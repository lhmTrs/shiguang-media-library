// 合同 D 前端（#52）：内容确实变化时的预览、继续使用、不再使用。
// 页面里的核对 / 接受 / 移除请求原样转发到“真实 catalog/router/SQLite + 测试原生替身与废纸篓”
// （tests/helpers/project-video-desktop-fixture.mjs），只替换项目与视频编号；候选媒体按原样（含 Range）转发。
// 页面列表只注入“内容已变化/待核验”的状态以显示入口。不碰真实素材与真实废纸篓。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import express from 'express';
import { chromium, expect } from '@playwright/test';
import { fixture, imported, initialize, bind, replaceBytes, appendXmp } from './helpers/project-video-desktop-fixture.mjs';
import { projectVideoRouter } from '../server/project-videos/router.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pv-change-ui-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
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
const work = () => page.getByRole('region', { name: '项目生成视频' }), modal = () => page.locator('.pv-modal');
const detail = () => work().getByRole('complementary', { name: '视频详情' });
const cardAt = i => work().locator(`.pv-card[data-video-id="${appIds[i]}"]`);
let appIds = [];
async function openChange(i) {
  await cardAt(i).click(); await detail().getByRole('button', { name: '处理内容变化…' }).click(); await expect(modal()).toContainText('处理内容变化');
}

