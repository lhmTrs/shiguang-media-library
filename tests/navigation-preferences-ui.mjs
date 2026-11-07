import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium,expect} from '@playwright/test';
import {fixture} from './helpers/prompt-lifecycle.mjs';

const root=path.resolve(import.meta.dirname,'..'),evidence=path.resolve(process.env.NAV_TEST_EVIDENCE||'collab/results/NAVIGATION-PREFERENCES-20261104/browser');
await fs.mkdir(evidence,{recursive:true});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'navigation-ui-')),run=promisify(execFile);
const photo=path.join(temporary,'摄影照片'),video=path.join(temporary,'视频素材'),music=path.join(temporary,'合成音乐');
for(const dir of [photo,video,music])await fs.mkdir(dir);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
for(let n=1;n<=4;n++)await fs.writeFile(path.join(photo,`照片-${n}.png`),png);
await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=teal:s=320x180:d=1','-an','-c:v','libx264','-pix_fmt','yuv420p',path.join(video,'合成视频.mp4')]);
await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=10',path.join(music,'合成音频.wav')]);
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const origin=`http://127.0.0.1:${port}`;
let logs='',browser,page,passed=false,cookie,token;const checks=[],errors=[],external=[];
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,PORT:String(port),NODE_ENV:'production',MEDIA_DATA_DIR:path.join(temporary,'data'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'1',SHIGUANG_AUDIO_ANALYSIS:'0'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exited=new Promise(r=>child.once('exit',r));
async function api(p,body){const r=await fetch(origin+'/api'+p,{method:body?'POST':'GET',headers:{cookie,origin,'x-local-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,p);return r.json();}
async function check(name,fn){if(process.env.NAV_TEST_FILTER&&!new RegExp(process.env.NAV_TEST_FILTER).test(name))return;await fn();checks.push(name);console.log('PASS '+name);}
const nav=()=>page.getByRole('navigation',{name:'主导航'}),item=name=>nav().getByRole('button',{name,exact:true});
async function select(name){await item(name).click();}
async function settings(){await page.locator('.sidebar').getByRole('button',{name:'界面设置',exact:true}).click();return page.getByRole('dialog',{name:'界面设置'});}
async function groups(values){for(const [name,expanded] of Object.entries(values)){const button=page.locator('.sidebar').getByRole('button',{name,exact:true});if((await button.getAttribute('aria-expanded'))!==String(expanded))await button.click();}}
async function healthy(){assert.deepEqual(errors,[]);assert.deepEqual(external,[]);}
try{
 await expect.poll(()=>logs,{timeout:20000}).toContain(origin);const response=await fetch(origin+'/api/session'),session=await response.json();cookie=response.headers.get('set-cookie').split(';')[0];token=session.token;
 for(const [directory,kind]of [[photo,'photo'],[video,'video'],[music,'music']])await api('/roots',{path:directory,kind});
 await api('/prompt-templates',fixture());
 await expect.poll(async()=>{const jobs=(await api('/jobs')).jobs;return jobs.every(j=>j.status!=='running');},{timeout:20000}).toBe(true);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('shiguang.refreshSeconds','0'));
 context.on('request',r=>{const url=new URL(r.url());if(url.protocol.startsWith('http')&&url.origin!==origin)external.push(url.origin+url.pathname);});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#/materials');
 await check('Explicit prompt-template link refreshes in place; a collapsed active group remains collapsed after reload',async()=>{
  await page.goto(origin+'/#/prompt-templates');await expect(page.getByRole('region',{name:'提示词模板工作台'})).toBeVisible();await expect(item('提示词模板')).toHaveAttribute('aria-current','page');
  await groups({'素材查找':true,'项目设计和管理':false,'素材管理':false,'素材目录':false});await page.reload();await expect(page.getByRole('region',{name:'提示词模板工作台'})).toBeVisible();
  await expect(page.locator('.sidebar').getByRole('button',{name:'项目设计和管理',exact:true})).toHaveAttribute('aria-expanded','false');await expect(page.locator('#navigation-roots')).toBeHidden();await expect(item('素材查找')).toHaveAttribute('aria-expanded','true');
  await page.locator('.sidebar').screenshot({path:path.join(evidence,'navigation-collapsed.png')});
 });
 await check('Parent/child hierarchy has an actual text indent, guide line and a visible selected marker',async()=>{
  await page.goto(origin+'/#/prompt-templates');await groups({'项目设计和管理':true,'素材管理':true});
  const parent=await item('项目设计和管理').locator('span').boundingBox(),child=await item('提示词模板').locator('span').boundingBox();assert.ok(child.x-parent.x>=18);
  assert.notEqual(await page.locator('#navigation-design').evaluate(el=>getComputedStyle(el).borderLeftStyle),'none');assert.notEqual(await item('提示词模板').evaluate(el=>getComputedStyle(el).boxShadow),'none');
  await page.locator('.sidebar').screenshot({path:path.join(evidence,'navigation-hierarchy.png')});
 });
 await check('Column URLs, Back/Forward and home startup restore the right material or design view',async()=>{
  await select('摄影照片');await expect(page).toHaveURL(origin+'/#/photos');await select('视频素材');await expect(page).toHaveURL(origin+'/#/videos');await page.goBack();await expect(item('摄影照片')).toHaveAttribute('aria-current','page');await page.goForward();await expect(item('视频素材')).toHaveAttribute('aria-current','page');await page.reload();await expect(item('视频素材')).toHaveAttribute('aria-current','page');
  await page.goto(origin);await expect(page).toHaveURL(origin+'/#/videos');const other=await context.newPage();await other.goto(origin);await expect(other).toHaveURL(origin+'/#/videos');await other.close();
 });
 await check('Each column keeps its own list/grid choice and search/display preferences survive reload without restoring search text',async()=>{
  await select('摄影照片');await page.getByRole('button',{name:'列表视图',exact:true}).click();await expect(page.locator('.asset-table')).toBeVisible();
  await select('音乐');await page.getByRole('button',{name:'网格视图',exact:true}).click();await expect(page.locator('.asset-grid')).toBeVisible();await select('摄影照片');await expect(page.locator('.asset-table')).toBeVisible();
  await page.getByRole('combobox',{name:'关键词匹配方式'}).selectOption('any');await page.getByRole('checkbox',{name:'仅搜索名称',exact:true}).check();await page.getByRole('button',{name:'更多筛选',exact:true}).click();await page.getByRole('textbox',{name:'搜索素材',exact:true}).fill('不恢复的临时关键词');await page.reload();
  await expect(page.locator('.asset-table')).toBeVisible();await expect(page.getByRole('combobox',{name:'关键词匹配方式'})).toHaveValue('any');await expect(page.getByRole('checkbox',{name:'仅搜索名称',exact:true})).toBeChecked();await expect(page.getByRole('button',{name:'更多筛选',exact:true})).toHaveAttribute('aria-expanded','true');await expect(page.getByRole('textbox',{name:'搜索素材',exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'更多筛选',exact:true}).click();
 });
 await check('Photo/video result count and sort controls fit inside their toolbar and never overlap the cards on desktop/mobile',async()=>{
  for(const name of ['摄影照片','视频素材']){
   await page.setViewportSize({width:1920,height:1000});await select(name);await page.getByRole('button',{name:'网格视图',exact:true}).click();await expect(page.locator('.asset-card').first()).toBeVisible();
   for(const width of [2560,1920,1440,1280,1150,1120,1101,1024,768,390,320]){
    await page.setViewportSize({width,height:1000});await page.evaluate(()=>scrollTo(0,0));
    const metrics=await page.evaluate(()=>{const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom,height:r.height};};return{toolbar:box('.content-toolbar'),count:box('.result-count'),sort:box('.library-view-controls > select'),grid:box('.asset-grid'),card:box('.asset-card'),scroll:document.documentElement.scrollWidth,viewport:innerWidth};});
    assert.ok(metrics.count.y>=metrics.toolbar.y&&metrics.count.bottom<=metrics.toolbar.bottom+1,JSON.stringify(metrics));assert.ok(metrics.sort.y>=metrics.toolbar.y&&metrics.sort.bottom<=metrics.toolbar.bottom+1,JSON.stringify(metrics));assert.ok(metrics.grid.y>=metrics.toolbar.bottom-1,JSON.stringify(metrics));assert.ok(metrics.card.y>=metrics.toolbar.bottom,JSON.stringify(metrics));assert.ok(metrics.scroll<=metrics.viewport+1,JSON.stringify(metrics));
    if([1920,390].includes(width))await page.screenshot({path:path.join(evidence,(name==='摄影照片'?'photos':'videos')+'-'+width+'.png')});
   }
  }
 });
 await check('Directory group folds persistently; its management action stays accessible; a directory shortcut opens material results',async()=>{
  await page.setViewportSize({width:1440,height:1000});await groups({'素材目录':true});await expect(page.locator('#navigation-roots > button')).toHaveCount(3);await page.locator('.sidebar').getByRole('button',{name:'素材目录',exact:true}).click();await page.reload();await expect(page.locator('#navigation-roots')).toBeHidden();await page.getByRole('button',{name:'管理素材目录',exact:true}).click();await expect(page.getByRole('dialog',{name:'素材目录与任务'})).toBeVisible();await page.getByRole('dialog',{name:'素材目录与任务'}).getByRole('button',{name:'关闭窗口',exact:true}).click();
  await groups({'项目设计和管理':true,'素材目录':true});await select('提示词模板');await page.locator('#navigation-roots > button').filter({hasText:'摄影照片'}).click();await expect(page).toHaveURL(origin+'/#/materials');await expect(page.locator('.active-filter-bar')).toContainText('摄影照片');
 });
 await check('Local memory controls disable future restore; explicit URLs keep working; reset affects preferences and preserves data',async()=>{
  let dialog=await settings();await dialog.getByRole('checkbox',{name:'从首页继续上次栏目'}).uncheck();await dialog.getByRole('checkbox',{name:'记住侧栏展开状态'}).uncheck();await dialog.getByRole('checkbox',{name:'记住显示与搜索偏好'}).uncheck();await dialog.getByRole('button',{name:'完成',exact:true}).click();
  await select('视频素材');await page.reload();await expect(page).toHaveURL(origin+'/#/videos');await page.goto(origin);await expect(page).toHaveURL(origin+'/#/materials');await expect(item('素材管理')).toHaveAttribute('aria-expanded','false');await expect(page.getByRole('combobox',{name:'关键词匹配方式'})).toHaveValue('all');
  dialog=await settings();await dialog.getByRole('checkbox',{name:'从首页继续上次栏目'}).check();await dialog.getByRole('checkbox',{name:'记住侧栏展开状态'}).check();await dialog.getByRole('checkbox',{name:'记住显示与搜索偏好'}).check();await dialog.getByRole('button',{name:'重置导航与浏览偏好'}).click();await dialog.getByRole('button',{name:'完成',exact:true}).click();assert.equal((await api('/prompt-templates')).items.length,1);assert.equal((await api('/roots')).length,3);await healthy();
 });
 await check('All material/design/management links refresh correctly; unknown routes and malformed browser preferences fall back safely',async()=>{
  await groups({'素材查找':true,'项目设计和管理':true,'素材管理':true});
  const paths={'全部素材':'materials','摄影照片':'photos','视频素材':'videos','音效':'sound-effects','音乐':'music','收藏':'favorites','项目':'projects','分镜设计':'storyboards','提示词模板':'prompt-templates','分类管理':'categories','标签管理':'tags','重复音频':'duplicates','待确认':'review','离线素材':'offline','失效素材':'missing'};
  for(const [name,url]of Object.entries(paths)){await select(name);await expect(page).toHaveURL(origin+'/#/'+url);await page.reload();await expect(item(name)).toHaveAttribute('aria-current','page');await healthy();}
  await page.goto(origin+'/#/nonexistent');await expect(page).toHaveURL(origin+'/#/materials');
  await page.evaluate(()=>{for(const k of ['browserMemory.v1','navigationGroups.v1','assetLayouts.v1','searchPreferences.v1'])localStorage.setItem('shiguang.'+k,'{broken');localStorage.setItem('shiguang.lastView','constructor');localStorage.setItem('shiguang.volume','9');});await page.goto(origin);await expect(page).toHaveURL(origin+'/#/materials');await expect(item('素材查找')).toHaveAttribute('aria-expanded','true');await healthy();
 });
 await check('EDGE Audio volume is restored, while playback and asset selection stay off after a reload',async()=>{
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/#/music');await page.getByRole('button',{name:'网格视图',exact:true}).click();await expect(page.locator('.asset-card')).toHaveCount(1);await page.locator('.asset-card').getByRole('button',{name:'试听',exact:true}).click();const volume=page.getByRole('slider',{name:'音量',exact:true});await expect(volume).toBeVisible();await volume.fill('0.3');await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('shiguang.volume')))).toBe(.3);await page.reload();await expect(page.getByRole('slider',{name:'音量',exact:true})).toHaveCount(0);await page.locator('.asset-card').getByRole('button',{name:'试听',exact:true}).click();await expect(page.getByRole('slider',{name:'音量',exact:true})).toHaveValue('0.3');await page.getByRole('button',{name:'关闭播放器',exact:true}).click();await healthy();
 });
 await check('EDGE Login deep links and browser history coexist with material URLs without losing the remembered column',async()=>{
  await page.goto(origin+'/#/photos');await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page).toHaveURL(origin+'/#/login');await expect(page.locator('.login-card')).toBeVisible();await page.goBack();await expect(page).toHaveURL(origin+'/#/photos');await expect(item('摄影照片')).toHaveAttribute('aria-current','page');await page.goForward();await expect(page.locator('.login-card')).toBeVisible();await page.goto(origin+'/#/login');await expect(page.locator('.login-card')).toBeVisible();await page.getByRole('button',{name:'返回素材库',exact:true}).click();await expect(page).toHaveURL(origin+'/#/photos');await healthy();
 });
 await check('EDGE Six shared themes and compact/mobile sidebars keep grouped navigation visible, usable and unclipped',async()=>{
  await page.goto(origin+'/#/photos');await groups({'素材查找':true,'项目设计和管理':true,'素材管理':false,'素材目录':true});
  for(const theme of ['forest','dark','midnight','sepia','graphite','ocean']){const dialog=await settings();await dialog.locator('[data-theme-option="'+theme+'"]').click();await dialog.getByRole('button',{name:'完成',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await page.locator('.sidebar').screenshot({path:path.join(evidence,'navigation-'+theme+'.png')});}
  await page.getByRole('button',{name:'折叠侧栏',exact:true}).click();await page.reload();await expect(page.locator('.app')).toHaveClass(/nav-collapsed/);await item('项目设计和管理').click();await expect(page.locator('#navigation-design')).toBeHidden();await item('项目设计和管理').click();await select('提示词模板');await expect(page).toHaveURL(origin+'/#/prompt-templates');
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'展开导航',exact:true}).click();await expect(item('项目设计和管理')).toBeVisible();await select('视频素材');await expect(page).toHaveURL(origin+'/#/videos');await expect(page.locator('.sidebar')).not.toHaveClass(/visible/);await page.getByRole('button',{name:'展开导航',exact:true}).click();await page.locator('.sidebar').getByRole('button',{name:'素材目录',exact:true}).click();await expect(page.locator('#navigation-roots')).toBeHidden();await page.locator('.sidebar').screenshot({path:path.join(evidence,'navigation-mobile.png')});await healthy();
 });
 await check('EDGE Browser storage failures preserve a usable explicit route and in-session navigation',async()=>{
  const disabled=await browser.newContext({viewport:{width:1280,height:900}});await disabled.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage disabled','SecurityError');}}));const safePage=await disabled.newPage(),storageErrors=[];safePage.on('pageerror',e=>storageErrors.push(e.message));await safePage.goto(origin+'/#/prompt-templates');await expect(safePage.getByRole('region',{name:'提示词模板工作台'})).toBeVisible();await safePage.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'摄影照片',exact:true}).click();await expect(safePage).toHaveURL(origin+'/#/photos');await safePage.reload();await expect(safePage.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'摄影照片',exact:true})).toHaveAttribute('aria-current','page');assert.deepEqual(storageErrors,[]);await disabled.close();
 });
 await context.close();passed=true;
}catch(e){await page?.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(evidence,'failure.txt'),e.stack);throw e;}
finally{
 await browser?.close();if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');let timer;try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Application closure unconfirmed')),15000))]);}finally{clearTimeout(timer);}
 const known=logs.includes('APPLICATION_CLOSED_KNOWN');await fs.writeFile(path.join(evidence,'server.log'),logs);assert.ok(known);if(passed)await fs.rm(temporary,{recursive:true,force:true});
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,external,resources:{applicationClosedKnown:known,browserClosed:!browser?.isConnected(),tempRemoved:passed,...(!passed?{retainedEvidenceDirectory:temporary}:{})},scope:'Actual production React/HTTP/SQLite with brand-new synthetic photo/video/audio roots; no author data, paid calls, credentials or MySQL changes.'},null,2));
}
