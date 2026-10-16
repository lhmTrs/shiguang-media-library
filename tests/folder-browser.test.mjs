import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Library } from "../server/library.mjs";
import { AssetCategories } from "../server/music-categories.mjs";
import { Projects } from "../server/projects.mjs";
import { FolderBrowser } from "../server/folder-browser.mjs";

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-folder-")));
  const source = path.join(base, "音效 素材"), other = path.join(base, "另一个目录");
  await fs.mkdir(path.join(source, "转场", "呼啸", "快速"), { recursive: true });
  await fs.mkdir(path.join(source, "空文件夹"));
  await fs.mkdir(path.join(source, "风_%"));
  await fs.mkdir(path.join(source, "风_其他"));
  await fs.mkdir(path.join(other, "转场"), { recursive: true });
  for (const rel of ["根.wav", "转场/普通.wav", "转场/呼啸/快.wav", "转场/呼啸/快速/更快.wav", "风_%/通配.wav", "风_其他/不能匹配.wav"])
    await fs.writeFile(path.join(source, rel), "fixture:" + rel);
  await fs.writeFile(path.join(other, "转场", "另一个.wav"), "other");
  const lib = await new Library(path.join(base, "db")).init(); lib.enqueue = () => {};
  const categories = new AssetCategories(lib).init(), projects = new Projects(lib).init();
  const root = await lib.addRoot(source, "sfx"), root2 = await lib.addRoot(other, "sfx");
  for (const r of [root, root2]) { const job = lib.scan(r.id); while (job.status === "running") await new Promise(r => setTimeout(r, 10)); assert.equal(job.status, "done"); }
  t.after(async () => { lib.db.close(); await fs.rm(base, { recursive: true, force: true }); });
  return { lib, categories, projects, browser: new FolderBrowser(lib), root, root2, source, base };
}

test("真实目录：多级、空目录、同名目录按根隔离，直接/子树范围与通配符转义", async t => {
  const { lib, browser, root, root2 } = await fixture(t);
  const top = await browser.branch({ root: root.id });
  assert.equal(top.state, "online"); assert.equal(top.total, 6); assert.equal(top.direct, 1);
  assert.equal(top.children.find(c => c.name === "空文件夹").total, 0);
  assert.equal(top.children.find(c => c.name === "转场").total, 3);
  assert.equal((await browser.branch({ root: root.id, directory: "转场/呼啸" })).children[0].name, "快速");
  assert.equal((await browser.branch({ root: root2.id })).total, 1);
  assert.equal(lib.list({ directoryRoot: root.id, directory: "转场" }).total, 3);
  assert.equal(lib.list({ directoryRoot: root.id, directory: "转场", includeChildren: "0" }).total, 1);
  assert.equal(lib.list({ directoryRoot: root.id, directory: "风_%" }).total, 1);
  assert.equal(lib.list({ directoryRoot: root.id, directory: "", includeChildren: "0" }).total, 1);
  for (const [id, name] of [["upper", "Case"], ["lower", "case"], ["emoji", "🎬"]])
    lib.db.prepare("INSERT INTO assets(id,root_id,path,name,kind) VALUES(?,?,?,?,?)").run(id, root.id, path.join(root.path, name, "例.wav"), "例.wav", "sfx");
  assert.equal(lib.list({ directoryRoot: root.id, directory: "Case" }).total, 1);
  assert.equal(lib.list({ directoryRoot: root.id, directory: "🎬", includeChildren: "0" }).total, 1);
});

