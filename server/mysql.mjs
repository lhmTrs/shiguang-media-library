import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { MysqlDatabase } from "./mysql-db.mjs";
import { observeDatabase } from "./read-cache.mjs";
import { UPLOAD_TABLES, uploadMysqlColumnType, uploadConstraints, uploadOrderBy } from "./cloud-upload-batch-store.mjs";
const TABLES = ["roots", "assets", "operations"];
export function validateConfig(input, previous = {}) {
  const port = Number(input.port ?? 3306);
  if (!["127.0.0.1", "localhost", "::1"].includes(input.host))
    throw Error("只允许连接本机 MySQL");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw Error("MySQL 端口无效");
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(input.database || ""))
    throw Error("数据库名称须以字母开头，只包含字母、数字和下划线");
  if (
    typeof input.user !== "string" ||
    !input.user.trim() ||
    input.user.length > 64
  )
    throw Error("请输入有效的 MySQL 用户名");
  if (input.password !== undefined && typeof input.password !== "string")
    throw Error("密码参数无效");
  const sameUser =
    input.user.trim() === previous.user &&
    input.host === previous.host &&
    port === previous.port;
  return {
    host: input.host,
    port,
    database: input.database,
    user: input.user.trim(),
    password: input.password ?? (sameUser ? previous.password : "") ?? "",
  };
}
export function safeError(e) {
  return (
    {
      ER_ACCESS_DENIED_ERROR: "MySQL 账户或密码错误",
      ER_DBACCESS_DENIED_ERROR: "MySQL 数据库访问权限不足",
      ER_TABLEACCESS_DENIED_ERROR: "MySQL 建表或写入权限不足",
      ECONNREFUSED: "无法连接本机 MySQL，请检查服务和端口",
      ETIMEDOUT: "连接本机 MySQL 超时",
    }[e.code] ||
    (e.localMessage ? e.message : "MySQL 操作失败，请检查连接和数据库权限")
  );
}
function error(message) {
  const e = Error(message);
  e.localMessage = true;
  return e;
}
function checksum(rows, columns) {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify(rows.map((row) => columns.map((c) => row[c] ?? null))),
    )
    .digest("hex");
}
/**
 * SQLite 列 → MySQL 列类型。
 *
 * 关键约束：**会被建索引的列不能落到 LONGTEXT**。以前凡是非 INT/REAL 一律 LONGTEXT，
 * 于是"从 SQLite 迁移过来的库"里 assets.sha256 成了 LONGTEXT，再对它建索引会被 MySQL 以
 * ER_BLOB_KEY_WITHOUT_LENGTH (1170) 拒绝，启动直接失败（已在隔离实例上实测复现）。
 * 所以哈希类列统一 VARCHAR(64)，与 library.mjs 里 ALTER TABLE 的显式类型保持一致。
 * 独立导出是为了能脱离数据库单测这条映射。
 */
export function mysqlColumnType(table, col) {
  if (["asset_metadata_clock", "asset_metadata_fields"].includes(table)) {
    if (col.name === "singleton_id") return "BIGINT PRIMARY KEY";
    if (["asset_id", "domain_id"].includes(col.name)) return "VARCHAR(36)";
    if (["schema_sha256", "db_identity", "value_sha256"].includes(col.name)) return "CHAR(64)";
    if (col.name === "field") return "VARCHAR(24)";
    if (["coverage", "provenance"].includes(col.name)) return "VARCHAR(32)";
    if (["seq", "version", "modified_ms"].includes(col.name)) return "BIGINT";
    throw error("未知字段证据列，未迁移");
  }
  if (table === "asset_repair_journal") {
    if (["operation_id","canonical_asset_id","alias_asset_id","from_root_id","to_root_id"].includes(col.name)) return "VARCHAR(36)" + (col.name === "operation_id" ? " PRIMARY KEY" : "");
    if (["idempotency_key","input_sha256"].includes(col.name)) return "CHAR(64)";
    if (col.name === "phase") return "VARCHAR(24)";
    if (["version","created_ms","updated_ms"].includes(col.name)) return "BIGINT";
    return "LONGTEXT";
  }
  if(Object.hasOwn(UPLOAD_TABLES,table))return uploadMysqlColumnType(table,col);
  if (col.name === "id") return "VARCHAR(36) PRIMARY KEY";
  if (/(sha256|sha1|md5|_hash|hash)$/i.test(String(col.name))) return "VARCHAR(64)";
  if (table === "asset_subcategories" && col.name === "name") return "VARCHAR(120)";
  if (table === "media_projects" && col.name === "name") return "VARCHAR(120)";
  if (table === "project_assets" && ["project_id", "asset_id"].includes(col.name)) return "VARCHAR(36)";
  if (["project_timelines", "project_timeline_batches", "project_manual_assets", "project_renders"].includes(table) && ["project_id", "timeline_id", "asset_id", "revision", "head_id"].includes(col.name)) return "VARCHAR(36)";
  if (table === "music_category_links" || (table === "asset_subcategories" && col.name === "category_id")) return "VARCHAR(36)";
  if (/INT/.test(col.type)) return "BIGINT";
  if (/REAL/.test(col.type)) return "DOUBLE";
  return "LONGTEXT";
}

