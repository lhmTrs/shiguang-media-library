import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
export async function bounded(p,ms,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),ms))]);}finally{clearTimeout(timer);}}
export async function ownedVideoServer(f,{phase,hold=false}={}){
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const args=[...(phase?['--import','./tests/fixtures/storyboard-video-v2/startup-checkpoint.mjs']:[]),'server/index.mjs'];
 const child=spawn(process.execPath,args,{cwd:process.cwd(),env:{...process.env,PORT:String(port),MEDIA_DATA_DIR:f.lib.dataDir,MEDIA_UPDREAM_QUEUE_DIR:path.join(f.dir,'absent-queue'),MEDIA_PERSONAL_ITEM_DIR:path.join(f.dir,'personal_item'),MEDIA_PERSONAL_VIDEO_DIR:path.join(f.dir,'personal-video'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_DISABLE_DESKTOP_NATIVE:'1',SHIGUANG_AUDIO_ANALYSIS:'0',...(phase?{VIDEO_V2_TEST_PHASE:phase,VIDEO_V2_TEST_HOLD:hold?'1':'0'}:{})},stdio:['ignore','pipe','pipe','ipc']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const exited=once(child,'exit');let stopped=false;
 const stop=async()=>{if(stopped)return;stopped=true;if(child.exitCode===null)child.kill('SIGTERM');const [code]=await bounded(exited,20000,'owned application normal exit timeout');assert.equal(code,0,output.slice(-2000));assert.match(output,/APPLICATION_CLOSED_KNOWN/);};
 const ready=async()=>{let base;for(let i=0;i<300;i++){if(child.exitCode!==null)throw Error('owned startup failed '+output.slice(-2000));const matched=/拾光素材库 http:\/\/127\.0\.0\.1:(\d+)/.exec(output);if(matched){base='http://127.0.0.1:'+matched[1];break;}await new Promise(r=>setTimeout(r,50));}assert.ok(base,'owned server did not listen');const response=await fetch(base+'/api/session'),cookie=response.headers.get('set-cookie').split(';')[0],session=await response.json();assert.equal(session.instanceId,f.instanceId);const headers={Cookie:cookie,'X-Local-Token':session.token,'X-Shiguang-Library-Id':session.instanceId,'Content-Type':'application/json'};
  const api=async(url,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+'/api'+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),value=await r.json();if(!r.ok)throw Object.assign(Error(value.message??value.error),{status:r.status,...value});return value;};api.raw=url=>fetch(base+(url.startsWith('/api/')?url:'/api'+url),{headers});
  // Startup queues metadata for the owned clip. Settle that known work before
  // asserting media authority; a concurrent metadata edit correctly conflicts.
  let idle=false;for(let i=0;i<200;i++){const jobs=await api('/jobs');if(jobs.metadata.active===0&&jobs.metadata.queued===0){idle=true;break;}await new Promise(r=>setTimeout(r,25));}assert.ok(idle,'owned startup metadata did not settle');return api;};
 return {child,ready,stop,output:()=>output};
}
