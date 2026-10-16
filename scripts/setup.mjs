import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function command(program, args, shell = false) {
  await new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: project, env: process.env, stdio: "inherit", shell });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(Error(`命令未完成（退出码 ${code}），请查看上方提示`)));
  });
}
try {
  if (process.versions.node.split(".")[0] !== "22") throw Error("请安装 Node.js 22.x 后重试：https://nodejs.org/en/download/archive/v22");
  let installed = false;
  try {
    await import("express"); await import("mysql2/promise"); const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:"); db.close(); installed = true;
  } catch {}
  if (!installed || process.argv.includes("--reinstall")) {
    console.log("安装锁定版本的依赖（首次需要联网）…");
    await command(process.platform === "win32" ? "npm.cmd" : "npm", ["ci"], process.platform === "win32");
  }
  try { await fs.access(path.join(project, "dist/index.html")); }
  catch { await command(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], process.platform === "win32"); }
  await command(process.execPath, ["scripts/doctor.mjs"]);
  if (process.argv.includes("--start")) await command(process.execPath, ["scripts/portable.mjs", "--open"]);
  else console.log("安装检查完成。运行 npm start（分享包）或 npm run portable（源项目）启动。");
} catch (e) { console.error(e.message); process.exitCode = 1; }
