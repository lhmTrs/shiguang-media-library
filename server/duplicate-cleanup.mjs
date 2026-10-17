import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export class DuplicateCleanup {
  constructor(detector) { this.detector = detector; this.lib = detector.lib; this.active = null; }
  roots() { return this.lib.allRoots().sort((a, b) => Number(a.management_order) - Number(b.management_order) || a.id.localeCompare(b.id)); }
  rootKey() { return JSON.stringify(this.roots().map(r => [r.id, r.path, r.management_order, r.managed_added_ms, r.retired])); }
  begin(label) {
    if (process.env.MEDIA_READONLY_FILES === "1" || !this.lib.trashBin) throw Error("当前环境不能移入废纸篓，未删除任何文件");
    if (this.active || this.detector.active || this.detector.marking || this.detector.busy() || this.lib.locks.size || [...this.lib.jobs.values()].some(j => j.status === "running")) throw Error("其他素材任务进行中，请稍后清理");
    const job = { id: crypto.randomUUID(), type: "duplicate-cleanup", label, status: "running", count: 0, total: 0, errors: [] };
    this.active = job; this.lib.jobs.set(job.id, job); return job;
  }
  end(job, error) { job.status = error ? "failed" : "done"; if (error) job.errors.push(error.message); job.finishedAt = Date.now(); this.active = null; }
  capture(id) {
    const a = this.lib.asset(id);
    const projects = this.lib.db.prepare("SELECT id,project_id,status,note FROM project_assets WHERE asset_id=? ORDER BY id").all(id);
    return { id: a.id, root_id: a.root_id, path: a.path, name: a.name, kind: a.kind, tags: a.tags, note: a.note, favorite: a.favorite, reveal_count: a.reveal_count, review: a.review, trashed: a.trashed, projects };
  }
  async verify(file, digest, signature) {
    const a = this.lib.asset(file.id);
    if (a.trashed || !a.online || a.path !== file.path || a.kind !== file.kind || !this.lib.roots().some(r => r.id === a.root_id && r.online)) throw Error("素材已移动、删除、离线、改类型或目录已注销");
    const before = await this.detector.inspect(a);
    if (signature && before.signature !== signature) throw Error("文件状态已变化，请重新检查重复音频");
    const handle = await fs.open(before.real, "r");
    try {
      const hash = crypto.createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest("hex") !== digest) throw Error("文件内容已变化，未删除");
    } finally { await handle.close(); }
    if ((await this.detector.inspect(this.lib.asset(file.id))).signature !== before.signature) throw Error("校验期间文件发生变化，未删除");
    return before.signature;
  }
  async preview(input) {
    const scope = this.detector.scope(input.scope), report = this.detector.read(scope);
    if (!report || report.id !== input.reportId) throw Error("检测结果已变化，请重新检查");
    const job = this.begin("准备重复音频清理预览");
    try {
      const roots = this.roots(), byRoot = new Map(roots.map(r => [r.id, r]));
      const plan = { scope, reportId: report.id, rootKey: this.rootKey(), groups: [], skipped: [], requiresOrderConfirmation: false };
      job.total = report.groups.length;
      for (const group of report.groups) {
        try {
          const current = group.files.filter(f => { try { return !this.lib.asset(f.id).trashed; } catch { return false; } });
          if (current.length < 2) continue;
          const files = [];
          for (const file of current) {
            const signature = await this.verify(file, group.sha256, file.signature);
            files.push({ ...this.capture(file.id), signature });
          }
          const rank = f => f.projects.length * 100000 + Number(f.favorite) * 10000 + Number(f.reveal_count || 0) * 10 + f.tags.length + (f.note ? 1 : 0) + (f.review ? 0 : 100);
          files.sort((a, b) => Number(byRoot.get(a.root_id)?.management_order) - Number(byRoot.get(b.root_id)?.management_order) || rank(b) - rank(a) || a.path.localeCompare(b.path, "zh-CN") || a.id.localeCompare(b.id));
          const [keep, ...remove] = files;
          if (remove.some(f => f.projects.length)) throw Error("待清理副本存在项目引用，请先人工核对");
          if (remove.some(f => f.tags.some(t => t !== "重复音频" && !keep.tags.includes(t)) || f.note && f.note !== keep.note || f.favorite && !keep.favorite)) throw Error("待清理副本有独立标签、备注或收藏，请先人工合并");
          if (new Set(files.map(f => f.root_id)).size > 1 && files.some(f => !byRoot.get(f.root_id)?.managed_added_ms)) plan.requiresOrderConfirmation = true;
          plan.groups.push({ sha256: group.sha256, size: group.size, keep, remove });
        } catch (e) { plan.skipped.push({ sha256: group.sha256, name: group.files[0]?.name, reason: e.message }); }
        finally { job.count++; }
      }
      if (plan.rootKey !== this.rootKey()) throw Error("素材库保留顺序已变化，请重新预览");
      const visible = f => ({ id: f.id, name: f.name, path: f.path, rootName: byRoot.get(f.root_id)?.name, rootPath: byRoot.get(f.root_id)?.path });
      return { plan, preview: { groups: plan.groups.map(g => ({ sha256: g.sha256, keep: visible(g.keep), remove: g.remove.map(visible) })), skipped: plan.skipped,
        removeCount: plan.groups.reduce((n, g) => n + g.remove.length, 0), bytes: plan.groups.reduce((n, g) => n + g.size * g.remove.length, 0), requiresOrderConfirmation: plan.requiresOrderConfirmation,
        roots: roots.map(r => ({ id: r.id, name: r.name, path: r.path, management_order: r.management_order, managed_added_ms: r.managed_added_ms, retired: r.retired })) } };
    } catch (e) { this.end(job, e); throw e; }
    finally { if (this.active === job) this.end(job); }
  }
  async execute(plan, acknowledgeOrder) {
    if (plan.requiresOrderConfirmation && acknowledgeOrder !== true) throw Error("旧素材库的真实加入时间未知，请确认保留顺序");
    if (this.detector.read(plan.scope)?.id !== plan.reportId || this.rootKey() !== plan.rootKey) throw Error("检测报告或素材库顺序已变化，请重新预览");
    const job = this.begin("清理重复音频");
    const result = { removed: 0, bytes: 0, results: [], skipped: [...plan.skipped], warnings: [] };
    try {
      const dir = path.join(this.lib.dataDir, "backups", `duplicate-cleanup-${Date.now()}-${job.id}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, "plan.json"), JSON.stringify(plan), { flag: "wx", mode: 0o600 });
      job.total = plan.groups.length;
      for (const group of plan.groups) {
        try {
          if (this.rootKey() !== plan.rootKey) throw Error("素材目录或保留顺序已变化");
          for (const file of [group.keep, ...group.remove]) {
            const { signature, ...snapshot } = file;
            if (JSON.stringify(this.capture(file.id)) !== JSON.stringify(snapshot)) throw Error("素材属性或项目引用已变化，请重新预览");
            await this.verify(file, group.sha256, signature);
          }
          this.lib.locks.add(group.keep.id);
          try {
            for (const file of group.remove) {
              // Never remove a copy after its keeper has disappeared or changed.
              await this.verify(group.keep, group.sha256, group.keep.signature);
              await this.verify(file, group.sha256, file.signature);
              const input = { action: "trash", ids: [file.id] };
              const expected = await this.lib.plan(input, job.id);
              if (!expected[0]?.ok) throw Error(expected[0]?.error || "无法准备废纸篓操作");
              const [operation] = await this.lib.execute(input, expected, job.id);
              result.results.push(operation);
              if (!operation.ok) throw Error(operation.error || "移入废纸篓失败");
              result.removed++; result.bytes += group.size;
              await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(result), { mode: 0o600 });
            }
          } finally { this.lib.locks.delete(group.keep.id); }
        } catch (e) { result.skipped.push({ sha256: group.sha256, name: group.keep.name, reason: e.message }); }
        finally { job.count++; }
      }
      try { await this.detector.reconcileTrash(result.results.filter(r => r.ok).map(r => r.id)); }
      catch (e) { result.warnings.push("文件已移入废纸篓，但重复标签清理失败：" + e.message); }
      await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(result), { mode: 0o600 });
      return result;
    } catch (e) { this.end(job, e); throw e; }
    finally { if (this.active === job) this.end(job); }
  }
}
