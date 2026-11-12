// 目录页卡片状态在六套主题下的可读性，以及右键菜单在小窗口里的位置（PR #80 FE2-R1/R2）。
// 真实本地服务 + 合成剧集；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const themes = [...(await fs.readFile(path.join(root, 'src/theme-list.ts'), 'utf8')).matchAll(/\{ id: "([a-z]+)"/g)].map(m => m[1]);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-folder-states-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const pf = () => page.locator('.pf');
const ep = n => pf().getByRole('button', { name: new RegExp(`^穿越计 第 1 季 第 ${n} 集(（当前项目）)?$`) });
const menu = () => page.getByRole('menu', { name: '操作' });

// 在页面里算对比度：卡片背景（含半透明合成到页面底色）与卡片里标题 / 小字的颜色。
async function contrastOf(cardButton) {
  return cardButton.evaluate(btn => {
    const probe = document.createElement('canvas').getContext('2d');
    const rgba = c => { probe.clearRect(0, 0, 1, 1); probe.fillStyle = '#000'; probe.fillStyle = c; probe.fillRect(0, 0, 1, 1); const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data; return [r, g, b, a / 255]; };
    const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const card = btn.closest('.pf-card'), page = rgba(getComputedStyle(document.querySelector('.pf') ?? document.body).backgroundColor);
    const base = page[3] ? page : rgba(getComputedStyle(document.body).backgroundColor);
    const bg = rgba(getComputedStyle(card).backgroundColor), mix = bg.slice(0, 3).map((v, i) => v * bg[3] + base[i] * (1 - bg[3]));
    return { title: ratio(rgba(getComputedStyle(btn.querySelector('b')).color), mix), sub: ratio(rgba(getComputedStyle(btn.querySelector('small')).color), mix) };
  });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const s = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  for (let i = 1; i <= 4; i++) await api(`/project-series/${s.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

  await check(`FE2-R1 反例：${themes.length} 套主题下，悬停、按 ⌘ 多选两集时卡片标题对比度 ≥ 4.5、小字 ≥ 4.5`, async () => {
    assert.ok(themes.includes('dark') && themes.includes('midnight'), '主题清单应包含深色与午夜蓝');
    const report = [];
    for (const theme of themes) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript(t => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); localStorage.setItem('shiguang.theme', t); } catch {} }, theme);
      page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await pf().getByRole('button', { name: '打开剧 穿越计' }).click(); await pf().getByRole('button', { name: '打开 第 1 季' }).click();
      await ep(2).hover(); await page.waitForTimeout(150);
      const hover = await contrastOf(ep(2));
      await ep(1).click(); await ep(3).click({ modifiers: ['Meta'] }); await page.mouse.move(5, 5); await page.waitForTimeout(150);
      await expect(pf().locator('.pf-episode[data-selected]')).toHaveCount(2);
      const picked = await contrastOf(ep(3));
      report.push({ theme, hover, picked });
      await context.close();
    }
    const bad = report.flatMap(r => ['hover', 'picked'].flatMap(k => ['title', 'sub'].filter(f => r[k][f] < 4.5).map(f => `${r.theme} ${k} ${f} ${r[k][f].toFixed(2)}`)));
    assert.deepEqual(bad, [], '对比度不足：' + bad.join('；'));
  });

  await check('FE2-R2 反例：1280×600 窗口右键第 2 集，菜单整个在窗口内，「改名」「删除」可点到（不执行删除）', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 600 } });
    await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();
    await pf().getByRole('button', { name: '打开剧 穿越计' }).click(); await pf().getByRole('button', { name: '打开 第 1 季' }).click();
    await ep(2).click({ button: 'right' }); await expect(menu()).toBeVisible();
    const box = await menu().boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= 600, '菜单越界：' + JSON.stringify(box));
    const del = menu().getByRole('menuitem', { name: '删除' }); await del.scrollIntoViewIfNeeded(); await del.hover();
    const delBox = await del.boundingBox(); assert.ok(delBox.y + delBox.height <= 600, '删除项不在窗口内：' + JSON.stringify(delBox));
    await menu().getByRole('menuitem', { name: '改名' }).click(); await expect(page.getByRole('dialog', { name: '编辑项目' })).toBeVisible();
    await page.getByRole('dialog', { name: '编辑项目' }).getByRole('button', { name: '取消' }).click();
    await context.close();
  });

  await check('FE2-R2 反例：1280×360 极矮窗口，菜单限高并在内部滚动，最后一项能滚到并可悬停', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 360 } });
    await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();
    await pf().getByRole('button', { name: '打开剧 穿越计' }).click(); await pf().getByRole('button', { name: '打开 第 1 季' }).click();
    await ep(1).scrollIntoViewIfNeeded(); await ep(1).click({ button: 'right' }); await expect(menu()).toBeVisible();
    const box = await menu().boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= 360, '菜单越界：' + JSON.stringify(box));
    assert.ok(await menu().evaluate(m => m.scrollHeight > m.clientHeight), '菜单应可在内部滚动');
    const del = menu().getByRole('menuitem', { name: '删除' }); await del.scrollIntoViewIfNeeded(); await del.hover();
    const delBox = await del.boundingBox(); assert.ok(delBox.y >= 0 && delBox.y + delBox.height <= 360, '删除项滚不到：' + JSON.stringify(delBox));
    await context.close();
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-folder-states-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
