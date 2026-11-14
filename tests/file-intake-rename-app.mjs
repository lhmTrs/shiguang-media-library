// 右键收纳联调：真实本地服务（临时库、合成视频、临时端口）+ 构建后的收纳窗口。不碰 4317 和真实素材库。
// 覆盖：剧集命名与分段预览、收纳时才建文件夹、整文件夹连续编号、一个视频不自动关窗与打开目标文件夹、
// 收完在访达中显示的派发记录、偏好记住、多个视频照旧关窗。需要先 npm run build；访达设为不可用（MEDIA_DISABLE_DESKTOP_NATIVE=1）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {chromium, expect} from '@playwright/test';
import {Receipts} from '../server/file-intake/files.mjs';

const root = path.resolve(import.meta.dirname, '..');
const owned = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-intake-rename-app-')));
const evidence = path.resolve(process.env.FILE_INTAKE_RENAME_APP_EVIDENCE || path.join(owned, 'evidence'));
await fs.mkdir(evidence, {recursive: true}); console.log('Evidence: ' + evidence);
const dataDir = path.join(owned, 'data'), personal = path.join(owned, 'personal_item'), clips = path.join(owned, '下载');
await fs.mkdir(clips);
const run = promisify(execFile), pause = ms => new Promise(r => setTimeout(r, ms));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(r => probe.close(r)); assert.notEqual(port, 4317);
const origin = 'http://127.0.0.1:' + port;
let child, exit, exited, output = '', browser, ctx, page, cookie = '', token = '', passed = false;
const checks = [], errors = [], gaps = [];

