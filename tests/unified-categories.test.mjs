import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Library } from "../server/library.mjs";
import { MusicCategories, AssetCategories } from "../server/music-categories.mjs";

test("统一分类保留旧 ID，四种素材均可多分类、筛选、主分类及原子保存", async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-unified-")));
  const source = path.join(base, "素材"); await fs.mkdir(source);
  const lib = await new Library(path.join(base, "data")).init(); lib.enqueue = () => {};
  t.after(async () => { lib.db.close(); await fs.rm(base, { recursive: true, force: true }); });
  const root = await lib.addRoot(source, "mixed");
  for (const name of ["音乐.mp3", "音效.wav", "视频.mp4", "照片.jpg"]) await fs.writeFile(path.join(source, name), "fixture");
  const job = lib.scan(root.id); while (job.status === "running") await new Promise(r => setTimeout(r, 10));
  const assets = lib.list().items;
  for (const a of assets) lib.patch(a.id, { category: "共同主分类", sub: "旧子类", tags: ["保留"], note: "备注", ...(a.ext === "mp3" ? { kind: "music" } : {}) });
  const old = new MusicCategories(lib).init(); const extra = old.create({ name: "旧额外分类" });
  const music = assets.find(a => a.ext === "mp3"); old.add({ assetId: music.id, categoryId: extra.id });
  const manager = new AssetCategories(lib).init();
  assert.equal(manager.get(extra.id).name, "旧额外分类");
  assert.equal(manager.list()[0].totalAssets, 4);
  for (const a of assets) {
    manager.add({ assetId: a.id, categoryId: extra.id });
    manager.add({ assetId: a.id, categoryId: extra.id });
    assert.equal(manager.members(a.id).length, 2);
  }
  assert.equal(manager.list().find(c => c.id === extra.id).n, 4);
  assert.equal(lib.list({ category: extra.name }).total, 4);
  for (const kind of ["music", "sfx", "video", "photo"]) {
    assert.equal(manager.list({ kind })[0].totalAssets, 1);
    assert.equal(lib.list({ kind, category: extra.name }).total, 1);
    assert.ok(lib.categoryOptions({ kind }).some(c => c.category === extra.name));
  }
  const video = assets.find(a => a.kind === "video");
  const target = manager.create({ name: "新主分类" });
  manager.assign({ ids: [video.id], categoryId: target.id });
  assert.ok(manager.members(video.id).some(c => c.id === extra.id));
  assert.equal(lib.asset(video.id).category, target.name);
  const before = lib.asset(video.id);
  assert.throws(() => manager.save({ assetId: video.id, category: "不能创建", sub: "", extraIds: ["unknown"] }));
  assert.equal(lib.asset(video.id).category, before.category);
  assert.equal(manager.list().some(c => c.name === "不能创建"), false);
  assert.throws(() => manager.save({ assetId: video.id, category: "不能创建", sub: "", extraIds: [extra.id] }), /分类不存在/);
  assert.throws(() => lib.patch(video.id, { category: "不能创建", note: "不应保存" }), /分类不存在/);
  assert.equal(lib.asset(video.id).note, "备注");
  const manual = manager.create({ name: "手动新分类" });
  manager.createSubcategory({ categoryId: manual.id, name: "新子类" });
  manager.save({ assetId: video.id, category: "手动新分类", sub: "新子类", extraIds: [extra.id] });
  assert.equal(manager.members(video.id).length, 2);
  assert.equal(lib.asset(video.id).sub, "新子类");
  const rollback = manager.create({ name: "应当回滚的新分类" });
  manager.createSubcategory({ categoryId: rollback.id, name: "回滚子类" });
  lib.db.exec("CREATE TRIGGER reject_category_link BEFORE INSERT ON music_category_links BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
  assert.throws(() => manager.save({ assetId: video.id, category: "应当回滚的新分类", sub: "回滚子类", extraIds: [extra.id] }));
  assert.equal(lib.asset(video.id).category, "手动新分类");
  assert.equal(lib.asset(video.id).sub, "新子类");
  assert.equal(manager.members(video.id).length, 2);
  assert.equal(manager.list().some(c => c.name === "应当回滚的新分类"), true);
  lib.db.exec("DROP TRIGGER reject_category_link");
  manager.detach({ assetId: video.id, categoryId: extra.id });
  assert.equal(manager.members(video.id).length, 1);
  manager.rename(extra.id, { name: "统一重命名" });
  assert.equal(lib.list({ category: "统一重命名" }).total, 3);
  manager.remove(extra.id);
  for (const a of assets) {
    assert.equal(lib.asset(a.id).note, "备注");
    assert.deepEqual(lib.asset(a.id).tags, ["保留"]);
    assert.equal(lib.asset(a.id).reveal_count, 0);
    assert.equal(await fs.readFile(a.path, "utf8"), "fixture");
  }
  await fs.mkdir(path.join(source, "空文件夹分类"));
  await fs.mkdir(path.join(source, "新视频分类"));
  await fs.writeFile(path.join(source, "新视频分类", "新视频.mp4"), "fixture");
  const rescan = lib.scan(root.id); while (rescan.status === "running") await new Promise(r => setTimeout(r, 10));
  assert.equal(rescan.status, "done");
  assert.ok(manager.list().some(c => c.name === "空文件夹分类" && c.n === 0));
  assert.equal(lib.list({ q: "新视频.mp4" }).items[0].category, "新视频分类");
  assert.equal(lib.asset(video.id).category, "手动新分类");
  assert.equal(manager.list().some(c => c.name === "不能创建"), false);
});
