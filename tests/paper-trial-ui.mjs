// 「新样子（试用）」开关的真实应用界面测试：开、关两种情况。
// 用法：npm run build && MEDIA_DISABLE_DESKTOP_NATIVE=1 node tests/paper-trial-ui.mjs
// 只用合成素材（ffmpeg 生成的正弦波、纯色视频和图片）和全新临时库；不碰真实库、不联网（检查没有外部请求，字体也不从外面加载）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium, expect} from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const evidence = path.resolve(process.env.PAPER_TEST_EVIDENCE || 'collab/results/PAPER-TRIAL-20261122/browser');
await fs.mkdir(evidence, {recursive: true});
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-trial-ui-')), run = promisify(execFile);
const dirs = {sfx: path.join(temporary, '合成音效'), music: path.join(temporary, '合成音乐'), video: path.join(temporary, '合成视频'), photo: path.join(temporary, '合成照片')};
const ff = (...args) => run('ffmpeg', ['-nostdin', '-y', '-v', 'error', ...args]);
await fs.mkdir(path.join(dirs.sfx, '环境', '雨天'), {recursive: true});
await fs.mkdir(path.join(dirs.music, '配乐', '开场'), {recursive: true});
await fs.mkdir(path.join(dirs.video, '空镜', '街道'), {recursive: true});
await fs.mkdir(path.join(dirs.photo, '参考', '建筑'), {recursive: true});
await ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', path.join(dirs.sfx, '环境', '雨天', '合成环境声-01.wav'));
await ff('-f', 'lavfi', '-i', 'sine=frequency=520:duration=4', path.join(dirs.music, '配乐', '开场', '合成配乐-02.mp3'));
await ff('-f', 'lavfi', '-i', 'color=c=0x7f8f9c:s=320x180:d=1', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dirs.video, '空镜', '街道', '合成空镜-03.mp4'));
await ff('-f', 'lavfi', '-i', 'color=c=0xe2a36f:s=480x320:d=1', '-frames:v', '1', path.join(dirs.photo, '参考', '建筑', '合成照片-04.png'));

const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
const origin = `http://127.0.0.1:${port}`;
let logs = '', browser, page, passed = false, cookie, token; const checks = [], errors = [], external = [], requests = [];
/** 打包宋体的请求：字体文件本身，或者装着它的那一块（fonts-*.css / fonts-*.js）。开关关着时一个都不能有。 */
const fontRequests = () => requests.filter(u => /\.woff2?$|\/fonts-[^/]+\.(css|js)$/.test(u));
const child = spawn(process.execPath, ['server/index.mjs'], {cwd: root, env: {...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temporary, 'data'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_READONLY_FILES: '1', MEDIA_DISABLE_DESKTOP_NATIVE: '1', SHIGUANG_AUDIO_ANALYSIS: '0'}});
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body) { const r = await fetch(origin + '/api' + p, {method: body ? 'POST' : 'GET', headers: {cookie, origin, 'x-local-token': token, 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})}); assert.ok(r.ok, p); return r.json(); }
async function check(name, fn) { if (process.env.PAPER_TEST_FILTER && !new RegExp(process.env.PAPER_TEST_FILTER).test(name)) return; await fn(); checks.push(name); console.log('PASS ' + name); }

