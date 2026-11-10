// 合同 D 前端（#52 / PR #53）：内容确实变化时的预览、继续使用、不再使用。
// 页面对本项目的全部 /api/project-videos/projects/<id>/... 请求（列表、核对、接受、移除、查询、候选媒体）
// 都转发到同一个“真实 catalog/router/SQLite + 测试替身”（tests/helpers/project-video-desktop-fixture.mjs），
// 只替换项目编号；列表的修订号、状态与执行操作的后台是同一个。
// 为验证文案或网络异常，只做三类改写，均在输出中注明：forceKind（改写 changeKind 字段）、丢弃回应（请求已在后台执行）、
// 把同步回执包装成 202 进行中并让下一次查询断线。废纸篓用测试替身。不碰真实素材与真实废纸篓。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import express from 'express';
import { chromium, expect } from '@playwright/test';
import { fixture, imported, initialize, bind, replaceBytes, appendXmp } from './helpers/project-video-desktop-fixture.mjs';
import { projectVideoRouter } from '../server/project-videos/router.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pv-change-ui-')));
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], cleanups = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body) { const response = await fetch(origin + '/api' + p, { method: body ? 'POST' : 'GET', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await response.json(); if (!response.ok) throw Error(data.error); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目生成视频' }), modal = () => page.locator('.pv-modal');
const detail = () => work().getByRole('complementary', { name: '视频详情' });
const card = id => work().locator(`.pv-card[data-video-id="${id}"]`);
const banner = () => work().locator('.pv-banner', { hasText: '内容变化处理' });
const ACCEPT = '我已核对当前内容，接受它作为这个视频的新内容', TRASH = '移到系统废纸篓（不是永久删除，可从废纸篓找回）', KEEP = '只移除记录，不移动文件';
const changedText = /视频内容已发生变化|无法确认是否只改了元数据/;
async function openChange(id) { await card(id).click(); await detail().getByRole('button', { name: '处理内容变化…' }).click(); await expect(modal()).toContainText('处理内容变化'); }
const closeX = () => page.locator('.pv-modal > header button[aria-label="关闭"]').click();

try {
  // ---- 真实后端 + 测试替身 ----
  const f = await fixture({ after: fn => cleanups.push(fn) });
  const fx = []; for (let i = 0; i < 16; i++) fx.push(await imported(f));
  initialize(f); await bind(f, fx[0], [0]); await bind(f, fx[1], [1, 2]);
  for (const [i, v] of fx.entries()) if (i !== 1 && i !== 10) await replaceBytes(f, v);
  await replaceBytes(f, fx[1], { duration: 1.5 }); // 变短，fx1 第二段越界
  await appendXmp(fx[10]); // 只改元数据
  const fxApp = express(); fxApp.use('/api/project-videos', projectVideoRouter(f.catalog, { sendMedia: async (_q, res, _file, handle) => { res.setHeader('content-type', 'video/mp4'); res.end(await handle.readFile()); } }));
  const fxServer = http.createServer(fxApp); await new Promise(r => fxServer.listen(0, '127.0.0.1', r));
  cleanups.unshift(async () => { fxServer.closeAllConnections(); await new Promise(r => fxServer.close(r)); });
  const fxOrigin = `http://127.0.0.1:${fxServer.address().port}`;
  const fxState = async id => (await f.catalog.list(f.project.id, { folderId: 'root' })).videos.find(v => v.id === id); // root 视图逐个核验
  const originalTrash = f.catalog.fileOperations.trash;

  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const projectId = (await api('/projects', { name: '内容变化短片' })).id;
  const otherId = (await api('/projects', { name: '另一个项目' })).id;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));

  // ---- 转发：本项目的全部视频接口 → 同一个真实后台；只替换项目编号 ----
  const swap = (text, a, b) => text.split(a).join(b);
  const posts = [], realKinds = []; let forceKind = '', dropNext = '', fake202 = '', failNextQuery = false, mutateAfterReady = null, holdLatest = null;
  const base = `/api/project-videos/projects/${projectId}`;
  await page.route(url => url.pathname === base || url.pathname.startsWith(base + '/'), async route => {
    const req = route.request(), url = new URL(req.url()), suffix = url.pathname.slice(base.length);
    const target = `${fxOrigin}/api/project-videos/projects/${f.project.id}${suffix}${url.search}`;
    if (/\/media$/.test(suffix)) {
      const res = await fetch(target, { method: req.method(), headers: req.headers().range ? { range: req.headers().range } : {} });
      const headers = {}; for (const h of ['content-type', 'content-range', 'accept-ranges', 'content-length']) { const v = res.headers.get(h); if (v) headers[h] = v; }
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    }
    if (failNextQuery && suffix.startsWith('/desktop-actions/')) { failNextQuery = false; return route.abort('failed'); } // 202 之后的查询断线
    const body = req.postData() ? swap(req.postData(), projectId, f.project.id) : undefined;
    if (req.method() === 'POST') posts.push({ suffix, body: body ? JSON.parse(body) : null });
    const res = await fetch(target, { method: req.method(), headers: { 'content-type': 'application/json' }, body });
    let text = swap(await res.text(), f.project.id, projectId);
    if (holdLatest && req.method() === 'GET' && url.search.includes('folderId=all')) { const gate = holdLatest; holdLatest = null; gate.reached(); await gate.release; } // 延迟交付“重新核对”的最新资料读取
    if (text.includes('"changeKind"')) { const j = JSON.parse(text); realKinds.push(j.changeKind); if (forceKind) { j.changeKind = forceKind; if (forceKind === 'metadata_only') j.canAccept = false; text = JSON.stringify(j); } }
    if (mutateAfterReady && text.includes('"changeKind"') && text.includes('"status":"ready"')) { const m = mutateAfterReady; mutateAfterReady = null; await m(); }
    if (req.method() === 'POST' && dropNext && suffix.endsWith(dropNext)) { dropNext = ''; return route.abort('failed'); } // 后台已执行，只丢回应
    if (req.method() === 'POST' && fake202 && suffix.endsWith(fake202) && res.ok) { // 后台已执行到终态；页面只看到 202 进行中
      fake202 = ''; failNextQuery = true; const j = JSON.parse(text);
      return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ requestId: j.requestId, projectId, status: 'running' }) });
    }
    await route.fulfill({ status: res.status, contentType: 'application/json', body: text });
  });
  const refreshListMenu = async () => { await work().getByRole('button', { name: '更多视频操作' }).click(); await page.getByRole('menuitem', { name: /刷新视频资料/ }).click(); };
  const postsFor = (id, s) => posts.filter(p => p.suffix === `/videos/${id}${s}`).length;

  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await page.locator('.topbar-project-slot select').selectOption(projectId);
  await expect(card(fx[0].id)).toContainText(/内容已变化|待核验/);
  const fxNames = Object.fromEntries((await f.catalog.list(f.project.id, { folderId: 'all' })).videos.map(v => [v.id, v.name || v.fileName]));

  await check('继续使用：点击后才播放冻结内容，勾选接受；用 Esc 退出成功结果也刷新列表（R3）', async () => {
    forceKind = 'content_changed'; await openChange(fx[0].id); await expect(modal()).toContainText('视频内容已发生变化'); forceKind = '';
    await expect(modal()).toContainText('原内容未保留，无法回放对照'); assert.equal(await modal().locator('video').count(), 0, '未点击前不播放');
    await modal().getByRole('button', { name: '播放当前内容' }).click();
    await expect.poll(() => modal().locator('video').evaluate(v => v.readyState), { timeout: 15000 }).toBeGreaterThan(0);
    const go = modal().getByRole('button', { name: '继续使用当前内容' }); await expect(go).toBeDisabled();
    await modal().getByLabel(ACCEPT).check(); await go.click();
    await expect(modal()).toContainText('已接受当前内容'); await expect(modal()).toContainText('保留 1 个镜号的采用');
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0);
    await expect(card(fx[0].id)).not.toContainText(/内容已变化|待核验/); // 列表已从同一后台刷新
    const v = await fxState(fx[0].id); assert.equal(v.adoptedShots.length, 1, '原采用保留'); assert.equal(v.status, 'available');
  });

  await check('变短：越界镜号必须精确确认解除，接受后只解除越界的采用；用“完成”退出也刷新（R3）', async () => {
    await openChange(fx[1].id); await expect(modal()).toContainText('超出新时长');
    await modal().getByLabel(ACCEPT).check();
    const go = modal().getByRole('button', { name: '继续使用当前内容' }); await expect(go).toBeDisabled();
    await modal().getByLabel(/确认解除 镜 .* 的采用/).check(); await go.click();
    await expect(modal()).toContainText(/解除 \d+ 个超出新时长的镜号采用/);
    const sent = posts.filter(p => p.suffix.endsWith('/accept-change')).at(-1).body; assert.ok(sent.confirmedUnbindShotIds.length >= 1);
    await modal().getByRole('button', { name: '完成' }).click(); await expect(modal()).toHaveCount(0);
    await expect(card(fx[1].id)).not.toContainText(/内容已变化|待核验/);
    assert.ok((await fxState(fx[1].id)).adoptedShots.length < 2, '只解除越界的采用');
  });

  await check('不再使用 + 保留：原文件在确认前被移走，结果只说“本次没有移动或删除文件”（R4）；用 ✕ 退出也刷新（R3）', async () => {
    await openChange(fx[2].id); await expect(modal()).toContainText(changedText);
    await modal().getByRole('button', { name: '不再使用…' }).click(); await expect(modal()).toContainText('这个文件怎么处理');
    const go = modal().getByRole('button', { name: /^移除记录/ }); await expect(go).toBeDisabled();
    await modal().getByLabel(KEEP).check();
    await fs.rename(fx[2].path, fx[2].path + '.moved'); // 原文件已不在原位置
    await go.click();
    await expect(modal()).toContainText('已移除视频记录'); await expect(modal()).toContainText('文件：本次没有移动或删除文件');
    await expect(modal()).not.toContainText('原位置');
    await closeX(); await expect(modal()).toHaveCount(0);
    await expect(card(fx[2].id)).toHaveCount(0); assert.equal(await fxState(fx[2].id), undefined, '记录已移除');
  });

  await check('不再使用 + 移到废纸篓：分别显示记录与文件结果', async () => {
    await openChange(fx[3].id); await modal().getByRole('button', { name: '不再使用…' }).click();
    await modal().getByLabel(TRASH).check(); await modal().getByRole('button', { name: '移除记录并移到废纸篓' }).click();
    await expect(modal()).toContainText('已移除视频记录', { timeout: 20000 }); await expect(modal()).toContainText('文件：已移到系统废纸篓');
    await modal().getByRole('button', { name: '完成' }).click();
    assert.equal(f.trash.length, 1); await assert.rejects(fs.access(fx[3].path)); await expect(card(fx[3].id)).toHaveCount(0);
  });

  await check('废纸篓失败（R4）：记录已移除、文件没有移动，不断言文件位置', async () => {
    f.catalog.fileOperations.trash = async () => { throw Object.assign(Error('测试：废纸篓暂不可用'), { code: 'TRASH_FAILED', status: 409 }); };
    await openChange(fx[4].id); await modal().getByRole('button', { name: '不再使用…' }).click();
    await modal().getByLabel(TRASH).check(); await modal().getByRole('button', { name: '移除记录并移到废纸篓' }).click();
    await expect(modal()).toContainText('已移除视频记录', { timeout: 20000 }); await expect(modal()).toContainText('没有移到废纸篓，本次没有移动文件');
    await expect(modal()).not.toContainText('原位置'); await expect(modal().locator('.pv-callout[data-tone="warn"]')).toBeVisible();
    f.catalog.fileOperations.trash = originalTrash;
    await modal().getByRole('button', { name: '完成' }).click(); await expect(card(fx[4].id)).toHaveCount(0);
  });

  await check('废纸篓结果未知（R2）：不能“完成”；稍后处理后卡片消失但页面顶部保留入口，查询不再次移动，已核对才收起', async () => {
    let calls = 0; f.catalog.fileOperations.trash = async () => { calls++; throw Object.assign(Error('废纸篓结果尚未核清'), { code: 'TRASH_UNSETTLED', effectUnknown: true }); };
    await openChange(fx[5].id); await modal().getByRole('button', { name: '不再使用…' }).click();
    await modal().getByLabel(TRASH).check(); await modal().getByRole('button', { name: '移除记录并移到废纸篓' }).click();
    await expect(modal()).toContainText('已移除视频记录', { timeout: 20000 }); await expect(modal()).toContainText('文件：处理结果待核对');
    await expect(modal().getByRole('button', { name: '完成' })).toHaveCount(0);
    await modal().getByRole('button', { name: '稍后处理' }).click(); await expect(modal()).toHaveCount(0);
    await expect(card(fx[5].id)).toHaveCount(0); // 已知事实：记录已移除
    await expect(banner()).toContainText('记录已移除，文件处理结果待核对');
    await page.keyboard.press('Escape'); await expect(banner()).toBeVisible();
    await banner().getByRole('button', { name: '查询原请求' }).click(); await expect(banner()).toContainText('记录已移除，文件处理结果待核对');
    assert.equal(calls, 1, '查询原请求不应再次移动文件'); assert.equal(postsFor(fx[5].id, '/remove'), 1, '只提交一次移除');
    f.catalog.fileOperations.trash = originalTrash;
    await banner().getByRole('button', { name: '打开' }).click(); await expect(modal()).toContainText('文件：处理结果待核对');
    await modal().getByRole('button', { name: '已核对，收起' }).click(); await expect(modal()).toHaveCount(0); await expect(banner()).toHaveCount(0);
  });

  await check('接受的回应丢失（R1）：切到其他页面再回来恢复原请求，不另起核对；收起后从页面顶部查询，只写一次', async () => {
    await openChange(fx[6].id); await expect(modal()).toContainText(changedText);
    const previews = postsFor(fx[6].id, '/changes/preview'); dropNext = '/accept-change';
    await modal().getByLabel(ACCEPT).check(); await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal()).toContainText('结果待核对'); const requestId = posts.filter(p => p.suffix.endsWith('/accept-change')).at(-1).body.requestId;
    await expect(modal()).toContainText(requestId);
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0); // 收起弹窗（模态弹窗打开时不能切页）
    await page.getByRole('navigation').getByRole('button', { name: '分镜设计' }).first().click(); await expect(work()).toBeHidden();
    await page.getByRole('navigation').getByRole('button', { name: '生成视频' }).first().click(); await expect(work()).toBeVisible();
    await expect(banner()).toContainText('结果待核对'); await expect(banner()).toContainText(requestId);
    await banner().getByRole('button', { name: '打开' }).click(); await expect(modal()).toContainText(requestId); await expect(modal()).toContainText('只会查询原请求');
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0);
    await banner().getByRole('button', { name: '查询原请求' }).click(); await expect(banner()).toContainText('已有结果，请查看'); // 结果未读，入口保留（RR3）
    await expect(card(fx[6].id)).not.toContainText(/内容已变化|待核验/); // 查询到终态后刷新
    await banner().getByRole('button', { name: '打开' }).click(); await expect(modal()).toContainText('已接受当前内容');
    await modal().getByRole('button', { name: '完成' }).click(); await expect(banner()).toHaveCount(0);
    assert.equal(postsFor(fx[6].id, '/changes/preview'), previews, '回来后不应另起核对');
    assert.equal(postsFor(fx[6].id, '/accept-change'), 1, '丢回应后不重发接受');
  });

  await check('接受：202 之后查询断线（R1）→ 待核对；查询原请求得到终态', async () => {
    await openChange(fx[7].id); await expect(modal()).toContainText(changedText); fake202 = '/accept-change';
    await modal().getByLabel(ACCEPT).check(); await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal()).toContainText('结果待核对', { timeout: 10000 });
    await modal().getByRole('button', { name: '查询原请求' }).click(); await expect(modal()).toContainText('已接受当前内容');
    assert.equal(postsFor(fx[7].id, '/accept-change'), 1);
    await modal().getByRole('button', { name: '完成' }).click(); await expect(card(fx[7].id)).not.toContainText(/内容已变化|待核验/);
  });

  await check('移除：202 之后查询断线，再切换到其他项目又切回（R1）→ 恢复原请求；查询得到终态，只写一次', async () => {
    await openChange(fx[8].id); await modal().getByRole('button', { name: '不再使用…' }).click(); await modal().getByLabel(KEEP).check();
    fake202 = '/remove'; await modal().getByRole('button', { name: /^移除记录/ }).click();
    await expect(modal()).toContainText('结果待核对', { timeout: 10000 }); const requestId = posts.filter(p => p.suffix.endsWith('/remove')).at(-1).body.requestId;
    await page.locator('.topbar-project-slot select').selectOption(otherId); await expect(modal()).toHaveCount(0);
    await page.locator('.topbar-project-slot select').selectOption(projectId);
    await expect(modal()).toContainText('结果待核对'); await expect(modal()).toContainText(requestId);
    await closeX(); await expect(banner()).toContainText(requestId);
    await banner().getByRole('button', { name: '打开' }).click(); await modal().getByRole('button', { name: '查询原请求' }).click();
    await expect(modal()).toContainText('已移除视频记录'); await expect(modal()).toContainText('文件：本次没有移动或删除文件');
    assert.equal(postsFor(fx[8].id, '/remove'), 1, '不重发移除');
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0); await expect(card(fx[8].id)).toHaveCount(0);
  });

  await check('并发更新修订后重新核对（R5）：先读最新修订，新核对带新修订，旧确认清空，再接受成功', async () => {
    await openChange(fx[9].id); await expect(modal()).toContainText(changedText);
    const v = await fxState(fx[9].id); await f.catalog.update(f.project.id, fx[9].id, { expectedRevision: v.revision, title: '并发改名', notes: '', prompt: { mode: 'none' } });
    await modal().getByLabel(ACCEPT).check(); await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal().locator('.pv-error')).toBeVisible(); await expect(modal()).not.toContainText('已接受当前内容');
    await modal().getByRole('button', { name: '重新核对' }).click(); await expect(modal()).toContainText(changedText);
    const last = posts.filter(p => p.suffix === `/videos/${fx[9].id}/changes/preview`).at(-1).body;
    assert.equal(last.expectedRevision, v.revision + 1, '重新核对使用最新修订');
    await expect(modal().getByLabel(ACCEPT)).not.toBeChecked(); // 旧确认已清空
    await modal().getByLabel(ACCEPT).check(); await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal()).toContainText('已接受当前内容');
    assert.equal(posts.filter(p => p.suffix.endsWith(`/videos/${fx[9].id}/accept-change`)).at(-1).body.expectedRevision, v.revision + 1);
    await modal().getByRole('button', { name: '完成' }).click();
  });

  await check('迟到的“重新核对”读取不能抹掉后来视频的待核对写请求（RR1）', async () => {
    const A = fx[12].id, B = fx[13].id;
    await openChange(A); await expect(modal()).toContainText(changedText);
    const v = await fxState(A); await f.catalog.update(f.project.id, A, { expectedRevision: v.revision, title: '并发改名', notes: '', prompt: { mode: 'none' } });
    await modal().getByLabel(ACCEPT).check(); await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal().locator('.pv-error')).toBeVisible();
    let release; const gate = { reached: null, release: new Promise(r => release = r) }; const arrived = new Promise(r => gate.reached = r); holdLatest = gate;
    const previewsA = postsFor(A, '/changes/preview');
    await modal().getByRole('button', { name: '重新核对' }).click(); await arrived; // 最新资料已在后台读出，回应被延迟
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0);
    await openChange(B); await expect(modal()).toContainText(changedText); dropNext = '/accept-change';
    await modal().getByLabel(ACCEPT).check(); await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal()).toContainText('结果待核对'); const requestId = posts.filter(p => p.suffix === `/videos/${B}/accept-change`).at(-1).body.requestId;
    release(); await page.waitForTimeout(800); // 放出 A 的迟到回应
    await expect(modal()).toContainText('结果待核对'); await expect(modal()).toContainText(requestId);
    await expect(modal()).toContainText(fxNames[B]);
    assert.equal(postsFor(A, '/changes/preview'), previewsA, '迟到读取不应为 A 另起核对');
    await modal().getByRole('button', { name: '查询原请求' }).click(); await expect(modal()).toContainText('已接受当前内容');
    assert.equal(postsFor(B, '/accept-change'), 1, 'B 不重发');
    await modal().getByRole('button', { name: '完成' }).click(); await expect(modal()).toHaveCount(0);
  });

  await check('整体 unknown 但记录已确认移除（RR2）：刷新列表，弹窗与顶部都显示已确认的记录事实，文件仍待核对', async () => {
    const id = fx[14].id, journal = f.catalog.actionJournal, save = journal.save.bind(journal); let injected = false;
    journal.save = s => { if (!injected && s.status === 'partial' && s.result?.record?.removed) { injected = true; throw Error('测试：最终回执保存失败'); } return save(s); };
    f.catalog.fileOperations.trash = async () => { throw Object.assign(Error('废纸篓结果尚未核清'), { code: 'TRASH_UNSETTLED', effectUnknown: true }); };
    try {
      await openChange(id); await modal().getByRole('button', { name: '不再使用…' }).click();
      await modal().getByLabel(TRASH).check(); await modal().getByRole('button', { name: '移除记录并移到废纸篓' }).click();
      await expect(modal()).toContainText('结果待核对', { timeout: 20000 }); assert.ok(injected, '注入点已触发');
      await expect(modal()).toContainText('已确认：视频记录已移除'); await expect(modal()).toContainText('文件：处理结果待核对');
      await expect(card(id)).toHaveCount(0); // 已知事实：通知父层并刷新
      await page.keyboard.press('Escape'); await expect(banner()).toContainText('记录已移除，文件处理结果待核对');
      await banner().getByRole('button', { name: '查询原请求' }).click(); await expect(banner()).toContainText('记录已移除');
      assert.equal(postsFor(id, '/remove'), 1);
      await banner().getByRole('button', { name: '打开' }).click(); await expect(modal()).toContainText('已确认：视频记录已移除');
      await modal().getByRole('button', { name: '已核对，收起' }).click(); await expect(banner()).toHaveCount(0);
    } finally { journal.save = save; f.catalog.fileOperations.trash = originalTrash; }
  });

  await check('收起后才到达的部分完成（RR3）：文件没有移到废纸篓的结果保留顶部入口，看过并收起后才消失', async () => {
    const id = fx[15].id; let entered, fail; const inTrash = new Promise(r => entered = r);
    f.catalog.fileOperations.trash = () => new Promise((_, reject) => { fail = reject; entered(); });
    try {
      await openChange(id); await modal().getByRole('button', { name: '不再使用…' }).click();
      await modal().getByLabel(TRASH).check(); await modal().getByRole('button', { name: '移除记录并移到废纸篓' }).click();
      await inTrash; await expect(modal()).toContainText('正在移除记录');
      await closeX(); await expect(modal()).toHaveCount(0); await expect(banner()).toContainText('处理中');
      fail(Object.assign(Error('测试：废纸篓暂不可用'), { code: 'TRASH_FAILED', status: 409 }));
      await expect(banner()).toContainText('记录已移除，文件没有移到废纸篓，请查看结果', { timeout: 10000 });
      await expect(card(id)).toHaveCount(0);
      await refreshListMenu(); await expect(banner()).toBeVisible(); // 列表刷新不清除未读结果
      await banner().getByRole('button', { name: '打开' }).click();
      await expect(modal()).toContainText('没有移到废纸篓，本次没有移动文件（测试：废纸篓暂不可用）');
      await modal().getByRole('button', { name: '完成' }).click(); await expect(modal()).toHaveCount(0); await expect(banner()).toHaveCount(0);
      assert.equal(postsFor(id, '/remove'), 1);
    } finally { f.catalog.fileOperations.trash = originalTrash; }
  });

  await check('核对之后文件又被改：继续使用被真实后台拒绝，可重新核对', async () => {
    const id = fx[11].id; mutateAfterReady = () => replaceBytes(f, fx[11], { color: 'yellow' }); // 第三种颜色：不回到原画面（原为蓝色）
    await openChange(id); await expect(modal()).toContainText(changedText);
    await modal().getByLabel(ACCEPT).check(); await modal().getByRole('button', { name: '继续使用当前内容' }).click();
    await expect(modal().locator('.pv-error')).toBeVisible(); await expect(modal()).not.toContainText('已接受当前内容');
    await modal().getByRole('button', { name: '重新核对' }).click(); await expect(modal()).toContainText(changedText);
    await page.keyboard.press('Escape'); await expect(modal()).toHaveCount(0); await expect(banner()).toHaveCount(0);
  });

  await check('只改元数据：核对回应丢失时只查询原请求，显示内容一致、不开放接受', async () => {
    const id = fx[10].id, before = postsFor(id, '/changes/preview'); dropNext = '/changes/preview'; forceKind = 'metadata_only';
    await openChange(id); await expect(modal()).toContainText('结果待核对');
    await modal().getByRole('button', { name: '查询原请求' }).click(); await expect(modal()).toContainText('视频内容一致'); forceKind = '';
    await expect(modal().getByRole('button', { name: '继续使用当前内容' })).toHaveCount(0);
    assert.equal(postsFor(id, '/changes/preview'), before + 1, '只提交一次核对');
    await modal().getByRole('button', { name: '知道了' }).click(); await expect(modal()).toHaveCount(0);
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
