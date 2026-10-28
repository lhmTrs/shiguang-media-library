/**
 * T-LOCAL-013F 专用一次性 MySQL 夹具（默认不启动，仅显式 opt-in 使用）。
 *
 * 只允许启动本文件自己在 0700 临时目录里初始化的 mysqld：
 *   --no-defaults、独立 datadir/socket/pid/log、--skip-networking、mysqlx=OFF。
 * 不读取 my.cnf/默认凭据，不连接 3306 或已有 socket，不 sudo/安装/启动 Docker。
 * 所有启动/就绪/退出都有截止时间；只终止本文件创建的 PID；失败保留目录并报错。
 *
 * 同一个文件同时是并发测试 worker 的入口：workerData.t13fRole 存在时执行
 * 指定 store 操作，通过 SharedArrayBuffer 与主线程做有界同步。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import mysql from "mysql2/promise";
import { MysqlDatabase } from "../server/mysql-db.mjs";
import { AudioResultStore } from "../server/audio-result-store.mjs";

export const MYSQL_OPT_IN_ENV = "T13F_MYSQL";
export const MYSQLD_PATH = "/usr/local/mysql/bin/mysqld";
const MYSQL_BASEDIR = "/usr/local/mysql";
// macOS sun_path 通常 104 字节；留出余量，保证短临时目录下的 socket 可用。
const SOCKET_PATH_LIMIT = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tail(text, max = 2000) {
  const value = String(text ?? "");
  return value.length > max ? value.slice(value.length - max) : value;
}

function runMysqld(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(MYSQLD_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    let settled = false;
    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      const exited = await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(5000).then(() => "timeout"),
      ]);
      const error = new Error(
        exited === "timeout"
          ? `mysqld 初始化超时且未能确认退出（${timeoutMs}ms），保留临时目录`
          : `mysqld 初始化超时（${timeoutMs}ms）`,
      );
      if (exited === "timeout") error.preserveDir = true;
      reject(error);
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`mysqld 启动失败：${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`mysqld 初始化退出 code=${code} signal=${signal}：${tail(stderr)}`));
        return;
      }
      resolve({ code, signal });
    });
  });
}

/**
 * 启动一个一次性 MySQL 实例并创建独立数据库。
 * 调用方必须 finally/after 调用 stop()；stop 确认进程退出后才删除临时目录。
 */
