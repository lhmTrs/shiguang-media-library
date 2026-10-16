import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

const stamp = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
export class DuplicateAudio {
  constructor(lib, busy = () => false) { this.lib = lib; this.busy = busy; this.active = null; this.marking = false; this.init(); }
  init() {
    this.lib.db.exec(this.lib.db.kind === "mysql"
      ? "CREATE TABLE IF NOT EXISTS duplicate_audio_reports (id VARCHAR(36) PRIMARY KEY,payload LONGTEXT NOT NULL) ENGINE=InnoDB"
      : "CREATE TABLE IF NOT EXISTS duplicate_audio_reports (id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  }
  scope(value = "sfx") { if (!["sfx", "music", "all"].includes(value)) throw Error("请选择音效、音乐或全部音频"); return value; }
  read(scope) { const row = this.lib.db.prepare("SELECT payload FROM duplicate_audio_reports WHERE id=?").get(this.scope(scope)); return row ? JSON.parse(row.payload) : null; }
  state(scope) {
    scope = this.scope(scope);
    const report = this.read(scope);
    if (report) {
      delete report.fingerprints;
      const ids = [...new Set(report.groups.flatMap(g => g.files.map(f => f.id)))], current = new Map();
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        const rows = this.lib.db.prepare(`SELECT id,path,name,category,sub,tags,reveal_count,online,kind,ext FROM assets WHERE trashed=0 AND id IN (${batch.map(() => "?").join(",")})`).all(...batch);
        for (const row of rows) current.set(row.id, { ...row, tags: JSON.parse(row.tags) });
      }
      report.groups = report.groups.map(group => {
        const files = group.files.filter(f => { const row = current.get(f.id); return row && row.path === f.path && (scope === "all" ? ["sfx", "music"].includes(row.kind) : row.kind === scope); })
          .map(file => { const { signature, ...visible } = file; return { ...visible, ...current.get(file.id) }; });
        return { ...group, files, extraBytes: group.size * (files.length - 1) };
      }).filter(group => group.files.length > 1);
      report.duplicateFiles = report.groups.reduce((n, g) => n + g.files.length, 0);
      report.extraCopies = report.groups.reduce((n, g) => n + g.files.length - 1, 0);
      report.extraBytes = report.groups.reduce((n, g) => n + g.extraBytes, 0);
    }
    return { active: this.active ? { ...this.active, errors: undefined } : null, lastJob: this.lastJob || null, marking: this.marking, report };
  }
  async inspect(asset) {
    const root = this.lib.roots().find(r => r.id === asset.root_id);
    if (!root) throw Error("素材目录未登记");
    const rootIdentity = await this.lib.fileChecker.rootHealth(root);
    const real = await this.lib.checked(asset.path, asset.root_id);
    const stat = await fs.stat(real);
    if (!stat.isFile() || !stat.size) throw Error("不是有效的非空文件");
    return { real, size: stat.size, signature: `${rootIdentity}:${real}:${stamp(stat)}` };
  }
  start(input = {}) {
    const scope = this.scope(input.scope);
    if (this.active || this.marking || this.busy()) throw Error("其他素材任务正在进行，请稍后检查");
    const job = { id: crypto.randomUUID(), type: "duplicates", scope, label: "检查重复音频", status: "running", phase: "stat", count: 0, total: 0, hashed: 0, cached: 0, startedAt: Date.now(), errors: [] };
    this.active = job; this.lib.jobs.set(job.id, job);
    setImmediate(() => { void this.work(job, input.force === true); });
    return { id: job.id };
  }
  cancel() { if (this.active) this.active.cancelled = true; return { ok: true }; }
  guard(job) { if (job.cancelled) throw Error("检查已取消"); if (this.busy()) throw Error("素材状态正在变化，本次检查已停止，请稍后重试"); }
  async work(job, force) {
    try {
      const old = this.read(job.scope), fingerprints = {}, skipped = [], sizes = new Map(), hashes = new Map();
      const assets = this.lib.db.prepare("SELECT * FROM assets WHERE trashed=0 AND " + (job.scope === "all" ? "kind IN ('sfx','music')" : "kind=?")).all(...(job.scope === "all" ? [] : [job.scope]));
      job.total = assets.length;
      for (const asset of assets) {
        this.guard(job);
        try { const info = await this.inspect(asset); if (!sizes.has(info.size)) sizes.set(info.size, []); sizes.get(info.size).push({ asset, info }); }
        catch (e) { skipped.push({ id: asset.id, name: asset.name, path: asset.path, reason: e.code || e.message }); }
        job.count++;
      }
      job.phase = "hash"; job.count = 0; job.total = [...sizes.values()].filter(g => g.length > 1).reduce((n, g) => n + g.length, 0);
      for (const entries of sizes.values()) {
        if (entries.length < 2) continue;
        for (const { asset, info } of entries) {
          this.guard(job);
          try {
            let digest;
            const cached = old?.fingerprints?.[asset.id];
            if (!force && cached?.signature === info.signature) { digest = cached.digest; job.cached++; }
            else {
              const handle = await fs.open(info.real, "r");
              try {
                if (!info.signature.endsWith(":" + stamp(await handle.stat()))) throw Error("文件已变化，未读取");
                const hash = crypto.createHash("sha256");
                for await (const chunk of handle.createReadStream({ autoClose: false })) { this.guard(job); hash.update(chunk); }
                if (!info.signature.endsWith(":" + stamp(await handle.stat()))) throw Error("读取期间文件已变化");
                digest = hash.digest("hex");
              } finally { await handle.close(); }
              job.hashed++;
            }
            if ((await this.inspect(asset)).signature !== info.signature) throw Error("文件在检查期间发生变化，已跳过");
            const fresh = this.lib.asset(asset.id);
            if (fresh.trashed || fresh.path !== asset.path || fresh.kind !== asset.kind) throw Error("素材记录发生变化，已跳过");
            fingerprints[asset.id] = { signature: info.signature, digest };
            if (!hashes.has(digest)) hashes.set(digest, []);
            hashes.get(digest).push({ ...fresh, actualSize: info.size, signature: info.signature });
          } catch (e) { if (job.cancelled || this.busy()) throw e; skipped.push({ id: asset.id, name: asset.name, path: asset.path, reason: e.code || e.message }); }
          job.count++;
        }
      }
      this.guard(job);
      const groups = [...hashes.entries()].filter(([, files]) => files.length > 1).map(([sha256, files]) => ({ sha256, files, size: files[0].actualSize, extraBytes: files[0].actualSize * (files.length - 1) })).sort((a, b) => b.extraBytes - a.extraBytes);
      const report = { id: job.id, scope: job.scope, createdAt: Date.now(), total: assets.length, checked: assets.length - skipped.length, skipped, groups, fingerprints,
        duplicateFiles: groups.reduce((n, g) => n + g.files.length, 0), extraCopies: groups.reduce((n, g) => n + g.files.length - 1, 0), extraBytes: groups.reduce((n, g) => n + g.extraBytes, 0), hashed: job.hashed, cached: job.cached };
      this.save(report); job.status = "done";
    } catch (e) { job.status = job.cancelled ? "cancelled" : "failed"; job.errors.push(e.message); job.error = e.message; }
    finally { job.finishedAt = Date.now(); this.lastJob = { ...job }; this.active = null; }
  }
  save(report) {
    this.lib.db.transaction(() => {
      this.lib.db.prepare("DELETE FROM duplicate_audio_reports WHERE id=?").run(report.scope);
      this.lib.db.prepare("INSERT INTO duplicate_audio_reports(id,payload) VALUES(?,?)").run(report.scope, JSON.stringify(report));
    })();
  }
  async reconcileTrash(changedIds) {
    if (!changedIds.length) return { removed: 0 };
    const changed = new Set(changedIds);
    // Combine scopes: a copy hidden by the selected scope is still a copy.
    const groups = this.lib.db.prepare("SELECT payload FROM duplicate_audio_reports").all()
      .flatMap(row => JSON.parse(row.payload).groups);
    const affected = new Set(groups.filter(g => g.files.some(f => changed.has(f.id))).flatMap(g => g.files.map(f => f.id)));
    const peers = new Map();
    for (const group of groups) for (const file of group.files) {
      if (!affected.has(file.id)) continue;
      if (!peers.has(file.id)) peers.set(file.id, new Set());
      for (const other of group.files) if (other.id !== file.id) peers.get(file.id).add(other.id);
    }
    const orphan = id => {
      const row = this.lib.db.prepare("SELECT id,path,tags,trashed FROM assets WHERE id=?").get(id);
      if (!row || row.trashed || !JSON.parse(row.tags).includes("重复音频")) return null;
      // Offline, renamed, and reclassified records are not deletions.
      for (const peer of peers.get(id) || []) {
        if (this.lib.db.prepare("SELECT id FROM assets WHERE id=? AND trashed=0").get(peer)) return null;
      }
      return { id: row.id, path: row.path, tags: JSON.parse(row.tags) };
    };
    const assets = [...affected].map(orphan).filter(Boolean);
    if (!assets.length) return { removed: 0 };
    const directory = path.join(this.lib.dataDir, "backups");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const backup = path.join(directory, `duplicate-audio-tag-cleanup-${Date.now()}-${crypto.randomUUID()}.json`);
    await fs.writeFile(backup, JSON.stringify({ createdAt: Date.now(), reason: "重复组删除后仅剩一个文件", changedIds, assets }), { flag: "wx", mode: 0o600 });
    let removed = 0;
    this.lib.db.transaction(() => {
      for (const before of assets) {
        const fresh = orphan(before.id);
        // Never remove newly edited tags based on an outdated backup.
        if (!fresh || JSON.stringify(fresh) !== JSON.stringify(before)) continue;
        this.lib.patch(fresh.id, { tags: fresh.tags.filter(t => t !== "重复音频") });
        removed++;
      }
    })();
    return { removed };
  }
  async mark(input) {
    const scope = this.scope(input.scope), report = this.read(scope);
    if (!report || report.id !== input.reportId) throw Error("检测结果已变化，请刷新后重试");
    if (this.active || this.marking || this.busy()) throw Error("素材任务进行中，请稍后标记");
    const visibleIds = new Set(this.state(scope).report.groups.flatMap(g => g.files.map(f => f.id)));
    const groups = report.groups.map(g => ({ ...g, files: g.files.filter(f => visibleIds.has(f.id)) })).filter(g => g.files.length > 1);
    this.marking = true;
    const job = { id: crypto.randomUUID(), type: "duplicates", label: "标记重复音频", status: "running", count: 0, total: visibleIds.size, startedAt: Date.now(), errors: [] };
    this.lib.jobs.set(job.id, job);
    const result = { marked: 0, alreadyMarked: 0, skipped: [] };
    try {
      const backup = groups.flatMap(g => g.files).map(f => { try { const a = this.lib.asset(f.id); return { id: a.id, path: a.path, tags: a.tags }; } catch { return { id: f.id, missing: true }; } });
      const directory = path.join(this.lib.dataDir, "backups");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(directory, `duplicate-audio-tags-${report.id}-${crypto.randomUUID()}.json`), JSON.stringify({ reportId: report.id, createdAt: Date.now(), assets: backup }), { flag: "wx", mode: 0o600 });
      for (const group of groups) {
        try {
          for (const file of group.files) {
            const a = this.lib.asset(file.id);
            if (a.trashed || a.path !== file.path || !["sfx", "music"].includes(a.kind) || (scope !== "all" && a.kind !== scope) || this.lib.locks.has(a.id) || (await this.inspect(a)).signature !== file.signature) throw Error("文件已变化、离线或有整理操作，整组暂不标记，请重新检查");
          }
          if (this.busy()) throw Error("素材任务进行中，暂不标记");
          let marked = 0, alreadyMarked = 0;
          this.lib.db.transaction(() => {
            for (const file of group.files) {
              const a = this.lib.asset(file.id);
              if (!a.tags.includes("重复音频") && a.tags.length >= 40) throw Error("素材标签已达上限，整组未标记");
            }
            for (const file of group.files) {
              const a = this.lib.asset(file.id);
              if (a.tags.includes("重复音频")) alreadyMarked++;
              else { this.lib.patch(a.id, { tags: [...a.tags, "重复音频"] }); marked++; }
            }
          })();
          result.marked += marked; result.alreadyMarked += alreadyMarked; job.count += group.files.length;
          for (const file of group.files) file.tags = this.lib.asset(file.id).tags;
        } catch (e) { result.skipped.push({ sha256: group.sha256, reason: e.message }); }
      }
      report.markedAt = Date.now(); report.markResult = result; this.save(report);
      job.status = "done"; return result;
    } catch (e) { job.status = "failed"; job.errors.push(e.message); throw e; }
    finally { job.finishedAt = Date.now(); this.marking = false; }
  }
}
