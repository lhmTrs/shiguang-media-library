import { metadataTransaction } from "./asset-metadata-versions.mjs";
import path from "node:path";

export const PENDING_DIRECTORY = "\u0000pending";
export const PENDING_NAMES = new Set(["待确认", "待试听确认"]);
export function directoryClass(root, filename) {
  const relative = path.relative(root.path, filename);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) return null;
  const dirs = relative.split(path.sep).slice(0, -1);
  const review = !dirs.length || PENDING_NAMES.has(dirs[0]);
  return { category: review ? "待确认" : dirs[0], sub: review ? "" : dirs[1] || "", review: review ? 1 : 0 };
}
export const classId = (root, category, sub = "") => JSON.stringify([root, category, sub]);

export class DirectoryClassification {
  constructor(lib) { this.lib = lib; }
  changes(rootId, assetId) {
    const roots = new Map(this.lib.allRoots().map(r => [r.id, r]));
    const rows = this.lib.db.prepare("SELECT id,root_id,path,category,sub,review,confirmed FROM assets WHERE trashed=0" + (assetId ? " AND id=?" : rootId ? " AND root_id=?" : "")).all(...(assetId ? [assetId] : rootId ? [rootId] : []));
    const changes = [];
    for (const row of rows) {
      const root = roots.get(row.root_id), next = root && directoryClass(root, row.path);
      if (!next) continue;
      const confirmed = next.review ? 0 : row.confirmed;
      if (row.category !== next.category || row.sub !== next.sub || Number(row.review) !== next.review || row.confirmed !== confirmed)
        changes.push({ row, next, confirmed });
    }
    return changes;
  }
  sync(rootId, assetId, changes = this.changes(rootId, assetId)) {
    if (!changes.length) return;
    const update = this.lib.db.prepare("UPDATE assets SET category=?,sub=?,review=?,confirmed=? WHERE id=?");
    metadataTransaction(this.lib, () => {
      for (const { row, next } of changes) {
        const current = this.lib.db.prepare("SELECT confirmed FROM assets WHERE id=?").get(row.id);
        if (current) update.run(next.category, next.sub, next.review, next.review ? 0 : current.confirmed, row.id);
      }
    });
  }
  filter(value) {
    let parts;
    try { parts = JSON.parse(value); } catch { throw Error("请选择现有目录分类"); }
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(p => typeof p !== "string")) throw Error("目录分类无效");
    const [root, category, sub] = parts;
    if (!this.lib.allRoots().some(r => r.id === root)) throw Error("分类所属目录未登记");
    if (!category || category.includes("/") || category.includes("\\") || sub.includes("/") || sub.includes("\\")) throw Error("目录分类无效");
    const collation = this.lib.db.kind === "mysql" ? " COLLATE utf8mb4_bin" : "";
    return { sql: `root_id=? AND category${collation}=?` + (sub ? ` AND sub${collation}=?` : ""), values: sub ? [root, category, sub] : [root, category] };
  }
  options(query = {}) {
    const { where, values } = this.lib.assetFilter(query, true);
    const category = this.lib.db.kind === "mysql" ? "category COLLATE utf8mb4_bin" : "category";
    const sub = this.lib.db.kind === "mysql" ? "sub COLLATE utf8mb4_bin" : "sub";
    const rows = this.lib.db.prepare(`SELECT root_id,${category} AS category,${sub} AS sub,COUNT(*) n,SUM(CASE WHEN online=0 THEN 1 ELSE 0 END) offline FROM assets WHERE ${where} GROUP BY root_id,${category},${sub}`).all(...values);
    const roots = new Map(this.lib.roots().map(r => [r.id, r])), groups = new Map();
    for (const row of rows) {
      const root = roots.get(row.root_id);
      if (!root || !row.category) continue;
      for (const sub of row.sub ? ["", row.sub] : [""]) {
        const id = classId(row.root_id, row.category, sub);
        const entry = groups.get(id) || { id, name: sub || row.category, category: row.category, sub, rootId: root.id, rootName: root.name, rootPath: root.path, n: 0, offline: 0 };
        entry.n += Number(row.n); entry.offline += Number(row.offline || 0); groups.set(id, entry);
      }
    }
    return [...groups.values()].sort((a, b) => (a.category + "/" + a.sub).localeCompare(b.category + "/" + b.sub, "zh-CN"));
  }
  list(query = {}) { return this.options(query); }
  subcategories(id) { const [root, category] = JSON.parse(id); return this.options().filter(c => c.rootId === root && c.category === category && c.sub); }
  members(id) {
    const a = this.lib.asset(id);
    return this.options().filter(c => c.rootId === a.root_id && c.category === a.category && (!c.sub || c.sub === a.sub));
  }
}
