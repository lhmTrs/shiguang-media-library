import {Library} from '../server/library.mjs';
import {startWatcher} from '../server/reconcile.mjs';
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
const sqlite=async dir=>{await fs.mkdir(dir,{recursive:true});const db=new Database(path.join(dir,'library.sqlite'));db.exec('CREATE TABLE roots(id TEXT,path TEXT);CREATE TABLE assets(id TEXT,root_id TEXT,path TEXT);CREATE TABLE owned(value TEXT);INSERT INTO owned VALUES(\'keep\')');db.close();};
test('Windows directory selection preserves the only old library, defaults new installs locally, conflicts fail without moving data',async t=>{
 const base=await temporary(t),project=path.join(base,'project'),home=path.join(base,'home'),local=path.join(base,'local'),old=path.join(project,'data'),next=path.join(local,'ShiguangMedia'),env={MEDIA_PORTABLE:'1',LOCALAPPDATA:local};
 assert.equal(dataDirectory(project,env,'win32',home),next);
 await sqlite(old);const before=await fs.readFile(path.join(old,'library.sqlite'));assert.equal(dataDirectory(project,env,'win32',home),old);
 await sqlite(next);assert.throws(()=>dataDirectory(project,env,'win32',home),{code:'DATA_DIRECTORY_CONFLICT'});
 assert.equal(dataDirectory(project,{...env,MEDIA_DATA_DIR:old},'win32',home),old);assert.deepEqual(await fs.readFile(path.join(old,'library.sqlite')),before);
 await fs.writeFile(path.join(next,'library.sqlite'),'corrupt');assert.throws(()=>dataDirectory(project,env,'win32',home),{code:'DATA_DIRECTORY_UNCONFIRMED'});
 assert.equal(dataDirectory(project,{MEDIA_PORTABLE:'1'},'darwin',home),old);
 await fs.unlink(path.join(next,'library.sqlite'));const unrelated=new Database(path.join(next,'library.sqlite'));unrelated.exec('CREATE TABLE unrelated(value TEXT)');unrelated.close();assert.throws(()=>dataDirectory(project,env,'win32',home),{code:'DATA_DIRECTORY_UNCONFIRMED'});
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
 assert.equal(record.port,port,'owned test refuses fallback or foreign ports before HTTP');assert.equal(record.url,origin);
 const readReceipt=()=>readShutdownReceipt(path.join(data,record.receiptDirectory));
 t.after(async()=>{if(!closed){const c=createShutdownClient({budgetMs:30000,readReceipt});const state=await c.stop({url:origin,libraryId:record.instanceId,runId:record.runId,requestId:crypto.randomUUID()});if(state.phase!=='CLOSED_KNOWN'){t.diagnostic('OWNED_APP_CLOSE_UNKNOWN: no forced stop');child.unref();child.stdout.unref();child.stderr.unref();}}});
 const response=await fetch(origin+'/api/session'),identity=await response.json(),cookie=response.headers.get('set-cookie').split(';')[0];const headers={cookie,origin,'x-local-token':identity.token,'content-type':'application/json'};
 const call=(route,body,extra={})=>fetch(origin+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return{data,record,origin,identity,headers,call,readReceipt,exited,output:()=>output};
}
test('Windows actual application: private identity, denied commands, 202 is not closure, real HTTP/DB drain receipt and restart readback',{skip:process.platform!=='win32',timeout:90000},async t=>{
 const base=await temporary(t),app=await startOwned(t,base);assert.equal(app.identity.platform,'win32');assert.ok(!('runId' in app.identity));assert.deepEqual(Object.keys(app.identity).sort(),['app','folderPickerAvailable','instanceId','platform','token','trashAvailable'].sort());
 assert.equal((await fetch(app.origin+'/api/application/identity')).status,401);
 const cliEnv={...process.env,MEDIA_DATA_DIR:app.data},launcher=await promisify(execFile)(process.execPath,[path.resolve('scripts/launch.mjs')],{env:cliEnv,timeout:5000,windowsHide:true});assert.equal(launcher.stdout.trim(),app.origin);
 const doctor=JSON.parse((await promisify(execFile)(process.execPath,[path.resolve('scripts/doctor.mjs'),'--json'],{env:cliEnv,timeout:15000,windowsHide:true})).stdout);assert.deepEqual(doctor.runtimeIdentity,{state:'matched',libraryId:app.record.instanceId,runId:app.record.runId});
 const recordFile=path.join(app.data,'server.json');await fs.writeFile(recordFile,JSON.stringify({...app.record,runId:crypto.randomUUID()}));await assert.rejects(promisify(execFile)(process.execPath,[path.resolve('scripts/launch.mjs')],{env:cliEnv,timeout:5000,windowsHide:true}));await fs.writeFile(recordFile,JSON.stringify(app.record));

 const quotedRoot=path.join(base,'quoted-root');await fs.mkdir(quotedRoot);const added=await app.call('roots',{path:'"'+quotedRoot+'"',kind:'sfx'});assert.equal(added.status,200,await added.clone().text());assert.equal((await added.json()).root.path,await fs.realpath(quotedRoot));
 const project=await (await app.call('projects',{name:'原样访达标题'})).json();assert.ok(project.id);

 // Actual project publication and DB readback, not just the cleanup adapter.
 const fixtureVideo=path.join(base,'synthetic.mp4');await promisify(execFile)('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=green:s=64x64:r=5:d=1','-c:v','libx264',fixtureVideo]);const video=await fs.readFile(fixtureVideo),requestId=crypto.randomUUID(),videoRoute=`project-videos/projects/${project.id}/imports`;
 const started=await app.call(videoRoute,{requestId,fileName:'验证 🎬.mp4',bytes:video.length,prompt:{mode:'none'}});assert.equal(started.status,200,await started.clone().text());
 const videoResponse=await fetch(app.origin+'/api/'+videoRoute+'/'+requestId+'/content',{method:'PUT',headers:{...app.headers,'content-type':'application/octet-stream'},body:video});const uploaded=await videoResponse.json();assert.equal(videoResponse.status,200,JSON.stringify(uploaded));assert.equal(uploaded.status,'ready');
 const probeDB=new Database(path.join(app.data,'library.sqlite'),{readonly:true});const stored=JSON.parse(probeDB.prepare('SELECT data_json FROM project_video_imports WHERE id=?').get(requestId).data_json);assert.equal(stored.stageCleanup.complete,true);await assert.rejects(fs.stat(stored.cache),{code:'ENOENT'});
 const published=JSON.parse(probeDB.prepare('SELECT data_json FROM storyboard_video_sources WHERE id=?').get(uploaded.videoId).data_json);assert.deepEqual(await fs.readFile(published.path),video);const mediaRow=probeDB.prepare('SELECT id,root_id FROM assets WHERE path=?').get(published.path),publishedRoot=probeDB.prepare('SELECT path FROM roots WHERE id=?').get(mediaRow.root_id).path;probeDB.close();const note='用户笔记访达原文';const metadata=await fetch(app.origin+'/api/assets/'+mediaRow.id,{method:'PATCH',headers:app.headers,body:JSON.stringify({note})});assert.equal(metadata.status,200);assert.equal((await metadata.json()).note,note);
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
 const manifest=JSON.parse(await fs.readFile(path.join(publishedRoot,'.shiguang','manifest.json'),'utf8'));assert.equal(manifest.entries[mediaRow.id].note,note);
 const db=new Database(path.join(app.data,'library.sqlite'),{readonly:true});assert.equal(db.prepare('SELECT name FROM media_projects WHERE id=?').get(project.id).name,'原样访达标题');db.close();
 const restarted=await startOwned(t,base);assert.notEqual(restarted.record.runId,app.record.runId);const readback=await (await restarted.call('projects')).json();assert.equal(readback.find(p=>p.id===project.id).name,'原样访达标题');
 const stopped=await promisify(execFile)(process.execPath,[path.resolve('scripts/stop-portable.mjs')],{env:{...process.env,MEDIA_DATA_DIR:restarted.data},timeout:35000,windowsHide:true});assert.match(stopped.stdout,/已正常停止/);assert.deepEqual(await restarted.exited,{code:0,signal:null});
 // Legacy share libraries retain data even when their dead run record predates runId.
 const legacy={...restarted.record};delete legacy.runId;await fs.writeFile(path.join(restarted.data,'server.json'),JSON.stringify(legacy));
 const slot=net.createServer();slot.listen(0,'127.0.0.1');await once(slot,'listening');const coldPort=slot.address().port;assert.ok(![4317,3306].includes(coldPort));await new Promise(r=>slot.close(r));
 const coldEnv={...process.env,HOME:path.join(base,'home'),USERPROFILE:path.join(base,'home'),LOCALAPPDATA:path.join(base,'home','local'),MEDIA_DATA_DIR:restarted.data,MEDIA_PERSONAL_ITEM_DIR:path.join(base,'personal'),MEDIA_UPDREAM_QUEUE_DIR:path.join(base,'empty-queue'),MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CODEX_AUTOCONNECT:'0',MEDIA_DISABLE_DESKTOP_NATIVE:'1',SHIGUANG_AUDIO_ANALYSIS:'',SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(base,'absent-release.json'),PORT:String(coldPort)};
 const cold=await promisify(execFile)(process.execPath,[path.resolve('scripts/launch.mjs')],{env:coldEnv,timeout:20000,windowsHide:true});assert.equal(cold.stdout.trim(),`http://127.0.0.1:${coldPort}`);
 const coldRecord=JSON.parse(await fs.readFile(path.join(restarted.data,'server.json'),'utf8'));assert.equal(coldRecord.port,coldPort);assert.notEqual(coldRecord.runId,restarted.record.runId);
 let coldClosed=false;t.after(async()=>{if(!coldClosed){const cleanup=await promisify(execFile)(process.execPath,[path.resolve('scripts/stop-portable.mjs')],{env:coldEnv,timeout:35000,windowsHide:true}).catch(()=>null);if(!cleanup)t.diagnostic('COLD_APP_CLOSE_UNKNOWN: retained, no forced stop');}});
 const session=await fetch(coldRecord.url+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0];const projects=await (await fetch(coldRecord.url+'/api/projects',{headers:{cookie}})).json();assert.equal(projects.find(p=>p.id===project.id).name,'原样访达标题');
 const coldStop=await promisify(execFile)(process.execPath,[path.resolve('scripts/stop-portable.mjs')],{env:coldEnv,timeout:35000,windowsHide:true});assert.match(coldStop.stdout,/已正常停止/);coldClosed=true;
 await until(async()=>{try{process.kill(coldRecord.pid,0);return false;}catch(e){if(e.code==='ESRCH')return true;throw e;}},5000);t.diagnostic('Cold launcher app: signed close receipt verified by real CLI; PID disappearance is supplementary, exit code not observed');

});

test('normal database close protocol requires real Worker ACK and normal exit; missing/false ACK never terminates (no MySQL connection)',async()=>{
 for(const options of [{delay:0,ack:true},{delay:120,ack:true},{delay:0,ack:false}]){
  const {port1,port2}=new MessageChannel(),signal=new SharedArrayBuffer(4),gate=new Int32Array(signal);
  const worker=new Worker(`const {workerData,parentPort}=require('node:worker_threads');const {port,signal,delay,ack}=workerData;const gate=new Int32Array(signal);port.on('message',()=>setTimeout(()=>{port.postMessage({value:ack});Atomics.store(gate,0,1);Atomics.notify(gate,0);port.close();parentPort.close();},delay));`,{eval:true,workerData:{port:port2,signal,...options},transferList:[port2]});await once(worker,'online');const exited=once(worker,'exit');let forced=0;worker.terminate=()=>{forced++;throw Error('FORCED_EXIT_FORBIDDEN');};
  const db=Object.assign(Object.create(MysqlDatabase.prototype),{worker,port:port1,gate,closed:false});
  if(options.delay===0&&options.ack===true)await db.closeNormally({ackTimeoutMs:50,exitTimeoutMs:1000});else await assert.rejects(db.closeNormally({ackTimeoutMs:50,exitTimeoutMs:1000}));
  worker.ref();assert.equal((await exited)[0],0);assert.equal(forced,0);port1.close();
 }
});

test('Windows actual filesystem watchers and their manifest writes close before database release',{skip:process.platform!=='win32',timeout:5000},async t=>{
 const base=await temporary(t),root=path.join(base,'root');await fs.mkdir(root);const lib=await new Library(path.join(base,'data')).init();lib.enqueue=()=>{};await lib.addRoot(root,'sfx');
 const messages=[],watcher=startWatcher(lib,{debounceMs:10,log:s=>messages.push(s)});t.after(async()=>{await watcher.close();if(lib.db.open)lib.db.close();});
 await fs.writeFile(path.join(root,'owned.wav'),'synthetic');await watcher.close();assert.equal(watcher.activeRoots,0);lib.db.close();
 const manifest=path.join(root,'.shiguang','manifest.json'),before=await fs.readFile(manifest);await fs.writeFile(path.join(root,'after-close.wav'),'still-owned');await pause(40);assert.deepEqual(await fs.readFile(manifest),before);assert.deepEqual(messages,[]);
});
