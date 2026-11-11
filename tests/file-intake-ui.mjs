// Isolated component checks. No product server, account, library, source media or native registration.
// The confirmation window itself is covered by tests/file-intake-simple-ui.mjs since INTAKE-SIMPLE;
// this runner keeps the file-task drawer, receipts, retries and completion notices.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {chromium, expect} from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const selectedCase = process.env.FILE_INTAKE_UI_CASE || 'all'; assert.ok(['all', 'completion', 'drawer-layout', 'retry-guidance', 'acknowledgement'].includes(selectedCase));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-intake-ui-')));
const evidence = path.resolve(process.env.FILE_INTAKE_UI_EVIDENCE || path.join(temp, 'evidence'));
await fs.mkdir(evidence, {recursive: true});
console.log('Evidence: ' + evidence);
const handoffId = '11111111-1111-4111-8111-111111111111', clone = value => structuredClone(value), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const folderA = 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa', folderB = 'bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb';
const projectTarget = (projectId = projectA, folderId = 'root') => ({kind: 'video', scope: 'project', projectId, folderId});
const checks = [], requests = [], errors = [], external = []; let server, browser, context, page, fixture, phase = 'setup', passed = false, origin, port;
const sourceFiles = ['tests/file-intake-ui.mjs', 'src/file-intake/FileIntakeWindow.tsx', 'src/file-intake/TargetEditor.tsx', 'src/file-intake/types.ts', 'src/file-intake/BatchDetails.tsx', 'src/file-intake/FileTaskEntry.tsx', 'src/file-intake/file-intake.css'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
const sourcesAtStart = await sourceHashes();
function setup() {
  const item = (id, status, extra = {}) => ({id, name: id + '.mp4', bytes: 4096, copiedBytes: 0, status, ...extra});
  return {
    status: {supported: true, installed: false, canTrash: true, activeCount: 2, needsAttention: 3, latestCompletion: null},
    handoff: {id: handoffId, preparation: 'ready', files: [{id: 'f1', mediaKind: 'video', name: '合成视频甲.mp4', bytes: 4096, path: '/synthetic/很长的自有目录/'.repeat(9) + '合成视频甲.mp4'}, {id: 'f2', mediaKind: 'video', name: '合成视频乙.mov', bytes: 8192, path: '/synthetic/合成视频乙.mov'}], projects: [{id: projectA, name: '合成甲项目'}, {id: projectB, name: '合成乙项目'}], canTrash: true},
    libraryId: 'synthetic-instance', preferences: {},
    folders: {[projectA]: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: folderA, name: '成片', relativePath: '合成甲/成片'}], [projectB]: [{id: 'root', name: '项目根目录', relativePath: ''}, {id: folderB, name: '成片', relativePath: '合成乙/成片'}]},
    categories: Object.fromEntries(['photo', 'video', 'music', 'sfx'].map(kind => [kind, [{id: '', name: '待确认', relativePath: ''}, {id: '合成分类', name: '合成分类', relativePath: '合成分类'}]])),
    batches: [{id: 'batch-existing', projectId: projectA, projectName: '合成甲项目', folderId: folderA, folderName: '成片/第一段', mode: 'move', createdAt: 1, updatedAt: 1, status: 'waiting', items: [
      item('conflict', 'duplicate', {adoptionStamp: 'stamp-v1', candidates: [{id: 'candidate-a', name: '目标同名.mp4', reason: '同名视频', adoptedShots: [{id: 'shot-7', number: '007'}, {id: 'shot-8', number: '008'}], mediaUrl: '/api/synthetic-preview/candidate-a'}, {id: 'candidate-b', name: '另一个候选.mp4', reason: '同名视频', adoptedShots: [], mediaUrl: '/api/synthetic-preview/candidate-b'}]}),
      item('copying', 'copying', {copiedBytes: 2048}), item('unknown', 'unknown', {code: 'RECEIPT_UNKNOWN', error: '原回执仍待核对'}), item('failed', 'failed', {error: '合成可重试失败'}), item('retained', 'source_retained', {videoId: 'video-retained'}), item('global-managed', 'managed', {assetId: 'asset-global'}), item('project-managed', 'managed', {managedProjectId: 'original-project', managedProjectName: '原合成项目', videoId: 'original-video'}),
    ]}, {id: 'batch-other', projectId: projectB, projectName: '合成乙项目', folderId: 'root', folderName: '根目录', mode: 'copy', createdAt: 2, updatedAt: 2, status: 'completed', items: [item('ready', 'ready', {videoId: 'ready-video'})]}],
    confirm: 'accept', resolve: 'normal', retry: 'normal', confirmBodies: [], resolveBodies: [], retryCount: 0, reconcileCount: 0, installCount: 0,
  };
}
function backendPreferences() {
  return Object.fromEntries(Object.entries(fixture.preferences).filter(([, d]) => d.scope === 'library' || fixture.handoff.projects.some(p => p.id === d.projectId)));
}
function rememberTargets(targets) {
  // Model the backend's convenience snapshot only after an accepted confirmation.
  for (const {destination: d} of targets) fixture.preferences[d.kind] = d.scope === 'library'
    ? {kind: d.kind, scope: 'library', directory: d.directory || ''}
    : {kind: d.kind, scope: 'project', projectId: d.projectId, ...(d.kind === 'video' ? {folderId: d.folderId || 'root'} : {})};
}
function destinationLabel(d) {
  return d.scope === 'project' ? fixture.handoff.projects.find(p => p.id === d.projectId).name + ' / ' + (fixture.folders[d.projectId]?.find(f => f.id === d.folderId)?.relativePath || '项目根目录')
    : ({photo: '摄影照片', video: '视频素材', music: '音乐', sfx: '音效'}[d.kind] + ' / ' + (d.directory || '待确认'));
}
function validateConfirm(body) {
  assert.deepEqual(Object.keys(body).sort(), ['version', 'requestId', 'mode', 'fileIds', 'targets'].sort());
  assert.equal(body.version, 2); assert.match(body.requestId, /^[a-f0-9-]{36}$/); assert.ok(['copy', 'move'].includes(body.mode));
  assert.ok(body.fileIds.length); assert.equal(new Set(body.fileIds).size, body.fileIds.length);
  assert.deepEqual(body.targets.map(t => t.fileId), body.fileIds);
  for (const t of body.targets) {
    assert.deepEqual(Object.keys(t).sort(), ['destination', 'fileId']);
    const file = fixture.handoff.files.find(f => f.id === t.fileId), d = t.destination;
    assert.ok(file); assert.ok((file.mediaKind === 'audio' ? ['music', 'sfx'] : [file.mediaKind]).includes(d.kind));
    if (d.scope === 'library') {
      assert.deepEqual(Object.keys(d).sort(), ['kind', 'scope', 'directory', ...(d.fileName ? ['fileName'] : [])].sort());
      assert.ok(fixture.categories[d.kind].some(f => f.id === d.directory));
    } else {
      assert.equal(d.scope, 'project'); assert.ok(fixture.handoff.projects.some(p => p.id === d.projectId));
      assert.deepEqual(Object.keys(d).sort(), ['kind', 'scope', 'projectId', ...(d.kind === 'video' ? ['folderId'] : ['imageProposal']), ...(d.fileName ? ['fileName'] : [])].sort());
      if (d.kind === 'video') assert.ok(fixture.folders[d.projectId].some(f => f.id === d.folderId));
    }
  }
}
async function routeApi(route) {
  const req = route.request(), url = new URL(req.url()), method = req.method(), body = req.postData() ? req.postDataJSON() : undefined;
  requests.push({path: url.pathname, method, body});
  const respond = (value, status = 200) => route.fulfill({status, json: clone(value)});
  if (url.pathname === '/api/session') return respond({app: 'shiguang-local-media', instanceId: fixture.libraryId, token: 'synthetic-token'});
  if (!url.pathname.startsWith('/api/file-intake/')) return respond({error: 'Unexpected synthetic test endpoint'}, 404);
  if (method === 'POST') assert.equal(req.headers()['x-local-token'], 'synthetic-token');
  const endpoint = url.pathname.slice('/api/file-intake'.length);
  if (endpoint === '/status') {if (fixture.firstCompletionAfterMount) {fixture.firstCompletionAfterMount = false; await pause(30); fixture.status.latestCompletion.updatedAt = Date.now();} return respond(fixture.status);}
  if (endpoint === '/install') {fixture.installCount++; fixture.status.installed = true; return respond({installed: true, message: '已安装合成入口，首次请到系统设置启用。'});}
  if (endpoint === '/preferences') {assert.equal(method, 'GET'); return respond({targets: backendPreferences()});}
  if (endpoint === '/handoffs/' + handoffId) return respond({...fixture.handoff, preferences: backendPreferences()});
  const category = endpoint.match(/^\/categories\/(photo|video|music|sfx)$/);
  if (category) {assert.equal(method, 'GET'); return respond({folders: fixture.categories[category[1]]});}
  if (/^\/projects\/[^/]+\/folders$/.test(endpoint)) {
    const project = endpoint.split('/')[2]; assert.ok(fixture.folders[project]);
    await pause(project === projectA ? 350 : 20);
    return respond({folders: fixture.folders[project]});
  }
  if (endpoint === '/handoffs/' + handoffId + '/confirm') {
    validateConfirm(body);
    fixture.confirmBodies.push(body); await pause(100);
    if (fixture.confirm === 'reject') return respond({error: '合成：目标需要重新选择', code: 'INVALID_TARGET', accepted: false, requestId: body.requestId}, 422);
    if (fixture.handoff.batchId) return respond({error: '这次选择已由原窗口接收，请查看原批次', code: 'INTAKE_ALREADY_ACCEPTED'}, 409);
    const items = body.fileIds.map(id => {const destination = clone(body.targets.find(t => t.fileId === id).destination); return {...fixture.handoff.files.find(f => f.id === id), destination, destinationLabel: destinationLabel(destination), copiedBytes: 0, status: 'queued'};});
    const labels = [...new Set(items.map(i => i.destinationLabel))], projects = [...new Set(items.map(i => i.destination.projectId || ''))];
    const batch = {version: 2, id: body.requestId, projectId: projects.length === 1 ? projects[0] : '', projectName: labels.length === 1 ? labels[0] : '多种素材收纳', folderId: '', folderName: labels.length > 1 ? labels.length + ' 个固定目标' : '', mode: body.mode, createdAt: 3, updatedAt: 3, status: 'queued', items};
    if (fixture.confirmReceipt === 'wrong-id') batch.id = '22222222-2222-4222-8222-222222222222';
    if (fixture.confirmReceipt === 'wrong-items') batch.items = batch.items.slice(0, 1);
    if (fixture.confirmReceipt === 'reverse-items') batch.items.reverse();
    if (fixture.confirmReceipt === 'wrong-destination') batch.items[0].destination = projectTarget(projectB, folderB);
    if (fixture.confirmReceipt === 'swapped-destinations') [batch.items[0].destination, batch.items[1].destination] = [batch.items[1].destination, batch.items[0].destination];
    if (fixture.confirmReceipt === 'wrong-mode') batch.mode = body.mode === 'copy' ? 'move' : 'copy';
    if (fixture.confirmReceipt === 'legacy-version') {delete batch.version; batch.projectId = projectA; batch.folderId = 'root';}
    if (fixture.confirmReceipt === 'duplicate-items') batch.items[1] = clone(batch.items[0]);
    rememberTargets(body.targets);
    fixture.handoff.batchId = batch.id; fixture.batches.unshift(batch);
    if (fixture.confirm === 'lost') return route.abort('failed'); return respond(batch);
  }
  if (endpoint === '/batches') {await pause(40); return respond({batches: fixture.batches});}
  const match = endpoint.match(/^\/batches\/([^/]+)(.*)$/), batch = fixture.batches.find(b => b.id === match?.[1]);
  if (match && batch) {
    const suffix = match[2];
    if (!suffix) return respond(batch);
    if (suffix === '/acknowledge') {assert.equal(body.resultKey,batch.resultKey);batch.acknowledged=body.acknowledged;fixture.status.needsAttention=body.acknowledged?0:4;return respond(batch);}
    if (suffix === '/reconcile') {fixture.reconcileCount++; const failed = batch.items.find(i => i.id === 'failed'); if (fixture.retry === 'lost' && failed) failed.status = 'copying'; return respond(batch);}
    const operation = suffix.match(/^\/items\/([^/]+)\/(resolve|retry)$/), item = batch.items.find(i => i.id === operation?.[1]);
    if (operation && item) {
      if (operation[2] === 'retry') {assert.equal(item.status, 'failed'); fixture.retryCount++; if (fixture.retry === 'lost') return route.abort('failed'); item.status = 'copying'; return respond(batch);}
      fixture.resolveBodies.push(body);
      if (fixture.resolve === 'lost') return route.abort('failed');
      if (body.choice === 'overwrite') {
        assert.equal(body.confirmUnbind, true); assert.equal(body.applyRemaining, undefined);
        if (fixture.resolve === 'adoption-race') {fixture.resolve = 'normal'; item.adoptionStamp = 'stamp-v2'; item.candidates[0].adoptedShots = [{id: 'shot-9', number: '009'}]; return respond({error: '采用关系已变化，请重新确认镜号', code: 'ADOPTION_CHANGED'}, 409);}
        assert.equal(body.adoptionStamp, item.adoptionStamp);
      }
      item.status = body.choice === 'cancel' ? 'cancelled' : 'ready'; item.videoId = 'resolved-video'; return respond(batch);
    }
  }
  return respond({error: 'Unexpected fixture route ' + endpoint}, 404);
}
async function fresh(window = false, initialCompletion = null, firstCompletionAfterMount = false, layout = false, configure = () => {}) {
  await context?.close(); fixture = setup(); fixture.status.latestCompletion = initialCompletion; fixture.firstCompletionAfterMount = firstCompletionAfterMount;
  configure(fixture);
  context = await browser.newContext({viewport: {width: 1000, height: 780}});
  context.setDefaultTimeout(5000);
  await context.addInitScript(() => {window.nativeAccepted = []; window.views = []; window.webkit = {messageHandlers: {intake: {postMessage: value => window.nativeAccepted.push(value)}}};});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol.startsWith('http') && url.origin !== origin) {external.push(url.href); return route.abort();}
    try {return await (url.pathname.startsWith('/api/') ? routeApi(route) : route.continue());}
    catch (error) {errors.push('Synthetic route ' + url.pathname + ': ' + error.message); await route.abort().catch(() => {});}
  });
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + (window ? '/#intake' : layout || selectedCase === 'drawer-layout' ? '/#drawer-layout' : '/'));
}
const drawer = () => page.getByRole('dialog', {name: '文件任务', exact: true});
const item = id => drawer().locator('.fi-item').filter({has: page.getByText(id + '.mp4', {exact: true})});
async function open() {await page.getByRole('button', {name: /^文件任务/}).click(); await expect(drawer()).toBeVisible(); await expect(drawer().getByLabel('选择文件收纳批次')).toHaveValue('batch-existing');}
const targetField = (label, id, targetPage = page) => targetPage.getByLabel(label + ' ' + id, {exact: true});
async function choose(ids = ['f1', 'f2'], project = projectA, folder = 'root') {
  for (const id of ids) {
    await targetField('收纳范围', id).selectOption('project');
    await targetField('目标项目', id).selectOption(project);
    await expect(targetField('目标分类', id)).toBeEnabled();
    await expect(targetField('目标分类', id)).toHaveValue('root');
    if (folder !== 'root') await targetField('目标分类', id).selectOption(folder);
  }
}
const targetFor = (body, id) => body.targets.find(t => t.fileId === id)?.destination;
async function check(name, fn) {if (selectedCase !== 'all' && !name.startsWith(selectedCase + ' ')) return; phase = name; await fn(); checks.push(name); console.log('PASS ' + name);}
try {
  await fs.writeFile(path.join(temp, 'index.html'), '<html><div id="root"></div><script type="module" src="/fixture.tsx"></script></html>');
  await fs.writeFile(path.join(temp, 'fixture.tsx'), `import React from 'react';import{createRoot}from'react-dom/client';import{FileIntakeWindow,FileTaskEntry}from${JSON.stringify(path.join(root, 'src/file-intake/index.ts'))};import{GlobalFeedback}from${JSON.stringify(path.join(root, 'src/global-feedback.tsx'))};
import ${JSON.stringify(path.join(root, 'src/style.css'))};import ${JSON.stringify(path.join(root, 'src/themes.css'))};import ${JSON.stringify(path.join(root, 'src/library-workspace.css'))};
const request=async(url,body,method,options)=>{const response=await fetch('/api'+url,{method:method||(body===undefined?'GET':'POST'),headers:{'content-type':'application/json','x-local-token':'synthetic-token'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:options?.signal});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error),{...value,status:response.status});return value;};
const entry=<FileTaskEntry request={request} onView={(project,id)=>{window.views.push([project,id]);}}/>;
createRoot(document.getElementById('root')).render(location.hash==='#intake'?<FileIntakeWindow handoffId="${handoffId}"/>:location.hash==='#drawer-layout'?<><div className="app library-workspace"><aside className="sidebar">合成侧栏</aside><main><header className="topbar library-topbar"><div className="breadcrumb">合成页面</div><div className="topbar-actions">{entry}</div></header><section style={{height:1500,padding:30}}><button id="background-action">底层页面操作</button><h1>合成视频页面</h1></section></main></div><GlobalFeedback/></>:<>{entry}<GlobalFeedback/></>);`);
  server = await createServer({configFile: false, root: temp, envDir: temp, cacheDir: path.join(temp, '.vite'), esbuild: {jsx: 'automatic'}, resolve: {alias: {react: path.join(root, 'node_modules/react'), 'react-dom': path.join(root, 'node_modules/react-dom'), 'lucide-react': path.join(root, 'node_modules/lucide-react')}}, server: {host: '127.0.0.1', port: 0, hmr: false, fs: {allow: [root, temp]}}, logLevel: 'error'});
  await server.listen(); origin = server.resolvedUrls.local[0].replace(/\/$/, ''); port = new URL(origin).port;
  browser = await chromium.launch({headless: true, executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  await check('acknowledgement clears old failure badge, preserves history and can restore without retry',async()=>{
    const start = requests.length; await fresh();const batch=fixture.batches[0];batch.status='partial';batch.canAcknowledge=true;batch.resultKey='current-result';
    batch.items=[1,2,3,4].map(n=>({id:'old-'+n,name:'old-'+n+'.mp4',bytes:4096,copiedBytes:0,status:'failed',code:'INTAKE_SOURCE_CHANGED',error:'合成旧选择失败'}));fixture.batches=[batch];fixture.status.needsAttention=4;fixture.status.activeCount=0;await page.reload();
    await expect(page.getByRole('button',{name:/^文件任务/})).toContainText('4 待处理');await open();
    await drawer().getByRole('button',{name:'标记已处理',exact:true}).click();
    await expect(page.getByRole('button',{name:/^文件任务/})).not.toContainText('待处理');await expect(drawer().locator('.fi-item')).toHaveCount(0);
    await drawer().getByRole('button',{name:'已处理',exact:true}).click();await expect(drawer().locator('.fi-item')).toHaveCount(4);
    await expect(drawer().locator('.fi-item .fi-error')).toHaveCount(0);await expect(drawer().locator('.fi-item').first()).toContainText('INTAKE_SOURCE_CHANGED');
    await page.screenshot({path:path.join(evidence,'acknowledged-history.png')});
    await drawer().getByRole('button',{name:'恢复待处理',exact:true}).click();await expect(page.getByRole('button',{name:/^文件任务/})).toContainText('4 待处理');
    await drawer().getByRole('button',{name:'最近任务',exact:true}).click();await expect(drawer().locator('.fi-item')).toHaveCount(4);
    assert.equal(fixture.retryCount,0);assert.equal(fixture.resolveBodies.length,0);assert.ok(batch.items.every(i=>i.status==='failed'));
    const posts=requests.slice(start).filter(r=>r.method==='POST');assert.equal(posts.length,2);assert.ok(posts.every(r=>r.path.endsWith('/acknowledge')));
  });
  await check('retry-guidance source-change failures require reselection while ordinary failed items remain retryable',async()=>{
    await fresh();fixture.batches[0].items.find(i=>i.id==='failed').code='INTAKE_SOURCE_CHANGED';
    fixture.batches[0].items.push({id:'recoverable',name:'recoverable.mp4',bytes:4096,copiedBytes:0,status:'failed',code:'TRANSIENT_IO_ERROR'});
    await open();await expect(item('failed').getByText('需要重新选择',{exact:true})).toBeVisible();
    await expect(item('failed').getByRole('button',{name:'重试此失败项',exact:true})).toHaveCount(0);
    await expect(drawer().getByText(/部分文件需要从访达重新选择/)).toBeVisible();
    await item('recoverable').getByRole('button',{name:'重试此失败项',exact:true}).click();
    await expect(item('recoverable')).toContainText('正在复制');assert.equal(fixture.retryCount,1);
    assert.equal(fixture.batches[0].items.find(i=>i.id==='failed').status,'failed');
  });
  await check('drawer-layout actual topbar backdrop and app styles keep viewport drawer, scroll and install reachable', async () => {
    const start = requests.length; await fresh(false, null, false, true); await page.setViewportSize({width: 1440, height: 900}); await open();
    const geometry = await drawer().evaluate(el => {const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,viewport:innerHeight,insideTopbar:!!el.closest('.topbar'),background:getComputedStyle(el).backgroundColor};});
    await fs.writeFile(path.join(evidence, 'drawer-layout-geometry.json'), JSON.stringify(geometry,null,2));
    await page.screenshot({path:path.join(evidence, 'drawer-layout-wide.png')});
    assert.ok(Math.abs(geometry.y) <= 1 && Math.abs(geometry.height - geometry.viewport) <= 1, 'drawer must fill the viewport rather than its backdrop-filtered topbar');
    assert.equal(geometry.insideTopbar,false); assert.notEqual(geometry.background,'rgba(0, 0, 0, 0)');
    const install = drawer().getByRole('button',{name:'安装访达入口',exact:true});
    await install.scrollIntoViewIfNeeded(); await expect(install).toBeInViewport();
    assert.ok(await drawer().locator('.fi-drawer-body').evaluate(el=>el.scrollHeight>el.clientHeight && el.scrollTop>0));
    await page.keyboard.press('Escape'); await expect(drawer()).toHaveCount(0); await expect(page.getByRole('button',{name:/^文件任务/})).toBeFocused();
    await open(); await drawer().getByRole('button',{name:'关闭文件任务',exact:true}).click(); await expect(drawer()).toHaveCount(0);
    const matrix=[];
    for (const theme of ['forest','dark','midnight','sepia','graphite','ocean']) for (const width of [1440,1280,420]) {
      await page.setViewportSize({width,height:900}); await page.evaluate(value=>document.documentElement.dataset.theme=value,theme); await open();
      const box=await drawer().boundingBox(); assert.ok(box && Math.abs(box.y)<=1 && Math.abs(box.height-900)<=1 && box.x>=0 && box.x+box.width<=width+1);
      await install.scrollIntoViewIfNeeded(); await expect(install).toBeInViewport();
      const coverage=await install.evaluate(el=>{const r=el.getBoundingClientRect();const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return !!top && (top===el || el.contains(top));});
      assert.equal(coverage,true,'install button must receive pointer events above the background page');
      if (width===1440 || (width===420 && theme==='midnight')) await page.screenshot({path:path.join(evidence,`drawer-layout-${theme}-${width}.png`)});
      matrix.push({theme,width,...box,installReachable:true}); await page.keyboard.press('Escape'); await expect(drawer()).toHaveCount(0);
    }
    await fs.writeFile(path.join(evidence,'drawer-layout-matrix.json'),JSON.stringify(matrix,null,2));
    fixture.batches=[]; await page.setViewportSize({width:1440,height:900}); await page.getByRole('button',{name:/^文件任务/}).click();
    await expect(drawer().getByRole('heading',{name:'暂无文件任务',exact:true})).toBeVisible(); await expect(install).toBeInViewport();
    await page.screenshot({path:path.join(evidence,'drawer-layout-empty.png')});
    await page.keyboard.press('Escape'); await expect(drawer()).toHaveCount(0);
    assert.equal(fixture.installCount,0); assert.equal(requests.slice(start).filter(r=>r.method==='POST').length,0);
  });
  await check('drawer real copy bytes, fixed targets, retry gates and managed project/global routing', async () => {
    await fresh(); await open(); await expect(drawer().getByText('成片/第一段 · 校验并登记成功后移入废纸篓', {exact: true})).toBeVisible(); await expect(drawer().getByRole('progressbar', {name: '复制进度 copying.mp4'})).toHaveAttribute('value', '2048'); await expect(drawer().getByRole('button', {name: '重试此失败项', exact: true})).toHaveCount(1); await expect(item('retained')).toContainText('原文件未移除');
    await item('global-managed').getByRole('button', {name: '查看已有素材', exact: true}).click(); assert.deepEqual(await page.evaluate(() => window.views), [['', 'asset-global']]); await open(); await item('project-managed').getByRole('button', {name: '查看 / 移动已有文件', exact: true}).click(); assert.deepEqual(await page.evaluate(() => window.views), [['', 'asset-global'], ['original-project', 'original-video']]);
  });
  await check('overwrite requires exact shots and new adoptionStamp after 409; overwrite never applies remaining', async () => {
    await fresh(); fixture.resolve = 'adoption-race'; await open(); const conflict = item('conflict'); await conflict.getByRole('button', {name: '覆盖…', exact: true}).click(); await expect(conflict.getByRole('region', {name: '覆盖影响确认 conflict.mp4'})).toContainText('镜 007、镜 008'); await expect(conflict.getByRole('button', {name: '确认覆盖', exact: true})).toBeDisabled(); assert.equal(fixture.resolveBodies.length, 0);
    await conflict.getByRole('checkbox', {name: /我已核对/}).check(); await conflict.getByRole('button', {name: '确认覆盖', exact: true}).click(); await expect(drawer().locator(':scope > .fi-drawer-body > .fi-error')).toContainText('ADOPTION_CHANGED'); await conflict.getByRole('button', {name: '覆盖…', exact: true}).click(); await expect(conflict.getByRole('region', {name: '覆盖影响确认 conflict.mp4'})).toContainText('镜 009'); await expect(conflict.getByRole('button', {name: '确认覆盖', exact: true})).toBeDisabled(); await conflict.getByRole('checkbox', {name: /我已核对/}).check(); await conflict.getByRole('button', {name: '确认覆盖', exact: true}).click(); await expect(conflict).toContainText('已收纳'); assert.equal(fixture.resolveBodies.length, 2); assert.equal(fixture.resolveBodies[1].adoptionStamp, 'stamp-v2'); assert.equal(fixture.resolveBodies[1].confirmUnbind, true); assert.equal(fixture.resolveBodies[1].applyRemaining, undefined);
  });
  await check('import/reuse allow applyRemaining; failed retry lost response stays locked until original receipt reconciles', async () => {
    await fresh(); await open(); await item('conflict').getByRole('checkbox', {name: /应用到后续重名项/}).check(); await item('conflict').getByRole('button', {name: '改名导入', exact: true}).click(); await expect(item('conflict')).toContainText('已收纳'); assert.deepEqual(fixture.resolveBodies[0], {choice: 'import', applyRemaining: true});
    fixture.retry = 'lost'; await item('failed').getByRole('button', {name: '重试此失败项', exact: true}).click(); await expect(drawer()).toContainText('操作响应未确认'); await pause(1200); assert.equal(fixture.retryCount, 1); await expect(item('failed').getByRole('button', {name: '重试此失败项', exact: true})).toBeDisabled(); await drawer().getByRole('button', {name: '核对原回执', exact: true}).click(); await expect(item('failed')).toContainText('正在复制'); assert.equal(fixture.retryCount, 1); assert.equal(fixture.reconcileCount, 1);
    await fresh(); await open(); await item('conflict').getByRole('checkbox', {name: /应用到后续重名项/}).check(); await item('conflict').getByRole('button', {name: '复用已有文件', exact: true}).click(); await expect(item('conflict')).toContainText('已收纳'); assert.deepEqual(fixture.resolveBodies[0], {choice: 'reuse', candidateId: 'candidate-a', applyRemaining: true});
  });
  await check('lost resolve cannot be replayed by polling/reconcile; item error stays visible and conflict can cancel explicitly', async () => {
    await fresh(); fixture.resolve = 'lost'; await open(); await item('conflict').getByRole('button', {name: '改名导入', exact: true}).click(); await expect(drawer()).toContainText('操作响应未确认'); await pause(1200); await expect(item('conflict').getByRole('button', {name: '改名导入', exact: true})).toBeDisabled(); await drawer().getByRole('button', {name: '核对原回执', exact: true}).click(); await expect(item('conflict').getByRole('button', {name: '改名导入', exact: true})).toBeDisabled(); assert.equal(fixture.resolveBodies.length, 1);
    await fresh(); await open(); await item('conflict').getByRole('button', {name: '取消此项', exact: true}).click(); await expect(item('conflict')).toContainText('已取消'); assert.deepEqual(fixture.resolveBodies[0], {choice: 'cancel'});
  });
  await check('drawer polling only when open/visible; unsupported install disabled; explicit install and responsive tokens', async () => {
    await fresh(); fixture.status.supported = false; await page.reload(); await open(); await expect(drawer().getByRole('button', {name: '安装访达入口', exact: true})).toBeDisabled(); assert.equal(fixture.installCount, 0);
    const count = () => requests.filter(r => r.path === '/api/file-intake/batches').length, before = count(); await expect.poll(count).toBeGreaterThan(before); await drawer().getByRole('button', {name: '关闭文件任务', exact: true}).click(); await pause(100); const closed = count(); await pause(1200); assert.equal(count(), closed);
    fixture.status.supported = true; await page.reload(); await open(); await drawer().getByRole('button', {name: '安装访达入口', exact: true}).click(); await expect(drawer().getByText('已安装合成入口，首次请到系统设置启用。', {exact: true})).toBeVisible(); assert.equal(fixture.installCount, 1);
    await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange'));}); await pause(100); const hidden = requests.length; await pause(1300); assert.equal(requests.length, hidden); await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); document.dispatchEvent(new Event('visibilitychange'));}); await expect.poll(() => requests.length).toBeGreaterThan(hidden);
    await page.setViewportSize({width: 420, height: 780}); await page.screenshot({path: path.join(evidence, 'drawer-narrow.png')}); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.evaluate(() => document.documentElement.dataset.theme = 'midnight'); await page.screenshot({path: path.join(evidence, 'drawer-theme.png')});
  });
  await check('completion status notifies closed drawer only for changed post-mount keys; initial/history/same-key suppressed and partial counts warn', async () => {
    const start = requests.length;
    await fresh(false, {id: 'initial-completion', updatedAt: 1, projectName: '首次已有记录', status: 'completed', completed: 2, failed: 0, retained: 0}, true);
    await expect(page.locator('.fi-count')).toHaveText('2'); await expect(page.locator('.global-feedback-card')).toHaveCount(0); await expect(page.getByRole('button', {name: /^文件任务/})).toHaveAttribute('aria-expanded', 'false');
    const readStatus = async () => {
      const before = requests.filter(r => r.path === '/api/file-intake/status').length;
      await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable: true, get: () => true}); document.dispatchEvent(new Event('visibilitychange'));}); await pause(50);
      await page.evaluate(() => {Object.defineProperty(document, 'hidden', {configurable: true, get: () => false}); document.dispatchEvent(new Event('visibilitychange'));});
      await expect.poll(() => requests.filter(r => r.path === '/api/file-intake/status').length).toBeGreaterThan(before); await pause(100);
    };
    fixture.status.latestCompletion = {id: 'late-old-completion', updatedAt: Date.now() - 60000, projectName: '迟到旧历史', status: 'completed', completed: 1, failed: 0, retained: 0};
    await readStatus(); await expect(page.locator('.global-feedback-card')).toHaveCount(0);
    fixture.status.latestCompletion = {id: 'new-completion', updatedAt: Date.now(), projectName: '后台合成项目', status: 'completed', completed: 2, failed: 0, retained: 0};
    await readStatus(); const success = page.locator('.global-feedback-card[data-feedback-kind="success"]'); await expect(success).toContainText('素材已收纳到后台合成项目'); await expect(success).toHaveCount(1);
    await readStatus(); await expect(success).toHaveCount(1); await expect(success).not.toContainText('相同提示');
    fixture.status.latestCompletion = {...fixture.status.latestCompletion, updatedAt: Date.now() + 1, status: 'partial', completed: 4, failed: 2, retained: 1};
    await readStatus(); const warning = page.locator('.global-feedback-card[data-feedback-kind="warning"]'); await expect(warning).toContainText('已收纳 4，失败 2，原件保留 1'); await expect(warning).toHaveCount(1);
    await readStatus(); await expect(warning).toHaveCount(1); await expect(warning).not.toContainText('相同提示');
    assert.equal(requests.slice(start).filter(r => r.path === '/api/file-intake/batches').length, 0); assert.equal(requests.slice(start).filter(r => r.method === 'POST').length, 0); await expect(drawer()).toHaveCount(0);
  });
  assert.ok(checks.length, 'selected group must execute at least one check');
  assert.deepEqual(errors, []); assert.deepEqual(external, []); passed = true;
} catch (error) {
  console.error('FAIL ' + phase + ': ' + error.message);
  await fs.writeFile(path.join(evidence, 'failure.txt'), error.stack || String(error));
  await fs.writeFile(path.join(evidence, 'failure-fixture.json'), JSON.stringify(fixture, null, 2));
  if (page) {
    await fs.writeFile(path.join(evidence, 'failure.html'), await page.content().catch(() => 'Page unavailable'));
    await page.screenshot({path: path.join(evidence, 'failure.png')}).catch(() => {});
  }
  process.exitCode = 1;
}
finally {
  await context?.close(); await browser?.close(); await server?.close();
  const resources = {browserClosed: !browser?.isConnected(), viteClosed: !server?.httpServer?.listening};
  if (port) {const probe = net.connect({host: '127.0.0.1', port: Number(port)}); resources.portClosed = await new Promise(resolve => {probe.once('connect', () => {probe.end(); resolve(false);}); probe.once('error', () => resolve(true));});}
  const sourcesAtEnd = await sourceHashes(), sourcesStable = JSON.stringify(sourcesAtStart) === JSON.stringify(sourcesAtEnd);
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({passed: passed && sourcesStable, selectedCase, phase, checks, errors, external, requests, resources, sourcesAtStart, sourcesAtEnd, sourcesStable, fixtureRoot: temp, scope: 'Component-only exact-contract synthetic responses. No App/backend/native/MySQL/account/model/media access.'}, null, 2) + '\n');
  assert.ok(sourcesStable, 'component sources must remain unchanged during the check');
  assert.ok(resources.browserClosed && resources.viteClosed && resources.portClosed, 'owned resources close normally');
}
