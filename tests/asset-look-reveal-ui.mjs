import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar, showPublicAssets } from './helpers/path-bar.mjs';

const root = path.resolve(process.env.CREATIVE_TEST_PROJECT_ROOT || path.resolve(import.meta.dirname, '..')), evidence = path.resolve(process.env.CREATIVE_TEST_EVIDENCE || 'collab/results/ASSET-LOOK-REVEAL-20261104/browser');
await fs.mkdir(evidence, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-ui-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw7kj7DwAENAIhJ+yrnwAAAABJRU5ErkJggg==', 'base64');
for (let i = 1; i <= 3; i++) await fs.writeFile(path.join(images, '合成图片' + i + '.png'), png);
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false, closed = false; const checks = [], errors = [], external = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_READONLY_FILES: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_PERSONAL_ITEM_DIR:path.join(temp,'personal'), CODEX_HOME:path.join(temp,'no-codex'), PATH:path.join(temp,'no-tools') }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const dialog = () => page.getByRole('dialog');
async function create(name) { await work().getByRole('button', { name: /^新建/ }).first().click(); await dialog().getByLabel('新资产名称').fill(name); await dialog().getByRole('button', { name: '创建并编辑' }).click(); await expect(work().getByRole('heading', { name, exact: true })).toBeVisible(); }
async function save() { await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled(); await expect(work().locator('.ca-alert')).toHaveCount(0); }
async function bind(index = 0) { await work().getByRole('button', { name: '从素材库绑定图片', exact: true }).click(); await expect(dialog().locator('.ca-media-picker button')).toHaveCount(3); await dialog().locator('.ca-media-picker button').nth(index).click(); await expect(dialog()).toHaveCount(0); }
const buttons=()=>work().locator('.ca-reveal-image');
try{
 await expect.poll(()=>logs,{timeout:25000}).toContain(origin);const sessionResponse=await fetch(origin+'/api/session'),session=await sessionResponse.json();cookie=sessionResponse.headers.get('set-cookie').split(';')[0];token=session.token;
 const a=await api('/projects',{name:'定位合成项目'});await api('/roots',{path:images,kind:'photo'});await expect.poll(async()=>(await api('/jobs')).jobs.every(j=>j.status!=='running'),{timeout:20000}).toBe(true);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext({viewport:{width:1480,height:1000}});const dist=path.join(root,'collab/results/ASSET-LOOK-REVEAL-20261104/dist'),calls=[];let mode='success',release,arrived;
 await context.route(origin+'/**',async route=>{const u=new URL(route.request().url());if(/^\/api\/assets\/[^/]+\/reveal$/.test(u.pathname)){calls.push({path:u.pathname,method:route.request().method(),body:route.request().postData()});if(mode==='delay'){arrived();await new Promise(r=>release=r);}return route.fulfill({status:mode==='failure'?409:200,contentType:'application/json',body:JSON.stringify(mode==='failure'?{error:'图片缺失或目录离线，无法定位'}:{ok:true})});}if(u.pathname==='/')return route.fulfill({path:path.join(dist,'index.html')});if(u.pathname.startsWith('/assets/'))return route.fulfill({path:path.join(dist,u.pathname.slice(1))});return route.continue();});
 await context.addInitScript(()=>localStorage.setItem('shiguang.refreshSeconds','0'));context.on('request',r=>{const u=new URL(r.url());if(u.protocol.startsWith('http')&&u.origin!==origin)external.push(u.origin+u.pathname);});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#/project-assets');await expect(work()).toBeVisible();await selectProjectInBar(page, a.id);await create('定位人物');await work().getByRole('button',{name:'造型与图片',exact:true}).click();await work().getByRole('button',{name:'新增造型',exact:true}).click();await bind(0);await bind(1);await save();let record=(await api('/project-assets/assets?project_id='+a.id)).items[0];record=await api('/project-assets/assets/'+record.id);
 await check('Each image sends its own media ID and POST to existing reveal route; not representative/creative IDs',async()=>{
  await expect(buttons()).toHaveCount(2);for(let i=0;i<2;i++){await buttons().nth(i).click();await expect(buttons().nth(i)).toBeEnabled();assert.equal(calls[i].path,'/api/assets/'+record.images[i].media_asset_id+'/reveal');assert.equal(calls[i].method,'POST');assert.notEqual(record.images[i].media_asset_id,record.id);assert.notEqual(record.images[i].media_asset_id,record.images[i].id);}assert.notEqual(calls[0].path,calls[1].path);
 });
 await check('Revealing does not save/discard unsaved text, reorder images or change representative',async()=>{
  await work().getByRole('button',{name:'资料概览',exact:true}).click();await work().getByLabel('基础信息',{exact:true}).fill('仍未保存的文字');await work().getByRole('button',{name:'造型与图片',exact:true}).click();await buttons().first().click();await expect(buttons().first()).toBeEnabled();await expect(work().getByRole('button',{name:'保存资料',exact:true})).toBeEnabled();assert.deepEqual(await api('/project-assets/assets/'+record.id),record);await work().getByRole('button',{name:'资料概览',exact:true}).click();await expect(work().getByLabel('基础信息',{exact:true})).toHaveValue('仍未保存的文字');await work().getByRole('button',{name:'造型与图片',exact:true}).click();
 });
 await check('Per-image pending state prevents repeat clicks and keeps other image available',async()=>{
  mode='delay';const ready=new Promise(r=>arrived=r);const before=calls.length;await buttons().first().click();await ready;await expect(buttons().first()).toBeDisabled();await expect(buttons().first()).toContainText('正在定位');await expect(buttons().nth(1)).toBeEnabled();assert.equal(calls.length,before+1);release();await expect(buttons().first()).toBeEnabled();mode='success';
 });
 await check('Visible reveal failure preserves draft and retry is available',async()=>{
  mode='failure';await buttons().nth(1).click();await expect(work().locator('.ca-alert')).toContainText('图片缺失或目录离线');await expect(buttons().nth(1)).toBeEnabled();await expect(work().getByRole('button',{name:'保存资料',exact:true})).toBeEnabled();assert.deepEqual(await api('/project-assets/assets/'+record.id),record);mode='success';await buttons().nth(1).click();await expect(work().locator('.ca-alert')).toHaveCount(0);
 });
 await check('Archived asset still allows reveal without restoring or mutating project data',async()=>{
  await save();record=await api('/project-assets/assets/'+record.id);await work().getByRole('button',{name:'归档',exact:true}).click();await expect(work().getByRole('button',{name:'恢复',exact:true})).toBeVisible();await work().getByRole('button',{name:'造型与图片',exact:true}).click();const before=await api('/project-assets/assets/'+record.id);await buttons().first().click();await expect(buttons().first()).toBeEnabled();assert.deepEqual(await api('/project-assets/assets/'+record.id),before);
 });
 await check('Public character reveals same registered media; 390px button visible and clickable',async()=>{
  const scopes=await api('/project-assets/scopes'),pub=scopes.items.find(p=>p.project_kind==='public');await showPublicAssets(page);await create('公共定位人物');await work().getByRole('button',{name:'造型与图片',exact:true}).click();await work().getByRole('button',{name:'新增造型',exact:true}).click();await bind(1);await save();const publicAsset=(await api('/project-assets/assets?project_id='+pub.id)).items[0];await page.setViewportSize({width:390,height:900});await buttons().first().scrollIntoViewIfNeeded();await buttons().first().click();await expect(buttons().first()).toBeEnabled();assert.equal(calls.at(-1).path,'/api/assets/'+publicAsset.images[0].media_asset_id+'/reveal');const rect=await buttons().first().boundingBox();assert.ok(rect.x>=0&&rect.x+rect.width<=390);await page.screenshot({path:path.join(evidence,'reveal-390.png'),fullPage:false});
 });
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await fs.writeFile(path.join(evidence,'reveal-requests.json'),JSON.stringify(calls,null,2)+'\n');passed=true;
}catch(e){console.error(e);if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:false}).catch(()=>{});throw e;}
finally{if(browser)await browser.close();child.kill('SIGTERM');let timer;const exit=await Promise.race([exited,new Promise(r=>timer=setTimeout(()=>r('timeout'),10000))]);clearTimeout(timer);if(exit==='timeout'){child.kill('SIGKILL');await exited;}await fs.writeFile(path.join(evidence,'server.log'),logs);await fs.rm(temp,{recursive:true,force:true});await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,external,exit,temporaryRemoved:!await fs.stat(temp).then(()=>true,()=>false),nativeWindow:'NOT_RUN; reveal HTTP stubbed; separate lib opener injected'},null,2)+'\n');}
