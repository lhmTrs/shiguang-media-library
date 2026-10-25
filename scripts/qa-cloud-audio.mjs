/**
 * T-LOCAL-014B 无头工作流验收（1280x800，WebKit）。
 *
 * 固定适配器：Playwright 在浏览器层拦截 /api/*，返回与真实本地 API 同形状的
 * 合成目录/来源/任务；不使用真实云端、账户、素材或数据库。用于验证页面在
 * 懒加载、来源选择、下载进度、取消、失败重试、关闭页面后任务继续等状态下的行为。
 *
 * 运行：node scripts/qa-cloud-audio.mjs
 * 证据：collab/results/T-LOCAL-014B/logs/ui-workflow.log 与 screenshots/。
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(PROJECT, "collab/results/T-LOCAL-014B");
const SHOTS = path.join(OUT, "screenshots");
const LOG = path.join(OUT, "logs/ui-workflow.log");
const ROOT_PATH = "/tmp/shiguang-qa-cloud-audio-download";

const logLines = [];
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  logLines.push(line);
  console.log(line);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`static server not ready: ${url}`);
}

function audioItem(id, fileName, category, mediaKind = "SFX") {
  return {
    id,
    sha256: "a".repeat(64),
    bytes: 8192,
    contentType: "audio/wav",
    createdAt: "2026-10-24T00:00:00Z",
    preferredShareId: id.replace(/.$/, "1"),
    ownerAccountId: "owner-demo",
    fileName,
    mediaKind,
    category,
    subcategory: "环境",
    visibleShareCount: 2,
  };
}

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });
  await fs.mkdir(path.dirname(LOG), { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const vite = spawn(
    process.execPath,
    [path.join(PROJECT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: PROJECT, stdio: ["ignore", "pipe", "pipe"] },
  );
  let viteOut = "";
  vite.stdout.on("data", (chunk) => (viteOut += chunk));
  vite.stderr.on("data", (chunk) => (viteOut += chunk));
  const stopVite = async () => {
    if (vite.exitCode === null) {
      vite.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (vite.exitCode === null) vite.kill("SIGKILL");
    }
  };

  const browser = await webkit.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addCookies([{ name: "media_session", value: "qa-session", domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => consoleErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));

  const normalId = "11111111-1111-4111-8111-111111111111";
  const failId = "22222222-2222-4222-8222-222222222222";
  const items = [audioItem(normalId, "环境音.wav", "音效"), audioItem(failId, "损坏示例.wav", "音效")];
  const state = {
    catalogCalls: 0,
    detailCalls: 0,
    jobCalls: 0,
    rootPosts: 0,
    rootKinds: [],
    jobs: [],
    attempts: new Map(),
    roots: [{ id: "root-demo", name: "下载根", kind: "sfx" }],
    jobSeq: 0,
  };
  const progresses = () => {
    const now = Date.now();
    for (const job of state.jobs) {
      if (job.state === "queued" && now - job.createdAt >= 120) job.state = "downloading";
      if (job.state === "downloading") {
        const ratio = Math.min(1, (now - job.createdAt) / 1500);
        job.receivedBytes = Math.round(job.bytes * ratio);
        if (ratio >= 1) {
          if (job.failOnce) {
            job.state = "failed";
            job.errorCode = "DIGEST_MISMATCH";
            job.error = "音频内容校验失败";
            job.completedAt = Date.now();
          } else {
            job.state = "completed";
            job.receivedBytes = job.bytes;
            job.assetId = `asset-${job.id.slice(0, 6)}`;
            job.completedAt = Date.now();
          }
        }
      }
    }
    return state.jobs.map((job) => ({ ...job }));
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const profile = {
    me: {
      accountId: "demo-account",
      username: "demo",
      displayName: "演示用户",
      deviceId: "demo-device",
      sessionId: "demo-session",
      superAdmin: false,
    },
    capabilities: { superAdmin: false, systemPermissions: [], groups: [] },
    devices: [],
  };
  const authView = {
    configured: true,
    originHost: "demo.invalid",
    hasCA: true,
    hasClientCertificate: true,
    state: "logged-in",
    username: "demo",
    displayName: "演示用户",
    accountId: "demo-account",
    deviceId: "demo-device",
    sessionId: "demo-session",
    refreshExpiresAt: null,
    accessExpiresInMs: 1_500_000,
    needsLogin: false,
    lastError: null,
    retryAfterMs: null,
    enrollment: { ready: true, enabled: true, configured: true, activated: true, deviceId: "demo-device", username: "demo", certificateExpiresAt: null, message: null },
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    try {
      if (pathname === "/api/session") return json(route, { token: "qa-token", trashAvailable: false, folderPickerAvailable: false, instanceId: "qa", app: "shiguang-local-media" });
      if (pathname === "/api/cloud-auth/status") return json(route, authView);
      if (pathname === "/api/cloud-management/profile") return json(route, profile);
      if (pathname === "/api/stats") return json(route, { total: 0, kinds: [], favorites: 0, review: 0, offline: 0, missing: 0, categories: [], formats: [] });
      if (pathname === "/api/roots" || pathname === "/api/roots/all") return json(route, []);
      if (pathname === "/api/jobs") return json(route, { jobs: [], metadata: { pending: 0 } });
      if (pathname === "/api/projects" || pathname === "/api/projects/usage-counts") return json(route, []);
      if (pathname === "/api/cloud-management/groups" || pathname === "/api/cloud-management/accounts" || pathname === "/api/cloud-management/roles" || pathname === "/api/cloud-management/candidates" || pathname === "/api/cloud-management/permissions" || pathname === "/api/cloud-management/audit-events") return json(route, []);
      if (pathname === "/api/cloud-audio/status") {
        return json(route, { enabled: true, configured: true, loggedIn: true, active: 0, queued: 0, maxActive: 2, maxPending: 12, interrupted: 0, receiverFaulted: false, staleTempFiles: 0 });
      }
      if (pathname === "/api/cloud-audio/roots" && method === "GET") return json(route, state.roots);
      if (pathname === "/api/cloud-audio/roots" && method === "POST") {
        state.rootPosts += 1;
        const body = request.postDataJSON();
        state.rootKinds.push(body?.kind);
        if (!body?.path?.startsWith("/")) return json(route, { error: "下载目录不合法", code: "INVALID_ROOT" }, 400);
        const root = { id: "root-demo-2", name: body.path.split("/").filter(Boolean).pop() || "下载根", kind: body.kind || "sfx" };
        state.roots = [root];
        return json(route, root);
      }
      if (pathname === "/api/cloud-audio/catalog") {
        state.catalogCalls += 1;
        const limit = Number(url.searchParams.get("limit") || 50);
        const offset = Number(url.searchParams.get("offset") || 0);
        return json(route, { items: offset === 0 ? items.slice(0, limit) : [], hasMore: false, limit, offset });
      }
      if (pathname.startsWith("/api/cloud-audio/audio/")) {
        state.detailCalls += 1;
        const audioId = pathname.split("/").pop();
        const item = items.find((entry) => entry.id === audioId);
        if (!item) return json(route, { error: "资源不存在", code: "NOT_FOUND" }, 404);
        return json(route, {
          audio: { id: item.id, sha256: item.sha256, bytes: item.bytes, contentType: item.contentType, createdAt: item.createdAt },
          shares: [
            { id: item.preferredShareId, ownerAccountId: "owner-demo", fileName: item.fileName, mediaKind: item.mediaKind, category: item.category, subcategory: item.subcategory, createdAt: "2026-10-24T00:00:00Z", version: 0 },
            { id: audioId.replace(/.$/, "3"), ownerAccountId: "owner-peer", fileName: `另一个来源-${item.fileName}`, mediaKind: item.mediaKind, category: item.category, subcategory: "室内", createdAt: "2026-10-23T00:00:00Z", version: 1 },
          ],
          hasMore: false,
          limit: 50,
          offset: 0,
        });
      }
      if (pathname === "/api/cloud-audio/jobs" && method === "GET") {
        state.jobCalls += 1;
        return json(route, progresses());
      }
      if (pathname === "/api/cloud-audio/jobs" && method === "POST") {
        const body = request.postDataJSON();
        const item = items.find((entry) => entry.id === body.audioId);
        if (!item) return json(route, { error: "资源不存在", code: "NOT_FOUND" }, 404);
        if (!state.roots.some((root) => root.id === body.rootId)) return json(route, { error: "下载目录不存在", code: "ROOT_NOT_FOUND" }, 404);
        state.jobSeq += 1;
        const attempts = (state.attempts.get(body.audioId) || 0) + 1;
        state.attempts.set(body.audioId, attempts);
        const share = body.shareId;
        const job = {
          id: crypto.randomUUID(),
          audioId: item.id,
          shareId: share,
          rootId: body.rootId,
          rootName: state.roots.find((root) => root.id === body.rootId)?.name || "",
          category: item.category,
          subcategory: item.subcategory,
          fileName: share === item.preferredShareId ? item.fileName : `另一个来源-${item.fileName}`,
          bytes: item.bytes,
          sha256: item.sha256,
          mimeType: item.contentType,
          state: "queued",
          errorCode: "",
          error: "",
          assetId: "",
          createdFile: true,
          cancelRequested: false,
          cleanupWarning: false,
          receivedBytes: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          startedAt: 0,
          completedAt: 0,
          failOnce: item.id === failId && attempts === 1,
        };
        state.jobs.unshift(job);
        return json(route, job);
      }
      const jobMatch = pathname.match(/^\/api\/cloud-audio\/jobs\/([^/]+)\/(cancel|retry)$/);
      if (jobMatch) {
        const job = state.jobs.find((entry) => entry.id === jobMatch[1]);
        if (!job) return json(route, { error: "下载任务不存在", code: "JOB_NOT_FOUND" }, 404);
        if (jobMatch[2] === "cancel") {
          job.state = "cancelled";
          job.cancelRequested = true;
          job.errorCode = "CANCELLED";
          job.error = "下载已取消";
          job.completedAt = Date.now();
          return json(route, { ...job });
        }
        state.jobSeq += 1;
        const next = { ...job, id: crypto.randomUUID(), state: "queued", errorCode: "", error: "", assetId: "", receivedBytes: 0, cancelRequested: false, createdAt: Date.now(), completedAt: 0, failOnce: false };
        state.jobs.unshift(next);
        return json(route, next);
      }
      return json(route, {});
    } catch (error) {
      return json(route, { error: String(error.message || error) }, 500);
    }
  });

  const results = [];
  const check = (name, condition, detail = "") => {
    results.push({ name, ok: !!condition, detail });
    log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!condition) throw new Error(`check failed: ${name} ${detail}`);
  };

  try {
    await waitForHttp(base);
    await page.goto(`${base}/#/account`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "云端音频" }).waitFor({ timeout: 15_000 });
    check("工作区加载并显示云端音频标签", true);

    await page.getByRole("button", { name: "云端音频" }).click();
    await page.getByText("环境音.wav").first().waitFor({ timeout: 10_000 });
    check("懒加载 catalog 只请求一次", state.catalogCalls === 1, `calls=${state.catalogCalls}`);
    check("进入列表不请求详情", state.detailCalls === 0, `detail=${state.detailCalls}`);
    await page.screenshot({ path: path.join(SHOTS, "01-catalog-1280x800.png") });

    await page.getByLabel("下载目录绝对路径").fill(ROOT_PATH);
    const kindOptions = await page.getByLabel("下载目录类型").locator("option").evaluateAll((options) => options.map((option) => option.value));
    check("下载目录类型可选音乐/音效/混合", ["mixed", "music", "sfx"].every((kind) => kindOptions.includes(kind)), kindOptions.join(","));
    await page.getByRole("button", { name: "添加目录" }).click();
    await page.getByText("已选择下载目录", { exact: false }).waitFor({ timeout: 5000 });
    check("显式本地路径登记下载根", state.rootPosts === 1);
    check("新根默认按混合目录登记", state.rootKinds[0] === "mixed", state.rootKinds[0]);
    check("根列表显示混合类型，音乐/音效可共用", (await page.locator(".cw-audio-root select").textContent()).includes("混合"));

    await page.getByRole("button", { name: "选择来源" }).first().click();
    await page.getByRole("dialog", { name: "选择云端来源" }).waitFor({ timeout: 5000 });
    await page.getByText("另一个来源-环境音.wav").waitFor();
    check("显式选择来源才读取详情", state.detailCalls === 1, `detail=${state.detailCalls}`);
    await page.screenshot({ path: path.join(SHOTS, "02-source-dialog-1280x800.png") });
    await page.getByText("另一个来源-环境音.wav").click();
    await page.getByRole("button", { name: "下载所选来源" }).click();
    await page.waitForTimeout(950);
    await page.screenshot({ path: path.join(SHOTS, "03-progress-1280x800.png") });
    await page.getByText("已加入素材库").first().waitFor({ timeout: 10_000 });
    const chosen = state.jobs[0];
    check("下载使用选择的来源", chosen.shareId === normalId.replace(/.$/, "3"), chosen.shareId);
    check("完成态显示可见入库结果", !!chosen.assetId, chosen.assetId);
    await page.screenshot({ path: path.join(SHOTS, "04-completed-1280x800.png") });

    // 取消：新任务还在下载时点击取消。
    await page.getByRole("button", { name: "下载", exact: true }).first().click();
    await page.waitForTimeout(180);
    const activeRow = page.locator(".cw-audio-job").first();
    await activeRow.getByRole("button", { name: /取消/ }).click();
    await activeRow.locator(".cw-audio-badge", { hasText: "已取消" }).waitFor({ timeout: 5000 });
    check("显式取消显示取消终态", state.jobs[0].state === "cancelled");

    // 失败 + 重试：第二个音频第一次失败，重试成功。
    const failRow = page.locator(".cw-audio-row", { hasText: "损坏示例.wav" });
    await failRow.getByRole("button", { name: "下载", exact: true }).click();
    const failedJobRow = page.locator(".cw-audio-job").first();
    await failedJobRow.locator(".cw-audio-badge", { hasText: "失败" }).waitFor({ timeout: 5000 });
    check("失败态显示固定错误文案", (await failedJobRow.textContent()).includes("音频内容校验失败"));
    await failedJobRow.getByRole("button", { name: "重试" }).click();
    await page.locator(".cw-audio-job").first().getByText("已加入素材库", { exact: false }).waitFor({ timeout: 10_000 });
    check("重试创建新任务并成功", state.jobs[0].state === "completed" && !state.jobs[0].failOnce);

    // 切走页面（卸载下载组件）让任务在后台完成；切回后仍能看到完成态。
    await page.getByRole("button", { name: "下载", exact: true }).first().click();
    const closingJob = state.jobs[0].id;
    await page.getByRole("button", { name: "个人安全" }).click();
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: "云端音频" }).click();
    await page.locator(".cw-audio-job").first().getByText("已加入素材库", { exact: false }).waitFor({ timeout: 10_000 });
    const completedAfterClose = state.jobs.find((job) => job.id === closingJob);
    check("卸载下载界面不会取消任务，返回后显示完成", completedAfterClose?.state === "completed", completedAfterClose?.state);
    await page.screenshot({ path: path.join(SHOTS, "05-after-close-1280x800.png") });

    check("无浏览器 console error", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
    log(`RESULT ${results.filter((item) => item.ok).length}/${results.length} pass`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await stopVite();
    await fs.writeFile(LOG, logLines.join("\n") + "\n");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
