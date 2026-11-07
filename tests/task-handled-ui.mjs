// Real App/Drawer/task HTTP APIs, fresh owned SQLite and synthetic media only.
// Controlled API responses are limited to identity-race/UNKNOWN probes and are labeled below.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {chromium,expect} from '@playwright/test';
import {PromptTemplates} from '../server/prompt-templates/store.mjs';
import {CodexStore} from '../server/prompt-codex/store.mjs';
import {taskSummary} from '../server/prompt-codex/tasks.mjs';
import {fixture,inputs} from './helpers/prompt-lifecycle.mjs';
const root=path.resolve(import.meta.dirname,'..'),evidence=path.resolve(root,'../browser'),dist=path.resolve(root,'../dist');
await fs.mkdir(evidence,{recursive:true});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'handled-ui-')),dataDir=path.join(temp,'data');
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin='http://127.0.0.1:'+port;
let child,exited,logs='',allLogs='',browser,page,context,db,store,prompts,passed=false,cookie='',token='',libraryId,storageKey;
const checks=[],errors=[],external=[],businessWrites=[],exits=[];
async function start(){logs='';child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(temp,'personal'),CODEX_HOME:path.join(temp,'codex-home'),MEDIA_CODEX_BIN:path.join(temp,'missing-codex'),SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(temp,'missing-release.json'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'1',SHIGUANG_AUDIO_ANALYSIS:'0',PATH:path.join(temp,'no-tools')},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs+=b;allLogs+=b;});exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));await expect.poll(()=>logs,{timeout:25000}).toContain(origin);const res=await fetch(origin+'/api/session'),session=await res.json();cookie=res.headers.get('set-cookie').split(';')[0];token=session.token;return session.instanceId;}
async function stop(){if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');let timer;try{const value=await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('own server failed to close')),15000))]);assert.match(logs,/APPLICATION_CLOSED_KNOWN/);exits.push({...value,known:true});}finally{clearTimeout(timer);}}
async function api(p){const res=await fetch(origin+'/api'+p,{headers:{cookie,origin,'x-local-token':token}});const value=await res.json();assert.ok(res.ok,p);return value;}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
const drawer=()=>page.getByRole('complementary',{name:'Codex 全局任务'}),card=id=>drawer().locator('[data-task-id="'+id+'"]');
async function show(tab){if(!await drawer().isVisible())await page.locator('.codex-tasks-entry').click();await expect(drawer()).toBeVisible();if(tab)await drawer().getByRole('button',{name:tab,exact:true}).click();}
async function refresh(){await drawer().getByRole('button',{name:'重新读取',exact:true}).click();await expect(drawer().getByRole('button',{name:'重新读取',exact:true})).toBeEnabled();}
function seed(title,status='failed',blocks=[],errorCode='SYNTHETIC_FAILURE'){
 const template=prompts.list().items[0],c=store.create({id:randomUUID(),template_id:template.id,template_revision:template.revision,values:inputs});
 db.prepare('UPDATE codex_conversations SET title=? WHERE id=?').run(title,c.id);
 const t=store.begin(c.id,{id:randomUUID(),expected_revision:c.revision,model:'synthetic-text',effort:'low',output:'mixed'}).turn;
 if(status!=='queued')store.updateTurn(t.id,{blocks,status,errorCode});return{taskId:t.id,conversationId:c.id};
}
function revise(id,{error='SECOND_FAILURE',blocks,revision=true}={}){const t=store.getTurn(id),actual={...t.actual,_taskSummary:taskSummary({blocks:blocks??t.blocks,actual:t.actual,request:t.request})};db.prepare('UPDATE codex_turns SET error_code=?,updated_at=?,blocks_json=?,actual_json=? WHERE id=?').run(error,revision?t.updated_at+1:t.updated_at,JSON.stringify(blocks??t.blocks),JSON.stringify(actual),id);}
async function reload(){await page.reload();await expect(page.locator('.codex-tasks-entry')).toBeVisible();await show();await expect(drawer().getByText('正在读取任务…')).toHaveCount(0);}
async function setupBrowser(state){
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});context=await browser.newContext({viewport:{width:1480,height:1000},...(state?{storageState:state}:{})});
 await context.route(origin+'/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({path:path.join(dist,'index.html')});if(u.pathname.startsWith('/assets/')){const file=path.resolve(dist,'.'+decodeURIComponent(u.pathname));assert.ok(file.startsWith(dist+path.sep));return route.fulfill({path:file});}return route.continue();});
 await context.addInitScript(()=>{if(location.protocol==='http:')localStorage.setItem('shiguang.refreshSeconds','0');});
 context.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&u.origin!==origin)external.push(u.origin+u.pathname);if(u.pathname.startsWith('/api/prompt-codex/')&&r.method()!=='GET')businessWrites.push(r.method()+' '+u.pathname);});
 page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#/projects');
}
try{
 libraryId=await start();storageKey='shiguang.codex.handled.v1.'+libraryId;
 db=new Database(path.join(dataDir,'library.sqlite'));db.pragma('busy_timeout=5000');const lib={db,dataDir,jobs:new Map()};prompts=new PromptTemplates(lib).init();prompts.create(fixture());store=new CodexStore(lib,prompts).init();
 const fail=seed('合成失败任务'),imageId=randomUUID(),bytes=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
 const imageBlocks=[{type:'text',text:'合成结果保留'},{type:'image',itemId:'owned-image',status:'ready',attachmentId:imageId,library:{status:'failed',error:'合成入库失败'}}];
 const image=seed('合成图片问题','completed',imageBlocks,''),interrupted=seed('合成中断任务','interrupted',[],'CODEX_CLOSE_UNSETTLED');
 store.addAttachment({id:imageId,turn_id:image.taskId,file_name:imageId+'.gif',sha256:createHash('sha256').update(bytes).digest('hex'),mime:'image/gif',bytes:bytes.length,created_at:Date.now(),updated_at:Date.now()});await fs.writeFile(path.join(dataDir,'prompt-codex/images',imageId+'.gif'),bytes,{mode:0o600});
 const initialOverview=await api('/prompt-codex/tasks');assert.equal(initialOverview.items.length,3);
 await setupBrowser();
 await check('Real initial attention tab and unread; opening original turn reads without handling',async()=>{
  await show();await expect(drawer().getByRole('button',{name:'待处理',exact:true})).toHaveAttribute('aria-pressed','true');await expect(card(fail.taskId)).toBeVisible();
  await card(fail.taskId).getByRole('button',{name:'查看此轮',exact:true}).click();await expect(page.locator('[data-turn-id="'+fail.taskId+'"]')).toBeVisible();await expect(drawer()).toBeHidden();
  await show('待处理');await expect(card(fail.taskId).getByRole('button',{name:'移至已结束'})).toBeVisible();assert.equal(await page.evaluate(k=>localStorage.getItem(k),storageKey),null);
 });
 await check('Explicit handling immediately moves; ended preserves failure and original image/round/reason',async()=>{
  await card(fail.taskId).getByRole('button',{name:'移至已结束'}).click();await expect(card(fail.taskId)).toHaveCount(0);await show('已结束');await expect(card(fail.taskId)).toContainText('生成失败');await expect(card(fail.taskId)).toContainText('SYNTHETIC_FAILURE');
  await show('待处理');await card(image.taskId).getByRole('button',{name:'移至已结束'}).click();await show('已结束');await expect(card(image.taskId)).toContainText('原图保留');await expect(card(image.taskId)).toContainText('入库失败');await card(image.taskId).getByRole('button',{name:'查看原图及入库问题'}).click();await expect(page.locator('[data-turn-id="'+image.taskId+'"]')).toBeVisible();await expect(page.getByRole('region',{name:'Codex 图文对话'})).toContainText('合成入库失败');
  const res=await fetch(origin+'/api/prompt-codex/images/'+imageId,{headers:{cookie}});assert.equal(res.status,200);assert.deepEqual(Buffer.from(await res.arrayBuffer()),bytes);
  const raw=await page.evaluate(k=>localStorage.getItem(k),storageKey);assert.ok(raw);for(const forbidden of ['合成','SYNTHETIC_TEXT','/api','token',imageId+'.gif'])assert.ok(!raw.includes(forbidden));
 });
 await check('Reload and observedAt-only refresh preserve preference; ordinary own-server restart changes ephemeral instance only',async()=>{
  await reload();await show('待处理');await expect(card(fail.taskId)).toHaveCount(0);await refresh();await expect(card(fail.taskId)).toHaveCount(0);
  const savedState=await context.storageState();await browser.close();browser=null;await stop();assert.equal(await start(),libraryId);const next=await api('/prompt-codex/tasks');assert.notEqual(next.instanceId,initialOverview.instanceId);
  await setupBrowser(savedState);await show('已结束');await expect(card(fail.taskId)).toContainText('SYNTHETIC_FAILURE');await expect(card(image.taskId)).toContainText('入库失败');
 });
 await check('Same task new revision/error and image problem resurface; a new taskId is independently pending',async()=>{
  revise(fail.taskId);await refresh();await show('待处理');await expect(card(fail.taskId)).toContainText('SECOND_FAILURE');await expect(card(fail.taskId).getByRole('button',{name:'移至已结束'})).toBeVisible();await card(fail.taskId).getByRole('button',{name:'移至已结束'}).click();
  revise(image.taskId,{error:'',blocks:[...imageBlocks,{type:'image',itemId:'new-failure',status:'failed'}],revision:false});await refresh();await expect(card(image.taskId)).toContainText('图片接收失败');await card(image.taskId).getByRole('button',{name:'移至已结束'}).click();
  const next=seed('合成新一轮');await refresh();await expect(card(next.taskId)).toBeVisible();
 });
 await check('Same-origin tab storage event synchronizes explicit handling; simultaneous writers preserve both records',async()=>{
  const second=await context.newPage();second.setDefaultTimeout(8000);await second.goto(origin+'/#/projects');await second.locator('.codex-tasks-entry').click();const d=second.getByRole('complementary',{name:'Codex 全局任务'});await d.getByRole('button',{name:'待处理',exact:true}).click();const target=d.locator('[data-task-id="'+interrupted.taskId+'"]');await expect(target).toBeVisible();
  await show('待处理');await card(interrupted.taskId).getByRole('button',{name:'移至已结束'}).click();await expect(target).toHaveCount(0);await d.getByRole('button',{name:'已结束',exact:true}).click();await expect(d.locator('[data-task-id="'+interrupted.taskId+'"]')).toContainText('CODEX_CLOSE_UNSETTLED');
  const a=seed('并发偏好甲'),b=seed('并发偏好乙');await refresh();await d.getByRole('button',{name:'重新读取',exact:true}).click();await d.getByRole('button',{name:'待处理',exact:true}).click();await expect(d.locator('[data-task-id="'+b.taskId+'"]')).toBeVisible();
  await Promise.all([card(a.taskId).getByRole('button',{name:'移至已结束'}).click(),d.locator('[data-task-id="'+b.taskId+'"]').getByRole('button',{name:'移至已结束'}).click()]);await expect(card(a.taskId)).toHaveCount(0);await expect(card(b.taskId)).toHaveCount(0);const saved=JSON.parse(await page.evaluate(k=>localStorage.getItem(k),storageKey));assert.ok(saved.keys.some(v=>v.includes(a.taskId)));assert.ok(saved.keys.some(v=>v.includes(b.taskId)));await second.close();
 });
 await check('Corrupt and unwritable storage visibly reject handling without overwriting corruption or false persistent success',async()=>{
  const original=await page.evaluate(k=>localStorage.getItem(k),storageKey);await page.evaluate(k=>localStorage.setItem(k,'{broken'),storageKey);await reload();await show('待处理');await expect(drawer()).toContainText('已处理记录损坏');await card(fail.taskId).getByRole('button',{name:'移至已结束'}).click();await expect(card(fail.taskId)).toBeVisible();assert.equal(await page.evaluate(k=>localStorage.getItem(k),storageKey),'{broken');
  await page.evaluate(({k,v})=>localStorage.setItem(k,v),{k:storageKey,v:original});await refresh();const pending=seed('不可写存储任务');await refresh();await page.evaluate(()=>{window.__originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k.startsWith('shiguang.codex.handled.v1.'))throw new DOMException('synthetic quota','QuotaExceededError');return window.__originalSetItem.call(this,k,v);};});
  await card(pending.taskId).getByRole('button',{name:'移至已结束'}).click();await expect(drawer()).toContainText('无法保存处理记录');await expect(card(pending.taskId)).toBeVisible();await page.evaluate(()=>{Storage.prototype.setItem=window.__originalSetItem;});await card(pending.taskId).getByRole('button',{name:'移至已结束'}).click();await expect(card(pending.taskId)).toHaveCount(0);
 });
 await check('Real queued task and controlled unconfirmed task cannot handle; classification keeps UNKNOWN visible',async()=>{
  const active=seed('合成准备任务','queued');await refresh();await show('进行中');await expect(card(active.taskId)).toContainText('准备中');await expect(card(active.taskId).getByRole('button',{name:'移至已结束'})).toHaveCount(0);
  const pattern=origin+'/api/prompt-codex/tasks?**';await page.route(pattern,async route=>{const res=await route.fetch(),body=await res.json();body.items=body.items.map(t=>t.taskId===fail.taskId?{...t,stateUnconfirmed:true,verificationError:'合成UNKNOWN'}:t);await route.fulfill({response:res,json:body});});await refresh();await show('待处理');await expect(card(fail.taskId)).toContainText('状态待确认');await expect(card(fail.taskId).getByRole('button',{name:'移至已结束'})).toHaveCount(0);await page.unroute(pattern);await refresh();await expect(card(fail.taskId)).toHaveCount(0);
 });
 await check('Controlled library identity event fences late old response; same IDs in another library do not inherit preferences',async()=>{
  const pattern=origin+'/api/prompt-codex/tasks?**';let entered;const reached=new Promise(r=>entered=r);let release;const gate=new Promise(r=>release=r);await page.route(pattern,async route=>{const res=await route.fetch();entered();await Promise.race([gate,new Promise(r=>setTimeout(r,8000))]);await route.fulfill({response:res});});const click=refresh();await reached;await page.evaluate(()=>window.dispatchEvent(new Event('shiguang-library-identity-changed')));release();await click;await expect(drawer().locator('.codex-task-card')).toHaveCount(0);await expect(drawer()).toContainText('素材库已变化');await page.unroute(pattern);
  const sessionPattern=origin+'/api/session';await page.route(sessionPattern,async route=>{const res=await route.fetch(),body=await res.json();body.instanceId='synthetic-other-library';await route.fulfill({response:res,json:body});});await reload();await show('待处理');await expect(card(fail.taskId).getByRole('button',{name:'移至已结束'})).toBeVisible();assert.equal(await page.evaluate(()=>localStorage.getItem('shiguang.codex.handled.v1.synthetic-other-library')),null);await page.unroute(sessionPattern);await reload();await show('已结束');await expect(card(fail.taskId)).toContainText('SECOND_FAILURE');
 });
 await check('Affected mobile button and ended card remain usable; no generation/stop/reconnect writes or external requests',async()=>{
  await page.setViewportSize({width:390,height:844});await show('已结束');await expect(card(fail.taskId)).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(evidence,'handled-mobile.png')});assert.deepEqual(businessWrites,[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 });
 passed=true;
}catch(e){await page?.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(evidence,'failure.txt'),e.stack);throw e;}
finally{
 await browser?.close();db?.close();if(child&&child.exitCode===null&&!child.signalCode)await stop();await fs.writeFile(path.join(evidence,'server.log'),allLogs);await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,external,businessWrites,exits,temp,scope:'fresh own SQLite and synthetic tasks/media; real App/task APIs; identity/UNKNOWN probes explicitly modeled'},null,2));if(exits.length&&exits.every(e=>e.known))await fs.rm(temp,{recursive:true,force:true});
}
