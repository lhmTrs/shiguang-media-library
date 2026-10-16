import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library, run, creationDay, fileCreated } from "../server/library.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("访达成功定位累计、失败不计数、降序分页和重扫及重启保留", async (t) => {
  const { source, lib, root, base } = await setup(t);
  for (const name of ["甲.mp3", "乙.mp3", "丙.mp3"])
    await fs.writeFile(path.join(source, name), "fixture");
  await scan(lib, root);
  const songs = lib.list().items;
  assert.ok(songs.every(a => a.reveal_count === 0));
  const a = songs.find(a => a.name === "甲.mp3"), b = songs.find(a => a.name === "乙.mp3");
  let calls = 0;
  const open = async p => { assert.equal(p, a.path); calls++; };
  await Promise.all([lib.reveal(a.id, open), lib.reveal(a.id, open)]);
  assert.equal(calls, 2);
  await lib.reveal(b.id, async () => {});
  await assert.rejects(lib.reveal(a.id, async () => { throw Error("打开访达失败"); }), /打开访达失败/);
  assert.equal(lib.asset(a.id).reveal_count, 2);
  assert.equal(lib.list({ sort: "revealCount" }).items[0].id, a.id);
  assert.equal(lib.list({ sort: "revealCount", q: "乙" }).items[0].reveal_count, 1);
  lib.patch(a.id, { reveal_count: 99, note: "保留计数" });
  assert.equal(lib.asset(a.id).reveal_count, 2);
  const plans = await lib.plan({ ids: [a.id], action: "rename", name: "改名甲.mp3" });
  await lib.execute({ ids: [a.id], action: "rename", name: "改名甲.mp3" }, plans);
  assert.equal(lib.asset(a.id).reveal_count, 2);
  await scan(lib, root);
  assert.equal(lib.asset(a.id).reveal_count, 2);
  await fs.unlink(b.path);
  await assert.rejects(lib.reveal(b.id, async () => { throw Error("不应执行"); }));
  assert.equal(lib.asset(b.id).reveal_count, 1);
  lib.db.close();
  const reopened = await new Library(path.join(base, "db")).init();
  lib.db = reopened.db;
  reopened.enqueue = () => {};
  assert.equal(reopened.asset(a.id).reveal_count, 2);
  assert.equal(reopened.list({ sort: "revealCount" }).items[0].id, a.id);
});

test("分类动态只统计音乐/音效，排除空分类与已删除素材，跟随筛选但不锁住自身", async (t) => {
  const { source, dest, lib, root, target } = await setup(t);
  for (const name of [
    "音乐.mp3",
    "风声.wav",
    "画面.mp4",
    "照片.jpg",
    "待删除.wav",
    "空分类.wav",
  ])
    await fs.writeFile(path.join(source, name), "fixture");
  await fs.writeFile(path.join(dest, "其他.wav"), "fixture");
  await scan(lib, root);
  await scan(lib, target);
  const files = lib.list().items;
  for (const a of files)
    lib.patch(a.id, {
      category: {
        "音乐.mp3": "音乐类",
        "风声.wav": "环境类",
        "画面.mp4": "视频专用",
        "照片.jpg": "照片专用",
        "待删除.wav": "已删除类",
        "空分类.wav": "   ",
        "其他.wav": "其他目录类",
      }[a.name],
      ...(a.name === "音乐.mp3" ? { kind: "music", favorite: true } : {}),
    });
  lib.db.prepare("UPDATE assets SET trashed=1 WHERE name=?").run("待删除.wav");
  const names = (q) => lib.categoryOptions(q).map((c) => c.category);
  assert.deepEqual(
    new Set(names({})),
    new Set(["音乐类", "环境类", "其他目录类"]),
  );
  assert.deepEqual(names({ kind: "music" }), ["音乐类"]);
  assert.deepEqual(names({ root: target.id }), ["其他目录类"]);
  assert.deepEqual(
    new Set(names({ root: [root.id, target.id], category: "音乐类" })),
    new Set(["音乐类", "环境类", "其他目录类"]),
  );
  assert.deepEqual(names({ favorite: "1" }), ["音乐类"]);
  assert.deepEqual(names({ q: "风声" }), ["环境类"]);
  assert.deepEqual(names({ kind: "video" }), []);
  assert.deepEqual(names({ page: "2", category: "音乐类" }), names({}));
  const sound = files.find((a) => a.name === "风声.wav");
  lib.db
    .prepare("UPDATE assets SET created_ms=?,duration=? WHERE id=?")
    .run(1791734400000, 4, sound.id);
  assert.deepEqual(
    names({
      root: root.id,
      createdFrom: "2026-10-12",
      createdTo: "2026-10-12",
      duration: "short",
      ext: "wav",
    }),
    ["环境类"],
  );
  lib.patch(sound.id, { category: "新环境类" });
  assert.equal(names({}).includes("环境类"), false);
  assert.equal(names({}).includes("新环境类"), true);
  assert.deepEqual(
    lib.list({ kind: "music" }).categories,
    lib.categoryOptions({ kind: "music" }),
  );
});

