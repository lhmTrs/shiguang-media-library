// Fixed local composition routes. The parent application supplies real guards;
// the browser cannot provide an identity, a callback or a filesystem path.
import express from 'express';
import {AsyncLocalStorage} from 'node:async_hooks';
const requestContext=new AsyncLocalStorage();
export const taskMayReadRemote=()=>requestContext.getStore()?.explicit===true;
import { strictJson, batchDto, CLOUD_UPLOAD_TASK_BASE } from './cloud-upload-task-router.mjs';
import { exact, id, integer, fingerprint, fail } from './cloud-upload-protocol.mjs';
export const TASK_ENTRY_BASE = CLOUD_UPLOAD_TASK_BASE;
const BODY_LIMIT=65536, READ_MS=10000;
const U='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const controls=[
 ['GET',/^\/control\/status$/,'status',[]],
 ['POST',/^\/control\/session-check$/,'sessionCheck',[]],
 ['POST',/^\/control\/groups$/,'groups',[]],
 ['GET',/^\/control\/queue-plan$/,'queuePlan',[]],
 ['POST',/^\/control\/host-registration$/,'registerHost',['clientCommandId','expectedVersion','assetIds']],
 ['POST',/^\/control\/proof-admission$/,'admitProof',['mode','clientCommandId','expectedVersion']],
 ['POST',/^\/control\/full-scan$/,'fullScan',['rootId','confirmed']],
 ['POST',/^\/control\/recover$/,'recover',['scope','queueFingerprint','confirmed']],
 ['POST',/^\/control\/start$/,'start',['scope','queueFingerprint','confirmed','automatic','recover']],
 ['POST',new RegExp(`^/control/batches/(${U})/command$`),'command',['clientCommandId','expectedVersion','action']],
];
const code=e=>/^[A-Z][A-Z0-9_]{0,63}$/.test(e?.code||'')?e.code:'ENTRY_UNKNOWN';
function fields(input,keys){exact(input,keys);if(Object.keys(input).length!==keys.length)fail('INVALID_REQUEST',400);return input;}
function inputFor(action,input,keys){
 fields(input,keys);
 if(['registerHost','admitProof','command'].includes(action)){id(input.clientCommandId);integer(input.expectedVersion);}
 if(action==='registerHost'){if(!Array.isArray(input.assetIds)||!input.assetIds.length||input.assetIds.length>50||new Set(input.assetIds).size!==input.assetIds.length)fail('INVALID_REQUEST',400);input.assetIds.forEach(id);}
 if(action==='admitProof'&&!['REGISTER','OPEN_SESSION'].includes(input.mode))fail('INVALID_REQUEST',400);
 if(action==='fullScan'){id(input.rootId);if(input.confirmed!==true)fail('INVALID_REQUEST',400);}
 if(['start','recover'].includes(action)){if(input.scope!=='CURRENT_NAMESPACE_ALL_PENDING'||input.confirmed!==true||!/^[a-f0-9]{64}$/.test(input.queueFingerprint))fail('INVALID_REQUEST',400);}
 if(action==='start'&&(typeof input.automatic!=='boolean'||input.recover!==false))fail('INVALID_REQUEST',400);
 if(action==='command'&&!['pause','resume','stop'].includes(input.action))fail('INVALID_REQUEST',400);
 return input;
}
// The body reader owns its listeners until the real stream settles or we stop
// consuming it. A response close is never treated as operation settlement.
export function readEntryBody(req,{readers,assertCurrent}={}){
 assertCurrent();
 if(req.body!==undefined||req.readableEnded)fail('RAW_BODY_REQUIRED',503);
 if(req.aborted||req.destroyed)fail('REQUEST_ABORTED',400);
 if(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity')fail('INVALID_REQUEST',400);
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('INVALID_REQUEST',400);
 const text=req.headers['content-length'];
 if(text!==undefined&&(!/^(?:0|[1-9][0-9]*)$/.test(text)||!Number.isSafeInteger(Number(text))))fail('INVALID_REQUEST',400);
 const expected=text===undefined?null:Number(text);if(expected>BODY_LIMIT){req.resume();fail('BODY_LIMIT',413);}
 return new Promise((resolve,reject)=>{
  const chunks=[];let count=0,settled=false;
  const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',errorEvent);req.off('aborted',aborted);req.off('close',closed);readers.delete(cancel);if(error){req.resume();reject(error);}else{try{assertCurrent();const raw=Buffer.concat(chunks,count);let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{fail('INVALID_JSON',400);}resolve(strictJson(decoded));}catch(e){reject(e);}}};
  const bad=(code,status)=>Object.assign(new Error(),{code,status});
  const data=chunk=>{try{assertCurrent();const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);count+=b.length;if(count>BODY_LIMIT)return finish(bad('BODY_LIMIT',413));if(expected!==null&&count>expected)return finish(bad('INVALID_REQUEST',400));chunks.push(b);}catch(e){finish(e);}};
  const end=()=>finish(expected!==null&&count!==expected?bad('INVALID_REQUEST',400):null);
  const errorEvent=()=>finish(bad('REQUEST_ABORTED',400)),aborted=errorEvent,closed=()=>{if(!req.complete)errorEvent();};
  const cancel=()=>finish(bad('ENTRY_CLOSED',503));const timer=setTimeout(()=>finish(bad('BODY_TIMEOUT',408)),READ_MS);timer.unref?.();readers.add(cancel);
  req.on('data',data);req.once('end',end);req.once('error',errorEvent);req.once('aborted',aborted);req.once('close',closed);
 });
}
export function createCloudUploadTaskEntry({runtime,host,guardLocalRequest,currentIdentity,readLocalStatus,verifySession,readGroups}={}){
 if(!runtime||runtime.host!==host||typeof host?.track!=='function'||typeof guardLocalRequest!=='function'||typeof currentIdentity!=='function')fail('ENTRY_BINDING_INVALID',503);
 const router=express.Router({caseSensitive:true,strict:true}),readers=new Set(),operations=new Set();let closing=false;
 const snapshot=()=>JSON.stringify(currentIdentity());
 const check=who=>{if(closing)fail('ENTRY_CLOSED',503);if(snapshot()!==who)fail('AUTH_CHANGED',409);};
 const work=async(req,res,next)=>{
  const url=new URL(req.url,'http://local.invalid'),raw=req.url.split('?')[0];
  if(req.method!=='GET'){const expected=req.headers['x-task-identity'];if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))fail('IDENTITY_VERSION_REQUIRED',428);if(expected!==fingerprint(currentIdentity()))fail('IDENTITY_VERSION_CHANGED',412);}
  const earlyCommand=req.method==='POST'&&!runtime.scheduler.started&&raw.match(new RegExp(`^/batches/(${U})/commands$`));
  if(!raw.startsWith('/control/')&&!earlyCommand)return runtime.router(req,res,next);
  const routes=earlyCommand?[['POST',new RegExp(`^/batches/(${U})/commands$`),'command',['clientCommandId','expectedVersion','action']]]:controls;
  const candidates=routes.map(([method,re,action,keys])=>({method,match:raw.match(re),action,keys})).filter(r=>r.match),route=candidates.find(r=>r.method===req.method);
  if(!route)fail(candidates.length?'METHOD_NOT_ALLOWED':'NOT_FOUND',candidates.length?405:404);
  if(url.search)fail('INVALID_REQUEST',400);const who=snapshot();check(who);
  const gate=await guardLocalRequest(req,{write:req.method!=='GET'});check(who);if(gate?.allowed!==true)fail('LOCAL_SESSION_REQUIRED',401);
  if(req.method!=='GET'){const expected=req.headers['x-task-identity'];if(typeof expected!=='string'||!/^[a-f0-9]{64}$/.test(expected))fail('IDENTITY_VERSION_REQUIRED',428);if(expected!==fingerprint(currentIdentity()))fail('IDENTITY_VERSION_CHANGED',412);}
  let input;if(req.method==='POST'){input=await host.track(()=>readEntryBody(req,{readers,assertCurrent:()=>check(who)}));check(who);input=inputFor(route.action,input,route.keys);}
  let result=route.action==='sessionCheck'?await host.track(()=>verifySession()):route.action==='groups'?await host.track(()=>readGroups()):route.action==='command'?await runtime.command(route.match[1],input):await runtime[route.action](...(input===undefined?[]:[input]));if(earlyCommand)result={data:batchDto(result)};check(who);if(route.action==='fullScan'){const value=result;result=Object.fromEntries(['mode','rootId','rootReachable','revision','elapsedMs','skipped','matchedByPath','added','missing','moved','renamed','deferred','repairPending','registrationChanged','hashBudgetExhausted'].filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));result.walkErrorCount=Array.isArray(value.walkErrors)?value.walkErrors.length:null;result.conflictCount=Array.isArray(value.conflicts)?value.conflicts.length:null;}if(route.action==='status'&&typeof readLocalStatus==='function'){const local=await readLocalStatus();check(who);result={...result,identityKey:local.identityKey,local};}if(!res.destroyed&&!res.headersSent)res.json(result);
 };
 router.use((req,res,next)=>{const promise=Promise.resolve().then(()=>requestContext.run({explicit:req.method!=='GET'},()=>work(req,res,next)));operations.add(promise);promise.catch(e=>{if(!res.destroyed&&!res.headersSent)res.status(Number.isInteger(e?.status)&&e.status>=400&&e.status<=599?e.status:503).json({error:{code:code(e)}});}).finally(()=>operations.delete(promise));});
 return{basePath:TASK_ENTRY_BASE,router,state:()=>({closing,active:operations.size,bodyReaders:readers.size}),async dispose({timeoutMs=10000}={}){closing=true;for(const cancel of [...readers])cancel();const result=await runtime.dispose({timeoutMs});return{...result,closed:result.closed===true&&operations.size===0,entryActive:operations.size};}};
}
