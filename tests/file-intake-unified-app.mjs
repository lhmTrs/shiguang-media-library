// Whole local App/API check with owned SQLite and synthetic media. No account,
// original library, real cloud or model; no native Finder registration.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {Receipts} from '../server/file-intake/files.mjs';
const root=path.resolve(import.meta.dirname,'..');
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-intake-app-')));
const dataDir=path.join(dir,'data'), evidence=path.resolve(process.env.FILE_INTAKE_APP_EVIDENCE||path.join(dir,'evidence'));
await fs.mkdir(evidence,{recursive:true});
const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
let child,exited,exit,output='',cookie='',token='',origin,passed=false;const checks=[];
function start() {
  child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,
    NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(dir,'personal_item'),
    MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',
    CODEX_HOME:path.join(dir,'codex'),CODEX_BIN:path.join(dir,'no-codex')},stdio:['ignore','pipe','pipe']});
  output='';exit=null;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);}));
}
async function ready() {
  const end=Date.now()+60000;
  while(Date.now()<end) {
    if(exit)throw Error('Owned App exited before ready');
    try {const record=JSON.parse(await fs.readFile(path.join(dataDir,'server.json'),'utf8'));
      if(record.pid===child.pid){origin=record.url;const r=await fetch(origin+'/api/session');const s=await r.json();
        if(r.ok&&s.app==='shiguang-local-media'){cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;token=s.token;return s;}}}
    catch{}await new Promise(r=>setTimeout(r,50));
  }throw Error('Owned App ready timeout');
}
async function api(url,body,method) {
  const r=await fetch(origin+'/api'+url,{method:method||(body?'POST':'GET'),headers:{cookie,...(body?{'Content-Type':'application/json','X-Local-Token':token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status,code:value.code});return value;
}
async function finishBatch(id) {
  const end=Date.now()+15000;
  while(Date.now()<end){const b=await api('/file-intake/batches/'+id);if(!['queued','running'].includes(b.status))return b;await new Promise(r=>setTimeout(r,30));}
  throw Error('Owned batch not terminal within budget');
}
async function stop() {
  if(!child||exit)return;
  child.kill('SIGTERM');let timer;
  try {await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_APP_CLOSE_UNKNOWN; no force kill attempted')),20000);})]);}
  finally {clearTimeout(timer);}
  assert.equal(exit.code,0);assert.equal(exit.signal,null);assert.match(output,/APPLICATION_CLOSED_KNOWN/);
}
let browser,context,page;
try {
  start();await ready();
  const project=await api('/projects',{name:'统一收纳合成项目',software:'',note:''});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
  const photo=path.join(dir,'苏禾_日常.png'),audio=path.join(dir,'合成音乐.wav');await fs.writeFile(photo,png);await fs.writeFile(audio,Buffer.concat([Buffer.from('RIFF'),Buffer.alloc(4096)]));
  const receipts=await new Receipts(dataDir).init(),handoff=await receipts.handoff([photo,audio]);
  const choices=await api('/file-intake/categories/music');assert.equal(choices.folders[0].id,'');
  await api('/file-intake/categories/music',{directory:'',name:'轻快'});
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  context=await browser.newContext({viewport:{width:1200,height:900}});page=await context.newPage();
  const fail=[];page.on('pageerror',e=>fail.push(e.message));
  const posts=[];page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/confirm'))posts.push(r.postDataJSON());});
  await page.goto(origin+'/#/file-intake/'+handoff.id);await expect(page.getByRole('heading',{name:'收纳素材到拾光'})).toBeVisible();
  // Per-file settings live in each file's 「改…」 panel since INTAKE-SIMPLE.
  const edit=async(p,file)=>{await p.locator('[data-file-id="'+file.id+'"]').click();return p.getByRole('dialog',{name:'收纳设置 '+file.name,exact:true});};
  const confirmButton=p=>p.locator('.fi-confirm-button');
  let panel=await edit(page,handoff.files[0]);
  await panel.getByRole('group',{name:'收纳范围 '+handoff.files[0].id}).getByRole('button',{name:'项目',exact:true}).click();
  await panel.getByLabel('目标项目 '+handoff.files[0].id).selectOption(project.id);
  await expect(panel.getByLabel('人物名 '+handoff.files[0].id)).toHaveValue('苏禾');await expect(panel.getByLabel('造型名 '+handoff.files[0].id)).toHaveValue('日常');
  await expect(panel.getByText('将新建人物：苏禾 · 将新建造型：日常')).toBeVisible();
  await panel.getByRole('button',{name:'完成',exact:true}).click();
  await expect(confirmButton(page)).toBeDisabled();
  panel=await edit(page,handoff.files[1]);
  await panel.getByLabel('素材类型 '+handoff.files[1].id).selectOption('music');
  await panel.getByLabel('目标分类 '+handoff.files[1].id).selectOption('轻快');
  await panel.getByRole('button',{name:'完成',exact:true}).click();
  await expect(confirmButton(page)).toBeEnabled();
  await confirmButton(page).click();
  await expect(page.getByText('任务已接收，请在网页顶栏“文件任务”查看后续进度。')).toBeVisible();assert.equal(posts.length,1);assert.equal(posts[0].version,2);
  const batch=await finishBatch(posts[0].requestId);assert.equal(batch.status,'completed',JSON.stringify(batch));assert.equal(batch.items.length,2);assert.ok(batch.items.every(i=>i.status==='ready'));
  const assets=await api('/project-assets/assets/'+batch.items[0].creativeAssetId);assert.equal(assets.name,'苏禾');assert.equal(assets.images.length,1);assert.ok(assets.looks.some(l=>l.name==='日常'&&l.default_image_id===assets.images[0].id));
  const music=await api('/assets/'+batch.items[1].assetId);assert.equal(music.kind,'music');assert.equal(music.category,'轻快');
  const prefs=await api('/file-intake/preferences');assert.equal(prefs.targets.photo.projectId,project.id);assert.equal(prefs.targets.music.directory,'轻快');
  assert.equal(JSON.stringify(prefs).includes('fileName'),false);assert.equal(JSON.stringify(prefs).includes('move'),false);
  checks.push('Actual UI+App mixed photo and audio confirm -> durable files/classification/person/look binding, once only');
  const newHandoff=await receipts.handoff([audio]),second=await context.newPage();await second.goto(origin+'/#/file-intake/'+newHandoff.id);const secondPanel=await edit(second,newHandoff.files[0]);await secondPanel.getByLabel('素材类型 '+newHandoff.files[0].id).selectOption('music');await expect(secondPanel.getByLabel('目标分类 '+newHandoff.files[0].id)).toHaveValue('轻快');
  await expect(second.getByRole('radio',{name:'复制',exact:true})).toBeChecked();assert.equal(posts.length,1);await second.close();
  checks.push('Backend preference restores category in another window, no automatic submit/source removal');
  const general=await receipts.handoff([photo]),generalBatch=await api('/file-intake/handoffs/'+general.id+'/confirm',{version:2,requestId:randomUUID(),mode:'copy',fileIds:[general.files[0].id],targets:[{fileId:general.files[0].id,destination:{kind:'photo',scope:'library',directory:''}}]});
  assert.equal((await finishBatch(generalBatch.id)).status,'completed');assert.equal((await api('/file-intake/preferences')).targets.photo.scope,'library');
  const bound=structuredClone(assets);bound.images.push({...bound.images[0],id:randomUUID()});
  await assert.rejects(api('/project-assets/assets/'+bound.id,{asset:bound,expected_revision:bound.revision+1},'PUT'));
  assert.equal((await api('/file-intake/preferences')).targets.photo.scope,'library');
  const saved=await api('/project-assets/assets/'+bound.id,{asset:bound,expected_revision:bound.revision},'PUT');
  assert.equal(saved.images.length,2);assert.equal(saved.looks[0].default_image_id,assets.looks[0].default_image_id);
  assert.equal((await api('/file-intake/preferences')).targets.photo.projectId,project.id);
  checks.push('Only a saved new image binding updates shared Finder project preset; conflict leaves preference and representative unchanged');
  const roots=await api('/roots');assert.ok(!roots.some(r=>path.basename(r.path)==='picture'));const systemMusic=roots.find(r=>path.basename(r.path)==='system_music');assert.ok(systemMusic);
  await assert.rejects(api('/roots/'+systemMusic.id+'/retire',{}),e=>e.code==='MANAGED_ROOT_PROTECTED');
  assert.equal(fail.length,0,fail.join('\n'));await fs.access(photo);await fs.access(audio);
  await context.close();context=null;await browser.close();browser=null;await stop();start();await ready();
  assert.equal((await api('/file-intake/batches/'+batch.id)).status,'completed');assert.equal((await api('/file-intake/preferences')).targets.music.directory,'轻快');
  checks.push('Normal App shutdown/restart retains exact task, backend target and source files');
  passed=true;
}finally{
  await context?.close();await browser?.close();await stop();
  await fs.writeFile(path.join(evidence,'unified-result.json'),JSON.stringify({passed,checks,exit,port,dir},null,2));
  await fs.writeFile(path.join(evidence,'owned-server.log'),output);console.log(JSON.stringify({passed,checks:checks.length,evidence,exit}));
}
