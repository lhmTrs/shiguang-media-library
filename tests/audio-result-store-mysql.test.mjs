/**
 * T-LOCAL-013F 定向测试：MySQL 结果存储与真实双连接隔离验收。
 *
 * 默认 **不** 启动 MySQL：只有显式 `T13F_MYSQL=1 node --test ...` 才运行；
 * 未显式开启时整个 describe 带清楚的 skip 理由，普通 `npm test` 不会拉起数据库。
 * 显式开启后，任何 mysqld 初始化/启动失败都直接 fail，绝不 skip 成“通过”。
 *
 * 只使用本文件通过 fixture 新建的一次性 mysqld（0700 临时目录、私有 socket、
 * --skip-networking）与合成 JSON；不连接 3306/已有实例，不读写真实素材库/账号/
 * 凭据，不运行引擎/真实音频，不部署/重启/提交/推送。
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { normalizeAudioResult } from "../server/audio-result.mjs";
import {
  AudioResultStore,
  AudioResultStoreError,
  STORE_SCHEMA_VERSION,
} from "../server/audio-result-store.mjs";
import { MysqlDatabase } from "../server/mysql-db.mjs";
import {
  MYSQL_OPT_IN_ENV,
  startMysqlFixture,
} from "./audio-result-store-mysql-fixture.mjs";

const ENABLED = process.env[MYSQL_OPT_IN_ENV] === "1";
const SKIP_REASON = ENABLED
  ? false
  : `T-LOCAL-013F MySQL 套件默认不启动数据库；显式设置 ${MYSQL_OPT_IN_ENV}=1 运行`;

let fixture = null;

/* ------------------------------------------------------------------ */
/* 合成数据                                                            */
/* ------------------------------------------------------------------ */

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

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function expectCode(code, fn) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}`);
  assert.ok(caught instanceof AudioResultStoreError, `expected AudioResultStoreError, got ${caught?.name}`);
  assert.equal(caught.code, code);
  assert.equal(typeof caught.message, "string");
  assert.ok(caught.message.length > 0);
  assert.doesNotMatch(caught.message, /SELECT|INSERT|UPDATE|password|socket|root_01/i);
  return caught;
}

/* ------------------------------------------------------------------ */
/* 夹具/连接辅助                                                       */
/* ------------------------------------------------------------------ */

async function q(sql, values = []) {
  const [rows] = await fixture.query(sql, values);
  return rows;
}

async function dropStoreTables() {
  await fixture.query(
    "DROP TABLE IF EXISTS audio_result_records, audio_result_commits, audio_result_store_meta",
  );
}

function openDb(t) {
  const db = new MysqlDatabase(fixture.config);
  t.after(() => {
    try {
      db.close();
    } catch {}
  });
  return db;
}

function openStore(t, db, resolveCurrent) {
  const store = new AudioResultStore({ db, resolveCurrent });
  return store;
}

async function tableNames() {
  const rows = await q(
    `SELECT TABLE_NAME AS name
       FROM information_schema.tables
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'audio_result_%'
      ORDER BY TABLE_NAME`,
  );
  return rows.map((row) => row.name);
}

/** 起一个独立连接 worker；所有 worker 都等到 ready 后由主线程统一放行。 */
function spawnWorker(role, params) {
  const sync = new SharedArrayBuffer(8);
  const worker = new Worker(new URL("./audio-result-store-mysql-fixture.mjs", import.meta.url), {
    workerData: { t13fRole: role, config: fixture.config, params, sync },
  });
  const gate = new Int32Array(sync);
  const messages = [];
  const waiters = [];
  let failure = null;

  const rejectWaiters = (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  worker.on("message", (message) => {
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  worker.on("error", (error) => {
    failure = error;
    rejectWaiters(error);
  });
  const exited = new Promise((resolve, reject) => {
    worker.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker 异常退出 code=${code}`));
    });
  });
  worker.on("exit", () => {
    // 仍挂着等待的 stage 不可能再到达；不要静默挂到超时。
    if (messages.some((message) => message.ok === false)) return;
    rejectWaiters(new Error("worker 已退出但未发出预期 stage"));
  });

  function waitFor(predicate, timeoutMs = 30000) {
    if (failure) return Promise.reject(failure);
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("worker stage 等待超时"));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  return {
    worker,
    gate,
    waitFor,
    ready: () => waitFor((message) => message.stage === "ready"),
    release() {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
    },
    async done() {
      const message = await waitFor(
        (value) => value.ok === false || (value.ok === true && value.stage !== "ready" && value.stage !== "locked"),
      );
      await exited;
      return message;
    },
  };
}

async function releaseTogether(...workers) {
  await Promise.all(workers.map((worker) => worker.ready()));
  for (const worker of workers) worker.release();
}

/* ------------------------------------------------------------------ */
/* 以下所有用例只在显式 opt-in 时运行                                  */
/* ------------------------------------------------------------------ */

