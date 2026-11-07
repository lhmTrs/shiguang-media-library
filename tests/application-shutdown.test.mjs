import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import http from 'node:http';import {once} from 'node:events';import {PassThrough} from 'node:stream';import {Worker} from 'node:worker_threads';
import {SHUTDOWN_GROUPS,createShutdownWorkGate,observeShutdownResource,createShutdownReceiptStore,createApplicationShutdown,verifyShutdownReceipt} from '../server/application-shutdown.mjs';
const token='a'.repeat(64),libraryId='private-test-library';
async function root(){const p=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-shutdown-module-')));await fs.chmod(p,0o700);return p;}
function gates(){return SHUTDOWN_GROUPS.map(group=>{const gate=createShutdownWorkGate();return{group,gate,stop:()=>gate.seal(),witnesses:[gate.witness]};});}
async function fixture(t,options={}){
 const dir=await root(),runId=crypto.randomUUID(),requestId=crypto.randomUUID(),receiptStore=createShutdownReceiptStore({root:dir}),stages=options.stages||gates();
 if(stages.length){
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>parentPort.close());`,{eval:true});await once(worker,'online');const stream=new PassThrough();stream.resume();const server=http.createServer((req,res)=>res.end());server.listen(0,'127.0.0.1');await once(server,'listening');
  stages[3]={group:'services',stop:()=>stream.end(),witnesses:[observeShutdownResource(stream)]};
  stages[4]={group:'database',stop:()=>worker.postMessage('stop'),witnesses:[observeShutdownResource(worker)]};
  stages[5]={group:'http',stop:()=>server.close(),witnesses:[observeShutdownResource(server)]};
  t.after(async t=>{stream.destroy();if(worker.threadId!==-1){const done=once(worker,'exit');worker.postMessage('stop');await done;}if(server.listening)await new Promise(r=>server.close(r));});
 }
 return{dir,runId,requestId,receiptStore,stages,controller:createApplicationShutdown({...options,runId,libraryId,stages,receiptStore})};
}
console.log(JSON.stringify({evidence:'W04 module-owned work/stream/worker/HTTP; NOT original App or MySQL',pid:process.pid,host:process.platform,node:process.version}));

test('W04 unsupported by default; callback returns or caller-made promises do not prove coverage',async t=>{
 const f=await fixture(t,{stages:[]});assert.throws(()=>f.controller.request({runId:f.runId,requestId:f.requestId},token),/UNSUPPORTED/);assert.deepEqual(await fs.readdir(f.dir),[]);
 const r=await root();const stages=gates().map(s=>({...s,witnesses:[Promise.resolve(true)]}));const c=createApplicationShutdown({runId:crypto.randomUUID(),libraryId,stages,receiptStore:createShutdownReceiptStore({root:r})});assert.throws(()=>c.request({runId:c.state().runId,requestId:crypto.randomUUID()},token),/UNSUPPORTED/);
 const fakeDB=createApplicationShutdown({runId:crypto.randomUUID(),libraryId,stages:gates(),receiptStore:createShutdownReceiptStore({root:r})});assert.throws(()=>fakeDB.request({runId:fakeDB.state().runId,requestId:crypto.randomUUID()},token),/UNSUPPORTED/);
 assert.throws(()=>observeShutdownResource({close:()=>true}),/NOT_OBSERVABLE/);assert.throws(()=>createApplicationShutdown({runId:f.runId,libraryId:f.runId}),/INVALID/);
});

test('W04 real module-owned work, stream, Worker exit and delayed HTTP complete before receipt',async t=>{
 const f=await fixture(t,{budgetMs:2000});
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');parentPort.on('message',()=>parentPort.close());`,{eval:true});await once(worker,'online');
 const stream=new PassThrough();stream.resume();
 let releaseHTTP;const server=http.createServer((req,res)=>{res.setHeader('connection','close');res.writeHead(200);res.write('first');releaseHTTP=()=>res.end('last');});server.listen(0,'127.0.0.1');await once(server,'listening');
 const request=http.get(`http://127.0.0.1:${server.address().port}`,res=>res.resume());request.on('error',()=>{});while(!releaseHTTP)await new Promise(r=>setTimeout(r,2));
 t.after(async t=>{stream.destroy();if(worker.threadId!==-1){const done=once(worker,'exit');worker.postMessage('stop');await done;}if(server.listening){releaseHTTP?.();await new Promise(r=>server.close(r));}});
 let releaseWork;const work=f.stages[1].gate.run(()=>new Promise(r=>{releaseWork=r;}));
 const stages=f.stages.map(s=>({group:s.group,stop:s.stop,witnesses:s.witnesses}));
 stages[3]={group:'services',stop:()=>stream.end(),witnesses:[observeShutdownResource(stream)]};
 stages[4]={group:'database',stop:()=>worker.postMessage('stop'),witnesses:[observeShutdownResource(worker)]};
 stages[5]={group:'http',stop:()=>server.close(),witnesses:[observeShutdownResource(server)]};
 const c=createApplicationShutdown({runId:f.runId,libraryId,stages,receiptStore:f.receiptStore,budgetMs:2000});const command={runId:f.runId,requestId:f.requestId};const first=c.request(command,token);assert.equal(c.request(command,token).completion,first.completion);assert.throws(()=>c.request({runId:f.runId,requestId:crypto.randomUUID()},token),/CONFLICT/);
 assert.equal(c.state().phase,'ACCEPTED');assert.equal(await f.receiptStore.readCommitted(),null);await new Promise(r=>setTimeout(r,15));assert.equal(c.state().phase,'ACCEPTED');releaseWork();await work;
 await new Promise(r=>setTimeout(r,20));assert.equal(c.state().phase,'ACCEPTED');assert.equal(await f.receiptStore.readCommitted(),null);releaseHTTP();
 assert.equal((await first.completion).phase,'CLOSED_KNOWN');assert.equal(worker.threadId,-1);assert.equal(server.listening,false);assert.equal(stream.destroyed,true);
 const receipt=await f.receiptStore.readCommitted();assert.equal(verifyShutdownReceipt(receipt,{...command,libraryId},token),true);const s=await fs.stat(path.join(f.dir,'shutdown-receipt.json'));assert.equal(s.mode&0o777,0o600);
 assert.throws(()=>f.stages[0].gate.run(()=>true),/ADMISSION_CLOSED/);
});

