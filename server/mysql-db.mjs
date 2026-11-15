import {withRenderMysqlLock} from './render-startup-mysql-lock.mjs';
import {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} from "node:worker_threads";

const connectionConfigs = new WeakMap();
const migrationConnections = new WeakSet();

// Preserve the library's synchronous file-operation transaction boundaries.
export class MysqlDatabase {
  constructor(config, {renderMigration = false} = {}) {
    connectionConfigs.set(this, {...config});
    if (renderMigration) migrationConnections.add(this);
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
    if (!renderMigration) this.read();
  }
  read() {
    if (Atomics.wait(this.gate, 0, 0, 15000) === "timed-out") {
      this.closed = true;
      if (migrationConnections.has(this)) {
        // An outstanding migration response is unknown: never terminate its
        // Worker or reuse its response channel for another SQL command.
        this.renderMigrationTransportUnknown = true;
        this.worker.unref(); this.port.unref();
      } else {
        void this.worker.terminate();
        this.port.close();
      }
      throw Error("MySQL 响应超时，未切回 SQLite；请检查本机数据库");
    }
    const packet = receiveMessageOnPort(this.port)?.message;
    if (!packet) throw Error("MySQL 通信失败");
    if (packet.error) {
      const e = Error(packet.error.message);
      e.code = packet.error.code;
      e.errno = packet.error.errno;
      e.sql = packet.error.sql;
      throw e;
    }
    return packet.value;
  }
  request(sql, values = [], mode = "all", renderToken = null) {
    if (mode !== "close" && (this.renderSchemaToken && renderToken !== this.renderSchemaToken)) throw Object.assign(Error("成片资料正在升级或需要核对，数据库请求未执行"), {code: "RENDER_SCHEMA_UPGRADE_ACTIVE", status: 503});
    if (this.closed) throw Error("MySQL 连接不可用，请重新启动素材库");
    Atomics.store(this.gate, 0, 0);
    this.port.postMessage({ sql, values, mode });
    const result = this.read();
    if (/^\s*(START\s+TRANSACTION|BEGIN)\b/i.test(sql)) this.renderTransactionActive = true;
    if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) this.renderTransactionActive = false;
    return result;
  }
  prepare(sql, renderToken = null) {
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
      return this.request(query, args, mode, renderToken);
    };
    return {
      all: (...args) => call("all", args),
      get: (...args) => call("get", args),
      run: (...args) => call("run", args),
    };
  }
  exec(sql, renderToken = null) {
    this.request(sql, [], "exec", renderToken);
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
  async withRenderSchemaUpgradeLock(callback, options) {
    if (this.renderSchemaToken || this.renderSchemaMigrationUnknown || this.renderTransactionActive) throw Object.assign(Error("成片资料升级窗口不可用"), {code: "RENDER_SCHEMA_UPGRADE_LOCK_FAILED", status: 503, reason: "busy", state: "failed", details: {renderSchemaUpgrade: {state: "failed", reason: "busy"}}});
    // Keep the original business connection untouched by migration session
    // changes, table locks and unknown cleanup. Seal only its local admission.
    const expected = this.prepare('SELECT DATABASE() AS `database`,@@server_uuid serverUuid,CONNECTION_ID() connectionId').get();
    this.renderSchemaToken = Symbol("render-schema-upgrade");
    let migration, bodyError, result;
    const receipt = {state: 'opening', businessConnectionId: expected.connectionId, migrationConnectionId: null, closeAck: false, workerExit: null};
    this.renderSchemaMigrationReceipt = receipt;
    try {
      migration = new MysqlDatabase(connectionConfigs.get(this), {renderMigration: true});
      this.renderSchemaMigrationResource = migration;
      migration.read();
      const identity = migration.prepare('SELECT DATABASE() AS `database`,@@server_uuid serverUuid,CONNECTION_ID() connectionId').get();
      receipt.migrationConnectionId = identity.connectionId;
      if (identity.database !== expected.database || identity.serverUuid !== expected.serverUuid || identity.connectionId === expected.connectionId) throw Object.assign(Error('迁移连接身份不一致'), {upgradeReason: 'unknown_outcome'});
      receipt.state = 'active';
      result = await withRenderMysqlLock({
        get: (sql, args = []) => migration.request(sql, args, "get"),
        all: (sql, args = []) => migration.request(sql, args, "all"),
        exec: sql => migration.request(sql, [], "exec"),
      }, callback, options);
    } catch (error) { bodyError = error; }
    finally {
      if (migration) {
        try {
          const code = await migration.closeRenderMigration();
          receipt.closeAck = true; receipt.workerExit = code; receipt.state = 'closed';
          this.renderSchemaMigrationResource = null;
        } catch (error) {
          receipt.state = 'unknown'; this.renderSchemaMigrationUnknown = true;
          const failure = Object.assign(Error('迁移连接关闭结果待核对'), {upgradeReason: 'unknown_outcome', renderUpgradeCleanupUnknown: true, cause: bodyError || error});
          bodyError = failure;
        }
      } else { receipt.state = 'open_failed'; }
      this.renderSchemaToken = null;
    }
    if (bodyError) throw bodyError;
    return result;
  }
  async closeRenderMigration() {
    if (!migrationConnections.has(this) || this.renderMigrationTransportUnknown || this.closed) throw Error('迁移连接关闭结果未知');
    // Register before requesting end(): the exit may follow its ACK immediately.
    const exited = new Promise(resolve => this.worker.once('exit', resolve));
    let timer;
    try {
      this.request('', [], 'close');
      this.closed = true; this.port.close();
      const code = await Promise.race([exited, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('迁移Worker退出未知')), 5000);})]);
      if (code !== 0) throw Error('迁移Worker非正常退出');
      return code;
    } catch (error) { this.worker.unref(); this.port.unref(); throw error; }
    finally { clearTimeout(timer); }
  }
  close() {
    if (migrationConnections.has(this)) throw Error("迁移连接必须等待正常关闭回执");
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
