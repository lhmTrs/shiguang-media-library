// 右键收纳 · 视频按剧集改名、收完在访达中显示、打开目标文件夹、收纳时新建文件夹（前端）。
// Synthetic responses only: no product server, library, source media or native registration.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, expect} from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const only = process.env.FILE_INTAKE_RENAME_CASE || 'all';
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-intake-rename-')));
const evidence = path.resolve(process.env.FILE_INTAKE_RENAME_EVIDENCE || path.join(temp, 'evidence'));
await fs.mkdir(evidence, {recursive: true}); console.log('Evidence: ' + evidence);
const H = '22222222-2222-4222-8222-222222222222', P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const clone = v => structuredClone(v), pause = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], external = []; let server, browser, context, page, fx, phase = 'setup', passed = false, origin, port;
const file = (id, name, mediaKind) => ({id, name, mediaKind, bytes: 4096, path: '/synthetic/Downloads/' + name});

function setup() {
  return {
    handoff: {id: H, preparation: 'ready', canTrash: true, projects: [{id: P1, name: '穿越计 第5集'}, {id: P2, name: '新品广告'}],
      files: [file('v1', 'dy_0612_2241.mov', 'video')],
      routingPreferences: {lastProjectId: {photo: null, video: P1}, lastVideoFolderByProject: {[P1]: 'f-b'}, lastLibraryDirectory: {photo: '', video: '', music: '', sfx: ''}, lastAudioKind: null, mode: 'copy', standardNames: true, revealWhenDone: true}},
    options: {projects: [
      {id: P1, name: '穿越计 第5集', series: {id: 's1', name: '穿越计', seasonNo: 2, seasonLabel: null, episodeNo: 5},
        videoFolders: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: 'f-b', name: 'B', relativePath: 'B'}, {id: 'f-bb', name: '补拍', relativePath: 'B/补拍'}], assets: []},
      {id: P2, name: '新品广告', videoFolders: [{id: 'root', name: '项目根目录', relativePath: ''}], assets: []}],
      photoCategories: [{id: '', name: '待确认', relativePath: ''}]},
    folders: {[P1]: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: 'f-b', name: 'B', relativePath: 'B'}, {id: 'f-bb', name: '补拍', relativePath: 'B/补拍'}], [P2]: [{id: 'root', name: '项目根目录', relativePath: ''}]},
    confirmBodies: [], previewBodies: [], openBodies: [], posts: [], batches: [], open: ['dispatched'], parts: 'good', receipt: '',
  };
}
// Mirrors the agreed rule closely enough to check what the window shows and sends.
function previewName(t) {
  const d = t.destination, p = fx.options.projects.find(x => x.id === d.projectId);
  const parent = fx.folders[d.projectId].find(f => f.id === (d.folderId || 'root'));
  const folders = [...(parent?.relativePath ? parent.relativePath.split('/') : []), ...(d.newFolder ? [d.newFolder.name] : [])];
  const head = p.series ? [{role: 'series', text: p.series.name}, {role: 'season', text: 'S0' + p.series.seasonNo}, {role: 'episode', text: 'E0' + p.series.episodeNo}] : [{role: 'project', text: p.name}];
  const parts = [...head, ...folders.map(text => ({role: 'folder', text})), {role: 'number', text: d.newFolder ? '001' : '017'}, {role: 'ext', text: '.mov'}];
  const name = (p.series ? p.series.name + 'S0' + p.series.seasonNo + 'E0' + p.series.episodeNo : p.name) + folders.map(f => '_' + f).join('') + '_' + (d.newFolder ? '001' : '017') + '.mov';
  return {name, parts: fx.parts === 'good' ? parts : fx.parts === 'broken' ? [{role: 'project', text: '对不上'}] : undefined};
}
async function routeApi(route) {
  const req = route.request(), url = new URL(req.url()), method = req.method(), body = req.postData() ? req.postDataJSON() : undefined;
  const respond = (value, status = 200) => route.fulfill({status, json: clone(value)});
  if (url.pathname === '/api/session') return respond({app: 'shiguang-local-media', instanceId: 'synthetic', token: 'synthetic-token'});
  if (method === 'POST') {assert.equal(req.headers()['x-local-token'], 'synthetic-token'); fx.posts.push(url.pathname);}
  const ep = url.pathname.slice('/api/file-intake'.length);
  if (ep === '/handoffs/' + H) return respond(fx.handoff);
  if (ep === '/routing-options') return respond(fx.options);
  if (ep === '/handoffs/' + H + '/name-preview') {
    fx.previewBodies.push(body);
    return respond({items: body.targets.map(t => {
      if (t.nameMode !== 'standard' || t.destination.kind !== 'video') return {fileId: t.fileId, proposedFileName: null, proposedNumber: null};
      const n = previewName(t); return {fileId: t.fileId, proposedFileName: n.name, proposedNumber: 17, ...(n.parts ? {nameParts: n.parts} : {})};
    })});
  }
  const pf = ep.match(/^\/projects\/([^/]+)\/folders$/); if (pf) return respond({folders: fx.folders[pf[1]]});
  if (ep === '/handoffs/' + H + '/confirm') {
    fx.confirmBodies.push(body); await pause(60);
    const items = body.fileIds.map(id => {const t = body.targets.find(x => x.fileId === id); return {...fx.handoff.files.find(f => f.id === id), destination: clone(t.destination), ...(t.nameMode ? {nameMode: t.nameMode} : {}), plannedFileName: t.nameMode ? previewName(t).name : undefined, copiedBytes: 0, status: 'queued'};});
    const batch = {version: 2, id: body.requestId, projectId: '', projectName: '多种素材收纳', folderId: '', folderName: '', mode: body.mode, createdAt: 1, updatedAt: 1, status: 'queued', items, revealWhenDone: !!body.revealWhenDone};
    if (fx.receipt === 'reveal-flipped') batch.revealWhenDone = !batch.revealWhenDone;
    if (fx.receipt === 'reveal-missing') delete batch.revealWhenDone; // older receipt shape: nothing to compare
    fx.handoff.batchId = batch.id; fx.batches.unshift(batch);
    return respond(batch);
  }
  const of = ep.match(/^\/batches\/([^/]+)\/open-folder$/);
  if (of) {
    fx.openBodies.push({id: of[1], body}); const next = fx.open.shift() || 'dispatched';
    if (next === 'changed') return respond({code: 'TARGET_CHANGED', error: '目录已被移动'}, 409);
    if (next === 'lost') return route.abort('failed');
    if (next === 'unknown') return respond({code: 'INTAKE_DESKTOP_UNKNOWN', error: '派发结果未知'}, 504);
    if (next === 'unavailable') return respond({code: 'INTAKE_DESKTOP_UNAVAILABLE', error: '桌面不可用'}, 503);
    return respond({status: 'dispatched'});
  }
  const b = ep.match(/^\/batches\/([^/]+)$/), batch = fx.batches.find(x => x.id === b?.[1]);
  if (batch) return respond(batch);
  return respond({error: 'Unexpected fixture route ' + ep}, 404);
}
async function fresh(configure = () => {}) {
  await context?.close(); fx = setup(); configure(fx);
  context = await browser.newContext({viewport: {width: 760, height: 690}}); context.setDefaultTimeout(5000);
  await context.addInitScript(() => {window.nativeMessages = []; window.webkit = {messageHandlers: {intake: {postMessage: v => window.nativeMessages.push(v)}, intakeAppearance: {postMessage: () => {}}}};});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith('http') && url.origin !== origin) {external.push(url.href); return route.abort();}
    try {return await (url.pathname.startsWith('/api/') ? routeApi(route) : route.continue());}
    catch (error) {errors.push('Synthetic route ' + url.pathname + ': ' + error.message); await route.abort().catch(() => {});}
  });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin + '/');
}
const confirmButton = () => page.locator('.fi-confirm-button');
const accepted = () => page.getByText('任务已接收，请在网页顶栏“文件任务”查看后续进度。', {exact: true});
const renameBox = () => page.getByRole('checkbox', {name: '按项目改名'});
const revealBox = () => page.getByRole('checkbox', {name: '收完在访达中显示'});
const nameCard = () => page.getByRole('region', {name: '收纳后的名字', exact: true});
const folderButton = () => page.getByRole('button', {name: '视频文件夹', exact: true});
const native = () => page.evaluate(() => window.nativeMessages);
const shot = name => page.screenshot({path: path.join(evidence, name + '.png')});
async function check(name, fn) {if (only !== 'all' && !name.startsWith(only + ' ')) return; phase = name; await fn(); checks.push(name); console.log('PASS ' + name);}

