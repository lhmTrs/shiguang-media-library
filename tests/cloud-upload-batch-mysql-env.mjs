// Explicit, disposable UQ01 environment only. Importing this module starts nothing.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import mysql from 'mysql2/promise';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {CloudUploadBatchStore} from '../server/cloud-upload-batch-store.mjs';
const exec=promisify(execFile);
const OWNER='BATCH-UPLOAD-01-MYSQL-20261026';
export async function confirmedClose(db,inventory){
 if(!db)return;
 const worker=db.worker,record={kind:'mysql-worker',exited:false};inventory.push(record);
 if(worker.threadId===-1){Object.assign(record,{exited:true,alreadyExited:true});return;}
 const ended=once(worker,'exit');
 try{db.close();}finally{
  const code=await Promise.race([ended.then(([code])=>code),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('worker exit unconfirmed')),5000);timer.unref();})]);
  if(worker.threadId!==-1)throw Error('worker exit unconfirmed');
  Object.assign(record,{exited:true,exitCode:code});
 }
}
async function observeTemporaryRoot(directory,pin){
 try{
  const current=await fs.lstat(directory);
  if(current.isSymbolicLink())return{state:'SYMLINK_RETAINED'};
  if(!current.isDirectory()||current.dev!==pin.dev||current.ino!==pin.ino)return{state:'REPLACED_RETAINED'};
  if((current.mode&0o777)!==pin.mode)return{state:'UNKNOWN_RETAINED',reason:'PRIVATE_MODE_CHANGED'};
  if(await fs.realpath(directory)!==directory)return{state:'UNKNOWN_RETAINED',reason:'PATH_ALIAS_CHANGED'};
  return{state:'ORIGINAL_RETAINED'};
 }catch(error){return{state:'UNKNOWN_RETAINED',reason:error.code==='ENOENT'?'PATH_MISSING':'STAT_UNCONFIRMED'};}
}
export async function startOwnedMysql(){
 if(process.env.UQ01_MYSQL_TEST!=='1')throw Error('explicit UQ01_MYSQL_TEST=1 required');
 const token=randomUUID(),suffix=token.replaceAll('-','').slice(0,16),name='uq01-mysql-'+suffix;
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'uq01-mysql-'+suffix+'-')));
 const rootStat=await fs.lstat(directory),rootIdentity={dev:rootStat.dev,ino:rootStat.ino,mode:rootStat.mode&0o777};
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink())throw Error('temporary root identity unavailable');
 const inventory={owner:OWNER,token,name,directory,containerId:null,image:null,port:null,databases:[],workers:[],events:[],cleanup:'NOT_STARTED'};
 inventory.rootIdentity=rootIdentity;inventory.temporaryFiles='RETAIN_ALL';
 const previousDataDir=process.env.MEDIA_DATA_DIR,previousSkip=process.env.MEDIA_SKIP_IMPORT;
 process.env.MEDIA_DATA_DIR=directory;process.env.MEDIA_SKIP_IMPORT='1';inventory.mediaDataDirOwned=true;
 const restoreEnvironment=()=>{for(const [key,value] of [['MEDIA_DATA_DIR',previousDataDir],['MEDIA_SKIP_IMPORT',previousSkip]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}};
 const password=randomBytes(32).toString('hex');
 let control;
 const run=async(args,options={})=>(await exec('docker',args,{timeout:30000,maxBuffer:262144,...options})).stdout.trim();
 try{
  inventory.daemon=await run(['version','--format','{{.Server.Version}}']);
  inventory.image=await run(['image','inspect','mysql:8.4','--format','{{.Id}}']);
  inventory.containerId=await run(['run','--detach','--pull=never','--name',name,'--label','uq01.owner='+OWNER,'--label','uq01.token='+token,'--cpus','1','--memory','1g','--pids-limit','256','--tmpfs','/var/lib/mysql:rw,size=536870912','--publish','127.0.0.1::3306','--env','MYSQL_ROOT_PASSWORD','--env','MYSQL_ROOT_HOST=%',inventory.image],{env:{...process.env,MYSQL_ROOT_PASSWORD:password}});
  const binding=JSON.parse(await run(['inspect','--format','{{json .NetworkSettings.Ports}}',inventory.containerId]))['3306/tcp'];
  if(binding?.length!==1||binding[0].HostIp!=='127.0.0.1')throw Error('loopback binding not confirmed');
  inventory.port=Number(binding[0].HostPort);
  const base={host:'127.0.0.1',port:inventory.port,user:'root',password,connectTimeout:1500};
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){try{control=await mysql.createConnection(base);await control.query('SELECT 1');break;}catch{await control?.end().catch(()=>{});control=null;await new Promise(r=>setTimeout(r,700));}}
  if(!control)throw Error('owned MySQL readiness timed out');
  const [[version]]=await control.query('SELECT VERSION() version,@@sql_mode sqlMode');
  inventory.server=version;if(!version.version.startsWith('8.4.'))throw Error('expected cached MySQL 8.4');
  const env={inventory,directory,config:database=>({...base,connectTimeout:5000,database}),async schema(label){if(inventory.databases.length>=8||!/^[a-z_]{1,16}$/.test(label))throw Error('invalid own schema label');const database='uq01_'+suffix+'_'+label;await control.query('CREATE DATABASE `'+database+'` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');inventory.databases.push(database);return database;},async connection(database){if(!inventory.databases.includes(database))throw Error('not own schema');return mysql.createConnection(this.config(database));},async closeDb(db){return confirmedClose(db,inventory.workers);},async finish(){
   try{
    await control.end();inventory.events.push('control-connection-ended');
    if(inventory.workers.some(w=>!w.exited))throw Error('unknown worker prevents cleanup');
    const observed=JSON.parse(await run(['inspect','--format','{{json .Config.Labels}}',inventory.containerId]));
    if(observed['uq01.owner']!==OWNER||observed['uq01.token']!==token)throw Error('container ownership unconfirmed');
    await run(['stop','--time','10',inventory.containerId]);
    const running=await run(['inspect','--format','{{.State.Running}}',inventory.containerId]);if(running!=='false')throw Error('container stop unconfirmed');
    await run(['rm',inventory.containerId]);inventory.cleanup='OWN_CONTAINER_REMOVED_TEMP_RETAINED';
   }catch(error){inventory.cleanup='RETAINED_RESOURCE_UNKNOWN';throw error;}
   finally{
    // No recursive cleanup, discovery of moved roots, or writes through this pathname.
    // Even a matching root can contain unregistered bytes; keep all temporary files.
    try{inventory.rootObservation=await observeTemporaryRoot(directory,rootIdentity);inventory.events.push('temporary-files-retained');}
    finally{restoreEnvironment();inventory.environmentRestored=true;}
   }
  }};
  return env;
 }catch(error){
  // Unknown startup state is retained. Never sweep other containers or print config/env/logs.
  try{
   await control?.end().catch(()=>{inventory.events.push('control-end-unconfirmed');});
   inventory.cleanup='RETAINED_STARTUP_FAILURE';
   inventory.rootObservation=await observeTemporaryRoot(directory,rootIdentity);
  }finally{restoreEnvironment();inventory.environmentRestored=true;}
  // Bounded diagnostics travel to the caller, never into a replaced/unknown temporary root.
  throw Object.assign(Error('owned MySQL setup failed; temporary files retained at '+directory),{cause:error,inventory});
 }
}
// Independent coordinating worker; each instance uses the real product worker adapter.
if(!isMainThread&&workerData?.kind==='uq01-cas-peer'){
 const db=new MysqlDatabase(workerData.config),store=new CloudUploadBatchStore(db);
 let row;
 parentPort.on('message',async message=>{
  try{
   if(message.action==='read'){row=store.get('cloud_upload_batches',{batchId:message.batchId});parentPort.postMessage({ok:true,version:row.version});}
   else if(message.action==='update'){store.transaction(()=>store.update('cloud_upload_batches',row,{state:'PAUSED'}));parentPort.postMessage({ok:true});}
   else if(message.action==='close'){const inventory=[];await confirmedClose(db,inventory);parentPort.postMessage({ok:true,inventory});parentPort.close();}
  }catch(e){parentPort.postMessage({ok:false,code:e.code||'UNCLASSIFIED'});}
 });
}
export function casPeer(config){
 const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'uq01-cas-peer',config},execArgv:[]});
 return{worker,async send(message){const answer=once(worker,'message');worker.postMessage(message);return(await Promise.race([answer,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('peer response unconfirmed')),10000);timer.unref();})]))[0];},async close(inventory){const record={kind:'coordinator-worker',exited:false};inventory.push(record);const exited=once(worker,'exit');const reply=await this.send({action:'close'});if(!reply.ok)throw Error('peer close unconfirmed');await exited;record.exited=worker.threadId===-1;inventory.push(...reply.inventory);}};
}
