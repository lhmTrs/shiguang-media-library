import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {syntheticVideoCaller} from './helpers/synthetic-video-v2-caller.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
async function bound(p,ms){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('owned video-v2 timeout')),ms))]);}finally{clearTimeout(timer);}}
async function captureChild(command,args){const child=spawn(command,args,{stdio:['ignore','pipe','pipe']}),done=once(child,'close');let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);const [code]=await bound(done,30000);assert.equal(code,0,err);return out;}

test('real isolated HTTP gates, v2 routes/error envelope, CAS, retired endpoints and minimal synthetic caller reserve→raw import→binding readback',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'video-v2-http-'))),data=path.join(dir,'data');await fs.mkdir(data,{mode:0o700});const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),MEDIA_DATA_DIR:data,MEDIA_UPDREAM_QUEUE_DIR:path.join(dir,'absent-queue'),MEDIA_PERSONAL_ITEM_DIR:path.join(dir,'personal_item'),MEDIA_PERSONAL_VIDEO_DIR:path.join(dir,'personal-video'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_DISABLE_DESKTOP_NATIVE:'1',SHIGUANG_AUDIO_ANALYSIS:'0'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const exited=once(child,'exit'),base='http://127.0.0.1:'+port;
 try{
  let ready=false;for(let n=0;n<450;n++){if(child.exitCode!==null)throw Error('owned application startup failed: '+output.slice(-1500));try{if((await fetch(base+'/api/session')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
  const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],auth=await session.json(),headers={Cookie:cookie,'X-Local-Token':auth.token,'X-Shiguang-Library-Id':auth.instanceId,'Content-Type':'application/json'};
  const call=async(url,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+'/api'+url,{method,headers,body:body===undefined?undefined:JSON.stringify(body)}),value=await r.json();if(!r.ok)throw Object.assign(Error(value.message??value.error),{status:r.status,...value});return value;};
  const project=await call('/projects',{name:'合成视频v2 HTTP项目'}),prefix='/storyboard-video/v2',scope=prefix+'/projects/'+project.id;
  for(const [extra,status]of [[{},401],[{Cookie:cookie,Origin:'https://example.invalid'},403],[{...headers,'X-Shiguang-Library-Id':'wrong'},409]]){const r=await fetch(base+'/api'+scope+'/state',{headers:extra}),error=await r.json();assert.equal(r.status,status);assert.equal(error.error,error.message);assert.ok(typeof error.code==='string');}
  assert.equal((await call(scope+'/state')).initialized,false);
  const source=syntheticSource(),first=source.scenes[0].shots[0];source.scenes[0].shots=Array.from({length:3},(_,i)=>({...structuredClone(first),id:'shot_'+i,dialogue:[],duration_ms:1000}));source.segments[0].start_shot_id='shot_0';
  const initialized=await call('/storyboard/projects/'+project.id+'/initialize',{source,request_id:randomUUID(),expected_revision:null});
  const file=path.join(dir,'synthetic.mp4'),encoded=spawnSync((process.env.VIDEO_V2_FFMPEG||'ffmpeg'),['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=96x64:r=8:d=4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file]);assert.equal(encoded.status,0);const bytes=await fs.readFile(file),importId=randomUUID();
  await call('/project-videos/projects/'+project.id+'/imports',{requestId:importId,fileName:'synthetic-http.mp4',bytes:bytes.length,prompt:{mode:'none'}});
  const upload=await fetch(base+'/api/project-videos/projects/'+project.id+'/imports/'+importId+'/content',{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:bytes});const imported=await upload.json();assert.equal(upload.status,200,JSON.stringify(imported));assert.equal(imported.status,'ready');
  const bindingPath=prefix+'/source-projects/'+project.id+'/videos/'+imported.videoId+'/binding',intent={action:'bind',expectedBindingRevision:0,targetProjectId:project.id,expectedStoryboardRevision:1,expectedAssetStamp:initialized.asset_stamp,shotIds:['shot_0','shot_1']},preview=await call(bindingPath+'/preview',intent);
  assert.deepEqual(preview.affectedShots,[]);assert.equal(preview.before,null);assert.equal(preview.after.shots.length,2);
  const missingToken=await fetch(base+'/api'+bindingPath,{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(intent)}),tokenError=await missingToken.json();assert.equal(missingToken.status,403);assert.equal(tokenError.error,tokenError.message);
  const bound=await call(bindingPath,{...intent,requestId:randomUUID(),previewHash:preview.previewHash},'PUT');assert.equal(bound.binding.origin,'manual');
  const page=await call(scope+'/shots/shot_0/videos');assert.equal(page.items.length,1);assert.ok(!JSON.stringify(page).includes(dir));
  const plans=[];for(const action of ['adopt-video','adopt-shot']){const i={action,expectedSelectionRevision:0,expectedStoryboardRevision:1,sourceProjectId:project.id,videoId:imported.videoId,bindingId:bound.binding.bindingId,expectedBindingRevision:1,...(action==='adopt-shot'?{shotId:'shot_0'}:{})},p=await call(scope+'/selections/preview',i);plans.push({...i,requestId:randomUUID(),previewHash:p.previewHash});}
  const raced=await Promise.allSettled(plans.map(p=>call(scope+'/selections',p)));assert.equal(raced.filter(r=>r.status==='fulfilled').length,1);assert.equal(raced.find(r=>r.status==='rejected').reason.code,'VIDEO_SELECTION_CONFLICT');
  const legacy=await fetch(base+'/api/storyboard-video/projects/'+project.id+'/state',{headers});assert.equal(legacy.status,410);assert.equal((await legacy.json()).code,'LEGACY_VIDEO_BINDING_RETIRED');
  const malformed=await fetch(base+'/api'+scope+'/provenance',{method:'POST',headers,body:'{"/private/synthetic-secret":'}),malformedBody=await malformed.json();assert.equal(malformed.status,400);assert.equal(malformedBody.error,malformedBody.message);assert.ok(!JSON.stringify(malformedBody).includes('synthetic-secret'));
  const outputFolder=await call('/project-videos/projects/'+project.id+'/folders',{requestId:randomUUID(),name:'合成外置输出',parentId:'root'});
  let durable;
  const produced=await syntheticVideoCaller({api:call,projectId:project.id,shotIds:['shot_0','shot_1'],folderId:outputFolder.id,bytes,
   persist:async record=>{durable=record;await fs.writeFile(path.join(dir,'synthetic-caller.json'),JSON.stringify(record),{mode:0o600});},
   afterReserve:async view=>{assert.ok(durable.provenance.provenanceId);view.project.scenes[0].shots[0].action='合成调用等待期间的新动作';await call('/storyboard/projects/'+project.id,{project:view.project,expected_revision:view.revision,request_id:randomUUID()},'PUT');},
   upload:async(url,raw)=>{const r=await fetch(base+'/api'+url,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream'},body:raw});assert.equal(r.status,200);return r.json();}});
  assert.equal(produced.actual.binding.provenance.storyboardRevision,1);assert.equal(produced.actual.context.storyboardRevision,2);assert.equal(produced.actual.review.needsReview,true);assert.equal(produced.receipt.id,durable.importId);
 }finally{
  if(child.exitCode===null)child.kill('SIGTERM');const [code]=await bound(exited,15000);assert.equal(code,0,output.slice(-1500));assert.match(output,/APPLICATION_CLOSED_KNOWN/);await fs.rm(dir,{recursive:true,force:true});
 }
});
