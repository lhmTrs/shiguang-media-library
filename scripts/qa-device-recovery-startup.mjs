// Real production build and HTTP routes, with disposable data and no cloud calls.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";

const project = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(project, "collab/results/DEVICE-RECOVERY-UI-20261024");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "sg-recovery-startup-"));
const deviceId = "11111111-2222-4333-8444-555555555555";
let browser;
try {
  await fs.mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: "chrome", headless: true });
  for (const registered of [false, true]) {
    const data = path.join(temp, registered ? "registered" : "fresh");
    await fs.mkdir(data, { recursive: true });
    if (registered) {
      await fs.mkdir(path.join(data, "cloud-device"));
      await fs.writeFile(path.join(data, "cloud-device/device.json"), JSON.stringify({ deviceId, activated: false, needsActivation: true }));
    }
    const child = spawn(process.execPath, ["server/index.mjs"], {
      cwd: project,
      env: { ...process.env, NODE_ENV: "production", MEDIA_DATA_DIR: data, MEDIA_SKIP_IMPORT: "1", MEDIA_NO_WATCH: "1", MEDIA_CLOUD_AUDIO_ENABLED: "0", SHIGUANG_AUDIO_ANALYSIS: "0", SHIGUANG_CLOUD_RELEASE_CONFIG: path.join(temp, "absent-release.json"), PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let exited = false, launchError = null, log = "";
    const stopped = new Promise(resolve => {
      child.once("exit", () => { exited = true; resolve(); });
      child.once("error", error => { launchError = error; exited = true; resolve(); });
    });
    for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { log = (log + chunk).slice(-16384); });
    try {
      let url;
      for (let i = 0; i < 300; i++) {
        if (launchError || exited) throw Error("Disposable server exited before readiness");
        url = log.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(url, "disposable server readiness timeout");
      const sessionResponse = await fetch(url + "/api/session", { signal: AbortSignal.timeout(3000) });
      const session = await sessionResponse.json();
      const cookie = sessionResponse.headers.get("set-cookie").split(";")[0];
      const statusResponse = await fetch(url + "/api/cloud-auth/status", { headers: { cookie }, signal: AbortSignal.timeout(3000) });
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      assert.equal(status.enrollment.recoverySupported, true);
      assert.equal(status.enrollment.deviceId, registered ? deviceId : null);
      const logoutResponse = await fetch(url + "/api/cloud-auth/logout", {
        method: "POST", headers: { cookie, origin: url, "content-type": "application/json", "x-local-token": session.token }, body: "{}", signal: AbortSignal.timeout(3000),
      });
      assert.equal(logoutResponse.status, 200);
      const logout = await logoutResponse.json();
      assert.equal(logout.state.enrollment.recoverySupported, true);
      assert.equal(logout.state.enrollment.deviceId, registered ? deviceId : null);
      for (const width of [1440, 375]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 } });
        try {
          await context.route("**/*", route => new URL(route.request().url()).origin === url ? route.continue() : route.abort());
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          await page.goto(url + "/#/login");
          const entry = page.locator("summary").filter({ hasText: "设备与开通恢复" });
          await expect(entry).toBeVisible();
          await entry.click();
          if (registered) {
            await expect(page.locator(".login-recovery code")).toHaveText(deviceId);
            await expect(page.getByRole("button", { name: "重新开通本机", exact: true })).toBeDisabled();
          } else {
            await expect(page.getByText(/未读取到本机已登记的设备 ID/)).toBeVisible();
            await expect(page.getByRole("button", { name: "重新开通本机", exact: true })).toHaveCount(0);
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
          assert.deepEqual(errors, []);
          await page.screenshot({ path: path.join(output, `startup-${registered ? "registered" : "fresh"}-${width}.png`), fullPage: true });
        } finally { await context.close(); }
      }
    } finally {
      if (!exited) child.kill("SIGTERM");
      let timer;
      try {
        await Promise.race([stopped, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Disposable server stop timeout")), 10000); })]);
      } finally {
        clearTimeout(timer);
        if (!exited) { child.kill("SIGKILL"); await stopped; }
      }
    }
  }
  console.log("PASS DEVICE_RECOVERY_REAL_STARTUP_HTTP_AND_BUILD");
} finally {
  await browser?.close();
  await fs.rm(temp, { recursive: true, force: true });
}
