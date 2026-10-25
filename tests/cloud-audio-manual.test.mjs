// Disposable SQLite + synthetic files + mock cloud; not a real Java/TLS deployment check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable} from 'node:stream';
import {Library} from '../server/library.mjs';
import {CloudAudioUpload,manualAudioAdmission} from '../server/cloud-audio-upload.mjs';
import {CloudAudioService} from '../server/cloud-audio-service.mjs';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function wav(){const b=Buffer.alloc(1068,3);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(8000,24);b.writeUInt32LE(16000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(1024,40);return b;}
async function fixture(t){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'manual-audio-')));const src=path.join(base,'source'),dest=path.join(base,'dest');await fs.mkdir(src);await fs.mkdir(dest);
 const lib=await new Library(path.join(base,'data'),{directoryClassification:true}).init();lib.enqueue=()=>{}; // No native metadata/background probe in this fixture.
 const root=await lib.addRoot(src,'sfx');const downloadRoot=await lib.addRoot(dest,'sfx');const file=path.join(src,'synthetic.wav');const bytes=wav();await fs.writeFile(file,bytes);const id=crypto.randomUUID(),s=await fs.stat(file);
 lib.db.prepare("INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,probe,capture_status) VALUES(?,?,?,'synthetic.wav','wav','sfx',?,?,'done','done')").run(id,root.id,file,bytes.length,s.mtimeMs);
 const rows=new Map();const cloud={epoch:1,accountId:'synthetic-a',calls:[],lost:false,pending:false,unsupported:false,badDownload:false,
 getState(){return {configured:true,state:'logged-in',accountId:this.accountId,deviceId:'synthetic-device',originHost:'mock.local'};},
 async proxy(method,url,{body,epoch}={}){assert.equal(epoch,this.epoch);this.calls.push({method,url,body});
  if(url.startsWith('/media/audio/catalog/search')){const u=new URL(url,'https://mock.local');const all=[...rows.values()].filter(r=>r.receipt&&(u.searchParams.get('q')||'')!=='empty').map(r=>({id:r.receipt.audioId,sha256:r.declaredSha256,bytes:r.declaredBytes,contentType:'audio/wav',createdAt:'2026-10-24T00:00:00Z',preferredShareId:r.receipt.shareId,ownerAccountId:r.owner,fileName:r.fileName,mediaKind:r.mediaKind,category:r.category,subcategory:r.subcategory,visibleShareCount:1}));const offset=Number(u.searchParams.get('offset')),limit=Number(u.searchParams.get('limit'));return {items:all.slice(offset,offset+limit),total:all.length,hasMore:offset+limit<all.length};}
  if(url.startsWith('/media/audio/')){const r=[...rows.values()].find(r=>r.receipt?.audioId===url.split('/')[3]?.split('?')[0]);assert(r);return {audio:{id:r.receipt.audioId,sha256:r.declaredSha256,bytes:r.declaredBytes,contentType:'audio/wav',createdAt:'2026-10-24T00:00:00Z'},shares:[{id:r.receipt.shareId,ownerAccountId:r.owner,fileName:r.fileName,mediaKind:r.mediaKind,category:r.category,subcategory:r.subcategory,createdAt:'2026-10-24T00:00:00Z',version:0}]};}
  if(method==='POST'&&url==='/media/upload-requests'){let r=[...rows.values()].find(r=>r.requestId===body.requestId&&r.owner===this.accountId);if(!r){r={...body,id:crypto.randomUUID(),owner:this.accountId,declaredSha256:body.sha256,declaredBytes:body.bytes,status:this.pending?'PENDING':'APPROVED',version:0};rows.set(r.id,r);}return r;}
  const serverId=url.split('/')[3]?.split('?')[0],r=rows.get(serverId);assert(r&&r.owner===this.accountId);
  if(url.endsWith('/cancel')){if(r.receipt)throw Object.assign(Error('synthetic'),{code:'UPLOAD_ALREADY_COMMITTED'});r.status='CANCELLED';r.version++;return r;}
  if(url.includes('includeTransfer')){if(this.unsupported)return r;return {request:r,transfer:{commitState:r.receipt?'COMMITTED':'NOT_COMMITTED',receipt:r.receipt||null}};}return r;
 },
 async uploadAudioContent(serverId,{source,bytes:expected,epoch,signal}){if(this.uploadGate){this.uploadEntered();await this.uploadGate;if(signal.aborted)throw Error('synthetic aborted');}const r=rows.get(serverId);const chunks=[];for await(const chunk of source){if(signal?.aborted)throw Error('aborted');chunks.push(chunk);}const data=Buffer.concat(chunks);assert.equal(data.length,expected);assert.equal(hash(data),r.declaredSha256);assert.equal(epoch,this.epoch);r.bytes=data;r.receipt??={audioId:crypto.randomUUID(),shareId:crypto.randomUUID(),sha256:hash(data),bytes:data.length};if(this.lost)throw Error('synthetic lost response');return r.receipt;},
 async openAudioContentStream(audioId){const r=[...rows.values()].find(r=>r.receipt?.audioId===audioId);const data=this.badDownload?Buffer.alloc(r.bytes.length):r.bytes;return {status:200,headers:{'content-length':String(data.length),'content-type':'audio/wav'},body:Readable.from([data])};}
 };
 const upload=await new CloudAudioUpload(lib,{cloudAuth:cloud,enabled:true}).init();const service=await new CloudAudioService(lib,{cloudAuth:cloud,enabled:true}).init();
 t.after(async()=>{await upload.dispose();await service.dispose();lib.db.close();await fs.rm(base,{recursive:true,force:true});});
 const input={assetId:id,mediaKind:'SFX',visibility:'PRIVATE',groupId:null,category:'音效',subcategory:'环境'};
 return {base,src,dest,file,bytes,lib,cloud,rows,upload,service,input,downloadRoot};
}
async function submitted(f){let j=await f.upload.prepare(f.input);j=await f.upload.action(j.id,'request');assert.equal(j.status,'APPROVED');j=await f.upload.action(j.id,'upload');assert.equal(j.state,'completed',JSON.stringify(j));return j;}
async function waitJob(service,id){for(let i=0;i<300;i++){const j=service.getJob(id);if(!['queued','downloading','installing'].includes(j.state))return j;await new Promise(r=>setTimeout(r,20));}throw Error('fixture job deadline');}

