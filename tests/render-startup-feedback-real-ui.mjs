// RENDER-STARTUP-REVISION 前后端组合联调（真实本地服务 + 合成旧库，不替身）。
// A：旧三列成片表 → 启动自动备份补列 → 读接口 writable=true → 页面里真的能关联项目视频成片、能播放。
// B：备份目录被占用 → 启动不补列 → writable=false + backup_failed → 页面说明原因、只禁「用这个作为成片」，准备文件夹照常；
//    直接发写请求时后端返回原请求的 failed 回执，页面不会走到这一步。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium, expect} from '@playwright/test';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {selectProjectInBar} from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const evidence = process.env.CREATIVE_TEST_EVIDENCE;
const work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'render-startup-feedback-')));
const video = path.join(work, 'final.mp4');
execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
const videoBytes = await fs.readFile(video);
const OLD_PAYLOAD = JSON.stringify({schemaVersion: 2, link: null, sourceId: null, offset: 0, linkedTimelineRevision: null, linkedSourceRevision: null, proof: null, snapshot: null, updatedAt: 1});

/** 用当前代码建库，再把成片表退回旧三列（模拟别人用旧版跑过的库）。 */
async function oldLibrary(dataDir, blockBackup) {
  const lib = await new Library(dataDir, {directoryClassification: true}).init(), projects = new Projects(lib).init();
  const project = projects.save(null, {name: '合成旧库项目'}), timeline = randomUUID();
  lib.db.prepare('INSERT INTO project_timelines VALUES(?,?,?,?,?,?,?)').run(timeline, project.id, '合成时间线', JSON.stringify({fps: 25, duration: 6, refs: [], warnings: []}), randomUUID(), randomUUID(), Date.now());
  lib.db.exec('ALTER TABLE project_renders DROP COLUMN revision');
  lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?)').run(timeline, project.id, OLD_PAYLOAD);
  lib.db.close();
  if (blockBackup) await fs.writeFile(path.join(dataDir, 'backups'), 'blocked');
  return {projectId: project.id, timeline};
}
async function serve(dataDir, base) {
  const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const port = s.address().port; await new Promise(r => s.close(r));
  let logs = '';
  const child = spawn(process.execPath, ['server/index.mjs'], {cwd: root, env: {...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: dataDir, MEDIA_PERSONAL_ITEM_DIR: path.join(base, 'personal'), CODEX_HOME: path.join(base, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_CLOUD_AUDIO_ENABLED: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  const exited = new Promise(r => child.once('close', (code, signal) => r({code, signal})));
  const origin = 'http://127.0.0.1:' + port;
  await expect.poll(() => logs, {timeout: 25000}).toContain(origin);
  const res = await fetch(origin + '/api/session'); const cookie = res.headers.get('set-cookie').split(';')[0], token = (await res.json()).token;
  const api = async (p, body, method, raw) => {
    const r = await fetch(origin + '/api' + p, {method: method ?? (body ? 'POST' : 'GET'), headers: {cookie, origin, 'x-local-token': token, 'content-type': raw ? 'application/octet-stream' : 'application/json'}, ...(body ? {body: raw ? body : JSON.stringify(body)} : {})});
    return {status: r.status, body: await r.json()};
  };
  // 只正常关闭（SIGTERM）；15 秒内没退出就如实报 UNKNOWN 并保留现场交给人核对，不强杀
  let stopped = null;
  const stop = async () => {
    if (stopped) return stopped;
    child.kill('SIGTERM'); let t;
    const out = await Promise.race([exited, new Promise(r => t = setTimeout(() => r('timeout'), 15000))]); clearTimeout(t);
    if (out === 'timeout') throw Error(`UNKNOWN: 测试服务 pid ${child.pid} 在 15 秒内没有正常退出，已保留现场，未强制结束；数据目录 ${dataDir}`);
    return stopped = out;
  };
  return {origin, api, stop, logs: () => logs};
}
async function importVideo(srv, projectId, name) {
  const folder = (await srv.api(`/project-videos/projects/${projectId}/folders`, {requestId: randomUUID(), name: '成片', parentId: 'root'})).body;
  const folderId = folder.folder?.id || folder.id || folder.folderId, requestId = randomUUID();
  await srv.api(`/project-videos/projects/${projectId}/imports`, {requestId, fileName: name, folderId, bytes: videoBytes.length, prompt: {mode: 'none'}});
  const imported = await srv.api(`/project-videos/projects/${projectId}/imports/${requestId}/content`, videoBytes, 'PUT', true);
  assert.equal(imported.body.status, 'ready', JSON.stringify(imported.body).slice(0, 200));
}
async function openUsage(page, origin, projectId) {
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, projectId);
  await page.getByRole('navigation', {name: '主导航'}).getByRole('button', {name: '素材使用', exact: true}).click();
  await expect(page.getByRole('region', {name: '成片与时间线'})).toBeVisible();
}
const shot = async (page, name) => { if (evidence) { await fs.mkdir(evidence, {recursive: true}); await page.screenshot({path: path.join(evidence, name + '.png')}); } };
async function check(name, fn) { await fn(); console.log('PASS ' + name); }

let browser; const servers = [];
try {
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true});
  const newPage = async () => { const ctx = await browser.newContext({viewport: {width: 1440, height: 1000}}); await ctx.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); return {page: p, errs}; };

  await check('A 旧三列库：启动自动备份补列 → writable=true → 页面里关联项目视频成片并能播放', async () => {
    const base = path.join(work, 'a'), dataDir = path.join(base, 'data'); await fs.mkdir(base);
    const {projectId, timeline} = await oldLibrary(dataDir, false);
    const srv = await serve(dataDir, base); servers.push(srv);
    const dto = (await srv.api(`/projects/${projectId}/timelines/${timeline}/render?schema=2`)).body;
    assert.equal(dto.writable, true, JSON.stringify(dto).slice(0, 300)); assert.equal(dto.details, null);
    const backups = await fs.readdir(path.join(dataDir, 'backups'), {recursive: true});
    assert.ok(backups.some(f => /render/i.test(f)), '启动时写了成片表备份：' + JSON.stringify(backups));
    await importVideo(srv, projectId, '旧库成片.mp4');
    const {page, errs} = await newPage();
    await openUsage(page, srv.origin, projectId);
    const usage = page.getByRole('region', {name: '成片与时间线'});
    await expect(usage.getByRole('note').filter({hasText: '成片表'})).toHaveCount(0);
    await usage.getByRole('button', {name: '从项目视频里选择成片…'}).click();
    const dlg = page.getByRole('dialog', {name: '选择这一集的成片'});
    await dlg.getByRole('button', {name: '准备「成片」文件夹'}).click();
    await dlg.getByRole('radio', {name: '选择成片：旧库成片.mp4'}).check();
    await dlg.getByLabel('成片片头偏移秒数').fill('0');
    await dlg.getByRole('button', {name: '用这个作为成片'}).click();
    await expect(dlg).toHaveCount(0, {timeout: 20000});
    await expect(usage.locator('.usage-render-status')).toContainText('成片可播放', {timeout: 15000});
    await expect.poll(() => usage.locator('video').evaluate(v => v.readyState)).toBeGreaterThan(0);
    const after = (await srv.api(`/projects/${projectId}/timelines/${timeline}/render?schema=2`)).body;
    assert.equal(after.link, 'project-video'); assert.equal(after.revision, 2, '旧行 revision=1，关联一次后为 2');
    await shot(page, 'startup-upgraded-linked');
    assert.deepEqual(errs, []);
    assert.deepEqual(await srv.stop(), {code: 0, signal: null}); servers.pop();
  });

  await check('B 备份目录被占用：不补列 → writable=false/backup_failed → 页面说明原因、只禁关联；直接写请求得原请求 failed 回执', async () => {
    const base = path.join(work, 'b'), dataDir = path.join(base, 'data'); await fs.mkdir(base);
    const {projectId, timeline} = await oldLibrary(dataDir, true);
    const srv = await serve(dataDir, base); servers.push(srv);
    const dto = (await srv.api(`/projects/${projectId}/timelines/${timeline}/render?schema=2`)).body;
    assert.equal(dto.writable, false); assert.equal(dto.details.renderSchemaUpgrade.reason, 'backup_failed');
    await importVideo(srv, projectId, '备份失败库成片.mp4');
    const {page, errs} = await newPage();
    await openUsage(page, srv.origin, projectId);
    const usage = page.getByRole('region', {name: '成片与时间线'});
    await expect(usage.getByRole('note').filter({hasText: '资料库备份未完成'})).toBeVisible();
    await usage.getByRole('button', {name: '从项目视频里选择成片…'}).click();
    const dlg = page.getByRole('dialog', {name: '选择这一集的成片'});
    await expect(dlg.getByRole('note')).toContainText('请检查磁盘空间和写入权限后重启拾光');
    await expect(dlg.getByRole('button', {name: '准备「成片」文件夹'})).toBeEnabled();
    await expect(dlg.getByRole('button', {name: '用这个作为成片'})).toBeDisabled();
    await shot(page, 'startup-backup-failed');
    // 页面不会发写请求；用接口直接验证后端对这种情况给的是原请求的 failed 回执（前端据此一步显示人话）
    const sources = (await srv.api(`/projects/${projectId}/timelines/${timeline}/render/sources?folderId=all`)).body;
    const source = sources.items.find(i => i.name === '备份失败库成片.mp4');
    assert.ok(source, JSON.stringify(sources).slice(0, 300));
    const rid = randomUUID();
    const post = await srv.api(`/projects/${projectId}/timelines/${timeline}/render`, {requestId: rid, sourceId: source.sourceId, offset: 0, expectedRevision: dto.revision, expectedSourceRevision: source.sourceRevision, expectedTimelineRevision: sources.timelineRevision});
    console.log('B 直接写请求的响应：', post.status, JSON.stringify({status: post.body.status, requestId: post.body.requestId === rid, code: post.body.error?.code ?? post.body.code, upgrade: post.body.error?.details?.renderSchemaUpgrade ?? post.body.details?.renderSchemaUpgrade}));
    assert.equal(post.status, 200); assert.equal(post.body.requestId, rid); assert.equal(post.body.status, 'failed');
    assert.equal(post.body.error.code, 'RENDER_SCHEMA_MIGRATION_REQUIRED'); assert.equal(post.body.error.details.renderSchemaUpgrade.reason, 'backup_failed');
    assert.equal((await srv.api(`/projects/${projectId}/timelines/${timeline}/render?schema=2`)).body.link, null, '没有写入');
    assert.deepEqual(errs, []);
    assert.deepEqual(await srv.stop(), {code: 0, signal: null}); servers.pop();
  });
} finally {
  let unknown = null;
  for (const s of servers) { try { await s.stop(); } catch (e) { unknown = e; console.error(e.message); } }
  await browser?.close();
  if (!unknown) await fs.rm(work, {recursive: true, force: true}); // 有服务没正常退出时保留临时目录供核对
}
