// STORYBOARD-SEGMENTS v1 前端界面测试：真实本地服务（全新合成库）+ 无头浏览器，不拦截接口。
// 覆盖用户谈定的段编辑：去掉挪动入口、只能在上方/下方插入、段分隔线与秒数、切段/合并、超长标红与保存时拦截、
// 分割模式、阅读模式段线、在此场景后新建场景。不连真实库、4317、平台或模型。
// 用法：npm run build && node tests/storyboard-segments-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { splitSegment } from '../server/storyboard/shared/segments.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-segments-ui-')));
const s0 = net.createServer(); await new Promise(r => s0.listen(0, '127.0.0.1', r)); const port = s0.address().port; await new Promise(r => s0.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const errors = [], foreign = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'p'), CODEX_HOME: path.join(temp, 'c'), MEDIA_UPDREAM_QUEUE_DIR: path.join(temp, 'no-queue'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' } });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
async function api(p, body, method) {
  const r = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); if (!r.ok) throw Object.assign(Error(p + ' ' + r.status + ' ' + JSON.stringify(d).slice(0, 300)), { status: r.status, data: d }); return d;
}
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
const shot = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  const main = await api('/projects', { name: '合成 · 段' }), second = await api('/projects', { name: '合成 · 段名' });
  // 示例 28 镜：A=镜1–7（15 秒）、B=镜8–28（65 秒）。用摄影模式初始化（初始化不允许超长），进页面再切到 Seedance 验超长。
  const example = JSON.parse(await fs.readFile(path.join(root, 'server/storyboard/example.json'), 'utf8'));
  example['分段'] = [{ '段': 'A', '起始镜号': '01' }, { '段': 'B', '起始镜号': '08' }];
  example['分割模式'] = { '模式': 'camera', '自定义上限毫秒': null };
  for (const id of [main.id, second.id]) await api('/storyboard/projects/' + id + '/initialize', { request_id: randomUUID(), source: example, expected_revision: null, filename: '示例.json', timing: 'duration' });
  // 漏写分段：拒绝导入并给出补法
  const bare = structuredClone(example); delete bare['分段'];
  const third = await api('/projects', { name: '合成 · 漏写分段' });
  await assert.rejects(api('/storyboard/projects/' + third.id + '/initialize', { request_id: randomUUID(), source: bare, expected_revision: null, filename: '漏写.json', timing: 'duration' }), e => e.status === 400 && /SEGMENTS_REQUIRED/.test(e.message));

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('shiguang.refreshSeconds', '0'); });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !['data:', 'blob:'].includes(u.protocol)) foreign.push(r.url()); });
  const puts = []; page.on('request', r => { if (r.method() === 'PUT' && /\/api\/storyboard\/projects\/[^/]+$/.test(new URL(r.url()).pathname)) puts.push(r.postDataJSON()); });
  const open = async id => { await page.goto(origin + '/?r=' + Date.now() + '#/storyboards'); await selectProjectInBar(page, id); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible({ timeout: 15000 }); };
  const dividers = () => page.locator('.sb-segment-divider');
  const row = n => page.getByTestId('shot-row-' + String(n).padStart(2, '0'));
  const menu = async (n, item) => { await row(n).click({ button: 'right' }); await page.getByRole('menuitem', { name: item }).click(); };
  const setMode = async mode => { await page.locator('.sb-segment-mode').click(); await page.getByLabel('分割模式', { exact: true }).selectOption(mode); await page.keyboard.press('Escape'); };
  const save = async () => { const n = puts.length; await page.getByRole('button', { name: /保存项目/ }).click(); const big = page.getByTestId('big-save'); if (await big.waitFor({ timeout: 1500 }).then(() => true, () => false)) await big.click(); await expect.poll(() => puts.length).toBe(n + 1); await expect(page.getByRole('button', { name: /保存项目/ })).toBeDisabled({ timeout: 10000 }); };

  await check('G1 页面上没有任何改变镜头顺序的入口；工具栏不再有「新增镜头」', async () => {
    await open(main.id);
    await expect(page.locator('.sb-drag-handle')).toHaveCount(0);
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);
    await row(2).click();
    for (const name of ['镜头上移', '镜头下移', '移动到场景']) await expect(page.getByLabel(name, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '在当前镜头上方插入镜头' })).toBeVisible();
    await expect(page.locator('.sb-table-tools').getByRole('button', { name: /新增镜头/ })).toHaveCount(0);
    await page.getByRole('button', { name: '编辑场景1' }).click();
    for (const name of ['场景上移', '场景下移']) await expect(page.getByRole('button', { name })).toHaveCount(0);
    await expect(page.getByTestId('scene-insert-after')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await check('G2 段分隔线：段名、镜头数、秒数；状态栏显示分割模式；切到 Seedance 2.5 后超长段标红', async () => {
    await expect(dividers()).toHaveCount(2);
    await expect(dividers().nth(0)).toContainText('A 段'); await expect(dividers().nth(0)).toContainText('7 镜 · 15 秒');
    await expect(dividers().nth(1)).toContainText('B 段'); await expect(dividers().nth(1)).toContainText('21 镜 · 65 秒');
    await expect(page.locator('.sb-segment-mode')).toHaveText('分割：摄影模式 · 不限时长');
    await expect(page.locator('.sb-segment-divider.is-over')).toHaveCount(0);
    await setMode('seedance_2_5');
    await expect(page.locator('.sb-segment-mode')).toHaveText('分割：Seedance 2.5 · 30 秒');
    await expect(dividers().nth(1)).toHaveClass(/is-over/);
    await expect(dividers().nth(1)).toContainText('超过 30 秒，建议再切一刀');
    await shot('segments-1-dividers');
  });

  await check('G2b 老数据例外：已超长的段没有变长，换小上限后照常保存', async () => {
    await save();
    const saved = await api('/storyboard/projects/' + main.id + '/segments');
    assert.equal(saved.segment_settings.mode, 'seedance_2_5'); assert.equal(saved.segments[1].overlong, true);
  });

  await check('G3 插入规则：A 段最后一镜下方插入归 A；B 段第一镜上方插入归 B 且 B 的起点移到新镜头', async () => {
    await menu(7, '在下方插入镜头');
    await expect(dividers().nth(0)).toContainText('8 镜');
    await menu(9, '在上方插入镜头');   // 镜9 现在是 B 段第一镜
    await expect(dividers().nth(0)).toContainText('8 镜');
    await expect(row(9)).toBeVisible();
    const startOfB = await page.evaluate(() => { let tr = document.querySelectorAll('tr.sb-segment-divider')[1]?.nextElementSibling; while (tr && !tr.hasAttribute('data-shot')) tr = tr.nextElementSibling; return tr?.getAttribute('data-testid'); });
    await expect(dividers().nth(1)).toContainText('22 镜');
    assert.equal(startOfB, 'shot-row-09', 'B 段第一行应是新插入的镜9');
    await expect(row(9).locator('.sb-unsaved-dot')).toBeVisible();
  });

  await check('G4 从这里切段：默认名 B1；段首右键「从这里切段」置灰并说明；并入上一段恢复原样', async () => {
    await row(9).click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '从这里切段' })).toBeDisabled();
    await page.keyboard.press('Escape');
    await menu(12, '从这里切段');
    await expect(dividers()).toHaveCount(3);
    await expect(dividers().nth(2)).toContainText('B1 段');
    await shot('segments-2-cut');
    await dividers().nth(2).getByRole('button', { name: '并入上一段' }).click();
    await expect(dividers()).toHaveCount(2);
    await expect(dividers().nth(0).getByRole('button', { name: '并入上一段' })).toHaveCount(0);
  });

  await check('G5 保存时拦截：超长且变长的段存不进去，列出哪一段；不发出 PUT', async () => {
    const before = puts.length;
    await page.getByRole('button', { name: /保存项目/ }).click();
    await expect(page.locator('.sb-toast, .global-feedback, [role="status"]').filter({ hasText: '存不进去' }).first()).toContainText('B 段');
    assert.equal(puts.length, before, '超长变长时不应发出保存请求');
  });

  await check('G6 分割模式改成摄影模式后不再超长；改成 Seedance 2.0 后上限 15 秒', async () => {
    await setMode('camera');
    await expect(page.locator('.sb-segment-mode')).toHaveText('分割：摄影模式 · 不限时长');
    await expect(page.locator('.sb-segment-divider.is-over')).toHaveCount(0);
    await setMode('seedance_2_0');
    await expect(page.locator('.sb-segment-divider.is-over').first()).toContainText('超过 15 秒');
  });

  await check('G7 阅读模式里段与段之间有带字母的分隔线', async () => {
    await page.getByRole('button', { name: '阅读模式' }).click();
    await expect(page.getByTestId('reading-segment-A')).toContainText('A 段');
    await expect(page.getByTestId('reading-segment-B')).toBeVisible();
    await shot('segments-3-reading');
    await page.keyboard.press('Escape');
  });

  await check('G8 在此场景后新建场景：插在原场景后面；空场景里新增的镜头归前一镜所在的段', async () => {
    const names = () => page.locator('.sb-scene-name strong').allTextContents();
    const count = (await names()).length;
    await page.getByRole('button', { name: '编辑场景1' }).click(); await page.getByTestId('scene-insert-after').click(); await page.keyboard.press('Escape');
    const after = await names(); assert.equal(after.length, count + 1); assert.equal(after[1], '新场景');
    await page.getByRole('button', { name: '在场景2新增镜头' }).click();
    await expect(dividers().nth(0)).toContainText('A 段');
  });

  await check('G9 用回空字母：B 并入 A 保存后，再从 A 里切段会问「叫 A1 还是覆盖 B」；选覆盖后保存成功，名字回到 B', async () => {
    await page.goto(origin + '/?r=' + Date.now() + '#/storyboards');
    const drop = page.getByRole('button', { name: '丢弃草稿' }); await drop.waitFor({ timeout: 15000 }); await drop.click();   // 上一个项目故意留下的未保存修改
    await open(second.id);
    await dividers().nth(1).getByRole('button', { name: '并入上一段' }).click();
    await expect(dividers()).toHaveCount(1);
    await save();
    await menu(10, '从这里切段');
    await expect(page.getByRole('dialog')).toContainText('空着字母 B');
    await expect(page.getByTestId('split-new')).toHaveText('叫 A1');
    await shot('segments-4-overwrite');
    await page.getByTestId('split-overwrite').click();
    await expect(dividers().nth(1)).toContainText('B 段');
    await save();
    const body = puts.at(-1); assert.equal(body.segment_name_overwrites?.length, 1); assert.equal(body.segment_name_overwrites[0].name, 'B');
    const seg = await api('/storyboard/projects/' + second.id + '/segments');
    assert.deepEqual(seg.segments.map(g => g.name), ['A', 'B']); assert.equal(seg.segments[1].start_number, '10');
  });

  await check('G10 Codex 切段后「待看的修改」里写成一句话', async () => {
    const cur = await api('/storyboard/projects/' + second.id); const sum = await api('/storyboard/projects/' + second.id + '/segments');
    const next = splitSegment(cur.project, sum.segments[0].shot_ids[4], { id: 'segment_' + randomUUID() });
    await api('/storyboard/projects/' + second.id, { project: next, expected_revision: cur.revision, change: { author: 'agent', reason_category: 'shot_feel', reason_text: '把 A 段拆短一点' }, request_id: randomUUID() }, 'PUT');
    await open(second.id);
    await page.getByRole('group', { name: '分镜视图' }).getByRole('button', { name: /待看的修改/ }).click();
    await expect(page.getByLabel('待看的修改')).toContainText('分段');
    await expect(page.getByLabel('待看的修改')).toContainText(/从镜 05 起切出新段 A1/);
    await shot('segments-5-pending');
  });

  await check('G11 自定义秒数：从 Seedance 2.0 真正切进「自定义」，输入框带上原上限；填 20 秒保存，刷新后仍是自定义 20 秒；填 0 被拒且不改草稿；可再切回预设', async () => {
    await page.getByRole('group', { name: '分镜视图' }).getByRole('button', { name: '编辑' }).click();
    await setMode('seedance_2_0'); await expect(page.locator('.sb-segment-mode')).toHaveText('分割：Seedance 2.0 · 15 秒');
    await page.locator('.sb-segment-mode').click();
    await page.getByLabel('分割模式', { exact: true }).selectOption('custom');
    await expect(page.getByLabel('分割模式', { exact: true })).toHaveValue('custom');
    const input = page.getByLabel('自定义上限（秒）', { exact: true });
    await expect(input).toHaveValue('15');
    await input.fill('0'); await input.press('Tab');
    await expect(page.locator('.sb-toast, .global-feedback, [role="status"]').filter({ hasText: '大于 0' }).first()).toBeVisible();
    await expect(input).toHaveValue('15');
    await input.fill('20'); await input.press('Tab');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sb-segment-mode')).toHaveText('分割：自定义 · 20 秒');
    await expect(page.locator('.sb-segment-divider.is-over').first()).toContainText('超过 20 秒');
    await save();
    assert.deepEqual(puts.at(-1).project.segment_settings, { mode: 'custom', custom_limit_ms: 20000 });
    await open(second.id);
    await expect(page.locator('.sb-segment-mode')).toHaveText('分割：自定义 · 20 秒');
    const seg = await api('/storyboard/projects/' + second.id + '/segments'); assert.equal(seg.limit_ms, 20000);
    await setMode('seedance_2_5'); await expect(page.locator('.sb-segment-mode')).toHaveText('分割：Seedance 2.5 · 30 秒');
    await expect(page.getByLabel('自定义上限（秒）', { exact: true })).toHaveCount(0);
  });

  await check('G12 右键菜单在六种主题下都不透明：背景、文字、边框取到分镜主题色；窄屏 390 下底部镜头右键插入可用', async () => {
    const themes = [...(await fs.readFile(path.join(root, 'src/theme-list.ts'), 'utf8')).matchAll(/\{ id: "([a-z]+)"/g)].map(m => m[1]);
    assert.equal(themes.length, 6);
    for (const theme of themes) {
      await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
      await row(3).click({ button: 'right' });
      const menuBox = page.getByRole('menu');
      await expect(menuBox).toBeVisible();
      const st = await menuBox.evaluate(el => { const c = getComputedStyle(el), b = getComputedStyle(el.querySelector('button')), app = el.closest('.sb-app'); return { inApp: !!app, bg: c.backgroundColor, border: c.borderTopWidth, text: b.color, paper: getComputedStyle(app ?? el).getPropertyValue('--sb-paper').trim() }; });
      assert.ok(st.inApp, theme + '：菜单应在分镜工作台里继承主题');
      assert.notEqual(st.bg, 'rgba(0, 0, 0, 0)', theme + '：菜单背景不应透明'); assert.notEqual(st.bg, '', theme);
      assert.notEqual(st.border, '0px', theme + '：菜单应有边框'); assert.ok(st.paper, theme + '：应取到 --sb-paper');
      assert.notEqual(st.text, st.bg, theme + '：文字与背景不应同色');
      await shot('segments-menu-' + theme);
      await page.keyboard.press('Escape'); await expect(menuBox).toHaveCount(0);
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = 'forest'; });
    await page.setViewportSize({ width: 390, height: 760 });
    const hide = page.getByRole('button', { name: '关闭镜头详情' }); if (await hide.isVisible()) await hide.click();   // 窄屏详情是浮层，先关掉
    const rows = page.locator('tr[data-shot]'), before = await rows.count();
    const last = rows.nth(before - 1); await last.scrollIntoViewIfNeeded(); await last.click({ button: 'right' });
    const box = await page.getByRole('menu').boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y + box.height <= 760, '窄屏菜单应完整在屏幕内');
    await shot('segments-menu-narrow');
    await page.getByRole('menuitem', { name: '在下方插入镜头' }).click();
    await expect(rows).toHaveCount(before + 1);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('G13 阅读模式左侧目录：段/场/镜与正文一致；点一镜跳过去并高亮；滚动时高亮跟着走；收起会记住；深色主题不是白底；窄屏默认收起、滑出后点一镜自动收回', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'forest'; });
    const reading = page.getByRole('dialog', { name: '分镜阅读模式' }), nav = reading.getByRole('navigation', { name: '目录' });
    await page.getByRole('button', { name: '阅读模式' }).click();
    await expect(nav).toBeVisible();
    await expect(reading.getByLabel('跳到场次')).toHaveCount(0);
    const seg = await api('/storyboard/projects/' + second.id + '/segments');
    await expect(nav.locator('.sb-reading-nav-seg')).toHaveCount(seg.segments.length);
    await expect(nav.locator('.sb-reading-nav-shot')).toHaveCount(await reading.locator('article[data-shot]').count());
    const target = seg.segments.at(-1).shot_ids[2];
    await nav.locator(`[data-nav-shot="${target}"]`).click();
    await expect(nav.locator(`[data-nav-shot="${target}"]`)).toHaveAttribute('aria-current', 'location');
    await expect(reading.locator(`article[data-shot="${target}"]`)).toBeInViewport();
    await shot('reading-nav-1-wide');
    await reading.locator('.sb-reading-body').evaluate(el => { el.scrollTop = 0; });
    await expect(nav.locator('[aria-current="location"]')).not.toHaveAttribute('data-nav-shot', target);
    await reading.getByRole('button', { name: '目录' }).click();
    await expect(nav).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '阅读模式' }).click();
    await expect(reading.getByRole('navigation', { name: '目录' })).toHaveCount(0);
    await reading.getByRole('button', { name: '目录' }).click();
    await expect(nav).toBeVisible();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    const bg = await reading.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(bg, 'rgb(255, 255, 255)', '深色主题下阅读模式不应是白底');
    await shot('reading-nav-2-dark');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'forest'; });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 760 });
    await page.getByRole('button', { name: '阅读模式' }).click();
    await expect(reading.getByRole('navigation', { name: '目录' })).toHaveCount(0);
    await reading.getByRole('button', { name: '目录' }).click();
    await expect(nav).toBeVisible();
    await shot('reading-nav-3-narrow');
    await nav.locator('.sb-reading-nav-shot').nth(3).click();
    await expect(nav).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('G14 目录高亮只看当前滚动位置（往返回到同一位置结果相同）；窄屏键盘选镜后焦点落到正文那一镜；很长的场景名不撑出横向滚动', async () => {
    const reading = page.getByRole('dialog', { name: '分镜阅读模式' }), nav = reading.getByRole('navigation', { name: '目录' }), bodyBox = reading.locator('.sb-reading-body');
    await page.getByRole('button', { name: '阅读模式' }).click();
    await expect(nav).toBeVisible();
    const base = await bodyBox.evaluate(el => el.querySelectorAll('article[data-shot]')[9].offsetTop);
    const seen = new Map();
    for (const d of [0, 60, 150, 270, 200, 80, 280, 780, 280, 0, 150]) {
      const top = base + d;
      await bodyBox.evaluate((el, t) => { el.scrollTop = t; }, top);
      await page.waitForTimeout(150);
      const { at, oracle } = await bodyBox.evaluate(el => { const line = el.getBoundingClientRect().top + 56; const hit = [...el.querySelectorAll('article[data-shot]')].find(a => a.getBoundingClientRect().bottom > line); return { at: el.scrollTop, oracle: hit?.dataset.shot }; });
      const cur = await nav.locator('[aria-current="location"]').getAttribute('data-nav-shot');
      assert.equal(cur, oracle, '高亮应是阅读线处的那一镜（scrollTop ' + at + '）');
      if (seen.has(at)) assert.equal(cur, seen.get(at), '回到同一位置 ' + at + ' 高亮应相同'); else seen.set(at, cur);
    }
    await page.keyboard.press('Escape');
    // 很长的场景名：只在目录里省略，完整名放 title；目录内容不横向滚动
    const cur = await api('/storyboard/projects/' + second.id); const p = structuredClone(cur.project);
    const longName = 'Location_' + 'VeryLongLocationName'.repeat(12); p.scenes[0].location = longName;
    await api('/storyboard/projects/' + second.id, { project: p, expected_revision: cur.revision, change: { author: 'user' }, request_id: randomUUID() }, 'PUT');
    await page.goto(origin + '/?r=' + Date.now() + '#/storyboards');
    const drop = page.getByRole('button', { name: '丢弃草稿' }); await drop.waitFor({ timeout: 15000 }); await drop.click();   // G12 留下的未保存插入
    await open(second.id);
    await page.getByRole('button', { name: '阅读模式' }).click();
    await expect(nav).toBeVisible();
    const geo = await nav.evaluate(el => ({ cw: el.clientWidth, sw: el.scrollWidth }));
    assert.ok(geo.sw <= geo.cw + 1, '目录不应横向滚动：' + JSON.stringify(geo));
    await expect(nav.locator('.sb-reading-nav-scene').first()).toHaveAttribute('title', new RegExp(longName));
    await expect(nav.locator('.sb-reading-nav-shot').first()).toBeInViewport();
    await page.keyboard.press('Escape');
    // 窄屏键盘：Enter / 空格选镜，目录收起后焦点在正文那一镜
    await page.setViewportSize({ width: 390, height: 760 });
    await page.getByRole('button', { name: '阅读模式' }).click();
    for (const [key, i] of [['Enter', 5], [' ', 7]]) {
      await reading.getByRole('button', { name: '目录' }).focus(); await page.keyboard.press('Enter');
      await expect(nav).toBeVisible();
      const item = nav.locator('.sb-reading-nav-shot').nth(i), id = await item.getAttribute('data-nav-shot');
      await item.focus(); await page.keyboard.press(key === ' ' ? 'Space' : key);
      await expect(nav).toHaveCount(0);
      const focused = await page.evaluate(() => ({ shot: document.activeElement?.getAttribute('data-shot'), inReading: !!document.activeElement?.closest('.sb-reading') }));
      assert.deepEqual(focused, { shot: id, inReading: true }, key + ' 选镜后焦点应在正文这一镜');
    }
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  assert.deepEqual(errors, [], '页面不应报错');
  assert.deepEqual(foreign, [], '不应访问外部地址');
  passed = true;
} finally {
  await browser?.close(); child.kill('SIGTERM'); await exited;
  if (passed) await fs.rm(temp, { recursive: true, force: true }); else console.log('临时目录保留：' + temp + '\n' + logs.slice(-2000));
}
