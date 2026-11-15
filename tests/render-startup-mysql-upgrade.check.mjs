// Actual socket-only MySQL, original MysqlDatabase/lock helper and startup module.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {upgradeRenderSchemaAtStartup,renderSchemaStatus} from '../server/render-schema-startup.mjs';
import {validateRenderPayload} from '../server/project-renders.mjs';
import {ownedRenderMysql,bounded} from './render-startup-mysql-fixture.mjs';
const env=await ownedRenderMysql(),control=await env.connect();let db;const payload=JSON.stringify({path:'/synthetic-only/a.mov',offset:0,dev:'1',ino:'2',size:4,mtime:1,updatedAt:1});
async function close(){if(!db)return;const exiting=once(db.worker,'exit');db.close();await bounded(exiting,5000,'owned worker exit missing');db=null;}
async function setup(name,{revision=false,rows=1}={}){await close();await control.query('DROP TABLE IF EXISTS project_renders');await control.query('CREATE TABLE project_renders(id VARCHAR(36) PRIMARY KEY,project_id VARCHAR(36) NOT NULL,payload LONGTEXT NOT NULL'+(revision?',revision BIGINT NOT NULL DEFAULT 1':'')+') ENGINE=InnoDB');for(let i=0;i<rows;i++)await control.execute('INSERT INTO project_renders(id,project_id,payload) VALUES(?,?,?)',['t'+i,'p',payload]);db=new MysqlDatabase(env.config);const prepare=db.prepare.bind(db);db.prepare=sql=>{const s=prepare(sql);for(const k of ['get','all','run']){const f=s[k];s[k]=(...args)=>{try{return f(...args);}catch(e){console.error('FIXTURE_SQL_ERROR',e.code,sql);throw e;}};}return s;};const dir=path.join(env.root,name);await fs.mkdir(dir,{mode:0o700});return {db,dataDir:dir};}
const run=lib=>upgradeRenderSchemaAtStartup(lib,{validatePayload:validateRenderPayload});
async function pass(name,fn){await fn();env.inventory.checks.push(name);console.log('PASS '+name);}
try{
 for(const count of [0,2])await pass('real startup legacy '+count+' rows durable backup and qualified column',async()=>{const lib=await setup('old'+count,{rows:count}),state=await run(lib);assert.equal(state.writable,true,JSON.stringify(state));const [after]=await control.query('SELECT * FROM project_renders ORDER BY id');assert.ok(after.every(r=>r.payload===payload&&r.revision===1));const files=await fs.readdir(path.join(lib.dataDir,'backups/render-schema-startup'));assert.equal(files.filter(f=>f.endsWith('.backup.json')).length,1);const before=files.slice();assert.equal((await run(lib)).writable,true);assert.deepEqual(await fs.readdir(path.join(lib.dataDir,'backups/render-schema-startup')),before);});
 await pass('qualified current and new empty table need no backup or ALTER',async()=>{const lib=await setup('ready',{revision:true});assert.equal((await run(lib)).writable,true);await assert.rejects(fs.access(path.join(lib.dataDir,'backups')),e=>e.code==='ENOENT');await control.query('DROP TABLE project_renders');assert.equal((await run(lib)).writable,true);await assert.rejects(fs.access(path.join(lib.dataDir,'backups')),e=>e.code==='ENOENT');});
 await pass('backup parent refuses before real MySQL ALTER',async()=>{const lib=await setup('backupfail');await fs.writeFile(path.join(lib.dataDir,'backups'),'not a directory');const state=await run(lib);assert.equal(state.writable,false);assert.equal((await control.query("SHOW COLUMNS FROM project_renders LIKE 'revision'"))[0].length,0);});
 await pass('post-DDL lost observation keeps real column and persistent needs-review across new connection',async()=>{const lib=await setup('postddl');const original=db.withRenderSchemaUpgradeLock.bind(db);db.withRenderSchemaUpgradeLock=(fn,opts)=>original(async locked=>fn({...locked,exec(sql){locked.exec(sql);throw Object.assign(Error('synthetic lost post-DDL observation'),{upgradeReason:'unknown_outcome'});}}),opts);const state=await run(lib);assert.equal(state.details.renderSchemaUpgrade.state,'needs_review');assert.equal((await control.query("SHOW COLUMNS FROM project_renders LIKE 'revision'"))[0].length,1);await close();db=new MysqlDatabase(env.config);lib.db=db;const next=await run(lib);assert.equal(next.details.renderSchemaUpgrade.state,'needs_review');assert.equal(renderSchemaStatus(db).writable,false);assert.equal((await control.query('SELECT payload FROM project_renders'))[0][0].payload,payload);});
 await pass('same database different dataDir cannot clear post-DDL pending fence',async()=>{
  const lib=await setup('crossdir-pending');const original=db.withRenderSchemaUpgradeLock.bind(db);
  db.withRenderSchemaUpgradeLock=(fn,opts)=>original(async locked=>fn({...locked,exec(sql){locked.exec(sql);throw Object.assign(Error('lost observation'),{upgradeReason:'unknown_outcome'});}}),opts);
  const first=await run(lib);assert.equal(first.details.renderSchemaUpgrade.state,'needs_review');await close();
  db=new MysqlDatabase(env.config);const other=path.join(env.root,'crossdir-other');await fs.mkdir(other,{mode:0o700});const second=await run({db,dataDir:other});
  assert.equal(second.writable,false);assert.equal(second.details.renderSchemaUpgrade.state,'needs_review');assert.equal(second.details.renderSchemaUpgrade.reason,'unknown_outcome');
  console.log('CROSS_DIRECTORY_STATES '+JSON.stringify({first,second}));
 });
 await pass('successful marked domain restarts only with matching private directory and receipt',async()=>{
  const lib=await setup('domain-success');assert.equal((await run(lib)).writable,true);await close();db=new MysqlDatabase(env.config);lib.db=db;
  assert.equal((await run(lib)).writable,true);const files=await fs.readdir(path.join(lib.dataDir,'backups/render-schema-startup'));assert.equal(files.filter(f=>f.endsWith('.backup.json')).length,1);
  const other=path.join(env.root,'domain-success-other');await fs.mkdir(other,{mode:0o700});assert.equal((await run({db,dataDir:other})).details.renderSchemaUpgrade.state,'needs_review');
  await close();db=new MysqlDatabase(env.config);lib.db=db;const dir=path.join(lib.dataDir,'backups/render-schema-startup');await fs.rename(dir,dir+'-original');await fs.mkdir(dir,{mode:0o700});for(const file of files)await fs.copyFile(path.join(dir+'-original',file),path.join(dir,file));
  assert.equal((await run(lib)).details.renderSchemaUpgrade.state,'needs_review');
 });
 await pass('marked column without its ready receipt stays needs-review',async()=>{
  const lib=await setup('missingreceipt');assert.equal((await run(lib)).writable,true);await close();db=new MysqlDatabase(env.config);lib.db=db;
  const dir=path.join(lib.dataDir,'backups/render-schema-startup');const state=(await fs.readdir(dir)).find(f=>f.endsWith('.json')&&!f.endsWith('.backup.json'));await fs.rename(path.join(dir,state),path.join(dir,state+'.retained'));
  const result=await run(lib);assert.equal(result.details.renderSchemaUpgrade.state,'needs_review');assert.equal(result.details.renderSchemaUpgrade.reason,'unknown_outcome');
 });
 await pass('marked domain with damaged ready receipt or missing backup remains needs-review',async()=>{
  const lib=await setup('damagedreceipt');assert.equal((await run(lib)).writable,true);await close();db=new MysqlDatabase(env.config);lib.db=db;
  const dir=path.join(lib.dataDir,'backups/render-schema-startup'),files=await fs.readdir(dir),file=files.find(f=>f.endsWith('.json')&&!f.endsWith('.backup.json')),receipt=await fs.readFile(path.join(dir,file));
  await fs.writeFile(path.join(dir,file),'invalid JSON');assert.equal((await run(lib)).details.renderSchemaUpgrade.state,'needs_review');
  await fs.writeFile(path.join(dir,file),receipt);await close();db=new MysqlDatabase(env.config);lib.db=db;
  const backup=files.find(f=>f.endsWith('.backup.json'));await fs.rename(path.join(dir,backup),path.join(dir,backup+'.retained'));assert.equal((await run(lib)).details.renderSchemaUpgrade.state,'needs_review');
 });
 await pass('unknown existing revision is refused without changing payload',async()=>{const lib=await setup('wrongtype');await control.query('ALTER TABLE project_renders ADD COLUMN revision TEXT');const state=await run(lib);assert.equal(state.details.renderSchemaUpgrade.reason,'unsupported_schema');assert.equal((await control.query('SELECT payload FROM project_renders'))[0][0].payload,payload);});
 await pass('permission failure on actual lock prevents ALTER',async()=>{
  const lib=await setup('permission');await control.query("CREATE USER 'startup_reader'@'localhost' IDENTIFIED BY ''");await control.query("GRANT SELECT,ALTER ON render_upgrade_test.* TO 'startup_reader'@'localhost'");await close();db=new MysqlDatabase({...env.config,user:'startup_reader'});lib.db=db;
  const state=await run(lib);assert.equal(state.details.renderSchemaUpgrade.reason,'permission_denied');assert.equal((await control.query("SHOW COLUMNS FROM project_renders LIKE 'revision'"))[0].length,0);
 });
 await pass('actual connection interruption after ALTER keeps pending state and original rows',async()=>{
  const lib=await setup('connectionloss'),killer=new MysqlDatabase(env.config),original=db.withRenderSchemaUpgradeLock.bind(db);
  db.withRenderSchemaUpgradeLock=(fn,opts)=>original(async locked=>fn({...locked,exec(sql){locked.exec(sql);killer.exec('KILL CONNECTION '+locked.identity.connectionId);}}),opts);
  try{const state=await run(lib);assert.equal(state.details.renderSchemaUpgrade.state,'needs_review');assert.equal((await control.query("SHOW COLUMNS FROM project_renders LIKE 'revision'"))[0].length,1);assert.equal((await control.query('SELECT payload FROM project_renders'))[0][0].payload,payload);assert.equal(db.prepare('SELECT @@autocommit a').get().a,1);assert.equal(db.renderSchemaMigrationReceipt.state,'closed');assert.equal(db.renderSchemaMigrationReceipt.closeAck,true);assert.equal(db.renderSchemaMigrationReceipt.workerExit,0);assert.notEqual(db.renderSchemaMigrationReceipt.businessConnectionId,db.renderSchemaMigrationReceipt.migrationConnectionId);console.log('MIGRATION_CLOSE_RECEIPT '+JSON.stringify(db.renderSchemaMigrationReceipt));}
  finally{const exit=once(killer.worker,'exit');killer.close();await bounded(exit,5000,'killer worker exit missing');}
  await close();db=new MysqlDatabase(env.config);lib.db=db;const next=await run(lib);assert.equal(next.details.renderSchemaUpgrade.state,'needs_review');
 });
 await pass('two real MySQL App adapter instances perform a single startup upgrade',async()=>{
  const {Worker}=await import('node:worker_threads');const lib=await setup('concurrent',{rows:2});
  const program="const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {MysqlDatabase}=await import(workerData.dbModule);const {upgradeRenderSchemaAtStartup}=await import(workerData.upgradeModule);const {validateRenderPayload}=await import(workerData.renderModule);const db=new MysqlDatabase(workerData.config);try{const state=await upgradeRenderSchemaAtStartup({db,dataDir:workerData.dir},{validatePayload:validateRenderPayload});parentPort.postMessage(state);}finally{db.close();parentPort.close();}})().catch(e=>{parentPort.postMessage({error:e.code||e.message});parentPort.close();process.exitCode=1;});";
  const workers=[1,2].map(()=>{const worker=new Worker(program,{eval:true,workerData:{dbModule:new URL('../server/mysql-db.mjs',import.meta.url).href,upgradeModule:new URL('../server/render-schema-startup.mjs',import.meta.url).href,renderModule:new URL('../server/project-renders.mjs',import.meta.url).href,config:env.config,dir:lib.dataDir}});return {worker,result:once(worker,'message'),exit:once(worker,'exit')};});
  for(const w of workers){const [state]=await bounded(w.result,10000,'startup instance response missing');assert.equal(state.writable,true,JSON.stringify(state));assert.deepEqual(await bounded(w.exit,5000,'startup instance exit missing'),[0]);}
  assert.equal((await fs.readdir(path.join(lib.dataDir,'backups/render-schema-startup'))).filter(x=>x.endsWith('.backup.json')).length,1);
 });
 console.log('MYSQL_STARTUP_CHECKS_PASSED '+env.inventory.checks.length);
}finally{await close();await control.end();await env.close();console.log('NORMAL_EXIT_CONFIRMED '+env.root);}
