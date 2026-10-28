// Actual domain/SQLite + real loopback HTTP. Remote/host permits and upload resource waits are explicit controlled substitutes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import express from 'express';
import {CloudUploadScheduler} from '../server/cloud-upload-scheduler.mjs';
import {createCloudUploadTaskRouter,CLOUD_UPLOAD_TASK_BASE as BASE} from '../server/cloud-upload-task-router.mjs';
import {sqliteFixture,rows} from './cloud-upload-batch-mysql-fixture.mjs';
import {uuid,clone} from '../server/cloud-upload-protocol.mjs';
export const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const retained=[],fault=(code,status=409)=>Object.assign(Error(code),{code,status});
const caps=()=>({protocol:2,writeMode:'READY',canCreateUploads:true,requiredSafety:Object.fromEntries(['sqlEligibility','contentRowLock','generationBindings','adminBarrier','integrityGate','fileOperationFence','legacyWriteFence'].map(k=>[k,true])),optional:{reuse:false},limits:{maxFileBytes:256000000,eligibilityMaxItems:50}});
export async function setup(t=null){
 const f=await sqliteFixture(null,rows(1));f.who={...f.who,librarySourceId:uuid()};retained.push({directory:f.dir,policy:'RETAIN_ALL',atSetup:true});const events=[],requests=new Map();let active=null;
 const control={allowed:true,enter:null,check:null,leave:null,prepare:null,capabilities:null,transfer:null,forget:null,unknownLeave:false};
 const permit={async enter(who,{signal}){events.push('enter');if(control.enter)await control.enter(who,signal);if(!control.allowed)return{allowed:false,permit:null};assert.equal(active,null);active={id:uuid(),who:clone(who)};return{allowed:true,permit:active};},async check(who,token,{signal}){assert.equal(token,active);assert.deepEqual(who,token.who);events.push('check');if(control.check)await control.check(who,signal);return{allowed:control.allowed};},async leave(who,token,proof){assert.equal(token,active);assert.deepEqual(who,token.who);assert.equal(proof.settled,true);events.push('leave-enter');if(control.leave)await control.leave();if(control.unknownLeave)return{released:false,settled:false,closed:false,unknown:true};active=null;events.push('leave-settled');return{released:true,settled:true};}};
 const originalPrepare=f.upload.prepareWithIdentity.bind(f.upload),originalForget=f.upload.forgetVerified.bind(f.upload);
 f.upload.prepareWithIdentity=async(...args)=>{events.push('prepare-enter');if(control.prepare)await control.prepare();const r=await originalPrepare(...args);events.push('prepare-settled');return r;};
 f.upload.forgetVerified=async(...args)=>{events.push('cleanup-enter');if(control.forget)await control.forget();const r=await originalForget(...args);events.push('cleanup-settled');return r;};
 f.upload.releasePayloadForApproval=async()=>{};f.upload.rebuildPayload=async()=>{};
 const observation=(c,r)=>({clientRequestId:c.item.clientRequestId,canonicalRequestId:r.id,attemptId:r.attemptId,requestState:'APPROVED',stateVersion:1,requestVersion:1,qualificationVersion:13,admissionEpoch:0});
 const remote={async capabilities(){events.push('capabilities');if(control.capabilities)await control.capabilities();return caps();},async eligibility(){events.push('eligibility');return{classification:'NEW',reviewRequired:false};},async resources(){events.push('resources');return{known:true,activeIntents:f.upload.jobs.size,intentBytes:100*f.upload.jobs.size,snapshotBytes:0};},async request(who,c){events.push('request');let r=requests.get(c.item.clientRequestId);if(!r){r={id:uuid(),attemptId:uuid()};requests.set(c.item.clientRequestId,r);}return observation(c,r);},async resolve(who,c){const r=requests.get(c.item.clientRequestId);return{clientRequestId:c.item.clientRequestId,commitState:'NOT_COMMITTED',request:observation(c,r)};},async transfer(who,c){events.push('transfer-enter');if(control.transfer)await control.transfer();const r=requests.get(c.item.clientRequestId);events.push('transfer-settled');return{clientRequestId:c.item.clientRequestId,commitState:'COMMITTED',receipt:{...f.receipt(c.item,c.attempt),canonicalRequestId:r.id,attemptId:r.attemptId}};},async retryClaim(){throw fault('TEST_RETRY_NOT_CONFIGURED');}};
 const core=new CloudUploadScheduler(f.batches,{remote,clock:()=>1000,operationMs:10000,dispatchPermit:permit});let handle,server,lastResponse;
 const x={f,events,control,permit,remote,core,get hostActive(){return active!==null;},get handle(){return handle;},get lastResponse(){return lastResponse;},get port(){return server.address().port;},async http(){const app=express();app.use((req,res,next)=>{lastResponse=res;next();});handle=createCloudUploadTaskRouter({preview:f.preview,batches:f.batches,scheduler:core,retryRemote:remote,currentIdentity:()=>f.who,guardLocalRequest:async(req,{write})=>{if(req.headers.cookie!=='media_session=controlled'||write&&req.headers['x-local-token']!=='controlled')throw fault('LOCAL_SESSION_REQUIRED',401);return{allowed:true,sessionId:'controlled'};},authorize:async()=>({allowed:true}),assertMaintenance:async()=>({allowed:control.allowed})});app.use(BASE,handle.router);server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return x;},async get(route){const response=await fetch(`http://127.0.0.1:${x.port}${BASE}${route}`,{headers:{Cookie:'media_session=controlled'}});return{status:response.status,body:await response.json()};},async close(){handle?.dispose();if(handle)assert.equal((await handle.drain({timeoutMs:1000})).closed,true);if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}const result=await core.dispose({timeoutMs:1000});assert.equal(result.closed,true);assert.equal(x.hostActive,false);if(f.db.open)f.db.close();}};
 t?.after(()=>x.close());return x;
}
const main=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main&&process.argv[2]==='interleaving-child'){
 const variant=process.argv[3],uncertain=variant.endsWith('-unknown')||variant.endsWith('-closedfalse'),identityChange=variant.startsWith('identity');
 const reply=variant.endsWith('closedfalse')?{allowed:true,closed:false}:uncertain?{allowed:true,unknown:true}:{allowed:true,unknown:false,closed:true};
 const x=await setup(),entered=deferred(),release=deferred();x.permit.check=async()=>{entered.resolve();await release.promise;return reply;};x.core.start({recover:false,automatic:false});await x.f.create();const work=x.core.tick().catch(e=>({code:e.code}));await entered.promise;
 const first=identityChange?null:await x.core.dispose({timeoutMs:0});if(identityChange)x.f.who={...x.f.who,epoch:x.f.who.epoch+1};release.resolve();const outcome=await work,final=await x.core.dispose({timeoutMs:0});
 assert.equal(outcome.code,identityChange?'AUTH_CHANGED':'SCHEDULER_CLOSING');assert.equal(x.events.includes('capabilities'),false);assert.equal(x.f.db.open,true);
 if(uncertain){assert.equal(final.closed,false);assert.equal(final.unknown,true);assert.equal(x.core.dispatchState().unknown,true);assert.equal(x.core.dispatchState().held,true);assert.equal(x.hostActive,true);assert.equal(x.events.includes('leave-enter'),false);assert.equal(x.core.release(),false);const next=new CloudUploadScheduler(x.f.batches,{remote:x.remote});assert.throws(()=>next.start({recover:false,automatic:false}),{code:'SCHEDULER_ACTIVE'});}
 else{assert.equal(final.closed,true);assert.equal(final.unknown,false);assert.equal(x.hostActive,false);assert.equal(x.events.includes('leave-settled'),true);assert.equal(x.core.dispatchState().settled,true);}
 const evidence={variant,reply,first,outcome,final,dispatch:x.core.dispatchState(),hostActive:x.hostActive,events:x.events,root:x.f.dir,dbOpenBeforeExit:x.f.db.open,unknownRetained:uncertain};if(!uncertain)await x.close();console.log('UQ04B1_R1_INTERLEAVING='+JSON.stringify(evidence));
}else if(main&&process.argv[2]==='unknown-child'){
 const x=await setup();if(process.argv[3]==='check')x.permit.check=async()=>({allowed:true,unknown:true});else x.control.unknownLeave=true;x.core.start({recover:false,automatic:false});await x.f.create();await x.core.tick().catch(()=>{});
 assert.equal(x.core.dispatchState().unknown,true);assert.equal(x.core.state().closed,false);const result=await x.core.dispose({timeoutMs:0});assert.equal(result.closed,false);assert.equal(result.unknown,true);assert.equal(x.f.db.open,true);assert.equal(x.hostActive,true);
 const competing=new CloudUploadScheduler(x.f.batches,{remote:x.remote});assert.throws(()=>competing.start({recover:false,automatic:false}),{code:'SCHEDULER_ACTIVE'});assert.equal(x.core.release(),false);assert.equal(x.f.db.open,true);
 console.log('UQ04B1_UNKNOWN='+JSON.stringify({result,dispatch:x.core.dispatchState(),keptRoot:x.f.dir,dbRetained:true,ownerRetained:true,policy:'No forced release/DB close; isolated child naturally exits; files retained'}));
}else if(main){
 const prior={MEDIA_DATA_DIR:process.env.MEDIA_DATA_DIR,MEDIA_SKIP_IMPORT:process.env.MEDIA_SKIP_IMPORT};
 test.before(async()=>{const env=await fs.mkdtemp(path.join(os.tmpdir(),'uq04b1-env-'));process.env.MEDIA_DATA_DIR=env;process.env.MEDIA_SKIP_IMPORT='1';retained.push({directory:env,policy:'RETAIN_ALL',atSetup:true});});
 test.after(()=>{for(const[k,v]of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;console.log('UQ04B1_RESOURCES='+JSON.stringify({retained,teardown:'Only known actual promises/HTTP/core/DB handles closed after confirmed settlement, no after filesystem scan/removal'}));});
 test('construction and GET never acquire dispatch permit, start, recover or prepare',async t=>{
  const x=await setup(t);await x.http();assert.deepEqual(x.core.state(),{started:false,closing:false,closed:false,inflight:0,timers:0});assert.equal((await x.get('/batches')).status,200);assert.deepEqual(x.events,[]);assert.equal(x.core.dispatchState().settled,true);assert.equal(x.handle.state().active,0);
 });
 test('response finish does not settle a domain handler; the original accepted command still commits during drain',async t=>{
  const x=await setup(t);await x.http();const entered=deferred(),release=deferred(),original=x.f.preview.snapshotScope;x.f.preview.snapshotScope=async(...args)=>{entered.resolve();await release.promise;return original(...args);};
  const body=x.f.input(),response=fetch(`http://127.0.0.1:${x.port}${BASE}/previews`,{method:'POST',headers:{Cookie:'media_session=controlled','x-local-token':'controlled','Content-Type':'application/json'},body:JSON.stringify(body)});
  await entered.promise;try{x.lastResponse.status(202).json({controlledEarlyResponse:true});assert.equal((await response).status,202);assert.equal(x.handle.state().active,1);assert.equal((await x.handle.drain({timeoutMs:5})).closed,false);assert.equal(x.f.db.open,true);}finally{release.resolve();}
  assert.equal((await x.handle.drain({timeoutMs:1000})).closed,true);assert.equal(x.f.db.prepare('SELECT COUNT(*) n FROM cloud_upload_previews').get().n,1);
 });
 test('maintenance blocks background tick before prepare or remote dispatch without changing a command',async t=>{
  const x=await setup(t);x.core.start({recover:false,automatic:false});const created=await x.f.create();const before=x.f.db.prepare('SELECT record_json FROM cloud_upload_batch_items').all();x.control.allowed=false;
  const result=await x.core.tick();assert.equal(result.code,'MAINTENANCE_BUSY');assert.deepEqual(x.events,['enter']);assert.equal(x.f.upload.jobs.size,0);assert.equal(x.f.batches.item(x.f.who,created.items[0].itemId).r.currentAttemptId,null);assert.deepEqual(x.f.db.prepare('SELECT record_json FROM cloud_upload_batch_items').all(),before);assert.equal(x.core.dispatchState().settled,true);
 });
 test('permit acquisition await must recheck identity and release only the original acquired token',async t=>{
  const x=await setup(t),entered=deferred(),release=deferred();x.control.enter=async()=>{entered.resolve();await release.promise;};x.core.start({recover:false,automatic:false});await x.f.create();const work=x.core.tick();const outcome=work.catch(e=>e);await entered.promise;assert.equal(x.core.dispatchState().acquiring,true);x.f.who={...x.f.who,epoch:x.f.who.epoch+1};release.resolve();assert.equal((await outcome).code,'AUTH_CHANGED');assert.equal(x.events.includes('prepare-enter'),false);assert.equal(x.events.includes('leave-settled'),true);assert.equal(x.core.dispatchState().settled,true);
 });
 test('awaiting a host maintenance check cannot carry an old identity into dispatch',async t=>{
  const x=await setup(t),entered=deferred(),release=deferred();x.control.check=async()=>{x.control.check=null;entered.resolve();await release.promise;};x.core.start({recover:false,automatic:false});await x.f.create();const outcome=x.core.tick().catch(e=>e);await entered.promise;x.f.who={...x.f.who,accountId:uuid()};release.resolve();assert.equal((await outcome).code,'AUTH_CHANGED');assert.equal(x.events.includes('capabilities'),false);assert.equal(x.hostActive,false);
 });
 test('maintenance changing during actual remote await blocks subsequent preparation',async t=>{
  const x=await setup(t),entered=deferred(),release=deferred();x.core.start({recover:false,automatic:false});await x.f.create();x.control.capabilities=async()=>{entered.resolve();await release.promise;};const work=x.core.tick();await entered.promise;assert.equal(x.hostActive,true);x.control.allowed=false;release.resolve();await work;assert.equal(x.events.includes('prepare-enter'),false);assert.equal(x.events.includes('request'),false);assert.equal(x.events.includes('leave-settled'),true);
 });
 test('prepare await stays owned across dispose timeout and only actual settlement permits another owner',async t=>{
  const x=await setup(t),entered=deferred(),release=deferred();x.control.prepare=async()=>{entered.resolve();await release.promise;};x.core.start({recover:false,automatic:false});await x.f.create();const work=x.core.tick();await entered.promise;
  try{const result=await x.core.dispose({timeoutMs:5});assert.equal(result.closed,false);assert.equal(result.unknown,true);assert.equal(x.f.db.open,true);assert.equal(x.hostActive,true);const other=new CloudUploadScheduler(x.f.batches,{remote:x.remote});assert.throws(()=>other.start({recover:false,automatic:false}),{code:'SCHEDULER_ACTIVE'});assert.equal(x.events.includes('leave-enter'),false);}finally{release.resolve();}
  await work;assert.equal((await x.core.dispose()).closed,true);assert.equal(x.hostActive,false);const other=new CloudUploadScheduler(x.f.batches,{remote:x.remote});other.start({recover:false,automatic:false});assert.equal((await other.dispose()).closed,true);
 });
 test('late authoritative commit and asynchronous receipt resource cleanup stay inside one permit',async t=>{
  const x=await setup(t);x.core.start({recover:false,automatic:false});const created=await x.f.create();await x.core.tick();await x.core.tick();x.events.length=0;
  const transferEntered=deferred(),transferRelease=deferred(),cleanupEntered=deferred(),cleanupRelease=deferred();x.control.transfer=async()=>{transferEntered.resolve();await transferRelease.promise;};x.control.forget=async()=>{cleanupEntered.resolve();await cleanupRelease.promise;};const work=x.core.tick();await transferEntered.promise;
  assert.equal((await x.core.dispose({timeoutMs:5})).closed,false);assert.equal(x.hostActive,true);transferRelease.resolve();await cleanupEntered.promise;
  assert.equal(x.f.batches.item(x.f.who,created.items[0].itemId).r.receipt!==null,true);assert.equal(x.events.includes('leave-enter'),false);assert.equal(x.core.state().inflight,1);assert.equal(x.f.db.open,true);cleanupRelease.resolve();await work;
  assert.equal((await x.core.dispose()).closed,true);assert.equal(x.hostActive,false);assert.ok(x.events.indexOf('cleanup-settled')<x.events.indexOf('leave-enter'));assert.equal(x.f.batches.summary(x.f.who,created.b.batchId).counts.committed,1);
 });
 test('host leave promise remains inflight after domain settled; timeout cannot claim release',async t=>{
  const x=await setup(t),entered=deferred(),release=deferred();x.control.leave=async()=>{entered.resolve();await release.promise;};x.core.start({recover:false,automatic:false});await x.f.create();const work=x.core.tick();await entered.promise;
  try{assert.equal(x.core.dispatchState().releasing,true);assert.equal((await x.core.dispose({timeoutMs:5})).closed,false);assert.equal(x.hostActive,true);assert.equal(x.f.db.open,true);}finally{release.resolve();}await work;assert.equal((await x.core.dispose()).closed,true);assert.equal(x.core.dispatchState().settled,true);
 });
 test('unknown host release retains ownership and database in an isolated naturally exiting process',async()=>{
  for(const variant of ['leave','check']){const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'unknown-child',variant],{timeout:5000,maxBuffer:65536});const line=stdout.split('\n').find(s=>s.startsWith('UQ04B1_UNKNOWN='));assert.ok(line);const result=JSON.parse(line.split('=').slice(1).join('='));assert.equal(result.dbRetained,true);assert.equal(result.ownerRetained,true);assert.equal(result.result.closed,false);retained.push({directory:result.keptRoot,policy:'RETAIN_ALL',childNaturallyExited:true,unknownOwnerWasNotForceReleased:true});}
 });
 for(const variant of ['dispose-unknown','dispose-closedfalse','identity-unknown','identity-closedfalse','dispose-known','identity-known'])test(`awaited host uncertainty survives ${variant} without false release`,async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'interleaving-child',variant],{timeout:5000,maxBuffer:65536});const line=stdout.split('\n').find(x=>x.startsWith('UQ04B1_R1_INTERLEAVING='));assert.ok(line);const result=JSON.parse(line.slice('UQ04B1_R1_INTERLEAVING='.length));assert.equal(result.variant,variant);if(variant.endsWith('-unknown'))assert.equal(result.reply.unknown,true);if(variant.endsWith('-closedfalse'))assert.equal(result.reply.closed,false);if(variant.endsWith('-known')){assert.equal(result.reply.unknown,false);assert.equal(result.reply.closed,true);}retained.push({directory:result.root,policy:'RETAIN_ALL',childNaturallyExited:true,unknownOwnerRetained:result.unknownRetained});console.log('UQ04B1_R1_EVIDENCE='+JSON.stringify(result));
 });

}
