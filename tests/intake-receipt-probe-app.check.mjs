// Explicit App check: only owned SQLite/files/loopback server, no original data.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Receipts} from '../server/file-intake/files.mjs';
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-receipt-probe-app-'))),dataDir=path.join(root,'data'),id=randomUUID();
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
let child,exited,origin,cookie,token,logs='',starts=0;const exits=[];
const bounded=async(p,ms)=>{let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('UNKNOWN: owned App timeout; evidence '+root)),ms);})]);}finally{clearTimeout(timer);}};
const hook=path.join(root,'cleanup-fault.mjs');await fs.writeFile(hook,`import fs from 'node:fs/promises';const original=fs.unlink;fs.unlink=async function(file){if(String(file).includes(${JSON.stringify(id+'.json.')} )&&String(file).endsWith('.tmp'))throw Object.assign(Error('synthetic cleanup fault'),{code:'EPERM'});return original(file);};`,{mode:0o600});
async function start(){
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));assert.notEqual(port,4317);
 child=spawn(process.execPath,[...(starts++===0?['--import',hook]:[]),'server/index.mjs'],{cwd:process.cwd(),env:{...process.env,PATH:path.join(root,'no-tools'),NODE_ENV:'production',PORT:String(port),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(root,'managed'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',MEDIA_CLOUD_AUDIO_ENABLED:'0',MEDIA_DISABLE_DESKTOP_NATIVE:'1',CODEX_BIN:path.join(root,'no-codex'),MEDIA_STORYBOARD_FFPROBE:path.join(root,'missing-private-probe')},stdio:['ignore','pipe','pipe']});
 exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));for(const pipe of [child.stdout,child.stderr])pipe.on('data',b=>{if(Buffer.byteLength(logs)+b.length<1048576)logs+=b;});
 origin='http://127.0.0.1:'+port;
 for(let i=0;i<150;i++){assert.equal(child.exitCode,null,logs);try{const response=await fetch(origin+'/api/session',{signal:AbortSignal.timeout(500)}),session=await response.json();if(response.ok){cookie=response.headers.get('set-cookie').split(';')[0];token=session.token;return;}}catch{}await new Promise(r=>setTimeout(r,50));}throw Error('owned App ready timeout');
}
async function stop(){if(!child)return;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');let exit;try{exit=await bounded(exited,15000);}catch(e){child.unref();child.stdout.unref?.();child.stderr.unref?.();throw e;}assert.deepEqual(exit,{code:0,signal:null},logs);exits.push(exit);child=null;}
async function api(route,body){const response=await fetch(origin+'/api'+route,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json','x-local-token':token,origin}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(3000)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
try{
 await start();const project=await api('/projects',{name:'合成收纳诊断'}),photo=path.join(root,'owned.png'),video=path.join(root,'owned.mp4');await fs.writeFile(photo,png);await fs.writeFile(video,'owned synthetic video');
 const receipts=await new Receipts(dataDir).init(),h=await receipts.handoff([photo,video]);const input={version:2,requestId:id,mode:'copy',fileIds:h.files.map(f=>f.id),targets:h.files.map(f=>({fileId:f.id,destination:f.mediaKind==='photo'?{scope:'library',kind:'photo'}:{scope:'project',kind:'video',projectId:project.id,folderId:'root'}}))};
 await api('/file-intake/handoffs/'+h.id+'/confirm',input);let dto;
 for(let i=0;i<200;i++){dto=await api('/file-intake/batches/'+id);if(!['queued','running'].includes(dto.status))break;await new Promise(r=>setTimeout(r,30));}
 assert.equal(dto.status,'partial',JSON.stringify(dto));assert.equal(dto.items.find(i=>i.mediaKind==='photo').status,'ready');const failed=dto.items.find(i=>i.mediaKind==='video');assert.equal(failed.status,'failed');assert.equal(failed.code,'PROBE_UNAVAILABLE');assert.equal(failed.diagnostic.causeCode,'ENOENT');assert.ok(!JSON.stringify(failed.diagnostic).includes(root));
 assert.deepEqual(await api('/file-intake/handoffs/'+h.id+'/confirm',input),dto);assert.deepEqual(await fs.readFile(photo),png);assert.equal((await fs.readFile(video,'utf8')),'owned synthetic video');
 const ownedTemps=await fs.readdir(path.join(dataDir,'file-intake/batches'));assert.equal(ownedTemps.filter(f=>f.startsWith(id+'.json.')&&f.endsWith('.tmp')).length,1);
 const ack=await api('/file-intake/batches/'+id+'/acknowledge',{acknowledged:true,resultKey:dto.resultKey});assert.equal(ack.acknowledged,true);
 await stop();await start();assert.deepEqual(await api('/file-intake/batches/'+id),ack);assert.deepEqual(await api('/file-intake/handoffs/'+h.id+'/confirm',input),ack);await stop();
 assert.equal(logs.match(/APPLICATION_CLOSED_KNOWN/g)?.length,2);await fs.writeFile(path.join(root,'result.json'),JSON.stringify({passed:true,checks:['cleanup-failed committed receipt discoverable through HTTP','photo succeeds while video dependency absent','safe diagnostic persisted','repeat and restart do not re-run','known failure acknowledged with original result','both Apps normal exit'],exits},null,2));console.log('PASS OWN_APP '+root);
}finally{await stop();await fs.writeFile(path.join(root,'app.log'),logs,{mode:0o600});}
