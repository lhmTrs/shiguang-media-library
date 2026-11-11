// Whole local App/API check with owned SQLite and synthetic media. No account,
// original library, real cloud or model; no native Finder registration.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Receipts} from '../server/file-intake/files.mjs';
const root=path.resolve(import.meta.dirname,'..');
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-intake-app-')));
const dataDir=path.join(dir,'data'), evidence=path.resolve(process.env.FILE_INTAKE_APP_EVIDENCE||path.join(dir,'evidence'));
await fs.mkdir(evidence,{recursive:true});
const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
let child,exited,exit,output='',cookie='',token='',origin,passed=false;const checks=[];
function start() {
  child=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,
    NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(dir,'personal_item'),
    MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',
    MEDIA_CLOUD_AUDIO_ENABLED:'0',MEDIA_DISABLE_DESKTOP_NATIVE:'1',
    CODEX_HOME:path.join(dir,'codex'),CODEX_BIN:path.join(dir,'no-codex')},stdio:['ignore','pipe','pipe']});
  output='';exit=null;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exit={code,signal};resolve(exit);}));
}
async function ready() {
  const end=Date.now()+60000;
  while(Date.now()<end) {
    if(exit)throw Error('Owned App exited before ready');
    try {const record=JSON.parse(await fs.readFile(path.join(dataDir,'server.json'),'utf8'));
      if(record.pid===child.pid){origin=record.url;const r=await fetch(origin+'/api/session');const s=await r.json();
        if(r.ok&&s.app==='shiguang-local-media'){cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;token=s.token;return s;}}}
    catch{}await new Promise(r=>setTimeout(r,50));
  }throw Error('Owned App ready timeout');
}
async function api(url,body,method) {
  const r=await fetch(origin+'/api'+url,{method:method||(body?'POST':'GET'),headers:{cookie,...(body?{'Content-Type':'application/json','X-Local-Token':token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)});
  const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status,code:value.code});return value;
}
async function finishBatch(id) {
  const end=Date.now()+15000;
  while(Date.now()<end){const b=await api('/file-intake/batches/'+id);if(!['queued','running'].includes(b.status))return b;await new Promise(r=>setTimeout(r,30));}
  throw Error('Owned batch not terminal within budget');
}
async function stop() {
  if(!child||exit)return;
  child.kill('SIGTERM');let timer;
  try {await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('OWNED_APP_CLOSE_UNKNOWN; no force kill attempted')),20000);})]);}
  finally {clearTimeout(timer);}
  assert.equal(exit.code,0);assert.equal(exit.signal,null);assert.match(output,/APPLICATION_CLOSED_KNOWN/);
}
try {
  const file=path.join(dir,'from-finder.mp4');
  const generated=spawnSync(process.env.FFMPEG_PATH||'/opt/homebrew/bin/ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=96x64:r=2:d=1','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file]);assert.equal(generated.status,0);
  start();const session=await ready();checks.push('original App started with new owned SQLite, autoconnect disabled');
  const project=await api('/projects',{name:'访达API合成项目',software:'',note:''});
  const receipts=await new Receipts(dataDir).init(),handoff=await receipts.handoff([file]);
  const h=await api('/file-intake/handoffs/'+handoff.id);assert.equal(h.files[0].id,handoff.files[0].id);assert.ok(h.projects.some(p=>p.id===project.id));
  const folders=await api('/file-intake/projects/'+project.id+'/folders');assert.equal(folders.folders[0].id,'root');
  const options=await api('/file-intake/routing-options');
  assert.deepEqual(options.projects.find(p=>p.id===project.id).videoFolders,folders.folders);
  assert.deepEqual(options.photoCategories,[{id:'',name:'待确认',relativePath:''}]);
  const choice={fileId:h.files[0].id,nameMode:'standard',destination:{kind:'video',scope:'project',projectId:project.id,folderId:'root'}};
  assert.deepEqual((await api('/file-intake/handoffs/'+handoff.id+'/name-preview',{targets:[choice]})).items,
    [{fileId:choice.fileId,proposedFileName:project.name+'_001.mp4',proposedNumber:1}]);
  await assert.rejects(fs.access(path.join(dir,'personal_item','video')),{code:'ENOENT'});
  assert.deepEqual(await api('/file-intake/theme'),{themeId:null});
  const themeUrl=origin+'/api/file-intake/theme';
  const unsigned=await fetch(themeUrl,{method:'PUT',headers:{cookie,'Content-Type':'application/json'},body:'{"themeId":"midnight"}'});
  assert.equal(unsigned.status,403);
  assert.deepEqual(await api('/file-intake/theme',{themeId:'midnight'},'PUT'),{themeId:'midnight'});
  assert.deepEqual(await api('/file-intake/theme',{themeId:'forest',onlyIfUnset:true},'PUT'),{themeId:'midnight'});
  assert.equal((await api('/file-intake/handoffs/'+handoff.id)).themeId,'midnight');
  checks.push('Authenticated routing options, read-only filename planning, and guarded shared theme through the App HTTP routes');
  const input={requestId:randomUUID(),projectId:project.id,folderId:'root',fileIds:handoff.files.map(i=>i.id),mode:'copy'};
  const accepted=await api('/file-intake/handoffs/'+handoff.id+'/confirm',input),again=await api('/file-intake/handoffs/'+handoff.id+'/confirm',input);assert.equal(accepted.id,again.id);
  const batch=await finishBatch(accepted.id);assert.equal(batch.status,'completed');assert.equal(batch.items[0].status,'ready');
  const list=await api('/project-videos/projects/'+project.id);assert.equal(list.videos.length,1);assert.deepEqual(await fs.readFile(list.videos[0].path),await fs.readFile(file));
  checks.push('private native selection -> confirm -> durable receipt -> actual copied/indexed project video; confirm idempotent');
  const media=await fetch(origin+list.videos[0].mediaUrl,{headers:{cookie,Range:'bytes=0-31'}});assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,32);
  const status=await api('/file-intake/status');assert.equal(status.activeCount,0);assert.equal(status.latestCompletion.id,batch.id);
  const managed=await receipts.handoff([list.videos[0].path]);const next=await api('/file-intake/handoffs/'+managed.id+'/confirm',{...input,requestId:randomUUID(),fileIds:managed.files.map(i=>i.id)});
  assert.equal((await finishBatch(next.id)).items[0].status,'managed');checks.push('original media route previews exact bytes; managed selection preserved without another copy');
  const refused=await fetch(origin+'/api/file-intake/handoffs/'+handoff.id+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(refused.status,401);
  const cross=await fetch(origin+'/api/file-intake/status',{headers:{cookie,Origin:'https://untrusted.invalid'}});assert.equal(cross.status,403);
  await assert.rejects(api('/file-intake/handoffs/'+randomUUID()+'/confirm',{...input,requestId:randomUUID(),path:file}),e=>e.status>=400);
  checks.push('no unauthenticated/cross-origin write or arbitrary HTTP path intake');
  await stop();await fs.writeFile(path.join(evidence,'first-app.log'),output);
  start();const restarted=await ready();assert.equal(restarted.instanceId,session.instanceId);
  assert.deepEqual(await api('/file-intake/theme'),{themeId:'midnight'});
  assert.ok((await api('/file-intake/batches')).batches.some(b=>b.id===batch.id&&b.items[0].status==='ready'));
  assert.equal((await api('/project-videos/projects/'+project.id)).videos.length,1);checks.push('normal owned restart retains exact receipts without recopy');
  passed=true;
}finally {
  let closeError;try{await stop();}catch(e){closeError=e.message;}
  await fs.writeFile(path.join(evidence,'last-app.log'),output);
  await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify({passed:passed&&!closeError,checks,dir,port,applicationExit:exit,applicationClosedKnown:/APPLICATION_CLOSED_KNOWN/.test(output),closeError},null,2));
  if(closeError)throw Error(closeError);
}
console.log(JSON.stringify({passed,evidence,checks}));
