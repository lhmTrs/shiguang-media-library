import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=fileURLToPath(new URL('..',import.meta.url));
const code='WINDOWS_CLOUD_AUDIO_UNSUPPORTED';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function tree(root){const out=[];async function walk(dir){for(const name of (await fs.readdir(dir)).sort()){const f=path.join(dir,name),s=await fs.lstat(f);out.push({path:path.relative(root,f),dev:s.dev,ino:s.ino,mode:s.mode,mtime:s.mtimeMs,bytes:s.size,sha:s.isFile()?crypto.createHash('sha256').update(await fs.readFile(f)).digest('hex'):null});if(s.isDirectory())await walk(f);}}await walk(root);return out;}
async function fixture(t,platform){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-w03-platform-'))),project=path.join(root,'project');await fs.chmod(root,0o700);await fs.mkdir(project);
 for(const dir of ['server','src'])await fs.cp(path.join(repo,dir),path.join(project,dir),{recursive:true});
 for(const name of ['package.json','index.html','tsconfig.json'])await fs.copyFile(path.join(repo,name),path.join(project,name));
 await fs.symlink(path.join(repo,'node_modules'),path.join(project,'node_modules'),'dir');
 const helper=path.join(project,'server/cloud-audio-platform.mjs'),source=await fs.readFile(helper,'utf8');assert.equal(source.split('process.platform').length,2);await fs.writeFile(helper,source.replace('process.platform',JSON.stringify(platform)));
 t.diagnostic(JSON.stringify({root,policy:'RETAIN_ALL',actualPlatform:process.platform,simulatedCloudPlatform:platform,realWindows:'NOT_RUN',productPlatformOverride:false}));return{root,project};
}
async function seed(data){await fs.mkdir(data,{recursive:true});for(const dir of ['cloud-audio-tmp','cloud-upload-intents','asset-metadata-registration']){await fs.mkdir(path.join(data,dir),{mode:0o700});await fs.writeFile(path.join(data,dir,'unknown-retain.bin'),'SYNTHETIC_UNKNOWN_RETAIN',{mode:0o600});}
 await fs.writeFile(path.join(data,'cloud-audio-jobs.json'),JSON.stringify({version:1,jobs:[{id:crypto.randomUUID(),audioId:crypto.randomUUID(),shareId:crypto.randomUUID(),rootId:'synthetic-root',rootPath:'/synthetic/root',bytes:16,sha256:'a'.repeat(64),state:'queued'}]}),{mode:0o600});
 await fs.writeFile(path.join(data,'cloud-audio-provenance.json'),'SYNTHETIC_BROKEN_KEEP',{mode:0o600});await fs.writeFile(path.join(data,'cloud-upload-intents/intents.json'),'SYNTHETIC_BROKEN_KEEP',{mode:0o600});await fs.writeFile(path.join(data,'cloud-upload-host-registration.json'),'SYNTHETIC_BROKEN_KEEP',{mode:0o600});
}
const isCloud=p=>/^(cloud-audio-|cloud-upload-|asset-metadata-registration)/.test(p.split(path.sep)[0]);