try {
  // ---- 真实后端 + 测试替身 ----
  const f = await fixture({ after: fn => cleanups.push(fn) });
  const fx = []; for (let i = 0; i < 6; i++) fx.push(await imported(f));
  initialize(f); await bind(f, fx[0], [0]); await bind(f, fx[1], [1, 2]); // fx1 跨两个镜号，变短后第二段越界
  await replaceBytes(f, fx[0]); await replaceBytes(f, fx[1], { duration: 1.5 }); await replaceBytes(f, fx[2]); await replaceBytes(f, fx[3]);
  await appendXmp(fx[4]); await replaceBytes(f, fx[5]);
  const fxApp = express(); fxApp.use('/api/project-videos', projectVideoRouter(f.catalog, { sendMedia: async (req, res, _file, handle) => { const data = await handle.readFile(); res.setHeader('content-type', 'video/mp4'); res.end(data); } }));
  const fxServer = http.createServer(fxApp); await new Promise(r => fxServer.listen(0, '127.0.0.1', r));
  cleanups.unshift(async () => { fxServer.closeAllConnections(); await new Promise(r => fxServer.close(r)); });
  const fxOrigin = `http://127.0.0.1:${fxServer.address().port}`;
  const fxState = async id => (await f.catalog.list(f.project.id, { folderId: 'root' })).videos.find(v => v.id === id); // root 视图会逐个核验，all 视图不核验

  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '内容变化短片' })).id;
  for (const [n, c] of [['一.mp4', 'green'], ['二.mp4', 'brown'], ['三.mp4', 'gray'], ['四.mp4', 'navy'], ['五.mp4', 'purple'], ['六.mp4', 'olive']]) await seedVideo(await clip(n, c));

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await page.locator('.topbar-project-slot select').selectOption(projectId);
  await expect(work().locator('.pv-card[data-video-id]')).toHaveCount(6);
  appIds = await work().locator('.pv-card[data-video-id]').evaluateAll(list => list.map(el => el.dataset.videoId));

  // 编号映射与转发
  const toFx = new Map([[projectId, f.project.id], ...appIds.map((id, i) => [id, fx[i].id])]), toApp = new Map([...toFx].map(([a, b]) => [b, a]));
  const swap = (text, map) => { let out = text; for (const [a, b] of map) out = out.split(a).join(b); return out; };
  const marks = { 0: 'content_changed', 1: 'content_changed', 2: 'content_changed', 3: 'content_changed', 4: 'needs_verification', 5: 'content_changed' };
  const counters = { previewPosts: 0 }; let dropNextPreview = false, mutateAfterPreview = null, forceKind = '', realKinds = [], forcePartial = '';
  await page.route(url => url.pathname === `/api/project-videos/projects/${projectId}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch(), data = await res.json();
    if (res.ok()) for (const v of data.videos) { const i = appIds.indexOf(v.id); if (marks[i]) { v.status = marks[i] === 'content_changed' ? 'changed' : 'untrusted'; v.verification = { state: marks[i], match: null, metadataChanged: false }; } }
    await route.fulfill({ status: res.status(), json: data });
  });
  const forwarded = /\/videos\/[^/]+\/(changes\/preview|accept-change|remove\/preview|remove|changes\/[^/]+\/media)$|\/desktop-actions\/[^/]+$/;
  await page.route(url => url.pathname.startsWith(`/api/project-videos/projects/${projectId}/`) && forwarded.test(url.pathname), async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.endsWith('/remove') && !(req.postData() || '').includes('requestId')) return route.fallback(); // 旧移除入口不转发
    const target = fxOrigin + swap(url.pathname, toFx) + url.search;
    if (url.pathname.includes('/changes/') && url.pathname.endsWith('/media')) {
      const res = await fetch(target, { method: req.method(), headers: req.headers().range ? { range: req.headers().range } : {} });
      const headers = {}; for (const h of ['content-type', 'content-range', 'accept-ranges', 'content-length']) { const v = res.headers.get(h); if (v) headers[h] = v; }
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    }
    const body = req.postData();
    if (url.pathname.endsWith('/changes/preview')) counters.previewPosts++;
    const res = await fetch(target, { method: req.method(), headers: { 'content-type': 'application/json' }, body: body ? swap(body, toFx) : undefined });
    let text = swap(await res.text(), toApp);
    // 记录真实后端给出的 changeKind；需要验证某种文案时，只改写这一个字段（流程仍由真实后端处理）
    if (text.includes('"changeKind"')) { const j = JSON.parse(text); realKinds.push(j.changeKind); if (forceKind) { j.changeKind = forceKind; if (forceKind === 'metadata_only') j.canAccept = false; text = JSON.stringify(j); } }
    // 模拟“记录已移除、文件处理失败/未知”的部分完成回执（只改写显示用的 file 与 status，验证界面分层显示）
    if (forcePartial && text.includes('"record"') && /"status":"(completed|partial)"/.test(text)) { const j = JSON.parse(text); j.status = 'partial'; j.file = forcePartial === 'failed' ? { action: 'trash', status: 'failed', code: 'TRASH_FAILED', reason: '测试：废纸篓暂不可用' } : { action: 'trash', status: 'unknown', code: 'TRASH_UNSETTLED' }; text = JSON.stringify(j); forcePartial = ''; }
    // 核对结果为 ready 并即将交给页面时，才改写文件：模拟“核对之后、接受之前文件又被改”
    if (mutateAfterPreview && text.includes('"changeKind"') && text.includes('"status":"ready"')) { const m = mutateAfterPreview; mutateAfterPreview = null; await m(); }
    if (dropNextPreview && url.pathname.endsWith('/changes/preview')) { dropNextPreview = false; return route.abort('failed'); }
    await route.fulfill({ status: res.status, contentType: 'application/json', body: text });
  });
  await work().getByRole('button', { name: '更多视频操作' }).click(); await page.getByRole('menuitem', { name: /刷新视频资料/ }).click();
  await expect(cardAt(0)).toContainText('内容已变化');

  await check('内容已变化：核对显示变化与对照，点击后才播放冻结内容；勾选接受后继续使用，原采用保留', async () => {
    forceKind = 'content_changed'; await openChange(0);
    await expect(modal()).toContainText('视频内容已发生变化'); forceKind = ''; await expect(modal()).toContainText('原内容未保留，无法回放对照');
    assert.equal(await modal().locator('video').count(), 0, '未点击前不播放');
    await modal().getByRole('button', { name: '播放当前内容' }).click();
    await expect.poll(() => modal().locator('video').evaluate(v => v.readyState), { timeout: 15000 }).toBeGreaterThan(0);
    const go = modal().getByRole('button', { name: '继续使用当前内容' }); await expect(go).toBeDisabled();
    await modal().getByLabel('我已核对当前内容，接受它作为这个视频的新内容').check(); await go.click();
    await expect(modal()).toContainText('已接受当前内容'); await expect(modal()).toContainText('保留 1 个镜号的采用');
    await modal().getByRole('button', { name: '完成' }).click(); await expect(modal()).toHaveCount(0);
    const v = await fxState(fx[0].id); assert.equal(v.adoptedShots.length, 1, '原采用保留'); assert.equal(v.status, 'available');
  });

  await check('变短：越界镜号必须精确确认解除，接受后只解除越界的采用', async () => {
    await openChange(1); await expect(modal()).toContainText('超出新时长');
    await modal().getByLabel('我已核对当前内容，接受它作为这个视频的新内容').check();
    const go = modal().getByRole('button', { name: '继续使用当前内容' }); await expect(go).toBeDisabled();
    await modal().getByLabel(/确认解除 镜 .* 的采用/).check(); await go.click();
    await expect(modal()).toContainText(/解除 \d+ 个超出新时长的镜号采用/); await modal().getByRole('button', { name: '完成' }).click();
    assert.ok((await fxState(fx[1].id)).adoptedShots.length < 2, '只解除越界的采用');
  });

  await check('不再使用 + 保留文件：每次选择处理方式，确认后移除记录并解除采用，文件仍在', async () => {
    await openChange(2); await modal().getByRole('button', { name: '不再使用…' }).click();
    await expect(modal()).toContainText('这个文件怎么处理'); const go = modal().getByRole('button', { name: /^移除记录/ });
    await expect(go).toBeDisabled();
    await modal().getByLabel('只移除记录，文件保留在原位置').check();
    const unbind = modal().getByLabel(/确认解除 镜 .* 的采用/); if (await unbind.count()) { await expect(go).toBeDisabled(); await unbind.check(); }
    await go.click();
    await expect(modal()).toContainText('已移除视频记录'); await expect(modal()).toContainText('文件：已保留在原位置');
    await modal().getByRole('button', { name: '完成' }).click();
    assert.equal(await fxState(fx[2].id), undefined, '记录已移除'); await fs.access(fx[2].path);
  });

  await check('不再使用 + 移到废纸篓：回执分别显示记录与文件结果', async () => {
    await openChange(3); await modal().getByRole('button', { name: '不再使用…' }).click();
    await modal().getByLabel('移到系统废纸篓（不是永久删除，可从废纸篓找回）').check();
    await modal().getByRole('button', { name: '移除记录并移到废纸篓' }).click();
    await expect(modal()).toContainText('已移除视频记录', { timeout: 20000 }); await expect(modal()).toContainText('文件：已移到系统废纸篓');
    await modal().getByRole('button', { name: '完成' }).click();
    assert.equal(f.trash.length, 1); await assert.rejects(fs.access(fx[3].path));
  });

  await check('只改了元数据：核对回应丢失时只查询原请求，结果为内容一致、无需处理', async () => {
    const posts0 = counters.previewPosts; dropNextPreview = true;
    forceKind = 'metadata_only'; await openChange(4); await expect(modal()).toContainText('结果待核对');
    await modal().getByRole('button', { name: '查询原请求' }).click(); await expect(modal()).toContainText('视频内容一致'); forceKind = '';
    assert.equal(counters.previewPosts, posts0 + 1, '只提交一次核对'); await modal().getByRole('button', { name: '知道了' }).click();
  });

  await check('核对之后文件又被改：继续使用被真实后端拒绝，提示并可重新核对', async () => {
    mutateAfterPreview = () => replaceBytes(f, fx[5], { color: 'blue' });
    await openChange(5); await expect(modal()).toContainText(/视频内容已发生变化|无法确认是否只改了元数据/);
    await modal().getByLabel('我已核对当前内容，接受它作为这个视频的新内容').check();
    await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal().locator('.pv-error')).toBeVisible(); await expect(modal()).not.toContainText('已接受当前内容');
    await modal().getByRole('button', { name: '重新核对' }).click(); await expect(modal()).toContainText(/视频内容已发生变化|无法确认是否只改了元数据/);
    await page.locator('.pv-modal > header button[aria-label="关闭"]').click(); await expect(modal()).toHaveCount(0);
  });

  await check('移除部分完成：记录已移除、文件失败时分别显示，不说全部失败', async () => {
    await openChange(5); await expect(modal()).toContainText(/视频内容已发生变化|无法确认是否只改了元数据/);
    await modal().getByRole('button', { name: '不再使用…' }).click();
    await modal().getByLabel('移到系统废纸篓（不是永久删除，可从废纸篓找回）').check(); forcePartial = 'failed';
    await modal().getByRole('button', { name: '移除记录并移到废纸篓' }).click();
    await expect(modal()).toContainText('已移除视频记录', { timeout: 20000 }); await expect(modal()).toContainText('没有移到废纸篓，文件仍在原位置：测试：废纸篓暂不可用');
    await expect(modal().locator('.pv-callout[data-tone="warn"]')).toBeVisible(); await modal().getByRole('button', { name: '完成' }).click();
  });

  console.log('real changeKind values:', JSON.stringify(realKinds));
  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'pv-change-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); const code = await exited; console.log('app exit:', code);
  for (const fn of cleanups) { try { await fn(); } catch (e) { console.error('cleanup:', e.message); passed = false; } }
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
