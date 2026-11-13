import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import * as M from '../server/storyboard/shared/model.mjs';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { builtDist, evidenceDir } from './helpers/artifacts.mjs';
const root=path.resolve(import.meta.dirname,'..'),evidence=evidenceDir('asset-shots',process.env.ASSET_SHOTS_EVIDENCE),dist=builtDist(root,process.env.ASSET_SHOTS_DIST);
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'asset-shots-ui-')),socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin='http://127.0.0.1:'+port;
let logs='',browser,context,page,cookie,token,passed=false;const checks=[],errors=[],external=[],held=new Set();
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:path.join(temporary,'data'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'1',SHIGUANG_AUDIO_ANALYSIS:'0',PATH:path.join(temporary,'no-tools')},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exited=new Promise(r=>child.once('exit',r));
async function api(p,body,method){const r=await fetch(origin+'/api'+p,{method:method||(body?'POST':'GET'),headers:{cookie,origin,'x-local-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,p+' '+JSON.stringify(v));return v;}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
const work=()=>page.getByRole('region',{name:'项目资产库'}),board=()=>page.getByRole('region',{name:'分镜设计工作台'}),links=()=>work().getByRole('region',{name:'关联镜号'});
async function nav(name){await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true}).click();}
async function selectAsset(project,kind,name){await nav('项目资产');await selectProjectInBar(page, project);await work().getByRole('tab',{name:new RegExp('^'+kind)}).click();await expect(work().locator('section.ca-gallery')).toHaveAttribute('aria-busy','false');await work().locator('.ca-card').filter({hasText:name}).click();await expect(work().locator('.ca-name-input')).toHaveValue(name);}
async function openLinks(){/* 详情改为单页分区：从「详情分区」导航跳到「出场镜头」 */await work().getByRole('navigation',{name:'详情分区'}).getByRole('button',{name:'出场镜头',exact:true}).click();await expect(links()).toHaveAttribute('aria-busy','false');}
async function highlighted(id,number){const row=board().locator('tr[data-shot="'+id+'"]');await expect(row).toHaveClass('sb-active-row');await expect(row.getByLabel('选择镜'+number,{exact:true})).toBeChecked();await expect(board().locator('tr.sb-active-row')).toHaveCount(1);await expect(board().getByLabel('搜索镜号或内容')).toHaveValue('');await expect.poll(()=>row.evaluate(el=>{const box=el.getBoundingClientRect(),container=el.closest('.sb-table-scroll').getBoundingClientRect();return box.top>=container.top&&box.bottom<=container.bottom;})).toBe(true);}
try{
 await expect.poll(()=>logs,{timeout:20000}).toContain(origin);const response=await fetch(origin+'/api/session');cookie=response.headers.get('set-cookie').split(';')[0];token=(await response.json()).token;
 const a=await api('/projects',{name:'关联镜号合成甲'}),b=await api('/projects',{name:'关联镜号合成乙'}),source=syntheticSource();source.asset_manifest.scene.push({id:'s2',name:'合成外景'});
 for(let i=1;i<32;i++){const q=M.emptyShot();q.action=i===1?'陈川与合成包只在文字中出现':'合成背景镜头 '+(i+1);source.scenes[0].shots.push(q);}const last=source.scenes[0].shots.at(-1);last.character_ids=['c1'];last.prop_ids=['p1'];last.action='末尾关联镜头';source.scenes[0].shots[1].scene_asset_id='s2';
 const outside=structuredClone(source.scenes[0]);outside.id=M.uid('scene');outside.location='合成外景';outside.name='外景场次';outside.scene_asset_id='s2';outside.shots=[M.emptyShot()];source.scenes.push(outside);
 let record=await api('/storyboard/projects/'+a.id+'/initialize',{source,expected_revision:null,request_id:randomUUID()});const targetId=record.project.scenes[0].shots.at(-1).id,firstId=record.project.scenes[0].shots[0].id,actorId=record.project.characters[0].id,unusedId=record.project.characters[1].id;
 await api('/project-assets/assets',{project_id:b.id,kind:'character',name:'未初始化人物'});assert.equal((await fetch(origin+'/api/project-assets/assets/'+actorId+'/shots')).status,401);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('shiguang.refreshSeconds','0'));context.on('request',r=>{const u=new URL(r.url());if(u.protocol.startsWith('http')&&u.origin!==origin)external.push(u.origin+u.pathname);});
 await context.route(origin+'/**',route=>{const u=new URL(route.request().url());if(u.pathname==='/')return route.fulfill({path:path.join(dist,'index.html')});if(u.pathname.startsWith('/assets/')){const file=path.resolve(dist,'.'+decodeURIComponent(u.pathname));assert.ok(file.startsWith(dist+path.sep));return route.fulfill({path:file});}return route.continue();});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#/project-assets');
 await check('人物新增同层关联镜号，顺序正确、明确关联去重、空关联不猜测名称',async()=>{
  await selectAsset(a.id,'人物','陈川');assert.deepEqual(await work().getByRole('navigation',{name:'详情分区'}).getByRole('button').allTextContents(),['资料','造型与参考图','属性','语音','出场镜头']);await openLinks();assert.deepEqual(await links().getByRole('button',{name:/查看镜/}).allTextContents().then(rows=>rows.map(s=>s.match(/镜 (\d+)/)[1])),['01','32']);await links().screenshot({path:path.join(evidence,'associated-shots.png')});
 });
 await check('首次跳转打开正确项目并滚动、高亮和选中末尾镜头，不修改分镜版本',async()=>{
  await links().getByRole('button',{name:'查看镜 32',exact:true}).click();await highlighted(targetId,'32');assert.equal((await api('/storyboard/projects/'+a.id)).revision,record.revision);await page.screenshot({path:path.join(evidence,'highlight-shot-32.png')});
  await board().getByLabel('搜索镜号或内容').fill('没有匹配的筛选');await expect(board().locator('tr[data-shot]')).toHaveCount(0);
 });
 await check('缓存页面和过滤状态下可重复跳转，重排后使用固定镜头ID而非旧镜号',async()=>{
  await selectAsset(a.id,'人物','陈川');await openLinks();const edited=structuredClone(record.project),shots=edited.scenes[0].shots,[target]=shots.splice(shots.findIndex(q=>q.id===targetId),1);shots.splice(6,0,target);record=await api('/storyboard/projects/'+a.id,{project:edited,expected_revision:record.revision},'PUT');await links().getByRole('button',{name:'查看镜 32',exact:true}).click();await highlighted(targetId,'07');
  await selectAsset(a.id,'人物','陈川');await openLinks();await links().getByRole('button',{name:'查看镜 01',exact:true}).click();await highlighted(firstId,'01');
 });
 await check('迟到的旧资产关联响应不覆盖另一个资产，读取失败显示原因且可刷新恢复',async()=>{
  await selectAsset(a.id,'人物','陈川');let release,seen;const released=new Promise(r=>release=r),captured=new Promise(r=>seen=r);held.add(release);const pattern=origin+'/api/project-assets/assets/'+actorId+'/shots';const handler=async route=>{const r=await route.fetch();seen();await released;await route.fulfill({response:r});};await context.route(pattern,handler);/* 详情打开时已读过一次关联；装好拦截后用「刷新关联」发出会迟到的那次请求 */await openLinks();await links().getByRole('button',{name:'刷新关联'}).click();await captured;
  await work().locator('.ca-card').filter({hasText:'不出场人物'}).click();await openLinks();await expect(links()).toContainText('尚无镜头明确关联');release();held.delete(release);await context.unroute(pattern,handler);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await expect(links().getByRole('button',{name:/查看镜/})).toHaveCount(0);
  const failure=origin+'/api/project-assets/assets/'+unusedId+'/shots';await context.route(failure,route=>route.fulfill({status:503,json:{error:'合成关联读取失败'}}));await links().getByRole('button',{name:'刷新关联'}).click();await expect(links().getByRole('alert')).toContainText('合成关联读取失败');await context.unroute(failure);await links().getByRole('button',{name:'刷新关联'}).click();await expect(links()).toHaveAttribute('aria-busy','false');await expect(links()).toContainText('尚无镜头明确关联');
 });
 await check('场景继承/本镜覆盖与道具可查看并跳转，不混用其他项目或未初始化资产',async()=>{
  await selectAsset(a.id,'场景','合成外景');assert.deepEqual(await work().getByRole('navigation',{name:'详情分区'}).getByRole('button').allTextContents(),['资料','参考图','出场镜头']);await openLinks();await expect(links().getByRole('button',{name:/查看镜/})).toHaveCount(2);await links().getByRole('button',{name:'查看镜 02',exact:true}).click();await highlighted(record.project.scenes[0].shots[1].id,'02');
  await selectAsset(a.id,'道具','合成包');await openLinks();await links().getByRole('button',{name:'查看镜 07',exact:true}).click();await highlighted(targetId,'07');
  await selectAsset(b.id,'人物','未初始化人物');await openLinks();await expect(links()).toContainText('尚未初始化分镜');await expect(links().getByRole('button',{name:/查看镜/})).toHaveCount(0);
 });
 await check('镜头在关联列表读取后被删除时明确提示，不高亮错误的首镜',async()=>{
  await selectAsset(a.id,'人物','陈川');await openLinks();const edited=structuredClone(record.project);edited.scenes[0].shots=edited.scenes[0].shots.filter(q=>q.id!==targetId);record=await api('/storyboard/projects/'+a.id,{project:edited,expected_revision:record.revision},'PUT');await links().getByRole('button',{name:'查看镜 07',exact:true}).click();/* 提示现在可能出现在分镜工作台或全局操作提示里 */await expect(page.getByText(/该关联镜头已删除/).first()).toBeVisible();await expect(board().locator('tr.sb-active-row')).toHaveCount(0);
 });
 await check('查看关联和跳转保留资产未保存资料，小屏无整页横向溢出',async()=>{
  await selectAsset(a.id,'人物','陈川');await work().getByLabel('基础信息',{exact:true}).fill('仅本地保留的资产草稿');await openLinks();await links().getByRole('button',{name:'查看镜 01',exact:true}).click();await highlighted(firstId,'01');await nav('项目资产');await work().getByRole('navigation',{name:'详情分区'}).getByRole('button',{name:'资料',exact:true}).click();await expect(work().getByLabel('基础信息',{exact:true})).toHaveValue('仅本地保留的资产草稿');assert.notEqual((await api('/project-assets/assets/'+actorId)).base_info,'仅本地保留的资产草稿');await openLinks();await page.setViewportSize({width:390,height:950});await links().scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(evidence,'associated-shots-mobile.png')});
 });
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);passed=true;
}catch(e){await page?.screenshot({path:path.join(evidence,'failure.png'),fullPage:true}).catch(()=>{});await fs.writeFile(path.join(evidence,'failure.txt'),e.stack);throw e;}
finally{
 for(const release of held)release();await context?.unrouteAll({behavior:'wait'});await browser?.close();if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');let timer;try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Owned test application close unknown')),15000))]);}finally{clearTimeout(timer);}const closed=logs.includes('APPLICATION_CLOSED_KNOWN');await fs.writeFile(path.join(evidence,'server.log'),logs);await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,external,dist,realModelCalls:0,resources:{browserClosed:!browser?.isConnected(),applicationClosedKnown:closed,tempRemoved:passed&&closed,...(!passed?{retained:temporary}:{})}},null,2));if(passed&&closed)await fs.rm(temporary,{recursive:true,force:true});assert.ok(closed);
}
