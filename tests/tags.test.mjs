import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Library } from "../server/library.mjs";
import { Tags } from "../server/tags.mjs";
test("标签导入、精确匹配、空标签、批量增删、改名及删除不影响素材文件", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "sg-tags-")),
  );
  const source = path.join(base, "素材");
  await fs.mkdir(source);
  const lib = await new Library(path.join(base, "data")).init();
  lib.enqueue = () => {};
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(source, "音乐.mp3"), "fixture");
  await fs.writeFile(path.join(source, "照片.jpg"), "fixture");
  const root = await lib.addRoot(source, "mixed"),
    job = lib.scan(root.id);
  while (job.status === "running") await new Promise((r) => setTimeout(r, 10));
  const [a, b] = lib.list().items;
  lib.patch(a.id, { tags: ["风", "大风"], note: "备注保留" });
  const manager = new Tags(lib).init();
  assert.equal(manager.list().find((t) => t.name === "风").n, 1);
  assert.equal(lib.list({ tagName: "风" }).total, 1);
  const tag = manager.create({ name: "测试标签" });
  assert.equal(manager.list().find((t) => t.id === tag.id).n, 0);
  assert.throws(() => manager.create({ name: "测试标签" }), /已存在/);
  manager.apply({ ids: [a.id, b.id], tagId: tag.id, action: "add" });
  manager.apply({ ids: [a.id], tagId: tag.id, action: "add" });
  assert.equal(lib.asset(a.id).tags.filter((t) => t === "测试标签").length, 1);
  assert.equal(manager.list().find((t) => t.id === tag.id).n, 2);
  manager.rename(tag.id, { name: "已改名" });
  assert.equal(lib.list({ tagName: "已改名" }).total, 2);
  assert.equal(lib.list({ tagName: "测试标签" }).total, 0);
  manager.apply({ ids: [a.id], tagId: tag.id, action: "remove" });
  assert.equal(lib.asset(a.id).tags.includes("风"), true);
  manager.remove(tag.id);
  assert.equal(lib.list({ untagged: "1" }).total, 1);
  assert.equal(lib.asset(a.id).note, "备注保留");
  assert.equal(await fs.readFile(a.path, "utf8"), "fixture");
  const literal = manager.create({ name: '%_"标签' });
  manager.apply({ ids: [b.id], tagId: literal.id, action: "add" });
  assert.equal(lib.list({ tagName: '%_"标签' }).total, 1);
  assert.throws(() =>
    manager.apply({ ids: [a.id, "missing"], tagId: literal.id, action: "add" }),
  );
  assert.equal(lib.asset(a.id).tags.includes(literal.name), false);
});
