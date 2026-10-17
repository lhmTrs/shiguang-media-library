import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const run = promisify(execFile), project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const shareFiles = ["package.json", "package-lock.json", "index.html", "tsconfig.json", ".gitignore", ".dockerignore", ".env.example", "Dockerfile", "compose.yaml", "README.md", "START_HERE.md", "AI_HANDOFF.md", "AI_QUICK_START.md", "AGENTS.md", "CODE_SYNC.md", "FOLDER_VIEW.md", "DIRECTORY_CLASSIFICATION.md", "AI_METADATA_API.md", "启动分享版.command", "安装并启动.cmd", "src", "server", "tests", "dist",
  ...["launch", "portable", "doctor", "setup", "stop-portable", "package", "qa", "qa-directory-classification", "test-mysql-local", "verify-mysql", "verify-package", "update-code", "theme-gen", "export-manifest", "relocate-root", "annotate"].map(n => `scripts/${n}.mjs`)];
export async function collectFiles(root, entry, result = []) {
  const absolute = path.join(root, entry), stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw Error("分享包拒绝包含符号链接：" + entry);
  if (stat.isDirectory()) for (const name of (await fs.readdir(absolute)).sort()) await collectFiles(root, path.join(entry, name), result);
  else if (stat.isFile()) result.push(entry);
  else throw Error("分享包拒绝特殊文件：" + entry);
  return result;
}
async function main() {
  if (process.env.npm_execpath) await run(process.execPath, [process.env.npm_execpath, "run", "build"], { cwd: project, maxBuffer: 2e6 });
  else await fs.access(path.join(project, "dist/index.html"));
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-share-")), root = path.join(staging, "shiguang-media");
  const directory = path.join(project, "releases"); await fs.mkdir(directory, { recursive: true });
  try {
    await fs.mkdir(root);
    for (const entry of shareFiles) for (const file of await collectFiles(project, entry)) {
      const source = path.join(project, file), destination = path.join(root, file);
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination);
      await fs.chmod(destination, file.endsWith(".command") ? 0o755 : 0o644);
    }
    const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    pkg.scripts["start:local"] = pkg.scripts.start;
    pkg.scripts.start = "node scripts/portable.mjs --open";
    pkg.scripts.dev = "node scripts/portable.mjs --foreground";
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    await fs.writeFile(path.join(root, "SHARE_PACKAGE.json"), JSON.stringify({ app: "shiguang-local-media", portable: true, database: "sqlite-by-default", createdAt: new Date().toISOString(), node: "22.x", includesPersonalData: false, dockerBuildVerified: false }, null, 2));
    const paths = await collectFiles(root, ".");
    const files = [];
    for (const file of paths) {
      const contents = await fs.readFile(path.join(root, file));
      // Credentials and runtime exports are never a packaging input.
      if (/mysql-connection\.json$|\.sqlite(?:-wal|-shm)?$|\.jsonl$|^data[\\/]|^reports[\\/]|^\.runtime[\\/]|^node_modules[\\/]/.test(file)) throw Error("检测到禁止打包的文件：" + file);
      files.push({ path: file.split(path.sep).join("/"), bytes: contents.length, sha256: crypto.createHash("sha256").update(contents).digest("hex") });
    }
    await fs.writeFile(path.join(root, "PACKAGE_MANIFEST.json"), JSON.stringify({ format: 1, files }, null, 2));
    const name = "拾光素材库-分享版-" + new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + ".zip";
    const archive = path.join(directory, name);
    await run("zip", ["-q", "-r", archive, "shiguang-media"], { cwd: staging, maxBuffer: 1e6 });
    const digest = crypto.createHash("sha256").update(await fs.readFile(archive)).digest("hex");
    await fs.writeFile(archive + ".sha256", `${digest}  ${name}\n`);
    console.log(JSON.stringify({ archive, sha256: digest, files: files.length + 1, bytes: (await fs.stat(archive)).size }));
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
