import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { CloudManagement, readAudioMaintenanceRequest } from '../server/cloud-management.mjs';
const op='11111111-1111-4111-8111-111111111111',run='22222222-2222-4222-8222-222222222222',fp='a'.repeat(64);
const fields=['controlled.invalid','owner-public-id','device-public-id','session-public-id'];
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const actor=digest(fields),plan={operationId:op,expectedProtocolVersion:0,expectedStorageVersion:2,clientIdentity:actor};
const view=(state='PLANNED')=>({runId:run,operationId:op,manifestFingerprint:fp,state,expiresAt:new Date(Date.now()+900000).toISOString(),objects:2,bytes:138025,receipt:state==='ENABLED'?{runId:run,manifestFingerprint:fp,objects:2,verifiedBytes:138025,protocolVersion:2,reconciliationVersion:4,writeMode:'READY',storageState:'READY',adoptedAt:new Date().toISOString()}:null});
const facade=()=>{const calls=[];const state={state:'logged-in',originHost:fields[0],accountId:fields[1],deviceId:fields[2],sessionId:fields[3]};const auth={epoch:0,getState:()=>state,proxy:async(method,path,options)=>{calls.push({method,path,options});return view();}};return {auth,state,calls,mgmt:new CloudManagement({}, {cloudAuth:auth})};};
test('fixed three paths/methods, exact remote DTO and same-identity witness; safe public projection',async()=>{
 const f=facade();f.auth.proxy=async(method,path,options)=>{f.calls.push({method,path,options});const v=view(path.endsWith('/apply')?'ENABLED':'PLANNED');return {...v,token:'SECRET_SENTINEL',manifest:{fileName:'PRIVATE_SENTINEL'},receipt:v.receipt?{...v.receipt,privatePath:'PRIVATE_SENTINEL'}:null};};
 const p=await f.mgmt.planAudioMaintenance(plan);assert.equal(p.state,'PLANNED');assert.equal(JSON.stringify(p).includes('SENTINEL'),false);
 const a=await f.mgmt.applyAudioMaintenance(run,{operationId:op,manifestFingerprint:fp,recoverBound:false,clientIdentity:actor});assert.equal(a.receipt.writeMode,'READY');await f.mgmt.audioMaintenanceStatus(run,actor);
 assert.deepEqual(f.calls.map(x=>[x.method,x.path]),[['POST','/system/audio-maintenance/plan'],['POST',`/system/audio-maintenance/runs/${run}/apply`],['GET',`/system/audio-maintenance/runs/${run}`]]);
 assert.deepEqual(f.calls[0].options.body,{operationId:op,expectedProtocolVersion:0,expectedStorageVersion:2});assert.deepEqual(f.calls[1].options.body,{operationId:op,manifestFingerprint:fp,recoverBound:false});assert.equal(f.calls[2].options.body,null);assert.ok(f.calls.every(x=>x.options.epoch===0&&x.options.bearer===true));
});
test('extra/oversized/missing/type/unsafe version/URL inputs reject before remote; witness not authorization',async()=>{
 const f=facade();for(const bad of [{...plan,url:'https://evil.invalid'},{...plan,operationId:'../runs'},{...plan,expectedProtocolVersion:'0'},{...plan,expectedStorageVersion:Number.MAX_SAFE_INTEGER},{...plan,clientIdentity:fields.join(':')},{operationId:op,expectedProtocolVersion:0},{...plan,padding:'x'.repeat(4096)}])await assert.rejects(f.mgmt.planAudioMaintenance(bad));
 for(const bad of [{operationId:op,manifestFingerprint:fp,recoverBound:1,clientIdentity:actor},{operationId:op,manifestFingerprint:fp.toUpperCase(),recoverBound:false,clientIdentity:actor}])await assert.rejects(f.mgmt.applyAudioMaintenance(run,bad));
 await assert.rejects(f.mgmt.audioMaintenanceStatus('../'+run,actor));assert.equal(f.calls.length,0);
});
test('old UI/new server identity refuses plan/apply/status before transport; correct new witness remains usable',async()=>{
 const f=facade();f.state.sessionId='new-public-session';for(const work of [()=>f.mgmt.planAudioMaintenance(plan),()=>f.mgmt.applyAudioMaintenance(run,{operationId:op,manifestFingerprint:fp,recoverBound:false,clientIdentity:actor}),()=>f.mgmt.audioMaintenanceStatus(run,actor)])await assert.rejects(work(),e=>e.code==='STALE');assert.equal(f.calls.length,0);
 const fresh=digest([...fields.slice(0,3),f.state.sessionId]);await f.mgmt.planAudioMaintenance({...plan,clientIdentity:fresh});assert.equal(f.calls.length,1);
});
test('epoch-bound queued writes/late replies are rejected without borrowing new identity',async()=>{
 const f=facade();let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);f.auth.proxy=async()=>{f.calls.push('first');entered();await gate;return view();};const first=f.mgmt.planAudioMaintenance(plan);await seen;const second=f.mgmt.planAudioMaintenance({...plan,operationId:'33333333-3333-4333-8333-333333333333'});const a=assert.rejects(first,e=>e.code==='STALE'),b=assert.rejects(second,e=>e.code==='STALE');f.auth.epoch++;release();await Promise.all([a,b]);assert.equal(f.calls.length,1);
});
test('unchanged epoch but changed public session during await cannot deliver success to stale UI',async()=>{
 const f=facade();f.auth.proxy=async()=>{f.state.sessionId='different';return view();};await assert.rejects(f.mgmt.planAudioMaintenance(plan),e=>e.code==='STALE');
});
test('BOUND/NEEDS_RECHECK remain non-success; typed receipt mismatch is invalid; fixed recovery flag preserved',async()=>{
 const f=facade();for(const state of ['BOUND','NEEDS_RECHECK']){f.auth.proxy=async()=>view(state);assert.equal((await f.mgmt.applyAudioMaintenance(run,{operationId:op,manifestFingerprint:fp,recoverBound:true,clientIdentity:actor})).receipt,null);}
 f.auth.proxy=async()=>({...view('ENABLED'),receipt:{...view('ENABLED').receipt,verifiedBytes:1}});await assert.rejects(f.mgmt.planAudioMaintenance(plan),e=>e.code==='RESPONSE_INVALID');
 f.auth.proxy=async()=>({...view(),operationId:run});await assert.rejects(f.mgmt.planAudioMaintenance(plan),e=>e.code==='RESPONSE_INVALID');
});
async function parserFixture(t){let accepted=0;const server=http.createServer(async(req,res)=>{req.originalUrl=req.url;try{const input=await readAudioMaintenanceRequest(req,{write:req.method==='POST'});accepted++;res.setHeader('content-type','application/json');res.end(JSON.stringify({input}));}catch(e){res.writeHead(e.status||400);res.end('invalid');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return {port:server.address().port,get accepted(){return accepted;}};}
const send=(port,{body='',method='POST',url='/',headers={}}={})=>new Promise((resolve,reject)=>{const data=Buffer.isBuffer(body)?body:Buffer.from(body);const req=http.request({host:'127.0.0.1',port,path:url,method,headers:{...(method==='POST'?{'content-type':'application/json','content-length':String(data.length)}:{}),...headers}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});req.once('error',reject);req.end(data);});
test('raw 4KiB parser rejects duplicate decoded keys/UTF8/query/encoding/chunked/body on GET',async t=>{
 const f=await parserFixture(t);assert.equal(await send(f.port,{body:JSON.stringify(plan)}),200);
 for(const body of ['{"x":1,"x":2}','{"x":1,"\\u0078":2}',Buffer.from([0xff]),'x'.repeat(4097)])assert.ok((await send(f.port,{body}))>=400);
 assert.equal(await send(f.port,{body:'{}',url:'/?'}),400);assert.equal(await send(f.port,{body:'{}',headers:{'content-encoding':'gzip'}}),400);assert.equal(await send(f.port,{method:'GET',body:'x',headers:{'content-length':'1'}}),400);assert.equal(await send(f.port,{method:'GET'}),200);
 // Explicit transfer-encoding is rejected even when the body is valid JSON.
 const status=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:f.port,path:'/',method:'POST',headers:{'content-type':'application/json','transfer-encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end('{}');});assert.equal(status,400);assert.equal(f.accepted,2);
});
