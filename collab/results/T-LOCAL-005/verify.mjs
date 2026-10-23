/**
 * T-LOCAL-005 隔离验收脚本。
 *
 * - 真实 HTTPS/mTLS mock（一次性 CA/证书）+ 临时 MEDIA_DATA_DIR；
 * - 无头 Chromium（本机 Chrome）与 WebKit；
 * - 覆盖未配置、保存、激活、登录、退出、401、429、证书错误、离线、
 *   本地已退出但云端未确认、请求中防连点、刷新后仅恢复脱敏状态；
 * - 截图 1280/390/320，检查表单、错误、加载状态无横向溢出。
 *
 * 运行：node collab/results/T-LOCAL-005/verify.mjs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { startMockCloud } from "../../../tests/cloud-auth-mock.mjs";

const PASSWORD = "correct horse battery staple";
const P12_PASS = crypto.randomBytes(18).toString("base64url");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "screenshots");
const result = { startedAt: new Date().toISOString(), browsers: [], errors: [] };

await fs.mkdir(OUT, { recursive: true });
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-cloud-ui-")));
const cloud = await startMockCloud();
await cloud.enroll({
  username: "alice",
  password: PASSWORD,
  displayName: "爱丽丝",
  superAdmin: true,
  clientCert: cloud.clientCertA,
  clientKey: cloud.clientKeyA,
});
await promisify(execFile)("openssl", [
  "pkcs12",
  "-export",
  "-out",
  path.join(cloud.dir, "client-a.p12"),
  "-inkey",
  cloud.clientKeyA,
  "-in",
  cloud.clientCertA,
  "-passout",
  `pass:${P12_PASS}`,
  "-name",
  "device-a",
]);
const P12_PATH = path.join(cloud.dir, "client-a.p12");

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

async function openSettings(page) {
  await page.getByRole("button", { name: "设置与缓存", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "设置与缓存", exact: true });
  await expect(dialog).toBeVisible();
  const region = dialog.getByRole("region", { name: "云端连接", exact: true });
  await expect(region).toBeVisible();
  return { dialog, region };
}

async function assertNoHorizontalOverflow(page, region, label) {
  await region.scrollIntoViewIfNeeded();
  const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(pageOverflow <= 1, `${label}: 页面横向溢出 ${pageOverflow}px`);
  const regionOverflow = await region.evaluate((el) => el.scrollWidth - el.clientWidth);
  assert.ok(regionOverflow <= 1, `${label}: 云端区域横向溢出 ${regionOverflow}px`);
  const boxes = await region.locator("input, button").evaluateAll((els) =>
    els.map((el) => {
      const rect = el.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }),
  );
  const viewport = page.viewportSize();
  for (const box of boxes) {
    assert.ok(box.left >= -1, `${label}: 控件越过左侧 ${box.left}px`);
    assert.ok(box.right <= viewport.width + 1, `${label}: 控件越过右侧 ${box.right}px`);
  }
}

async function startServer(name) {
  const dataDir = path.join(base, `${name}-data`);
  await fs.mkdir(dataDir, { recursive: true });
  // 避免临时数据目录触发 swiftc；仅放空占位，不用于真实删除。
  const trashHash = crypto.createHash("sha256").update(await fs.readFile(path.join(PROJECT, "server/trash.swift"))).digest("hex").slice(0, 12);
  await fs.writeFile(path.join(dataDir, `trash-helper-${trashHash}`), "", { mode: 0o755 });
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

async function runFlow(browserType, name, options) {
  const browser = await browserType.launch({ headless: true, ...options });
  const server = await startServer(name);
  const pageErrors = [];
  const cloudBodies = [];
  const syntheticBodies = [];
  const cloudRequests = [];
  const responseWaiters = [];
  let context;
  try {
    const pending = await cloud.enrollPending({
      username: `carol-${name}`,
      displayName: "卡罗尔",
      clientCert: cloud.clientCertB,
    });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => localStorage.setItem("shiguang.refreshSeconds", "0"));
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
    page.on("request", (req) => {
      if (req.url().includes("/api/cloud-auth/")) cloudRequests.push({ method: req.method(), url: req.url() });
    });
    page.on("response", (res) => {
      if (!res.url().includes("/api/cloud-auth/")) return;
      const synthetic = res.headers()["x-synthetic"] === "1";
      responseWaiters.push(
        res
          .text()
          .then((text) => (synthetic ? syntheticBodies : cloudBodies).push({ url: res.url(), status: res.status(), text }))
          .catch(() => undefined),
      );
    });

    await page.goto(server.url);
    let { dialog, region } = await openSettings(page);
    await expect(region.locator(".database-status")).toHaveText("未配置");
    await expect(region.getByRole("button", { name: "登录", exact: true })).toBeDisabled();
    await expect(region.getByRole("button", { name: "激活设备", exact: true })).toBeDisabled();

    // 未配置时保存：只显示安全的配置错误，不泄露路径。
    await region.getByRole("button", { name: "保存连接配置", exact: true }).click();
    await expect(region.locator(".database-error")).toContainText("云端连接配置不完整");

    // 保存连接配置（PEM，客户端 B；状态必须明确是“已保存、未连接”）。
    await region.getByLabel("云端地址（HTTPS）", { exact: true }).fill(cloud.origin);
    await region.getByLabel("云端 CA 证书路径", { exact: true }).fill(cloud.caCert);
    await region.getByLabel("设备证书路径（PEM）", { exact: true }).fill(cloud.clientCertB);
    await region.getByLabel("设备私钥路径（PEM）", { exact: true }).fill(cloud.clientKeyB);
    await region.getByRole("button", { name: "保存连接配置", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("连接配置已保存");
    await expect(region.locator(".database-status")).toHaveText("已保存，未连接");
    await expect(region.getByLabel("云端 CA 证书路径", { exact: true })).toHaveValue("");
    await expect(region.getByLabel("设备证书路径（PEM）", { exact: true })).toHaveValue("");
    await expect(region.getByLabel("设备私钥路径（PEM）", { exact: true })).toHaveValue("");
    assert.equal((await region.innerText()).includes(base), false, "配置成功后界面回显了本机路径");

    // 401：错误激活凭证；提交后激活码与密码都必须立刻清空。
    await region.getByLabel("激活凭证", { exact: true }).fill("invalid-activation-token");
    await region.getByLabel("激活设置密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "激活设备", exact: true }).click();
    await expect(region.locator(".database-error")).toContainText("登录状态无效");
    await expect(region.getByLabel("激活凭证", { exact: true })).toHaveValue("");
    await expect(region.getByLabel("激活设置密码", { exact: true })).toHaveValue("");

    // 激活成功：一次性凭证 + 设置密码，随后自动登录。
    await region.getByLabel("激活凭证", { exact: true }).fill(pending.activationToken);
    await region.getByLabel("激活设置密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "激活设备", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("设备已激活并登录云端");
    await expect(region.locator(".database-status")).toHaveText("已连接");
    await expect(region.locator(".cloud-summary")).toContainText(`卡罗尔 · carol-${name}`);
    await expect(region.locator(".cloud-summary")).not.toContainText(base);
    await expect(region.getByLabel("激活凭证", { exact: true })).toHaveValue("");
    await expect(region.getByLabel("激活设置密码", { exact: true })).toHaveValue("");

    // 刷新页面：只从后端恢复脱敏状态，不恢复密码/令牌。
    await page.reload();
    const reopened = await openSettings(page);
    dialog = reopened.dialog;
    region = reopened.region;
    await expect(region.locator(".database-status")).toHaveText("已连接");
    await expect(region.locator(".cloud-summary")).toContainText(`卡罗尔 · carol-${name}`);
    await expect(region.getByLabel("云端密码", { exact: true })).toHaveValue("");
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    assert.equal(storage.includes(PASSWORD), false, "localStorage/sessionStorage 存了密码");
    assert.equal(storage.includes("refreshToken"), false, "localStorage/sessionStorage 存了令牌");

    // 三种宽度的表单截图 + 溢出检查。
    for (const [width, height] of [[1280, 900], [390, 700], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await assertNoHorizontalOverflow(page, region, `${name}-form-${width}`);
      await region.scrollIntoViewIfNeeded();
      await page.screenshot({ path: screenshot(name, `form-${width}`), animations: "disabled" });
    }

    // 退出登录：真实 mock 撤销会话。
    await page.setViewportSize({ width: 1280, height: 900 });
    await region.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("已退出，云端会话已撤销");
    await expect(region.locator(".database-status")).toHaveText("已保存，未连接");

    // 切换到客户端 A 的 P12，登录 alice：先验证口令只写不回显，再测错误密码 401 与成功。
    await region.getByLabel("设备证书路径（P12）", { exact: true }).fill(P12_PATH);
    await region.getByLabel("P12 口令（仅本机保存，不回显）", { exact: true }).fill(P12_PASS);
    await region.getByRole("button", { name: "保存连接配置", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("连接配置已保存");
    await expect(region.getByLabel("P12 口令（仅本机保存，不回显）", { exact: true })).toHaveValue("");
    assert.equal((await region.innerText()).includes(P12_PATH), false, "P12 路径被界面回显");
    assert.equal((await region.innerText()).includes(P12_PASS), false, "P12 口令被界面回显");
    const p12Config = JSON.parse(await fs.readFile(path.join(server.dataDir, "cloud-auth.json"), "utf8"));
    assert.equal(p12Config.p12Path, P12_PATH, "P12 路径未写入配置");
    assert.equal(p12Config.certPath, "", "切换 P12 时未清掉旧 PEM 证书");
    assert.equal(p12Config.keyPath, "", "切换 P12 时未清掉旧 PEM 私钥");
    assert.equal(JSON.stringify(p12Config).includes(P12_PASS), false, "配置文件存了 P12 口令");
    await region.getByLabel("云端用户名", { exact: true }).fill("alice");
    await region.getByLabel("云端密码", { exact: true }).fill("wrong password");
    await region.getByRole("button", { name: "登录", exact: true }).click();
    await expect(region.locator(".database-error")).toContainText("登录状态无效");
    await expect(region.getByLabel("云端密码", { exact: true })).toHaveValue("");
    await region.getByLabel("云端密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "登录", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("已连接云端并登录");
    await expect(region.locator(".cloud-summary")).toContainText("爱丽丝 · alice");

    // 再切回 PEM，确认旧 P12 不会继续压住新证书。
    await region.getByLabel("设备证书路径（PEM）", { exact: true }).fill(cloud.clientCertA);
    await region.getByLabel("设备私钥路径（PEM）", { exact: true }).fill(cloud.clientKeyA);
    await region.getByRole("button", { name: "保存连接配置", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("连接配置已保存");
    const pemConfig = JSON.parse(await fs.readFile(path.join(server.dataDir, "cloud-auth.json"), "utf8"));
    assert.equal(pemConfig.p12Path, "", "切回 PEM 时未清掉旧 P12");
    assert.equal(pemConfig.certPath, cloud.clientCertA);
    await region.getByLabel("云端密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "登录", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("已连接云端并登录");

    // 请求中防连点：延迟真实登录响应，期间全部动作必须禁用。
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const loginPattern = "**/api/cloud-auth/login";
    let delayedLogins = 0;
    await page.route(loginPattern, async (route) => {
      delayedLogins += 1;
      await gate;
      await route.continue();
    });
    await region.getByLabel("云端密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "登录", exact: true }).click();
    await expect(region.getByRole("button", { name: "登录中…", exact: true })).toBeDisabled();
    await expect(region.getByRole("button", { name: "保存连接配置", exact: true })).toBeDisabled();
    await expect(region.getByRole("button", { name: "退出登录", exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 390, height: 700 });
    await assertNoHorizontalOverflow(page, region, `${name}-loading-390`);
    await region.getByRole("button", { name: "登录中…", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot(name, "loading-390"), animations: "disabled" });
    release();
    await expect(region.locator(".cloud-notice")).toContainText("已连接云端并登录");
    assert.equal(delayedLogins, 1, "登录请求被重复提交");
    await page.unroute(loginPattern);

    // 429 冷却：只验证前端安全提示，不噪音真实 mock。
    await page.route(loginPattern, (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Retry-After": "2", "x-synthetic": "1" },
        body: JSON.stringify({ error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED", kind: "cloud", retryAfterMs: 2000 }),
      }),
    );
    await region.getByLabel("云端密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "登录", exact: true }).click();
    await expect(region.locator(".database-error")).toContainText("请求过于频繁，请 2 秒后重试");
    await page.unroute(loginPattern);

    // 证书失败：固定公开文案，不显示本机路径或原始异常。
    await page.route(loginPattern, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "x-synthetic": "1" },
        body: JSON.stringify({ error: `ENOENT ${base}/client.crt`, code: "CERT_FILE_UNREADABLE", kind: "cert" }),
      }),
    );
    await region.getByLabel("云端密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "登录", exact: true }).click();
    await expect(region.locator(".database-error")).toContainText("无法读取证书文件");
    await expect(region.locator(".database-error")).not.toContainText(base);
    await page.unroute(loginPattern);

    // 离线：网络类错误固定文案。
    await page.route(loginPattern, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        headers: { "x-synthetic": "1" },
        body: JSON.stringify({ error: "connect ECONNREFUSED 127.0.0.1", code: "ECONNREFUSED", kind: "network" }),
      }),
    );
    await region.getByLabel("云端密码", { exact: true }).fill(PASSWORD);
    await region.getByRole("button", { name: "登录", exact: true }).click();
    await expect(region.locator(".database-error")).toContainText("无法连接云端服务");
    await expect(region.locator(".database-error")).not.toContainText("127.0.0.1");
    await page.unroute(loginPattern);

    // 错误态窄屏截图。
    for (const [width, height] of [[390, 700], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await assertNoHorizontalOverflow(page, region, `${name}-error-${width}`);
      await region.locator(".database-error").scrollIntoViewIfNeeded();
      await page.screenshot({ path: screenshot(name, `error-${width}`), animations: "disabled" });
    }

    // 本地已退出但远端撤销未确认：模拟后端 200 返回（不接真实网络）。
    const currentStatus = await page.evaluate(async () => {
      const response = await fetch("/api/cloud-auth/status");
      return response.json();
    });
    const loggedOutState = {
      ...currentStatus,
      state: "logged-out",
      username: null,
      displayName: null,
      accountId: null,
      deviceId: null,
      sessionId: null,
      refreshExpiresAt: null,
      accessExpiresInMs: null,
      needsLogin: false,
      lastError: null,
      retryAfterMs: null,
    };
    await page.route("**/api/cloud-auth/logout", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "x-synthetic": "1" },
        body: JSON.stringify({
          localLoggedOut: true,
          cloudRevoked: false,
          error: { code: "ECONNREFUSED", kind: "network", status: null, message: "无法连接云端服务" },
          state: loggedOutState,
        }),
      }),
    );
    await page.setViewportSize({ width: 320, height: 640 });
    await region.getByRole("button", { name: "退出登录", exact: true }).click();
    await expect(region.locator(".cloud-notice")).toContainText("本地已退出；云端撤销未确认");
    await expect(region.locator(".cloud-notice")).toContainText("无法连接云端服务");
    await assertNoHorizontalOverflow(page, region, `${name}-logout-unconfirmed-320`);
    await region.locator(".cloud-notice").scrollIntoViewIfNeeded();
    await page.screenshot({ path: screenshot(name, "logout-unconfirmed-320"), animations: "disabled" });
    await page.unroute("**/api/cloud-auth/logout");

    await Promise.all(responseWaiters);

    // 网络与 DOM 脱敏断言。
    const allBodies = cloudBodies.map((item) => item.text).join("\n");
    for (const forbidden of ["accessToken", "refreshToken", PASSWORD, P12_PASS, base, cloud.caCert, cloud.clientKeyA, P12_PATH]) {
      assert.equal(allBodies.includes(forbidden), false, `云端认证响应泄露了 ${forbidden.slice(0, 40)}`);
    }
    for (const request of cloudRequests) {
      assert.equal(request.url.includes("password"), false, "密码出现在 URL 查询串");
      assert.equal(request.url.includes("activationToken"), false, "激活码出现在 URL 查询串");
    }
    const domText = await page.evaluate(() => document.body.innerText);
    for (const forbidden of ["accessToken", "refreshToken", PASSWORD, P12_PASS, base, P12_PATH]) {
      assert.equal(domText.includes(forbidden), false, `页面 DOM 泄露了 ${forbidden.slice(0, 40)}`);
    }

    // 直接读取状态接口，确认只返回脱敏字段。
    const sessionResponse = await fetch(`${server.url}/api/session`);
    const session = await sessionResponse.json();
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
    const statusResponse = await fetch(`${server.url}/api/cloud-auth/status`, { headers: { cookie } });
    const statusText = await statusResponse.text();
    for (const forbidden of ["accessToken", "refreshToken", PASSWORD, P12_PASS, base, P12_PATH, cloud.caCert]) {
      assert.equal(statusText.includes(forbidden), false, `status 接口泄露了 ${forbidden.slice(0, 40)}`);
    }

    for (const [width, height] of [[1280, 900], [390, 700], [320, 640]]) {
      await page.setViewportSize({ width, height });
      await assertNoHorizontalOverflow(page, region, `${name}-final-${width}`);
      await page.screenshot({ path: screenshot(name, `final-${width}`), animations: "disabled" });
    }

    assert.deepEqual(pageErrors, [], `${name} 页面脚本错误：${pageErrors.join("; ")}`);
    result.browsers.push({ name, ok: true, cloudRequests: cloudRequests.length, screenshots: (await fs.readdir(OUT)).filter((f) => f.startsWith(name + "-")).length });
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
    await stopServer(server);
    await fs.rm(server.dataDir, { recursive: true, force: true });
  }
}

try {
  await runFlow(chromium, "chrome", { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  await runFlow(webkit, "webkit", {});
} finally {
  await cloud.close().catch(() => undefined);
  await fs.rm(cloud.dir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(base, { recursive: true, force: true }).catch(() => undefined);
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(HERE, "results.json"), JSON.stringify(result, null, 2) + "\n");
  if (result.errors.length) {
    console.error(JSON.stringify(result.errors, null, 2));
    process.exitCode = 1;
  }
}