try {
  await fs.writeFile(path.join(temp, 'index.html'), '<html><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>');
  await fs.writeFile(path.join(temp, 'fixture.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{FileIntakeWindow}from${JSON.stringify(path.join(root, 'src/file-intake/index.ts'))};import ${JSON.stringify(path.join(root, 'src/style.css'))};createRoot(document.getElementById('root')).render(<FileIntakeWindow handoffId="${H}"/>);`);
  server = await createServer({configFile: false, root: temp, envDir: temp, cacheDir: path.join(temp, '.vite'), esbuild: {jsx: 'automatic'}, resolve: {alias: {react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom'), 'lucide-react': path.join(root, 'node_modules/lucide-react')}}, server: {host: '127.0.0.1', port: 0, hmr: false, fs: {allow: [root, temp]}}, logLevel: 'error'});
  await server.listen(); origin = server.resolvedUrls.local[0].replace(/\/$/, ''); port = new URL(origin).port;
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});

  await check('one video in an episode: series place, labelled new name, both options remembered and sent', async () => {
    await fresh();
    await expect(page.locator('.fi-single-dest')).toContainText('穿越计 › 第2季 › 第5集');
    await expect(folderButton()).toContainText('B');
    await expect(renameBox()).toBeChecked(); await expect(revealBox()).toBeChecked(); await expect(revealBox()).toBeEnabled();
    await expect(page.getByRole('group', {name: '收纳时', exact: true})).toContainText('视频按剧集；图片照旧按人物_造型');
    const card = nameCard(); await expect(card).toContainText('收纳后改名为');
    await expect(card.locator('.fi-newname-full')).toHaveText('穿越计S02E05_B_017.mov');
    await expect(card.locator('.fi-newname-tag')).toHaveText(['剧名穿越计', '季 · 集S02E05', '文件夹B', '序号017']);
    await expect(page.locator('.fi-single-name')).toContainText('dy_0612_2241.mov'); // original stays on the file line
    await shot('1-single-video');
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    const b = fx.confirmBodies[0];
    assert.equal(b.revealWhenDone, true); assert.equal(b.standardNames, true);
    assert.deepEqual(b.targets, [{fileId: 'v1', destination: {kind: 'video', scope: 'project', projectId: P1, folderId: 'f-b'}, nameMode: 'standard'}]);
    // One video: the window stays open for 打开目标文件夹, and there is no 文件任务 link any more.
    await pause(300); assert.deepEqual(await native(), []);
    await expect(page.getByText('窗口不会自动关闭；文件收完才会出现在文件夹里', {exact: true})).toBeVisible();
    await expect(page.getByRole('link', {name: /文件任务/})).toHaveCount(0);
    const after = page.getByRole('region', {name: '收完以后', exact: true});
    await expect(after).toContainText('穿越计S02E05_B_017.mov'); await expect(after).toContainText('收完会打开访达，选中这个文件');
    await shot('2-receipt');
    await page.getByRole('button', {name: '打开目标文件夹', exact: true}).click();
    await expect.poll(native).toEqual(['close']);
    assert.deepEqual(fx.openBodies, [{id: b.requestId, body: {}}]);
  });

  await check('open-folder failures keep the window open and say what happened', async () => {
    await fresh(f => {f.open = ['changed', 'lost', 'unknown', 'unavailable', 'dispatched'];});
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    const open = page.getByRole('button', {name: '打开目标文件夹', exact: true});
    await open.click(); await expect(page.locator('.fi-foot [role=alert]')).toContainText('目标文件夹已经不在原来的位置');
    assert.deepEqual(await native(), []); await expect(open).toBeEnabled();
    await open.click(); await expect(page.locator('.fi-foot [role=alert]')).toContainText('没能确认访达是否已经打开');
    assert.deepEqual(await native(), []); assert.equal(fx.openBodies.length, 2); // no retry behind the user's back
    await pause(400); assert.equal(fx.openBodies.length, 2);
    await open.click(); await expect.poll(() => fx.openBodies.length).toBe(3); await expect(page.locator('.fi-foot [role=alert]')).toContainText('没能确认访达是否已经打开');
    await open.click(); await expect(page.locator('.fi-foot [role=alert]')).toContainText('连不上访达');
    assert.deepEqual(await native(), []);
    await page.getByRole('button', {name: '关闭', exact: true}).click(); assert.deepEqual(await native(), ['close']);
  });

  await check('turning reveal off is sent as false; a receipt that disagrees is not taken as this window\'s', async () => {
    await fresh(); await revealBox().uncheck(); await confirmButton().click(); await expect(accepted()).toBeVisible();
    assert.equal(fx.confirmBodies[0].revealWhenDone, false);
    await expect(page.getByRole('region', {name: '收完以后', exact: true})).not.toContainText('打开访达');
    await fresh(f => {f.receipt = 'reveal-missing';}); await confirmButton().click(); await expect(accepted()).toBeVisible();
    await fresh(f => {f.receipt = 'reveal-flipped';}); await confirmButton().click();
    await expect(page.getByText('此选择已由另一窗口接收，以下为原批次；本窗口未确认成功。', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: '打开目标文件夹', exact: true})).toHaveCount(0);
  });

  await check('new folder is only named here: sent as newFolder under the chosen parent, existing names are reused', async () => {
    await fresh();
    await folderButton().click(); const dialog = page.getByRole('dialog', {name: '选择文件夹', exact: true});
    await expect(dialog.getByRole('option', {name: /^B\s*上次用的/})).toBeVisible();
    const input = dialog.getByRole('textbox', {name: '新文件夹名字', exact: true});
    await input.fill('a/b'); await expect(dialog).toContainText('名字里不能有'); await expect(dialog.getByRole('button', {name: '用这个', exact: true})).toBeDisabled();
    // The parent starts at the current folder (B); at the project root, 「b」 is the existing B (case-insensitive).
    await expect(dialog.getByRole('combobox', {name: '建在哪里', exact: true})).toHaveValue('f-b');
    await dialog.getByRole('combobox', {name: '建在哪里', exact: true}).selectOption('root');
    await input.fill('b'); await expect(dialog.getByRole('button', {name: '用已有的', exact: true})).toBeEnabled();
    await dialog.getByRole('button', {name: '用已有的', exact: true}).click(); await expect(folderButton()).toHaveAttribute('data-value', 'f-b');
    await folderButton().click(); await dialog.getByRole('combobox', {name: '建在哪里', exact: true}).selectOption('f-b');
    await input.fill('补拍'); await expect(dialog).toContainText('已有同名文件夹「B/补拍」');
    await input.fill('A'); await dialog.getByRole('combobox', {name: '建在哪里', exact: true}).selectOption('root');
    await shot('3-folder-picker');
    await dialog.getByRole('button', {name: '用这个', exact: true}).click();
    await expect(folderButton()).toHaveAttribute('data-value', 'new:A'); await expect(folderButton()).toContainText('收纳时新建');
    await expect(nameCard()).toContainText('「A」是新文件夹，从 001 开始');
    await shot('4-new-folder');
    await expect(nameCard().locator('.fi-newname-full')).toHaveText('穿越计S02E05_A_001.mov');
    assert.deepEqual(fx.previewBodies.at(-1).targets[0].destination, {kind: 'video', scope: 'project', projectId: P1, folderId: 'root', newFolder: {name: 'A'}});
    assert.equal(fx.posts.filter(p => !p.endsWith('/name-preview')).length, 0); // nothing created before 收纳
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    assert.deepEqual(fx.confirmBodies[0].targets[0].destination, {kind: 'video', scope: 'project', projectId: P1, folderId: 'root', newFolder: {name: 'A'}});
  });

  await check('several videos: reveal is greyed with the reason and not sent; folder popover can name a new folder', async () => {
    await fresh(f => {f.handoff.files = [file('v1', 'dy_1.mov', 'video'), file('v2', 'dy_2.mov', 'video')];});
    await expect(revealBox()).toBeDisabled(); await expect(revealBox()).toBeChecked();
    await expect(page.getByRole('group', {name: '收纳时', exact: true})).toContainText('只在收纳 1 个视频时生效');
    await shot('5-several-videos');
    await page.getByRole('button', {name: '改文件夹…', exact: true}).click();
    const pop = page.getByRole('dialog', {name: '改视频去处', exact: true});
    await pop.getByRole('textbox', {name: '新文件夹名字', exact: true}).fill('C');
    await expect(pop).toContainText('点「收纳」时才真正建'); await pop.getByRole('button', {name: '放进去', exact: true}).click();
    await expect(page.getByRole('region', {name: '穿越计 › 第2季 › 第5集 › B/C（收纳时新建）', exact: true})).toBeVisible();
    await expect(page.locator('.fi-rename').first()).toContainText('穿越计S02E05_B_C_001.mov');
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    const b = fx.confirmBodies[0]; assert.equal('revealWhenDone' in b, false);
    for (const t of b.targets) assert.deepEqual(t.destination, {kind: 'video', scope: 'project', projectId: P1, folderId: 'f-b', newFolder: {name: 'C'}});
    await expect.poll(native).toEqual(['accepted']); // several files still close on their own
    await expect(page.getByRole('button', {name: '打开目标文件夹', exact: true})).toHaveCount(0);
  });

  await check('photos only: no reveal option; name pieces that do not add up fall back to the plain name', async () => {
    await fresh(f => {f.handoff.files = [file('p1', 'image_1.png', 'photo')];});
    await expect(revealBox()).toHaveCount(0);
    await fresh(f => {f.parts = 'broken';});
    await expect(nameCard().locator('.fi-newname-full')).toHaveText('穿越计S02E05_B_017.mov'); await expect(nameCard().locator('.fi-newname-tag')).toHaveCount(0);
    await fresh(f => {f.parts = 'none';});
    await expect(nameCard().locator('.fi-newname-full')).toHaveText('穿越计S02E05_B_017.mov'); await expect(nameCard().locator('.fi-newname-tag')).toHaveCount(0);
    await renameBox().uncheck(); await expect(nameCard()).toHaveCount(0);
  });

  await check('a standalone project keeps project name and has no series place', async () => {
    await fresh(f => {f.handoff.routingPreferences.lastProjectId.video = P2;});
    await expect(page.locator('.fi-single-dest')).toContainText('新品广告');
    await expect(page.locator('.fi-single-dest')).not.toContainText('第');
    await expect(nameCard().locator('.fi-newname-full')).toHaveText('新品广告_017.mov');
    await expect(nameCard().locator('.fi-newname-tag')).toHaveText(['项目新品广告', '序号017']);
  });

  assert.ok(checks.length, 'selected case must run'); assert.deepEqual(errors, []); assert.deepEqual(external, []); passed = true;
} catch (error) {
  console.error('FAIL ' + phase + ': ' + error.message);
  await fs.writeFile(path.join(evidence, 'failure.txt'), error.stack || String(error));
  if (page) {await fs.writeFile(path.join(evidence, 'failure.html'), await page.content().catch(() => '')); await page.screenshot({path: path.join(evidence, 'failure.png')}).catch(() => {});}
  process.exitCode = 1;
} finally {
  await context?.close(); await browser?.close(); await server?.close();
  const resources = {browserClosed: !browser?.isConnected(), viteClosed: !server?.httpServer?.listening};
  if (port) {const probe = net.connect({host: '127.0.0.1', port: Number(port)}); resources.portClosed = await new Promise(r => {probe.once('connect', () => {probe.end(); r(false);}); probe.once('error', () => r(true));});}
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({passed, phase, checks, errors, external, resources}, null, 2) + '\n');
}
if (passed) console.log(checks.length + ' 项全部通过');