test('manual upload -> literal group search/page -> verified no-replace download -> Library and duplicate reuse',{timeout:20000},async t=>{
 const f=await fixture(t);const j=await submitted(f);const page=await f.service.search({q:'%_!',groupId:crypto.randomUUID(),limit:1,offset:0});assert.equal(page.total,1);assert.equal(new URL(f.cloud.calls.at(-1).url,'https://mock.local').searchParams.get('q'),'%_!');assert.equal((await f.service.search({q:'empty'})).total,0);assert.equal((await f.service.search({offset:1})).items.length,0);
 const job=await f.service.startDownload({audioId:j.receipt.audioId,shareId:j.receipt.shareId,rootId:f.downloadRoot.id});const done=await waitJob(f.service,job.id);assert.equal(done.state,'completed',JSON.stringify(done));const asset=f.lib.asset(done.assetId);assert.equal(hash(await fs.readFile(asset.path)),hash(f.bytes));assert.equal(asset.kind,'sfx');
 const again=await waitJob(f.service,(await f.service.startDownload({audioId:j.receipt.audioId,shareId:j.receipt.shareId,rootId:f.downloadRoot.id})).id);assert.equal(again.state,'completed');assert.equal(again.createdFile,false);assert.equal(again.assetId,done.assetId);
 assert(!JSON.stringify(f.cloud.calls).includes(f.src));
});
test('approval pending/rejected/expired never sends bytes; same intent key only',{timeout:10000},async t=>{
 const f=await fixture(t);f.cloud.pending=true;let j=await f.upload.prepare(f.input);j=await f.upload.action(j.id,'request');assert.equal(j.status,'PENDING');await assert.rejects(f.upload.action(j.id,'upload'),{code:'UPLOAD_STATE'});
 const row=f.rows.get(j.requestId);for(const status of ['REJECTED','EXPIRED']){row.status=status;j=await f.upload.action(j.id,'refresh');assert.equal(j.status,status);await assert.rejects(f.upload.action(j.id,'upload'),{code:'UPLOAD_STATE'});}assert.equal(row.receipt,undefined);assert.equal(f.rows.size,1);
});
test('lost PUT result persists across restart; unsupported recovery stays unknown; committed recovery never uploads again',{timeout:10000},async t=>{
 const f=await fixture(t);let j=await f.upload.prepare(f.input);j=await f.upload.action(j.id,'request');f.cloud.lost=true;j=await f.upload.action(j.id,'upload');assert.equal(j.state,'unknown');
 const reloaded=await new CloudAudioUpload(f.lib,{cloudAuth:f.cloud,enabled:true}).init();assert.equal(reloaded.list()[0].state,'unknown');f.cloud.unsupported=true;j=await reloaded.action(j.id,'reconcile');assert.equal(j.state,'unknown');await assert.rejects(reloaded.action(j.id,'upload'),{code:'UPLOAD_STATE'});
 f.cloud.unsupported=false;j=await reloaded.action(j.id,'reconcile');assert.equal(j.state,'completed');assert.equal(f.rows.size,1);await assert.rejects(reloaded.action(j.id,'cancel'),{code:'UPLOAD_ALREADY_COMMITTED'});await reloaded.dispose();
});
test('source changed and identity switched cannot reuse old bytes/hash or expose old intents',{timeout:10000},async t=>{
 const f=await fixture(t);let j=await f.upload.prepare(f.input);j=await f.upload.action(j.id,'request');await fs.appendFile(f.file,'changed');j=await f.upload.action(j.id,'upload');assert.equal(j.state,'failed');assert.equal(f.rows.get(j.requestId).receipt,undefined);
 f.cloud.epoch++;f.cloud.accountId='synthetic-b';assert.deepEqual(f.upload.list(),[]);await assert.rejects(f.upload.action(j.id,'refresh'),{code:'NOT_FOUND'});
});
test('cancel not-yet-published intent removes only its private snapshot; default off is inert',{timeout:10000},async t=>{
 const f=await fixture(t);const off=await new CloudAudioUpload(f.lib,{cloudAuth:f.cloud,enabled:false}).init();assert.throws(()=>off.list(),{status:503});let j=await f.upload.prepare(f.input);j=await f.upload.action(j.id,'request');j=await f.upload.action(j.id,'cancel');assert.equal(j.state,'cancelled');assert.equal(f.rows.get(j.requestId).status,'CANCELLED');await assert.rejects(fs.stat(path.join(f.lib.dataDir,'cloud-upload-intents',`payload-${j.id}`)),{code:'ENOENT'});assert.equal(hash(await fs.readFile(f.file)),hash(f.bytes));
});
test('download hash failure never installs a half file or reports completed',{timeout:20000},async t=>{
 const f=await fixture(t);const j=await submitted(f);f.cloud.badDownload=true;const done=await waitJob(f.service,(await f.service.startDownload({audioId:j.receipt.audioId,shareId:j.receipt.shareId,rootId:f.downloadRoot.id})).id);assert.equal(done.state,'failed');assert.equal(done.assetId,'');assert.deepEqual(await fs.readdir(f.dest),[]);
});

