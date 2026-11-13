// Real HTTP/React/SSE and current task/stop backend, fresh owned SQLite/FS;
// only app-server is a local JSON-RPC peer. Never opens the user's data or Codex.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {fixture,inputs} from './helpers/prompt-lifecycle.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import Database from 'better-sqlite3';
import { projectInBar, selectProjectInBar } from './helpers/path-bar.mjs';
import { builtDist, evidenceDir } from './helpers/artifacts.mjs';
const root=path.resolve(import.meta.dirname,'..'),evidence=evidenceDir('codex-task-drawer',process.env.CODEX_TASK_EVIDENCE),dist=builtDist(root,process.env.CODEX_TASK_DIST);
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'codex-task-drawer-'));
const mock=path.join(temp,'fake-codex'),trace=path.join(temp,'rpc.jsonl');
const originalPeer=await fs.readFile(path.join(root,'tests/helpers/fake-codex.mjs'),'utf8');
const peer=originalPeer.replace("if(text.includes('慢速停止测试')){later(10000,()=>finish(threadId,turnId));return;}","if(text.includes('慢速停止测试')){let pulse=0;const timer=setInterval(()=>notify('item/agentMessage/delta',{itemId:turnId+'-text',delta:' 合成进度'+(++pulse)}),1000);timers.push(timer);later(180000,()=>finish(threadId,turnId));return;}");
assert.notEqual(peer,originalPeer);await fs.writeFile(mock,'#!'+process.execPath+'\n'+peer,{mode:0o700});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin='http://127.0.0.1:'+port;
let logs='',cookie='',token='',browser,page,passed=false;const checks=[],errors=[],external=[];
const sources=['server/prompt-codex/router.mjs','server/prompt-codex/service.mjs','server/prompt-codex/store.mjs','server/prompt-codex/tasks.mjs'];
const hashes=async()=>Promise.all(sources.map(async file=>({file,sha256:createHash('sha256').update(await fs.readFile(path.join(root,file))).digest('hex')})));
const backendBefore=await hashes();
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:path.join(temp,'data'),MEDIA_PERSONAL_ITEM_DIR:path.join(temp,'personal'),CODEX_HOME:path.join(temp,'mock-home'),SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(temp,'missing-release.json'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'0',SHIGUANG_AUDIO_ANALYSIS:'0',MEDIA_CODEX_BIN:mock,CODEX_FAKE_TRACE:trace,CODEX_FAKE_IMAGE_FILES:'1',PATH:path.join(temp,'no-tools')},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exited=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
async function raw(p,body,method){const res=await fetch(origin+'/api'+p,{method:method||(body?'POST':'GET'),headers:{cookie,origin,'x-local-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await res.json();return{res,data};}
async function api(p,body,method){const r=await raw(p,body,method);assert.ok(r.res.ok,p+' '+JSON.stringify(r.data));return r.data;}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
const calls=async method=>(await fs.readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(c=>c.method===method).length;
const taskButton=()=>page.locator('.library-topbar .codex-tasks-entry');
const drawer=()=>page.getByRole('complementary',{name:'Codex 全局任务'});
async function showDrawer(tab){if(!await drawer().isVisible()){/* 预期中的失败提示会叠在顶栏右上角、盖住 Codex 按钮：先逐条关掉 */await dismissNotices();await taskButton().click();/* 任务列表现在在「自由管家」面板的「任务」栏目里 */const tasks=page.getByRole('tablist',{name:'自由管家栏目'}).getByRole('tab',{name:/^任务/});if(await tasks.count())await tasks.click();await expect(drawer()).toBeVisible();}if(tab)await drawer().getByRole('button',{name:tab,exact:true}).click();}
// Codex 任务结束提示现在走右上角「全局操作提示」
const taskNotices=()=>page.getByRole('region',{name:'全局操作提示'}).getByText(/^Codex：/);
async function dismissNotices(){const close=page.getByRole('region',{name:'全局操作提示'}).getByRole('button',{name:'关闭此提示'});for(let i=0;i<10&&await close.count();i++){/* 提示可能正在自动消失 */await close.first().dispatchEvent('click',undefined,{timeout:1000}).catch(()=>{});await page.waitForTimeout(150);}}
/** 点「重新读取」并等这次刷新被界面处理完：请求已发出 → 读取期间按钮不可用 → 处理结束按钮恢复 → 再等两帧让提示渲染出来。 */
async function refreshTasks(){const button=drawer().getByRole('button',{name:'重新读取',exact:true});const sent=page.waitForRequest(r=>r.method()==='GET'&&new URL(r.url()).pathname==='/api/prompt-codex/tasks');await button.click();await sent;await expect(button).toBeEnabled();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
const card=id=>drawer().locator('[data-task-id="'+id+'"]');
const chat=()=>page.getByRole('region',{name:'Codex 图文对话'});
async function jump(id,tab){await showDrawer(tab);await card(id).locator('.codex-task-main').click();await expect(page.locator('[data-turn-id="'+id+'"]')).toBeVisible();await expect(drawer()).toBeHidden();}
try{
 await expect.poll(()=>logs,{timeout:25000}).toContain(origin);const session=await fetch(origin+'/api/session');cookie=session.headers.get('set-cookie').split(';')[0];token=(await session.json()).token;
 await api('/prompt-codex/tasks'); // Must be the real backend, never a stub.
 const templateA=await api('/prompt-templates',{...fixture(),name:'同名模板'}),templateB=await api('/prompt-templates',{...fixture(),name:'同名模板'}),projectA=await api('/projects',{name:'合成项目甲'}),projectB=await api('/projects',{name:'合成项目乙'});
 await api('/prompt-codex/connect',{});
 async function conversation(template,slow=false){return api('/prompt-codex/conversations',{id:randomUUID(),template_id:template.id,template_revision:template.revision,values:{...inputs,主题:slow?'慢速停止测试':'普通历史'}});}
 async function start(c,project,text=''){const latest=await api('/prompt-codex/conversations/'+c.id);return api('/prompt-codex/conversations/'+c.id+'/turns',{id:randomUUID(),expected_revision:latest.revision,model:'synthetic-a',effort:'high',output:'text',text,retry_of:null,project_id:project.id});}
 const history=await conversation(templateA),oldTurn=await start(history,projectA);await expect.poll(async()=>(await api('/prompt-codex/conversations/'+history.id)).turns[0].status).toBe('completed');
 const newTurn=await start(history,projectA,'第二轮');await expect.poll(async()=>(await api('/prompt-codex/conversations/'+history.id)).turns.at(-1).status).toBe('completed');
 // Terminal-only fixture seeding in this test's brand-new SQLite. No active
 // Service state is edited, and every visible task still uses the real GET API.
 const deletedTemplate=await api('/prompt-templates',{...fixture(),name:'合成已删除模板'}),seedDb=new Database(path.join(temp,'data','library.sqlite'));seedDb.pragma('busy_timeout=5000');
 const headSeed=seedDb.prepare('SELECT * FROM codex_conversations WHERE id=?').get(history.id),turnSeed=seedDb.prepare('SELECT * FROM codex_turns WHERE id=?').get(oldTurn.id);
 function insert(table,row){const keys=Object.keys(row);seedDb.prepare('INSERT INTO '+table+'('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));}
 function seedTerminal({title='分页合成',template=templateA.id,deleted=false,blocks=null,project=null,createdAt=Date.now()-100000}={}){
  const conversationId=randomUUID(),taskId=randomUUID(),actual=JSON.parse(turnSeed.actual_json);if(blocks)delete actual._taskSummary;if(project)actual.pictureProject=project;
  insert('codex_conversations',{...headSeed,id:conversationId,title,template_id:template,deleted_at:deleted?createdAt:null,created_at:createdAt,updated_at:createdAt});
  insert('codex_turns',{...turnSeed,id:taskId,conversation_id:conversationId,sequence_no:1,actual_json:JSON.stringify(actual),...(blocks?{blocks_json:JSON.stringify(blocks)}:{}),created_at:createdAt,updated_at:createdAt});return{conversationId,taskId};
 }
 for(let i=0;i<55;i++)seedTerminal({createdAt:Date.now()-1000000-i});
 const softDeleted=seedTerminal({title:'已删除保留历史',template:deletedTemplate.id,deleted:true,createdAt:Date.now()-20000}),missing=seedTerminal({title:'目标模板已不存在',template:randomUUID(),createdAt:Date.now()-19000});
 const imageId=randomUUID(),imageBytes=Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==','base64');
 const imageIssue=seedTerminal({title:'图片原图保留入库问题',project:{id:randomUUID(),name:'合成不可用项目'},createdAt:Date.now()-18000,blocks:[{type:'image',itemId:'owned-image',status:'ready',attachmentId:imageId,library:{status:'failed',error:'合成入库失败'}}]});
 insert('codex_attachments',{id:imageId,turn_id:imageIssue.taskId,file_name:imageId+'.gif',sha256:createHash('sha256').update(imageBytes).digest('hex'),mime:'image/gif',bytes:imageBytes.length,created_at:Date.now(),updated_at:Date.now()});seedDb.close();await fs.writeFile(path.join(temp,'data/prompt-codex/images',imageId+'.gif'),imageBytes,{mode:0o600});
 await api('/prompt-templates/'+deletedTemplate.id,{expected_revision:deletedTemplate.revision},'DELETE');
 await api('/storyboard/projects/'+projectA.id+'/initialize',{request_id:randomUUID(),source:syntheticSource(),expected_revision:null,filename:'合成.json',timing:'duration'});
 const ca=await conversation(templateA,true),cb=await conversation(templateA,true),cc=await conversation(templateB,true),a=await start(ca,projectA),b=await start(cb,projectA),c=await start(cc,projectB);
 const agedDb=new Database(path.join(temp,'data','library.sqlite'));agedDb.prepare('UPDATE codex_turns SET created_at=? WHERE id IN (?,?)').run(Date.now()-10000000,a.id,c.id);agedDb.close();
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext({viewport:{width:1480,height:1000}});
 await context.route(origin+'/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({path:path.join(dist,'index.html')});if(u.pathname.startsWith('/assets/')){const file=path.resolve(dist,'.'+decodeURIComponent(u.pathname));assert.ok(file.startsWith(dist+path.sep));return route.fulfill({path:file});}return route.continue();});
 await context.addInitScript(()=>{localStorage.setItem('shiguang.refreshSeconds','0');window.__taskScrolls=[];const original=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){if(this.dataset?.turnId)window.__taskScrolls.push(this.dataset.turnId);return original.apply(this,args);};});
 context.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&u.origin!==origin)external.push(u.origin+u.pathname);});
 page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#/projects');
 await check('Three real concurrent tasks, same titles across templates, global count, non-modal close/focus and navigation never sends/stops',async()=>{
  await expect(taskButton()).toContainText('生成中 3');await selectProjectInBar(page, projectA.id);
  await showDrawer('进行中');await expect(drawer().locator('.codex-task-card')).toHaveCount(3);await expect(card(c.id)).toContainText('合成项目乙');
  await expect(taskNotices()).toHaveCount(0);
  await page.keyboard.press('Escape');await expect(drawer()).toBeHidden();await expect(taskButton()).toBeFocused();const count=await calls('turn/start');await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'项目资产',exact:true}).click();await expect(taskButton()).toContainText('生成中 3');assert.equal(await calls('turn/start'),count);assert.equal(await calls('turn/interrupt'),0);
 });
 await check('Exact old turn / cross-template navigation, one 4s highlight, progress never steals scroll, global image project unchanged',async()=>{
  await jump(c.id,'进行中');await expect(page.locator('.codex-chat [data-conversation-id="'+cc.id+'"]')).toHaveClass('selected');await expect(projectInBar(page)).toHaveAttribute('data-project', projectA.id);
  await expect(page.locator('[data-turn-id="'+c.id+'"]')).toHaveClass(/codex-turn-focused/);await page.waitForTimeout(1200);assert.equal(await page.evaluate(id=>window.__taskScrolls.filter(v=>v===id).length,c.id),1);await page.waitForTimeout(3000);await expect(page.locator('[data-turn-id="'+c.id+'"]')).not.toHaveClass(/codex-turn-focused/);
  await jump(oldTurn.id,'已结束');await expect(page.locator('[data-turn-id="'+oldTurn.id+'"]')).toHaveClass(/codex-turn-focused/);await expect(page.locator('.codex-chat [data-conversation-id="'+history.id+'"]')).toHaveClass('selected');await expect(projectInBar(page)).toHaveAttribute('data-project', projectA.id);
 });
 await check('Template save failure cancels navigation; follow-up and template input survive successful round-trip',async()=>{
  await chat().getByLabel('Codex 追问内容').fill('未发送的追问草稿');
  const draftPattern=origin+'/api/prompt-templates/'+templateA.id+'/draft';let denied=0;await page.route(draftPattern,async route=>{if(route.request().method()==='PUT'){denied++;return route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'合成草稿保存失败'})});}return route.continue();});
  await page.getByLabel('主题',{exact:true}).fill('必须保留的模板输入');await showDrawer('进行中');await card(c.id).locator('.codex-task-main').click();await expect(drawer()).toContainText('导航已取消');await expect(chat().getByLabel('Codex 追问内容')).toHaveValue('未发送的追问草稿');assert.ok(denied>0);
  await page.unroute(draftPattern);await card(c.id).locator('.codex-task-main').click();await expect(drawer()).toBeHidden();await expect(projectInBar(page)).toHaveAttribute('data-project', projectA.id);
  await jump(newTurn.id,'已结束');await expect(chat().getByLabel('Codex 追问内容')).toHaveValue('未发送的追问草稿');await expect(page.getByLabel('主题',{exact:true})).toHaveValue('必须保留的模板输入');
 });
 await check('Edits typed while a target is loading are saved before the context switches',async()=>{
  const slow=origin+'/api/prompt-codex/conversations/'+cc.id;await page.route(slow,async route=>{await new Promise(r=>setTimeout(r,1000));return route.continue();});await showDrawer('进行中');const loading=page.waitForRequest(req=>req.url()===slow);await card(c.id).locator('.codex-task-main').click();await loading;await page.getByLabel('主题',{exact:true}).fill('加载目标时继续输入也须保留');await chat().getByLabel('Codex 追问内容').fill('异步加载时补充追问');await expect(drawer()).toBeHidden();await page.unroute(slow);assert.equal((await api('/prompt-templates/'+templateA.id)).draft.values.主题,'加载目标时继续输入也须保留');await jump(newTurn.id,'已结束');await expect(chat().getByLabel('Codex 追问内容')).toHaveValue('异步加载时补充追问');await expect(page.getByLabel('主题',{exact:true})).toHaveValue('加载目标时继续输入也须保留');
 });
 await check('Slow old response cannot override later task selection',async()=>{
  const slow=origin+'/api/prompt-codex/conversations/'+cc.id;await page.route(slow,async route=>{await new Promise(r=>setTimeout(r,600));return route.continue();});await showDrawer('进行中');await card(c.id).locator('.codex-task-main').click();await card(a.id).locator('.codex-task-main').click();await expect(drawer()).toBeHidden();await expect(page.locator('.codex-chat [data-conversation-id="'+ca.id+'"]')).toHaveClass('selected');await page.waitForTimeout(800);await expect(page.locator('.codex-chat [data-conversation-id="'+ca.id+'"]')).toHaveClass('selected');await page.unroute(slow);
 });
 await check('Manual page navigation supersedes a slow task request without restoring its old selection',async()=>{
  const slow=origin+'/api/prompt-codex/conversations/'+cc.id;await page.route(slow,async route=>{await new Promise(r=>setTimeout(r,700));return route.continue();});await showDrawer('进行中');const loading=page.waitForRequest(req=>req.url()===slow);await card(c.id).locator('.codex-task-main').click();await loading;await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'项目',exact:true}).click();await page.waitForTimeout(1000);assert.equal(new URL(page.url()).hash,'#/projects');await page.unroute(slow);
 });
 await check('Shared stop requires explicit scope; changed scope rejects without navigating or interrupting extra tasks',async()=>{
  await showDrawer('进行中');await card(b.id).getByRole('button',{name:'停止',exact:true}).click();const dialog=page.getByRole('dialog',{name:'确认停止影响范围'});await expect(dialog).toContainText(c.id);await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await calls('turn/interrupt'),0);await expect(page.locator('.codex-chat [data-conversation-id="'+ca.id+'"]')).toHaveClass('selected');
  await card(b.id).getByRole('button',{name:'停止',exact:true}).click();const extra=await conversation(templateB,true);await start(extra,projectB);await dialog.getByRole('button',{name:'确认停止并允许中断这些任务'}).click();await expect(dialog).toBeHidden();await expect(drawer()).toContainText(/范围|变化|重新/);assert.equal(await calls('turn/interrupt'),0);assert.equal((await api('/prompt-codex/tasks')).activeCount,4);
  await drawer().getByRole('button',{name:'重新读取',exact:true}).click();await card(b.id).getByRole('button',{name:'停止',exact:true}).click();await dialog.getByRole('button',{name:'确认停止并允许中断这些任务'}).click();await expect.poll(async()=>(await api('/prompt-codex/conversations/'+cb.id)).turns[0].error_code).toBe('USER_STOPPED');await expect(taskButton()).toContainText('生成中 3');
  await expect(taskNotices()).toHaveCount(1);/* 提示并入全局操作提示，自动消失时间随类型不同：手动关掉后再重新读取，确认不会重复提示 */await dismissNotices();await refreshTasks();/* 当场计数：toHaveCount(0) 会自动重试，等重复提示自动消失后反而通过 */assert.equal(await taskNotices().count(),0,'重新读取不应再发同一条提示');await drawer().getByRole('button',{name:'已结束',exact:true}).click();await expect(card(b.id)).toContainText('用户已停止');
 });
 await check('Conversation stop also uses scope confirmation, not legacy bypass',async()=>{
  await page.keyboard.press('Escape');await showDrawer('进行中');await card(a.id).locator('.codex-task-main').click();await chat().getByRole('button',{name:'停止生成',exact:true}).click();const dialog=page.getByRole('dialog',{name:'确认停止影响范围'});await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await calls('turn/interrupt'),1);
 });
 await check('Read outage retains known tasks; visibility pause/resume; no reconnect while tasks active',async()=>{
  await showDrawer('进行中');await expect(drawer().getByRole('button',{name:'重新连接',exact:true})).toBeDisabled();await page.route(origin+'/api/prompt-codex/tasks?**',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成读取失败'})}));await drawer().getByRole('button',{name:'重新读取',exact:true}).click();await expect(drawer()).toContainText('进度连接中断，后台状态待确认');await expect(drawer().locator('.codex-task-card')).toHaveCount(3);await page.unroute(origin+'/api/prompt-codex/tasks?**');await drawer().getByRole('button',{name:'重新读取',exact:true}).click();await expect(drawer().getByText('合成读取失败')).toHaveCount(0);
  let reads=0;const count=req=>{if(new URL(req.url()).pathname==='/api/prompt-codex/tasks')reads++;};page.on('request',count);await page.waitForTimeout(100);await page.evaluate(()=>{window.__hiddenForTest=true;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.__hiddenForTest?'hidden':'visible'});document.dispatchEvent(new Event('visibilitychange'));});const before=reads;await page.waitForTimeout(3000);assert.equal(reads,before);await page.evaluate(()=>{window.__hiddenForTest=false;document.dispatchEvent(new Event('visibilitychange'));});await expect.poll(()=>reads).toBeGreaterThan(before);page.off('request',count);
 });
 await check('Stable recent pagination deduplicates and is not reset by head polling; deleted/missing/unavailable/image errors explain without restore/regenerate',async()=>{
  await showDrawer('已结束');const firstCount=await drawer().locator('.codex-task-card').count();await drawer().getByRole('button',{name:'读取更早的任务'}).click();await expect.poll(()=>drawer().locator('.codex-task-card').count()).toBeGreaterThan(firstCount);await drawer().getByRole('button',{name:'重新读取',exact:true}).click();const ids=await drawer().locator('.codex-task-card').evaluateAll(nodes=>nodes.map(n=>n.dataset.taskId));assert.equal(new Set(ids).size,ids.length);await expect(drawer().getByRole('button',{name:'读取更早的任务'})).toHaveCount(0);await drawer().locator('.codex-task-list').evaluate(el=>el.scrollTop=120);await page.keyboard.press('Escape');await showDrawer();await expect(drawer().getByRole('button',{name:'已结束',exact:true})).toHaveAttribute('aria-pressed','true');assert.equal(await drawer().locator('.codex-task-list').evaluate(el=>el.scrollTop),120);
  await card(missing.taskId).locator('.codex-task-main').click();await expect(drawer().getByRole('alert')).toContainText(/不存在|找到|缺失/);await expect(page.locator('.codex-chat [data-conversation-id="'+ca.id+'"]')).toHaveClass('selected');
  const starts=await calls('turn/start');await card(softDeleted.taskId).locator('.codex-task-main').click();await expect(drawer()).toBeHidden();await expect(chat()).toContainText('已删除的对话');assert.ok((await api('/prompt-codex/conversations/'+softDeleted.conversationId)).deleted_at);assert.ok((await api('/prompt-templates/'+deletedTemplate.id)).deleted_at);
  await showDrawer('待处理');await expect(card(imageIssue.taskId)).toContainText('当前不可用');await expect(card(imageIssue.taskId)).toContainText('原图保留');await card(imageIssue.taskId).getByRole('button',{name:'查看原图及入库问题'}).click();await expect(drawer()).toBeHidden();await expect(chat()).toContainText('合成入库失败');await expect(chat().getByRole('button',{name:'加入素材库',exact:true})).toBeVisible();assert.equal(await calls('turn/start'),starts);await expect(projectInBar(page)).toHaveAttribute('data-project', projectA.id);
 });
 await check('Unsaved storyboard draft stays in its original project across task navigation',async()=>{
  await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'分镜设计',exact:true}).click();const board=page.getByRole('region',{name:'分镜设计工作台'});await expect(board.getByTestId('detail-action')).toBeVisible();
  const endpoint=origin+'/api/storyboard/projects/'+projectA.id;await page.route(endpoint,route=>route.request().method()==='PUT'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成分镜保存失败'})}):route.continue());await board.getByTestId('detail-action').fill('未保存的分镜草稿');await jump(c.id,'进行中');await expect(projectInBar(page)).toHaveAttribute('data-project', projectA.id);await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'分镜设计',exact:true}).click();await expect(board.getByTestId('detail-action')).toHaveValue('未保存的分镜草稿');await page.unroute(endpoint);
 });
 await check('Currently visible terminal turn does not notify again and reading never repeats generation',async()=>{
  await jump(a.id,'进行中');await page.waitForTimeout(600);const starts=await calls('turn/start');const scope=await api('/prompt-codex/tasks/'+a.id+'/stop-impact');await api('/prompt-codex/tasks/'+a.id+'/stop',{impactToken:scope.impactToken,confirmSharedClose:scope.requiresConfirmation});await expect(taskButton()).toContainText('生成中 2');assert.equal((await api('/prompt-codex/tasks')).items.some(t=>t.taskId===a.id),false);await expect(taskNotices()).toHaveCount(0);await showDrawer('已结束');await expect(card(a.id)).toContainText('状态已从原对话核对');await refreshTasks();/* 当场计数：toHaveCount(0) 会自动重试，等重复提示自动消失后反而通过 */assert.equal(await taskNotices().count(),0,'重新读取不应再发同一条提示');assert.equal(await calls('turn/start'),starts);
 });
 await check('An aged task missing from page one stays pending on failed exact read, then resolves without generation replay',async()=>{
  await page.route(origin+'/api/prompt-codex/conversations/'+cc.id,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成原轮核对失败'})}));const starts=await calls('turn/start'),scope=await api('/prompt-codex/tasks/'+c.id+'/stop-impact');await api('/prompt-codex/tasks/'+c.id+'/stop',{impactToken:scope.impactToken,confirmSharedClose:scope.requiresConfirmation});await expect.poll(async()=>(await api('/prompt-codex/tasks')).activeCount).toBe(1);await showDrawer('待处理');await drawer().getByRole('button',{name:'重新读取',exact:true}).click();await expect(card(c.id)).toContainText('状态待确认');await expect(card(c.id)).toContainText('合成原轮核对失败');await page.unroute(origin+'/api/prompt-codex/conversations/'+cc.id);await drawer().getByRole('button',{name:'重新读取',exact:true}).click();await drawer().getByRole('button',{name:'已结束',exact:true}).click();await expect(card(c.id)).toContainText('用户已停止');assert.equal(await calls('turn/start'),starts);
 });
 await check('Uncertain submission keeps its exact original identity, blocks navigation, and only reads on confirmation',async()=>{
  await page.keyboard.press('Escape');const pattern=origin+'/api/prompt-codex/conversations/*/turns';let submitted=null;await page.route(pattern,async route=>{if(route.request().method()!=='POST')return route.continue();submitted=route.request().postDataJSON();await route.fetch();return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成提交回执丢失'})});});const count=await calls('turn/start');await chat().locator('.codex-generate-button').click();await expect(chat().locator('.codex-generation-feedback')).toContainText('提交结果待确认');assert.ok(submitted?.id);await page.unroute(pattern);await showDrawer('进行中');const other=drawer().locator('.codex-task-card').filter({hasText:'生成中'}).first();await other.locator('.codex-task-main').click();await expect(drawer()).toContainText('原提交结果待确认');await page.keyboard.press('Escape');await chat().locator('.codex-generation-feedback').getByRole('button',{name:'检查提交结果',exact:true}).click();await expect(page.locator('[data-turn-id="'+submitted.id+'"]')).toBeVisible();await expect(chat().locator('.codex-generation-feedback').getByRole('button',{name:'检查提交结果',exact:true})).toHaveCount(0);assert.equal(await calls('turn/start'),count+1);
 });
 await check('390px / dark theme / Escape focus, drawer stays under the header without horizontal overflow',async()=>{
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>document.documentElement.dataset.theme='dark');await showDrawer('进行中');await expect(drawer()).toBeVisible();assert.ok(await drawer().evaluate(el=>el.getBoundingClientRect().width<=innerWidth));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(evidence,'drawer-390-dark.png'),fullPage:false});await page.keyboard.press('Escape');await expect(taskButton()).toBeFocused();await page.setViewportSize({width:1480,height:1000});await page.evaluate(()=>document.documentElement.dataset.theme='forest');await showDrawer('进行中');await page.screenshot({path:path.join(evidence,'drawer-desktop.png'),fullPage:false});
 });
 assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(external.length,0,JSON.stringify(external));assert.deepEqual(await hashes(),backendBefore,'backend must remain stable for this integration evidence');passed=true;
}catch(e){console.error(e);if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:false}).catch(()=>{});throw e;}
finally{
 if(browser)await browser.close();child.kill('SIGTERM');let timer;const end=await Promise.race([exited,new Promise(r=>timer=setTimeout(()=>r(null),10000))]);clearTimeout(timer);if(!end){child.kill('SIGKILL');await exited;}
 await fs.writeFile(path.join(evidence,'server.log'),logs);await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,external,backendBefore,exit:end??'owned test child forced closed after timeout',port,temporary:temp},null,2)+'\n');await fs.rm(temp,{recursive:true,force:true});
}
