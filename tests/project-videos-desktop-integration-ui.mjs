// #47 前端 × #49 后端联调（合同 v1）。
// 1) 真实 App（MEDIA_DISABLE_DESKTOP_NATIVE=1）：真实 capabilities 不可用时，前端禁用并显示后台原因。
// 2) 桌面操作请求原样转发到“真实 catalog/router/SQLite + 测试原生替身”（tests/helpers/project-video-desktop-fixture.mjs），
//    只替换双方的项目与视频编号；验证真实回执字段、202→GET、失败/跳过、回应丢失不重发、核对过期。
// 不写系统剪贴板、不打开访达；不增加任何产品后门。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import { chromium, expect } from '@playwright/test';
import { fixture, imported, replaceBytes } from './helpers/project-video-desktop-fixture.mjs';
import { projectVideoRouter } from '../server/project-videos/router.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pv-desktop-integ-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
async function clip(name, color) {
  const file = path.join(clips, name);
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
  assert.equal(run.status, 0, run.stderr?.toString()); return file;
}
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], cleanups = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) {
  const binary = Buffer.isBuffer(body);
  const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': binary ? 'application/octet-stream' : 'application/json' }, body: binary ? body : body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
let projectId; const pv = suffix => `/project-videos/projects/${encodeURIComponent(projectId)}${suffix}`;
async function seedVideo(file) {
  const bytes = await fs.readFile(file), requestId = crypto.randomUUID();
  await api(pv('/imports'), { requestId, folderId: 'root', fileName: path.basename(file), bytes: bytes.length, prompt: { mode: 'none' } });
  const receipt = await api(pv(`/imports/${requestId}/content`), bytes, 'PUT'); assert.equal(receipt.status, 'ready');
}
const work = () => page.getByRole('region', { name: '项目生成视频' }), cards = () => work().locator('.pv-card[data-video-id]');
const bar = () => work().getByRole('toolbar', { name: '已选视频操作' }), banner = () => work().locator('.pv-desktop-banner'), modal = () => page.locator('.pv-modal');
const refresh = async () => { await work().getByRole('button', { name: '更多视频操作' }).click(); await page.getByRole('menuitem', { name: /刷新视频资料/ }).click(); };
async function pick(indexes) { const all = await cards().all(); await all[indexes[0]].click(); for (const i of indexes.slice(1)) await all[i].click({ modifiers: ['Meta'] }); }

try {
  // ---- 真实后端 + 测试原生替身 ----
  const f = await fixture({ after: fn => cleanups.push(fn) });
  const fx = [await imported(f), await imported(f), await imported(f), await imported(f)];
  await fs.rm(fx[3].path); // 第四个文件缺失：真实后端应逐项跳过
  const fxApp = express(); fxApp.use('/api/project-videos', projectVideoRouter(f.catalog, { sendMedia: async (_q, res, _file, handle) => res.end(await handle.readFile()) }));
  const fxServer = http.createServer(fxApp); await new Promise(r => fxServer.listen(0, '127.0.0.1', r));
  cleanups.unshift(async () => { fxServer.closeAllConnections(); await new Promise(r => fxServer.close(r)); });
  const fxBase = `http://127.0.0.1:${fxServer.address().port}/api/project-videos/projects/${f.project.id}`;

  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '联调短片' })).id;
  for (const [name, color] of [['甲.mp4', 'green'], ['乙.mp4', 'brown'], ['丙.mp4', 'gray'], ['丁.mp4', 'navy']]) await seedVideo(await clip(name, color));

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await page.locator('.topbar-project-slot select').selectOption(projectId);
  await expect(cards()).toHaveCount(4);
  const appIds = await cards().evaluateAll(list => list.map(el => el.dataset.videoId));

  await check('真实 App 禁用原生能力时：列表返回 capabilities，复制与批量定位禁用并显示后台原因', async () => {
    const list = await api(pv('?folderId=root'));
    assert.equal(list.capabilities?.version, 1); assert.equal(list.capabilities.maxSelection, 50); assert.equal(list.capabilities.clipboard.available, false);
    await pick([0, 1]);
    await expect(bar().getByRole('button', { name: '复制' })).toBeDisabled();
    await expect(bar().getByRole('button', { name: '在访达中显示' })).toBeDisabled();
    if (list.capabilities.clipboard.reason) await expect(bar()).toContainText(list.capabilities.clipboard.reason);
    await bar().getByRole('button', { name: '取消选择' }).click();
  });

  // ---- 转发：页面发出的桌面操作 → 真实后端（替身原生）；编号双向替换 ----
  const toFx = new Map([[projectId, f.project.id], ...appIds.map((id, i) => [id, fx[i].id])]), toApp = new Map([...toFx].map(([a, b]) => [b, a]));
  const swap = (text, map) => { let out = text; for (const [a, b] of map) out = out.split(a).join(b); return out; };
  const counters = { forwarded: 0 }; let dropNext = '';
  async function forward(route, suffix) {
    const req = route.request(), body = req.postData();
    const res = await fetch(fxBase + suffix, { method: req.method(), headers: { 'content-type': 'application/json' }, body: body ? swap(body, toFx) : undefined });
    const text = swap(await res.text(), toApp); counters.forwarded++;
    if (dropNext && suffix.startsWith(dropNext)) { dropNext = ''; return route.abort('failed'); } // 真实请求已到后端，只丢回应
    await route.fulfill({ status: res.status, contentType: 'application/json', body: text });
  }
  const fxCaps = (await (await fetch(fxBase)).json()).capabilities;
  await page.route(url => url.pathname === `/api/project-videos/projects/${projectId}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch(), data = await res.json(); if (res.ok()) data.capabilities = fxCaps; await route.fulfill({ status: res.status(), json: data });
  });
  await page.route(`**/api/project-videos/projects/${projectId}/videos/clipboard`, r => forward(r, '/videos/clipboard'));
  await page.route(`**/api/project-videos/projects/${projectId}/videos/reveal/preview`, r => forward(r, '/videos/reveal/preview'));
  await page.route(`**/api/project-videos/projects/${projectId}/videos/reveal`, r => forward(r, '/videos/reveal'));
  await page.route(`**/api/project-videos/projects/${projectId}/desktop-actions/*`, r => forward(r, '/desktop-actions/' + r.request().url().split('/desktop-actions/')[1]));
  await refresh();

  await check('复制（真实回执）：3 选 2 可用，缺失项逐项跳过；原生只写一次、顺序为可见顺序', async () => {
    await pick([0, 3, 1]);
    await bar().getByRole('button', { name: '复制' }).click();
    await expect(banner()).toContainText('已将 2 个视频文件复制到系统剪贴板', { timeout: 20000 }); await expect(banner()).toContainText('跳过 1 个');
    assert.equal(f.native.copies.length, 1, '原生剪贴板只写一次');
    const written = (f.native.copies[0].paths ?? f.native.copies[0]).map(p => path.basename(String(p)));
    assert.deepEqual(written, [path.basename(fx[0].path), path.basename(fx[1].path)], '按可见顺序写入，缺失项不写');
    await banner().locator('summary').click(); await expect(banner().locator('li')).toHaveCount(1);
    await banner().getByRole('button', { name: '收起提示' }).click();
  });

  await check('复制只选缺失文件：真实 failed / NO_VALID_FILES 不显示成功，原生不写', async () => {
    const before = f.native.copies.length; await (await cards().all())[3].click(); await page.keyboard.press('Meta+C');
    await expect(banner()).not.toContainText('已将', { timeout: 20000 }); await expect(banner()).toHaveAttribute('data-tone', 'bad');
    assert.equal(f.native.copies.length, before); await banner().getByRole('button', { name: '收起提示' }).click();
  });

  await check('复制回应丢失：后端已执行，前端待核对；查询原请求取回原回执，原生不重复写', async () => {
    const before = f.native.copies.length; dropNext = '/videos/clipboard';
    await pick([0, 1]); await bar().getByRole('button', { name: '复制' }).click();
    await expect(banner()).toContainText('结果待核对');
    await expect.poll(() => f.native.copies.length, { timeout: 20000 }).toBe(before + 1);
    await banner().getByRole('button', { name: '查询原请求' }).click();
    await expect(banner()).toContainText('已将 2 个视频文件复制到系统剪贴板', { timeout: 20000 });
    assert.equal(f.native.copies.length, before + 1, '查询不应重复写剪贴板'); await banner().getByRole('button', { name: '收起提示' }).click();
  });

  await check('批量在访达中显示（真实回执）：先核对目录数，确认后才派发', async () => {
    const before = f.native.reveals.length; await pick([0, 1]);
    await bar().getByRole('button', { name: '在访达中显示' }).click();
    await expect(modal()).toContainText(/将在 \d+ 个目录中定位 2 个文件/, { timeout: 20000 }); assert.equal(f.native.reveals.length, before, '确认前不派发');
    await modal().getByRole('button', { name: /在访达中定位 2 个文件/ }).click();
    await expect(modal()).toContainText('已请求在访达显示 2 个文件', { timeout: 20000 }); assert.equal(f.native.reveals.length, before + 1);
    await modal().getByRole('button', { name: '完成' }).click(); await expect(modal()).toHaveCount(0);
  });

  await check('核对后内容改变：真实执行被拒，不显示已请求，原生不派发', async () => {
    const before = f.native.reveals.length; await pick([0, 1]);
    await bar().getByRole('button', { name: '在访达中显示' }).click(); await expect(modal()).toContainText(/将在 \d+ 个目录中定位 2 个文件/, { timeout: 20000 });
    await replaceBytes(f, fx[0]);
    await modal().getByRole('button', { name: /在访达中定位 2 个文件/ }).click();
    await expect(modal()).not.toContainText('已请求在访达显示 2 个文件', { timeout: 20000 });
    await expect(modal().locator('.pv-error, [role=alert]')).toBeVisible({ timeout: 20000 });
    assert.equal(f.native.reveals.length, before, '内容改变后不应派发');
    await modal().locator('.pv-dialog-actions').getByRole('button').first().click(); await expect(modal()).toHaveCount(0);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  console.log('forwarded requests:', counters.forwarded);
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'pv-desktop-integ-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); const code = await exited; console.log('app exit:', code);
  for (const fn of cleanups) { try { await fn(); } catch (e) { console.error('cleanup:', e.message); passed = false; } }
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
