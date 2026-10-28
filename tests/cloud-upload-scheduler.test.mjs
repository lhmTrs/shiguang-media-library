import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CloudUploadScheduler} from '../server/cloud-upload-scheduler.mjs';
import {CloudAudioUpload} from '../server/cloud-audio-upload.mjs';
import {sqliteFixture,rows} from './cloud-upload-batch-mysql-fixture.mjs';
import {uuid} from '../server/cloud-upload-protocol.mjs';
const caps=()=>({protocol:2,writeMode:'READY',canCreateUploads:true,requiredSafety:Object.fromEntries(['sqlEligibility','contentRowLock','generationBindings','adminBarrier','integrityGate','fileOperationFence','legacyWriteFence'].map(k=>[k,true])),optional:{reuse:false},limits:{maxFileBytes:256000000,eligibilityMaxItems:50}});
const retainedRoots=[];
const originalEnvironment={MEDIA_DATA_DIR:process.env.MEDIA_DATA_DIR,MEDIA_SKIP_IMPORT:process.env.MEDIA_SKIP_IMPORT};
test.before(async()=>{const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'uq03a-test-env-')));process.env.MEDIA_DATA_DIR=directory;process.env.MEDIA_SKIP_IMPORT='1';retainedRoots.push({directory,role:'MEDIA_DATA_DIR',policy:'RETAIN_ALL',observedAtSetup:true});});
async function setup(t,source=rows(3),threshold=32){
 const f=await sqliteFixture(null,source);f.who={...f.who,librarySourceId:uuid()};retainedRoots.push({directory:f.dir,policy:'RETAIN_ALL',observedAtSetup:true});
 let now=1000,live=0,maximum=0,core,overrideResources=null;
 const records=new Map(),calls=[];
 const upload=f.upload,originalPrepare=upload.prepareWithIdentity.bind(upload);
 upload.prepareWithIdentity=async(ids,version,metadata)=>{const j=await originalPrepare(ids,version,metadata);j.bytes=version.size;j.snapshotBytes??=0;return j;};
 upload.releasePayloadForApproval=async intentId=>{const j=upload.jobs.get(intentId);if(j)j.snapshotBytes=0;calls.push({kind:'release',intentId});};
 upload.rebuildPayload=async intentId=>{const j=upload.jobs.get(intentId);assert.ok(j);assert.equal(j.status,'APPROVED');j.snapshotBytes=j.bytes;calls.push({kind:'rebuild',intentId});};
 const dto=(c,rec)=>({clientRequestId:c.item.clientRequestId,canonicalRequestId:rec?.id??null,attemptId:rec?.attemptId??null,requestState:rec?.state??'NOT_CREATED',stateVersion:rec?.version??0,admissionEpoch:0});
 const remote={enabled:true,optionalReuse:false,onTransfer:null,onRequest:null,onCancel:null,onEligibility:null,reuseResult:{outcome:'NEEDS_UPLOAD'},
  async capabilities(){const c=caps();c.canCreateUploads=this.enabled;c.optional.reuse=this.optionalReuse;return c;},
  async eligibility(w,c){if(this.onEligibility)return this.onEligibility(w,c);return{classification:records.has(c.item.clientRequestId)?'IN_PROGRESS':'NEW',reviewRequired:c.item.declaredBytes>threshold};},
  async resources(){return overrideResources??{known:true,activeIntents:upload.jobs.size,intentBytes:upload.jobs.size*1500,snapshotBytes:[...upload.jobs.values()].reduce((n,j)=>n+(j.snapshotBytes||0),0)};},
  async request(w,c){calls.push({kind:'request',batchId:c.batch.batchId,itemId:c.item.itemId,client:c.item.clientRequestId,at:now});if(this.onRequest)await this.onRequest(w,c);let rec=records.get(c.item.clientRequestId);if(!rec){rec={id:uuid(),attemptId:uuid(),state:c.item.declaredBytes>threshold?'PENDING':'APPROVED',version:1};records.set(c.item.clientRequestId,rec);}Object.assign(upload.jobs.get(c.item.intentId),{status:rec.state,state:'ready'});return dto(c,rec);},
  async resolve(w,c){calls.push({kind:'resolve',client:c.item.clientRequestId,at:now});const rec=records.get(c.item.clientRequestId);return rec?.receipt?{clientRequestId:c.item.clientRequestId,commitState:'COMMITTED',receipt:rec.receipt}:{clientRequestId:c.item.clientRequestId,commitState:'NOT_COMMITTED',request:dto(c,rec)};},
  async transfer(w,c,{signal}){calls.push({kind:'transfer',batchId:c.batch.batchId,itemId:c.item.itemId,client:c.item.clientRequestId,at:now});maximum=Math.max(maximum,++live);try{if(this.onTransfer)await this.onTransfer(w,c,signal);const rec=records.get(c.item.clientRequestId);rec.receipt={...f.receipt(c.item,c.attempt),canonicalRequestId:rec.id,attemptId:rec.attemptId};return{clientRequestId:c.item.clientRequestId,commitState:'COMMITTED',receipt:rec.receipt};}finally{live--; }},
  async cancel(w,c){calls.push({kind:'cancel',client:c.item.clientRequestId});if(this.onCancel)return this.onCancel(w,c);return{clientRequestId:c.item.clientRequestId,commitState:'UNKNOWN'};},
  async reuse(w,c){calls.push({kind:'reuse',client:c.item.clientRequestId});return this.reuseResult;},
 };
 core=new CloudUploadScheduler(f.batches,{remote,clock:()=>now,operationMs:1000});
 t.after(async()=>{const disposed=await core.dispose({timeoutMs:1000});assert.equal(disposed.closed,true);f.db.close();});
 return{f,core,remote,records,calls,get maximum(){return maximum;},advance(ms){now+=ms;f.clock=now;},set resources(value){overrideResources=value;},approve(){for(const [client,r]of records)if(r.state==='PENDING'){r.state='APPROVED';r.version++;const j=[...upload.jobs.values()].find(x=>x.clientRequestId===client);if(j)j.status='APPROVED';}},row(id){return f.store.get('cloud_upload_batch_items',{itemId:id});}};
}
function command(x,batchId,action,clientCommandId=uuid()){return x.core.command(batchId,{clientCommandId,expectedVersion:x.f.store.get('cloud_upload_batches',{batchId}).version,action});}
test('constructor is idle, explicit singleton start, and two batches share one fair transfer lane',async t=>{
 const x=await setup(t,rows(2));assert.deepEqual(x.core.state(),{started:false,closing:false,closed:false,inflight:0,timers:0});assert.equal(x.calls.length,0);x.core.start({recover:false,automatic:false});const a=await x.f.create();
 // Different batches contain independent assets to avoid the separate cross-batch duplicate claim fence.
 x.f.sourceRows=rows(2,{start:20});const c=await x.f.create();
 const second=new CloudUploadScheduler(x.f.batches,{remote:x.remote});assert.throws(()=>second.start(),{code:'SCHEDULER_ACTIVE'});
 await x.core.pump();assert.equal(x.maximum,1);assert.equal(x.f.batches.summary(x.f.who,a.b.batchId).state,'COMPLETED');assert.equal(x.f.batches.summary(x.f.who,c.b.batchId).state,'COMPLETED');
 const transfers=x.calls.filter(c=>c.kind==='transfer');assert.ok(transfers.some(c=>c.batchId===a.b.batchId));assert.ok(transfers.some(t=>t.batchId===c.b.batchId));
});
test('T-1/T auto approve, T+1 waits without a snapshot slot and approval continues original IDs',async t=>{
 const source=rows(3);source.forEach((r,i)=>{r.declaredBytes=31+i;r.sourceVersion.size=31+i;});const x=await setup(t,source,32);x.core.start({recover:false,automatic:false});const {b,items}=await x.f.create();await x.core.pump();
 assert.equal(x.row(items[0].itemId).state,'COMMITTED');assert.equal(x.row(items[1].itemId).state,'COMMITTED');const waiting=x.row(items[2].itemId);assert.equal(waiting.state,'WAITING_APPROVAL');assert.equal(x.f.upload.jobs.get(waiting.intentId).snapshotBytes,0);assert.ok(x.calls.some(c=>c.kind==='release'));
 x.approve();x.advance(30000);await x.core.pump();assert.equal(x.row(waiting.itemId).state,'COMMITTED');assert.equal(x.row(waiting.itemId).clientRequestId,waiting.clientRequestId);assert.equal(x.calls.filter(c=>c.kind==='request').length,3);assert.equal(x.f.batches.summary(x.f.who,b.batchId).state,'COMPLETED');
});
test('ten pending approvals leave room for an exempt item instead of blocking the batch',async t=>{
 const source=rows(12);source.forEach((r,i)=>{r.declaredBytes=i<11?33:31;r.sourceVersion.size=r.declaredBytes;});const x=await setup(t,source,32);x.core.start({recover:false,automatic:false});const {items}=await x.f.create();await x.core.pump();
 assert.equal(x.f.batches.schedulerPending(x.f.who),10);assert.equal(x.row(items[11].itemId).state,'COMMITTED');assert.equal(x.row(items[10].itemId).currentAttemptId,null);assert.equal(x.calls.filter(c=>c.kind==='request').length,11);
});
test('24 request attempts per rolling minute persists and 429 honors Retry-After using original IDs',async t=>{
 const x=await setup(t,rows(30));x.core.start({recover:false,automatic:false});await x.f.create();await x.core.pump();assert.equal(x.calls.filter(c=>c.kind==='request').length,24);x.advance(60001);await x.core.pump();assert.equal(x.calls.filter(c=>c.kind==='request').length,30);
 const y=await setup(t,rows(1));y.core.start({recover:false,automatic:false});const {items}=await y.f.create();let once=true;y.remote.onRequest=async()=>{if(once){once=false;throw Object.assign(Error('synthetic429'),{status:429,code:'RATE_LIMITED',retryAfter:'10'});}};await y.core.pump();const r=y.row(items[0].itemId);assert.equal(r.state,'RECONCILING');assert.equal(y.calls.filter(c=>c.kind==='request').length,1);y.advance(9999);await y.core.pump();assert.equal(y.calls.filter(c=>c.kind==='request').length,1);y.advance(2);await y.core.pump();assert.equal(y.row(r.itemId).state,'COMMITTED');assert.equal(y.row(r.itemId).clientRequestId,r.clientRequestId);
});
test('capacity windows fail closed at 50 intents / JSON limit / 512MB, without allocating a fresh attempt',async t=>{
 for(const resources of [{known:true,activeIntents:50,intentBytes:50000,snapshotBytes:0},{known:true,activeIntents:0,intentBytes:262144,snapshotBytes:0},{known:false,activeIntents:0,intentBytes:0,snapshotBytes:0}]){
  const x=await setup(t,rows(1));x.resources=resources;x.core.start({recover:false,automatic:false});const {items}=await x.f.create();await x.core.pump();assert.equal(x.row(items[0].itemId).currentAttemptId,null);assert.equal(x.calls.filter(c=>c.kind==='request').length,0);
 }
 const x=await setup(t,rows(1));x.core.start({recover:false,automatic:false});const {items}=await x.f.create();await x.core.tick();await x.core.tick();x.resources={known:true,activeIntents:1,intentBytes:1500,snapshotBytes:512000000};await x.core.tick();assert.equal(x.calls.filter(c=>c.kind==='transfer').length,0);assert.equal(x.row(items[0].itemId).state,'RECONCILING');
});
test('missing safety or historical eligibility never upgrades to NEW; retry count and remote503 remain bounded',async t=>{
 const x=await setup(t,rows(1));x.remote.enabled=false;x.core.start({recover:false,automatic:false});const {items}=await x.f.create();for(let i=0;i<10;i++){await x.core.pump();x.advance(300000);}const r=x.row(items[0].itemId);assert.equal(r.schedulerBlocked,true);assert.equal(r.retryCount,8);assert.equal(r.currentAttemptId,null);assert.equal(x.calls.filter(c=>c.kind==='request').length,0);
 const y=await setup(t,rows(1));y.core.start({recover:false,automatic:false});const created=await y.f.create();await y.core.tick();let failedRequests=0;y.remote.request=async()=>{failedRequests++;throw Object.assign(Error('remote retry gap'),{code:'PROTOCOL_UPDATE_REQUIRED',status:503});};await y.core.pump();const first=y.row(created.items[0].itemId);y.advance(10000);await y.core.pump();assert.equal(y.row(first.itemId).currentAttemptId,first.currentAttemptId);assert.equal(y.row(first.itemId).receipt,null);for(let i=0;i<10;i++){y.advance(300000);await y.core.pump();}assert.equal(y.row(first.itemId).retryCount,8);assert.equal(y.row(first.itemId).schedulerBlocked,true);assert.equal(failedRequests,8);
});
test('pause commits before dispatch continuation, stop does not abort another batch, command replay is durable',async t=>{
 const x=await setup(t,rows(1));x.core.start({recover:false,automatic:false});const {b,items}=await x.f.create();await x.core.tick();let paused=false;x.remote.onEligibility=async()=>{if(!paused){paused=true;command(x,b.batchId,'pause');}return{classification:'IN_PROGRESS',reviewRequired:false};};await x.core.tick();assert.equal(x.calls.filter(c=>c.kind==='request').length,0);assert.equal(x.f.batches.summary(x.f.who,b.batchId).state,'PAUSED');x.remote.onEligibility=null;command(x,b.batchId,'resume');await x.core.pump();assert.equal(x.row(items[0].itemId).state,'COMMITTED');
 const y=await setup(t,rows(1));y.core.start({recover:false,automatic:false});const created=await y.f.create();const input={clientCommandId:uuid(),expectedVersion:created.b.version,action:'stop'};const a=y.core.command(created.b.batchId,input);assert.deepEqual(y.core.command(created.b.batchId,input),a);assert.equal(a.state,'STOPPED');assert.equal(y.calls.length,0);
});
test('reuse only falls back after explicit NEEDS_UPLOAD; unknown reuse reconciles original request',async t=>{
 const x=await setup(t,rows(1));x.remote.optionalReuse=true;x.core.start({recover:false,automatic:false});const {items}=await x.f.create();await x.core.pump();assert.equal(x.calls.filter(c=>c.kind==='reuse').length,1);assert.equal(x.calls.filter(c=>c.kind==='transfer').length,1);assert.equal(x.row(items[0].itemId).state,'COMMITTED');
 const y=await setup(t,rows(1));y.remote.optionalReuse=true;y.remote.reuseResult={outcome:'UNKNOWN'};y.core.start({recover:false,automatic:false});const created=await y.f.create();await y.core.pump();assert.equal(y.calls.filter(c=>c.kind==='transfer').length,0);assert.equal(y.row(created.items[0].itemId).state,'RECONCILING');
});
test('original CloudAudioUpload prepares/hashes/snapshots/commits stable private intent without actual network',async t=>{
 const f=await sqliteFixture(null,[]);retainedRoots.push({directory:f.dir,policy:'RETAIN_ALL'});const media=path.join(f.dir,'synthetic-source');await fs.mkdir(media);const file=path.join(media,'synthetic.wav');await fs.writeFile(file,Buffer.alloc(4096,17));const assetId=uuid(),rootId=f.input().scopes[0].rootId,a={id:assetId,root_id:rootId,kind:'music',category:'A',sub:'B',trashed:0},root={id:rootId,path:await fs.realpath(media),retired:0};
 const lib={dataDir:f.dir,asset:()=>a,rootById:()=>root,source:async()=>({a,p:file,stat:await fs.stat(file)})};let request,legacy,sent=0;const auth={epoch:1,getState:()=>({configured:true,state:'logged-in',originHost:'fixture.invalid',accountId:f.who.accountId,deviceId:f.who.deviceId}),async proxy(method,url,{body}){if(method==='POST'){request={id:uuid(),requestId:body.requestId,declaredSha256:body.sha256,declaredBytes:body.bytes,status:'APPROVED',version:1};}return request;},async uploadAudioContent(id,{source}){for await(const chunk of source)sent+=chunk.length;legacy={audioId:uuid(),shareId:uuid(),sha256:request.declaredSha256,bytes:sent};return legacy;}};
 const upload=await new CloudAudioUpload(lib,{cloudAuth:auth,enabled:true}).init();f.batches.upload=upload;const inspected=await upload.inspectForBatch(assetId);f.sourceRows=[{...inspected,target:{visibility:'PRIVATE',groupId:null}}];
 const observation=c=>({clientRequestId:c.item.clientRequestId,canonicalRequestId:request.id,attemptId:request.id,requestState:request.status,stateVersion:request.version,admissionEpoch:0});
 const remote={capabilities:async()=>caps(),eligibility:async()=>({classification:'NEW',reviewRequired:false}),resources:async()=>({known:true,activeIntents:upload.list().length,intentBytes:upload.list().length*4096,snapshotBytes:4096}),request:async(w,c)=>{await upload.action(c.item.intentId,'request');return observation(c);},resolve:async(w,c)=>({clientRequestId:c.item.clientRequestId,commitState:'NOT_COMMITTED',request:observation(c)}),transfer:async(w,c)=>{await upload.action(c.item.intentId,'upload');return{clientRequestId:c.item.clientRequestId,commitState:'COMMITTED',receipt:{...f.receipt(c.item,c.attempt),canonicalRequestId:request.id,attemptId:request.id,blobId:legacy.audioId,shareId:legacy.shareId}};}};
 const core=new CloudUploadScheduler(f.batches,{remote,clock:()=>1000});t.after(async()=>{assert.equal((await core.dispose()).closed,true);await upload.dispose();f.db.close();});core.start({recover:false,automatic:false});const {items}=await f.create();await core.pump();const done=f.store.get('cloud_upload_batch_items',{itemId:items[0].itemId});assert.equal(done.state,'COMMITTED');assert.equal(sent,4096);assert.equal(upload.list().length,0);assert.equal(done.cleanupPending,false);
});
test('automatic scheduler child naturally exits after dispose with all timers closed',async()=>{
 const schedulerUrl=new URL('../server/cloud-upload-scheduler.mjs',import.meta.url).href,fixtureUrl=new URL('./cloud-upload-batch-mysql-fixture.mjs',import.meta.url).href;
 const code=`import {CloudUploadScheduler} from ${JSON.stringify(schedulerUrl)};import {sqliteFixture} from ${JSON.stringify(fixtureUrl)};const f=await sqliteFixture(null,[]);const noop=async()=>({});const remote={capabilities:noop,eligibility:noop,resources:noop,request:noop,resolve:noop,transfer:noop};const s=new CloudUploadScheduler(f.batches,{remote,intervalMs:10});s.start({recover:false});setTimeout(async()=>{const result=await s.dispose();f.db.close();process.stdout.write(JSON.stringify({result,state:s.state(),retainedRoot:f.dir}));},30);`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{timeout:3000,maxBuffer:65536});const result=JSON.parse(stdout);assert.equal(result.result.closed,true);assert.equal(result.state.timers,0);retainedRoots.push({directory:result.retainedRoot,policy:'RETAIN_ALL',childNaturallyExited:true});
});
test.after(()=>{for(const [key,value]of Object.entries(originalEnvironment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}console.log(JSON.stringify({retainedRoots,afterPolicy:'No filesystem reads or recursive cleanup in after'}));});
test('sixty persisted items progress while forty-nine retained intents keep the actual synthetic window at fifty',async t=>{
 const x=await setup(t,rows(60));for(let i=0;i<49;i++){const id=uuid();x.f.upload.jobs.set(id,{id,clientRequestId:uuid(),state:'unknown',snapshotBytes:0});}x.core.start({recover:false,automatic:false});const {b}=await x.f.create();assert.equal(x.f.batches.rows(b.batchId).length,60);assert.equal(x.f.upload.jobs.size,49);
 for(let i=0;i<3;i++){await x.core.pump();x.advance(60001);}await x.core.pump();assert.equal(x.f.batches.summary(x.f.who,b.batchId).state,'COMPLETED');assert.equal(x.f.upload.maximum,50);assert.equal(x.f.upload.jobs.size,49);assert.equal(x.calls.filter(c=>c.kind==='request').length,60);
});
test('stopping a different batch never aborts the active transfer of another batch',async t=>{
 const x=await setup(t,rows(1));x.core.start({recover:false,automatic:false});const a=await x.f.create();x.f.sourceRows=rows(1,{start:20});const b=await x.f.create();let release,activeContext,activeSignal,entered;const ready=new Promise(r=>entered=r);x.remote.onTransfer=async(w,c,signal)=>{activeContext=c;activeSignal=signal;entered();await new Promise(r=>release=r);};let active;
 for(let i=0;i<10;i++){const next=x.core.tick();if(await Promise.race([next.then(()=>false),ready.then(()=>true)])){active=next;break;}}
 assert.ok(active);try{const other=activeContext.batch.batchId===a.b.batchId?b.b.batchId:a.b.batchId;command(x,other,'stop');assert.equal(activeSignal.aborted,false);}finally{release();}await active;assert.equal(x.f.batches.summary(x.f.who,activeContext.batch.batchId).state,'COMPLETED');
});
test('source preparation cannot carry an old safety capability into content dispatch',async t=>{
 const x=await setup(t,rows(1));x.core.start({recover:false,automatic:false});const {items}=await x.f.create();await x.core.tick();await x.core.tick();const rebuild=x.f.upload.rebuildPayload;x.f.upload.rebuildPayload=async id=>{await rebuild(id);x.remote.enabled=false;};await x.core.pump();assert.equal(x.calls.filter(c=>c.kind==='transfer').length,0);assert.equal(x.row(items[0].itemId).state,'RECONCILING');
});
test('all mandatory safety gates are required even with top-level enabled, and reuse commit never sends content twice',async t=>{
 const x=await setup(t,rows(1));x.remote.capabilities=async()=>{const c=caps();c.requiredSafety.legacyWriteFence=false;return c;};x.core.start({recover:false,automatic:false});const created=await x.f.create();await x.core.pump();assert.equal(x.row(created.items[0].itemId).currentAttemptId,null);assert.equal(x.calls.filter(c=>c.kind==='request').length,0);
 const y=await setup(t,rows(1));y.remote.optionalReuse=true;y.remote.reuse=async(w,c)=>{const rec=y.records.get(c.item.clientRequestId);return{outcome:'COMMITTED',receipt:{...y.f.receipt(c.item,c.attempt),canonicalRequestId:rec.id,attemptId:rec.attemptId,mode:'reused'}};};y.core.start({recover:false,automatic:false});const {b}=await y.f.create();await y.core.pump();assert.equal(y.f.batches.summary(y.f.who,b.batchId).counts.reused,1);assert.equal(y.calls.filter(c=>c.kind==='transfer').length,0);
});
test('bounded scan progress reaches work behind historical batches rather than declaring the queue empty',async t=>{
 const x=await setup(t,rows(1));x.core.start({recover:false,automatic:false});const {b,items}=await x.f.create();const batch=x.f.store.get('cloud_upload_batches',{batchId:b.batchId});
 x.f.store.transaction(()=>{for(let i=0;i<12;i++){const batchId='00000000-0000-4000-8000-'+String(90000+i).padStart(12,'0');x.f.store.insert('cloud_upload_batches',{...batch,batchId,clientCommandId:uuid(),state:'STOPPED',stopRequested:true});x.f.store.insert('cloud_upload_batch_items',{...items[0],itemId:uuid(),batchId,state:'CANCELLED'});}});
 await x.core.pump({maxSteps:32});assert.equal(x.row(items[0].itemId).state,'COMMITTED');assert.equal(x.calls.filter(c=>c.kind==='request').length,1);
});
test('different connection objects cannot create a second scheduler owner for the same library identity',async t=>{
 const x=await setup(t,rows(1)),y=await setup(t,rows(1));y.f.who={...y.f.who,librarySourceId:x.f.who.librarySourceId};x.core.start({recover:false,automatic:false});assert.throws(()=>y.core.start({recover:false,automatic:false}),{code:'SCHEDULER_ACTIVE'});assert.equal((await x.core.dispose()).closed,true);assert.equal(y.core.start({recover:false,automatic:false}).started,true);
});
test('lost possibly-pending request replies keep ten reserved approval slots while exempt work proceeds',async t=>{
 const source=rows(12);source.forEach((r,i)=>{r.declaredBytes=i<11?33:31;r.sourceVersion.size=r.declaredBytes;});const x=await setup(t,source,32);x.remote.onRequest=async(w,c)=>{if(c.item.declaredBytes>32)throw Object.assign(Error('reply unavailable'),{code:'PROTOCOL_UPDATE_REQUIRED',status:503});};x.core.start({recover:false,automatic:false});const {items}=await x.f.create();await x.core.pump();assert.equal(x.f.batches.schedulerPending(x.f.who),10);assert.equal(x.row(items[10].itemId).currentAttemptId,null);assert.equal(x.row(items[11].itemId).state,'COMMITTED');assert.equal(x.row(items[0].itemId).state,'RECONCILING');assert.equal(x.f.upload.jobs.size,10);
});

test('optional dispatch permit denies maintenance before choosing work and default construction remains idle',async t=>{
 const x=await setup(t,rows(1));assert.equal(x.core.dispatchState().configured,false);assert.equal(x.calls.length,0);assert.equal((await x.core.dispose()).closed,true);
 let enters=0,checks=0,leaves=0;const permit={async enter(){enters++;return{allowed:false,permit:null};},async check(){checks++;return{allowed:true};},async leave(){leaves++;return{released:true,settled:true};}};
 const core=new CloudUploadScheduler(x.f.batches,{remote:x.remote,clock:()=>1000,dispatchPermit:permit});t.after(async()=>assert.equal((await core.dispose()).closed,true));
 assert.deepEqual(core.dispatchState(),{configured:true,acquiring:false,held:false,releasing:false,unknown:false,settled:true});assert.equal(enters,0);
 core.start({recover:false,automatic:false});await x.f.create();const before=x.f.db.prepare('SELECT record_json FROM cloud_upload_batch_items').all();const result=await core.tick();assert.equal(result.processed,false);assert.equal(result.code,'MAINTENANCE_BUSY');assert.equal(enters,1);assert.equal(checks,0);assert.equal(leaves,0);assert.deepEqual(x.f.db.prepare('SELECT record_json FROM cloud_upload_batch_items').all(),before);assert.equal(x.calls.length,0);assert.equal((await core.dispose()).closed,true);
});
