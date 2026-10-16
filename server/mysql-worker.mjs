import { workerData } from "node:worker_threads";
import mysql from "mysql2/promise";
const { port, signal, config } = workerData;
const gate = new Int32Array(signal);
let connection;
function reply(value) {
  port.postMessage(value);
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
}
try {
  connection = await mysql.createConnection({
    ...config,
    charset: "utf8mb4",
    connectTimeout: 5000,
    multipleStatements: false,
  });
  await connection.query(
    "SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')",
  );
  reply({ value: true });
} catch (e) {
  reply({ error: { code: e.code, message: "MySQL 连接失败" } });
  port.close();
}
if (connection)
  port.on("message", async ({ sql, values, mode }) => {
    try {
      if (mode === "close") {
        await connection.end();
        reply({ value: true });
        port.close();
        return;
      }
      const [rows] =
        mode === "exec"
          ? await connection.query(sql)
          : await connection.execute(sql, values || []);
      reply({
        value:
          mode === "get"
            ? rows[0]
            : mode === "run" || mode === "exec"
              ? { changes: rows.affectedRows, lastInsertRowid: rows.insertId }
              : rows,
      });
    } catch (e) {
      reply({ error: { code: e.code, message: "MySQL 查询失败" } });
    }
  });
