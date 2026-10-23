/**
 * T-LOCAL-010 隔离 UI 验收：云端管理工作台改版。
 *
 * 真实本地服务 + 一次性 HTTPS/mTLS 管理 mock + 临时 MEDIA_DATA_DIR。
 * 覆盖角色主从/权限分组/空状态/保存与撤销、账户搜索与危险操作确认、
 * 账户授权、小组、个人安全、审计；1920×1080 / 1280×800 / 390×844、
 * 浅色/深色、横向溢出与行内文本/按钮重叠检查。只调用 mock，不连正式云端。
 *
 * 运行：node collab/results/T-LOCAL-010/verify-ui.mjs
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
const OUT = path.join(HERE, "screenshots");
const result = { startedAt: new Date().toISOString(), checks: [], screenshots: [], errors: [] };

await fs.mkdir(OUT, { recursive: true });
const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-t10-ui-")));

function note(label, detail = "") {
  result.checks.push({ label, detail, at: new Date().toISOString() });
}

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

async function cloudLogin(server, cloud) {
  const sessionResponse = await fetch(`${server.url}/api/session`);
  const setCookie = sessionResponse.headers.getSetCookie?.()[0] || sessionResponse.headers.get("set-cookie");
  const cookie = String(setCookie || "").split(";")[0];
  const session = await sessionResponse.json();
  assert.ok(cookie && session.token, "本地会话创建失败");
  const headers = { "content-type": "application/json", cookie, "x-local-token": session.token };
  let response = await fetch(`${server.url}/api/cloud-auth/config`, {
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
  response = await fetch(`${server.url}/api/cloud-auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  assert.equal(response.status, 200, await response.text());
}

async function noOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - innerWidth,
    body: document.body.scrollWidth - innerWidth,
    panels: [...document.querySelectorAll(".cw-panel, .cw-workbench, .cw-surface")].map(
      (node) => node.scrollWidth - node.clientWidth,
    ),
  }));
  assert.ok(metrics.document <= 1, `${label}: 页面横向溢出 ${metrics.document}px`);
  assert.ok(metrics.body <= 1, `${label}: body 横向溢出 ${metrics.body}px`);
  assert.ok(metrics.panels.every((value) => value <= 1), `${label}: 管理面板内部横向溢出 ${metrics.panels.join(",")}`);
  note(`overflow:${label}`, JSON.stringify(metrics));
}

async function noClippedControls(page, label) {
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll(".cw-panel button, .cw-panel .cw-badge")]
      .filter((node) => {
        const style = getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return false;
        return node.scrollWidth > node.clientWidth + 2;
      })
      .map((node) => `${node.tagName}:${(node.textContent || "").trim().slice(0, 40)}`),
  );
  assert.deepEqual(clipped, [], `${label}: 文本/按钮被裁剪 ${clipped.join(" | ")}`);
  note(`clipped:${label}`);
}

async function noRowOverlap(page, label) {
  const overlaps = await page.evaluate(() => {
    const bad = [];
    for (const row of document.querySelectorAll(".cw-row")) {
      const main = row.querySelector(".cw-row-main");
      const actions = row.querySelector(".cw-actions, .cw-inline-confirm");
      if (!main || !actions) continue;
      const a = main.getBoundingClientRect();
      const b = actions.getBoundingClientRect();
      const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ix > 1 && iy > 1) bad.push((row.textContent || "").trim().slice(0, 48));
    }
    return bad;
  });
  assert.deepEqual(overlaps, [], `${label}: 行内文本与操作重叠 ${overlaps.join(" | ")}`);
  note(`row-overlap:${label}`);
}

async function openWorkspace(page) {
  await expect(page.locator(".account-button.signed-in")).toBeVisible({ timeout: 15_000 });
  await page.locator(".account-entry > .account-button").click();
  await expect(page.getByRole("menu", { name: "账户菜单" })).toBeVisible();
  await page.getByRole("menuitem", { name: "账户与小组", exact: true }).click();
  await expect(page).toHaveURL(/#\/account$/);
  await expect(page.locator(".cw-title strong", { hasText: "账户与小组" })).toBeVisible();
  await expect(page.locator(".cw-tabs")).toBeVisible();
  await page.getByRole("button", { name: "角色与授权", exact: true }).click();
  await expect(page.locator(".cw-panel[aria-label='角色与授权']")).toBeVisible();
}

async function shot(page, name, label) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: "disabled" });
  result.screenshots.push({ name, label, file });
}

async function setViewport(page, width, height) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(120);
}

const cloud = await startManagementCloud();
const server = await startServer();
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error.message || error)));

try {
  await cloudLogin(server, cloud);
  await context.addInitScript(() => {
    localStorage.setItem("shiguang.pageSize", "20");
    localStorage.setItem("shiguang.refreshSeconds", "0");
  });
  await page.goto(server.url);
  await expect(page.locator(".asset-row")).toHaveCount(0);
  await openWorkspace(page);

  // ---------- 角色：有数据 / 权限分组 / 三种尺寸 ----------
  await expect(page.locator(".cw-select-list button", { hasText: "音频审核员" })).toBeVisible();
  await expect(page.locator(".cw-detail h2")).toContainText("管理员");
  const groupsVisible = await page.locator(".cw-perm-group h3").allTextContents();
  assert.ok(groupsVisible.some((text) => text.includes("账户")), `权限未按语义分组：${groupsVisible.join(",")}`);
  assert.ok(groupsVisible.some((text) => text.includes("小组")), `权限未按语义分组：${groupsVisible.join(",")}`);
  assert.equal(await page.getByRole("button", { name: "撤销更改" }).isDisabled(), true, "未修改时撤销应禁用");
  for (const [width, height] of [[1920, 1080], [1280, 800], [390, 844]]) {
    await setViewport(page, width, height);
    await noOverflow(page, `roles-${width}`);
    await noClippedControls(page, `roles-${width}`);
    await noRowOverlap(page, `roles-${width}`);
    await shot(page, `roles-data-${width}x${height}`, `角色与授权 · 有数据 · ${width}×${height}`);
  }

  // ---------- 角色空状态（拦截 mock，仅用于截图） ----------
  await setViewport(page, 1280, 800);
  await page.route("**/api/cloud-management/roles**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.locator(".cw-pagebar").getByRole("button", { name: "刷新" }).click();
  await expect(page.locator(".cw-empty-state h2")).toContainText("还没有角色");
  await expect(page.locator(".cw-master")).toContainText("暂无角色");
  await setViewport(page, 1920, 1080);
  await noOverflow(page, "roles-empty-1920");
  await shot(page, "roles-empty-1920x1080", "角色与授权 · 空状态 · 1920×1080");
  await setViewport(page, 1280, 800);
  await noOverflow(page, "roles-empty-1280");
  await shot(page, "roles-empty-1280x800", "角色与授权 · 空状态 · 1280×800");
  await setViewport(page, 390, 844);
  await noOverflow(page, "roles-empty-390");
  await shot(page, "roles-empty-390x844", "角色与授权 · 空状态 · 390×844");
  await page.unroute("**/api/cloud-management/roles**");
  await setViewport(page, 1280, 800);
  await page.locator(".cw-pagebar").getByRole("button", { name: "刷新" }).click();
  await expect(page.locator(".cw-select-list button", { hasText: "音频审核员" })).toBeVisible();

  // ---------- 权限保存 / 取消 ----------
  await page.locator(".cw-select-list button", { hasText: "音频审核员" }).click();
  await expect(page.locator(".cw-detail h2")).toContainText("音频审核员");
  const manage = page.getByLabel("group:member:manage", { exact: true });
  const save = page.getByRole("button", { name: "保存权限" });
  const cancel = page.getByRole("button", { name: "撤销更改" });
  await expect(manage).not.toBeChecked();
  await manage.check();
  await expect(save).toBeEnabled();
  await cancel.click();
  await expect(manage).not.toBeChecked();
  await expect(save).toBeDisabled();
  note("role-cancel", "撤销更改后回到原权限，保存重新禁用");
  await manage.check();
  await save.click();
  await expect(page.locator(".cw-success")).toContainText("角色权限已更新");
  await expect(manage).toBeChecked();
  note("role-save", "权限保存成功，勾选状态保留");

  // ---------- 深色主题 ----------
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(150);
  await noOverflow(page, "roles-dark-1280");
  await shot(page, "roles-dark-1280x800", "角色与授权 · 深色主题 · 1280×800");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "forest";
  });

  // ---------- 账户授权 ----------
  await page.getByRole("button", { name: "账户授权", exact: true }).click();
  await expect(page.locator(".cw-auth-workbench .cw-select-list button").first()).toBeVisible();
  await expect(page.locator(".cw-detail")).toContainText("选择一个账户");
  await setViewport(page, 1920, 1080);
  await noOverflow(page, "roles-auth-1920");
  await shot(page, "roles-auth-1920x1080", "账户授权 · 账户列表 · 1920×1080");
  await setViewport(page, 1280, 800);
  await noOverflow(page, "roles-auth-1280");
  await shot(page, "roles-auth-1280x800", "账户授权 · 账户列表 · 1280×800");
  await page.getByLabel("授权账户搜索").fill("member");
  await page.locator(".cw-filterbar").getByRole("button", { name: "搜索" }).click();
  const authMember = page.locator(".cw-auth-workbench .cw-select-list button", { hasText: "@member" });
  await expect(authMember).toBeVisible();
  await authMember.click();
  await expect(page.locator(".cw-detail")).toContainText("@member");
  await expect(page.locator(".cw-assign-section").first()).toBeVisible();
  await noOverflow(page, "roles-auth-member-1280");
  await noClippedControls(page, "roles-auth-member-1280");
  await shot(page, "roles-auth-member-1280x800", "账户授权 · 选中账户与授权明细 · 1280×800");
  await setViewport(page, 390, 844);
  await noOverflow(page, "roles-auth-390");
  await shot(page, "roles-auth-390x844", "账户授权 · 390×844");

  // ---------- 账户管理：搜索 / 危险操作确认 ----------
  await setViewport(page, 1280, 800);
  await page.getByRole("button", { name: "账户管理", exact: true }).click();
  await expect(page.locator(".cw-account-list .cw-row").first()).toBeVisible();
  await noOverflow(page, "accounts-1280");
  await noClippedControls(page, "accounts-1280");
  await noRowOverlap(page, "accounts-1280");
  await shot(page, "accounts-1280x800", "账户管理 · 账户列表 · 1280×800");
  await page.getByLabel("搜索账户").fill("member");
  await page.locator(".cw-filterbar").getByRole("button", { name: "搜索" }).click();
  const memberRow = page.locator(".cw-account-list .cw-row", { hasText: "@member" });
  await expect(memberRow).toBeVisible();
  await memberRow.getByRole("button", { name: "停用" }).click();
  await expect(page.locator(".cw-confirm")).toBeVisible();
  await expect(page.locator(".cw-confirm")).toContainText("确认停用 @member");
  await page.locator(".cw-confirm").getByRole("button", { name: "取消" }).click();
  await expect(page.locator(".cw-confirm")).toHaveCount(0);
  await expect(memberRow).toContainText("启用");
  note("account-disable-cancel", "取消停用后账户状态未变");
  await memberRow.getByRole("button", { name: "停用" }).click();
  await page.locator(".cw-confirm").getByRole("button", { name: "确认" }).click();
  await expect(page.locator(".cw-success")).toContainText("账户已停用");
  await expect(memberRow).toContainText("停用");
  note("account-disable-confirm", "确认后账户停用");
  await setViewport(page, 390, 844);
  await noOverflow(page, "accounts-390");
  await noClippedControls(page, "accounts-390");
  await noRowOverlap(page, "accounts-390");
  await shot(page, "accounts-390x844", "账户管理 · 390×844");

  // ---------- 小组：危险操作确认 ----------
  await setViewport(page, 1280, 800);
  await page.getByRole("button", { name: "小组与成员", exact: true }).click();
  await page.getByLabel("管理模式（含停用/待接管小组）").check();
  await expect(page.locator(".cw-groups-workbench .cw-select-list button").first()).toBeVisible();
  await noOverflow(page, "groups-1280");
  await noClippedControls(page, "groups-1280");
  await noRowOverlap(page, "groups-1280");
  await shot(page, "groups-1280x800", "小组与成员 · 1280×800");
  if (await page.getByRole("button", { name: "停用小组" }).count()) {
    await page.getByRole("button", { name: "停用小组" }).click();
    await expect(page.locator(".cw-confirm")).toBeVisible();
    await page.locator(".cw-confirm").getByRole("button", { name: "取消" }).click();
    await expect(page.locator(".cw-confirm")).toHaveCount(0);
    note("group-disable-cancel", "取消停用小组后未提交");
  }

  // ---------- 个人安全：浅色 / 深色 / 窄屏 ----------
  await page.getByRole("button", { name: "个人安全", exact: true }).click();
  await expect(page.getByRole("region", { name: "个人安全" })).toBeVisible();
  await noOverflow(page, "security-1280");
  await noRowOverlap(page, "security-1280");
  await shot(page, "security-1280x800", "个人安全 · 1280×800");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.waitForTimeout(150);
  await noOverflow(page, "security-dark-1280");
  await shot(page, "security-dark-1280x800", "个人安全 · 深色主题 · 1280×800");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "forest";
  });
  await setViewport(page, 390, 844);
  await noOverflow(page, "security-390");
  await noClippedControls(page, "security-390");
  await shot(page, "security-390x844", "个人安全 · 390×844");

  // ---------- 审计 ----------
  await setViewport(page, 1280, 800);
  await page.getByRole("button", { name: "审计", exact: true }).click();
  await expect(page.locator(".cw-panel[aria-label='审计']")).toBeVisible();
  await noOverflow(page, "audit-1280");
  await noClippedControls(page, "audit-1280");
  await shot(page, "audit-1280x800", "审计 · 1280×800");

  // ---------- 全部主区域在 390 宽逐页复查横向溢出 ----------
  await setViewport(page, 390, 844);
  for (const tab of ["个人安全", "小组与成员", "账户管理", "角色与授权", "审计"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await page.waitForTimeout(250);
    await noOverflow(page, `all-tabs-390:${tab}`);
    await noClippedControls(page, `all-tabs-390:${tab}`);
  }

  assert.deepEqual(pageErrors, [], `页面异常：${pageErrors.join("; ")}`);
  note("page-errors", "none");
} catch (error) {
  result.errors.push(String(error?.stack || error));
  throw error;
} finally {
  await fs.writeFile(
    path.join(HERE, "ui-results.json"),
    JSON.stringify({ ...result, finishedAt: new Date().toISOString() }, null, 2) + "\n",
  );
  await context.close().catch(() => undefined);
  await browser.close();
  await cloud.close();
  await stopServer(server);
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
}

console.log(JSON.stringify({ checks: result.checks.length, screenshots: result.screenshots.length, errors: result.errors }, null, 2));
