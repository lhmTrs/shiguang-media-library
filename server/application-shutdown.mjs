import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Server} from 'node:net';
import {Worker} from 'node:worker_threads';
import {Stream, finished} from 'node:stream';

const witnesses=new WeakMap(), stores=new WeakMap();
export const SHUTDOWN_GROUPS=Object.freeze(['inflight','manifest','afterCommit','services','database','http']);
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const tokenOK=s=>typeof s==='string'&&s.length>=32&&s.length<=256&&!/[\x00-\x20\x7f]/.test(s);
const failure=code=>Object.assign(Error(code),{code});
function witness(promise,kind){const handle=Object.freeze({});promise.catch(()=>{});witnesses.set(handle,{promise,kind});return handle;}

// Subscribe BEFORE asking a real resource to close. A callback's return value
// cannot mint a witness. Already-ended/unrecognized objects are unprovable here.
export function observeShutdownResource(resource){
 if(resource instanceof Worker){
  if(resource.threadId===-1)throw failure('RESOURCE_NOT_OBSERVABLE');
  return witness(new Promise((resolve,reject)=>{const done=code=>{cleanup();code===0?resolve():reject(failure('WORKER_EXIT_UNKNOWN'));};const error=()=>{cleanup();reject(failure('WORKER_EXIT_UNKNOWN'));};const cleanup=()=>{resource.off('exit',done);resource.off('error',error);};resource.once('exit',done);resource.once('error',error);}), 'worker');
 }
 if(resource instanceof Server){
  if(!resource.listening)throw failure('RESOURCE_NOT_OBSERVABLE');
  return witness(new Promise((resolve,reject)=>{const done=()=>{cleanup();resolve();};const error=()=>{cleanup();reject(failure('HTTP_CLOSE_UNKNOWN'));};const cleanup=()=>{resource.off('close',done);resource.off('error',error);};resource.once('close',done);resource.once('error',error);}), 'http');
 }
 if(resource instanceof Stream){
  if(resource.destroyed)throw failure('RESOURCE_NOT_OBSERVABLE');
  return witness(new Promise((resolve,reject)=>{const cleanup=finished(resource,error=>{cleanup();error?reject(failure('STREAM_END_UNKNOWN')):resolve();});}), 'stream');
 }
 throw failure('RESOURCE_NOT_OBSERVABLE');
}

// This proves only work admitted through THIS gate. It does not discover an
// App's hidden manifest/afterCommit/database work; that integration is unbuilt.
export function createShutdownWorkGate(){
 let sealed=false,pending=0,failed=false,resolve,reject;
 const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
 const settle=()=>{if(sealed&&!pending)failed?reject(failure('WORK_END_UNKNOWN')):resolve();};
 return Object.freeze({witness:witness(promise,'work'),
  run(operation){if(sealed)throw failure('ADMISSION_CLOSED');if(pending>=256)throw failure('WORK_LIMIT');pending++;let result;try{result=operation();}catch(e){result=Promise.reject(e);}return Promise.resolve(result).catch(e=>{failed=true;throw e;}).finally(()=>{pending--;settle();});},
  seal(){sealed=true;settle();}
 });
}

const bodyKeys=['format','libraryId','runId','requestId','phase','expiresAt'];
function signShutdownReceipt(body,token){
 if(!tokenOK(token)||!body||Object.keys(body).sort().join()!==[...bodyKeys].sort().join()||body.format!==1||!uuid.test(body.runId)||!uuid.test(body.requestId)||typeof body.libraryId!=='string'||!body.libraryId||body.libraryId.length>128||!['CLOSED_KNOWN','ACCEPTED','UNKNOWN'].includes(body.phase)||!Number.isSafeInteger(body.expiresAt))throw failure('INVALID_RECEIPT');
 const payload=JSON.stringify(Object.fromEntries(bodyKeys.map(k=>[k,body[k]])));
 return {body:JSON.parse(payload),mac:crypto.createHmac('sha256',token).update(payload).digest('hex')};
}
export function verifyShutdownReceipt(envelope,expected,token,now=Date.now()){
 try{
  if(!envelope||Object.keys(envelope).sort().join()!=='body,mac'||!tokenOK(token)||typeof envelope.mac!=='string'||!/^[a-f0-9]{64}$/.test(envelope.mac))return false;
  const {body}=envelope,signed=signShutdownReceipt(body,token);
  return body.phase==='CLOSED_KNOWN'&&body.runId===expected.runId&&body.requestId===expected.requestId&&body.libraryId===expected.libraryId&&body.expiresAt>now&&body.expiresAt<=now+30000&&crypto.timingSafeEqual(Buffer.from(signed.mac,'hex'),Buffer.from(envelope.mac,'hex'));
 }catch{return false;}
}

