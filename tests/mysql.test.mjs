import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, safeError } from "../server/mysql.mjs";
test("MySQL 限本机、名称校验、密码保留边界与错误脱敏", () => {
  const c = {
    host: "127.0.0.1",
    port: 3306,
    database: "shiguang_media",
    user: "root",
    password: "test-secret",
  };
  assert.throws(() => validateConfig({ ...c, host: "example.com" }), /本机/);
  assert.throws(
    () => validateConfig({ ...c, database: "x; DROP DATABASE x" }),
    /数据库名称/,
  );
  assert.throws(() => validateConfig({ ...c, port: 0 }), /端口/);
  assert.equal(
    validateConfig({ ...c, password: undefined }, c).password,
    "test-secret",
  );
  assert.equal(
    validateConfig({ ...c, user: "other", password: undefined }, c).password,
    "",
  );
  assert.equal(
    safeError({ code: "ER_ACCESS_DENIED_ERROR", message: "test-secret" }),
    "MySQL 账户或密码错误",
  );
  assert.equal(
    safeError({ code: "UNKNOWN", message: "test-secret" }).includes(
      "test-secret",
    ),
    false,
  );
});
