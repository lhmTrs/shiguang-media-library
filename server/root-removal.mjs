import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ordered = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const quote = name => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw Error("存在无法安全处理的数据表，未移除目录");
  return `\`${name}\``;
};

/** Explicit metadata removal only. Never read, rename, trash or unlink original media. */
export class RootRemoval {
  constructor(lib, busy = () => false) { this.lib = lib; this.busy = busy; this.previews = new Map(); this.active = false; }
  idle() {
    if (this.busy() || this.lib.locks.size || this.lib.workers || [...this.lib.jobs.values()].some(j => j.status === "running"))
      throw Error("扫描或素材操作正在进行，请完成后再移除目录");
  }
  snapshot(rootId, lock = false) {
    const db = this.lib.db, suffix = lock && db.kind === "mysql" ? " FOR UPDATE" : "";
    const root = suffix ? db.prepare("SELECT * FROM roots WHERE id=? FOR UPDATE").get(rootId) : this.lib.rootById(rootId);
    if (!root) throw Error("目录已移除，请刷新列表");
    if (!root.retired) throw Error("请先注销该目录，再移除管理记录");
    const assets = ordered(db.prepare("SELECT * FROM assets WHERE root_id=?" + suffix).all(rootId));
    if (assets.some(a => this.lib.locks.has(a.id))) throw Error("素材正在处理，请稍后重试");
    const ids = new Set(assets.map(a => a.id));
    const tables = db.kind === "mysql"
      ? db.prepare("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'").all()
      : db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const related = [];
    for (const { name } of tables.sort((a,b) => a.name.localeCompare(b.name))) {
      if (["roots", "assets"].includes(name)) continue;
      const table = quote(name);
      const columns = db.kind === "mysql"
        ? db.prepare("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?").all(name)
        : db.prepare(`PRAGMA table_info(${table})`).all();
      const names = new Set(columns.map(c => c.name)), terms = [], params = [];
      if (names.has("asset_id")) { terms.push("asset_id IN (SELECT id FROM assets WHERE root_id=?)"); params.push(rootId); }
      if (names.has("root_id")) { terms.push("root_id=?"); params.push(rootId); }
      if (name === "openai_diagnostics") {
        terms.push(`${db.kind === "mysql" ? "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.assetId'))" : "json_extract(payload,'$.assetId')"} IN (SELECT id FROM assets WHERE root_id=?)`);
        params.push(rootId);
      }
      if (!terms.length) continue;
      const where = terms.join(" OR "), rows = ordered(db.prepare(`SELECT * FROM ${table} WHERE ${where}${suffix}`).all(...params));
      if (name === "operations" && rows.some(r => r.status === "pending")) throw Error("素材文件操作尚未完成，不能移除目录");
      related.push({ name, where, params, rows });
    }
    const tableNames = new Set(tables.map(t => t.name));
    const timelines = tableNames.has("project_timelines") ? ordered(db.prepare("SELECT * FROM project_timelines" + suffix).all()) : [];
    const affectedTimelines = timelines.filter(t => JSON.parse(t.snapshot).refs.some(ref => ids.has(ref.assetId)));
    const timelineIds = new Set(affectedTimelines.map(t => t.id));
    const batches = tableNames.has("project_timeline_batches") ? ordered(db.prepare("SELECT * FROM project_timeline_batches" + suffix).all()) : [];
    const affectedBatches = batches.filter(b => {
      if (timelineIds.has(b.timeline_id)) return true;
      const p = JSON.parse(b.payload);
      return p.affected?.some(id => ids.has(id)) || p.beforeProjection?.some(row => ids.has(row.asset_id))
        || p.after?.snapshot?.refs?.some(ref => ids.has(ref.assetId))
        || (p.before?.snapshot && JSON.parse(p.before.snapshot).refs.some(ref => ids.has(ref.assetId)));
    });
    return { root, assets, related, timelines: affectedTimelines, batches: affectedBatches };
  }
  preview(rootId, owner) {
    if (this.active) throw Error("正在移除目录，请稍后重试");
    this.idle();
    const snapshot = this.snapshot(rootId), confirmation = crypto.randomBytes(24).toString("hex");
    for (const [key, p] of this.previews) if (Date.now() - p.createdAt > 600000) this.previews.delete(key);
    if (this.previews.size >= 12) this.previews.delete(this.previews.keys().next().value);
    this.previews.set(confirmation, { rootId, owner, db: this.lib.db, fingerprint: digest(snapshot), createdAt: Date.now() });
    return { confirmation, name: snapshot.root.name, assets: snapshot.assets.length,
      favorites: snapshot.assets.filter(a => a.favorite).length,
      tagged: snapshot.assets.filter(a => JSON.parse(a.tags || "[]").length).length,
      notes: snapshot.assets.filter(a => a.note).length,
      projectLinks: snapshot.related.find(t => t.name === "project_assets")?.rows.length || 0,
      timelines: snapshot.timelines.length, invalidatedImports: snapshot.batches.length };
  }
  async execute(rootId, confirmation, owner) {
    if (this.active) throw Error("正在移除目录，请稍后重试");
    const plan = this.previews.get(confirmation);
    if (!plan || plan.rootId !== rootId || plan.owner !== owner || plan.db !== this.lib.db || Date.now() - plan.createdAt > 600000)
      throw Error("目录移除确认已失效，请重新预览");
    this.previews.delete(confirmation);this.idle();this.active = true;
    try {
      const snapshot = this.snapshot(rootId);
      if (digest(snapshot) !== plan.fingerprint) throw Error("目录或素材记录已变化，请重新预览，不会删除新修改");
      const payload = JSON.stringify({ version: 1, type: "root-metadata-removal", createdAt: new Date().toISOString(), snapshot });
      if (Buffer.byteLength(payload) > 128 * 1024 * 1024) throw Error("目录元数据过大，无法安全备份；管理记录已保留");
      const directory = path.join(this.lib.dataDir, "root-removal-backups");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const backupDirectory = await fs.lstat(directory);
      if (!backupDirectory.isDirectory() || backupDirectory.isSymbolicLink() || (process.platform !== "win32" && (backupDirectory.mode & 0o077)))
        throw Error("备份目录不安全，未移除管理记录");
      const backup = `${Date.now()}-${crypto.randomUUID()}.json`;
      const handle = await fs.open(path.join(directory, backup), "wx", 0o600);
      try { await handle.writeFile(payload);await handle.sync(); } finally { await handle.close(); }
      if (crypto.createHash("sha256").update(await fs.readFile(path.join(directory, backup))).digest("hex") !== crypto.createHash("sha256").update(payload).digest("hex"))
        throw Error("备份校验失败，未移除管理记录");
      this.lib.db.transaction(() => {
        this.idle();
        if (plan.db !== this.lib.db || digest(this.snapshot(rootId, true)) !== plan.fingerprint) throw Error("备份期间记录发生变化，请重新预览");
        const ids = new Set(snapshot.assets.map(a => a.id)), now = Date.now();
        for (const t of snapshot.timelines) {
          const s = JSON.parse(t.snapshot);
          s.refs = s.refs.map(ref => ids.has(ref.assetId) ? { ...ref, assetId: null, used: false } : ref);
          this.lib.db.prepare("UPDATE project_timelines SET snapshot=?,revision=?,head_id=?,updated_at=? WHERE id=?")
            .run(JSON.stringify(s), crypto.randomUUID(), crypto.randomUUID(), now, t.id);
        }
        // Old undo payloads must not restore associations to permanently removed asset IDs.
        for (const b of snapshot.batches) this.lib.db.prepare("UPDATE project_timeline_batches SET status='invalidated' WHERE id=?").run(b.id);
        for (const t of snapshot.related) this.lib.db.prepare(`DELETE FROM ${quote(t.name)} WHERE ${t.where}`).run(...t.params);
        this.lib.db.prepare("DELETE FROM assets WHERE root_id=?").run(rootId);
        this.lib.db.prepare("DELETE FROM roots WHERE id=?").run(rootId);
      })();
      const removed = new Set(snapshot.assets.map(a => a.id));
      this.lib.metadataQueue = this.lib.metadataQueue.filter(id => !removed.has(id));
      for (const id of removed) this.lib.metadataPending.delete(id);
      return { removed: true, id: rootId, removedAssets: removed.size, backup: `root-removal-backups/${backup}` };
    } finally { this.active = false; }
  }
}
