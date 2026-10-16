import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const FILE_STATUS_TTL = 10 * 60 * 1000;
const within = (root, p) => p === root || p.startsWith(root + path.sep);
export class MissingFiles {
  constructor(lib, busy = () => false) {
    this.lib = lib;
    this.busy = busy;
    this.active = null;
    lib.fileChecker = this;
  }
  async rootHealth(root) {
    const real = await fs.realpath(root.path);
    if (real !== root.path) throw Error("登记目录位置已变化");
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw Error("素材目录不可用");
    await fs.access(real, constants.R_OK | constants.X_OK);
    const handle = await fs.opendir(real); await handle.close();
    if (within("/Volumes", real) && stat.dev === (await fs.stat("/Volumes")).dev) throw Error("外接硬盘未挂载");
    return `${stat.dev}:${stat.ino}`;
  }
  async missing(asset, root) {
    if (!within(root.path, asset.path) || asset.path === root.path) throw Error("路径不在登记目录中");
    try { await fs.lstat(asset.path); return false; }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    let parent = path.dirname(asset.path);
    while (within(root.path, parent)) {
      try {
        const real = await fs.realpath(parent);
        if (!within(root.path, real) || !(await fs.stat(real)).isDirectory()) throw Error("上级目录不可用");
        await fs.access(real, constants.R_OK | constants.X_OK);
        const dir = await fs.opendir(real); await dir.close();
        return true;
      } catch (e) {
        if (e.code !== "ENOENT" || parent === root.path) throw e;
        const entry = await fs.lstat(parent).catch(err => { if (err.code !== "ENOENT") throw err; return null; });
        if (entry?.isSymbolicLink()) throw Error("上级链接暂不可用");
        parent = path.dirname(parent);
      }
    }
    throw Error("无法确认文件状态");
  }
  record(asset, status, reason, identity = "") {
    this.lib.db.prepare("UPDATE assets SET file_status=?,file_checked_ms=?,file_check_path=?,file_root_identity=?,file_check_reason=?,online=? WHERE id=? AND path=? AND trashed=0")
      .run(status, Date.now(), asset.path, identity, reason, status === "online" ? 1 : 0, asset.id, asset.path);
    return { status, reason, identity };
  }
  async inspect(asset, root, identity) {
    try {
      if (await this.missing(asset, root)) {
        if (identity !== await this.rootHealth(root)) return this.record(asset, "offline", "素材目录状态发生变化");
        return this.record(asset, "missing", "原路径不存在，等待人工确认清理", identity);
      }
      const real = await fs.realpath(asset.path);
      if (!within(root.path, real) || !(await fs.stat(real)).isFile()) throw Error("不是登记目录内的普通文件");
      await fs.access(real, constants.R_OK);
      return this.record(asset, "online", "文件存在", identity);
    } catch {
      return this.record(asset, "unavailable", "文件无权限、链接失效或暂时无法访问", identity);
    }
  }
  async verify(asset) {
    const root = this.lib.roots().find(r => r.id === asset.root_id);
    if (!root) return this.record(asset, "offline", "素材目录未登记");
    let identity;
    try { identity = await this.rootHealth(root); }
    catch { return this.record(asset, "offline", "素材目录离线、未挂载或无权限"); }
    return this.inspect(asset, root, identity);
  }
  check({ force = false, dryRun = false } = {}) {
    if (this.active) return this.active;
    if (this.busy()) return Promise.resolve({ checked: 0, removed: 0, deferred: true });
    this.active = this.work({ force, dryRun }).finally(() => { this.active = null; });
    return this.active;
  }
  cleanupPreview(ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== "string")) throw Error("每次请选择 1–200 条失效记录");
    return [...new Set(ids)].map(id => {
      const a = this.lib.asset(id);
      if (a.trashed || a.file_status !== "missing") throw Error("所选记录状态已变化，请刷新后重新选择");
      return { id: a.id, name: a.name, path: a.path, reason: a.file_check_reason, checkedMs: a.file_checked_ms };
    });
  }
  clean(items) {
    if (this.active || this.busy()) throw Error("检查、扫描或素材操作正在进行，请稍后清理");
    const ids = new Set(items.map(a => a.id));
    this.active = this.work({ force: true, cleanup: new Map(items.map(a => [a.id, a.path])) })
      .then(result => {
        result.skipped = [...ids].filter(id => !result.removedIds.includes(id)).map(id => {
          let a; try { a = this.lib.asset(id); } catch {}
          return { id, name: a?.name || id, reason: a?.file_check_reason || "记录已变化或有操作正在进行，已保留" };
        });
        return result;
      }).finally(() => { this.active = null; });
    return this.active;
  }
  async work({ force, dryRun = false, cleanup = null }) {
    const lib = this.lib;
    const job = { id: crypto.randomUUID(), type: "cleanup", label: cleanup ? "人工清理失效记录" : "检查文件状态", status: "running", count: 0, errors: [], startedAt: Date.now() };
    lib.jobs.set(job.id, job);
    const result = { checked: 0, cached: 0, missing: 0, removed: 0, removedIds: [], offline: 0, protected: 0 };
    let backup;
    try {
      const names = lib.db.kind === "mysql"
        ? lib.db.prepare("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()").all()
        : lib.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const tables = new Set(names.map(t => t.name));
      const related = ["music_category_links", "music_analyses", "operations"].filter(t => tables.has(t));
      for (const root of lib.roots()) {
        if (this.busy()) break;
        const assets = lib.db.prepare("SELECT * FROM assets WHERE root_id=? AND trashed=0").all(root.id).filter(a => !cleanup || cleanup.has(a.id));
        if (!assets.length) continue;
        let identity;
        try { identity = await this.rootHealth(root); }
        catch {
          if (!dryRun) {
            lib.db.prepare("UPDATE roots SET online=0 WHERE id=?").run(root.id);
            const selected = cleanup ? ` AND id IN (${assets.map(() => "?").join(",")})` : "";
            lib.db.prepare("UPDATE assets SET file_status='offline',file_checked_ms=?,file_check_path=path,file_root_identity='',file_check_reason=?,online=0 WHERE root_id=? AND trashed=0" + selected)
              .run(Date.now(), "素材目录离线、未挂载或无权限", root.id, ...(cleanup ? assets.map(a => a.id) : []));
          }
          result.offline += assets.length;
          continue;
        }
        for (const snapshot of assets) {
          if (this.busy()) break;
          job.count++;
          if (cleanup && (snapshot.path !== cleanup.get(snapshot.id) || snapshot.file_status !== "missing")) continue;
          if (!force && !cleanup && snapshot.file_check_path === snapshot.path && snapshot.file_root_identity === identity && snapshot.file_checked_ms > Date.now() - FILE_STATUS_TTL) {
            result.cached++; continue;
          }
          result.checked++;
          if (dryRun) { if (await this.missing(snapshot, root).catch(() => false)) result.missing++; continue; }
          const state = await this.inspect(snapshot, root, identity);
          if (state.status === "missing") result.missing++;
          if (!cleanup || state.status !== "missing" || this.busy()) continue;
          try {
            const asset = lib.db.prepare("SELECT * FROM assets WHERE id=? AND path=? AND trashed=0").get(snapshot.id, snapshot.path);
            if (!asset || lib.locks.has(asset.id) || lib.db.prepare("SELECT id FROM operations WHERE asset_id=? AND status='pending'").get(asset.id)) continue;
            const records = {};
            for (const table of related) records[table] = lib.db.prepare(`SELECT * FROM ${table} WHERE asset_id=?`).all(asset.id);
            const diagnosticWhere = lib.db.kind === "mysql" ? "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.assetId'))=?" : "json_extract(payload,'$.assetId')=?";
            if (tables.has("openai_diagnostics")) records.openai_diagnostics = lib.db.prepare(`SELECT * FROM openai_diagnostics WHERE ${diagnosticWhere}`).all(asset.id);
            if (!backup) {
              const dir = path.join(lib.dataDir, "missing-file-backups");
              await fs.mkdir(dir, { recursive: true, mode: 0o700 });
              backup = await fs.open(path.join(dir, `${Date.now()}-${job.id}.jsonl`), "wx", 0o600);
            }
            await backup.writeFile(JSON.stringify({ removedAt: new Date().toISOString(), asset, related: records }) + "\n"); await backup.sync();
            if (this.busy() || identity !== await this.rootHealth(root) || !await this.missing(snapshot, root)) { await this.verify(asset); continue; }
            lib.db.transaction(() => {
              const fresh = lib.db.prepare("SELECT * FROM assets WHERE id=?").get(asset.id);
              if (!fresh || JSON.stringify(fresh) !== JSON.stringify(asset) || lib.locks.has(asset.id)) return;
              for (const table of related) lib.db.prepare(`DELETE FROM ${table} WHERE asset_id=?`).run(asset.id);
              if (tables.has("openai_diagnostics")) lib.db.prepare(`DELETE FROM openai_diagnostics WHERE ${diagnosticWhere}`).run(asset.id);
              lib.db.prepare("DELETE FROM assets WHERE id=?").run(asset.id);
              result.removed++; result.removedIds.push(asset.id);
            })();
            if (result.removedIds.includes(asset.id)) for (const suffix of ["png", "jpg", "m4a", "mp4"]) {
              const key = crypto.createHash("sha256").update(`${asset.id}:${asset.size}:${asset.mtime}:${suffix}`).digest("hex");
              await fs.unlink(path.join(lib.cache, `${key}.${suffix}`)).catch(() => {});
            }
          } catch { result.protected++; }
        }
        if (!dryRun) {
          try { if (identity === await this.rootHealth(root)) lib.db.prepare("UPDATE roots SET online=1 WHERE id=?").run(root.id); }
          catch { lib.db.prepare("UPDATE roots SET online=0 WHERE id=?").run(root.id); }
        }
      }
      job.status = "done"; return result;
    } catch (e) { job.status = "failed"; job.errors.push("文件状态检查未完成，未验证的数据已保留"); throw e; }
    finally { await backup?.close(); job.finishedAt = Date.now(); job.removed = result.removed; }
  }
}
