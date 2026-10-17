import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Library } from "../server/library.mjs";
import { MetadataBatches } from "../server/metadata-batches.mjs";

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-annotations-")));
  const source = path.join(base, "音效"); await fs.mkdir(path.join(source, "转场"), { recursive: true });
  const lib = await new Library(path.join(base, "data"), { directoryClassification: true }).init(); lib.enqueue = () => {};
  t.after(async () => { lib.db.close(); await fs.rm(base, { recursive: true, force: true }); });
  for (const name of ["WHOOSH.wav", "普通.wav", "100%_片段.wav"]) await fs.writeFile(path.join(source, "转场", name), "untouched media");
  const root = await lib.addRoot(source, "sfx"), job = lib.scan(root.id);
  while (job.status === "running") await new Promise(r => setTimeout(r, 5));
  assert.equal(job.status, "done");
  return { base, lib, root, batches: new MetadataBatches(lib).init(), files: lib.list().items };
}
test("预览不改数据，统一追加标签、只补空备注、审计持久化和幂等提交", async t => {
  const { lib, batches, files } = await fixture(t), a = files[0], b = files[1];
  lib.patch(a.id, { tags: ["原标签"], note: "原备注" });
  const { plan, preview } = batches.preview({ selection: { ids: [a.id, b.id] }, changes: { addTags: ["转场"], note: { text: "补充", mode: "ifEmpty" } }, reason: "名称建议" });
  assert.equal(preview.changed, 2); assert.deepEqual(lib.asset(a.id).tags, ["原标签"]);
  const done = await batches.apply(plan);
  assert.equal(done.items.length, 2); assert.deepEqual(lib.asset(a.id).tags, ["原标签", "转场"]);
  assert.equal(lib.asset(a.id).note, "原备注"); assert.equal(lib.asset(b.id).note, "补充");
  assert.equal((await batches.apply(plan)).items.length, 2); assert.equal(batches.list().length, 1);
  assert.equal(new MetadataBatches(lib).init().read(plan.id).basis, "metadata");
  assert.equal(await fs.readFile(a.path, "utf8"), "untouched media");
});
test("仅选当前在管素材，关键词忽略大小写并按字面匹配通配符", async t => {
  const { lib, root, batches } = await fixture(t);
  const input = { selection: { filter: { kind: "sfx" }, match: { fields: ["name"], keywords: ["whoosh"] } }, changes: { addTags: ["转场"] } };
  assert.equal(batches.preview(input).preview.matched, 1);
  assert.equal(batches.preview({ ...input, selection: { filter: { kind: "sfx" }, match: { fields: ["name"], keywords: ["%_"] } } }).preview.matched, 1);
  lib.retireRoot(root.id);
  assert.equal(batches.preview(input).preview.matched, 0);
  assert.throws(() => batches.preview({ ...input, selection: { filter: {} } }), /筛选/);
  assert.throws(() => batches.preview({ ...input, selection: { filter: { kind: "" } } }), /类型/);
  assert.throws(() => batches.preview({ ...input, selection: { filter: { kind: "sfx" }, match: { fields: ["name; DROP TABLE assets"], keywords: ["x"] } } }), /字段/);
});
test("确认冻结目标；预览后修改或移动冲突项跳过，不扩大搜索", async t => {
  const { lib, batches, files } = await fixture(t), [a, b] = files;
  const { plan } = batches.preview({ selection: { ids: [a.id, b.id] }, changes: { addTags: ["新增"] } });
  lib.patch(a.id, { note: "其他人刚写入" });
  lib.db.prepare("UPDATE assets SET path=? WHERE id=?").run(b.path + ".moved", b.id);
  const result = await batches.apply(plan);
  assert.equal(result.items.length, 0); assert.equal(result.skipped.length, 2);
  assert.equal(lib.asset(a.id).note, "其他人刚写入"); assert.deepEqual(lib.asset(a.id).tags, []);
});
test("撤销只恢复本批改过的字段，不抹掉无关新备注，冲突项可重试", async t => {
  const { lib, batches, files } = await fixture(t), [a, b] = files;
  const { plan } = batches.preview({ selection: { ids: [a.id, b.id] }, changes: { addTags: ["转场"] } });
  await batches.apply(plan); lib.patch(a.id, { note: "之后添加的备注" }); lib.patch(b.id, { tags: ["转场", "之后添加的标签"] });
  const result = await batches.undo(plan.id);
  assert.equal(result.restored, 1); assert.equal(result.skipped.length, 1); assert.equal(result.status, "partially_undone");
  assert.equal(lib.asset(a.id).note, "之后添加的备注"); assert.deepEqual(lib.asset(a.id).tags, []);
  assert.deepEqual(lib.asset(b.id).tags, ["转场", "之后添加的标签"]);
  lib.patch(b.id, { tags: ["转场"] }); assert.equal((await batches.undo(plan.id)).restored, 1);
  assert.equal(batches.read(plan.id).status, "undone"); assert.equal((await batches.undo(plan.id)).restored, 0);
});
test("逐文件不同备注与标签、追加幂等、上限与额外字段保护", async t => {
  const { lib, batches, files } = await fixture(t), [a, b] = files;
  lib.patch(a.id, { note: "原备注" });
  const input = { items: [{ id: a.id, changes: { note: { mode: "append", text: "附注" } } }, { id: b.id, changes: { addTags: ["环境"] } }] };
  await batches.apply(batches.preview(input).plan);
  assert.equal(lib.asset(a.id).note, "原备注\n附注"); assert.deepEqual(lib.asset(b.id).tags, ["环境"]);
  assert.equal(batches.preview(input).preview.changed, 0);
  assert.throws(() => batches.preview({ selection: { ids: [a.id] }, changes: { category: "转场" } }), /仅支持/);
  assert.throws(() => batches.preview({ items: [input.items[0], input.items[0]] }), /不能重复/);
  lib.patch(b.id, { tags: Array.from({ length: 40 }, (_, i) => "t" + i) });
  assert.equal(batches.preview({ selection: { ids: [b.id] }, changes: { addTags: ["超限"] } }).preview.skipped.length, 1);
});
test("备份失败不写库；数据库事务失败不留下半批标注", async t => {
  const { lib, batches, base, files } = await fixture(t);
  const { plan } = batches.preview({ selection: { ids: files.map(a => a.id) }, changes: { addTags: ["转场"] } });
  await fs.writeFile(path.join(base, "data", "backups"), "block backup");
  await assert.rejects(batches.apply(plan));
  assert.ok(files.every(a => lib.asset(a.id).tags.length === 0));
  await fs.unlink(path.join(base, "data", "backups"));
  const patch = lib.patch.bind(lib); let n = 0;
  lib.patch = (...args) => { if (++n === 2) throw Error("injected failure"); return patch(...args); };
  await assert.rejects(batches.apply(plan), /injected failure/);
  assert.ok(files.every(a => lib.asset(a.id).tags.length === 0)); assert.equal(batches.list().length, 0);
});
