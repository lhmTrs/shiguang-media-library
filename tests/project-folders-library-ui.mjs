// 目录位置与「刚新建的剧」按素材库隔离（SERIES-P1 FE4-R1）：同一地址先后启动两个不同数据目录的实例，同一浏览器标签换库后重新打开（新文档，sessionStorage 仍在）。
// 合成数据；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-libswap-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let browser, page, passed = false, server = null, holdSeries = false; const held = [];
const releaseAll = () => { for (const r of held.splice(0)) r(); }; const checks = [], errors = [];
async function start(name) {
  let logs = ''; const dir = path.join(temp, name);
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(dir, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(dir, 'personal'), CODEX_HOME: path.join(dir, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  const exited = new Promise(r => child.once('exit', r));
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  return { child, exited, logs: () => logs };
}
async function stop() { if (!server) return; server.child.kill('SIGTERM'); let timer; const r = await Promise.race([server.exited, new Promise(res => timer = setTimeout(() => res('timeout'), 10000))]); clearTimeout(timer); if (r === 'timeout') { server.child.kill('SIGKILL'); await server.exited; } server = null; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const pf = () => page.locator('.pf');
const heading = name => pf().getByRole('heading', { level: 1, name, exact: true });

try {
  server = await start('甲');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } }); await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch { /* about:blank 不允许访问 */ } });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.route(url => url.pathname === '/api/project-series', async route => { if (route.request().method() === 'GET' && holdSeries) await new Promise(r => held.push(r)); return route.fallback(); });
  await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();

  await check('库甲：新建剧后读列表挂起，页面已在新剧', async () => {
    holdSeries = true;
    await pf().locator('.project-blank').getByRole('button', { name: '新建剧' }).click();
    const d = page.getByRole('dialog', { name: '新建剧' }); await d.getByLabel('剧名').fill('甲的剧'); await d.getByRole('button', { name: '新建剧', exact: true }).click();
    await expect(heading('甲的剧')).toBeVisible();
  });

  await check('FE4-R1 反例：同一地址换成空库乙后在同一标签打开项目页：不显示甲的剧、没有「新建季」，停在乙的空根目录', async () => {
    holdSeries = false; releaseAll();
    await stop(); server = await start('乙');
    await page.goto('about:blank'); await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();
    await expect(heading('项目')).toBeVisible();
    await expect(pf().locator('.project-blank')).toBeVisible();
    await expect(pf().getByText('甲的剧')).toHaveCount(0); await expect(pf().getByRole('button', { name: '新建季' })).toHaveCount(0);
  });

  await check('换回库甲：回到甲时目录仍能进入甲的剧（它已真实存在）', async () => {
    await stop(); server = await start('甲');
    await page.goto('about:blank'); await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();
    await expect(heading('甲的剧')).toBeVisible();
  });

  assert.deepEqual(errors.filter(e => !/素材库实例已变化/.test(e)), [], '页面不应出现脚本错误：' + JSON.stringify(errors));
  passed = true;
} finally {
  if (!passed) { console.error(server?.logs().slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-libswap-failure.png') }).catch(() => {}); }
  holdSeries = false; releaseAll(); await browser?.close(); await stop(); await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
