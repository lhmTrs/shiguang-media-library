/**
 * T-LOCAL-014B：云端音频下载本地 HTTP 边界测试。
 *
 * 验证默认可用/显式关闭后的固定路由、会话/Origin/CSRF、DTO 校验与脱敏；
 * 不登录真实云端、不连接服务器、不扫描真实素材。使用临时 dataDir + 随机端口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t, { enabled }) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-ca-route-")));
  const dataDir = path.join(base, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const trashHash = crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(PROJECT, "server/trash.swift")))
    .digest("hex")
    .slice(0, 12);
  await fs.writeFile(path.join(dataDir, `trash-helper-${trashHash}`), "", { mode: 0o755 });
  const port = await freePort();
  const featureEnv = { ...process.env };
  if (enabled === undefined) delete featureEnv.MEDIA_CLOUD_AUDIO_ENABLED;
  else featureEnv.MEDIA_CLOUD_AUDIO_ENABLED = enabled ? "1" : "0";
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: PROJECT,
    env: {
      ...featureEnv,
      MEDIA_DATA_DIR: dataDir,
      MEDIA_SKIP_IMPORT: "1",
      MEDIA_SKIP_RECONCILE: "1",
      MEDIA_NO_WATCH: "1",
      NODE_ENV: "production",
      PORT: String(port),
      SHIGUANG_AUDIO_ANALYSIS: "",
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
    await fs.rm(base, { recursive: true, force: true });
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
  const setCookie = sessionRes.headers.getSetCookie?.()[0] || sessionRes.headers.get("set-cookie");
  const cookie = String(setCookie).split(";")[0];
  const { token } = await sessionRes.json();
  return { base, dataDir, child, output: () => output, url, cookie, token };
}

function call(server, pathname, { method = "GET", origin, body, token = true } = {}) {
  const headers = { cookie: server.cookie };
  if (method !== "GET" && token) headers["x-local-token"] = server.token;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${server.url}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("显式关闭：session/Origin 之后统一 503 CLOUD_AUDIO_DISABLED，零目录/零网络", async (t) => {
  const server = await startServer(t, { enabled: false });
  const noSession = await fetch(`${server.url}/api/cloud-audio/status`);
  assert.equal(noSession.status, 401, "未带本机会话应先 401");
  const crossOrigin = await call(server, "/api/cloud-audio/status", { origin: "http://evil.example" });
  assert.equal(crossOrigin.status, 403, "跨站 Origin 应先 403");
  const disabledStatus = await call(server, "/api/cloud-audio/status");
  assert.equal(disabledStatus.status, 200, "status 必须可读，供 UI 显示不可用而不是无限转圈");
  assert.equal((await disabledStatus.json()).enabled, false);
  for (const [method, pathname, body] of [
    ["GET", "/api/cloud-audio/catalog"],
    ["GET", "/api/cloud-audio/roots"],
    ["POST", "/api/cloud-audio/roots", { path: "/tmp" }],
    ["GET", "/api/cloud-audio/jobs"],
    ["POST", "/api/cloud-audio/jobs", {}],
  ]) {
    const res = await call(server, pathname, { method, body });
    const text = await res.text();
    const parsed = JSON.parse(text);
    assert.equal(res.status, 503, `${method} ${pathname}: ${text}`);
    assert.equal(parsed.code, "CLOUD_AUDIO_DISABLED");
    assert.equal(parsed.error, "云端音频下载未启用");
    assert.equal(text.includes(server.base), false, "不得泄露本机路径");
  }
  await assert.rejects(fs.access(path.join(server.dataDir, "cloud-audio-tmp")), /ENOENT/);
  await assert.rejects(fs.access(path.join(server.dataDir, "cloud-audio-jobs.json")), /ENOENT/);
});

test("新安装默认开启入口，但不登录、不自动上传；仍受本机会话保护", async (t) => {
  const server = await startServer(t, {});
  const unauthorized = await fetch(`${server.url}/api/cloud-audio/status`);
  assert.equal(unauthorized.status, 401);
  const response = await call(server, "/api/cloud-audio/status");
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.enabled, true);
  assert.equal(status.loggedIn, false);
  assert.equal(status.active, 0);
  assert.equal(status.queued, 0);
});

test("显式开启：status 可用；未配置/未登录时固定错误；写操作仍需本机 token", async (t) => {
  const server = await startServer(t, { enabled: true });
  const status = await call(server, "/api/cloud-audio/status");
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.enabled, true);
  assert.equal(body.maxActive, 2);
  assert.equal(body.maxPending, 12);
  assert.equal(JSON.stringify(body).includes(server.base), false);

  const noToken = await call(server, "/api/cloud-audio/roots", {
    method: "POST",
    body: { path: "/tmp" },
    token: false,
  });
  assert.equal(noToken.status, 403, "写操作缺本机 token 必须 403");
  assert.equal((await noToken.text()).includes("cloud-audio"), false);

  const catalog = await call(server, "/api/cloud-audio/catalog?limit=50&offset=0");
  assert.equal(catalog.status, 503);
  assert.equal((await catalog.json()).code, "NOT_CONFIGURED");

  const register = await call(server, "/api/cloud-audio/roots", { method: "POST", body: { path: server.base } });
  assert.equal(register.status, 503);
  assert.equal((await register.json()).code, "NOT_CONFIGURED");

  const list = await call(server, "/api/cloud-audio/jobs");
  assert.equal(list.status, 503, "未配置身份时任务列表也必须拒绝，不能返回跨身份记录");
  assert.equal((await list.json()).code, "NOT_CONFIGURED");

  const badId = await call(server, "/api/cloud-audio/audio/not-a-uuid");
  assert.equal(badId.status, 400);
  assert.equal((await badId.json()).code, "INVALID_REQUEST");

  // 临时工作目录只在显式开启后创建；任务文件在第一次真正的任务写入时才落盘。
  assert.equal((await fs.stat(path.join(server.dataDir, "cloud-audio-tmp"))).mode & 0o777, 0o700);
  await assert.rejects(fs.access(path.join(server.dataDir, "cloud-audio-provenance.json")), /ENOENT/);
});

test("未知 cloud-audio 子路径不进入固定 API 错误处理，保持既有的静态回退行为", async (t) => {
  const server = await startServer(t, { enabled: false });
  const res = await call(server, "/api/cloud-audio/nope");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!doctype html>/i);
});
