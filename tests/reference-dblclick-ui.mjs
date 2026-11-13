// 详情参考图：单击打开「图片设置」、双击打开大图（单击稍等再弹窗，第二下点击才能成为双击）；键盘回车立即打开设置。
// 真实本地服务 + 合成图片；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar, projectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-dblclick-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const people = ['阿青', '海边', '阿蓝'];
for (const [i, name] of people.entries()) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${['aa5533', '3355aa', '2255cc'][i]}:s=300x400`, '-frames:v', '1', path.join(images, name + '.png')]);
  assert.equal(run.status, 0, run.stderr?.toString());
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const wrap = name => work().locator('.ca-card-wrap').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
const section = () => work().getByRole('region', { name: '人物属性' });
const shot = async name => { if (process.env.ATTR_SHOTS) await page.screenshot({ path: path.join(process.env.ATTR_SHOTS, name + '.png') }); };

const settingsOpen = () => page.getByRole('button', { name: '关闭图片设置' });
const viewer = () => page.getByRole('dialog', { name: '参考图片大图预览' });

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '双击短片' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  const ids = {};
  for (const [kind, name] of [['character', '阿青'], ['scene', '海边'], ['character', '阿蓝']]) {
    const a = await api('/project-assets/assets', { project_id: project.id, kind, name });
    const look = crypto.randomUUID(), img = crypto.randomUUID(), image = { id: img, look_id: kind === 'character' ? look : null, media_asset_id: media[name + '.png'].id, reference_type: kind === 'character' ? '人物身份' : '场景空间', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: name + '.png' };
    const asset = kind === 'character' ? { ...a, default_look_id: look, looks: [{ id: look, name: '日常', description: '', tags: [], default_image_id: img, archived_at: null }], images: [image] } : { ...a, default_image_id: img, images: [image] };
    await api('/project-assets/assets/' + a.id, { asset, expected_revision: a.revision }, 'PUT'); ids[name] = a.id;
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id);

  for (const [tab, name] of [['人物', '阿青'], ['场景', '海边']]) {
    await check(tab + '：双击参考图打开大图，不弹「图片设置」；单击稍后打开「图片设置」；回车立即打开；间隔约 0.32 秒的双击和放大镜都能放大', async () => {
      await work().getByRole('tab', { name: new RegExp('^' + tab) }).click(); await wrap(name).locator('.ca-card').click();
      const tile = work().locator('.ca-tile-open').first(); await expect(tile).toBeVisible();
      await tile.dblclick(); await expect(viewer()).toBeVisible(); await page.waitForTimeout(400); await expect(settingsOpen()).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
      await tile.click(); await expect(settingsOpen()).toBeVisible(); await expect(viewer()).toHaveCount(0);
      await settingsOpen().click(); await expect(settingsOpen()).toHaveCount(0);
      await tile.focus(); await page.keyboard.press('Enter'); await expect(settingsOpen()).toBeVisible({ timeout: 200 });
      await settingsOpen().click(); await expect(settingsOpen()).toHaveCount(0);
      // FE1-R1: a slower but normal double click (≈320 ms between the clicks) still opens the large view.
      const box = await tile.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 3;
      await page.mouse.click(x, y); await page.waitForTimeout(320); await page.mouse.click(x, y, { clickCount: 2 });
      await expect(viewer()).toBeVisible(); await page.waitForTimeout(500); await expect(settingsOpen()).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
      // The always-visible magnifier opens the large view at once, without 图片设置.
      await work().getByRole('button', { name: '放大查看：' + name + '.png' }).click(); await expect(viewer()).toBeVisible(); await page.waitForTimeout(500); await expect(settingsOpen()).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
    });
  }

  await check('FE1-R2 反例：单击参考图后立刻 Shift 点进入多选，排队的「图片设置」被取消，图片已选中', async () => {
    await work().getByRole('tab', { name: /^人物/ }).click(); await wrap('阿青').locator('.ca-card').click();
    const tile = work().locator('.ca-tile-open').first(); await expect(tile).toBeVisible();
    await tile.click(); await tile.click({ modifiers: ['Shift'], delay: 0 });
    await expect(work().getByRole('toolbar', { name: '已选参考图操作' })).toContainText('已选 1 张');
    await page.waitForTimeout(700); await expect(settingsOpen()).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await check('FE2-R3 反例：单击参考图后 0.4 秒内切到「剧本」，排队的「图片设置」不弹出、不盖住剧本；切回人物也不恢复，之后单击照常', async () => {
    await work().getByRole('tab', { name: /^人物/ }).click(); await wrap('阿青').locator('.ca-card').click();
    const tile = work().locator('.ca-tile-open').first(); await expect(tile).toBeVisible();
    await tile.click(); await work().getByRole('tab', { name: '剧本', exact: true }).click();
    await expect(work().getByRole('tab', { name: '剧本', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(650); await expect(settingsOpen()).toHaveCount(0);
    await work().getByRole('tab', { name: /^人物/ }).click(); await page.waitForTimeout(650); await expect(settingsOpen()).toHaveCount(0);
    await wrap('阿青').locator('.ca-card').click(); await work().locator('.ca-tile-open').first().click(); await expect(settingsOpen()).toBeVisible();
    await settingsOpen().click(); await expect(settingsOpen()).toHaveCount(0);
  });

  await check('卡片：双击人物、场景卡片放大默认图；右键「放大查看」同样放大；没有默认图时这一项停用', async () => {
    for (const [tab, name] of [['人物', '阿青'], ['场景', '海边']]) {
      await work().getByRole('tab', { name: new RegExp('^' + tab) }).click(); await expect(wrap(name)).toBeVisible();
      await wrap(name).locator('.ca-card').dblclick(); await expect(viewer()).toBeVisible(); await expect(viewer()).toContainText(name + '.png');
      await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
      await wrap(name).click({ button: 'right' }); await page.getByRole('menu', { name: name + '的操作' }).getByRole('menuitem', { name: '放大查看' }).click();
      await expect(viewer()).toBeVisible(); await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0);
    }
    await api('/project-assets/assets', { project_id: (await projectInBar(page).getAttribute('data-project')), kind: 'character', name: '无图人物' });
    await work().getByRole('tab', { name: /^人物/ }).click(); await work().getByRole('button', { name: '更多资产操作' }).click(); await work().getByRole('menuitem', { name: '刷新列表' }).click();
    await wrap('无图人物').click({ button: 'right' }); await expect(page.getByRole('menu', { name: '无图人物的操作' }).getByRole('menuitem', { name: '放大查看' })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  await check('不闪：再点已经打开的人物不重新读取；换人物时不出现整页的「正在读取」条，按钮不变灰', async () => {
    await page.evaluate(() => { window.__flash = 0; new MutationObserver(() => { if (document.querySelector('.ca-v2 > .ca-progress') || document.querySelector('fieldset.ca-interaction:disabled')) window.__flash++; }).observe(document.body, { subtree: true, childList: true, attributes: true }); });
    let reads = 0; const count = r => { if (r.method() === 'GET' && /\/api\/project-assets\/assets\/[^/?]+$/.test(new URL(r.url()).pathname)) reads++; }; page.on('request', count);
    await wrap('阿青').locator('.ca-card').click(); await expect(work().locator('.ca-name-input')).toHaveValue('阿青');
    const after = reads; await wrap('阿青').locator('.ca-card').click(); await wrap('阿青').locator('.ca-card').click(); await page.waitForTimeout(400);
    assert.equal(reads, after, 'clicking the open character does not reload');
    await wrap('无图人物').locator('.ca-card').click(); await expect(work().locator('.ca-name-input')).toHaveValue('无图人物');
    await wrap('阿青').locator('.ca-card').click(); await expect(work().locator('.ca-name-input')).toHaveValue('阿青');
    assert.equal(await page.evaluate(() => window.__flash), 0, 'no page-wide busy bar or disabled fieldset while opening details');
    page.off('request', count);
  });

  const holdDetail = async id => { let release; const gate = new Promise(r => { release = r; }); let held = false;
    const handler = async route => { if (!held && route.request().method() === 'GET' && new URL(route.request().url()).pathname.endsWith('/assets/' + id)) { held = true; await gate; } return route.fallback(); };
    const match = url => url.pathname.endsWith('/assets/' + id); await page.route(match, handler);
    return { release: () => release(), done: () => page.unroute(match, handler), seen: () => held }; };

  await check('FE1-R1 反例：双击另一个人物的卡片打开大图，那个人物的详情晚到时大图不会自己关掉', async () => {
    await work().getByRole('tab', { name: /^人物/ }).click(); await wrap('阿青').locator('.ca-card').click(); await expect(work().locator('.ca-name-input')).toHaveValue('阿青');
    const h = await holdDetail(ids['阿蓝']);
    await wrap('阿蓝').locator('.ca-card').dblclick(); await expect(viewer()).toBeVisible(); await expect(viewer()).toContainText('阿蓝.png'); await expect.poll(h.seen).toBe(true);
    h.release(); await expect(work().locator('.ca-name-input')).toHaveValue('阿蓝');
    await page.waitForTimeout(500); await expect(viewer()).toBeVisible();
    await page.keyboard.press('Escape'); await expect(viewer()).toHaveCount(0); await h.done();
  });

  await check('FE1-R2 反例：读取另一个人物期间，旧详情鼠标和键盘都不能编辑；读完不丢任何输入；切类别取消读取后不会卡在「读取中」', async () => {
    await wrap('阿青').locator('.ca-card').click(); await expect(work().locator('.ca-name-input')).toHaveValue('阿青');
    let h = await holdDetail(ids['阿蓝']);
    await wrap('阿蓝').locator('.ca-card').click(); await expect.poll(h.seen).toBe(true);
    const aside = work().getByRole('complementary', { name: '人物详情' }); await expect(aside).toHaveAttribute('aria-busy', 'true');
    const name = work().locator('.ca-name-input'), focused = () => name.evaluate(el => el === document.activeElement);
    await name.focus({ timeout: 1000 }).catch(() => {}); let reached = await focused();
    for (let i = 0; i < 40 && !reached; i++) { await page.keyboard.press('Tab'); reached = await focused(); }
    assert.equal(reached, false, 'old detail inputs cannot take focus (direct focus or Tab) while loading');
    await page.evaluate(() => document.activeElement?.blur()); await expect(name).toHaveValue('阿青');
    h.release(); await expect(name).toHaveValue('阿蓝'); await expect(aside).not.toHaveAttribute('aria-busy', 'true'); await h.done();
    h = await holdDetail(ids['阿青']);
    await wrap('阿青').locator('.ca-card').click(); await expect.poll(h.seen).toBe(true);
    await work().getByRole('tab', { name: /^场景/ }).click(); h.release(); await h.done();
    await work().getByRole('tab', { name: /^人物/ }).click(); await wrap('阿青').locator('.ca-card').click();
    await expect(work().locator('.ca-name-input')).toHaveValue('阿青'); await expect(work().locator('.ca-detail[aria-busy="true"]')).toHaveCount(0);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-dblclick-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
