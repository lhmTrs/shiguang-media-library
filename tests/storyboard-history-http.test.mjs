import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
async function bound(p,ms){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned application timeout')),ms))]);}finally{clearTimeout(timer);}}
test('real isolated HTTP: same local gates, snapshots/diff/read markers/category/restore; normal close',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'storyboard-history-http-'))),data=path.join(root,'data');await fs.mkdir(data,{mode:0o700});const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),MEDIA_DATA_DIR:data,MEDIA_UPDREAM_QUEUE_DIR:path.join(root,'absent-queue'),MEDIA_PERSONAL_VIDEO_DIR:path.join(root,'video'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_DISABLE_DESKTOP_NATIVE:'1',SHIGUANG_AUDIO_ANALYSIS:'0'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>{output+=v;});child.stderr.on('data',v=>{output+=v;});const exited=once(child,'exit'),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let i=0;i<450;i++){if(child.exitCode!==null)throw Error('owned application startup failed');try{if((await fetch(base+'/api/session')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json(),headers={Cookie:cookie,'X-Local-Token':token,'Content-Type':'application/json'};
  const call=async(url,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+'/api'+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),value=await r.json();if(!r.ok)throw Object.assign(Error(value.message||value.error),{status:r.status,...value});return value;};
  const project=await call('/projects',{name:'合成历史HTTP项目'}),prefix='/storyboard/projects/'+project.id;
  assert.equal((await fetch(base+'/api'+prefix+'/versions')).status,401);
  await call(prefix+'/initialize',{source:syntheticSource(),request_id:randomUUID(),expected_revision:null});const first=await call(prefix);assert.equal(first.version,1);assert.equal(first.pending_count,0);
  const draft=structuredClone(first.project);draft.scenes[0].shots[0].action='合成HTTP新动作';
  await assert.rejects(call(prefix,{project:draft,expected_revision:1,change:{author:'agent'}},'PUT'),{status:400,code:'CHANGE_REASON_REQUIRED'});
  const request={project:draft,expected_revision:1,request_id:randomUUID(),change:{author:'agent',reason_text:'原用户指令',reason_category:'shot_feel'}};const second=await call(prefix,request,'PUT');assert.equal(second.version,2);assert.equal((await call(prefix,request,'PUT')).saved_version,2);
  const versions=await call(prefix+'/versions');assert.equal(versions.total,2);assert.ok(versions.storage.bytes>0);const diff=await call(prefix+'/versions/1/diff?against=current');assert.ok(diff.changes.some(c=>c.field==='action'));assert.equal((await call(prefix+'/changes?limit=1')).items[0].reason_text,'原用户指令');
  await call(prefix+'/versions/2/category',{reason_category:'miscommunication',expected_reason_category:'shot_feel'},'PATCH');assert.equal((await call(prefix+'/versions/2')).reason_category,'miscommunication');
  await assert.rejects(call(prefix+'/pending/clear',{all:true}),{status:400,code:'VIEW_VERSION_REQUIRED'});
  const restored=await call(prefix+'/versions/1/restore',{expected_revision:2,request_id:randomUUID()});assert.equal(restored.version,3);assert.equal(restored.project.scenes[0].shots[0].action,first.project.scenes[0].shots[0].action);
  const cleared=await call(prefix+'/pending/clear',{all:true,through_version:2});assert.equal(cleared.pending_count,0);assert.deepEqual((await call(prefix+'/pending')).items,[]);assert.equal((await call(prefix+'/versions')).total,3);assert.equal((await call(prefix+'/changes?limit=1')).items[0].author_kind,'restore');
  assert.equal((await fetch(base+'/api'+prefix+'/pending/clear',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 }finally{
  if(child.exitCode===null)child.kill('SIGTERM');const [code]=await bound(exited,15000);assert.equal(code,0);assert.match(output,/APPLICATION_CLOSED_KNOWN/);await fs.rm(root,{recursive:true,force:true});
 }
});
