/**
 * T-LOCAL-013E：本地音频结果存储核心与提交令牌（隔离 SQLite）。
 *
 * 只做同步 SQLite 存取：
 *   - 显式 initSchema 才建表，构造与未 init 的 get 不执行任何 SQL；
 *   - begin 在短事务里重读当前身份、核对待提交身份并生成不可猜随机 token；
 *   - save 在同一事务里复核 token/身份/版本/context/指纹后 upsert 最近成功结果；
 *   - get 只读，返回 missing/ready/stale，隐藏或不可管理素材不泄露旧结果；
 *   - invalidate 撤销资格并让旧成功 stale，但不删除最近成功结果。
 *
 * 边界（见 collab/results/T-LOCAL-013E/report.md、T-LOCAL-013F/report.md）：
 *   - 只支持既有同步 SQLite / MySQL 接口；未知 db.kind 固定 UNSUPPORTED_STORAGE，
 *     不偷偷另开 SQLite、不回退。MySQL 复用既有 MysqlDatabase 适配器。
 *   - MySQL 的 DDL 可能隐式提交，因此 init 先探测结构、最后写 version marker；
 *     失败残留保留并拒绝，不 DROP/清空用户表。
 *   - resolveCurrent 是未来可信内部适配器的接口；本轮**没有**接 Library 管理状态，
 *     也没有接执行链、HTTP、前端或迁移。
 *   - schema/source/engine 字段仍沿用 T13D 的合成 brief-v1 协议；不代表真实发行
 *     引擎协议、真实缓存或真实素材分析已经验收。
 *   - 本模块不读全局 library、不换库、不下载、不联网、不运行引擎。
 */
import { createHash, randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  MAX_RESULT_BYTES,
  PROTOCOL,
  SCHEMA_VERSION as RESULT_SCHEMA_VERSION,
  createAudioResultFingerprint,
} from "./audio-result.mjs";

/** 本模块自己的 schema 版本（与 T13D 结果 schema 版本是两件事）。 */
export const STORE_SCHEMA_VERSION = 1;

/** 存储 payload 上限：64 KiB 规范化结果（不含 context 列）。 */
export const MAX_STORE_PAYLOAD_BYTES = MAX_RESULT_BYTES;

const TABLE_META = "audio_result_store_meta";
const TABLE_COMMITS = "audio_result_commits";
const TABLE_RECORDS = "audio_result_records";

const TABLE_COLUMNS = Object.freeze({
  [TABLE_META]: Object.freeze(["meta_key", "meta_value"]),
  [TABLE_COMMITS]: Object.freeze([
    "asset_id",
    "job_id",
    "token_sha256",
    "root_id",
    "kind",
    "library_generation",
    "asset_generation",
    "source_generation",
    "context_json",
    "fingerprint",
    "created_at_ms",
    "consumed_at_ms",
  ]),
  [TABLE_RECORDS]: Object.freeze([
    "asset_id",
    "token_sha256",
    "job_id",
    "root_id",
    "kind",
    "library_generation",
    "asset_generation",
    "source_generation",
    "context_json",
    "fingerprint",
    "payload_json",
    "payload_bytes",
    "payload_sha256",
    "analyzed_ms",
    "analyzed_at_ms",
    "saved_at_ms",
    "invalidated_at_ms",
  ]),
});

/* ------------------------------------------------------------------ */
/* SQL：SQLite / MySQL 两套方言，参数占位符与列顺序保持一致             */
/* ------------------------------------------------------------------ */

const SQLITE_COMMIT_UPSERT = `INSERT INTO ${TABLE_COMMITS}
   (asset_id, job_id, token_sha256, root_id, kind,
    library_generation, asset_generation, source_generation,
    context_json, fingerprint, created_at_ms, consumed_at_ms)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
 ON CONFLICT(asset_id) DO UPDATE SET
   job_id = excluded.job_id,
   token_sha256 = excluded.token_sha256,
   root_id = excluded.root_id,
   kind = excluded.kind,
   library_generation = excluded.library_generation,
   asset_generation = excluded.asset_generation,
   source_generation = excluded.source_generation,
   context_json = excluded.context_json,
   fingerprint = excluded.fingerprint,
   created_at_ms = excluded.created_at_ms,
   consumed_at_ms = NULL`;

const MYSQL_COMMIT_UPSERT = `INSERT INTO ${TABLE_COMMITS}
   (asset_id, job_id, token_sha256, root_id, kind,
    library_generation, asset_generation, source_generation,
    context_json, fingerprint, created_at_ms, consumed_at_ms)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
 ON DUPLICATE KEY UPDATE
   job_id = VALUES(job_id),
   token_sha256 = VALUES(token_sha256),
   root_id = VALUES(root_id),
   kind = VALUES(kind),
   library_generation = VALUES(library_generation),
   asset_generation = VALUES(asset_generation),
   source_generation = VALUES(source_generation),
   context_json = VALUES(context_json),
   fingerprint = VALUES(fingerprint),
   created_at_ms = VALUES(created_at_ms),
   consumed_at_ms = NULL`;

const SQLITE_RECORD_UPSERT = `INSERT INTO ${TABLE_RECORDS}
   (asset_id, token_sha256, job_id, root_id, kind,
    library_generation, asset_generation, source_generation,
    context_json, fingerprint, payload_json, payload_bytes, payload_sha256,
    analyzed_ms, analyzed_at_ms, saved_at_ms, invalidated_at_ms)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
 ON CONFLICT(asset_id) DO UPDATE SET
   token_sha256 = excluded.token_sha256,
   job_id = excluded.job_id,
   root_id = excluded.root_id,
   kind = excluded.kind,
   library_generation = excluded.library_generation,
   asset_generation = excluded.asset_generation,
   source_generation = excluded.source_generation,
   context_json = excluded.context_json,
   fingerprint = excluded.fingerprint,
   payload_json = excluded.payload_json,
   payload_bytes = excluded.payload_bytes,
   payload_sha256 = excluded.payload_sha256,
   analyzed_ms = excluded.analyzed_ms,
   analyzed_at_ms = excluded.analyzed_at_ms,
   saved_at_ms = excluded.saved_at_ms,
   invalidated_at_ms = NULL`;

const MYSQL_RECORD_UPSERT = `INSERT INTO ${TABLE_RECORDS}
   (asset_id, token_sha256, job_id, root_id, kind,
    library_generation, asset_generation, source_generation,
    context_json, fingerprint, payload_json, payload_bytes, payload_sha256,
    analyzed_ms, analyzed_at_ms, saved_at_ms, invalidated_at_ms)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
 ON DUPLICATE KEY UPDATE
   token_sha256 = VALUES(token_sha256),
   job_id = VALUES(job_id),
   root_id = VALUES(root_id),
   kind = VALUES(kind),
   library_generation = VALUES(library_generation),
   asset_generation = VALUES(asset_generation),
   source_generation = VALUES(source_generation),
   context_json = VALUES(context_json),
   fingerprint = VALUES(fingerprint),
   payload_json = VALUES(payload_json),
   payload_bytes = VALUES(payload_bytes),
   payload_sha256 = VALUES(payload_sha256),
   analyzed_ms = VALUES(analyzed_ms),
   analyzed_at_ms = VALUES(analyzed_at_ms),
   saved_at_ms = VALUES(saved_at_ms),
   invalidated_at_ms = NULL`;

const COMMIT_SELECT = `SELECT asset_id, job_id, token_sha256, root_id, kind,
         library_generation, asset_generation, source_generation,
         context_json, fingerprint, created_at_ms, consumed_at_ms
    FROM ${TABLE_COMMITS}
   WHERE token_sha256 = ?`;

const RECORD_SELECT = `SELECT asset_id, token_sha256, job_id, root_id, kind,
         library_generation, asset_generation, source_generation,
         context_json, fingerprint, payload_json, payload_bytes,
         payload_sha256, analyzed_ms, analyzed_at_ms, saved_at_ms, invalidated_at_ms
    FROM ${TABLE_RECORDS}
   WHERE asset_id = ?`;

