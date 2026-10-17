/**
 * 素材目录（根）的生命周期验收：改类型/改名、仅注销、恢复、彻底删除、路径迁移。
 *
 * 契约：
 *   1. 改类型只影响音频的 music↔sfx 判定，不动标签；改名纯展示
 *   2. **仅注销**：不参与扫描/监听/导航与重叠校验，但 roots 行与全部素材属性保留、可恢复
 *      （所以绝不是 DELETE —— 删了会让 checked() 报"未登记的素材目录"，那批资产的试听会全坏）
 *   3. 彻底删除只允许"已注销且名下没有素材"
 *   4. 迁移路径**保持同一个 root_id 与 assets.id**：标签/备注/分类/项目关联全保留，不产生新记录
 *   5. 迁移前预检重合度；低于阈值或旧路径仍在时要求二次确认
 *   6. 内容原地变化后必须清空过期 sha256，避免跨盘认领匹配到旧哈希
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { reconcileRoot, relocateRoot } from "../server/reconcile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup(t, kind = "music") {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-roots-")));
  const source = path.join(base, "素材目录");
  await fs.mkdir(source, { recursive: true });
  const lib = await new Library(path.join(base, "db")).init();
  lib.enqueue = () => {};
  const root = await lib.addRoot(source, kind);
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

test("改类型：音频按新的根类型重新判定 music↔sfx，改名为纯展示", async (t) => {
  const { source, lib, root } = await setup(t, "music");
  await fs.writeFile(path.join(source, "歌.wav"), "x");
  await scan(lib, root);
  const asset = lib.list().items[0];
  assert.equal(asset.kind, "music");
  lib.patch(asset.id, { tags: ["保留我"] });

  const result = lib.updateRoot(root.id, { kind: "sfx", name: "改名后的目录" });
  assert.equal(result.root.name, "改名后的目录");
  assert.equal(result.root.kind, "sfx");
  assert.ok(result.changed >= 1, "音频条目应被重新判定");
  assert.equal(lib.asset(asset.id).kind, "sfx");
  assert.deepEqual(lib.asset(asset.id).tags, ["保留我"], "改类型不能动标签");
  assert.throws(() => lib.updateRoot(root.id, { kind: "不存在的类型" }), /未知目录类型/);
  assert.throws(() => lib.updateRoot(root.id, { name: "  " }), /显示名/);
});

test("仅注销可恢复：记录与属性保留，只是不再参与管理", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "甲.wav"), "x");
  await scan(lib, root);
  const asset = lib.list().items[0];
  lib.patch(asset.id, { tags: ["注销也要留着"], note: "备注" });

  const retired = lib.retireRoot(root.id);
  assert.equal(Number(retired.retired), 1);
  assert.equal(lib.roots().length, 0, "在管的根里不应出现");
  assert.equal(lib.allRoots().length, 1, "管理界面里仍应看得见");
  assert.deepEqual(lib.asset(asset.id).tags, ["注销也要留着"], "素材与标签必须保留");
  assert.equal(lib.asset(asset.id).note, "备注");
  assert.equal(lib.list().total, 0, "注销素材不再出现在全部素材中");
  assert.equal(lib.list({ kind: "music" }).total, 0);
  assert.equal(lib.list({ root: root.id, q: "甲" }).total, 0);
  assert.equal(lib.stats().total, 0);
  assert.deepEqual(lib.stats().kinds, []);
  assert.deepEqual(lib.stats().formats, []);

  const restored = lib.restoreRoot(root.id);
  assert.equal(Number(restored.retired), 0);
  assert.equal(lib.roots().length, 1);
  assert.equal(lib.list().total, 1, "恢复后重新显示同一素材");
  assert.equal(lib.list().items[0].id, asset.id);
  // 重新登记同一路径 = 恢复，而不是新建一条
  lib.retireRoot(root.id);
  const readded = await lib.addRoot(source, "music");
  assert.equal(readded.id, root.id, "同路径重新登记应恢复原来的根");
  assert.equal(lib.roots().length, 1);
});

test("彻底删除：未注销拒绝、有素材拒绝、注销且清空后允许", async (t) => {
  const { source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "甲.wav"), "x");
  await scan(lib, root);
  assert.throws(() => lib.deleteRoot(root.id), /请先注销/);
  lib.retireRoot(root.id);
  assert.throws(() => lib.deleteRoot(root.id), /仍有 1 条素材索引/);
  lib.db.prepare("DELETE FROM assets WHERE root_id=?").run(root.id);
  assert.equal(lib.deleteRoot(root.id).removed, true);
  assert.equal(lib.allRoots().length, 0);
});

test("路径迁移（同盘整目录改名）：同一个素材 id、标签保留、零新增零冲突", async (t) => {
  const { base, source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "剧中", "主题曲.wav").replace(/\/[^/]+$/, "") + "/placeholder", "x").catch(() => {});
  await fs.mkdir(path.join(source, "剧中"), { recursive: true });
  await fs.writeFile(path.join(source, "剧中", "主题曲.wav"), "payload");
  await scan(lib, root);
  const asset = lib.list().items.find((a) => a.name === "主题曲.wav");
  lib.patch(asset.id, { tags: ["片头", "紧张"], note: "用于第 1 集片头", favorite: true });

  const next = path.join(base, "改过名的目录");
  await fs.rename(source, next);

  const result = await relocateRoot(lib, root.id, next);
  assert.equal(result.needsConfirm, undefined, "旧路径已不存在且重合度高，不应要求确认");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.report.conflicts, 0);
  assert.equal(result.report.added, 0, "迁移不应产生新素材");
  assert.equal(result.report.missing, 0, "迁移不应把素材判为失联");

  const after = lib.asset(asset.id);
  assert.equal(after.name, "主题曲.wav");
  assert.ok(after.path.startsWith(next), after.path);
  assert.deepEqual(after.tags, ["片头", "紧张"]);
  assert.equal(after.note, "用于第 1 集片头");
  assert.equal(after.favorite, 1);
  assert.equal(lib.list().total, 1, "不应出现重复记录");
  assert.equal(lib.rootById(root.id).path, next, "root_id 保持不变");
  assert.equal(lib.roots().length, 1);
});

test("迁移预检：新位置是另一批文件时要求二次确认，确认后才执行", async (t) => {
  const { base, source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "甲.wav"), "aaaa");
  await scan(lib, root);
  const other = path.join(base, "另一批文件");
  await fs.mkdir(other);
  await fs.writeFile(path.join(other, "完全不同.wav"), "bbbb");

  const dry = await relocateRoot(lib, root.id, other);
  assert.equal(dry.needsConfirm, true);
  assert.ok(dry.warnings.some((w) => w.includes("只匹配到")), JSON.stringify(dry.warnings));
  assert.equal(lib.rootById(root.id).path, source, "未确认时不得改动任何东西");

  const done = await relocateRoot(lib, root.id, other, { confirm: true });
  assert.equal(lib.rootById(root.id).path, other);
  assert.ok(done.report.added >= 1, "新位置的另一个文件会作为新素材入库");
});

test("迁移拒绝：路径不存在 / 新旧相同 / 与其它根重叠", async (t) => {
  const { base, source, lib, root } = await setup(t);
  await fs.writeFile(path.join(source, "甲.wav"), "x");
  await scan(lib, root);
  await assert.rejects(() => relocateRoot(lib, root.id, path.join(base, "不存在")), /不存在或无法访问/);
  await assert.rejects(() => relocateRoot(lib, root.id, source), /新旧路径相同/);

  const other = path.join(base, "另一个根");
  await fs.mkdir(path.join(other, "内层"), { recursive: true });
  await lib.addRoot(other, "music");
  await assert.rejects(() => relocateRoot(lib, root.id, path.join(other, "内层")), /重叠/);
});

test("内容原地变化后清空过期 sha256（否则跨盘认领会匹配到旧哈希）", async (t) => {
  const { source, lib, root } = await setup(t);
  const file = path.join(source, "会变的.wav");
  await fs.writeFile(file, "original-content");
  await scan(lib, root);
  const asset = lib.list().items[0];
  await reconcileRoot(lib, root); // 默认预算：补上 sha256
  assert.ok(lib.db.prepare("SELECT sha256 FROM assets WHERE id=?").get(asset.id).sha256, "应先算出一个哈希");

  await fs.writeFile(file, "completely-different-and-longer-content");
  await reconcileRoot(lib, root, { hashBudgetFiles: 0, hashBudgetBytes: 0 });
  assert.equal(
    lib.db.prepare("SELECT sha256 FROM assets WHERE id=?").get(asset.id).sha256,
    null,
    "内容变化后必须清空过期哈希",
  );
});
