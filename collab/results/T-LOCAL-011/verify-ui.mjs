/**
 * T-LOCAL-011 可复跑验收：账户页慢加载定位与最小修复。
 *
 * 覆盖：
 *  1) 真实主页面（真实 App，非夹具）首屏/空闲/显式刷新/切页签的 profile 请求数；
 *  2) 父级每 200ms 无关重渲染的隔离夹具：修复前依赖 vs 当前实现；
 *  3) 后端连接池基准：旧 agent:false 等价基线 vs 受控 keep-alive（握手次数/时延）；
 *  4) 双刷新在途合并、pool 上限/清理断言；空闲 socket 真实回收（短计时器）；
 *  5) 403 权限失效与写后刷新：旧 profile 在途时强制新一轮，旧响应不得回填旧权限。
 *
 * 只用临时 MEDIA_DATA_DIR、一次性 HTTPS/mTLS mock、合成账户；不连正式云端。
 * 运行：node collab/results/T-LOCAL-011/verify-ui.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "vite";
import { Library } from "../../../server/library.mjs";
import { CloudAuth } from "../../../server/cloud-auth.mjs";
import { CloudManagement } from "../../../server/cloud-management.mjs";
import { startManagementCloud } from "../../../tests/cloud-management-mock.mjs";

const PASSWORD = "correct horse battery staple";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "../../..");
const SCREENS = path.join(HERE, "screenshots");
const HARNESS = path.join(HERE, "harness");
const result = { startedAt: new Date().toISOString(), checks: [], metrics: {}, screenshots: [], errors: [] };

await fs.mkdir(SCREENS, { recursive: true });
const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-t11-ui-")));

const note = (label, detail) => result.checks.push({ label, detail, at: new Date().toISOString() });
const record = (key, value) => (result.metrics[key] = value);
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: PROJECT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      MEDIA_DATA_DIR: dataDir,
      MEDIA_SKIP_IMPORT: "1",
      MEDIA_SKIP_RECONCILE: "1",
      MEDIA_NO_WATCH: "1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (logs += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (logs += chunk));
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (logs.includes(`http://127.0.0.1:${port}`)) return { child, port, url: `http://127.0.0.1:${port}`, logs: () => logs };
    if (child.exitCode !== null) throw new Error(`服务提前退出：\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGKILL");
  throw new Error(`服务启动超时：\n${logs}`);
}

async function stopServer(server) {
  if (server.child.exitCode === null) {
    server.child.kill("SIGTERM");
    await Promise.race([once(server.child, "exit"), new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
  }
}

function startStatic(dist, backendPort) {
  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith("/api/")) {
      const proxy = http.request(
        {
          hostname: "127.0.0.1",
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${backendPort}` },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxy.on("error", () => {
        res.statusCode = 502;
        res.end("bad gateway");
      });
      req.pipe(proxy);
      return;
    }
    const url = new URL(req.url, "http://localhost");
    let file = path.join(dist, decodeURIComponent(url.pathname));
    try {
      const stat = await fs.stat(file);
      if (stat.isDirectory()) file = path.join(file, "index.html");
      const body = await fs.readFile(file);
      res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function profileCalls(page) {
  const calls = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/cloud-management/profile")) calls.push({ at: Date.now(), method: request.method() });
  });
  return calls;
}

async function waitFor(check, timeout = 8_000, label = "条件") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label}等待超时`);
}

async function waitReady(page) {
  await page.locator(".cw-tabs").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(250);
}

async function loginBackend(baseUrl, cloud) {
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  assert.equal(sessionResponse.status, 200);
  const setCookie = sessionResponse.headers.getSetCookie?.()[0] || sessionResponse.headers.get("set-cookie");
  const cookie = String(setCookie).split(";")[0];
  const session = await sessionResponse.json();
  const headers = { "content-type": "application/json", cookie, "x-local-token": session.token };
  let response = await fetch(`${baseUrl}/api/cloud-auth/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      origin: cloud.origin,
      caPath: cloud.caCert,
      certPath: cloud.clientOwner.cert,
      keyPath: cloud.clientOwner.key,
    }),
  });
  assert.equal(response.status, 200, await response.text());
  response = await fetch(`${baseUrl}/api/cloud-auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  assert.equal(response.status, 200, await response.text());
  return cookie;
}

async function addCookie(context, cookie) {
  const [name, ...rest] = cookie.split("=");
  await context.addCookies([{ name, value: rest.join("="), domain: "127.0.0.1", path: "/" }]);
}

async function buildHarness() {
  const configFile = path.join(HARNESS, "vite.config.mjs");
  for (const mode of ["legacy", "current"]) {
    await build({ configFile, mode, logLevel: "warn" });
    note(`构建隔离夹具 ${mode}`, "vite build 退出 0");
  }
}

/** 旧实现等价基线：每请求 agent:false + 重新读 TLS 文件，不复用连接。 */
async function legacyProfileRound(cloud, accessToken) {
  const ca = await fs.readFile(cloud.caCert);
  const cert = await fs.readFile(cloud.clientOwner.cert);
  const key = await fs.readFile(cloud.clientOwner.key);
  const get = (pathname) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        cloud.origin + "/api/v1" + pathname,
        {
          method: "GET",
          headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
          ca,
          cert,
          key,
          rejectUnauthorized: true,
          agent: false,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
            try {
              resolve(JSON.parse(text).data);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  return Promise.all([get("/me"), get("/me/capabilities"), get("/me/devices")]);
}

const server = await startServer();
const cloud = await startManagementCloud();
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
let benchLib = null;
let benchAuth = null;
try {
  const cookie = await loginBackend(server.url, cloud);

  // ── 1. 真实主页面 ───────────────────────────────────────
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await addCookie(context, cookie);
    await context.addInitScript(() => {
      localStorage.setItem("shiguang.pageSize", "20");
      localStorage.setItem("shiguang.refreshSeconds", "0");
    });
    const page = await context.newPage();
    const calls = profileCalls(page);
    const groupCalls = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/cloud-management/groups?management=")) groupCalls.push(request.url());
    });
    const t0 = Date.now();
    await page.goto(`${server.url}/#/account`);
    await waitReady(page);
    const readyMs = Date.now() - t0;
    const afterReady = calls.length;
    await page.waitForTimeout(2500);
    const afterIdle = calls.length;
    await page.locator(".cw-header-actions button[aria-label='刷新管理数据']").click();
    await page.waitForTimeout(600);
    const afterRefresh = calls.length;
    // 连续两次点击：在途合并应只发出一条新的 profile 请求。
    await page.evaluate(() => {
      const button = document.querySelector(".cw-header-actions button[aria-label='刷新管理数据']");
      button?.click();
      button?.click();
    });
    await page.waitForTimeout(700);
    const afterDouble = calls.length;
    await page.getByRole("button", { name: "小组与成员", exact: true }).click().catch(() => undefined);
    await page.waitForTimeout(250);
    await page.getByRole("button", { name: "个人安全", exact: true }).click().catch(() => undefined);
    await page.waitForTimeout(300);
    const afterTabs = calls.length;
    await page.screenshot({ path: path.join(SCREENS, "account-1280x800.png"), animations: "disabled" });

    // 角色页本身不应预取“账户授权”才需要的组列表；进入子视图后再取。
    groupCalls.length = 0;
    await page.getByRole("button", { name: "角色与授权", exact: true }).click();
    await page.locator(".cw-panel[aria-label='角色与授权']").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(900);
    const groupsBeforeAuth = groupCalls.length;
    await page.getByRole("button", { name: "账户授权", exact: true }).click();
    await page.waitForTimeout(900);
    const groupsAfterAuth = groupCalls.length;

    record("realApp", { readyMs, afterReady, afterIdle, afterRefresh, afterDouble, afterTabs, groupsBeforeAuth, groupsAfterAuth, total: calls.length });
    assert.equal(afterReady, 1, "首屏只应读取一次 profile");
    assert.equal(afterIdle, afterReady, "空闲期间不得重复读取 profile");
    assert.equal(afterRefresh, afterReady + 1, "显式刷新只增加一次");
    assert.equal(afterDouble, afterRefresh + 1, "连续双击刷新应合并在途读取");
    assert.equal(afterTabs, afterDouble, "切换已加载页签不得重复读取 profile");
    assert.equal(groupsBeforeAuth, 0, "角色权限视图不得预取账户授权才需要的组列表");
    assert.ok(groupsAfterAuth >= 1, "进入账户授权后必须按需读取组列表");
    note(
      "真实主页面请求数",
      `首屏 ${afterReady}，空闲 +0，显式刷新 +1，双刷 +1，切页签 +0；角色页组列表预取 ${groupsBeforeAuth}，进入账户授权后 ${groupsAfterAuth}；就绪 ${readyMs}ms`,
    );
    result.screenshots.push("screenshots/account-1280x800.png");
    await context.close();
  }

  // ── 2. 父级重渲染夹具：legacy vs current ────────────────
  await buildHarness();
  const harness = [];
  for (const mode of ["legacy", "current"]) {
    const dist = path.join(HARNESS, mode === "legacy" ? "dist-legacy" : "dist");
    const site = await startStatic(dist, server.port);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await addCookie(context, cookie);
    const page = await context.newPage();
    const calls = profileCalls(page);
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${site.port}/`);
    await waitReady(page);
    const readyMs = Date.now() - t0;
    const initial = calls.length;
    const cloudStart = cloud.requests.length;
    const connStart = cloud.secureConnections();
    await page.waitForTimeout(2000);
    const after = calls.length;
    const cloudRequests = cloud.requests.length - cloudStart;
    const handshakes = cloud.secureConnections() - connStart;
    harness.push({ mode, readyMs, initial, after, delta: after - initial, cloudRequests, handshakes });
    await context.close();
    await new Promise((resolve) => site.server.close(resolve));
  }
  const legacy = harness.find((item) => item.mode === "legacy");
  const current = harness.find((item) => item.mode === "current");
  record("parentRerenderHarness", harness);
  assert.ok(legacy.delta >= 5, `旧依赖应随父级重渲染反复加载，实际 ${legacy.delta}`);
  assert.equal(current.delta, 0, "修复后父级 10 次重渲染不得新增 profile 请求");
  assert.equal(current.initial, 1);
  note(
    "父级重渲染夹具",
    `2 秒内父级重渲染 10 次：修复前 profile ${legacy.initial}→${legacy.after}（+${legacy.delta}，云请求 ${legacy.cloudRequests}，握手 ${legacy.handshakes}）；修复后 ${current.initial}→${current.after}（+0，云请求 ${current.cloudRequests}，握手 ${current.handshakes}）`,
  );

  // ── 3. 后端连接池基准（独立临时库 + 同一 mock）────────
  const benchDir = path.join(dataDir, "bench");
  benchLib = await new Library(benchDir).init();
  benchAuth = await new CloudAuth(benchLib, { dataDir: benchLib.dataDir }).init();
  await benchAuth.configure({
    origin: cloud.origin,
    caPath: cloud.caCert,
    certPath: cloud.clientOwner.cert,
    keyPath: cloud.clientOwner.key,
  });
  await benchAuth.login({ username: "owner", password: PASSWORD });
  const mgmt = new CloudManagement(benchLib, { cloudAuth: benchAuth });

  const legacyStart = cloud.secureConnections();
  const legacyTime = performance.now();
  for (let i = 0; i < 5; i += 1) await legacyProfileRound(cloud, benchAuth.accessToken);
  const legacyMs = Math.round(performance.now() - legacyTime);
  const legacyHandshakes = cloud.secureConnections() - legacyStart;

  // 冷启动受控池，确保基准不从前面页面流量“白捡”连接。
  benchAuth.dispose();
  const fixedStart = cloud.secureConnections();
  const fixedTime = performance.now();
  for (let i = 0; i < 5; i += 1) await mgmt.profile();
  const fixedMs = Math.round(performance.now() - fixedTime);
  const fixedHandshakes = cloud.secureConnections() - fixedStart;

  const seqStart = cloud.secureConnections();
  const seqTime = performance.now();
  for (let i = 0; i < 20; i += 1) await benchAuth.me();
  const seqMs = Math.round(performance.now() - seqTime);
  const seqHandshakes = cloud.secureConnections() - seqStart;
  const pool = benchAuth.getConnectionPoolInfo();
  record("backendBenchmark", {
    rounds: 5,
    requestsPerRound: 3,
    legacyAgentFalse: { handshakes: legacyHandshakes, totalMs: legacyMs, avgRoundMs: Math.round(legacyMs / 5) },
    controlledKeepAlive: { handshakes: fixedHandshakes, totalMs: fixedMs, avgRoundMs: Math.round(fixedMs / 5) },
    sequential20: { handshakes: seqHandshakes, totalMs: seqMs, pool },
  });
  assert.equal(legacyHandshakes, 15, "旧 agent:false 基线每请求一次握手");
  assert.ok(fixedHandshakes >= 1 && fixedHandshakes <= 3, `受控池 5 轮只应首轮握手，实际 ${fixedHandshakes}`);
  assert.equal(seqHandshakes, 0, "顺序 20 次 me 必须完全复用连接");
  assert.equal(pool.maxSockets, 4);
  assert.equal(pool.maxFreeSockets, 4);
  note(
    "后端连接池基准",
    `5 轮×3 请求：agent:false ${legacyHandshakes} 次握手/${legacyMs}ms；受控池 ${fixedHandshakes} 次握手/${fixedMs}ms；随后 20 次顺序 me ${seqHandshakes} 次握手/${seqMs}ms`,
  );

  // ── 4. 空闲 socket 真实回收（核心 Agent 不支持 freeSocketTimeout）──
  {
    const idleDir = path.join(dataDir, "idle");
    const idleLib = await new Library(idleDir).init();
    const idleAuth = await new CloudAuth(idleLib, { dataDir: idleLib.dataDir, idleSocketMs: 250 }).init();
    try {
      await idleAuth.configure({
        origin: cloud.origin,
        caPath: cloud.caCert,
        certPath: cloud.clientOwner.cert,
        keyPath: cloud.clientOwner.key,
      });
      await idleAuth.login({ username: "owner", password: PASSWORD });
      await idleAuth.me();
      assert.ok(idleAuth.getConnectionPoolInfo().freeSockets >= 1, "空闲连接应入池");
      const idleBase = cloud.secureConnections();
      await waitFor(() => idleAuth.getConnectionPoolInfo().freeSockets === 0, 4_000, "空闲连接回收");
      assert.equal(idleAuth.getConnectionPoolInfo().idleTimers, 0, "回收后不得遗留计时器");
      await idleAuth.me();
      assert.equal(cloud.secureConnections(), idleBase + 1, "回收后下一次请求必须重新握手");
      record("idleSocketReclaim", {
        configuredIdleMs: 250,
        productionIdleMs: 30_000,
        handshakeAfterReclaim: 1,
        coreFreeSocketTimeoutSupported: false, // Node 22.7.0 _http_agent 无该选项
      });
      note("空闲 socket 回收", "250ms 注入计时器：空闲池清零、计时器清零，下一次请求重新握手；生产默认 30s");
    } finally {
      idleAuth.dispose();
      idleLib.db.close();
    }
  }

  // ── 5. 403 权限失效 / 写后刷新：旧 profile 在途也不得回填 ──
  {
    const owner = cloud.state.accounts.get(cloud.ids.owner);
    owner.superAdmin = true;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await addCookie(context, cookie);
    await context.addInitScript(() => localStorage.setItem("shiguang.refreshSeconds", "0"));
    const page = await context.newPage();
    const calls = profileCalls(page);
    try {
      await page.goto(`${server.url}/#/account`);
      await waitReady(page);
      assert.equal(await page.locator(".cw-tabs button", { hasText: "账户管理" }).count(), 1, "前置：owner 应有账户管理入口");

      // 让一次 profile（/me 子请求）停在服务端；随后撤权并从账户页触发 403。
      const hold = cloud.holdNext("/api/v1/me");
      const before = calls.length;
      await page.locator(".cw-header-actions button[aria-label='刷新管理数据']").click();
      await hold.arrived;
      await waitFor(() => calls.length === before + 1, 4_000, "旧 profile 在途");
      owner.superAdmin = false;
      await page.locator(".cw-tabs button", { hasText: "账户管理" }).click();
      // 403 必须另起一轮 profile，而不是复用旧的在途 promise。
      await waitFor(() => calls.length >= before + 2, 8_000, "403 后新 profile");
      const whileHeld = calls.length;
      hold.release();
      await page.waitForTimeout(500);
      assert.equal(calls.length, whileHeld, "迟到的旧 profile 不得再触发请求");
      assert.equal(await page.locator(".cw-tabs button", { hasText: "账户管理" }).count(), 0, "旧 capabilities 不得回填账户入口");
      assert.equal(await page.locator(".cw-tabs button", { hasText: "角色与授权" }).count(), 0, "旧 capabilities 不得回填角色入口");
      record("profile403Race", { initial: before, whileHeld, afterRelease: calls.length, superAdminRestored: true });
      note("403 权限竞态", `旧 profile 在途（累计 ${before + 1}）→ 403 → 强制新请求（累计 ${before + 2}）；放行旧响应后仍停在 ${calls.length}，旧权限未回填`);
    } finally {
      owner.superAdmin = true;
      await context.close();
    }
  }

  {
    const owner = cloud.state.accounts.get(cloud.ids.owner);
    owner.superAdmin = true;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await addCookie(context, cookie);
    await context.addInitScript(() => localStorage.setItem("shiguang.refreshSeconds", "0"));
    const page = await context.newPage();
    const calls = profileCalls(page);
    try {
      await page.goto(`${server.url}/#/account`);
      await waitReady(page);
      await page.getByRole("button", { name: "小组与成员", exact: true }).click();
      // management=false 只显示本人所属小组；owner 不是成员，切到管理模式才能看到全部小组。
      await page.locator(".cw-groups-workbench").waitFor({ timeout: 10_000 });
      await page.locator(".cw-pagebar input[type='checkbox']").check();
      await page.locator("input[aria-label='小组名称']").waitFor({ timeout: 10_000 });

      // 手动刷新先挂起一轮 profile；随后的写操作成功，写后 reload 必须另起一轮。
      const hold = cloud.holdNext("/api/v1/me");
      const before = calls.length;
      await page.locator(".cw-header-actions button[aria-label='刷新管理数据']").click();
      await hold.arrived;
      await waitFor(() => calls.length === before + 1, 4_000, "写前 profile 在途");

      const renamed = `T11-写后刷新-${Date.now().toString().slice(-6)}`;
      await page.locator("input[aria-label='小组名称']").fill(renamed);
      await page.getByRole("button", { name: "保存名称", exact: true }).click();
      await waitFor(() => calls.length >= before + 2, 10_000, "写后新 profile");
      const whileHeld = calls.length;
      hold.release();
      await page.waitForTimeout(500);
      assert.equal(calls.length, whileHeld, "写后读取不得被旧 profile 迟到响应覆盖");
      assert.equal(await page.locator(".cw-success", { hasText: "小组名称已更新" }).count(), 1, "写操作应成功");
      assert.ok((await page.locator(".cw-detail-title h2").innerText()).includes(renamed), "写后详情应为新值");
      record("profileWriteReload", { initial: before, whileHeld, afterRelease: calls.length });
      note("写后刷新竞态", `写前 profile 在途（累计 ${before + 1}）→ 保存名称 → 写后强制新 profile（累计 ${before + 2}）；放行旧响应后仍为 ${calls.length}`);
    } finally {
      await context.close();
    }
  }

  result.ok = result.checks.length >= 4 && result.errors.length === 0;
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(HERE, "ui-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.metrics, null, 2));
  console.log(`T-LOCAL-011 verify ok: ${result.checks.length} checks`);
} catch (error) {
  result.errors.push({ message: String(error?.message || error) });
  result.ok = false;
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(HERE, "ui-results.json"), JSON.stringify(result, null, 2));
  throw error;
} finally {
  benchAuth?.dispose();
  benchLib?.db.close();
  await browser.close().catch(() => undefined);
  await cloud.close();
  await stopServer(server);
  await fs.rm(dataDir, { recursive: true, force: true });
}