/**
 * MySQL 表结构（版本 1 与 SQLite 逻辑等价）。
 * ID/token/元数据键使用 ascii_bin，确保 `assetA` 与 `asseta` 不合并；
 * payload/context 使用 utf8mb4_bin 保留原始大小写与字节。
 * MySQL 8.0 的 VALUES() 已弃用但仍受支持；不改共享适配器，沿用现有驱动。
 */
const MYSQL_DDL = Object.freeze([
  `CREATE TABLE IF NOT EXISTS ${TABLE_META} (
     meta_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     meta_value VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     PRIMARY KEY (meta_key)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS ${TABLE_COMMITS} (
     asset_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     job_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     token_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     root_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     kind VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     library_generation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     asset_generation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     source_generation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     context_json MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
     fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     created_at_ms BIGINT NOT NULL,
     consumed_at_ms BIGINT NULL,
     PRIMARY KEY (asset_id),
     UNIQUE KEY uq_audio_result_commits_token (token_sha256)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS ${TABLE_RECORDS} (
     asset_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     token_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     job_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     root_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     kind VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     library_generation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     asset_generation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     source_generation VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     context_json MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
     fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     payload_json MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
     payload_bytes INT UNSIGNED NOT NULL,
     payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
     analyzed_ms DOUBLE NOT NULL,
     analyzed_at_ms BIGINT NOT NULL,
     saved_at_ms BIGINT NOT NULL,
     invalidated_at_ms BIGINT NULL,
     PRIMARY KEY (asset_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
]);

/** 期望列：type/length/unsigned 用于逐列比对 COLUMN_TYPE，不只看 DATA_TYPE。 */
const mysqlCol = (name, type, extra = {}) =>
  Object.freeze({ name, type, nullable: false, charset: null, collation: null, ...extra });
const mysqlTextCol = (name, type, charset, collation, extra = {}) =>
  mysqlCol(name, type, { charset, collation, ...extra });

const MYSQL_COLUMNS = Object.freeze({
  [TABLE_META]: Object.freeze([
    mysqlTextCol("meta_key", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("meta_value", "varchar", "ascii", "ascii_bin", { length: 255 }),
  ]),
  [TABLE_COMMITS]: Object.freeze([
    mysqlTextCol("asset_id", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("job_id", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("token_sha256", "char", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("root_id", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("kind", "varchar", "ascii", "ascii_bin", { length: 8 }),
    mysqlTextCol("library_generation", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("asset_generation", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("source_generation", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("context_json", "mediumtext", "utf8mb4", "utf8mb4_bin"),
    mysqlTextCol("fingerprint", "char", "ascii", "ascii_bin", { length: 64 }),
    mysqlCol("created_at_ms", "bigint"),
    mysqlCol("consumed_at_ms", "bigint", { nullable: true }),
  ]),
  [TABLE_RECORDS]: Object.freeze([
    mysqlTextCol("asset_id", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("token_sha256", "char", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("job_id", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("root_id", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("kind", "varchar", "ascii", "ascii_bin", { length: 8 }),
    mysqlTextCol("library_generation", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("asset_generation", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("source_generation", "varchar", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("context_json", "mediumtext", "utf8mb4", "utf8mb4_bin"),
    mysqlTextCol("fingerprint", "char", "ascii", "ascii_bin", { length: 64 }),
    mysqlTextCol("payload_json", "mediumtext", "utf8mb4", "utf8mb4_bin"),
    mysqlCol("payload_bytes", "int", { unsigned: true }),
    mysqlTextCol("payload_sha256", "char", "ascii", "ascii_bin", { length: 64 }),
    mysqlCol("analyzed_ms", "double"),
    mysqlCol("analyzed_at_ms", "bigint"),
    mysqlCol("saved_at_ms", "bigint"),
    mysqlCol("invalidated_at_ms", "bigint", { nullable: true }),
  ]),
});

/** 唯一索引：PRIMARY + commits 的 token 唯一键。 */
const MYSQL_UNIQUE_INDEXES = Object.freeze({
  [TABLE_META]: Object.freeze({ primary: Object.freeze(["meta_key"]), unique: Object.freeze([]) }),
  [TABLE_COMMITS]: Object.freeze({
    primary: Object.freeze(["asset_id"]),
    unique: Object.freeze([Object.freeze(["token_sha256"])]),
  }),
  [TABLE_RECORDS]: Object.freeze({ primary: Object.freeze(["asset_id"]), unique: Object.freeze([]) }),
});

const MYSQL_BUSY_CODES = new Set([
  "ER_LOCK_WAIT_TIMEOUT",
  "ER_LOCK_DEADLOCK",
  "ER_QUERY_TIMEOUT",
]);
const MYSQL_CLOSED_CODES = new Set([
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "ECONNRESET",
  "EPIPE",
  "ER_SERVER_SHUTDOWN",
  "ER_CONN",
]);

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GENERATION_PATTERN = /^[0-9a-f]{32,64}$/;
const TONIC_PATTERN = /^[A-G][#b]?$/;

const IDENTITY_FIELDS = Object.freeze([
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
]);

const RESULT_FIELDS = Object.freeze([
  "ok",
  "schemaVersion",
  "protocol",
  "value",
  "warnings",
  "provenance",
  "fingerprint",
]);
const VALUE_FIELDS = Object.freeze(["bpm", "key", "loud", "energy", "fit", "seg"]);
const KEY_FIELDS = Object.freeze(["tonic", "mode", "keyScore", "recognized"]);
const LOUD_FIELDS = Object.freeze(["peakDbfs", "rmsDbfs"]);
const ENERGY_FIELDS = Object.freeze(["minDbfs", "maxDbfs", "stdDb"]);
const FIT_FIELDS = Object.freeze(["beat", "tonal", "chord"]);
const SEG_FIELDS = Object.freeze(["energyChangeSec"]);
const TIMING_FIELDS = Object.freeze(["analyzedMs", "analyzedAtMs"]);

const WARNING_SET = new Set(["BPM_UNAVAILABLE", "KEY_UNRECOGNIZED", "UNKNOWN_FIELDS_IGNORED"]);

const WARNINGS = Object.freeze({
  BPM_UNAVAILABLE: "BPM_UNAVAILABLE",
  KEY_UNRECOGNIZED: "KEY_UNRECOGNIZED",
  UNKNOWN_FIELDS_IGNORED: "UNKNOWN_FIELDS_IGNORED",
});

/** 固定错误码；所有对外异常只带 code + 固定短文案。 */
export const STORE_ERROR_CODES = Object.freeze({
  INVALID_OPTIONS: "INVALID_OPTIONS",
  INVALID_DB: "INVALID_DB",
  UNSUPPORTED_STORAGE: "UNSUPPORTED_STORAGE",
  STORE_CLOSED: "STORE_CLOSED",
  STORE_NOT_INITIALIZED: "STORE_NOT_INITIALIZED",
  SCHEMA_CONFLICT: "SCHEMA_CONFLICT",
  UNSUPPORTED_SCHEMA_VERSION: "UNSUPPORTED_SCHEMA_VERSION",
  SCHEMA_INIT_FAILED: "SCHEMA_INIT_FAILED",
  STORAGE_BUSY: "STORAGE_BUSY",
  STORAGE_ERROR: "STORAGE_ERROR",
  INVALID_ASSET_ID: "INVALID_ASSET_ID",
  INVALID_JOB_ID: "INVALID_JOB_ID",
  INVALID_IDENTITY: "INVALID_IDENTITY",
  IDENTITY_CHANGED: "IDENTITY_CHANGED",
  ASSET_UNAVAILABLE: "ASSET_UNAVAILABLE",
  RESOLVER_FAILED: "RESOLVER_FAILED",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_CONSUMED: "TOKEN_CONSUMED",
  INVALID_RESULT: "INVALID_RESULT",
  RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
  RESULT_MISMATCH: "RESULT_MISMATCH",
  INVALID_TIMES: "INVALID_TIMES",
  INVALID_CONTEXT: "INVALID_CONTEXT",
});

const ERROR_MESSAGES = Object.freeze({
  INVALID_OPTIONS: "store options must be exactly {db, resolveCurrent}",
  INVALID_DB: "db must expose synchronous SQLite or MySQL methods",
  UNSUPPORTED_STORAGE: "only synchronous SQLite or MySQL storage is supported",
  STORE_CLOSED: "database connection is closed",
  STORE_NOT_INITIALIZED: "initSchema must be called before use",
  SCHEMA_CONFLICT: "existing audio result store schema is incompatible",
  UNSUPPORTED_SCHEMA_VERSION: "audio result store schema version is not supported",
  SCHEMA_INIT_FAILED: "audio result store schema initialization failed",
  STORAGE_BUSY: "database is busy",
  STORAGE_ERROR: "database operation failed",
  INVALID_ASSET_ID: "assetId must be 1-64 ASCII letters, digits, underscore or hyphen",
  INVALID_JOB_ID: "jobId must be 1-64 ASCII letters, digits, underscore or hyphen",
  INVALID_IDENTITY: "identity does not match the required shape",
  IDENTITY_CHANGED: "current identity no longer matches the expected identity",
  ASSET_UNAVAILABLE: "asset is not currently managed",
  RESOLVER_FAILED: "current identity resolver failed",
  INVALID_TOKEN: "commit token is not current",
  TOKEN_CONSUMED: "commit token has already been consumed",
  INVALID_RESULT: "normalized result does not match the required shape",
  RESULT_TOO_LARGE: "normalized result payload exceeds 64 KiB",
  RESULT_MISMATCH: "normalized result does not match the commit",
  INVALID_TIMES: "timing object must be exactly two finite non-negative values",
  INVALID_CONTEXT: "context does not match the required shape",
});

/** 固定错误类型；message 是固定文案，绝不拼接 SQL、路径或原始异常。 */
export class AudioResultStoreError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.STORAGE_ERROR);
    this.name = "AudioResultStoreError";
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : "STORAGE_ERROR";
  }
}

/**
 * 隔离的本地结果存储。构造只保存 db/resolveCurrent 引用，不执行 SQL/DDL。
 *
 * @param {{db: object, resolveCurrent: (assetId: string, db: object) => object|null}} options
 */
export class AudioResultStore {
  #db;
  #resolveCurrent;
  #dialect;
  #initialized = false;

  constructor(options) {
    let values;
    try {
      values = readOwnDataValues(options, ["db", "resolveCurrent"]);
    } catch {
      values = null;
    }
    if (!values) throw new AudioResultStoreError("INVALID_OPTIONS");

    const db = values.db;
    const resolveCurrent = values.resolveCurrent;
    if (resolveCurrent === null || typeof resolveCurrent !== "function") {
      throw new AudioResultStoreError("INVALID_OPTIONS");
    }
    if (db === null || typeof db !== "object" || Array.isArray(db)) {
      throw new AudioResultStoreError("INVALID_DB");
    }

    // better-sqlite3 原生实例没有 kind 属性；显式 kind 只接受 "sqlite"。
    // MySQL 仅接受既有 MysqlDatabase 的同步适配器；其它未知 kind 在构造期
    // 固定拒绝，且不碰 db.prepare。
    const kind = db.kind;
    if (kind !== undefined && kind !== "sqlite" && kind !== "mysql") {
      throw new AudioResultStoreError("UNSUPPORTED_STORAGE");
    }
    if (
      typeof db.prepare !== "function" ||
      typeof db.exec !== "function" ||
      typeof db.transaction !== "function"
    ) {
      throw new AudioResultStoreError("INVALID_DB");
    }

    this.#db = db;
    this.#resolveCurrent = resolveCurrent;
    this.#dialect = kind === "mysql" ? "mysql" : "sqlite";
  }

  /**
   * 显式幂等初始化。首次创建三张隔离表；重复调用不执行 SQL。
   * @returns {{ok:true, schemaVersion:1, created:boolean}}
   */
  initSchema() {
    if (this.#initialized) {
      this.#assertOpen();
      return Object.freeze({ ok: true, schemaVersion: STORE_SCHEMA_VERSION, created: false });
    }
    this.#assertOpen();

    let outcome;
    try {
      // MySQL DDL 会隐式提交，不能伪装成 SQLite 的“DDL 事务回滚”。
      outcome =
        this.#dialect === "mysql"
          ? this.#initSchemaMysql()
          : this.#db.transaction(() => this.#initSchemaTx())();
    } catch (error) {
      throw this.#translate(error, "SCHEMA_INIT_FAILED");
    }
    this.#initialized = true;
    return deepFreeze({
      ok: true,
      schemaVersion: STORE_SCHEMA_VERSION,
      created: outcome.created,
    });
  }

  /**
   * 申请提交资格：短事务内重读当前身份、对照 expectedIdentity，原子替换旧资格。
   *
   * @param {string} assetId
   * @param {string} jobId
   * @param {object} expectedIdentity 由 resolveCurrent 得到的身份快照
   * @returns {{ok:true, assetId:string, jobId:string, token:string,
   *   fingerprint:string, libraryGeneration:string, assetGeneration:string,
   *   sourceGeneration:string, createdAtMs:number}}
   */
  begin(assetId, jobId, expectedIdentity) {
    this.#assertReady();
    assertId(assetId, "INVALID_ASSET_ID");
    assertId(jobId, "INVALID_JOB_ID");
    const expected = this.#snapshotIdentity(expectedIdentity, assetId);

    let summary;
    try {
      summary = this.#db.transaction(() => {
        const current = this.#resolveIdentity(assetId);
        if (current === null || !isManaged(current)) {
          throw storeError("ASSET_UNAVAILABLE");
        }
        if (!identityEqual(current, expected)) {
          throw storeError("IDENTITY_CHANGED");
        }

        const token = randomBytes(32).toString("hex");
        const now = Date.now();
        this.#db
          .prepare(this.#dialect === "mysql" ? MYSQL_COMMIT_UPSERT : SQLITE_COMMIT_UPSERT)
          .run(
            assetId,
            jobId,
            sha256(token),
            current.rootId,
            current.kind,
            current.libraryGeneration,
            current.assetGeneration,
            current.sourceGeneration,
            canonicalContext(current.context),
            current.contextFingerprint,
            now,
          );

        return {
          ok: true,
          assetId,
          jobId,
          token,
          fingerprint: current.contextFingerprint,
          libraryGeneration: current.libraryGeneration,
          assetGeneration: current.assetGeneration,
          sourceGeneration: current.sourceGeneration,
          createdAtMs: now,
        };
      })();
    } catch (error) {
      throw this.#translate(error, "STORAGE_ERROR");
    }
    return deepFreeze(summary);
  }

  /**
   * 在短事务里复核 token/身份/generation/context/指纹，成功才 upsert 并消费 token。
   * 同一 token 第二次保存固定 TOKEN_CONSUMED，绝不允许同 token 写不同 payload。
   *
   * @param {string} token
   * @param {object} normalizedResult T13D normalizeAudioResult 的成功结果
   * @param {{analyzedMs:number, analyzedAtMs:number}} timing
   */
  save(token, normalizedResult, timing) {
    this.#assertReady();
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
      throw storeError("INVALID_TOKEN");
    }
    const times = readTiming(timing);
    let result;
    try {
      result = validateResult(normalizedResult);
    } catch (error) {
      if (error instanceof AudioResultStoreError) throw error;
      throw storeError("INVALID_RESULT");
    }
    const tokenHash = sha256(token);

    let summary;
    try {
      summary = this.#db.transaction(() => {
        const commit = this.#db
          .prepare(
            this.#dialect === "mysql" ? `${COMMIT_SELECT} FOR UPDATE` : COMMIT_SELECT,
          )
          .get(tokenHash);

        if (!commit) throw storeError("INVALID_TOKEN");
        if (commit.consumed_at_ms !== null) throw storeError("TOKEN_CONSUMED");

        const current = this.#resolveIdentity(commit.asset_id);
        if (current === null || !isManaged(current)) {
          throw storeError("ASSET_UNAVAILABLE");
        }
        if (!commitMatchesIdentity(commit, current)) {
          throw storeError("IDENTITY_CHANGED");
        }
        if (
          commit.fingerprint !== result.fingerprint ||
          commit.context_json !== result.contextJson
        ) {
          throw storeError("RESULT_MISMATCH");
        }

        const savedAtMs = Date.now();
        this.#db
          .prepare(this.#dialect === "mysql" ? MYSQL_RECORD_UPSERT : SQLITE_RECORD_UPSERT)
          .run(
            commit.asset_id,
            tokenHash,
            commit.job_id,
            current.rootId,
            current.kind,
            current.libraryGeneration,
            current.assetGeneration,
            current.sourceGeneration,
            result.contextJson,
            result.fingerprint,
            result.payloadJson,
            result.payloadBytes,
            result.payloadSha256,
            times.analyzedMs,
            times.analyzedAtMs,
            savedAtMs,
          );

        const consumed = this.#db
          .prepare(
            `UPDATE ${TABLE_COMMITS}
                SET consumed_at_ms = ?
              WHERE asset_id = ? AND token_sha256 = ? AND consumed_at_ms IS NULL`,
          )
          .run(savedAtMs, commit.asset_id, tokenHash);
        if (consumed.changes !== 1) throw storeError("STORAGE_ERROR");

        return {
          ok: true,
          assetId: commit.asset_id,
          jobId: commit.job_id,
          fingerprint: result.fingerprint,
          analyzedMs: times.analyzedMs,
          analyzedAtMs: times.analyzedAtMs,
          savedAtMs,
          payloadBytes: result.payloadBytes,
          consumed: true,
        };
      })();
    } catch (error) {
      throw this.#translate(error, "STORAGE_ERROR");
    }
    return deepFreeze(summary);
  }

  /**
   * 只读查询。missing/ready/stale 三态；隐藏/离线/trashed/retired/rootRetired/busy
   * 或 resolver 返回 null 时只返回 missing，不泄露旧结果。
   *
   * @param {string} assetId
   * @param {object} expectedContext 未来可信身份提供的 T13D context
   */
  get(assetId, expectedContext) {
    this.#assertReady();
    assertId(assetId, "INVALID_ASSET_ID");
    const expectedFingerprint = fingerprintContext(expectedContext);

    let outcome;
    try {
      outcome = this.#db.transaction(() => {
        const current = this.#resolveIdentity(assetId);
        if (current === null || !isManaged(current)) {
          return { ok: true, status: "missing" };
        }

        const row = this.#db.prepare(RECORD_SELECT).get(assetId);
        if (!row) return { ok: true, status: "missing" };

        // 先校验读取侧元数据；任何损坏都在解析 payload 之前固定 CORRUPT，
        // 且不把损坏的时间列原样带回。
        const storedTiming = readStoredTiming(row);
        if (storedTiming === null) {
          return { ok: true, assetId, status: "stale", reason: "CORRUPT", result: null };
        }
        if (!isBoundedPayload(row.payload_json, row.payload_bytes)) {
          return { ok: true, assetId, status: "stale", reason: "CORRUPT", result: null };
        }

        const base = {
          ok: true,
          assetId,
          savedAtMs: storedTiming.savedAtMs,
          analyzedMs: storedTiming.analyzedMs,
          analyzedAtMs: storedTiming.analyzedAtMs,
        };

        let validated;
        try {
          const parsed = decodeJson(row.payload_json);
          validated = validateResult(parsed);
        } catch {
          return { ...base, status: "stale", reason: "CORRUPT", result: null };
        }
        if (
          validated.fingerprint !== row.fingerprint ||
          validated.contextJson !== row.context_json ||
          validated.payloadBytes !== row.payload_bytes ||
          validated.payloadSha256 !== row.payload_sha256 ||
          row.payload_bytes > MAX_STORE_PAYLOAD_BYTES
        ) {
          return { ...base, status: "stale", reason: "CORRUPT", result: null };
        }

        if (storedTiming.invalidatedAtMs !== null) {
          return { ...base, status: "stale", reason: "INVALIDATED", result: validated.payload };
        }
        if (row.fingerprint !== expectedFingerprint) {
          return { ...base, status: "stale", reason: "CONTEXT_CHANGED", result: validated.payload };
        }
        if (!recordMatchesIdentity(row, current)) {
          return { ...base, status: "stale", reason: "CURRENT_CHANGED", result: validated.payload };
        }

        return { ...base, status: "ready", result: validated.payload };
      })();
    } catch (error) {
      throw this.#translate(error, "STORAGE_ERROR");
    }
    return deepFreeze(outcome);
  }

  /**
   * T13G：只按 token 定向撤销提交资格。
   *
   * 与 invalidate(assetId) 不同，本方法只在给定 token 仍是该 asset 的当前未消费
   * 资格时才撤销，并按同一 token 让旧成功 stale；已被新 begin 替换的旧 token、
   * 已消费 token、未知 token 都不会影响新任务或新结果。短事务 + 参数绑定；
   * MySQL 先 FOR UPDATE 锁提交行，避免与 save/新 begin 的覆盖窗口。
   *
   * @param {string} token begin 返回的 64 位十六进制 token
   * @returns {{ok:true, tokenMatched:boolean, revokedCommit:boolean, invalidatedResult:boolean}}
   */
  invalidateToken(token) {
    this.#assertReady();
    if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
      throw storeError("INVALID_TOKEN");
    }
    const tokenHash = sha256(token);

    let outcome;
    try {
      outcome = this.#db.transaction(() => {
        const row = this.#db
          .prepare(
            this.#dialect === "mysql"
              ? `SELECT asset_id, consumed_at_ms FROM ${TABLE_COMMITS} WHERE token_sha256 = ? FOR UPDATE`
              : `SELECT asset_id, consumed_at_ms FROM ${TABLE_COMMITS} WHERE token_sha256 = ?`,
          )
          .get(tokenHash);
        if (!row) {
          return {
            ok: true,
            tokenMatched: false,
            revokedCommit: false,
            invalidatedResult: false,
          };
        }
        // 已消费 token 不是当前资格，绝不因此把已提交结果改 stale。
        if (row.consumed_at_ms !== null) {
          return {
            ok: true,
            tokenMatched: true,
            revokedCommit: false,
            invalidatedResult: false,
          };
        }

        const now = Date.now();
        const commits = this.#db
          .prepare(
            `UPDATE ${TABLE_COMMITS}
                SET consumed_at_ms = ?
              WHERE token_sha256 = ? AND consumed_at_ms IS NULL`,
          )
          .run(now, tokenHash);
        if (commits.changes !== 1) {
          // 同一事务内只可能与 save 竞争；未撤销成功时不得动结果。
          return {
            ok: true,
            tokenMatched: true,
            revokedCommit: false,
            invalidatedResult: false,
          };
        }
        const records = this.#db
          .prepare(
            `UPDATE ${TABLE_RECORDS}
                SET invalidated_at_ms = ?
              WHERE asset_id = ? AND invalidated_at_ms IS NULL`,
          )
          .run(now, row.asset_id);
        return {
          ok: true,
          tokenMatched: true,
          revokedCommit: true,
          invalidatedResult: records.changes > 0,
        };
      })();
    } catch (error) {
      throw this.#translate(error, "STORAGE_ERROR");
    }
    return deepFreeze(outcome);
  }

  /**
   * 撤销当前提交资格并让最近成功结果 stale，但不删除结果行。
   * 幂等：没有资格/结果时也返回 ok。
   */
  invalidate(assetId) {
    this.#assertReady();
    assertId(assetId, "INVALID_ASSET_ID");

    let outcome;
    try {
      outcome = this.#db.transaction(() => {
        const now = Date.now();
        const commits = this.#db
          .prepare(
            `UPDATE ${TABLE_COMMITS}
                SET consumed_at_ms = ?
              WHERE asset_id = ? AND consumed_at_ms IS NULL`,
          )
          .run(now, assetId);
        const records = this.#db
          .prepare(
            `UPDATE ${TABLE_RECORDS}
                SET invalidated_at_ms = ?
              WHERE asset_id = ? AND invalidated_at_ms IS NULL`,
          )
          .run(now, assetId);
        return {
          ok: true,
          assetId,
          revokedCommit: commits.changes > 0,
          invalidatedResult: records.changes > 0,
        };
      })();
    } catch (error) {
      throw this.#translate(error, "STORAGE_ERROR");
    }
    return deepFreeze(outcome);
  }

  /* ---------------------------------------------------------------- */
  /* schema                                                           */
  /* ---------------------------------------------------------------- */

  #initSchemaTx() {
    const names = [TABLE_META, TABLE_COMMITS, TABLE_RECORDS];
    const rows = this.#db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`,
      )
      .all(...names);
    const present = new Set(rows.map((row) => row.name));

    if (present.size === 0) {
      this.#db.exec(`
        CREATE TABLE ${TABLE_META} (
          meta_key TEXT PRIMARY KEY NOT NULL,
          meta_value TEXT NOT NULL
        );
        CREATE TABLE ${TABLE_COMMITS} (
          asset_id TEXT PRIMARY KEY NOT NULL,
          job_id TEXT NOT NULL,
          token_sha256 TEXT NOT NULL UNIQUE,
          root_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          library_generation TEXT NOT NULL,
          asset_generation TEXT NOT NULL,
          source_generation TEXT NOT NULL,
          context_json TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          consumed_at_ms INTEGER
        );
        CREATE TABLE ${TABLE_RECORDS} (
          asset_id TEXT PRIMARY KEY NOT NULL,
          token_sha256 TEXT NOT NULL,
          job_id TEXT NOT NULL,
          root_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          library_generation TEXT NOT NULL,
          asset_generation TEXT NOT NULL,
          source_generation TEXT NOT NULL,
          context_json TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_bytes INTEGER NOT NULL,
          payload_sha256 TEXT NOT NULL,
          analyzed_ms REAL NOT NULL,
          analyzed_at_ms INTEGER NOT NULL,
          saved_at_ms INTEGER NOT NULL,
          invalidated_at_ms INTEGER
        );
      `);
      this.#db
        .prepare(
          `INSERT INTO ${TABLE_META} (meta_key, meta_value) VALUES (?, ?), (?, ?)`,
        )
        .run("schema_version", String(STORE_SCHEMA_VERSION), "created_at_ms", String(Date.now()));
      return { created: true };
    }

    if (!present.has(TABLE_META)) throw storeError("SCHEMA_CONFLICT");

    const meta = this.#db
      .prepare(`SELECT meta_value FROM ${TABLE_META} WHERE meta_key = ?`)
      .get("schema_version");
    if (!meta || meta.meta_value !== String(STORE_SCHEMA_VERSION)) {
      throw storeError("UNSUPPORTED_SCHEMA_VERSION");
    }

    for (const name of names) {
      if (!present.has(name)) throw storeError("SCHEMA_CONFLICT");
      const columns = this.#db
        .prepare(`PRAGMA table_info(${name})`)
        .all()
        .map((row) => row.name);
      if (columns.join(",") !== TABLE_COLUMNS[name].join(",")) {
        throw storeError("SCHEMA_CONFLICT");
      }
    }
    return { created: false };
  }

  /**
   * MySQL 初始化：先探测三表是否齐全，缺任意一张就拒绝；全部不存在才建表。
   * DDL 会隐式提交，因此**最后**才写 schema_version marker，任何 DDL 失败都
   * 不会留下“成功版本”。残留表保留不删，重复 init 受控 SCHEMA_CONFLICT。
   * 两个实例并行 init 时，结果只可能是成功一致或受控 SCHEMA_CONFLICT。
   */
  #initSchemaMysql() {
    const names = [TABLE_META, TABLE_COMMITS, TABLE_RECORDS];
    const rows = this.#db
      .prepare(
        `SELECT TABLE_NAME AS name
           FROM information_schema.tables
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?)`,
      )
      .all(...names);
    const present = new Set(rows.map((row) => row.name));

    if (present.size === 0) {
      for (const ddl of MYSQL_DDL) this.#db.exec(ddl);
      this.#verifyMysqlSchema();
      this.#db
        .prepare(
          `INSERT INTO ${TABLE_META} (meta_key, meta_value) VALUES (?, ?), (?, ?)
           ON DUPLICATE KEY UPDATE meta_value = meta_value`,
        )
        .run("schema_version", String(STORE_SCHEMA_VERSION), "created_at_ms", String(Date.now()));
      const marker = this.#db
        .prepare(`SELECT meta_value FROM ${TABLE_META} WHERE meta_key = ?`)
        .get("schema_version");
      if (!marker || marker.meta_value !== String(STORE_SCHEMA_VERSION)) {
        throw storeError("SCHEMA_INIT_FAILED");
      }
      return { created: true };
    }

    // 半初始化残留（只有部分表）明确拒绝，不删除、不补建、不写 marker。
    if (present.size !== names.length) throw storeError("SCHEMA_CONFLICT");

    this.#verifyMysqlSchema();
    const marker = this.#db
      .prepare(`SELECT meta_value FROM ${TABLE_META} WHERE meta_key = ?`)
      .get("schema_version");
    // 结构完整但缺 marker 只可能来自中断的首次 DDL；保守拒绝而不是猜版本。
    if (!marker) throw storeError("SCHEMA_CONFLICT");
    if (marker.meta_value !== String(STORE_SCHEMA_VERSION)) {
      throw storeError("UNSUPPORTED_SCHEMA_VERSION");
    }
    return { created: false };
  }

  /** 显式校验 MySQL 表引擎、列类型/可空/排序语义与主键/唯一 token 约束。 */
  #verifyMysqlSchema() {
    const names = [TABLE_META, TABLE_COMMITS, TABLE_RECORDS];
    const tables = this.#db
      .prepare(
        `SELECT TABLE_NAME AS name, ENGINE AS engine
           FROM information_schema.tables
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?, ?, ?)`,
      )
      .all(...names);
    if (!Array.isArray(tables) || tables.length !== names.length) {
      throw storeError("SCHEMA_CONFLICT");
    }
    const engines = new Map(tables.map((row) => [row.name, String(row.engine ?? "").toLowerCase()]));

    for (const name of names) {
      if (engines.get(name) !== "innodb") throw storeError("SCHEMA_CONFLICT");

      const columns = this.#db
        .prepare(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType, COLUMN_TYPE AS columnType,
                  IS_NULLABLE AS nullable, CHARACTER_SET_NAME AS charset,
                  COLLATION_NAME AS collation
             FROM information_schema.columns
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION`,
        )
        .all(name);
      const expectedColumns = MYSQL_COLUMNS[name];
      if (!Array.isArray(columns) || columns.length !== expectedColumns.length) {
        throw storeError("SCHEMA_CONFLICT");
      }
      for (let index = 0; index < expectedColumns.length; index += 1) {
        const actual = columns[index];
        const expected = expectedColumns[index];
        const expectedColumnType = expected.unsigned
          ? `${expected.type} unsigned`
          : expected.length
            ? `${expected.type}(${expected.length})`
            : expected.type;
        if (
          actual.name !== expected.name ||
          String(actual.dataType ?? "").toLowerCase() !== expected.type ||
          actual.columnType !== expectedColumnType ||
          (actual.nullable === "YES") !== expected.nullable ||
          (actual.charset ?? null) !== expected.charset ||
          (actual.collation ?? null) !== expected.collation
        ) {
          throw storeError("SCHEMA_CONFLICT");
        }
      }

      const stats = this.#db
        .prepare(
          `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
                  SEQ_IN_INDEX AS seq, COLUMN_NAME AS columnName,
                  SUB_PART AS subPart, INDEX_TYPE AS indexType,
                  EXPRESSION AS expression
             FROM information_schema.statistics
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
            ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
        )
        .all(name);
      if (!Array.isArray(stats)) throw storeError("SCHEMA_CONFLICT");

      const grouped = new Map();
      for (const row of stats) {
        const indexName = row.indexName;
        // 列名相同不代表索引语义相同：token_sha256(1) 这种前缀唯一索引只约束
        // 首字符，函数索引/非 BTREE 索引同样不是契约里的完整列唯一约束。
        // SUB_PART 为 NULL、EXPRESSION 为空、INDEX_TYPE=BTREE 才视为完整列索引。
        const subPart = row.subPart === null || row.subPart === undefined ? null : Number(row.subPart);
        const expression = row.expression ?? null;
        if (
          typeof row.columnName !== "string" ||
          row.columnName.length === 0 ||
          subPart !== null ||
          expression !== null ||
          String(row.indexType ?? "").toUpperCase() !== "BTREE"
        ) {
          throw storeError("SCHEMA_CONFLICT");
        }
        if (!grouped.has(indexName)) {
          grouped.set(indexName, { nonUnique: Number(row.nonUnique), columns: [] });
        }
        const info = grouped.get(indexName);
        if (Number(row.nonUnique) !== info.nonUnique) throw storeError("SCHEMA_CONFLICT");
        if (Number(row.seq) !== info.columns.length + 1) throw storeError("SCHEMA_CONFLICT");
        info.columns.push(row.columnName);
      }
      const spec = MYSQL_UNIQUE_INDEXES[name];
      const primary = grouped.get("PRIMARY");
      if (
        !primary ||
        primary.nonUnique !== 0 ||
        primary.columns.join(",") !== spec.primary.join(",")
      ) {
        throw storeError("SCHEMA_CONFLICT");
      }
      const unique = [];
      for (const [indexName, info] of grouped) {
        if (indexName === "PRIMARY") continue;
        if (info.nonUnique === 0) unique.push(info.columns.join(","));
      }
      const expectedUnique = spec.unique.map((columns2) => columns2.join(","));
      if (unique.length !== expectedUnique.length) throw storeError("SCHEMA_CONFLICT");
      for (const expected of expectedUnique) {
        if (!unique.includes(expected)) throw storeError("SCHEMA_CONFLICT");
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* identity                                                         */
  /* ---------------------------------------------------------------- */

  #resolveIdentity(assetId) {
    let raw;
    try {
      raw = this.#resolveCurrent(assetId, this.#db);
    } catch {
      throw storeError("RESOLVER_FAILED");
    }
    // 先按原生 Promise 内部身份判定，独立于对象自有 then 的形状：真正原生
    // Promise 即使 then 被遮蔽为 null/undefined/非函数，也必须固定拒绝并
    // 安全消费其拒绝，不能落入身份快照分支。
    let genuinePromise;
    try {
      genuinePromise = utilTypes.isPromise(raw);
    } catch {
      throw storeError("RESOLVER_FAILED");
    }
    if (genuinePromise) {
      // 同步接口仍拒绝异步 resolver，不 await、不延长事务；但已产生的原生
      // Promise 拒绝要安全消费，避免默认策略下变成 unhandledRejection。
      consumeNativeRejection(raw);
      throw storeError("RESOLVER_FAILED");
    }
    let thenable;
    try {
      thenable = isThenable(raw);
    } catch {
      throw storeError("RESOLVER_FAILED");
    }
    if (thenable) {
      // 普通 thenable 只按形状拒绝，绝不读取/执行其 then getter 或方法。
      throw storeError("RESOLVER_FAILED");
    }
    if (raw === null || raw === undefined) return null;
    return this.#snapshotIdentity(raw, assetId);
  }

  #snapshotIdentity(raw, expectedAssetId) {
    let values;
    try {
      values = readOwnDataValues(raw, IDENTITY_FIELDS);
    } catch {
      values = null;
    }
    if (!values) throw storeError("INVALID_IDENTITY");

    if (values.assetId !== expectedAssetId || !ID_PATTERN.test(values.assetId)) {
      throw storeError("INVALID_IDENTITY");
    }
    if (typeof values.rootId !== "string" || !ID_PATTERN.test(values.rootId)) {
      throw storeError("INVALID_IDENTITY");
    }
    if (values.kind !== "music" && values.kind !== "sfx") {
      throw storeError("INVALID_IDENTITY");
    }
    for (const name of ["online", "trashed", "retired", "rootRetired", "busy"]) {
      if (typeof values[name] !== "boolean") throw storeError("INVALID_IDENTITY");
    }
    for (const name of ["libraryGeneration", "assetGeneration", "sourceGeneration"]) {
      if (typeof values[name] !== "string" || !GENERATION_PATTERN.test(values[name])) {
        throw storeError("INVALID_IDENTITY");
      }
    }

    let fingerprint;
    try {
      fingerprint = createAudioResultFingerprint(values.context);
    } catch {
      throw storeError("INVALID_IDENTITY");
    }
    if (!fingerprint.ok) throw storeError("INVALID_IDENTITY");
    if (fingerprint.provenance.kind !== values.kind) throw storeError("INVALID_IDENTITY");

    return Object.freeze({
      assetId: values.assetId,
      rootId: values.rootId,
      kind: values.kind,
      online: values.online,
      trashed: values.trashed,
      retired: values.retired,
      rootRetired: values.rootRetired,
      busy: values.busy,
      libraryGeneration: values.libraryGeneration,
      assetGeneration: values.assetGeneration,
      sourceGeneration: values.sourceGeneration,
      contextFingerprint: fingerprint.fingerprint,
      context: fingerprint.provenance,
    });
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle / errors                                               */
  /* ---------------------------------------------------------------- */

  #isOpen() {
    // better-sqlite3 暴露 open；MysqlDatabase 暴露 closed。两者都不假设对方字段。
    if (this.#db.open === false) return false;
    if (this.#db.closed === true) return false;
    return true;
  }

  #assertOpen() {
    if (!this.#isOpen()) throw storeError("STORE_CLOSED");
  }

  #assertReady() {
    if (!this.#initialized) throw storeError("STORE_NOT_INITIALIZED");
    this.#assertOpen();
  }

  #translate(error, fallbackCode) {
    if (error instanceof AudioResultStoreError) return error;
    if (!this.#isOpen()) return storeError("STORE_CLOSED");
    const rawCode = typeof error?.code === "string" ? error.code : "";
    if (this.#dialect === "mysql") {
      if (MYSQL_BUSY_CODES.has(rawCode)) return storeError("STORAGE_BUSY");
      if (MYSQL_CLOSED_CODES.has(rawCode)) return storeError("STORE_CLOSED");
      return storeError(fallbackCode);
    }
    if (
      rawCode === "SQLITE_BUSY" ||
      rawCode === "SQLITE_BUSY_SNAPSHOT" ||
      rawCode === "SQLITE_BUSY_TIMEOUT" ||
      rawCode === "SQLITE_LOCKED"
    ) {
      return storeError("STORAGE_BUSY");
    }
    if (rawCode === "SQLITE_MISUSE" || rawCode === "SQLITE_CLOSED") {
      return storeError("STORE_CLOSED");
    }
    return storeError(fallbackCode);
  }
}

/* ------------------------------------------------------------------ */
/* result validation                                                   */
/* ------------------------------------------------------------------ */

/**
 * 严格校验一条 T13D 成功结果，重建 allowlist payload。
 * 不信任调用方 ok:true/指纹：provenance 必须能重新通过 T13D context 校验并算出同一指纹。
 */
function validateResult(result) {
  let top;
  try {
    top = readOwnDataValues(result, RESULT_FIELDS);
  } catch {
    top = null;
  }
  if (!top) throw storeError("INVALID_RESULT");
  if (top.ok !== true) throw storeError("INVALID_RESULT");
  if (top.schemaVersion !== RESULT_SCHEMA_VERSION) throw storeError("INVALID_RESULT");
  if (top.protocol !== PROTOCOL) throw storeError("INVALID_RESULT");
  if (typeof top.fingerprint !== "string" || !SHA256_PATTERN.test(top.fingerprint)) {
    throw storeError("INVALID_RESULT");
  }

  let fingerprint;
  try {
    fingerprint = createAudioResultFingerprint(top.provenance);
  } catch {
    throw storeError("INVALID_RESULT");
  }
  if (!fingerprint.ok || fingerprint.fingerprint !== top.fingerprint) {
    throw storeError("INVALID_RESULT");
  }
  const durationSec = fingerprint.provenance.durationSec;

  let value;
  try {
    value = readOwnDataValues(top.value, VALUE_FIELDS);
  } catch {
    value = null;
  }
  if (!value) throw storeError("INVALID_RESULT");

  const bpm = readBpm(value.bpm);
  const key = readKey(value.key);
  const loud = readLoud(value.loud);
  const energy = readEnergy(value.energy);
  const fit = readFit(value.fit);
  const seg = readSeg(value.seg, durationSec);

  const hasMeasurement =
    bpm !== null ||
    key.keyScore !== null ||
    key.recognized === true ||
    loud.peakDbfs !== null ||
    loud.rmsDbfs !== null ||
    energy.minDbfs !== null ||
    energy.maxDbfs !== null ||
    energy.stdDb !== null ||
    fit.beat !== null ||
    fit.tonal !== null ||
    fit.chord !== null ||
    (seg !== null && seg.energyChangeSec.length > 0);
  if (!hasMeasurement) throw storeError("INVALID_RESULT");

  const warnings = readWarnings(top.warnings);
  if (warnings.includes(WARNINGS.BPM_UNAVAILABLE) && bpm !== null) {
    throw storeError("INVALID_RESULT");
  }
  if (warnings.includes(WARNINGS.KEY_UNRECOGNIZED) && key.recognized !== false) {
    throw storeError("INVALID_RESULT");
  }

  const payload = {
    ok: true,
    schemaVersion: RESULT_SCHEMA_VERSION,
    protocol: PROTOCOL,
    value: {
      bpm,
      key: {
        tonic: key.tonic,
        mode: key.mode,
        keyScore: key.keyScore,
        recognized: key.recognized,
      },
      loud: { peakDbfs: loud.peakDbfs, rmsDbfs: loud.rmsDbfs },
      energy: {
        minDbfs: energy.minDbfs,
        maxDbfs: energy.maxDbfs,
        stdDb: energy.stdDb,
      },
      fit: { beat: fit.beat, tonal: fit.tonal, chord: fit.chord },
      seg: seg === null ? null : { energyChangeSec: [...seg.energyChangeSec] },
    },
    warnings: [...warnings],
    provenance: fingerprint.provenance,
    fingerprint: fingerprint.fingerprint,
  };
  const payloadJson = encodeJson(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  if (payloadBytes > MAX_STORE_PAYLOAD_BYTES) throw storeError("RESULT_TOO_LARGE");

  return {
    payload: deepFreeze(payload),
    payloadJson,
    payloadBytes,
    payloadSha256: sha256(payloadJson),
    fingerprint: fingerprint.fingerprint,
    contextJson: canonicalContext(fingerprint.provenance),
  };
}

function readBpm(value) {
  if (value === null) return null;
  if (!isFiniteNumber(value) || value <= 0 || value > 400) {
    throw storeError("INVALID_RESULT");
  }
  return value;
}

function readKey(value) {
  let key;
  try {
    key = readOwnDataValues(value, KEY_FIELDS);
  } catch {
    key = null;
  }
  if (!key) throw storeError("INVALID_RESULT");

  const { tonic, mode, keyScore, recognized } = key;
  if (typeof recognized !== "boolean") throw storeError("INVALID_RESULT");
  if (tonic !== null && (typeof tonic !== "string" || !TONIC_PATTERN.test(tonic))) {
    throw storeError("INVALID_RESULT");
  }
  if (mode !== null && mode !== "major" && mode !== "minor") {
    throw storeError("INVALID_RESULT");
  }
  if (recognized) {
    if (tonic === null || mode === null) throw storeError("INVALID_RESULT");
  } else if (tonic !== null || mode !== null) {
    throw storeError("INVALID_RESULT");
  }
  if (keyScore !== null && (!isFiniteNumber(keyScore) || keyScore < 0 || keyScore > 1)) {
    throw storeError("INVALID_RESULT");
  }
  return { tonic, mode, keyScore, recognized };
}

function readLoud(value) {
  let loud;
  try {
    loud = readOwnDataValues(value, LOUD_FIELDS);
  } catch {
    loud = null;
  }
  if (!loud) throw storeError("INVALID_RESULT");
  for (const name of LOUD_FIELDS) {
    if (loud[name] !== null && (!isFiniteNumber(loud[name]) || loud[name] < -200 || loud[name] > 50)) {
      throw storeError("INVALID_RESULT");
    }
  }
  return { peakDbfs: loud.peakDbfs, rmsDbfs: loud.rmsDbfs };
}

function readEnergy(value) {
  let energy;
  try {
    energy = readOwnDataValues(value, ENERGY_FIELDS);
  } catch {
    energy = null;
  }
  if (!energy) throw storeError("INVALID_RESULT");
  for (const name of ["minDbfs", "maxDbfs"]) {
    if (
      energy[name] !== null &&
      (!isFiniteNumber(energy[name]) || energy[name] < -200 || energy[name] > 50)
    ) {
      throw storeError("INVALID_RESULT");
    }
  }
  if (energy.stdDb !== null && (!isFiniteNumber(energy.stdDb) || energy.stdDb < 0 || energy.stdDb > 200)) {
    throw storeError("INVALID_RESULT");
  }
  if (energy.minDbfs !== null && energy.maxDbfs !== null && energy.minDbfs > energy.maxDbfs) {
    throw storeError("INVALID_RESULT");
  }
  return { minDbfs: energy.minDbfs, maxDbfs: energy.maxDbfs, stdDb: energy.stdDb };
}

function readFit(value) {
  let fit;
  try {
    fit = readOwnDataValues(value, FIT_FIELDS);
  } catch {
    fit = null;
  }
  if (!fit) throw storeError("INVALID_RESULT");
  for (const name of FIT_FIELDS) {
    if (fit[name] !== null && (!isFiniteNumber(fit[name]) || fit[name] < 0 || fit[name] > 1)) {
      throw storeError("INVALID_RESULT");
    }
  }
  return { beat: fit.beat, tonal: fit.tonal, chord: fit.chord };
}

function readSeg(value, durationSec) {
  if (value === null) return null;
  let seg;
  try {
    seg = readOwnDataValues(value, SEG_FIELDS);
  } catch {
    seg = null;
  }
  if (!seg) throw storeError("INVALID_RESULT");
  const points = readArrayValues(seg.energyChangeSec, 1000);
  if (!points) throw storeError("INVALID_RESULT");
  let previous = -Infinity;
  for (const point of points) {
    if (!isFiniteNumber(point) || point < 0 || point > durationSec) {
      throw storeError("INVALID_RESULT");
    }
    if (point <= previous) throw storeError("INVALID_RESULT");
    previous = point;
  }
  return { energyChangeSec: points };
}

function readWarnings(value) {
  const warnings = readArrayValues(value, 3);
  if (!warnings) throw storeError("INVALID_RESULT");
  const seen = new Set();
  for (const warning of warnings) {
    if (typeof warning !== "string" || !WARNING_SET.has(warning) || seen.has(warning)) {
      throw storeError("INVALID_RESULT");
    }
    seen.add(warning);
  }
  return warnings;
}

function readTiming(timing) {
  let values;
  try {
    values = readOwnDataValues(timing, TIMING_FIELDS);
  } catch {
    values = null;
  }
  if (!values) throw storeError("INVALID_TIMES");
  const { analyzedMs, analyzedAtMs } = values;
  if (!isFiniteNumber(analyzedMs) || analyzedMs < 0 || analyzedMs > Number.MAX_SAFE_INTEGER) {
    throw storeError("INVALID_TIMES");
  }
  if (!Number.isSafeInteger(analyzedAtMs) || analyzedAtMs < 0) {
    throw storeError("INVALID_TIMES");
  }
  return { analyzedMs, analyzedAtMs };
}

/**
 * 读取侧严格校验存储的时间列。SQLite 类型亲和不阻止文本/负数写进
 * INTEGER/REAL 列，因此 ready/stale 的每个出口都只使用这里校验过的值。
 * 任何类型/范围错误返回 null，由 get 固定 stale CORRUPT 且不带坏值。
 */
function readStoredTiming(row) {
  const analyzedMs = row.analyzed_ms;
  const analyzedAtMs = row.analyzed_at_ms;
  const savedAtMs = row.saved_at_ms;
  const invalidatedAtMs = row.invalidated_at_ms;

  if (
    !isFiniteNumber(analyzedMs) ||
    analyzedMs < 0 ||
    analyzedMs > Number.MAX_SAFE_INTEGER
  ) {
    return null;
  }
  if (!Number.isSafeInteger(analyzedAtMs) || analyzedAtMs < 0) return null;
  if (!Number.isSafeInteger(savedAtMs) || savedAtMs < 0) return null;
  if (
    invalidatedAtMs !== null &&
    (!Number.isSafeInteger(invalidatedAtMs) || invalidatedAtMs < 0)
  ) {
    return null;
  }
  return { analyzedMs, analyzedAtMs, savedAtMs, invalidatedAtMs };
}

/**
 * 解析前核验真实 payload 文本与声明长度：只接受字符串、真实 UTF-8
 * 字节数与 payload_bytes 完全一致、且不超过 64 KiB。声明列不可信，
 * 超限内容根本不进入 JSON.parse。
 */
function isBoundedPayload(text, declaredBytes) {
  if (typeof text !== "string") return false;
  if (
    !Number.isSafeInteger(declaredBytes) ||
    declaredBytes < 0 ||
    declaredBytes > MAX_STORE_PAYLOAD_BYTES
  ) {
    return false;
  }
  // UTF-8 字节数不小于 JS 字符串长度；先做 O(1) 上界短路，再核真实字节。
  if (text.length > MAX_STORE_PAYLOAD_BYTES) return false;
  const actualBytes = Buffer.byteLength(text, "utf8");
  return actualBytes <= MAX_STORE_PAYLOAD_BYTES && actualBytes === declaredBytes;
}

/* ------------------------------------------------------------------ */
/* identity helpers                                                    */
/* ------------------------------------------------------------------ */

function isManaged(identity) {
  return (
    identity.online === true &&
    identity.trashed === false &&
    identity.retired === false &&
    identity.rootRetired === false &&
    identity.busy === false
  );
}

function identityEqual(left, right) {
  return (
    left.assetId === right.assetId &&
    left.rootId === right.rootId &&
    left.kind === right.kind &&
    left.online === right.online &&
    left.trashed === right.trashed &&
    left.retired === right.retired &&
    left.rootRetired === right.rootRetired &&
    left.busy === right.busy &&
    left.libraryGeneration === right.libraryGeneration &&
    left.assetGeneration === right.assetGeneration &&
    left.sourceGeneration === right.sourceGeneration &&
    left.contextFingerprint === right.contextFingerprint
  );
}

function commitMatchesIdentity(commit, identity) {
  return (
    commit.root_id === identity.rootId &&
    commit.kind === identity.kind &&
    commit.library_generation === identity.libraryGeneration &&
    commit.asset_generation === identity.assetGeneration &&
    commit.source_generation === identity.sourceGeneration &&
    commit.fingerprint === identity.contextFingerprint &&
    commit.context_json === canonicalContext(identity.context)
  );
}

function recordMatchesIdentity(row, identity) {
  return (
    row.root_id === identity.rootId &&
    row.kind === identity.kind &&
    row.library_generation === identity.libraryGeneration &&
    row.asset_generation === identity.assetGeneration &&
    row.source_generation === identity.sourceGeneration &&
    row.fingerprint === identity.contextFingerprint
  );
}

/** 固定域标签 + 固定字段顺序，避免依赖对象属性插入顺序。 */
function canonicalContext(provenance) {
  return JSON.stringify([
    "shiguang.audio-result-store.context",
    RESULT_SCHEMA_VERSION,
    PROTOCOL,
    provenance.kind,
    provenance.sourceSha256,
    provenance.sourceSize,
    provenance.durationSec,
    provenance.engineVersion,
    provenance.engineBinarySha256,
    provenance.engineGeneration,
    "brief",
    true,
  ]);
}

function fingerprintContext(context) {
  let fingerprint;
  try {
    fingerprint = createAudioResultFingerprint(context);
  } catch {
    throw storeError("INVALID_CONTEXT");
  }
  if (!fingerprint.ok) throw storeError("INVALID_CONTEXT");
  return fingerprint.fingerprint;
}

/* ------------------------------------------------------------------ */
/* generic helpers                                                     */
/* ------------------------------------------------------------------ */

function assertId(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw storeError(code);
}

/**
 * 读取恰好 expected 个自有字符串键的 data descriptor 值。
 * 访问器一律拒绝且不执行 getter；反射 trap 抛错由调用方收敛。
 */
function readOwnDataValues(object, expected) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return null;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(object);
  if (keys.length !== expected.length) return null;
  const values = Object.create(null);
  for (const name of keys) {
    if (typeof name !== "string" || !expected.includes(name)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    values[name] = descriptor.value;
  }
  for (const name of expected) {
    if (!Object.hasOwn(values, name)) return null;
  }
  return values;
}

/** 只读取数组自有的数字索引 data descriptor，不调用迭代器/访问器。 */
function readArrayValues(array, maxLength) {
  if (!Array.isArray(array)) return null;
  const length = array.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) return null;
  const keys = Reflect.ownKeys(array);
  if (keys.length !== length + 1) return null;
  const values = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    values.push(descriptor.value);
  }
  return values;
}

function isThenable(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  let cursor = value;
  for (let depth = 0; depth < 8 && cursor !== null; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, "then");
    if (descriptor !== undefined) {
      // 访问器型 then 也不执行 getter；无法安全判断时按 thenable 拒绝。
      return Object.hasOwn(descriptor, "value")
        ? typeof descriptor.value === "function"
        : true;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return false;
}

const NOOP = () => {};

/**
 * 只消费真正的原生 Promise 拒绝：调用方已用 util.types.isPromise 完成品牌
 * 判定；这里用内置 Promise.prototype.then 挂一个拒绝处理器，不读取/调用
 * 对象自己的 then getter 或自定义 then 方法，不 await，也不安装进程级
 * unhandledRejection 吞错。非原生 thenable 不会走到这里。
 */
function consumeNativeRejection(value) {
  try {
    Promise.prototype.then.call(value, undefined, NOOP);
  } catch {
    // 极端 Promise 子类/被代理对象仍可能拒绝挂载；保持固定错误，不扩散异常。
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * JSON 没有 -0 字面量；用单一固定标记对象编码负零，读出时恢复。
 * 合法结果只有固定字段，标记对象不会与任何允许字段冲突。
 */
const NEGATIVE_ZERO_TAG = "$shiguangNegativeZero";

function encodeJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (Object.is(item, -0)) return { [NEGATIVE_ZERO_TAG]: true };
    return item;
  });
}

function decodeJson(text) {
  return JSON.parse(text, (_key, item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    const keys = Object.keys(item);
    if (keys.length === 1 && keys[0] === NEGATIVE_ZERO_TAG && item[NEGATIVE_ZERO_TAG] === true) {
      return -0;
    }
    return item;
  });
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function storeError(code) {
  return new AudioResultStoreError(code);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const name of Object.keys(value)) deepFreeze(value[name]);
  return Object.freeze(value);
}
