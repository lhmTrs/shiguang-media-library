import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {constants} from 'node:fs';
import {directory,readJson,privateFolder,writePrivate,failure} from './files.mjs';
import {hash,taskId,taskDiagnostic,degradedTask,projectTask} from './model.mjs';
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const maxDiagnosticDetails = 50;
export class UpdreamProgress {
 constructor({dataDir,queueDir=path.join(os.homedir(),'Library/Application Support/CodexUpdream/followups'),libraryId,resolveVideo,projectName}={}){
  this.queueDir=path.resolve(queueDir);this.preferences=path.join(dataDir,'updream-progress');this.context={libraryId,resolveVideo,projectName};this.chain=Promise.resolve();
 }
 async preferencesRead(){
  try{
   await directory(this.preferences,{privateMode:true});
   const {value}=await readJson(path.join(this.preferences,'read.json'),{limit:512*1024,privateMode:true});
   if(value.version!==1||!value.read||typeof value.read!=='object'||Array.isArray(value.read)||Object.keys(value.read).length>1000||Object.entries(value.read).some(([id,v])=>!taskId(id)||!hex(v)))throw failure('preferences_unavailable');
   return {state:'ready',read:value.read};
  }catch(e){if(e.code==='ENOENT')return {state:'ready',read:{}};return {state:'unavailable',read:{}};}
 }
 async snapshot(){
  const readAt=Date.now(),preferences=await this.preferencesRead(),queue={state:'ready',reason:null,truncated:false,invalidCount:0,warning:false};
  const names=[],tasks=[],diagnosticItems=[];const budget={left:32*1024*1024};
  let verifiedQueue = false;
  try{
   await directory(this.queueDir,{privateMode:true});await directory(path.join(this.queueDir,'jobs'),{privateMode:true});
   verifiedQueue = true;
   const handle=await fs.opendir(path.join(this.queueDir,'jobs'));
   let scanned=0;
   for await(const item of handle){
    if(++scanned>1000){queue.truncated=true;break;}
    if(!item.name.endsWith('.json'))continue;
    if(!/^[a-f0-9]{64}\.json$/.test(item.name)){diagnosticItems.push(taskDiagnostic('record-'+hash(item.name),'invalid_record'));continue;}
    if(names.length===200){queue.truncated=true;break;}names.push(item.name);
   }
  }catch(e){
   const absent=e.code==='ENOENT'&&!verifiedQueue;
   queue.state=absent?'absent':'unavailable';queue.reason=absent?null:'queue_unavailable';
   return this.response(tasks,diagnosticItems,queue,preferences,readAt);
  }
  for(const name of names.sort()){
   let id='record-'+name.slice(0,-5), entry;
   try{
    const {value:q,mtime}=await readJson(path.join(this.queueDir,'jobs',name),{privateMode:true,budget});
    if(!taskId(q.task_id)||hash(q.task_id)+'.json'!==name||q.version!==1)throw failure('invalid_record');id=q.task_id;
    if(typeof q.source!=='string'||q.source.length>4096||!path.isAbsolute(q.source))throw failure('invalid_record');
    entry=q;
    const source=await readJson(q.source,{budget}).catch(error=>{
     if(error.code==='ENOENT')throw failure('state_missing');
     throw error;
    });
    tasks.push(projectTask(q,source.value,Math.max(mtime,source.mtime),this.context));
   }catch(e){diagnosticItems.push(taskDiagnostic(id,e.code,entry));}
  }
  tasks.sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)||(a.id<b.id?-1:1));
  diagnosticItems.sort((a,b)=>(b.registeredAt??0)-(a.registeredAt??0)||a.id.localeCompare(b.id));
  if(diagnosticItems.length||queue.truncated){queue.state='degraded';queue.reason=queue.truncated?'read_limit':'invalid_records';}
  return this.response(tasks,diagnosticItems,queue,preferences,readAt);
 }
 response(tasks,diagnosticItems,queue,preferences,readAt){
  tasks=tasks.map(task=>({...task,unread:task.unread&&preferences.read[task.id]!==task.eventVersion}));
  const activeCount=tasks.filter(t=>t.active).length,unreadCount=tasks.filter(t=>t.unread).length;
  const attentionTasks=tasks.filter(t=>!t.active&&t.attention);
  const attentionCount=attentionTasks.length,attentionUnreadCount=attentionTasks.filter(t=>t.unread).length;
  const doneUnreadCount=tasks.filter(t=>!t.active&&!t.attention&&t.unread).length;
  const byReason={},legacyStatus={};
  for(const item of diagnosticItems){
   byReason[item.reason]=(byReason[item.reason]??0)+1;
   if(item.legacyStatus)legacyStatus[item.legacyStatus]=(legacyStatus[item.legacyStatus]??0)+1;
  }
  const diagnosticCount=diagnosticItems.length;
  queue.invalidCount=diagnosticCount;
  queue.warning=queue.state==='unavailable'||queue.truncated||diagnosticItems.some(item=>!item.historicalMissing);
  const diagnostics={count:diagnosticCount,byReason,legacyStatus,truncated:diagnosticCount>maxDiagnosticDetails,
   items:diagnosticItems.slice(0,maxDiagnosticDetails).map(({historicalMissing,...item})=>item)};
  const showEntry=activeCount>0||unreadCount>0||attentionCount>0||diagnosticCount>0||queue.warning;
  return {schemaVersion:1,readAt,queue,preferences:{state:preferences.state},
   summary:{activeCount,unreadCount,attentionCount,attentionUnreadCount,doneUnreadCount,diagnosticCount,showEntry},diagnostics,tasks,diagnosticItems};
 }
 async list({scope='all',offset=0,limit=50}={}){
  if(!['all','active','history'].includes(scope)||!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw failure('invalid_input');
  const {diagnosticItems, ...result}=await this.snapshot();
  const tasks=result.tasks.filter(t=>scope==='all'||(scope==='active'?t.active:!t.active));
  return {...result,tasks:tasks.slice(offset,offset+limit),total:tasks.length,offset,limit};
 }
 async detail(id){
  if(!taskId(id))throw failure('invalid_input');
  const result=await this.snapshot();
  const diagnostic=result.diagnosticItems.find(t=>t.id===id);
  const task=result.tasks.find(t=>t.id===id)??(diagnostic?degradedTask(id,diagnostic.reason):null);
  if(!task)throw failure(result.queue.state==='unavailable'?'queue_unavailable':'not_found');
  return {schemaVersion:1,readAt:result.readAt,task};
 }
 async markRead(input){
  if(!input||Object.keys(input).join(',')!=='items'||!Array.isArray(input.items)||input.items.length<1||input.items.length>100||input.items.some(v=>!v||Object.keys(v).sort().join(',')!=='id,version'||!taskId(v.id)||!hex(v.version)))throw failure('invalid_input');
  const work=this.chain.then(()=>this.writeRead(input.items));this.chain=work.catch(()=>{});return work;
 }
 async writeRead(items){
  await privateFolder(this.preferences);
  const lock=path.join(this.preferences,'read.lock');let handle;
  try{handle=await fs.open(lock,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch{throw failure('preferences_busy');}
  try{
   const preferences=await this.preferencesRead();if(preferences.state!=='ready')throw failure('preferences_unavailable');
   const snapshot=await this.snapshot(),tasks=new Map(snapshot.tasks.map(t=>[t.id,t])),marked=[],skipped=[];
   const read={...preferences.read};
   for(const {id,version}of items){const task=tasks.get(id);if(!task||task.eventVersion!==version){skipped.push(id);continue;}read[id]=version;marked.push(id);}
   if(Object.keys(read).length>1000)throw failure('preferences_unavailable');
   await writePrivate(path.join(this.preferences,'read.json'),{version:1,read});
   return {schemaVersion:1,readAt:Date.now(),marked,skipped};
  }finally{
   const held=await handle.stat();await handle.close();const current=await fs.lstat(lock).catch(()=>null);
   if(current?.dev===held.dev&&current?.ino===held.ino&&!current.isSymbolicLink())await fs.unlink(lock);
  }
 }
}
