/**
 * T-LOCAL-013E 定向测试：隔离 SQLite 结果存储与提交令牌。
 *
 * 只使用临时目录/内存 SQLite 与合成 JSON；不启动服务、不读写真实素材库、
 * 不运行发行引擎/真实音频、不访问云端账户或服务器、不部署。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { normalizeAudioResult } from "../server/audio-result.mjs";
import {
  AudioResultStore,
  AudioResultStoreError,
  MAX_STORE_PAYLOAD_BYTES,
  STORE_SCHEMA_VERSION,
} from "../server/audio-result-store.mjs";

const IDENTITY_KEYS = [
  "assetId",
  "rootId",
  "kind",
  "online",
  "trashed",
  "retired",
  "rootRetired",
  "busy",
  "libraryGeneration",
  "assetGeneration",
  "sourceGeneration",
  "context",
];

function baseContext(over = {}) {
  return {
    kind: "music",
    sourceSha256: "a".repeat(64),
    sourceSize: 12_345,
    durationSec: 600,
    engineVersion: "1.0.0",
    engineBinarySha256: "b".repeat(64),
    engineGeneration: "c".repeat(32),
    parameters: { brief: true },
    ...over,
  };
}

function baseRaw(over = {}) {
  return {
    bpm: 120,
    key: { best: "C major", r: 0.8 },
    loud: { peak: 2.5, rms: -12 },
    energy: { min: -30, max: -4, std: 3 },
    fit: { beat: 0.9, tonal: 0.8, chord: 0.5 },
    seg: [0, 10, 200],
    ...over,
  };
}

function resultFor(context, raw = baseRaw()) {
  const result = normalizeAudioResult(JSON.stringify(raw), context);
  assert.equal(result.ok, true);
  return result;
}

function identity(assetId, context, over = {}) {
  return {
    assetId,
    rootId: "root_01",
    kind: context.kind,
    online: true,
    trashed: false,
    retired: false,
    rootRetired: false,
    busy: false,
    libraryGeneration: "1".repeat(32),
    assetGeneration: "2".repeat(32),
    sourceGeneration: "3".repeat(32),
    context,
    ...over,
  };
}

function timing(over = {}) {
  return { analyzedMs: 12.5, analyzedAtMs: 1_700_000_000_000, ...over };
}

async function tempDb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-t13e-"));
  const file = path.join(dir, "store.sqlite");
  const db = new Database(file);
  t.after(async () => {
    try {
      db.close();
    } catch {}
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { db, file, dir };
}

async function makeStore(t, options = {}) {
  const { db, file, dir } = await tempDb(t);
  const context = options.context ?? baseContext();
  const assetId = options.assetId ?? "asset_01";
  const ident = options.ident ?? identity(assetId, context);
  const store = new AudioResultStore({
    db,
    resolveCurrent: options.resolveCurrent ?? ((id) => (id === assetId ? ident : null)),
  });
  if (options.init !== false) store.initSchema();
  return { db, file, dir, context, assetId, ident, store };
}

function expectCode(code, fn) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}`);
  assert.ok(caught instanceof AudioResultStoreError, `expected AudioResultStoreError, got ${caught.name}`);
  assert.equal(caught.code, code);
  assert.equal(typeof caught.message, "string");
  assert.ok(caught.message.length > 0);
  return caught;
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test("构造与未 init 的读取不执行任何 SQL", async (t) => {
  const { db } = await tempDb(t);
  const counts = { prepare: 0, exec: 0, transaction: 0 };
  const wrapper = {
    get open() {
      return db.open;
    },
    prepare(...args) {
      counts.prepare += 1;
      return db.prepare(...args);
    },
    exec(...args) {
      counts.exec += 1;
      return db.exec(...args);
    },
    transaction(fn) {
      counts.transaction += 1;
      return db.transaction(fn);
    },
  };

  const ident = identity("asset_01", baseContext());
  const store = new AudioResultStore({ db: wrapper, resolveCurrent: () => ident });
  assert.deepEqual(counts, { prepare: 0, exec: 0, transaction: 0 });

  expectCode("STORE_NOT_INITIALIZED", () => store.get("asset_01", baseContext()));
  expectCode("STORE_NOT_INITIALIZED", () => store.begin("asset_01", "job_01", ident));
  expectCode("STORE_NOT_INITIALIZED", () => store.invalidate("asset_01"));
  assert.deepEqual(counts, { prepare: 0, exec: 0, transaction: 0 });
  assert.deepEqual(tableNames(db), []);
});

test("initSchema 创建三张隔离表并写入版本 1", async (t) => {
  const { db, store } = await makeStore(t, { init: false });
  const first = store.initSchema();
  assert.deepEqual(first, { ok: true, schemaVersion: STORE_SCHEMA_VERSION, created: true });
  assert.deepEqual(tableNames(db), [
    "audio_result_commits",
    "audio_result_records",
    "audio_result_store_meta",
  ]);
  const meta = db
    .prepare("SELECT meta_value FROM audio_result_store_meta WHERE meta_key = 'schema_version'")
    .get();
  assert.equal(meta.meta_value, "1");
  assert.equal(count(db, "audio_result_commits"), 0);
  assert.equal(count(db, "audio_result_records"), 0);
});

test("重复 initSchema 幂等且不再执行 SQL", async (t) => {
  const { db } = await tempDb(t);
  const counts = { prepare: 0, exec: 0, transaction: 0 };
  const wrapper = {
    get open() {
      return db.open;
    },
    prepare(...args) {
      counts.prepare += 1;
      return db.prepare(...args);
    },
    exec(...args) {
      counts.exec += 1;
      return db.exec(...args);
    },
    transaction(fn) {
      counts.transaction += 1;
      return db.transaction(fn);
    },
  };
  const ident = identity("asset_01", baseContext());
  const store = new AudioResultStore({ db: wrapper, resolveCurrent: () => ident });
  assert.equal(store.initSchema().created, true);
  counts.prepare = 0;
  counts.exec = 0;
  counts.transaction = 0;
  const second = store.initSchema();
  assert.deepEqual(second, { ok: true, schemaVersion: 1, created: false });
  assert.deepEqual(counts, { prepare: 0, exec: 0, transaction: 0 });
});

test("initSchema 不触碰既有 asset_audio 表和数据", async (t) => {
  const { db } = await tempDb(t);
  db.exec("CREATE TABLE asset_audio (id TEXT PRIMARY KEY, payload TEXT, legacy INTEGER)");
  db.prepare("INSERT INTO asset_audio (id, payload, legacy) VALUES (?, ?, ?)").run(
    "old_01",
    "keep-me",
    7,
  );
  const ident = identity("asset_01", baseContext());
  const store = new AudioResultStore({ db, resolveCurrent: () => ident });
  store.initSchema();
  assert.deepEqual(
    db.prepare("SELECT id, payload, legacy FROM asset_audio").all(),
    [{ id: "old_01", payload: "keep-me", legacy: 7 }],
  );
  assert.deepEqual(
    db.prepare("PRAGMA table_info(asset_audio)").all().map((row) => row.name),
    ["id", "payload", "legacy"],
  );
});

test("未知 schema 版本拒绝且不建其它表", async (t) => {
  const { db } = await tempDb(t);
  db.exec(`
    CREATE TABLE audio_result_store_meta (
      meta_key TEXT PRIMARY KEY NOT NULL,
      meta_value TEXT NOT NULL
    );
    INSERT INTO audio_result_store_meta (meta_key, meta_value) VALUES ('schema_version', '2');
  `);
  const store = new AudioResultStore({
    db,
    resolveCurrent: () => identity("asset_01", baseContext()),
  });
  expectCode("UNSUPPORTED_SCHEMA_VERSION", () => store.initSchema());
  assert.deepEqual(tableNames(db), ["audio_result_store_meta"]);
});

test("已有结构冲突拒绝且不清空/不改写", async (t) => {
  const { db } = await tempDb(t);
  db.exec(`
    CREATE TABLE audio_result_store_meta (
      meta_key TEXT PRIMARY KEY NOT NULL,
      meta_value TEXT NOT NULL
    );
    INSERT INTO audio_result_store_meta (meta_key, meta_value) VALUES ('schema_version', '1');
  `);
  const store = new AudioResultStore({
    db,
    resolveCurrent: () => identity("asset_01", baseContext()),
  });
  expectCode("SCHEMA_CONFLICT", () => store.initSchema());
  assert.deepEqual(tableNames(db), ["audio_result_store_meta"]);
  assert.equal(
    db.prepare("SELECT meta_value FROM audio_result_store_meta").get().meta_value,
    "1",
  );
});

test("已有表列结构不符时拒绝", async (t) => {
  const { db } = await tempDb(t);
  db.exec(`
    CREATE TABLE audio_result_store_meta (
      meta_key TEXT PRIMARY KEY NOT NULL,
      meta_value TEXT NOT NULL
    );
    INSERT INTO audio_result_store_meta (meta_key, meta_value) VALUES ('schema_version', '1');
    CREATE TABLE audio_result_commits (asset_id TEXT PRIMARY KEY, wrong TEXT);
    CREATE TABLE audio_result_records (asset_id TEXT PRIMARY KEY, wrong TEXT);
  `);
  const store = new AudioResultStore({
    db,
    resolveCurrent: () => identity("asset_01", baseContext()),
  });
  expectCode("SCHEMA_CONFLICT", () => store.initSchema());
  assert.deepEqual(
    db.prepare("PRAGMA table_info(audio_result_commits)").all().map((row) => row.name),
    ["asset_id", "wrong"],
  );
});

test("DDL 失败回滚且可恢复", async (t) => {
  const { db } = await tempDb(t);
  db.exec("CREATE VIEW audio_result_store_meta AS SELECT 1 AS x");
  const ident = identity("asset_01", baseContext());
  const store = new AudioResultStore({ db, resolveCurrent: () => ident });
  const error = expectCode("SCHEMA_INIT_FAILED", () => store.initSchema());
  assert.doesNotMatch(error.message, /audio_result|CREATE|VIEW/i);
  assert.deepEqual(tableNames(db), []);
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all().map((row) => row.name),
    ["audio_result_store_meta"],
  );
  db.exec("DROP VIEW audio_result_store_meta");
  assert.equal(store.initSchema().created, true);
});

test("未知 kind 构造期固定拒绝且零 SQL；mysql 交给 T13F 专用套件", async () => {
  for (const kind of ["postgres", "sqlite3", null]) {
    let calls = 0;
    const fake = {
      kind,
      prepare() {
        calls += 1;
      },
      exec() {
        calls += 1;
      },
      transaction() {
        calls += 1;
      },
    };
    expectCode("UNSUPPORTED_STORAGE", () => new AudioResultStore({ db: fake, resolveCurrent: () => ({}) }));
    assert.equal(calls, 0);
  }

  // MySQL 是 T13F 显式支持的第二种方言；构造阶段仍然零 SQL，真实连接/DDL
  // 只由 tests/audio-result-store-mysql.test.mjs 的一次性实例套件验证。
  let calls = 0;
  const mysqlShaped = {
    kind: "mysql",
    prepare() {
      calls += 1;
    },
    exec() {
      calls += 1;
    },
    transaction() {
      calls += 1;
    },
  };
  const store = new AudioResultStore({ db: mysqlShaped, resolveCurrent: () => ({}) });
  assert.equal(calls, 0);
  expectCode("STORE_NOT_INITIALIZED", () => store.get("asset_01", baseContext()));
  assert.equal(calls, 0);

  const noMethods = { kind: "sqlite" };
  expectCode("INVALID_DB", () => new AudioResultStore({ db: noMethods, resolveCurrent: () => ({}) }));
  expectCode("INVALID_DB", () =>
    new AudioResultStore({ db: { ...mysqlShaped, prepare: undefined }, resolveCurrent: () => ({}) }),
  );
});

test("选项/依赖形状非法固定拒绝", async (t) => {
  const { db } = await tempDb(t);
  expectCode("INVALID_OPTIONS", () => new AudioResultStore());
  expectCode("INVALID_OPTIONS", () => new AudioResultStore({ db }));
  expectCode("INVALID_OPTIONS", () =>
    new AudioResultStore({ db, resolveCurrent: () => ({}), extra: true }),
  );
  expectCode("INVALID_OPTIONS", () =>
    new AudioResultStore({ db, resolveCurrent: "not-a-function" }),
  );
});

test("db 关闭后固定 STORE_CLOSED", async (t) => {
  const { db, store } = await makeStore(t);
  db.close();
  expectCode("STORE_CLOSED", () => store.initSchema());
  expectCode("STORE_CLOSED", () => store.get("asset_01", baseContext()));
  expectCode("STORE_CLOSED", () => store.begin("asset_01", "job_01", identity("asset_01", baseContext())));
});

test("begin 返回脱敏摘要与不可猜 token", async (t) => {
  const { store, assetId, ident } = await makeStore(t);
  const first = store.begin(assetId, "job_01", ident);
  assert.deepEqual(Object.keys(first).sort(), [
    "assetGeneration",
    "assetId",
    "createdAtMs",
    "fingerprint",
    "jobId",
    "libraryGeneration",
    "ok",
    "sourceGeneration",
    "token",
  ]);
  assert.match(first.token, /^[0-9a-f]{64}$/);
  assert.equal(first.assetId, assetId);
  assert.equal(first.jobId, "job_01");
  assert.doesNotMatch(JSON.stringify(first), /\/Users|root_01/);

  const second = store.begin(assetId, "job_02", ident);
  assert.notEqual(second.token, first.token);
  expectCode("INVALID_TOKEN", () => store.save(first.token, resultFor(baseContext()), timing()));
});

test("begin/save/get 成功并重开读取", async (t) => {
  const { db, file, store, assetId, context, ident } = await makeStore(t);
  const normalized = resultFor(context);
  const began = store.begin(assetId, "job_01", ident);
  const saved = store.save(began.token, normalized, timing());
  assert.equal(saved.ok, true);
  assert.equal(saved.consumed, true);
  assert.equal(saved.fingerprint, normalized.fingerprint);

  const got = store.get(assetId, context);
  assert.equal(got.status, "ready");
  assert.deepEqual(got.result, normalized);
  assert.equal(got.analyzedMs, 12.5);
  assert.equal(got.analyzedAtMs, 1_700_000_000_000);
  assert.ok(got.savedAtMs > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(got.result), "utf8") <= MAX_STORE_PAYLOAD_BYTES);
  assert.doesNotMatch(JSON.stringify(got), /payload_json|context_json|asset_audio|SELECT/);

  const stored = db
    .prepare("SELECT payload_bytes, payload_sha256 FROM audio_result_records WHERE asset_id = ?")
    .get(assetId);
  assert.equal(stored.payload_bytes, saved.payloadBytes);
  assert.equal(
    stored.payload_sha256,
    createHash("sha256").update(JSON.stringify(got.result), "utf8").digest("hex"),
  );

  db.close();
  const reopened = new Database(file);
  t.after(() => {
    try {
      reopened.close();
    } catch {}
  });
  const store2 = new AudioResultStore({ db: reopened, resolveCurrent: () => ident });
  store2.initSchema();
  const got2 = store2.get(assetId, context);
  assert.equal(got2.status, "ready");
  assert.deepEqual(got2.result, normalized);
});

test("同一 token 重复保存固定 TOKEN_CONSUMED，不能写不同 payload", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const first = resultFor(context);
  store.save(began.token, first, timing());
  expectCode("TOKEN_CONSUMED", () => store.save(began.token, first, timing()));
  const other = resultFor(context, baseRaw({ bpm: 90 }));
  expectCode("TOKEN_CONSUMED", () => store.save(began.token, other, timing()));
  assert.equal(store.get(assetId, context).result.value.bpm, 120);
});

test("未知/格式错误 token 固定拒绝", async (t) => {
  const { store, assetId, context } = await makeStore(t);
  expectCode("INVALID_TOKEN", () => store.save("f".repeat(64), resultFor(context), timing()));
  expectCode("INVALID_TOKEN", () => store.save("", resultFor(context), timing()));
  expectCode("INVALID_TOKEN", () => store.save("not-a-token", resultFor(context), timing()));
  expectCode("INVALID_TOKEN", () => store.save(123, resultFor(context), timing()));
  assert.equal(store.get(assetId, context).status, "missing");
});

test("非法 assetId/jobId 与 SQL 注入字符串不执行 SQL", async (t) => {
  const { db, store, ident } = await makeStore(t);
  for (const assetId of ["", "a".repeat(65), "a b", "中文", "a'b", "a;DROP TABLE asset_audio"]) {
    expectCode("INVALID_ASSET_ID", () => store.begin(assetId, "job_01", ident));
    expectCode("INVALID_ASSET_ID", () => store.get(assetId, baseContext()));
    expectCode("INVALID_ASSET_ID", () => store.invalidate(assetId));
  }
  for (const jobId of ["", "j".repeat(65), "job 1", "job'2", "job;--"]) {
    expectCode("INVALID_JOB_ID", () => store.begin("asset_01", jobId, ident));
  }
  assert.ok(tableNames(db).includes("audio_result_commits"));
  assert.ok(tableNames(db).includes("audio_result_records"));
});

test("新 begin 原子替换资格，旧 token 立即失效", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const first = store.begin(assetId, "job_01", ident);
  const second = store.begin(assetId, "job_02", ident);
  expectCode("INVALID_TOKEN", () => store.save(first.token, resultFor(context), timing()));
  store.save(second.token, resultFor(context), timing());
  expectCode("INVALID_TOKEN", () => store.save(first.token, resultFor(context), timing()));
  assert.equal(store.get(assetId, context).status, "ready");
});

test("两个实例/两个连接共享文件时旧 token 不能覆盖", async (t) => {
  const { db, file, store, assetId, context, ident } = await makeStore(t);
  const db2 = new Database(file);
  t.after(() => {
    try {
      db2.close();
    } catch {}
  });
  const store2 = new AudioResultStore({ db: db2, resolveCurrent: () => ident });
  store2.initSchema();

  const a = store.begin(assetId, "job_a", ident);
  const b = store2.begin(assetId, "job_b", ident);
  expectCode("INVALID_TOKEN", () => store.save(a.token, resultFor(context), timing()));
  const savedB = store2.save(b.token, resultFor(context), timing());
  assert.equal(savedB.ok, true);
  expectCode("INVALID_TOKEN", () => store.save(a.token, resultFor(context), timing()));
  expectCode("TOKEN_CONSUMED", () => store2.save(b.token, resultFor(context), timing()));

  db.close();
  db2.close();
  const db3 = new Database(file);
  t.after(() => {
    try {
      db3.close();
    } catch {}
  });
  const store3 = new AudioResultStore({ db: db3, resolveCurrent: () => ident });
  store3.initSchema();
  assert.equal(store3.get(assetId, context).status, "ready");
});

test("无记录返回 missing，不泄露旧行", async (t) => {
  const { store, assetId, context } = await makeStore(t);
  const got = store.get(assetId, context);
  assert.deepEqual(got, { ok: true, status: "missing" });
});

test("invalidate 撤销资格并让旧结果 stale，但不删除记录", async (t) => {
  const { db, store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const normalized = resultFor(context);
  store.save(began.token, normalized, timing());

  const invalidated = store.invalidate(assetId);
  assert.deepEqual(invalidated, {
    ok: true,
    assetId,
    revokedCommit: false,
    invalidatedResult: true,
  });
  const got = store.get(assetId, context);
  assert.equal(got.status, "stale");
  assert.equal(got.reason, "INVALIDATED");
  assert.deepEqual(got.result, normalized);
  assert.equal(count(db, "audio_result_records"), 1);

  const again = store.invalidate(assetId);
  assert.equal(again.revokedCommit, false);
  assert.equal(again.invalidatedResult, false);

  const pending = store.begin(assetId, "job_02", ident);
  assert.equal(pending.ok, true);
  const revoked = store.invalidate(assetId);
  assert.equal(revoked.revokedCommit, true);
  assert.equal(revoked.invalidatedResult, false);
  expectCode("TOKEN_CONSUMED", () =>
    store.save(pending.token, resultFor(context), timing()),
  );
});

test("invalidate 后新 begin/save 重新变 ready", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const first = store.begin(assetId, "job_01", ident);
  store.save(first.token, resultFor(context), timing());
  store.invalidate(assetId);
  const second = store.begin(assetId, "job_02", ident);
  store.save(second.token, resultFor(context, baseRaw({ bpm: 100 })), timing());
  const got = store.get(assetId, context);
  assert.equal(got.status, "ready");
  assert.equal(got.result.value.bpm, 100);
});

test("begin 后身份未变不使旧成功结果 stale", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const first = store.begin(assetId, "job_01", ident);
  store.save(first.token, resultFor(context), timing());
  store.begin(assetId, "job_02", ident);
  assert.equal(store.get(assetId, context).status, "ready");
});

test("begin 对照 expectedIdentity，generation 变化固定 IDENTITY_CHANGED", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const expected = { ...ident, assetGeneration: "9".repeat(32) };
  expectCode("IDENTITY_CHANGED", () => store.begin(assetId, "job_01", expected));
  assert.equal(store.get(assetId, context).status, "missing");
});

test("隐藏/离线/trashed/retired/rootRetired/busy 的 begin 拒绝", async (t) => {
  const context = baseContext();
  const flags = ["online", "trashed", "retired", "rootRetired", "busy"];
  for (const flag of flags) {
    const assetId = `asset_${flag}`;
    const ident = identity(assetId, context, { [flag]: flag === "online" ? false : true });
    const db = new Database(":memory:");
    t.after(() => {
      try {
        db.close();
      } catch {}
    });
    const store = new AudioResultStore({ db, resolveCurrent: () => ident });
    store.initSchema();
    expectCode("ASSET_UNAVAILABLE", () => store.begin(assetId, "job_01", ident));
  }
});

test("resolver 返回 null：begin 不可用、get missing", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t, {
    resolveCurrent: () => null,
  });
  expectCode("ASSET_UNAVAILABLE", () => store.begin(assetId, "job_01", ident));
  assert.equal(store.get(assetId, context).status, "missing");
});

test("save 前身份 generation/context 变化固定 IDENTITY_CHANGED 且旧结果保留", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const first = store.begin(assetId, "job_01", ident);
  const oldResult = resultFor(context);
  store.save(first.token, oldResult, timing());

  const second = store.begin(assetId, "job_02", ident);
  ident.assetGeneration = "9".repeat(32);
  expectCode("IDENTITY_CHANGED", () => store.save(second.token, oldResult, timing()));
  const stale = store.get(assetId, context);
  assert.equal(stale.status, "stale");
  assert.equal(stale.reason, "CURRENT_CHANGED");
  assert.deepEqual(stale.result, oldResult);

  ident.context = baseContext({ durationSec: 500 });
  expectCode("IDENTITY_CHANGED", () => store.save(second.token, resultFor(ident.context), timing()));
});

test("save 结果 context 与 commit 不一致固定 RESULT_MISMATCH", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const other = resultFor(baseContext({ durationSec: 500 }));
  expectCode("RESULT_MISMATCH", () => store.save(began.token, other, timing()));
  assert.equal(store.get(assetId, context).status, "missing");
});

test("get 对隐藏/离线/trashed/retired/rootRetired/busy 一律 missing 且不泄露值", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  store.save(began.token, resultFor(context), timing());

  const flags = ["online", "trashed", "retired", "rootRetired", "busy"];
  for (const flag of flags) {
    ident[flag] = flag === "online" ? false : true;
    const got = store.get(assetId, context);
    assert.deepEqual(got, { ok: true, status: "missing" });
    assert.equal(got.result, undefined);
    assert.doesNotMatch(JSON.stringify(got), /120|bpm|C major/);
    ident[flag] = flag === "online";
  }
});

test("get 对 expectedContext 变化返回 stale CONTEXT_CHANGED", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const normalized = resultFor(context);
  store.save(began.token, normalized, timing());
  const got = store.get(assetId, baseContext({ durationSec: 500 }));
  assert.equal(got.status, "stale");
  assert.equal(got.reason, "CONTEXT_CHANGED");
  assert.deepEqual(got.result, normalized);
});

test("get 对当前 context/generation 变化返回 stale CURRENT_CHANGED", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const normalized = resultFor(context);
  store.save(began.token, normalized, timing());

  ident.context = baseContext({ engineVersion: "2.0.0" });
  let got = store.get(assetId, context);
  assert.equal(got.reason, "CURRENT_CHANGED");
  assert.deepEqual(got.result, normalized);

  ident.context = context;
  for (const [name, value] of [
    ["libraryGeneration", "4".repeat(32)],
    ["assetGeneration", "5".repeat(32)],
    ["sourceGeneration", "6".repeat(32)],
  ]) {
    const before = ident[name];
    ident[name] = value;
    got = store.get(assetId, context);
    assert.equal(got.status, "stale");
    assert.equal(got.reason, "CURRENT_CHANGED");
    ident[name] = before;
  }
});

test("resolver 抛异常固定 RESOLVER_FAILED 且不泄露原始信息", async (t) => {
  let armed = false;
  const { store, assetId, context, ident } = await makeStore(t, {
    resolveCurrent: () => {
      if (armed) throw new Error("/private/synthetic/secret.wav SQL SELECT");
      return ident;
    },
  });
  const began = store.begin(assetId, "job_01", ident);
  armed = true;
  const saved = expectCode("RESOLVER_FAILED", () =>
    store.save(began.token, resultFor(context), timing()),
  );
  assert.doesNotMatch(saved.message, /private|SQL|wav/i);
  expectCode("RESOLVER_FAILED", () => store.get(assetId, context));
  expectCode("RESOLVER_FAILED", () => store.begin(assetId, "job_02", ident));
});

test("resolver 返回 Promise/thenable 固定 RESOLVER_FAILED", async (t) => {
  const { db } = await tempDb(t);
  const context = baseContext();
  const ident = identity("asset_01", context);
  const stores = [
    new AudioResultStore({ db, resolveCurrent: async () => ident }),
    new AudioResultStore({ db, resolveCurrent: () => ({ then() {} }) }),
  ];
  for (const store of stores) {
    store.initSchema();
    expectCode("RESOLVER_FAILED", () => store.get("asset_01", context));
    expectCode("RESOLVER_FAILED", () => store.begin("asset_01", "job_01", ident));
  }
});

test("resolver 形状错误/访问器固定 INVALID_IDENTITY 且不执行 getter", async (t) => {
  const { db } = await tempDb(t);
  const context = baseContext();
  const valid = identity("asset_01", context);

  const missing = { ...valid };
  delete missing.context;
  let getterRan = 0;
  const withGetter = { ...valid };
  Object.defineProperty(withGetter, "online", {
    enumerable: true,
    get() {
      getterRan += 1;
      return true;
    },
  });
  const extra = { ...valid, path: "/private/synthetic/secret.wav" };

  for (const bad of [missing, withGetter, extra]) {
    const store = new AudioResultStore({ db, resolveCurrent: () => bad });
    store.initSchema();
    expectCode("INVALID_IDENTITY", () => store.get("asset_01", context));
    expectCode("INVALID_IDENTITY", () => store.begin("asset_01", "job_01", valid));
  }
  assert.equal(getterRan, 0);
});

test("resolver 复用可变对象：begin 快照后原位修改不能影响资格", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  ident.assetGeneration = "9".repeat(32);
  expectCode("IDENTITY_CHANGED", () => store.save(began.token, resultFor(context), timing()));

  const second = store.begin(assetId, "job_02", ident);
  store.save(second.token, resultFor(context), timing());
  assert.equal(store.get(assetId, context).status, "ready");
});

test("save 只接受严格 T13D 成功结构：伪造 ok/未知字段/schema/协议/指纹", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const normalized = resultFor(context);

  for (const bad of [
    { ok: true },
    { ...normalized, ok: false },
    { ...normalized, schemaVersion: 2 },
    { ...normalized, protocol: "other" },
    { ...normalized, extra: "x" },
    { ...normalized, fingerprint: "0".repeat(64) },
    { ...normalized, fingerprint: normalized.fingerprint.slice(0, 63) },
    { ...normalized, provenance: { ...normalized.provenance, engineVersion: "2.0.0" } },
    { ...normalized, value: { ...normalized.value, bpm: 999 } },
    { ...normalized, value: { ...normalized.value, src: "/private/a.wav" } },
    { ...normalized, warnings: ["HACK"] },
    { ...normalized, warnings: ["BPM_UNAVAILABLE", "BPM_UNAVAILABLE"] },
    { ...normalized, warnings: ["BPM_UNAVAILABLE"] },
    { ...normalized, warnings: ["KEY_UNRECOGNIZED"] },
    { ...normalized, value: { ...normalized.value, loud: { peakDbfs: 51, rmsDbfs: null } } },
    { ...normalized, value: { ...normalized.value, loud: { peakDbfs: Infinity, rmsDbfs: null } } },
    { ...normalized, value: { ...normalized.value, key: { ...normalized.value.key, keyScore: "0.5" } } },
    {
      ...normalized,
      value: {
        ...normalized.value,
        energy: { minDbfs: 0, maxDbfs: -10, stdDb: 1 },
      },
    },
    {
      ...normalized,
      value: {
        ...normalized.value,
        seg: { energyChangeSec: [0, 10, 9] },
      },
    },
    { ...normalized, value: { ...normalized.value, unknownNested: {} } },
    { ...normalized, path: "x" },
  ]) {
    expectCode("INVALID_RESULT", () => store.save(began.token, bad, timing()));
  }
  assert.equal(store.get(assetId, context).status, "missing");

  const validUnknown = resultFor(context, baseRaw({ pad: "ignored" }));
  assert.deepEqual(validUnknown.warnings, ["UNKNOWN_FIELDS_IGNORED"]);
  store.save(began.token, validUnknown, timing());
  assert.equal(store.get(assetId, context).status, "ready");
});

test("save 拒绝缺失/NaN/Infinity/字符串/未来时间字段", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const normalized = resultFor(context);
  for (const bad of [
    undefined,
    {},
    { analyzedMs: 1 },
    { analyzedAtMs: 1 },
    { analyzedMs: 1, analyzedAtMs: 1, extra: 2 },
    { analyzedMs: NaN, analyzedAtMs: 1 },
    { analyzedMs: Infinity, analyzedAtMs: 1 },
    { analyzedMs: -1, analyzedAtMs: 1 },
    { analyzedMs: "1", analyzedAtMs: 1 },
    { analyzedMs: 1, analyzedAtMs: 1.5 },
    { analyzedMs: 1, analyzedAtMs: -1 },
    Object.defineProperty({ analyzedAtMs: 1 }, "analyzedMs", { enumerable: true, get: () => 1 }),
  ]) {
    expectCode("INVALID_TIMES", () => store.save(began.token, normalized, bad));
  }
  const ok = store.save(began.token, normalized, { analyzedMs: 1.5, analyzedAtMs: 0 });
  assert.equal(ok.ok, true);
});

test("超大/未知填充与 1001 个 seg 点拒绝", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const normalized = resultFor(context);
  const huge = { ...normalized, pad: "x".repeat(70_000) };
  expectCode("INVALID_RESULT", () => store.save(began.token, huge, timing()));

  const tooManySeg = {
    ...normalized,
    value: {
      ...normalized.value,
      seg: { energyChangeSec: Array.from({ length: 1001 }, (_, index) => index * 0.1) },
    },
  };
  expectCode("INVALID_RESULT", () => store.save(began.token, tooManySeg, timing()));
  assert.ok(MAX_STORE_PAYLOAD_BYTES <= 64 * 1024);
});

test("get 对坏 JSON 受控 stale CORRUPT，不返回原始行", async (t) => {
  const { db, store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  store.save(began.token, resultFor(context), timing());
  db.prepare("UPDATE audio_result_records SET payload_json = ? WHERE asset_id = ?").run(
    "{bad-json",
    assetId,
  );
  const got = store.get(assetId, context);
  assert.equal(got.status, "stale");
  assert.equal(got.reason, "CORRUPT");
  assert.equal(got.result, null);
  assert.doesNotMatch(JSON.stringify(got), /payload_json|bad-json|SELECT/);
});

test("get 检测 payload 原位篡改（即使指纹不变）", async (t) => {
  const { db, store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  store.save(began.token, resultFor(context), timing());
  const result = db
    .prepare("UPDATE audio_result_records SET payload_json = replace(payload_json, '\"bpm\":120', '\"bpm\":121') WHERE asset_id = ?")
    .run(assetId);
  assert.equal(result.changes, 1);
  const got = store.get(assetId, context);
  assert.equal(got.status, "stale");
  assert.equal(got.reason, "CORRUPT");
  assert.equal(got.result, null);
});

test("get 解析前拒绝超大/伪长度/非文本 payload，且不改写记录", async (t) => {
  const { db, store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  store.save(began.token, resultFor(context), timing());
  const select = db.prepare(
    "SELECT payload_json, payload_bytes FROM audio_result_records WHERE asset_id = ?",
  );
  const original = { ...select.get(assetId) };

  const cases = [
    {
      name: "1MiB payload with fake small length",
      text: '{"padding":"' + "x".repeat(1024 * 1024) + '"}',
      bytes: 1,
    },
    {
      name: "oversized declared length with small valid payload",
      text: original.payload_json,
      bytes: MAX_STORE_PAYLOAD_BYTES + 1,
    },
    {
      name: "declared length mismatch",
      text: original.payload_json,
      bytes: original.payload_bytes + 1,
    },
    { name: "non-text BLOB payload", text: Buffer.from([0xff, 0x00]), bytes: 2 },
    {
      name: "bad payload_bytes type",
      text: original.payload_json,
      bytes: "/private/synthetic/bytes",
    },
    { name: "negative payload_bytes", text: original.payload_json, bytes: -1 },
  ];

  for (const item of cases) {
    db.prepare(
      "UPDATE audio_result_records SET payload_json = ?, payload_bytes = ? WHERE asset_id = ?",
    ).run(item.text, item.bytes, assetId);

    const realParse = JSON.parse;
    let parseCalls = 0;
    let parsedHuge = false;
    JSON.parse = (value, ...rest) => {
      parseCalls += 1;
      if (typeof value === "string" && Buffer.byteLength(value, "utf8") > MAX_STORE_PAYLOAD_BYTES) {
        parsedHuge = true;
      }
      return realParse(value, ...rest);
    };
    let got;
    try {
      got = store.get(assetId, context);
    } finally {
      JSON.parse = realParse;
    }

    assert.equal(got.status, "stale", item.name);
    assert.equal(got.reason, "CORRUPT", item.name);
    assert.equal(got.result, null, item.name);
    assert.equal(parseCalls, 0, `${item.name}: payload must not reach JSON.parse`);
    assert.equal(parsedHuge, false, item.name);
    assert.equal(JSON.stringify(got).includes("/private/"), false, item.name);
    assert.deepEqual(
      select.get(assetId),
      { payload_json: item.text, payload_bytes: item.bytes },
      item.name,
    );
  }
});

test("get 时间列类型/范围损坏固定 CORRUPT，ready/stale 各出口不带坏值", async (t) => {
  const { db, store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  store.save(began.token, resultFor(context), timing());
  const rowStmt = db.prepare(
    `SELECT analyzed_ms, analyzed_at_ms, saved_at_ms, invalidated_at_ms
       FROM audio_result_records WHERE asset_id = ?`,
  );
  const good = { ...rowStmt.get(assetId) };
  const restore = () =>
    db
      .prepare(
        `UPDATE audio_result_records
            SET analyzed_ms = ?, analyzed_at_ms = ?, saved_at_ms = ?, invalidated_at_ms = ?
          WHERE asset_id = ?`,
      )
      .run(good.analyzed_ms, good.analyzed_at_ms, good.saved_at_ms, good.invalidated_at_ms, assetId);

  const cases = [
    ["analyzed_ms text", "analyzed_ms = ?", "/private/synthetic/analyzed"],
    ["analyzed_ms negative", "analyzed_ms = ?", -1],
    ["analyzed_at_ms text", "analyzed_at_ms = ?", "/private/synthetic/at"],
    ["analyzed_at_ms malformed numeric text", "analyzed_at_ms = ?", "1700000000000x"],
    ["analyzed_at_ms non-integer", "analyzed_at_ms = ?", 1.5],
    ["analyzed_at_ms negative", "analyzed_at_ms = ?", -1],
    ["saved_at_ms text", "saved_at_ms = ?", "/private/synthetic/saved"],
    ["saved_at_ms negative", "saved_at_ms = ?", -123],
    ["saved_at_ms non-integer", "saved_at_ms = ?", 1.5],
    ["invalidated_at_ms text", "invalidated_at_ms = ?", "/private/synthetic/invalidated"],
    ["invalidated_at_ms negative", "invalidated_at_ms = ?", -1],
    ["invalidated_at_ms non-integer", "invalidated_at_ms = ?", 1.5],
  ];

  for (const [name, assignment, value] of cases) {
    restore();
    db.prepare(`UPDATE audio_result_records SET ${assignment} WHERE asset_id = ?`).run(value, assetId);
    const got = store.get(assetId, context);
    assert.equal(got.status, "stale", name);
    assert.equal(got.reason, "CORRUPT", name);
    assert.equal(got.result, null, name);
    assert.equal(JSON.stringify(got).includes("/private/"), false, name);
    assert.equal(Object.hasOwn(got, "savedAtMs"), false, name);
    assert.equal(Object.hasOwn(got, "analyzedMs"), false, name);
    assert.equal(Object.hasOwn(got, "analyzedAtMs"), false, name);
  }

  restore();
  const ready = store.get(assetId, context);
  assert.equal(ready.status, "ready");
  assert.equal(ready.savedAtMs, good.saved_at_ms);
  assert.equal(ready.analyzedMs, good.analyzed_ms);
  assert.equal(ready.analyzedAtMs, good.analyzed_at_ms);

  store.invalidate(assetId);
  const invalidated = store.get(assetId, context);
  assert.equal(invalidated.status, "stale");
  assert.equal(invalidated.reason, "INVALIDATED");

  // INVALIDATED 出口也先校验时间列
  db.prepare("UPDATE audio_result_records SET invalidated_at_ms = ? WHERE asset_id = ?").run(
    "/private/synthetic/invalidated-exit",
    assetId,
  );
  assert.equal(store.get(assetId, context).reason, "CORRUPT");

  // CONTEXT_CHANGED 出口也先校验时间列
  const changedContext = baseContext({ sourceSize: 54_321 });
  db.prepare("UPDATE audio_result_records SET invalidated_at_ms = NULL WHERE asset_id = ?").run(assetId);
  db.prepare("UPDATE audio_result_records SET saved_at_ms = ? WHERE asset_id = ?").run(-1, assetId);
  assert.equal(store.get(assetId, changedContext).reason, "CORRUPT");
  db.prepare("UPDATE audio_result_records SET saved_at_ms = ? WHERE asset_id = ?").run(
    good.saved_at_ms,
    assetId,
  );
  assert.equal(store.get(assetId, changedContext).reason, "CONTEXT_CHANGED");

  // CURRENT_CHANGED 出口也先校验时间列
  ident.assetGeneration = "9".repeat(32);
  assert.equal(store.get(assetId, context).reason, "CURRENT_CHANGED");
  db.prepare("UPDATE audio_result_records SET analyzed_ms = ? WHERE asset_id = ?").run(
    "/private/synthetic/current-exit",
    assetId,
  );
  assert.equal(store.get(assetId, context).reason, "CORRUPT");
});

test("resolver 普通 thenable 不被调用，访问器 then 不执行 getter", async (t) => {
  const { db } = await tempDb(t);
  const context = baseContext();
  const ident = identity("asset_01", context);
  let thenCalls = 0;
  let thenGetterCalls = 0;
  const rejectingThenable = {
    then() {
      thenCalls += 1;
      throw new Error("/private/synthetic/thenable");
    },
  };
  const accessorThen = { ...ident };
  Object.defineProperty(accessorThen, "then", {
    enumerable: true,
    get() {
      thenGetterCalls += 1;
      return () => {};
    },
  });

  for (const resolveCurrent of [() => rejectingThenable, () => accessorThen]) {
    const store = new AudioResultStore({ db, resolveCurrent });
    store.initSchema();
    expectCode("RESOLVER_FAILED", () => store.get("asset_01", context));
    expectCode("RESOLVER_FAILED", () => store.begin("asset_01", "job_01", ident));
  }
  assert.equal(thenCalls, 0);
  assert.equal(thenGetterCalls, 0);
});

test("resolver 原生 Promise 的 then 被遮蔽/伪造仍固定 RESOLVER_FAILED", async (t) => {
  const { db } = await tempDb(t);
  const context = baseContext();
  const ident = identity("asset_01", context);
  let thenGetterCalls = 0;
  const makers = [
    () => {
      const pending = Promise.resolve(ident);
      Object.defineProperty(pending, "then", { value: null, configurable: true });
      return pending;
    },
    () => {
      const pending = Promise.resolve(ident);
      Object.defineProperty(pending, "then", { value: undefined, configurable: true });
      return pending;
    },
    () => {
      const pending = Promise.resolve(ident);
      Object.defineProperty(pending, "then", { value: 42, configurable: true });
      return pending;
    },
    () => {
      const pending = Promise.resolve(ident);
      Object.defineProperty(pending, "then", {
        configurable: true,
        get() {
          thenGetterCalls += 1;
          return () => {};
        },
      });
      return pending;
    },
  ];

  for (const make of makers) {
    const store = new AudioResultStore({ db, resolveCurrent: make });
    store.initSchema();
    expectCode("RESOLVER_FAILED", () => store.get("asset_01", context));
    expectCode("RESOLVER_FAILED", () => store.begin("asset_01", "job_01", ident));
  }
  assert.equal(thenGetterCalls, 0);
});

test("resolver 反射陷阱固定 RESOLVER_FAILED", async (t) => {
  const { db } = await tempDb(t);
  const context = baseContext();
  const ident = identity("asset_01", context);
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const store = new AudioResultStore({ db, resolveCurrent: () => proxy });
  store.initSchema();
  expectCode("RESOLVER_FAILED", () => store.get("asset_01", context));
  expectCode("RESOLVER_FAILED", () => store.begin("asset_01", "job_01", ident));
});

test("resolver 异步拒绝被安全消费：async/Promise.reject 不产生 unhandledRejection", async () => {
  const moduleUrl = new URL("../server/audio-result-store.mjs", import.meta.url).href;
  const resultUrl = new URL("../server/audio-result.mjs", import.meta.url).href;
  const packagePath = path.join(import.meta.dirname, "..", "package.json");
  const context = baseContext();
  const ident = identity("asset_01", context);
  const scenarios = [
    ["async throw", "async () => { throw new Error('/private/synthetic/async'); }"],
    ["Promise.reject", "() => Promise.reject(new Error('/private/synthetic/reject'))"],
    [
      "already rejected promise",
      "() => { const pending = Promise.reject(new Error('/private/synthetic/rejected')); return pending; }",
    ],
    [
      "rejected promise with shadowed then=null",
      "() => { const pending = Promise.reject(new Error('/private/synthetic/masked-null')); Object.defineProperty(pending, 'then', { value: null, configurable: true }); return pending; }",
    ],
    [
      "rejected promise with shadowed then=undefined",
      "() => { const pending = Promise.reject(new Error('/private/synthetic/masked-undefined')); Object.defineProperty(pending, 'then', { value: undefined, configurable: true }); return pending; }",
    ],
    [
      "rejected promise with shadowed then=non-function",
      "() => { const pending = Promise.reject(new Error('/private/synthetic/masked-number')); Object.defineProperty(pending, 'then', { value: 42, configurable: true }); return pending; }",
    ],
    [
      "rejected promise with throwing then getter",
      "() => { const pending = Promise.reject(new Error('/private/synthetic/masked-getter')); Object.defineProperty(pending, 'then', { configurable: true, get() { throw new Error('/private/synthetic/then-getter'); } }); return pending; }",
    ],
  ];

  for (const [name, body] of scenarios) {
    const script = `
      import { createRequire } from "node:module";
      import { AudioResultStore } from ${JSON.stringify(moduleUrl)};
      import { normalizeAudioResult } from ${JSON.stringify(resultUrl)};
      const require = createRequire(${JSON.stringify(packagePath)});
      const Database = require("better-sqlite3");
      const db = new Database(":memory:");
      const context = ${JSON.stringify(context)};
      const ident = ${JSON.stringify(ident)};
      const rejecting = ${body};
      let unhandled = 0;
      process.on("unhandledRejection", () => { unhandled += 1; });
      let mode = "ok";
      const store = new AudioResultStore({
        db,
        resolveCurrent: () => (mode === "ok" ? ident : rejecting()),
      });
      store.initSchema();
      const codes = [];
      const run = (fn) => {
        try { fn(); codes.push("NO_ERROR"); }
        catch (error) { codes.push(error.code); }
      };
      const began = store.begin("asset_01", "job_01", ident);
      const result = normalizeAudioResult('{"bpm":120}', context);
      if (result.ok !== true) throw new Error("normalize failed");
      mode = "reject";
      run(() => store.get("asset_01", context));
      run(() => store.begin("asset_01", "job_02", ident));
      run(() => store.save(began.token, result, { analyzedMs: 1, analyzedAtMs: 1 }));
      setTimeout(() => {
        db.close();
        console.log(JSON.stringify({ codes, unhandled }));
        process.exitCode = codes.length === 3 && codes.every((code) => code === "RESOLVER_FAILED") && unhandled === 0 ? 0 : 1;
      }, 25);
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(child.status, 0, `${name}: ${child.stdout}${child.stderr}`);
  }
});

test("SQL 写入故障回滚，旧成功结果与提交资格不丢", async (t) => {
  const { db, store, assetId, context, ident } = await makeStore(t);
  const first = store.begin(assetId, "job_01", ident);
  const oldResult = resultFor(context);
  store.save(first.token, oldResult, timing());

  db.exec(`
    CREATE TRIGGER fail_record_update
    BEFORE UPDATE ON audio_result_records
    BEGIN
      SELECT RAISE(ABORT, 'blocked');
    END;
  `);
  const second = store.begin(assetId, "job_02", ident);
  const error = expectCode("STORAGE_ERROR", () =>
    store.save(second.token, resultFor(context, baseRaw({ bpm: 90 })), timing()),
  );
  assert.doesNotMatch(error.message, /blocked|audio_result|UPDATE|SELECT/i);

  assert.equal(store.get(assetId, context).status, "ready");
  assert.deepEqual(store.get(assetId, context).result, oldResult);
  const commit = db
    .prepare("SELECT consumed_at_ms FROM audio_result_commits WHERE asset_id = ?")
    .get(assetId);
  assert.equal(commit.consumed_at_ms, null);

  db.exec("DROP TRIGGER fail_record_update");
  const saved = store.save(second.token, resultFor(context, baseRaw({ bpm: 90 })), timing());
  assert.equal(saved.ok, true);
  assert.equal(store.get(assetId, context).result.value.bpm, 90);
});

test("SQLITE_BUSY 固定 STORAGE_BUSY 且不递归重试", async (t) => {
  const { db } = await tempDb(t);
  const context = baseContext();
  const ident = identity("asset_01", context);
  let armed = false;
  let attempts = 0;
  const wrapper = {
    get open() {
      return db.open;
    },
    prepare(...args) {
      attempts += 1;
      if (armed) {
        const error = new Error("SQLITE_BUSY: database is locked");
        error.code = "SQLITE_BUSY";
        throw error;
      }
      return db.prepare(...args);
    },
    exec(...args) {
      return db.exec(...args);
    },
    transaction(fn) {
      return db.transaction(fn);
    },
  };
  const store = new AudioResultStore({ db: wrapper, resolveCurrent: () => ident });
  store.initSchema();
  armed = true;
  attempts = 0;
  const error = expectCode("STORAGE_BUSY", () => store.begin("asset_01", "job_01", ident));
  assert.equal(attempts, 1);
  assert.equal(error.message, "database is busy");
});

test("get 可在只读连接上读取，save 不写坏", async (t) => {
  const { file, store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const normalized = resultFor(context);
  store.save(began.token, normalized, timing());
  const pending = store.begin(assetId, "job_02", ident);

  const readonly = new Database(file, { readonly: true });
  t.after(() => {
    try {
      readonly.close();
    } catch {}
  });
  const store2 = new AudioResultStore({ db: readonly, resolveCurrent: () => ident });
  assert.equal(store2.initSchema().created, false);
  const got = store2.get(assetId, context);
  assert.equal(got.status, "ready");
  assert.deepEqual(got.result, normalized);

  expectCode("STORAGE_ERROR", () =>
    store2.save(pending.token, resultFor(context, baseRaw({ bpm: 90 })), timing()),
  );
});

test("模块静态边界：不引入文件/网络/子进程", async () => {
  const source = await fs.readFile(
    path.join(import.meta.dirname, "..", "server", "audio-result-store.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["'](?:node:)?(?:fs|net|http|https|child_process|dgram|dns)["']/);
  assert.doesNotMatch(source, /\bspawn\s*\(|\bfetch\s*\(|execFile\s*\(/);
  assert.match(source, /from "\.\/audio-result\.mjs"/);
});

test("公开返回值深度冻结", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  assert.ok(Object.isFrozen(began));
  const saved = store.save(began.token, resultFor(context), timing());
  assert.ok(Object.isFrozen(saved));
  const got = store.get(assetId, context);
  assert.ok(Object.isFrozen(got));
  assert.ok(Object.isFrozen(got.result));
  assert.ok(Object.isFrozen(got.result.value));
  assert.ok(Object.isFrozen(got.result.value.seg));
  assert.throws(() => {
    got.status = "hacked";
  }, TypeError);
  assert.throws(() => {
    got.result.value.bpm = 1;
  }, TypeError);
});

test("旧 asset_audio 在完整 begin/save/get/invalidate 流程后不变", async (t) => {
  const { db, store, assetId, context, ident } = await makeStore(t);
  db.exec("CREATE TABLE asset_audio (id TEXT PRIMARY KEY, payload TEXT)");
  db.prepare("INSERT INTO asset_audio (id, payload) VALUES (?, ?)").run("old", "keep");
  const began = store.begin(assetId, "job_01", ident);
  store.save(began.token, resultFor(context), timing());
  store.get(assetId, context);
  store.invalidate(assetId);
  assert.deepEqual(db.prepare("SELECT id, payload FROM asset_audio").all(), [
    { id: "old", payload: "keep" },
  ]);
});

test("负零测量值按原值往返，不被 JSON 序列化改写成 0", async (t) => {
  const context = baseContext();
  const raw =
    '{"bpm":120,"key":{"best":"C major","r":-0},"loud":{"peak":-0,"rms":-12},' +
    '"energy":{"min":-0,"max":0,"std":-0},"fit":{"beat":-0,"tonal":0,"chord":-0},' +
    '"seg":[-0,10]}';
  const normalized = normalizeAudioResult(raw, context);
  assert.equal(normalized.ok, true);
  assert.ok(Object.is(normalized.value.key.keyScore, -0));
  assert.ok(Object.is(normalized.value.loud.peakDbfs, -0));
  assert.ok(Object.is(normalized.value.energy.minDbfs, -0));
  assert.ok(Object.is(normalized.value.energy.stdDb, -0));
  assert.ok(Object.is(normalized.value.fit.beat, -0));
  assert.ok(Object.is(normalized.value.seg.energyChangeSec[0], -0));

  const { store, assetId, ident } = await makeStore(t, { context });
  const began = store.begin(assetId, "job_01", ident);
  store.save(began.token, normalized, timing());
  const got = store.get(assetId, context);
  assert.equal(got.status, "ready");
  assert.deepEqual(got.result, normalized);
  assert.ok(Object.is(got.result.value.key.keyScore, -0));
  assert.ok(Object.is(got.result.value.loud.peakDbfs, -0));
  assert.ok(Object.is(got.result.value.seg.energyChangeSec[0], -0));
});

test("result/timing 反射陷阱收敛为固定失败码，不泄露原始异常", async (t) => {
  const { store, assetId, context, ident } = await makeStore(t);
  const began = store.begin(assetId, "job_01", ident);
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  expectCode("INVALID_RESULT", () => store.save(began.token, proxy, timing()));

  const normalized = resultFor(context);
  const { proxy: badTiming, revoke: revokeTiming } = Proxy.revocable({}, {});
  revokeTiming();
  expectCode("INVALID_TIMES", () => store.save(began.token, normalized, badTiming));
});

/* ------------------------------------------------------------------ */
/* T13G：token 定向撤销                                                */
/* ------------------------------------------------------------------ */

