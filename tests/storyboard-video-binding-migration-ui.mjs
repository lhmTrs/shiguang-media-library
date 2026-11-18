// 分镜视频绑定 v2 迁移未完成时的页面状态：真实服务和页面，读取响应按合同 v1.3 的字段改成“暂缓/失败”。
// 后端升级本身由后端和组合测试覆盖；这里只查前端不把未知当成没有采用，也不放开依赖保护的写入口。
// 用法：npm run build && node tests/storyboard-video-binding-migration-ui.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID as rid } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'video-binding-migration-ui-')));
const s0 = net.createServer(); await new Promise(r => s0.listen(0, '127.0.0.1', r)); const port = s0.address().port; await new Promise(r => s0.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, library, passed = false; const errors = [], writes = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'item'), MEDIA_PERSONAL_VIDEO_DIR: path.join(temp, 'video'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_UPDREAM_QUEUE_DIR: path.join(temp, 'no-queue'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
const headers = () => ({ cookie, origin, 'x-local-token': token, 'x-shiguang-library-id': library });
async function api(p, body) { const r = await fetch(origin + '/api' + p, { method: body ? 'POST' : 'GET', headers: { ...headers(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json(); if (!r.ok) throw Error(p + ' ' + r.status + JSON.stringify(d).slice(0, 200)); return d; }
const check = async (name, fn) => { await fn(); console.log('PASS ' + name); };
async function importVideo(project, name, color) {
  const file = path.join(temp, name), run = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]); assert.equal(run.status, 0, String(run.stderr));
  const bytes = await fs.readFile(file), requestId = rid(); await api(`/project-videos/projects/${project}/imports`, { requestId, fileName: name, bytes: bytes.length, prompt: { mode: 'none' } });
  const receipt = await (await fetch(`${origin}/api/project-videos/projects/${project}/imports/${requestId}/content`, { method: 'PUT', headers: { ...headers(), 'content-type': 'application/octet-stream' }, body: bytes })).json(); assert.equal(receipt.status, 'ready'); return receipt.videoId;
}
const deferred = { schemaVersion: 2, status: 'deferred', phase: 'deferred', reasonCode: 'INSTANCE_DEFERRED', writeAllowed: false, adoptionKnown: false, historyPrune: 'paused' };
let migration = deferred;
const rewrite = (route, change) => route.fetch().then(async response => { const body = await response.json(); change(body); await route.fulfill({ response, json: body }); });
const work = () => page.getByRole('region', { name: '项目生成视频' }), card = id => work().locator(`.pv-card[data-video-id="${id}"]`), detail = () => work().getByRole('complementary', { name: '视频详情' });

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const session = await fetch(origin + '/api/session'), auth = await session.json(); cookie = session.headers.get('set-cookie').split(';')[0]; token = auth.token; library = auth.instanceId;
  const project = await api('/projects', { name: '合成迁移项目' }), source = syntheticSource(); await api(`/storyboard/projects/${project.id}/initialize`, { request_id: rid(), source, expected_revision: null, filename: '合成.json', timing: 'duration' });
  const first = await importVideo(project.id, 'first.mp4', 'navy'), second = await importVideo(project.id, 'second.mp4', 'teal');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { const u = new URL(r.url()); if (r.method() !== 'GET' && /storyboard-video\/v2|\/operations|\/remove$/.test(u.pathname)) writes.push(u.pathname); });
  await page.route(url => /\/api\/project-videos\/projects\/[^/]+$/.test(url.pathname), route => route.request().method() === 'GET' ? rewrite(route, body => { body.adoptionStamp = null; body.migration = migration; for (const video of body.videos) video.adoptedShots = null; }) : route.fallback());
  await page.route(url => /\/api\/storyboard-video\/v2\/projects\/[^/]+\/state$/.test(url.pathname), route => rewrite(route, body => { body.migration = migration; body.context.selectionRevision = null; for (const shot of body.shots) Object.assign(shot, { adopted: null, defaultVideo: null, candidateCount: null, newVideoCount: null, needsReview: null, reviewReasons: null }); }));
  await page.route(url => /\/api\/storyboard-video\/v2\/projects\/[^/]+\/shots\/[^/]+\/videos$/.test(url.pathname), route => rewrite(route, body => { Object.assign(body, { migration, total: null, items: [] }); }));

  await check('M1 生成视频页：能打开和播放，采用显示待确认，不写成候选', async () => {
    await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id); await expect(card(first)).toBeVisible({ timeout: 15000 });
    await expect(work().getByRole('status').filter({ hasText: '片子绑定数据升级已暂缓' })).toContainText('分镜旧版本清理已暂停'); await expect(card(first)).toContainText('采用待确认'); await expect(card(first)).not.toContainText('候选');
    const chips = work().getByRole('group', { name: '按采用状态筛选' }); await expect(chips.getByRole('button', { name: /候选/ })).toBeDisabled(); await expect(chips.getByRole('button', { name: /已采用/ })).toBeDisabled();
    await card(first).click(); await expect(detail()).toContainText('采用关系待确认'); await expect(detail().locator('video').first().or(detail().getByRole('button', { name: /播放|查看/ }).first())).toBeVisible();
  });

  await check('M2 依赖采用保护的入口全部停用，也不发写请求', async () => {
    await detail().getByRole('button', { name: '视频操作' }).click(); for (const name of [/^移动到/, /标记为废片/, /移除视频记录/]) await expect(page.getByRole('menuitem', { name })).toBeDisabled(); await page.keyboard.press('Escape');
    await card(second).click({ button: 'right' }); const menu = page.getByRole('menu', { name: '视频操作' }); for (const name of [/对应到分镜镜头/, /^移动到/]) await expect(menu.getByRole('menuitem', { name })).toBeDisabled(); await page.keyboard.press('Escape');
    await card(first).click(); await card(second).click({ modifiers: ['Meta'] }); const bar = work().getByRole('toolbar', { name: '已选视频操作' }); await expect(bar.getByRole('button', { name: /移动到/ })).toBeDisabled(); await expect(bar.getByRole('button', { name: '标记为废片' })).toBeDisabled(); assert.deepEqual(writes, []);
  });

  await check('M3 分镜页：显示暂缓和裁剪暂停，镜号写状态，打开后不说没有片子', async () => {
    await page.goto(origin + '/?r=1#/storyboards'); await selectProjectInBar(page, project.id); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.sv-migration')).toContainText('片子绑定数据升级已暂缓'); await expect(page.locator('.sv-migration')).toContainText('分镜旧版本清理已暂停'); const button = page.getByRole('button', { name: '播放镜01的片子' }); await expect(button).toContainText('已暂缓'); await button.click();
    const d = page.getByRole('dialog', { name: '镜 01 的片子' }); await expect(d.getByText('暂时读不到这一镜对应的片子')).toBeVisible(); await expect(d.getByText('这一镜还没有对应的片子')).toHaveCount(0); await d.getByRole('button', { name: '关闭' }).click(); assert.deepEqual(writes, []);
  });

  await check('M4 升级失败：两页都写明失败状态', async () => {
    migration = { ...deferred, status: 'failed', phase: 'delete', reasonCode: 'MIGRATION_FAILED', historyPrune: 'paused' }; await page.reload(); await expect(page.locator('.sv-migration')).toContainText('片子绑定数据升级失败（MIGRATION_FAILED）', { timeout: 15000 }); await expect(page.getByRole('button', { name: '播放镜01的片子' })).toContainText('升级失败');
    await page.goto(origin + '/?r=2#/project-videos'); await expect(work().getByRole('status').filter({ hasText: '片子绑定数据升级失败' })).toBeVisible({ timeout: 15000 });
  });

  assert.deepEqual(errors, []); passed = true; console.log('ALL PASS storyboard-video-binding-migration-ui');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const r = await Promise.race([exited, new Promise(x => setTimeout(() => x('timeout'), 20000))]); if (r === 'timeout') { console.log('服务没有在 20 秒内正常退出'); passed = false; } }
  if (passed && !logs.includes('APPLICATION_CLOSED_KNOWN')) { console.log('没有正常关闭'); passed = false; }
  await fs.rm(temp, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-1500)); process.exitCode = 1; }
}
