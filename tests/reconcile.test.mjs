/**
 * 外部整理（访达 / 终端 / 脚本 / GPT 直接改文件系统）后的对账验收。
 *
 * 这些用例就是这次改造要守住的契约：
 *   1. 改名 / 同盘移动 / 整目录移动 → **素材 id、标签、备注、收藏全部不变**，且不产生重复记录
 *   2. 内容相同但 inode 变了（跨盘搬运、复制后删除）→ 用 sha256 认领回原 id
 *   3. 外部新增 → 正常入库；外部删除 → **只标离线，绝不删记录**，清单里留 missing 痕迹
 *   4. 清单损坏 → 挪走留证并从数据库重建，不抛错
 *   5. 监听用的"精简路径对账"能一次调用接上改名；判断不了时明确要求全量
 *   6. 元数据两个方向：默认"数据库 → 清单"镜像；显式 importMetadata 才"清单 → 数据库"
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { manifestPath, readManifest, writeManifest } from "../server/fs-manifest.mjs";
import { readAssetId } from "../server/fs-identity.mjs";
import { reconcilePaths, reconcileRoot } from "../server/reconcile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noHash = { hashBudgetFiles: 0, hashBudgetBytes: 0 };

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-rec-")));
  const source = path.join(base, "素材");
  await fs.mkdir(path.join(source, "子目录"), { recursive: true });
  const lib = await new Library(path.join(base, "db")).init();
  lib.enqueue = () => {}; // 参数读取另有测试；这里只验证身份与元数据
  const root = await lib.addRoot(source, "sfx");
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, source, lib, root };
}

async function scan(lib, root) {
  const job = lib.scan(root.id);
  for (let i = 0; i < 500 && job.status === "running"; i++) await sleep(10);
  assert.equal(job.status, "done", JSON.stringify(job));
  return job;
}

test("外部改名与整目录移动：素材 id 与标签、备注、收藏全部保留", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "甲.wav"), "aaaa");
  await fs.writeFile(path.join(source, "子目录", "乙.wav"), "bbbb");
  await scan(lib, root);
  const jia = lib.list().items.find((a) => a.name === "甲.wav");
  const yi = lib.list().items.find((a) => a.name === "乙.wav");
  lib.patch(jia.id, { tags: ["紧张", "鼓点"], note: "用于片头", favorite: true });
  await reconcileRoot(lib, root, noHash); // 首次对账：把 dev:ino 写进库与清单

  await fs.rename(path.join(source, "甲.wav"), path.join(source, "甲-改名.wav"));
  await fs.rename(path.join(source, "子目录"), path.join(source, "子目录-改名"));
  const report = await reconcileRoot(lib, root, noHash);

  assert.equal(report.added, 0, "改名不应该产生新素材");
  assert.equal(report.missing, 0, "改名不应该把原记录判为失联");
  const after = lib.asset(jia.id);
  assert.equal(after.name, "甲-改名.wav");
  assert.ok(after.path.endsWith("甲-改名.wav"));
  assert.deepEqual(after.tags, ["紧张", "鼓点"]);
  assert.equal(after.note, "用于片头");
  assert.equal(after.favorite, 1);
  assert.ok(lib.asset(yi.id).path.includes("子目录-改名"), lib.asset(yi.id).path);
  assert.equal(lib.list().total, 2, "不应出现重复记录");
  const { manifest } = await readManifest(root);
  assert.deepEqual(manifest.entries[jia.id].tags, ["紧张", "鼓点"], "清单里也应保有标签");
});

test("内容相同但 inode 变了（跨盘搬运）：用 sha256 认领回原 id", async (t) => {
  const { source, lib, root } = await setup(t);
  const original = path.join(source, "跨盘.wav");
  await fs.writeFile(original, "content-for-hash");
  await scan(lib, root);
  const asset = lib.list().items[0];
  lib.patch(asset.id, { tags: ["跨盘标签"] });
  const first = await reconcileRoot(lib, root); // 默认预算会给已认领条目补 sha256
  assert.ok(first.hashed >= 1, "首次对账应补上 sha256");

  // 用"另写一个新文件 + 删掉旧文件"模拟跨盘搬运：新 inode、无 xattr、连名字都变了
  await fs.writeFile(path.join(source, "跨盘-新位置.wav"), "content-for-hash");
  await fs.unlink(original);
  const report = await reconcileRoot(lib, root, noHash);

  assert.equal(report.added, 0, "同一内容不应变成两个素材");
  const after = lib.asset(asset.id);
  assert.equal(after.name, "跨盘-新位置.wav");
  assert.deepEqual(after.tags, ["跨盘标签"]);
  assert.equal(lib.list().total, 1);
});

test("外部新增会入库、外部删除只标离线且绝不删记录，清单保留 missing 痕迹", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "旧.wav"), "old");
  await scan(lib, root);
  const old = lib.list().items[0];

  await fs.writeFile(path.join(source, "新.wav"), "new");
  let report = await reconcileRoot(lib, root, noHash);
  assert.equal(report.added, 1, "外部新增文件应被索引");
  assert.equal(lib.list().total, 2);

  await fs.unlink(path.join(source, "旧.wav"));
  report = await reconcileRoot(lib, root, noHash);
  assert.equal(report.missing, 1);
  const row = lib.db.prepare("SELECT * FROM assets WHERE id=?").get(old.id);
  assert.ok(row, "失联记录必须保留，绝不自动删除");
  assert.equal(row.online, 0);
  const { manifest } = await readManifest(root);
  assert.equal(manifest.entries[old.id].state, "missing");
  assert.ok(manifest.entries[old.id].missingSince);
  assert.equal(lib.list().items.some((a) => a.path.includes(".shiguang")), false, "清单目录本身不该被当成素材");
});

test("清单损坏时降级：挪走坏文件、从数据库重建，不抛错", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "a.wav"), "x");
  await scan(lib, root);
  const asset = lib.list().items[0];
  await fs.mkdir(path.dirname(manifestPath(root)), { recursive: true });
  await fs.writeFile(manifestPath(root), "{ 这不是 JSON");

  const report = await reconcileRoot(lib, root, noHash);
  assert.equal(report.manifestIssue, "unparsable");
  const { manifest } = await readManifest(root);
  assert.ok(manifest.entries[asset.id], "重建的清单应包含原素材");
  const files = await fs.readdir(path.dirname(manifestPath(root)));
  assert.ok(files.some((f) => f.includes(".broken-")), "损坏的清单应留证而不是被丢掉");
});

test("精简路径对账（监听快路径）一次调用即接上外部改名", async (t) => {
  const { source, lib, root } = await setup(t);
  const from = path.join(source, "原名.wav");
  await fs.writeFile(from, "payload");
  await scan(lib, root);
  const asset = lib.list().items[0];
  lib.patch(asset.id, { note: "保留备注" });
  await reconcileRoot(lib, root, noHash);
  await fs.rename(from, path.join(source, "新名.wav"));

  const result = await reconcilePaths(lib, root, ["原名.wav", "新名.wav"]);
  assert.equal(result.vanished, 1);
  assert.equal(result.adopted, 1);
  assert.equal(result.needFullReconcile, false);
  assert.equal(lib.asset(asset.id).name, "新名.wav");
  assert.equal(lib.asset(asset.id).note, "保留备注");
  assert.equal(lib.list().total, 1);
});

test("精简路径判断不了的新文件会明确要求全量对账", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "a.wav"), "a");
  await scan(lib, root);
  await reconcileRoot(lib, root, noHash);
  await fs.writeFile(path.join(source, "brand-new.wav"), "b");
  const result = await reconcilePaths(lib, root, ["brand-new.wav"]);
  assert.equal(result.needFullReconcile, true);
});

test("元数据两个方向：默认镜像到清单，显式 importMetadata 才反向并入", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "m.wav"), "m");
  await scan(lib, root);
  const asset = lib.list().items[0];
  await reconcileRoot(lib, root, noHash);

  // 方向一：清单 → 数据库（模拟 GPT 直接在清单里写标签）
  const { manifest } = await readManifest(root);
  manifest.entries[asset.id].tags = ["GPT打标"];
  manifest.entries[asset.id].note = "外部写入的备注";
  await writeManifest(root, manifest);
  await reconcileRoot(lib, root, { ...noHash, importMetadata: true });
  assert.deepEqual(lib.asset(asset.id).tags, ["GPT打标"]);
  assert.equal(lib.asset(asset.id).note, "外部写入的备注");

  // 方向二：数据库 → 清单（界面里改的东西必须回到清单，否则下次对账会被旧清单覆盖）
  lib.patch(asset.id, { note: "界面里改的" });
  await reconcileRoot(lib, root, noHash);
  const again = (await readManifest(root)).manifest;
  assert.equal(again.entries[asset.id].note, "界面里改的");
});

test("同名同大小但其中一个文件已丢失时绝不误配（回归：曾撞 MySQL path 唯一约束）", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.mkdir(path.join(source, "A"), { recursive: true });
  await fs.mkdir(path.join(source, "B"), { recursive: true });
  await fs.writeFile(path.join(source, "A", "同名.wav"), "same-content");
  await fs.writeFile(path.join(source, "B", "同名.wav"), "same-content");
  await scan(lib, root);
  await reconcileRoot(lib, root, noHash); // 清单里此时是相对路径，第一级匹配即可命中
  assert.equal(lib.list().total, 2);

  await fs.unlink(path.join(source, "A", "同名.wav")); // 外部只删掉 A 里的那个
  const report = await reconcileRoot(lib, root, noHash);

  assert.equal((report.conflicts || []).filter((c) => c.code === "PATH_OWNED").length, 0, "不应发生路径抢占");
  assert.equal(lib.list().total, 2, "记录数不应变化");
  const rows = lib.db.prepare("SELECT id,path,online FROM assets ORDER BY path").all();
  const paths = rows.map((r) => r.path);
  assert.equal(new Set(paths).size, paths.length, "路径绝不能重复（否则 MySQL 会直接报唯一约束）");
  const a = rows.find((r) => r.path.includes("/A/"));
  const b = rows.find((r) => r.path.includes("/B/"));
  assert.equal(a.online, 0, "文件没了的记录应如实标离线");
  assert.equal(b.online, 1, "文件还在的记录保持在线");
  assert.equal(lib.asset(b.id).path.endsWith("/B/同名.wav"), true, "B 记录不能被改到别处");
});

test("数据库丢失后按清单恢复：标签与备注不丢（清单是唯一副本）", async (t) => {
  const { base, source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "r.wav"), "payload");
  await scan(lib, root);
  const asset = lib.list().items[0];
  lib.patch(asset.id, { tags: ["清单里有"], note: "这是唯一副本" });
  await reconcileRoot(lib, root, noHash); // 元数据落到清单

  // 模拟数据库丢失：换一个全新的空数据目录，重新登记同一个根（扫描会生成新 id）
  const fresh = await new Library(path.join(base, "db2")).init();
  fresh.enqueue = () => {};
  const freshRoot = await fresh.addRoot(source, "sfx");
  const job = fresh.scan(freshRoot.id);
  for (let i = 0; i < 500 && job.status === "running"; i++) await sleep(10);
  assert.deepEqual(fresh.list().items[0].tags, [], "新库初始没有标签");

  const report = await reconcileRoot(fresh, freshRoot, noHash);
  assert.ok(report.recovered >= 1, "应识别出清单条目对应的数据库行已丢失");
  const after = fresh.list().items[0];
  assert.deepEqual(after.tags, ["清单里有"], "标签应从清单恢复");
  assert.equal(after.note, "这是唯一副本");
  fresh.db.close();
});

test("darwin 下把素材 id 写进文件扩展属性（同盘移动与复制都能带走）", { skip: process.platform !== "darwin" }, async (t) => {
  const { source, lib, root } = await setup(t);
  const file = path.join(source, "x.wav");
  await fs.writeFile(file, "x");
  await scan(lib, root);
  const asset = lib.list().items[0];
  await reconcileRoot(lib, root, noHash);
  assert.equal(await readAssetId(file), asset.id);
});
