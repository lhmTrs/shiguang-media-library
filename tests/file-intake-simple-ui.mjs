// Simple intake window (INTAKE-SIMPLE). Component checks against exact synthetic responses.
// No product server, account, library, source media, model or native registration.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, expect} from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const only = process.env.FILE_INTAKE_SIMPLE_CASE || 'all';
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-intake-simple-')));
const evidence = path.resolve(process.env.FILE_INTAKE_SIMPLE_EVIDENCE || path.join(temp, 'evidence'));
await fs.mkdir(evidence, {recursive: true}); console.log('Evidence: ' + evidence);
const H = '11111111-1111-4111-8111-111111111111', P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPpfDwAE/wH+nEwxYgAAAABJRU5ErkJggg==', 'base64');
const clone = v => structuredClone(v), pause = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], external = []; let server, browser, context, page, fx, phase = 'setup', passed = false, origin, port;

function setup() {
  const file = (id, name, mediaKind, extra = {}) => ({id, name, mediaKind, bytes: 4096, path: '/synthetic/Downloads/' + name, ...extra});
  return {
    handoff: {id: H, preparation: 'ready', canTrash: true, projects: [{id: P1, name: '穿越计'}, {id: P2, name: '雨巷'}],
      files: [file('v1', '穿越计视频16.mp4', 'video'), file('p1', '阿青_泳衣.png', 'photo'), file('p2', 'image_0931.png', 'photo'), file('p3', '小雨_校服.png', 'photo'), file('a1', '雨声.wav', 'audio', {durationSec: 42}), file('a2', '片尾.m4a', 'audio', {durationSec: null})],
      routingPreferences: {lastProjectId: {photo: P1, video: P1}, lastVideoFolderByProject: {[P1]: 'f-out'}, lastLibraryDirectory: {photo: '', video: '', music: '', sfx: ''}, lastAudioKind: null, mode: 'copy', standardNames: true}},
    options: {projects: [
      {id: P1, name: '穿越计', videoFolders: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: 'f-out', name: '外景', relativePath: '外景'}],
        assets: [{id: 'c1', kind: 'character', name: '阿青', revision: 3, defaultLookId: 'l1', looks: [{id: 'l1', name: '日常', revision: 1}, {id: 'l2', name: '泳衣', revision: 2}]}, {id: 's1', kind: 'scene', name: '雨夜街口', revision: 5, defaultLookId: null, looks: []}]},
      {id: P2, name: '雨巷', videoFolders: [{id: 'root', name: '项目根目录', relativePath: ''}], assets: []}],
      photoCategories: [{id: '', name: '待确认', relativePath: ''}, {id: '场景', name: '场景', relativePath: '场景'}]},
    preferences: {}, routing404: false, confirm: 'accept', receipt: '', confirmBodies: [], previewBodies: [], posts: [],
    folders: {[P1]: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: 'f-out', name: '外景', relativePath: '外景'}], [P2]: [{id: 'root', name: '项目根目录', relativePath: ''}]},
    categories: Object.fromEntries(['photo', 'video', 'music', 'sfx'].map(k => [k, [{id: '', name: '待确认', relativePath: ''}, {id: '场景', name: '场景', relativePath: '场景'}]])),
    batches: [],
  };
}
function validateConfirm(b) {
  assert.deepEqual(Object.keys(b).sort(), ['fileIds', 'mode', 'requestId', 'standardNames', 'targets', 'version']);
  assert.equal(b.version, 2); assert.match(b.requestId, /^[a-f0-9-]{36}$/); assert.deepEqual(b.targets.map(t => t.fileId), b.fileIds);
  for (const t of b.targets) {
    assert.deepEqual(Object.keys(t).filter(k => !['fileId', 'destination', 'nameMode'].includes(k)), []);
    if (t.nameMode !== undefined) {assert.equal(t.nameMode, 'standard'); assert.equal(t.destination.scope, 'project'); assert.equal(t.destination.fileName, undefined);}
  }
}
async function routeApi(route) {
  const req = route.request(), url = new URL(req.url()), method = req.method(), body = req.postData() ? req.postDataJSON() : undefined;
  const respond = (value, status = 200) => route.fulfill({status, json: clone(value)});
  if (url.pathname === '/api/session') return respond({app: 'shiguang-local-media', instanceId: 'synthetic', token: 'synthetic-token'});
  if (method === 'POST') {assert.equal(req.headers()['x-local-token'], 'synthetic-token'); fx.posts.push(url.pathname);}
  const ep = url.pathname.slice('/api/file-intake'.length);
  if (ep === '/handoffs/' + H) return respond({...fx.handoff, preferences: fx.preferences});
  if (ep.startsWith('/handoffs/' + H + '/files/')) return route.fulfill({status: 200, contentType: 'image/png', body: PNG});
  if (ep === '/routing-options') return fx.routing404 ? respond({error: 'Not found'}, 404) : respond(fx.options);
  if (ep === '/image-proposal') {
    const p = fx.options.projects.find(x => x.id === url.searchParams.get('projectId')), name = url.searchParams.get('name'), lookName = url.searchParams.get('lookName');
    const c = p.assets.find(a => a.kind === 'character' && a.name === name), l = c?.looks.find(x => x.name === lookName);
    return respond({destination: {projectId: p.id, characterId: c?.id || null, characterRevision: c?.revision ?? null, lookId: l?.id || null, lookRevision: l?.revision ?? null, newCharacter: !c, newLook: !l, characterName: name, lookName}, message: ''});
  }
  if (ep === '/handoffs/' + H + '/name-preview') {
    fx.previewBodies.push(body); let n = 17;
    return respond({items: body.targets.map(t => ({fileId: t.fileId, proposedFileName: t.nameMode === 'standard' ? (t.destination.kind === 'video' ? '穿越计_外景_' + String(n++).padStart(3, '0') + '.mp4' : t.destination.assetKind ? '雨夜街口_' + String(n++).padStart(3, '0') + '.png' : t.destination.imageProposal.characterName + '_' + t.destination.imageProposal.lookName + '.png') : null, proposedNumber: null}))});
  }
  const cat = ep.match(/^\/categories\/(\w+)$/); if (cat) return respond({folders: fx.categories[cat[1]]});
  const pf = ep.match(/^\/projects\/([^/]+)\/folders$/); if (pf) return respond({folders: fx.folders[pf[1]]});
  if (ep === '/handoffs/' + H + '/confirm') {
    validateConfirm(body); fx.confirmBodies.push(body); await pause(80);
    if (fx.confirm === 'reject') return respond({error: '合成：目标需要重新选择', code: 'INVALID_TARGET', accepted: false, requestId: body.requestId}, 422);
    const items = body.fileIds.map(id => {const t = body.targets.find(x => x.fileId === id); return {...fx.handoff.files.find(f => f.id === id), destination: clone(t.destination), ...(t.nameMode ? {nameMode: t.nameMode} : {}), copiedBytes: 0, status: 'queued'};});
    const batch = {version: 2, id: body.requestId, projectId: '', projectName: '多种素材收纳', folderId: '', folderName: '', mode: body.mode, createdAt: 1, updatedAt: 1, status: 'queued', items};
    if (fx.receipt === 'wrong-destination') batch.items[0].destination = {kind: 'video', scope: 'project', projectId: P2, folderId: 'root'};
    if (fx.receipt === 'wrong-mode') batch.mode = body.mode === 'copy' ? 'move' : 'copy';
    if (fx.receipt === 'reverse-items') batch.items.reverse();
    if (fx.receipt === 'dropped-name-mode') delete batch.items.find(i => i.nameMode).nameMode;
    fx.handoff.batchId = batch.id; fx.batches.unshift(batch);
    if (fx.confirm === 'lost') return route.abort('failed');
    return respond(batch);
  }
  const b = ep.match(/^\/batches\/([^/]+)$/), batch = fx.batches.find(x => x.id === b?.[1]);
  if (batch) return respond(batch);
  return respond({error: 'Unexpected fixture route ' + ep}, 404);
}
async function fresh(configure = () => {}) {
  await context?.close(); fx = setup(); configure(fx);
  context = await browser.newContext({viewport: {width: 760, height: 690}}); context.setDefaultTimeout(5000);
  await context.addInitScript(() => {window.nativeAccepted = []; window.appearance = []; window.webkit = {messageHandlers: {intake: {postMessage: v => window.nativeAccepted.push(v)}, intakeAppearance: {postMessage: v => window.appearance.push(v)}}};});
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
const group = title => page.getByRole('region', {name: title, exact: true});
const target = (b, id) => b.targets.find(t => t.fileId === id);
async function settle() {
  await page.getByRole('group', {name: '去向 小雨_校服.png', exact: true}).getByRole('button', {name: '新建人物', exact: true}).click();
  await page.getByRole('group', {name: '素材类型 片尾.m4a', exact: true}).getByRole('button', {name: '音乐', exact: true}).click();
  await expect(confirmButton()).toBeEnabled();
}
async function check(name, fn) {if (only !== 'all' && !name.startsWith(only + ' ')) return; phase = name; await fn(); checks.push(name); console.log('PASS ' + name);}

try {
  await fs.writeFile(path.join(temp, 'index.html'), '<html><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>');
  await fs.writeFile(path.join(temp, 'fixture.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{FileIntakeWindow}from${JSON.stringify(path.join(root, 'src/file-intake/index.ts'))};import ${JSON.stringify(path.join(root, 'src/style.css'))};createRoot(document.getElementById('root')).render(<FileIntakeWindow handoffId="${H}"/>);`);
  server = await createServer({configFile: false, root: temp, envDir: temp, cacheDir: path.join(temp, '.vite'), esbuild: {jsx: 'automatic'}, resolve: {alias: {react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom'), 'lucide-react': path.join(root, 'node_modules/lucide-react')}}, server: {host: '127.0.0.1', port: 0, hmr: false, fs: {allow: [root, temp]}}, logLevel: 'error'});
  await server.listen(); origin = server.resolvedUrls.local[0].replace(/\/$/, ''); port = new URL(origin).port;
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});

  await check('routing groups by destination; decisions block confirm; one exact submission with standard names', async () => {
    await fresh();
    const decide = group('需要你决定');
    await expect(decide).toContainText('小雨_校服.png'); await expect(decide).toContainText('项目里还没有这个人物');
    await expect(decide).toContainText('片尾.m4a'); await expect(decide).toContainText('没读到音频时长');
    await expect(group('项目「穿越计」 › 外景')).toContainText('穿越计_外景_017.mp4');
    await expect(group('摄影照片 › 待确认')).toContainText('image_0931.png');
    await expect(group('音效 › 待确认')).toContainText('0:42 · 按时长预选为音效');
    await expect(page.getByText('还差 2 个', {exact: true})).toBeVisible(); await expect(confirmButton()).toBeDisabled();
    await expect(page.getByRole('radio', {name: '复制', exact: true})).toBeChecked();
    await expect(page.getByRole('checkbox', {name: '收纳时按规范改名'})).toBeChecked();
    await page.screenshot({path: path.join(evidence, 'groups.png')});
    await settle(); await page.screenshot({path: path.join(evidence, 'ready.png')});
    assert.equal(fx.confirmBodies.length, 0, 'previews and decisions never submit');
    await confirmButton().click(); await confirmButton().dispatchEvent('click').catch(() => {});
    await expect(accepted()).toBeVisible(); assert.equal(fx.confirmBodies.length, 1);
    const b = fx.confirmBodies[0];
    assert.equal(b.mode, 'copy'); assert.equal(b.standardNames, true); assert.deepEqual(b.fileIds, ['v1', 'p1', 'p2', 'p3', 'a1', 'a2']);
    assert.deepEqual(target(b, 'v1'), {fileId: 'v1', destination: {kind: 'video', scope: 'project', projectId: P1, folderId: 'f-out'}, nameMode: 'standard'});
    assert.deepEqual(target(b, 'p1').destination, {kind: 'photo', scope: 'project', projectId: P1, imageProposal: {projectId: P1, characterId: 'c1', characterRevision: 3, lookId: 'l2', lookRevision: 2, newCharacter: false, newLook: false, characterName: '阿青', lookName: '泳衣'}});
    assert.deepEqual(target(b, 'p2'), {fileId: 'p2', destination: {kind: 'photo', scope: 'library', directory: ''}});
    assert.equal(target(b, 'p3').destination.imageProposal.newCharacter, true); assert.equal(target(b, 'p3').destination.imageProposal.characterName, '小雨');
    assert.deepEqual(target(b, 'a1').destination, {kind: 'sfx', scope: 'library', directory: ''});
    assert.deepEqual(target(b, 'a2').destination, {kind: 'music', scope: 'library', directory: ''});
    assert.ok(fx.previewBodies.length > 0 && fx.previewBodies.every(p => p.targets.every(t => t.destination.scope === 'project')), 'only project targets are name-previewed');
    assert.deepEqual(await page.evaluate(() => window.nativeAccepted), ['accepted']);
    await expect(page.getByText(/秒后自动关闭/)).toBeVisible();
    assert.ok((await page.evaluate(() => window.appearance)).every(v => /^(light|dark)(:#[0-9a-f]{6})?$/.test(v)), 'appearance uses its own channel');
  });

  await check('put photo into a project scene from the group, and keep the name when renamed by hand', async () => {
    await fresh();
    await page.getByRole('checkbox', {name: '选择 image_0931.png', exact: true}).check();
    await group('摄影照片 › 待确认').getByRole('button', {name: '放进项目…', exact: true}).click();
    const pop = page.getByRole('dialog', {name: '放进项目', exact: true});
    await pop.getByRole('button', {name: '场景', exact: true}).click(); await pop.getByRole('radio', {name: '雨夜街口', exact: true}).click();
    await expect(pop).toContainText('放到场景「雨夜街口」'); await pop.getByRole('button', {name: '放进去', exact: true}).click();
    await expect(group('项目「穿越计」 · 场景和道具')).toContainText('雨夜街口_');
    await page.getByRole('button', {name: '单独设置 穿越计视频16.mp4', exact: true}).click();
    const editor = page.getByRole('dialog', {name: '收纳设置 穿越计视频16.mp4', exact: true});
    await editor.getByLabel('副本名称 v1', {exact: true}).fill('我的成片.mp4');
    await editor.getByRole('button', {name: '完成', exact: true}).click();
    await settle(); await confirmButton().click(); await expect(accepted()).toBeVisible();
    const b = fx.confirmBodies[0];
    assert.deepEqual(target(b, 'p2'), {fileId: 'p2', destination: {kind: 'photo', scope: 'project', projectId: P1, assetKind: 'scene', assetId: 's1', assetRevision: 5}, nameMode: 'standard'});
    assert.equal(target(b, 'v1').destination.fileName, '我的成片.mp4'); assert.equal(target(b, 'v1').nameMode, undefined, 'a hand-typed name wins over standard naming');
  });

  await check('single file keeps the project-name hint and stays a general photo', async () => {
    // Independent review counterexample (FE3): a lone 穿越计_天台.png must show the same hint as in the grid.
    await fresh(f => {f.handoff.files = [{id: 'x1', name: '穿越计_天台.png', mediaKind: 'photo', bytes: 4096, path: '/synthetic/Downloads/穿越计_天台.png'}];});
    const dest = page.locator('.fi-single-dest');
    await expect(dest).toContainText('收到 摄影照片 › 待确认'); await expect(dest).toContainText('名字里有项目「穿越计」');
    await expect(page.getByRole('region', {name: '需要你决定', exact: true})).toHaveCount(0);
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    assert.deepEqual(fx.confirmBodies[0].targets, [{fileId: 'x1', destination: {kind: 'photo', scope: 'library', directory: ''}}]);
  });

  await check('round-2 design: project bar, whole-row settings, move highlight, manual tag and reset', async () => {
    await fresh(f => {f.handoff.files.push({id: 'v2', name: 'canvas_77.mp4', mediaKind: 'video', bytes: 4096, path: '/synthetic/Downloads/canvas_77.mp4'});});
    // Equal two-way choices, no primary colour inside the decision rows.
    await expect(page.getByRole('region', {name: '需要你决定', exact: true}).locator('.fi-primary')).toHaveCount(0);
    // Project bar: an unrecognised video follows the batch project; a project named in the file name does not.
    const bar = page.getByLabel('整批项目', {exact: true}); await expect(bar).toHaveValue(P1);
    await bar.selectOption(P2);
    await expect(page.getByRole('region', {name: '项目「雨巷」 › 项目根目录', exact: true})).toContainText('canvas_77.mp4');
    await expect(page.getByRole('region', {name: '项目「穿越计」 › 外景', exact: true})).toContainText('穿越计视频16.mp4');
    await bar.selectOption(P1);
    // Clicking the row (not its buttons) opens the anchored panel over a dimmed window.
    await page.locator('.fi-row', {hasText: '小雨_校服.png'}).click({position: {x: 300, y: 12}});
    const panel = page.getByRole('dialog', {name: '收纳设置 小雨_校服.png', exact: true}); await expect(panel).toBeVisible();
    await expect(page.locator('.fi-scrim')).toBeVisible(); await expect(page.locator('.fi-row.fi-active')).toContainText('小雨_校服.png');
    await panel.getByLabel('人物名 p3', {exact: true}).fill('阿青'); await panel.getByLabel('造型名 p3', {exact: true}).fill('泳衣');
    await panel.getByRole('button', {name: '完成', exact: true}).click(); await expect(panel).toHaveCount(0);
    // It moved into the (opened) character group, lit up, and carries the manual tag.
    const moved = page.getByRole('region', {name: '项目「穿越计」 · 人物照片', exact: true}).locator('.fi-tile', {hasText: '手动设置'});
    await expect(moved).toHaveCount(1); await expect(moved).toHaveClass(/fi-flash/);
    await expect(page.getByRole('region', {name: '需要你决定', exact: true})).not.toContainText('小雨_校服.png');
    // 恢复自动分 returns it to the question.
    await page.getByRole('button', {name: '单独设置 小雨_校服.png', exact: true}).click();
    await page.getByRole('dialog', {name: '收纳设置 小雨_校服.png', exact: true}).getByRole('button', {name: '恢复自动分', exact: true}).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('region', {name: '需要你决定', exact: true})).toContainText('小雨_校服.png');
    assert.equal(fx.confirmBodies.length, 0);
  });

  await check('project bar with different photo and video history shows what really happens (FE5 R1)', async () => {
    // Independent review counterexample: photo history 穿越计, video history 雨巷, no project in canvas_77.mp4.
    await fresh(f => {
      f.handoff.routingPreferences.lastProjectId = {photo: P1, video: P2};
      f.handoff.files = [['v1', '穿越计视频16.mp4', 'video'], ['v2', 'canvas_77.mp4', 'video'], ['p1', '阿青_泳衣.png', 'photo'], ['p2', 'image_0931.png', 'photo']]
        .map(([id, name, mediaKind]) => ({id, name, mediaKind, bytes: 4096, path: '/synthetic/Downloads/' + name}));
    });
    const bar = page.getByLabel('整批项目', {exact: true});
    // Initial display: no single project is pretended; each kind keeps its own history, said plainly.
    await expect(bar).toHaveValue(''); await expect(bar.locator('option:checked')).toHaveText('各自沿用上次');
    await expect(page.locator('.fi-projectbar')).toContainText('照片和视频的默认去处不同');
    await expect(group('项目「雨巷」 › 项目根目录')).toContainText('canvas_77.mp4');
    await expect(group('项目「穿越计」 · 人物照片')).toContainText('阿青_泳衣.png');
    // A per-file manual target, set before the bar changes.
    await page.getByRole('checkbox', {name: '选择 image_0931.png', exact: true}).check();
    await group('摄影照片 › 待确认').getByRole('button', {name: '放进项目…', exact: true}).click();
    const pop = page.getByRole('dialog', {name: '放进项目', exact: true});
    await pop.getByRole('button', {name: '场景', exact: true}).click(); await pop.getByRole('radio', {name: '雨夜街口', exact: true}).click();
    await pop.getByRole('button', {name: '放进去', exact: true}).click();
    // Explicit change to 雨巷: unnamed photo and video both follow it; named and manual files do not move.
    await bar.selectOption(P2); await expect(page.locator('.fi-projectbar')).not.toContainText('照片和视频的默认去处不同');
    await expect(group('项目「雨巷」 › 项目根目录')).toContainText('canvas_77.mp4');
    await expect(group('需要你决定')).toContainText('阿青_泳衣.png'); // 雨巷 has no 阿青: the agreed new-character question
    await expect(group('项目「穿越计」 › 外景')).toContainText('穿越计视频16.mp4');
    // Explicit change to 穿越计: everything unnamed follows it, video into that project's last folder.
    await bar.selectOption(P1); await expect(bar).toHaveValue(P1);
    await expect(group('项目「穿越计」 › 外景')).toContainText('canvas_77.mp4');
    await expect(group('项目「穿越计」 · 人物照片')).toContainText('阿青_泳衣.png');
    await expect(confirmButton()).toBeEnabled(); await confirmButton().click(); await expect(accepted()).toBeVisible();
    const b = fx.confirmBodies[0], d = id => target(b, id).destination;
    assert.deepEqual(b.fileIds, ['v1', 'v2', 'p1', 'p2']);
    for (const id of ['v1', 'v2']) assert.deepEqual([d(id).kind, d(id).projectId, d(id).folderId], ['video', P1, 'f-out'], id);
    assert.equal(d('p1').projectId, P1); assert.equal(d('p1').scope, 'project');
    assert.deepEqual([d('p2').projectId, d('p2').assetKind, d('p2').assetId], [P1, 'scene', 's1']);
    assert.equal(fx.confirmBodies.length, 1);
  });

  await check('project bar with history on one side only stays neutral and can pick the same project (FE6 R1)', async () => {
    const files = names => names.map(([id, name, mediaKind]) => ({id, name, mediaKind, bytes: 4096, path: '/synthetic/Downloads/' + name}));
    // Independent review counterexample: only 穿越计 exists, photo history 穿越计, no video history.
    await fresh(f => {
      f.options.projects = [f.options.projects[0]]; f.handoff.projects = [f.handoff.projects[0]];
      f.handoff.routingPreferences.lastProjectId = {photo: P1, video: null}; f.handoff.routingPreferences.lastVideoFolderByProject = {};
      f.handoff.files = files([['p1', '阿青_泳衣.png', 'photo'], ['v2', 'canvas_77.mp4', 'video']]);
    });
    const bar = page.getByLabel('整批项目', {exact: true});
    await expect(bar).toHaveValue(''); await expect(bar.locator('option:checked')).toHaveText('各自沿用上次');
    await expect(page.locator('.fi-projectbar')).toContainText('照片和视频的默认去处不同');
    await expect(group('视频素材 › 待确认')).toContainText('canvas_77.mp4');
    await expect(group('项目「穿越计」 · 人物照片')).toContainText('阿青_泳衣.png');
    // The one project can be chosen explicitly, and the video follows it.
    await bar.selectOption(P1); await expect(bar).toHaveValue(P1);
    await expect(group('项目「穿越计」 › 项目根目录')).toContainText('canvas_77.mp4'); await expect(group('视频素材 › 待确认')).toHaveCount(0);
    await expect(confirmButton()).toBeEnabled(); await confirmButton().click(); await expect(accepted()).toBeVisible();
    let b = fx.confirmBodies[0];
    assert.deepEqual(target(b, 'v2').destination, {kind: 'video', scope: 'project', projectId: P1, folderId: 'root'});
    assert.equal(target(b, 'p1').destination.projectId, P1); assert.equal(fx.confirmBodies.length, 1);

    // Only video history: neutral too; without a pick the request keeps each kind's own default.
    await fresh(f => {
      f.handoff.routingPreferences.lastProjectId = {photo: null, video: P2};
      f.handoff.files = files([['p2', 'image_0931.png', 'photo'], ['v2', 'canvas_77.mp4', 'video']]);
    });
    await expect(page.getByLabel('整批项目', {exact: true})).toHaveValue('');
    await expect(page.locator('.fi-projectbar')).toContainText('照片和视频的默认去处不同');
    await expect(group('项目「雨巷」 › 项目根目录')).toContainText('canvas_77.mp4'); await expect(group('摄影照片 › 待确认')).toContainText('image_0931.png');
    await confirmButton().click(); await expect(accepted()).toBeVisible(); b = fx.confirmBodies[0];
    assert.deepEqual(target(b, 'v2').destination, {kind: 'video', scope: 'project', projectId: P2, folderId: 'root'});
    assert.deepEqual(target(b, 'p2').destination, {kind: 'photo', scope: 'library', directory: ''});

    // Zero followers: every name carries its project; the bar shows that project and claims nothing else.
    await fresh(f => {f.handoff.routingPreferences.lastProjectId = {photo: null, video: null}; f.handoff.files = files([['v1', '穿越计视频16.mp4', 'video']]);});
    await expect(page.getByLabel('整批项目', {exact: true})).toHaveValue(P1);
    await expect(page.locator('.fi-projectbar')).not.toContainText('默认去处不同');
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    assert.equal(target(fx.confirmBodies[0], 'v1').destination.projectId, P1);
  });

  await check('footer stays clickable while an editable settings panel is open (FE5 R2)', async () => {
    await fresh(); await page.setViewportSize({width: 600, height: 560});
    await settle();
    await page.locator('.fi-foot label', {hasText: '移动'}).click(); await expect(page.getByRole('radio', {name: '移动', exact: true})).toBeChecked();
    await page.getByRole('button', {name: '单独设置 image_0931.png', exact: true}).click();
    const panel = page.getByRole('dialog', {name: '收纳设置 image_0931.png', exact: true}); await expect(panel).toBeVisible();
    await expect(page.locator('.fi-scrim')).toBeVisible();
    // The real click must land on the button itself, not on the scrim or the panel.
    const hit = await confirmButton().evaluate(el => {const r = el.getBoundingClientRect(), top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && el.contains(top);});
    assert.equal(hit, true, 'confirm button centre is covered');
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    assert.equal(fx.confirmBodies.length, 1); assert.equal(fx.confirmBodies[0].mode, 'move');
  });

  await check('removed files leave the submission and can be restored; audio kind can be switched', async () => {
    await fresh();
    for (const name of ['小雨_校服.png', '片尾.m4a']) {await page.getByRole('button', {name: '单独设置 ' + name, exact: true}).click(); await page.getByRole('button', {name: '移除 ' + name, exact: true}).click();}
    await expect(page.getByRole('button', {name: '恢复 小雨_校服.png', exact: true})).toBeVisible();
    await page.getByRole('group', {name: '素材类型 雨声.wav', exact: true}).getByRole('button', {name: '音乐', exact: true}).click();
    await expect(confirmButton()).toBeEnabled(); await confirmButton().click(); await expect(accepted()).toBeVisible();
    const b = fx.confirmBodies[0]; assert.deepEqual(b.fileIds, ['v1', 'p1', 'p2', 'a1']); assert.equal(target(b, 'a1').destination.kind, 'music');
  });

  await check('selection-proof background check keeps choices, never submits early, enables only when ready', async () => {
    await fresh(f => {f.handoff.preparation = 'checking';});
    await expect(page.getByText('正在后台核验原文件，可先选择项目和文件夹；完成后即可确认收纳。', {exact: true})).toBeVisible();
    await settle().catch(() => {}); await expect(confirmButton()).toBeDisabled();
    fx.handoff.preparation = 'ready'; await expect(confirmButton()).toBeEnabled({timeout: 4000}); assert.equal(fx.confirmBodies.length, 0);
    await expect(group('需要你决定')).toHaveCount(0);
    fx.handoff.preparation = 'failed'; fx.handoff.preparationError = '合成核验失败'; await page.reload();
    await expect(page.getByText('合成核验失败', {exact: true})).toBeVisible(); await expect(confirmButton()).toBeDisabled(); assert.equal(fx.confirmBodies.length, 0);
  });

  await check('known refusal keeps inputs; lost confirm locks the original request and recovers without repost', async () => {
    await fresh(); await settle(); fx.confirm = 'reject'; await confirmButton().click();
    await expect(page.locator('.fi-body > .fi-error')).toContainText('目标需要重新选择'); await expect(confirmButton()).toBeEnabled();
    fx.handoff.batchId = undefined; fx.batches = []; fx.confirm = 'lost'; await confirmButton().click();
    const check = page.getByRole('button', {name: '核对原提交结果', exact: true}); await expect(check).toBeVisible();
    await expect(page.getByRole('group', {name: '素材类型 雨声.wav', exact: true}).getByRole('button', {name: '音乐', exact: true})).toBeDisabled();
    await pause(1200); assert.equal(fx.confirmBodies.length, 2); await check.click(); await expect(accepted()).toBeVisible();
    await page.reload(); await expect(page.getByText('这是此选择的既有回执，没有新建任务。', {exact: true})).toBeVisible(); assert.equal(fx.confirmBodies.length, 2);
  });

  await check('confirm-binding rejects changed destination, mode or name mode; matching items accept regardless of order', async () => {
    for (const variant of ['wrong-destination', 'wrong-mode', 'dropped-name-mode', 'reverse-items']) {
      await fresh(f => {f.receipt = variant;}); await settle(); await confirmButton().click();
      if (variant === 'reverse-items') {await expect(accepted()).toBeVisible(); assert.deepEqual(await page.evaluate(() => window.nativeAccepted), ['accepted']);}
      else {await expect(page.getByText('此选择已由另一窗口接收，以下为原批次；本窗口未确认成功。', {exact: true})).toBeVisible(); assert.deepEqual(await page.evaluate(() => window.nativeAccepted), []);}
      assert.equal(fx.confirmBodies.length, 1);
    }
  });

  await check('legacy saved submission reconciles without upgrading or reposting', async () => {
    await fresh(); const journal = {requestId: '33333333-3333-4333-8333-333333333333', projectId: P1, folderId: 'f-out', mode: 'move', fileIds: ['v1']};
    await page.evaluate(({id, journal}) => sessionStorage.setItem('shiguang.file-intake.' + id, JSON.stringify(journal)), {id: H, journal});
    await page.reload(); await expect(page.getByRole('button', {name: '核对原提交结果', exact: true})).toBeVisible();
    const legacy = {id: journal.requestId, projectId: P1, projectName: '穿越计', folderId: 'f-out', folderName: '外景', mode: 'move', createdAt: 1, updatedAt: 1, status: 'queued', items: [{...fx.handoff.files[0], copiedBytes: 0, status: 'queued'}]};
    fx.batches.unshift(legacy); fx.handoff.batchId = legacy.id;
    await page.getByRole('button', {name: '核对原提交结果', exact: true}).click(); await expect(accepted()).toBeVisible();
    assert.equal(fx.confirmBodies.length, 0); assert.equal(fx.posts.length, 0);
  });

  await check('older service without routing options falls back to per-kind presets and per-file editing quietly', async () => {
    await fresh(f => {f.routing404 = true; f.handoff.routingPreferences = undefined; f.handoff.files = f.handoff.files.filter(x => x.mediaKind === 'video'); f.preferences = {video: {kind: 'video', scope: 'project', projectId: P2, folderId: 'root'}};});
    await expect(page.locator('.fi-single-dest')).toContainText('收到 雨巷 › 项目根目录'); await expect(page.locator('.fi-single')).toContainText('穿越计视频16.mp4'); await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('checkbox', {name: '收纳时按规范改名'})).not.toBeChecked();
    await confirmButton().click(); await expect(accepted()).toBeVisible();
    assert.deepEqual(fx.confirmBodies[0].targets, [{fileId: 'v1', destination: {kind: 'video', scope: 'project', projectId: P2, folderId: 'root'}}]);
    assert.equal(fx.confirmBodies[0].standardNames, false);
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
