/**
 * T-AUDIO-FREEZE（回复 #0061）：音频功能默认关闭的服务端开关。
 *
 * 契约：
 *   1. 默认（不设 SHIGUANG_AUDIO_ANALYSIS 或非 "1"）启动不创建音频实例，5 条音频路由
 *      在既有本机 session / Origin 校验之后统一 503 + AUDIO_FEATURE_DISABLED。
 *   2. 关闭态零音频联网、零下载、零子进程、零 asset_audio 建表；响应不泄露引擎路径。
 *   3. 不改变普通素材与云认证入口；开关只认服务端环境变量，HTTP 无法修改。
 *
 * 隔离：临时 MEDIA_DATA_DIR + 合成素材目录 + 随机端口；不碰真实库/素材/引擎。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Library } from "../server/library.mjs";
import { AUDIO_FEATURE_DISABLED, audioFeatureEnabled } from "../server/audio-feature.mjs";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PROBE = path.join(PROJECT, "tests", "audio-side-effect-probe.cjs");
const AUDIO_PATTERN = /audio-engine|audio-analyze|112\.74\.109\.173/i;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function wavBytes() {
  const data = Buffer.alloc(32, 1);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function makeLibrary(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-audio-flag-")));
  const mediaRoot = path.join(base, "合成素材");
  const dataDir = path.join(base, "data");
  await fs.mkdir(mediaRoot, { recursive: true });
  const assetPath = path.join(mediaRoot, "测试音效.wav");
  await fs.writeFile(assetPath, wavBytes());

  const lib = await new Library(dataDir, { directoryClassification: true }).init();
  const root = await lib.addRoot(mediaRoot, "sfx");
  const assetId = crypto.randomUUID();
  const stat = await fs.stat(assetPath);
  lib.db
    .prepare(
      "INSERT INTO assets (id,root_id,path,name,ext,kind,size,mtime,probe,capture_status,online,trashed) VALUES (?,?,?,?,?,?,?,?,?,?,1,0)",
    )
    .run(assetId, root.id, assetPath, path.basename(assetPath), ".wav", "sfx", stat.size, stat.mtimeMs, "ready", "ready");
  lib.db.close();

  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dataDir, mediaRoot, assetId };
}

async function startServer(t, { dataDir, flag }) {
  // 占位废纸篓组件，避免临时数据目录触发 swiftc 编译（与既有 HTTP 测试一致）。
  const trashHash = crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(PROJECT, "server/trash.swift")))
    .digest("hex")
    .slice(0, 12);
  const trashHelper = path.join(dataDir, `trash-helper-${trashHash}`);
  await fs.writeFile(trashHelper, "", { mode: 0o755 });

  const probeLog = path.join(dataDir, "audio-side-effects.jsonl");
  await fs.writeFile(probeLog, "");
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: PROJECT,
    env: {
      ...process.env,
      MEDIA_DATA_DIR: dataDir,
      MEDIA_SKIP_IMPORT: "1",
      MEDIA_SKIP_RECONCILE: "1",
      MEDIA_NO_WATCH: "1",
      NODE_ENV: "production",
      PORT: String(port),
      SHIGUANG_AUDIO_ANALYSIS: flag ? "1" : "",
      AUDIO_ENGINE_URL: "https://127.0.0.1:9/audio-engine-must-not-be-fetched.tar.gz",
      AUDIO_PROBE_LOG: probeLog,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${PROBE}`.trim(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  const deadline = Date.now() + 15_000;
  let url = null;
  while (Date.now() < deadline) {
    const match = output.match(/拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      url = match[1];
      break;
    }
    if (child.exitCode !== null) throw new Error(`本地服务提前退出：\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(url, `本地服务未在期限内启动：\n${output}`);

  const sessionRes = await fetch(`${url}/api/session`);
  assert.equal(sessionRes.status, 200);
  const setCookie = sessionRes.headers.getSetCookie?.()[0] || sessionRes.headers.get("set-cookie");
  const cookie = String(setCookie).split(";")[0];
  const { token } = await sessionRes.json();
  return { child, output: () => output, url, cookie, token, probeLog };
}

function call(server, pathname, { method = "GET", origin, body } = {}) {
  const headers = { cookie: server.cookie };
  if (method !== "GET") headers["x-local-token"] = server.token;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${server.url}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function audioRequests(server, assetId) {
  return [
    ["GET", "/api/audio-engine/status"],
    ["POST", "/api/audio-engine/install"],
    ["POST", "/api/audio-engine/cancel"],
    ["DELETE", "/api/audio-engine"],
    ["GET", `/api/assets/${assetId}/audio`],
    ["POST", `/api/assets/${assetId}/analyze-audio`, { force: true }],
  ].map(([method, pathname, body]) => ({ method, pathname, body }));
}

test("开关只认服务端显式 =1，默认及其它值一律关闭", () => {
  assert.equal(audioFeatureEnabled({}), false);
  assert.equal(audioFeatureEnabled({ SHIGUANG_AUDIO_ANALYSIS: "" }), false);
  assert.equal(audioFeatureEnabled({ SHIGUANG_AUDIO_ANALYSIS: "0" }), false);
  assert.equal(audioFeatureEnabled({ SHIGUANG_AUDIO_ANALYSIS: "true" }), false);
  assert.equal(audioFeatureEnabled({ SHIGUANG_AUDIO_ANALYSIS: "1" }), true);
});

test("默认关闭：6 路由在 session/Origin 之后 503，零音频副作用，普通入口无回归", async (t) => {
  const { base, dataDir, assetId } = await makeLibrary(t);
  const server = await startServer(t, { dataDir, flag: false });

  // session / Origin 保护仍然先于开关生效
  const noSession = await fetch(`${server.url}/api/audio-engine/status`);
  assert.equal(noSession.status, 401, "未带本机会话应先被 401 拦住");
  const crossOrigin = await fetch(`${server.url}/api/audio-engine/status`, {
    headers: { cookie: server.cookie, origin: "http://evil.example" },
  });
  assert.equal(crossOrigin.status, 403, "跨站 Origin 应先被 403 拦住");

  for (const { method, pathname, body } of audioRequests(server, assetId)) {
    const res = await call(server, pathname, { method, body });
    const text = await res.text();
    assert.equal(res.status, 503, `${method} ${pathname} 应返回 503，实际 ${res.status}: ${text}`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.code, AUDIO_FEATURE_DISABLED, `${method} ${pathname} 应回固定错误码`);
    assert.equal(parsed.error, "音频分析功能未启用");
    assert.equal(text.includes(base), false, "关闭态响应不得泄露本机数据目录");
    assert.equal(AUDIO_PATTERN.test(text), false, "关闭态响应不得泄露引擎路径/下载地址");
  }

  // 普通素材与云认证入口不回归
  const assetRes = await call(server, `/api/assets/${assetId}`);
  assert.equal(assetRes.status, 200);
  const asset = await assetRes.json();
  assert.equal(asset.id, assetId);
  assert.equal(asset.name, "测试音效.wav");

  const cloudRes = await call(server, "/api/cloud-auth/status");
  assert.equal(cloudRes.status, 200);
  assert.equal(typeof (await cloudRes.json()), "object");

  const statsRes = await call(server, "/api/stats");
  assert.equal(statsRes.status, 200);

  // 关闭态无音频实例：不生成 engines 目录、不建 asset_audio 表
  await assert.rejects(fs.access(path.join(dataDir, "engines")), /ENOENT/);
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await exited;

  const db = new Database(path.join(dataDir, "library.sqlite"), { readonly: true });
  const audioTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_audio'").get();
  db.close();
  assert.equal(audioTable, undefined, "默认关闭时不得创建 asset_audio 表");

  // 探针：零音频网络、零音频子进程、零 asset_audio SQL
  const lines = (await fs.readFile(server.probeLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const netHits = lines.filter((line) => line.kind.startsWith("net.") && AUDIO_PATTERN.test(line.detail));
  const processHits = lines.filter(
    (line) => line.kind.startsWith("process.") && /audio-analyze|\btar\b/i.test(line.detail),
  );
  const sqlHits = lines.filter((line) => line.kind.startsWith("db."));
  assert.deepEqual(netHits, [], "关闭态不得发起音频下载/联网");
  assert.deepEqual(processHits, [], "关闭态不得 spawn 音频引擎或 tar");
  assert.deepEqual(sqlHits, [], "关闭态不得执行任何 asset_audio 建表/查询");
  t.diagnostic(`probe: net=${lines.filter((l) => l.kind.startsWith("net.")).length} process=${lines.filter((l) => l.kind.startsWith("process.")).length} sql=${sqlHits.length}`);
});

test("显式 =1 才放行 status；仅创建实例本身仍不建表/不联网/不 spawn", async (t) => {
  const { dataDir } = await makeLibrary(t);
  const server = await startServer(t, { dataDir, flag: true });

  const res = await call(server, "/api/audio-engine/status");
  assert.equal(res.status, 200, "运维显式开启后 status 不应被 503 拦截");
  const body = await res.json();
  assert.equal(body.installed, false);
  assert.equal(body.path, null);
  assert.equal(typeof body.expected, "object");

  // T-LOCAL-012：install 必须显式 confirm，取消接口同样受 session/token 保护。
  const noConfirm = await call(server, "/api/audio-engine/install", { method: "POST", body: {} });
  assert.equal(noConfirm.status, 400, "缺少 confirm 应是 400，而不是开始下载");
  assert.equal((await noConfirm.json()).code, "ENGINE_CONFIRM_REQUIRED");
  const cancel = await call(server, "/api/audio-engine/cancel", { method: "POST", body: {} });
  assert.equal(cancel.status, 200, "空闲时取消应返回当前状态");
  assert.equal((await cancel.json()).installed, false);

  const db = new Database(path.join(dataDir, "library.sqlite"), { readonly: true });
  const audioTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='asset_audio'").get();
  db.close();
  assert.equal(audioTable, undefined, "只读 status 不应建 asset_audio 表");

  const lines = (await fs.readFile(server.probeLog, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.filter((line) => line.kind.startsWith("net.") && AUDIO_PATTERN.test(line.detail)),
    [],
    "未调用 install 不得联网",
  );
  assert.deepEqual(
    lines.filter((line) => line.kind.startsWith("process.") && /audio-analyze|\btar\b/i.test(line.detail)),
    [],
    "未调用 install/analyze 不得 spawn",
  );
  assert.deepEqual(lines.filter((line) => line.kind.startsWith("db.")), [], "status 不应触达 asset_audio");

  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await exited;
});
