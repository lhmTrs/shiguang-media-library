// Isolated real React/browser checks. HTTP responses are explicit controlled fixtures,
// distinct from fingerprint01's actual backend/SQLite route evidence. RETAIN_ALL.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const evidence = path.resolve(process.argv[2] || path.join(repo, 'collab/results/OFFLINE-REPAIR-02A-20261026/browser'));
await fs.mkdir(evidence, { recursive: true });
const temp = await fs.mkdtemp(path.join(path.dirname(evidence), 'ui-fixture-'));
await fs.writeFile(path.join(evidence, 'registration.json'), JSON.stringify({ directory: temp, setup: true, policy: 'RETAIN_ALL', after: 'only close known browser/Vite/HTTP handles; no tree scans or removal' }, null, 2));
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const assets = Array.from({ length: 51 }, (_, i) => ({ id: id(i + 1), name: `素材${i + 1}`, online: i === 1 ? 1 : 0, file_status: i === 1 ? 'online' : 'missing' }));
const roots = [{ id: id(101), name: '目标目录', online: 1 }, { id: id(102), name: '离线目录', online: 0 }, { id: id(103), name: '已退管', online: 1, retired: 1 }];
const checks = [], calls = [], errors = [];
let server, browser, page, startReply, getReply, cancelReply, taskNumber = 200, aborted = 0;
let hostState, registerReply, restorePreviewReply, confirmRestoreReply, resolveRestoreReply, getRestoreReply, recoverRestoreReply, historyReply;
const releases = new Set();
const operation = (phase = 'COMPLETE', extra = {}) => ({operationId:id(taskNumber+5000),assetId:id(1),phase,version:1,complete:phase==='COMPLETE',needsRecovery:['PREPARED','DB_COMMITTED','MIRROR_PENDING'].includes(phase),inFlight:false,targetRootId:id(101),targetRelativePath:'音乐/确认候选.wav',...extra});
const task = (status = 'queued', extra = {}) => ({ id: id(taskNumber), taskId: id(taskNumber), mode: 'preview', status, checked: 0, saved: 0, bytesRead: 0, remainingSelected: null, selectionTruncated: false, resultTruncated: false, searchComplete: false, items: [], issues: [], candidates: [], ...extra });
function gate() { let release; const promise = new Promise(r => release = r); releases.add(release); return { promise, release: () => { releases.delete(release); release(); } }; }
const count = method => calls.filter(c => c.method === method).length;
const pause = ms => new Promise(r => setTimeout(r, ms));
// Reuse the exact production entry handlers and JSX, rather than a handwritten copy.
const main = await fs.readFile(path.join(repo, 'src/main.tsx'), 'utf8');
const ast = ts.createSourceFile('main.tsx', main, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let icon, actions, repairState, batchEntry, dialogEntry, restoredHandler;
function visit(n) {
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'IconButton') icon = n.getText(ast);
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'assetActions') actions = n.getText(ast);
  if (ts.isFunctionDeclaration(n) && n.name?.text === 'restoredAsset') restoredHandler = n.getText(ast);
  if (ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isArrayBindingPattern(d.name) && d.name.elements.some(e => e.name?.getText(ast) === 'repairIds'))) repairState = n.getText(ast);
  if (ts.isJsxExpression(n) && n.expression) {
    const text = n.expression.getText(ast);
    if (text.startsWith('(view ===') && text.includes('setRepairIds([...checked])')) batchEntry = text;
    if (text.startsWith('repairIds && <OfflineRepairDialog')) dialogEntry = text;
  }
  ts.forEachChild(n, visit);
}
visit(ast);
if (![icon, actions, repairState, batchEntry, dialogEntry, restoredHandler].every(Boolean)) throw Error('Production repair entry extraction failed');
await fs.writeFile(path.join(evidence, 'entry-source.json'), JSON.stringify({ source: 'src/main.tsx', sha256: crypto.createHash('sha256').update(main).digest('hex'), extraction: 'TypeScript AST; actual IconButton, assetActions, repair state, batch and dialog JSX; unrelated App startup excluded' }, null, 2));
try {
  await fs.writeFile(path.join(temp, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  await fs.writeFile(path.join(temp, 'main.tsx'), `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{Search,FilePenLine,Trash2}from'lucide-react';
import{OfflineRepairDialog}from${JSON.stringify(path.join(repo, 'src/OfflineRepairDialog.tsx'))};
import${JSON.stringify(path.join(repo, 'src/style.css'))};import${JSON.stringify(path.join(repo, 'src/themes.css'))};
const allAssets=${JSON.stringify(assets)},roots=${JSON.stringify(roots)};
const params=new URLSearchParams(location.search), total=Number(params.get('count')||'1');
const events=window.restoreEvents={refreshes:0,gets:[],errors:[]};
const api=async(url,body,method)=>{if(url.startsWith('/assets/'))events.gets.push(url.slice('/assets/'.length));const r=await fetch('/api'+url,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json','X-Local-Token':'isolated-fixture'},body:body?JSON.stringify(body):undefined});const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error||'FIXTURE_ERROR'),{code:v.code||v.error,status:r.status});return v;};
${icon}
function Fixture(){
 const [assets,setAssets]=useState(allAssets.slice(0,total)),view=params.get('view')||'offline',folderView=true;
 const [selected,setSelected]=useState(assets[0]),[editRevision,setEditRevision]=useState(0),[draft,setDraft]=useState('未保存草稿');
 const refreshRef={current:async()=>{events.refreshes++;setAssets(before=>before.filter(a=>a.id!==events.gets.at(-1)));}},fail=e=>events.errors.push(String(e));
 const busy=params.has('busy'),fileChecking=params.has('checking');const[checked,setChecked]=useState(new Set(assets.map(a=>a.id)));
 const setCategoryAsset=()=>{},setCleanupIds=()=>{};
 ${repairState}
 ${actions}
 ${restoredHandler}
 return <><div style={{padding:16}}><h1>离线修复隔离测试</h1><input aria-label="未保存备注" value={draft} onChange={e=>setDraft(e.target.value)}/><p>受控API替身；不连接作者服务。</p>{assets.slice(0,1).map(a=><div key={a.id}>{assetActions(a)}</div>)}{${batchEntry}}<button onClick={()=>setRepairIds(assets.map(a=>a.id))}>测试打开弹窗</button><button onClick={()=>setRepairIds(null)}>测试卸载弹窗</button></div>{params.has('direct')?repairIds&&<OfflineRepairDialog ids={repairIds} assets={assets} roots={roots} request={api} close={()=>setRepairIds(null)} restored={id=>{void restoredAsset(id).catch(fail);}} pollMs={100}/>:(${dialogEntry})}</>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
  server = await createServer({ configFile: false, root: temp, envDir: temp, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, fs: { allow: [repo] } }, logLevel: 'error' });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', r => { if (r.url().includes('/api/asset-fingerprints/') || r.url().includes('/api/asset-repairs/')) aborted++; });
  await page.route('**/api/**', async route => {
    const req = route.request(), method = req.method(), pathname = new URL(req.url()).pathname;
    const call = { method, pathname, body: req.postDataJSON() }; calls.push(call);
    try {
      let response;
      if(method==='GET'&&pathname==='/api/cloud-upload-host/readiness')response=hostState;
      else if(method==='POST'&&pathname==='/api/cloud-upload-host/register')response=await registerReply(call);
      else if(method==='POST'&&pathname==='/api/asset-repairs/preview')response=await restorePreviewReply(call);
      else if(method==='POST'&&pathname==='/api/asset-repairs/confirm')response=await confirmRestoreReply(call);
      else if(method==='POST'&&pathname==='/api/asset-repairs/resolve')response=await resolveRestoreReply(call);
      else if(method==='POST'&&pathname==='/api/asset-repairs/history')response=await historyReply(call);
      else if(method==='POST'&&pathname.startsWith('/api/asset-repairs/')&&pathname.endsWith('/recover'))response=await recoverRestoreReply(call);
      else if(method==='GET'&&pathname.startsWith('/api/asset-repairs/'))response=await getRestoreReply(call);
      else if(method==='GET'&&pathname.startsWith('/api/assets/'))response={...assets[0],name:'已恢复素材',note:'服务器原备注',tags:[],path:'fixture-relative',online:1,file_status:'online'};
      else if (method === 'POST' && pathname === '/api/asset-fingerprints') response = await startReply(call);
      else if (method === 'POST' && pathname.endsWith('/cancel')) response = await cancelReply(call);
      else if (method === 'GET' && /^\/api\/asset-fingerprints\/[a-f0-9-]+$/.test(pathname)) response = await getReply(call);
      else throw Error('Unexpected API route');
      await route.fulfill({ status: response.http || 200, contentType: 'application/json', body: JSON.stringify(response.body || response) });
    } catch (e) { if (!/closed|disposed|canceled|cancelled|Invalid Interception/i.test(String(e))) errors.push(String(e)); }
  });
  const button = () => page.getByRole('button', { name: '尝试修复', exact: true });
  const close = () => page.getByRole('button', { name: '关闭尝试修复', exact: true }).click();
  const choose = () => page.getByRole('checkbox', { name: '搜索目录：目标目录', exact: true }).check();
  const status = () => page.getByRole('status');
  async function fresh(query = '?direct=1') {
    for (const release of releases) release(); releases.clear();
    await page.goto(url + query); await page.evaluate(() => sessionStorage.clear()); await page.reload();
    calls.length = 0; taskNumber++;
    startReply = () => task(); getReply = () => task('running'); cancelReply = () => task('cancelling');
    hostState={ready:false,phase:'NOT_REGISTERED',version:0,code:'STORE_NOT_REGISTERED',canRegister:true};
    registerReply=()=>hostState={ready:true,phase:'READY',version:2,code:'STORE_READY'};
    restorePreviewReply=()=>hostState.ready?{previewId:id(taskNumber+4000),assetId:id(1),targetRootId:id(101),targetRelativePath:'音乐/确认候选.wav',expiresAt:Date.now()+300000,confirmationRequired:true,contentMatch:true,physicalIdentityProven:false}:{http:409,body:{code:'UPLOAD_STATE_UNKNOWN'}};
    confirmRestoreReply=()=>operation();resolveRestoreReply=()=>({found:true,operation:operation('MIRROR_PENDING')});getRestoreReply=()=>operation('MIRROR_PENDING');recoverRestoreReply=()=>operation();historyReply=()=>({items:[],nextCursor:null,complete:true});
    await page.getByRole('button', { name: '测试打开弹窗', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  }
  await fresh(); await pause(250); expect(calls).toEqual([]);
  await expect(button()).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '搜索目录：离线目录' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '搜索目录：已退管' })).toHaveCount(0);
  await choose(); await expect(button()).toBeEnabled(); checks.push('mount idle, explicit root required, offline/retired roots unavailable');
  const startGate = gate(); startReply = async () => { await startGate.promise; return task(); };
  await button().evaluate(b => { b.click(); b.click(); });
  await expect.poll(() => count('POST')).toBe(1);
  expect(calls[0].body).toEqual({ mode: 'preview', assetIds: [id(1)], rootIds: [id(101)] });
  startGate.release(); await expect(status()).toContainText('等待开始');
  await expect(status()).toContainText('正在检查');
  const cancelGate = gate(); cancelReply = async () => { await cancelGate.promise; return task('cancelling'); };
  await page.getByRole('button', { name: '请求停止任务', exact: true }).click();
  await expect(status()).not.toContainText('任务已取消');
  cancelGate.release(); await expect(status()).toContainText('等待任务实际停止');
  getReply = () => task('cancelling'); await pause(200); await expect(status()).toContainText('等待任务实际停止');
  getReply = () => task('cancelled'); await expect(status()).toContainText('任务已取消');
  const terminalCount = count('GET'); await pause(300); expect(count('GET')).toBe(terminalCount);
  checks.push('one POST on double start; exact preview payload; cancellation waits actual terminal; terminal stops polling');

  await fresh('?direct=1&count=4'); await choose();
  getReply = () => task('done', { searchComplete: false, checked: 2, bytesRead: 40, remainingSelected: 0, issues: [{ assetId: id(3), code: 'NO_TRUSTED_FINGERPRINT' }, { assetId: id(4), code: 'ORIGINAL_PRESENT' }, { assetId: null, code: 'BYTE_BUDGET' }], candidates: ['候选甲.wav', '候选乙.wav'].map((name, i) => ({ sourceAssetId: id(1), targetRootId: id(101), targetRelativePath: '音乐/' + name, targetAssetId: i ? id(350) : null, sha256: 'a'.repeat(64), contentMatch: true, ambiguous: true, physicalIdentityProven: false, uniqueness: 'not_asserted' })) });
  await button().click(); await expect(page.getByText('目标目录 / 音乐/候选甲.wav')).toBeVisible();
  await expect(page.getByText('目标目录 / 音乐/候选乙.wav')).toBeVisible();
  await expect(page.getByText('已有素材记录，待确认合并；尚未执行。', { exact: false })).toBeVisible();
  await expect(page.getByText('没有可信的移动前指纹', { exact: false })).toBeVisible();
  await expect(page.getByText('原路径仍有文件', { exact: false })).toBeVisible();
  await expect(page.getByText('本次范围未完整覆盖', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /确认合并|确认恢复|应用修复/ })).toHaveCount(0);
  await page.screenshot({ path: path.join(evidence, 'repair-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.getByRole('dialog').evaluate(el => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: el.clientWidth, scroll: el.scrollWidth, height: el.getBoundingClientRect().height }));
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390); expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1); expect(bounds.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: path.join(evidence, 'repair-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 850 }); checks.push('all ambiguous candidates/no hash/original present/incomplete/existing target, no fake merge, desktop/mobile bounded layout');

  await fresh(); await choose(); getReply = () => ({ http: 503, body: { error: '/Users/private-do-not-display' } });
  await button().click(); await expect(page.getByRole('alert')).toContainText('查询失败');
  const errorCount = count('GET'); await pause(300); expect(count('GET')).toBe(errorCount); expect(count('POST')).toBe(1);
  expect(await page.getByRole('dialog').innerText()).not.toContain('/Users/private-do-not-display');
  getReply = () => task('done', { searchComplete: true }); await page.getByRole('button', { name: '重新查询任务' }).click(); await expect(status()).toContainText('任务结束');
  checks.push('query error halts GET, does not repeat POST, redacts error paths, explicit query recovery');

  await fresh(); await choose(); const getGate = gate(); getReply = async () => { await getGate.promise; return task('running'); };
  await button().click(); await expect.poll(() => count('GET')).toBe(1);
  await close(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => aborted).toBeGreaterThan(0); const closeCount = calls.length;
  await pause(300); expect(calls.length).toBe(closeCount); expect(calls.some(c => c.pathname.endsWith('/cancel'))).toBe(false);
  getGate.release();
  await page.getByRole('button', { name: '测试打开弹窗', exact: true }).click(); await expect(page.getByRole('button', { name: '查询上次任务' })).toBeVisible();
  await pause(220); expect(calls.length).toBe(closeCount);
  getReply = () => ({ http: 400, body: { error: 'TASK_NOT_FOUND' } });
  await page.getByRole('button', { name: '查询上次任务' }).click(); await expect(page.getByRole('alert')).toContainText('服务可能已重启');
  expect(count('POST')).toBe(1); checks.push('close aborts GET and timers without cancel, reopen explicit query only, lost task has no automatic restart');

  await fresh(); await choose(); const delayedStart = gate(); const oldId = id(taskNumber);
  startReply = async () => { await delayedStart.promise; return task('done', { id: oldId, taskId: oldId, searchComplete: true }); };
  await button().click(); await expect.poll(() => count('POST')).toBe(1); await close();
  await page.getByRole('button', { name: '测试打开弹窗', exact: true }).click();
  await expect(page.getByText('上次启动结果未确认', { exact: false })).toBeVisible(); delayedStart.release();
  await expect(status()).toHaveCount(0); await page.getByRole('button', { name: '核对后刷新任务记录' }).click();
  await expect(page.getByRole('button', { name: '查询上次任务' })).toBeVisible();
  getReply = () => task('done', { id: oldId, taskId: oldId, searchComplete: true });
  await page.getByRole('button', { name: '查询上次任务' }).click(); await expect(status()).toContainText('任务结束');
  taskNumber++; startReply = () => task('done', { searchComplete: true }); await choose(); await button().click();
  await expect(status()).toContainText('任务结束'); expect(count('POST')).toBe(2);
  checks.push('late start after close cannot mutate reopened UI, saved task recoverable explicitly; new task isolated by ID/generation');

  await fresh('?direct=1&count=2'); await page.getByText('需要预先建立文件指纹？', { exact: true }).click();
  const hashButton = page.getByRole('button', { name: '建立所选在线素材指纹' }); await expect(hashButton).toBeDisabled();
  await page.getByRole('checkbox', { name: '确认仅为所选 1 条显示在线的素材建立内容指纹' }).check();
  startReply = () => task('done', { mode: 'fingerprint', saved: 1, searchComplete: true });
  await hashButton.click(); await expect(status()).toContainText('任务结束');
  expect(calls[0].body).toEqual({ mode: 'fingerprint', assetIds: [id(2)] }); checks.push('fingerprint requires explicit consent, only online IDs, no target-root/source confusion');
  await fresh(); await page.getByText('需要预先建立文件指纹？', { exact: true }).click(); await expect(hashButton).toBeDisabled(); expect(count('POST')).toBe(0);

  await fresh('?direct=1&count=51'); await choose(); await expect(button()).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('不会自动截取');
  await page.getByRole('checkbox', { name: '选择旧素材：素材51', exact: true }).uncheck();
  startReply = () => task('done', { searchComplete: true }); await button().click(); expect(calls[0].body.assetIds).toHaveLength(50); checks.push('51 IDs blocked, explicit deselection to 50, no silent truncation');

  await fresh(); await choose(); getReply = () => task('done', { candidates: [{ sourceAssetId: id(1), targetRootId: id(101), targetRelativePath: '/Users/private-file.wav', targetAssetId: null, contentMatch: true, ambiguous: false, physicalIdentityProven: false, uniqueness: 'not_asserted' }] });
  await button().click(); await expect(page.getByRole('alert')).toContainText('查询失败'); expect(await page.getByRole('dialog').innerText()).not.toContain('/Users/private-file.wav'); checks.push('invalid absolute candidate path rejected before render');

  await fresh(); await choose();
  startReply = () => ({ http: 503, body: { error: 'START_UNKNOWN' } });
  await button().click(); await expect(page.getByRole('alert')).toContainText('启动结果未确认');
  await expect(button()).toBeDisabled(); await pause(220); expect(count('POST')).toBe(1); expect(count('GET')).toBe(0);
  checks.push('unknown start result blocks duplicate start and automatic retry');

  await fresh(); await choose();
  cancelReply = () => ({ http: 503, body: { error: 'CANCEL_UNKNOWN' } });
  await button().click(); await expect(status()).toContainText('正在检查');
  await page.getByRole('button', { name: '请求停止任务', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('不能据此认定任务已停止');
  const beforeFailurePoll = count('GET'); await expect.poll(() => count('GET')).toBeGreaterThan(beforeFailurePoll);
  getReply = () => task('done', { searchComplete: true }); await expect(status()).toContainText('任务结束');
  checks.push('cancel transport failure never claims cancelled and progress query continues');

  await fresh(); await choose(); const staleCancel = gate(); const staleId = id(taskNumber);
  cancelReply = async () => { await staleCancel.promise; return task('cancelled', { id: staleId, taskId: staleId }); };
  await button().click(); await expect(status()).toContainText('正在检查');
  await page.getByRole('button', { name: '请求停止任务', exact: true }).click();
  await expect.poll(() => calls.filter(c => c.pathname.endsWith('/cancel')).length).toBe(1);
  await close(); getReply = () => task('done', { id: staleId, taskId: staleId, searchComplete: true });
  await page.getByRole('button', { name: '测试打开弹窗', exact: true }).click();
  await page.getByRole('button', { name: '查询上次任务' }).click(); await expect(status()).toContainText('任务结束');
  taskNumber++; startReply = () => task('done', { searchComplete: true });
  await choose(); await button().click(); await expect(status()).toContainText('任务结束');
  staleCancel.release(); await pause(220); await expect(status()).toContainText('任务结束'); await expect(status()).not.toContainText('已取消');
  checks.push('late cancel from old instance cannot overwrite a new task');

  await fresh(); await choose(); getReply = () => task('done', { id: id(999), taskId: id(999), searchComplete: true });
  await button().click(); await expect(page.getByRole('alert')).toContainText('查询失败'); await expect(status()).not.toContainText('任务结束');
  checks.push('mismatched task ID rejected without replacing current task');

  const restoreView=()=>page.getByRole('region',{name:'实际恢复状态'});
  async function prepareRestore(){
    await choose();getReply=()=>task('done',{searchComplete:true,remainingSelected:0,candidates:[{sourceAssetId:id(1),targetRootId:id(101),targetRelativePath:'音乐/确认候选.wav',targetAssetId:null,contentMatch:true,ambiguous:false,physicalIdentityProven:false,uniqueness:'not_asserted'}]});
    await button().click();await expect(page.getByRole('button',{name:'核对恢复位置：音乐/确认候选.wav'})).toBeVisible();
    await page.getByRole('button',{name:'核对恢复环境',exact:true}).click();await expect(page.getByRole('button',{name:'核验并登记本库上传存储'})).toBeVisible();
    await page.getByRole('button',{name:'核验并登记本库上传存储'}).click();await expect(page.getByText('已登记实际上传存储',{exact:false})).toBeVisible();
    await page.getByRole('button',{name:'核对恢复位置：音乐/确认候选.wav'}).click();await expect(page.getByRole('button',{name:'确认恢复原 ID'})).toBeVisible();
  }
  await fresh();await prepareRestore();expect(calls.filter(c=>c.pathname==='/api/asset-repairs/confirm')).toHaveLength(0);
  await page.getByRole('button',{name:'确认恢复原 ID'}).evaluate(b=>{b.click();b.click();});await expect(restoreView().getByRole('status')).toContainText('已重新关联');
  expect(calls.filter(c=>c.pathname==='/api/asset-repairs/confirm')).toHaveLength(1);expect(calls.find(c=>c.pathname==='/api/cloud-upload-host/register').body.assetIds).toEqual([id(1)]);
  await expect.poll(()=>page.evaluate(()=>window.restoreEvents.refreshes)).toBe(1);await expect(page.getByRole('textbox',{name:'未保存备注'})).toHaveValue('未保存草稿');
  await page.screenshot({path:path.join(evidence,'restore-confirm-desktop.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'restore-confirm-mobile.png')});expect(await page.getByRole('dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1)).toBe(true);await page.setViewportSize({width:1280,height:850});checks.push('explicit actual-store registration then separate preview/confirm, duplicate click one command, COMPLETE-only callback and unsaved draft preserved');

  await fresh();await prepareRestore();confirmRestoreReply=()=>({http:503,body:{code:'RESULT_UNKNOWN'}});await page.getByRole('button',{name:'确认恢复原 ID'}).click();await expect(page.getByRole('alert')).toContainText('结果尚未确认');
  await expect(page.getByRole('button',{name:'核对恢复位置：音乐/确认候选.wav'})).toBeDisabled();const unknownCommand=calls.find(c=>c.pathname==='/api/asset-repairs/confirm').body;await close();const beforeReopen=calls.length;await page.getByRole('button',{name:'测试打开弹窗',exact:true}).click();await pause(200);expect(calls.length).toBe(beforeReopen);
  await page.getByRole('button',{name:'核对上次确认结果'}).click();await expect(restoreView().getByRole('status')).toContainText('镜像待恢复');expect(calls.find(c=>c.pathname==='/api/asset-repairs/resolve').body).toEqual({assetId:id(1),...unknownCommand});expect(calls.filter(c=>c.pathname.endsWith('/recover'))).toHaveLength(0);expect(await page.evaluate(()=>JSON.parse(Object.entries(sessionStorage).find(([key])=>key.startsWith('offline-restore-intent:'))[1]).operationId)).toBe(operation().operationId);
  await page.getByRole('button',{name:'补齐恢复镜像'}).click();await expect(restoreView().getByRole('status')).toContainText('已重新关联');expect(calls.filter(c=>c.pathname==='/api/asset-repairs/confirm')).toHaveLength(1);checks.push('lost confirm response survives close/reopen, resolves same original command, mirror recovery only explicit');

  await fresh();await prepareRestore();confirmRestoreReply=()=>operation('PREPARED');recoverRestoreReply=()=>operation('ABORTED');await page.getByRole('button',{name:'确认恢复原 ID'}).click();await expect(restoreView().getByRole('status')).toContainText('尚未提交');await page.getByRole('button',{name:'核对并中止未提交操作'}).click();await expect(restoreView().getByRole('status')).toContainText('已中止');expect(await page.evaluate(()=>window.restoreEvents.refreshes)).toBe(0);checks.push('PREPARED recover is abort and ABORTED never reports restoration');

  await fresh();await prepareRestore();confirmRestoreReply=()=>operation('PREPARED');getRestoreReply=()=>operation('COMPLETE',{operationId:id(9999)});await page.getByRole('button',{name:'确认恢复原 ID'}).click();await expect(restoreView().getByRole('status')).toContainText('尚未提交');await page.getByRole('button',{name:'查询当前恢复状态'}).click();await expect(page.getByRole('alert')).toContainText('结果尚未确认');await expect(restoreView().getByRole('status')).toContainText('尚未提交');expect(await page.evaluate(()=>window.restoreEvents.refreshes)).toBe(0);checks.push('mismatched restore operation response cannot claim COMPLETE or release original pending intent');

  await fresh();await page.getByRole('button',{name:'核对恢复环境',exact:true}).click();registerReply=()=>({ready:false,phase:'INIT_PENDING',version:1,code:'CONTROLLED_FAILURE'});await page.getByRole('button',{name:'核验并登记本库上传存储'}).click();await expect(page.getByText('登记未全部完成',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'核验并登记本库上传存储'})).toHaveCount(0);await pause(200);expect(calls.filter(c=>c.pathname==='/api/cloud-upload-host/register')).toHaveLength(1);checks.push('registration INIT_PENDING has no automatic overwrite or new initialization');

  await fresh();const cursor={createdMs:42,operationId:id(800)};historyReply=call=>call.body.after?{items:[operation('ABORTED',{operationId:id(821)})],nextCursor:null,complete:true}:{items:Array.from({length:20},(_,i)=>operation('ABORTED',{operationId:id(800+i)})),nextCursor:cursor,complete:false};
  await page.getByRole('button',{name:'核对恢复记录'}).click();await expect(page.getByRole('button',{name:'更多恢复记录'})).toBeVisible();await page.getByRole('button',{name:'更多恢复记录'}).click();expect(calls.filter(c=>c.pathname==='/api/asset-repairs/history')[1].body.after).toEqual(cursor);await expect(page.getByRole('button',{name:'查看恢复操作：'+id(821)})).toBeVisible();checks.push('history uses explicit stable cursor and continues beyond first page');

  await fresh();await prepareRestore();confirmRestoreReply=()=>operation('PREPARED',{inFlight:true});const heldRepair=gate();getRestoreReply=async()=>{await heldRepair.promise;return operation('MIRROR_PENDING');};await page.getByRole('button',{name:'确认恢复原 ID'}).click();await expect.poll(()=>calls.filter(c=>c.method==='GET'&&c.pathname.startsWith('/api/asset-repairs/')).length).toBe(1);await close();const afterClose=calls.length;heldRepair.release();await pause(250);expect(calls.length).toBe(afterClose);expect(calls.filter(c=>c.pathname.endsWith('/recover'))).toHaveLength(0);checks.push('active restore GET aborts/stops on close without claiming cancel or recovery');

  // Exact production main entry fragments are mounted here, not an imitation button.
  await page.goto(url + '?count=1&view=offline'); await page.evaluate(() => sessionStorage.clear());
  calls.length = 0; taskNumber++; startReply = () => task('done', { searchComplete: true });
  await page.getByRole('button', { name: '尝试修复：素材1', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); expect(calls).toEqual([]);
  await choose(); await button().click(); await expect(status()).toContainText('任务结束'); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '尝试修复：素材1', exact: true })).toBeFocused();
  await page.goto(url + '?count=2&view=missing'); await page.evaluate(() => sessionStorage.clear());
  await page.getByRole('button', { name: '尝试修复所选', exact: true }).click(); await expect(page.getByText('旧素材：已选 2 条（最多 50 条）')).toBeVisible(); await close();
  await page.goto(url + '?count=51&view=offline'); await expect(page.getByRole('button', { name: '尝试修复所选', exact: true })).toBeDisabled();
  await page.goto(url + '?count=1&view=missing&checking=1'); await expect(page.getByRole('button', { name: '尝试修复：素材1', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '尝试修复所选', exact: true })).toBeDisabled();
  checks.push('exact main single/batch handlers mount real dialog, missing/offline scope, 50 limit/checking guard, Escape focus restoration');
  expect(errors).toEqual([]);
  await fs.writeFile(path.join(evidence, 'results.json'), JSON.stringify({ passed: true, checks, pageErrors: errors, calls, aborted, API: 'controlled browser HTTP fixture; not real backend integration', productionEntries: 'AST-extracted exact main handlers/JSX; full App startup not run' }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: checks.length, details: checks }));
} catch (e) {
  await fs.writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ error: String(e), checks, calls, pageErrors: errors }, null, 2));
  await page?.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  throw e;
} finally {
  for (const release of releases) release();
  await browser?.close(); await server?.close();
}
