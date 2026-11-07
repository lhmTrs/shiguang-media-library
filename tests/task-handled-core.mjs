import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
const root=path.resolve(import.meta.dirname,'..'),temp=await fs.mkdtemp(path.join(os.tmpdir(),'handled-core-')),checks=[];
try{
 for(const name of ['codex-task-types','task-handled-preferences']){
  const source=await fs.readFile(path.join(root,'src',name+'.ts'),'utf8');
  const result=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace("'./codex-task-types'","'./codex-task-types.mjs'");
  await fs.writeFile(path.join(temp,name+'.mjs'),result);
 }
 const {taskIssueKey,canHandleTask,taskObservationKey}=await import(path.join(temp,'codex-task-types.mjs'));
 const {readHandledTasks,writeHandledTask,handledStorageKey}=await import(path.join(temp,'task-handled-preferences.mjs'));
 const make=()=>({taskId:randomUUID(),status:'failed',errorCode:'SYNTHETIC_FAILURE',updatedAt:100,terminalRevision:'failed:SYNTHETIC_FAILURE:100',attention:{required:true,reasons:['TASK_FAILED']},images:[],imageCount:0});
 const task=make(),key=taskIssueKey(task);assert.ok(key);
 const storage=()=>{const data=new Map();return{data,getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};};
 const s=storage();writeHandledTask('library-a',key,s);assert.ok(readHandledTasks('library-a',s).has(key));assert.equal(readHandledTasks('library-b',s).size,0);
 assert.equal(taskIssueKey({...task,title:'sensitive title',preview:'/private/path secret',observedAt:500}),key);
 for(const change of [{taskId:randomUUID()},{terminalRevision:'failed:SYNTHETIC_FAILURE:101'},{errorCode:'SECOND_FAILURE'},{attention:{required:true,reasons:['TASK_FAILED','IMAGE_LIBRARY_FAILED']}},{images:[{attachmentId:randomUUID(),status:'ready',libraryStatus:'failed',errorCode:'IMAGE_LIBRARY_FAILED'}],imageCount:1}])assert.notEqual(taskIssueKey({...task,...change}),key);
 assert.equal(taskObservationKey('process',task),taskObservationKey('process',{...task,observedAt:999}));
 checks.push('stable library isolation; observation/text/path excluded; new task/revision/error/image problem resurfacing');
 for(const status of ['queued','running','stopping'])assert.equal(canHandleTask({...task,status}),false);assert.equal(canHandleTask({...task,stateUnconfirmed:true}),false);assert.equal(canHandleTask(task),true);
 checks.push('active and unconfirmed tasks cannot be handled');
 for(let n=0;n<510;n++)writeHandledTask('library-a',taskIssueKey(make()),s);assert.equal(readHandledTasks('library-a',s).size,500);assert.ok(!readHandledTasks('library-a',s).has(key));
 const large=storage();for(let n=0;n<350;n++){const t=make();t.attention.reasons=Array.from({length:16},(_,i)=>'R'+i+'_'+('X'.repeat(140)));writeHandledTask('large',taskIssueKey(t),large);}assert.ok(large.getItem(handledStorageKey('large')).length<=750000);assert.ok(readHandledTasks('large',large).size<350);
 checks.push('bounded 500 entries and bounded encoded size with oldest preference eviction');
 const bad=storage();bad.setItem(handledStorageKey('bad'),'{broken');assert.throws(()=>readHandledTasks('bad',bad),/损坏/);assert.throws(()=>writeHandledTask('bad',key,bad),/损坏/);assert.equal(bad.getItem(handledStorageKey('bad')),'{broken');
 assert.throws(()=>writeHandledTask('a',key,{getItem:()=>null,setItem:()=>{throw Error('quota');}}),/无法保存/);assert.throws(()=>writeHandledTask('a',key,{getItem:()=>null,setItem:()=>{}}),/未确认/);assert.throws(()=>readHandledTasks('a',{getItem:()=>{throw Error('denied');},setItem:()=>{}}),/无法读取/);
 assert.throws(()=>handledStorageKey('../path'));assert.throws(()=>writeHandledTask('a','sensitive text',s));
 checks.push('malformed storage is preserved; denied/no-op writes rejected; invalid identity and payload rejected');
 console.log(JSON.stringify({passed:true,checks},null,2));
}finally{await fs.rm(temp,{recursive:true,force:true});}
