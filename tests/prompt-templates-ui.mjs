import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import Database from 'better-sqlite3';
import {PromptTemplates} from '../server/prompt-templates/store.mjs';
import {fixture,inputs,lifecycle} from './helpers/prompt-lifecycle.mjs';

const root=path.resolve(import.meta.dirname,'..');
const evidence=path.resolve(process.env.PROMPT_TEST_EVIDENCE||path.join(root,'collab/results/PROMPT-TEMPLATES-20261104'));
await fs.mkdir(evidence,{recursive:true});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'prompt-integrated-'));
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`;
let logs='',browser,page,cookie='',token='',passed=false;
const checks=[],errors=[],unexpected=[],requests=[];
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,PORT:String(port),NODE_ENV:'production',MEDIA_DATA_DIR:temporary,MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'1',SHIGUANG_AUDIO_ANALYSIS:'0',PATH:path.join(temporary,'no-tools')},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exit=new Promise(r=>child.once('exit',r));
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
const raw=(p,init={})=>fetch(origin+'/api'+p,{...init,headers:{cookie,origin,...init.headers}});
async function api(p,body,method){const r=await raw(p,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json','x-local-token':token},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
async function download(page,button){const event=page.waitForEvent('download');await button.click();return fs.readFile(await (await event).path());}
try{
 await expect.poll(()=>logs,{timeout:25000}).toContain(origin);
 const response=await fetch(origin+'/api/session'),identity=await response.json();token=identity.token;cookie=response.headers.get('set-cookie').split(';')[0];
 await check('Existing media server session/Host/origin/write-token protect all prompt APIs',async()=>{
  assert.equal(identity.app,'shiguang-local-media');assert.deepEqual((await api('/prompt-templates')).items,[]);
  assert.equal((await fetch(origin+'/api/prompt-templates')).status,401);
  assert.equal((await raw('/prompt-templates',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(fixture())})).status,403);
  assert.equal((await raw('/prompt-templates',{headers:{origin:'http://127.0.0.1:4328'}})).status,403);
  assert.equal((await raw('/prompt-templates/not-found')).status,400);
 });
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1600,height:1000},acceptDownloads:true});await context.addInitScript(()=>localStorage.setItem('shiguang.refreshSeconds','0'));
 context.on('request',r=>{const u=new URL(r.url());if(u.protocol.startsWith('http')){requests.push(u.pathname);if(u.origin!==origin)unexpected.push(r.url());}});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());await page.goto(origin);
 const nav=page.getByRole('navigation',{name:'主导航'}),item=name=>nav.getByRole('button',{name,exact:true});await item('提示词模板').click();
 const app=page.getByRole('region',{name:'提示词模板工作台'}),button=name=>app.getByRole('button',{name,exact:true});let templateId;
 await check('Native React workspace, same navigation/settings/service and no iframe',async()=>{
  await expect(app.getByRole('heading',{name:'从一个好用的模板开始'})).toBeVisible();await expect(page.locator('iframe')).toHaveCount(0);
  assert.deepEqual(await page.locator('#navigation-design > button').evaluateAll(xs=>xs.map(x=>x.getAttribute('aria-label'))),['项目','分镜设计','提示词模板']);
  await expect(page.getByRole('combobox',{name:'当前项目',exact:true})).toHaveCount(0);await expect(app.locator('.prompt-storage')).toContainText('SQLite');
  await button('选用内置模板').first().click();await expect(page.locator('.prompt-version-list article')).toHaveCount(4);await page.getByRole('button',{name:'关闭面板'}).click();
 });
 await check('Create/edit template, detect inputs and configure multiselect/number/optional fields',async()=>{
  await button('新建模板').first().click();const modal=page.getByRole('dialog',{name:'编辑提示词模板'});
  await modal.getByRole('textbox',{name:'模板名称',exact:true}).fill(fixture().name);await modal.getByRole('textbox',{name:'用途说明'}).fill(fixture().description);
  await modal.getByRole('textbox',{name:'模板正文',exact:true}).fill(fixture().body);await modal.getByRole('button',{name:'识别输入项'}).click();
  await modal.getByLabel('风格输入类型',{exact:true}).selectOption('multiselect');await modal.getByLabel('风格选项',{exact:true}).fill('纪实\n温暖\n悬疑');
  await modal.getByLabel('时长输入类型',{exact:true}).selectOption('number');await modal.getByLabel('时长默认值',{exact:true}).fill('15');
  await modal.getByLabel('补充必填',{exact:true}).uncheck();await modal.getByRole('button',{name:'保存模板',exact:true}).click();await expect(modal).toHaveCount(0);
  templateId=(await api('/prompt-templates')).items[0].id;await expect(app.getByRole('heading',{name:/合成情绪模板/})).toBeVisible();
 });
 const current=()=>api('/prompt-templates/'+templateId);
 await check('Real-time prompt, multiselect, autosaved draft, immutable generation record and TXT export',async()=>{
  await app.getByLabel('主题',{exact:true}).fill(inputs.主题);await app.getByRole('checkbox',{name:'温暖',exact:true}).check();await app.getByRole('checkbox',{name:'纪实',exact:true}).check();await app.getByLabel('时长',{exact:true}).fill('20');
  await expect(app.getByLabel('完整提示词内容')).toContainText('温暖、纪实');await expect(app.getByLabel('完整提示词内容')).not.toContainText('补充：');
  await expect(app.getByTestId('prompt-save-status')).toHaveText('草稿已保存到数据库');assert.deepEqual((await current()).draft.values,inputs);
  await button('保存记录').click();await expect.poll(async()=>(await api('/prompt-templates/'+templateId+'/records')).total).toBe(1);
  await button('保存记录').click();assert.equal((await api('/prompt-templates/'+templateId+'/records')).total,1);
  const bytes=await download(page,button('TXT'));assert.equal(bytes.toString(),(await api('/prompt-templates/'+templateId+'/records')).items[0].prompt);
  await item('项目').click();await item('提示词模板').click();await expect(app.getByLabel('主题',{exact:true})).toHaveValue(inputs.主题);
  await page.reload();await item('提示词模板').click();await expect(app.getByLabel('主题',{exact:true})).toHaveValue(inputs.主题);
 });
 await check('Complete version inspection, rollback creates v3 and keeps v2/old input/history',async()=>{
  await button('编辑模板').click();const modal=page.getByRole('dialog');await modal.getByLabel('模板正文',{exact:true}).fill(fixture().body+'\n第二版规则');await modal.getByRole('button',{name:'保存模板'}).click();
  await expect.poll(async()=>(await current()).current_version).toBe(2);await expect(button('下载旧版草稿')).toBeVisible();await button('历史版本').click();
  await expect(page.locator('.prompt-version-list article')).toHaveCount(2);await page.getByRole('button',{name:'回滚到 v1',exact:true}).click();await expect.poll(async()=>(await current()).current_version).toBe(3);
  assert.equal((await current()).definition.body,fixture().body);assert.equal((await api('/prompt-templates/'+templateId+'/versions')).length,3);
  await button('生成记录').click();await expect(page.locator('.prompt-version-list article')).toHaveCount(1);await page.getByText('查看本次输入与完整模板快照',{exact:true}).click();await expect(page.locator('.prompt-version-list')).toContainText(inputs.主题);await page.getByRole('button',{name:'关闭面板'}).click();
 });
 await check('Delete hides only; deleted list allows complete history and restore',async()=>{
  await button('删除模板').click();await expect(app.getByRole('heading',{name:'从一个好用的模板开始'})).toBeVisible();assert.equal((await api('/prompt-templates')).items.length,0);
  await button('已删除').click();await expect(button('恢复模板')).toBeVisible();await expect(app.getByLabel('主题',{exact:true})).toBeDisabled();assert.equal((await api('/prompt-templates/'+templateId+'/records')).total,1);
  await button('恢复模板').click();await button('正常').click();await expect(app.getByRole('heading',{name:/合成情绪模板/})).toBeVisible();assert.equal((await current()).deleted_at,null);
 });
 await check('Single-template JSON export/reimport keeps definition under a new stable ID',async()=>{
  const before=(await current()).definition,bytes=await download(page,button('导出模板'));assert.deepEqual(JSON.parse(bytes).template,before);
  await app.locator('input[type=file]').first().setInputFiles({name:'模板.json',mimeType:'application/json',buffer:bytes});await expect.poll(async()=>(await api('/prompt-templates')).items.length).toBe(2);
  const rows=(await api('/prompt-templates')).items;templateId=rows.find(r=>r.id!==templateId).id;assert.deepEqual((await current()).definition,before);
 });
 await check('Six outer themes also style prompt fields, preview and dialogs without losing inputs',async()=>{
  await app.getByLabel('主题',{exact:true}).fill('主题切换保留');const colors={};
  for(const theme of ['forest','dark','midnight','sepia','graphite','ocean']){
   await button('提示词界面设置').click();const settings=page.getByRole('dialog',{name:'界面设置'});await settings.locator('[data-theme-option="'+theme+'"]').click();await settings.getByRole('button',{name:'完成'}).click();await expect(page.locator('html')).toHaveAttribute('data-theme',theme);await expect(app.getByLabel('主题',{exact:true})).toHaveValue('主题切换保留');
   const color=await app.locator('.prompt-form').evaluate(el=>getComputedStyle(el).backgroundColor);colors[theme]=color;await button('编辑模板').click();assert.equal(await page.locator('.prompt-modal').evaluate(el=>getComputedStyle(el).backgroundColor),color);await page.getByRole('button',{name:'关闭面板'}).click();await page.screenshot({path:path.join(evidence,'prompt-'+theme+'.png')});
  }assert.ok(new Set(Object.values(colors)).size>=4);await fs.writeFile(path.join(evidence,'theme-colors.json'),JSON.stringify(colors,null,2));
 });
 await check('Conflict preserves local text, can export before explicitly rereading current database version',async()=>{
  await expect(app.getByTestId('prompt-save-status')).toHaveText('草稿已保存到数据库');const t=await current();await api('/prompt-templates/'+templateId,{definition:{...t.definition,description:'其他窗口编辑'},expected_revision:t.revision},'PUT');
  await app.getByLabel('主题',{exact:true}).fill('本地尚未保存的内容');await expect(app.getByRole('alert')).toContainText('模板已被更新');await expect(app.getByLabel('主题',{exact:true})).toHaveValue('本地尚未保存的内容');
  const bytes=await download(page,button('下载本次输入'));assert.equal(JSON.parse(bytes).主题,'本地尚未保存的内容');await button('重新读取').click();await expect(app.getByRole('alert')).toHaveCount(0);await expect(app.locator('.prompt-document-heading')).toContainText('其他窗口编辑');
 });
 await check('Complete backup/download/preview/restore including soft-deleted history, then harmless repeat restore',async()=>{
  const db=new Database(':memory:');const store=new PromptTemplates({db,dataDir:temporary}).init();const {backup}=lifecycle(store);db.close();
  await app.locator('input[type=file]').nth(1).setInputFiles({name:'完整备份.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});await expect(page.getByRole('dialog',{name:'恢复提示词备份'})).toContainText('已删除 1 个');await page.getByRole('button',{name:'确认恢复备份'}).click();await expect(page.getByRole('dialog',{name:'恢复提示词备份'})).toHaveCount(0);
  const bytes=await download(page,button('完整备份')),all=JSON.parse(bytes);const templateTables=all.templates?.tables||all.tables;assert.equal(templateTables.prompt_templates.length,3);assert.equal(templateTables.prompt_templates.filter(t=>t.deleted_at!==null).length,1);
  await app.locator('input[type=file]').nth(1).setInputFiles({name:'再次恢复.json',mimeType:'application/json',buffer:bytes});await expect(page.getByRole('dialog',{name:'恢复提示词备份'})).toContainText('将新增 0 行');await page.getByRole('button',{name:'确认恢复备份'}).click();await expect(page.getByRole('dialog',{name:'恢复提示词备份'})).toHaveCount(0);
  assert.ok((await fs.readdir(path.join(temporary,'backups'))).filter(n=>n.startsWith('prompt-templates-before-restore')||n.startsWith('prompt-codex-before-restore')).length===2);
 });
 await check('Desktop/tablet/mobile fit page width; no external requests, uncaught browser errors or material-data mixing',async()=>{
  for(const width of [1600,1280,1024,390,320]){await page.setViewportSize({width,height:950});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow at '+width);await page.screenshot({path:path.join(evidence,'prompt-width-'+width+'.png')});}
  assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);assert.deepEqual(await api('/projects'),[]);
 });
 await check('Drag saves fixed database order, keyboard works inside filters, edits and reload retain order, stale order never overwrites',async()=>{
  await page.setViewportSize({width:1600,height:1000});for(const name of ['排序验收甲','排序验收乙','排序验收丙'])await api('/prompt-templates',{...fixture(),name});await button('重新读取').click();const before=(await api('/prompt-templates')).items.map(t=>t.id);await expect(app.locator('.prompt-template-row')).toHaveCount(before.length);const chosen=await app.locator('.prompt-template.selected').locator('..').getAttribute('data-template-id'),source=before.at(-1),target=before[0];await app.locator('[data-template-id="'+source+'"]').getByRole('button',{name:/拖动排序/}).dragTo(app.locator('[data-template-id="'+target+'"]'));const moved=[source,...before.slice(0,-1)];await expect.poll(async()=>(await api('/prompt-templates')).items.map(t=>t.id)).toEqual(moved);assert.equal(await app.locator('.prompt-template.selected').locator('..').getAttribute('data-template-id'),chosen);const selected=await api('/prompt-templates/'+chosen);await api('/prompt-templates/'+chosen,{definition:{...selected.definition,description:'更新后顺序保持'},expected_revision:selected.revision},'PUT');assert.deepEqual((await api('/prompt-templates')).items.map(t=>t.id),moved);await page.reload();await expect(app.locator('.prompt-template-row')).toHaveCount(moved.length);assert.deepEqual(await app.locator('.prompt-template-row').evaluateAll(rows=>rows.map(row=>row.dataset.templateId)),moved);
  await app.getByLabel('搜索提示词模板').fill('排序验收');const shown=await app.locator('.prompt-template-row').evaluateAll(rows=>rows.map(row=>row.dataset.templateId));assert.equal(shown.length,3);const fullBefore=(await api('/prompt-templates')).items.map(t=>t.id);await app.locator('[data-template-id="'+shown[1]+'"]').getByRole('button',{name:/拖动排序/}).press('Alt+ArrowUp');const visibleNext=[shown[1],shown[0],shown[2]];let at=0;const filteredExpected=fullBefore.map(id=>shown.includes(id)?visibleNext[at++]:id);await expect.poll(async()=>(await api('/prompt-templates')).items.map(t=>t.id)).toEqual(filteredExpected);await expect.poll(()=>app.locator('.prompt-template-row').evaluateAll(rows=>rows.map(row=>row.dataset.templateId))).toEqual(visibleNext);await expect(app.locator('.prompt-order-handle').first()).toBeEnabled();await page.route('**/api/prompt-templates/order',route=>route.fulfill({status:409,json:{error:'模板列表或顺序已在别处更新，请重新读取后再拖动',code:'PROMPT_CONFLICT'}}));await app.locator('[data-template-id="'+visibleNext[1]+'"]').getByRole('button',{name:/拖动排序/}).press('Alt+ArrowUp');await expect(app.locator('.prompt-alert')).toContainText('顺序已在别处更新');assert.deepEqual((await api('/prompt-templates')).items.map(t=>t.id),filteredExpected);await page.unroute('**/api/prompt-templates/order');await page.screenshot({path:path.join(evidence,'template-order-desktop.png')});await page.setViewportSize({width:390,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(evidence,'template-order-mobile.png')});
 });
 await context.close();passed=true;
}catch(e){await page?.screenshot({path:path.join(evidence,'ui-failure.png')}).catch(()=>{});await fs.writeFile(path.join(evidence,'ui-failure.txt'),e.stack);throw e;}
finally{
 await browser?.close();if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');let timer;try{await Promise.race([exit,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Owned app did not close')),15000))]);}finally{clearTimeout(timer);}
 const known=logs.includes('APPLICATION_CLOSED_KNOWN');await fs.writeFile(path.join(evidence,'ui-server.log'),logs);assert.ok(known,'application shutdown proof');
 if(passed)await fs.rm(temporary,{recursive:true,force:true});await fs.writeFile(path.join(evidence,'ui-result.json'),JSON.stringify({passed,checks,errors,unexpected,requests,resources:{browserClosed:!browser?.isConnected(),applicationClosedKnown:known,tempRemoved:passed,...(!passed?{retainedEvidenceDirectory:temporary}:{})}},null,2));
}