test("真实目录：标签组合过滤、不写旧分类或项目记录，目录离线/改名保留索引", async t => {
  const { lib, browser, root, source, categories, projects } = await fixture(t);
  const asset = lib.list({ q: "快.wav" }).items[0];
  lib.patch(asset.id, { tags: ["科幻", "短促"], note: "必须保留" });
  const project = projects.save(null, { name: "保留项目", software: "resolve" });
  projects.add(project.id, { ids: [asset.id] });
  const before = { asset: lib.asset(asset.id), cats: categories.list(), history: projects.history(asset.id) };
  assert.equal(lib.list({ directoryRoot: root.id, directory: "转场", tagRules: JSON.stringify({ all: ["科幻"], any: [], none: [] }) }).total, 1);
  await browser.branch({ root: root.id, directory: "转场/呼啸" });
  await fs.rename(path.join(source, "空文件夹"), path.join(source, "新名字"));
  const changed = await browser.branch({ root: root.id });
  assert(changed.children.some(c => c.name === "新名字"));
  assert(!changed.children.some(c => c.name === "空文件夹"));
  await fs.rename(source, source + "-离线");
  const offline = await browser.branch({ root: root.id });
  assert.equal(offline.state, "offline"); assert.equal(offline.total, 6);
  assert.equal((await browser.branch({ root: root.id, directory: "转场/呼啸" })).children[0].name, "快速");
  assert.deepEqual({ asset: lib.asset(asset.id), cats: categories.list(), history: projects.history(asset.id) }, before);
  assert.equal(await fs.readFile(path.join(source + "-离线", "转场/呼啸/快.wav"), "utf8"), "fixture:转场/呼啸/快.wav");
});

test("真实目录：拒绝越界、无效范围及符号链接，不读取未登记目录", async t => {
  const { lib, browser, root, source, base } = await fixture(t);
  for (const directory of ["../", "/tmp", "转场/../", "转场\\呼啸", "a//b"])
    await assert.rejects(browser.branch({ root: root.id, directory }), /目录|参数/);
  await assert.rejects(browser.branch({ root: "unknown" }), /未登记/);
  assert.throws(() => lib.list({ directoryRoot: root.id, includeChildren: "bad" }), /范围参数/);
  assert.throws(() => lib.list({ directory: "转场" }), /先选择/);
  const outside = path.join(base, "私有"); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(source, "链接"));
  assert(!(await browser.branch({ root: root.id })).children.some(c => c.name === "链接"));
  await assert.rejects(browser.branch({ root: root.id, directory: "链接" }), /超出|符号链接/);
});

test("新建真实文件夹：只在登记目录内显式创建，不覆盖文件且不改素材数据", async t => {
  const { lib, browser, root, source, base } = await fixture(t);
  const before = lib.list({}).items;
  const result = await browser.create({ root: root.id, directory: "转场", name: " 新建 目录 " });
  assert.equal(result.directory, "转场/新建 目录");
  assert((await fs.stat(path.join(source, result.directory))).isDirectory());
  assert.equal((await browser.branch({ root: root.id, directory: result.directory })).writable, true);
  assert.equal((await browser.branch({ root: root.id, directory: result.directory })).path, path.join(source, result.directory));
  for (const name of ["", "..", ".隐藏", "a/b", "a\\b", "a:b", "a\n", "长".repeat(100)])
    await assert.rejects(browser.create({ root: root.id, name }), /名称/);
  await assert.rejects(browser.create({ root: root.id, name: "根.wav" }), /同名/);
  await assert.rejects(browser.create({ root: root.id, directory: "转场", name: "新建 目录" }), /同名/);
  await assert.rejects(browser.create({ root: "unknown", name: "新目录" }), /未登记/);
  await assert.rejects(browser.create({ root: root.id, directory: "../", name: "新目录" }), /目录/);
  await assert.rejects(browser.create({ root: root.id, directory: "不存在/父目录", name: "新目录" }));
  await fs.symlink(path.join(source, "转场"), path.join(source, "内部链接"));
  await assert.rejects(browser.create({ root: root.id, directory: "内部链接", name: "禁止创建" }), /符号链接/);
  await fs.symlink(base, path.join(source, "外部链接"));
  await assert.rejects(browser.create({ root: root.id, directory: "外部链接", name: "禁止创建" }), /超出/);
  assert.deepEqual(lib.list({}).items, before);
});

test("新建真实文件夹：原文件只读模式禁止写入", async t => {
  const { browser, root, source } = await fixture(t);
  const previous = process.env.MEDIA_READONLY_FILES;
  process.env.MEDIA_READONLY_FILES = "1";
  try {
    assert.equal((await browser.branch({ root: root.id })).writable, false);
    await assert.rejects(browser.create({ root: root.id, name: "禁止" }), /只读/);
    await assert.rejects(fs.stat(path.join(source, "禁止")), { code: "ENOENT" });
  } finally {
    if (previous === undefined) delete process.env.MEDIA_READONLY_FILES; else process.env.MEDIA_READONLY_FILES = previous;
  }
});
