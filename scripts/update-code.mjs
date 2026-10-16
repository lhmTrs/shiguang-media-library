import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "../server/runtime.mjs";

const exec = promisify(execFile);
export async function gitState(project) {
  const git = async args => (await exec("git", args, { cwd: project, maxBuffer: 2e6 })).stdout.trim();
  try {
    const root = await git(["rev-parse", "--show-toplevel"]);
    if (await fs.realpath(root) !== await fs.realpath(project)) throw Error();
  } catch { throw Error("当前项目不是独立的 Git 仓库，请先按照 CODE_SYNC.md 接入私有仓库。"); }
  if (await git(["status", "--porcelain", "--untracked-files=normal"])) throw Error("存在未提交的修改或未跟踪文件。请先检查并提交，不会自动覆盖、暂存或丢弃。");
  let upstream;
  try { upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"]); }
  catch { throw Error("当前分支没有设置上游分支，请先接入私有仓库并设置跟踪分支。"); }
  return { git, upstream, before: await git(["rev-parse", "HEAD"]) };
}

export async function assertStopped(project, env = process.env) {
  const directories = new Set([dataDirectory(project, env), path.join(project, "data")]);
  for (const directory of directories) {
    let record;
    try { record = JSON.parse(await fs.readFile(path.join(directory, "server.json"), "utf8")); }
    catch (e) { if (e.code === "ENOENT") continue; throw Error("运行记录无法读取，无法确认服务已停止，请先人工核对。"); }
    if (!Number.isInteger(record.pid) || record.pid < 1) throw Error("运行记录异常，请先人工确认服务已停止。");
    try { process.kill(record.pid, 0); }
    catch (e) { if (e.code === "ESRCH") continue; throw Error("无法确认进程状态，请先人工核对。"); }
    throw Error("检测到服务进程仍在运行，请先安全停止服务再更新。此脚本不会停止进程。");
  }
}

async function npm(project, args) {
  const entry = process.env.npm_execpath;
  const command = entry ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  await new Promise((resolve, reject) => {
    const child = spawn(command, entry ? [entry, ...args] : args, { cwd: project, stdio: "inherit", shell: !entry && process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(Error("依赖安装或构建失败；未启动服务，请先修复。")));
  });
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) !== 22) throw Error("请使用 Node.js 22.x。");
  const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const { git, before } = await gitState(project);
  await assertStopped(project);
  if (process.argv.includes("--check")) { console.log("本地工作区干净、已设置上游且未发现运行中的服务。尚未联网检查远端版本。"); return; }
  try { await git(["fetch", "--no-tags"]); }
  catch { throw Error("获取远端代码失败，请检查网络和 Git 登录凭证。没有合并代码。"); }
  await gitState(project);
  try { await git(["merge-base", "--is-ancestor", "HEAD", "@{upstream}"]); }
  catch { throw Error("本地与远端并非可直接快进的关系。请先处理本地提交，不会自动合并或覆盖。"); }
  const backup = "update-backup/" + new Date().toISOString().replace(/[^0-9]/g, "");
  await git(["branch", backup, before]);
  console.log("旧代码已保留在本地分支：" + backup);
  try {
    await assertStopped(project);
    await git(["merge", "--ff-only", "@{upstream}"]);
    await npm(project, ["ci"]);
    await npm(project, ["run", "build"]);
  } catch (e) {
    throw Error("更新未完成，服务未启动。旧提交仍在 " + backup + "。请让维护者检查代码、依赖和构建状态；不要重置数据库。" + (e.message?.includes("未启动服务") ? " " + e.message : ""));
  }
  console.log("代码和网页已更新。未读取或迁移数据库，未移动素材，也未自动重启。请按本机原有方式启动并验收。");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
