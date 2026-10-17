import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Library } from "../server/library.mjs";
import { Projects } from "../server/projects.mjs";
import { MissingFiles } from "../server/missing-files.mjs";
import { DuplicateAudio } from "../server/duplicate-audio.mjs";

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-cleanup-")));
  const lib = await new Library(path.join(base, "data"), { directoryClassification: true }).init(); lib.enqueue = () => {};
  t.after(async () => { lib.db.close(); await fs.rm(base, { recursive: true, force: true }); });
  const helper = path.join(base, "trash-helper.mjs");
  await fs.writeFile(helper, `#!/usr/bin/env node
import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
const dir=${JSON.stringify(path.join(base, ".Trash"))};await fs.mkdir(dir,{recursive:true});
const target=path.join(dir,crypto.randomUUID());await fs.rename(process.argv[2],target);process.stdout.write(JSON.stringify(target));
`, { mode: 0o700 });
  lib.trashBin = helper;
  const roots = [];
  for (const name of ["先管理", "后管理"]) {
    const source = path.join(base, name); await fs.mkdir(source);
    const root = await lib.addRoot(source, "sfx"); roots.push(root);
    await fs.writeFile(path.join(source, "副本.wav"), "identical-audio");
    const job = lib.scan(root.id); while (job.status === "running") await new Promise(r => setTimeout(r, 5));
    assert.equal(job.status, "done");
  }
  new MissingFiles(lib); const projects = new Projects(lib).init(), detector = new DuplicateAudio(lib);
  detector.start({ scope: "sfx", force: true });
  while (detector.active) await new Promise(r => setTimeout(r, 5));
  assert.equal(detector.lastJob.status, "done");
  const reportId = detector.read("sfx").id;
  return { lib, roots, projects, detector, input: { scope: "sfx", reportId } };
}
test("一键清理保留最先管理的根、写备份和撤销记录，清理后移除孤立重复标签", async t => {
  const { lib, roots, detector, input } = await fixture(t);
  await detector.mark(input);
  const { plan, preview } = await detector.cleanup.preview(input);
  assert.equal(preview.removeCount, 1); assert.equal(plan.groups[0].keep.root_id, roots[0].id);
  const result = await detector.cleanup.execute(plan, false);
  assert.equal(result.removed, 1); assert.equal(result.skipped.length, 0);
  assert.equal(await fs.readFile(plan.groups[0].keep.path, "utf8"), "identical-audio");
  assert.deepEqual(lib.asset(plan.groups[0].keep.id).tags, []);
  assert.equal(lib.asset(plan.groups[0].remove[0].id).trashed, 1);
  const operation = lib.db.prepare("SELECT * FROM operations WHERE action='trash'").get();
  assert.equal(operation.status, "done");
  await lib.undo(operation.id);
  assert.equal(await fs.readFile(plan.groups[0].remove[0].path, "utf8"), "identical-audio");
  assert.ok((await fs.readdir(path.join(lib.dataDir, "backups"))).some(n => n.startsWith("duplicate-cleanup-")));
});
test("历史加入时间未知需确认顺序，手动调整顺序使旧预览失效", async t => {
  const { lib, roots, detector, input } = await fixture(t);
  lib.db.exec("UPDATE roots SET managed_added_ms=NULL");
  const { plan, preview } = await detector.cleanup.preview(input);
  assert.equal(preview.requiresOrderConfirmation, true);
  await assert.rejects(detector.cleanup.execute(plan, false), /确认保留顺序/);
  lib.setRootManagementOrder([roots[1].id, roots[0].id]);
  await assert.rejects(detector.cleanup.execute(plan, true), /顺序已变化/);
  const next = await detector.cleanup.preview(input);
  assert.equal(next.plan.groups[0].keep.root_id, roots[1].id);
  assert.equal((await detector.cleanup.execute(next.plan, true)).removed, 1);
});
test("保留文件被删或副本被改写时，不能继续删除剩余副本", async t => {
  const { detector, input } = await fixture(t);
  const { plan } = await detector.cleanup.preview(input);
  await fs.unlink(plan.groups[0].keep.path);
  const result = await detector.cleanup.execute(plan, false);
  assert.equal(result.removed, 0); assert.equal(result.skipped.length, 1);
  assert.equal(await fs.readFile(plan.groups[0].remove[0].path, "utf8"), "identical-audio");
});
test("项目引用、独立备注或标签不自动丢弃；注销的根不参与清理", async t => {
  const { lib, roots, projects, detector, input } = await fixture(t);
  const later = lib.list({ root: roots[1].id }).items[0];
  const project = projects.save(null, { name: "剪辑工程", software: "resolve" });
  projects.add(project.id, { ids: [later.id] });
  assert.equal((await detector.cleanup.preview(input)).preview.removeCount, 0);
  projects.remove(project.id);
  lib.patch(later.id, { note: "独立备注" });
  assert.equal((await detector.cleanup.preview(input)).preview.removeCount, 0);
  lib.patch(later.id, { note: "", tags: ["独立标签"] });
  assert.equal((await detector.cleanup.preview(input)).preview.removeCount, 0);
  lib.patch(later.id, { tags: [] }); lib.retireRoot(roots[0].id);
  assert.equal((await detector.cleanup.preview(input)).preview.removeCount, 0);
});
test("预览后元数据或项目变化整组跳过；无废纸篓组件拒绝", async t => {
  const { lib, detector, input } = await fixture(t);
  const { plan } = await detector.cleanup.preview(input);
  lib.patch(plan.groups[0].remove[0].id, { note: "预览后新增" });
  assert.equal((await detector.cleanup.execute(plan, false)).removed, 0);
  lib.trashBin = null;
  await assert.rejects(detector.cleanup.preview(input), /不能移入废纸篓/);
});
test("登记时间和顺序持久化，恢复不改时间；旧库迁移不伪造时间", async t => {
  const { lib, roots } = await fixture(t);
  assert.ok(roots[0].managed_added_ms > 0);
  assert.ok(roots[0].management_order < roots[1].management_order);
  lib.retireRoot(roots[0].id); lib.restoreRoot(roots[0].id);
  assert.equal(lib.rootById(roots[0].id).managed_added_ms, roots[0].managed_added_ms);
  lib.db.prepare("UPDATE roots SET managed_added_ms=NULL,management_order=0 WHERE id=?").run(roots[0].id);
  await lib.ensureRootManagement();
  assert.equal(lib.rootById(roots[0].id).managed_added_ms, null);
  assert.ok(lib.rootById(roots[0].id).management_order > 0);
});
