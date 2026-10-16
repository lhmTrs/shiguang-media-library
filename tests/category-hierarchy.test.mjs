import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { AssetCategories } from "../server/music-categories.mjs";

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-hierarchy-")));
  const rootPath = path.join(base, "素材"); await fs.mkdir(rootPath);
  const lib = await new Library(path.join(base, "db")).init(); lib.enqueue = () => {};
  t.after(async () => { lib.db.close(); await fs.rm(base, { recursive: true, force: true }); });
  const root = await lib.addRoot(rootPath, "mixed");
  await fs.writeFile(path.join(rootPath, "测试.wav"), "fixture");
  const scan = async () => { const job = lib.scan(root.id); while (job.status === "running") await new Promise(r => setTimeout(r, 10)); assert.equal(job.status, "done"); return job; };
  await scan();
  return { lib, rootPath, scan, asset: lib.list().items[0] };
}

test("二级分类迁移备份、归属校验、同名子类、原子更新、改名删除和重启", async t => {
  const { lib, asset } = await setup(t);
  lib.patch(asset.id, { category: "悬疑", sub: "危机", tags: ["保留"], note: "不改变" });
  const manager = new AssetCategories(lib).init();
  const parent = manager.list().find(c => c.name === "悬疑");
  const child = manager.subcategories(parent.id)[0];
  assert.equal(child.name, "危机"); assert.equal(Number(child.n), 1);
  assert.ok((await fs.readdir(path.join(lib.dataDir, "backups"))).some(n => n.startsWith("before-category-hierarchy-")));
  const other = manager.create({ name: "搞笑" });
  assert.throws(() => lib.patch(asset.id, { category: other.name, sub: child.name, note: "禁止写入" }), /子类不属于/);
  assert.equal(lib.asset(asset.id).note, "不改变");
  assert.equal(lib.asset(asset.id).category, "悬疑");
  assert.throws(() => lib.patch(asset.id, { sub: "不存在" }), /子类不属于/);
  const duplicateName = manager.createSubcategory({ categoryId: other.id, name: "危机" });
  assert.notEqual(duplicateName.id, child.id);
  assert.throws(() => manager.createSubcategory({ categoryId: other.id, name: "危机" }), /同名/);
  manager.renameSubcategory(child.id, { name: "追踪" });
  assert.equal(lib.asset(asset.id).sub, "追踪");
  assert.equal(manager.subcategory(duplicateName.id).name, "危机");
  manager.rename(parent.id, { name: "紧张悬疑" });
  assert.equal(lib.asset(asset.id).category, "紧张悬疑");
  assert.equal(lib.list({ subcategoryId: child.id }).total, 1);
  lib.patch(asset.id, { category: other.name });
  assert.equal(lib.asset(asset.id).sub, "");
  lib.patch(asset.id, { sub: "危机" });
  manager.assign({ ids: [asset.id], categoryId: parent.id });
  assert.equal(lib.asset(asset.id).sub, "");
  lib.patch(asset.id, { sub: "追踪" });
  manager.removeSubcategory(child.id);
  assert.equal(lib.asset(asset.id).category, "紧张悬疑");
  assert.equal(lib.asset(asset.id).sub, "");
  new AssetCategories(lib).init();
  assert.equal(manager.subcategories(parent.id).length, 0);
  lib.patch(asset.id, { category: other.name, sub: "危机" });
  manager.remove(other.id);
  assert.equal(lib.asset(asset.id).category, ""); assert.equal(lib.asset(asset.id).sub, "");
  assert.deepEqual(lib.asset(asset.id).tags, ["保留"]);
  assert.equal(await fs.readFile(asset.path, "utf8"), "fixture");
});

test("新增目录按两级关系入库，空子目录注册，重扫保留人工分类", async t => {
  const { lib, rootPath, scan, asset } = await setup(t);
  const manager = new AssetCategories(lib).init();
  await fs.mkdir(path.join(rootPath, "情绪", "紧张", "更深目录"), { recursive: true });
  await fs.mkdir(path.join(rootPath, "情绪", "悲伤"));
  await fs.writeFile(path.join(rootPath, "情绪", "紧张", "更深目录", "新增.wav"), "fixture");
  assert.equal((await scan()).errors.length, 0);
  const added = lib.list({ q: "新增.wav" }).items[0];
  assert.equal(added.category, "情绪"); assert.equal(added.sub, "紧张");
  const parent = manager.list().find(c => c.name === "情绪");
  assert.deepEqual(manager.subcategories(parent.id).map(c => c.name).sort(), ["悲伤", "紧张"].sort());
  assert.equal(manager.list().some(c => c.name === "更深目录"), false);
  const manual = manager.create({ name: "人工主类" }); manager.createSubcategory({ categoryId: manual.id, name: "人工子类" });
  lib.patch(added.id, { category: manual.name, sub: "人工子类" }); await scan();
  assert.equal(lib.asset(added.id).sub, "人工子类");
  assert.equal(lib.asset(asset.id).category, "");
});