// ---- 页面里用的小工具 ----
const sidebar = () => page.locator('.sidebar');
const groupButton = name => sidebar().getByRole('button', {name, exact: true});
async function openSettings() { await sidebar().getByRole('button', {name: '界面设置', exact: true}).click(); return page.getByRole('dialog', {name: '界面设置'}); }
async function setTrial(on) {
  const dialog = await openSettings();
  const toggle = dialog.getByRole('switch', {name: '新样子（试用）'});
  if (on) await toggle.check(); else await toggle.uncheck();
  await dialog.getByRole('button', {name: '完成', exact: true}).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute('data-sg-paper'))).toBe(on ? 'on' : null);
}
/** 试用样式里每一条规则（含 @media 里的）在当前页面上匹配到的元素；total 用来确认样式确实加载了，测试不是空转。 */
const paperRuleHits = () => page.evaluate(() => {
  let total = 0; const hits = [];
  const walk = rules => { for (const r of rules) {
    if (r.cssRules && !r.selectorText) walk(r.cssRules);
    if (!r.selectorText || !r.selectorText.includes('data-sg-paper')) continue;
    total++;
    for (const selector of r.selectorText.split(/,(?![^(]*\))/)) { try { if (document.querySelector(selector)) hits.push(selector.trim()); } catch {} }
  } };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch {} }
  return {total, hits};
});
/** 文字颜色对它实际压着的底色（往上找第一个不透明底色）的对比度。 */
const contrastOf = locator => locator.evaluate(el => {
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return {r, g, b, a}; };
  const lum = ({r, g, b}) => [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const fg = parse(getComputedStyle(el).color);
  let node = el, bg = null;
  while (node && node.nodeType === 1) { const c = parse(getComputedStyle(node).backgroundColor); if (c && c.a >= 0.99) { bg = c; break; } node = node.parentElement; }
  bg ??= parse(getComputedStyle(document.documentElement).backgroundColor) ?? {r: 255, g: 255, b: 255};
  const [x, y] = [lum(fg), lum(bg)];
  return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100;
});
const style = (locator, prop) => locator.evaluate((el, p) => getComputedStyle(el)[p], prop);
const rows = () => page.locator('.asset-table .asset-row');
const rowNamed = name => rows().filter({has: page.locator('.asset-name-button', {hasText: name})});

