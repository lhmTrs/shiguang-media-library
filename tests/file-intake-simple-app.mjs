// INTAKE-SIMPLE end to end: real App + owned SQLite + owned synthetic media, driven through the new window.
// Needs the backend contract (routing-options, name-preview, durationSec, routingPreferences, theme).
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {chromium, expect} from '@playwright/test';
import {Receipts} from '../server/file-intake/files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'shiguang-intake-simple-app-')));
const dataDir = path.join(dir, 'data'), evidence = path.resolve(process.env.FILE_INTAKE_SIMPLE_APP_EVIDENCE || path.join(dir, 'evidence'));
await fs.mkdir(evidence, {recursive: true});
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = listener.address().port; await new Promise(r => listener.close(r));
assert.notEqual(port, 4317);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
let child, exited, exit, output = '', cookie = '', token = '', origin, passed = false; const checks = [], failures = [];
function start() {
  child = spawn(process.execPath, ['server/index.mjs'], {cwd: root, env: {...process.env, NODE_ENV: 'production', PORT: String(port), MEDIA_DATA_DIR: dataDir, MEDIA_PERSONAL_ITEM_DIR: path.join(dir, 'personal_item'),
    MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_CLOUD_AUDIO_ENABLED: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1',
    CODEX_HOME: path.join(dir, 'codex'), CODEX_BIN: path.join(dir, 'no-codex')}, stdio: ['ignore', 'pipe', 'pipe']});
  output = ''; exit = null; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  exited = new Promise(resolve => child.once('exit', (code, signal) => {exit = {code, signal}; resolve(exit);}));
}
async function ready() {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (exit) throw Error('Owned App exited before ready');
    try {const record = JSON.parse(await fs.readFile(path.join(dataDir, 'server.json'), 'utf8'));
      if (record.pid === child.pid) {origin = record.url; const r = await fetch(origin + '/api/session'); const s = await r.json();
        if (r.ok && s.app === 'shiguang-local-media') {cookie = r.headers.get('set-cookie')?.split(';')[0] || cookie; token = s.token; return s;}}}
    catch {} await new Promise(r => setTimeout(r, 50));
  } throw Error('Owned App ready timeout');
}
async function api(url, body, method) {
  const r = await fetch(origin + '/api' + url, {method: method || (body ? 'POST' : 'GET'), headers: {cookie, ...(body ? {'Content-Type': 'application/json', 'X-Local-Token': token} : {})}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000)});
  const value = await r.json(); if (!r.ok) throw Object.assign(Error(value.error), {status: r.status, code: value.code}); return value;
}
async function finishBatch(id) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {const b = await api('/file-intake/batches/' + id); if (!['queued', 'running'].includes(b.status)) return b; await new Promise(r => setTimeout(r, 50));}
  throw Error('Owned batch not terminal within budget');
}
async function stop() {
  if (!child || exit) return; child.kill('SIGTERM'); let timer;
  try {await Promise.race([exited, new Promise((_, reject) => {timer = setTimeout(() => reject(Error('OWNED_APP_CLOSE_UNKNOWN; no force kill attempted')), 20000);})]);}
  finally {clearTimeout(timer);}
  assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.match(output, /APPLICATION_CLOSED_KNOWN/);
}
const media = (args, file) => {const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args, '-y', file]); assert.equal(r.status, 0, String(r.stderr)); return file;};
let browser, context;
try {
  const src = path.join(dir, 'Downloads'); await fs.mkdir(src);
  const video = (name, color) => media(['-f', 'lavfi', '-i', 'color=c=' + color + ':s=96x64:r=2:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p'], path.join(src, name));
  // Distinct pixels per photo, so no two are content duplicates of each other.
  const colors = ['red', 'green', 'blue', 'yellow', 'purple', 'orange']; let shade = 0;
  const photo = async name => media(['-f', 'lavfi', '-i', 'color=c=' + colors[shade++ % colors.length] + ':s=16x16', '-frames:v', '1'], path.join(src, name));
  const v1 = video('穿越计外景16.mp4', 'blue'), p1 = await photo('阿青_泳衣.png'), p2 = await photo('雨夜街口_02.png'), p3 = await photo('image_0931.png');
  const a1 = media(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=42', '-ac', '1', '-ar', '8000'], path.join(src, 'rain.wav'));
  start(); await ready();
  const project = await api('/projects', {name: '穿越计', software: '', note: ''});
  const folder = await api('/project-videos/projects/' + project.id + '/folders', {requestId: randomUUID(), name: '外景'});
  const scene = await api('/project-assets/assets', {project_id: project.id, kind: 'scene', name: '雨夜街口'});
  await api('/file-intake/theme', {themeId: 'dark'}, 'PUT');
  const receipts = await new Receipts(dataDir).init();
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  context = await browser.newContext({viewport: {width: 760, height: 690}}); context.setDefaultTimeout(15000);
  await context.addInitScript(() => {window.nativeAccepted = []; window.webkit = {messageHandlers: {intake: {postMessage: v => window.nativeAccepted.push(v)}, intakeAppearance: {postMessage: () => {}}}};});
  const open = async files => {const h = await receipts.handoff(files); const page = await context.newPage(); page.on('pageerror', e => failures.push(e.message));
    const posts = []; page.on('request', r => {if (r.method() === 'POST' && r.url().endsWith('/confirm')) posts.push(r.postDataJSON());});
    await page.goto(origin + '/#/file-intake/' + h.id); await expect(page.getByRole('heading', {name: '收纳素材到拾光'})).toBeAttached(); return {h, page, posts};};

  // Round 1: every rule against the real service.
  const one = await open([v1, p1, p2, p3, a1]), page = one.page;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('region', {name: '项目「穿越计」 › 外景', exact: true})).toContainText('穿越计外景16.mp4');
  await expect(page.getByRole('region', {name: '项目「穿越计」 · 场景和道具', exact: true})).toContainText('雨夜街口_02.png');
  await expect(page.getByRole('region', {name: '摄影照片 › 待确认', exact: true})).toContainText('image_0931.png');
  await expect(page.getByRole('region', {name: '音效 › 待确认', exact: true})).toContainText('0:42 · 按时长预选为音效');
  await expect(page.getByRole('region', {name: '需要你决定', exact: true})).toContainText('项目里还没有这个人物');
  await expect(page.getByRole('radio', {name: '复制', exact: true})).toBeChecked();
  const standard = page.getByRole('checkbox', {name: '收纳时按规范改名'}); await expect(standard).not.toBeChecked(); await standard.check();
  await expect(page.getByRole('region', {name: '项目「穿越计」 › 外景', exact: true})).toContainText(/穿越计_外景_\d{3}\.mp4/);
  await page.getByRole('group', {name: '去向 阿青_泳衣.png', exact: true}).getByRole('button', {name: '新建人物', exact: true}).click();
  await expect(page.locator('.fi-confirm-button')).toBeEnabled(); await page.screenshot({path: path.join(evidence, 'round1-ready.png')});
  assert.equal(one.posts.length, 0, 'previews never confirm');
  await page.locator('.fi-confirm-button').click(); await expect(page.getByText('任务已接收，请在网页顶栏“文件任务”查看后续进度。', {exact: true})).toBeVisible();
  assert.equal(one.posts.length, 1); assert.deepEqual(await page.evaluate(() => window.nativeAccepted), ['accepted']);
  const sent = one.posts[0], byName = name => one.h.files.find(f => f.name === name).id, t = name => sent.targets.find(x => x.fileId === byName(name));
  assert.equal(sent.standardNames, true);
  assert.deepEqual(t('穿越计外景16.mp4').destination, {kind: 'video', scope: 'project', projectId: project.id, folderId: folder.id}); assert.equal(t('穿越计外景16.mp4').nameMode, 'standard');
  assert.deepEqual(t('雨夜街口_02.png').destination, {kind: 'photo', scope: 'project', projectId: project.id, assetKind: 'scene', assetId: scene.id, assetRevision: scene.revision});
  assert.deepEqual(t('image_0931.png').destination, {kind: 'photo', scope: 'library', directory: ''}); assert.equal(t('image_0931.png').nameMode, undefined);
  assert.deepEqual(t('rain.wav').destination, {kind: 'sfx', scope: 'library', directory: ''});
  const batch = await finishBatch(sent.requestId); await page.screenshot({path: path.join(evidence, 'round1-accepted.png')});
  assert.equal(batch.status, 'completed', JSON.stringify(batch.items.map(i => [i.name, i.status, i.error, i.candidates?.map(c => c.reason)]))); assert.ok(batch.items.every(i => i.status === 'ready'), JSON.stringify(batch.items.map(i => [i.name, i.status, i.error])));
  const item = name => batch.items.find(i => i.name === name);
  assert.match(item('穿越计外景16.mp4').resultFileName || item('穿越计外景16.mp4').plannedFileName, /^穿越计_外景_\d{3}\.mp4$/);
  const sceneAfter = await api('/project-assets/assets/' + scene.id); assert.equal(sceneAfter.images.length, 1);
  const character = await api('/project-assets/assets/' + item('阿青_泳衣.png').creativeAssetId); assert.equal(character.name, '阿青'); assert.ok(character.looks.some(l => l.name === '泳衣'));
  assert.equal((await api('/assets/' + item('rain.wav').assetId)).kind, 'sfx');
  for (const f of [v1, p1, p2, p3, a1]) await fs.access(f);
  checks.push('round 1: video folder by name, scene, new character on explicit click, library photo, sfx by duration; one confirm; copies verified; sources kept');
  const prefs = await api('/file-intake/preferences'), routing = prefs.routingPreferences || (await api('/file-intake/handoffs/' + one.h.id)).routingPreferences;
  assert.equal(routing.standardNames, true); assert.equal(routing.mode, 'copy'); assert.equal(routing.lastVideoFolderByProject[project.id], folder.id); assert.equal(routing.lastProjectId.video, project.id);
  assert.equal((await api('/file-intake/theme')).themeId, 'dark', 'the intake window never writes its theme back');
  checks.push('accepted receipt updates routing preferences; theme read-only from the window');

  // Round 2: remembered folder, existing character, numbering continues.
  const v2 = video('穿越计视频17.mp4', 'red'), p4 = await photo('阿青_日常.png');
  const two = await open([v2, p4]), page2 = two.page;
  await expect(page2.getByRole('region', {name: '项目「穿越计」 › 外景', exact: true})).toContainText('穿越计视频17.mp4');
  await expect(page2.getByRole('checkbox', {name: '收纳时按规范改名'})).toBeChecked();
  await expect(page2.getByRole('region', {name: '项目「穿越计」 · 人物照片', exact: true})).toContainText('阿青_日常.png');
  await expect(page2.locator('.fi-confirm-button')).toBeEnabled(); await page2.locator('.fi-confirm-button').click();
  await expect(page2.getByText('任务已接收，请在网页顶栏“文件任务”查看后续进度。', {exact: true})).toBeVisible();
  const batch2 = await finishBatch(two.posts[0].requestId); assert.equal(batch2.status, 'completed', JSON.stringify(batch2));
  const n1 = Number((item('穿越计外景16.mp4').resultFileName || item('穿越计外景16.mp4').plannedFileName).match(/_(\d{3})\.mp4$/)[1]);
  const second = batch2.items.find(i => i.name === '穿越计视频17.mp4'), n2 = Number((second.resultFileName || second.plannedFileName).match(/_(\d{3})\.mp4$/)[1]);
  assert.equal(n2, n1 + 1, 'standard numbering continues in the same folder');
  const aq = await api('/project-assets/assets/' + character.id); assert.ok(aq.looks.some(l => l.name === '日常'));
  checks.push('round 2: remembered project folder, existing character new look, numbering continues');
  assert.deepEqual(failures, []);
  await context.close(); context = null; await browser.close(); browser = null; await stop(); passed = true;
} finally {
  await context?.close(); await browser?.close(); let closeError; try {await stop();} catch (e) {closeError = e.message;}
  await fs.writeFile(path.join(evidence, 'owned-server.log'), output);
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({passed: passed && !closeError, checks, failures, exit, port, dir, closeError}, null, 2));
  console.log(JSON.stringify({passed: passed && !closeError, checks, evidence}));
}
