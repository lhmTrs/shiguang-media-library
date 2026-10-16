import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library, run } from "../server/library.mjs";
import { MusicCategories } from "../server/music-categories.mjs";
test("新音乐目录中的音频 MP4 与 NCM 入库并计入分类，重扫保留人工类型和分类", async (t) => {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "sg-music-import-")),
  );
  const source = path.join(base, "音乐"),
    folder = path.join(source, "新分类");
  await fs.mkdir(folder, { recursive: true });
  const p = path.join(folder, "歌曲.mp4");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    "aac",
    p,
  ]);
  await fs.writeFile(path.join(folder, "加密歌曲.ncm"), "fixture");
  await fs.copyFile(p, path.join(source, "根目录音乐.mp4"));
  const lib = await new Library(path.join(base, "data")).init();
  lib.enqueue = () => {};
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const root = await lib.addRoot(source, "music");
  async function scan() {
    const j = lib.scan(root.id);
    while (j.status === "running") await new Promise((r) => setTimeout(r, 10));
    assert.equal(j.status, "done");
  }
  await scan();
  let assets = lib.list().items;
  const mp4 = assets.find((a) => a.name === "歌曲.mp4"),
    ncm = assets.find((a) => a.ext === "ncm");
  assert.ok(ncm);
  await lib.probe(mp4.id);
  await lib.probe(ncm.id);
  const direct = assets.find((a) => a.name === "根目录音乐.mp4");
  await lib.probe(direct.id);
  assert.equal(lib.asset(direct.id).category, "音乐");
  assert.equal(lib.asset(mp4.id).kind, "music");
  assert.equal(lib.asset(ncm.id).probe, "error");
  assert.match(lib.asset(ncm.id).error, /NCM/);
  const manager = new MusicCategories(lib).init();
  assert.equal(manager.list().find((c) => c.name === "新分类").n, 2);
  lib.patch(mp4.id, { kind: "video", category: "人工分类", note: "保留" });
  await scan();
  await lib.probe(mp4.id);
  assert.equal(lib.asset(mp4.id).kind, "video");
  assert.equal(lib.asset(mp4.id).category, "人工分类");
  assert.equal(lib.asset(mp4.id).note, "保留");
  lib.db
    .prepare(
      "UPDATE assets SET basis='原音乐目录分类',probe='ready' WHERE id=?",
    )
    .run(mp4.id);
  await scan();
  assert.equal(lib.asset(mp4.id).probe, "pending");
  await lib.probe(mp4.id);
  assert.equal(lib.asset(mp4.id).kind, "music");
  assert.equal(lib.asset(mp4.id).category, "人工分类");
  assert.ok((await fs.stat(p)).size > 0);
});
