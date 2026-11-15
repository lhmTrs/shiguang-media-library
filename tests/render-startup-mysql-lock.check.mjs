import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {ownedRenderMysql,bounded} from './render-startup-mysql-fixture.mjs';
const env=await ownedRenderMysql();
let control=await env.connect();const databases=new Set();
function database(config=env.config){const db=new MysqlDatabase(config);databases.add(db);return db;}
async function close(db){if(!databases.has(db))return;const exited=once(db.worker,'exit');db.close();await bounded(exited,5000,'worker exit unconfirmed');databases.delete(db);}
async function reset(){await control.query('DROP TABLE IF EXISTS project_renders');await control.query('CREATE TABLE project_renders(id VARCHAR(36) PRIMARY KEY,project_id VARCHAR(36) NOT NULL,payload LONGTEXT NOT NULL) ENGINE=InnoDB');await control.query("INSERT INTO project_renders VALUES('one','project','original')");}
const alter='ALTER TABLE project_renders ADD COLUMN revision BIGINT NOT NULL DEFAULT 1';
async function check(name,fn){await reset();await fn();env.inventory.checks.push(name);console.log('PASS '+name);}
try{
 await check('frozen connection; non-cooperating writes blocked before and after DDL; session restored',async()=>{
  const db=database(),outsider=await env.connect();await outsider.query('SET SESSION lock_wait_timeout=1');let escaped;
  const original=db.prepare('SELECT @@autocommit a,@@lock_wait_timeout t').get();
  await db.withRenderSchemaUpgradeLock(async locked=>{
   escaped=locked;assert.equal(locked.kind,'mysql');assert.equal(locked.identity.database,env.config.database);
   assert.throws(()=>db.prepare('SELECT 1').get(),{code:'RENDER_SCHEMA_UPGRADE_ACTIVE'});
   const before=locked.prepare('SELECT * FROM project_renders').all();
   await assert.rejects(outsider.query("UPDATE project_renders SET payload='bad'"),{code:'ER_LOCK_WAIT_TIMEOUT'});
   const backup=path.join(env.root,'synthetic-backup.json');await fs.writeFile(backup,JSON.stringify(before),{flag:'wx',mode:0o600});
   locked.exec(alter);
   await assert.rejects(outsider.query("UPDATE project_renders SET payload='bad'"),{code:'ER_LOCK_WAIT_TIMEOUT'});
   assert.deepEqual(locked.prepare('SELECT * FROM project_renders').all(),before.map(r=>({...r,revision:1})));
   assert.throws(()=>locked.exec(alter),{reason:'unsupported_schema'});
  });
  assert.throws(()=>escaped.prepare('SELECT * FROM project_renders').all(),{reason:'unknown_outcome'});
  assert.deepEqual(db.prepare('SELECT @@autocommit a,@@lock_wait_timeout t').get(),original);
  await outsider.query("UPDATE project_renders SET payload='released'");await outsider.end();await close(db);
 });
 await check('existing transaction rejected without implicit commit',async()=>{
  const db=database();db.exec('START TRANSACTION');db.prepare("UPDATE project_renders SET payload='uncommitted'").run();
  await assert.rejects(db.withRenderSchemaUpgradeLock(async()=>assert.fail('entered')),{reason:'busy'});
  db.exec('ROLLBACK');assert.equal(db.prepare('SELECT payload FROM project_renders').get().payload,'original');await close(db);
 });
 await check('backup failure preserves 3 columns and releases locks',async()=>{
  const db=database();await assert.rejects(db.withRenderSchemaUpgradeLock(async locked=>{locked.prepare('SELECT * FROM project_renders').all();throw Object.assign(Error('synthetic disk failure'),{code:'TEST_BACKUP_FAILED'});} ),{code:'TEST_BACKUP_FAILED'});
  assert.equal((await control.query("SELECT * FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='project_renders'"))[0].length,3);
  await control.query("UPDATE project_renders SET payload='writable'");await close(db);
 });
 await check('post-DDL verification failure is not rolled back or retried',async()=>{
  const db=database();await assert.rejects(db.withRenderSchemaUpgradeLock(async locked=>{locked.exec(alter);throw Object.assign(Error('synthetic verification failure'),{code:'TEST_VERIFICATION_FAILED'});} ),{code:'TEST_VERIFICATION_FAILED'});
  const [[row]]=await control.query('SELECT * FROM project_renders');assert.equal(row.payload,'original');assert.equal(row.revision,1);await close(db);
 });
 await check('table lock timeout is bounded and callback never runs',async()=>{
  const holder=await env.connect();await holder.query('SET autocommit=0');await holder.query('LOCK TABLES project_renders WRITE');
  const db=database(),start=Date.now();
  await assert.rejects(db.withRenderSchemaUpgradeLock(async()=>assert.fail('entered'),{timeoutMs:1000}),{reason:'busy'});assert.ok(Date.now()-start<3500);
  await holder.query('COMMIT');await holder.query('UNLOCK TABLES');await holder.end();assert.equal(db.prepare('SELECT @@autocommit a').get().a,1);await close(db);
 });
 await check('permission denied before DDL; no stale named lock',async()=>{
  await control.query("CREATE USER 'render_limited'@'localhost' IDENTIFIED BY ''");await control.query("GRANT SELECT,ALTER ON render_upgrade_test.* TO 'render_limited'@'localhost'");
  const db=database({...env.config,user:'render_limited'});
  await assert.rejects(db.withRenderSchemaUpgradeLock(async()=>assert.fail('entered')),{reason:'permission_denied'});await close(db);
  const good=database();await good.withRenderSchemaUpgradeLock(async locked=>locked.exec(alter));await close(good);
 });
 await check('two instances serialize and second rechecks completed schema',async()=>{
  const db=database();let peer,peerDone;
  await db.withRenderSchemaUpgradeLock(async locked=>{
   const source=`const {parentPort,workerData}=require('node:worker_threads'); (async()=>{const {MysqlDatabase}=await import(workerData.module);const db=new MysqlDatabase(workerData.config);parentPort.postMessage({ready:true});parentPort.once('message',async()=>{let altered=false;try{await db.withRenderSchemaUpgradeLock(async locked=>{const columns=locked.prepare("SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_renders'").all();if(!columns.some(c=>c.name==='revision')){locked.exec(workerData.alter);altered=true;}},{timeoutMs:3000});parentPort.postMessage({ok:true,altered});}catch(e){parentPort.postMessage({ok:false,code:e.code,reason:e.reason});}finally{db.close();parentPort.close();}});})();`;
   peer=new Worker(source,{eval:true,workerData:{module:new URL('../server/mysql-db.mjs',import.meta.url).href,config:env.config,alter}});
   peerDone=once(peer,'exit');assert.equal((await once(peer,'message'))[0].ready,true);
   const result=once(peer,'message');peer.postMessage('go');peer.result=result;
   await new Promise(r=>setTimeout(r,150));locked.exec(alter);
  });
  const [result]=await bounded(peer.result,5000,'peer lock unconfirmed');assert.deepEqual(result,{ok:true,altered:false});await bounded(peerDone,5000,'peer exit unconfirmed');await close(db);
 });
 await check('expired callback window cannot issue a late ALTER and still releases its original locks',async()=>{
  const db=database();await assert.rejects(db.withRenderSchemaUpgradeLock(async locked=>{await new Promise(r=>setTimeout(r,1050));locked.exec(alter);},{timeoutMs:1000,windowMs:1000}),{reason:'busy'});
  assert.equal((await control.query("SHOW COLUMNS FROM project_renders LIKE 'revision'"))[0].length,0);await control.query("UPDATE project_renders SET payload='unlocked'");await close(db);
 });
 await check('owned connection loss marks cleanup unknown and prevents further DB use',async()=>{
  const db=database();await assert.rejects(db.withRenderSchemaUpgradeLock(async locked=>{await control.query('KILL CONNECTION '+locked.identity.connectionId);locked.exec(alter);}),e=>e.renderUpgradeCleanupUnknown===true&&e.reason==='unknown_outcome');
  assert.throws(()=>db.prepare('SELECT 1').get(),{code:'RENDER_SCHEMA_UPGRADE_ACTIVE'});assert.equal((await control.query("SELECT * FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='project_renders'"))[0].length,3);await close(db);
 });
 console.log('MYSQL_LOCK_CHECKS_PASSED '+env.inventory.checks.length);
}finally{
 for(const db of databases)await close(db);
 await control.end();await env.close();console.log('NORMAL_EXIT_CONFIRMED '+env.root);
}
