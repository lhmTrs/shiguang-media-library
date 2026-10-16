#!/usr/bin/env node
/**
 * 一次性迁移工具：把数据库里的元数据物化成各登记根下的 `.shiguang/manifest.json`。
 *
 * 为什么需要它：切换"文件系统为真相、清单为身份载体"之前，得先把现有标签/备注/分类
 * 落到清单里，否则外部整理一次就会丢。之后应用的对账（server/reconcile.mjs）就以此为准。
 *
 * 用法：
 *   node scripts/export-manifest.mjs                 # 物化 + 立即对账（不计算哈希）
 *   node scripts/export-manifest.mjs --hash          # 同上，并按预算渐进补齐 sha256
 *   node scripts/export-manifest.mjs --dry-run       # 只看会写什么，不落盘
 *   node scripts/export-manifest.mjs --root=<id|绝对路径>   # 只处理某一个根
 *   node scripts/export-manifest.mjs --no-reconcile  # 只写清单，不跑对账
 *
 * 安全：写清单是"临时文件 + rename"原子替换，并保留上一版 `.bak`；已存在的清单里的
 * 未知字段与 missing 记录都会保留，不会被洗掉。原素材文件不做任何修改。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "../server/library.mjs";
import { MysqlStorage } from "../server/mysql.mjs";
import { dataDirectory } from "../server/runtime.mjs";
import { manifestPath, readManifest, writeManifest } from "../server/fs-manifest.mjs";
import { materializeManifest, reconcileRoot } from "../server/reconcile.mjs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const withHash = args.includes("--hash");
const reconcile = !args.includes("--no-reconcile");
const only = args.find((a) => a.startsWith("--root="))?.slice("--root=".length);

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = dataDirectory(project);
const mysqlStorage = await new MysqlStorage(dataDir).init();
const lib = await new Library(dataDir, { database: mysqlStorage.database }).init();
mysqlStorage.attach?.(lib);

const roots = lib.roots().filter((r) => !only || r.id === only || r.path === only);
if (!roots.length) {
  console.log(JSON.stringify({ dataDir, roots: 0, note: only ? "没有匹配的登记目录" : "还没有登记任何素材目录" }));
  process.exit(0);
}

const summary = [];
for (const root of roots) {
  const existing = await readManifest(root);
  const built = await materializeManifest(lib, root);
  // 合并策略：数据库里的元数据为主，但保留清单里已有的未知字段、dev/ino 与 missing 记录
  for (const [entryId, entry] of Object.entries(built.entries)) {
    const previous = existing.manifest?.entries?.[entryId];
    if (!previous) continue;
    built.entries[entryId] = {
      ...entry,
      ...(previous.dev ? { dev: previous.dev } : {}),
      ...(previous.ino ? { ino: previous.ino } : {}),
      ...(previous.sha256 ? { sha256: previous.sha256 } : {}),
      ...(previous.state ? { state: previous.state, missingSince: previous.missingSince } : {}),
    };
  }
  for (const [entryId, previous] of Object.entries(existing.manifest?.entries ?? {})) {
    if (!built.entries[entryId]) built.entries[entryId] = previous; // 数据库里没了的旧条目：留在清单里，不丢历史
  }
  built.revision = Number(existing.manifest?.revision || 0) + 1;

  const item = {
    rootId: root.id,
    path: root.path,
    manifest: manifestPath(root),
    entries: Object.keys(built.entries).length,
    existingManifest: existing.reason,
    wrote: false,
  };
  if (!dryRun) {
    await writeManifest(root, built);
    item.wrote = true;
    if (reconcile) {
      item.reconcile = await reconcileRoot(lib, root, {
        hashBudgetFiles: withHash ? undefined : 0,
        hashBudgetBytes: withHash ? undefined : 0,
      });
    }
  }
  summary.push(item);
}

console.log(JSON.stringify({ dataDir, dryRun, roots: summary.length, detail: summary }, null, 2));
