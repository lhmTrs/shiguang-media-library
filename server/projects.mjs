import crypto from "node:crypto";

export class Projects {
  constructor(lib) { this.lib = lib; }
  init() {
    const mysql = this.lib.db.kind === "mysql";
    const definitions = mysql
      ? ["CREATE TABLE IF NOT EXISTS media_projects (id VARCHAR(36) PRIMARY KEY,name VARCHAR(120) NOT NULL UNIQUE,software VARCHAR(32) NOT NULL,note TEXT NOT NULL,created_at DOUBLE NOT NULL,updated_at DOUBLE NOT NULL) ENGINE=InnoDB",
         "CREATE TABLE IF NOT EXISTS project_assets (id VARCHAR(36) PRIMARY KEY,project_id VARCHAR(36) NOT NULL,asset_id VARCHAR(36) NOT NULL,status VARCHAR(16) NOT NULL,note TEXT NOT NULL,source VARCHAR(32) NOT NULL,added_at DOUBLE NOT NULL,used_at DOUBLE,updated_at DOUBLE NOT NULL,snapshot LONGTEXT NOT NULL,UNIQUE(project_id,asset_id),INDEX project_assets_asset(asset_id)) ENGINE=InnoDB"]
      : ["CREATE TABLE IF NOT EXISTS media_projects (id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,software TEXT NOT NULL,note TEXT NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL)",
         "CREATE TABLE IF NOT EXISTS project_assets (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,asset_id TEXT NOT NULL,status TEXT NOT NULL,note TEXT NOT NULL,source TEXT NOT NULL,added_at REAL NOT NULL,used_at REAL,updated_at REAL NOT NULL,snapshot TEXT NOT NULL,UNIQUE(project_id,asset_id))",
         "CREATE INDEX IF NOT EXISTS project_assets_asset ON project_assets(asset_id)"];
    for (const sql of definitions) this.lib.db.exec(sql);
    return this;
  }
  text(value, max, label, required = false) {
    if (typeof value !== "string" || value.trim().length > max || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw Error(`${label}格式不正确，最多 ${max} 字`);
    return value.trim();
  }
  get(id) {
    const p = this.lib.db.prepare("SELECT * FROM media_projects WHERE id=?").get(id);
    if (!p) throw Error("项目不存在或已删除");
    return p;
  }
  list() {
    return this.lib.db.prepare(`SELECT p.*,COUNT(a.id) total,
      SUM(CASE WHEN a.status='candidate' THEN 1 ELSE 0 END) candidates,
      SUM(CASE WHEN a.status='used' THEN 1 ELSE 0 END) used
      FROM media_projects p LEFT JOIN project_assets a ON a.project_id=p.id
      GROUP BY p.id ORDER BY p.updated_at DESC,p.id`).all().map(p => ({ ...p, candidates: Number(p.candidates), used: Number(p.used), total: Number(p.total) }));
  }
  save(id, input) {
    if (id) this.get(id);
    const name = this.text(input.name, 120, "项目名称", true), note = this.text(input.note ?? "", 2000, "项目备注");
    const software = input.software ?? "";
    if (!["", "jianying", "resolve", "other"].includes(software)) throw Error("请选择有效的剪辑软件");
    const existing = this.lib.db.prepare("SELECT id FROM media_projects WHERE name=?").get(name);
    if (existing && existing.id !== id) throw Error("项目名称已存在");
    const now = Date.now();
    if (id) this.lib.db.prepare("UPDATE media_projects SET name=?,software=?,note=?,updated_at=? WHERE id=?").run(name, software, note, now, id);
    else {
      id = crypto.randomUUID();
      this.lib.db.prepare("INSERT INTO media_projects(id,name,software,note,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(id, name, software, note, now, now);
    }
    return this.get(id);
  }
  remove(id) {
    this.get(id);
    this.lib.db.transaction(() => {
      this.lib.db.prepare("DELETE FROM project_assets WHERE project_id=?").run(id);
      this.lib.db.prepare("DELETE FROM media_projects WHERE id=?").run(id);
    })();
    return { removed: true };
  }
  ids(value) {
    if (!Array.isArray(value) || !value.length || value.length > 200 || value.some(id => typeof id !== "string" || !id || id.length > 36)) throw Error("请选择 1–200 个素材");
    return [...new Set(value)];
  }
  add(projectId, input) {
    this.get(projectId);
    const assets = this.ids(input.ids).map(id => this.lib.asset(id));
    if (assets.some(a => a.trashed)) throw Error("不能添加已移入废纸篓的素材");
    let added = 0;
    this.lib.db.transaction(() => {
      const now = Date.now();
      for (const a of assets) {
        if (this.lib.db.prepare("SELECT id FROM project_assets WHERE project_id=? AND asset_id=?").get(projectId, a.id)) continue;
        this.lib.db.prepare("INSERT INTO project_assets(id,project_id,asset_id,status,note,source,added_at,used_at,updated_at,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(crypto.randomUUID(), projectId, a.id, "candidate", "", "manual", now, null, now, JSON.stringify(a));
        added++;
      }
      if (added) this.lib.db.prepare("UPDATE media_projects SET updated_at=? WHERE id=?").run(now, projectId);
    })();
    return { added, alreadyAdded: assets.length - added };
  }
  change(projectId, input) {
    this.get(projectId);
    const ids = this.ids(input.ids);
    if (!Object.hasOwn(input, "status") && !Object.hasOwn(input, "note")) throw Error("请选择使用状态或填写备注");
    if (Object.hasOwn(input, "status") && !["candidate", "used"].includes(input.status)) throw Error("使用状态不正确");
    const note = Object.hasOwn(input, "note") ? this.text(input.note, 2000, "使用位置备注") : null;
    this.lib.db.transaction(() => {
      const rows = ids.map(id => this.lib.db.prepare("SELECT * FROM project_assets WHERE project_id=? AND asset_id=?").get(projectId, id));
      if (rows.some(r => !r)) throw Error("所选素材不在此项目，请刷新重试");
      const now = Date.now();
      for (const row of rows) {
        const status = input.status ?? row.status;
        this.lib.db.prepare("UPDATE project_assets SET status=?,note=?,used_at=?,updated_at=? WHERE id=?")
          .run(status, note ?? row.note, status === "used" ? row.used_at ?? now : row.used_at, now, row.id);
      }
      this.lib.db.prepare("UPDATE media_projects SET updated_at=? WHERE id=?").run(now, projectId);
    })();
    return { updated: ids.length };
  }
  removeItems(projectId, input) {
    this.get(projectId);
    const ids = this.ids(input.ids);
    this.lib.db.transaction(() => {
      for (const id of ids) this.lib.db.prepare("DELETE FROM project_assets WHERE project_id=? AND asset_id=?").run(projectId, id);
      this.lib.db.prepare("UPDATE media_projects SET updated_at=? WHERE id=?").run(Date.now(), projectId);
    })();
    return { removed: ids.length };
  }
  members(projectId) {
    this.get(projectId);
    return this.lib.db.prepare("SELECT asset_id,status FROM project_assets WHERE project_id=?").all(projectId);
  }
  history(assetId) {
    return this.lib.db.prepare(`SELECT a.*,p.name project_name,p.software FROM project_assets a
      JOIN media_projects p ON p.id=a.project_id WHERE a.asset_id=? ORDER BY a.updated_at DESC,a.id`).all(assetId).map(({ snapshot, ...row }) => row);
  }
  items(projectId, query = {}) {
    this.get(projectId);
    if (query.status && !["candidate", "used"].includes(query.status)) throw Error("使用状态不正确");
    if (query.kind && !["music", "sfx", "photo", "video"].includes(query.kind)) throw Error("素材类型不正确");
    const q = String(query.q || "").trim().toLocaleLowerCase();
    const page = Math.max(1, Math.min(100000, Number(query.page) || 1));
    const rows = this.lib.db.prepare("SELECT p.*,a.name live_name,a.path live_path,a.kind live_kind FROM project_assets p LEFT JOIN assets a ON a.id=p.asset_id WHERE p.project_id=? ORDER BY p.added_at DESC,p.id").all(projectId);
    const base = rows.filter(r => !query.status || r.status === query.status).filter(r => {
      if (!q) return true;
      const snapshot = JSON.parse(r.snapshot);
      return [r.live_name ?? snapshot.name, r.live_path ?? snapshot.path, r.note].some(s => String(s).toLocaleLowerCase().includes(q));
    });
    const kinds = { all: base.length, music: 0, sfx: 0, photo: 0, video: 0 };
    const kindOf = row => row.live_kind ?? JSON.parse(row.snapshot).kind;
    for (const row of base) { const kind = kindOf(row); if (Object.hasOwn(kinds, kind) && kind !== "all") kinds[kind]++; }
    const matching = base.filter(row => !query.kind || kindOf(row) === query.kind);
    // Keep a snapshot if the original index is cleaned; project history must survive.
    const activeRoots = new Set(this.lib.roots().map(r => r.id));
    const items = matching.slice((page - 1) * 60, page * 60).map(({ snapshot, live_name, live_path, live_kind, ...row }) => {
      let asset;
      try { asset = this.lib.asset(row.asset_id); }
      catch (e) { if (e.message !== "素材不存在") throw e; asset = { ...JSON.parse(snapshot), online: 0 }; }
      const retired = !activeRoots.has(asset.root_id);
      const unavailable = retired || !asset.online || !!asset.trashed || asset.file_status === "missing";
      return { ...row, asset: { ...asset, online: unavailable ? 0 : 1 }, unavailable };
    });
    return { items, total: matching.length, pages: Math.ceil(matching.length / 60), kinds };
  }
}
