// Private loopback HTTP/SQLite fixture. Explicit setup is synthetic; requests exercise actual router/adapter/upload.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {sqliteFixture,rows,fixedId} from './cloud-upload-batch-mysql-fixture.mjs';
import {CloudUploadScheduler} from '../server/cloud-upload-scheduler.mjs';
import {createCloudUploadTaskRouter} from '../server/cloud-upload-task-router.mjs';
import {CloudUploadHttpAdapter} from '../server/cloud-upload-http-adapter.mjs';
import {CloudAudioUpload} from '../server/cloud-audio-upload.mjs';
import {uuid,fingerprint,clone} from '../server/cloud-upload-protocol.mjs';
export const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),fault=(code,status=409)=>Object.assign(Error(code),{code,status});
export const caps=()=>({protocol:2,writeMode:'READY',canCreateUploads:true,requiredSafety:Object.fromEntries(['sqlEligibility','contentRowLock','generationBindings','adminBarrier','integrityGate','fileOperationFence','legacyWriteFence'].map(k=>[k,true])),optional:{reuse:false},limits:{maxFileBytes:256000000,eligibilityMaxItems:50}});
const listen=async app=>{const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,url:`http://127.0.0.1:${server.address().port}`};};
const close=async server=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
export async function fixture(evidence){
 await fs.mkdir(evidence,{recursive:true});const env=await fs.mkdtemp(path.join(os.tmpdir(),'uq04d-env-'));process.env.MEDIA_DATA_DIR=env;process.env.MEDIA_SKIP_IMPORT='1';
 const f=await sqliteFixture(null,rows(1)),kept=[env,f.dir],remoteCalls=[],localCalls=[],requests=new Map(),clients=new Map(),commands=new Map();let upload,handle,scheduler,localServer,cloudServer;
 const control={patch:v=>v,hold:null,permission:null,maintenance:null,localGuard:null,dropRemote:false,delayLocal:null};
 const cloud=express();cloud.use(express.json());
 const save=body=>{const row={id:uuid(),ownerAccountId:f.who.accountId,requestId:body.requestId,mediaKind:body.mediaKind,fileName:body.fileName,declaredBytes:body.bytes,declaredSha256:body.sha256,visibility:body.visibility,groupId:body.groupId,category:body.category,subcategory:body.subcategory,status:'APPROVED',version:1,approvalThresholdBytes:1000000,createdAt:'2026-10-27T00:00:00Z',expiresAt:'2030-01-01T00:00:00Z',reviewedBy:null};requests.set(row.id,row);clients.set(row.requestId,{row,attemptId:uuid(),qualificationVersion:13,attemptVersion:7});return row;};
 cloud.use(async(req,res)=>{try{
  assert.equal(req.headers.authorization,'Bearer controlled-test-only');remoteCalls.push({method:req.method,url:req.url,body:clone(req.body??null)});let data;
  if(req.method==='GET'&&req.path==='/media/upload-capabilities')data=caps();
  else if(req.method==='POST'&&req.path==='/media/upload-requests')data=save(req.body);
  else if(req.method==='GET'&&req.path.endsWith('/retry-context')){
   const row=requests.get(req.path.split('/')[3]);if(!row)throw fault('NOT_FOUND',404);const c=clients.get(row.requestId);
   data={schema:1,ownerAccountId:row.ownerAccountId,clientRequestId:row.requestId,originalRequestId:row.id,attemptId:c.attemptId,requestVersion:row.version,requestState:row.status,requestExpiresAt:row.expiresAt,qualificationVersion:c.qualificationVersion,qualificationState:'FAILED',qualificationAttemptId:c.attemptId,qualificationRequestId:row.id,remoteAttemptVersion:c.attemptVersion,remoteAttemptState:'CANCELLED',admissionEpoch:0,admissionState:'NORMAL',backfillState:'READY',commitState:'NOT_COMMITTED',cloudReadStartedAt:'2026-10-27T01:00:00Z',cloudReadCompletedAt:'2026-10-27T01:00:01Z',request:clone(row)};
   if(control.hold)await control.hold();data=control.patch(data);
  }else if(req.method==='POST'&&req.path.endsWith('/retry-claim')){
   const body=req.body,original=req.path.split('/')[3],key=fingerprint({original,body});let record=commands.get(body.clientCommandId);
   if(record){if(record.key!==key)throw fault('IDEMPOTENCY_CONFLICT');}else{
    const old=requests.get(original);if(!old)throw fault('NOT_FOUND',404);if(body.expectedVersion!==clients.get(old.requestId).qualificationVersion)throw fault('VERSION_CONFLICT');
    const row=save(body.request),c=clients.get(row.requestId);c.attemptId=body.newAttemptId;c.qualificationVersion=14;
    record={key,data:{originalRequestId:original,clientCommandId:body.clientCommandId,newClientRequestId:row.requestId,attemptId:body.newAttemptId,serverRequestId:row.id,qualificationVersion:14,admissionEpoch:0,commitState:'NOT_COMMITTED',request:clone(row)}};commands.set(body.clientCommandId,record);
   }data=clone(record.data);if(control.dropRemote){control.dropRemote=false;throw fault('RESPONSE_ABORTED',502);}
  }else if(req.method==='GET'&&req.path.startsWith('/media/upload-request-resolutions/')){const c=clients.get(req.path.split('/').at(-1));if(!c)throw fault('NOT_FOUND',404);data={clientRequestId:c.row.requestId,canonicalRequestId:c.row.id,attemptId:c.attemptId,commitState:'NOT_COMMITTED',receipt:null,currentAvailability:'NOT_COMMITTED',qualificationVersion:c.qualificationVersion,admissionEpoch:0,storageGeneration:null};}
  else if(req.method==='GET'&&req.path.startsWith('/media/upload-requests/')){data=clone(requests.get(req.path.split('/').at(-1)));if(!data)throw fault('NOT_FOUND',404);}
  else throw fault('UNEXPECTED_REMOTE_ROUTE',404);
  res.json({data});
 }catch(e){res.status(e.status??500).json({error:{code:e.code??'FIXTURE_ERROR'}});}});
 const cloudEndpoint=await listen(cloud);cloudServer=cloudEndpoint.server;
 const auth={get epoch(){return f.who.epoch;},getState:()=>({configured:true,state:'logged-in',originHost:'controlled.invalid',accountId:f.who.accountId,deviceId:f.who.deviceId}),async uploadAudioContent(){throw fault('UNEXPECTED_CONTENT');},async proxy(method,route,{body=null,epoch}={}){assert.equal(epoch,f.who.epoch);const response=await fetch(cloudEndpoint.url+route,{method,headers:{Authorization:'Bearer controlled-test-only',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw fault(data.error.code,response.status);return data.data;}};
 const file=path.join(f.dir,'synthetic.wav');await fs.writeFile(file,Buffer.alloc(32,19));const assetId=uuid(),asset={id:assetId,root_id:fixedId(9),kind:'music',category:'A',sub:'B',trashed:0};
 const lib={dataDir:f.dir,asset:()=>asset,rootById:()=>({id:fixedId(9),path:f.dir,retired:0}),source:async()=>({a:asset,p:file,stat:await fs.stat(file)})};
 upload=await new CloudAudioUpload(lib,{cloudAuth:auth,enabled:true}).init();f.batches.upload=upload;const adapter=new CloudUploadHttpAdapter({auth,upload,currentIdentity:()=>f.who});
 const inspected=await upload.inspectForBatch(assetId);f.sourceRows=[{...inspected,target:{visibility:'PRIVATE',groupId:null}}];const created=await f.create(),itemId=created.items[0].itemId;
 await f.batches.prepareItem(f.who,itemId);let c=f.batches.schedulerContext(f.who,itemId);await upload.action(c.item.intentId,'request');const remote=clients.get(c.item.clientRequestId);
 f.batches.schedulerObserve(f.who,itemId,c.attempt.attemptId,{clientRequestId:c.item.clientRequestId,canonicalRequestId:remote.row.id,attemptId:remote.attemptId,requestState:'APPROVED',stateVersion:1,requestVersion:1,qualificationVersion:13,admissionEpoch:0},1000);c=f.batches.schedulerContext(f.who,itemId);remote.row.status='CANCELLED';remote.row.version=9;
 const proof={proofId:uuid(),...f.who,clientRequestId:c.item.clientRequestId,canonicalRequestId:remote.row.id,attemptId:remote.attemptId,stateVersion:7,admissionEpoch:0,commitState:'NOT_COMMITTED',workerState:'SETTLED',operationsState:'SETTLED',budgetState:'SETTLED',attemptState:'CANCELLED',observedAt:'2026-10-27T00:00:00Z',versionKind:'attempt'},exit={operationId:uuid(),kind:'resolve',settledAt:1000,itemId,localAttemptId:c.attempt.attemptId,clientRequestId:c.item.clientRequestId,identityFingerprint:fingerprint(f.who)};
 f.batches.schedulerTerminate(f.who,c,proof,exit);assert.equal((await f.batches.cleanupSettled(f.who,itemId,c.attempt.attemptId)).cleanupComplete,true);
 const noWork=async()=>{throw fault('UNEXPECTED_DISPATCH');};scheduler=new CloudUploadScheduler(f.batches,{remote:{capabilities:noWork,eligibility:noWork,resources:noWork,request:noWork,resolve:noWork,transfer:noWork}}); // never start/tick
 const app=express();app.use(express.json({verify(req,_res,buffer){req.cloudUploadRawBody=buffer;}}));
 handle=createCloudUploadTaskRouter({preview:f.preview,batches:f.batches,scheduler,retryRemote:adapter,currentIdentity:()=>f.who,guardLocalRequest:async(req,{write})=>{if(control.localGuard)await control.localGuard();if(req.headers.host!==new URL(result.url).host||req.headers.origin&&req.headers.origin!==new URL(result.url).origin||!req.headers.cookie?.includes('media_session=controlled'))throw fault('LOCAL_SESSION_REQUIRED',401);if(write&&req.headers['x-local-token']!=='controlled-token')throw fault('LOCAL_TOKEN_REQUIRED',401);return{allowed:true,sessionId:'controlled'};},authorize:async()=>{if(control.permission)await control.permission();return{allowed:true};},assertMaintenance:async()=>{if(control.maintenance)await control.maintenance();return{allowed:true};}});
 app.use('/api/cloud-upload-tasks',async(req,res,next)=>{localCalls.push({method:req.method,url:req.url,body:clone(req.body??null)});if(control.delayLocal)await control.delayLocal(req);handle.router(req,res,next);});
 const localEndpoint=await listen(app);localServer=localEndpoint.server;
 const result={f,kept,app,adapter,upload,remoteCalls,localCalls,control,commands,clients,requests,url:localEndpoint.url,batchId:created.b.batchId,itemId,get version(){return f.batches.item(f.who,itemId).r.version;},scope:()=>fingerprint(f.who),async call(method,route,body){const res=await fetch(result.url+'/api/cloud-upload-tasks'+route,{method,headers:{Cookie:'media_session=controlled',Origin:result.url,...(body?{'Content-Type':'application/json','x-local-token':'controlled-token'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:res.status,body:await res.json()};},async close(){handle.dispose();await close(localServer);await close(cloudServer);assert.equal((await scheduler.dispose()).closed,true);assert.equal((await upload.dispose()).closed,true);f.db.close();await fs.writeFile(path.join(evidence,'resource-exit.json'),JSON.stringify({kept,policy:'RETAIN_ALL; known handles closed, no after filesystem scan/removal'},null,2));}};
 remoteCalls.length=0;localCalls.length=0;return result;
}
export async function backendTests(evidence){const checks=[],b=await fixture(evidence);const record=s=>checks.push(s),route=()=>`/batches/${b.batchId}/items/${b.itemId}/retry-qualification?itemVersion=${b.version}`;
 try{
  const before=b.f.db.prepare('SELECT * FROM cloud_upload_batch_items').all(),save=b.upload.save,accept=b.upload.acceptBatchRequest,resources=b.upload.registeredResources;let sideEffects=0;
  b.upload.save=b.upload.acceptBatchRequest=b.upload.registeredResources=async()=>{sideEffects++;throw fault('READ_SIDE_EFFECT');};
  let one=await b.call('GET',route());assert.equal(one.status,200,JSON.stringify(one));assert.equal(one.body.data.requestVersion,9);assert.equal(one.body.data.qualificationVersion,13);assert.notEqual(one.body.data.itemVersion,13);assert.deepEqual(b.f.db.prepare('SELECT * FROM cloud_upload_batch_items').all(),before);assert.equal(sideEffects,0);assert.equal(b.remoteCalls.length,1);assert.equal(b.remoteCalls[0].method,'GET');record('owned read actual localHTTP→adapter→remoteHTTP; distinct item/request/q, no upload save/accept/resource scan');
  for(const patch of [v=>({...v,qualificationVersion:null}),v=>({...v,qualificationAttemptId:uuid()}),v=>({...v,ownerAccountId:uuid()}),v=>({...v,commitState:'COMMITTED'}),v=>({...v,cloudReadCompletedAt:null}),v=>({...v,cloudReadCompletedAt:'2020-01-01T00:00:00Z'}),v=>({...v,admissionEpoch:1}),v=>({...v,requestVersion:8}),v=>({...v,remoteAttemptVersion:8})]){b.control.patch=patch;assert.notEqual((await b.call('GET',route())).status,200);}b.control.patch=v=>v;record('missing q/time, wrong owner/lineage/admission/request/attempt versions and committed forbid retry');
  assert.equal((await b.call('GET',route()+'&forged=1')).status,400);assert.equal((await b.call('GET',route().replace(b.batchId,uuid()))).status,404);record('strict GET query and URL owned batch binding');
  for(const field of ['accountId','deviceId','librarySourceId','cloudServiceKey','epoch']){const old=b.f.who;b.control.hold=async()=>{b.f.who={...old,[field]:field==='epoch'?old.epoch+1:field==='cloudServiceKey'?'c'.repeat(64):uuid()};};const r=await b.call('GET',route());assert.notEqual(r.status,200,field);b.f.who=old;b.control.hold=null;}record('every identity dimension changing during remote await discards response');
  const original=b.f.batches.schedulerContext(b.f.who,b.itemId),oldItem=clone(original.item);
  b.control.hold=async()=>{b.f.store.update('cloud_upload_batch_items',oldItem,{lastCode:'CHANGED_DURING_READ'});};assert.equal((await b.call('GET',route())).status,409);b.control.hold=null;record('local item changed during await invalidates read before response');
  // At final permission await, change currentAttemptId; final sync guard must still reject.
  let permissions=0;b.control.permission=async()=>{if(++permissions===2){const r=b.f.batches.item(b.f.who,b.itemId).r;b.f.store.update('cloud_upload_batch_items',r,{metadataFingerprint:'d'.repeat(64)});}};assert.equal((await b.call('GET',route())).status,409);b.control.permission=null;record('final permission-await mutation cannot leak stale qualification DTO');
  b.upload.save=save;b.upload.acceptBatchRequest=accept;b.upload.registeredResources=resources;
  await fs.writeFile(path.join(evidence,'http-trace.json'),JSON.stringify({localCalls:b.localCalls,remoteCalls:b.remoteCalls,commandIds:[...b.commands.keys()],cloudFixture:'controlled loopback; no credentials in trace'},null,2));await fs.writeFile(path.join(evidence,'results.json'),JSON.stringify({passed:true,checks,remote:'controlled loopback cloud DTO/claim fixture; Java H2 validated separately',schedulerStarted:false},null,2));console.log(JSON.stringify({passed:true,checks:checks.length}));
 }finally{await b.close();}return checks;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await backendTests(path.resolve(process.argv[2]));
