import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {progressFixture} from './helpers/updream-progress-fixture.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(p,ms){let timer;try{return await Promise.race([p,new Promise((_,rej)=>timer=setTimeout(()=>rej(Error('owned test timeout')),ms))]);}finally{clearTimeout(timer);}}
test('isolated real application gates and read-only queue API; normal shutdown does not wait for remote work',async()=>{
 const f=await progressFixture();await f.put('active');const job=await f.put('failed',{stage:'failed'},{generation:{task_id:'failed',status:'failed',error:'PRIVATE_RAW_ERROR'}});
 const before=await Promise.all([fs.readFile(job.file),fs.readFile(job.source)]);
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),MEDIA_DATA_DIR:f.data,MEDIA_UPDREAM_QUEUE_DIR:f.queue,MEDIA_PERSONAL_VIDEO_DIR:path.join(f.root,'video'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_DISABLE_DESKTOP_NATIVE:'1',SHIGUANG_AUDIO_ANALYSIS:'0'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});const exited=once(child,'exit');const base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<450;i++){if(child.exitCode!==null)throw Error('isolated application exited before ready');try{const r=await fetch(base+'/api/session');if(r.ok){ready=true;break;}}catch{}await wait(100);}assert.ok(ready,'isolated server readiness');
  assert.equal((await fetch(base+'/api/updream-progress')).status,401);
  const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();const headers={Cookie:cookie,'Content-Type':'application/json'};
  const listing=await fetch(base+'/api/updream-progress',{headers});assert.equal(listing.status,200);const body=await listing.json();assert.equal(body.tasks.length,2);assert.ok(!JSON.stringify(body).includes('PRIVATE'));assert.equal(listing.headers.get('cache-control'),'no-store');
  const task=body.tasks.find(t=>t.id==='failed'),request={items:[{id:task.id,version:task.eventVersion}]};
  assert.equal((await fetch(base+'/api/updream-progress/read',{method:'POST',headers,body:JSON.stringify(request)})).status,403);
  assert.equal((await fetch(base+'/api/updream-progress/read',{method:'POST',headers:{...headers,'X-Local-Token':token,Origin:'https://evil.invalid'},body:JSON.stringify(request)})).status,403);
  const result=await fetch(base+'/api/updream-progress/read',{method:'POST',headers:{...headers,'X-Local-Token':token},body:JSON.stringify(request)});assert.equal(result.status,200);assert.deepEqual((await result.json()).marked,['failed']);
  const detail=await fetch(base+'/api/updream-progress/tasks/failed',{headers});assert.equal((await detail.json()).task.unread,false);
  assert.equal((await fetch(base+'/api/updream-progress?queueDir=/etc',{headers})).status,400);
  assert.equal((await fetch(base+'/api/updream-progress/tasks/failed/cancel',{method:'POST',headers:{...headers,'X-Local-Token':token},body:'{}'})).status,404);
  assert.deepEqual(await Promise.all([fs.readFile(job.file),fs.readFile(job.source)]),before);
 }finally{
  if(child.exitCode===null)child.kill('SIGTERM');const [code]=await bounded(exited,15000);assert.equal(code,0);assert.match(output,/APPLICATION_CLOSED_KNOWN/);await fs.rm(f.root,{recursive:true,force:true});
 }
});