test('W04 returned close callback without actual witnesses times out, stays UNKNOWN even after late end',async t=>{
 const f=await fixture(t,{budgetMs:35,stages:gates().map(s=>({...s,stop:()=>{}}))});const command={runId:f.runId,requestId:f.requestId};const task=f.controller.request(command,token);assert.equal((await task.completion).phase,'UNKNOWN');assert.equal(await f.receiptStore.readCommitted(),null);assert.equal(f.controller.request(command,token).completion,task.completion);assert.throws(()=>f.controller.request({runId:f.runId,requestId:crypto.randomUUID()},token),/CONFLICT/);
});

test('W04 late actual work cannot resume later phases or publish a success after timeout',async t=>{
 const dir=await root(),stages=gates();let release,calls=0;const work=stages[0].gate.run(()=>new Promise(r=>{release=r;}));stages[1].stop=()=>{calls++;stages[1].gate.seal();};const f=await fixture(t,{stages,budgetMs:30});const store=f.receiptStore,c=f.controller;const job=c.request({runId:c.state().runId,requestId:crypto.randomUUID()},token);assert.equal((await job.completion).phase,'UNKNOWN');release();await work;await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);assert.equal(c.state().phase,'UNKNOWN');assert.equal(await store.readCommitted(),null);
});

test('W04 step exception is sticky; matching retry never repeats executed work',async t=>{
 const stages=gates();let calls=0;stages[0].stop=()=>{calls++;throw Error('private internal error');};const f=await fixture(t,{stages});const cmd={runId:f.runId,requestId:f.requestId};const task=f.controller.request(cmd,token);assert.deepEqual(await task.completion,{phase:'UNKNOWN',runId:f.runId,requestId:f.requestId});await f.controller.request(cmd,token).completion;assert.equal(calls,1);assert.equal(await f.receiptStore.readCommitted(),null);
});

test('W04 Windows receipt unsupported and malformed coverage never start close operations',async t=>{
 const dir=await root(),stages=gates();let calls=0;stages[0].stop=()=>{calls++;};const store=createShutdownReceiptStore({root:dir,platform:'win32'});assert.equal(store.supported,false);const c=createApplicationShutdown({runId:crypto.randomUUID(),libraryId,stages,receiptStore:store});assert.throws(()=>c.request({runId:c.state().runId,requestId:crypto.randomUUID()},token),/UNSUPPORTED/);assert.equal(calls,0);assert.deepEqual(await fs.readdir(dir),[]);
});

test('W04 rejects unsafe private root or symlink receipt; existing sentinel stays unchanged',async t=>{
 for(const mode of ['root-mode','symlink']){const f=await fixture(t);const dir=f.dir,sentinel=path.join(dir,'sentinel');await fs.writeFile(sentinel,'keep');if(mode==='root-mode')await fs.chmod(dir,0o755);else await fs.symlink(sentinel,path.join(dir,'shutdown-receipt.json'));const store=f.receiptStore,c=f.controller;assert.equal((await c.request({runId:c.state().runId,requestId:crypto.randomUUID()},token).completion).phase,'UNKNOWN');assert.equal(await store.readCommitted(),null);assert.equal(await fs.readFile(sentinel,'utf8'),'keep');}
});

test('W04 wrong run/token command never starts; caller cannot mutate captured coverage to bypass witnesses',async t=>{
 const stages=gates();let release;const held=stages[0].gate.run(()=>new Promise(r=>{release=r;}));const f=await fixture(t,{stages,budgetMs:35});assert.throws(()=>f.controller.request({runId:crypto.randomUUID(),requestId:f.requestId},token),/INVALID/);assert.throws(()=>f.controller.request({runId:f.runId,requestId:f.requestId},'bad'),/INVALID/);assert.equal(f.controller.state().phase,'IDLE');stages.splice(0);const result=await f.controller.request({runId:f.runId,requestId:f.requestId},token).completion;assert.equal(result.phase,'UNKNOWN');release();await held;assert.equal(await f.receiptStore.readCommitted(),null);
});

test('W04 stage budget: sync late stop cannot start any subsequent resource stage',async t=>{
 const stages=gates();let subsequent=0;
 stages[0].stop=()=>{const end=performance.now()+80;while(performance.now()<end){}stages[0].gate.seal();};
 stages[1].stop=()=>{subsequent++;stages[1].gate.seal();};
 const f=await fixture(t,{stages,budgetMs:35});
 const result=await f.controller.request({runId:f.runId,requestId:f.requestId},token).completion;
 assert.equal(result.phase,'UNKNOWN');assert.equal(subsequent,0,'budget already expired; later close steps must not start');assert.equal(await f.receiptStore.readCommitted(),null);
});
