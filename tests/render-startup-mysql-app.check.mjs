// Opt-in: real isolated MySQL, real application HTTP startup and business writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {ownedRenderMysql,bounded} from './render-startup-mysql-fixture.mjs';
import {activateAndRestart} from './helpers/mysql-activate.mjs';

const env=await ownedRenderMysql({tcp:true});
let lib,child,exited,logs='',control;
const dataDir=path.join(env.root,'app');
try {
 const storage=await new MysqlStorage(dataDir).init();
 lib=await new Library(dataDir,{directoryClassification:true}).init();storage.attach(lib);
 const projects=new Projects(lib).init(),project=projects.save(null,{name:'故障前合成项目'}),timeline=randomUUID();
 lib.db.prepare('INSERT INTO project_timelines VALUES(?,?,?,?,?,?,?)').run(timeline,project.id,'合成时间线',JSON.stringify({fps:25,duration:2,refs:[],warnings:[]}),randomUUID(),randomUUID(),Date.now());
 const payload=JSON.stringify({schemaVersion:2,link:null,sourceId:null,offset:0,linkedTimelineRevision:null,linkedSourceRevision:null,proof:null,snapshot:null,updatedAt:1});
 lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?,?)').run(timeline,project.id,payload,1);
 ({lib}=await activateAndRestart({storage,lib,config:env.tcpConfig}));
 // The general importer emits nullable columns. Build the exact recognized
 // native legacy table in this owned synthetic target; do not loosen recognition.
 lib.db.exec('DROP TABLE project_renders');
 lib.db.exec('CREATE TABLE project_renders(id VARCHAR(36) PRIMARY KEY,project_id VARCHAR(36) NOT NULL,payload LONGTEXT NOT NULL) ENGINE=InnoDB');
 lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?)').run(timeline,project.id,payload);
 const exit=once(lib.db.worker,'exit');lib.db.close();await bounded(exit,5000,'seed worker exit unknown');lib=null;
 const hook=path.join(env.root,'startup-fault.mjs');
 await fs.writeFile(hook,`
import {MysqlDatabase} from ${JSON.stringify(new URL('../server/mysql-db.mjs',import.meta.url).href)};
const original=MysqlDatabase.prototype.withRenderSchemaUpgradeLock;
MysqlDatabase.prototype.withRenderSchemaUpgradeLock=async function(fn,opts){
 const killer=new MysqlDatabase(${JSON.stringify(env.tcpConfig)},{renderMigration:true});killer.read();
 let failed=false;
 try{return await original.call(this,locked=>fn({...locked,exec(sql){locked.exec(sql);failed=true;killer.exec('KILL CONNECTION '+locked.identity.connectionId);}}),opts);}
 finally{
  await killer.closeRenderMigration();
  console.log('OWN_MIGRATION_FAULT_RECEIPT '+JSON.stringify({faultAfterDDL:failed,...this.renderSchemaMigrationReceipt}));
 }
};
`,{mode:0o600,flag:'wx'});
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 child=spawn(process.execPath,['--import',hook,'server/index.mjs'],{cwd:process.cwd(),env:{...process.env,HOME:env.root,PATH:path.join(env.root,'no-tools'),MEDIA_DATA_DIR:dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(env.root,'personal_item'),PORT:String(port),NODE_ENV:'production',MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CLOUD_AUDIO_ENABLED:'0',SHIGUANG_CLOUD_RELEASE_CONFIG:path.join(env.root,'absent-release.json')},stdio:['ignore','pipe','pipe']});
 exited=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{if(Buffer.byteLength(logs)+b.length<=1048576)logs+=b;});
 const origin='http://127.0.0.1:'+port;let session;
 for(let i=0;i<150;i++){
  assert.equal(child.exitCode,null,logs);
  try{const response=await fetch(origin+'/api/session',{signal:AbortSignal.timeout(500)});session={cookie:response.headers.get('set-cookie').split(';')[0],...await response.json()};break;}catch{await new Promise(r=>setTimeout(r,100));}
 }
 assert.ok(session,logs);
 async function api(route,method='GET',body){const response=await fetch(origin+route,{method,headers:{cookie:session.cookie,'x-local-token':session.token,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
 const renderPath=`/api/projects/${project.id}/timelines/${timeline}/render`;
 const dto=await api(renderPath+'?schema=2');console.log('APP_RENDER_STATE '+JSON.stringify(dto.details));assert.equal(dto.writable,false);assert.equal(dto.details.renderSchemaUpgrade.state,'needs_review');assert.equal(dto.details.renderSchemaUpgrade.reason,'unknown_outcome');
 const failed=await api(renderPath,'DELETE',{requestId:randomUUID(),expectedRevision:1});assert.equal(failed.status,'failed');assert.equal(failed.error.code,'RENDER_SCHEMA_MIGRATION_REQUIRED');assert.deepEqual(await api(renderPath+'/requests/'+failed.requestId),failed);
 const created=await api('/api/projects','POST',{name:'迁移故障后仍可创建项目',note:'自有合成数据'});assert.ok(created.id);
 const renamed=await api('/api/projects/'+created.id,'PATCH',{name:'故障后修改成功',note:'受控业务写入已持久化'});assert.equal(renamed.name,'故障后修改成功');
 assert.ok((await api('/api/projects')).some(p=>p.id===created.id&&p.note==='受控业务写入已持久化'));
 control=await env.connect();await control.changeUser({database:env.tcpConfig.database});
 assert.equal((await control.query('SELECT name FROM media_projects WHERE id=?',[created.id]))[0][0].name,'故障后修改成功');
 assert.equal((await control.query('SELECT payload,revision FROM project_renders'))[0][0].payload,payload);
 const receipt=JSON.parse(logs.match(/OWN_MIGRATION_FAULT_RECEIPT (.+)/)?.[1]||'null');assert.equal(receipt?.faultAfterDDL,true);assert.equal(receipt.state,'closed');assert.equal(receipt.closeAck,true);assert.equal(receipt.workerExit,0);assert.notEqual(receipt.businessConnectionId,receipt.migrationConnectionId);
 env.inventory.checks.push('real application starts after migration connection loss; render summary and durable failed receipt; original project HTTP create/update/list remains persisted');
 console.log('PASS REAL_MYSQL_APP_DEGRADATION '+JSON.stringify(receipt));
} finally {
 if(lib){const exit=once(lib.db.worker,'exit');lib.db.close();await bounded(exit,5000,'seed final worker exit unknown');}
 if(child){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const exit=await bounded(exited,15000,'UNKNOWN: owned App did not close; retained '+env.root);await fs.writeFile(path.join(env.root,'app.log'),logs,{mode:0o600});assert.deepEqual(exit,{code:0,signal:null},logs);assert.match(logs,/APPLICATION_CLOSED_KNOWN/);env.inventory.appExit=exit;}
 await control?.end();await env.close();console.log('NORMAL_EXIT_CONFIRMED '+env.root);
}
