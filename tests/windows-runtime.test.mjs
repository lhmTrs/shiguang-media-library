import {Worker,MessageChannel} from 'node:worker_threads';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import Database from 'better-sqlite3';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {dataDirectory} from '../server/runtime.mjs';
import {platformWords} from '../server/platform-words.mjs';
import {createShutdownClient} from '../scripts/shutdown-client.mjs';
import {readShutdownReceipt,verifyShutdownReceipt,observeSqliteShutdown} from '../server/application-shutdown.mjs';
import {allocateWindowsStage,cleanupWindowsStage} from '../server/windows-staging.mjs';
const temporary=tempDirectories(test,'windows-runtime-');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await pause(20);}throw Error('OWNED_OPERATION_TIMEOUT');}
const sqlite=async dir=>{await fs.mkdir(dir,{recursive:true});const db=new Database(path.join(dir,'library.sqlite'));db.exec('CREATE TABLE owned(value TEXT);INSERT INTO owned VALUES(\'keep\')');db.close();};
test('Windows directory selection preserves the only old library, defaults new installs locally, conflicts fail without moving data',async t=>{
 const base=await temporary(t),project=path.join(base,'project'),home=path.join(base,'home'),local=path.join(base,'local'),old=path.join(project,'data'),next=path.join(local,'ShiguangMedia'),env={MEDIA_PORTABLE:'1',LOCALAPPDATA:local};
 assert.equal(dataDirectory(project,env,'win32',home),next);
 await sqlite(old);const before=await fs.readFile(path.join(old,'library.sqlite'));assert.equal(dataDirectory(project,env,'win32',home),old);
 await sqlite(next);assert.throws(()=>dataDirectory(project,env,'win32',home),{code:'DATA_DIRECTORY_CONFLICT'});
 assert.equal(dataDirectory(project,{...env,MEDIA_DATA_DIR:old},'win32',home),old);assert.deepEqual(await fs.readFile(path.join(old,'library.sqlite')),before);
 await fs.writeFile(path.join(next,'library.sqlite'),'corrupt');assert.throws(()=>dataDirectory(project,env,'win32',home),{code:'DATA_DIRECTORY_UNCONFIRMED'});
 assert.equal(dataDirectory(project,{MEDIA_PORTABLE:'1'},'darwin',home),old);
});
test('platform messages preserve Mac byte-for-byte and do not translate user content',()=>{
 const message='在访达中显示 · 系统废纸篓 · 这台 Mac · Mac 原生组件';assert.equal(platformWords(message,'darwin'),message);
 assert.equal(platformWords(message,'win32'),'在文件夹中显示 · 系统回收站 · 这台电脑 · 系统组件');assert.equal(platformWords('访达','linux'),'文件管理器');
 assert.throws(()=>observeSqliteShutdown({open:true,close(){}}),/DATABASE_NOT_OBSERVABLE/);
});
test('Windows same-volume staging only removes owned bytes after verified publication and readback',{skip:process.platform!=='win32'},async t=>{
 const base=await temporary(t),target=path.join(base,'target');await fs.mkdir(target);const own=await allocateWindowsStage(target,'shiguang-reference-import-');const stage=path.join(own.cache,'original.partial');await fs.writeFile(stage,'owned');const stageStat=await fs.lstat(stage),copy=path.join(target,'saved.txt');
 assert.equal((await fs.stat(target)).dev,(await fs.stat(own.cache)).dev);
 const input={cache:own.cache,cacheIdentity:own.identity,stage,stageStat,target};
 await assert.rejects(cleanupWindowsStage({...input,verify:async()=>{throw Error('not published');}}));assert.equal(await fs.readFile(stage,'utf8'),'owned');
 await fs.copyFile(stage,copy);await cleanupWindowsStage({...input,verify:async()=>assert.equal(await fs.readFile(copy,'utf8'),'owned')});assert.equal(await fs.readFile(copy,'utf8'),'owned');await assert.rejects(fs.stat(own.cache),{code:'ENOENT'});
 const changed=await allocateWindowsStage(target,'shiguang-reference-import-'),changedStage=path.join(changed.cache,'original.partial');await fs.writeFile(changedStage,'original');const old=await fs.stat(changedStage);await fs.writeFile(changedStage,'replacement');await assert.rejects(cleanupWindowsStage({cache:changed.cache,cacheIdentity:changed.identity,stage:changedStage,stageStat:old,target,verify:async()=>{}}));assert.equal(await fs.readFile(changedStage,'utf8'),'replacement');
});
async function startOwned(t,base){
 const data=path.join(base,'data'),personal=path.join(base,'personal'),home=path.join(base,'home');for(const d of [data,personal,home])await fs.mkdir(d,{recursive:true});
 const reserved=net.createServer();reserved.listen(0,'127.0.0.1');await once(reserved,'listening');const port=reserved.address().port;assert.ok(![4317,3306].includes(port));await new Promise(r=>reserved.close(r));
 const child=spawn(process.execPath,[path.resolve('server/index.mjs')],{env:{...process.env,HOME:home,USERPROFILE:home,LOCALAPPDATA:path.join(home,'local'),MEDIA_DATA_DIR:data,MEDIA_PERSONAL_ITEM_DIR:personal,MEDIA_UPDREAM_QUEUE_DIR:path.join(base,'empty-queue'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',MEDIA_DISABLE_DESKTOP_NATIVE:'1',SHIGUANG_AUDIO_ANALYSIS:'',SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(base,'absent-release.json'),PORT:String(port),NODE_ENV:'production'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let output='',closed=false;child.stdout.on('data',b=>output=(output+b).slice(-16000));child.stderr.on('data',b=>output=(output+b).slice(-16000));const exited=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;resolve({code,signal});}));
 const origin=`http://127.0.0.1:${port}`;
 const record=await until(async()=>{if(closed)throw Error('OWNED_SERVER_START_FAILED '+output.slice(-1000));try{const value=JSON.parse(await fs.readFile(path.join(data,'server.json'),'utf8'));return value.pid===child.pid&&value;}catch{return null;}});
 const readReceipt=()=>readShutdownReceipt(path.join(data,record.receiptDirectory));
 t.after(async()=>{if(!closed){const c=createShutdownClient({budgetMs:30000,readReceipt});const state=await c.stop({url:origin,libraryId:record.instanceId,runId:record.runId,requestId:crypto.randomUUID()});if(state.phase!=='CLOSED_KNOWN'){t.diagnostic('OWNED_APP_CLOSE_UNKNOWN: no forced stop');child.unref();child.stdout.unref();child.stderr.unref();}}});
 const response=await fetch(origin+'/api/session'),identity=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];const headers={cookie,origin,'x-local-token':identity.token,'content-type':'application/json'};
 const call=(route,body,extra={})=>fetch(origin+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return{data,record,origin,identity,headers,call,readReceipt,exited,output:()=>output};
}
test('Windows actual application: private identity, denied commands, 202 is not closure, real HTTP/DB drain receipt and restart readback',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const base=await temporary(t),app=await startOwned(t,base);assert.equal(app.identity.platform,'win32');assert.ok(!('runId' in app.identity));assert.deepEqual(Object.keys(app.identity).sort(),['app','folderPickerAvailable','instanceId','platform','token','trashAvailable'].sort());
 assert.equal((await fetch(app.origin+'/api/application/identity')).status,401);
 const project=await (await app.call('projects',{name:'原样访达标题'})).json();assert.ok(project.id);

 // Actual project publication and DB readback, not just the cleanup adapter.
 const fixtureVideo=path.join(base,'synthetic.mp4');await promisify(execFile)('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=green:s=64x64:r=5:d=1','-c:v','libx264',fixtureVideo]);const video=await fs.readFile(fixtureVideo),requestId=crypto.randomUUID(),videoRoute=`project-videos/projects/${project.id}/imports`;
 const started=await app.call(videoRoute,{requestId,fileName:'验证 🎬.mp4',bytes:video.length,prompt:{mode:'none'}});assert.equal(started.status,200,await started.clone().text());
 const videoResponse=await fetch(app.origin+'/api/'+videoRoute+'/'+requestId+'/content',{method:'PUT',headers:{...app.headers,'content-type':'application/octet-stream'},body:video});const uploaded=await videoResponse.json();assert.equal(videoResponse.status,200,JSON.stringify(uploaded));assert.equal(uploaded.status,'ready');
 const probeDB=new Database(path.join(app.data,'library.sqlite'),{readonly:true});const stored=JSON.parse(probeDB.prepare('SELECT data_json FROM project_video_imports WHERE id=?').get(requestId).data_json);assert.equal(stored.stageCleanup.complete,true);await assert.rejects(fs.stat(stored.cache),{code:'ENOENT'});
 const published=JSON.parse(probeDB.prepare('SELECT data_json FROM storyboard_video_sources WHERE id=?').get(uploaded.videoId).data_json);assert.deepEqual(await fs.readFile(published.path),video);probeDB.close();
 const scene=await (await app.call('project-assets/assets',{project_id:project.id,kind:'scene',name:'合成场景'})).json();assert.ok(scene.id);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64'),imageId=crypto.randomUUID();
 const imageStart=await app.call('project-assets/image-imports',{requestId:imageId,assetId:scene.id,projectId:project.id,lookId:null,fileName:'场景 🎬.png',bytes:png.length});assert.equal(imageStart.status,200,await imageStart.clone().text());
 const imageResponse=await fetch(app.origin+'/api/project-assets/image-imports/'+imageId+'/content',{method:'PUT',headers:{...app.headers,'content-type':'application/octet-stream'},body:png});const image=await imageResponse.json();assert.equal(imageResponse.status,200,JSON.stringify(image));assert.equal(image.status,'ready');
 const imageDB=new Database(path.join(app.data,'library.sqlite'),{readonly:true});const savedImage=imageDB.prepare('SELECT path FROM assets WHERE id=?').get(image.mediaAssetId);imageDB.close();assert.deepEqual(await fs.readFile(savedImage.path),png);assert.ok(!(await fs.readdir(path.dirname(savedImage.path))).some(n=>n.startsWith('.shiguang-reference-import-')));
 const command={runId:app.record.runId,requestId:crypto.randomUUID()};
 assert.equal((await app.call('application/shutdown',command,{'x-local-token':'wrong'})).status,403);
 assert.equal((await app.call('application/shutdown',command,{origin:'http://example.invalid'})).status,403);
 assert.equal((await app.call('application/shutdown',{...command,runId:crypto.randomUUID()})).status,409);assert.equal((await app.call('stats')).status,200);
 const held=net.connect(Number(new URL(app.origin).port),'127.0.0.1');await once(held,'connect');held.write(`GET /api/stats HTTP/1.1\r\nHost: ${new URL(app.origin).host}\r\n`);t.after(()=>held.end());
 const accepted=await app.call('application/shutdown',command);assert.equal(accepted.status,202);await accepted.json();await pause(100);assert.equal(await app.readReceipt(),null,'live HTTP connection must not mint completion');held.end();
 const receipt=await until(()=>app.readReceipt(),30000);assert.equal(verifyShutdownReceipt(receipt,{libraryId:app.record.instanceId,...command},app.identity.token),true);assert.deepEqual(await app.exited,{code:0,signal:null});
 const db=new Database(path.join(app.data,'library.sqlite'),{readonly:true});assert.equal(db.prepare('SELECT name FROM media_projects WHERE id=?').get(project.id).name,'原样访达标题');db.close();
 const restarted=await startOwned(t,base);assert.notEqual(restarted.record.runId,app.record.runId);const readback=await (await restarted.call('projects')).json();assert.equal(readback.find(p=>p.id===project.id).name,'原样访达标题');
 const stopped=await promisify(execFile)(process.execPath,[path.resolve('scripts/stop-portable.mjs')],{env:{...process.env,MEDIA_DATA_DIR:restarted.data},timeout:35000,windowsHide:true});assert.match(stopped.stdout,/已正常停止/);assert.deepEqual(await restarted.exited,{code:0,signal:null});
});

test('normal database close protocol requires real Worker ACK and normal exit; missing/false ACK never terminates (no MySQL connection)',async()=>{
 for(const options of [{delay:0,ack:true},{delay:120,ack:true},{delay:0,ack:false}]){
  const {port1,port2}=new MessageChannel(),signal=new SharedArrayBuffer(4),gate=new Int32Array(signal);
  const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads');const {port,signal,delay,ack}=workerData;const gate=new Int32Array(signal);port.on('message',()=>setTimeout(()=>{port.postMessage({value:ack});Atomics.store(gate,0,1);Atomics.notify(gate,0);port.close();parentPort.close();},delay));`,{eval:true,workerData:{port:port2,signal,...options},transferList:[port2]});await once(worker,'online');const exited=once(worker,'exit');let forced=0;worker.terminate=()=>{forced++;throw Error('FORCED_EXIT_FORBIDDEN');};
  const db=Object.assign(Object.create(MysqlDatabase.prototype),{worker,port:port1,gate,closed:false});
  if(options.delay===0&&options.ack===true)await db.closeNormally({ackTimeoutMs:50,exitTimeoutMs:1000});else await assert.rejects(db.closeNormally({ackTimeoutMs:50,exitTimeoutMs:1000}));
  assert.equal((await exited)[0],0);assert.equal(forced,0);port1.close();
 }
});
