import { chromium, webkit } from "playwright";
import { expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Library, run } from "../server/library.mjs";
import { AssetCategories } from "../server/music-categories.mjs";
import { DuplicateAudio } from "../server/duplicate-audio.mjs";

const project = process.cwd();
const out = path.join(project, ".runtime", "qa");
await fs.mkdir(out, { recursive: true });
const base = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-browser-")),
);
const source = path.join(base, "音效 测试"),
  photos = path.join(base, "摄影素材"),
  destination = path.join(base, "归档");
await fs.mkdir(source);
await fs.mkdir(photos);
await fs.mkdir(destination);
await fs.mkdir(path.join(source, "转场", "呼啸", "快速"), { recursive: true });
await run("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:duration=3",
  path.join(source, "风声 测试.wav"),
]);
await run("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=880:duration=2",
  "-c:a",
  "libmp3lame",
  path.join(source, "第二段 音效.mp3"),
]);
await run("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=640x360:duration=2",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv420p",
  path.join(photos, "摄影片段.mp4"),
]);
await run("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=640x420",
  "-frames:v",
  "1",
  path.join(photos, "测试照片.jpg"),
]);
await run("exiftool", [
  "-overwrite_original",
  "-DateTimeOriginal=2026:10:12 10:20:30",
  "-OffsetTimeOriginal=+08:00",
  path.join(photos, "测试照片.jpg"),
]);
await run("sips", [
  "-s",
  "format",
  "heic",
  path.join(photos, "测试照片.jpg"),
  "--out",
  path.join(photos, "测试照片.heic"),
]);
const data = path.join(base, "data");
const shortAudioBuffers = [];
for (const duration of [0.08, 0.3, 0.8]) {
  const file = path.join(base, `short-${duration}.wav`);
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, file]);
  shortAudioBuffers.push(await fs.readFile(file));
}
const library = await new Library(data).init();
library.enqueue = () => {};
const soundRoot = await library.addRoot(source, "sfx");
const photoRoot = await library.addRoot(photos, "mixed");
const destRoot = await library.addRoot(destination, "mixed");
for (const r of [soundRoot, photoRoot]) {
  const j = library.scan(
    r.id,
    new Map([
      [
        path.join(source, "风声 测试.wav"),
        {
          category: "07_环境自然与动物",
          sub: "风声",
          review: true,
          basis: "测试分类",
        },
      ],
    ]),
  );
  while (j.status === "running") await new Promise((r) => setTimeout(r, 20));
  assert.equal(j.status, "done");
}
new AssetCategories(library).init();
new DuplicateAudio(library);
if (process.env.MYSQL_QA_CONFIG) {
  const { MysqlStorage } = await import("../server/mysql.mjs");
  const storage = await new MysqlStorage(data).init();
  storage.attach(library);
  await storage.activate(JSON.parse(process.env.MYSQL_QA_CONFIG));
  assert.equal(storage.publicState().mode, "mysql");
}
library.db.prepare("UPDATE assets SET reveal_count=3 WHERE name=?").run("第二段 音效.mp3");
library.db.close();
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: project,
  env: {
    ...process.env,
    NODE_ENV: "production",
    MEDIA_DATA_DIR: data,
    MEDIA_SKIP_IMPORT: "1",
    PORT: "4587",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (b) => (logs += b));
