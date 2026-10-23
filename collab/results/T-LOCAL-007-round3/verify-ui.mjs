/**
 * T-LOCAL-007 隔离 UI 验收：未配置 → 独立登录页 → 开通本机 → 自动登录 → 回主界面。
 *
 * 真实本地服务 + 一次性 HTTPS/mTLS mock + 临时 MEDIA_DATA_DIR/合成 WAV；
 * 不连正式云端、不建正式账户、不碰真实素材/库/系统信任。
 *
 * 运行：node collab/results/T-LOCAL-007/verify-ui.mjs
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
import { startEnrollmentMock } from "../../../tests/device-enrollment-mock.mjs";
import { Library } from "../../../server/library.mjs";

const exec = promisify(execFile);
const PASSWORD = "correct horse battery staple";
const CODE = "A".repeat(43);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "screenshots");
const result = { startedAt: new Date().toISOString(), browsers: [], errors: [] };

await fs.mkdir(OUT, { recursive: true });
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-enroll-ui-")));
const seedData = path.join(base, "seed-data");
const mediaRoot = path.join(base, "素材库");
const fixture = path.join(base, "fixture.wav");
await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", fixture]);
await fs.mkdir(mediaRoot, { recursive: true });
for (let i = 1; i <= 25; i += 1) await fs.copyFile(fixture, path.join(mediaRoot, `tone-${String(i).padStart(2, "0")}.wav`));
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

const screenshot = (name, label) => path.join(OUT, `${name}-${label}.png`);

async function startServer(name, releaseFile) {
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
      SHIGUANG_CLOUD_RELEASE_CONFIG: releaseFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (logs += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (logs += chunk));
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = logs.match(/拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) return { child, url: match[1], logs: () => logs };
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

async function noOverflow(page, label) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 1, `${label}: 页面横向溢出 ${overflow}px`);
}

async function runFlow(browserType, name, releaseFile, mock) {
  const browser = await browserType.launch(
    browserType === chromium
      ? { headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
      : { headless: true },
  );
  const server = await startServer(name, releaseFile);
  const pageErrors = [];
  const enrollmentBodies = [];
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem("shiguang.pageSize", "20");
      localStorage.setItem("shiguang.refreshSeconds", "0");
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));
    page.on("request", (request) => {
      if (request.url().endsWith("/api/cloud-auth/enroll")) enrollmentBodies.push(request.postData() || "");
    });
    await page.goto(server.url);
    await expect(page.locator(".asset-row")).toHaveCount(20);

    // 顶部登录入口 → 独立登录页；无设备证书时应自动进入「开通本机」。
    await page.locator(".account-entry > .account-button").click();
    await expect(page).toHaveURL(/#\/login$/);
    await expect(page.getByRole("heading", { name: "开通本机", exact: true })).toBeVisible();
    await expect(page.getByLabel("开通码", { exact: true })).toBeVisible();
    await expect(page.getByLabel("开通账户密码", { exact: true })).toBeVisible();
    await expect(page.getByLabel("设备名称", { exact: true })).toBeVisible();
    assert.equal(await page.getByRole("button", { name: "开通并登录", exact: true }).isEnabled(), true);
    await noOverflow(page, `${name}-enroll-1280`);
    await page.screenshot({ path: screenshot(name, "enroll-1280"), animations: "disabled" });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await noOverflow(page, `${name}-enroll-${width}`);
      await page.screenshot({ path: screenshot(name, `enroll-${width}`), animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // 首次失败：固定文案、清空密码/开通码，不泄露原始响应。
    mock.setFailNext(401, "UNAUTHORIZED");
    await page.getByLabel("开通码", { exact: true }).fill(CODE);
    await page.getByLabel("开通账户密码", { exact: true }).fill(PASSWORD);
    await page.getByLabel("设备名称", { exact: true }).fill("验收机");
    await page.getByRole("button", { name: "开通并登录", exact: true }).click();
    await expect(page.locator(".login-error")).toContainText("登录状态无效或凭据已失效");
    await expect(page.getByLabel("开通码", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("开通账户密码", { exact: true })).toHaveValue("");

    // 成功：开通 → 激活 → 自动回主界面，顶部显示账户名。
    await page.getByLabel("开通码", { exact: true }).fill(CODE);
    await page.getByLabel("开通账户密码", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "开通并登录", exact: true }).click();
    await expect(page.locator(".asset-row")).toHaveCount(20, { timeout: 20_000 });
    await expect(page.locator(".account-entry > .account-button")).toContainText("爱丽丝");
    await expect(page.getByRole("button", { name: "第 2 页", exact: true })).toBeVisible();
    await noOverflow(page, `${name}-main-1280`);
    await page.screenshot({ path: screenshot(name, "main-1280"), animations: "disabled" });

    // 打开账户菜单并确认设备状态只显示脱敏信息。
    await page.locator(".account-entry > .account-button").click();
    await expect(page.getByRole("menu", { name: "账户菜单" })).toBeVisible();
    await expect(page.getByRole("menu", { name: "账户菜单" })).toContainText("@alice");
    await page.screenshot({ path: screenshot(name, "menu-1280"), animations: "disabled" });
    await page.keyboard.press("Escape");

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.reload();
      await expect(page.locator(".asset-row")).toHaveCount(20);
      await expect(page.locator(".account-entry > .account-button")).toContainText("爱丽丝");
      await noOverflow(page, `${name}-main-${width}`);
      await page.screenshot({ path: screenshot(name, `main-${width}`), animations: "disabled" });
      await page.locator(".account-entry > .account-button").click();
      await expect(page.getByRole("menu", { name: "账户菜单" })).toBeVisible();
      await noOverflow(page, `${name}-menu-${width}`);
      await page.screenshot({ path: screenshot(name, `menu-${width}`), animations: "disabled" });
      await page.keyboard.press("Escape");
    }

    // 退出后仍保留设备证书，可直接用用户名/密码再次登录；登录页在窄屏不溢出。
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".account-entry > .account-button").click();
    await page.getByRole("menu", { name: "账户菜单" }).getByRole("menuitem", { name: "退出登录", exact: true }).click();
    await expect(page.locator(".account-entry > .account-button")).toContainText("登录", { timeout: 10_000 });
    await page.locator(".account-entry > .account-button").click();
    await expect(page.getByRole("heading", { name: "登录云端账户", exact: true })).toBeVisible();
    await noOverflow(page, `${name}-login-390`);
    await page.screenshot({ path: screenshot(name, "login-390"), animations: "disabled" });
    await page.setViewportSize({ width: 320, height: 700 });
    await noOverflow(page, `${name}-login-320`);
    await page.screenshot({ path: screenshot(name, "login-320"), animations: "disabled" });

    // 浏览器请求体只有开通码/密码/设备名，绝不携带证书、私钥或路径。
    const bodies = enrollmentBodies.join("\n");
    for (const forbidden of ["PRIVATE KEY", "certificate", "cloud-device", "/Users/", "caPath"]) {
      assert.equal(bodies.includes(forbidden), false, `浏览器请求体泄露 ${forbidden}`);
    }
    result.browsers.push({
      name,
      passed: true,
      enrollRequests: enrollmentBodies.length,
      pageErrors,
      screenshots: (await fs.readdir(OUT)).filter((file) => file.startsWith(`${name}-`)).length,
    });
    if (pageErrors.length) throw new Error(`${name}: 页面异常 ${pageErrors.join("; ")}`);
  } finally {
    await context?.close().catch(() => undefined);
    await stopServer(server);
    await browser.close();
  }
}

const mock = await startEnrollmentMock();
mock.getUser("alice").displayName = "爱丽丝";
const releaseFile = path.join(base, "cloud-release.json");
await fs.writeFile(
  releaseFile,
  JSON.stringify(
    {
      schemaVersion: 1,
      enabled: true,
      apiOrigin: mock.apiOrigin,
      enrollmentOrigin: mock.enrollmentOrigin,
      serverCaPem: mock.serverCaPem,
      deviceCaPem: mock.deviceCaPem,
    },
    null,
    2,
  ),
  { mode: 0o644 },
);

// 每个浏览器用独立的 mock 账户状态/设备绑定，避免客户端证书串用。
try {
  const chromiumMock = mock;
  await runFlow(chromium, "chromium", releaseFile, chromiumMock);
  // 第二个浏览器用全新 mock，避免同一开通码已绑定上一浏览器的设备公钥。
  await chromiumMock.close();
  const second = await startEnrollmentMock();
  second.getUser("alice").displayName = "爱丽丝";
  await fs.writeFile(
    releaseFile,
    JSON.stringify(
      {
        schemaVersion: 1,
        enabled: true,
        apiOrigin: second.apiOrigin,
        enrollmentOrigin: second.enrollmentOrigin,
        serverCaPem: second.serverCaPem,
        deviceCaPem: second.deviceCaPem,
      },
      null,
      2,
    ),
  );
  await runFlow(webkit, "webkit", releaseFile, second);
  await second.close();
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