test("invalidateToken 只撤销匹配的当前资格，旧/消费/未知 token 不影响新任务", async (t) => {
  const { store, assetId, context, ident, db } = await makeStore(t);
  const normalized = resultFor(context);

  const first = store.begin(assetId, "job_01", ident);
  store.save(first.token, normalized, timing());
  assert.equal(store.get(assetId, context).status, "ready");

  // 已消费 token 不能把已提交结果改 stale。
  assert.deepEqual(store.invalidateToken(first.token), {
    ok: true,
    tokenMatched: true,
    revokedCommit: false,
    invalidatedResult: false,
  });
  assert.equal(store.get(assetId, context).status, "ready");

  // 新 begin 替换旧 token；旧 token 撤销不得影响新资格。
  const second = store.begin(assetId, "job_02", ident);
  assert.deepEqual(store.invalidateToken(first.token), {
    ok: true,
    tokenMatched: false,
    revokedCommit: false,
    invalidatedResult: false,
  });
  assert.equal(
    db.prepare("SELECT token_sha256, consumed_at_ms FROM audio_result_commits WHERE asset_id = ?").get(assetId)
      .token_sha256,
    createHash("sha256").update(second.token).digest("hex"),
    "旧 token 撤销不得消费/替换新 token",
  );

  // 撤销当前 token：资格消费 + 旧成功 stale，但不删记录。
  assert.deepEqual(store.invalidateToken(second.token), {
    ok: true,
    tokenMatched: true,
    revokedCommit: true,
    invalidatedResult: true,
  });
  const stale = store.get(assetId, context);
  assert.equal(stale.status, "stale");
  assert.equal(stale.reason, "INVALIDATED");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM audio_result_records WHERE asset_id = ?").get(assetId).n,
    1,
  );
  // 幂等：再次撤销同一 token 不重复改变任何东西。
  assert.deepEqual(store.invalidateToken(second.token), {
    ok: true,
    tokenMatched: true,
    revokedCommit: false,
    invalidatedResult: false,
  });
});

test("invalidateToken 拒绝畸形 token，未知 token 幂等无副作用", async (t) => {
  const { store, assetId, context, ident, db } = await makeStore(t);
  const first = store.begin(assetId, "job_01", ident);
  store.save(first.token, resultFor(context), timing());
  const before = db.prepare("SELECT * FROM audio_result_records").get();

  for (const bad of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64), 42, null, undefined]) {
    expectCode("INVALID_TOKEN", () => store.invalidateToken(bad));
  }
  assert.deepEqual(
    store.invalidateToken("f".repeat(64)),
    { ok: true, tokenMatched: false, revokedCommit: false, invalidatedResult: false },
  );
  assert.deepEqual(db.prepare("SELECT * FROM audio_result_records").get(), before);
  assert.equal(store.get(assetId, context).status, "ready");
  // 未知 token 撤销后，原本的当前资格仍可正常保存。
  const second = store.begin(assetId, "job_02", ident);
  assert.equal(store.save(second.token, resultFor(context), timing()).ok, true);
});
