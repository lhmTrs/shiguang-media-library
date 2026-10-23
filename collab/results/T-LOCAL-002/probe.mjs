// T-LOCAL-002 窄屏 DOM/截图证据探针（一次性隔离夹具，headless WebKit）。
// 运行：node collab/results/T-LOCAL-002/probe.mjs
import { webkit } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { Library, run } from "../../../server/library.mjs";

const project = path.resolve(import.meta.dirname, "../../..");
const out = path.join(project, "collab/results/T-LOCAL-002");
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tl002-probe-")));
const source = path.join(base, "音效 测试");
const photos = path.join(base, "摄影素材");
await fs.mkdir(source);
await fs.mkdir(photos);
await fs.mkdir(path.join(source, "转场", "呼啸", "快速"), { recursive: true });
await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", path.join(source, "风声 测试.wav")]);
await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-c:a", "libmp3lame", path.join(source, "第二段 音效.mp3")]);
await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(photos, "摄影片段.mp4")]);
await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=640x420", "-frames:v", "1", path.join(photos, "测试照片.jpg")]);
await run("exiftool", ["-overwrite_original", "-DateTimeOriginal=2026:10:12 10:20:30", "-OffsetTimeOriginal=+08:00", path.join(photos, "测试照片.jpg")]);
await run("sips", ["-s", "format", "heic", path.join(photos, "测试照片.jpg"), "--out", path.join(photos, "测试照片.heic")]);
const data = path.join(base, "data");
const library = await new Library(data).init();
library.enqueue = () => {};
const soundRoot = await library.addRoot(source, "sfx");
const photoRoot = await library.addRoot(photos, "mixed");
for (const r of [soundRoot, photoRoot]) {
  const j = library.scan(r.id, new Map());
  while (j.status === "running") await new Promise(r => setTimeout(r, 20));
  if (j.status !== "done") throw new Error("scan failed");
}
const setTags = library.db.prepare("UPDATE assets SET tags=? WHERE name=?");
setTags.run('["环境","自然","风声"]', "风声 测试.wav");
setTags.run('["音效","环境","测试"]', "第二段 音效.mp3");
setTags.run('["摄影","测试","旅行"]', "测试照片.jpg");
library.db.close();
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: project,
  env: { ...process.env, NODE_ENV: "production", MEDIA_DATA_DIR: data, MEDIA_SKIP_IMPORT: "1", PORT: "4611" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", b => (logs += b));
server.stderr.on("data", b => (logs += b));
let url;
for (let n = 0; n < 100; n++) {
  await new Promise(r => setTimeout(r, 200));
  const m = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
  if (m) { url = m[0]; break; }
  if (server.exitCode !== null) throw Error(logs);
}
if (!url) throw Error("server timeout: " + logs);

const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", e => errors.push(e.message));
const thresholds = [[1440, 900], [1280, 800], [1024, 768], [390, 844], [320, 844]];
const audits = [];
const failures = [];

function audit(label, width) {
  return page.evaluate(({ label, width }) => {
    const vw = innerWidth;
    const rect = el => { const r = el.getBoundingClientRect(); return { left: +r.left.toFixed(1), top: +r.top.toFixed(1), right: +r.right.toFixed(1), bottom: +r.bottom.toFixed(1), width: +r.width.toFixed(1), height: +r.height.toFixed(1) }; };
    const describe = el => ({ tag: el.tagName.toLowerCase(), cls: typeof el.className === "string" ? el.className : "", text: (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50), ...rect(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
    const overflow = [...document.querySelectorAll("body *")].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5); }).slice(0, 12).map(describe);
    const controls = [...document.querySelectorAll(".content-toolbar .series-mode, .content-toolbar > div:last-child > select, .content-toolbar > div:last-child > .segmented:not(.series-mode), .content-toolbar .toolbar-popover")].filter(el => el.getBoundingClientRect().width > 0);
    const controlChecks = controls.map(el => {
      const d = describe(el); const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      return { ...d, inViewport: r.left >= -0.5 && r.right <= vw + 0.5, hitOk: !!hit && (el === hit || el.contains(hit)) };
    });
    const overlap = [];
    for (let i = 0; i < controlChecks.length; i++) for (let j = i + 1; j < controlChecks.length; j++) {
      const a = controlChecks[i], b = controlChecks[j];
      if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) overlap.push([a.text || a.cls, b.text || b.cls]);
    }
    const selectors = ["#asset-details", ".batch-bar", ".category-filter-menu", ".tag-rule-panel", ".toolbar-popover-panel", ".advanced-filters", ".active-filter-bar"];
    const boxes = {};
    for (const s of selectors) { const el = document.querySelector(s); if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) boxes[s] = { ...describe(el), inViewport: r.left >= -0.5 && r.right <= vw + 0.5 }; } }
    return {
      label, width, vw, docScrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
      toolbar: document.querySelector(".content-toolbar") ? describe(document.querySelector(".content-toolbar")) : null,
      overflow, overlappingControls: overlap,
      controls: controlChecks.map(c => ({ text: c.text || c.cls, left: c.left, right: c.right, top: c.top, width: c.width, inViewport: c.inViewport, hitOk: c.hitOk })),
      boxes,
    };
  }, { label, width });
}

