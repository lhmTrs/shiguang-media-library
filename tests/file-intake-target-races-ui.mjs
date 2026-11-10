// Regression cases from independent review findings. Owned synthetic App/SQLite only.
// Fault injection delays/drops only this runner's local requests. No native UI.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {Receipts} from '../server/file-intake/files.mjs';

const root=path.resolve(import.meta.dirname,'..'), evidence=await fs.mkdtemp(path.join(os.tmpdir(),'intake-target-races-evidence-'));
const owned=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-independent-client-')));
const dataDir=path.join(owned,'data'),personal=path.join(owned,'personal_item');
const run=promisify(execFile),pause=ms=>new Promise(r=>setTimeout(r,ms));
const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const port=server.address().port;await new Promise(r=>server.close(r));
assert.notEqual(port,4317);
const origin='http://127.0.0.1:'+port;
let child,exit,exited,output='',browser,ctx,cookie='',token='',harnessError='';
const results=[],errors=[],requests=[],releases=[];
const head=(await run('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();

const tracked=['src/file-intake/TargetEditor.tsx','src/file-intake/FileIntakeWindow.tsx'];
async function treeHash(){const h=createHash('sha256');for(const p of tracked){h.update(p);h.update(await fs.readFile(path.join(root,p)));}return h.digest('hex');}
const sourceHashBefore=await treeHash();
const record=(id,status,detail)=>{results.push({id,status,...detail});console.log(status+' '+id);};
async function api(url,body,method){
  const r=await fetch(origin+'/api'+url,{method:method||(body===undefined?'GET':'POST'),headers:{cookie,...(body===undefined?{}:{'content-type':'application/json','x-local-token':token})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error),{status:r.status,code:v.code});return v;
}
async function ready(){for(let i=0;i<600;i++){if(exit)throw Error('Owned App exited before ready');try{const r=await fetch(origin+'/api/session');if(r.ok){const s=await r.json();cookie=r.headers.get('set-cookie')?.split(';')[0]||'';token=s.token;const rec=JSON.parse(await fs.readFile(path.join(dataDir,'server.json'),'utf8'));assert.equal(rec.pid,child.pid);assert.equal(rec.instanceId,s.instanceId);return;}}catch{}await pause(50);}throw Error('App ready timeout');}
async function stop(){if(!child||exit)return;child.kill('SIGTERM');let timer;try{await Promise.race([exited,new Promise((_,rej)=>{timer=setTimeout(()=>rej(Error('OWNED_APP_CLOSE_UNKNOWN')),20000);})]);}finally{clearTimeout(timer);}assert.deepEqual(exit,{code:0,signal:null});assert.match(output,/APPLICATION_CLOSED_KNOWN/);}
async function pageFor(h){const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/#/file-intake/'+h.id);await expect(p.getByRole('heading',{name:'收纳素材到拾光',exact:true})).toBeVisible();return p;}
const field=(p,label,id)=>p.getByLabel(label+' '+id,{exact:true});
const confirm=p=>p.getByRole('button',{name:'确认收纳',exact:true});
async function photoProject(p,id,project){await field(p,'收纳范围',id).selectOption('project');await field(p,'目标项目',id).selectOption(project);await expect(confirm(p)).toBeEnabled();}
async function done(id){for(let i=0;i<500;i++){const b=await api('/file-intake/batches/'+id);if(!['queued','running'].includes(b.status))return b;await pause(30);}throw Error('batch terminal timeout');}
async function blockConfirm(p){await p.route('**/api/file-intake/handoffs/*/confirm',route=>route.abort('failed'));await confirm(p).click();await expect(p.getByRole('button',{name:'核对原提交结果',exact:true})).toBeVisible();}
async function shot(p,name){await p.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});}

try{
  child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:personal,MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',CODEX_HOME:path.join(owned,'codex'),CODEX_BIN:path.join(owned,'no-codex')},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);exited=new Promise(r=>child.once('exit',(code,signal)=>{exit={code,signal};r(exit);}));
  await ready();
  const png=path.join(owned,'苏禾_日常.png'),video=path.join(owned,'独立视频.mp4'),music=path.join(owned,'独立音乐.wav'),sfx=path.join(owned,'独立音效.wav');
  // Valid codecs and pixels, generated from constants; no user media.
  await run('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-f','lavfi','-i','color=c=blue:s=32x32','-frames:v','1','-threads','1',png]);
  await run('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-f','lavfi','-i','color=c=red:s=32x32:r=10','-t','0.3','-c:v','libx264','-pix_fmt','yuv420p',video]);
  for(const [p,freq]of [[music,440],[sfx,880]])await run('/opt/homebrew/bin/ffmpeg',['-loglevel','error','-f','lavfi','-i','sine=frequency='+freq+':duration=0.25','-c:a','pcm_s16le',p]);
  const receipts=await new Receipts(dataDir).init();
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  ctx=await browser.newContext({viewport:{width:1100,height:900}});ctx.setDefaultTimeout(5000);
  await ctx.route('**/*',route=>{const u=new URL(route.request().url());if(u.protocol.startsWith('http')&&u.origin!==origin){errors.push('External request blocked '+u.origin);return route.abort();}return route.continue();});
  ctx.on('request',r=>{if(r.url().startsWith(origin+'/api/file-intake/'))requests.push({method:r.method(),url:r.url().slice(origin.length),body:r.postData()});});

  // Four media destinations, actual folder creation, durable backend readback.
  const mixed=await receipts.handoff([png,video,music,sfx]),p=await pageFor(mixed);
  const ids=mixed.files.map(f=>f.id);
  await expect(confirm(p)).toBeDisabled();await field(p,'素材类型',ids[2]).selectOption('music');await expect(confirm(p)).toBeDisabled();await field(p,'素材类型',ids[3]).selectOption('sfx');
  for(const id of ids)await expect(field(p,'目标分类',id)).toHaveValue('');
  const sfxSection=p.getByRole('region',{name:'收纳设置 独立音效.wav',exact:true});
  await sfxSection.getByText('新建分类文件夹',{exact:true}).click();await field(p,'新分类名称',ids[3]).fill('环境');await sfxSection.getByRole('button',{name:'创建分类',exact:true}).click();await expect(field(p,'目标分类',ids[3])).toHaveValue('环境');
  await field(p,'新分类名称',ids[3]).fill('室内');await sfxSection.getByRole('button',{name:'创建分类',exact:true}).click();await expect(field(p,'目标分类',ids[3])).toHaveValue('环境/室内');
  await fs.access(path.join(personal,'system_sfx','环境','室内'));
  await expect(confirm(p)).toBeEnabled();await shot(p,'four-media-before-confirm');await confirm(p).click();await expect(p.getByText('任务已接收，请在网页顶栏“文件任务”查看后续进度。',{exact:true})).toBeVisible();
  const accepted=JSON.parse(requests.find(r=>r.url.endsWith('/'+mixed.id+'/confirm')).body),batch=await done(accepted.requestId);
  assert.equal(batch.status,'completed');assert.deepEqual(batch.items.map(i=>i.destination.kind),['photo','video','music','sfx']);assert.ok(batch.items.every(i=>i.status==='ready'&&i.destinationLabel));
  for(const item of batch.items){const a=await api('/assets/'+item.assetId);assert.equal(a.kind,item.destination.kind);if(a.kind==='sfx'){assert.equal(a.category,'环境');assert.equal(a.sub,'室内');}}
  for(const src of [png,video,music,sfx])await fs.access(src);
  const next=await receipts.handoff([sfx]),other=await browser.newContext(),np=await other.newPage();await np.goto(origin+'/#/file-intake/'+next.id);await field(np,'素材类型',next.files[0].id).selectOption('sfx');await expect(field(np,'目标分类',next.files[0].id)).toHaveValue('环境/室内');await expect(np.getByRole('radio',{name:/复制并保留原文件/})).toBeChecked();await other.close();
  record('C0-four-media-actual-app','PASS',{requestId:batch.id,kinds:batch.items.map(i=>i.destination.kind),destinations:batch.items.map(i=>i.destination),anotherBrowserContextPreset:true});await p.close();

  // Unknown submission: a stale category must stay visibly fixed, not root.
  await api('/file-intake/categories/video',{directory:'',name:'原定分类'});
  const unknown=await receipts.handoff([video]),u=await pageFor(unknown),uid=unknown.files[0].id;
  await field(u,'收纳范围',uid).selectOption('library');await expect(field(u,'目标分类',uid)).toBeEnabled();await field(u,'目标分类',uid).selectOption('原定分类');await expect(confirm(u)).toBeEnabled();await blockConfirm(u);
  const journal=await u.evaluate(id=>sessionStorage.getItem('shiguang.file-intake.'+id),unknown.id);
  await fs.rmdir(path.join(personal,'system_video','原定分类'));await u.reload();await expect(u.getByRole('button',{name:'核对原提交结果',exact:true})).toBeVisible();await expect(field(u,'目标分类',uid)).toBeDisabled();
  await expect(field(u,'目标分类',uid)).toHaveValue('原定分类');
  assert.equal(await u.evaluate(id=>sessionStorage.getItem('shiguang.file-intake.'+id),unknown.id),journal);
  await u.getByRole('button',{name:'核对原提交结果',exact:true}).click();await expect(u.locator('.fi-confirm > .fi-error')).toContainText('尚未取得权威批次回执');
  const unknownPosts=requests.filter(r=>r.method==='POST'&&r.url.endsWith('/'+unknown.id+'/confirm')).length;assert.equal(unknownPosts,1);
  await shot(u,'unknown-category-changed-to-root');record('C1-frozen-missing-category-preserved','PASS',{expected:'原定分类 stays fixed even if unavailable',actual:await field(u,'目标分类',uid).inputValue(),original:JSON.parse(journal),journalUnchanged:true,confirmPosts:unknownPosts});await u.close();

  const project=await api('/projects',{name:'独立人物项目',software:'',note:''});
  // Explicit names survive a matching intermediate filename and subsequent renames.
  const manual=await receipts.handoff([png]),m=await pageFor(manual),mid=manual.files[0].id;await photoProject(m,mid,project.id);
  await field(m,'人物名',mid).fill('林舟');
  await m.getByText('修改导入后的文件名',{exact:true}).click();await field(m,'副本名称',mid).fill('林舟_夜行.png');await expect(field(m,'人物名',mid)).toHaveValue('林舟');
  await field(m,'副本名称',mid).fill('周扬_便装.png');await expect(field(m,'人物名',mid)).toHaveValue('林舟');await expect(confirm(m)).toBeEnabled();
  await shot(m,'manual-character-overwritten');record('C2-manual-name-survives-renames','PASS',{steps:['source 苏禾_日常.png','explicit character 林舟','rename 林舟_夜行.png','rename 周扬_便装.png'],expected:'林舟',actual:await field(m,'人物名',mid).inputValue()});

  // The serialized submit intentionally lacks draft names; reload must still show the proposal.
  await blockConfirm(m);const imageJournal=await m.evaluate(id=>sessionStorage.getItem('shiguang.file-intake.'+id),manual.id);await m.reload();await expect(m.getByRole('button',{name:'核对原提交结果',exact:true})).toBeVisible();await expect(field(m,'人物名',mid)).toBeDisabled();await expect(field(m,'人物名',mid)).toHaveValue('林舟');await expect(field(m,'造型名',mid)).toHaveValue('便装');
  await shot(m,'unknown-image-target-blank');record('C3-frozen-image-target-restored','PASS',{expected:'Show immutable imageProposal character/look',actual:{character:await field(m,'人物名',mid).inputValue(),look:await field(m,'造型名',mid).inputValue()},original:JSON.parse(imageJournal)});await m.close();

  // Async create returns after an explicit new media-kind choice; it must not undo it.
  const race=await receipts.handoff([music]),r=await pageFor(race),rid=race.files[0].id;
  await field(r,'素材类型',rid).selectOption('music');await expect(confirm(r)).toBeEnabled();
  const section=r.getByRole('region',{name:'收纳设置 独立音乐.wav',exact:true});await section.getByText('新建分类文件夹',{exact:true}).click();await field(r,'新分类名称',rid).fill('慢回应分类');
  let fetchedResolve;const fetched=new Promise(resolve=>fetchedResolve=resolve);let release;const gate=new Promise(resolve=>release=resolve);releases.push(release);
  await r.route('**/api/file-intake/categories/music',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();fetchedResolve();await gate;await route.fulfill({response});});
  await section.getByRole('button',{name:'创建分类',exact:true}).click();await fetched;
  await field(r,'素材类型',rid).selectOption('sfx');await expect(field(r,'素材类型',rid)).toHaveValue('sfx');release();
  await expect(section.getByRole('button',{name:'创建分类',exact:true})).toBeVisible();await expect(field(r,'新分类名称',rid)).toHaveValue('');await expect(field(r,'素材类型',rid)).toHaveValue('sfx');await expect(field(r,'目标分类',rid)).toHaveValue('');
  await shot(r,'late-folder-response-reverts-audio-kind');record('C4-late-category-response-ignored','PASS',{explicitLatestChoice:'sfx',actual:await field(r,'素材类型',rid).inputValue(),actualDirectory:await field(r,'目标分类',rid).inputValue(),fault:'Delay only the real POST response after folder is created'});await r.close();

  // Deferred source verification waits before loading the real preview.
  const delayed=await receipts.handoff([png],{deferFingerprint:true}),d=await pageFor(delayed),did=delayed.files[0].id;
  const img=d.getByRole('img',{name:'苏禾_日常.png',exact:true});await expect(img).toHaveCount(0);
  const before={deferred:true};
  await receipts.prepareHandoff(delayed.id);await expect(confirm(d)).toBeEnabled();await expect(d.getByText('正在后台核验原文件，可先选择项目和文件夹；完成后即可确认收纳。',{exact:true})).toHaveCount(0);
  await expect.poll(()=>img.evaluate(e=>e.naturalWidth)).toBeGreaterThan(0);
  const after=await img.evaluate(e=>({complete:e.complete,width:e.naturalWidth,src:e.getAttribute('src')}));
  const preview=await d.request.get(origin+after.src);assert.equal(preview.status(),200);
  assert.ok(after.width>0);await shot(d,'prepared-image-preview-still-broken');record('C5-preview-waits-until-ready','PASS',{before,after,endpointStatusWhenReady:preview.status(),handoffId:delayed.id});await d.close();

  // Removing and restoring a row creates a new editor instance. Its predecessor
  // must never be allowed to apply the delayed category response.
  const remount=await receipts.handoff([music]),rp=await pageFor(remount),rpid=remount.files[0].id;
  await field(rp,'素材类型',rpid).selectOption('music');await expect(confirm(rp)).toBeEnabled();
  const rs=rp.getByRole('region',{name:'收纳设置 独立音乐.wav',exact:true});await rs.getByText('新建分类文件夹',{exact:true}).click();await field(rp,'新分类名称',rpid).fill('移除前分类');
  let readFolder,releaseFolder,finishedFolder;const folderRead=new Promise(r=>readFolder=r),folderGate=new Promise(r=>releaseFolder=r),folderFinished=new Promise(r=>finishedFolder=r);releases.push(releaseFolder);
  await rp.route('**/api/file-intake/categories/music',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();readFolder();await folderGate;await route.fulfill({response});finishedFolder();});
  await rs.getByRole('button',{name:'创建分类',exact:true}).click();await folderRead;
  await rp.getByRole('button',{name:'移除 独立音乐.wav',exact:true}).click();await rp.getByRole('button',{name:'恢复 独立音乐.wav',exact:true}).click();await field(rp,'素材类型',rpid).selectOption('sfx');
  releaseFolder();await folderFinished;await pause(150);
  try{await expect(field(rp,'素材类型',rpid)).toHaveValue('sfx');record('C6-unmounted-category-response-ignored','PASS',{});}catch(e){record('C6-unmounted-category-response-ignored','FAIL',{message:e.message});process.exitCode=1;}await rp.close();

  // The server accepted the original request, but both the confirm response and
  // subsequent receipt read are lost. Recovery must remain read-only throughout.
  const acceptedUnknown=await receipts.handoff([png]),ap=await pageFor(acceptedUnknown),apid=acceptedUnknown.files[0].id;
  await photoProject(ap,apid,project.id);await field(ap,'人物名',apid).fill('回执核对人物');await expect(confirm(ap)).toBeEnabled();
  await ap.route('**/api/file-intake/handoffs/*/confirm',async route=>{await route.fetch();await route.abort('failed');});await confirm(ap).click();await expect(ap.getByRole('button',{name:'核对原提交结果',exact:true})).toBeVisible();
  const fixed=await ap.evaluate(id=>sessionStorage.getItem('shiguang.file-intake.'+id),acceptedUnknown.id);
  await ap.route('**/api/file-intake/batches/*',route=>route.abort('failed'));await ap.reload();
  try{await expect(ap.getByRole('button',{name:'核对原提交结果',exact:true})).toBeVisible();await expect(field(ap,'人物名',apid)).toBeDisabled();await expect(field(ap,'人物名',apid)).toHaveValue('回执核对人物');assert.equal(await ap.evaluate(id=>sessionStorage.getItem('shiguang.file-intake.'+id),acceptedUnknown.id),fixed);assert.equal(requests.filter(r=>r.method==='POST'&&r.url.endsWith('/'+acceptedUnknown.id+'/confirm')).length,1);record('C7-accepted-receipt-loss-keeps-frozen-target','PASS',{});}catch(e){record('C7-accepted-receipt-loss-keeps-frozen-target','FAIL',{message:e.message});process.exitCode=1;}await ap.close();

  // A pre-v2 request keeps its original project/folder instead of current prefs.
  const legacyFolder=await api('/project-videos/projects/'+project.id+'/folders',{requestId:crypto.randomUUID(),parentId:'root',name:'旧版固定文件夹'});
  const legacyFolderId=legacyFolder.id||legacyFolder.folder?.id;assert.ok(legacyFolderId);
  const old=await receipts.handoff([video]),lp=await pageFor(old),lid=old.files[0].id;
  const legacyInput={requestId:crypto.randomUUID(),projectId:project.id,folderId:legacyFolderId,mode:'copy',fileIds:[lid]};
  await lp.evaluate(({id,input})=>sessionStorage.setItem('shiguang.file-intake.'+id,JSON.stringify(input)),{id:old.id,input:legacyInput});await lp.reload();
  await expect(lp.getByRole('button',{name:'核对原提交结果',exact:true})).toBeVisible();
  for(let i=0;i<2;i++){await expect(field(lp,'收纳范围',lid)).toHaveValue('project');await expect(field(lp,'目标项目',lid)).toHaveValue(project.id);await expect(field(lp,'目标分类',lid)).toHaveValue(legacyFolderId);await expect(field(lp,'目标分类',lid)).toBeDisabled();if(i===0){await lp.getByRole('button',{name:'核对原提交结果',exact:true}).click();await expect(lp.locator('.fi-confirm > .fi-error')).toContainText('尚未取得权威批次回执');}}
  assert.deepEqual(await lp.evaluate(id=>JSON.parse(sessionStorage.getItem('shiguang.file-intake.'+id)),old.id),legacyInput);assert.equal(requests.filter(r=>r.method==='POST'&&r.url.endsWith('/'+old.id+'/confirm')).length,0);record('C8-legacy-journal-keeps-original-project-folder','PASS',{});await lp.close();
}catch(e){harnessError=e.stack||String(e);console.error(harnessError);process.exitCode=1;}
finally{
  for(const release of releases)release();
  await ctx?.close();await browser?.close();await stop();
  const probe=net.connect({host:'127.0.0.1',port});const portClosed=await new Promise(resolve=>{probe.once('connect',()=>{probe.end();resolve(false);});probe.once('error',()=>resolve(true));});
  const sourceHashAfter=await treeHash();const resources={exit,applicationClosedKnown:/APPLICATION_CLOSED_KNOWN/.test(output),browserClosed:!browser?.isConnected(),portClosed,sourceStable:sourceHashBefore===sourceHashAfter};
  await fs.writeFile(path.join(evidence,'cases-result.json'),JSON.stringify({head,owned,port,results,errors,harnessError,resources,sourceHashBefore,sourceHashAfter,requests},null,2));
  await fs.writeFile(path.join(evidence,'owned-server.log'),output);
  assert.ok(resources.sourceStable&&resources.portClosed&&resources.browserClosed&&resources.applicationClosedKnown);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({evidence,harnessError:!!harnessError,results:results.map(r=>({id:r.id,status:r.status})),resources}));
}
