// 废片收纳（#55 / PR #56）前端 × 真实后端联调。
// 页面对本项目的全部 /api/project-videos/projects/<id>/... 请求（列表、收纳处预览/执行、批量移动预览/执行、原请求查询）
// 都转发到“真实 catalog/router/SQLite + 测试废纸篓”（tests/helpers/project-video-desktop-fixture.mjs），只替换项目编号；
// 文件真的在临时目录里移动，采用关系由真实分镜存储解除。网络异常只有一种：在请求到达后台之前丢弃执行 POST（后台从未收到）。
// 不碰真实素材、真实废纸篓或现用服务。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { chromium, expect } from '@playwright/test';
import { fixture, imported, initialize, bind } from './helpers/project-video-desktop-fixture.mjs';
import { projectVideoRouter } from '../server/project-videos/router.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pv-reject-int-')));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], cleanups = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body) { const response = await fetch(origin + '/api' + p, { method: body ? 'POST' : 'GET', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); if (!response.ok) throw Error(data.error); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目生成视频' }), modal = () => page.locator('.pv-modal');
const card = id => work().locator(`.pv-card[data-video-id="${id}"]`);
const chip = () => work().locator('.pv-folder-reject');
const bar = () => work().getByRole('navigation', { name: /视频文件夹/ });
const menuMark = async id => { await card(id).click({ button: 'right' }); await page.getByRole('menuitem', { name: /标记.*为废片…/ }).click(); };

try {
  // ---- 真实后端 ----
  const f = await fixture({ after: fn => cleanups.push(fn) });
  initialize(f);
  const area = await f.catalog.folders.create(f.project.id, { requestId: randomUUID(), parentId: 'root', name: '废片' }); // 用户手建
  const v = []; for (let i = 0; i < 4; i++) v.push(await imported(f, `合成${i}.mp4`));
  await bind(f, v[0], [0]);
  const dupInArea = await imported(f, 'dup.mp4', area.id), dup = await imported(f, 'dup.mp4');
  const fxApp = express(); fxApp.use('/api/project-videos', projectVideoRouter(f.catalog, { sendMedia: async (_q, res, _file, handle) => { res.setHeader('content-type', 'video/mp4'); res.end(await handle.readFile()); } }));
  const fxServer = http.createServer(fxApp); await new Promise(r => fxServer.listen(0, '127.0.0.1', r));
  cleanups.unshift(async () => { fxServer.closeAllConnections(); await new Promise(r => fxServer.close(r)); });
  const fxOrigin = `http://127.0.0.1:${fxServer.address().port}`;
  const source = id => f.entry.store.source(f.project.id, id);
  const adopted = async () => Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length;

  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const projectId = (await api('/projects', { name: '废片联调' })).id;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));

  // ---- 转发：本项目全部视频接口 → 真实后端；只替换项目编号 ----
  const swap = (text, a, b) => text.split(a).join(b);
  const posts = [], statuses = []; let dropBefore = '';
  const base = `/api/project-videos/projects/${projectId}`;
  await page.route(url => url.pathname === base || url.pathname.startsWith(base + '/'), async route => {
    const req = route.request(), url = new URL(req.url()), suffix = url.pathname.slice(base.length);
    const target = `${fxOrigin}/api/project-videos/projects/${f.project.id}${suffix}${url.search}`;
    if (/\/media$|\/thumbnail/.test(suffix)) { const res = await fetch(target); return route.fulfill({ status: res.status, headers: { 'content-type': res.headers.get('content-type') || 'application/octet-stream' }, body: Buffer.from(await res.arrayBuffer()) }); }
    const body = req.postData() ? swap(req.postData(), projectId, f.project.id) : undefined;
    if (req.method() === 'POST') posts.push({ suffix, body: body ? JSON.parse(body) : null });
    if (req.method() === 'POST' && dropBefore && suffix === dropBefore) { dropBefore = ''; return route.abort('failed'); } // 后台从未收到
    const res = await fetch(target, { method: req.method(), headers: { 'content-type': 'application/json' }, body });
    const text = swap(await res.text(), f.project.id, projectId);
    if (['/folders/reject', '/operations'].includes(suffix) && req.method() === 'POST') statuses.push({ suffix, http: res.status, status: JSON.parse(text).status });
    await route.fulfill({ status: res.status, contentType: 'application/json', body: text });
  });
  const last = s => posts.filter(p => p.suffix === s).at(-1)?.body;
  const count = s => posts.filter(p => p.suffix === s).length;

  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await page.locator('.topbar-project-slot select').selectOption(projectId);
  await expect(card(v[0].id)).toBeVisible();

  await check('设置收纳处的执行 POST 未到后台：原请求只读查询为 unknown / OPERATION_NOT_STARTED，不报“已准备”，不重发、不创建或改动', async () => {
    await menuMark(v[1].id); await expect(modal()).toContainText('项目还没有废片收纳处');
    await modal().getByRole('button', { name: '核对影响' }).click(); await expect(modal()).toContainText('将把“废片”设为废片收纳处');
    await modal().getByLabel('确认设置废片收纳处').check(); dropBefore = '/folders/reject';
    await modal().getByRole('button', { name: '设为收纳处' }).click(); await expect(modal()).toContainText('结果待核对');
    const requestId = last('/folders/reject').requestId;
    await modal().getByRole('button', { name: '查询原请求' }).click(); await expect(modal()).toContainText('当前只有预览，执行尚未确认');
    await expect(modal()).not.toContainText('收纳处已准备'); assert.equal(count('/folders/reject'), 1);
    const q = await (await fetch(`${fxOrigin}/api/project-videos/projects/${f.project.id}/operations/${requestId}`)).json();
    assert.equal(q.status, 'unknown'); assert.equal(q.errorCode, 'OPERATION_NOT_STARTED'); assert.equal(q.phase, 'preview');
    assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId ?? null, null, '没有设置角色');
    await modal().getByRole('button', { name: '已核对，收起' }).click(); await expect(modal()).toHaveCount(0);
  });

  await check('两阶段固定编号：设置收纳处（200 + running → 查询 ready），再精确确认解除采用后真的移入；镜头保留', async () => {
    const shotsBefore = (await f.entry.store.state(f.project.id)).shots.length; assert.equal(await adopted(), 1);
    await menuMark(v[0].id); await modal().getByRole('button', { name: '核对影响' }).click();
    await expect(modal()).toContainText('该文件夹（含子文件夹）现有 1 个视频'); // rejectVideoCount：手建目录里已有 dup.mp4
    await modal().getByLabel('确认设置废片收纳处').check(); await modal().getByRole('button', { name: '设为收纳处' }).click();
    await expect(modal()).toContainText('收纳处已准备', { timeout: 15000 });
    const rolePreview = posts.filter(p => p.suffix === '/folders/reject/preview').at(-1).body, roleCommit = last('/folders/reject');
    assert.equal(roleCommit.requestId, rolePreview.requestId, '执行沿用预览的固定编号');
    assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId, area.id);
    await modal().getByRole('button', { name: /继续：核对移入影响/ }).click(); await expect(modal()).toContainText(/镜 0?1/);
    await modal().getByLabel('我已核对上述镜号，确认解除这些采用关系').check(); await modal().getByRole('button', { name: '移入废片' }).click();
    await expect(modal()).toContainText('已移入废片：1 个视频', { timeout: 15000 }); await expect(modal()).toContainText('解除 1 个镜号的采用');
    const preview = posts.filter(p => p.suffix === '/operations/preview').at(-1).body, commit = last('/operations');
    assert.equal(commit.requestId, preview.requestId); assert.equal(preview.kind, 'move-videos'); assert.equal(commit.confirmedUnbindShotIds.length, 1);
    assert.ok(statuses.filter(s => s.http === 200).some(s => s.status === 'running'), '执行回应为 200 + running，前端按原请求查询到终态');
    assert.equal(path.dirname(source(v[0].id).path), area.path, '文件真的移入收纳处'); assert.equal(await adopted(), 0);
    assert.equal((await f.entry.store.state(f.project.id)).shots.length, shotsBefore, '镜头保留');
    await modal().getByRole('button', { name: '完成' }).click(); await expect(card(v[0].id)).toHaveCount(0); await expect(chip()).toContainText('2');
  });

  await check('批量两个未采用视频：confirmedUnbindShotIds 为 []，整批移入', async () => {
    await card(v[1].id).click(); await card(v[2].id).click({ modifiers: ['Meta'] });
    await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '标记为废片' }).click();
    await expect(modal()).toContainText('没有受影响的采用镜号'); await modal().getByRole('button', { name: '移入废片' }).click();
    await expect(modal()).toContainText('已移入废片：2 个视频', { timeout: 15000 });
    assert.deepEqual(last('/operations').confirmedUnbindShotIds, []); assert.deepEqual(last('/operations/preview').sourceIds.sort(), [v[1].id, v[2].id].sort());
    for (const x of [v[1], v[2]]) assert.equal(path.dirname(source(x.id).path), area.path);
    await modal().getByRole('button', { name: '完成' }).click();
  });

  await check('真实同名冲突：选择“保留双方”后重新核对，执行后收纳处里两个文件都在', async () => {
    await menuMark(dup.id); await expect(modal()).toContainText('同名冲突');
    const choice = modal().locator('select[aria-label^="冲突处理"]'); await choice.selectOption('rename');
    await modal().getByRole('button', { name: '按所选冲突方式重新核对' }).click();
    await expect(modal().getByRole('button', { name: '移入废片' })).toBeEnabled();
    assert.equal(last('/operations/preview').choices[dup.id], 'rename', '批量 choices 以 sourceId 为键');
    await modal().getByRole('button', { name: '移入废片' }).click(); await expect(modal()).toContainText('已移入废片：1 个视频', { timeout: 15000 });
    const names = await fs.readdir(area.path); assert.ok(names.includes('dup.mp4') && names.some(n => /^dup_0\.mp4$/.test(n)), names.join(','));
    await fs.access(source(dupInArea.id).path);
    await modal().getByRole('button', { name: '完成' }).click();
  });

  await check('移入的执行 POST 未到后台：查询为 unknown / OPERATION_NOT_STARTED，界面不报已移动，文件未动', async () => {
    const before = source(v[3].id).path;
    await menuMark(v[3].id); await expect(modal().getByRole('button', { name: '移入废片' })).toBeEnabled(); dropBefore = '/operations';
    await modal().getByRole('button', { name: '移入废片' }).click(); await expect(modal()).toContainText('结果待核对');
    await modal().getByRole('button', { name: '查询原请求' }).click(); await expect(modal()).toContainText('当前只有预览，执行尚未确认');
    await expect(modal()).not.toContainText('已移入废片'); assert.equal(source(v[3].id).path, before); await fs.access(before);
    await modal().getByRole('button', { name: '已核对，收起' }).click(); await expect(card(v[3].id)).toBeVisible();
  });

  await check('废片视图与“全部视频”：真实列表按收纳处子树区分', async () => {
    await chip().click(); for (const x of [v[0], v[1], v[2], dup, dupInArea]) await expect(card(x.id)).toBeVisible();
    await bar().getByRole('button', { name: '全部视频' }).click(); await expect(card(v[3].id)).toBeVisible(); await expect(card(v[0].id)).toHaveCount(0);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'pv-reject-int-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); const code = await exited; console.log('app exit:', code);
  for (const fn of cleanups) { try { await fn(); } catch (e) { console.error('cleanup:', e.message); passed = false; } }
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