async function check(label) {
  for (const [width, height] of thresholds) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    const a = await audit(label, width);
    audits.push(a);
    await page.screenshot({ path: path.join(out, `${label}-${width}.png`) });
    if (a.docScrollWidth > a.vw) failures.push(`${label} ${width}: 文档横向溢出 ${a.docScrollWidth} > ${a.vw}`);
    if (a.overflow.length) failures.push(`${label} ${width}: 元素出屏 ${a.overflow.map(o => o.cls || o.tag).join(",")}`);
    // 详情抽屉在窄屏是有意覆盖层；打开时工具条被覆盖不算控件缺陷。
    if (label !== "details-open") {
      for (const c of a.controls) {
        if (!c.inViewport) failures.push(`${label} ${width}: 控件出屏 ${c.text}`);
        if (!c.hitOk) failures.push(`${label} ${width}: 控件中心不可点击 ${c.text}`);
      }
      if (a.overlappingControls.length) failures.push(`${label} ${width}: 控件重叠 ${JSON.stringify(a.overlappingControls)}`);
    }
    if (label === "details-open" && a.boxes["#asset-details"]) {
      const d = a.boxes["#asset-details"];
      if (d.scrollWidth > d.clientWidth + 1) failures.push(`details-open ${width}: 详情内部横向溢出 ${d.scrollWidth} > ${d.clientWidth}`);
      if (!d.inViewport) failures.push(`details-open ${width}: 详情出屏`);
    }
    for (const [sel, box] of Object.entries(a.boxes)) if (!box.inViewport) failures.push(`${label} ${width}: ${sel} 出屏 ${JSON.stringify(box)}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(150);
}

try {
  await page.goto(url);
  await page.getByRole("heading", { name: "全部素材", exact: true }).waitFor();
  await page.locator(".asset-row").first().waitFor();
  await check("default");

  // 长中文搜索 + 多标签条件
  await page.getByRole("textbox", { name: "搜索素材", exact: true }).fill("风声 测试 环境 自然");
  await page.waitForTimeout(500);
  await page.locator(".tag-rule-filter > button").click();
  for (const tag of ["环境", "自然"]) await page.getByLabel(tag, { exact: true }).check();
  await page.getByRole("region", { name: "标签筛选条件", exact: true }).getByRole("button", { name: "完成", exact: true }).click();
  await page.waitForTimeout(400);
  await check("search-tags");

  // 筛选菜单展开（标签面板 / 分类菜单）
  for (const [width, height] of thresholds) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    // ≤1100px 时分类/标签筛选收在“更多筛选”里，先展开再测菜单边界。
    const moreFilters = page.getByRole("button", { name: "更多筛选", exact: true });
    if (width <= 1100 && await moreFilters.getAttribute("aria-expanded") !== "true") await moreFilters.click();
    await page.waitForTimeout(150);
    await page.locator(".tag-rule-filter > button").click();
    let a = await audit("tag-menu-open", width); audits.push(a);
    await page.screenshot({ path: path.join(out, `tag-menu-open-${width}.png`) });
    if (a.docScrollWidth > a.vw) failures.push(`tag-menu-open ${width}: 文档横向溢出 ${a.docScrollWidth} > ${a.vw}`);
    if (a.boxes[".tag-rule-panel"] && !a.boxes[".tag-rule-panel"].inViewport) failures.push(`tag-menu-open ${width}: 标签面板出屏`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
    await page.locator(".category-filter input").click();
    a = await audit("category-menu-open", width); audits.push(a);
    await page.screenshot({ path: path.join(out, `category-menu-open-${width}.png`) });
    if (a.docScrollWidth > a.vw) failures.push(`category-menu-open ${width}: 文档横向溢出 ${a.docScrollWidth} > ${a.vw}`);
    if (a.boxes[".category-filter-menu"] && !a.boxes[".category-filter-menu"].inViewport) failures.push(`category-menu-open ${width}: 分类面板出屏`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(100);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const moreAtWide = page.getByRole("button", { name: "更多筛选", exact: true });
  if (await moreAtWide.getAttribute("aria-expanded") === "true") await moreAtWide.click();

  // 重置筛选，选中两项 -> 批量操作栏
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await page.waitForTimeout(500);
  await page.locator(".asset-row input[type=checkbox]").nth(0).check();
  await page.locator(".asset-row input[type=checkbox]").nth(1).check();
  await page.waitForTimeout(200);
  await check("batch-bar");

  // 详情面板打开
  await page.locator(".asset-row").first().click({ position: { x: 200, y: 30 } });
  await page.waitForTimeout(400);
  await check("details-open");
  if (await page.getByRole("button", { name: "隐藏素材详情", exact: true }).count()) {
    await page.getByRole("button", { name: "隐藏素材详情", exact: true }).click();
    await page.waitForTimeout(300);
  }
  await check("details-closed");

  // 更多筛选展开 + 已选批量栏并存
  await page.getByRole("button", { name: "更多筛选", exact: true }).click();
  await page.waitForTimeout(300);
  await check("advanced-filters");

  await fs.writeFile(path.join(out, "dom-audit.json"), JSON.stringify(audits, null, 2));
  await fs.writeFile(path.join(out, "dom-audit-failures.json"), JSON.stringify(failures, null, 2));
  console.log("AUDITS=" + audits.length);
  console.log("FAILURES=" + failures.length);
  for (const f of failures) console.log("FAIL " + f);
  if (errors.length) console.log("PAGEERRORS=" + JSON.stringify(errors));
} finally {
  await browser.close();
  server.kill("SIGTERM");
  await new Promise(r => server.once("exit", r));
  await fs.rm(base, { recursive: true, force: true });
}