test('Windows capability guards direct services and host, preserving uninspected history and memory-only disposal',async t=>{
 const {root,project}=await fixture(t,'win32'),data=path.join(root,'data');await seed(data);const before=await tree(data);
 const [{CloudAudioService},{CloudAudioUpload,manualAudioAdmission},{CloudUploadHost}]=await Promise.all(['cloud-audio-service','cloud-audio-upload','cloud-upload-host'].map(n=>import(pathToFileURL(path.join(project,'server',n+'.mjs')))));
 const lib={dataDir:data,db:{},locks:new Set()},auth={};
 const admission=manualAudioAdmission(async()=>({active:0,queued:0,statisticsKnown:false}));let invoked=false;for(const mode of ['download','upload'])await assert.rejects(admission[mode](()=>{invoked=true;}),e=>e.code===code);assert.equal(invoked,false);
 for(const enabled of [false,true]){
  const audio=new CloudAudioService(lib,{dataDir:data,cloudAuth:auth,enabled}),upload=new CloudAudioUpload(lib,{dataDir:data,cloudAuth:auth,enabled}),host=new CloudUploadHost(lib,{upload,sourceId:crypto.randomUUID()});await audio.init();await upload.init();await host.init();
  const status=await audio.status();assert.equal(status.enabled,false);assert.equal(status.platformCode,code);assert.equal(status.statisticsKnown,false);assert.equal(status.historyState,'UNINSPECTED');assert.equal(audio.currentActivity().known,false);assert.equal((await host.readiness()).ready,false);assert.equal((await host.readiness()).code,code);assert.equal(host.repair,null);assert.equal(host.merge,null);
  const skips=new Set(['constructor','init','status','currentActivity','neverStartedIO','dispose','track','clearStore','assertPlatform','readiness']);
  for(const object of [audio,upload,host])for(const [name,d] of Object.entries(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(object))))if(typeof d.value==='function'&&!skips.has(name))await assert.rejects(Promise.resolve().then(()=>object[name]()),e=>e.code===code,name);
  for(const fn of Object.values(host.fieldRegistration))await assert.rejects(Promise.resolve().then(fn),e=>e.code===code);
  assert.equal(await host.track(()=>Promise.resolve('LOCAL_READ_OK')),'LOCAL_READ_OK');assert.equal(audio.neverStartedIO(),true);assert.equal(upload.neverStartedIO(),true);
  assert.deepEqual(await upload.dispose(),{closed:true,unknown:false,neverStarted:true});assert.deepEqual(await audio.dispose(),{closed:true,unknown:false,neverStarted:true});assert.equal((await host.dispose()).closed,true);assert.equal(audio.currentActivity().known,false);
 }
 assert.deepEqual(await tree(data),before);await fs.writeFile(path.join(root,'tree-evidence.json'),JSON.stringify({before,after:await tree(data)},null,2));
});

test('partial POSIX initialization never regains never-started proof after references are cleared',async t=>{
 const {root,project}=await fixture(t,'darwin');const [{CloudAudioService},{CloudAudioUpload,manualAudioAdmission}]=await Promise.all(['cloud-audio-service','cloud-audio-upload'].map(n=>import(pathToFileURL(path.join(project,'server',n+'.mjs')))));
 let invoked=false;await assert.rejects(manualAudioAdmission(async()=>({active:0,queued:0,statisticsKnown:false})).upload(()=>{invoked=true;}),e=>e.code==='UPLOAD_STATE_UNKNOWN');assert.equal(invoked,false);
 const missing=path.join(root,'absent'),lib={dataDir:missing};const audio=new CloudAudioService(lib,{dataDir:missing,cloudAuth:{},enabled:true}),upload=new CloudAudioUpload(lib,{dataDir:missing,cloudAuth:{},enabled:true});await assert.rejects(audio.init());await assert.rejects(upload.init());assert.equal(audio.neverStartedIO(),false);assert.equal(upload.neverStartedIO(),false);assert.equal(audio.currentActivity().known,false);assert.deepEqual(await audio.dispose(),{closed:false,unknown:true});assert.deepEqual(await upload.dispose(),{closed:false,unknown:true});
 const supported=path.join(root,'supported');await fs.mkdir(supported,{mode:0o700});const normal=new CloudAudioService({dataDir:supported},{dataDir:supported,cloudAuth:{getState:()=>({configured:false,state:'unconfigured'})},enabled:true});await normal.init();assert.equal(normal.neverStartedIO(),false);assert.equal(normal.currentActivity().known,true);assert.equal(normal.currentActivity().allowed,true);assert.equal((await fs.stat(path.join(supported,'cloud-audio-tmp'))).mode&0o777,0o700);assert.equal((await normal.dispose()).closed,true);assert.equal(normal.neverStartedIO(),false);
});

