import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {PromptTemplates} from '../server/prompt-templates/store.mjs';
import {CodexStore} from '../server/prompt-codex/store.mjs';
import {CodexMedia} from '../server/prompt-codex/media.mjs';
import {CodexService} from '../server/prompt-codex/service.mjs';
import {fixture,inputs} from './helpers/prompt-lifecycle.mjs';
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn){for(let n=0;n<150;n++){const result=fn();if(result)return result;await delay(3);}throw Error('synthetic condition timed out');}
class Fake extends EventEmitter {
 constructor(){super();this.closed=true;this.calls=[];this.closes=0;this.next=0;this.ackOnly=true;}
 async start(){this.closed=false;}
 async close(){this.closes++;if(this.closeHook)await this.closeHook();if(this.rejectClose)throw Object.assign(Error('synthetic unknown exit'),{code:'CODEX_CLOSE_UNSETTLED'});if(this.silentClose)return;this.closed=true;this.emit('closed',{});}
 async call(method,params){this.calls.push({method,params});
 if(method==='account/read')return{account:{type:'synthetic'}};
 if(method==='model/list')return{data:[{model:'mock',supportedReasoningEfforts:[{reasoningEffort:'low'}],inputModalities:['text','image']}],nextCursor:null};
 if(method==='thread/start')return{thread:{id:'t'+(++this.next)},model:'mock',reasoningEffort:'low'};
 if(method==='turn/start')return{turn:{id:'r'+this.next}};
 if(method==='turn/interrupt'){if(!this.ackOnly)this.emit('notification','turn/completed',{threadId:params.threadId,turnId:params.turnId,turn:{id:params.turnId,status:'interrupted',items:[]}});return{};}
 throw Error(method);}
}
export async function setup(t,options={}){
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'task-drawer-')),db=new Database(path.join(dataDir,'test.sqlite'));
 db.exec('CREATE TABLE media_projects(id TEXT PRIMARY KEY,name TEXT,project_kind TEXT)');
 const lib={db,dataDir,jobs:new Map()},prompts=new PromptTemplates(lib).init(),store=new CodexStore(lib,prompts).init(),media=await new CodexMedia(dataDir).init(),fake=new Fake();
 const service=new CodexService(store,media,{transportFactory:()=>fake,timeoutMs:100000,stopTimeoutMs:25,...options});
 t.after(async()=>{fake.rejectClose=false;fake.silentClose=false;fake.closeHook=null;await service.close();db.close();await fs.rm(dataDir,{recursive:true,force:true});});
 return {db,lib,prompts,store,media,fake,service};
}
export function conversation(s){const template=s.prompts.create(fixture());return s.store.create({id:randomUUID(),template_id:template.id,template_revision:template.revision,values:inputs});}
export const request=(head,extra={})=>({id:randomUUID(),expected_revision:head.revision,model:'mock',effort:'low',output:'text',...extra});
export async function start(s){const head=conversation(s),input=request(head);await s.service.start(head.id,input);const task=await until(()=>{const task=s.service.tasks.get(input.id);return task?.remoteTurnId?task:null;});return task;}
export function emit(s,task,method,params={}){s.fake.emit('notification',method,{threadId:task.threadId,turnId:task.remoteTurnId,...params});}
export async function finish(s,task,items=[]){emit(s,task,'turn/completed',{turn:{id:task.remoteTurnId,status:'completed',items}});await task.work;}
