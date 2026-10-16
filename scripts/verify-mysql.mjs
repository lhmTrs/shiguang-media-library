import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import mysql from "mysql2/promise";
import { Library } from "../server/library.mjs";
import { MysqlStorage, validateConfig, safeError } from "../server/mysql.mjs";
import { MusicCategories, AssetCategories } from "../server/music-categories.mjs";
import { Tags } from "../server/tags.mjs";
import { MusicAnalysis } from "../server/music-analysis.mjs";
import { MissingFiles } from "../server/missing-files.mjs";
import { Projects } from "../server/projects.mjs";

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdout.write("等待本机 MySQL 验证配置（输入不回显）\n");
const config = await new Promise((resolve) => {
  let input = "";
  const read = (chunk) => {
    input += chunk.toString();
    if (input.includes("\n")) {
      process.stdin.off("data", read);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      resolve(JSON.parse(input.split("\n")[0]));
    }
  };
  process.stdin.on("data", read);
});
const base = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-mysql-")),
);
const database = "shiguang_verify_" + Date.now();
let lib, storage, admin;
try {
  admin = await mysql.createConnection({
    ...validateConfig({ ...config, database }),
    database: undefined,
  });
  const source = path.join(base, "素材");
  const dest = path.join(base, "目标");
  await fs.mkdir(source);
  await fs.mkdir(dest);
  lib = await new Library(path.join(base, "data")).init();
  lib.enqueue = () => {};
  const root = await lib.addRoot(source, "sfx");
  const target = await lib.addRoot(dest, "mixed");
  await fs.writeFile(path.join(source, "风声_%_\\.wav"), "fixture");
  const job = lib.scan(root.id);
  while (job.status === "running") await new Promise((r) => setTimeout(r, 10));
  assert.equal(job.status, "done");
  const asset = lib.list().items[0];
  lib.patch(asset.id, {
    tags: ["中文", "雨声"],
    note: "引号 ' 与 \\ 路径",
    favorite: true,
  });
  lib.db
    .prepare("UPDATE assets SET captured_ms=?,created_ms=? WHERE id=?")
    .run(1791734400000, 1791734400000, asset.id);
  const original = lib.asset(asset.id);
  const emptyCategory = new MusicCategories(lib)
    .init()
    .create({ name: "迁移空分类" });
  const emptyTag = new Tags(lib).init().create({ name: "迁移空标签" });
  const projects = new Projects(lib).init();
  const project = projects.save(null, { name: "迁移项目", software: "resolve", note: "项目备注" });
  projects.add(project.id, { ids: [asset.id] });
  projects.change(project.id, { ids: [asset.id], status: "used", note: "开场" });
  const projectUsedAt = projects.history(asset.id)[0].used_at;
  const analysis = await new MusicAnalysis(lib).init();
  await analysis.configure({ apiKey: "sk-mysql-secret-fixture-not-real" });
  const log = analysis.diagnostics.record({
    operation: "connection",
    outcome: "error",
    httpStatus: 429,
    code: "insufficient_quota",
    requestId: "req_mysql_fixture",
  });
  const cacheKey = "a".repeat(64);
  lib.db
    .prepare(
      "INSERT INTO music_analyses(id,asset_id,cache_key,payload,created_ms) VALUES(?,?,?,?,?)",
    )
    .run(
      "00000000-0000-4000-8000-000000000001",
      asset.id,
      cacheKey,
      JSON.stringify({ summary: "分析缓存测试", tags: ["紧张"] }),
      Date.now(),
    );
  storage = await new MysqlStorage(lib.dataDir).init();
  storage.attach(lib);
  await storage.activate({ ...config, database });
  assert.equal(storage.publicState().mode, "mysql");
  new Projects(lib).init();
  assert.equal(projects.list()[0].used, 1);
  assert.equal(projects.history(asset.id)[0].used_at, projectUsedAt);
  assert.equal(projects.items(project.id, { q: "开场", status: "used" }).total, 1);
  assert.equal(projects.items(project.id, { kind: "sfx", status: "used" }).total, 1);
  assert.deepEqual(projects.items(project.id, { kind: "music" }).kinds, { all: 1, sfx: 1, music: 0, photo: 0, video: 0 });
  assert.equal(projects.add(project.id, { ids: [asset.id] }).alreadyAdded, 1);
  projects.change(project.id, { ids: [asset.id], status: "candidate" });
  projects.change(project.id, { ids: [asset.id], status: "used" });
  assert.equal(projects.history(asset.id)[0].used_at, projectUsedAt);
  const mysqlProject = projects.save(null, { name: "MySQL 新项目", software: "jianying" });
  projects.add(mysqlProject.id, { ids: [asset.id] });
  assert.equal(projects.history(asset.id).length, 2);
  projects.remove(mysqlProject.id);
  assert.equal(projects.history(asset.id).length, 1);
  lib.db.exec("ALTER TABLE assets DROP COLUMN reveal_count");
  lib.ensureRevealCount();
  assert.equal(lib.asset(asset.id).reveal_count, 0);
  await Promise.all([lib.reveal(asset.id, async () => {}), lib.reveal(asset.id, async () => {})]);
  await assert.rejects(lib.reveal(asset.id, async () => { throw Error("访达未打开"); }));
  assert.equal(lib.asset(asset.id).reveal_count, 2);
  assert.equal(lib.list({ sort: "revealCount" }).items[0].id, asset.id);
  assert.equal(analysis.cached(cacheKey).summary, "分析缓存测试");
  assert.equal(analysis.key, "sk-mysql-secret-fixture-not-real");
  assert.ok(analysis.diagnostics.list().some((item) => item.id === log.id));
  analysis.diagnostics.record({
    operation: "connection",
    outcome: "success",
    httpStatus: 200,
  });
  const detailedFailure = analysis.diagnostics.record({
    operation: "analysis",
    outcome: "error",
    assetId: asset.id,
    httpStatus: 400,
    details: {
      reason: "测试参数错误",
      providerParam: "max_completion_tokens",
      responseBody: '{"error":{"message":"Unsupported parameter"}}',
    },
  });
  assert.equal(
    analysis.diagnostics.lastFailure(asset.id).id,
    detailedFailure.id,
  );
  assert.ok(
    !lib.db
      .prepare("SELECT encrypted FROM app_secrets WHERE id=?")
      .get("openai-api-key")
      .encrypted.includes("sk-mysql-secret-fixture-not-real"),
  );
  lib.db.transaction(() => {
    lib.db
      .prepare("DELETE FROM music_analyses WHERE cache_key=?")
      .run(cacheKey);
    lib.db
      .prepare(
        "INSERT INTO music_analyses(id,asset_id,cache_key,payload,created_ms) VALUES(?,?,?,?,?)",
      )
      .run(
        "00000000-0000-4000-8000-000000000002",
        asset.id,
        cacheKey,
        JSON.stringify({ summary: "MySQL 分析缓存", tags: ["电子"] }),
        Date.now(),
      );
  })();
  const tagManager = new Tags(lib).init();
  assert.equal(tagManager.list().find((t) => t.id === emptyTag.id).n, 0);
  tagManager.apply({ ids: [asset.id], tagId: emptyTag.id, action: "add" });
  assert.equal(lib.list({ tagName: "迁移空标签" }).total, 1);
  tagManager.rename(emptyTag.id, { name: "标签新名称" });
  assert.equal(lib.list({ tagName: "标签新名称" }).total, 1);
  tagManager.remove(emptyTag.id);
  assert.equal(lib.list({ q: "_%_\\" }).total, 1);
  assert.equal(
    lib.list({
      root: [root.id, target.id],
      capturedFrom: "2026-10-12",
      capturedTo: "2026-10-12",
    }).total,
    1,
  );
  assert.equal(lib.stats().favorites, 1);
  for (const key of [
    "name",
    "path",
    "tags",
    "note",
    "favorite",
    "captured_ms",
    "created_ms",
  ])
    assert.deepEqual(lib.asset(asset.id)[key], original[key]);
  lib.patch(asset.id, { note: "MySQL 新备注", tags: ["更新标签"] });
  assert.equal(lib.list({ tagRules: JSON.stringify({ all: ["更新标签"], any: ["更新标签", "不存在"], none: ["人声"] }) }).total, 1);
  assert.equal(lib.list({ tagRules: JSON.stringify({ none: ["更新标签"] }) }).total, 0);
  assert.throws(() => lib.list({ tagRules: '{"all":"非法"}' }), /标签/);
  const [rows] = await admin.query(
    `SELECT note,tags FROM \`${database}\`.assets WHERE id=?`,
    [asset.id],
  );
  assert.equal(rows[0].note, "MySQL 新备注");
  assert.throws(() =>
    lib.db.transaction(() => {
      lib.db
        .prepare("UPDATE assets SET note=? WHERE id=?")
        .run("rollback", asset.id);
      throw Error("rollback");
    })(),
  );
  assert.equal(lib.asset(asset.id).note, "MySQL 新备注");
  const move = await lib.execute({
    action: "rename",
    ids: [asset.id],
    name: "重命名.wav",
  });
  assert.equal(move[0].ok, true, JSON.stringify(move));
  await lib.undo(move[0].operation);
  const r3 = await lib
    .addRoot(path.join(base, "data", "cache"), "sfx")
    .catch(() => null);
  assert.equal(r3, null);
  const beforeRestart = lib.stats();
  lib.patch(asset.id, { category: "环境类" });
  assert.deepEqual(lib.list({ kind: "sfx" }).categories, [
    { category: "环境类", n: 1 },
  ]);
  assert.deepEqual(lib.list({ kind: "music" }).categories, []);
  lib.patch(asset.id, { category: "新环境类" });
  assert.deepEqual(lib.list({ kind: "sfx" }).categories, [
    { category: "新环境类", n: 1 },
  ]);
  lib.patch(asset.id, { kind: "music" });
  const manager = new MusicCategories(lib).init();
  assert.equal(
    manager.list().every((c) => typeof c.offline === "number"),
    true,
  );
  assert.equal(manager.list().find((c) => c.id === emptyCategory.id).n, 0);
  manager.assign({ ids: [asset.id], categoryId: emptyCategory.id });
  const extra = manager.create({ name: "额外分类" });
  manager.add({ assetId: asset.id, categoryId: extra.id });
  assert.equal(lib.list({ kind: "music", category: "额外分类" }).total, 1);
  assert.equal(
    lib
      .list({ kind: "music" })
      .categories.find((c) => c.category === "额外分类").n,
    1,
  );
  assert.equal(manager.members(asset.id).length, 2);
  manager.rename(emptyCategory.id, { name: "MySQL 分类改名" });
  assert.equal(lib.asset(asset.id).category, "MySQL 分类改名");
  manager.remove(emptyCategory.id);
  assert.equal(lib.asset(asset.id).category, "");
  assert.equal(lib.list({ kind: "music", uncategorized: "1" }).total, 0);
  assert.equal(manager.list()[0].n, 0);
  lib.db.close();
  storage = await new MysqlStorage(lib.dataDir).init();
  lib = await new Library(lib.dataDir, { database: storage.database }).init();
  lib.enqueue = () => {};
  storage.attach(lib);
  assert.equal(lib.stats().total, beforeRestart.total);
  assert.equal(lib.asset(asset.id).reveal_count, 2);
  assert.equal(
    (await new MusicAnalysis(lib).init()).cached(cacheKey).summary,
    "MySQL 分析缓存",
  );
  const secretsRestored = await new MusicAnalysis(lib).init();
  assert.ok(
    secretsRestored.diagnostics
      .list()
      .some(
        (item) => item.id === log.id && item.requestId === "req_mysql_fixture",
      ),
  );
  assert.equal(secretsRestored.key, "sk-mysql-secret-fixture-not-real");
  await secretsRestored.removeKey();
  assert.equal(secretsRestored.state().hasKey, false);
  assert.equal(lib.asset(asset.id).note, "MySQL 新备注");
  assert.equal(
    new MusicCategories(lib)
      .init()
      .members(asset.id)
      .some((c) => c.id === extra.id),
    true,
  );
  assert.equal(
    (await fs.stat(path.join(lib.dataDir, "mysql-connection.json"))).mode &
      0o777,
    0o600,
  );
  if (config.password)
    assert.equal(
      JSON.stringify(storage.publicState()).includes(config.password),
      false,
    );
  for (const name of ["统一音效.wav", "统一视频.mp4", "统一照片.jpg"]) await fs.writeFile(path.join(source, name), "fixture");
  const unifiedJob = lib.scan(root.id);
  while (unifiedJob.status === "running") await new Promise(r => setTimeout(r, 10));
  const unified = new AssetCategories(lib).init();
  assert.equal(unified.get(extra.id).name, extra.name);
  for (const item of lib.list().items) {
    unified.add({ assetId: item.id, categoryId: extra.id });
    assert.ok(unified.members(item.id).some(c => c.id === extra.id));
  }
  assert.equal(lib.list({ category: extra.name }).total, 4);
  for (const kind of ["music", "sfx", "video", "photo"]) assert.equal(unified.list({ kind })[0].totalAssets, 1);
  const unifiedVideo = lib.list({ kind: "video" }).items[0];
  assert.throws(() => unified.save({ assetId: unifiedVideo.id, category: "视频主分类", sub: "", extraIds: [extra.id] }), /分类不存在/);
  assert.throws(() => lib.patch(unifiedVideo.id, { category: "不能隐式新建" }), /分类不存在/);
  const videoParent = unified.create({ name: "视频主分类" });
  const videoChild = unified.createSubcategory({ categoryId: videoParent.id, name: "子类" });
  unified.save({ assetId: unifiedVideo.id, category: "视频主分类", sub: "子类", extraIds: [extra.id] });
  assert.equal(unified.members(unifiedVideo.id).length, 2);
  assert.equal(lib.asset(unifiedVideo.id).kind, "video");
  assert.equal(lib.list({ subcategoryId: videoChild.id }).total, 1);
  assert.throws(() => lib.patch(unifiedVideo.id, { sub: "非法子类", note: "不应写入" }), /子类不属于/);
  unified.renameSubcategory(videoChild.id, { name: "重命名子类" });
  assert.equal(lib.asset(unifiedVideo.id).sub, "重命名子类");
  await fs.mkdir(path.join(source, "扫描新增分类"));
  const folderScan = lib.scan(root.id);
  while (folderScan.status === "running") await new Promise(r => setTimeout(r, 10));
  assert.equal(folderScan.status, "done");
  assert.ok(unified.list().some(c => c.name === "扫描新增分类" && c.n === 0));
  assert.equal(lib.asset(unifiedVideo.id).category, "视频主分类");
  await fs.unlink(lib.asset(asset.id).path);
  const fileChecker = new MissingFiles(lib);
  const checked = await fileChecker.check({ force: true });
  assert.equal(checked.removed, 0);
  assert.equal(lib.asset(asset.id).file_status, "missing");
  const cleanup = await fileChecker.clean(fileChecker.cleanupPreview([asset.id]));
  assert.equal(cleanup.removed, 1);
  assert.throws(() => lib.asset(asset.id));
  for (const table of ["music_category_links", "music_analyses", "operations"])
    assert.equal(lib.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE asset_id=?`).get(asset.id).n, 0);
  assert.equal(lib.db.prepare("SELECT COUNT(*) n FROM openai_diagnostics WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.assetId'))=?").get(asset.id).n, 0);
  assert.ok((await fs.readdir(path.join(lib.dataDir, "missing-file-backups"))).length);
  console.log(
    JSON.stringify({
      passed: true,
      tests: [
        "完整迁移校验",
        "真实 MySQL 读取与写入",
        "中文及特殊字符搜索",
        "目录和日期组合筛选",
        "事务回滚",
        "改名与撤销",
        "重启持久化",
        "密码权限及不返回密码",
        "音乐分析缓存迁移与 MySQL 持久化",
        "加密 API Key 迁移、重启与删除",
        "脱敏诊断日志迁移、写入与重启",
        "失效文件索引与关联数据事务清理、备份保留",
        "统一分类四种类型归属、筛选及事务保存",
        "项目候选及使用历史迁移、MySQL持久化、幂等及移除保护",
      ],
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      passed: false,
      error: safeError(e),
      code: e.code || null,
      detail: e instanceof assert.AssertionError ? e.message : undefined,
    }),
  );
  process.exitCode = 1;
} finally {
  lib?.db.close();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
  }
  await fs.rm(base, { recursive: true, force: true });
}