// No import/construction IO. Only a real POSIX host is supported. An injected
// platform may deny support but can never make a real Windows host supported.
export function createShutdownReceiptStore({root,platform=process.platform}={}){
 const supported=process.platform!=='win32'&&['darwin','linux'].includes(process.platform)&&['darwin','linux'].includes(platform);
 let committed=null,anchor=null;
 const rootCheck=async()=>{
  if(!supported)throw failure('RECEIPT_STORAGE_UNSUPPORTED');
  if(typeof root!=='string'||root.length>4096||!path.isAbsolute(root)||await fs.realpath(root)!==root)throw failure('RECEIPT_ROOT_UNSAFE');
  const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||stat.uid!==process.getuid())throw failure('RECEIPT_ROOT_UNSAFE');if(anchor&&(anchor.dev!==stat.dev||anchor.ino!==stat.ino))throw failure('RECEIPT_ROOT_CHANGED');anchor??=stat;return stat;
 };
 const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
 const target=typeof root==='string'?path.join(root,'shutdown-receipt.json'):null;
 const api=Object.freeze({supported,
  async readCommitted(){
   if(!committed||committed.body.expiresAt<=Date.now())return null;await rootCheck();const handle=await fs.open(target,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const s=await handle.stat();if(!s.isFile()||s.nlink!==1||(s.mode&0o777)!==0o600||s.uid!==process.getuid()||s.size>4096)throw failure('RECEIPT_FILE_UNSAFE');const buffer=Buffer.alloc(4097);const {bytesRead}=await handle.read(buffer,0,buffer.length,0);if(bytesRead>4096)throw failure('RECEIPT_FILE_UNSAFE');const value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));if(value.mac!==committed.mac)return null;return value;}finally{await handle.close();}
  }
 });
 stores.set(api,{supported,async write(envelope){
  committed=null;const initial=await rootCheck();
  try{const s=await fs.lstat(target);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o777)!==0o600)throw failure('RECEIPT_FILE_UNSAFE');}catch(e){if(e.code!=='ENOENT')throw e;}
  const raw=JSON.stringify(envelope);if(Buffer.byteLength(raw)>4096)throw failure('RECEIPT_TOO_LARGE');
  const temp=path.join(root,'shutdown-'+crypto.randomUUID()+'.tmp');const handle=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
  if(!same(initial,await rootCheck()))throw failure('RECEIPT_ROOT_CHANGED');
  await fs.rename(temp,target);const directory=await fs.open(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{if(!same(initial,await directory.stat()))throw failure('RECEIPT_ROOT_CHANGED');await directory.sync();}finally{await directory.close();}
  if(!same(initial,await rootCheck()))throw failure('RECEIPT_ROOT_CHANGED');
  committed=envelope; // Readers only expose a receipt after all syncs succeed.
 }});
 return api;
}

// Coverage defaults to unsupported. Every named group requires a privately
// minted witness, not `true`, a resolved callback, or an arbitrary Promise.
export function createApplicationShutdown({runId,libraryId,stages=[],receiptStore,budgetMs=10000}={}){
 if(!uuid.test(runId)||typeof libraryId!=='string'||!libraryId||libraryId.length>128||runId===libraryId||!Number.isInteger(budgetMs)||budgetMs<20||budgetMs>30000)throw failure('INVALID_SHUTDOWN_CONFIG');
 if(!Array.isArray(stages)||stages.length>6||stages.some(s=>!s||!Array.isArray(s.witnesses)||s.witnesses.length>64))throw failure('INVALID_SHUTDOWN_CONFIG');
 const store=stores.get(receiptStore);
 // Capture capabilities before any await; caller mutation cannot erase coverage.
 stages=stages.map(s=>Object.freeze({group:s.group,stop:s.stop,witnesses:Array.isArray(s.witnesses)?[...s.witnesses]:[]}));
 const allWitnesses=stages.flatMap(s=>s.witnesses);
 const configured=allWitnesses.length<=256&&new Set(allWitnesses).size===allWitnesses.length&&store?.supported&&stages.length===SHUTDOWN_GROUPS.length&&stages.every((s,i)=>s.group===SHUTDOWN_GROUPS[i]&&typeof s.stop==='function'&&Array.isArray(s.witnesses)&&s.witnesses.length>0&&s.witnesses.every(w=>{const kind=witnesses.get(w)?.kind;return i<3?kind==='work':i===3?['worker','http','stream'].includes(kind):i===4?kind==='worker':kind==='http';}));
 let phase='IDLE',requestId=null,completion=null,accepted=null;
 const state=()=>({phase,runId,requestId});
 function request(command,token){
  if(!command||Object.keys(command).sort().join()!=='requestId,runId'||command.runId!==runId||!uuid.test(command.requestId)||!tokenOK(token))throw failure('INVALID_SHUTDOWN_COMMAND');
  if(requestId){if(requestId!==command.requestId)throw failure('SHUTDOWN_CONFLICT');return {accepted,completion};}
  if(!configured)throw failure('SHUTDOWN_UNSUPPORTED');
  requestId=command.requestId;phase='ACCEPTED';accepted=Object.freeze(state());const expiresAt=Date.now()+budgetMs,deadline=performance.now()+budgetMs;
  const withinBudget=()=>{if(performance.now()>=deadline)throw failure('SHUTDOWN_TIMEOUT');};
  const bounded=async operation=>{let timer;try{
   withinBudget();const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('SHUTDOWN_TIMEOUT')),Math.max(0,deadline-performance.now()));});
   const value=await Promise.race([Promise.resolve().then(()=>{withinBudget();return operation();}),timeout]);withinBudget();return value;
  }finally{clearTimeout(timer);}};
  completion=(async()=>{
   try{
    for(const stage of stages){await bounded(()=>stage.stop());await bounded(()=>Promise.all(stage.witnesses.map(w=>witnesses.get(w).promise)));}
    withinBudget();
    const receipt=signShutdownReceipt({format:1,libraryId,runId,requestId,phase:'CLOSED_KNOWN',expiresAt},token);
    await bounded(()=>store.write(receipt));
    withinBudget();phase='CLOSED_KNOWN';
   }catch{phase='UNKNOWN';}
   return state();
  })();return {accepted,completion};
 }
 return Object.freeze({request,state});
}