try {
  await expect.poll(() => logs, {timeout: 20000}).toContain(origin);
  const response = await fetch(origin + '/api/session'), session = await response.json(); cookie = response.headers.get('set-cookie').split(';')[0]; token = session.token;
  for (const [kind, directory] of Object.entries(dirs)) await api('/roots', {path: directory, kind});
  await api('/projects', {name: '合成项目'});
  await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running' && j.status !== 'queued'), {timeout: 30000}).toBe(true);
  await expect.poll(async () => (await api('/assets?pageSize=50')).total, {timeout: 20000}).toBe(4);

  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 960}});
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  context.on('request', r => { const url = new URL(r.url()); if (url.protocol.startsWith('http') && url.origin !== origin) external.push(url.origin + url.pathname); if (url.protocol.startsWith('http')) requests.push(url.pathname); });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/materials');
  await expect(rows()).toHaveCount(4);

  await check('OFF by default: original structure, no trial attribute, not one trial CSS rule matches anything', async () => {
    assert.equal(await page.evaluate(() => localStorage.getItem('shiguang.paperTrial.v1')), null);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-sg-paper')), false);
    const {total, hits} = await paperRuleHits();
    assert.ok(total > 50, 'trial stylesheet and token block are loaded: ' + total);
    assert.deepEqual(hits, []);
    await expect(page.locator('.library-topbar .breadcrumb')).toHaveText(/素材库\s*\/\s*全部素材/);
    await expect(page.locator('.topbar-actions > .codex-tasks-entry')).toHaveCount(1);
    await expect(page.locator('.topbar-actions > .fi-entry')).toHaveCount(1);
    await expect(page.locator('.topbar-actions .file-check-button')).toBeVisible();
    await expect(page.locator('.sgp-tasks, .sgp-path, .sgp-row-thumb')).toHaveCount(0);
    for (const name of ['素材查找', '项目设计和管理']) await expect(groupButton(name)).toHaveAttribute('aria-expanded', 'true');
    assert.equal(await style(page.locator('.sidebar'), 'backgroundColor'), 'rgb(240, 244, 243)');
    assert.ok(!(await style(page.locator('.library-heading h1'), 'fontFamily')).includes('Noto Serif SC'));
    assert.deepEqual(fontRequests(), [], 'no bundled font is requested while the trial is off');
    assert.equal(await page.evaluate(() => [...document.fonts].some(f => f.family.replace(/["']/g, '') === 'Noto Serif SC')), false);
    await page.screenshot({path: path.join(evidence, 'off-materials.png'), animations: 'disabled'});
  });

  await check('OFF in all 6 themes: theme colours are the themes\' own, trial rules still match nothing', async () => {
    requests.length = 0;
    // 每套风格的品牌色取自生成好的 themes.css（含对比度保护后的值）；试用块的赭红不能漏进来。
    const css = await fs.readFile(path.join(root, 'src/themes.css'), 'utf8'), brand = {};
    for (const [, selector, id, body] of css.matchAll(/(:root|html\[data-theme="([a-z]+)"\])\s*\{([\s\S]*?)\n\}/g)) {
      const value = [...body.matchAll(/--c-356451:\s*([^;]+);/g)].pop()?.[1].trim();
      if (value) brand[selector === ':root' ? 'forest' : id] = value;
    }
    assert.deepEqual(Object.keys(brand).sort(), ['dark', 'forest', 'graphite', 'midnight', 'ocean', 'sepia']);
    assert.ok(!Object.values(brand).includes('#9a4a2b'));
    for (const [theme, value] of Object.entries(brand)) {
      await page.evaluate(id => localStorage.setItem('shiguang.theme', id), theme); await page.reload(); await expect(rows()).toHaveCount(4);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-356451').trim()), value, theme);
      assert.deepEqual((await paperRuleHits()).hits, [], theme);
    }
    await page.evaluate(() => localStorage.setItem('shiguang.theme', 'forest')); await page.reload(); await expect(rows()).toHaveCount(4);
    assert.deepEqual(fontRequests(), [], 'no bundled font is requested in any theme while the trial is off');
  });

  await check('ON via settings: switch is remembered only in this browser and survives reload', async () => {
    await setTrial(true);
    assert.equal(await page.evaluate(() => localStorage.getItem('shiguang.paperTrial.v1')), 'on');
    await page.reload(); await expect(rows()).toHaveCount(4);
    await expect(page.locator('html')).toHaveAttribute('data-sg-paper', 'on');
    const dialog = await openSettings();
    await expect(dialog.getByRole('switch', {name: '新样子（试用）'})).toBeChecked();
    await dialog.screenshot({path: path.join(evidence, 'on-settings.png'), animations: 'disabled'});
    await dialog.getByRole('button', {name: '完成', exact: true}).click();
  });

  await check('ON list page: spec colours, serif title and names, medium density, no external font request', async () => {
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(244, 242, 238)');
    assert.equal(await style(page.locator('.library-browser'), 'backgroundColor'), 'rgb(253, 252, 250)');
    const h1 = page.locator('.library-heading h1');
    assert.match(await style(h1, 'fontFamily'), /Noto Serif SC/); assert.equal(await style(h1, 'fontSize'), '24px'); assert.equal(await style(h1, 'color'), 'rgb(38, 35, 31)');
    const name = rows().first().locator('.asset-name-button');
    assert.match(await style(name, 'fontFamily'), /Noto Serif SC/); assert.equal(await style(name, 'fontSize'), '14px');
    assert.match(await style(page.locator('.result-count'), 'fontFamily'), /Noto Sans SC/);
    // 打包的 Noto Serif SC 真的加载上了，而且是从本机拿的（同源 woff2）。
    await expect.poll(() => page.evaluate(() => [...document.fonts].some(f => f.family.replace(/["']/g, '') === 'Noto Serif SC' && f.status === 'loaded')), {timeout: 15000}).toBe(true);
    assert.ok(fontRequests().some(u => u.endsWith('.woff2')), 'a bundled woff2 slice was fetched from this machine');
    assert.ok(!fontRequests().some(u => u.endsWith('.woff')), 'only woff2 is shipped');
    assert.equal(await style(rows().first(), 'paddingTop'), '8px'); assert.equal(await style(rows().first(), 'paddingBottom'), '8px');
    assert.equal(await style(rows().first().locator('.file-cell span').first(), 'lineHeight'), '18px'); // 12px × 1.5
    assert.equal(await style(rows().first(), 'borderBottomColor'), 'rgb(236, 231, 222)');
    assert.equal(await style(rows().first().locator('.file-cell span').first(), 'color'), 'rgb(100, 92, 81)');
    assert.equal(await style(page.locator('.add-root-button'), 'backgroundColor'), 'rgb(154, 74, 43)');
    for (const control of [page.locator('.filters .advanced-filter-trigger'), page.locator('.heading-tools > .plain').first()]) {
      assert.equal(await style(control, 'backgroundColor'), 'rgb(242, 238, 231)'); assert.equal(await style(control, 'borderTopWidth'), '0px');
    }
    await page.screenshot({path: path.join(evidence, 'on-materials.png'), animations: 'disabled'});
  });

  await check('ON list page keeps every field: checkbox, audition or thumbnail, name, meta, two-line category, duration, size, actions, toolbar', async () => {
    for (let i = 0; i < 4; i++) {
      const row = rows().nth(i);
      await expect(row.getByRole('checkbox')).toHaveCount(1);
      await expect(row.locator('.asset-name-button')).toHaveText(/合成/);
      await expect(row.locator('.file-cell span').first()).toContainText('定位');
      await expect(row.locator('.category-cell span')).toHaveCount(1); await expect(row.locator('.category-cell small')).toHaveCount(1);
      await expect(row.locator('.mono')).toHaveCount(1); await expect(row.locator('.size-cell')).toHaveCount(1);
      await expect(row.getByRole('button', {name: /^定位素材：/})).toHaveCount(1);
      await expect(row.getByRole('button', {name: /收藏$/})).toHaveCount(1);
      await expect(row.getByRole('button', {name: /^更多素材操作：/})).toHaveCount(1);
    }
    for (const audio of ['合成环境声-01.wav', '合成配乐-02.mp3']) await expect(rowNamed(audio).locator('.file-icon[title="试听"]')).toHaveCount(1);
    for (const visual of ['合成空镜-03.mp4', '合成照片-04.png']) {
      const thumb = rowNamed(visual).locator('img.sgp-row-thumb');
      await expect(thumb).toHaveCount(1);
      await expect.poll(() => thumb.evaluate(img => img.complete && img.naturalWidth > 0), {timeout: 20000}).toBe(true);
    }
    await expect(page.locator('.result-count')).toHaveText(/4 条结果/);
    await expect(page.getByRole('button', {name: '平铺', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: '同系列分组', exact: true})).toBeVisible();
    await expect(page.getByRole('combobox', {name: '排序'})).toBeVisible();
    await expect(page.getByRole('button', {name: '列表视图', exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: '网格视图', exact: true})).toBeVisible();
  });

  await check('ON row actions are faint until that row is hovered; a saved star stays visible', async () => {
    await page.mouse.move(5, 950);
    const actions = i => rows().nth(i).locator('.asset-quick-actions > .icon-button').first();
    assert.equal(await style(actions(0), 'opacity'), '0.35');
    await rows().nth(1).hover(); await expect.poll(() => style(actions(1), 'opacity')).toBe('1');
    assert.equal(await style(actions(0), 'opacity'), '0.35');
    await rows().nth(1).getByRole('button', {name: '收藏', exact: true}).click();
    await expect(rows().nth(1).getByRole('button', {name: '取消收藏', exact: true})).toBeVisible();
    await page.mouse.move(5, 950); await page.locator('.library-heading h1').click();
    await expect.poll(() => style(rows().nth(1).getByRole('button', {name: '取消收藏', exact: true}), 'opacity')).toBe('1');
    await rows().nth(1).hover(); await page.screenshot({path: path.join(evidence, 'on-row-hover.png'), animations: 'disabled'});
    await rows().nth(1).getByRole('button', {name: '取消收藏', exact: true}).click();
    await expect(rows().nth(1).getByRole('button', {name: '收藏', exact: true})).toBeVisible();
  });

  await check('ON sidebar: material and project groups open one at a time, both can close, current page opens its own group', async () => {
    await page.reload(); await expect(rows()).toHaveCount(4); // 不带上一步留下的选中行
    const mat = groupButton('素材 · 剪辑时用'), proj = groupButton('项目 · 做漫剧时用');
    await expect(mat).toHaveAttribute('aria-expanded', 'true'); await expect(proj).toHaveAttribute('aria-expanded', 'false');
    await expect(proj.locator('.sgp-group-count')).toHaveText('7');
    await page.mouse.move(5, 950); await page.screenshot({path: path.join(evidence, 'on-sidebar-material.png'), animations: 'disabled'});
    await proj.click();
    await expect(proj).toHaveAttribute('aria-expanded', 'true'); await expect(mat).toHaveAttribute('aria-expanded', 'false');
    await expect(mat.locator('.sgp-group-count')).toHaveText('6');
    await expect(page.locator('#navigation-find')).toBeHidden(); await expect(page.locator('#navigation-design')).toBeVisible();
    await page.mouse.move(5, 950); await page.screenshot({path: path.join(evidence, 'on-sidebar-project.png'), animations: 'disabled'});
    await proj.click();
    await expect(proj).toHaveAttribute('aria-expanded', 'false'); await expect(mat).toHaveAttribute('aria-expanded', 'false');
    await page.goto(origin + '/#/project-music');
    await expect(proj).toHaveAttribute('aria-expanded', 'true'); await expect(mat).toHaveAttribute('aria-expanded', 'false');
    await page.goto(origin + '/#/photos');
    await expect(mat).toHaveAttribute('aria-expanded', 'true'); await expect(proj).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar().getByRole('button', {name: '摄影照片', exact: true})).toHaveAttribute('aria-current', 'page');
    // 另外两组（素材管理、素材目录）照旧各自开合，不参与“一次只开一组”。
    const manage = groupButton('素材管理'), wasOpen = await manage.getAttribute('aria-expanded');
    await manage.click(); await expect(manage).toHaveAttribute('aria-expanded', wasOpen === 'true' ? 'false' : 'true');
    await expect(mat).toHaveAttribute('aria-expanded', 'true');
    await manage.click();
    await page.goto(origin + '/#/materials'); await expect(rows()).toHaveCount(4);
  });

  await check('ON top bar ③: project / page path on the left; only 待处理 and 后台任务 on the right; three task entries reuse their own panels', async () => {
    const pathNav = page.getByRole('navigation', {name: '位置'});
    await expect(pathNav).toContainText('合成项目'); await expect(pathNav.locator('.sgp-path-page')).toHaveText('全部素材');
    await expect(page.locator('.topbar-actions > .sgn-entry')).toBeVisible();
    await expect(page.locator('.topbar-actions > .codex-tasks-entry, .topbar-actions > .fi-entry, .topbar-actions > .file-check-entry')).toHaveCount(0);
    const tasks = page.getByRole('button', {name: /^后台任务/}), menu = page.locator('#sgp-tasks-menu');
    await expect(menu).toBeHidden();
    await tasks.click(); await expect(menu).toBeVisible(); await expect(tasks).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('button', {name: /Codex 任务/})).toBeVisible();
    await expect(menu.getByRole('button', {name: /文件任务/})).toBeVisible();
    await expect(menu.getByRole('button', {name: '检查文件状态', exact: true})).toBeVisible();
    await expect(menu).toContainText('Updream 视频任务 · 最近没有');
    await page.screenshot({path: path.join(evidence, 'on-background-tasks.png'), animations: 'disabled'});
    await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(tasks).toBeFocused();
    await tasks.click(); await menu.getByRole('button', {name: /文件任务/}).click();
    await expect(page.locator('#file-intake-tasks')).toBeVisible(); await expect(menu).toBeHidden();
    await page.getByRole('button', {name: '关闭文件任务', exact: true}).click();
    await expect(page.locator('#file-intake-tasks')).toHaveCount(0); await expect(tasks).toBeFocused();
    await tasks.click(); await menu.getByRole('button', {name: /Codex 任务/}).click();
    await expect(page.locator('#codex-global-task-drawer')).toBeVisible(); await expect(menu).toBeHidden();
    await page.locator('#codex-global-task-drawer').getByRole('button', {name: /^关闭/}).first().click();
    await expect(page.locator('#codex-global-task-drawer')).toBeHidden();
    await tasks.click(); await page.locator('.library-heading h1').click(); await expect(menu).toBeHidden();
  });

  await check('ON text contrast is at least 4.5:1 on its actual background', async () => {
    const targets = {
      title: page.locator('.library-heading h1'), count: page.locator('.library-heading p'), results: page.locator('.result-count'),
      head: page.locator('.table-head span').first(), name: rows().first().locator('.asset-name-button'), meta: rows().first().locator('.file-cell span').first(),
      category: rows().first().locator('.category-cell span'), subcategory: rows().first().locator('.category-cell small'), size: rows().first().locator('.size-cell'),
      group: groupButton('项目 · 做漫剧时用'), item: sidebar().locator('.nav-item.selected'), itemCount: sidebar().locator('.nav-group-items .nav-item small').nth(1),
      path: page.locator('.sgp-path .ppb-seg').first(), page: page.locator('.sgp-path-page'), pending: page.locator('.sgn-entry'),
      tasks: page.getByRole('button', {name: /^后台任务/}), addRoot: page.locator('.add-root-button'), sort: page.getByRole('combobox', {name: '排序'}),
      tiled: page.getByRole('button', {name: '平铺', exact: true}), search: page.getByPlaceholder('搜索名称、标签或备注'),
    };
    const low = [];
    for (const [key, locator] of Object.entries(targets)) { const ratio = await contrastOf(locator); if (ratio < 4.5) low.push(`${key} ${ratio}`); }
    assert.deepEqual(low, []);
  });

  await check('OFF again via settings: attribute and storage cleared, original top bar and sidebar back, trial rules match nothing', async () => {
    await setTrial(false);
    assert.equal(await page.evaluate(() => localStorage.getItem('shiguang.paperTrial.v1')), null);
    await expect(page.locator('.library-topbar .breadcrumb')).toHaveText(/素材库\s*\/\s*全部素材/);
    await expect(page.locator('.topbar-actions > .codex-tasks-entry')).toHaveCount(1);
    await expect(page.locator('.sgp-tasks, .sgp-path, .sgp-row-thumb')).toHaveCount(0);
    await expect(groupButton('素材查找')).toBeVisible();
    assert.deepEqual((await paperRuleHits()).hits, []);
    assert.equal(await style(page.locator('.sidebar'), 'backgroundColor'), 'rgb(240, 244, 243)');
    requests.length = 0; await page.reload(); await expect(rows()).toHaveCount(4);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-sg-paper')), false);
    assert.deepEqual(fontRequests(), [], 'after turning it off, a reload requests no bundled font');
    await page.mouse.move(5, 950); await page.screenshot({path: path.join(evidence, 'off-again-materials.png'), animations: 'disabled'});
  });

  await check('No page errors and no request leaves this machine (fonts included)', async () => {
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
  });
  await context.close(); passed = true;
} catch (e) { await page?.screenshot({path: path.join(evidence, 'failure.png'), animations: 'disabled'}).catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.txt'), e.stack); throw e; }
finally {
  await browser?.close(); if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer; try { await Promise.race([exited, new Promise((_, reject) => timer = setTimeout(() => reject(Error('Application closure unconfirmed')), 15000))]); } finally { clearTimeout(timer); }
  await fs.writeFile(path.join(evidence, 'server.log'), logs); if (passed) await fs.rm(temporary, {recursive: true, force: true});
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({passed, checks, errors, external, scope: 'Production build with brand-new synthetic audio/video/photo roots; trial switch off and on; no author data, network or paid calls.'}, null, 2));
}
