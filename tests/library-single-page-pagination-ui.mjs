// 素材查找列表：素材很少（不论选几条/页都只有一页）且稳定读取完成时不显示底部分页条（UI 审计⑥，用户「只有一页时藏分页」）。
// 真实本地服务 + 合成图片；数量边界用 page.route 改写列表响应里的 total / pages / entries，不造几百张图。
// 覆盖：20 项藏、21 项显示；150 项且每页 200 仍显示（保留改每页数量的入口）；分组模式按列表条目数判断；
// 读取中、出错、参数读取中照常显示原提示。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'single-page-pagination-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
for (const name of ['外景_甲.png', '外景_乙.png', '外景_丙.png']) await fs.writeFile(path.join(images, name), Buffer.concat([png, Buffer.from(name)]));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, cookie, token, passed = false; const errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body) { const r = await fetch(origin + '/api' + p, { method: body ? 'POST' : 'GET', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const d = await r.json(); if (!r.ok) throw Error(p + ' ' + JSON.stringify(d)); return d; }
const evidence = process.env.CREATIVE_TEST_EVIDENCE;
async function check(name, fn) { await fn(); console.log('PASS ' + name); }

// 每个场景一个新页面：fake 决定列表响应怎么改写、是否挂起或失败，jobs 的 pending 改成多少
async function open(fake, { pageSize, flat = true } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(size => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); if (size) localStorage.setItem('shiguang.pageSize', String(size)); } catch {} }, pageSize ?? null);
  const list = u => ['/api/assets', '/api/asset-series'].includes(new URL(u).pathname);
  const held = [];
  await context.route(list, async route => {
    if (fake.fail) return route.abort('connectionreset');
    if (fake.hold) await new Promise(r => held.push(r));
    try {
      const response = await route.fetch(), json = await response.json();
      const series = new URL(route.request().url()).pathname === '/api/asset-series';
      Object.assign(json, series ? fake.series ?? {} : fake.flat ?? {});
      await route.fulfill({ response, json });
    } catch { /* 场景已关闭时的迟到请求 */ }
  });
  if (fake.pending) await context.route(u => new URL(u).pathname === '/api/jobs', async route => { try { const response = await route.fetch(), json = await response.json(); json.metadata = { ...json.metadata, pending: fake.pending }; await route.fulfill({ response, json }); } catch {} });
  const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/all');
  const work = page.locator('.pagination');
  if (!fake.hold && !fake.fail) {
    await expect(page.getByText(/\d+ 条结果/).first()).toBeVisible({ timeout: 15000 });
    const listButton = page.getByRole('button', { name: /列表/ }).first(); if (await listButton.isVisible().catch(() => false)) await listButton.click();
    const mode = page.getByRole('button', { name: flat ? '平铺' : '同系列分组', exact: true });
    if (await mode.isVisible().catch(() => false)) await mode.click();
    await page.waitForTimeout(700);
  }
  return { page, context, footer: work, release: () => { fake.hold = false; held.splice(0).forEach(r => r()); } };
}
const shot = async (page, name) => { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') }); } };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  await api('/roots', { path: images, kind: 'photo' });
  await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });

  await check('真实 3 项（平铺）：不显示分页条，顶部仍有「3 条结果」', async () => {
    const { page, context, footer } = await open({});
    await expect(page.getByText('3 条结果').first()).toBeVisible(); await expect(footer).toHaveCount(0); await shot(page, '3-hidden'); await context.close();
  });
  await check('边界：20 项、1 页 → 不显示；21 项、1 页 → 显示「共 21 项」和每页数量', async () => {
    let v = await open({ flat: { total: 20, pages: 1 } }); await expect(v.footer).toHaveCount(0); await v.context.close();
    v = await open({ flat: { total: 21, pages: 1 } }); await expect(v.footer).toBeVisible(); await expect(v.footer).toContainText('共 21 项'); await expect(v.page.getByLabel('每页显示数量')).toBeVisible(); await shot(v.page, '21-shown'); await v.context.close();
  });
  await check('150 项且每页 200（只有 1 页）仍显示分页条，每页数量保持 200 且可以改回 50', async () => {
    const v = await open({ flat: { total: 150, pages: 1 } }, { pageSize: 200 });
    await expect(v.footer).toBeVisible(); const select = v.page.getByLabel('每页显示数量'); await expect(select).toHaveValue('200');
    const reread = v.page.waitForResponse(r => /\/api\/asset(s|-series)\?/.test(r.url()) && new URL(r.url()).searchParams.get('pageSize') === '50');
    await select.selectOption('50'); await reread; await expect(select).toHaveValue('50'); await v.page.waitForTimeout(400); await v.context.close();
  });
  await check('多页时一定显示：10 项但 pages 为 2', async () => {
    const v = await open({ flat: { total: 10, pages: 2 } }); await expect(v.footer).toBeVisible(); await v.context.close();
  });
  await check('分组模式按列表条目数判断：素材 40 但条目 5 → 不显示；素材 12 但条目 25 → 显示', async () => {
    let v = await open({ series: { total: 40, entries: 5, pages: 1 } }, { flat: false }); await expect(v.footer).toHaveCount(0); await v.context.close();
    v = await open({ series: { total: 12, entries: 25, pages: 1 } }, { flat: false }); await expect(v.footer).toBeVisible(); await expect(v.footer).toContainText('25 个列表条目'); await v.context.close();
  });
  await check('读取中照常显示分页条和「数量尚未读到」；读完后（3 项）收起', async () => {
    const v = await open({ hold: true });
    await expect(v.footer).toBeVisible({ timeout: 10000 }); await expect(v.footer).toContainText('数量尚未读到'); await shot(v.page, 'loading-shown');
    v.release(); await expect(v.footer).toHaveCount(0, { timeout: 10000 }); await v.context.close();
  });
  await check('列表读取出错时照常显示分页条和「数量尚未读到」', async () => {
    const v = await open({ fail: true });
    await expect(v.footer).toBeVisible({ timeout: 10000 }); await expect(v.footer).toContainText('数量尚未读到'); await v.context.close();
  });
  await check('参数读取中（pending 3）照常显示「3 项参数读取中」', async () => {
    const v = await open({ pending: 3 });
    await expect(v.footer).toBeVisible(); await expect(v.footer).toContainText('3 项参数读取中'); await shot(v.page, 'pending-shown'); await v.context.close();
  });
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) console.log(logs.slice(-3000));
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
}
