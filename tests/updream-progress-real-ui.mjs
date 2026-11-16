// UPDREAM-PROGRESS-V1 组合联调：真实前端 + 真实后端 + 合成跟进队列（tests/helpers/updream-progress-fixture.mjs）。
// 不拦截任何接口。覆盖：进行中/失败/待核对/已入库可查看 → 页面显示；点「查看视频」跳到生成视频并定位；
// 卡片可见后记已读，重启服务后已读仍在；原队列和任务文件字节不变；页面没有请求本机以外的地址；服务正常关闭。
// 用法：npm run build && node tests/updream-progress-real-ui.mjs（需要 ffmpeg；CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { progressFixture } from './helpers/updream-progress-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const f = await progressFixture();
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const clip = path.join(f.root, '合成.mp4');
assert.equal(spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=96x64:r=8:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', clip]).status, 0);
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: f.data, MEDIA_UPDREAM_QUEUE_DIR: f.queue, MEDIA_PERSONAL_ITEM_DIR: path.join(f.root, 'personal'), CODEX_HOME: path.join(f.root, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' };
let child, logs = '', exited, browser, page, cookie, token, passed = false; const errors = [], foreign = [];
function start() { logs = ''; child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal }))); return expect.poll(() => logs, { timeout: 25000 }).toContain(origin); }
async function stop() { child.kill('SIGTERM'); const r = await Promise.race([exited, new Promise(x => setTimeout(() => x('timeout'), 20000))]); assert.notEqual(r, 'timeout', '服务没有正常退出'); assert.ok(logs.includes('APPLICATION_CLOSED_KNOWN'), '没有正常关闭：' + logs.slice(-400)); }
async function session() { const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; const j = await s.json(); token = j.token; return j; }
async function api(p, body, method, raw) { const r = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': raw ? 'application/octet-stream' : 'application/json' }, body: body ? (raw ? body : JSON.stringify(body)) : undefined }); const d = await r.json(); if (!r.ok) throw Error(p + ' ' + r.status + ' ' + JSON.stringify(d).slice(0, 300)); return d; }
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
const shot = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };
async function snapshot() { const out = {}; for (const dir of [f.jobs, f.sources]) for (const n of await fs.readdir(dir)) out[path.join(dir, n)] = crypto.createHash('sha256').update(await fs.readFile(path.join(dir, n))).digest('hex'); return out; }

try {
  await start(); const s = await session();
  // 真实合成库：一个项目 + 一个托管视频，给「已入库可查看」用
  const project = await api('/projects', { name: 'Updream 组合联调', software: 'resolve' });
  const bytes = await fs.readFile(clip), requestId = crypto.randomUUID();
  await api(`/project-videos/projects/${project.id}/imports`, { requestId, fileName: 'done.mp4', folderId: 'root', bytes: bytes.length, prompt: { mode: 'none' } });
  assert.equal((await api(`/project-videos/projects/${project.id}/imports/${requestId}/content`, bytes, 'PUT', true)).status, 'ready');
  const video = (await api(`/project-videos/projects/${project.id}?folderId=all`)).videos[0];
  const tgt = { origin: 'http://127.0.0.1:4317', project: project.id, folder: '合成片段', filename: 'done.mp4' };
  await f.put('active-1', { stage: 'monitoring' }, { name: '组合联调 · 进行中', generation: { task_id: 'active-1', status: 'processing', progress: '37%' } });
  await f.put('failed-1', { stage: 'failed' }, { name: '组合联调 · 失败', generation: { task_id: 'failed-1', status: 'failed', error: 'PRIVATE_RAW_ERROR' } });
  await f.put('review-1', { stage: 'needs_user' }, { name: '组合联调 · 待核对', generation: { task_id: 'review-1', status: 'processing' } });
  await f.put('done-1', { stage: 'done', target: tgt }, { name: '组合联调 · 已入库', generation: { task_id: 'done-1', status: 'completed' },
    delivery: { stage: 'ready', verified: true, target: { ...tgt, instance: s.instanceId, folder_id: crypto.randomUUID() }, video_id: video.id, prompt_id: crypto.randomUUID(), file: '/PRIVATE/RESULT/FILE.mp4', sha256: 'a'.repeat(64) } });
  const before = await snapshot();
  const list = await api('/updream-progress?scope=all');
  const byId = Object.fromEntries(list.tasks.map(t => [t.id, t]));
  assert.equal(byId['done-1'].phase, 'imported', JSON.stringify(byId['done-1']).slice(0, 400)); assert.equal(byId['done-1'].delivery.canView, true, '已入库合成任务应可查看');
  assert.doesNotMatch(JSON.stringify(list), /PRIVATE_|example\.invalid|token=/);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !['data:', 'blob:'].includes(u.protocol)) foreign.push(r.url()); });
  const entry = () => page.locator('.ud-entry'), drawer = () => page.getByRole('complementary', { name: 'Updream 视频任务' }), card = n => drawer().locator('.ud-card').filter({ hasText: n });

  await check('R1 真后端：顶栏出现入口，进行中/待处理/已完成分类和状态正确，无私有字段', async () => {
    await page.goto(origin + '/#/project-videos');
    await expect(entry()).toContainText('Updream · 进行中 1');
    await entry().click(); await expect(card('组合联调 · 进行中')).toContainText('生成中 · 37%');
    await drawer().getByRole('button', { name: /^待处理/ }).click();
    await expect(card('组合联调 · 失败').locator('.ud-state')).toHaveText('失败'); await expect(card('组合联调 · 待核对').locator('.ud-state')).toHaveText('待核对');
    await expect(drawer()).not.toContainText('PRIVATE');
    await shot('r1-attention');
  });
  await check('R2 已入库：卡片可见后记已读；点「查看视频」跳到生成视频页', async () => {
    await drawer().getByRole('button', { name: /^已完成/ }).click();
    await expect(card('组合联调 · 已入库')).toContainText('原执行方回读核对通过');
    await expect.poll(async () => (await api('/updream-progress?scope=all')).tasks.find(t => t.id === 'done-1').unread, { timeout: 5000 }).toBe(false);
    await card('组合联调 · 已入库').getByRole('button', { name: '查看视频' }).click();
    await expect(page.getByRole('region', { name: '项目生成视频' })).toBeVisible();
    await shot('r2-view');
  });
  await check('R3 原队列与任务文件字节不变；页面只请求本机；无页面错误', async () => {
    assert.deepEqual(await snapshot(), before); assert.deepEqual(foreign, []); assert.deepEqual(errors, []);
  });
  await check('R4 服务正常关闭并重启：已读状态保留，任务仍在', async () => {
    await page.close(); await stop(); await start(); await session();
    const again = await api('/updream-progress?scope=all');
    assert.equal(again.tasks.find(t => t.id === 'done-1').unread, false); assert.equal(again.tasks.length, 4);
    assert.deepEqual(await snapshot(), before);
  });
  await stop();
  passed = true; console.log('ALL PASS updream-progress-real-ui');
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, new Promise(r => setTimeout(r, 15000))]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  await fs.rm(f.root, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-2000)); process.exitCode = 1; }
}
