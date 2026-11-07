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
const root=path.resolve(import.meta.dirname,'..'),evidence=path.resolve(process.env.CODEX_TASK_EVIDENCE||path.join(root,'collab/results/CODEX-TASK-DRAWER-20261104/frontend/rework-r2/browser-'+Date.now())),dist=path.resolve(process.env.CODEX_TASK_DIST||path.join(root,'collab/results/CODEX-TASK-DRAWER-20261104/frontend/rework-r2/dist'));
await fs.mkdir(evidence,{recursive:true});const temp=await fs.mkdtemp(path.join(os.tmpdir(),'codex-task-drawer-'));
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
const taskButton=()=>page.locator('.codex-tasks-entry:visible').first();
const drawer=()=>page.getByRole('complementary',{name:'Codex 全局任务'});
async function showDrawer(tab){if(!await drawer().isVisible())await taskButton().click();if(tab)await drawer().getByRole('button',{name:tab,exact:true}).click();}
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
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});const context=await browser.newContext({viewport:{width:1480,height:1000},hasTouch:true});
 await context.route(origin+'/**',async route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({path:path.join(dist,'index.html')});if(u.pathname.startsWith('/assets/')){const file=path.resolve(dist,'.'+decodeURIComponent(u.pathname));assert.ok(file.startsWith(dist+path.sep));return route.fulfill({path:file});}return route.continue();});
 await context.addInitScript(()=>{localStorage.setItem('shiguang.refreshSeconds','0');window.__taskScrolls=[];const original=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){if(this.dataset?.turnId)window.__taskScrolls.push(this.dataset.turnId);return original.apply(this,args);};});
 context.on('request',r=>{const u=new URL(r.url());if(/^https?:$/.test(u.protocol)&&u.origin!==origin)external.push(u.origin+u.pathname);});
 page=await context.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#/projects');

 // Only the outstanding pointer-layout regression is exercised here.
 const hitResults=[];
 async function pointer(locator,mobile){await expect(locator).toBeVisible();if(mobile)await locator.tap();else await locator.click();}
 async function geometry(locator){return locator.evaluate(el=>{const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{rect:{x:r.x,y:r.y,width:r.width,height:r.height},hit:hit?.className,targetsButton:hit===el||el.contains(hit),inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight};});}
 async function verifyPair(name,back,mobile){
  const entry=page.locator('.codex-task-overlaybar .codex-tasks-entry');await expect(entry).toContainText('生成中 3');
  const before={entry:await geometry(entry),back:await geometry(back)};
  for(const value of Object.values(before)){assert.ok(value.targetsButton,JSON.stringify(before));assert.ok(value.inside,JSON.stringify(before));}
  const er=before.entry.rect,br=before.back.rect;assert.ok(er.y+er.height<=br.y||br.y+br.height<=er.y||er.x+er.width<=br.x||br.x+br.width<=er.x,'independent button space');
  assert.equal(await page.locator('.codex-special-page').evaluate(el=>el.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:false});
  await pointer(entry,mobile);await expect(drawer()).toBeVisible();const whileOpen=await geometry(back);assert.ok(whileOpen.targetsButton&&whileOpen.inside,JSON.stringify(whileOpen));await pointer(drawer().getByRole('button',{name:'关闭 Codex 任务',exact:true}),mobile);await expect(drawer()).toBeHidden();
  const after=await geometry(back);assert.ok(after.targetsButton&&after.inside,JSON.stringify(after));hitResults.push({name,before,whileOpen,after});
  await pointer(entry,mobile);await expect(drawer()).toBeVisible();await pointer(back,mobile);
 }
 const account=randomUUID(),device=randomUUID(),accountSession=randomUUID();
 for(const width of [1480,390]){
  const mobile=width===390;await page.setViewportSize({width,height:1000});
  await page.unroute(origin+'/api/cloud-auth/status');await page.unroute(origin+'/api/cloud-management/profile');await page.unroute(origin+'/api/cloud-upload-tasks/control/status');
  await check(width+'px login entry and return accept real '+(mobile?'touch':'mouse')+' input',async()=>{
   await page.goto(origin+'/?layout='+width+'-login#/login');
   await verifyPair('login-'+width,page.getByRole('button',{name:'返回素材库',exact:true}),mobile);await expect(page.locator('.codex-special-page')).toHaveCount(0);await expect(page.locator('.library-topbar')).toBeVisible();
  });
  await page.route(origin+'/api/cloud-auth/status',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({configured:true,state:'logged-in',username:'synthetic',displayName:'合成账户',accountId:account,deviceId:device,sessionId:accountSession,needsLogin:false,lastError:null})}));
  await page.route(origin+'/api/cloud-management/profile',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({me:{accountId:account,username:'synthetic',displayName:'合成账户'},capabilities:{superAdmin:false,systemPermissions:[],groups:[]},devices:[]})}));
  await page.route(origin+'/api/cloud-upload-tasks/control/status',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({known:true,local:{engine:'sqlite',registrationAssetIds:[],roots:[]},identityKey:'synthetic-view-only',counts:{},pending:[]})}));
  await check(width+'px account entry and return accept real '+(mobile?'touch':'mouse')+' input (cloud view modeled)',async()=>{
   await page.goto(origin+'/?layout='+width+'-account#/account');await expect(page.locator('.cloud-workspace')).toBeVisible();
   await verifyPair('account-'+width,page.locator('.cloud-workspace .cw-header').getByRole('button',{name:'返回素材库',exact:true}),mobile);await expect(page.locator('.codex-special-page')).toHaveCount(0);await expect(page.locator('.library-topbar')).toBeVisible();
  });
  await check(width+'px upload entry and return accept real '+(mobile?'touch':'mouse')+' input (cloud view modeled)',async()=>{
   await page.goto(origin+'/?layout='+width+'-upload#/account');await pointer(page.getByRole('button',{name:'云端音频',exact:true}),mobile);await pointer(page.getByRole('button',{name:'批量上传任务',exact:true}),mobile);await pointer(page.getByRole('button',{name:'进入上传任务中心',exact:true}),mobile);
   await verifyPair('upload-'+width,page.getByRole('button',{name:'返回账户',exact:true}),mobile);await expect(page.locator('.cloud-workspace')).toBeVisible();
  });
 }
 await fs.writeFile(path.join(evidence,'pointer-hits.json'),JSON.stringify(hitResults,null,2)+'\n');
 assert.equal(await calls('turn/start'),5);assert.equal(await calls('turn/interrupt'),0);
 assert.equal(errors.length,0,JSON.stringify(errors));assert.equal(external.length,0,JSON.stringify(external));assert.deepEqual(await hashes(),backendBefore,'backend must remain stable for this integration evidence');passed=true;
}catch(e){console.error(e);if(page)await page.screenshot({path:path.join(evidence,'failure.png'),fullPage:false}).catch(()=>{});throw e;}
finally{
 if(browser)await browser.close();child.kill('SIGTERM');let timer;const end=await Promise.race([exited,new Promise(r=>timer=setTimeout(()=>r(null),10000))]);clearTimeout(timer);if(!end){child.kill('SIGKILL');await exited;}
 await fs.writeFile(path.join(evidence,'server.log'),logs);await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,external,backendBefore,exit:end??'owned test child forced closed after timeout',port,temporary:temp},null,2)+'\n');await fs.rm(temp,{recursive:true,force:true});
}
