/**
 * T-LOCAL-008 round2 隔离 UI 验收：账户/小组/授权管理工作区。
 *
 * 真实本地服务 + 一次性 HTTPS/mTLS 管理 mock + 临时 MEDIA_DATA_DIR/合成 WAV。
 * 覆盖 owner/管理员/组长入口、实际点击与网络参数、13寸/窄屏、403/409/429/401、
 * 一次性码显示与清除、退出后迟到结果失效；round2 另加“仅 account:create”
 * 自定义角色的创建入口与不读全局列表检查。不连正式云端、不使用真实账户/素材。
 *
 * 运行：node collab/results/T-LOCAL-008-round2/verify-ui.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium, webkit, expect } from "@playwright/test";
import { startManagementCloud } from "../../../tests/cloud-management-mock.mjs";
import { Library } from "../../../server/library.mjs";

const exec = promisify(execFile);
const PASSWORD = "correct horse battery staple";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "screenshots");
const result = { startedAt: new Date().toISOString(), browsers: [], errors: [] };

await fs.mkdir(OUT, { recursive: true });
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-management-ui-")));
const seedData = path.join(base, "seed-data");
const mediaRoot = path.join(base, "素材库");
const fixture = path.join(base, "fixture.wav");
await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", fixture]);
await fs.mkdir(mediaRoot, { recursive: true });
for (let i = 1; i <= 20; i += 1) {
  await fs.copyFile(fixture, path.join(mediaRoot, `tone-${String(i).padStart(2, "0")}.wav`));
}
{
  const lib = await new Library(seedData, { directoryClassification: true }).init();
  lib.enqueue = () => {};
  const root = await lib.addRoot(mediaRoot, "music");
  const job = lib.scan(root.id);
  while (job.status === "running") await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(job.status, "done");
  lib.db.exec("UPDATE assets SET probe='ready', capture_status='ready', duration=0.5");
  lib.db.close();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const screenshot = (name, label) => path.join(OUT, `${name}-${label}.png`);

async function startServer(name) {
  const dataDir = path.join(base, `${name}-data`);
  await fs.cp(seedData, dataDir, { recursive: true });
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
    const match = logs.match(/拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) return { child, url: match[1], dataDir, logs: () => logs };
    if (child.exitCode !== null) throw new Error(`服务提前退出：\n${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
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

async function cloudLogin(server, cloud, cert, username) {
  const sessionResponse = await fetch(`${server.url}/api/session`);
  const setCookie = sessionResponse.headers.getSetCookie?.()[0] || sessionResponse.headers.get("set-cookie");
  const cookie = String(setCookie || "").split(";")[0];
  const session = await sessionResponse.json();
  assert.ok(cookie && session.token, "本地会话创建失败");
  const headers = { "content-type": "application/json", cookie, "x-local-token": session.token };
  const config = await fetch(`${server.url}/api/cloud-auth/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      origin: cloud.origin,
      caPath: cloud.caCert,
      certPath: cert.cert,
      keyPath: cert.key,
    }),
  });
  assert.equal(config.status, 200, await config.text());
  const login = await fetch(`${server.url}/api/cloud-auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200, JSON.stringify(loginBody));
  assert.equal(loginBody.state, "logged-in");
}

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, `${label}: 页面横向溢出 ${overflow}px`);
}

async function openWorkspace(page) {
  await page.locator(".account-entry > .account-button").click();
  await expect(page.getByRole("menu", { name: "账户菜单" })).toBeVisible();
  await page.getByRole("menuitem", { name: "账户与小组", exact: true }).click();
  await expect(page).toHaveURL(/#\/account$/);
  await expect(page.locator(".cw-title strong", { hasText: "账户与小组" })).toBeVisible();
  await expect(page.locator(".cw-tabs")).toBeVisible();
}

async function runFlow(browserType, options) {
  const { name, username, certKey, expectTabs, fault = null, mutations = false, createOnly = false } = options;
  const cloud = await startManagementCloud();
  const cert = cloud[certKey];
  const server = await startServer(name);
  const browser = await browserType.launch(
    browserType === chromium
      ? { headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
      : { headless: true },
  );
  const pageErrors = [];
  const requests = [];
  let context;
  try {
    await cloudLogin(server, cloud, cert, username);
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem("shiguang.pageSize", "20");
      localStorage.setItem("shiguang.refreshSeconds", "0");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
    page.on("request", (request) => {
      if (request.url().includes("/api/cloud-management/")) {
        requests.push({ url: request.url(), method: request.method(), body: request.postData() || "" });
      }
    });
    await page.goto(server.url);
    await expect(page.locator(".asset-row")).toHaveCount(20);
    const displayName = { owner: "唯一负责人", admin: "管理员", creator: "创建员小周" }[username] || "组长小李";
    await expect(page.locator(".account-entry > .account-button")).toContainText(displayName);

    await openWorkspace(page);
    const tabNames = await page.locator(".cw-tabs button").allTextContents();
    for (const expected of expectTabs) assert.ok(tabNames.includes(expected), `${name}: 缺少页签 ${expected}`);
    for (const forbidden of ["角色与授权", "审计", "账户管理"].filter((item) => !expectTabs.includes(item))) {
      assert.equal(tabNames.includes(forbidden), false, `${name}: 不应出现页签 ${forbidden}`);
    }
    await expect(page.getByRole("region", { name: "个人安全" })).toBeVisible();
    await noOverflow(page, `${name}-security-1280`);
    await page.screenshot({ path: screenshot(name, "security-1280"), animations: "disabled" });

    if (createOnly) {
      // 仅 account:create：必须有创建入口，且绝不请求全局账户列表。
      const accountGets = () =>
        requests.filter((item) => {
          const url = new URL(item.url);
          return item.method === "GET" && url.pathname === "/api/cloud-management/accounts";
        }).length;
      const beforeGets = accountGets();
      await page.getByRole("button", { name: "账户管理", exact: true }).click();
      await expect(page.getByLabel("搜索账户")).toHaveCount(0);
      await expect(page.locator(".cw-panel[aria-label='账户管理'] .cw-list")).toHaveCount(0);
      await expect(page.locator(".cw-panel[aria-label='账户管理']")).toContainText("仅创建账户");
      assert.equal(accountGets(), beforeGets, "仅创建角色进入账户页不得请求全局列表");

      await page.getByRole("button", { name: "创建待激活账户" }).click();
      await page.getByLabel("新账户用户名").fill("only.creator.ui");
      await page.getByLabel("新账户显示名").fill("仅创建界面");
      await page.getByRole("button", { name: "创建并签发开通码" }).click();
      await expect(page.locator(".cw-secret")).toBeVisible();
      const code = (await page.locator(".cw-secret code").textContent())?.trim() || "";
      assert.match(code, /^[A-Za-z0-9_-]{43}$/);
      const posted = requests.filter((item) => {
        const url = new URL(item.url);
        return item.method === "POST" && url.pathname === "/api/cloud-management/accounts";
      });
      assert.equal(posted.length, 1, "只创建一次，本地不应并发重试");
      assert.equal(accountGets(), beforeGets, "创建成功后也不得擅自读取全局列表");
      await page.getByRole("button", { name: "关闭一次性码" }).click();
      await expect(page.locator(".cw-secret")).toHaveCount(0);
      await noOverflow(page, `${name}-create-only-1280`);
      await page.screenshot({ path: screenshot(name, "create-only-1280"), animations: "disabled" });

      // 前端隐藏不是安全边界：同一角色直接调用本地列表 API 仍由云端 403。
      const denied = await page.evaluate(async () => {
        const response = await fetch("/api/cloud-management/accounts?limit=5&offset=0");
        return { status: response.status, body: await response.json() };
      });
      assert.equal(denied.status, 403, `${name}: 仅创建角色直接读列表应 403`);
      assert.equal(denied.body.code, "FORBIDDEN");
    }

    if (mutations) {
      // 个人设备：撤销备用机（保留当前设备会话）。
      const backup = page.locator(".cw-row", { hasText: "owner 的备用机" });
      await expect(backup).toBeVisible();
      await backup.getByRole("button", { name: "撤销" }).click();
      await backup.getByRole("button", { name: "确认撤销" }).click();
      await expect(page.locator(".cw-success")).toContainText("设备已撤销");
      await expect(page.locator(".cw-row", { hasText: "owner 的备用机" })).toContainText("已撤销");
      await expect(page.locator(".cw-row", { hasText: "owner 的备用机" }).getByRole("button", { name: "撤销" })).toHaveCount(0);

      // 小组：管理模式 → 选择音频组 → 改名。
      await page.getByRole("button", { name: "小组与成员", exact: true }).click();
      await page.getByLabel("管理模式（含停用/待接管小组）").check();
      await expect(page.locator(".cw-select-list button", { hasText: "音频组" })).toBeVisible();
      await page.locator(".cw-select-list button", { hasText: "音频组" }).click();
      await expect(page.getByLabel("小组名称")).toHaveValue("音频组");
      await page.getByLabel("小组名称").fill("音频组-验收");
      await page.getByRole("button", { name: "保存名称" }).click();
      await expect(page.locator(".cw-success")).toContainText("小组名称已更新");
      await expect(page.locator(".cw-detail h2")).toContainText("音频组-验收");
      await page.screenshot({ path: screenshot(name, "groups-1280"), animations: "disabled" });

      // 409：外部推进版本后保存旧版本，界面提示重读且不覆盖。
      const groupA = cloud.ids.groups.a;
      cloud.state.groups.get(groupA).version += 1;
      await page.getByLabel("小组名称").fill("不应覆盖");
      await page.getByRole("button", { name: "保存名称" }).click();
      await expect(page.locator(".cw-error")).toContainText("数据已被其他人更新");
      await page.getByRole("button", { name: "刷新", exact: true }).last().click();
      await expect(page.getByLabel("小组名称")).toHaveValue("音频组-验收");

      // 添加既有有效账户；候选是精确用户名。
      await page.getByLabel("添加成员用户名").fill("newbie");
      await page.getByRole("button", { name: "查找", exact: true }).first().click();
      await expect(page.getByRole("button", { name: /加入 新组员小周/ })).toBeVisible();
      await page.getByRole("button", { name: /加入 新组员小周/ }).click();
      await expect(page.locator(".cw-success")).toContainText("成员已加入");
      await expect(page.locator(".cw-detail")).toContainText("新组员小周");

      // 负责人交接给 member；原负责人仍保留为成员。
      await page.getByLabel("交接负责人用户名").fill("member");
      const transferBox = page.locator(".cw-inline-form", { has: page.getByLabel("交接负责人用户名") });
      await transferBox.getByRole("button", { name: "查找", exact: true }).click();
      await transferBox.getByRole("button", { name: "确认交接" }).click();
      await expect(page.locator(".cw-success")).toContainText("负责人已交接");
      await expect(page.locator(".cw-detail")).toContainText("member");

      // 账户：搜索 → 签发开通码 → 只显示一次；签发重置码；创建待激活账户。
      await page.getByRole("button", { name: "账户管理", exact: true }).click();
      await page.getByLabel("搜索账户").fill("member");
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      const memberRow = page.locator(".cw-row", { hasText: "@member" });
      await expect(memberRow).toBeVisible();
      await memberRow.getByRole("button", { name: "发开通码" }).click();
      await expect(page.locator(".cw-secret")).toBeVisible();
      const openingCode = (await page.locator(".cw-secret code").textContent())?.trim() || "";
      assert.match(openingCode, /^[A-Za-z0-9_-]{43}$/);
      const bodyText = await page.locator("body").innerText();
      assert.equal(bodyText.includes("localStorage"), false);
      await page.getByRole("button", { name: "关闭一次性码" }).click();
      await expect(page.locator(".cw-secret")).toHaveCount(0);
      assert.equal((await page.locator("body").innerText()).includes(openingCode), false, "关闭后一次性码必须离开 DOM");

      await memberRow.getByRole("button", { name: "重置码" }).click();
      await expect(page.getByLabel("操作者当前密码")).toBeVisible();
      await page.getByLabel("操作者当前密码").fill(PASSWORD);
      await page.getByRole("button", { name: "确认签发" }).click();
      await expect(page.locator(".cw-secret")).toBeVisible();
      const resetCode = (await page.locator(".cw-secret code").textContent())?.trim() || "";
      assert.match(resetCode, /^[A-Za-z0-9_-]{43}$/);
      await page.getByRole("button", { name: "关闭一次性码" }).click();
      await expect(page.locator(".cw-secret")).toHaveCount(0);
      await page.screenshot({ path: screenshot(name, "accounts-1280"), animations: "disabled" });

      await page.getByRole("button", { name: "创建待激活账户" }).click();
      await page.getByLabel("新账户用户名").fill("ui.pending");
      await page.getByLabel("新账户显示名").fill("界面待激活");
      await page.getByRole("button", { name: "创建并签发开通码" }).click();
      await expect(page.locator(".cw-secret")).toBeVisible();
      assert.match((await page.locator(".cw-secret code").textContent())?.trim() || "", /^[A-Za-z0-9_-]{43}$/);
      await page.getByRole("button", { name: "关闭一次性码" }).click();
      await expect(page.locator(".cw-row", { hasText: "ui.pending" })).toHaveCount(0); // 先按 member 过滤

      // 角色：影响预览、更新权限、创建自定义角色。
      await page.getByRole("button", { name: "角色与授权", exact: true }).click();
      await page.locator(".cw-select-list button", { hasText: "音频审核员" }).click();
      await expect(page.locator(".cw-detail")).toContainText("影响 1 条授权");
      await page.getByLabel("group:member:manage", { exact: true }).check();
      await page.getByRole("button", { name: "保存权限" }).click();
      await expect(page.locator(".cw-success")).toContainText("角色权限已更新");
      await expect(page.locator(".cw-detail")).toContainText("版本 v1");
      await page.screenshot({ path: screenshot(name, "roles-1280"), animations: "disabled" });

      await page.getByRole("button", { name: "创建自定义角色" }).click();
      await page.getByLabel("角色编码").fill("UI_REVIEWER");
      await page.getByLabel("角色名称").fill("界面审核员");
      await page.getByLabel("角色范围").selectOption("GROUP");
      await page.getByRole("form", { name: "创建自定义角色" }).getByLabel("media:review", { exact: true }).check();
      await page.getByRole("button", { name: "创建", exact: true }).click();
      await expect(page.locator(".cw-success")).toContainText("自定义角色已创建");
      await expect(page.locator(".cw-select-list")).toContainText("UI_REVIEWER");

      // 审计：实际写入后有脱敏摘要。
      await page.getByRole("button", { name: "审计", exact: true }).click();
      await expect(page.locator(".cw-list .cw-row").first()).toBeVisible();
      const auditText = await page.locator(".cw-panel").innerText();
      assert.equal(auditText.includes("accessToken"), false);
      await noOverflow(page, `${name}-audit-1280`);
      await page.screenshot({ path: screenshot(name, "audit-1280"), animations: "disabled" });
    }

    // 窄屏：每个可见页签逐个检查不溢出。
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const tab of expectTabs) {
        await page.getByRole("button", { name: tab, exact: true }).click();
        await noOverflow(page, `${name}-${tab}-${width}`);
      }
      await page.getByRole("button", { name: "个人安全", exact: true }).click();
      await page.screenshot({ path: screenshot(name, `security-${width}`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // 直接调用本地管理 API：无权限时由云端拒绝，前端页签隐藏不是安全边界。
    if (!expectTabs.includes("账户管理")) {
      const response = await page.evaluate(async () => {
        const r = await fetch("/api/cloud-management/accounts?limit=5&offset=0");
        return { status: r.status, body: await r.json() };
      });
      assert.equal(response.status, 403, `${name}: 直接调用账户接口应 403`);
      assert.equal(response.body.code, "FORBIDDEN");
    }
    if (!expectTabs.includes("角色与授权")) {
      const response = await page.evaluate(async () => {
        const r = await fetch("/api/cloud-management/permissions");
        return { status: r.status, body: await r.json() };
      });
      assert.equal(response.status, 403, `${name}: 直接调用角色目录应 403`);
    }

    // 429：固定文案，且不自动并发重试。
    if (fault === "429") {
      await page.getByRole("button", { name: "账户管理", exact: true }).click();
      await expect(page.locator(".cw-panel[aria-label='账户管理'] .cw-list .cw-row").first()).toBeVisible();
      await page.waitForTimeout(400);
      cloud.failNext(429, "RATE_LIMITED");
      await page.locator(".cw-panel").getByRole("button", { name: "刷新" }).click();
      await expect(page.locator(".cw-error")).toContainText("请求过于频繁");
      const after = requests.length;
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal(requests.length, after, "429 后不得自动重试");
    }

    // 401：撤销云端会话后，迟到列表不能继续显示，工作区退回登录提示。
    if (fault === "401") {
      await page.getByRole("button", { name: "账户管理", exact: true }).click();
      await expect(page.locator(".cw-panel[aria-label='账户管理'] .cw-list .cw-row").first()).toBeVisible();
      await page.waitForTimeout(400);
      cloud.revokeAllSessions();
      await page.locator(".cw-panel").getByRole("button", { name: "刷新" }).click();
      await expect(page.locator(".cw-signed-out")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("heading", { name: "需要登录云端账户" })).toBeVisible();
      await expect(page.locator(".cw-tabs")).toHaveCount(0);

      // 登录页的独立"忘记密码"入口：只需设备证书 + 重置码，不要求旧会话。
      await page.getByRole("button", { name: "去登录" }).click();
      await expect(page.getByRole("heading", { name: "登录云端账户" })).toBeVisible();
      await page.getByRole("button", { name: /忘记密码/ }).click();
      await expect(page.getByRole("heading", { name: "重置密码" })).toBeVisible();
      await page.getByLabel("重置码").fill("B".repeat(43));
      await page.getByLabel("新密码", { exact: true }).fill("a brand new password");
      await page.getByLabel("确认新密码").fill("a brand new password");
      await page.getByRole("button", { name: "重置密码", exact: true }).click();
      await expect(page.locator(".login-error")).toContainText("登录状态无效");
      await expect(page.getByLabel("重置码")).toHaveValue("");
      await expect(page.getByLabel("新密码", { exact: true })).toHaveValue("");
      await page.screenshot({ path: screenshot(name, "reset-login-1280"), animations: "disabled" });
    }

    // 浏览器请求只带业务参数；绝不含证书/私钥/路径/令牌。
    const bodies = requests.map((item) => item.body).join("\n");
    for (const forbidden of ["PRIVATE KEY", "caPath", "keyPath", "/Users/", "accessToken", "refreshToken"]) {
      assert.equal(bodies.includes(forbidden), false, `${name}: 浏览器管理请求泄露 ${forbidden}`);
    }
    assert.ok(requests.every((item) => item.url.startsWith(server.url)), "所有管理请求必须发往本地 Node");

    result.browsers.push({
      name,
      passed: true,
      tabs: expectTabs,
      managementRequests: requests.length,
      pageErrors,
      screenshots: (await fs.readdir(OUT)).filter((file) => file.startsWith(`${name}-`)).length,
    });
    if (pageErrors.length) throw new Error(`${name}: 页面异常 ${pageErrors.join("; ")}`);
  } finally {
    await context?.close().catch(() => undefined);
    await stopServer(server);
    await browser.close();
    await cloud.close();
  }
}

const ownerTabs = ["个人安全", "小组与成员", "账户管理", "角色与授权", "审计"];
const adminTabs = ["个人安全", "小组与成员", "账户管理"];
const leaderTabs = ["个人安全", "小组与成员"];

try {
  await runFlow(chromium, {
    name: "chromium-owner",
    username: "owner",
    certKey: "clientOwner",
    expectTabs: ownerTabs,
    mutations: true,
    fault: "429",
  });
  await runFlow(webkit, {
    name: "webkit-owner",
    username: "owner",
    certKey: "clientOwner",
    expectTabs: ownerTabs,
    fault: "401",
  });
  await runFlow(chromium, {
    name: "chromium-admin",
    username: "admin",
    certKey: "clientAdmin",
    expectTabs: adminTabs,
  });
  await runFlow(chromium, {
    name: "chromium-leader",
    username: "leader",
    certKey: "clientReader",
    expectTabs: leaderTabs,
  });
  await runFlow(chromium, {
    name: "chromium-create-only",
    username: "creator",
    certKey: "clientCreator",
    expectTabs: ["个人安全", "小组与成员", "账户管理"],
    createOnly: true,
  });
} catch (error) {
  result.errors.push(String(error?.stack || error));
  throw error;
} finally {
  await fs.writeFile(
    path.join(HERE, "ui-results.json"),
    JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify({ browsers: result.browsers, errors: result.errors }, null, 2));
