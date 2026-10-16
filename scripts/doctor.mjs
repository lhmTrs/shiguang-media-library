import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataDirectory } from "../server/runtime.mjs";
const run = promisify(execFile), project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
const add = (name, ok, required, detail) => results.push({ name, ok, required, detail });
add("Node.js", process.versions.node.split(".")[0] === "22", true, process.version + "（分享版使用 Node.js 22.x）");
try {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:"); db.prepare("SELECT 1").get(); db.close();
  add("内置 SQLite", true, true, "无需安装 MySQL 或独立 SQLite 服务");
} catch { add("内置 SQLite", false, true, "请在本机重新运行 npm ci，不要复制其他电脑的 node_modules"); }
try { await fs.access(path.join(project, "dist/index.html")); add("网页构建", true, true, "dist/index.html 存在"); }
catch { add("网页构建", false, true, "请运行 npm run build"); }
for (const [command, args, label] of [["ffmpeg", ["-version"], "FFmpeg（波形/视频缩略图/代理）"], ["ffprobe", ["-version"], "FFprobe（媒体参数）"], ["exiftool", ["-ver"], "ExifTool（拍摄日期）"]]) {
  try { await run(command, args, { timeout: 6000, maxBuffer: 512000 }); add(label, true, false, "可用"); }
  catch { add(label, false, false, "未找到或不可执行；对应媒体功能可能不可用，见 START_HERE.md"); }
}
if (process.platform === "darwin") {
  try { await run("xcrun", ["--find", "swiftc"], { timeout: 6000 }); add("Mac 废纸篓组件", true, false, "Swift 编译工具可用"); }
  catch { add("Mac 废纸篓组件", false, false, "未安装 Command Line Tools 时删除禁用，其他功能仍可使用"); }
}
const data = dataDirectory(project, { ...process.env, MEDIA_PORTABLE: "1" });
let existingMysql = false;
try { await fs.access(path.join(data, "mysql-connection.json")); existingMysql = true; } catch {}
const report = { passed: results.every(r => r.ok || !r.required), platform: process.platform, arch: process.arch, dataDirectory: data,
  database: existingMysql ? "已有 MySQL 配置，不会删除或静默切换" : "新数据目录默认 SQLite", results };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`平台：${report.platform}/${report.arch}\n数据目录：${data}\n数据库：${report.database}`);
  for (const r of results) console.log(`${r.ok ? "[OK]" : r.required ? "[缺少]" : "[可选]"} ${r.name}：${r.detail}`);
}
if (!report.passed) process.exitCode = 1;