export async function startMysqlFixture({ startupTimeoutMs = 45000, stopTimeoutMs = 20000 } = {}) {
  let stat;
  try {
    stat = await fsp.stat(MYSQLD_PATH);
  } catch {
    throw new Error(`未找到 ${MYSQLD_PATH}；T13F MySQL 验收明确未验，不回退 SQLite`);
  }
  if (!stat.isFile()) throw new Error(`${MYSQLD_PATH} 不是可执行文件`);

  const dir = await fsp.mkdtemp("/tmp/shiguang-t13f-");
  await fsp.chmod(dir, 0o700);
  const datadir = path.join(dir, "data");
  const socketPath = path.join(dir, "m.sock");
  if (Buffer.byteLength(socketPath) >= SOCKET_PATH_LIMIT) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw new Error("临时 socket 路径过长");
  }
  const initLog = path.join(dir, "init.log");
  const errorLog = path.join(dir, "error.log");
  const pidFile = path.join(dir, "mysqld.pid");
  await fsp.mkdir(datadir, { mode: 0o700 });

  let child = null;
  let exitInfo = null;
  let exitedResolve;
  const exited = new Promise((resolve) => {
    exitedResolve = resolve;
  });
  let spawnError = null;
  let stderr = "";
  let admin = null;

  const killAndCleanup = async () => {
    if (admin) {
      try {
        await admin.end();
      } catch {}
      admin = null;
    }
    if (child && !exitInfo) {
      // 启动失败路径也先礼后兵；不能确认退出时保留目录，绝不盲删活动 datadir。
      try {
        child.kill("SIGTERM");
      } catch {}
      const first = await Promise.race([exited, sleep(5000).then(() => "timeout")]);
      if (first === "timeout") {
        try {
          child.kill("SIGKILL");
        } catch {}
        const second = await Promise.race([exited, sleep(5000).then(() => "timeout")]);
        if (second === "timeout") {
          throw new Error(`mysqld 未能确认退出，保留临时目录：${dir}`);
        }
      }
    }
    await fsp.rm(dir, { recursive: true, force: true });
  };

  try {
    await runMysqld(
      [
        "--no-defaults",
        "--initialize-insecure",
        `--basedir=${MYSQL_BASEDIR}`,
        `--datadir=${datadir}`,
        `--log-error=${initLog}`,
      ],
      90000,
    );

    child = spawn(
      MYSQLD_PATH,
      [
        "--no-defaults",
        `--basedir=${MYSQL_BASEDIR}`,
        `--datadir=${datadir}`,
        `--socket=${socketPath}`,
        `--pid-file=${pidFile}`,
        `--log-error=${errorLog}`,
        "--skip-networking",
        "--mysqlx=OFF",
        "--secure-file-priv=NULL",
        "--skip-name-resolve",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("exit", (code, signal) => {
      exitInfo = { code, signal };
      exitedResolve(exitInfo);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });

    const deadline = Date.now() + startupTimeoutMs;
    for (;;) {
      if (spawnError) throw new Error(`mysqld 启动失败：${spawnError.message}`);
      if (exitInfo) {
        throw new Error(`mysqld 提前退出 code=${exitInfo.code} signal=${exitInfo.signal}：${tail(stderr)}`);
      }
      if (fs.existsSync(socketPath)) {
        try {
          admin = await mysql.createConnection({
            socketPath,
            user: "root",
            charset: "utf8mb4",
            connectTimeout: 2000,
          });
          break;
        } catch {
          admin = null;
        }
      }
      if (Date.now() > deadline) throw new Error(`等待 mysqld 就绪超时（${startupTimeoutMs}ms）`);
      await sleep(100);
    }

    const [versionRows] = await admin.query("SELECT VERSION() AS version");
    const version = versionRows[0].version;
    const database = "t13f_results";
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await admin.query(`USE \`${database}\``);

    // 只从夹具内部生成连接配置；测试不接受任意环境变量里的真实连接配置。
    const config = Object.freeze({ socketPath, user: "root", database, charset: "utf8mb4" });
    let stopped = false;

    return Object.freeze({
      dir,
      socketPath,
      database,
      version,
      config,
      query: (sql, values = []) => admin.query(sql, values),
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await admin.end();
        } catch {}
        admin = null;
        if (!exitInfo) {
          try {
            child.kill("SIGTERM");
          } catch {}
          const first = await Promise.race([exited, sleep(stopTimeoutMs).then(() => "timeout")]);
          if (first === "timeout") {
            try {
              child.kill("SIGKILL");
            } catch {}
            const second = await Promise.race([exited, sleep(5000).then(() => "timeout")]);
            if (second === "timeout") {
              // 不能确认退出时保留目录，避免盲删活动 datadir。
              throw new Error(`mysqld 未能确认退出，保留临时目录：${dir}`);
            }
          }
        }
        await fsp.rm(dir, { recursive: true, force: true });
      },
    });
  } catch (error) {
    // 无法确认初始化进程退出时保留目录，避免盲删活动 datadir。
    if (error?.preserveDir) throw error;
    try {
      await killAndCleanup();
    } catch (cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* 并发 worker：只在 worker_threads 中运行，主线程 import 无副作用      */
/* ------------------------------------------------------------------ */

function waitGate(gate, index, value = 1, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(gate, index) !== value) {
    const remain = deadline - Date.now();
    if (remain <= 0) throw new Error(`worker 同步等待超时（slot ${index}）`);
    Atomics.wait(gate, index, Atomics.load(gate, index), Math.min(remain, 500));
  }
}

async function runWorker({ t13fRole, config, params, sync }) {
  const gate = sync ? new Int32Array(sync) : null;
  let db = null;
  try {
    db = new MysqlDatabase(config);
    const identity = params.identity;
    const store = new AudioResultStore({
      db,
      resolveCurrent: (assetId) => (assetId === identity.assetId ? identity : null),
    });
    // init 角色不预初始化：两个连接必须在同一屏障后真正并发执行 initSchema。
    if (t13fRole === "init") {
      parentPort.postMessage({ ok: true, stage: "ready" });
      waitGate(gate, 0);
      try {
        parentPort.postMessage({ ok: true, value: store.initSchema() });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error?.code ?? "WORKER_ERROR" });
      }
      return;
    }

    store.initSchema();
    // 两个连接都完成构造/幂等 init 后才进入同一屏障，避免把“先后执行”冒充并发。
    parentPort.postMessage({ ok: true, stage: "ready" });

    if (t13fRole === "begin") {
      waitGate(gate, 0);
      parentPort.postMessage({ ok: true, value: store.begin(params.assetId, params.jobId, identity) });
      return;
    }
    if (t13fRole === "save") {
      waitGate(gate, 0);
      try {
        const value = store.save(params.token, params.result, params.timing);
        parentPort.postMessage({ ok: true, value });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error?.code ?? "WORKER_ERROR" });
      }
      return;
    }
    if (t13fRole === "hold-lock") {
      db.transaction(() => {
        const row = db
          .prepare(`SELECT asset_id FROM audio_result_commits WHERE asset_id = ? FOR UPDATE`)
          .get(params.assetId);
        if (!row) throw Object.assign(new Error("缺少提交行"), { code: "NO_ROW" });
        parentPort.postMessage({ ok: true, stage: "locked" });
        waitGate(gate, 0, 1, 15000);
      })();
      parentPort.postMessage({ ok: true, stage: "done" });
      return;
    }
    throw new Error(`未知 worker role：${t13fRole}`);
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      stage: "error",
      code: error?.code ?? "WORKER_ERROR",
    });
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

if (!isMainThread && workerData && workerData.t13fRole) {
  await runWorker(workerData);
}