test("素材目录多选合并、单选兼容、组合筛选和参数安全", async (t) => {
  const { source, dest, lib, root, target } = await setup(t);
  await fs.writeFile(path.join(source, "风声.wav"), "fixture");
  await fs.writeFile(path.join(dest, "音乐.mp3"), "fixture");
  await scan(lib, root);
  await scan(lib, target);
  assert.equal(lib.list({ root: root.id }).total, 1);
  assert.equal(lib.list({ root: [root.id, target.id] }).total, 2);
  assert.equal(lib.list({ root: [root.id, root.id] }).total, 1);
  assert.equal(
    lib.list({ root: [root.id, target.id], ext: "wav", q: "风" }).total,
    1,
  );
  assert.equal(lib.list({ root: ["不存在"] }).total, 0);
  assert.equal(lib.list({ root: ["' OR 1=1 --"] }).total, 0);
  assert.equal(lib.list({ root: [] }).total, 2);
  assert.throws(() => lib.list({ root: { id: root.id } }), /参数无效/);
});

test("创建日期边界、组合筛选、单边筛选、未知时间和日期校验", async (t) => {
  const { source, lib, root } = await setup(t);
  for (const name of [
    "前一天.wav",
    "当天开始.wav",
    "当天结束.wav",
    "第二天.wav",
    "未知.wav",
  ])
    await fs.writeFile(path.join(source, name), "date fixture");
  await scan(lib, root);
  const start = creationDay("2026-10-13");
  const dates = {
    "前一天.wav": start - 1,
    "当天开始.wav": start,
    "当天结束.wav": start + 86400000 - 1,
    "第二天.wav": start + 86400000,
    "未知.wav": null,
  };
  for (const a of lib.list().items)
    lib.db
      .prepare("UPDATE assets SET created_ms=? WHERE id=?")
      .run(dates[a.name], a.id);
  const day = lib.list({ createdFrom: "2026-10-13", createdTo: "2026-10-13" });
  assert.equal(day.total, 2);
  assert.deepEqual(
    new Set(day.items.map((a) => a.name)),
    new Set(["当天开始.wav", "当天结束.wav"]),
  );
  assert.equal(lib.list({ createdFrom: "2026-10-13" }).total, 3);
  assert.equal(lib.list({ createdTo: "2026-10-13" }).total, 3);
  assert.equal(
    lib.list({
      q: "结束",
      kind: "sfx",
      root: root.id,
      createdFrom: "2026-10-13",
      createdTo: "2026-10-13",
    }).total,
    1,
  );
  assert.equal(lib.list({ createdFrom: "2026-10-15" }).total, 0);
  assert.equal(lib.list({ sort: "createdNewest" }).items[0].name, "第二天.wav");
  assert.equal(
    lib.list({ sort: "createdOldest" }).items.at(-1).name,
    "未知.wav",
  );
  assert.throws(
    () => lib.list({ createdFrom: "2026-10-14", createdTo: "2026-10-13" }),
    /晚于/,
  );
  for (const bad of [
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "not-a-date",
    "2026-1-1",
  ])
    assert.throws(() => creationDay(bad), /日期/);
  assert.ok(Number.isFinite(creationDay("2024-02-29")));
  assert.equal(fileCreated({ birthtimeMs: 0, mtimeMs: 123 }), null);
});

