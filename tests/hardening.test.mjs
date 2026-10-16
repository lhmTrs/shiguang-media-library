/**
 * 加固测试：守住"身份误认、并发、目录边界"这三类此前只覆盖了正常流程的失效面。
 * 每一条都对应一个已实测复现的问题，所以这里是回归防线，不是补充覆盖率。
 *
 *   ① SQLite→MySQL 迁移：哈希类列必须是可索引的短类型（否则 1170 打挂启动）
 *   ② 同名同大小但内容不同：只能"提示疑似"，绝不能自动继承旧 id 与标签
 *   ③ .shiguang 为符号链接时不得写到登记目录之外
 *   ④ 并发写清单不得互相踩临时文件（此前固定 tmp 名 → ENOENT）
 *   ⑤ 目录改名事件必须触发全量对账（此前被当作"没事发生"跳过）
 *   ⑥ 已搬走的根目录不得被重新创建、也不得误判为在线
 *   ⑦ MEDIA_READONLY_FILES=1 时不得写登记目录里的任何东西
 *   ⑧ 分享包白名单必须包含文档里介绍的维护脚本
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library, indexTargetColumns } from "../server/library.mjs";
import { mysqlColumnType } from "../server/mysql.mjs";
import { manifestPath, readManifest, writeManifest } from "../server/fs-manifest.mjs";
import { reconcilePaths, reconcileRoot } from "../server/reconcile.mjs";
import { shareFiles } from "../scripts/package.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t, kind = "sfx") {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-hard-")));
  const dir = path.join(base, "素材目录");
  await fs.mkdir(dir, { recursive: true });
  const lib = await new Library(path.join(base, "db")).init();
  lib.enqueue = () => {};
  const root = await lib.addRoot(dir, kind);
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dir, lib, root };
}

async function scan(lib, root) {
  const job = lib.scan(root.id);
  for (let i = 0; i < 500 && job.status === "running"; i++) await sleep(10);
  assert.equal(job.status, "done", JSON.stringify(job));
}

test("① MySQL 类型映射：哈希类列是可索引的短类型，整数仍是 BIGINT", () => {
  assert.equal(mysqlColumnType("assets", { name: "sha256", type: "TEXT" }), "VARCHAR(64)");
  assert.equal(mysqlColumnType("openai_diagnostics", { name: "cache_hash", type: "TEXT" }), "VARCHAR(64)");
  assert.equal(mysqlColumnType("assets", { name: "dev", type: "INTEGER" }), "BIGINT");
  assert.equal(mysqlColumnType("assets", { name: "ino", type: "INTEGER" }), "BIGINT");
  assert.equal(mysqlColumnType("assets", { name: "note", type: "TEXT" }), "LONGTEXT");
  assert.equal(mysqlColumnType("assets", { name: "id", type: "TEXT" }), "VARCHAR(36) PRIMARY KEY");
});

test("①b 索引降级规则：TEXT/BLOB 列自动加前缀长度（MySQL 1170 的兜底）", () => {
  const types = new Map([
    ["sha256", "longtext"],
    ["dev", "bigint"],
    ["note", "text"],
  ]);
  assert.equal(indexTargetColumns("dev,ino", types), "dev,ino");
  assert.equal(indexTargetColumns("sha256", types), "sha256(32)");
  assert.equal(indexTargetColumns("dev, sha256", types), "dev,sha256(32)");
  assert.equal(indexTargetColumns("path", new Map()), "path");
});

test("② 同名同大小但内容不同：只提示疑似，绝不自动继承旧身份与标签", async (t) => {
  const { dir, lib, root } = await setup(t);
  await fs.mkdir(path.join(dir, "A"));
  await fs.mkdir(path.join(dir, "B"));
  await fs.writeFile(path.join(dir, "A", "同名.wav"), "AAAA");
  await scan(lib, root);
  await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });
  const old = lib.list().items[0];
  lib.patch(old.id, { tags: ["旧标签"], note: "旧备注" });

  await fs.unlink(path.join(dir, "A", "同名.wav"));
  await fs.writeFile(path.join(dir, "B", "同名.wav"), "BBBB"); // 同名同大小、内容不同
  const report = await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });

  const items = lib.list().items;
  assert.equal(items.length, 2, "旧记录保留 + 新文件成为新素材");
  const fresh = items.find((a) => a.path.includes("/B/"));
  assert.deepEqual(fresh.tags, [], "新文件绝不能继承旧标签");
  assert.equal(fresh.note, "", "新文件绝不能继承旧备注");
  assert.notEqual(fresh.id, old.id);
  assert.equal(lib.asset(old.id).online, 0, "原位置的文件已不在，应如实标离线");
  assert.deepEqual(lib.asset(old.id).tags, ["旧标签"], "旧记录的标签仍在（只是没被错误挂到别人身上）");
  assert.equal(report.suspected, 1, "应记为疑似而非认领");
  assert.equal(report.suspectedClaims.length, 1);
});

test("②b 显式开启 adoptSuspected 后才允许启发式认领（保留逃生口）", async (t) => {
  const { dir, lib, root } = await setup(t);
  await fs.writeFile(path.join(dir, "甲.wav"), "AAAA");
  await scan(lib, root);
  // tagFiles:false + 不补哈希 → 第 1~4 级都没有证据，只能落到第 5 级
  await reconcileRoot(lib, root, { tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0 });
  const old = lib.list().items[0];
  lib.patch(old.id, { tags: ["保留"] });
  await fs.unlink(path.join(dir, "甲.wav"));
  await fs.mkdir(path.join(dir, "移到别处"));
  await fs.writeFile(path.join(dir, "移到别处", "甲.wav"), "BBBB"); // 同名同大小、新 inode、无 xattr、无哈希

  const dry = await reconcileRoot(lib, root, { tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0 });
  assert.equal(dry.suspected, 1, "默认只提示，不认领");
  const fresh = lib.list().items.find((a) => a.path.includes("移到别处"));
  assert.ok(fresh, "默认情况下新位置的文件作为新素材入库");
  assert.deepEqual(fresh.tags, [], "默认绝不能让新文件继承旧标签");

  // 清掉清单里那条新条目与库里的行，回到"只有旧记录 + 一个同名同大小文件"的状态，
  // 然后显式开启逃生口：此时应改为跟随移动，而不是新增记录。
  const { manifest } = await readManifest(root);
  delete manifest.entries[fresh.id];
  await writeManifest(root, manifest);
  lib.db.prepare("DELETE FROM assets WHERE id=?").run(fresh.id);
  const adopted = await reconcileRoot(lib, root, { tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0, adoptSuspected: true });
  assert.equal(adopted.suspected, 1);
  assert.equal(adopted.added, 0, "开启后由启发式认领，不再新增记录");
  assert.equal(lib.list().total, 1);
  assert.ok(lib.asset(old.id).path.includes("移到别处"), "显式开启后才跟随移动");
  assert.deepEqual(lib.asset(old.id).tags, ["保留"]);
});

test("③ .shiguang 是指向目录外的符号链接时拒绝写入", async (t) => {
  const { base, dir, lib, root } = await setup(t);
  await fs.writeFile(path.join(dir, "a.wav"), "x");
  const outside = path.join(base, "目录外");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(dir, ".shiguang"));

  await assert.rejects(() => writeManifest(root, { entries: {}, revision: 1 }), /符号链接/);
  assert.equal(
    await fs.access(path.join(outside, "manifest.json")).then(() => true).catch(() => false),
    false,
    "绝不能在登记目录之外生成清单",
  );
  // 对账本身仍要能跑完（只记 manifestWriteError，不影响索引）
  const report = await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });
  assert.ok(report.manifestWriteError, "应记录清单写入失败");
  assert.equal(await fs.access(path.join(outside, "manifest.json")).then(() => true).catch(() => false), false);
});

test("④ 并发写同一份清单：不互相踩临时文件，version 单调且无残留", async (t) => {
  const { dir, root } = await setup(t);
  await fs.writeFile(path.join(dir, "a.wav"), "x");
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => writeManifest(root, { entries: { [`e${i}`]: { relPath: `f${i}.wav` } }, revision: i })),
  );
  const rejected = results.filter((r) => r.status === "rejected");
  assert.deepEqual(rejected.map((r) => String(r.reason?.code || r.reason?.message)), [], "不应有任何一次失败");
  const { manifest, reason } = await readManifest(root);
  assert.equal(reason, "ok");
  assert.ok(manifest.revision >= 9, `revision 应单调不减，实际 ${manifest.revision}`);
  const leftovers = (await fs.readdir(path.join(dir, ".shiguang"))).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "不应残留临时文件");
});

test("⑤ 目录改名事件必须要求全量对账（否则路径会停在旧位置）", async (t) => {
  const { dir, lib, root } = await setup(t);
  await fs.mkdir(path.join(dir, "子目录"));
  await fs.writeFile(path.join(dir, "子目录", "a.wav"), "x");
  await scan(lib, root);
  await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });

  await fs.rename(path.join(dir, "子目录"), path.join(dir, "改名后"));
  const report = await reconcilePaths(lib, root, ["子目录", "改名后"]);
  assert.equal(report.needFullReconcile, true, "目录事件必须要求全量对账");
  await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });
  assert.ok(lib.list().items[0].path.includes("改名后"), "全量对账后路径应更新");
});

test("⑥ 已搬走的根：不重建旧目录、不误判在线、不写清单", async (t) => {
  const { dir, lib, root } = await setup(t);
  await fs.writeFile(path.join(dir, "a.wav"), "x");
  await scan(lib, root);
  await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });
  assert.ok(await fs.access(manifestPath(root)).then(() => true).catch(() => false), "正常时应已写出清单");

  await fs.rename(dir, dir + "-搬走了");
  const report = await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });
  assert.equal(report.rootReachable, false);
  assert.equal(
    await fs.stat(dir).then(() => true).catch(() => false),
    false,
    "绝不能把已搬走的旧目录重新创建出来",
  );
  assert.equal(Number(lib.rootById(root.id).online), 0, "应如实标离线，界面才能给出重新指定位置的提醒");
});

test("⑦ MEDIA_READONLY_FILES=1：清单与打标都不写", async (t) => {
  const { dir, root } = await setup(t);
  const file = path.join(dir, "a.wav");
  await fs.writeFile(file, "x");
  process.env.MEDIA_READONLY_FILES = "1";
  t.after(() => delete process.env.MEDIA_READONLY_FILES);
  const result = await writeManifest(root, { entries: {}, revision: 1 });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "readonly");
  assert.equal(await fs.access(manifestPath(root)).then(() => true).catch(() => false), false, "只读模式下不得写入登记目录");
});

test("⑧ 分享包白名单包含文档里介绍的维护脚本", () => {
  for (const name of ["theme-gen", "export-manifest", "relocate-root"])
    assert.ok(shareFiles.includes(`scripts/${name}.mjs`), `分享包缺少 scripts/${name}.mjs`);
});
