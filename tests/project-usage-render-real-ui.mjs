// 素材使用页 × 成片后端（PROJECT-USAGE-RENDER v1）真实组合联调：不替身，真实本地服务 + 合成数据。
// 合成音效库 → 真实导入时间线 → 项目视频里放一个用户自建的「成片」文件夹和 H.264 成片 →
// 选片窗口：成片还没登记为保留文件夹 → 点「准备」→ 后端自动接管同名文件夹（不移动内容）→ 选成片关联 →
// 播放器读后端 mediaUrl，点轨道跳到对应秒数 → 解除关联。另一集没有「成片」文件夹 → 「准备」新建。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'usage-render-real-'))), sfx = path.join(temp, '音效');
await fs.mkdir(sfx);
const names = ['风声 山谷', '脚步 石板路', '木门吱呀', '雨声 屋檐'];
for (const [i, n] of names.entries()) execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 80}:duration=3`, path.join(sfx, n + '.wav')]);
const finalFile = path.join(temp, 'final.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', finalFile]);
const finalBytes = await fs.readFile(finalFile);
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
const rid = () => crypto.randomUUID();
async function api(p, body, method, raw) {
  const headers = { cookie, origin, 'x-local-token': token, 'content-type': raw ? 'application/octet-stream' : 'application/json' };
  const r = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers, ...(body ? { body: raw ? body : JSON.stringify(body) } : {}) });
  const d = await r.json(); if (!r.ok) throw Object.assign(Error(p + ' ' + r.status + ' ' + JSON.stringify(d).slice(0, 300)), { status: r.status, body: d }); return d;
}
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
const evidence = process.env.CREATIVE_TEST_EVIDENCE;
const shot = async name => { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') }); } };
async function importTimeline(projectId) {
  const file = (id, n) => `<file id="${id}"><name>${n}.wav</name><pathurl>file://localhost${encodeURI(path.join(sfx, n + '.wav'))}</pathurl><rate><timebase>25</timebase></rate></file>`;
  const clips = [[0, 0, 0, 125], [1, 1, 250, 325], [2, 0, 400, 450], [3, 1, 500, 700]]; // 0–5s、10–13s、16–18s、20–28s
  const tracks = [0, 1].map(t => `<track>${clips.map(([f, tr, a, b], i) => tr === t ? `<clipitem id="c${i}"><name>片段${i}</name><start>${a}</start><end>${b}</end><in>0</in><out>${b - a}</out>${file('f' + f, names[f])}</clipitem>` : '').join('')}</track>`).join('');
  const xml = `<?xml version="1.0"?><!DOCTYPE xmeml><xmeml version="5"><sequence id="s"><name>合成时间线</name><duration>750</duration><rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><media><audio>${tracks}</audio></media></sequence></xmeml>`;
  const preview = await api(`/projects/${projectId}/timeline-import/preview`, { xml });
  await api(`/projects/${projectId}/timeline-import/confirm`, { token: preview.token, selections: preview.rows.map(r => ({ key: r.key, assetId: r.assetId, used: !!r.assetId && r.eligible })), confirmUsed: true });
}
async function importVideo(projectId, folderId, fileName) {
  const requestId = rid();
  await api(`/project-videos/projects/${projectId}/imports`, { requestId, fileName, folderId, bytes: finalBytes.length, prompt: { mode: 'none' } });
  const r = await api(`/project-videos/projects/${projectId}/imports/${requestId}/content`, finalBytes, 'PUT', true);
  assert.equal(r.status, 'ready', JSON.stringify(r).slice(0, 300));
  return r;
}
async function openUsage(projectId) {
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, projectId);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '素材使用', exact: true }).click();
  await expect(page.getByRole('region', { name: '成片与时间线' })).toBeVisible();
}
const usage = () => page.getByRole('region', { name: '成片与时间线' });

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  await api('/roots', { path: sfx, kind: 'sfx' });
  await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 30000 }).toBe(true);
  const A = await api('/projects', { name: '合成第1集', software: 'resolve' }), B = await api('/projects', { name: '合成第2集', software: 'resolve' });
  await importTimeline(A.id); await importTimeline(B.id);
  const own = await api(`/project-videos/projects/${A.id}/folders`, { requestId: rid(), name: '成片', parentId: 'root' });
  const ownId = own.folder?.id || own.id || own.folderId;
  assert.ok(ownId, '没拿到自建成片文件夹 id：' + JSON.stringify(own).slice(0, 200));
  await importVideo(A.id, ownId, '合成第1集_成片.mp4');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));

  await check('真实后端：自建的普通「成片」文件夹在选片窗口里先显示「准备」；点「准备」→ 自动接管（不移动内容）并提示', async () => {
    await openUsage(A.id);
    await expect(usage().locator('.usage-render-status')).toContainText('还没关联成片');
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await expect(dlg).toContainText('这一集还没有「成片」文件夹');
    await dlg.getByRole('button', { name: '准备「成片」文件夹' }).click();
    await expect(dlg.getByRole('status').filter({ hasText: '已把你原有的「成片」文件夹设为保留文件夹' })).toBeVisible({ timeout: 15000 });
    await expect(dlg.getByRole('radio', { name: '选择成片：合成第1集_成片.mp4' })).toBeVisible();
    await shot('real-adopted');
  });
  await check('真实后端：选成片关联（带修订号）→ 状态「成片可播放」→ 点轨道一段，播放器跳到对应秒数（偏移 0）', async () => {
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await dlg.getByRole('radio', { name: '选择成片：合成第1集_成片.mp4' }).check();
    await dlg.getByRole('button', { name: '用这个作为成片' }).click();
    await expect(dlg).toHaveCount(0, { timeout: 20000 });
    await expect(usage().locator('.usage-render-status')).toContainText('成片可播放', { timeout: 15000 });
    await expect(usage().locator('.usage-render-status')).toContainText('成片 / 合成第1集_成片.mp4');
    const video = usage().locator('video');
    await expect.poll(() => video.evaluate(v => v.readyState), { timeout: 15000 }).toBeGreaterThan(0);
    await usage().getByRole('button', { name: /木门吱呀\.wav，A1，00:16\.0/ }).click();
    await expect.poll(() => video.evaluate(v => Math.round(v.currentTime))).toBe(16);
    await expect.poll(() => video.evaluate(v => [v.videoWidth, v.readyState >= 2, !v.error])).toEqual([320, true, true]); // 真的解出了画面，不只是读到元数据
    await expect(page.getByRole('complementary', { name: '此刻时间线上的音效' })).toContainText('木门吱呀.wav');
    await shot('real-linked');
  });
  await check('真实后端：接管后 folderRoles 指向用户原来那个文件夹（同一个 id），状态 ready', async () => {
    const roles = (await api(`/project-videos/projects/${A.id}`)).folderRoles;
    assert.equal(roles.finalFolderId, ownId); assert.equal(roles.finalState, 'ready');
  });
  await check('真实后端：解除关联 → 状态回到「还没关联成片」，项目视频仍在', async () => {
    page.once('dialog', d => d.accept());
    await usage().getByRole('button', { name: '解除成片关联' }).click();
    await expect(usage().locator('.usage-render-status')).toContainText('还没关联成片', { timeout: 15000 });
    const tls = await api(`/projects/${A.id}/timelines`), tl = (tls.timelines || tls)[0];
    const render = await api(`/projects/${A.id}/timelines/${tl.id}/render?schema=2`);
    assert.equal(render.link, null); assert.equal(render.playback.reasonCode, 'RENDER_NOT_LINKED');
    const list = await api(`/projects/${A.id}/timelines/${tl.id}/render/sources`);
    assert.ok(list.items.some(i => i.name === '合成第1集_成片.mp4' && i.selectable), JSON.stringify(list.items.map(i => i.name)));
  });
  await check('真实后端：另一集没有「成片」文件夹 → 点「准备」新建（created），打开窗口本身不建', async () => {
    const before = (await api(`/project-videos/projects/${B.id}`)).folderRoles;
    assert.equal(before.finalState, 'not_created');
    await openUsage(B.id);
    await usage().getByRole('button', { name: '从项目视频里选择成片…' }).click();
    const dlg = page.getByRole('dialog', { name: '选择这一集的成片' });
    await expect(dlg).toContainText('这一集还没有「成片」文件夹');
    assert.equal((await api(`/project-videos/projects/${B.id}`)).folderRoles.finalState, 'not_created');
    await dlg.getByRole('button', { name: '准备「成片」文件夹' }).click();
    await expect(dlg.getByRole('status').filter({ hasText: '已建好「成片」文件夹' })).toBeVisible({ timeout: 15000 });
    assert.equal((await api(`/project-videos/projects/${B.id}`)).folderRoles.finalState, 'ready');
    await dlg.getByRole('button', { name: '取消' }).click();
  });
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  if (!passed) console.log(logs.slice(-3000));
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
}
