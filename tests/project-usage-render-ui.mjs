// 素材使用页改版前端（合同 PROJECT-USAGE-RENDER v1）：真实本地服务 + 合成项目；成片/选片/回执/总览接口按冻结 fixture 替身。
// 覆盖：成片可播放时跟随播放；此刻/接下来清单排除禁用、保留和位置未知；不能选的视频置灰写原因；
// 关联请求带正确修订号；202 结果不明只核对原请求、不重发；415 拒绝显示原因；找不到成片、旧关联、时间线已变更；还没导入时间线。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const fixture = JSON.parse(await fs.readFile(path.join(root, 'tests/fixtures/project-usage-render-v1.json'), 'utf8'));
const FID = fixture.ids.projectId, TID = fixture.ids.timelineId;
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-render-'));
const videoFile = path.join(temp, 'render.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=60', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoFile]);
const videoBytes = await fs.readFile(videoFile);
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const errors = [], checks = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body) { const r = await fetch(origin + '/api' + p, { method: body ? 'POST' : 'GET', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const d = await r.json(); if (!r.ok) throw Error(p + ' ' + JSON.stringify(d)); return d; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const evidence = process.env.CREATIVE_TEST_EVIDENCE;
const shot = async name => { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') }); } };

let PID = '';
const remap = body => JSON.parse(JSON.stringify(body).replaceAll(FID, PID));
const caseBody = id => remap(fixture.cases.find(c => c.id === id).response.body);
const caseStatus = id => fixture.cases.find(c => c.id === id).response.status;
// 替身状态：每个场景改这里
const fake = { render: 'render-ready', sources: 'render-sources', overview: 'overview-ready', link: 'link-completed', receipts: [], posts: [], deletes: [], ensures: [] };
// 在冻结 fixture 上加一段 1–2 秒的音效：offset 3 时，成片 1 秒处 t = −2，这段会落进「接下来 10 秒」窗口
const earlyOverview = () => { const body = caseBody('overview-ready'); body.timelines[0].references.push({ assetId: null, key: 'early', name: '片头早到.wav', kind: 'sfx', used: true, retained: false, occurrences: [{ occurrenceId: 'early-1', track: 1, start: 1, end: 2, disabled: false }] }); return body; };
// 冻结 fixture 的回执编号是固定的；替身按真实后端那样回显这次请求的编号、项目、时间线（除非用例故意给别的身份）
const ownReceipt = (body, {rid, tid}) => !body || !body.action ? body : { ...body, requestId: rid, projectId: PID, timelineId: body.timelineId === null ? null : tid,
  statusUrl: body.timelineId === null ? `/api/project-videos/projects/${PID}/operations/${rid}` : `/api/projects/${PID}/timelines/${tid}/render/requests/${rid}` };
const OTHER_TID = '20000000-0000-4000-8000-000000000099', OTHER_RID = '30000000-0000-4000-8000-000000000098';
const foreign = body => ({ ...body, requestId: OTHER_RID, timelineId: OTHER_TID, statusUrl: `/api/projects/${PID}/timelines/${OTHER_TID}/render/requests/${OTHER_RID}` });
const TID2 = '20000000-0000-4000-8000-000000000002';
const twoOverview = () => { const body = caseBody('overview-ready'); body.timelines.push({ ...structuredClone(body.timelines[0]), id: TID2, name: '合成第二条时间线' }); return body; };
async function installMocks() {
  const ctx = page.context();
  const at = (u, re) => re.test(new URL(u).pathname);
  await ctx.route(u => at(u, /^\/api\/projects\/[^/]+\/timeline-overview$/), r => r.fulfill({ json: fake.overview === 'overview-early' ? earlyOverview() : fake.overview === 'overview-two' ? twoOverview() : caseBody(fake.overview) }));
  await ctx.route(u => at(u, /\/render\/media$/), r => {
    // 真实后端 sendMedia 支持 Range；替身也按 Range 回 206，浏览器才能跳转
    const m = /bytes=(\d+)-(\d*)/.exec(r.request().headers().range || '');
    const start = m ? Number(m[1]) : 0, end = m && m[2] ? Math.min(Number(m[2]), videoBytes.length - 1) : videoBytes.length - 1;
    return r.fulfill({ status: m ? 206 : 200, headers: { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(m ? { 'content-range': `bytes ${start}-${end}/${videoBytes.length}` } : {}) }, body: videoBytes.subarray(start, end + 1) });
  });
  await ctx.route(u => at(u, /\/render\/sources$/), r => r.fulfill({ json: fake.sources === 'final-missing' ? { ...caseBody('render-sources'), items: caseBody('render-sources').items.filter(i => i.folder?.role !== 'final'), folders: caseBody('folders-not-created').folders, folderRoles: caseBody('folders-not-created').folderRoles } : caseBody(fake.sources) }));
  await ctx.route(u => at(u, /\/render\/requests\/[^/]+$/), r => {
    const pathname = new URL(r.request().url()).pathname, [, tid, rid] = /timelines\/([^/]+)\/render\/requests\/([^/]+)$/.exec(pathname);
    fake.receiptUrls = [...(fake.receiptUrls ?? []), pathname]; fake.receiptReads = (fake.receiptReads ?? 0) + 1;
    const next = fake.receipts.shift() ?? 'link-terminal-unknown', spec = typeof next === 'string' ? { case: next } : next;
    let body = ownReceipt(caseBody(spec.case), { rid, tid });
    if (spec.status) body = { ...body, status: spec.status };
    if (spec.foreign) body = foreign(body);
    if (fake.swapStatusUrl && spec.status === 'running') body = { ...body, statusUrl: `/api/projects/${PID}/timelines/${OTHER_TID}/render/requests/${OTHER_RID}` };
    return r.fulfill({ status: caseStatus(spec.case), json: body });
  });
  await ctx.route(u => at(u, /\/folders\/final\/ensure$/), r => { const b = r.request().postDataJSON(); fake.ensures.push(b); return r.fulfill({ status: 200, json: ownReceipt(caseBody('ensure-adopted'), { rid: b.requestId }) }); });
  await ctx.route(u => at(u, /^\/api\/projects\/[^/]+\/timelines\/[^/]+\/render$/), r => {
    const m = r.request().method();
    if (m === 'GET') { fake.gets = (fake.gets ?? 0) + 1; return r.fulfill({ json: caseBody(fake.render) }); }
    const tid = /timelines\/([^/]+)\/render$/.exec(new URL(r.request().url()).pathname)[1];
    if (m === 'POST') {
      const b = r.request().postDataJSON(); fake.posts.push({ ...b, tid });
      if (fake.link === 'abort') return r.abort('connectionreset');
      if (fake.link === 'unsettled-foreign') return r.fulfill({ status: 503, json: { error: '合成：结果未核清', code: 'OPERATION_UNSETTLED', requestId: OTHER_RID, details: { statusUrl: `/api/projects/${PID}/timelines/${OTHER_TID}/render/requests/${OTHER_RID}` } } });
      return r.fulfill({ status: caseStatus(fake.link), json: ownReceipt(caseBody(fake.link), { rid: b.requestId, tid }) });
    }
    if (m === 'DELETE') { const b = r.request().postDataJSON(); fake.deletes.push(b); return r.fulfill({ status: 200, json: ownReceipt(caseBody('unlink-completed'), { rid: b.requestId, tid }) }); }
    return r.fallback();
  });
}
const usage = () => page.getByRole('region', { name: '成片与时间线' });
/** 直接设播放器时间并派发 timeupdate（替身视频不一定在播） */
const playAt = sec => usage().locator('video').evaluate((v, s) => new Promise(done => { v.addEventListener('seeked', () => { v.dispatchEvent(new Event('timeupdate')); done(); }, { once: true }); v.currentTime = s; }), sec);
const nowPanel = () => page.getByRole('complementary', { name: '此刻时间线上的音效' });
async function openUsage() {
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, PID);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '素材使用', exact: true }).click();
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  PID = (await api('/projects', { name: '合成第1集', software: 'resolve' })).id;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();

  await check('成片可播放：状态写明成片位置；点轨道上一段 → 成片跳到该处（t = currentTime − offset），此刻清单列出它，排除已禁用、上次导入保留和位置未知', async () => {
    await openUsage();
    await expect(usage().locator('.usage-render-status')).toContainText('成片可播放');
    await expect(usage().locator('.usage-render-status')).toContainText('成片 / 合成S01E01_成片_001.mp4');
    const video = usage().locator('video'); await expect(video).toBeVisible();
    await expect.poll(() => video.evaluate(v => v.readyState)).toBeGreaterThan(0);
    await usage().getByRole('button', { name: /合成脚步声\.wav，A1，00:10\.0/ }).click();
    await expect.poll(() => video.evaluate(v => Math.round(v.currentTime * 10) / 10)).toBe(13); // 10 + offset 3
    await expect(nowPanel()).toContainText('合成脚步声.wav');
    await expect(nowPanel()).not.toContainText('合成衣料声.wav'); // 11–15 但已禁用
    await expect(nowPanel()).not.toContainText('上次导入保留.wav'); // retained
    await expect(nowPanel().getByRole('button', { name: /合成脚步声\.wav/ })).toContainText('6.0 秒后'); // 下一段 16s
    await expect(nowPanel()).toContainText('另有 1 处引用缺少位置');
    await shot('ready');
  });
  await check('「下一个音效」跳到下一段开头；成片与时间线对不上（timeline_changed）时提示暂不自动对照', async () => {
    await usage().getByRole('button', { name: /下一个音效/ }).click();
    await expect(page.locator('.usage-clock')).toContainText('00:16.0');
    fake.render = 'render-timeline-changed'; await page.reload(); await openUsage();
    await expect(nowPanel()).toContainText('时间线重新导入过');
  });
  await check('找不到成片：写明原因、给「从项目视频里选择成片」；旧关联找不到时显示原路径', async () => {
    fake.render = 'render-missing'; await page.reload(); await openUsage();
    await expect(usage().locator('.usage-render-status')).toContainText('找不到成片');
    await expect(usage().locator('.usage-player-empty')).toContainText('成片视频文件已移动或丢失');
    fake.render = 'render-legacy-missing'; await page.reload(); await openUsage();
    await expect(usage().locator('.usage-player-empty')).toContainText('/synthetic/legacy/旧成片.mp4');
    await shot('missing');
  });
  await check('选择成片：默认打开「成片」文件夹；不能播放、编码未知、废片、缺失、未托管、待核验的视频置灰写原因；确认带正确修订号，完成后重读', async () => {
    fake.render = 'render-unlinked'; fake.link = 'link-completed'; fake.posts.length = 0; await page.reload(); await openUsage();
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await expect(dlg.getByRole('navigation', { name: '项目视频文件夹' }).getByRole('button', { name: '成片', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dlg.getByRole('radio', { name: '选择成片：不可预览.mov' })).toBeDisabled();
    await expect(dlg).toContainText('浏览器');
    await expect(dlg.getByRole('radio', { name: '选择成片：编码待确认.mp4' })).toBeDisabled();
    await expect(dlg.getByRole('button', { name: '刷新视频信息' })).toBeVisible();
    await shot('picker');
    await dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' }).check();
    await dlg.getByLabel('成片片头偏移秒数').fill('3');
    fake.render = 'render-ready';
    await dlg.getByRole('button', { name: '用这个作为成片' }).click();
    await expect(dlg).toHaveCount(0);
    assert.equal(fake.posts.length, 1);
    const body = fake.posts[0];
    assert.equal(body.sourceId, fixture.ids.sourceId); assert.equal(body.offset, 3); assert.equal(body.expectedRevision, 0);
    assert.equal(body.expectedSourceRevision, 5); assert.equal(body.expectedTimelineRevision, fixture.ids.timelineRevision); assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    await expect(usage().locator('.usage-render-status')).toContainText('成片可播放');
  });
  await check('结果不明：202 后查原回执得 unknown → 显示「核对原请求」，不再发第二次关联；核对得 completed 才关闭', async () => {
    fake.render = 'render-unlinked'; fake.link = 'link-checking'; fake.posts.length = 0; fake.receipts = ['link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown', 'link-terminal-unknown'];
    await page.reload(); await openUsage();
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' }).check();
    await dlg.getByRole('button', { name: '用这个作为成片' }).click();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible({ timeout: 15000 });
    await expect(dlg.getByRole('button', { name: '用这个作为成片' })).toBeDisabled();
    assert.equal(fake.posts.length, 1);
    fake.receipts = ['link-completed']; fake.render = 'render-ready';
    await dlg.getByRole('button', { name: '核对原请求' }).click();
    await expect(dlg).toHaveCount(0);
    assert.equal(fake.posts.length, 1);
  });
  await check('415 编码不支持：显示原因，不关闭、不重发', async () => {
    fake.render = 'render-unlinked'; fake.link = 'reject-prores'; fake.posts.length = 0; await page.reload(); await openUsage();
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' }).check();
    await dlg.getByRole('button', { name: '用这个作为成片' }).click();
    await expect(dlg.getByRole('alert')).toContainText('当前网页播放器不支持此编码');
    assert.equal(fake.posts.length, 1);
    await dlg.getByRole('button', { name: '取消' }).click();
  });
  await check('还没有「成片」文件夹：默认显示「准备」说明；打开窗口不建；点「准备」才调用 ensure（带角色修订），接管后提示', async () => {
    fake.sources = 'final-missing'; fake.ensures.length = 0; await page.reload(); await openUsage();
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await expect(dlg).toContainText('这一集还没有「成片」文件夹');
    assert.equal(fake.ensures.length, 0);
    await dlg.getByRole('button', { name: '准备「成片」文件夹' }).click();
    await expect(dlg.getByRole('status').filter({ hasText: '已把你原有的「成片」文件夹设为保留文件夹' })).toBeVisible();
    assert.equal(fake.ensures.length, 1); assert.equal(fake.ensures[0].expectedRolesRevision, 3);
    fake.sources = 'render-sources';
    await dlg.getByRole('button', { name: '取消' }).click();
  });
  // —— 组合验收退回的 C1–C4 反例（Codex 2026-11-15）——
  await check('C1 成片与时间线对不上（timeline_changed）时：轨道不自动高亮、画面不叠音效名、不列此刻/接下来', async () => {
    fake.render = 'render-timeline-changed'; await page.reload(); await openUsage();
    await expect(nowPanel()).toContainText('暂不自动对照');
    await expect.poll(() => usage().locator('video').evaluate(v => v.readyState)).toBeGreaterThan(0);
    await playAt(13); // t = 13 − 3 = 10，落在脚步声 10–14 里
    await expect(page.locator('.usage-clock')).toContainText('00:10.0');
    await expect(usage().locator('.usage-clip[data-active="true"]')).toHaveCount(0);
    await expect(usage().locator('.usage-overlay')).toHaveCount(0);
    await expect(nowPanel().locator('.usage-now-item')).toHaveCount(0);
    await expect(nowPanel().locator('.usage-next-item')).toHaveCount(0);
  });
  await check('C3 成片还在片头（t < 0）：不列此刻/接下来，提示时间线还没开始', async () => {
    fake.render = 'render-ready'; fake.overview = 'overview-early'; await page.reload(); await openUsage();
    await expect.poll(() => usage().locator('video').evaluate(v => v.readyState)).toBeGreaterThan(0);
    await playAt(1); // t = 1 − 3 = −2；第一声 1–2 不能算「3 秒后」
    await expect(page.locator('.usage-clock')).toContainText('-00:02.0');
    await expect(nowPanel().locator('.usage-next-item')).toHaveCount(0);
    await expect(nowPanel().locator('.usage-now-item')).toHaveCount(0);
    await expect(nowPanel()).toContainText('成片还在片头');
    await playAt(13); // 回到时间线内仍正常跟随
    await expect(nowPanel().locator('.usage-now-item')).toContainText('合成脚步声.wav');
    fake.overview = 'overview-ready';
  });
  await check('C2 关联请求没收到答复（连接被重置）：进入「核对原请求」，按原编号查回执；关掉再打开也不能换编号重发', async () => {
    fake.render = 'render-unlinked'; fake.link = 'abort'; fake.posts.length = 0; fake.receiptUrls = []; fake.receipts = []; await page.reload(); await openUsage();
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    let dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' }).check();
    await dlg.getByRole('button', { name: '用这个作为成片' }).click();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: '用这个作为成片' })).toBeDisabled();
    assert.equal(fake.posts.length, 1);
    const requestId = fake.posts[0].requestId;
    await dlg.getByRole('button', { name: '取消' }).click();
    await expect(usage().getByRole('button', { name: '核对原请求' })).toBeVisible(); // 关掉窗口后外面仍能核对
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' }).check();
    await expect(dlg.getByRole('button', { name: '用这个作为成片' })).toBeDisabled();
    fake.receipts = ['link-terminal-unknown'];
    await dlg.getByRole('button', { name: '核对原请求' }).click();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible(); // unknown 仍待核对
    await expect(dlg.getByRole('button', { name: '用这个作为成片' })).toBeDisabled();
    fake.receipts = ['link-completed']; fake.render = 'render-ready';
    await dlg.getByRole('button', { name: '核对原请求' }).click();
    await expect(dlg).toHaveCount(0);
    assert.equal(fake.posts.length, 1);
    assert.ok(fake.receiptUrls.length >= 2 && fake.receiptUrls.every(u => u.endsWith('/render/requests/' + requestId)), requestId + ' ' + JSON.stringify(fake.receiptUrls));
    await expect(usage().getByRole('button', { name: '核对原请求' })).toHaveCount(0);
    fake.link = 'link-completed';
  });
  await check('C4 浏览器实际播放失败（MediaError 4）：重读 GET 后仍保留原因，同一来源不能再确认；点「重试播放」才重新核验', async () => {
    fake.render = 'render-ready'; await page.reload(); await openUsage();
    const video = usage().locator('video');
    await expect.poll(() => video.evaluate(v => v.readyState)).toBeGreaterThan(0);
    const before = fake.gets ?? 0;
    await video.evaluate(v => { Object.defineProperty(v, 'error', { value: { code: 4, message: 'synthetic decode failure' }, configurable: true }); v.dispatchEvent(new Event('error')); });
    await expect.poll(() => fake.gets ?? 0).toBeGreaterThan(before); // 轻量 GET 已重读
    await page.waitForTimeout(300);
    await expect(usage().locator('.usage-render-status')).toContainText('当前浏览器无法播放这个成片');
    await expect(usage().locator('.usage-player-empty')).toContainText('当前浏览器无法播放这个成片');
    await expect(usage().locator('video')).toHaveCount(0);
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await expect(dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' })).toBeDisabled();
    await expect(dlg).toContainText('当前浏览器无法播放这个成片');
    await dlg.getByRole('button', { name: '取消' }).click();
    await shot('media-error');
    await usage().getByRole('button', { name: '重试播放' }).click();
    await expect(usage().locator('.usage-render-status')).toContainText('成片可播放');
    await expect(usage().locator('video')).toHaveCount(1);
  });
  // —— C2 增量返工 R1/R2（Codex 2026-11-15）——
  const openPickerAndConfirm = async () => {
    await usage().getByRole('button', { name: /从项目视频里选择成片…|选择成片|更换成片/ }).first().click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' }).check();
    await dlg.getByRole('button', { name: '用这个作为成片' }).click();
    return dlg;
  };
  const allOriginal = rid => fake.receiptUrls.length > 0 && fake.receiptUrls.every(u => u.endsWith(`/timelines/${TID}/render/requests/${rid}`));
  await check('R1a 503 未核清的错误体给了别的编号和地址：仍按原编号、原时间线核对', async () => {
    fake.render = 'render-unlinked'; fake.link = 'unsettled-foreign'; fake.posts.length = 0; fake.receiptUrls = []; fake.receipts = ['link-terminal-unknown']; await page.reload(); await openUsage();
    const dlg = await openPickerAndConfirm();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible();
    await dlg.getByRole('button', { name: '核对原请求' }).click();
    await expect.poll(() => fake.receiptUrls.length).toBe(1);
    assert.ok(allOriginal(fake.posts[0].requestId), JSON.stringify(fake.receiptUrls));
    await expect(dlg.getByRole('button', { name: '用这个作为成片' })).toBeDisabled();
    await dlg.getByRole('button', { name: '取消' }).click();
  });
  await check('R1b 202 后轮询回执把地址换成别处：自动轮询仍只查原地址', async () => {
    fake.render = 'render-unlinked'; fake.link = 'link-checking'; fake.posts.length = 0; fake.receiptUrls = [];
    // 第一轮回执自身身份正确，但 statusUrl 指向别的时间线/编号
    fake.receipts = [{ case: 'link-checking', status: 'running' }, 'link-terminal-unknown']; fake.swapStatusUrl = true;
    await page.reload(); await openUsage();
    const dlg = await openPickerAndConfirm();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible({ timeout: 15000 });
    assert.ok(fake.receiptUrls.length >= 2 && allOriginal(fake.posts[0].requestId), JSON.stringify(fake.receiptUrls));
    fake.swapStatusUrl = false;
    await dlg.getByRole('button', { name: '取消' }).click();
  });
  await check('R1c 核对查到的 completed 属于别的编号/时间线：不关窗、不清待核对、提示不属于原请求；原编号 completed 才关', async () => {
    fake.render = 'render-unlinked'; fake.link = 'abort'; fake.posts.length = 0; fake.receiptUrls = []; fake.receipts = []; await page.reload(); await openUsage();
    const dlg = await openPickerAndConfirm();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible();
    fake.receipts = [{ case: 'link-completed', foreign: true }]; fake.render = 'render-ready';
    await dlg.getByRole('button', { name: '核对原请求' }).click();
    await expect(dlg.getByRole('alert')).toContainText('不属于原请求');
    await expect(dlg).toHaveCount(1);
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: '用这个作为成片' })).toBeDisabled();
    fake.receipts = ['link-completed'];
    await dlg.getByRole('button', { name: '核对原请求' }).click();
    await expect(dlg).toHaveCount(0);
    assert.equal(fake.posts.length, 1); assert.ok(allOriginal(fake.posts[0].requestId), JSON.stringify(fake.receiptUrls));
    fake.link = 'link-completed';
  });
  await check('R2 两条时间线各有一条结果不明的关联：切回 A 仍能按 A 的原编号核对，不能重新确认', async () => {
    fake.render = 'render-unlinked'; fake.overview = 'overview-two'; fake.link = 'abort'; fake.posts.length = 0; fake.receiptUrls = []; fake.receipts = []; await page.reload(); await openUsage();
    const select = usage().getByRole('combobox', { name: '时间线' });
    let dlg = await openPickerAndConfirm();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible(); await dlg.getByRole('button', { name: '取消' }).click();
    await select.selectOption(TID2);
    dlg = await openPickerAndConfirm();
    await expect(dlg.getByRole('button', { name: '核对原请求' })).toBeVisible(); await dlg.getByRole('button', { name: '取消' }).click();
    assert.equal(fake.posts.length, 2); assert.deepEqual(fake.posts.map(p => p.tid), [TID, TID2]);
    await select.selectOption(TID);
    await expect(usage().getByRole('button', { name: '核对原请求' })).toBeVisible();
    await usage().getByRole('button', { name: /从项目视频里选择成片…|选择成片/ }).first().click();
    dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await dlg.getByRole('radio', { name: '选择成片：合成S01E01_成片_001.mp4' }).check();
    await expect(dlg.getByRole('button', { name: '用这个作为成片' })).toBeDisabled();
    fake.receipts = ['link-terminal-unknown'];
    await dlg.getByRole('button', { name: '核对原请求' }).click();
    await expect.poll(() => fake.receiptUrls.length).toBe(1);
    assert.ok(fake.receiptUrls[0].endsWith(`/timelines/${TID}/render/requests/${fake.posts[0].requestId}`), fake.receiptUrls[0]);
    assert.equal(fake.posts.length, 2);
    await dlg.getByRole('button', { name: '取消' }).click();
    fake.overview = 'overview-ready'; fake.link = 'link-completed';
  });
  await check('还没导入时间线：显示两步说明，不伪造时间线', async () => {
    fake.overview = 'overview-empty'; await page.reload(); await openUsage();
    await expect(page.getByRole('region', { name: '开始' })).toContainText('两步就能边看成片边对照音效');
    // 列表为空：不显示全选行和表头（两条框线），只留空状态
    await expect(page.locator('.project-items-empty')).toBeVisible();
    await expect(page.locator('.project-list-heading')).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: '选择本页项目素材' })).toHaveCount(0);
    await shot('empty');
  });
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) console.log(logs.slice(-3000));
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
}
