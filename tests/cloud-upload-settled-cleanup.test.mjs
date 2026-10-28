// Real uploader + SQLite domain + scheduler; remote termination is a controlled substitute.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CloudAudioUpload} from '../server/cloud-audio-upload.mjs';
import {CloudUploadScheduler} from '../server/cloud-upload-scheduler.mjs';
import {sqliteFixture} from './cloud-upload-batch-mysql-fixture.mjs';
import {uuid,fingerprint,clone} from '../server/cloud-upload-protocol.mjs';
const retainedRoots=[],originalEnvironment={MEDIA_DATA_DIR:process.env.MEDIA_DATA_DIR,MEDIA_SKIP_IMPORT:process.env.MEDIA_SKIP_IMPORT};
test.before(async()=>{const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'uq03b1-env-')));retainedRoots.push({directory,kind:'environment',policy:'RETAIN_ALL'});process.env.MEDIA_DATA_DIR=directory;process.env.MEDIA_SKIP_IMPORT='1';});
test.after(()=>{for(const [k,v] of Object.entries(originalEnvironment))if(v===undefined)delete process.env[k];else process.env[k]=v;console.log(JSON.stringify({retainedRoots,afterPolicy:'Only known handles closed; registered metadata reported; no filesystem reads or recursive cleanup'}));});
const fault=code=>Object.assign(Error(code),{code});
async function setup(t,{snapshot=true,terminate=true}={}){
 const f=await sqliteFixture(null,[]);f.who={...f.who,librarySourceId:uuid()};
 retainedRoots.push({directory:f.dir,librarySourceId:f.who.librarySourceId,kind:'SQLite-and-synthetic-media',policy:'RETAIN_ALL'});
 const media=path.join(f.dir,'synthetic-source');await fs.mkdir(media);const file=path.join(media,'synthetic.wav');await fs.writeFile(file,Buffer.alloc(4096,17));
 const assetId=uuid(),rootId=f.input().scopes[0].rootId,a={id:assetId,root_id:rootId,kind:'music',category:'A',sub:'B',trashed:0},root={id:rootId,path:await fs.realpath(media),retired:0};
 const lib={dataDir:f.dir,asset:()=>a,rootById:()=>root,source:async()=>({a,p:file,stat:await fs.stat(file)})};
 let request,upload,now=1000,core;const handles=[];
 const auth={epoch:1,getState:()=>({configured:true,state:'logged-in',originHost:'fixture.invalid',accountId:f.who.accountId,deviceId:f.who.deviceId}),async proxy(method,url,{body}={}){if(method==='POST')request={id:uuid(),requestId:body.requestId,declaredSha256:body.sha256,declaredBytes:body.bytes,status:'APPROVED',version:1};else if(method==='DELETE')request={...request,status:'CANCELLED',version:2};return request;}};
 async function openUpload(){upload=await new CloudAudioUpload(lib,{cloudAuth:auth,enabled:true}).init();handles.push(upload);f.batches.upload=upload;return upload;}
 await openUpload();const inspected=await upload.inspectForBatch(assetId);f.sourceRows=[{...inspected,target:{visibility:'PRIVATE',groupId:null}}];
 const {b,items}=await f.create(),itemId=items[0].itemId;await f.batches.prepareItem(f.who,itemId);
 let c=f.batches.schedulerContext(f.who,itemId);await upload.action(c.item.intentId,'request');
 f.batches.schedulerObserve(f.who,itemId,c.attempt.attemptId,{clientRequestId:c.item.clientRequestId,canonicalRequestId:request.id,attemptId:request.id,requestState:'APPROVED',stateVersion:1,admissionEpoch:0},now);
 c=f.batches.schedulerContext(f.who,itemId);if(snapshot)await upload.rebuildPayload(c.item.intentId);
 const ids={intentId:c.attempt.intentId,clientRequestId:c.attempt.clientRequestId};
 const proof={proofId:uuid(),...f.who,clientRequestId:ids.clientRequestId,canonicalRequestId:request.id,attemptId:request.id,stateVersion:1,admissionEpoch:0,commitState:'NOT_COMMITTED',workerState:'SETTLED',operationsState:'SETTLED'};
 const exit={operationId:uuid(),kind:'resolve',settledAt:now,itemId,localAttemptId:c.attempt.attemptId,clientRequestId:ids.clientRequestId,identityFingerprint:fingerprint(f.who)};
 function end(){return f.batches.schedulerTerminate(f.who,f.batches.schedulerContext(f.who,itemId),proof,exit);}
 if(terminate)end();
 const x={f,b,itemId,ids,proof,exit,file,lib,auth,context:c,handles,end,get upload(){return upload;},row(){return f.store.get('cloud_upload_batch_items',{itemId});},attempt(){return f.store.get('cloud_upload_item_attempts',{attemptId:c.attempt.attemptId});},binding(){return f.batches.settledBinding(f.who,itemId,c.attempt.attemptId);},clean(){return f.batches.cleanupSettled(f.who,itemId,c.attempt.attemptId);},payload(){return path.join(upload.dir,'payload-'+ids.intentId);},async reopen(){assert.equal((await upload.dispose()).closed,true);f.reopen();await openUpload();},scheduler(){const noop=async()=>{throw fault('UNEXPECTED_REMOTE_CALL');};core=new CloudUploadScheduler(f.batches,{remote:{capabilities:noop,eligibility:noop,resources:noop,request:noop,resolve:noop,transfer:noop},clock:()=>now});core.start({recover:false,automatic:false});return core;},advance(ms){now+=ms;f.clock=now;}};
 t.after(async()=>{if(core)assert.equal((await core.dispose()).closed,true);for(const h of handles)assert.equal((await h.dispose()).closed,true);f.db.close();});return x;
}
async function absent(file){await assert.rejects(fs.lstat(file),{code:'ENOENT'});}
async function retained(x){assert.equal(x.row().cleanupPending,true);assert.equal(x.row().resourcesRetained,true);assert.equal(x.attempt().state,'FAILED_FENCED');assert.equal(x.row().receipt,null);assert.equal(x.upload.jobs.length,1);}
test('real registered payload deletes only after same-DB terminal proof/ownership; source may be gone; module and DB reopen',async t=>{
 const x=await setup(t);await fs.rename(x.file,x.file+'.retained');const unlink=x.upload._unlinkSettledPayload.bind(x.upload);let checked=false;
 x.upload._unlinkSettledPayload=async(...args)=>{assert.equal(x.attempt().terminalEvidence.proofId,x.proof.proofId);assert.equal(x.attempt().cleanupState,'PENDING');assert.ok(x.attempt().cleanupOwnership.payload.fileIdentity);checked=true;return unlink(...args);};
 const r=await x.clean();assert.equal(r.cleanupComplete,true,JSON.stringify(r));assert.equal(checked,true);await absent(x.payload());assert.equal(x.upload.jobs.length,0);assert.equal(x.row().state,'FAILED');assert.equal(x.row().cleanupPending,false);assert.equal(x.attempt().cleanupResult.payloadBytesReleased,4096);await x.reopen();assert.equal(x.upload.jobs.length,0);assert.equal(x.row().cleanupPending,false);assert.equal((await x.clean()).cleanupComplete,true);assert.equal(x.attempt().cleanupResult.payloadBytesReleased,0);
});
test('prepared intent with registered absence and cancelled real intent use no success receipt',async t=>{
 for(const cancelled of [false,true]){const x=await setup(t,{snapshot:false,terminate:false});if(cancelled)await x.upload.action(x.ids.intentId,'cancel');x.end();assert.equal((await x.clean()).cleanupComplete,true);assert.equal(x.attempt().cleanupResult.payloadBytesReleased,0);assert.equal(x.row().receipt,null);assert.equal(x.row().state,'FAILED');}
});
test('missing proof, Boolean proof and UNKNOWN cannot authorize non-success cleanup',async t=>{
 const x=await setup(t,{terminate:false});assert.throws(()=>x.f.batches.schedulerTerminate(x.f.who,x.context,undefined,x.exit));
 for(const bad of [true,{fenced:true},{...x.proof,commitState:'UNKNOWN'},{...x.proof,workerState:'ACTIVE'}])assert.throws(()=>x.f.batches.schedulerTerminate(x.f.who,x.context,bad,x.exit));
 await assert.rejects(x.clean());assert.equal((await fs.stat(x.payload())).size,4096);assert.equal(x.attempt().terminalEvidence,undefined);
});
test('active busy, controller, or same-intent operation retains payload and ledger for later retry',async t=>{
 for(const kind of ['busy','controller','operation']){const x=await setup(t);if(kind==='busy')x.upload.busy=true;else if(kind==='controller')x.upload.controllers.set(x.ids.intentId,new AbortController());else x.upload.operations.add(x.ids.intentId);assert.equal((await x.clean()).cleanupPending,true);await retained(x);if(kind==='busy')x.upload.busy=false;else if(kind==='controller')x.upload.controllers.clear();else x.upload.operations.clear();assert.equal((await x.clean()).cleanupComplete,true);}
});
test('call evidence must match fresh committed ledger exactly; wrong identity and original mapping reject',async t=>{
 const x=await setup(t);const good=x.binding();
 for(const patch of [{intentId:uuid()},{clientRequestId:uuid()},{identity:{...good.identity,accountId:uuid()}},{identity:{...good.identity,cloudServiceKey:'c'.repeat(64)}},{identity:{...good.identity,deviceId:uuid()}},{identity:{...good.identity,librarySourceId:uuid()}},{identity:{...good.identity,epoch:2}},{localAttemptId:uuid()},{serverAttemptId:uuid()},{terminalEvidence:{...good.terminalEvidence,proofId:uuid()}}])await assert.rejects(x.upload.forgetSettled(x.ids,{...good,...patch},()=>x.binding(),()=>{}));
 assert.equal((await fs.stat(x.payload())).size,4096);assert.equal(x.upload.jobs.length,1);
});
test('legacy intent without root or file ownership is retained, never adopted from metadata',async t=>{
 const x=await setup(t);const j=x.upload.jobs[0];delete j.payloadOwnership;await x.upload.save();assert.equal((await x.clean()).cleanupPending,true);await retained(x);assert.equal(x.row().cleanupReason,'PAYLOAD_OWNERSHIP_UNKNOWN');assert.equal(x.attempt().cleanupOwnership,undefined);await x.reopen();assert.equal((await x.clean()).cleanupPending,true);
});
test('known missing payload is idempotent only with reliable original ownership',async t=>{
 const x=await setup(t);await fs.rename(x.payload(),x.payload()+'.retained');assert.equal((await x.clean()).cleanupComplete,true);assert.equal(x.attempt().cleanupResult.payloadBytesReleased,0);
 const y=await setup(t);delete y.upload.jobs[0].payloadOwnership;await y.upload.save();await fs.rename(y.payload(),y.payload()+'.retained');assert.equal((await y.clean()).cleanupPending,true);
});
test('replaced file with equal bytes/hash, symlink, and hardlink are retained',async t=>{
 for(const kind of ['replacement','symlink','hardlink']){const x=await setup(t);const payload=x.payload();if(kind==='hardlink')await fs.link(payload,payload+'.other');else{await fs.rename(payload,payload+'.original');if(kind==='symlink')await fs.symlink(payload+'.original',payload);else await fs.writeFile(payload,Buffer.alloc(4096,17),{mode:0o600});}assert.equal((await x.clean()).cleanupPending,true);await retained(x);assert.ok(await fs.lstat(payload));}
});
test('replaced private root remains rejected after module reopen',async t=>{
 const x=await setup(t),old=x.upload.dir;await fs.rename(old,old+'.retained');await fs.mkdir(old,{mode:0o700});await fs.copyFile(path.join(old+'.retained','intents.json'),path.join(old,'intents.json'));await fs.copyFile(path.join(old+'.retained','payload-'+x.ids.intentId),path.join(old,'payload-'+x.ids.intentId));await fs.chmod(path.join(old,'payload-'+x.ids.intentId),0o600);assert.equal((await x.clean()).cleanupPending,true);await x.reopen();assert.equal((await x.clean()).cleanupPending,true);await retained(x);
});
test('unlink failure keeps proof and exact IDs, and retry deletes actual payload',async t=>{
 const x=await setup(t),unlink=x.upload._unlinkSettledPayload.bind(x.upload);x.upload._unlinkSettledPayload=async()=>{throw fault('SYNTHETIC_UNLINK');};assert.equal((await x.clean()).cleanupPending,true);await retained(x);assert.equal(x.attempt().terminalEvidence.proofId,x.proof.proofId);x.upload._unlinkSettledPayload=unlink;assert.equal((await x.clean()).cleanupComplete,true);await absent(x.payload());
});
test('JSON failure after real unlink does not free intent slot and survives reopen',async t=>{
 const x=await setup(t),save=x.upload.save.bind(x.upload);x.upload.save=async o=>{if(o?.omitIntentId)throw fault('SYNTHETIC_SAVE');return save(o);};assert.equal((await x.clean()).cleanupPending,true);await absent(x.payload());await retained(x);assert.equal(x.upload.jobs[0].settledCleanup.heldBytes,4096);await x.reopen();assert.equal((await x.clean()).cleanupComplete,true);assert.equal(x.attempt().cleanupResult.payloadBytesReleased,0);
});
test('directory fsync failure retains pending after unlink and original-ID replay completes',async t=>{
 const x=await setup(t),sync=x.upload.syncIntentDirectory.bind(x.upload);let once=true;x.upload.syncIntentDirectory=async()=>{if(once){once=false;throw fault('SYNTHETIC_FSYNC');}return sync();};assert.equal((await x.clean()).cleanupPending,true);await retained(x);assert.equal((await x.clean()).cleanupComplete,true);
});
test('failure at final DB acknowledgement preserves immutable termination and replays after DB/module restart',async t=>{
 const x=await setup(t),update=x.f.store.update.bind(x.f.store);x.f.store.update=(table,row,patch)=>{if(table==='cloud_upload_item_attempts'&&patch.cleanupState==='COMPLETE')throw fault('SYNTHETIC_DB_ACK');return update(table,row,patch);};assert.equal((await x.clean()).cleanupPending,true);assert.equal(x.upload.jobs.length,0);assert.equal(x.row().resourcesRetained,true);assert.equal(x.attempt().terminalEvidence.proofId,x.proof.proofId);await x.reopen();assert.equal((await x.clean()).cleanupComplete,true);assert.equal(x.attempt().cleanupState,'COMPLETE');
});
test('new attempt before cleanup and identity change never remove old payload or touch new attempt',async t=>{
 const x=await setup(t);x.f.store.transaction(()=>{const r=x.row();x.f.store.update('cloud_upload_batch_items',r,{currentAttemptId:uuid(),intentId:uuid(),clientRequestId:uuid()});});await assert.rejects(x.clean());assert.equal((await fs.stat(x.payload())).size,4096);
 const y=await setup(t);y.f.who={...y.f.who,epoch:2};y.auth.epoch=2;await assert.rejects(y.clean());assert.equal(y.upload.jobs.length,1);
});
test('late ordinary request observation cannot resurrect terminal attempt',async t=>{
 const x=await setup(t);assert.throws(()=>x.f.batches.schedulerObserve(x.f.who,x.itemId,x.context.attempt.attemptId,{clientRequestId:x.ids.clientRequestId,canonicalRequestId:x.proof.canonicalRequestId,attemptId:x.proof.attemptId,requestState:'APPROVED',stateVersion:2,admissionEpoch:0},2000));assert.equal(x.row().state,'FAILED');assert.equal(x.attempt().state,'FAILED_FENCED');
});
test('late success during cleanup remains authoritative; non-success cleanup must stop',async t=>{
 const x=await setup(t),unlink=x.upload._unlinkSettledPayload.bind(x.upload);let receipt;
 x.upload._unlinkSettledPayload=async(...args)=>{receipt={...x.f.receipt(x.row(),x.attempt()),canonicalRequestId:x.proof.canonicalRequestId,attemptId:x.proof.attemptId};await x.f.batches.recordReceipt(x.f.who,x.itemId,x.context.attempt.attemptId,receipt);return unlink(...args);};
 assert.equal((await x.clean()).cleanupPending,true);assert.equal(x.row().state,'COMMITTED');assert.equal(x.row().receipt.receiptId,receipt.receiptId);assert.equal((await fs.stat(x.payload())).size,4096);assert.equal(x.upload.jobs.length,1);assert.equal((await x.f.batches.recordReceipt(x.f.who,x.itemId,x.context.attempt.attemptId,receipt)).cleanupPending,false);assert.equal(x.upload.jobs.length,0);
});
test('FAILED cleanup retries with bounded backoff, no remote requests, and restart retains retry deadline',async t=>{
 const x=await setup(t),unlink=x.upload._unlinkSettledPayload.bind(x.upload);let tries=0;x.upload._unlinkSettledPayload=async()=>{tries++;throw fault('SYNTHETIC_UNLINK');};let core=x.scheduler();await core.tick();assert.equal(tries,1);assert.equal(x.row().state,'FAILED');const due=x.row().nextRetryAt;assert.ok(due>1000);await core.pump();assert.equal(tries,1);assert.equal((await core.dispose()).closed,true);await x.reopen();core=x.scheduler();await core.tick();assert.equal(tries,1);x.advance(due-1000+1);await core.tick();assert.equal(x.row().cleanupPending,false);await absent(x.payload());
});
test('50 intents remain occupied until JSON durable omission; actual omission frees exactly one slot',async t=>{
 const x=await setup(t),j=x.upload.jobs[0];for(let i=1;i<50;i++)x.upload.jobs.push({...clone(j),id:uuid(),clientRequestId:uuid()});await x.upload.save();const save=x.upload.save.bind(x.upload);x.upload.save=async o=>{if(o?.omitIntentId)throw fault('SYNTHETIC_SAVE');return save(o);};assert.equal((await x.clean()).cleanupPending,true);assert.equal(x.upload.jobs.length,50);await assert.rejects(x.upload.prepareWithIdentity({intentId:uuid(),clientRequestId:uuid()},x.context.item.sourceVersion,{assetId:j.assetId,sha256:j.sha256,...x.context.item.metadata}),{code:'UPLOAD_LIMIT'});x.upload.save=save;assert.equal((await x.clean()).cleanupComplete,true);assert.equal(x.upload.jobs.length,49);await x.upload.prepareWithIdentity({intentId:uuid(),clientRequestId:uuid()},x.context.item.sourceVersion,{assetId:j.assetId,sha256:j.sha256,...x.context.item.metadata});assert.equal(x.upload.jobs.length,50);
});
test('dispose timeout preserves UNKNOWN until actual paused cleanup leaves; no new operations accepted',async t=>{
 const x=await setup(t),unlink=x.upload._unlinkSettledPayload.bind(x.upload);let release,entered;const ready=new Promise(r=>entered=r);x.upload._unlinkSettledPayload=async(...args)=>{entered();await new Promise(r=>release=r);return unlink(...args);};const work=x.clean();await ready;assert.deepEqual(await x.upload.dispose({timeoutMs:10}),{closed:false,unknown:true});await assert.rejects(x.upload.rebuildPayload(x.ids.intentId));release();assert.equal((await work).cleanupPending,true);assert.equal((await x.upload.dispose()).closed,true);assert.equal((await fs.stat(x.payload())).size,4096);
});
test('child process retains live flow after UNKNOWN and naturally exits after real stream close',async()=>{
 const url=new URL('../server/cloud-audio-upload.mjs',import.meta.url).href;
 const code=`import {CloudAudioUpload} from ${JSON.stringify(url)};import {PassThrough} from 'node:stream';const u=new CloudAudioUpload({dataDir:'.'},{enabled:false});const stream=new PassThrough();const id='00000000-0000-4000-8000-000000000001';u.operations.add(id);stream.once('close',()=>u.operations.delete(id));const first=await u.dispose({timeoutMs:10});stream.destroy();await new Promise(r=>stream.once('close',r));const second=await u.dispose();process.stdout.write(JSON.stringify({first,second,destroyed:stream.destroyed}));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{timeout:3000,maxBuffer:65536});const r=JSON.parse(stdout);assert.equal(r.first.unknown,true);assert.equal(r.second.closed,true);assert.equal(r.destroyed,true);
});
test('512MB budget retains actual unlinked bytes until durable JSON removal',async t=>{
 const x=await setup(t),original=x.upload.jobs[0],next={intentId:uuid(),clientRequestId:uuid()};
 await x.upload.prepareWithIdentity(next,x.context.item.sourceVersion,{assetId:original.assetId,sha256:original.sha256,...x.context.item.metadata});await x.upload.action(next.intentId,'request');
 const save=x.upload.save.bind(x.upload);x.upload.save=async o=>{if(o?.omitIntentId)throw fault('SYNTHETIC_SAVE');return save(o);};assert.equal((await x.clean()).cleanupPending,true);await absent(x.payload());
 const jsonSize=(await fs.stat(path.join(x.upload.dir,'intents.json'))).size,filler=await fs.open(path.join(x.upload.dir,'synthetic-budget-reservation'),'wx',0o600);
 try{await filler.truncate(512000000-jsonSize-4096);await filler.sync();}finally{await filler.close();}
 await assert.rejects(x.upload.rebuildPayload(next.intentId),{code:'UPLOAD_LIMIT'});assert.equal(x.upload.jobs[0].settledCleanup.heldBytes,4096);
 x.upload.save=save;assert.equal((await x.clean()).cleanupComplete,true);await x.upload.rebuildPayload(next.intentId);assert.equal((await fs.stat(path.join(x.upload.dir,'payload-'+next.intentId))).size,4096);
});
test('fsync failure after JSON rename keeps RAM reservation; cold replay uses DB ownership and absent JSON',async t=>{
 const x=await setup(t),sync=x.upload.syncIntentDirectory.bind(x.upload);let n=0;x.upload.syncIntentDirectory=async()=>{if(++n===3)throw fault('SYNTHETIC_FINAL_FSYNC');return sync();};assert.equal((await x.clean()).cleanupPending,true);assert.equal(x.upload.jobs.length,1);assert.equal(x.row().resourcesRetained,true);const rows=JSON.parse(await fs.readFile(path.join(x.upload.dir,'intents.json'),'utf8'));assert.equal(rows.length,0);await x.reopen();assert.equal(x.upload.jobs.length,0);assert.equal((await x.clean()).cleanupComplete,true);
});
test('database mapping changes during awaited unlink boundary reject deletion and leave new IDs intact',async t=>{
 const x=await setup(t),unlink=x.upload._unlinkSettledPayload.bind(x.upload),newId=uuid();x.upload._unlinkSettledPayload=async(...args)=>{x.f.store.transaction(()=>x.f.store.update('cloud_upload_batch_items',x.row(),{currentAttemptId:newId,intentId:uuid(),clientRequestId:uuid()}));return unlink(...args);};assert.equal((await x.clean()).cleanupPending,true);assert.equal(x.row().currentAttemptId,newId);assert.equal((await fs.stat(x.payload())).size,4096);assert.equal(x.upload.jobs.length,1);
});
test('cleanup is serialized against cancel and payload rebuild on the same intent',async t=>{
 const x=await setup(t),unlink=x.upload._unlinkSettledPayload.bind(x.upload);let release,entered;const ready=new Promise(r=>entered=r);x.upload._unlinkSettledPayload=async(...args)=>{entered();await new Promise(r=>release=r);return unlink(...args);};const work=x.clean();await ready;try{await assert.rejects(x.upload.action(x.ids.intentId,'cancel'));await assert.rejects(x.upload.rebuildPayload(x.ids.intentId));assert.equal((await x.clean()).cleanupPending,true);}finally{release();}assert.equal((await work).cleanupComplete,true);
});

test('unrelated live local operation blocks cleanup; wrong client local-exit cannot terminate',async t=>{
 const x=await setup(t,{terminate:false});assert.throws(()=>x.f.batches.schedulerTerminate(x.f.who,x.context,x.proof,{...x.exit,clientRequestId:uuid()}));x.end();const other=uuid();x.upload.operations.add(other);try{assert.equal((await x.clean()).cleanupPending,true);assert.equal((await fs.stat(x.payload())).size,4096);}finally{x.upload.operations.delete(other);}assert.equal((await x.clean()).cleanupComplete,true);
});
test('corrupt full payload bytes are rejected even when recorded inode/size identity is updated',async t=>{
 const x=await setup(t);const file=await fs.open(x.payload(),'r+');try{await file.write(Buffer.from([99]),0,1,0);await file.sync();const st=await file.stat();x.upload.jobs[0].payloadOwnership.fileIdentity={dev:st.dev,ino:st.ino,size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs,birthtimeMs:st.birthtimeMs,nlink:st.nlink,mode:st.mode&0o777};}finally{await file.close();}await x.upload.save();assert.equal((await x.clean()).cleanupPending,true);await retained(x);assert.equal((await fs.stat(x.payload())).size,4096);
});
test('registered CREATING exact complete snapshot recovers; unknown INTENDING stays pending',async t=>{
 const x=await setup(t);x.upload.jobs[0].payloadOwnership.state='CREATING';await x.upload.save();await x.reopen();assert.equal((await x.clean()).cleanupComplete,true);
 const y=await setup(t);y.upload.jobs[0].payloadOwnership.state='INTENDING';delete y.upload.jobs[0].payloadOwnership.fileIdentity;await y.upload.save();await y.reopen();assert.equal((await y.clean()).cleanupPending,true);await retained(y);
});
