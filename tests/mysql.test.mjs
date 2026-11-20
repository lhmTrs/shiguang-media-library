import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Sqlite from "better-sqlite3";
import { validateConfig, safeError, MysqlStorage } from "../server/mysql.mjs";
import {scriptSchema} from "../server/project-scripts/schema.mjs";
import {tempDirectories} from "./helpers/temp-cleanup.mjs";
const temporary = tempDirectories(test, "sg-mysql-ddl-");
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
test("迁移前拒绝未结清的后台工作，不连接目标或冻结源库", async t => {
  const directory = await temporary(t), db = new Sqlite(':memory:'); t.after(() => db.close());
  const storage = await new MysqlStorage(directory).init();
  const lib = {db, locks: new Set(), jobs: new Map(), workers: 0, metadataPending: new Set(), metadataQueue: [], pump() {}};
  storage.attach(lib); let connected = false;
  storage.connect = async () => { connected = true; throw Error('must not connect'); };
  const config = {host: '127.0.0.1', database: 'owned', user: 'synthetic'};
  for (const scenario of ['worker', 'queued-metadata', 'queued-job', 'unknown-job']) {
    lib.workers = scenario === 'worker' ? 1 : 0;
    lib.metadataQueue = scenario === 'queued-metadata' ? ['synthetic'] : [];
    lib.jobs.clear(); if (scenario.endsWith('job')) lib.jobs.set('synthetic', {status: scenario === 'queued-job' ? 'queued' : 'unknown'});
    await assert.rejects(storage.activate(config), /等待扫描或文件操作完成/);
    assert.equal(connected, false); assert.equal(db.pragma('query_only', {simple: true}), 0);
    assert.equal(storage.restartRequired, false); assert.equal(storage.migrating, false);
  }
});
test("迁移诊断只暴露受限表名和阶段，不暴露驱动原文", () => {
  const driver = {code: "UNKNOWN", message: "private SQL and connection details"};
  assert.equal(safeError(driver, {phase: "schema", table: "project_scripts"}),
    "MySQL 操作失败，请检查连接和数据库权限（迁移建表：project_scripts）");
  assert.equal(safeError(driver, {phase: "copy", table: "project_scripts"}),
    "MySQL 操作失败，请检查连接和数据库权限（迁移复制：project_scripts）");
  assert.equal(safeError(driver, {phase: "verify", table: "project_scripts"}),
    "MySQL 操作失败，请检查连接和数据库权限（迁移校验：project_scripts）");
  for (const context of [{phase: "secret", table: "project_scripts"}, {phase: "toString", table: "project_scripts"}, {phase: "copy", table: "bad;SQL"}])
    assert.equal(safeError(driver, context), safeError(driver));
  for (const code of ["ER_PRIMARY_CANT_HAVE_NULL", "ER_BAD_NULL_ERROR", "ER_DUP_ENTRY"])
    assert.ok(!safeError({...driver, code}, {phase: "copy", table: "project_scripts"}).includes(driver.message));
});
test("真实 SQLite PRAGMA 的可空主键生成非空 MySQL DDL，保留非主键可空及复合主键", async t => {
  const directory = await temporary(t), db = new Sqlite(path.join(directory, "library.sqlite"));
  t.after(() => db.close());
  db.exec(`CREATE TABLE roots(id TEXT PRIMARY KEY,path TEXT);
    CREATE TABLE assets(id TEXT PRIMARY KEY,root_id TEXT,path TEXT,created_ms REAL,captured_ms REAL);
    CREATE TABLE operations(id TEXT PRIMARY KEY);
    CREATE TABLE asset_repair_journal(operation_id TEXT PRIMARY KEY,alias_asset_id TEXT);
    CREATE TABLE asset_metadata_fields(asset_id TEXT,field TEXT,PRIMARY KEY(asset_id,field));`);
  db.exec(scriptSchema(false));
  const source = db.prepare("PRAGMA table_info(project_scripts)").all().find(c => c.name === "id");
  assert.equal(source.pk, 1); assert.equal(source.notnull, 0);
  const storage = await new MysqlStorage(directory).init(), ddl = [];
  const lib = {db, locks: new Set(), jobs: new Map(), workers: 0, pump() {}};
  storage.attach(lib);
  let ended = false, rolledBack = false;
  // Capture the real activate generator; no listener, worker or native server.
  storage.connect = async () => ({
    async changeUser() {},
    async execute(sql) {
      return [sql.startsWith("SELECT * FROM shiguang_database_meta")
        ? [{source_id: storage.sourceId, schema_version: 1}] : []];
    },
    async query(sql) { ddl.push(sql); return [[{n: 0}]]; },
    async beginTransaction() { throw Error("owned DDL capture stops before data copy"); },
    async rollback() { rolledBack = true; },
    async end() { ended = true; },
  });
  await assert.rejects(storage.activate({host: "127.0.0.1", port: 49152, user: "synthetic", password: "", database: "owned_ddl"}));
  const table = name => ddl.find(sql => sql.startsWith("CREATE TABLE IF NOT EXISTS " + name + " ("));
  assert.match(table("project_scripts"), /`id` VARCHAR\(36\) PRIMARY KEY NOT NULL/);
  assert.doesNotMatch(table("project_scripts"), /PRIMARY KEY NULL/);
  assert.match(table("roots"), /`path` LONGTEXT NULL/);
  assert.match(table("asset_metadata_fields"), /`asset_id` VARCHAR\(36\) NOT NULL,`field` VARCHAR\(24\) NOT NULL,PRIMARY KEY\(asset_id,field\)/);
  assert.equal(lib.db, db); assert.equal(db.open, true); assert.equal(lib.migrating, false);
  assert.equal(ended, true); assert.equal(rolledBack, true);
  assert.equal(db.pragma('query_only', {simple: true}), 0);
  await assert.rejects(fs.access(storage.configPath), {code: "ENOENT"});

  const oldPrepared = db.prepare("INSERT INTO project_scripts VALUES('owned','title','body',1,1,1)");
  storage.connect = async () => ({
    async changeUser() {},
    async execute(sql) { return [sql.startsWith("SELECT * FROM shiguang_database_meta") ? [{source_id: storage.sourceId, schema_version: 1}] : []]; },
    async query(sql) { return sql.startsWith('SELECT COUNT(*)') ? [[{n: 0}]] : [[]]; },
    async beginTransaction() {}, async commit() {}, async rollback() {}, async end() {},
  });
  const result = await storage.activate({host: "127.0.0.1", port: 49152, user: "synthetic", password: "", database: "owned_ddl"});
  assert.equal(lib.db, db); assert.equal(db.open, true); assert.equal(storage.database, null);
  assert.equal(result.mode, 'sqlite'); assert.equal(result.configuredMode, 'mysql'); assert.equal(result.restartRequired, true);
  assert.equal(result.status, 'restart_required'); assert.equal(result.migrating, false); assert.equal(result.readOnly, true);
  assert.equal(lib.migrating, true);
  assert.equal(db.pragma('query_only', {simple: true}), 1);
  // Bypassing all HTTP/UI guards still cannot write copied business data.
  assert.throws(() => oldPrepared.run(), {code: 'SQLITE_READONLY'});
  assert.throws(() => db.exec("INSERT INTO roots VALUES('background','owned')"), {code: 'SQLITE_READONLY'});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_scripts').get().n, 0);
  assert.equal(JSON.parse(await fs.readFile(storage.configPath, 'utf8')).database, 'owned_ddl');
  await assert.rejects(storage.activate({host: '127.0.0.1', user: 'synthetic', database: 'other'}), /未重复迁移/);
});
