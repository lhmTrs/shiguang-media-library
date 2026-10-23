/**
 * T-LOCAL-010 改版前基线截图（只用于对比，不是验收脚本）。
 * 一次性本地服务 + 管理 mock + 临时 MEDIA_DATA_DIR；不连正式云端、不碰真实素材。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startManagementCloud } from "../../../tests/cloud-management-mock.mjs";

const PASSWORD = "correct horse battery staple";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "../../..");
const OUT = path.join(HERE, "screenshots", "before");
await fs.mkdir(OUT, { recursive: true });
const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-t10-before-")));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

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
let url = "";
const deadline = Date.now() + 25_000;
while (Date.now() < deadline) {
  const match = logs.match(/拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/);
  if (match) {
    url = match[1];
    break;
  }
  if (child.exitCode !== null) throw new Error(`服务提前退出：\n${logs}`);
  await new Promise((resolve) => setTimeout(resolve, 60));
}
assert.ok(url, `服务启动超时：\n${logs}`);

const cloud = await startManagementCloud();
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
try {
  const sessionResponse = await fetch(`${url}/api/session`);
  const setCookie = sessionResponse.headers.getSetCookie?.()[0] || sessionResponse.headers.get("set-cookie");
  const cookie = String(setCookie || "").split(";")[0];
  const session = await sessionResponse.json();
  const headers = { "content-type": "application/json", cookie, "x-local-token": session.token };
  let response = await fetch(`${url}/api/cloud-auth/config`, {
    method: "POST",
    headers,
    body: JSON.stringify({ origin: cloud.origin, caPath: cloud.caCert, certPath: cloud.clientOwner.cert, keyPath: cloud.clientOwner.key }),
  });
  assert.equal(response.status, 200, await response.text());
  response = await fetch(`${url}/api/cloud-auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  assert.equal(response.status, 200, await response.text());

  await context.addInitScript(() => {
    localStorage.setItem("shiguang.pageSize", "20");
    localStorage.setItem("shiguang.refreshSeconds", "0");
  });
  await page.goto(url);
  await page.waitForTimeout(1500);
  console.log("account:", await page.locator(".account-button").innerText(), "signed-in:", await page.locator(".account-button.signed-in").count());
  await page.screenshot({ path: path.join(OUT, "debug-home.png") });
  await page.locator(".account-entry > .account-button").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "debug-menu.png") });
  await page.getByRole("menuitem", { name: "账户与小组", exact: true }).click();
  await expect(page.locator(".cw-tabs")).toBeVisible();
  await page.getByRole("button", { name: "角色与授权", exact: true }).click();
  await expect(page.locator(".cw-panel[aria-label='角色与授权']")).toBeVisible();
  await page.waitForTimeout(700);

  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, `roles-${width}x${height}-before.png`), animations: "disabled" });
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "账户管理", exact: true }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, "accounts-1280x800-before.png"), animations: "disabled" });
  await page.getByRole("button", { name: "个人安全", exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, "security-1280x800-before.png"), animations: "disabled" });
  console.log("before screenshots ok");
} finally {
  await context.close().catch(() => undefined);
  await browser.close();
  await cloud.close();
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 4000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}