server.stderr.on("data", (b) => (logs += b));
let url;
for (let n = 0; n < 100; n++) {
  await new Promise((r) => setTimeout(r, 300));
  const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
  if (match) {
    url = match[0];
    break;
  }
  if (server.exitCode !== null) throw Error(logs);
}
if (!url) throw Error("QA server timeout: " + logs);
const results = [];
async function verify(browserType, name, options) {
  const browser = await browserType.launch({ headless: true, ...options });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(url);
    await page
      .getByRole("heading", { name: "全部素材", exact: true })
      .waitFor();
    await page.locator(".asset-row").first().waitFor();
    assert.equal(await page.locator(".asset-row").count(), 5);
    // Slow or failed category statistics must not keep the material list blocked.
    {
      const isolated = await browser.newContext();
      await isolated.addInitScript(() => localStorage.setItem("shiguang.refreshSeconds", "0"));
      const quick = await isolated.newPage();
      let release = () => {}, requested = false;
      const gate = new Promise(resolve => { release = resolve; });
      await quick.route("**/api/categories", async route => {
        requested = true;
        await gate;
        await route.fulfill({ status: 503, json: { error: "测试分类统计不可用" } });
      });
      await quick.goto(url);
      await expect(quick.locator(".asset-row")).toHaveCount(5);
      await expect.poll(() => requested).toBe(true);
      await expect(quick.locator(".table-mask,.work-overlay")).toHaveCount(0);
      await quick.getByRole("textbox", { name: "搜索素材", exact: true }).fill("风声");
      await expect(quick.locator(".asset-row")).toHaveCount(1);
      await expect(quick.locator(".table-mask,.work-overlay")).toHaveCount(0);
      release();
      await expect(quick.getByText("分类列表暂未更新，已保留现有分类；可点击刷新重试", { exact: true })).toBeVisible();
      await expect(quick.locator(".asset-row")).toHaveCount(1);
      await isolated.close();
    }
    // Use an isolated browser clock and localStorage so polling tests do not affect audio timing below.
    {
      const pollingContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const polling = await pollingContext.newPage();
      polling.on("dialog", dialog => dialog.accept());
      polling.on("pageerror", e => errors.push(e.message));
      let rootRequests = 0, revision = 0, assetRequests = 0;
      let holdAssets = false, releaseAssets = () => {};
      let assetsGate = Promise.resolve();
      await polling.route("**/api/maintenance/files", route => route.fulfill({ json: { deferred: true } }));
      await polling.route("**/api/roots", async route => {
        rootRequests++;
        const response = await route.fetch();
        const rows = await response.json();
        await route.fulfill({ json: rows.map(row => ({ ...row, revision: Number(row.revision || 0) + revision })) });
      });
      // 列表请求有两类：普通模式 /api/assets?…、系列分组模式 /api/asset-series?…
      // 只拦前者会让"自动刷新"用例在系列模式下永远数到 0（本轮 T-LOCAL-001 的根因）。
      await polling.route(/\/api\/(?:assets|asset-series)\?/, async route => {
        assetRequests++;
        if (holdAssets) await assetsGate;
        await route.continue();
      });
      await polling.clock.install();
      await polling.goto(url);
      await expect(polling.locator(".asset-row")).toHaveCount(5);
      await expect(polling.locator(".table-mask")).toHaveCount(0);
      await polling.clock.pauseAt(new Date(Date.now() + 1000));
      const settings = polling.getByRole("dialog", { name: "界面设置", exact: true });
      const interval = settings.getByLabel("自动刷新间隔", { exact: true });
      await polling.getByRole("button", { name: "界面设置", exact: true }).click();
      await expect(interval).toHaveValue("30");
      await interval.selectOption("15");
      await polling.screenshot({ path: path.join(out, `${name}-refresh-settings.png`) });
      await settings.getByRole("button", { name: "完成", exact: true }).click();
      const checkbox = polling.locator(".asset-row").first().locator('input[type="checkbox"]');
      await checkbox.check();
      const rootsBefore = rootRequests, assetsBefore = assetRequests;
      await polling.clock.runFor(14000);
      assert.equal(rootRequests, rootsBefore, "15 秒前不能触发自动刷新");
      holdAssets = true; assetsGate = new Promise(resolve => { releaseAssets = resolve; });
      revision++;
      await polling.clock.runFor(1000);
      await expect.poll(() => assetRequests).toBeGreaterThan(assetsBefore);
      await expect(polling.locator(".table-mask")).toHaveCount(0);
      await expect(polling.locator(".inline-loading")).toHaveCount(0);
      await expect(checkbox).toBeEnabled();
      await expect(checkbox).toBeChecked();
      const inFlightRoots = rootRequests;
      await polling.clock.runFor(30000);
      assert.equal(rootRequests, inFlightRoots, "慢请求未结束时不能叠加轮询");
      holdAssets = false; releaseAssets();
      await expect(polling.locator(".asset-row")).toHaveCount(5);
      await expect(checkbox).toBeChecked();
      await polling.locator(".asset-row").first().locator(".asset-name-button").click();
      const editor = polling.getByRole("dialog", { name: "编辑素材详情", exact: true });
      await editor.getByLabel("素材备注", { exact: true }).fill("未保存的草稿不能被后台刷新覆盖");
      const duringEdit = rootRequests;
      revision++;
      await polling.clock.runFor(30000);
      assert.equal(rootRequests, duringEdit, "编辑中暂缓轮询");
      await expect(editor.getByLabel("素材备注", { exact: true })).toHaveValue("未保存的草稿不能被后台刷新覆盖");
      await editor.getByRole("button", { name: "关闭编辑", exact: true }).click();
      await polling.getByRole("button", { name: "界面设置", exact: true }).click();
      await interval.selectOption("0");
      await settings.getByRole("button", { name: "完成", exact: true }).click();
      const disabledRoots = rootRequests;
      await polling.clock.runFor(300000);
      assert.equal(rootRequests, disabledRoots, "关闭后不再自动刷新");
      await polling.reload();
      await expect(polling.locator(".asset-row")).toHaveCount(5);
      await polling.getByRole("button", { name: "界面设置", exact: true }).click();
      await expect(interval).toHaveValue("0");
      for (const width of [1280, 390, 320]) {
        await polling.setViewportSize({ width, height: 844 });
        assert(await settings.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `Refresh settings overflow at ${width}`);
      }
      await pollingContext.close();
    }
    const navigation = page.getByRole("navigation", { name: "主导航" });
    await page.getByRole("button", { name: "折叠侧栏", exact: true }).click();
    await expect(page.locator(".app")).toHaveClass(/nav-collapsed/);
    assert.equal(await page.locator(".sidebar").evaluate(el => el.getBoundingClientRect().width), 64);
    await page.getByRole("button", { name: "界面设置", exact: true }).click();
    const navSettings = page.getByRole("dialog", { name: "界面设置" });
    // 界面风格：切换即时写 <html data-theme>，并确实改变渲染出来的底色与强调色
    // 注意底色挂在 :root（= <html>）上，body 自身是透明的，断言不能看 body。
    const readPaint = () => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return { bg: root.backgroundColor, accent: root.getPropertyValue("--green").trim(), scheme: root.colorScheme };
    });
    const defaultPaint = await readPaint();
    await navSettings.getByRole("radio", { name: /深色/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const darkPaint = await readPaint();
    assert.notEqual(darkPaint.bg, defaultPaint.bg, "深色风格应改变页面底色");
    assert.notEqual(darkPaint.accent, defaultPaint.accent, "深色风格应改变强调色");
    assert.equal(darkPaint.scheme, "dark", "深色风格应声明 color-scheme: dark");
    await navSettings.getByRole("radio", { name: /森林绿/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
    assert.equal((await readPaint()).bg, defaultPaint.bg, "切回默认风格应还原底色");
    await navSettings.getByRole("checkbox", { name: "离线素材", exact: true }).uncheck();
    await navSettings.getByRole("checkbox", { name: "素材目录", exact: true }).uncheck();
    await expect(navSettings.getByRole("checkbox", { name: /全部素材/ })).toBeDisabled();
    await navSettings.getByRole("button", { name: "完成", exact: true }).click();
    await expect(navigation.getByRole("button", { name: "离线素材", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".app")).toHaveClass(/nav-collapsed/);
    await expect(navigation.getByRole("button", { name: "离线素材", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
    await expect(page.locator(".root-nav")).toHaveCount(0);
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 768]]) {
      await page.setViewportSize({ width, height });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Navigation layout overflows at ${width}`);
      const settingsBox = await page.getByRole("button", { name: "设置与缓存", exact: true }).boundingBox();
      assert(settingsBox && settingsBox.y + settingsBox.height <= height, "Sidebar settings must remain reachable");
      await page.screenshot({ path: path.join(out, `${name}-navigation-${width}.png`) });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "展开导航", exact: true }).click();
    await expect(navigation).toBeVisible();
    await page.getByRole("button", { name: "界面设置", exact: true }).click();
    await navSettings.getByRole("button", { name: "恢复全部", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(navSettings).toHaveCount(0);
    await page.getByRole("button", { name: "展开导航", exact: true }).click();
    await navigation.getByRole("button", { name: "全部素材", exact: true }).click();
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const moreFilters = page.getByRole("button", { name: "更多筛选", exact: true });
    const showFilters = async () => { if (await moreFilters.getAttribute("aria-expanded") !== "true") await moreFilters.click(); };
    await expect(page.getByRole("region", { name: "更多素材筛选", exact: true })).not.toBeVisible();
    await navigation.getByRole("button", { name: "音效", exact: true }).click();
    await showFilters();
    await page.getByLabel("筛选时长", { exact: true }).selectOption("short");
    await moreFilters.click();
    await expect(page.getByRole("button", { name: "取消时长筛选", exact: true })).toBeVisible();
    await navigation.getByRole("button", { name: "音乐", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消时长筛选", exact: true })).toHaveCount(0);
    await showFilters();
    await page.getByLabel("筛选格式", { exact: true }).selectOption("mp3");
    await navigation.getByRole("button", { name: "音效", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消时长筛选", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "取消格式筛选", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "取消时长筛选", exact: true }).click();
    await navigation.getByRole("button", { name: "全部素材", exact: true }).click();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    for (const width of [1440, 1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Compact toolbar overflows at ${width}`);
      await showFilters();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Expanded filters overflow at ${width}`);
      await page.screenshot({ path: path.join(out, `${name}-search-expanded-${width}.png`) });
      await moreFilters.click();
      await page.screenshot({ path: path.join(out, `${name}-search-compact-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const phaseToken = (await (await context.request.get(url + "/api/session")).json()).token;
    const folderActionAsset = (await (await context.request.get(url + "/api/assets?sort=revealCount")).json()).items[0];
    const folderActionRow = page.locator(".asset-row").filter({ hasText: folderActionAsset.name });
    await folderActionRow.getByRole("button", { name: "更多素材操作：" + folderActionAsset.name, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^修改分类：/ })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /^添加素材分类：/ })).toHaveCount(0);
    await page.screenshot({ path: path.join(out, name + "-folder-mode-actions.png") });
    await page.getByRole("menuitem", { name: "移动素材：" + folderActionAsset.name, exact: true }).click();
    const moveDialog = page.getByRole("dialog", { name: "移动素材", exact: true });
    await expect(moveDialog).toBeVisible();
    await moveDialog.getByRole("complementary", { name: "已登记素材目录", exact: true }).getByRole("button", { name: "音效 测试", exact: true }).click();
    await moveDialog.getByRole("button", { name: "转场", exact: true }).click();
    await expect(moveDialog.getByRole("button", { name: "检查目标路径", exact: true })).toBeEnabled();
    await moveDialog.getByRole("navigation", { name: "目标文件夹路径", exact: true }).getByRole("button", { name: "转场", exact: true }).click();
    await expect(moveDialog.getByRole("button", { name: "检查目标路径", exact: true })).toBeEnabled();
    await moveDialog.getByRole("textbox", { name: "搜索当前文件夹", exact: true }).fill("不存在");
    await expect(moveDialog.locator(".destination-folders")).toContainText("没有匹配");
    await moveDialog.getByRole("textbox", { name: "搜索当前文件夹", exact: true }).fill("");
    await page.screenshot({ path: path.join(out, `${name}-move-picker-browse.png`) });
    await moveDialog.getByRole("button", { name: "呼啸", exact: true }).click();
    await moveDialog.getByRole("button", { name: "上一级", exact: true }).click();
    await moveDialog.getByRole("button", { name: "后退", exact: true }).click();
    await expect(moveDialog.locator(".destination-selected")).toContainText("转场/呼啸");
    await moveDialog.getByRole("button", { name: "前进", exact: true }).click();
    await expect(moveDialog.locator(".destination-selected")).toContainText("/转场");
    await moveDialog.getByRole("button", { name: "新建文件夹", exact: true }).click();
    await moveDialog.getByRole("textbox", { name: "新文件夹名称", exact: true }).fill("呼啸");
    await moveDialog.getByRole("button", { name: "创建文件夹", exact: true }).click();
    await expect(moveDialog.getByRole("alert")).toContainText("同名");
    await moveDialog.getByRole("textbox", { name: "新文件夹名称", exact: true }).fill("测试归档");
    await moveDialog.getByRole("button", { name: "创建文件夹", exact: true }).click();
    await expect(moveDialog.locator(".destination-selected")).toContainText("转场/测试归档");
    await expect(moveDialog.getByRole("button", { name: "检查目标路径", exact: true })).toBeEnabled();
    for (const width of [1440, 1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await moveDialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `Move dialog overflows at ${width}`);
      await page.screenshot({ path: path.join(out, `${name}-move-picker-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await moveDialog.getByRole("button", { name: "检查目标路径", exact: true }).click();
    await expect(moveDialog.locator(".plans")).toContainText("测试归档");
    await moveDialog.getByRole("button", { name: "确认移动", exact: true }).click();
    await expect(moveDialog).toHaveCount(0);
    const movedFixture = await (await context.request.get(url + "/api/assets/" + folderActionAsset.id)).json();
    assert.equal(movedFixture.path, path.join(source, "转场/测试归档", folderActionAsset.name));
    assert.deepEqual(movedFixture.tags, folderActionAsset.tags);
    const originalRoot = (await (await context.request.get(url + "/api/roots")).json()).find(r => r.id === folderActionAsset.root_id);
    const restorePreview = await (await context.request.post(url + "/api/operations/preview", { headers: { "X-Local-Token": phaseToken }, data: {
      ids: [folderActionAsset.id], action: "move", rootId: originalRoot.id, relative: path.relative(originalRoot.path, path.dirname(folderActionAsset.path)),
    } })).json();
    assert(restorePreview.items.every(item => item.ok));
    const restoreResult = await context.request.post(url + "/api/operations", { headers: { "X-Local-Token": phaseToken }, data: { confirmation: restorePreview.confirmation } });
    assert(restoreResult.ok());
    assert((await restoreResult.json()).every(item => item.ok));
    await fs.rmdir(path.join(source, "转场/测试归档"));
    await page.reload();
    await expect(folderActionRow).toBeVisible();
    await folderActionRow.locator(".asset-name-button").click();
    const folderEditor = page.getByRole("dialog", { name: "编辑素材详情", exact: true });
    await expect(folderEditor.getByLabel("编辑主分类", { exact: true })).toHaveCount(0);
    await expect(folderEditor.getByLabel("选择额外分类", { exact: true })).toHaveCount(0);
    const folderSave = page.waitForRequest(r => r.method() === "PATCH" && r.url().endsWith("/api/assets/" + folderActionAsset.id));
    await folderEditor.getByRole("button", { name: "保存标签与属性", exact: true }).click();
    const folderPatch = (await folderSave).postDataJSON();
    assert.equal(Object.hasOwn(folderPatch, "category"), false);
    assert.equal(Object.hasOwn(folderPatch, "sub"), false);
    await expect(folderEditor).toContainText("标签与属性已保存");
    await folderEditor.getByRole("button", { name: "关闭", exact: true }).click();
    const preserved = await (await context.request.get(url + "/api/assets/" + folderActionAsset.id)).json();
    assert.equal(preserved.category, folderActionAsset.category); assert.equal(preserved.sub, folderActionAsset.sub);
    await expect(page.getByRole("button", { name: "给选中素材添加分类", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "显示设置", exact: true }).click();
    await page.getByLabel("显示完整操作", { exact: true }).check(); await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: "显示设置", exact: true })).toHaveCount(0);
    await expect(folderActionRow.getByRole("button", { name: "移动素材：" + folderActionAsset.name, exact: true })).toBeVisible();
    await expect(folderActionRow.getByRole("button", { name: /^修改分类：|^添加素材分类：/ })).toHaveCount(0);
    await page.getByRole("button", { name: "显示设置", exact: true }).click();
    await page.getByLabel("显示完整操作", { exact: true }).uncheck(); await page.keyboard.press("Escape");
    await expect(page.getByRole("group", { name: "显示设置", exact: true })).toHaveCount(0);
    await navigation.getByRole("button", { name: "分类管理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分类管理", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择文件夹：音效 测试", exact: true }).click();
    await expect(page.locator(".folder-asset")).toHaveCount(2);
    await page.getByRole("region", { name: "真实文件夹浏览", exact: true }).getByRole("button", { name: /^转场/ }).click();
    await page.getByRole("region", { name: "真实文件夹浏览", exact: true }).getByRole("button", { name: /^呼啸/ }).click();
    await page.getByRole("region", { name: "真实文件夹浏览", exact: true }).getByRole("button", { name: /^快速/ }).click();
    await expect(page.getByRole("navigation", { name: "文件夹路径", exact: true })).toContainText("快速");
    await expect(page.locator(".folder-asset")).toHaveCount(0);
    await page.getByRole("navigation", { name: "文件夹路径", exact: true }).getByRole("button", { name: "音效 测试", exact: true }).click();
    await expect(page.locator(".folder-asset")).toHaveCount(2);
    await page.getByRole("checkbox", { name: "包含子文件夹", exact: true }).uncheck();
    await expect(page.locator(".folder-asset")).toHaveCount(2);
    await page.getByRole("textbox", { name: "搜索文件夹素材", exact: true }).fill("第二段");
    await expect(page.locator(".folder-asset")).toHaveCount(1);
    await page.getByRole("button", { name: "清空筛选", exact: true }).click();
    await expect(page.locator(".folder-asset")).toHaveCount(2);
    for (const width of [1440, 1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Folder browser overflow at " + width);
      await page.screenshot({ path: path.join(out, `${name}-folder-browser-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "选择文件夹：摄影素材", exact: true }).click();
    await page.getByRole("button", { name: "预览素材：测试照片.jpg", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "文件夹素材预览", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "旧分类视图", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分类管理", exact: true })).toBeVisible();
    await page.reload();
    await navigation.getByRole("button", { name: "分类管理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "分类管理", exact: true })).toBeVisible();
    await navigation.getByRole("button", { name: "全部素材", exact: true }).click();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    const phaseHeaders = { "X-Local-Token": phaseToken };
    const phaseFiles = (await (await context.request.get(url + "/api/assets?kind=sfx&sort=revealCount")).json()).items;
    const phaseFirst = phaseFiles[0], phaseSecond = phaseFiles[1];
    await page.locator(".asset-row").filter({ hasText: phaseFirst.name }).getByTitle("试听", { exact: true }).click();
    await expect(page.locator(".player-title strong")).toHaveText(phaseFirst.name);
    await expect.poll(() => page.locator("audio").evaluate(el => !el.paused && el.readyState >= 2)).toBe(true);
    const continuousSwitch = page.getByRole("checkbox", { name: "连续试听", exact: true });
    await expect(continuousSwitch).not.toBeChecked();
    await page.locator("audio").evaluate(el => { el.currentTime = el.duration - 0.15; });
    await expect.poll(() => page.locator("audio").evaluate(el => el.ended)).toBe(true);
    await expect(page.locator(".player-title strong")).toHaveText(phaseFirst.name);
    await continuousSwitch.check();
    await page.getByRole("button", { name: "播放试听", exact: true }).click();
    await expect.poll(() => page.locator("audio").evaluate(el => !el.paused)).toBe(true);
    await page.locator("audio").evaluate(el => { el.currentTime = el.duration - 0.15; });
    await expect(page.locator(".player-title strong")).toHaveText(phaseSecond.name);
    await expect.poll(() => page.locator("audio").evaluate(el => !el.paused && el.readyState >= 2)).toBe(true);
    await page.locator("audio").evaluate(el => { el.currentTime = el.duration - 0.15; });
    await expect.poll(() => page.locator("audio").evaluate(el => el.ended)).toBe(true);
    await expect(page.locator(".player-title strong")).toHaveText(phaseSecond.name);
    await continuousSwitch.uncheck();
    await page.getByRole("button", { name: "上一首试听", exact: true }).click();
    await expect(page.locator(".player-title strong")).toHaveText(phaseFirst.name);
    await expect.poll(() => page.locator("audio").evaluate(el => !el.paused && el.readyState >= 2)).toBe(true);
    await page.locator("body").evaluate(() => (document.activeElement instanceof HTMLElement) && document.activeElement.blur());
    await page.keyboard.press("Space");
    await expect.poll(() => page.locator("audio").evaluate(el => el.paused)).toBe(true);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".player-title strong")).toHaveText(phaseSecond.name);
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".player-title strong")).toHaveText(phaseFirst.name);
    await page.getByRole("button", { name: "暂停试听", exact: true }).click();
    await page.getByLabel("搜索素材", { exact: true }).focus();
    await page.keyboard.press("Space");
    assert.equal(await page.locator("audio").evaluate(el => el.paused), true);
    await page.getByLabel("搜索素材", { exact: true }).fill("");
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await page.locator(".audition-wave").click({ position: { x: 50, y: 15 } });
    await expect.poll(() => page.locator("audio").evaluate(el => el.currentTime)).toBeGreaterThan(0);
    await page.getByLabel("试听入点", { exact: true }).fill("0.2");
    await page.getByLabel("试听出点", { exact: true }).fill("0.55");
    await page.getByLabel("循环试听选段", { exact: true }).check();
    await continuousSwitch.check();
    await expect(page.getByLabel("循环试听选段", { exact: true })).not.toBeChecked();
    await page.getByLabel("循环试听选段", { exact: true }).check();
    await expect(continuousSwitch).not.toBeChecked();
    await page.getByRole("button", { name: "播放试听", exact: true }).click();
    await page.waitForTimeout(850);
    const loopTime = await page.locator("audio").evaluate(el => el.currentTime);
    assert.ok(loopTime >= 0.18 && loopTime <= 0.65, "audition loop outside selection: " + loopTime);
    await page.getByRole("button", { name: "暂停试听", exact: true }).click();
    await page.getByRole("button", { name: "重置试听选段", exact: true }).click();
    await page.getByRole("button", { name: "收藏试听素材", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消试听素材收藏", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消试听素材收藏", exact: true }).click();
    await context.request.patch(url + "/api/assets/" + phaseFirst.id, { headers: phaseHeaders, data: { tags: ["阶段悬疑", "阶段紧张"] } });
    await context.request.patch(url + "/api/assets/" + phaseSecond.id, { headers: phaseHeaders, data: { tags: ["阶段悬疑", "阶段人声"] } });
    await page.getByRole("button", { name: "刷新索引显示", exact: true }).click();
    await page.getByRole("button", { name: "标签筛选", exact: true }).click();
    const rulesPanel = page.getByRole("region", { name: "标签筛选条件" });
    for (const [mode, tag] of [["all", "阶段悬疑"], ["any", "阶段紧张"], ["none", "阶段人声"]]) {
      await rulesPanel.getByLabel("标签匹配方式", { exact: true }).selectOption(mode);
      await rulesPanel.getByRole("textbox", { name: "搜索筛选标签", exact: true }).fill(tag);
      await rulesPanel.getByRole("checkbox", { name: tag, exact: true }).check();
    }
    await expect(page.getByRole("button", { name: "组合标签筛选", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "筛选标签", exact: true })).toHaveCount(0);
    await rulesPanel.getByRole("textbox", { name: "搜索筛选标签", exact: true }).fill("阶段悬疑");
    await rulesPanel.getByRole("checkbox", { name: "阶段悬疑", exact: true }).check();
    await expect(rulesPanel.getByRole("button", { name: "移除同时包含标签：阶段悬疑", exact: true })).toHaveCount(0);
    await expect(rulesPanel.getByRole("button", { name: "移除排除标签：阶段悬疑", exact: true })).toBeVisible();
    await rulesPanel.getByRole("checkbox", { name: "阶段悬疑", exact: true }).uncheck();
    await rulesPanel.getByLabel("标签匹配方式", { exact: true }).selectOption("all");
    await rulesPanel.getByRole("checkbox", { name: "阶段悬疑", exact: true }).check();
    await expect(page.getByRole("button", { name: "标签筛选", exact: true })).toContainText("包含 2 · 排除 1");
    await rulesPanel.getByRole("button", { name: "完成", exact: true }).click();
    await expect(page.locator(".asset-row")).toHaveCount(1);
    await expect(page.locator(".asset-row")).toContainText(phaseFirst.name);
    await page.locator(".asset-row").getByRole("button", { name: "更多素材操作：" + phaseFirst.name, exact: true }).click();
    await page.getByRole("menuitem", { name: "修改分类：" + phaseFirst.name, exact: true }).click();
    await page.getByRole("dialog", { name: "修改素材分类", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
    const pausedAt = await page.locator("audio").evaluate(el => el.currentTime);
    await page.locator(".asset-name-button").filter({ hasText: phaseFirst.name }).click();
    const phaseEditor = page.getByRole("dialog", { name: "编辑素材详情", exact: true });
    await phaseEditor.getByLabel("素材备注", { exact: true }).fill("阶段选材备注");
    await phaseEditor.getByRole("button", { name: "保存标签与属性", exact: true }).click();
    await expect(phaseEditor).toContainText("标签、属性及主分类已保存");
    await phaseEditor.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator(".details textarea")).toHaveValue("阶段选材备注");
    await expect(page.locator(".asset-row")).toHaveCount(1);
    assert.ok(Math.abs(await page.locator("audio").evaluate(el => el.currentTime) - pausedAt) < 0.1, "edit reset audition position");
    await expect(page.locator(".audition-error")).toHaveCount(0);
    await expect(page.locator(".detail-identity h2")).toHaveAttribute("title", phaseFirst.name);
    await expect(page.locator(".details .audio-preview")).toHaveCSS("height", "76px");
    await expect(page.locator(".detail-file-info")).not.toHaveAttribute("open", "");
    await page.locator(".detail-file-info > summary").click();
    await expect(page.locator(".detail-file-info dl")).toBeVisible();
    await page.locator(".detail-file-info > summary").click();
    await page.screenshot({ path: path.join(out, name + "-audition-workspace.png") });
    await page.setViewportSize({ width: 320, height: 844 });
    await page.locator(".details").evaluate(el => { el.scrollTop = 0; });
    assert.ok(await page.locator(".details").evaluate(el => el.scrollWidth <= el.clientWidth), "detail panel overflows");
    await page.screenshot({ path: path.join(out, name + "-details-redesign-320.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "重置筛选", exact: true }).click();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "下一首试听", exact: true }).click();
    await expect(page.locator(".player-title strong")).toHaveText(phaseSecond.name);
    await expect(page.locator(".details.has-selection")).toHaveCount(0);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "audition workspace overflow at " + width);
      await page.screenshot({ path: path.join(out, name + "-audition-workspace-" + width + ".png") });
    }
    await page.getByRole("button", { name: "关闭播放器", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const a of phaseFiles) await context.request.patch(url + "/api/assets/" + a.id, { headers: phaseHeaders, data: { tags: a.tags, note: a.note, favorite: a.favorite } });
    await page.getByRole("button", { name: "刷新索引显示", exact: true }).click();
    const auditionPrefix = "跨页候选-" + name + "-", auditionPaths = [];
    const auditionBytes = await fs.readFile(path.join(source, "风声 测试.wav"));
    for (let i = 1; i <= 64; i++) { const p = path.join(source, auditionPrefix + String(i).padStart(3, "0") + ".wav"); await fs.writeFile(p, auditionBytes); auditionPaths.push(p); }
    await context.request.post(url + "/api/roots/" + soundRoot.id + "/scan", { headers: phaseHeaders, data: {} });
    await expect.poll(async () => { const j = await (await context.request.get(url + "/api/jobs")).json(); return j.jobs.some(job => job.status === "running") || j.metadata.pending > 0; }, { timeout: 30000 }).toBe(false);
    await page.getByLabel("搜索素材", { exact: true }).fill(auditionPrefix);
    await expect(page.locator(".asset-row")).toHaveCount(60);
    const lastCandidateName = auditionPrefix + "060.wav";
    const lastCandidate = page.locator(".asset-row").filter({ hasText: lastCandidateName });
    await lastCandidate.getByTitle("试听", { exact: true }).click();
    await expect.poll(() => page.locator("audio").evaluate(el => !el.paused && el.readyState >= 2)).toBe(true);
    await page.getByRole("button", { name: "暂停试听", exact: true }).click();
    const savedScroll = await page.evaluate(() => scrollY);
    await lastCandidate.locator(".asset-name-button").click();
    const scrolledEditor = page.getByRole("dialog", { name: "编辑素材详情", exact: true });
    await scrolledEditor.getByLabel("素材备注", { exact: true }).fill("跨页选材位置保留");
    await scrolledEditor.getByRole("button", { name: "保存标签与属性", exact: true }).click();
    await expect(scrolledEditor).toContainText("标签、属性及主分类已保存");
    await scrolledEditor.getByRole("button", { name: "关闭", exact: true }).click();
    await expect.poll(async () => Math.abs(await page.evaluate(() => scrollY) - savedScroll)).toBeLessThan(3);
    await continuousSwitch.check();
    await page.getByRole("button", { name: "播放试听", exact: true }).click();
    await page.locator("audio").evaluate(el => { el.currentTime = el.duration - 0.15; });
    await expect(page.locator(".player-title strong")).toHaveText(auditionPrefix + "061.wav");
    await continuousSwitch.uncheck();
    await expect(page.locator(".asset-row")).toHaveCount(4);
    await expect(page.getByLabel("搜索素材", { exact: true })).toHaveValue(auditionPrefix);
    await page.getByRole("button", { name: "上一首试听", exact: true }).click();
    await expect(page.locator(".player-title strong")).toHaveText(lastCandidateName);
    await expect(page.locator(".asset-row")).toHaveCount(60);
    await page.getByRole("button", { name: "关闭播放器", exact: true }).click();
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    // Exercise actual sub-second playback, delayed loading, and a pending next-page request.
    for (let i = 0; i < auditionPaths.length; i++) await fs.writeFile(auditionPaths[i], shortAudioBuffers[i % shortAudioBuffers.length]);
    await context.request.post(url + "/api/roots/" + soundRoot.id + "/scan", { headers: phaseHeaders, data: {} });
    await expect.poll(async () => { const j = await (await context.request.get(url + "/api/jobs")).json(); return j.jobs.some(job => job.status === "running") || j.metadata.pending > 0; }, { timeout: 30000 }).toBe(false);
    await page.getByRole("button", { name: "刷新索引显示", exact: true }).click();
    const shortRecords = (await (await context.request.get(url + "/api/assets?q=" + encodeURIComponent(auditionPrefix))).json()).items;
    const shortFirst = shortRecords.find(a => a.name === auditionPrefix + "001.wav"), shortSecond = shortRecords.find(a => a.name === auditionPrefix + "002.wav");
    assert.ok(shortFirst.duration < 1 && shortSecond.duration < 1);
    let releaseLoad, loadSeen;
    const loadGate = new Promise(resolve => { releaseLoad = resolve; }), pendingLoad = new Promise(resolve => { loadSeen = resolve; });
    const shortLoadUrl = `**/api/media/${shortSecond.id}/original`;
    await page.route(shortLoadUrl, async route => { loadSeen(); await loadGate; await route.continue(); });
    await page.locator(".asset-row").filter({ hasText: shortFirst.name }).getByTitle("试听", { exact: true }).click();
    await expect.poll(() => page.locator("audio").evaluate(el => el.ended)).toBe(true);
    await expect(page.getByRole("button", { name: "播放试听", exact: true })).toBeVisible();
    await continuousSwitch.check();
    await page.getByRole("button", { name: "播放试听", exact: true }).click();
    await Promise.race([pendingLoad, new Promise((_, reject) => setTimeout(() => reject(Error("未进入短音频加载测试")), 10000))]);
    await expect(page.getByRole("button", { name: "暂停试听", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "暂停试听", exact: true }).click();
    releaseLoad();
    await page.waitForTimeout(1100);
    await expect.poll(() => page.locator("audio").evaluate(el => el.paused)).toBe(true);
    await expect(page.locator(".player-title strong")).toHaveText(shortSecond.name);
    await expect(page.getByRole("button", { name: "播放试听", exact: true })).toBeVisible();
    await page.unroute(shortLoadUrl);
    for (const delay of [0, 40, 420]) {
      await page.getByRole("button", { name: "播放试听", exact: true }).click();
      await page.waitForTimeout(delay);
      await page.locator(".player-toggle").click();
      const pausedName = await page.locator(".player-title strong").textContent();
      await page.waitForTimeout(1000);
      assert.equal(await page.locator("audio").evaluate(el => el.paused), true, "短促连播暂停后不应恢复播放");
      await expect(page.locator(".player-title strong")).toHaveText(pausedName);
    }
    // Keyboard pause must also remain paused after keyup.
    await page.getByRole("button", { name: "播放试听", exact: true }).press("Space");
    await page.locator(".player-toggle").press("Space");
    await page.waitForTimeout(1000);
    assert.equal(await page.locator("audio").evaluate(el => el.paused), true);
    await continuousSwitch.uncheck();
    let releasePage, pageSeen;
    const pageGate = new Promise(resolve => { releasePage = resolve; }), pendingPage = new Promise(resolve => { pageSeen = resolve; });
    const nextPageRoute = "**/api/assets?**";
    await page.route(nextPageRoute, async route => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("q") === auditionPrefix && u.searchParams.get("page") === "2") { pageSeen(); await pageGate; }
      await route.continue();
    });
    await lastCandidate.getByTitle("试听", { exact: true }).click();
    await expect.poll(() => page.locator("audio").evaluate(el => el.ended)).toBe(true);
    await expect(page.getByRole("button", { name: "播放试听", exact: true })).toBeVisible();
    await continuousSwitch.check();
    await page.getByRole("button", { name: "播放试听", exact: true }).click();
    await Promise.race([pendingPage, new Promise((_, reject) => setTimeout(() => reject(Error("未进入短音频跨页测试")), 10000))]);
    await page.getByRole("button", { name: "暂停试听", exact: true }).click();
    releasePage();
    await page.waitForTimeout(1100);
    await expect(page.locator(".player-title strong")).toHaveText(lastCandidateName);
    assert.equal(await page.locator("audio").evaluate(el => el.paused), true, "暂停必须取消待执行的跨页连播");
    await page.unroute(nextPageRoute);
    await continuousSwitch.uncheck();
    await page.getByRole("button", { name: "关闭播放器", exact: true }).click();
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    const auditionRecords = [];
    for (const p of [1, 2]) auditionRecords.push(...(await (await context.request.get(url + "/api/assets?q=" + encodeURIComponent(auditionPrefix) + "&page=" + p)).json()).items);
    for (const p of auditionPaths) await fs.unlink(p);
    await context.request.post(url + "/api/maintenance/files", { headers: phaseHeaders, data: { force: true } });
    const auditionCleanup = await (await context.request.post(url + "/api/maintenance/files/cleanup/preview", { headers: phaseHeaders, data: { ids: auditionRecords.map(a => a.id) } })).json();
    assert.equal((await (await context.request.post(url + "/api/maintenance/files/cleanup", { headers: phaseHeaders, data: { confirmation: auditionCleanup.confirmation } })).json()).removed, 64);
    await page.getByLabel("搜索素材", { exact: true }).fill("");
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await page.locator("nav .nav-item").filter({ hasText: /^项目$/ }).click();
    await page.getByRole("button", { name: "新建项目", exact: true }).click();
    const projectDialog = page.getByRole("dialog", { name: "新建项目", exact: true });
    await projectDialog.getByLabel("项目名称", { exact: true }).fill("耳机广告-" + name);
    await projectDialog.getByLabel("项目剪辑软件", { exact: true }).selectOption("resolve");
    await projectDialog.getByLabel("项目备注", { exact: true }).fill("项目测试备注");
    await projectDialog.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(projectDialog).toHaveCount(0);
    await expect(page.locator(".project-title h2")).toHaveText("耳机广告-" + name);
    const createdProjectId = await page.getByLabel("当前项目", { exact: true }).inputValue();
    assert.ok(createdProjectId);
    await page.locator("nav .nav-item").filter({ hasText: "全部素材" }).click();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    const projectAssets = (await (await context.request.get(url + "/api/assets")).json()).items;
    const projectTarget = projectAssets[0];
    const targetRow = page.locator(".asset-row").filter({ hasText: projectTarget.name });
    await targetRow.getByRole("button", { name: "更多素材操作：" + projectTarget.name, exact: true }).click();
    await page.getByRole("menuitem", { name: "加入当前项目：" + projectTarget.name, exact: true }).click();
    await expect(targetRow).toContainText("已加入项目");
    await targetRow.getByRole("button", { name: "更多素材操作：" + projectTarget.name, exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "加入当前项目：" + projectTarget.name, exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    for (const a of projectAssets) await page.getByRole("checkbox", { name: "选择 " + a.name, exact: true }).check();
    await page.getByRole("button", { name: "批量加入当前项目", exact: true }).click();
    await expect.poll(async () => (await (await context.request.get(url + "/api/projects")).json())[0].total).toBe(5);
    await page.locator("nav .nav-item").filter({ hasText: /^项目$/ }).click();
    await expect(page.locator(".project-item")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "筛选项目音效", exact: true })).toContainText("2");
    await expect(page.getByRole("button", { name: "筛选项目照片", exact: true })).toContainText("2");
    await expect(page.getByRole("button", { name: "筛选项目视频", exact: true })).toContainText("1");
    await page.getByRole("button", { name: "筛选项目音效", exact: true }).click();
    await expect(page.locator(".project-item")).toHaveCount(2);
    await page.getByLabel("选择本页项目素材", { exact: true }).check();
    await page.getByRole("button", { name: "筛选项目照片", exact: true }).click();
    await expect(page.locator(".project-item")).toHaveCount(2);
    await expect(page.getByLabel("选择本页项目素材", { exact: true })).not.toBeChecked();
    await page.getByRole("button", { name: "预览项目素材：测试照片.jpg", exact: true }).click();
    const projectMediaDialog = page.getByRole("dialog", { name: "项目素材预览", exact: true });
    await expect(projectMediaDialog.getByRole("img", { name: "测试照片.jpg", exact: true })).toBeVisible();
    await expect.poll(() => projectMediaDialog.locator("img").evaluate(el => el.complete && el.naturalWidth > 0)).toBe(true);
    await projectMediaDialog.getByRole("button", { name: "关闭项目素材预览", exact: true }).click();
    await page.getByLabel("搜索项目素材", { exact: true }).fill("测试照片");
    await expect.poll(async () => await page.getByRole("button", { name: "筛选项目全部", exact: true }).textContent()).toContain("2");
    await page.getByLabel("搜索项目素材", { exact: true }).fill("");
    await page.getByRole("button", { name: "筛选项目视频", exact: true }).click();
    await expect(page.locator(".project-item")).toHaveCount(1);
    await page.getByRole("button", { name: "预览项目素材：摄影片段.mp4", exact: true }).click();
    await expect(projectMediaDialog.locator("video")).toBeVisible();
    await expect.poll(() => projectMediaDialog.locator("video").evaluate(el => el.readyState >= 1)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(projectMediaDialog).toHaveCount(0);
    await page.getByRole("button", { name: "筛选项目音乐", exact: true }).click();
    await expect(page.locator(".project-item")).toHaveCount(0);
    await expect(page.getByText("暂无音乐素材", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "筛选项目全部", exact: true }).click();
    await expect(page.locator(".project-item")).toHaveCount(5);
    await page.getByLabel("已使用：" + projectTarget.name, { exact: true }).check();
    await expect(page.locator(".project-item")).toHaveCount(4);
    await page.getByRole("tab", { name: /^已使用/ }).click();
    await expect(page.locator(".project-item")).toHaveCount(1);
    await page.getByRole("button", { name: "添加使用位置备注", exact: true }).click();
    await page.getByLabel("使用位置备注", { exact: true }).fill("第1集开场");
    await page.getByRole("button", { name: "保存备注", exact: true }).click();
    await expect(page.getByRole("button", { name: "第1集开场", exact: true })).toBeVisible();
    await page.locator(".project-item .asset-name-button").click();
    const projectAssetEditor = page.getByRole("dialog", { name: "编辑素材详情", exact: true });
    await expect(projectAssetEditor.getByRole("region", { name: "项目使用历史", exact: true })).toContainText("已用于 1 个项目");
    await expect(projectAssetEditor).toContainText("第1集开场");
    await projectAssetEditor.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByLabel("已使用：" + projectTarget.name, { exact: true }).uncheck();
    await expect(page.locator(".project-item")).toHaveCount(0);
    await page.getByRole("tab", { name: /^候选素材/ }).click();
    await expect(page.locator(".project-item")).toHaveCount(5);
    await page.getByLabel("选择本页项目素材", { exact: true }).check();
    await page.getByRole("button", { name: "标记已使用", exact: true }).click();
    await expect(page.locator(".project-item")).toHaveCount(0);
    await page.getByRole("tab", { name: /^已使用/ }).click();
    await expect(page.locator(".project-item")).toHaveCount(5);
    await page.screenshot({ path: path.join(out, name + "-projects-desktop.png") });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "project workspace overflow at " + width);
      await page.screenshot({ path: path.join(out, name + "-projects-" + width + ".png") });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await expect(page.getByLabel("当前项目", { exact: true })).toHaveValue(createdProjectId);
    await page.locator("nav .nav-item").filter({ hasText: /^项目$/ }).click();
    await page.getByRole("tab", { name: /^已使用/ }).click();
    await expect(page.locator(".project-item")).toHaveCount(5);
    await expect(page.getByRole("button", { name: "第1集开场", exact: true })).toBeVisible();
    page.once("dialog", d => d.accept());
    await page.getByRole("button", { name: "移出项目素材：" + projectTarget.name, exact: true }).click();
    await expect(page.locator(".project-item")).toHaveCount(4);
    await fs.access(projectTarget.path);
    page.once("dialog", d => d.dismiss());
    await page.getByRole("button", { name: "删除当前项目", exact: true }).click();
    await expect(page.locator(".project-title h2")).toHaveText("耳机广告-" + name);
    await page.getByRole("button", { name: "编辑当前项目", exact: true }).click();
    const editProjectDialog = page.getByRole("dialog", { name: "编辑项目", exact: true });
    await editProjectDialog.getByLabel("项目名称", { exact: true }).fill("广告终版-" + name);
    await editProjectDialog.getByRole("button", { name: "保存项目", exact: true }).click();
    await expect(page.locator(".project-title h2")).toHaveText("广告终版-" + name);
    page.once("dialog", d => d.accept());
    await page.getByRole("button", { name: "删除当前项目", exact: true }).click();
    await expect(page.locator(".project-title h2")).toHaveCount(0);
    assert.equal((await (await context.request.get(url + "/api/projects")).json()).length, 0);
    for (const a of projectAssets) await fs.access(a.path);
    await page.locator("nav .nav-item").filter({ hasText: "全部素材" }).click();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await page.getByRole("button", { name: "显示设置", exact: true }).click();
    await page.getByLabel("显示完整操作", { exact: true }).check();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("排序", { exact: true })).toHaveValue("revealCount");
    await expect(page.locator(".asset-row").first()).toContainText("第二段 音效.mp3");
    await expect(page.locator(".asset-row").first()).toContainText("访达 3 次");
    await page.locator(".asset-name-button").filter({ hasText: "第二段 音效.mp3" }).click();
    const assetEditor = page.getByRole("dialog", { name: "编辑素材详情" });
    await expect(assetEditor).toBeVisible();
    await assetEditor.getByLabel("新增素材标签").fill("弹窗验证，节奏");
    await assetEditor.getByLabel("新增素材标签").press("Enter");
    await assetEditor.getByLabel("素材备注").fill("弹窗备注测试");
    await assetEditor.getByRole("button", { name: "保存标签与属性" }).click();
    await expect(assetEditor).toContainText("标签、属性及主分类已保存");
    await assetEditor.getByRole("button", { name: "关闭", exact: true }).click();
    await page.locator(".asset-name-button").filter({ hasText: "第二段 音效.mp3" }).click();
    await expect(assetEditor.getByLabel("素材备注")).toHaveValue("弹窗备注测试");
    await expect(assetEditor.getByLabel("移除标签：弹窗验证", { exact: true })).toBeVisible();
    await assetEditor.getByLabel("新文件名").fill("弹窗改名.mp3");
    await assetEditor.getByRole("button", { name: "检查改名" }).click();
    await expect(assetEditor.getByRole("button", { name: "确认修改原文件名" })).toBeVisible();
    await assetEditor.getByRole("button", { name: "确认修改原文件名" }).click();
    await expect(assetEditor.getByLabel("新文件名")).toHaveValue("弹窗改名.mp3");
    await assetEditor.getByLabel("新文件名").fill("第二段 音效.mp3");
    await assetEditor.getByRole("button", { name: "检查改名" }).click();
    await assetEditor.getByRole("button", { name: "确认修改原文件名" }).click();
    await expect(assetEditor.getByLabel("新文件名")).toHaveValue("第二段 音效.mp3");
    await assetEditor.getByLabel("移除标签：弹窗验证", { exact: true }).click();
    await assetEditor.getByLabel("移除标签：节奏", { exact: true }).click();
    await assetEditor.getByLabel("素材备注").fill("");
    await assetEditor.getByRole("button", { name: "保存标签与属性" }).click();
    await expect(assetEditor).toContainText("标签、属性及主分类已保存");
    await page.screenshot({ path: path.join(out, name + "-asset-editor.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, name + "-asset-editor-mobile.png") });
    assert.equal(await assetEditor.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press("Escape");
    await expect(assetEditor).toHaveCount(0);
    await showFilters();
    await page
      .getByRole("button", { name: "筛选素材目录", exact: true })
      .click();
    const directoryOptions = page.getByRole("group", { name: "素材目录勾选" });
    await directoryOptions.getByRole("checkbox", { name: /音效 测试/ }).check();
    await expect(page.locator(".asset-row")).toHaveCount(2);
    await directoryOptions.getByRole("checkbox", { name: /摄影素材/ }).check();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await expect(
      page.getByRole("button", { name: "筛选素材目录", exact: true }),
    ).toContainText("已选 2 个目录");
    await directoryOptions
      .getByRole("checkbox", { name: /音效 测试/ })
      .uncheck();
    await expect(page.locator(".asset-row")).toHaveCount(3);
    await directoryOptions
      .getByRole("button", { name: "全部目录", exact: true })
      .click();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(directoryOptions).toHaveCount(0);
    const categorySelect = page.getByLabel("筛选分类", { exact: true });
    const categoryOptions = page.getByRole("listbox", { name: "可选分类" });
    await categorySelect.click();
    await expect(categoryOptions.getByRole("option")).toHaveCount(2);
    await categorySelect.fill("环境");
    await expect(categoryOptions.getByRole("option")).toHaveCount(1);
    await expect(categoryOptions.getByRole("option")).toContainText("环境自然与动物");
    await page.screenshot({ path: path.join(out, name + "-category-search.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, name + "-category-search-mobile.png") });
    const menuBounds = await categoryOptions.boundingBox();
    assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 390);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await categorySelect.fill("不存在的分类关键词");
    await expect(categoryOptions.getByRole("status")).toHaveText("没有匹配的分类");
    await categorySelect.press("Escape");
    await expect(categoryOptions).toHaveCount(0);
    await expect(categorySelect).toHaveValue("");
    await categorySelect.click();
    await categorySelect.fill("环境");
    await categorySelect.press("Enter");
    await expect(categorySelect).toHaveValue("环境自然与动物");
    await expect(page.locator(".asset-row")).toHaveCount(1);
    await page
      .getByRole("button", { name: "筛选素材目录", exact: true })
      .click();
    await directoryOptions.getByRole("checkbox", { name: /摄影素材/ }).check();
    await expect(categorySelect).toHaveValue("环境自然与动物");
    await expect(page.locator(".asset-row")).toHaveCount(0);
    await categorySelect.click();
    await expect(categoryOptions.getByRole("option")).toHaveCount(1);
    await categoryOptions.getByRole("option").click();
    await expect(page.locator(".asset-row")).toHaveCount(3);
    await page.getByRole("button", { name: "筛选素材目录", exact: true }).click();
    await directoryOptions
      .getByRole("button", { name: "全部目录", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await categorySelect.click();
    await expect(categoryOptions.getByRole("option")).toHaveCount(2);
    await categorySelect.press("ArrowDown");
    await categorySelect.press("Enter");
    await expect(page.locator(".asset-row")).toHaveCount(1);
    await categorySelect.click();
    await categoryOptions.getByRole("option", { name: "全部分类", exact: true }).click();
    await expect(categorySelect).toHaveValue("");
    await categorySelect.click();
    await page.getByRole("heading", { name: "全部素材", exact: true }).click();
    await expect(categoryOptions).toHaveCount(0);
    await expect(page.locator(".asset-row")).toHaveCount(5);
    const allDates = await (
      await context.request.get(url + "/api/assets")
    ).json();
    const dateValue = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(allDates.items[0].created_ms));
    await page.getByLabel("创建日期起始", { exact: true }).fill(dateValue);
    await page.getByLabel("创建日期结束", { exact: true }).fill(dateValue);
    await expect(page.locator(".asset-row")).toHaveCount(5);
    const future = Number(dateValue.slice(0, 4)) + 1 + dateValue.slice(4);
    await page.getByRole("button", { name: "清除创建日期筛选" }).click();
    await page.getByLabel("创建日期起始", { exact: true }).fill(future);
    await expect(
      page.getByRole("heading", { name: "没有匹配的素材" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "重置筛选", exact: true }).click();
    await expect(page.locator(".asset-row")).toHaveCount(5);
    assert.equal(
      await page.getByLabel("创建日期起始", { exact: true }).inputValue(),
      "",
    );
    const invalidDates = await context.request.get(
      url + "/api/assets?createdFrom=2026-02-30",
    );
    assert.equal(invalidDates.status(), 400);
    await page.getByLabel("日期类型", { exact: true }).selectOption("captured");
    await page.getByLabel("拍摄日期起始", { exact: true }).fill("2026-10-12");
    await page.getByLabel("拍摄日期结束", { exact: true }).fill("2026-10-12");
    await expect(
      page.locator(".asset-row").filter({ hasText: "测试照片.jpg" }),
    ).toHaveCount(1);
    await page.getByRole("button", { name: "清除拍摄日期筛选" }).click();
    await page.getByLabel("日期类型", { exact: true }).selectOption("created");
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await page.getByRole("textbox", { name: "搜索素材" }).fill("风声");
    await page.waitForFunction(
      () => document.querySelectorAll(".asset-row").length === 1,
    );
    await page.locator(".asset-row").first().click();
    await page.getByRole("button", { name: "试听", exact: true }).click();
    await page.waitForFunction(() => {
      const a = document.querySelector("audio");
      return a && a.readyState >= 2 && !a.paused;
    });
    await page.waitForFunction(() => {
      const i = document.querySelector(".wave img");
      return i && i.complete && i.naturalWidth > 0;
    });
    await page.getByRole("button", { name: "暂停试听", exact: true }).click();
    await page
      .locator(".field")
      .filter({ hasText: "标签" })
      .locator("input")
      .fill("广告，夜景");
    await page
      .locator(".field")
      .filter({ hasText: "备注" })
      .locator("textarea")
      .fill("测试备注");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("status").waitFor();
    const tagTrigger = page.getByRole("button", { name: "标签筛选", exact: true });
    const tagFilter = page.getByRole("textbox", { name: "搜索筛选标签", exact: true });
    const tagOptions = page.getByRole("group", { name: "可选筛选标签", exact: true });
    await tagTrigger.click();
    await expect(page.getByLabel("标签匹配方式", { exact: true })).toHaveValue("all");
    await tagFilter.fill("夜");
    await expect(tagOptions.getByRole("checkbox")).toHaveCount(1);
    await expect(tagOptions).toContainText("夜景");
    await page.screenshot({ path: path.join(out, name + "-tag-search.png") });
    await tagOptions.getByRole("checkbox", { name: "夜景", exact: true }).check();
    await page.getByRole("region", { name: "标签筛选条件" }).getByRole("button", { name: "完成", exact: true }).click();
    await expect(tagTrigger).toContainText("包含 1");
    await expect(page.locator(".asset-row")).toHaveCount(1);
    await page.getByLabel("搜索素材", { exact: true }).fill("第二段");
    await expect(page.getByRole("heading", { name: "没有匹配的素材", exact: true })).toBeVisible();
    await page.getByLabel("搜索素材", { exact: true }).fill("");
    await expect(page.locator(".asset-row")).toHaveCount(1);
    await tagTrigger.click();
    await tagFilter.fill("不存在的标签");
    await expect(tagOptions.getByRole("status")).toHaveText("没有匹配的标签");
    await tagFilter.press("Escape");
    await expect(tagTrigger).toBeFocused();
    await expect(tagTrigger).toContainText("包含 1");
    await page.getByRole("button", { name: "关闭详情", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await tagTrigger.click();
    await tagFilter.fill("夜");
    await page.screenshot({ path: path.join(out, name + "-tag-search-mobile.png") });
    const tagMenuBounds = await tagOptions.boundingBox();
    assert.ok(tagMenuBounds && tagMenuBounds.x >= 0 && tagMenuBounds.x + tagMenuBounds.width <= 390);
    await tagFilter.press("Escape");
    await page.getByRole("button", { name: /^取消包含标签筛选：/ }).click();
    await expect(tagTrigger).toHaveText("全部标签");
    await expect(page.locator(".asset-row")).toHaveCount(5);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("textbox", { name: "搜索素材" }).fill("夜景");
    await page.waitForFunction(
      () => document.querySelectorAll(".asset-row").length === 1,
    );
    await page.reload();
    await page
      .locator(".asset-row")
      .filter({ hasText: "风声 测试.wav" })
      .click();
    await expect(
      page.locator(".field").filter({ hasText: "标签" }).locator("input"),
    ).toHaveValue("广告，夜景");
    await page.getByRole("button", { name: "改名", exact: true }).click();
    await page
      .getByRole("textbox", { name: "新文件名（保留扩展名）" })
      .fill("风声 已改名.wav");
    await page.getByRole("button", { name: "检查目标路径" }).click();
    await page.getByRole("button", { name: "确认改名", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(
      await fs
        .readFile(path.join(source, "风声 已改名.wav"))
        .then((b) => b.length > 0),
      true,
    );
    await page.getByRole("button", { name: "操作记录", exact: true }).click();
    await page.locator(".operation").first().waitFor();
    page.once("dialog", (d) => d.accept());
    await page
      .getByRole("button", { name: "撤销", exact: true })
      .first()
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".operation-title")
        ?.textContent?.includes("已撤销"),
    );
    await fs.access(path.join(source, "风声 测试.wav"));
    await page.getByRole("button", { name: "关闭窗口" }).click();
    await page.locator(".nav-item").filter({ hasText: "摄影照片" }).click();
    await page.locator(".asset-card").first().waitFor();
    await page.waitForFunction(() => {
      const i = document.querySelector(".asset-card img");
      return i && i.complete && i.naturalWidth > 0;
    });
    await page.locator(".asset-card").first().click();
    await page.locator(".image-preview").click();
    await page.getByRole("dialog", { name: "照片预览" }).waitFor();
    await page.screenshot({ path: path.join(out, name + "-photo.png") });
    await page.getByRole("button", { name: "关闭窗口" }).click();
    await page.locator(".nav-item").filter({ hasText: "视频素材" }).click();
    await page.locator(".asset-card").first().waitFor();
    await page.locator(".asset-card").first().click();
    await page.waitForFunction(() => {
      const v = document.querySelector("video");
      return v && v.readyState >= 1;
    });
    assert.equal(
      await page.locator("video").evaluate((v) => v.videoWidth),
      640,
    );
    await page.screenshot({
      path: path.join(out, name + "-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(out, name + "-mobile.png"),
      fullPage: true,
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "mobile overflow",
    );
    await page.getByRole("button", { name: "展开导航" }).click();
    await page.locator(".nav-item").filter({ hasText: "音效" }).click();
    await page.locator(".asset-row").first().waitFor();
    await page.getByRole("button", { name: "添加素材目录" }).click();
    try { await page.getByRole("dialog").waitFor({ timeout: 5000 }); }
    catch (e) { console.log(JSON.stringify({ browser: name, url: page.url(), errors, body: await page.locator("body").innerText() })); await page.screenshot({ path: path.join(out, name + "-modal-failure.png"), fullPage: true }); throw e; }
    assert.ok(
      await page
        .locator(".modal")
        .evaluate((e) => e.getBoundingClientRect().right <= innerWidth),
    );
    await page.getByRole("button", { name: "关闭窗口" }).click();
    const session = await context.request.get(url + "/api/session");
    const { token } = await session.json();
    const headers = { "X-Local-Token": token };
    const unauth = await context.request.post(url + "/api/cache/clear", {
      data: {},
    });
    assert.equal(unauth.status(), 403);
    const foreign = await context.request.get(url + "/api/stats", {
      headers: { Origin: "https://example.com" },
    });
    assert.equal(foreign.status(), 403);
    const list = await (
      await context.request.get(url + "/api/assets?kind=sfx")
    ).json();
    const a = list.items.find((a) => a.name === "第二段 音效.mp3");
    const knownCategories = await (await context.request.get(url + "/api/categories")).json();
    for (const name of ["待确认分类验收", "搜索分类验收", "管理分类原始"])
      if (!knownCategories.some(c => c.name === name)) {
        const created = await context.request.post(url + "/api/categories", { headers, data: { name } });
        assert.equal(created.status(), 200);
      }
    const hierarchyParents = await (await context.request.get(url + "/api/categories")).json();
    const hierarchyChildren = await (await context.request.get(url + "/api/subcategories")).json();
    for (const [parentName, childName] of [["待确认分类验收", "风声校正"], ["搜索分类验收", "测试子类"]]) {
      const parent = hierarchyParents.find(c => c.name === parentName);
      if (!hierarchyChildren.some(c => c.category_id === parent.id && c.name === childName))
        assert.equal((await context.request.post(url + "/api/subcategories", { headers, data: { categoryId: parent.id, name: childName } })).status(), 200);
    }
    const forbidden = await context.request.patch(url + "/api/assets/" + a.id, { headers, data: { category: "不允许隐式创建分类", note: "不应被保存" } });
    assert.equal(forbidden.status(), 400);
    const pendingAsset = list.items.find(a => a.review && !a.confirmed);
    assert.ok(pendingAsset);
    const pendingBytes = await fs.readFile(pendingAsset.path);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".nav-item").filter({ hasText: "待确认" }).click();
    await page.getByLabel("搜索素材", { exact: true }).fill("");
    const changeCategory = page.getByRole("button", { name: "修改分类：" + pendingAsset.name, exact: true });
    await changeCategory.click();
    const categoryEditor = page.getByRole("dialog", { name: "修改素材分类", exact: true });
    await expect(categoryEditor.getByLabel("待确认主分类")).toHaveValue(pendingAsset.category);
    await categoryEditor.getByRole("button", { name: "取消", exact: true }).click();
    await changeCategory.click();
    const primaryCategory = categoryEditor.getByRole("combobox", { name: "待确认主分类" });
    await primaryCategory.fill("不存在的主分类搜索词");
    await expect(categoryEditor.getByRole("listbox", { name: "主分类选项" })).toContainText("没有匹配的分类");
    await primaryCategory.press("Enter");
    await expect(categoryEditor).toBeVisible();
    assert.equal((await (await context.request.get(url + "/api/assets/" + pendingAsset.id)).json()).category, pendingAsset.category);
    await primaryCategory.press("Escape");
    await expect(primaryCategory).toHaveAttribute("aria-expanded", "false");
    await expect(categoryEditor).toBeVisible();
    await categoryEditor.getByRole("button", { name: "展开主分类", exact: true }).click();
    await expect(categoryEditor.getByRole("option", { name: "未分类", exact: true })).toBeVisible();
    await primaryCategory.fill("待确认分类");
    await expect(categoryEditor.getByRole("option")).toHaveCount(1);
    await primaryCategory.press("ArrowDown");
    await primaryCategory.press("Enter");
    await expect(primaryCategory).toHaveValue("待确认分类验收");
    await expect(categoryEditor.getByLabel("待确认子类")).toHaveValue("");
    await categoryEditor.getByLabel("待确认子类").fill("风声校正");
    await categoryEditor.getByRole("option", { name: "风声校正", exact: true }).click();
    await page.screenshot({ path: path.join(out, name + "-review-category.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, name + "-review-category-mobile.png") });
    assert.ok(await categoryEditor.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    await categoryEditor.getByRole("button", { name: "保存分类", exact: true }).click();
    await expect(categoryEditor).toHaveCount(0);
    let reviewed = await (await context.request.get(url + "/api/assets/" + pendingAsset.id)).json();
    assert.equal(reviewed.category, "待确认分类验收");
    assert.equal(reviewed.sub, "风声校正");
    for (const key of ["review", "confirmed", "kind", "tags", "note", "reveal_count"])
      assert.deepEqual(reviewed[key], pendingAsset[key]);
    assert.deepEqual(await fs.readFile(pendingAsset.path), pendingBytes);
    await expect(changeCategory).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "网格视图", exact: true }).click();
    await changeCategory.click();
    await categoryEditor.getByRole("button", { name: "展开主分类", exact: true }).click();
    await categoryEditor.getByRole("option", { name: pendingAsset.category || "未分类", exact: true }).click();
    await categoryEditor.getByRole("button", { name: "展开子类", exact: true }).click();
    await categoryEditor.getByRole("option", { name: pendingAsset.sub || "未选择子类", exact: true }).click();
    await categoryEditor.getByRole("button", { name: "保存分类", exact: true }).click();
    await expect(categoryEditor).toHaveCount(0);
    await page.locator(".nav-item").filter({ hasText: "全部素材" }).click();
    async function verifyManagerFileActions(manager) {
      await expect(page.getByLabel(manager === "category" ? "分类素材排序" : "标签素材排序", { exact: true })).toHaveValue("revealCount");
      await expect(page.locator(".category-music-row").filter({ hasText: a.name })).toContainText("访达 3 次");
      const reveal = page.getByRole("button", { name: (manager === "category" ? "定位素材：" : "定位素材：") + a.name, exact: true });
      const remove = page.getByRole("button", { name: "删除素材：" + a.name, exact: true });
      await expect(reveal).toBeEnabled();
      let revealCalls = 0;
      const revealUrl = url + `/api/assets/${a.id}/reveal`;
      await page.route(revealUrl, route => { revealCalls++; return route.fulfill({ json: { ok: true } }); });
      await reveal.click();
      await expect(reveal).toBeEnabled();
      assert.equal(revealCalls, 1);
      await page.unroute(revealUrl);
      await remove.click();
      const trashDialog = page.getByRole("dialog", { name: "移入废纸篓", exact: true });
      await expect(trashDialog).toBeVisible();
      await trashDialog.getByRole("button", { name: "取消", exact: true }).click();
      await fs.access(a.path);
      await remove.click();
      await trashDialog.getByRole("button", { name: "检查目标路径", exact: true }).click();
      await expect(trashDialog.locator(".plans")).toContainText(a.name);
      await trashDialog.getByRole("button", { name: "确认移入废纸篓", exact: true }).click();
      await expect(trashDialog).toHaveCount(0);
      await expect(remove).toHaveCount(0);
      await assert.rejects(fs.access(a.path));
      const operations = await (await context.request.get(url + "/api/operations")).json();
      const removed = operations.find(o => o.asset_id === a.id && o.action === "trash" && !o.undone && o.status === "done");
      assert.ok(removed);
      const restored = await context.request.post(url + `/api/operations/${removed.id}/undo`, { headers, data: {} });
      assert.equal(restored.status(), 200);
      await fs.access(a.path);
      await page.getByRole("button", { name: manager === "category" ? "刷新素材分类" : "刷新标签", exact: true }).click();
      await expect(remove).toBeEnabled();
    }
    const range = await context.request.get(
      url + "/api/media/" + a.id + "/original",
      { headers: { Range: "bytes=0-9" } },
    );
    assert.equal(range.status(), 206);
    assert.equal((await range.body()).length, 10);
    const wrong = await context.request.get(
      url + "/api/media/" + a.id + "/original",
      { headers: { Range: "bytes=999999999-" } },
    );
    assert.equal(wrong.status(), 416);
    const emptyRange = await context.request.get(
      url + "/api/media/" + a.id + "/original",
      { headers: { Range: "bytes=-" } },
    );
    assert.equal(emptyRange.status(), 416);
    const proxyAudio = await context.request.get(
      url + "/api/media/" + a.id + "/proxy",
    );
    assert.equal(proxyAudio.status(), 200);
    assert.match(proxyAudio.headers()["content-type"], /audio\/mp4/);
    const videos = await (
      await context.request.get(url + "/api/assets?kind=video")
    ).json();
    const proxyVideo = await context.request.get(
      url + "/api/media/" + videos.items[0].id + "/proxy",
    );
    assert.equal(proxyVideo.status(), 200);
    assert.match(proxyVideo.headers()["content-type"], /video\/mp4/);
    const photoAssets = await (
      await context.request.get(url + "/api/assets?kind=photo")
    ).json();
    const heic = photoAssets.items.find((a) => a.ext === "heic");
    const existingCategories = await (await context.request.get(url + "/api/categories")).json();
    const sharedCategory = existingCategories.find(c => c.name === "跨类型额外分类") || await (await context.request.post(url + "/api/categories", { headers, data: { name: "跨类型额外分类" } })).json();
    assert.ok(sharedCategory.id);
    async function verifySearchActions(asset) {
      await page.getByLabel("搜索素材", { exact: true }).fill(asset.name);
      await expect(page.locator(".asset-row")).toHaveCount(1);
      const revealUrl = url + `/api/assets/${asset.id}/reveal`;
      let revealed = 0;
      await page.route(revealUrl, route => { revealed++; return route.fulfill({ json: { ok: true, asset } }); });
      const reveal = page.getByRole("button", { name: "定位素材：" + asset.name, exact: true });
      await reveal.click();
      await expect(reveal).toBeEnabled();
      assert.equal(revealed, 1);
      await page.unroute(revealUrl);
      await expect(page.locator(".details.has-selection")).toHaveCount(0);
      const addTag = page.getByRole("button", { name: "添加素材标签：" + asset.name, exact: true });
      await addTag.click();
      const tagsDialog = page.getByRole("dialog", { name: "管理单个素材标签", exact: true });
      const nightTag = tagsDialog.getByRole("checkbox", { name: "素材标签：夜景", exact: true });
      await nightTag.setChecked(!asset.tags.includes("夜景"));
      await expect(tagsDialog.getByRole("button", { name: "完成", exact: true })).toBeEnabled();
      const tagged = await (await context.request.get(url + "/api/assets/" + asset.id)).json();
      assert.equal(tagged.tags.includes("夜景"), !asset.tags.includes("夜景"));
      await nightTag.setChecked(asset.tags.includes("夜景"));
      await expect(tagsDialog.getByRole("button", { name: "完成", exact: true })).toBeEnabled();
      await tagsDialog.getByRole("button", { name: "完成", exact: true }).click();
      const change = page.getByRole("button", { name: "修改分类：" + asset.name, exact: true });
      await change.click();
      const editor = page.getByRole("dialog", { name: "修改素材分类", exact: true });
      await editor.getByLabel("待确认主分类").fill("搜索分类");
      await editor.getByRole("option", { name: "搜索分类验收", exact: true }).click();
      await editor.getByLabel("待确认子类").fill("测试子类");
      await editor.getByRole("option", { name: "测试子类", exact: true }).click();
      await editor.getByRole("checkbox", { name: "归属分类：跨类型额外分类", exact: true }).check();
      await editor.getByRole("button", { name: "保存分类", exact: true }).click();
      await expect(editor).toHaveCount(0);
      const categorized = await (await context.request.get(url + "/api/assets/" + asset.id)).json();
      assert.equal(categorized.category, "搜索分类验收");
      assert.equal(categorized.kind, asset.kind);
      assert.equal(categorized.confirmed, asset.confirmed);
      assert.ok((await (await context.request.get(url + `/api/assets/${asset.id}/categories`)).json()).some(c => c.id === sharedCategory.id));
      await change.click();
      await expect(editor.getByRole("checkbox", { name: "归属分类：跨类型额外分类", exact: true })).toBeChecked();
      await editor.getByRole("button", { name: "展开主分类", exact: true }).click();
      await editor.getByRole("option", { name: asset.category || "未分类", exact: true }).click();
      if (asset.category) {
        await editor.getByRole("button", { name: "展开子类", exact: true }).click();
        await editor.getByRole("option", { name: asset.sub || "未选择子类", exact: true }).click();
      }
      await editor.getByRole("checkbox", { name: "归属分类：跨类型额外分类", exact: true }).uncheck();
      await editor.getByRole("button", { name: "保存分类", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await page.getByRole("button", { name: "删除素材：" + asset.name, exact: true }).click();
      const deleteDialog = page.getByRole("dialog", { name: "移入废纸篓", exact: true });
      await expect(deleteDialog).toContainText(asset.name);
      await deleteDialog.getByRole("button", { name: "取消", exact: true }).click();
      await fs.access(asset.path);
    }
    await verifySearchActions(a);
    await verifySearchActions(videos.items[0]);
    await verifySearchActions(heic);
    for (const width of [1024, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.getByRole("button", { name: "修改分类：" + heic.name, exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "search actions overflow at " + width);
      const toolbarBounds = await page.locator(".content-toolbar").boundingBox();
      const tableBounds = await page.locator(".table-head").boundingBox();
      assert.ok(toolbarBounds && tableBounds && toolbarBounds.y + toolbarBounds.height <= tableBounds.y, "toolbar overlaps search results at " + width);
      await page.screenshot({ path: path.join(out, name + "-search-actions-" + width + ".png") });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "网格视图", exact: true }).click();
    await expect(page.getByRole("button", { name: "添加素材标签：" + heic.name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "修改分类：" + heic.name, exact: true })).toBeVisible();
    await page.screenshot({ path: path.join(out, name + "-search-actions-grid.png") });
    await page.getByRole("button", { name: "列表视图", exact: true }).click();
    await page.getByLabel("搜索素材", { exact: true }).fill("");
    const preview = await context.request.get(
      url + "/api/media/" + heic.id + "/thumb",
    );
    assert.equal(preview.status(), 200);
    assert.match(preview.headers()["content-type"], /image\/jpeg/);
    const exported = await context.request.get(url + "/api/export");
    assert.equal(exported.status(), 200);
    assert.match(await exported.text(), /测试备注/);
    const check = await context.request.post(url + "/api/operations/preview", {
      headers,
      data: { ids: [a.id], action: "move", rootId: destRoot.id },
    });
    assert.equal(check.status(), 200);
    const confirmed = await check.json();
    const move = await context.request.post(url + "/api/operations", {
      headers,
      data: { confirmation: confirmed.confirmation },
    });
    assert.equal((await move.json())[0].ok, true);
    await fs.access(path.join(destination, a.name));
    const op = (
      await (await context.request.get(url + "/api/operations")).json()
    ).find((o) => o.action === "move" && !o.undone);
    const restore = await context.request.post(
      url + "/api/operations/" + op.id + "/undo",
      { headers, data: {} },
    );
    assert.equal(restore.status(), 200);
    await fs.access(path.join(source, a.name));
    await context.request.patch(url + "/api/assets/" + a.id, {
      headers,
      data: { kind: "music", category: "管理分类原始" },
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await verifySearchActions(await (await context.request.get(url + "/api/assets/" + a.id)).json());
    await page.locator(".nav-item").filter({ hasText: "分类管理" }).click();
    await page
      .getByRole("heading", { name: "分类管理", exact: true })
      .waitFor();
    await expect(page.getByLabel("分类素材类型")).toHaveValue("");
    for (const [kind, count] of [["photo", 2], ["video", 1], ["sfx", 1]]) {
      await page.getByLabel("分类素材类型").selectOption(kind);
      await expect(page.locator(".category-music-row")).toHaveCount(count);
    }
    await page.getByLabel("分类素材类型").selectOption("");
    await expect(page.locator(".category-music-row")).toHaveCount(5);
    await page.screenshot({ path: path.join(out, name + "-unified-categories.png") });
    await page.getByLabel("分类素材类型").selectOption("music");
    await page.getByRole("button", { name: "新建分类", exact: true }).click();
    await page.getByLabel("素材分类名称", { exact: true }).fill("分类管理测试");
    await page.getByRole("button", { name: "保存分类", exact: true }).click();
    await expect(
      page
        .locator(".category-content")
        .getByRole("heading", { name: "分类管理测试", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "新建子类", exact: true }).click();
    await page.getByLabel("子类名称", { exact: true }).fill("管理子类测试");
    await page.getByRole("button", { name: "保存子类", exact: true }).click();
    await expect(page.getByRole("button", { name: "重命名子类：管理子类测试", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重命名子类：管理子类测试", exact: true }).click();
    await page.getByLabel("子类名称", { exact: true }).fill("管理子类改名");
    await page.getByRole("button", { name: "保存子类", exact: true }).click();
    await expect(page.getByRole("button", { name: "删除子类：管理子类改名", exact: true })).toBeVisible();
    await page.getByLabel("筛选子类", { exact: true }).selectOption({ label: "管理子类改名（0）" });
    await expect(page.locator(".category-music-row")).toHaveCount(0);
    await page.screenshot({ path: path.join(out, name + "-subcategory-manager.png") });
    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "删除子类：管理子类改名", exact: true }).click();
    await expect(page.getByRole("button", { name: "删除子类：管理子类改名", exact: true })).toHaveCount(0);
    await expect(page.getByLabel("筛选子类", { exact: true })).toHaveValue("");
    await page
      .getByRole("button", { name: "重命名素材分类", exact: true })
      .click();
    await page.getByLabel("素材分类名称", { exact: true }).fill("分类管理改名");
    await page.getByRole("button", { name: "保存分类", exact: true }).click();
    await expect(
      page
        .locator(".category-content")
        .getByRole("heading", { name: "分类管理改名", exact: true }),
    ).toBeVisible();
    await page
      .locator(".category-entry")
      .filter({ hasText: "管理分类原始" })
      .click();
    await verifyManagerFileActions("category");
    await page
      .getByRole("checkbox", { name: "勾选分类素材：" + a.name, exact: true })
      .check();
    const managedCats = await (
      await context.request.get(url + "/api/categories")
    ).json();
    const managed = managedCats.find((c) => c.name === "分类管理改名");
    await page
      .getByRole("button", { name: "添加素材分类：" + a.name, exact: true })
      .click();
    const quickDialog = page.getByRole("dialog", {
      name: "添加到其他素材分类",
      exact: true,
    });
    const quickTarget = quickDialog
      .locator(".quick-category-option")
      .filter({ hasText: "分类管理改名" });
    await quickTarget.click();
    await expect(quickTarget).toBeDisabled();
    await expect(quickTarget).toContainText("已包含");
    assert.equal(
      (await (await context.request.get(url + "/api/assets/" + a.id)).json())
        .category,
      "管理分类原始",
    );
    assert.equal(
      (
        await (
          await context.request.get(
            url + "/api/assets/" + a.id + "/categories",
          )
        ).json()
      ).length,
      2,
    );
    await page.screenshot({
      path: path.join(out, name + "-quick-category.png"),
    });
    await quickDialog
      .getByRole("button", { name: "完成", exact: true })
      .click();
    await expect(page.locator(".category-music-row")).toHaveCount(1);
    await page
      .getByLabel("目标素材分类", { exact: true })
      .selectOption(managed.id);
    await page.getByRole("button", { name: "设为主分类", exact: true }).click();
    await expect(page.locator(".category-music-row")).toHaveCount(0);
    await page
      .locator(".category-entry")
      .filter({ hasText: "分类管理改名" })
      .click();
    await expect(page.locator(".category-music-row")).toHaveCount(1);
    await page
      .getByRole("button", { name: "试听素材：" + a.name, exact: true })
      .click();
    await page.waitForFunction(() => {
      const a = document.querySelector("audio");
      return a && !a.paused;
    });
    await page
      .getByRole("button", { name: "暂停素材：" + a.name, exact: true })
      .click();
    await page.screenshot({
      path: path.join(out, name + "-category-manager.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "category manager mobile overflow",
    );
    await page.screenshot({
      path: path.join(out, name + "-category-manager-mobile.png"),
    });
    await page
      .getByRole("button", { name: "删除素材分类", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认删除分类", exact: true })
      .click();
    await expect(
      page
        .locator(".category-content")
        .getByRole("heading", { name: "未分类", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".category-music-row")).toHaveCount(1);
    assert.equal(
      (await (await context.request.get(url + "/api/assets/" + a.id)).json())
        .category,
      "",
    );
    await fs.access(path.join(source, a.name));
    const searchCategory = await (
      await context.request.post(url + "/api/categories", {
        headers,
        data: { name: "搜索快速分类" },
      })
    ).json();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".nav-item").filter({ hasText: "全部素材" }).click();
    await page.getByLabel("搜索素材", { exact: true }).fill(a.name);
    await expect(page.locator(".asset-row")).toHaveCount(1);
    await page
      .getByRole("button", { name: "添加素材分类：" + a.name, exact: true })
      .click();
    const searchDialog = page.getByRole("dialog", {
      name: "添加到其他素材分类",
      exact: true,
    });
    const searchTarget = searchDialog
      .locator(".quick-category-option")
      .filter({ hasText: "搜索快速分类" });
    await searchTarget.click();
    await expect(searchTarget).toBeDisabled();
    await searchDialog
      .getByRole("button", { name: "完成", exact: true })
      .click();
    await page.locator(".asset-row").first().click();
    await page
      .getByRole("button", { name: "给选中素材添加分类", exact: true })
      .click();
    await expect(
      searchDialog
        .locator(".quick-category-option")
        .filter({ hasText: "搜索快速分类" }),
    ).toContainText("已包含");
    await page.screenshot({
      path: path.join(out, name + "-search-quick-category.png"),
    });
    await searchDialog
      .getByRole("button", { name: "完成", exact: true })
      .click();
    await context.request.delete(
      url + "/api/categories/" + searchCategory.id,
      { headers, data: {} },
    );
    await context.request.patch(url + "/api/assets/" + a.id, {
      headers,
      data: { kind: "sfx", category: a.category },
    });
    for (const c of managedCats.filter((c) => c.name === "管理分类原始"))
      await context.request.delete(url + "/api/categories/" + c.id, {
        headers,
        data: {},
      });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".nav-item").filter({ hasText: "标签管理" }).click();
    await page.getByRole("button", { name: "新建标签", exact: true }).click();
    await page.getByLabel("标签名称", { exact: true }).fill("标签管理验收");
    await page.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(
      page
        .locator(".category-content")
        .getByRole("heading", { name: "标签管理验收", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".category-music-row")).toHaveCount(0);
    await page
      .locator(".tag-manager .category-entry")
      .filter({ hasText: "全部素材" })
      .click();
    await page.getByLabel("搜索标签中的素材", { exact: true }).fill(a.name);
    await expect(page.locator(".category-music-row")).toHaveCount(1);
    await verifyManagerFileActions("tag");
    await page
      .getByRole("checkbox", { name: "勾选标签素材：" + a.name, exact: true })
      .check();
    const tagItems = await (
      await context.request.get(url + "/api/tags")
    ).json();
    const createdTag = tagItems.find((t) => t.name === "标签管理验收");
    await page
      .getByLabel("目标标签", { exact: true })
      .selectOption(createdTag.id);
    await page.getByRole("button", { name: "添加标签", exact: true }).click();
    await page
      .locator(".tag-manager .category-entry")
      .filter({ hasText: "标签管理验收" })
      .click();
    await expect(page.locator(".category-music-row")).toHaveCount(1);
    await page.getByRole("button", { name: "重命名标签", exact: true }).click();
    await page.getByLabel("标签名称", { exact: true }).fill("标签已改名");
    await page.getByRole("button", { name: "保存标签", exact: true }).click();
    await expect(page.locator(".category-music-row")).toContainText(
      "标签已改名",
    );
    await page
      .getByRole("button", { name: "管理素材标签：" + a.name, exact: true })
      .click();
    const quickTags = page.getByRole("dialog", {
      name: "管理单个素材标签",
      exact: true,
    });
    await expect(
      quickTags.getByRole("checkbox", {
        name: "素材标签：标签已改名",
        exact: true,
      }),
    ).toBeChecked();
    await quickTags
      .getByLabel("搜索或新建素材标签", { exact: true })
      .fill("快捷新增标签");
    await quickTags.getByRole("button", { name: /新建并添加/ }).click();
    await expect(
      quickTags.getByRole("checkbox", {
        name: "素材标签：快捷新增标签",
        exact: true,
      }),
    ).toBeChecked();
    await quickTags
      .getByRole("checkbox", { name: "素材标签：快捷新增标签", exact: true })
      .uncheck();
    await expect(
      quickTags.getByRole("checkbox", {
        name: "素材标签：快捷新增标签",
        exact: true,
      }),
    ).not.toBeChecked();
    await expect(
      quickTags.getByRole("checkbox", {
        name: "素材标签：标签已改名",
        exact: true,
      }),
    ).toBeChecked();
    await page.screenshot({
      path: path.join(out, name + "-optimized-quick-tags.png"),
    });
    await quickTags.getByRole("button", { name: "完成", exact: true }).click();
    const extraTag = (
      await (await context.request.get(url + "/api/tags")).json()
    ).find((t) => t.name === "快捷新增标签");
    await context.request.delete(url + "/api/tags/" + extraTag.id, {
      headers,
      data: {},
    });
    await page
      .getByLabel("筛选标签素材类型", { exact: true })
      .selectOption("photo");
    await expect(page.locator(".category-music-row")).toHaveCount(0);
    await page.getByLabel("筛选标签素材类型", { exact: true }).selectOption("");
    await expect(page.locator(".category-music-row")).toHaveCount(1);
    await page.screenshot({ path: path.join(out, name + "-tag-manager.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "tag manager mobile overflow",
    );
    await page.screenshot({
      path: path.join(out, name + "-tag-manager-mobile.png"),
    });
    await page
      .getByRole("button", { name: "移除当前标签：" + a.name, exact: true })
      .click();
    await expect(page.locator(".category-music-row")).toHaveCount(0);
    await page.getByRole("button", { name: "删除标签", exact: true }).click();
    await page
      .getByRole("button", { name: "确认删除标签", exact: true })
      .click();
    await expect(
      page
        .locator(".category-content")
        .getByRole("heading", { name: "全部素材", exact: true }),
    ).toBeVisible();
    assert.equal(
      (
        await (await context.request.get(url + "/api/assets/" + a.id)).json()
      ).tags.includes("标签已改名"),
      false,
    );
    await fs.access(path.join(source, a.name));
    await page.setViewportSize({ width: 1440, height: 900 });
    await context.request.patch(url + "/api/assets/" + a.id, {
      headers,
      data: { kind: "music", tags: [] },
    });
    await page
      .getByRole("button", { name: "连续标记音乐", exact: true })
      .click();
    await expect(page.locator(".queue-track h2")).toHaveText(a.name);
    await expect(
      page.getByRole("button", { name: "保存并下一首", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "分析当前音乐", exact: true }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "配置 API Key", exact: true })
      .click();
    const aiSettings = page.getByRole("dialog", {
      name: "OpenAI 音乐分析设置",
      exact: true,
    });
    const initialTest = await (
      await context.request.post(url + "/api/openai/test", {
        headers,
        data: {},
      })
    ).json();
    assert.equal(initialTest.ok, false);
    assert.equal(initialTest.diagnostic.code, "not_configured");
    await aiSettings
      .getByLabel("OpenAI API Key", { exact: true })
      .fill("sk-local-browser-fixture-not-real");
    await aiSettings
      .getByRole("button", { name: "保存密钥", exact: true })
      .click();
    await expect(aiSettings.getByRole("status")).toHaveText(
      "密钥已保存，尚未调用 API",
    );
    await expect(
      aiSettings.getByLabel("OpenAI API Key", { exact: true }),
    ).toHaveValue("");
    assert.equal(
      (await (await context.request.get(url + "/api/openai")).json()).hasKey,
      true,
    );
    await page.route("**/api/openai/test", async (route) => {
      await route.fulfill({ json: initialTest });
    });
    await aiSettings
      .getByRole("button", { name: "测试连接", exact: true })
      .click();
    await expect(aiSettings.getByRole("status")).toContainText(
      "请先保存 API Key",
    );
    await page.unroute("**/api/openai/test");
    await aiSettings
      .getByRole("button", { name: "查看诊断日志", exact: true })
      .click();
    await expect(aiSettings.locator(".diagnostic-entry").first()).toContainText(
      "连接测试失败",
    );
    await aiSettings.locator(".diagnostic-entry summary").first().click();
    await expect(
      aiSettings.locator(".diagnostic-entry pre").first(),
    ).toContainText("not_configured");
    const downloadEvent = page.waitForEvent("download");
    await aiSettings
      .getByRole("button", { name: "导出脱敏日志", exact: true })
      .click();
    const exportText = await fs.readFile(
      await (await downloadEvent).path(),
      "utf8",
    );
    assert.ok(!exportText.includes("sk-local-browser-fixture-not-real"));
    assert.ok(exportText.includes("not_configured"));
    await page.screenshot({
      path: path.join(out, name + "-openai-diagnostics.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "diagnostics mobile overflow",
    );
    await page.screenshot({
      path: path.join(out, name + "-openai-diagnostics-mobile.png"),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await aiSettings
      .getByRole("button", { name: "关闭音乐分析设置", exact: true })
      .click();
    const fixtureAnalysis = {
      summary: "测试音频分析结果",
      mood: "紧张",
      style: "电子",
      instruments: "合成器",
      rhythm: "规律",
      energy: "中等",
      uses: "悬疑铺垫",
      limitations: "仅当前片段",
      tags: ["紧张", "电子"],
      note: "测试建议备注",
      model: "gpt-audio-1.5",
      start: 0,
      duration: 2,
      createdAt: new Date().toISOString(),
      cached: false,
    };
    // Stub only the model call: browser QA never uploads audio or uses paid APIs.
    const analysisPattern = "**/api/assets/" + a.id + "/analysis";
    await page.route(analysisPattern, async (route) => {
      assert.equal(route.request().method(), "POST");
      assert.equal(route.request().postDataJSON().consent, true);
      await route.fulfill({ json: fixtureAnalysis });
    });
    await page
      .getByRole("button", { name: "分析当前音乐", exact: true })
      .click();
    await expect(page.locator(".analysis-result")).toContainText(
      "测试音频分析结果",
    );
    assert.deepEqual(
      (await (await context.request.get(url + "/api/assets/" + a.id)).json())
        .tags,
      [],
    );
    await page
      .getByRole("checkbox", { name: "同时采用建议备注", exact: true })
      .check();
    await page
      .getByRole("button", { name: "采用勾选建议", exact: true })
      .click();
    await expect(
      page.getByLabel("连续标记备注", { exact: true }),
    ).toContainText("测试建议备注");
    await expect(
      page.getByRole("checkbox", { name: "连续标记标签：紧张", exact: true }),
    ).toBeChecked();
    await page.screenshot({
      path: path.join(out, name + "-music-ai-analysis.png"),
    });
    await page.unroute(analysisPattern);
    await context.request.delete(url + "/api/openai/config", {
      headers,
      data: {},
    });
    await page
      .getByRole("checkbox", { name: "连续标记标签：紧张", exact: true })
      .check();
    await page.getByLabel("连续标记新标签", { exact: true }).fill("短剧反转");
    await page
      .locator(".queue-new-tag")
      .getByRole("button", { name: "添加", exact: true })
      .click();
    await page
      .getByLabel("连续标记备注", { exact: true })
      .fill("测试连续标记备注");
    await page.screenshot({
      path: path.join(out, name + "-music-tag-queue.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "music queue mobile overflow",
    );
    await page.screenshot({
      path: path.join(out, name + "-music-tag-queue-mobile.png"),
    });
    await page
      .getByRole("button", { name: "保存并下一首", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "暂无未标记音乐", exact: true }),
    ).toBeVisible();
    const saved = await (
      await context.request.get(url + "/api/assets/" + a.id)
    ).json();
    assert.ok(saved.tags.includes("紧张") && saved.tags.includes("短剧反转"));
    assert.equal(saved.note, "测试连续标记备注");
    // Simulate a newly indexed music item while the empty queue stays open.
    const increment = (
      await (await context.request.get(url + "/api/assets?kind=sfx")).json()
    ).items[0];
    assert.ok(increment);
    await context.request.patch(url + "/api/assets/" + increment.id, {
      headers,
      data: { kind: "music", tags: [] },
    });
    await expect(page.locator(".queue-track h2")).toHaveText(increment.name, {
      timeout: 12000,
    });
    await page.getByRole("button", { name: "暂时跳过", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "本轮已处理完，其余音乐已跳过",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "重新查看跳过项", exact: true })
      .click();
    await expect(page.locator(".queue-track h2")).toHaveText(increment.name);
    await page
      .getByRole("button", { name: "沿用上一首标签", exact: true })
      .click();
    await expect(
      page.getByRole("checkbox", { name: "连续标记标签：紧张", exact: true }),
    ).toBeChecked();
    await page
      .getByRole("button", { name: "保存并下一首", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "暂无未标记音乐", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "返回标签管理", exact: true })
      .click();
    await context.request.patch(url + "/api/assets/" + increment.id, {
      headers,
      data: { kind: increment.kind, tags: increment.tags },
    });
    await context.request.patch(url + "/api/assets/" + a.id, {
      headers,
      data: { kind: a.kind, tags: a.tags, note: a.note },
    });
    // Only disposable test files participate in missing-record cleanup.
    await page.setViewportSize({ width: 1440, height: 1000 });
    const missingName = `缓存核验-${name}.wav`;
    const missingPath = path.join(source, missingName);
    const originalBytes = await fs.readFile(path.join(source, "风声 测试.wav"));
    await fs.writeFile(missingPath, originalBytes);
    await context.request.post(url + "/api/roots/" + soundRoot.id + "/scan", { headers, data: {} });
    await expect.poll(async () => (await (await context.request.get(url + "/api/jobs")).json()).jobs.some(j => j.status === "running")).toBe(false);
    const missingAsset = (await (await context.request.get(url + "/api/assets?q=" + encodeURIComponent(missingName))).json()).items[0];
    assert.ok(missingAsset);
    await context.request.patch(url + "/api/assets/" + missingAsset.id, { headers, data: { tags: ["不得丢失"], note: "缓存测试" } });
    await fs.unlink(missingPath);
    await page.reload();
    await page.locator("nav .nav-item").filter({ hasText: "全部素材" }).click();
    await page.getByRole("button", { name: "更多素材操作", exact: true }).click();
    await page.getByRole("button", { name: "检查文件状态", exact: true }).click();
    await expect.poll(async () => (await (await context.request.get(url + "/api/assets/" + missingAsset.id)).json()).file_status).toBe("missing");
    await page.locator("nav .nav-item").filter({ hasText: "失效素材" }).click();
    const missingRow = page.locator(".asset-row").filter({ hasText: missingName });
    await expect(page.locator(".asset-row")).toHaveCount(1);
    await expect(missingRow).toContainText(missingPath);
    await expect(missingRow).toContainText("上次检查");
    await page.screenshot({ path: path.join(out, name + "-missing-desktop.png") });
    await missingRow.getByRole("button", { name: "清理失效记录：" + missingName, exact: true }).click();
    const cleanupDialog = page.getByRole("dialog", { name: "确认清理失效记录" });
    await expect(cleanupDialog.getByRole("button", { name: "确认清理关联记录", exact: true })).toBeEnabled();
    await cleanupDialog.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal((await (await context.request.get(url + "/api/assets/" + missingAsset.id)).json()).note, "缓存测试");
    await missingRow.getByRole("button", { name: "清理失效记录：" + missingName, exact: true }).click();
    await expect(cleanupDialog.getByRole("button", { name: "确认清理关联记录", exact: true })).toBeEnabled();
    await fs.writeFile(missingPath, originalBytes);
    await cleanupDialog.getByRole("button", { name: "确认清理关联记录", exact: true }).click();
    await expect(cleanupDialog).toContainText("已清理 0 条，保留 1 条");
    assert.deepEqual((await (await context.request.get(url + "/api/assets/" + missingAsset.id)).json()).tags, ["不得丢失"]);
    await cleanupDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await fs.unlink(missingPath);
    await page.getByRole("button", { name: "更多素材操作", exact: true }).click();
    await page.getByRole("button", { name: "检查文件状态", exact: true }).click();
    await expect(missingRow).toBeVisible();
    await missingRow.getByRole("button", { name: "清理失效记录：" + missingName, exact: true }).click();
    await expect(cleanupDialog.getByRole("button", { name: "确认清理关联记录", exact: true })).toBeEnabled();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({ path: path.join(out, name + "-missing-confirm-mobile.png") });
    assert.ok(await cleanupDialog.evaluate(el => el.getBoundingClientRect().right <= innerWidth));
    await cleanupDialog.getByRole("button", { name: "确认清理关联记录", exact: true }).click();
    await expect(cleanupDialog).toContainText("已清理 1 条，保留 0 条");
    assert.equal((await context.request.post(url + "/api/maintenance/files/cleanup", { headers, data: { confirmation: "invalid" } })).status(), 400);
    assert.ok((await fs.readdir(path.join(data, "missing-file-backups"))).length > 0);
    await fs.access(path.join(source, "风声 测试.wav"));
    await cleanupDialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    const duplicatePath = path.join(source, "重复检测副本-" + name + ".wav");
    await fs.writeFile(duplicatePath, originalBytes);
    await context.request.post(url + "/api/roots/" + soundRoot.id + "/scan", { headers, data: {} });
    await expect.poll(async () => (await (await context.request.get(url + "/api/jobs")).json()).jobs.some(j => j.status === "running")).toBe(false);
    const duplicateAsset = (await (await context.request.get(url + "/api/assets?q=" + encodeURIComponent("重复检测副本-" + name))).json()).items[0];
    const duplicateOriginal = (await (await context.request.get(url + "/api/assets?q=" + encodeURIComponent("风声 测试.wav"))).json()).items[0];
    await page.locator("nav .nav-item").filter({ hasText: "重复音频" }).click();
    await expect(page.getByRole("heading", { name: "重复音频", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "开始检查", exact: true }).click();
    await expect(page.locator(".duplicate-stats")).toBeVisible();
    await expect(page.locator(".duplicate-stats").first()).toContainText("重复组");
    await expect(page.locator(".duplicate-file")).toHaveCount(2);
    await page.getByRole("button", { name: "试听重复音频：" + duplicateAsset.name, exact: true }).click();
    await expect.poll(() => page.locator("audio").evaluate(el => !el.paused)).toBe(true);
    await expect.poll(async () => (await (await context.request.get(url + "/api/jobs")).json()).jobs.some(j => j.status === "running")).toBe(false);
    page.once("dialog", d => d.accept());
    await page.getByRole("button", { name: "标记重复音频", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "新增标记 2 个" })).toBeVisible();
    await expect(page.locator(".duplicate-badge")).toHaveCount(2);
    assert.ok((await (await context.request.get(url + "/api/assets/" + duplicateAsset.id)).json()).tags.includes("重复音频"));
    await page.screenshot({ path: path.join(out, name + "-duplicate-audio.png") });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "duplicate audio overflow at " + width);
      await page.screenshot({ path: path.join(out, name + "-duplicate-audio-" + width + ".png") });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const duplicateReveal = page.getByRole("button", { name: "定位重复音频：" + duplicateAsset.name, exact: true });
    await duplicateReveal.click();
    await expect.poll(async () => (await (await context.request.get(url + "/api/assets/" + duplicateAsset.id)).json()).reveal_count).toBe(1);
    const duplicateDelete = page.getByRole("button", { name: "删除重复音频：" + duplicateAsset.name, exact: true });
    await duplicateDelete.click();
    const duplicateTrashDialog = page.getByRole("dialog", { name: "移入废纸篓", exact: true });
    await expect(duplicateTrashDialog).toContainText(duplicateAsset.name);
    await duplicateTrashDialog.getByRole("button", { name: "取消", exact: true }).click();
    await fs.access(duplicatePath);
    assert.equal((await (await context.request.get(url + "/api/assets/" + duplicateAsset.id)).json()).trashed, 0);
    await duplicateDelete.click();
    await duplicateTrashDialog.getByRole("button", { name: "检查目标路径", exact: true }).click();
    await expect(duplicateTrashDialog).toContainText(duplicatePath);
    await page.setViewportSize({ width: 320, height: 844 });
    await page.screenshot({ path: path.join(out, name + "-duplicate-trash-mobile.png") });
    await duplicateTrashDialog.getByRole("button", { name: "确认移入废纸篓", exact: true }).click();
    await expect(duplicateTrashDialog).toHaveCount(0);
    await expect(page.locator(".duplicate-file")).toHaveCount(0);
    await expect(page.locator(".duplicate-stats > div").first()).toContainText("0");
    const survivorAfterTrash = (await (await context.request.get(url + "/api/assets/" + duplicateOriginal.id)).json());
    assert.deepEqual(survivorAfterTrash.tags, duplicateOriginal.tags.filter(t => t !== "重复音频"), "最后一个副本应移除重复标签，保留其他标签");
    assert.ok((await (await context.request.get(url + "/api/assets/" + duplicateAsset.id)).json()).tags.includes("重复音频"), "废纸篓记录不应被清理标签");
    await assert.rejects(fs.access(duplicatePath)); await fs.access(duplicateOriginal.path);
    const duplicateTrashOp = (await (await context.request.get(url + "/api/operations")).json()).find(op => op.asset_id === duplicateAsset.id && op.action === "trash" && !op.undone);
    assert.ok(duplicateTrashOp);
    assert.equal((await context.request.post(url + "/api/operations/" + duplicateTrashOp.id + "/undo", { headers, data: {} })).status(), 200);
    await fs.access(duplicatePath);
    await page.getByRole("button", { name: "刷新检测结果", exact: true }).click();
    await expect(page.locator(".duplicate-file")).toHaveCount(2);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const previousDuplicateReport = (await (await context.request.get(url + "/api/duplicate-audio?scope=sfx")).json()).report.id;
    await page.getByRole("button", { name: "开始检查", exact: true }).click();
    await expect.poll(async () => { const current = await (await context.request.get(url + "/api/duplicate-audio?scope=sfx")).json(); return !current.active && current.report?.id !== previousDuplicateReport; }).toBe(true);
    await expect.poll(async () => (await (await context.request.get(url + "/api/duplicate-audio?scope=sfx")).json()).report?.cached || 0).toBeGreaterThan(0);
    await context.request.patch(url + "/api/assets/" + duplicateOriginal.id, { headers, data: { tags: duplicateOriginal.tags } });
    await fs.unlink(duplicatePath);
    await context.request.post(url + "/api/maintenance/files", { headers, data: { force: true } });
    const duplicateCleanup = await (await context.request.post(url + "/api/maintenance/files/cleanup/preview", { headers, data: { ids: [duplicateAsset.id] } })).json();
    assert.equal((await (await context.request.post(url + "/api/maintenance/files/cleanup", { headers, data: { confirmation: duplicateCleanup.confirmation } })).json()).removed, 1);
    // 加载与处理中的反馈：首屏转圈、列表内联"读取中…"、扫描中的提示与轮询
    {
      const slow = await context.newPage();
      slow.on("pageerror", (e) => errors.push(e.message));
      // 首屏慢：应看到全屏转圈
      await slow.route("**/api/session", async (route) => {
        await new Promise((r) => setTimeout(r, 900));
        await route.continue();
      });
      await slow.goto(url);
      await slow.locator(".work-overlay .spinner").waitFor({ timeout: 15000 });
      assert.equal((await slow.locator(".work-card p").innerText()).trim(), "正在读取素材库…");
      await slow.locator(".work-overlay").waitFor({ state: "detached", timeout: 25000 });

      // 列表读取慢：应看到内联"读取中…"且 main 标记 aria-busy
      await slow.route("**/api/assets?*", async (route) => {
        await new Promise((r) => setTimeout(r, 700));
        await route.continue();
      });
      await slow.getByRole("button", { name: "管理素材目录", exact: true }).click().catch(() => {});
      await slow.keyboard.press("Escape");
      await slow.locator(".sidebar").getByRole("button", { name: /全部素材/ }).first().click();
      await slow.getByRole("button", { name: "刷新索引显示", exact: true }).click();
      await slow.locator(".inline-loading").waitFor({ timeout: 10000 });
      assert.equal(await slow.locator("main").getAttribute("aria-busy"), "true");
      await slow.locator(".inline-loading").waitFor({ state: "detached", timeout: 20000 });

      // 列表容器内的蒙层（Element v-loading 效果）：盖住列表内容、居中转圈、拦截点击
      await slow.getByPlaceholder("搜索名称、标签或备注").fill("音效");
      await slow.locator(".table-mask").waitFor({ timeout: 12000 });
      assert.equal(await slow.locator(".table-mask .spinner").count(), 1);
      const maskCovers = await slow.evaluate(() => {
        const row = document.querySelector(".asset-row");
        const mask = document.querySelector(".table-mask");
        if (!row || !mask) return false;
        const r = row.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + 24, r.top + 8);
        return !!(hit && hit.closest(".table-mask"));
      });
      assert.ok(maskCovers, "蒙层应盖住列表内容并拦截点击");
      await slow.locator(".table-mask").waitFor({ state: "detached", timeout: 20000 });

      // 扫描进行中：顶栏提示带转圈，并且会轮询任务状态（否则进度不会自己更新）
      let jobPolls = 0;
      await slow.route("**/api/jobs", async (route) => {
        jobPolls++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            jobs: [{ id: "qa-job", rootId: null, type: "scan", status: "running", count: 1, errors: [] }],
            metadata: { pending: 0 },
          }),
        });
      });
      await slow.getByRole("button", { name: "刷新索引显示", exact: true }).click();
      await slow.locator(".work-pill").waitFor({ timeout: 10000 });
      assert.equal(await slow.locator(".work-pill .spinner").count(), 1);
      await new Promise((r) => setTimeout(r, 3500));
      assert.ok(jobPolls >= 2, `扫描进行中应轮询任务状态，实际 ${jobPolls} 次`);
      await slow.close();
    }
    assert.deepEqual(errors, []);
    results.push({
      browser: name,
      passed: true,
      tests: [
        "移动目标文件夹浏览、面包屑同层选择、后退前进、搜索、新建重名拦截、真实移动及元数据保留、窄屏适配",
        "文件夹模式移除旧分类/额外分类入口，新增单文件移动确认，保存标签不提交旧分类字段；旧模式保留",
        "真实文件夹多级/空目录浏览、面包屑、子树范围、搜索、照片预览及旧分类一键回切持久化",
        "分层筛选折叠、条件逐项清除、音乐音效独立记忆、显示和维护菜单",
        "侧栏折叠、导航显隐勾选、刷新保留、恢复全部与手机遮罩",
        "1440/1280/1024导航布局无横向溢出、底部设置入口可见",
        "连续试听、键盘防误触、波形定位及选段循环",
        "播完自动下一条、跨页连播、末尾停止与循环互斥",
        "80/300/800毫秒短音频连播暂停、加载中暂停、键盘暂停及取消跨页自动播放",
        "项目新建、候选幂等添加、批量使用、备注历史、持久化、移动端及删除不动原文件",
        "项目类型筛选与统计、筛选后清空勾选、照片视频预览及组合搜索",
        "精简操作菜单、标签全部/任意/排除组合、编辑后状态同步",
        "64条候选跨页切歌、滚动位置及筛选保留",
        "搜索",
        "点击名称编辑弹窗、标签备注持久化、改名确认及窄屏显示",
        "试听",
        "波形",
        "标签持久化",
        "改名撤销",
        "照片",
        "视频",
        "移动恢复",
        "导出",
        "会话校验",
        "跨站拒绝",
        "Range",
        "手机布局",
        "连续音乐打标与备注保存",
        "增量音乐自动入队",
        "跳过重访与沿用标签",
        "AI 设置与建议采用（模拟模型，无上传）",
        "连接测试入口、诊断日志查看与脱敏导出（无外网调用）",
        "失效记录仅标记、取消清理、文件恢复保护、确认清理和移动端弹窗",
        "加载与处理中的转圈与禁用：首屏遮罩、列表容器蒙层与点击拦截、内联读取提示、扫描中提示与任务轮询",
      ],
    });
  } finally {
    await browser.close();
  }
}
try {
  if (!process.argv.includes("--only-webkit")) await verify(chromium, "chrome", {
    executablePath:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  if (process.argv.includes("--webkit") || process.argv.includes("--only-webkit")) await verify(webkit, "webkit", {});
  await fs.writeFile(
    path.join(out, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results, null, 2));
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
  await fs.rm(base, { recursive: true, force: true });
}
