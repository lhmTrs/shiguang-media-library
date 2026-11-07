import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {chromium,expect} from '@playwright/test';

const root=path.resolve(import.meta.dirname,'..');
const evidence=path.resolve(process.env.PROMPT_TEST_EVIDENCE||path.join(root,'collab/results/PROMPT-FIELD-NAME-20261106/browser'));
const build=path.resolve(process.env.PROMPT_TEST_BUILD||path.join(root,'dist'));
await fs.mkdir(evidence,{recursive:true});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'prompt-field-names-'));
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`;
let logs='',browser,page,cookie='',token='',passed=false;
const checks=[],errors=[],external=[];
const child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,PORT:String(port),NODE_ENV:'production',MEDIA_DATA_DIR:temporary,MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'1',SHIGUANG_AUDIO_ANALYSIS:'0',PATH:path.join(temporary,'no-tools')},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const exit=new Promise(r=>child.once('exit',r));
async function api(route,body){const r=await fetch(origin+'/api'+route,{method:body?'POST':'GET',headers:{cookie,origin,'content-type':'application/json','x-local-token':token},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,value:await r.json()};}
async function check(name,fn){await fn();checks.push(name);console.log('PASS '+name);}
try{
 await expect.poll(()=>logs,{timeout:25000}).toContain(origin);
 const response=await fetch(origin+'/api/session');({token}=await response.json());cookie=response.headers.get('set-cookie').split(';')[0];
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const context=await browser.newContext({viewport:{width:1470,height:1100}});
 await context.addInitScript(()=>localStorage.setItem('shiguang.refreshSeconds','0'));
 // Serve the candidate to this disposable browser without replacing the running product's dist.
 await context.route(origin+'/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/')return route.fulfill({path:path.join(build,'index.html'),contentType:'text/html'});
  if(/^\/assets\/[A-Za-z0-9_.-]+$/.test(pathname))return route.fulfill({path:path.join(build,pathname.slice(1)),contentType:pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'application/octet-stream'});
  return route.continue();
 });
 context.on('request',r=>{const u=new URL(r.url());if(u.protocol.startsWith('http')&&u.origin!==origin)external.push(r.url());});
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/#/prompt-templates');
 const app=page.getByRole('region',{name:'提示词模板工作台'}),button=name=>app.getByRole('button',{name,exact:true});
 const modal=page.getByRole('dialog',{name:'编辑提示词模板'}),key='原作 / 素材';let id;
 await check('Detect slash field and save single-select/default/required through the real API',async()=>{
  await button('新建模板').first().click();await modal.getByLabel('模板名称',{exact:true}).fill('斜杠字段页面验收');
  await modal.getByLabel('模板正文',{exact:true}).fill('创作依据：{{原作 / 素材}}\n\n内容：{{剧本大纲}}');
  await modal.getByRole('button',{name:'识别输入项'}).click();
  await modal.getByLabel(key+'输入类型',{exact:true}).selectOption('select');
  await modal.getByLabel(key+'选项',{exact:true}).fill('原作\n素材');await modal.getByLabel(key+'默认值',{exact:true}).fill('原作');
  await modal.getByLabel('剧本大纲默认值',{exact:true}).fill('合成剧本');await modal.getByRole('button',{name:'保存模板'}).click();await expect(modal).toHaveCount(0);
  const list=await api('/prompt-templates');assert.equal(list.value.items.length,1);id=list.value.items[0].id;
  assert.deepEqual((await api('/prompt-templates/'+id)).value.definition.fields[0],{key,type:'select',required:true,help:'',options:['原作','素材'],default:'原作'});
  await expect(app.getByLabel(key,{exact:true})).toHaveValue('原作');
 });
 await check('Selection compiles, autosaves and survives a full page reload',async()=>{
  await app.getByLabel(key,{exact:true}).selectOption('素材');await expect(app.getByLabel('完整提示词内容')).toContainText('创作依据：素材');
  await expect(app.getByTestId('prompt-save-status')).toHaveText('草稿已保存到数据库');
  await page.reload();await expect(app.getByLabel(key,{exact:true})).toHaveValue('素材');
 });
 await check('Edited field type and required checkbox persist in the next version',async()=>{
  await button('编辑模板').click();await expect(modal.getByLabel(key+'必填',{exact:true})).toBeChecked();
  await modal.getByLabel('剧本大纲输入类型',{exact:true}).selectOption('number');await modal.getByLabel('剧本大纲默认值',{exact:true}).fill('15');await modal.getByLabel('剧本大纲必填',{exact:true}).uncheck();
  await modal.getByRole('button',{name:'保存模板'}).click();await expect(modal).toHaveCount(0);
  const current=(await api('/prompt-templates/'+id)).value;assert.equal(current.current_version,2);assert.equal(current.definition.fields[1].type,'number');assert.equal(current.definition.fields[1].required,false);
  await button('编辑模板').click();await expect(modal.getByLabel('剧本大纲输入类型',{exact:true})).toHaveValue('number');await expect(modal.getByLabel('剧本大纲必填',{exact:true})).not.toBeChecked();
 });
 await check('Invalid field names show a specific error and retain the unsaved editor',async()=>{
  await modal.getByLabel('模板正文',{exact:true}).fill('{{非法@名称}}');await modal.getByRole('button',{name:'识别输入项'}).click();await modal.getByRole('button',{name:'保存模板'}).click();
  await expect(modal.getByRole('alert')).toContainText('「非法@名称」名称无效');await expect(modal.getByLabel('模板正文',{exact:true})).toHaveValue('{{非法@名称}}');
  assert.equal((await api('/prompt-templates/'+id)).value.current_version,2);await page.screenshot({path:path.join(evidence,'specific-field-error.png')});await modal.getByRole('button',{name:'取消',exact:true}).click();
  const bad=await api('/prompt-templates',{name:'服务端校验',body:'{{题目}}',fields:[{key:'题目',type:'invalid',required:true,default:''}]});assert.equal(bad.status,400);assert.match(bad.value.error,/「题目」类型无效/);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 });
 passed=true;
}catch(e){await page?.screenshot({path:path.join(evidence,'failure.png')}).catch(()=>{});throw e;}
finally{
 await browser?.close();if(child.exitCode===null&&!child.signalCode)child.kill('SIGTERM');let timer;
 try{await Promise.race([exit,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Owned app did not close')),15000))]);}finally{clearTimeout(timer);}
 const closedKnown=logs.includes('APPLICATION_CLOSED_KNOWN');await fs.writeFile(path.join(evidence,'server.log'),logs);
 assert.ok(closedKnown,'application shutdown proof');if(passed)await fs.rm(temporary,{recursive:true,force:true});
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed,checks,errors,external,applicationClosedKnown:closedKnown,tempRemoved:passed},null,2));
}
