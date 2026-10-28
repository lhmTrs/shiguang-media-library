// Opt-in connected workflow, launched only by CloudLocalJavaE2eCheck.
// No page.route(), mocked cloud API, fake login, fake transfer or fake SQLite index.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {webkit} from '@playwright/test';
import {Library} from '../server/library.mjs';

const project=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const privateRoot=await fs.realpath(config.privateRoot),out=await fs.realpath(config.evidence);
assert(privateRoot.includes('cloud-local-java-'));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const checks=[],http=[],browserErrors=[],processes=[];
const result={checks,http,browserErrors,processes};
let browser;
let cleanupPromise;
const check=(name,condition,detail={})=>{checks.push({name,ok:!!condition,...detail});console.log(`${condition?'PASS':'FAIL'} ${name}`);assert(condition,name);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=20000){const end=Date.now()+ms;for(;;){const value=await fn();if(value)return value;assert(Date.now()<end,'bounded fixture wait expired');await delay(40);}}
async function port(){const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const n=server.address().port;await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));return n;}
function wave(){const b=Buffer.alloc(1_100_044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
const bytes=wave(),filename='合成雨声%_!.wav',category='音效',sub='环境',sentinel=Buffer.from('synthetic preexisting different content, must never overwrite');
Object.assign(result,{sha256:sha(bytes),bytes:bytes.length,filename,probe:'Java AudioProbe.inspect synthetic substitute',httpInterception:false});
Library.prototype.enqueue=function(){ }; // Seed and native metadata background only; real scan/index untouched.
async function seed(role){
 const root=path.join(privateRoot,role);await fs.mkdir(root,{mode:0o700});const data=path.join(root,'data'),media=path.join(root,'media');await fs.mkdir(data);await fs.mkdir(media);
 const home=path.join(root,'home'),tmp=path.join(root,'tmp');await fs.mkdir(home);await fs.mkdir(tmp);
 const lib=await new Library(data,{directoryClassification:true}).init();const registered=await lib.addRoot(media,'sfx');
 const target=path.join(media,category,sub,filename);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,role==='a'?bytes:sentinel,{flag:'wx'});
 let assetId=null;
 if(role==='a'){
  assetId=crypto.randomUUID();const stat=await fs.stat(target);
  lib.db.prepare("INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,category,sub,probe,capture_status) VALUES(?,?,?,?,?,'sfx',?,?,?,?,'done','done')").run(assetId,registered.id,target,filename,'wav',bytes.length,stat.mtimeMs,category,sub);
 }
 lib.db.close();
 const digest=sha(await fs.readFile(path.join(project,'server/trash.swift'))).slice(0,12);
 // Non-executed fixture marker prevents startup swift compilation. No trash route is exercised.
 await fs.writeFile(path.join(data,`trash-helper-${digest}`),'fixture-only-not-executable',{mode:0o600});
 return{role,root,data,media,target,home,tmp,rootId:registered.id,assetId};
}
async function start(local){
 const selected=await port();
 const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:local.home,TMPDIR:local.tmp,LANG:'en_US.UTF-8',E2E_PRIVATE_ROOT:privateRoot,MEDIA_DATA_DIR:local.data,MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_READONLY_FILES:'1',MEDIA_CLOUD_AUDIO_ENABLED:'1',SHIGUANG_AUDIO_ANALYSIS:'',SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(local.root,'absent-release.json'),PORT:String(selected),NODE_ENV:'production'};
 const child=spawn(process.execPath,['tests/cloud-local-java-local-entry.mjs'],{cwd:project,env,stdio:['ignore','pipe','pipe']});
 // Register every lifecycle listener before awaiting readiness or attaching other work.
 let failure=null;const ended=new Promise(resolve=>{child.once('error',error=>{failure=error;resolve();});child.once('close',(code,signal)=>{record.closed=true;record.exitCode=code;record.signal=signal;resolve();});});
 const record={role:local.role,pid:child.pid,closed:false,selectedPort:selected};processes.push(record);
 let stdout='',stderr='';child.stdout.on('data',c=>{stdout=(stdout+c).slice(-65536);});child.stderr.on('data',c=>{stderr=(stderr+c).slice(-65536);});
 local.child=child;local.ended=ended;local.record=record;local.logs=()=>({stdout,stderr});locals.push(local);
 await until(async()=>{assert(!failure&&!record.closed,'local server failed before ready');try{const state=JSON.parse(await fs.readFile(path.join(local.data,'server.json'),'utf8'));assert.equal(state.pid,child.pid);assert.equal(state.port,selected);return state;}catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return false;throw e;}},25000);
 local.base=`http://127.0.0.1:${selected}`;
 const response=await fetch(local.base+'/api/session',{signal:AbortSignal.timeout(5000)});assert.equal(response.status,200);const session=await response.json();local.cookie=response.headers.get('set-cookie').split(';')[0];local.token=session.token;
 return local;
}
const locals=[];
async function api(local,method,route,body){
 const response=await fetch(local.base+'/api'+route,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{cookie:local.cookie,'x-local-token':local.token,origin:local.base,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 http.push({side:local.role,method,path:'/api'+route,status:response.status,transport:'actual loopback HTTP'});
 const data=await response.json();assert.equal(response.status,200,`${method} ${route}: ${JSON.stringify(data)}`);return data;
}
async function page(local){
 const context=await browser.newContext({viewport:{width:1280,height:800}});
 await context.addCookies([{name:'media_session',value:local.cookie.split('=')[1],url:local.base,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage();local.page=page;local.context=context;
 page.on('console',m=>{if(m.type()==='error')browserErrors.push({side:local.role,kind:'console',message:m.text()});});
 page.on('pageerror',e=>browserErrors.push({side:local.role,kind:'pageerror',message:e.message}));
 page.on('requestfailed',r=>browserErrors.push({side:local.role,kind:'network',method:r.method(),url:r.url(),failure:r.failure()?.errorText}));
 page.on('request',r=>{const pathname=new URL(r.url()).pathname;if(r.method()==='POST'&&pathname==='/api/cloud-audio/uploads'){
  const value=r.postDataJSON();(result.browserUploadPayloads??=[]).push({side:local.role,path:pathname,keys:Object.keys(value).sort(),assetId:value.assetId,mediaKind:value.mediaKind,visibility:value.visibility,groupId:value.groupId,category:value.category,subcategory:value.subcategory});
 }});
 page.on('response',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/api/'))http.push({side:local.role,method:r.request().method(),path:url.pathname+url.search,status:r.status(),transport:'actual browser to Node HTTP'});});
 await page.goto(local.base+'/#/account',{waitUntil:'networkidle',timeout:25000});
 await page.getByRole('button',{name:'云端音频',exact:true}).click();
 await page.getByRole('heading',{name:'手动上传音乐 / 音效'}).waitFor();await page.waitForLoadState('networkidle');
 return page;
}
async function cleanup(){
 if(cleanupPromise)return cleanupPromise;
 cleanupPromise=(async()=>{
  if(browser)await browser.close();
  for(const local of locals){
   if(!local.record.closed){local.child.kill('SIGTERM');await Promise.race([local.ended,delay(4000)]);if(!local.record.closed){local.child.kill('SIGKILL');await Promise.race([local.ended,delay(4000)]);}}
   assert(local.record.closed,`unknown child exit, preserve private root ${local.role}`);
   const logs=local.logs();await fs.writeFile(path.join(out,`local-${local.role}.log`),logs.stdout+'\nSTDERR\n'+logs.stderr);
  }
 })();return cleanupPromise;
}
process.once('SIGTERM',()=>{cleanup().then(()=>process.exit(143)).catch(e=>{console.error(e.message);process.exit(144);});});
process.once('SIGINT',()=>{cleanup().then(()=>process.exit(130)).catch(()=>process.exit(144));});
try{
 const a=await start(await seed('a')),b=await start(await seed('b'));
 for(const local of[a,b]){
  await api(local,'POST','/cloud-auth/config',config[local.role].config);
  const state=await api(local,'POST','/cloud-auth/login',{username:config[local.role].username,password:config.password});
  check(`${local.role} actual device-bound login`,state.state==='logged-in'&&state.accountId===config[local.role].accountId);
  const profile=await api(local,'GET','/cloud-management/profile');check(`${local.role} current group capability`,profile.capabilities.groups.some(g=>g.groupId===config.groupId&&g.canReadShared));
  check(`${local.role} analysis engine remains disabled`,(await fetch(local.base+'/api/audio-engine/status',{headers:{cookie:local.cookie},signal:AbortSignal.timeout(5000)})).status===503);
 }
 // Direct counterexample for the exact original RequestInit-vs-business-body misuse.
 const wrongPayload={method:'POST',body:JSON.stringify({assetId:a.assetId,mediaKind:'SFX',visibility:'GROUP',groupId:config.groupId,category,subcategory:sub})};
 const wrongResponse=await fetch(a.base+'/api/cloud-audio/uploads',{method:'POST',headers:{cookie:a.cookie,'x-local-token':a.token,origin:a.base,'content-type':'application/json'},body:JSON.stringify(wrongPayload),signal:AbortSignal.timeout(5000)});
 const wrongError=await wrongResponse.json();result.originalMisuseCounterexample={keys:Object.keys(wrongPayload).sort(),wrappedBusinessKeys:Object.keys(JSON.parse(wrongPayload.body)).sort(),status:wrongResponse.status,code:wrongError.code};
 check('original wrapped RequestInit payload is rejected by actual Node',wrongResponse.status===400&&wrongError.code==='INVALID_REQUEST');
 browser=await webkit.launch();const pa=await page(a);
 await pa.getByLabel('选择上传素材').selectOption(a.assetId);await pa.getByLabel('上传可见范围').selectOption(config.groupId);
 await pa.getByLabel('云端主分类').fill(category);await pa.getByLabel('云端子分类').fill(sub);
 const submitted=pa.waitForResponse(r=>new URL(r.url()).pathname==='/api/cloud-audio/uploads'&&r.request().method()==='POST');
 await pa.getByRole('button',{name:'提交上传申请',exact:true}).click();const submittedResponse=await submitted;check('actual browser submit HTTP 200',submittedResponse.status()===200);await pa.getByText('待操作 · 待审批',{exact:true}).waitFor();
 let upload=(await api(a,'GET','/cloud-audio/uploads'))[0];check('A browser created real pending request',upload.state==='ready'&&upload.status==='PENDING'&&!!upload.requestId&&!upload.receipt);
 check('pending approval cannot publish/download',(await api(b,'GET','/cloud-audio/search?'+new URLSearchParams({q:'雨声%_!',groupId:config.groupId}))).total===0);
 const temp=path.join(privateRoot,'approval-request.tmp');await fs.writeFile(temp,JSON.stringify({requestId:upload.requestId,version:upload.version}),{mode:0o600});await fs.rename(temp,path.join(privateRoot,'approval-request.json'));
 await until(async()=>{try{return JSON.parse(await fs.readFile(path.join(privateRoot,'approval-ack.json'),'utf8')).approved;}catch(e){if(e.code==='ENOENT')return false;throw e;}},20000);
 await pa.getByRole('button',{name:'刷新审批状态',exact:true}).click();await pa.getByRole('button',{name:'上传音频',exact:true}).waitFor();
 await pa.getByRole('button',{name:'上传音频',exact:true}).click();await pa.getByText('已提交云端 · 审批通过',{exact:true}).waitFor({timeout:25000});
 upload=(await api(a,'GET','/cloud-audio/uploads'))[0];check('A real upload yields committed receipt',upload.state==='completed'&&upload.receipt?.sha256===sha(bytes)&&upload.receipt?.bytes===bytes.length);
 result.upload=upload;
 check('browser sends actual business fields with no RequestInit wrapper',result.browserUploadPayloads.length===1&&JSON.stringify(result.browserUploadPayloads[0].keys)===JSON.stringify(['assetId','category','groupId','mediaKind','subcategory','visibility'])&&result.browserUploadPayloads[0].assetId===a.assetId);
 await pa.screenshot({path:path.join(out,'a-upload-completed.png')});
 const pb=await page(b);await pb.getByLabel('云端音频关键词').fill('雨声%_!');await pb.getByLabel('查找小组').selectOption(config.groupId);await pb.getByRole('button',{name:'查找云端音频',exact:true}).click();await pb.getByText('匹配 1 个音频对象',{exact:true}).waitFor();
 const found=await api(b,'GET','/cloud-audio/search?'+new URLSearchParams({q:'雨声%_!',groupId:config.groupId,limit:'1',offset:'0'}));check('B keyword+group real Java search matches same receipt',found.total===1&&found.items[0].id===upload.receipt.audioId&&found.items[0].preferredShareId===upload.receipt.shareId);
 check('B literal no-match is true empty',(await api(b,'GET','/cloud-audio/search?'+new URLSearchParams({q:'nonexistent-synthetic',groupId:config.groupId}))).total===0);
 const beyond=await api(b,'GET','/cloud-audio/search?'+new URLSearchParams({q:'雨声%_!',groupId:config.groupId,limit:'1',offset:'1'}));check('B past-last-page retains authorized total',beyond.total===1&&beyond.items.length===0);
 await pb.screenshot({path:path.join(out,'b-keyword-group-search.png')});
 await pb.getByRole('button',{name:'下载',exact:true}).first().click();await pb.locator('.cw-audio-job').first().getByText('已加入素材库',{exact:false}).waitFor({timeout:25000});
 const first=(await api(b,'GET','/cloud-audio/jobs'))[0];check('B real Receiver/Installer/Library completed',first.state==='completed'&&first.receivedBytes===bytes.length&&!!first.assetId&&first.createdFile===true);
 const db=new Database(path.join(b.data,'library.sqlite'),{readonly:true});
 try{
  const asset=db.prepare('SELECT id,root_id,path,kind,size,category,sub FROM assets WHERE id=?').get(first.assetId);assert(asset);
  check('SQLite indexed correct root/type/size',asset.root_id===b.rootId&&asset.kind==='sfx'&&asset.size===bytes.length);
  const relative=path.relative(b.media,asset.path);check('SQLite and real path keep two-level classification',relative===path.join(category,sub,'合成雨声%_! (2).wav')&&asset.category===category&&asset.sub===sub);
  check('installed bytes hash equals A and Java receipt',sha(await fs.readFile(asset.path))===sha(bytes));
  check('preexisting same-name file is preserved',sha(await fs.readFile(b.target))===sha(sentinel));
  const count=db.prepare('SELECT COUNT(*) n FROM assets').get().n;
  await pb.getByRole('button',{name:'下载',exact:true}).first().click();await until(async()=>{const jobs=await api(b,'GET','/cloud-audio/jobs');return jobs.length===2&&jobs[0].state==='completed'?jobs[0]:false;},25000);
  const again=(await api(b,'GET','/cloud-audio/jobs'))[0];check('second actual HTTP download reuses same indexed asset',again.assetId===first.assetId&&again.createdFile===false&&db.prepare('SELECT COUNT(*) n FROM assets').get().n===count);
  check('source A bytes never modified',sha(await fs.readFile(a.target))===sha(bytes));
  result.download={first,again,sqlite:{...asset,path:relative},rowCount:count,sentinelSha256:sha(await fs.readFile(b.target)),installedSha256:sha(await fs.readFile(asset.path))};
 }finally{db.close();}
 await pb.locator('.cw-audio-job').first().getByText('已加入素材库',{exact:false}).waitFor({timeout:15000});
 await pb.screenshot({path:path.join(out,'b-library-completed.png'),fullPage:true});
 for(const local of[a,b]){await local.page.getByRole('button',{name:'个人安全',exact:true}).click();await local.page.waitForLoadState('networkidle');}
 await pb.goto(b.base,{waitUntil:'networkidle',timeout:20000});
 await pb.getByText('合成雨声%_! (2).wav',{exact:true}).first().waitFor({timeout:15000});
 check('B real Library page displays installed indexed asset',true);
 await pb.screenshot({path:path.join(out,'b-real-library.png'),fullPage:true});
 await cleanup();check('strict browser errors remain empty including teardown',browserErrors.length===0,{count:browserErrors.length});check('both owned local processes closed',processes.length===2&&processes.every(p=>p.closed));
 result.completed=true;
}catch(error){result.completed=false;result.failure={name:error.name,message:error.message};console.error(error.stack);process.exitCode=1;}
finally{
 try{await cleanup();}catch(error){result.cleanupFailure=error.message;process.exitCode=1;}
 await fs.writeFile(path.join(out,'node-evidence.json'),JSON.stringify(result,null,2)+'\n');
}