async function api(url, body, method) {
  const r = await fetch(origin + '/api' + url, {method: method || (body === undefined ? 'GET' : 'POST'), headers: {cookie, ...(body === undefined ? {} : {'content-type': 'application/json', 'x-local-token': token})}, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(15000)});
  const v = await r.json(); if (!r.ok) throw Object.assign(Error(v.error), {status: r.status, code: v.code}); return v;
}
async function ready() {
  for (let i = 0; i < 600; i++) {
    if (exit) throw Error('Owned App exited before ready');
    try {const r = await fetch(origin + '/api/session'); if (r.ok) {const s = await r.json(); cookie = r.headers.get('set-cookie')?.split(';')[0] || ''; token = s.token; return;}} catch {}
    await pause(50);
  }
  throw Error('App ready timeout');
}
async function stop() {
  if (!child || exit) return; child.kill('SIGTERM'); let timer;
  try {await Promise.race([exited, new Promise((_, rej) => {timer = setTimeout(() => rej(Error('OWNED_APP_CLOSE_UNKNOWN')), 20000);})]);} finally {clearTimeout(timer);}
}
async function clip(name, color) {
  const file = path.join(clips, name);
  await run('/opt/homebrew/bin/ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=' + color + ':s=32x32:r=10', '-t', '0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
  return file;
}
async function done(id) {for (let i = 0; i < 600; i++) {const b = await api('/file-intake/batches/' + id); if (!['queued', 'running'].includes(b.status)) return b; await pause(50);} throw Error('batch terminal timeout');}
async function open(handoff) {
  await ctx?.close();
  ctx = await browser.newContext({viewport: {width: 760, height: 690}}); ctx.setDefaultTimeout(8000);
  // Stand-in for the native shell: record what the page asks it to do.
  await ctx.addInitScript(() => {window.nativeMessages = []; window.webkit = {messageHandlers: {intake: {postMessage: v => window.nativeMessages.push(v)}, intakeAppearance: {postMessage: () => {}}}};});
  await ctx.route('**/*', route => {const u = new URL(route.request().url()); if (u.protocol.startsWith('http') && u.origin !== origin) {errors.push('External request blocked ' + u.origin); return route.abort();} return route.continue();});
  page = await ctx.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/file-intake/' + handoff.id);
  await expect(page.getByRole('heading', {name: '收纳素材到拾光', exact: true})).toBeAttached();
  await expect(page.locator('.fi-pill-ok')).toContainText('已核验', {timeout: 15000});
}
const native = () => page.evaluate(() => window.nativeMessages);
const shot = name => page.screenshot({path: path.join(evidence, name + '.png')});
const confirmButton = () => page.locator('.fi-confirm-button');
const renameBox = () => page.getByRole('checkbox', {name: '按项目改名'});
const revealBox = () => page.getByRole('checkbox', {name: '收完在访达中显示'});
const nameCard = () => page.getByRole('region', {name: '收纳后的名字', exact: true});
async function check(name, fn) {await fn(); checks.push(name); console.log('PASS ' + name);}

try {
  child = spawn(process.execPath, ['server/index.mjs'], {cwd: root, env: {...process.env, NODE_ENV: 'production', PORT: String(port), MEDIA_DATA_DIR: dataDir, MEDIA_PERSONAL_ITEM_DIR: personal, MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1', CODEX_HOME: path.join(owned, 'codex'), CODEX_BIN: path.join(owned, 'no-codex')}, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  exited = new Promise(r => child.once('exit', (code, signal) => {exit = {code, signal}; r(exit);}));
  await ready();

  // A series with season 2 and its first episode, plus one existing video folder B.
  const series = await api('/project-series', {name: '穿越计', request_id: randomUUID()});
  const season = await api('/project-series/' + series.id + '/seasons', {request_id: randomUUID(), season_no: 2});
  const episode = (await api('/project-series/' + series.id + '/episodes', {season_id: season.id, expected_episode_no: 1, request_id: randomUUID(), name: '穿越计第一集'})).project;
  await api('/project-videos/projects/' + episode.id + '/folders', {requestId: randomUUID(), parentId: 'root', name: 'B'});
  const receipts = await new Receipts(dataDir).init();
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});

  await check('one video: series name preview, folder only named until 收纳, created once, window stays for 打开目标文件夹', async () => {
    const handoff = await receipts.handoff([await clip('穿越计第一集_dy0612.mp4', 'red')]);
    await open(handoff);
    await expect(page.locator('.fi-single-dest')).toContainText('穿越计 › 第2季 › 第1集');
    await expect(renameBox()).not.toBeChecked(); await renameBox().check();
    await expect(revealBox()).toBeEnabled(); await revealBox().check();
    await page.getByRole('button', {name: '视频文件夹', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: '选择文件夹', exact: true});
    await dialog.getByRole('combobox', {name: '建在哪里', exact: true}).selectOption('root');
    await dialog.getByRole('textbox', {name: '新文件夹名字', exact: true}).fill('A');
    await dialog.getByRole('button', {name: '用这个', exact: true}).click();
    await expect(nameCard().locator('.fi-newname-full')).toHaveText('穿越计S02E01_A_001.mp4');
    await expect(nameCard().locator('.fi-newname-tag')).toHaveText(['剧名穿越计', '季 · 集S02E01', '文件夹A', '序号001']);
    await shot('1-before-confirm');
    // Previewing never creates the folder.
    assert.deepEqual((await api('/file-intake/projects/' + episode.id + '/folders')).folders.map(f => f.relativePath).sort(), ['', 'B']);
    await confirmButton().click();
    await expect(page.getByText('任务已接收，请在网页顶栏“文件任务”查看后续进度。', {exact: true})).toBeVisible();
    await expect(page.getByRole('region', {name: '收完以后', exact: true})).toContainText('穿越计S02E01_A_001.mp4');
    await pause(400); assert.deepEqual(await native(), []); // one video: no automatic close
    const batch = await done((await api('/file-intake/handoffs/' + handoff.id)).batchId);
    const item = batch.items[0];
    assert.equal(item.status, 'ready'); assert.equal(item.resultFileName, '穿越计S02E01_A_001.mp4');
    assert.equal(item.resolvedFolder?.relativePath, 'A');
    if (batch.revealWhenDone !== true) gaps.push('batch DTO 没有 revealWhenDone（合同 B4 要求带出）');
    assert.ok(item.reveal && item.reveal.status !== 'dispatched', 'native disabled: reveal must not claim it was dispatched');
    const folders = (await api('/file-intake/projects/' + episode.id + '/folders')).folders.map(f => f.relativePath).sort();
    assert.deepEqual(folders, ['', 'A', 'B']);
    await page.getByRole('button', {name: '打开目标文件夹', exact: true}).click();
    await expect(page.locator('.fi-foot [role=alert]')).toContainText('连不上访达');
    assert.deepEqual(await native(), []); await shot('2-receipt-desktop-unavailable');
    await page.getByRole('button', {name: '关闭', exact: true}).click(); assert.deepEqual(await native(), ['close']);
  });

  await check('preferences remembered; numbering continues across prefixes in the same folder', async () => {
    // A hand-named file already in A with a two-digit number: the next number must go past it.
    const listing = await api('/project-videos/projects/' + episode.id + '?folderId=all');
    const first = listing.videos.find(v => v.fileName === '穿越计S02E01_A_001.mp4'); assert.ok(first, 'first video registered under its new name');
    await fs.copyFile(first.path, path.join(path.dirname(first.path), 'A_07.mp4'));
    const handoff = await receipts.handoff([await clip('穿越计第一集_dy0613.mp4', 'blue')]);
    await open(handoff);
    await expect(renameBox()).toBeChecked(); await expect(revealBox()).toBeChecked();
    await expect(page.getByRole('button', {name: '视频文件夹', exact: true})).toHaveAttribute('data-value', first.folderId);
    await expect(nameCard().locator('.fi-newname-full')).toHaveText('穿越计S02E01_A_008.mp4');
    await revealBox().uncheck(); await confirmButton().click();
    await expect(page.getByRole('region', {name: '收完以后', exact: true})).toContainText('穿越计S02E01_A_008.mp4');
    const batch = await done((await api('/file-intake/handoffs/' + handoff.id)).batchId);
    assert.equal(batch.items[0].resultFileName, '穿越计S02E01_A_008.mp4'); assert.notEqual(batch.revealWhenDone, true);
    assert.equal(batch.items[0].reveal, undefined);
  });

  await check('several videos: reveal greyed and not sent, numbers in order, window closes on its own', async () => {
    const handoff = await receipts.handoff([await clip('穿越计第一集_x1.mp4', 'green'), await clip('穿越计第一集_x2.mp4', 'yellow')]);
    await open(handoff);
    await expect(revealBox()).toBeDisabled(); await expect(revealBox()).not.toBeChecked(); // last single-video choice was off
    await expect(page.getByRole('group', {name: '收纳时', exact: true})).toContainText('只在收纳 1 个视频时生效');
    await shot('3-several');
    await confirmButton().click();
    await expect.poll(native).toEqual(['accepted']);
    const batch = await done((await api('/file-intake/handoffs/' + handoff.id)).batchId);
    assert.deepEqual(batch.items.map(i => i.resultFileName).sort(), ['穿越计S02E01_A_009.mp4', '穿越计S02E01_A_010.mp4']);
    await expect(page.getByRole('button', {name: '打开目标文件夹', exact: true})).toHaveCount(0);
  });

  assert.deepEqual(errors, []); if (gaps.length) console.log('GAP ' + gaps.join('；')); assert.deepEqual(gaps, []); passed = true;
} catch (error) {
  console.error('FAIL ' + (checks.length + 1) + ': ' + error.message);
  await fs.writeFile(path.join(evidence, 'failure.txt'), (error.stack || String(error)) + '\n\n' + output.slice(-6000));
  if (page) {await page.screenshot({path: path.join(evidence, 'failure.png')}).catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.html'), await page.content().catch(() => ''));}
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {}); await browser?.close().catch(() => {});
  await stop().catch(e => {console.error(e.message); process.exitCode = 1;});
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({passed, checks, errors, exit}, null, 2) + '\n');
}
if (passed) console.log(checks.length + ' 项全部通过');
