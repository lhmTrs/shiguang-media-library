/**
 * T-LOCAL-006 隔离验收脚本。
 *
 * - 一次性 HTTPS/mTLS mock + 临时 MEDIA_DATA_DIR + 合成 WAV（25 个）。
 * - 无头 Chromium / WebKit；覆盖顶部账户入口、独立登录页、直达/刷新/后退、
 *   未登录继续本地使用、成功返回并保留搜索与页码、401/429/证书/网络/未知错误、
 *   防连点、退出（云端已撤销 / 本地已退出远端未确认）、迟到状态不覆盖、激活次级入口。
 * - 1280/390/320 截图与可点击/不溢出检查。
 *
 * 运行：node collab/results/T-LOCAL-006/verify.mjs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { startMockCloud } from "../../../tests/cloud-auth-mock.mjs";
import { Library } from "../../../server/library.mjs";

const PASSWORD = "correct horse battery staple";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "screenshots");
const result = { startedAt: new Date().toISOString(), browsers: [], errors: [] };
const exec = promisify(execFile);

await fs.mkdir(OUT, { recursive: true });
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-login-ui-")));
const seedData = path.join(base, "seed-data");
const mediaRoot = path.join(base, "素材库");
const fixture = path.join(base, "fixture.wav");
await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", fixture]);
await fs.mkdir(mediaRoot, { recursive: true });
for (let i = 1; i <= 25; i += 1) {
  await fs.copyFile(fixture, path.join(mediaRoot, `tone-${String(i).padStart(2, "0")}.wav`));
}
{
  const lib = await new Library(seedData, { directoryClassification: true }).init();
  lib.enqueue = () => {};
  const root = await lib.addRoot(mediaRoot, "music");
  const job = lib.scan(root.id);
  while (job.status === "running") await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(job.status, "done");
  lib.db.exec("UPDATE assets SET probe='ready',capture_status='ready',duration=0.6");
  lib.db.close();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function screenshot(name, label) {
  return path.join(OUT, `${name}-${label}.png`);
}

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
  const deadline = Date.now() + 20_000;
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

async function openSettings(page) {
  await page.getByRole("button", { name: "设置与缓存", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "设置与缓存", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByText("高级云端设置（诊断 / 配置）", { exact: true }).click();
  const region = dialog.getByRole("region", { name: "云端连接", exact: true });
  await expect(region).toBeVisible();
  return { dialog, region };
}

async function configurePem(page, cloud, { useP12 = false } = {}) {
  const { dialog, region } = await openSettings(page);
  if (!useP12) {
    await region.getByLabel("云端地址（HTTPS）", { exact: true }).fill(cloud.origin);
    await region.getByLabel("云端 CA 证书路径", { exact: true }).fill(cloud.caCert);
    await region.getByLabel("设备证书路径（PEM）", { exact: true }).fill(cloud.clientCertA);
    await region.getByLabel("设备私钥路径（PEM）", { exact: true }).fill(cloud.clientKeyA);
  }
  await region.getByRole("button", { name: "保存连接配置", exact: true }).click();
  await expect(region.locator(".cloud-notice")).toContainText("连接配置已保存");
  await dialog.getByRole("button", { name: "关闭窗口", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function setBrowseState(page) {
  const search = page.getByLabel("搜索素材", { exact: true });
  await search.fill("tone");
  // 搜索输入有 220ms 防抖；等 search 状态提交后再翻页，避免页码被重置。
  await page.waitForTimeout(350);
  await expect(page.locator(".asset-row")).toHaveCount(20);
  await page.getByRole("button", { name: "第 2 页", exact: true }).click();
  await expect(page.locator(".asset-row")).toHaveCount(5);
  await expect(page.getByRole("button", { name: "第 2 页", exact: true })).toHaveAttribute("aria-current", "page");
  return search;
}

async function assertBrowseState(page, label) {
  const search = page.getByLabel("搜索素材", { exact: true });
  await expect(search, `${label}: 搜索词丢失`).toHaveValue("tone");
  await expect(page.getByRole("button", { name: "第 2 页", exact: true }), `${label}: 页码丢失`).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".asset-row"), `${label}: 当前页素材数量不对`).toHaveCount(5);
}

async function assertNoOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, `${label}: 页面横向溢出 ${overflow}px`);
}

async function assertClickable(locator, label) {
  const box = await locator.boundingBox();
  assert.ok(box, `${label}: 无可见区域`);
  const viewport = locator.page().viewportSize();
  assert.ok(box.x >= -1 && box.y >= -1, `${label}: 控件越过左上边界`);
  assert.ok(box.x + box.width <= viewport.width + 1, `${label}: 控件越过右边界`);
  assert.ok(box.y + box.height <= viewport.height + 1, `${label}: 控件越过下边界`);
  const hit = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const node = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!node && (el === node || el.contains(node));
  });
  assert.ok(hit, `${label}: 中心点不可点击（被遮挡）`);
}

async function assertTopbar(page, label) {
  await assertNoOverflow(page, `${label}-topbar`);
  const menu = page.getByRole("button", { name: "展开导航", exact: true });
  const account = page.locator(".account-entry > .account-button");
  const add = page.getByRole("button", { name: "添加素材目录", exact: true });
  for (const [locator, name] of [[menu, "导航按钮"], [account, "账户入口"], [add, "添加目录"]]) {
    await assertClickable(locator, `${label}-${name}`);
  }
  const boxes = await page.locator(".topbar button, .topbar select").evaluateAll((els) =>
    els.filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }),
  );
  for (const box of boxes) {
    assert.ok(box.left >= -1, `${label}: 顶栏控件越过左侧 ${box.left}px`);
    assert.ok(box.right <= page.viewportSize().width + 1, `${label}: 顶栏控件越过右侧 ${box.right}px`);
  }
}

async function assertLoginLayout(page, label) {
  await assertNoOverflow(page, label);
  const card = page.locator(".login-card");
  const box = await card.boundingBox();
  assert.ok(box.width <= page.viewportSize().width + 1, `${label}: 登录卡片超宽`);
  const controls = await page.locator(".login-card input, .login-card button").evaluateAll((els) =>
    els.filter((el) => el.getBoundingClientRect().width > 0).map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }),
  );
  for (const item of controls) {
    assert.ok(item.left >= -1, `${label}: 登录控件越过左侧 ${item.left}px`);
    assert.ok(item.right <= page.viewportSize().width + 1, `${label}: 登录控件越过右侧 ${item.right}px`);
  }
}

async function assertMenuLayout(page, label) {
  await assertNoOverflow(page, label);
  const menu = page.getByRole("menu", { name: "账户菜单" });
  const box = await menu.boundingBox();
  assert.ok(box, `${label}: 账户菜单不可见`);
  const viewport = page.viewportSize();
  assert.ok(box.x >= -1 && box.y >= -1, `${label}: 账户菜单越过左上边界`);
  assert.ok(box.x + box.width <= viewport.width + 1, `${label}: 账户菜单越过右边界`);
  assert.ok(box.y + box.height <= viewport.height + 1, `${label}: 账户菜单越过下边界`);
}

async function openLoginPage(page) {
  await page.locator(".account-entry > .account-button").click();
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.getByRole("heading", { name: "登录云端账户", exact: true })).toBeVisible();
}

async function runFlow(browserType, name, options) {
  const browser = await browserType.launch({ headless: true, ...options });
  const server = await startServer(name);
  const cloud = await startMockCloud();
  await cloud.enroll({
    username: "alice",
    password: PASSWORD,
    displayName: "爱丽丝",
    superAdmin: true,
    clientCert: cloud.clientCertA,
  });
  const pageErrors = [];
  const cloudRequests = [];
  const authBodies = [];
  let context;
  let cloudClosed = false;
  try {
    const pending = await cloud.enrollPending({
      username: `carol-${name}`,
      displayName: "卡罗尔",
      clientCert: cloud.clientCertB,
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem("shiguang.refreshSeconds", "0");
      localStorage.setItem("shiguang.pageSize", "20");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
    page.on("request", (request) => {
      if (request.url().includes("/api/cloud-auth/")) cloudRequests.push({ method: request.method(), url: request.url() });
    });
    page.on("response", (response) => {
      if (!response.url().includes("/api/cloud-auth/")) return;
      // 注入的合成错误响应含故意路径；只收集真实后端响应做脱敏断言。
      if (response.headers()["x-synthetic"] === "1") return;
      void response.text().then((text) => authBodies.push(text)).catch(() => undefined);
    });

    await page.goto(server.url);
    await expect(page.locator(".asset-row")).toHaveCount(20);
    const search = await setBrowseState(page);

    // 未配置：顶部入口可打开独立登录页，但显示安全的“尚未就绪”，不暴露证书输入。
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName("登录");
    await openLoginPage(page);
    await expect(page.getByText("云端服务尚未就绪", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeDisabled();
    for (const forbidden of ["云端 CA 证书路径", "设备证书路径（PEM）", "设备私钥路径（PEM）", "设备证书路径（P12）", "P12 口令"]) {
      assert.equal(await page.getByLabel(forbidden, { exact: true }).count(), 0, `普通登录页出现高级字段：${forbidden}`);
    }
    await page.getByRole("button", { name: "返回素材库", exact: true }).click();
    await expect(page).not.toHaveURL(/#\/login/);
    await assertBrowseState(page, `${name}-unconfigured-return`);

    // 高级设置折叠配置；配置后登录页启用。
    await configurePem(page, cloud);
    await openLoginPage(page);
    const loginButton = page.getByRole("button", { name: "登录", exact: true });
    await expect(loginButton).toBeEnabled();

    // 浏览器后退：回到原主视图并保留筛选/页码。
    await page.goBack();
    await expect(page).not.toHaveURL(/#\/login/);
    await assertBrowseState(page, `${name}-browser-back`);

    // 刷新登录页仍停在登录页；返回按钮可回主界面。
    await openLoginPage(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "登录云端账户", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回素材库", exact: true }).click();
    await expect(page).not.toHaveURL(/#\/login/);

    // 直达登录页（全新 history entry，state 为空）也能返回。
    await page.goto(`${server.url}#/login`);
    await expect(page.getByRole("heading", { name: "登录云端账户", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "返回素材库", exact: true }).click();
    await expect(page).not.toHaveURL(/#\/login/);
    await expect(page.locator(".asset-row")).toHaveCount(20);

    // 重新建立筛选/页码，后续成功登录必须保留它。
    await setBrowseState(page);
    await openLoginPage(page);

    // 401：真实 mock 错误密码，停留登录页、密码清空、用户名保留。
    await page.getByLabel("用户名", { exact: true }).fill("alice");
    await page.getByLabel("密码", { exact: true }).fill("wrong password");
    await loginButton.click();
    await expect(page.locator(".login-error")).toContainText("登录状态无效");
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("用户名", { exact: true })).toHaveValue("alice");

    // 429 / 证书 / 网络 / 未知非 JSON：固定安全文案，不泄露路径或原始异常。
    const loginPattern = "**/api/cloud-auth/login";
    await page.route(loginPattern, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Retry-After": "2", "x-synthetic": "1" },
        body: JSON.stringify({ error: "raw rate limit", code: "RATE_LIMITED", kind: "cloud", retryAfterMs: 2000 }),
      }),
    );
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await loginButton.click();
    await expect(page.locator(".login-error")).toContainText("请求过于频繁，请 2 秒后重试");
    await page.unroute(loginPattern);

    await page.route(loginPattern, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "x-synthetic": "1" },
        body: JSON.stringify({ error: `ENOENT ${base}/client.crt`, code: "CERT_FILE_UNREADABLE", kind: "cert" }),
      }),
    );
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await loginButton.click();
    await expect(page.locator(".login-error")).toContainText("无法读取证书文件");
    await expect(page.locator(".login-error")).not.toContainText(base);
    await page.unroute(loginPattern);

    await page.route(loginPattern, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "x-synthetic": "1" },
        body: JSON.stringify({ error: "connect ECONNREFUSED 127.0.0.1", code: "ECONNREFUSED", kind: "network" }),
      }),
    );
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await loginButton.click();
    await expect(page.locator(".login-error")).toContainText("无法连接云端服务");
    await expect(page.locator(".login-error")).not.toContainText("127.0.0.1");
    await page.unroute(loginPattern);

    await page.route(loginPattern, (route) =>
      route.fulfill({
        status: 500,
        contentType: "text/html",
        headers: { "x-synthetic": "1" },
        body: `<html><body>ENOENT ${base}/secret.key</body></html>`,
      }),
    );
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await loginButton.click();
    await expect(page.locator(".login-error")).toContainText("云端认证操作失败，请稍后重试");
    await expect(page.locator(".login-error")).not.toContainText(base);
    await expect(page.locator(".login-error")).not.toContainText("ENOENT");
    await page.unroute(loginPattern);

    // 防连点：延迟真实登录响应；期间只发出一次请求，按钮/输入禁用。
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let delayed = 0;
    await page.route(loginPattern, async (route) => {
      delayed += 1;
      await gate;
      await route.continue();
    });
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await loginButton.click();
    await expect(page.getByRole("button", { name: "登录中…", exact: true })).toBeDisabled();
    await expect(page.getByLabel("用户名", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("密码", { exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 700 });
    await assertLoginLayout(page, `${name}-login-loading-390`);
    await page.screenshot({ path: screenshot(name, "login-loading-390"), animations: "disabled" });
    release();
    await expect(page).not.toHaveURL(/#\/login/);
    assert.equal(delayed, 1, "登录请求被重复提交");
    await page.unroute(loginPattern);

    // 成功后回到主界面，顶部入口显示账户，筛选与页码保留。
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName(/账户：爱丽丝/);
    await assertBrowseState(page, `${name}-login-success`);
    assert.equal((await page.evaluate(() => location.hash)).includes("password"), false, "URL 出现密码");
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    for (const secret of [PASSWORD, "refreshToken", "accessToken"]) {
      assert.equal(storage.includes(secret), false, `浏览器存储出现敏感值 ${secret}`);
    }

    // 刷新后只从后端恢复脱敏账户状态。
    await page.reload();
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName(/账户：爱丽丝/);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: screenshot(name, "main-logged-in-1280"), animations: "disabled" });

    // 已有有效会话时直达登录页 -> 直接回主界面，避免循环。
    await page.goto(`${server.url}#/login`);
    await expect(page.getByRole("heading", { name: "登录云端账户", exact: true })).toHaveCount(0);
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName(/账户：爱丽丝/);
    await expect(page).not.toHaveURL(/#\/login/);

    // 正常退出：云端撤销确认。
    await page.locator(".account-entry > .account-button").click();
    await expect(page.getByRole("menu", { name: "账户菜单" })).toBeVisible();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("已退出，云端会话已撤销");
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName("登录");

    // 登录页窄屏与未配置/错误态截图（已配置但未登录）。
    await openLoginPage(page);
    for (const [width, height] of [[1280, 900], [390, 700], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await assertLoginLayout(page, `${name}-login-${width}`);
      await page.screenshot({ path: screenshot(name, `login-${width}`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // 重新登录；随后测试“菜单打开时迟到的旧状态不能覆盖退出结果”。
    await page.getByLabel("用户名", { exact: true }).fill("alice");
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName(/账户：爱丽丝/);
    const staleState = await page.evaluate(async () => (await fetch("/api/cloud-auth/status")).json());
    let releaseStatus;
    const statusGate = new Promise((resolve) => (releaseStatus = resolve));
    let heldStatus = false;
    await page.route("**/api/cloud-auth/status", async (route) => {
      if (heldStatus) {
        await route.continue();
        return;
      }
      heldStatus = true;
      await statusGate;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(staleState) });
    });
    await page.locator(".account-entry > .account-button").click();
    await expect(page.getByRole("menu", { name: "账户菜单" })).toBeVisible();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("已退出，云端会话已撤销");
    releaseStatus();
    await page.waitForTimeout(400);
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName("登录");
    await expect(page.getByRole("menu", { name: "账户菜单" })).toHaveCount(0);
    await page.unroute("**/api/cloud-auth/status");

    // 激活次级入口：切换到客户端 B，独立表单，不与普通登录混排。
    const { dialog, region } = await openSettings(page);
    await region.getByLabel("设备证书路径（PEM）", { exact: true }).fill(cloud.clientCertB);
    await region.getByLabel("设备私钥路径（PEM）", { exact: true }).fill(cloud.clientKeyB);
    await region.getByRole("button", { name: "保存连接配置", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("连接配置已保存");
    await dialog.getByRole("button", { name: "关闭窗口", exact: true }).click();
    await openLoginPage(page);
    await page.getByRole("button", { name: "首次在本机使用？激活设备", exact: true }).click();
    await expect(page.getByRole("heading", { name: "激活本机设备", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "登录云端账户", exact: true })).toHaveCount(0);
    await page.getByLabel("激活凭证", { exact: true }).fill("invalid-activation");
    await page.getByLabel("激活设置密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "激活并登录", exact: true }).click();
    await expect(page.locator(".login-error")).toContainText("登录状态无效");
    await expect(page.getByLabel("激活凭证", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("激活设置密码", { exact: true })).toHaveValue("");
    await page.getByLabel("激活凭证", { exact: true }).fill(pending.activationToken);
    await page.getByLabel("激活设置密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "激活并登录", exact: true }).click();
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName(/账户：卡罗尔/);
    assert.equal((await page.evaluate(() => location.hash)).includes("activation"), false, "URL 出现激活码");

    // 顶部入口 390/320 可点击与不溢出 + 截图。
    for (const [width, height] of [[390, 700], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await assertTopbar(page, `${name}-topbar-${width}`);
      await page.locator(".account-entry > .account-button").click();
      await expect(page.getByRole("menu", { name: "账户菜单" })).toBeVisible();
      await assertMenuLayout(page, `${name}-menu-${width}`);
      await page.screenshot({ path: screenshot(name, `account-menu-${width}`), animations: "disabled" });
      await page.keyboard.press("Escape");
    }

    // 退出并清理。
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".account-entry > .account-button").click();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName("登录");

    // 退出时云端不可达：本地已退出、云端撤销未确认（停掉一次性 mock，不接真实网络）。
    await openLoginPage(page);
    await page.getByLabel("用户名", { exact: true }).fill(`carol-${name}`);
    await page.getByLabel("密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName(/账户：卡罗尔/);
    await cloud.close();
    cloudClosed = true;
    await page.locator(".account-entry > .account-button").click();
    await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("本地已退出；云端撤销未确认");
    await expect(page.locator(".toast")).toContainText("无法连接云端服务");
    await expect(page.locator(".account-entry > .account-button")).toHaveAccessibleName("登录");

    // 网络/DOM 脱敏断言。
    const bodies = authBodies.join("\n");
    for (const forbidden of ["accessToken", "refreshToken", PASSWORD, base, cloud.caCert, cloud.clientKeyA, cloud.clientKeyB]) {
      assert.equal(bodies.includes(forbidden), false, `云端认证响应泄露了 ${forbidden.slice(0, 40)}`);
    }
    for (const request of cloudRequests) {
      assert.equal(request.url.includes("password"), false, "密码出现在 URL 查询串");
      assert.equal(request.url.includes("activation"), false, "激活码出现在 URL 查询串");
    }
    const domText = await page.evaluate(() => document.body.innerText);
    for (const forbidden of ["accessToken", "refreshToken", PASSWORD, base, cloud.clientKeyA]) {
      assert.equal(domText.includes(forbidden), false, `页面 DOM 泄露了 ${forbidden.slice(0, 40)}`);
    }

    assert.deepEqual(pageErrors, [], `${name} 页面脚本错误：${pageErrors.join("; ")}`);
    result.browsers.push({
      name,
      ok: true,
      cloudRequests: cloudRequests.length,
      screenshots: (await fs.readdir(OUT)).filter((file) => file.startsWith(`${name}-`)).length,
    });
    console.log(`PASS ${name}`);
  } catch (error) {
    result.errors.push({ name, error: String(error?.stack || error) });
    console.error(`FAIL ${name}: ${error?.stack || error}`);
    throw error;
  } finally {
    try {
      await context?.close();
    } catch {}
    await browser.close();
    if (!cloudClosed) await cloud.close().catch(() => undefined);
    await stopServer(server);
    await fs.rm(server.dataDir, { recursive: true, force: true });
  }
}

try {
  await runFlow(chromium, "chrome", { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  await runFlow(webkit, "webkit", {});
} finally {
  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(HERE, "results.json"), JSON.stringify(result, null, 2) + "\n");
  if (result.errors.length) {
    console.error(JSON.stringify(result.errors, null, 2));
    process.exitCode = 1;
  }
}
