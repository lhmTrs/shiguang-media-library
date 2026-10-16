import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { collectFiles } from "./package.mjs";
const run = promisify(execFile);
const archive = path.resolve(process.argv[2] || "");
if (!process.argv[2]) throw Error("用法：node scripts/verify-package.mjs /absolute/path/to/share.zip");
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-package-test-")));
let child, childExited, logs = "";
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([childExited.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 10000))]);
  if (!stopped) { child.kill("SIGKILL"); await childExited; throw Error("验收服务停止超时"); }
}
async function start(root, state, noTools = false) {
  logs = "";
  child = spawn(process.execPath, ["scripts/portable.mjs", "--foreground"], { cwd: root, env: {
    ...process.env, MEDIA_DATA_DIR: state, MEDIA_PORTABLE: "1", MEDIA_SKIP_IMPORT: "1", MEDIA_CONTAINER: "0", MEDIA_READONLY_FILES: "1", PORT: "4517",
    ...(noTools ? { PATH: path.join(base, "empty-path") } : {}),
  }, stdio: ["ignore", "pipe", "pipe"] });
  childExited = once(child, "exit");
  child.stdout.on("data", b => { logs += b; }); child.stderr.on("data", b => { logs += b; });
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw Error("分享包启动失败：" + logs.slice(-1800));
    const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) {
      try {
        const session = await fetch(match[0] + "/api/session"); const identity = await session.json();
        if (identity.app === "shiguang-local-media") {
          const cookie = session.headers.get("set-cookie").split(";")[0];
          return async (route, body, method = "POST", extraHeaders = {}) => {
            const r = await fetch(match[0] + "/api" + route, { method: body === undefined ? "GET" : method,
              headers: { cookie, "x-local-token": identity.token, "content-type": "application/json", ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
            if (!r.ok) throw Error(`HTTP ${r.status} ${route}: ` + (await r.text()).slice(0, 500));
            return r.json();
          };
        }
      } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error("分享包启动超时：" + logs.slice(-1800));
}
async function idle(api) {
  for (let i = 0; i < 240; i++) {
    const j = await api("/jobs");
    if (!j.jobs.some(j => j.status === "running") && !j.metadata.pending) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw Error("分享包任务未结束");
}
try {
  const names = (await run("unzip", ["-Z1", archive], { maxBuffer: 2e6 })).stdout.trim().split("\n");
  for (const name of names) {
    if (!name.startsWith("shiguang-media/") || name.includes("\\") || name.split("/").includes("..") || /[\x00-\x1f]/.test(name)) throw Error("拒绝不安全压缩包路径");
    if (/\/(?:node_modules|data|reports|\.runtime)\//.test(name) || /mysql-connection\.json$|\.sqlite(?:-wal|-shm)?$/.test(name)) throw Error("分享包包含禁止的运行数据");
  }
  const info = (await run("zipinfo", ["-l", archive], { maxBuffer: 2e6 })).stdout;
  if (/^l[rwx-]{9}\s/m.test(info)) throw Error("分享包不能包含符号链接");
  await run("unzip", ["-q", archive, "-d", base]);
  const root = path.join(base, "shiguang-media"), manifest = JSON.parse(await fs.readFile(path.join(root, "PACKAGE_MANIFEST.json"), "utf8"));
  const actual = (await collectFiles(root, ".")).filter(p => p !== "PACKAGE_MANIFEST.json").map(p => p.split(path.sep).join("/")).sort();
  assert.deepEqual(actual, manifest.files.map(f => f.path).sort());
  for (const file of manifest.files) assert.equal(crypto.createHash("sha256").update(await fs.readFile(path.join(root, file.path))).digest("hex"), file.sha256, "哈希不匹配：" + file.path);
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.ok(pkg.scripts.start.includes("portable.mjs")); assert.ok(pkg.scripts.dev.includes("portable.mjs"));
  console.log("文件清单与隐私边界通过，正在临时目录安装本机依赖…");
  await new Promise((resolve, reject) => {
    const installer = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
    installer.on("error", reject); installer.on("exit", code => code === 0 ? resolve() : reject(Error("干净安装 npm ci 失败")));
  });
  await run(process.execPath, ["scripts/doctor.mjs", "--json"], { cwd: root, maxBuffer: 1e6 });
  const media = path.join(base, "media"); await fs.mkdir(media);
  const pcm = Buffer.alloc(44 + 8820);
  pcm.write("RIFF"); pcm.writeUInt32LE(pcm.length - 8, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22); pcm.writeUInt32LE(22050, 24); pcm.writeUInt32LE(44100, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(8820, 40);
  await fs.writeFile(path.join(media, "测试 音效.wav"), pcm); await fs.writeFile(path.join(media, "重复副本.wav"), pcm);
  let api = await start(root, path.join(base, "state"));
  assert.equal((await api("/mysql")).mode, "sqlite"); assert.equal((await api("/roots")).length, 0);
  await api("/roots", { path: media, kind: "sfx" }); await idle(api);
  const assets = (await api("/assets")).items; assert.equal(assets.length, 2);
  await api("/assets/" + assets[0].id, { tags: ["分享验收"], note: "SQLite 保存" }, "PATCH");
  const project = await api("/projects", { name: "隔离验收项目", software: "resolve" });
  await api(`/projects/${project.id}/items`, { ids: assets.map(a => a.id) });
  await api(`/projects/${project.id}/items`, { ids: [assets[0].id], status: "used", note: "开场" }, "PATCH");
  assert.equal((await api(`/projects/${project.id}/items?kind=sfx&status=used`)).total, 1);
  assert.equal((await api(`/assets/${assets[0].id}/projects`))[0].status, "used");
  await api("/duplicate-audio/start", { scope: "sfx" }); await idle(api);
  assert.equal((await api("/duplicate-audio?scope=sfx")).report.groups.length, 1);
  await assert.rejects(api("/operations/preview", { action: "rename", ids: [assets[0].id], name: "不能改.wav" }), /HTTP 403/);
  await stop();
  api = await start(root, path.join(base, "state"));
  assert.deepEqual((await api(`/assets/${assets[0].id}`)).tags, ["分享验收"]);
  assert.equal((await api("/projects"))[0].used, 1);
  await stop();
  api = await start(root, path.join(base, "state-no-tools"), true);
  assert.equal((await api("/mysql")).mode, "sqlite");
  await api("/roots", { path: media, kind: "sfx" }); await idle(api);
  assert.equal((await api("/assets")).total, 2);
  await stop();
  assert.deepEqual(await fs.readFile(path.join(media, "测试 音效.wav")), pcm);
  assert.deepEqual(await fs.readFile(path.join(media, "重复副本.wav")), pcm);
  console.log(JSON.stringify({ passed: true, files: manifest.files.length + 1, database: "sqlite", freshInstall: true, restartPersistence: true, withoutMediaTools: true, originalFilesUnchanged: true }));
} finally { try { await stop(); } finally { await fs.rm(base, { recursive: true, force: true }); } }
