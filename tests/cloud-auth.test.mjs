/**
 * T-LOCAL-CLOUD-001：本地认证适配（隔离 mock）验收测试。
 *
 * 全部使用一次性证书 + 本机随机端口的 HTTPS 双向 TLS mock：
 *   - 不连正式云端、不碰真实账户、不使用 18443 旧探针；
 *   - 只读/写临时 MEDIA_DATA_DIR；
 *   - 覆盖：激活、登录、退出、到期刷新 single-flight、刷新响应丢失、重启恢复、
 *     401 撤权、429 冷却、证书失败、账户切换、令牌不外泄；
 *   - #0011 返工回归：退出/配置竞争、半响应/超时/超量、原生文件错误脱敏、429 冷却。
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
import express from "express";
import { Library } from "../server/library.mjs";
import {
  CloudAuth,
  CloudAuthError,
  cloudAuthErrorHandler,
  parseRetryAfterMs,
} from "../server/cloud-auth.mjs";
import { startMockCloud } from "./cloud-auth-mock.mjs";

const PASSWORD = "correct horse battery staple";
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function setup(t, { timeoutMs, idleSocketMs } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-cloud-")));
  const lib = await new Library(path.join(base, "data")).init();
  const cloud = await startMockCloud();
  await cloud.enroll({ username: "alice", password: PASSWORD, displayName: "爱丽丝", superAdmin: true, clientCert: cloud.clientCertA, clientKey: cloud.clientKeyA });
  await cloud.enroll({ username: "bob", password: PASSWORD, displayName: "鲍勃", clientCert: cloud.clientCertB, clientKey: cloud.clientKeyB });
  let now = Date.now();
  const auth = await new CloudAuth(lib, {
    dataDir: lib.dataDir,
    clock: () => now,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(idleSocketMs ? { idleSocketMs } : {}),
  }).init();
  t.after(async () => {
    auth.dispose();
    lib.db.close();
    await cloud.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const configure = (extra = {}) =>
    auth.configure({ origin: cloud.origin, caPath: cloud.caCert, certPath: cloud.clientCertA, keyPath: cloud.clientKeyA, ...extra });
  const secret = () => lib.db.prepare("SELECT encrypted FROM app_secrets WHERE id='cloud.refreshToken'").get();
  return { base, lib, cloud, auth, configure, secret, advance: (ms) => (now += ms) };
}

test("配置要求 HTTPS，且拒绝不存在的证书文件", async (t) => {
  const { auth, cloud } = await setup(t);
  await assert.rejects(() => auth.configure({ origin: "http://127.0.0.1:1", caPath: cloud.caCert, certPath: cloud.clientCertA, keyPath: cloud.clientKeyA }), /HTTPS/);
  await assert.rejects(
    () => auth.configure({ origin: cloud.origin, caPath: path.join(os.tmpdir(), "missing-ca.crt"), certPath: cloud.clientCertA, keyPath: cloud.clientKeyA }),
    /不存在或不可读/,
  );
});

test("登录 → 本人资料 → 退出；对外状态与本地存储都不含令牌", async (t) => {
  const { auth, configure, lib } = await setup(t);
  await configure();
  const state = await auth.login({ username: "alice", password: PASSWORD });
  assert.equal(state.state, "logged-in");
  assert.equal(state.username, "alice");
  assert.equal(state.displayName, "爱丽丝");
  assert.equal(state.hasClientCertificate, true);

  const profile = await auth.me();
  assert.equal(profile.username, "alice");
  assert.equal(profile.superAdmin, true);

  // 对外状态必须脱敏：没有令牌、没有密码、没有本机路径
  const visible = JSON.stringify(auth.getState());
  for (const forbidden of ["accessToken", "refreshToken", "Bearer", PASSWORD, lib.dataDir])
    assert.equal(visible.includes(forbidden), false, `对外状态泄露了 ${forbidden}`);

  // 刷新令牌必须加密存放（不能是明文列）
  const row = lib.db.prepare("SELECT encrypted FROM app_secrets WHERE id='cloud.refreshToken'").get();
  assert.ok(row, "刷新令牌应写入 SecretStore");
  assert.equal(row.encrypted.includes("eyJ"), false, "密文里不应出现明文令牌");
  assert.ok(JSON.parse(row.encrypted).version === 1, "应是 AES-GCM 加密信封");

  const result = await auth.logout();
  assert.equal(result.localLoggedOut, true);
  assert.equal(result.cloudRevoked, true);
  assert.equal(auth.getState().state, "logged-out");
  assert.equal(lib.db.prepare("SELECT encrypted FROM app_secrets WHERE id='cloud.refreshToken'").get(), undefined);
});

test("激活：一次性凭证设置密码并登录", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  const pending = await cloud.enrollPending({ username: "carol", displayName: "卡罗尔", clientCert: cloud.clientCertA });
  const state = await auth.activate({ activationToken: pending.activationToken, password: PASSWORD });
  assert.equal(state.state, "logged-in");
  assert.equal(state.username, "carol");
  await assert.rejects(() => auth.activate({ activationToken: pending.activationToken, password: PASSWORD }), /凭据|无效|UNAUTHORIZED/);
});

test("到期后并发调用只触发一次刷新（single-flight）", async (t) => {
  const { auth, configure, cloud, advance } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  const before = cloud.counts.refresh;
  advance((1800 - 119) * 1000); // 剩余 < 120 秒 → 触发按需刷新
  const results = await Promise.all([auth.me(), auth.me(), auth.me(), auth.me(), auth.me()]);
  assert.equal(results.length, 5);
  assert.equal(cloud.counts.refresh - before, 1, "并发调用只能发出一次刷新请求");
  assert.equal(auth.getState().state, "logged-in");
});

test("刷新响应丢失：转为需重新登录，不无限重试旧令牌", async (t) => {
  const { auth, configure, cloud, advance } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  const before = cloud.counts.refresh;
  cloud.flags.dropRefreshResponse = true;
  advance((1800 - 119) * 1000);
  await assert.rejects(() => auth.me());
  const after = cloud.counts.refresh;
  assert.equal(after - before, 1, "只允许尝试一次刷新");
  const state = auth.getState();
  assert.equal(state.state, "needs-login");
  assert.equal(state.needsLogin, true);
  assert.ok(state.lastError?.code, "应记录脱敏错误码");
  // 再次调用不应再打云端
  await assert.rejects(() => auth.me());
  assert.equal(cloud.counts.refresh, after, "状态不确定后不得继续重试旧令牌");
});

test("重启恢复：正常可续；上次刷新中断则要求重新登录", async (t) => {
  const { auth, configure, lib, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });

  // 正常重启：凭据仍在，首次调用通过刷新拿回 access
  const restarted = await new CloudAuth(lib, { dataDir: lib.dataDir }).init();
  const profile = await restarted.me();
  assert.equal(profile.username, "alice");

  // 模拟"刷新进行中崩溃"：状态文件留 refreshing=true
  const statePath = path.join(lib.dataDir, "cloud-auth-state.json");
  const persisted = JSON.parse(await fs.readFile(statePath, "utf8"));
  await fs.writeFile(statePath, JSON.stringify({ ...persisted, refreshing: true }));
  const crashed = await new CloudAuth(lib, { dataDir: lib.dataDir }).init();
  assert.equal(crashed.getState().state, "needs-login");
  assert.equal(crashed.getState().lastError.code, "REFRESH_INTERRUPTED");
  await assert.rejects(() => crashed.me(), /尚未登录|需重新登录|NOT_LOGGED_IN/);
  void cloud;
});

test("401 撤权：清除凭据并停止重试", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  cloud.revokeAllSessions();
  await assert.rejects(() => auth.me());
  const state = auth.getState();
  assert.equal(state.state, "needs-login");
  assert.equal(state.username, null);
  const tokenRows = (await fs.readdir(auth.dataDir)).filter((f) => f.startsWith("cloud-auth"));
  assert.ok(tokenRows.length >= 1);
});

test("429 限流：记录冷却，冷却期内不再向云端发刷新请求", async (t) => {
  const { auth, configure, cloud, advance } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  cloud.flags.rateLimitRefresh = true;
  advance((1800 - 119) * 1000);
  const before = cloud.counts.refresh;
  await assert.rejects(() => auth.me(), (e) => e.status === 429 || e.code === "RATE_LIMITED");
  assert.equal(cloud.counts.refresh - before, 1, "第一次请求才会真正到达云端");
  assert.equal(auth.getState().state, "rate-limited");
  assert.ok(auth.getState().retryAfterMs > 0, "应暴露 retry-after 剩余时间");

  // 同一可控时刻连续调用：冷却门必须本地拒绝，不能继续轰炸云端
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => auth.refresh(), (e) => e.code === "RATE_LIMITED" && e.retryAfterMs > 0);
  }
  assert.equal(cloud.counts.refresh - before, 1, "冷却期内刷新计数不得增加");

  advance(1000);
  cloud.flags.rateLimitRefresh = false;
  const profile = await auth.me();
  assert.equal(profile.username, "alice");
  assert.equal(auth.getState().state, "logged-in");
});

test("连接拒绝归类为 network，不误标为证书错误", async (t) => {
  const { auth, cloud } = await setup(t);
  const closedPort = await freePort();
  await auth.configure({
    origin: `https://127.0.0.1:${closedPort}`,
    caPath: cloud.caCert,
    certPath: cloud.clientCertA,
    keyPath: cloud.clientKeyA,
  });
  let caught;
  try {
    await auth.login({ username: "alice", password: PASSWORD });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof CloudAuthError);
  assert.equal(caught.kind, "network");
  assert.notEqual(caught.kind, "cert");
});

test("R1：logout 中止迟到的刷新响应，不能把 logged-out 改回 logged-in", async (t) => {
  const { auth, configure, cloud, advance, secret } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  advance((1800 - 119) * 1000);

  const gate = cloud.gateRefreshResponse();
  // 先挂 rejection 处理器，避免 logout 中止请求时产生 unhandledRejection
  const pending = auth.refresh().then(
    () => ({ resolved: true }),
    (error) => ({ error }),
  );
  await gate.entered;
  const logout = await auth.logout();
  assert.equal(logout.cloudRevoked, true);
  assert.equal(auth.getState().state, "logged-out");

  gate.release();
  const outcome = await pending;
  assert.equal(outcome.error?.code, "STALE");
  assert.equal(auth.getState().state, "logged-out", "迟到响应不得恢复登录态");
  assert.equal(secret(), undefined, "迟到响应不得重新写入刷新密文");
  const after = cloud.counts.refresh;
  await assert.rejects(() => auth.me(), /尚未登录|需重新登录|NOT_LOGGED_IN/);
  assert.equal(cloud.counts.refresh, after, "退出后不得再重试旧刷新令牌");
});

test("R1：configure 换身份中止迟到的刷新响应，不把旧凭据带进新上下文", async (t) => {
  const { auth, configure, cloud, advance, secret } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  advance((1800 - 119) * 1000);

  const gate = cloud.gateRefreshResponse();
  const pending = auth.refresh().then(
    () => ({ resolved: true }),
    (error) => ({ error }),
  );
  await gate.entered;
  await configure({ certPath: cloud.clientCertB, keyPath: cloud.clientKeyB });
  assert.equal(auth.getState().state, "logged-out");

  gate.release();
  const outcome = await pending;
  assert.equal(outcome.error?.code, "STALE");
  assert.equal(auth.getState().state, "logged-out");
  assert.equal(secret(), undefined);
  const state = await auth.login({ username: "bob", password: PASSWORD });
  assert.equal(state.username, "bob");
});

test("R2：刷新半响应断流必须收敛为 needs-login，且不卡死 single-flight", async (t) => {
  const { auth, configure, cloud, advance, secret } = await setup(t, { timeoutMs: 400 });
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  advance((1800 - 119) * 1000);
  cloud.flags.partialRefreshResponse = true;
  const before = cloud.counts.refresh;
  const started = Date.now();
  await assert.rejects(() => auth.me(), (e) => e instanceof CloudAuthError);
  assert.ok(Date.now() - started < 1500, "不能悬挂到测试 watchdog 之后");
  assert.equal(cloud.counts.refresh - before, 1);
  assert.equal(auth.getState().state, "needs-login");
  const persisted = JSON.parse(await fs.readFile(path.join(auth.dataDir, "cloud-auth-state.json"), "utf8"));
  assert.equal(persisted.refreshing, false);
  assert.equal(secret(), undefined);

  const after = cloud.counts.refresh;
  await assert.rejects(() => auth.me(), /尚未登录|需重新登录|NOT_LOGGED_IN/);
  assert.equal(cloud.counts.refresh, after, "半响应后不得重试已消费令牌");

  // single-flight 已释放：重新登录可以正常建立新会话
  cloud.flags.partialRefreshResponse = false;
  const state = await auth.login({ username: "alice", password: PASSWORD });
  assert.equal(state.state, "logged-in");
});

test("R2：刷新只给响应头不结束，完整请求 deadline 必须收敛", async (t) => {
  const { auth, configure, cloud, advance } = await setup(t, { timeoutMs: 300 });
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  advance((1800 - 119) * 1000);
  cloud.flags.stallRefreshResponse = true;
  const started = Date.now();
  await assert.rejects(() => auth.me(), (e) => e instanceof CloudAuthError);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 200 && elapsed < 1500, `deadline 应收敛请求，实际 ${elapsed}ms`);
  assert.equal(auth.getState().state, "needs-login");
});

test("R2：刷新响应超量被有界拒绝，不能打满内存", async (t) => {
  const { auth, configure, cloud, advance } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  advance((1800 - 119) * 1000);
  cloud.flags.oversizeRefreshResponse = true;
  await assert.rejects(() => auth.me(), (e) => e instanceof CloudAuthError);
  assert.equal(auth.getState().state, "needs-login");
});

test("R3：配置后证书文件丢失/损坏统一为 CloudAuthError，不暴露本机路径", async (t) => {
  const { base, auth, cloud } = await setup(t);
  const disposable = path.join(base, "disposable-ca.crt");
  await fs.copyFile(cloud.caCert, disposable);
  await auth.configure({ origin: cloud.origin, caPath: disposable, certPath: cloud.clientCertA, keyPath: cloud.clientKeyA });
  await fs.rm(disposable);

  let missing;
  try {
    await auth.login({ username: "alice", password: PASSWORD });
  } catch (e) {
    missing = e;
  }
  assert.ok(missing instanceof CloudAuthError, "原生 ENOENT 必须转换成 CloudAuthError");
  assert.equal(missing.code, "CERT_FILE_UNREADABLE");
  assert.equal(JSON.stringify(missing.toPublic()).includes(base), false, "公开错误不得含临时路径");
  assert.equal(String(missing.message).includes(base), false);

  const corrupt = path.join(base, "corrupt-ca.crt");
  await fs.writeFile(corrupt, "not a certificate\n");
  await auth.configure({ caPath: corrupt });
  let invalid;
  try {
    await auth.login({ username: "alice", password: PASSWORD });
  } catch (e) {
    invalid = e;
  }
  assert.ok(invalid instanceof CloudAuthError, "TLS 构造错误必须转换成 CloudAuthError");
  assert.equal(JSON.stringify(invalid.toPublic()).includes(base), false);
});

test("R3：状态文件写入失败脱敏为 STORAGE_ERROR", async (t) => {
  const { base, auth, cloud } = await setup(t);
  const blocker = path.join(base, "not-a-dir");
  await fs.writeFile(blocker, "x");
  auth.statePath = path.join(blocker, "cloud-auth-state.json");
  let caught;
  try {
    await auth.configure({ origin: cloud.origin, caPath: cloud.caCert, certPath: cloud.clientCertA, keyPath: cloud.clientKeyA });
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof CloudAuthError);
  assert.equal(caught.code, "STORAGE_ERROR");
  assert.equal(JSON.stringify(caught.toPublic()).includes(base), false);
});

test("R3：路由末端兜住非 CloudAuthError，响应与日志都不含原始 message", async (t) => {
  const app = express();
  app.get("/api/cloud-auth/boom", (req, res, next) => next(new Error("ENOENT /tmp/private-xyz/ca.crt")));
  app.get("/api/cloud-auth/rate", (req, res, next) =>
    next(new CloudAuthError("限流", { kind: "cloud", code: "RATE_LIMITED", status: 429, retryAfterMs: 1500, requestId: "req-123" })),
  );
  app.get("/api/cloud-auth/badid", (req, res, next) =>
    next(new CloudAuthError("坏 id", { kind: "cloud", code: "RATE_LIMITED", status: 429, retryAfterMs: 1000, requestId: "<script>" })),
  );
  app.use("/api/cloud-auth", cloudAuthErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  let logged = "";
  const original = console.error;
  console.error = (...args) => {
    logged += args.join(" ") + "\n";
  };
  t.after(() => {
    console.error = original;
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const boom = await fetch(`${base}/api/cloud-auth/boom`);
  const boomBody = await boom.json();
  assert.equal(boom.status, 400);
  assert.equal(boomBody.code, "INTERNAL");
  assert.equal(JSON.stringify(boomBody).includes("/tmp/private-xyz"), false);
  assert.equal(logged.includes("/tmp/private-xyz"), false, "日志不得打印原始 message");

  const rate = await fetch(`${base}/api/cloud-auth/rate`);
  const rateBody = await rate.json();
  assert.equal(rate.status, 429);
  assert.equal(rateBody.retryAfterMs, 1500);
  assert.equal(rateBody.requestId, "req-123");
  assert.equal(rate.headers.get("retry-after"), "2");

  const bad = await fetch(`${base}/api/cloud-auth/badid`);
  const badBody = await bad.json();
  assert.equal(bad.status, 429);
  assert.equal(badBody.requestId, undefined, "不安全 requestId 不得透传");
  assert.equal(JSON.stringify(badBody).includes("<script>"), false);
});

test("R4：Retry-After 数字秒/HTTP 日期/非法值都有安全边界", () => {
  const now = Date.parse("2026-10-22T04:00:00Z");
  assert.equal(parseRetryAfterMs("1", now), 1000);
  assert.equal(parseRetryAfterMs("0", now), 1000, "0 秒也要至少冷却 1 秒");
  assert.equal(parseRetryAfterMs("1.5", now), 1500);
  const date = new Date(now + 5000).toUTCString();
  assert.equal(parseRetryAfterMs(date, now), 5000);
  assert.equal(parseRetryAfterMs("not-a-date", now), 60_000);
  assert.equal(parseRetryAfterMs(undefined, now), 60_000);
  assert.ok(parseRetryAfterMs("999999999", now) <= 24 * 3600 * 1000);
});

test("R3：整站隔离 HTTP 下证书丢失只回固定公开码，日志不含本机路径", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-cloud-http-")));
  const dataDir = path.join(base, "data");
  const cloud = await startMockCloud();
  await cloud.enroll({ username: "alice", password: PASSWORD, displayName: "爱丽丝", clientCert: cloud.clientCertA, clientKey: cloud.clientKeyA });

  // 避免临时数据目录触发 trash.swift 编译：按 index.mjs 的版本名放一个可执行占位
  await fs.mkdir(dataDir, { recursive: true });
  const trashHash = crypto.createHash("sha256").update(await fs.readFile(path.join(PROJECT, "server/trash.swift"))).digest("hex").slice(0, 12);
  const trashHelper = path.join(dataDir, `trash-helper-${trashHash}`);
  await fs.writeFile(trashHelper, "", { mode: 0o755 });

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
    await cloud.close();
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
  assert.equal(sessionRes.status, 200);
  const setCookie = sessionRes.headers.getSetCookie?.()[0] || sessionRes.headers.get("set-cookie");
  const cookie = String(setCookie).split(";")[0];
  const { token } = await sessionRes.json();
  const headers = { cookie, "x-local-token": token, "content-type": "application/json" };

  const caCopy = path.join(base, "session-ca.crt");
  await fs.copyFile(cloud.caCert, caCopy);
  const configured = await fetch(`${url}/api/cloud-auth/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ origin: cloud.origin, caPath: caCopy, certPath: cloud.clientCertA, keyPath: cloud.clientKeyA }),
  });
  assert.equal(configured.status, 200, await configured.text());
  await fs.rm(caCopy);

  const login = await fetch(`${url}/api/cloud-auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "alice", password: PASSWORD }),
  });
  const body = await login.json();
  assert.equal(login.status, 400);
  assert.equal(body.code, "CERT_FILE_UNREADABLE");
  assert.equal(JSON.stringify(body).includes(base), false, "HTTP 响应不得含本机路径");
  assert.equal(JSON.stringify(body).includes(PASSWORD), false);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(output.includes(caCopy), false, "服务端日志不得含证书路径");
  assert.equal(output.includes(PASSWORD), false, "服务端日志不得含密码");
});

// ── T-LOCAL-011：受控 keep-alive 与材料轮换 ─────────────────

test("受控 keep-alive：同身份连续请求复用 TLS 连接，dispose 后销毁旧池", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  const base = cloud.secureConnections();
  const first = await auth.me();
  const second = await auth.me();
  assert.equal(first.username, "alice");
  assert.equal(second.username, "alice");
  assert.equal(cloud.secureConnections(), base, "连续请求不得重新握手");

  const pool = auth.getConnectionPoolInfo();
  assert.equal(pool.configured, true);
  assert.equal(pool.maxSockets, 4);
  assert.equal(pool.maxFreeSockets, 4);
  assert.ok(pool.freeSockets >= 1 && pool.freeSockets <= 4, `空闲池必须有界，实际 ${pool.freeSockets}`);

  auth.dispose();
  assert.equal(auth.getConnectionPoolInfo().configured, false);
  const afterDispose = cloud.secureConnections();
  await auth.me();
  assert.equal(cloud.secureConnections(), afterDispose + 1, "dispose 后必须重新握手");
});

test("keep-alive 并发有界：同批最多 4 条连接，下一批全部复用", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  await auth.me(); // 预热一条空闲连接
  const base = cloud.secureConnections();
  const results = await Promise.all(Array.from({ length: 8 }, () => auth.me()));
  assert.equal(results.every((item) => item.username === "alice"), true);
  const opened = cloud.secureConnections() - base;
  assert.ok(opened >= 0 && opened <= 4, `并发连接必须 <= maxSockets 4，实际新增 ${opened}`);

  const beforeSecond = cloud.secureConnections();
  await Promise.all(Array.from({ length: 4 }, () => auth.me()));
  assert.equal(cloud.secureConnections(), beforeSecond, "第二批必须复用空闲连接");
});

test("同一路径续换材料：下一请求使用新材料，不沿用旧连接", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  assert.equal((await auth.me()).username, "alice");
  const before = cloud.secureConnections();
  const poolBefore = auth.getConnectionPoolInfo();
  assert.equal(poolBefore.generations, 1);

  // 同一路径覆写设备私钥（内容变化、密钥本身不变），模拟证书续换。
  const keyPem = await fs.readFile(cloud.clientKeyA, "utf8");
  await fs.writeFile(cloud.clientKeyA, keyPem.trimEnd() + "\n\n");
  const refreshed = await auth.me();
  assert.equal(refreshed.username, "alice");
  assert.equal(cloud.secureConnections(), before + 1, "材料变化必须重建连接");
  assert.equal(auth.getConnectionPoolInfo().generations, 2);

  const again = cloud.secureConnections();
  await auth.me();
  assert.equal(cloud.secureConnections(), again, "新池建立后继续复用，不是每请求重连");
});

test("退出/重新登录销毁旧池；新会话从新连接开始", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  await auth.me();
  assert.equal(auth.getConnectionPoolInfo().configured, true);
  await auth.logout();
  assert.equal(auth.getConnectionPoolInfo().configured, false, "退出后必须销毁空闲池");
  const base = cloud.secureConnections();
  await auth.login({ username: "alice", password: PASSWORD });
  assert.ok(cloud.secureConnections() > base, "重新登录必须新建连接");
  assert.equal((await auth.me()).username, "alice");
  assert.ok(auth.getConnectionPoolInfo().generations >= 2);
});

test("空闲连接有界回收：核心 Agent 不支持 freeSocketTimeout，超时后真实关闭并重连", async (t) => {
  // Node 22.7.0 的 _http_agent 不读取 freeSocketTimeout；生产默认 30s，
  // 这里注入 250ms 证明“真正关闭空闲 socket、下一次重新握手”，不用等 30 秒。
  const { auth, configure, cloud } = await setup(t, { idleSocketMs: 250 });
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  assert.equal((await auth.me()).username, "alice");

  const pool = auth.getConnectionPoolInfo();
  assert.equal(pool.idleSocketMs, 250);
  assert.ok(pool.freeSockets >= 1, `应有一条空闲连接，实际 ${pool.freeSockets}`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(auth.getConnectionPoolInfo().idleTimers, auth.getConnectionPoolInfo().freeSockets);

  const base = cloud.secureConnections();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && auth.getConnectionPoolInfo().freeSockets > 0)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(auth.getConnectionPoolInfo().freeSockets, 0, "空闲超时后必须从池中移除");
  assert.equal(auth.getConnectionPoolInfo().idleTimers, 0, "回收后不能遗留计时器");

  await auth.me();
  assert.equal(cloud.secureConnections(), base + 1, "空闲连接被回收后，下一次请求必须重新握手");
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ── T-LOCAL-014B：音频内容流复用同一 mTLS 池、epoch 中止、固定 UUID ─────

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let ended = false;
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => {
      ended = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on("close", () => {
      if (!ended) reject(new Error("stream closed"));
    });
  });
}

test("音频内容流：连续三次下载只握手一次，字节与声明长度一致", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  const catalog = await auth.proxy("GET", "/media/audio/catalog?limit=50&offset=0");
  assert.equal(catalog.items.length, 1);
  const details = await auth.proxy("GET", `/media/audio/${cloud.audio.audioId}?limit=50&offset=0`);
  assert.equal(details.shares.length, 1);
  const base = cloud.secureConnections();
  for (let i = 0; i < 3; i += 1) {
    const opened = await auth.openAudioContentStream(cloud.audio.audioId);
    assert.equal(opened.status, 200);
    assert.equal(opened.headers["content-type"], "audio/wav");
    assert.equal(Number(opened.headers["content-length"]), cloud.audio.bytes.length);
    const received = await collect(opened.body);
    assert.equal(received.length, cloud.audio.bytes.length);
    assert.equal(crypto.createHash("sha256").update(received).digest("hex"), cloud.audio.sha256);
  }
  assert.equal(cloud.secureConnections(), base, "顺序下载必须复用同一套 TLS 池，不得每请求握手");
  assert.equal(cloud.counts.audioContent, 3);
});

test("音频内容流：logout/config 变化中止在途流；旧 epoch 不能复用新会话", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  cloud.flags.audioStall = true;
  const opened = await auth.openAudioContentStream(cloud.audio.audioId);
  const reading = collect(opened.body);
  reading.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stale = auth.epoch;
  const logout = await auth.logout();
  assert.equal(logout.localLoggedOut, true);
  await assert.rejects(reading, "logout 后旧流必须被中止");
  assert.notEqual(auth.epoch, stale);
  await assert.rejects(
    () => auth.openAudioContentStream(cloud.audio.audioId, { epoch: stale }),
    (error) => error.code === "STALE",
  );

  // 重新登录后旧 epoch 仍不能下载，新会话正常。
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  await assert.rejects(
    () => auth.openAudioContentStream(cloud.audio.audioId, { epoch: stale }),
    (error) => error.code === "STALE",
  );
  cloud.flags.audioStall = false;
  const fresh = await auth.openAudioContentStream(cloud.audio.audioId);
  assert.equal(fresh.status, 200);
  assert.equal((await collect(fresh.body)).length, cloud.audio.bytes.length);

  // 配置身份变化（换成另一张设备证书）同样中止在途流。
  cloud.flags.audioStall = true;
  const second = await auth.openAudioContentStream(cloud.audio.audioId);
  const secondReading = collect(second.body);
  secondReading.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  await auth.configure({ certPath: cloud.clientCertB, keyPath: cloud.clientKeyB });
  await assert.rejects(secondReading, "身份变化后旧流必须被中止");
  cloud.flags.audioStall = false;
});

test("音频内容流：只接受规范小写 UUID，非法标识不发请求", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  const before = cloud.counts.audioContent;
  for (const bad of ["../catalog", "11111111-2222-4333-8444-55555555555Z", "", null])
    await assert.rejects(
      () => auth.openAudioContentStream(bad),
      (error) => error.code === "INVALID_REQUEST",
    );
  assert.equal(cloud.counts.audioContent, before);
});

test("音频内容流：响应头之后 abort 仍会销毁实际 body 并只清理一次", async (t) => {
  const { auth, configure, cloud } = await setup(t);
  await configure();
  await auth.login({ username: "alice", password: PASSWORD });
  const base = cloud.secureConnections();
  cloud.flags.audioStall = true;
  const controller = new AbortController();
  const opened = await auth.openAudioContentStream(cloud.audio.audioId, { signal: controller.signal });
  const body = opened.body;
  let errors = 0;
  body.on("error", () => { errors += 1; });
  body.resume();
  assert.equal(body.destroyed, false);
  controller.abort();
  const deadline = Date.now() + 3000;
  while (!body.destroyed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(body.destroyed, true, "abort 必须停止已打开 body，而不是只在 fetch 头阶段生效");
  assert.ok(errors <= 1, "body 不应重复收到取消错误");
  assert.equal(auth.activeRequests ? auth.activeRequests.size : 0, 0);
  assert.equal(cloud.secureConnections(), base, "取消不应改变身份池的握手计数");
  cloud.flags.audioStall = false;
});