test('fixed PUT transport uses actual disposable mTLS and aborts on authentication epoch change',{timeout:20000},async t=>{
 const {default:https}=await import('node:https');const {CloudAuth}=await import('../server/cloud-auth.mjs');const {startMockCloud}=await import('./cloud-auth-mock.mjs');
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'manual-put-tls-')));const lib=await new Library(path.join(base,'data')).init();const cloud=await startMockCloud();
 await cloud.enroll({username:'alice',password:'synthetic-only-password',displayName:'Synthetic',clientCert:cloud.clientCertA,clientKey:cloud.clientKeyA});
 const ca=await fs.readFile(cloud.caCert),cert=await fs.readFile(cloud.clientCertA),key=await fs.readFile(cloud.clientKeyA);const data=wav();let gated=false,release,enteredResolve;const entered=new Promise(r=>enteredResolve=r);const gate=new Promise(r=>release=r);
 const server=https.createServer({key:await fs.readFile(path.join(cloud.dir,'server.key')),cert:await fs.readFile(path.join(cloud.dir,'server.crt')),ca,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  try{
   if(req.method==='PUT'){
    assert.equal(req.socket.authorized,true);assert.match(req.url,/^\/api\/v1\/media\/upload-requests\/[a-f0-9-]{36}\/content$/);assert.match(req.headers.authorization,/^Bearer /);assert.equal(req.headers['content-type'],'application/octet-stream');assert.equal(Number(req.headers['content-length']),data.length);
    const chunks=[];for await(const b of req)chunks.push(b);assert.deepEqual(Buffer.concat(chunks),data);
    if(gated){enteredResolve();await gate;}
    if(!res.destroyed)res.end(JSON.stringify({code:'OK',data:{audioId:crypto.randomUUID(),shareId:crypto.randomUUID(),sha256:hash(data),bytes:data.length}}));
   }else{
    const upstream=https.request(new URL(req.url,cloud.origin),{method:req.method,headers:req.headers,ca,cert,key,rejectUnauthorized:true},reply=>{res.writeHead(reply.statusCode,{'content-type':'application/json'});reply.pipe(res);});upstream.on('error',()=>res.destroy());req.pipe(upstream);
   }
  }catch{res.destroy();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const auth=await new CloudAuth(lib,{dataDir:lib.dataDir}).init();
 t.after(async()=>{release();auth.dispose();server.closeAllConnections?.();await new Promise(r=>server.close(r));await cloud.close();lib.db.close();await fs.rm(base,{recursive:true,force:true});await fs.rm(cloud.dir,{recursive:true,force:true});});
 await auth.configure({origin:`https://127.0.0.1:${server.address().port}`,caPath:cloud.caCert,certPath:cloud.clientCertA,keyPath:cloud.clientKeyA});await auth.login({username:'alice',password:'synthetic-only-password'});
 const result=await auth.uploadAudioContent(crypto.randomUUID(),{source:Readable.from([data]),bytes:data.length,epoch:auth.epoch});assert.equal(result.sha256,hash(data));
 const broken=new Readable({read(){}});const early=assert.rejects(auth.uploadAudioContent(crypto.randomUUID(),{source:broken,bytes:data.length,epoch:auth.epoch}));broken.destroy(Error('synthetic early source error'));await early;
 gated=true;const pending=auth.uploadAudioContent(crypto.randomUUID(),{source:Readable.from([data]),bytes:data.length,epoch:auth.epoch});const checked=assert.rejects(pending);await entered;await auth.logout();release();await checked;
});


test('in-flight cancel stays unknown until explicit confirmation; duplicate preparation is refused',{timeout:10000},async t=>{
 const f=await fixture(t);let j=await f.upload.prepare(f.input);await assert.rejects(f.upload.prepare(f.input),{code:'UPLOAD_STATE'});j=await f.upload.action(j.id,'request');
 let release,entered;const started=new Promise(r=>entered=r);f.cloud.uploadEntered=entered;f.cloud.uploadGate=new Promise(r=>release=r);
 const uploading=f.upload.action(j.id,'upload');try{await started;assert.equal((await f.upload.action(j.id,'cancel')).state,'uploading');}finally{release();}
 j=await uploading;assert.equal(j.state,'unknown');assert.equal(f.rows.get(j.requestId).receipt,undefined);
 j=await f.upload.action(j.id,'reconcile');assert.equal(j.state,'ready');j=await f.upload.action(j.id,'cancel');assert.equal(j.state,'cancelled');
});
test('known share is blocked from request cancellation even when the response was lost',{timeout:10000},async t=>{
 const f=await fixture(t);let j=await f.upload.prepare(f.input);j=await f.upload.action(j.id,'request');f.cloud.lost=true;j=await f.upload.action(j.id,'upload');assert.equal(j.state,'unknown');await assert.rejects(f.upload.action(j.id,'cancel'),{code:'UPLOAD_ALREADY_COMMITTED'});assert.equal(f.rows.get(j.requestId).status,'APPROVED');
});

test('new local HTTP entry points keep session/Origin/CSRF guards and default-off creates no upload intent directory',{timeout:20000},async t=>{
 const {spawn}=await import('node:child_process');const {default:net}=await import('node:net');const {fileURLToPath}=await import('node:url');const project=fileURLToPath(new URL('..',import.meta.url));
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'manual-route-'))),dataDir=path.join(base,'data');await fs.mkdir(dataDir);
 const digest=hash(await fs.readFile(path.join(project,'server/trash.swift'))).slice(0,12);await fs.writeFile(path.join(dataDir,`trash-helper-${digest}`),'',{mode:0o755});
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:project,env:{...process.env,MEDIA_DATA_DIR:dataDir,MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CLOUD_AUDIO_ENABLED:'',SHIGUANG_AUDIO_ANALYSIS:'',SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(base,'no-release.json'),PORT:String(port)},stdio:['ignore','pipe','pipe']});let output='',closed=false;const completion=new Promise(r=>child.once('close',()=>{closed=true;r();}));child.on('error',()=>{});for(const stream of [child.stdout,child.stderr])stream.on('data',c=>{output=(output+c).slice(-16384);});
 const bounded=async(p,ms)=>{let timer;try{return await Promise.race([p.then(()=>true),new Promise(r=>timer=setTimeout(()=>r(false),ms))]);}finally{clearTimeout(timer);}};
 t.after(async()=>{if(!closed){child.kill('SIGTERM');if(!await bounded(completion,3000)){child.kill('SIGKILL');assert(await bounded(completion,3000));}}assert(closed);await fs.rm(base,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${port}`;for(let n=0;n<150&&!output.includes('拾光素材库 http');n++){assert(!closed);await new Promise(r=>setTimeout(r,50));}assert(output.includes('拾光素材库 http'));
 assert.equal((await fetch(url+'/api/cloud-audio/uploads')).status,401);
 const session=await fetch(url+'/api/session');const cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();
 const headers={cookie,'x-local-token':token,'content-type':'application/json'};
 assert.equal((await fetch(url+'/api/cloud-audio/uploads',{headers:{cookie,origin:'http://evil.invalid'}})).status,403);
 assert.equal((await fetch(url+'/api/cloud-audio/uploads',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'})).status,403);
 for(const suffix of ['/uploads','/upload-assets','/search?q=rain']){const r=await fetch(url+'/api/cloud-audio'+suffix,{headers});assert.equal(r.status,503);assert.equal((await r.json()).code,'CLOUD_AUDIO_DISABLED');}
 const r=await fetch(url+'/api/cloud-audio/uploads',{method:'POST',headers,body:'{}'});assert.equal(r.status,503);
 await assert.rejects(fs.stat(path.join(dataDir,'cloud-upload-intents')),{code:'ENOENT'});
});


test('upload metadata uses the existing safe two-level installer contract, never arbitrary local paths',{timeout:10000},async t=>{
 const f=await fixture(t);
 for(const category of ['..','A/B','unsafe*','声'.repeat(60)])await assert.rejects(f.upload.prepare({...f.input,category}),{code:'INVALID_REQUEST'});
 await assert.rejects(f.upload.prepare({...f.input,path:f.file}),{code:'INVALID_REQUEST'});
 assert.equal(f.rows.size,0);assert.deepEqual(await fs.readdir(path.join(f.lib.dataDir,'cloud-upload-intents')),[]);
});


test('shared local admission preserves existing bounds through overlapping starts and failure cleanup',{timeout:10000},async()=>{
 let release;const held=new Promise(r=>release=r);const status={active:0,queued:0};const gate=manualAudioAdmission(async()=>status);
 const starting=gate.download(()=>held);await assert.rejects(gate.upload(()=>assert.fail('must not begin upload')),{code:'BUSY'});release();await starting;
 status.queued=1;await assert.rejects(gate.upload(()=>assert.fail('must not overlap queued downloads')),{code:'BUSY'});status.queued=0;
 let ready,finish;const begun=new Promise(r=>ready=r),body=new Promise(r=>finish=r);const upload=gate.upload(async()=>{ready();await body;throw Error('synthetic failure');});const checked=assert.rejects(upload);await begun;
 await assert.rejects(gate.download(()=>assert.fail('must not overlap upload')),{code:'BUSY'});finish();await checked;assert.equal(await gate.download(async()=>42),42);
});
