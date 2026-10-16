import fs from "node:fs/promises";
import { constants } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

// Keep the wrapping key separate from database backups. Never expose decrypted values in public state.
export class SecretStore {
  constructor(lib) {
    this.lib = lib;
    this.masterPath = path.join(lib.dataDir, "secrets-master.key");
    this.master = null;
  }
  ensureTable() {
    if (this.database === this.lib.db) return;
    this.lib.db.exec(
      this.lib.db.kind === "mysql"
        ? "CREATE TABLE IF NOT EXISTS app_secrets (id VARCHAR(36) PRIMARY KEY,encrypted LONGTEXT NOT NULL,updated_ms DOUBLE) ENGINE=InnoDB"
        : "CREATE TABLE IF NOT EXISTS app_secrets (id TEXT PRIMARY KEY,encrypted TEXT NOT NULL,updated_ms REAL)",
    );
    this.database = this.lib.db;
  }
  async readMaster() {
    let handle;
    try {
      handle = await fs.open(
        this.masterPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== 32) throw Error("invalid key");
      await handle.chmod(0o600);
      this.master = await handle.readFile();
      if (this.master.length !== 32) throw Error("invalid key");
    } finally {
      await handle?.close();
    }
  }
  async init() {
    this.ensureTable();
    try {
      await this.readMaster();
    } catch (e) {
      if (
        e.code !== "ENOENT" ||
        this.lib.db.prepare("SELECT id FROM app_secrets LIMIT 1").get()
      )
        throw Error(
          "本机解密密钥缺失或损坏，数据库密文已保留，请恢复密钥文件或移除后重新配置",
        );
    }
    return this;
  }
  async prepareMaster() {
    if (this.master) return;
    this.ensureTable();
    if (this.lib.db.prepare("SELECT id FROM app_secrets LIMIT 1").get())
      throw Error("本机解密密钥缺失，未覆盖已保存的密文");
    let handle;
    try {
      handle = await fs.open(
        this.masterPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      await handle.writeFile(crypto.randomBytes(32));
      await handle.sync();
    } catch (e) {
      if (e.code !== "EEXIST") throw Error("本机解密密钥创建失败");
    } finally {
      await handle?.close();
    }
    try {
      await this.readMaster();
    } catch {
      throw Error("本机解密密钥读取失败，未保存 API Key");
    }
  }
  get(id) {
    this.ensureTable();
    const row = this.lib.db
      .prepare("SELECT encrypted FROM app_secrets WHERE id=?")
      .get(id);
    if (!row) return null;
    try {
      if (!this.master) throw Error("missing key");
      const { version, iv, tag, data } = JSON.parse(row.encrypted);
      if (version !== 1) throw Error("unsupported version");
      const nonce = Buffer.from(iv, "base64"),
        authTag = Buffer.from(tag, "base64");
      if (nonce.length !== 12 || authTag.length !== 16)
        throw Error("invalid envelope");
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        this.master,
        nonce,
      );
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(Buffer.from(data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw Error("保存的密钥无法解密，密文未改动，请检查本机解密密钥");
    }
  }
  async set(id, value) {
    await this.prepareMaster();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.master, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const encrypted = JSON.stringify({
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    });
    this.lib.db.transaction(() => {
      this.lib.db.prepare("DELETE FROM app_secrets WHERE id=?").run(id);
      this.lib.db
        .prepare(
          "INSERT INTO app_secrets(id,encrypted,updated_ms) VALUES(?,?,?)",
        )
        .run(id, encrypted, Date.now());
      if (this.get(id) !== value) throw Error("密钥保存校验失败");
    })();
  }
  remove(id) {
    this.ensureTable();
    this.lib.db.prepare("DELETE FROM app_secrets WHERE id=?").run(id);
  }
}