export class MysqlStorage {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.configPath = path.join(dataDir, "mysql-connection.json");
    this.config = null;
    this.database = null;
    this.lib = null;
    this.migrating = false;
    this.state = {
      status: "disabled",
      lastSync: null,
      counts: null,
      error: "",
    };
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const idFile = path.join(this.dataDir, "mysql-source-id");
    try {
      this.sourceId = (await fs.readFile(idFile, "utf8")).trim();
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.sourceId = crypto.randomUUID();
      await fs.writeFile(idFile, this.sourceId, { mode: 0o600, flag: "wx" });
    }
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(this.configPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT")
        throw error("数据库连接配置损坏，未切换到 SQLite");
      return this;
    }
    this.config = validateConfig(saved, saved);
    try {
      this.database = new MysqlDatabase(this.config);
      const marker = this.database
        .prepare("SELECT source_id FROM shiguang_database_meta WHERE id=1")
        .get();
      if (marker?.source_id !== this.sourceId)
        throw error("MySQL 数据库归属不匹配，未使用该库");
      this.state = {
        status: "ready",
        lastSync: saved.migratedAt,
        counts: saved.counts,
        error: "",
      };
    } catch (e) {
      this.database?.close();
      throw error(safeError(e) + "；未切回 SQLite");
    }
    return this;
  }
  attach(lib) {
    this.lib = lib;
  }
  publicState() {
    const c = this.config || {
      host: "127.0.0.1",
      port: 3306,
      database: "shiguang_media",
      user: "",
    };
    return {
      config: {
        host: c.host,
        port: c.port,
        database: c.database,
        user: c.user,
        hasPassword: !!c.password,
      },
      ...this.state,
      mode: this.database ? "mysql" : "sqlite",
      migrating: this.migrating,
    };
  }
  async connect(c, withDatabase = false) {
    return mysql.createConnection({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      ...(withDatabase ? { database: c.database } : {}),
      charset: "utf8mb4",
      connectTimeout: 5000,
      multipleStatements: false,
    });
  }
  async test(input) {
    let conn;
    try {
      conn = await this.connect(validateConfig(input, this.config || {}));
      await conn.execute("SELECT 1");
      return { connected: true };
    } catch (e) {
      throw error(safeError(e));
    } finally {
      await conn?.end();
    }
  }
  async activate(input) {
    if (this.migrating) throw error("数据库迁移进行中");
    const c = validateConfig(input, this.config || {});
    if (this.database)
      throw error(
        "已使用 MySQL 主数据库；更换数据库需单独迁移，未覆盖现有配置",
      );
    if (
      this.lib.locks.size ||
      [...this.lib.jobs.values()].some((j) => j.status === "running")
    )
      throw error("请等待扫描或文件操作完成后再迁移");
    if (this.lib.db.prepare("SELECT operation_id FROM asset_repair_journal WHERE alias_asset_id IS NOT NULL LIMIT 1").get()) throw error("存在已合并记录，尚未验证其 MySQL 迁移，未切换数据库");
    this.migrating = true;
    this.lib.migrating = true;
    this.state.status = "syncing";
    this.state.error = "";
    let conn, newDb;
    try {
      while (this.lib.workers) await new Promise((r) => setTimeout(r, 50));
      conn = await this.connect(c);
      const backups = path.join(this.dataDir, "backups");
      await fs.mkdir(backups, { recursive: true });
      const backup = path.join(backups, `before-mysql-${Date.now()}.sqlite`);
      await this.lib.db.backup(backup);
      const tables = [...TABLES];
      if (
        this.lib.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='openai_diagnostics'",
          )
          .get()
      )
        tables.push("openai_diagnostics");
      if (
        this.lib.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='app_secrets'",
          )
          .get()
      )
        tables.push("app_secrets");
      if (
        this.lib.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='music_analyses'",
          )
          .get()
      )
        tables.push("music_analyses");
      if (
        this.lib.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='asset_tags'",
          )
          .get()
      )
        tables.push("asset_tags");
      if (
        this.lib.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='music_categories'",
          )
          .get()
      )
        tables.push("music_categories");
      if (
        this.lib.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='music_category_links'",
          )
          .get()
      )
        tables.push("music_category_links");
      for (const table of ["asset_subcategories", "category_hierarchy_meta", "duplicate_audio_reports", "media_projects", "project_assets", "metadata_batches", "project_timelines", "project_timeline_batches", "project_manual_assets", "project_renders", "asset_repair_journal", "asset_metadata_clock", "asset_metadata_fields"])
        if (this.lib.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) tables.push(table);
      for(const table of Object.keys(UPLOAD_TABLES))if(this.lib.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))tables.push(table);
      const snapshot = this.lib.db.transaction(() =>
        Object.fromEntries(
          tables.map((t) => [
            t,
            {
              columns: this.lib.db.prepare(`PRAGMA table_info(${t})`).all(),
              rows: this.lib.db
                .prepare(
                  `SELECT * FROM ${t} ORDER BY ${Object.hasOwn(UPLOAD_TABLES,t)?uploadOrderBy(t):t === "asset_repair_journal" ? "operation_id" : t === "operations" ? "rowid" : "id"}`,
                )
                .all(),
            },
          ]),
        ),
      )();
      await conn.query(
        `CREATE DATABASE IF NOT EXISTS \`${c.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
      );
      await conn.changeUser({ database: c.database });
      const [existing] = await conn.execute(
        "SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?",
        [c.database],
      );
      const names = new Set(existing.map((r) => r.name));
      if (
        !names.has("shiguang_database_meta") &&
        tables.some((t) => names.has(t))
      )
        throw error("目标数据库存在同名表，请选择新的独立数据库");
      await conn.query(
        "CREATE TABLE IF NOT EXISTS shiguang_database_meta (id INT PRIMARY KEY,source_id VARCHAR(36) NOT NULL,schema_version INT NOT NULL) ENGINE=InnoDB",
      );
      await conn.execute(
        "INSERT IGNORE INTO shiguang_database_meta VALUES(1,?,1)",
        [this.sourceId],
      );
      const [marker] = await conn.execute(
        "SELECT * FROM shiguang_database_meta WHERE id=1",
      );
      if (
        marker[0]?.source_id !== this.sourceId ||
        marker[0]?.schema_version !== 1
      )
        throw error("目标数据库属于其他素材库，未覆盖任何数据");
      for (const t of tables) {
        const defs = snapshot[t].columns.map((col) => {
          const type = mysqlColumnType(t, col);
          if(Object.hasOwn(UPLOAD_TABLES,t))return `\`${col.name}\` ${type}${col.notnull?" NOT NULL":" NULL"}${col.dflt_value!==null?" DEFAULT "+col.dflt_value:""}`;
          return `\`${col.name}\` ${type}${col.name === "id" ? "" : col.dflt_value !== null ? " DEFAULT " + (type === "LONGTEXT" ? "(" + col.dflt_value + ")" : col.dflt_value) : " NULL"}`;
        });
        if(Object.hasOwn(UPLOAD_TABLES,t))defs.push(...uploadConstraints(t));
        if (t === "asset_metadata_fields") defs.push("PRIMARY KEY(asset_id,field)");
        // Evidence is retained by migration, but MySQL latest remains unsupported.
        if (t === "operations")
          defs.push("operation_seq BIGINT AUTO_INCREMENT UNIQUE");
        if (t === "asset_subcategories") defs.push("UNIQUE(category_id,name)");
        if (t === "media_projects") defs.push("UNIQUE(name)");
        if (t === "project_manual_assets") defs.push("UNIQUE(project_id,asset_id)");
        if (t === "project_assets") defs.push("UNIQUE(project_id,asset_id)", "INDEX project_assets_asset(asset_id)");
        if (t === "asset_repair_journal") defs.push("UNIQUE(idempotency_key)", "UNIQUE(alias_asset_id)");
        if (t === "music_category_links")
          defs.push(
            "UNIQUE(asset_id,category_id)",
            "INDEX music_link_category(category_id)",
          );
        if (t === "music_analyses")
          defs.push(
            "cache_hash CHAR(64) GENERATED ALWAYS AS (SHA2(cache_key,256)) STORED UNIQUE",
          );
        if (t === "music_categories" || t === "asset_tags")
          defs.push(
            "name_hash CHAR(64) GENERATED ALWAYS AS (SHA2(name,256)) STORED UNIQUE",
          );
        if (t === "assets" || t === "roots")
          defs.push(
            "path_hash CHAR(64) GENERATED ALWAYS AS (SHA2(path,256)) STORED UNIQUE",
          );
        if (t === "assets")
          defs.push(
            "INDEX assets_root (root_id(36))",
            "INDEX assets_created (created_ms)",
            "INDEX assets_captured (captured_ms)",
          );
        await conn.query(
          `CREATE TABLE IF NOT EXISTS ${t} (${defs.join(",")}) ENGINE=InnoDB`,
        );
        const [count] = await conn.query(`SELECT COUNT(*) n FROM ${t}`);
        if (count[0].n)
          throw error("目标数据库已含素材数据，未覆盖；请选择新的数据库");
      }
      await conn.beginTransaction();
      for (const t of tables) {
        const columns = snapshot[t].columns.map((col) => col.name);
        for (let i = 0; i < snapshot[t].rows.length; i += 50) {
          const rows = snapshot[t].rows.slice(i, i + 50);
          await conn.execute(
            `INSERT INTO ${t} (${columns.map((c) => "`" + c + "`").join(",")}) VALUES ${rows.map(() => `(${columns.map(() => "?").join(",")})`).join(",")}`,
            rows.flatMap((row) => columns.map((c) => row[c])),
          );
        }
        const [copied] = await conn.query(
          `SELECT ${columns.map((c) => "`" + c + "`").join(",")} FROM ${t} ORDER BY ${Object.hasOwn(UPLOAD_TABLES,t)?uploadOrderBy(t):"id"}`,
        );
        // Upload snapshots were read using these same typed PKs (including numeric ordinal).
        const source = Object.hasOwn(UPLOAD_TABLES,t) ? snapshot[t].rows : [...snapshot[t].rows].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        );
        if (checksum(copied, columns) !== checksum(source, columns))
          throw error("迁移校验未通过，未切换数据库");
      }
      await conn.commit();
      newDb = new MysqlDatabase(c);
      const counts = Object.fromEntries(
        tables.map((t) => [t, snapshot[t].rows.length]),
      );
      const migratedAt = new Date().toISOString();
      const temp = this.configPath + ".tmp";
      await fs.writeFile(
        temp,
        JSON.stringify({ ...c, backup, counts, migratedAt }),
        { mode: 0o600 },
      );
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.configPath);
      const old = this.lib.db;
      this.lib.db = newDb;
      observeDatabase(newDb);
      this.database = newDb;
      newDb = null;
      this.config = c;
      old.close();
      this.state = { status: "ready", lastSync: migratedAt, counts, error: "" };
      return this.publicState();
    } catch (e) {
      await conn?.rollback().catch(() => {});
      newDb?.close();
      this.state.status = "error";
      this.state.error = safeError(e);
      throw error(this.state.error);
    } finally {
      await conn?.end();
      this.migrating = false;
      this.lib.migrating = false;
      this.lib.pump();
    }
  }
}
