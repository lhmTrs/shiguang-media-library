import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { chromium, webkit, expect } from "@playwright/test";
import { Library } from "../server/library.mjs";

const exec = promisify(execFile), project = process.cwd();
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sg-directory-qa-")));
const data = path.join(base, "data"), out = path.join(project, ".runtime", "qa-directory");
await fs.mkdir(out, { recursive: true });
const fixture = path.join(base, "fixture.wav");
await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.6", fixture]);
const lib = await new Library(data, { directoryClassification: true }).init(); lib.enqueue = () => {};
const roots = [];
for (const name of ["音乐库", "音效库"]) {
  const source = path.join(base, name);
  await fs.mkdir(path.join(source, "B", "C", "D"), { recursive: true });
  await fs.mkdir(path.join(source, "待确认"));
  await fs.mkdir(path.join(source, "空类", "空子类"), { recursive: true });
  const files = ["loose.wav", "B/one.wav", "B/C/two.wav", "B/C/D/deep.wav", "待确认/inbox.wav"];
  if (name === "音乐库") { await fs.mkdir(path.join(source, "独有")); files.push("独有/only.wav"); }
  for (const filename of files) await fs.copyFile(fixture, path.join(source, filename));
  const root = await lib.addRoot(source, name === "音乐库" ? "music" : "sfx"); roots.push(root);
  const job = lib.scan(root.id); while (job.status === "running") await new Promise(r => setTimeout(r, 10));
  assert.equal(job.status, "done");
}
lib.db.exec("UPDATE assets SET probe='ready',capture_status='ready',duration=0.6");
lib.db.close();
const server = spawn(process.execPath, ["server/index.mjs"], { cwd: project, env: { ...process.env, NODE_ENV: "production", MEDIA_DATA_DIR: data, MEDIA_SKIP_IMPORT: "1", MEDIA_NO_WATCH: "1", PORT: "4591" }, stdio: ["ignore", "pipe", "pipe"] });
const exited = new Promise(resolve => server.once("exit", resolve)); let logs = "", url;
server.stdout.on("data", b => logs += b); server.stderr.on("data", b => logs += b);
const results = [];
try {
  for (let i = 0; i < 300; i++) { await new Promise(r => setTimeout(r, 100)); url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) break; if (server.exitCode !== null) throw Error(logs); }
  if (!url) throw Error("独立验收服务启动超时");
  const sessionResponse = await fetch(url + "/api/session"), session = await sessionResponse.json();
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";")[0];
  async function request(endpoint, body, method) {
    const r = await fetch(url + "/api" + endpoint, { method: method || (body ? "POST" : "GET"), headers: { cookie, ...(body ? { "Content-Type": "application/json", "X-Local-Token": session.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const value = await r.json(); if (!r.ok) throw Error(value.error); return value;
  }
  for (const [type, name, options] of [[chromium, "chrome", { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }], ...(process.argv.includes("--webkit") ? [[webkit, "webkit", {}]] : [])]) {
    const browser = await type.launch({ headless: true, ...options });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(() => { localStorage.setItem("shiguang.categoryView", "legacy"); localStorage.setItem("shiguang.refreshSeconds", "0"); });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.goto(url);
      await expect(page.locator(".asset-row")).toHaveCount(11);
      const picker = page.getByRole("combobox", { name: "筛选分类", exact: true });
      await picker.fill("B");
      const choose = text => page.locator(".category-filter-menu button").filter({ has: page.locator("span", { hasText: new RegExp("^" + text + "$") }) }).click();
      await expect(page.locator(".category-filter-menu").getByText("音乐库_B", { exact: true })).toBeVisible();
      await expect(page.locator(".category-filter-menu").getByText("音效库_B", { exact: true })).toBeVisible();
      await choose("音乐库_B"); await expect(page.locator(".asset-row")).toHaveCount(3);
      await expect(page.locator(".library-heading")).not.toContainText(roots[0].id);
      await picker.fill("独有"); await choose("独有"); await expect(page.locator(".asset-row")).toHaveCount(1);
      await picker.fill(""); await choose("全部分类"); await expect(page.locator(".asset-row")).toHaveCount(11);
      const raw = await request("/categories"); assert.ok(raw.some(c => c.category === "B" && c.rootId === roots[0].id)); assert.equal(raw.some(c => c.category.includes("音乐库_")), false);
      await page.locator(".sidebar").getByRole("button", { name: /^待确认/ }).click();
      await expect(page.locator(".asset-row")).toHaveCount(4);
      const row = page.locator(".asset-row").filter({ has: page.getByRole("button", { name: "loose.wav", exact: true }) }).filter({ hasText: "音乐" });
      await row.getByRole("button", { name: "loose.wav", exact: true }).click();
      const editor = page.getByRole("dialog", { name: "编辑素材详情", exact: true });
      await expect(editor.getByRole("checkbox", { name: "人工确认" })).toHaveCount(0);
      await expect(editor.getByRole("combobox", { name: "编辑主分类" })).toHaveCount(0);
      await editor.getByLabel("素材备注", { exact: true }).fill("保留备注 " + name);
      await editor.getByLabel("新增素材标签", { exact: true }).fill("保留标签"); await editor.getByLabel("新增素材标签", { exact: true }).press("Enter");
      await editor.getByRole("button", { name: "保存标签与属性", exact: true }).click();
      await expect(editor.getByText("标签与属性已保存", { exact: true })).toBeVisible();
      await editor.getByRole("button", { name: "关闭编辑", exact: true }).click();
      await row.getByRole("button", { name: "更多素材操作：loose.wav", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "修改分类：loose.wav", exact: true })).toHaveCount(0);
      await page.getByRole("menuitem", { name: "移动素材：loose.wav", exact: true }).click();
      const destination = page.getByLabel("选择移动目标文件夹", { exact: true });
      await destination.getByLabel("已登记素材目录").getByRole("button", { name: "音乐库", exact: true }).click();
      for (const folder of ["B", "C", "D"]) await destination.getByLabel("目标子文件夹", { exact: true }).getByRole("button", { name: folder, exact: true }).click();
      await page.getByRole("button", { name: "检查目标路径", exact: true }).click();
      await page.getByRole("button", { name: "确认移动", exact: true }).click();
      await expect(page.locator(".asset-row")).toHaveCount(3);
      const moved = (await request("/assets?root=" + roots[0].id)).items.find(a => a.name === "loose.wav");
      assert.equal(moved.category, "B"); assert.equal(moved.sub, "C"); assert.equal(moved.review, 0); assert.deepEqual(moved.tags, ["保留标签"]);
      const op = (await request("/operations")).find(o => o.asset_id === moved.id && o.action === "move" && !o.undone);
      await request(`/operations/${op.id}/undo`, {});
      await page.getByRole("button", { name: "刷新索引显示", exact: true }).click(); await expect(page.locator(".asset-row")).toHaveCount(4);
      const blocked = await fetch(url + "/api/categories", { method: "POST", headers: { cookie, "Content-Type": "application/json", "X-Local-Token": session.token }, body: JSON.stringify({ name: "伪分类" }) }); assert.equal(blocked.status, 410);
      await page.locator(".sidebar").getByRole("button", { name: /^分类管理/ }).click();
      await expect(page.getByRole("button", { name: "旧分类视图", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "新建分类文件夹", exact: true }).click();
      await page.getByRole("textbox", { name: "新分类文件夹名称", exact: true }).fill("新分类" + name);
      await page.getByRole("button", { name: "创建分类文件夹", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "新分类文件夹名称", exact: true })).toHaveCount(0);
      await fs.access(path.join(roots[0].path, "新分类" + name));
      const expand = page.getByRole("button", { name: /^(展开|收起)目录：音乐库$/ });
      if (await expand.getAttribute("aria-expanded") === "false") await expand.click();
      await page.getByRole("button", { name: "选择文件夹：音乐库_B", exact: true }).click();
      await expect(page.locator(".folder-asset")).toHaveCount(3);
      await page.locator(".folder-children button").filter({ hasText: "B / C" }).click();
      await expect(page.locator(".folder-asset")).toHaveCount(2);
      await expect(page.locator(".folder-children button")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "新建分类文件夹", exact: true })).toBeDisabled();
      const widths = [1440, 1280, 1024, 390, 320];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 844 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator(".app")).toHaveCount(1);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
        await page.screenshot({ path: path.join(out, `${name}-classification-${width}.png`), fullPage: false, animations: "disabled" });
      }
      assert.deepEqual(errors, []);
      await context.close(); results.push({ browser: name, passed: true, checks: ["跨根重名只前端加前缀", "唯一分类保持原名", "搜索与筛选根隔离", "待确认位置派生", "标签备注编辑", "通过移动离开待确认", "撤销恢复待确认", "第三层归入第二级", "旧视图偏好失效", "拒绝旧分类写接口", "1440/1280/1024/390/320响应式"] });
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify(results, null, 2));
} finally {
  if (server.exitCode === null) { server.kill("SIGTERM"); await exited; }
  await fs.rm(base, { recursive: true, force: true });
}