test("旧数据库安全迁移、创建时间回填、重扫更新且保留标签", async (t) => {
  const { source, lib, root } = await setup(t);
  const p = path.join(source, "时间测试.wav");
  await fs.writeFile(p, "fixture");
  await fs.utimes(p, new Date("2040-01-01"), new Date("2040-01-01"));
  await scan(lib, root);
  const a = lib.list().items[0];
  const actual = (await fs.stat(p)).birthtimeMs;
  assert.equal(a.created_ms, actual);
  assert.notEqual(a.created_ms, a.mtime);
  lib.patch(a.id, { tags: ["保留标签"], favorite: 1 });
  lib.db.exec(
    "DROP INDEX assets_created; ALTER TABLE assets DROP COLUMN created_ms",
  );
  lib.db.close();
  const reopened = await new Library(lib.dataDir).init();
  lib.db = reopened.db;
  assert.equal(lib.asset(a.id).created_ms, actual);
  assert.deepEqual(lib.asset(a.id).tags, ["保留标签"]);
  assert.equal(lib.asset(a.id).favorite, 1);
  lib.db.prepare("UPDATE assets SET created_ms=NULL WHERE id=?").run(a.id);
  await scan(lib, root);
  assert.equal(lib.asset(a.id).created_ms, actual);
});
async function setup(t) {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-test-")),
  );
  const source = path.join(base, "摄影 音效"),
    dest = path.join(base, "目标");
  await fs.mkdir(source);
  await fs.mkdir(dest);
  const lib = await new Library(path.join(base, "db")).init();
  // Metadata processing is tested separately; file safety tests use small fixtures.
  lib.enqueue = () => {};
  const root = await lib.addRoot(source, "sfx"),
    target = await lib.addRoot(dest, "mixed");
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, source, dest, lib, root, target };
}
async function scan(lib, root, c) {
  const j = lib.scan(root.id, c);
  for (let n = 0; n < 500 && j.status === "running"; n++) await sleep(10);
  assert.equal(j.status, "done", JSON.stringify(j));
  return j;
}

test("真实扫描、中文分类、标签搜索、重扫保留元数据及禁止重复目录", async (t) => {
  const { source, dest, lib, root } = await setup(t);
  const p = path.join(source, "风声 中文.mp3");
  await fs.writeFile(p, "fixture");
  await fs.writeFile(path.join(source, ".隐藏.mp3"), "hidden");
  await fs.writeFile(path.join(source, "笔记.txt"), "ignored");
  await fs.writeFile(path.join(dest, "外部.mp3"), "external");
  await fs.symlink(path.join(dest, "外部.mp3"), path.join(source, "链接.mp3"));
  await scan(
    lib,
    root,
    new Map([
      [
        p,
        {
          category: "07_环境自然与动物",
          sub: "风声",
          basis: "未试听",
          review: true,
        },
      ],
    ]),
  );
  assert.equal(lib.stats().total, 1);
  const a = lib.list().items[0];
  assert.equal(a.review, 1);
  lib.patch(a.id, {
    tags: ["夜景", "转场", "夜景"],
    note: "广告第一镜",
    favorite: 1,
  });
  assert.equal(lib.list({ q: "夜景" }).total, 1);
  assert.equal(lib.list({ view: "favorites" }).total, 1);
  assert.deepEqual(lib.asset(a.id).tags, ["夜景", "转场"]);
  lib.patch(a.id, { confirmed: 1 });
  assert.equal(lib.stats().review, 0);
  await scan(lib, root);
  assert.equal(lib.asset(a.id).favorite, 1);
  assert.equal(lib.stats().total, 1);
  await assert.rejects(
    () => lib.addRoot(path.dirname(source)),
    /重叠|数据目录/,
  );
  await assert.rejects(
    () => lib.checked(path.join(source, "链接.mp3"), root.id),
    /超出/,
  );
  lib.db.close();
  const reopened = await new Library(lib.dataDir).init();
  assert.equal(reopened.asset(a.id).note, "广告第一镜");
  reopened.db.close();
  lib.db = new (await import("better-sqlite3")).default(
    path.join(lib.dataDir, "library.sqlite"),
  );
});

