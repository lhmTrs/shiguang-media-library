#!/usr/bin/env node
/**
 * 把一个已登记目录迁移到新路径（整目录改名 / 搬盘）。
 *
 * 与界面上的「重新指定位置」走同一套逻辑（server/reconcile.mjs 的 relocateRoot）：
 *   - **保持同一个 root_id**，只改 roots.path
 *   - 然后把清单搬过去、对该根跑一次对账，由 dev:ino（同盘）或 xattr/sha256（跨盘）
 *     把每条素材重新认领回**同一个 assets.id**
 *   - 因此标签、备注、分类、收藏、拍摄时间校正、项目关联全部天然保留，不会产生新记录
 *
 * 用法：
 *   node scripts/relocate-root.mjs --list
 *   node scripts/relocate-root.mjs --root <id|显示名|旧路径> --to <新绝对路径> [--confirm] [--hash]
 *
 * 安全：迁移前先预检"新位置与原根的重合度"，低于阈值或旧路径仍存在时，会要求加 --confirm；
 * 迁移后校验"冲突为 0 且离线数不增加"，失败且旧位置还在时自动回滚。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "../server/library.mjs";
import { MysqlStorage } from "../server/mysql.mjs";
import { dataDirectory } from "../server/runtime.mjs";
import { relocateRoot } from "../server/reconcile.mjs";

const args = process.argv.slice(2);
/**
 * 取值同时支持 `--root=X` 与 `--root X` 两种写法。
 * （只支持等号写法时，按文档写 `--root X` 会静默退化成 --list：什么都不迁，只打印列表。）
 */
const value = (flag) => {
  const hit = args.find((a) => a.startsWith(flag + "="));
  if (hit) return hit.slice(flag.length + 1);
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length || args[i + 1].startsWith("--")) return undefined;
  return args[i + 1];
};

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = dataDirectory(project);
const storage = await new MysqlStorage(dataDir).init();
const lib = await new Library(dataDir, { database: storage.database }).init();
storage.attach?.(lib);

const rootArg = value("--root");
const toArg = value("--to");
if (args.includes("--list") || (!rootArg && !toArg)) {
  const roots = lib.allRoots();
  console.log(`数据目录：${dataDir}`);
  for (const r of roots)
    console.log(`  ${r.retired ? "[已注销] " : ""}${r.name}  ${r.path}  (id=${r.id}, kind=${r.kind}, online=${r.online})`);
  lib.db.close();
  process.exit(0);
}

const key = rootArg;
const to = toArg;
const root =
  lib.allRoots().find((r) => r.id === key) ||
  lib.allRoots().find((r) => r.name === key) ||
  lib.allRoots().find((r) => r.path === key);
if (!root) {
  console.error(`找不到匹配的登记目录：${key}（用 --list 查看）`);
  lib.db.close();
  process.exit(1);
}
if (!to) {
  console.error("请用 --to=<新绝对路径> 指定新位置");
  lib.db.close();
  process.exit(1);
}

const result = await relocateRoot(lib, root.id, to, {
  confirm: args.includes("--confirm"),
  hashBudgetFiles: args.includes("--hash") ? undefined : 0,
  hashBudgetBytes: args.includes("--hash") ? undefined : 0,
});
if (result.needsConfirm) {
  console.log("需要二次确认（未做任何修改）：");
  for (const w of result.warnings) console.log("  ⚠️ " + w);
  console.log(`  重合度 ${Math.round(result.matchRatio * 100)}%（${result.matched}/${result.total}）`);
  console.log(`  确认无误后重跑并加上 --confirm`);
} else {
  console.log(JSON.stringify(result, null, 2));
  console.log(result.ok ? "✅ 迁移完成，属性与标签保留" : "❌ 校验未通过（已尝试回滚，详见上方 report）");
}
lib.db.close();
