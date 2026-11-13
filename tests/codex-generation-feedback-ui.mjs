// Fresh library + synthetic app-server only. Never invokes a real model.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';
import {codexTemplateUiFixture} from './helpers/codex-template-ui-fixture.mjs';
import {fixture,inputs} from './helpers/prompt-lifecycle.mjs';

const {evidence,temporary,origin,child,exited,logs,serveCandidate}=await codexTemplateUiFixture({
 name:'codex-generate-feedback',distEnv:'GENERATION_TEST_DIST',evidenceEnv:'GENERATION_TEST_EVIDENCE',readOnly:true,
});
const baseline=process.env.GENERATION_TEST_BASELINE==='1';
let browser,page,cookie,token,passed=false;const checks=[],errors=[],external=[],contexts=[];
async function api(p,body,method){const r=await fetch(origin+'/api'+p,{method:method||(body?'POST':'GET'),headers:{cookie,origin,'x-local-token':token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,p);return r.json();}
const chat=()=>page.getByRole('region',{name:'Codex 图文对话'}),button=()=>chat().locator('.codex-generate-button'),feedback=()=>chat().locator('.codex-generation-feedback');
const connectRoute='**/api/prompt-codex/connect';
const connection=()=>chat().locator('.codex-connection');
const reconnect=()=>chat().locator('.codex-header-actions').getByRole('button',{name:'重新连接',exact:true});
let project,template;
async function open(){
 const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
 await context.addInitScript(id=>{localStorage.setItem('shiguang.refreshSeconds','0');localStorage.setItem('shiguang.activeProject',id)},project.id);
 await serveCandidate(context,external);
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/#/prompt-templates');await expect(button()).toBeEnabled();
 if(baseline)await chat().locator('.codex-connect-button').click();
 else{
  await expect(connection()).toHaveText(/^\s*(尚未连接|已连接)\s*$/);
  if((await connection().textContent()).trim()==='尚未连接')await reconnect().click();
 }
 await expect(connection()).toHaveText('已连接');return context;
}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name)}
async function snapshot(name){await button().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,name+'.png')})}
try{
 await expect.poll(logs,{timeout:20000}).toContain(origin);const session=await fetch(origin+'/api/session');cookie=session.headers.get('set-cookie').split(';')[0];token=(await session.json()).token;
 template=await api('/prompt-templates',fixture());await api('/prompt-templates/'+template.id+'/draft',{template_revision:1,expected_revision:0,values:inputs},'PUT');project=await api('/projects',{name:'生成反馈合成项目'});
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 await check(baseline?'Baseline reproduces a silent draft-save stop next to the generate button':'Draft-save failure is visible beside the clicked button and sends no generation',async()=>{
  const context=await open();let turns=0;context.on('request',r=>{if(r.method()==='POST'&&/\/turns$/.test(r.url()))turns++});
  await context.route('**/api/prompt-templates/*/draft',route=>route.fulfill({status:409,json:{error:'合成草稿冲突，请重新核对'}}));
  await page.getByLabel('主题',{exact:true}).fill('草稿失败反馈验证');await button().click();
  if(baseline){await expect(page.getByText(/合成草稿冲突，请重新核对。可先下载/)).toBeVisible();await expect(feedback()).toHaveCount(0);await expect(button()).toBeEnabled();}
  else{await expect(feedback()).toContainText('尚未发送生成请求');await expect(feedback()).toContainText('合成草稿冲突');await expect(button()).toBeEnabled();}
  assert.equal(turns,0);await snapshot('draft-save-failure');await context.close();
 });
 if(!baseline){
 await check('Slow local conversation save shows step and seconds; a history-list failure cannot prevent generation',async()=>{
  const context=await open();let creates=0,turns=0;let release;
  await context.route('**/api/prompt-codex/conversations',async route=>{if(route.request().method()!=='POST')return route.continue();creates++;await new Promise(r=>release=r);await route.continue()});
  context.on('request',r=>{if(r.method()==='POST'&&/\/turns$/.test(r.url()))turns++});
  await page.clock.install();await button().click();await expect(feedback()).toContainText('正在保存模板对话');await expect.poll(()=>creates).toBe(1);await page.clock.fastForward(9000);await expect(feedback()).toContainText('9 秒');await expect(feedback()).toContainText('处理较慢');await button().dispatchEvent('click');assert.equal(creates,1);await snapshot('slow-save');
  await context.route('**/api/prompt-codex/conversations?*',route=>route.fulfill({status:503,json:{error:'合成历史列表故障'}}));release();await expect(chat().locator('.codex-status')).toHaveText('已完成');assert.equal(turns,1);await expect(feedback()).toContainText('已完成');await context.close();
 });
 await check('An explicit generation rejection is shown next to the button and can be corrected without replay',async()=>{
  const context=await open();let turns=0;await context.route('**/api/prompt-codex/conversations/*/turns',route=>{turns++;return route.fulfill({status:429,json:{error:'合成并发上限，请稍后发送'}})});
  await button().click();await expect(feedback()).toContainText('合成并发上限');await expect(button()).toBeEnabled();assert.equal(turns,1);await snapshot('generation-refused');await context.close();
 });
 await check('A lost generation receipt locks further sends; read-only recovery finds the original turn without replay',async()=>{
  const context=await open();let turns=0;await context.route('**/api/prompt-codex/conversations/*/turns',async route=>{turns++;await route.fetch();await route.abort('failed')});
  await button().click();await expect(feedback()).toContainText('提交结果待确认');await expect(button()).toBeDisabled();await button().dispatchEvent('click');assert.equal(turns,1);
  await feedback().getByRole('button',{name:'检查提交结果',exact:true}).click();await expect(feedback()).not.toContainText('提交结果待确认');await expect(chat().locator('.codex-status')).toHaveText('已完成');assert.equal(turns,1);await snapshot('recovered-original-turn');await context.close();
 });
 await check('A timeout releases the spinner; checks are read-only and an explicit retry retains the original UUID and payload',async()=>{
  const context=await open();let turns=0,release;const bodies=[];
  context.on('request',r=>{if(r.method()==='POST'&&/\/turns$/.test(r.url()))bodies.push(r.postDataJSON())});
  await context.route('**/api/prompt-codex/conversations/*/turns',async route=>{turns++;await new Promise(r=>release=r);await route.fulfill({status:503,json:{error:'合成未接收'}}).catch(()=>{})});
  // fake timers do not control AbortSignal.timeout, so accelerate only this browser API.
  await page.evaluate(()=>{const original=AbortSignal.timeout.bind(AbortSignal);AbortSignal.timeout=ms=>original(ms===30000?800:ms)});
  await button().click();await expect(feedback()).toContainText('等待超时');await expect(feedback()).toContainText('提交结果待确认');await expect(button()).toBeDisabled();
  await feedback().getByRole('button',{name:'检查提交结果',exact:true}).click();await expect(feedback()).toContainText('尚未查到这次生成');await expect(button()).toBeDisabled();assert.equal(turns,1);
  await page.setViewportSize({width:390,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await snapshot('unknown-mobile');release();await context.unroute('**/api/prompt-codex/conversations/*/turns');
  await feedback().getByRole('button',{name:'重试原提交',exact:true}).click();await expect(feedback()).not.toContainText('提交结果待确认');await expect(chat().locator('.codex-status')).toHaveText('已完成');assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);await context.close();
 });
 await check('Failed connection and missing project explain the blocked action at the bottom of the panel',async()=>{
  const context=await open();
  let statusReads=0;const writes=[];
  context.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/prompt-codex/'))writes.push(new URL(r.url()).pathname)});
  await context.route('**/api/prompt-codex/status',route=>{
   statusReads++;return route.fulfill({status:503,json:{error:'合成本机 Codex 不可用'}});
  });
  await button().click();await expect(feedback()).toContainText('合成本机 Codex 不可用');await expect(feedback()).toContainText('尚未发送生成请求');await expect(button()).toBeEnabled();
  await expect(connection()).toHaveText('连接失败');assert.equal(statusReads,1);assert.deepEqual(writes,[]);
  // 顶栏统一后不能再把项目清空：让项目列表真的为空（宿主没有当前项目），再看发送保护
  await context.route(u=>['/api/projects','/api/project-series'].includes(new URL(u).pathname),r=>r.request().method()==='GET'?r.fulfill({json:[]}):r.continue());await page.reload();await expect(page.locator('.ppb')).not.toHaveAttribute('data-project',/./);await expect(button()).toBeDisabled();await expect(chat().locator('.codex-generate-action')).toContainText('请先在顶部选择项目');await context.close();
 });
 await check('Unsupported-tool failure is explained next to follow-up; explicit reconnect preserves input and never sends it',async()=>{
  const toolTemplate=await api('/prompt-templates',{...fixture(),name:'合成工具错误模板'});await api('/prompt-templates/'+toolTemplate.id+'/draft',{template_revision:1,expected_revision:0,values:{...inputs,主题:'合成工具断连测试'}},'PUT');
  const context=await open();await page.locator('.prompt-template-list').getByRole('button').filter({hasText:'合成工具错误模板'}).click();await button().click();
  await expect(chat().locator('.codex-status')).toHaveText('失败',{timeout:12000});const inline=chat().locator('.codex-composer-feedback');await expect(inline).toHaveAttribute('role','alert');await expect(inline).toContainText('被拦截：外部工具');await expect(inline).toContainText('test_tools.private_lookup');
  await expect(connection()).toHaveText('连接失败');
  const input=chat().getByLabel('Codex 追问内容'),send=()=>chat().getByRole('button',{name:'发送追问',exact:true});
  const followup='为什么停止，请直接用文字解释';await input.fill(followup);
  let submits=0,connects=0;
  context.on('request',r=>{
   if(r.method()!=='POST')return;
   if(/\/turns$/.test(r.url()))submits++;
   if(new URL(r.url()).pathname==='/api/prompt-codex/connect')connects++;
  });
  await expect(send()).toBeDisabled();
  await input.press('Control+Enter');await expect(inline).toContainText('尚未连接，请点击“重新连接”');
  await expect(input).toHaveValue(followup);assert.equal(submits,0);assert.equal(connects,0);
  await context.route(connectRoute,route=>route.fulfill({status:503,json:{error:'合成重连失败，请检查本机服务'}}));
  await inline.getByRole('button',{name:'重新连接',exact:true}).click();await expect(inline).toContainText('合成重连失败');
  await expect(send()).toBeDisabled();await expect(input).toHaveValue(followup);assert.equal(submits,0);assert.equal(connects,1);await snapshot('followup-reconnect-error');
  await context.unroute(connectRoute);await inline.getByRole('button',{name:'重新连接',exact:true}).click();
  await expect(connection()).toHaveText('已连接');await expect(send()).toBeEnabled();await expect(input).toHaveValue(followup);assert.equal(submits,0);assert.equal(connects,2);
  await send().click();await expect(chat().locator('.codex-status').last()).toHaveText('已完成');assert.equal(submits,1);assert.equal(connects,2);await expect(input).toHaveValue('');
  const id=await chat().locator('.codex-history-list>button.selected').getAttribute('data-conversation-id'),saved=await api('/prompt-codex/conversations/'+id);assert.equal(saved.turns.length,2);assert.equal(saved.turns[0].error_code,'UNEXPECTED_TOOL_REQUEST');assert.equal(saved.turns[1].request.text,'为什么停止，请直接用文字解释');assert.equal(saved.turns[1].actual.contextRestored,true);
  await input.fill('连接已断开时保留这条追问');
  await context.route('**/api/prompt-codex/conversations/*/turns',async route=>{
   // Drop the real fake-Codex connection between the read-only status check and POST.
   await api('/prompt-codex/disconnect',{});await route.continue();
  });
  await send().click();await expect(inline).toContainText('请先连接 Codex');
  await expect(inline).not.toContainText('提交结果待确认');await expect(input).toHaveValue('连接已断开时保留这条追问');
  await expect(send()).toBeDisabled();await expect(inline.getByRole('button',{name:'重新连接',exact:true})).toBeEnabled();
  assert.equal(submits,2);assert.equal(connects,2);assert.equal((await api('/prompt-codex/conversations/'+id)).turns.length,2);
  await page.setViewportSize({width:390,height:1000});await input.scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(evidence,'followup-error-mobile.png')});await context.close();
 });
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);passed=true;
}catch(e){await page?.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(evidence,'failure.txt'),e.stack);throw e;}
finally{
 for(const c of contexts)await c.close().catch(()=>{});await browser?.close();if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');let timer;try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Application did not close')),15000))])}finally{clearTimeout(timer)}
 const known=logs().includes('APPLICATION_CLOSED_KNOWN');await fs.writeFile(path.join(evidence,'server.log'),logs());assert.ok(known);
 if(passed)await fs.rm(temporary,{recursive:true,force:true});await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,baseline,checks,errors,external,realModelCalls:0,applicationClosedKnown:known,browserClosed:!browser?.isConnected(),tempRemoved:passed,...(!passed?{retained:temporary}:{})},null,2));
}
