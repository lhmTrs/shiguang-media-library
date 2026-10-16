import {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} from "node:worker_threads";

// Preserve the library's synchronous file-operation transaction boundaries.
export class MysqlDatabase {
  constructor(config) {
    this.kind = "mysql";
    this.closed = false;
    const { port1, port2 } = new MessageChannel();
    this.port = port1;
    this.signal = new SharedArrayBuffer(4);
    this.gate = new Int32Array(this.signal);
    this.worker = new Worker(new URL("./mysql-worker.mjs", import.meta.url), {
      execArgv: [],
      workerData: { config, port: port2, signal: this.signal },
      transferList: [port2],
    });
    this.worker.on("error", () => {});
    this.read();
  }
  read() {
    if (Atomics.wait(this.gate, 0, 0, 15000) === "timed-out") {
      this.closed = true;
      void this.worker.terminate();
      this.port.close();
      throw Error("MySQL 响应超时，未切回 SQLite；请检查本机数据库");
    }
    const packet = receiveMessageOnPort(this.port)?.message;
    if (!packet) throw Error("MySQL 通信失败");
    if (packet.error) {
      const e = Error(packet.error.message);
      e.code = packet.error.code;
      throw e;
    }
    return packet.value;
  }
  request(sql, values = [], mode = "all") {
    if (this.closed) throw Error("MySQL 连接不可用，请重新启动素材库");
    Atomics.store(this.gate, 0, 0);
    this.port.postMessage({ sql, values, mode });
    return this.read();
  }
  prepare(sql) {
    sql = sql
      .replace(/name COLLATE NOCASE/g, "name COLLATE utf8mb4_0900_ai_ci")
      .replace(/\browid\b/g, "operation_seq");
    const call = (mode, args) => {
      let query = sql;
      if (
        args.length === 1 &&
        args[0] &&
        typeof args[0] === "object" &&
        !Array.isArray(args[0])
      ) {
        const params = args[0];
        const values = [];
        query = query.replace(/@(\w+)/g, (_, key) => {
          values.push(params[key]);
          return "?";
        });
        args = values;
      }
      return this.request(query, args, mode);
    };
    return {
      all: (...args) => call("all", args),
      get: (...args) => call("get", args),
      run: (...args) => call("run", args),
    };
  }
  exec(sql) {
    this.request(sql, [], "exec");
    return this;
  }
  transaction(fn) {
    return (...args) => {
      this.exec("START TRANSACTION");
      try {
        const result = fn(...args);
        if (result?.then) throw Error("同步事务不能包含异步回调");
        this.exec("COMMIT");
        return result;
      } catch (e) {
        try {
          this.exec("ROLLBACK");
        } catch {}
        throw e;
      }
    };
  }
  close() {
    if (this.closed) return;
    try {
      this.request("", [], "close");
    } finally {
      this.closed = true;
      this.port.close();
      void this.worker.terminate();
    }
  }
}