test("改名、移动、冲突拒绝、路径越界和逐项结果", async (t) => {
  const { source, dest, lib, root, target } = await setup(t);
  await fs.writeFile(path.join(source, "原始.mp3"), "abc");
  await fs.writeFile(path.join(source, "已存在.mp3"), "keep");
  await scan(lib, root);
  const a = lib.list({ q: "原始" }).items[0];
  const conflict = await lib.execute({
    ids: [a.id],
    action: "rename",
    name: "已存在.mp3",
  });
  assert.equal(conflict[0].ok, false);
  assert.equal(
    await fs.readFile(path.join(source, "已存在.mp3"), "utf8"),
    "keep",
  );
  const rename = await lib.execute({
    ids: [a.id],
    action: "rename",
    name: "修改 后.mp3",
  });
  assert.equal(rename[0].ok, true);
  assert.equal(
    await fs.readFile(path.join(source, "修改 后.mp3"), "utf8"),
    "abc",
  );
  const unsafe = await lib.plan({
    ids: [a.id],
    action: "move",
    rootId: target.id,
    relative: "../越界",
  });
  assert.equal(unsafe[0].ok, false);
  const move = await lib.execute({
    ids: [a.id],
    action: "move",
    rootId: target.id,
    relative: "",
  });
  assert.equal(move[0].ok, true);
  assert.equal(lib.asset(a.id).root_id, target.id);
  await assert.rejects(() => lib.undo(rename[0].operation), /后续/);
  await lib.undo(move[0].operation);
  await lib.undo(rename[0].operation);
  assert.equal(await fs.readFile(path.join(source, "原始.mp3"), "utf8"), "abc");
  assert.equal(lib.asset(a.id).root_id, root.id);
  assert.equal((await fs.readdir(dest)).length, 0);
});

test("确认后源文件变化拒绝执行，移动目标重名不覆盖", async (t) => {
  const { source, dest, lib, root, target } = await setup(t);
  const p = path.join(source, "片段.mp4");
  await fs.writeFile(p, "video");
  await scan(lib, root);
  const a = lib.list().items[0];
  const input = { ids: [a.id], action: "rename", name: "新片段.mp4" };
  const plan = await lib.plan(input);
  await fs.writeFile(p, "changed-video");
  const result = await lib.execute(input, plan);
  assert.equal(result[0].ok, false);
  assert.match(result[0].error, /变化/);
  assert.equal(await fs.readFile(p, "utf8"), "changed-video");
  await fs.writeFile(path.join(dest, "片段.mp4"), "do not overwrite");
  const moved = await lib.execute({
    ids: [a.id],
    action: "move",
    rootId: target.id,
  });
  assert.equal(moved[0].ok, false);
  assert.equal(
    await fs.readFile(path.join(dest, "片段.mp4"), "utf8"),
    "do not overwrite",
  );
});

test("离线保留索引、参数变化重新读取、损坏媒体错误可见", async (t) => {
  const { source, lib, root } = await setup(t);
  const p = path.join(source, "损坏.mp3");
  await fs.writeFile(p, "not audio");
  await scan(lib, root);
  const a = lib.list().items[0];
  await lib.probe(a.id);
  assert.equal(lib.asset(a.id).probe, "error");
  assert.match(lib.asset(a.id).error, /失败/);
  await fs.writeFile(p, "new damaged file");
  await scan(lib, root);
  assert.equal(lib.asset(a.id).probe, "pending");
  await fs.rename(source, source + "-offline");
  const j = lib.scan(root.id);
  for (let n = 0; n < 100 && j.status === "running"; n++) await sleep(10);
  assert.equal(j.status, "failed");
  assert.equal(lib.list({ view: "offline" }).total, 1);
  assert.equal(lib.stats().total, 1);
  await fs.rename(source + "-offline", source);
  await scan(lib, root);
  assert.equal(lib.asset(a.id).online, 1);
});