test('controlled original App: unknown cloud history, no cloud filesystem calls, authenticated local reads, actual graceful exit', {timeout:60000}, async t=>{
 for(const feature of ['1','0']){
 const {root,project}=await fixture(t,'win32'),data=path.join(root,'data'),home=path.join(root,'home'),bin=path.join(root,'bin');await seed(data);await fs.mkdir(home);await fs.mkdir(bin);await fs.writeFile(path.join(bin,'swiftc'),'#!/bin/sh\nexit 1\n',{mode:0o700});await fs.mkdir(path.join(project,'dist'));await fs.writeFile(path.join(project,'dist/index.html'),'<html>synthetic API fixture</html>');const before=(await tree(data)).filter(x=>isCloud(x.path));
 const monitor=path.join(root,'monitor.mjs');await fs.writeFile(monitor,`import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';const data=${JSON.stringify(data)},report=${JSON.stringify(path.join(root,'io-monitor.json'))},hits=[];const save=fs.writeFileSync.bind(fs);const forbidden=p=>{if(typeof p!=='string')return false;const rel=path.relative(data,p);return !rel.startsWith('..')&&/^(cloud-audio-|cloud-upload-|asset-metadata-registration)/.test(rel.split(path.sep)[0]);};for(const object of [fs,fsp])for(const name of ['open','openSync','readFile','readFileSync','writeFile','writeFileSync','mkdir','mkdirSync','chmod','chmodSync','lstat','lstatSync','stat','statSync','realpath','realpathSync','readdir','readdirSync','opendir','rename','unlink','rm']){const original=object[name];if(typeof original!=='function')continue;object[name]=function(...args){if(args.some(forbidden)){hits.push(name);throw Object.assign(Error('W03_UNEXPECTED_CLOUD_IO'),{code:'W03_UNEXPECTED_CLOUD_IO'});}return original.apply(this,args);};}process.on('exit',()=>save(report,JSON.stringify({hits})));`);
 const port=await freePort(),origin='http://127.0.0.1:'+port;let log='';const child=spawn(process.execPath,['--import',monitor,'server/index.mjs'],{cwd:project,env:{PATH:bin+path.delimiter+process.env.PATH,HOME:home,LANG:'en_US.UTF-8',MEDIA_DATA_DIR:data,MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CLOUD_AUDIO_ENABLED:feature,SHIGUANG_AUDIO_ANALYSIS:'0',SHIGUANG_AUDIO_RUNTIME_CONFIG:path.join(root,'no-audio.json'),SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(root,'no-release.json'),PORT:String(port),NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);const exit=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));let ended=false;
 t.after(async()=>{if(!ended&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');let timer;const outcome=await Promise.race([exit,new Promise(r=>{timer=setTimeout(()=>r(null),15000);})]);clearTimeout(timer);await fs.writeFile(path.join(root,'app.log'),log);await fs.writeFile(path.join(root,'exit.json'),JSON.stringify({pid:child.pid,outcome,closedMarker:log.includes('APPLICATION_CLOSED_KNOWN')},null,2));assert.ok(outcome,'owned App did not settle; retained, no force kill');assert.deepEqual(outcome,{code:0,signal:null});});
 for(let i=0;i<400&&!log.includes('拾光素材库 '+origin);i++){if(child.exitCode!==null)throw Error('APP_EARLY_EXIT '+log.slice(-1000));await sleep(25);}assert.ok(log.includes('拾光素材库 '+origin));
 const sr=await fetch(origin+'/api/session'),cookie=sr.headers.get('set-cookie').split(';')[0],session=await sr.json();const call=(method,route,body)=>fetch(origin+'/api'+route,{method,headers:{cookie,origin,'x-local-token':session.token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 assert.equal((await fetch(origin+'/api/stats')).status,401);assert.equal((await call('GET','/stats')).status,200);assert.equal((await call('GET','/assets?kind=music')).status,200);
 const status=await (await call('GET','/cloud-audio/status')).json();assert.equal(status.enabled,false);assert.equal(status.platformCode,code);assert.equal(status.statisticsKnown,false);assert.equal(status.historyState,'UNINSPECTED');
 const tasks=await (await call('GET','/cloud-upload-tasks/control/status')).json();assert.equal(tasks.known,false);assert.equal(tasks.code,code);
 const readiness=await (await call('GET','/cloud-upload-host/readiness')).json();assert.equal(readiness.ready,false);assert.equal(readiness.code,code);
 for(const [route,body] of [['/cloud-audio/jobs',{}],['/cloud-audio/uploads',{}],['/cloud-upload-host/register',{}],['/asset-metadata-registration/preview',{}],['/cloud-management/audio-maintenance/plan',{}]]){const r=await call('POST',route,body);assert.equal(r.status,503,route);assert.ok(JSON.stringify(await r.json()).includes(code),route);}
 assert.deepEqual((await tree(data)).filter(x=>isCloud(x.path)),before);child.kill('SIGTERM');let timer;const outcome=await Promise.race([exit,new Promise(r=>{timer=setTimeout(()=>r(null),15000);})]);clearTimeout(timer);ended=true;assert.deepEqual(outcome,{code:0,signal:null});assert.ok(log.includes('APPLICATION_CLOSED_KNOWN'));assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'io-monitor.json'),'utf8')).hits,[]);const after=(await tree(data)).filter(x=>isCloud(x.path));assert.deepEqual(after,before);await fs.writeFile(path.join(root,'cloud-tree-evidence.json'),JSON.stringify({before,after,status,tasks,readiness,feature,serverRecord:(await tree(data)).find(x=>x.path==='server.json')||null},null,2));
 }
});

test('dispose rejects a positive close during pre-receive service metadata and before start locks exist', {timeout:20000}, async t=>{
 const {root,project}=await fixture(t,'darwin');
 const [{Library},{CloudAudioService}]=await Promise.all(['library','cloud-audio-service'].map(n=>import(pathToFileURL(path.join(project,'server',n+'.mjs')))));
 const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_GATE_TIMEOUT')),3000);})]);}finally{clearTimeout(timer);}};
 for(const phase of ['early-capacity','metadata']){
  const base=path.join(root,phase);await fs.mkdir(base,{mode:0o700});await fs.mkdir(path.join(base,'media'),{mode:0o700});const lib=await new Library(path.join(base,'data'),{directoryClassification:true}).init();lib.enqueue=()=>{};const media=await lib.addRoot(path.join(base,'media'),'sfx');
  let release,entered,details=0,inflight=false,streams=0;const gate=new Promise(r=>release=r),ready=new Promise(r=>entered=r),audioId=crypto.randomUUID(),shareId=crypto.randomUUID(),bytes=Buffer.alloc(300);
  const auth={epoch:4,getState:()=>({configured:true,state:'logged-in',accountId:'synthetic-a',deviceId:'synthetic-d',originHost:'synthetic.invalid'}),async proxy(){details++;if(phase==='metadata'&&details===2){inflight=true;entered();await gate;inflight=false;}return{audio:{id:audioId,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,contentType:'audio/wav',createdAt:'2026-10-24T00:00:00Z'},shares:[{id:shareId,ownerAccountId:'synthetic-owner',fileName:'synthetic.wav',mediaKind:'SFX',category:'test',subcategory:'synthetic',createdAt:'2026-10-24T00:00:00Z',version:0}]};},async openAudioContentStream(){streams++;throw Error('UNEXPECTED_STREAM');}};
  const service=await new CloudAudioService(lib,{dataDir:path.join(base,'data'),cloudAuth:auth,enabled:true}).init();const original=fs.readdir;let armed=phase==='early-capacity',start;
  if(armed)fs.readdir=async function(target,...args){if(armed&&target===path.join(base,'data','cloud-audio-tmp')){armed=false;inflight=true;entered();await gate;inflight=false;}return original.call(this,target,...args);};
  try{
   start=service.startDownload({audioId,shareId,rootId:media.id});start.catch(()=>{});if(phase==='metadata')await start;await bounded(ready);const before=service.currentActivity();assert.equal(before.allowed,false);if(phase==='early-capacity'){assert.equal(before.active,0);assert.equal(before.reservations,0);assert.ok(before.serviceOperations>0);}else{assert.equal(before.active,1);assert.equal(before.pending,1);assert.equal(before.reservations,1);assert.equal(before.receiverActive,0);}
   const disposed=await service.dispose();assert.deepEqual(disposed,{closed:false,unknown:true});assert.equal(inflight,true);assert.equal(streams,0);await fs.writeFile(path.join(base,'gated-dispose.json'),JSON.stringify({phase,before,disposed,metadataStillInFlight:inflight,streams},null,2));
  }finally{
   fs.readdir=original;auth.epoch++;release();if(start)await bounded(Promise.allSettled([start]));let idle=false;for(let n=0;n<300;n++){const a=service.currentActivity();if(a.known&&a.allowed){idle=true;break;}await sleep(5);}assert.equal(idle,true,'owned service gate and finally must actually settle');assert.equal(inflight,false);assert.equal(streams,0);const exit=await bounded(service.dispose());assert.equal(exit.closed,true);await fs.writeFile(path.join(base,'resource-exit.json'),JSON.stringify({gateReleased:true,metadataStillInFlight:inflight,streams,exit},null,2));lib.db.close();
  }
 }
});