describe("T-LOCAL-013F 一次性 MySQL 结果存储", { skip: SKIP_REASON }, () => {
  before(async () => {
    const startedAt = Date.now();
    fixture = await startMysqlFixture();
    console.log(
      `[T13F] isolated mysqld ${fixture.version} ready in ${Date.now() - startedAt}ms; ` +
        "socket-only, networking disabled",
    );
  });

  after(async () => {
    if (fixture) {
      const dir = fixture.dir;
      await fixture.stop();
      console.log(`[T13F] fixture stopped; tempDirRemoved=${!fs.existsSync(dir)}`);
    }
    fixture = null;
  });

  test("未知 db.kind 构造期固定拒绝且零 SQL，不回退 MySQL", () => {
    for (const kind of ["postgres", "mariadb", null]) {
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
    expectCode("INVALID_DB", () =>
      new AudioResultStore({ db: { kind: "mysql" }, resolveCurrent: () => ({}) }),
    );
  });

  test("构造与未 init 零 SQL；init 显式幂等、InnoDB/ascii_bin/版本 1，旧表不动", async (t) => {
    await dropStoreTables();
    await fixture.query("DROP TABLE IF EXISTS asset_audio");
    await fixture.query(
      "CREATE TABLE asset_audio (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL) ENGINE=InnoDB",
    );
    await fixture.query("INSERT INTO asset_audio (id, name) VALUES (1, 'keep')");

    const real = openDb(t);
    const counts = { prepare: 0, exec: 0, transaction: 0 };
    const wrapper = {
      kind: "mysql",
      get closed() {
        return real.closed;
      },
      prepare(...args) {
        counts.prepare += 1;
        return real.prepare(...args);
      },
      exec(...args) {
        counts.exec += 1;
        return real.exec(...args);
      },
      transaction(fn) {
        counts.transaction += 1;
        return real.transaction(fn);
      },
    };
    const store = openStore(t, wrapper, () => null);
    assert.deepEqual(counts, { prepare: 0, exec: 0, transaction: 0 });
    assert.deepEqual(store.initSchema(), { ok: true, schemaVersion: STORE_SCHEMA_VERSION, created: true });
    const beforeSecond = { ...counts };
    assert.deepEqual(store.initSchema(), { ok: true, schemaVersion: STORE_SCHEMA_VERSION, created: false });
    assert.deepEqual(counts, beforeSecond);
    assert.equal(counts.exec, 3); // 三张表各一条 DDL

    assert.deepEqual(await tableNames(), [
      "audio_result_commits",
      "audio_result_records",
      "audio_result_store_meta",
    ]);
    const tables = await q(
      `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_COLLATION AS collation
         FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'audio_result_%'`,
    );
    for (const table of tables) {
      assert.equal(table.engine, "InnoDB");
      assert.equal(table.collation, "utf8mb4_bin");
    }
    const columns = await q(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, COLLATION_NAME AS collation,
              IS_NULLABLE AS nullable
         FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_result_commits'
        ORDER BY ORDINAL_POSITION`,
    );
    const byName = Object.fromEntries(columns.map((column) => [column.name, column]));
    assert.equal(byName.asset_id.collation, "ascii_bin");
    assert.equal(byName.asset_id.type, "varchar(64)");
    assert.equal(byName.token_sha256.type, "char(64)");
    assert.equal(byName.token_sha256.collation, "ascii_bin");
    assert.equal(byName.context_json.collation, "utf8mb4_bin");
    assert.equal(byName.consumed_at_ms.nullable, "YES");
    const indexes = await q(
      `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS columnName
         FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_result_commits'`,
    );
    assert.deepEqual(
      indexes.filter((index) => Number(index.nonUnique) === 0).map((index) => [index.name, index.columnName]).sort(),
      [
        ["PRIMARY", "asset_id"],
        ["uq_audio_result_commits_token", "token_sha256"],
      ],
    );
    assert.deepEqual(
      await q("SELECT meta_value FROM audio_result_store_meta WHERE meta_key = 'schema_version'"),
      [{ meta_value: "1" }],
    );
    assert.deepEqual(await q("SELECT id, name FROM asset_audio"), [{ id: 1, name: "keep" }]);
    const metaRows = await q("SELECT COUNT(*) AS n FROM audio_result_store_meta");
    assert.equal(metaRows[0].n, 2); // schema_version + created_at_ms
  });

  test("已有表版本未知/结构或约束冲突固定拒绝，不 DROP/重建/清空", async (t) => {
    await dropStoreTables();
    const db = openDb(t);
    openStore(t, db, () => null).initSchema();

    await fixture.query("UPDATE audio_result_store_meta SET meta_value = '2' WHERE meta_key = 'schema_version'");
    const versioned = openDb(t);
    expectCode("UNSUPPORTED_SCHEMA_VERSION", () => openStore(t, versioned, () => null).initSchema());
    assert.equal((await q("SELECT COUNT(*) AS n FROM audio_result_store_meta"))[0].n, 2);

    await fixture.query("UPDATE audio_result_store_meta SET meta_value = '1' WHERE meta_key = 'schema_version'");
    await fixture.query(
      "ALTER TABLE audio_result_commits MODIFY kind VARCHAR(9) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    );
    const changed = openDb(t);
    expectCode("SCHEMA_CONFLICT", () => openStore(t, changed, () => null).initSchema());
    const kind = await q(
      `SELECT COLUMN_TYPE AS type FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_result_commits' AND COLUMN_NAME = 'kind'`,
    );
    assert.equal(kind[0].type, "varchar(9)"); // 原表保留，没有被重建/改回
    assert.equal((await q("SELECT COUNT(*) AS n FROM audio_result_store_meta"))[0].n, 2);

    await fixture.query(
      "ALTER TABLE audio_result_commits MODIFY kind VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    );
    await fixture.query("ALTER TABLE audio_result_commits ADD UNIQUE KEY uq_t13f_extra (job_id)");
    const extraUnique = openDb(t);
    expectCode("SCHEMA_CONFLICT", () => openStore(t, extraUnique, () => null).initSchema());
    assert.deepEqual(await tableNames(), [
      "audio_result_commits",
      "audio_result_records",
      "audio_result_store_meta",
    ]);
    await fixture.query("ALTER TABLE audio_result_commits DROP INDEX uq_t13f_extra");
    assert.equal(openStore(t, openDb(t), () => null).initSchema().created, false);
  });

  test("唯一 token/主键前缀索引被拒绝，恢复完整索引后 init 成功", async (t) => {
    await dropStoreTables();
    openStore(t, openDb(t), () => null).initSchema();

    await fixture.query(
      "ALTER TABLE audio_result_commits DROP INDEX uq_audio_result_commits_token, " +
        "ADD UNIQUE KEY uq_audio_result_commits_token (token_sha256(1))",
    );
    const uniquePart = await q(
      `SELECT SUB_PART AS subPart
         FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_result_commits'
          AND INDEX_NAME = 'uq_audio_result_commits_token'`,
    );
    assert.equal(Number(uniquePart[0].subPart), 1);
    expectCode("SCHEMA_CONFLICT", () => openStore(t, openDb(t), () => null).initSchema());

    await fixture.query(
      "ALTER TABLE audio_result_commits DROP INDEX uq_audio_result_commits_token, " +
        "ADD UNIQUE KEY uq_audio_result_commits_token (token_sha256)",
    );
    assert.equal(openStore(t, openDb(t), () => null).initSchema().created, false);

    // MySQL 8.2 允许给 VARCHAR 主键加前缀（SUB_PART=1）；同样必须拒绝。
    await fixture.query(
      "ALTER TABLE audio_result_commits DROP PRIMARY KEY, ADD PRIMARY KEY (asset_id(1))",
    );
    const primaryPart = await q(
      `SELECT SUB_PART AS subPart
         FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audio_result_commits'
          AND INDEX_NAME = 'PRIMARY'`,
    );
    assert.equal(Number(primaryPart[0].subPart), 1);
    expectCode("SCHEMA_CONFLICT", () => openStore(t, openDb(t), () => null).initSchema());

    await fixture.query(
      "ALTER TABLE audio_result_commits DROP PRIMARY KEY, ADD PRIMARY KEY (asset_id)",
    );
    assert.equal(openStore(t, openDb(t), () => null).initSchema().created, false);
  });

  test("DDL 失败保留残留且无假 marker，重复 init 受控拒绝，清理后可恢复", async (t) => {
    await dropStoreTables();
    const real = openDb(t);
    let execCount = 0;
    const flaky = {
      kind: "mysql",
      get closed() {
        return real.closed;
      },
      prepare: (...args) => real.prepare(...args),
      transaction: (fn) => real.transaction(fn),
      exec(sql) {
        execCount += 1;
        if (execCount === 2) {
          const error = new Error("forced DDL failure");
          error.code = "ER_UNKNOWN";
          throw error;
        }
        return real.exec(sql);
      },
    };
    const store = openStore(t, flaky, () => null);
    const error = expectCode("SCHEMA_INIT_FAILED", () => store.initSchema());
    assert.doesNotMatch(error.message, /audio_result|CREATE|forced/i);
    assert.deepEqual(await tableNames(), ["audio_result_store_meta"]);
    assert.equal((await q("SELECT COUNT(*) AS n FROM audio_result_store_meta"))[0].n, 0);

    const retry = openDb(t);
    expectCode("SCHEMA_CONFLICT", () => openStore(t, retry, () => null).initSchema());
    // 半初始化残留仍在，不写版本；明确拒绝而不是猜版本或 DROP 用户表。
    assert.equal((await q("SELECT COUNT(*) AS n FROM audio_result_store_meta"))[0].n, 0);

    await dropStoreTables();
    const recovered = openDb(t);
    assert.equal(openStore(t, recovered, () => null).initSchema().created, true);
  });

  test("普通保存/重开读取/null/合法 0/负零/正 peak/seg", async (t) => {
    await dropStoreTables();
    await fixture.query(
      "CREATE TABLE IF NOT EXISTS asset_audio (id INT PRIMARY KEY, name VARCHAR(20) NOT NULL) ENGINE=InnoDB",
    );
    await fixture.query("INSERT IGNORE INTO asset_audio (id, name) VALUES (1, 'keep')");
    const context = baseContext({ durationSec: 100 });
    const ident = identity("asset_basic", context);
    const resolver = (assetId) => (assetId === "asset_basic" ? ident : null);

    const db1 = openDb(t);
    const store1 = openStore(t, db1, resolver);
    store1.initSchema();
    const began = store1.begin("asset_basic", "job_01", ident);
    const raw = {
      bpm: null,
      key: { best: null, r: 0.5 },
      loud: { peak: 2.5, rms: null },
      energy: { min: null, max: null, std: null },
      fit: { beat: 0.9, tonal: null, chord: null },
      seg: [0, 10],
    };
    const result = resultFor(context, raw);
    const saved = store1.save(began.token, result, { analyzedMs: 0, analyzedAtMs: 1_700_000_000_000 });
    assert.equal(saved.ok, true);
    assert.ok(saved.payloadBytes > 0);

    const rows = await q(
      `SELECT token_sha256, analyzed_ms, analyzed_at_ms, payload_bytes,
              LENGTH(CAST(payload_json AS BINARY)) AS bytes, invalidated_at_ms
         FROM audio_result_records WHERE asset_id = 'asset_basic'`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_sha256, sha256(began.token)); // 只存 SHA256，不存明文 token
    assert.equal(rows[0].token_sha256.includes(began.token), false);
    assert.equal(rows[0].analyzed_ms, 0);
    assert.equal(rows[0].analyzed_at_ms, 1_700_000_000_000);
    assert.equal(rows[0].payload_bytes, saved.payloadBytes);
    assert.equal(rows[0].bytes, saved.payloadBytes);
    assert.equal(rows[0].invalidated_at_ms, null);

    db1.close();
    const db2 = openDb(t);
    const store2 = openStore(t, db2, resolver);
    assert.equal(store2.initSchema().created, false);
    const got = store2.get("asset_basic", context);
    assert.equal(got.status, "ready");
    assert.deepEqual(got.result, result);
    assert.equal(got.analyzedMs, 0);
    assert.equal(got.analyzedAtMs, 1_700_000_000_000);
    assert.ok(Object.is(got.result.value.loud.peakDbfs, 2.5));
    assert.deepEqual(got.result.value.seg.energyChangeSec, [0, 10]);

    // 独立 asset 验证 -0 经 MySQL MEDIUMTEXT 往返仍是 -0。
    const contextZero = baseContext({ durationSec: 100 });
    const identZero = identity("asset_negzero", contextZero);
    const zero = normalizeAudioResult(
      '{"bpm":120,"key":{"best":"C major","r":-0},"loud":{"peak":-0,"rms":-12},' +
        '"energy":{"min":-0,"max":0,"std":-0},"fit":{"beat":-0,"tonal":0,"chord":-0},"seg":[-0,10]}',
      contextZero,
    );
    assert.equal(zero.ok, true);
    const storeZero = openStore(t, openDb(t), (id) => (id === "asset_negzero" ? identZero : null));
    storeZero.initSchema();
    const zeroBegin = storeZero.begin("asset_negzero", "job_zero", identZero);
    storeZero.save(zeroBegin.token, zero, timing());
    const zeroGot = storeZero.get("asset_negzero", contextZero);
    assert.equal(zeroGot.status, "ready");
    assert.ok(Object.is(zeroGot.result.value.key.keyScore, -0));
    assert.ok(Object.is(zeroGot.result.value.loud.peakDbfs, -0));
    assert.ok(Object.is(zeroGot.result.value.energy.minDbfs, -0));
    assert.ok(Object.is(zeroGot.result.value.energy.stdDb, -0));
    assert.ok(Object.is(zeroGot.result.value.fit.beat, -0));
    assert.ok(Object.is(zeroGot.result.value.seg.energyChangeSec[0], -0));
    // 旧 asset_audio 在完整 begin/save/get 流程后保持原样。
    assert.deepEqual(await q("SELECT id, name FROM asset_audio"), [{ id: 1, name: "keep" }]);
  });

  test("坏 payload/时间列返回 stale CORRUPT，且不把坏时间值带回", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_corrupt", context);
    const resolver = (id) => (id === "asset_corrupt" ? ident : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const result = resultFor(context);
    let began = store.begin("asset_corrupt", "job_01", ident);
    store.save(began.token, result, timing());

    const original = (
      await q(
        "SELECT payload_json, payload_bytes FROM audio_result_records WHERE asset_id = 'asset_corrupt'",
      )
    )[0];

    const cases = [
      ["坏 JSON", "UPDATE audio_result_records SET payload_json = ?, payload_bytes = ? WHERE asset_id = 'asset_corrupt'", ["{bad", 4]],
      ["声明字节不符", "UPDATE audio_result_records SET payload_bytes = payload_bytes + 1 WHERE asset_id = 'asset_corrupt'", []],
      ["payload_bytes 超限", "UPDATE audio_result_records SET payload_bytes = 70000 WHERE asset_id = 'asset_corrupt'", []],
      ["analyzed_ms 负数", "UPDATE audio_result_records SET analyzed_ms = -1 WHERE asset_id = 'asset_corrupt'", []],
      ["analyzed_at_ms 负数", "UPDATE audio_result_records SET analyzed_at_ms = -123 WHERE asset_id = 'asset_corrupt'", []],
      ["saved_at_ms 负数", "UPDATE audio_result_records SET saved_at_ms = -123 WHERE asset_id = 'asset_corrupt'", []],
      ["invalidated_at_ms 负数", "UPDATE audio_result_records SET invalidated_at_ms = -1 WHERE asset_id = 'asset_corrupt'", []],
    ];
    for (const [name, sql, values] of cases) {
      await fixture.query("UPDATE audio_result_records SET payload_json = ?, payload_bytes = ? WHERE asset_id = 'asset_corrupt'", [original.payload_json, original.payload_bytes]);
      await fixture.query("UPDATE audio_result_records SET analyzed_ms = 12.5, analyzed_at_ms = 1700000000000, saved_at_ms = 1700000000001, invalidated_at_ms = NULL WHERE asset_id = 'asset_corrupt'");
      await fixture.query(sql, values);
      const got = store.get("asset_corrupt", context);
      assert.equal(got.status, "stale", name);
      assert.equal(got.reason, "CORRUPT", name);
      assert.equal(got.result, null, name);
      if (name.includes("时间")) {
        assert.equal(got.analyzedMs, undefined, name);
        assert.equal(got.analyzedAtMs, undefined, name);
        assert.equal(got.savedAtMs, undefined, name);
      }
    }
  });

  test("同 asset 新 token 废旧 token、重放与明文 token 不落库", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_tokens", context);
    const resolver = (id) => (id === "asset_tokens" ? ident : null);
    const storeA = openStore(t, openDb(t), resolver);
    storeA.initSchema();
    const storeB = openStore(t, openDb(t), resolver);
    storeB.initSchema();
    const result = resultFor(context);

    const first = storeA.begin("asset_tokens", "job_a", ident);
    const second = storeB.begin("asset_tokens", "job_b", ident);
    assert.notEqual(first.token, second.token);
    expectCode("INVALID_TOKEN", () => storeA.save(first.token, result, timing()));
    const saved = storeB.save(second.token, result, timing());
    assert.equal(saved.ok, true);
    expectCode("TOKEN_CONSUMED", () => storeB.save(second.token, result, timing()));
    expectCode("INVALID_TOKEN", () => storeA.save(first.token, result, timing()));

    const rows = await q(
      "SELECT token_sha256, consumed_at_ms FROM audio_result_commits WHERE asset_id = 'asset_tokens'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_sha256, sha256(second.token));
    assert.equal(typeof rows[0].consumed_at_ms, "number");
    const [record] = await q(
      "SELECT token_sha256 FROM audio_result_records WHERE asset_id = 'asset_tokens'",
    );
    assert.equal(record.token_sha256, sha256(second.token));
  });

  test("save 前身份/generation/context 变化拒绝，旧成功保留，结果不符 RESULT_MISMATCH", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    let ident = identity("asset_identity", context);
    const resolver = (id) => (id === "asset_identity" ? ident : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const r1 = resultFor(context, baseRaw({ bpm: 100 }));
    const first = store.begin("asset_identity", "job_01", ident);
    store.save(first.token, r1, timing());
    assert.equal(store.get("asset_identity", context).status, "ready");

    const pending = store.begin("asset_identity", "job_02", ident);
    const r2 = resultFor(context, baseRaw({ bpm: 128 }));
    expectCode("RESULT_MISMATCH", () =>
      store.save(pending.token, resultFor(baseContext({ durationSec: 599 })), timing()),
    );

    ident = identity("asset_identity", context, { libraryGeneration: "9".repeat(32) });
    expectCode("IDENTITY_CHANGED", () => store.save(pending.token, r2, timing()));
    const stale = store.get("asset_identity", context);
    assert.equal(stale.status, "stale");
    assert.equal(stale.reason, "CURRENT_CHANGED");
    assert.deepEqual(stale.result, r1);

    ident = identity("asset_identity", context);
    const ready = store.get("asset_identity", context);
    assert.equal(ready.status, "ready");
    assert.deepEqual(ready.result, r1);

    // 源/引擎 context 变化（duration 599）也必须 CURRENT_CHANGED，而不是 ready。
    ident = identity("asset_identity", baseContext({ durationSec: 599 }));
    const engineChanged = store.get("asset_identity", context);
    assert.equal(engineChanged.status, "stale");
    assert.equal(engineChanged.reason, "CURRENT_CHANGED");
    assert.deepEqual(engineChanged.result, r1);
  });

  test("get 隐藏 missing、context 变化 stale、invalidate 不删记录且幂等", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    let ident = identity("asset_get", context);
    const resolver = (id) => (id === "asset_get" ? ident : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const result = resultFor(context);
    const began = store.begin("asset_get", "job_01", ident);
    store.save(began.token, result, timing());

    const changed = store.get("asset_get", baseContext({ durationSec: 599 }));
    assert.equal(changed.status, "stale");
    assert.equal(changed.reason, "CONTEXT_CHANGED");
    assert.deepEqual(changed.result, result);

    for (const [name, over] of [
      ["offline", { online: false }],
      ["trashed", { trashed: true }],
      ["retired", { retired: true }],
      ["rootRetired", { rootRetired: true }],
      ["busy", { busy: true }],
    ]) {
      ident = identity("asset_get", context, over);
      const got = store.get("asset_get", context);
      assert.deepEqual(got, { ok: true, status: "missing" }, name);
    }
    ident = identity("asset_get", context);
    assert.equal(store.get("asset_get", context).status, "ready");

    const invalidated = store.invalidate("asset_get");
    assert.deepEqual(invalidated, {
      ok: true,
      assetId: "asset_get",
      revokedCommit: false,
      invalidatedResult: true,
    });
    const stale = store.get("asset_get", context);
    assert.equal(stale.status, "stale");
    assert.equal(stale.reason, "INVALIDATED");
    assert.deepEqual(stale.result, result);
    assert.equal((await q("SELECT COUNT(*) AS n FROM audio_result_records"))[0].n, 1);

    assert.deepEqual(store.invalidate("asset_get"), {
      ok: true,
      assetId: "asset_get",
      revokedCommit: false,
      invalidatedResult: false,
    });
    const again = store.begin("asset_get", "job_02", ident);
    store.save(again.token, resultFor(context, baseRaw({ bpm: 90 })), timing());
    assert.equal(store.get("asset_get", context).status, "ready");
  });

  test("大小写不同的 assetId 在 MySQL ascii_bin 下不串", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const upper = identity("assetA", context);
    const lower = identity("asseta", context);
    const resolver = (id) => (id === "assetA" ? upper : id === "asseta" ? lower : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const upperBegin = store.begin("assetA", "job_upper", upper);
    const lowerBegin = store.begin("asseta", "job_lower", lower);
    store.save(upperBegin.token, resultFor(context, baseRaw({ bpm: 90 })), timing());
    store.save(lowerBegin.token, resultFor(context, baseRaw({ bpm: 180 })), timing());

    assert.equal(store.get("assetA", context).result.value.bpm, 90);
    assert.equal(store.get("asseta", context).result.value.bpm, 180);
    assert.equal((await q("SELECT COUNT(*) AS n FROM audio_result_records"))[0].n, 2);
    const ids = await q("SELECT asset_id FROM audio_result_records ORDER BY asset_id");
    assert.deepEqual(ids.map((row) => row.asset_id), ["assetA", "asseta"]);
    const byDefault = await q(
      "SELECT COUNT(*) AS n FROM audio_result_records WHERE asset_id = 'ASSETA'",
    );
    assert.equal(byDefault[0].n, 0); // 默认排序规则也不会把大小写合并
  });

  test("双连接并发 begin（不存在 commit 行）安全，只有一个 token 当前", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_race_begin", context);
    const admin = openDb(t);
    openStore(t, admin, () => null).initSchema();

    const params = { assetId: "asset_race_begin", identity: ident };
    const a = spawnWorker("begin", { ...params, jobId: "job_a" });
    const b = spawnWorker("begin", { ...params, jobId: "job_b" });
    await releaseTogether(a, b);
    const [ra, rb] = await Promise.all([a.done(), b.done()]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.notEqual(ra.value.token, rb.value.token);

    const rows = await q(
      "SELECT token_sha256, consumed_at_ms FROM audio_result_commits WHERE asset_id = 'asset_race_begin'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].consumed_at_ms, null);
    const tokens = [ra.value.token, rb.value.token];
    const current = tokens.filter((token) => sha256(token) === rows[0].token_sha256);
    assert.equal(current.length, 1);

    const store = openStore(t, openDb(t), (id) => (id === "asset_race_begin" ? ident : null));
    store.initSchema();
    const loser = tokens.find((token) => token !== current[0]);
    expectCode("INVALID_TOKEN", () => store.save(loser, resultFor(context), timing()));
    assert.equal(store.save(current[0], resultFor(context), timing()).ok, true);
  });

  test("双连接并发 save 同一 token：恰好一个成功，另一个 TOKEN_CONSUMED", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_race_save", context);
    const resolver = (id) => (id === "asset_race_save" ? ident : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const began = store.begin("asset_race_save", "job_01", ident);
    const result = resultFor(context);

    const params = {
      assetId: "asset_race_save",
      identity: ident,
      token: began.token,
      result,
      timing: timing(),
    };
    const a = spawnWorker("save", params);
    const b = spawnWorker("save", params);
    await releaseTogether(a, b);
    const [ra, rb] = await Promise.all([a.done(), b.done()]);
    const successes = [ra, rb].filter((result2) => result2.ok === true);
    const failures = [ra, rb].filter((result2) => result2.ok === false);
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "TOKEN_CONSUMED");
    assert.equal((await q("SELECT COUNT(*) AS n FROM audio_result_records"))[0].n, 1);
    const rows = await q(
      "SELECT token_sha256, consumed_at_ms FROM audio_result_commits WHERE asset_id = 'asset_race_save'",
    );
    assert.equal(rows[0].token_sha256, sha256(began.token));
    assert.equal(typeof rows[0].consumed_at_ms, "number");
  });

  test("save 对 invalidate 争用：不谎称取消已提交成功，最终只会 stale", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_race_invalidate", context);
    const resolver = (id) => (id === "asset_race_invalidate" ? ident : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const baseline = resultFor(context, baseRaw({ bpm: 90 }));
    const first = store.begin("asset_race_invalidate", "job_01", ident);
    store.save(first.token, baseline, timing());
    let expectedPayload = baseline;

    for (let round = 0; round < 2; round += 1) {
      const next = resultFor(context, baseRaw({ bpm: 100 + round }));
      const began = store.begin("asset_race_invalidate", `job_${round}`, ident);
      const worker = spawnWorker("save", {
        assetId: "asset_race_invalidate",
        identity: ident,
        token: began.token,
        result: next,
        timing: timing(),
      });
      await worker.ready();
      worker.release();
      const invalidated = store.invalidate("asset_race_invalidate");
      const outcome = await worker.done();

      const after = store.get("asset_race_invalidate", context);
      assert.equal(after.status, "stale");
      assert.equal(after.reason, "INVALIDATED");
      if (outcome.ok === true) {
        assert.equal(outcome.value.consumed, true);
        assert.deepEqual(after.result, next);
        expectedPayload = next;
        assert.equal(invalidated.invalidatedResult, true);
      } else {
        assert.equal(outcome.code, "TOKEN_CONSUMED");
        assert.deepEqual(after.result, expectedPayload);
      }
      // 无论谁先提交，都不能在 invalidate 之后又变成 ready。
      assert.notEqual(store.get("asset_race_invalidate", context).status, "ready");
    }
  });

  test("trigger 失败回滚：旧成功与未消费资格都保留，移除故障后可重试", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_trigger", context);
    const resolver = (id) => (id === "asset_trigger" ? ident : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const r1 = resultFor(context, baseRaw({ bpm: 90 }));
    const first = store.begin("asset_trigger", "job_01", ident);
    store.save(first.token, r1, timing());
    const pending = store.begin("asset_trigger", "job_02", ident);
    const r2 = resultFor(context, baseRaw({ bpm: 150 }));

    await fixture.query(
      "CREATE TRIGGER t13f_force_fail BEFORE INSERT ON audio_result_records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced failure'",
    );
    try {
      expectCode("STORAGE_ERROR", () => store.save(pending.token, r2, timing()));
    } finally {
      await fixture.query("DROP TRIGGER t13f_force_fail");
    }

    const still = store.get("asset_trigger", context);
    assert.equal(still.status, "ready");
    assert.deepEqual(still.result, r1);
    const commit = await q(
      "SELECT consumed_at_ms FROM audio_result_commits WHERE asset_id = 'asset_trigger'",
    );
    assert.equal(commit[0].consumed_at_ms, null);

    const retried = store.save(pending.token, r2, timing());
    assert.equal(retried.ok, true);
    const updated = store.get("asset_trigger", context);
    assert.equal(updated.status, "ready");
    assert.deepEqual(updated.result, r2);
  });

  test("双连接并发 init：只允许成功一致或受控 SCHEMA_CONFLICT/BUSY，最终 schema 一致", async (t) => {
    await dropStoreTables();
    const a = spawnWorker("init", {});
    const b = spawnWorker("init", {});
    await releaseTogether(a, b);
    const [ra, rb] = await Promise.all([a.done(), b.done()]);
    const successes = [ra, rb].filter((outcome) => outcome.ok === true);
    const failures = [ra, rb].filter((outcome) => outcome.ok === false);
    assert.ok(successes.length >= 1, "至少一个 init 成功");
    for (const failure of failures) {
      assert.ok(
        failure.code === "SCHEMA_CONFLICT" || failure.code === "STORAGE_BUSY",
        `并行 init 只允许受控失败，实际 ${failure.code}`,
      );
    }
    for (const success of successes) {
      assert.equal(success.value.schemaVersion, STORE_SCHEMA_VERSION);
      assert.equal(typeof success.value.created, "boolean");
    }
    assert.deepEqual(await tableNames(), [
      "audio_result_commits",
      "audio_result_records",
      "audio_result_store_meta",
    ]);
    assert.deepEqual(
      await q("SELECT meta_value FROM audio_result_store_meta WHERE meta_key = 'schema_version'"),
      [{ meta_value: "1" }],
    );
    assert.equal(openStore(t, openDb(t), () => null).initSchema().created, false);
  });

  test("save 持有提交行锁时 begin 等待提交，不会用旧资格覆盖新结果", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_save_begin", context);
    const resolver = (id) => (id === "asset_save_begin" ? ident : null);
    const store = openStore(t, openDb(t), resolver);
    store.initSchema();
    const r1 = resultFor(context, baseRaw({ bpm: 90 }));
    const first = store.begin("asset_save_begin", "job_01", ident);
    store.save(first.token, r1, timing());

    const pending = store.begin("asset_save_begin", "job_02", ident);
    const r2 = resultFor(context, baseRaw({ bpm: 140 }));
    await fixture.query(
      "CREATE TRIGGER t13f_slow_insert BEFORE INSERT ON audio_result_records FOR EACH ROW SET @t13f_slow = SLEEP(1)",
    );
    try {
      const worker = spawnWorker("save", {
        assetId: "asset_save_begin",
        identity: ident,
        token: pending.token,
        result: r2,
        timing: timing(),
      });
      await worker.ready();
      worker.release();
      // 让 save 先进入 INSERT trigger 的 1s 睡眠，此时它已持有提交行锁。
      await new Promise((resolve) => setTimeout(resolve, 250));
      const startedAt = Date.now();
      const next = store.begin("asset_save_begin", "job_03", ident);
      const waited = Date.now() - startedAt;
      const outcome = await worker.done();
      assert.equal(outcome.ok, true);
      assert.ok(waited >= 300, `begin 未等待 save 提交：${waited}ms`);

      const commit = await q(
        "SELECT token_sha256, consumed_at_ms FROM audio_result_commits WHERE asset_id = 'asset_save_begin'",
      );
      assert.equal(commit[0].token_sha256, sha256(next.token)); // begin 在 save 提交后生效
      assert.equal(commit[0].consumed_at_ms, null);
      const got = store.get("asset_save_begin", context);
      assert.equal(got.status, "ready");
      assert.deepEqual(got.result, r2); // 已提交的新结果没有被旧资格覆盖
    } finally {
      await fixture.query("DROP TRIGGER IF EXISTS t13f_slow_insert");
    }
  });

  test("锁等待超时固定 STORAGE_BUSY，不递归重试；释放后可重试成功", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_lock", context);
    const resolver = (id) => (id === "asset_lock" ? ident : null);
    const db = openDb(t);
    const store = openStore(t, db, resolver);
    store.initSchema();
    const began = store.begin("asset_lock", "job_01", ident);
    const result = resultFor(context);

    const holder = spawnWorker("hold-lock", { assetId: "asset_lock", identity: ident });
    await holder.ready();
    await holder.waitFor((message) => message.stage === "locked");
    db.exec("SET SESSION innodb_lock_wait_timeout = 1");
    const startedAt = Date.now();
    let attempts = 0;
    const wrapper = {
      kind: "mysql",
      get closed() {
        return db.closed;
      },
      prepare(...args) {
        attempts += 1;
        return db.prepare(...args);
      },
      exec: (...args) => db.exec(...args),
      transaction: (fn) => db.transaction(fn),
    };
    const timedStore = openStore(t, wrapper, resolver);
    // initSchema 已由原 store 完成；timedStore 是同一 schema 的新实例。
    timedStore.initSchema();
    attempts = 0;
    const error = expectCode("STORAGE_BUSY", () => timedStore.save(began.token, result, timing()));
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 900, `lock wait elapsed ${elapsed}`);
    assert.ok(elapsed < 5000, `未按短锁超时返回：${elapsed}`);
    assert.equal(attempts, 1);
    assert.match(error.message, /busy/);

    holder.release();
    await holder.done();
    assert.equal(store.save(began.token, result, timing()).ok, true);
  });

  test("连接关闭后固定 STORE_CLOSED，不偷偷回退 SQLite", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_closed", context);
    const resolver = (id) => (id === "asset_closed" ? ident : null);
    const db = openDb(t);
    const store = openStore(t, db, resolver);
    store.initSchema();
    db.close();
    expectCode("STORE_CLOSED", () => store.get("asset_closed", context));
    expectCode("STORE_CLOSED", () => store.begin("asset_closed", "job_01", ident));
    expectCode("STORE_CLOSED", () => store.invalidate("asset_closed"));
    expectCode("STORE_CLOSED", () => store.initSchema());
  });
  test("invalidateToken 定向撤销：旧 token 不影响新资格，当前 token 只改 stale", async (t) => {
    await dropStoreTables();
    const context = baseContext();
    const ident = identity("asset_token", context);
    const resolver = (id) => (id === "asset_token" ? ident : null);
    const db = openDb(t);
    const store = openStore(t, db, resolver);
    store.initSchema();
    const result = resultFor(context);

    const first = store.begin("asset_token", "job_01", ident);
    store.save(first.token, result, timing());
    const second = store.begin("asset_token", "job_02", ident);

    // 已保存/已被替换的旧 token 都不得动新资格与新结果。
    assert.deepEqual(store.invalidateToken(first.token), {
      ok: true,
      tokenMatched: false,
      revokedCommit: false,
      invalidatedResult: false,
    });
    const current = await q("SELECT token_sha256, consumed_at_ms FROM audio_result_commits WHERE asset_id = ?", [
      "asset_token",
    ]);
    assert.equal(current.length, 1);
    assert.equal(current[0].token_sha256, sha256(second.token));
    assert.equal(current[0].consumed_at_ms, null);
    assert.equal(store.get("asset_token", context).status, "ready");

    // 撤销当前 token：消费资格并把同一 asset 的旧成功改 stale，不删行。
    assert.deepEqual(store.invalidateToken(second.token), {
      ok: true,
      tokenMatched: true,
      revokedCommit: true,
      invalidatedResult: true,
    });
    const stale = store.get("asset_token", context);
    assert.equal(stale.status, "stale");
    assert.equal(stale.reason, "INVALIDATED");
    const rows = await q("SELECT COUNT(*) AS n FROM audio_result_records WHERE asset_id = ?", ["asset_token"]);
    assert.equal(Number(rows[0].n), 1);
    assert.deepEqual(store.invalidateToken(second.token), {
      ok: true,
      tokenMatched: true,
      revokedCommit: false,
      invalidatedResult: false,
    });
    expectCode("TOKEN_CONSUMED", () => store.save(second.token, result, timing()));
  });

});
