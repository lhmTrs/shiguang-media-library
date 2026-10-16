import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import mysql from "mysql2/promise";
const base = await fs.mkdtemp(path.join(os.tmpdir(), "sg-mysql-"));
const data = path.join(base, "db");
await fs.mkdir(data, { mode: 0o700 });
const listener = net.createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((r) => listener.close(r));
const binary = "/usr/local/mysql/bin/mysqld";
let server;
try {
  const init = spawn(
    binary,
    ["--no-defaults", "--initialize-insecure", "--datadir=" + data],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let initLog = "";
  init.stderr.on("data", (b) => (initLog += b));
  const [code] = await once(init, "exit");
  if (code) throw Error("测试 MySQL 初始化失败：" + initLog.slice(-1500));
  server = spawn(
    binary,
    [
      "--no-defaults",
      "--datadir=" + data,
      "--port=" + port,
      "--bind-address=127.0.0.1",
      "--socket=" + path.join(base, "mysql.sock"),
      "--pid-file=" + path.join(base, "mysql.pid"),
      "--mysqlx=OFF",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let logs = "";
  server.stderr.on("data", (b) => (logs += b));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const c = await mysql.createConnection({
        host: "127.0.0.1",
        port,
        user: "root",
        password: "",
        connectTimeout: 500,
      });
      await c.end();
      ready = true;
      break;
    } catch {
      if (server.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!ready) throw Error("测试 MySQL 启动失败：" + logs.slice(-1500));
  const verify = spawn(process.execPath, ["scripts/verify-mysql.mjs"], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  verify.stdin.end(
    JSON.stringify({ host: "127.0.0.1", port, user: "root", password: "" }) +
      "\n",
  );
  const [result] = await once(verify, "exit");
  if (result) process.exitCode = result;
  if (!result && process.argv.includes("--browser")) {
    const database = "shiguang_browser_" + Date.now();
    try {
      const qa = spawn(process.execPath, ["scripts/qa.mjs", "--webkit"], {
        stdio: "inherit",
        env: {
          ...process.env,
          MYSQL_QA_CONFIG: JSON.stringify({
            host: "127.0.0.1",
            port,
            user: "root",
            password: "",
            database,
          }),
        },
      });
      const [qaResult] = await once(qa, "exit");
      if (qaResult) process.exitCode = qaResult;
    } finally {
      const conn = await mysql.createConnection({
        host: "127.0.0.1",
        port,
        user: "root",
        password: "",
      });
      await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await conn.end();
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
  await fs.rm(base, { recursive: true, force: true });
}
