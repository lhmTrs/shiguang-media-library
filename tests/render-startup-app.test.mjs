import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
const bounded=async(work,ms)=>{let timer;try{return await Promise.race([work,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('OWN_APP_TIMEOUT')),ms))]);}finally{clearTimeout(timer);}};
for(const failBackup of [false,true])test('actual isolated SQLite App startup; backup failure='+failBackup,{timeout:40000},async t=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-render-startup-app-'))),dataDir=path.join(root,'data');const lib=await new Library(dataDir,{directoryClassification:true}).init(),projects=new Projects(lib).init(),project=projects.save(null,{name:'合成启动项目'}),timeline=randomUUID();
 lib.db.prepare('INSERT INTO project_timelines VALUES(?,?,?,?,?,?,?)').run(timeline,project.id,'合成时间线',JSON.stringify({fps:25,duration:2,refs:[],warnings:[]}),randomUUID(),randomUUID(),Date.now());
 lib.db.exec('ALTER TABLE project_renders DROP COLUMN revision');const payload=JSON.stringify({schemaVersion:2,link:null,sourceId:null,offset:0,linkedTimelineRevision:null,linkedSourceRevision:null,proof:null,snapshot:null,updatedAt:1});lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?)').run(timeline,project.id,payload);lib.db.close();if(failBackup)await fs.writeFile(path.join(dataDir,'backups'),'blocked');
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));let logs='';
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:process.cwd(),env:{...process.env,HOME:root,PATH:path.join(root,'no-tools'),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(root,'personal_item'),PORT:String(port),NODE_ENV:'production',MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CLOUD_AUDIO_ENABLED:'0',SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(root,'absent-release.json')},stdio:['ignore','pipe','pipe']});
 const exited=new Promise(r=>child.once('close',(code,signal)=>r({code,signal})));for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{if(Buffer.byteLength(logs)+b.length<1024*1024)logs+=b;});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const exit=await bounded(exited,15000);await fs.writeFile(path.join(root,'app.log'),logs,{mode:0o600});assert.deepEqual(exit,{code:0,signal:null});assert.match(logs,/APPLICATION_CLOSED_KNOWN/);});
 const origin='http://127.0.0.1:'+port;let session;
 for(let i=0;i<120;i++){assert.equal(child.exitCode,null,logs);try{const response=await fetch(origin+'/api/session',{signal:AbortSignal.timeout(500)});session={cookie:response.headers.get('set-cookie').split(';')[0],...await response.json()};break;}catch{await new Promise(r=>setTimeout(r,50));}}
 assert.ok(session,logs);const response=await fetch(origin+`/api/projects/${project.id}/timelines/${timeline}/render?schema=2`,{headers:{cookie:session.cookie}});assert.equal(response.status,200);const dto=await response.json();assert.equal(dto.writable,!failBackup);assert.equal(dto.link,null);assert.equal(dto.revision,1);if(failBackup)assert.equal(dto.details.renderSchemaUpgrade.reason,'backup_failed');else assert.equal(dto.details,null);
 child.kill('SIGTERM');await bounded(exited,15000);const check=await new Library(dataDir,{directoryClassification:true}).init();assert.equal(check.db.prepare('SELECT payload FROM project_renders').get().payload,payload);assert.equal(check.db.prepare('PRAGMA table_info(project_renders)').all().some(c=>c.name==='revision'),!failBackup);check.db.close();console.log('OWN_APP_EVIDENCE '+root);
});
