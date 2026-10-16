import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Library } from "../server/library.mjs";
import { MusicCategories } from "../server/music-categories.mjs";
test("音乐分类创建、改名、归属、删除及空分类持久化，不影响音效与原文件", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "sg-categories-")),
  );
  const source = path.join(base, "音乐");
  await fs.mkdir(source);
  const lib = await new Library(path.join(base, "db")).init();
  lib.enqueue = () => {};
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = await lib.addRoot(source, "music");
  for (const name of ["歌曲.mp3", "音效.wav"])
    await fs.writeFile(path.join(source, name), "unchanged");
  const job = lib.scan(root.id);
  while (job.status === "running") await new Promise((r) => setTimeout(r, 10));
  const song = lib.list().items.find((a) => a.name === "歌曲.mp3"),
    sound = lib.list().items.find((a) => a.name === "音效.wav");
  lib.patch(song.id, { category: "旧分类", tags: ["保留"], note: "保留备注" });
  lib.patch(sound.id, { category: "旧分类", kind: "sfx" });
  const manager = new MusicCategories(lib).init();
  const old = manager.list().find((c) => c.name === "旧分类");
  assert.equal(old.n, 1);
  const empty = manager.create({ name: "空分类" });
  assert.equal(manager.list().find((c) => c.id === empty.id).n, 0);
  assert.equal(
    manager.add({ assetId: song.id, categoryId: empty.id }).added,
    true,
  );
  assert.equal(
    manager.add({ assetId: song.id, categoryId: empty.id }).added,
    false,
  );
  assert.equal(lib.asset(song.id).category, "旧分类");
  assert.equal(manager.members(song.id).length, 2);
  assert.equal(lib.list({ kind: "music", category: "空分类" }).total, 1);
  assert.equal(lib.list({ kind: "music" }).total, 1);
  assert.equal(
    lib.list({ kind: "music" }).categories.find((c) => c.category === "空分类")
      .n,
    1,
  );
  assert.equal(manager.list()[0].totalMusic, 1);
  assert.throws(() => manager.create({ name: "空分类" }), /已存在/);
  assert.throws(() => manager.create({ name: "未分类" }));
  manager.rename(old.id, { name: "新分类" });
  assert.equal(lib.asset(song.id).category, "新分类");
  assert.equal(lib.asset(sound.id).category, "旧分类");
  assert.throws(
    () => manager.assign({ ids: [song.id, sound.id], categoryId: empty.id }),
    /只能调整/,
  );
  assert.equal(lib.asset(song.id).category, "新分类");
  manager.assign({ ids: [song.id], categoryId: empty.id });
  assert.equal(manager.members(song.id).length, 1);
  assert.equal(manager.list().find((c) => c.id === old.id).n, 0);
  manager.remove(empty.id);
  assert.equal(lib.asset(song.id).category, "");
  assert.equal(manager.list()[0].n, 1);
  assert.equal(lib.asset(song.id).note, "保留备注");
  assert.deepEqual(lib.asset(song.id).tags, ["保留"]);
  assert.equal(await fs.readFile(song.path, "utf8"), "unchanged");
  assert.equal(lib.asset(song.id).path, song.path);
  assert.throws(() => manager.remove("uncategorized"), /不存在/);
  assert.equal(
    new MusicCategories(lib)
      .init()
      .list()
      .some((c) => c.id === old.id),
    true,
  );
});
