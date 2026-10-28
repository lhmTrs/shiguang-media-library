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

test("approval setting routes retain local session, origin and write-token checks", async t => {
  const server = await startServer(t, { enabled: false });
  const route = "/api/cloud-management/upload-approval-settings";
  assert.equal((await fetch(server.url + route)).status, 401);
  assert.equal((await call(server, route, { origin: "http://cross.invalid" })).status, 403);
  assert.equal((await call(server, route, { method: "PUT", body: { thresholdMb: 128, expectedVersion: 0 }, token: false })).status, 403);
  const bad = await call(server, route, { method: "PUT", body: { thresholdMb: 128, expectedVersion: 0, path: "/arbitrary" } });
  assert.equal(bad.status, 400); assert.equal((await bad.json()).code, "INVALID_REQUEST");
  const valid = await call(server, route, { method: "PUT", body: { thresholdMb: 128, expectedVersion: 0 } });
  assert.equal(valid.status, 401); assert.equal((await valid.json()).code, "NOT_LOGGED_IN");
  const read = await call(server, route); assert.equal(read.status, 401); assert.equal((await read.json()).code, "NOT_LOGGED_IN");
});