test("FFprobe读取真实音频时长", async (t) => {
  const { source, lib, root } = await setup(t);
  const p = path.join(source, "测试正弦.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1.5",
    p,
  ]);
  await scan(lib, root);
  const a = lib.list().items[0];
  await lib.probe(a.id);
  assert.equal(lib.asset(a.id).probe, "ready");
  assert.ok(Math.abs(lib.asset(a.id).duration - 1.5) < 0.01);
});

test("批量部分失败、只读目标目录和符号链接目标不影响源文件", async (t) => {
  const { source, dest, base, lib, root, target } = await setup(t);
  await fs.writeFile(path.join(source, "甲.wav"), "a");
  await fs.writeFile(path.join(source, "乙.wav"), "b");
  await scan(lib, root);
  const items = lib.list().items;
  await fs.writeFile(path.join(dest, "甲.wav"), "existing");
  const result = await lib.execute({
    ids: items.map((a) => a.id),
    action: "move",
    rootId: target.id,
  });
  assert.equal(result.filter((r) => r.ok).length, 1);
  assert.equal(result.filter((r) => !r.ok).length, 1);
  assert.equal(
    await fs.readFile(path.join(dest, "甲.wav"), "utf8"),
    "existing",
  );
  const a = items.find((a) => a.name === "甲.wav");
  await fs.mkdir(path.join(base, "outside"));
  await fs.symlink(path.join(base, "outside"), path.join(dest, "越界链接"));
  const unsafe = await lib.plan({
    ids: [a.id],
    action: "move",
    rootId: target.id,
    relative: "越界链接",
  });
  assert.equal(unsafe[0].ok, false);
  if (process.getuid?.() !== 0) {
    await fs.mkdir(path.join(dest, "只读"));
    await fs.chmod(path.join(dest, "只读"), 0o555);
    const denied = await lib.execute({
      ids: [a.id],
      action: "move",
      rootId: target.id,
      relative: "只读",
    });
    assert.equal(denied[0].ok, false);
    await fs.chmod(path.join(dest, "只读"), 0o755);
    await fs.access(path.join(source, a.name));
  }
});

test(
  "原生废纸篓与恢复，只使用测试副本",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { source, base, lib, root } = await setup(t);
    const helper = path.join(base, "trash-helper");
    await run(
      "swiftc",
      [
        fileURLToPath(new URL("../server/trash.swift", import.meta.url)),
        "-o",
        helper,
      ],
      { timeout: 90000 },
    );
    lib.trashBin = helper;
    const name = "拾光测试-" + Date.now() + ".wav",
      p = path.join(source, name);
    await fs.writeFile(p, "trash fixture");
    await scan(lib, root);
    const a = lib.list().items[0];
    const result = await lib.execute({ ids: [a.id], action: "trash" });
    assert.equal(result[0].ok, true, JSON.stringify(result));
    assert.equal(lib.asset(a.id).trashed, 1);
    assert.equal(lib.stats().total, 0);
    const op = lib.db
      .prepare("SELECT * FROM operations WHERE id=?")
      .get(result[0].operation);
    assert.match(op.target, /\.Trash/);
    t.after(() => fs.unlink(op.target).catch(() => {}));
    await fs.writeFile(p, "conflict");
    await assert.rejects(() => lib.undo(op.id));
    assert.equal(await fs.readFile(p, "utf8"), "conflict");
    await fs.unlink(p);
    await lib.undo(op.id);
    assert.equal(lib.asset(a.id).trashed, 0);
    assert.equal(await fs.readFile(p, "utf8"), "trash fixture");
  },
);
