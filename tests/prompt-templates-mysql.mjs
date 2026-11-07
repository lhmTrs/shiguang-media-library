import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import {Library} from '../server/library.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {PromptTemplates} from '../server/prompt-templates/store.mjs';
import {fixture,lifecycle,orderLifecycle} from './helpers/prompt-lifecycle.mjs';

const evidence=path.resolve(process.env.PROMPT_TEST_EVIDENCE||'collab/results/PROMPT-TEMPLATES-20261104');
await fs.mkdir(evidence,{recursive:true});
const base=await fs.mkdtemp(path.join(os.tmpdir(),'prompt-mysql-'));
const data=path.join(base,'mysql');await fs.mkdir(data,{mode:0o700});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
let server,connection,lib,storage,freshDB,targetDB,logs='',passed=false,version,workerExitKnown=false;
const checks=[];const check=(name,fn)=>{const result=fn();checks.push(name);console.log('PASS '+name);return result;};
const config={host:'127.0.0.1',port,user:'root',password:'',database:'prompt_migration'};
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),ms))]);}finally{clearTimeout(timer);}}
process.env.MEDIA_SKIP_IMPORT='1';process.env.MEDIA_SKIP_RECONCILE='1';process.env.MEDIA_NO_WATCH='1';process.env.MEDIA_READONLY_FILES='1';process.env.SHIGUANG_AUDIO_ANALYSIS='0';
try{
 const binary=process.env.PROMPT_MYSQLD||'/usr/local/mysql/bin/mysqld';
 const init=spawn(binary,['--no-defaults','--initialize-insecure','--datadir='+data],{stdio:['ignore','pipe','pipe']});init.stdout.on('data',b=>logs+=b);init.stderr.on('data',b=>logs+=b);
 const [code]=await within(once(init,'exit'),30000,'MySQL initialization did not finish');assert.equal(code,0,'fresh MySQL initialization');
 server=spawn(binary,['--no-defaults','--datadir='+data,'--port='+port,'--bind-address=127.0.0.1','--socket='+path.join(base,'mysql.sock'),'--pid-file='+path.join(base,'mysql.pid'),'--mysqlx=OFF'],{stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
 for(let i=0;i<100;i++){try{connection=await mysql.createConnection({...config,database:undefined,connectTimeout:500});break;}catch{if(server.exitCode!==null)throw Error('Fresh MySQL exited');await new Promise(r=>setTimeout(r,150));}}
 assert.ok(connection,'fresh MySQL became ready');version=(await connection.query('SELECT VERSION() version'))[0][0].version;assert.match(version,/^8\.2\./);console.log('MySQL '+version);
 const appDir=path.join(base,'app');storage=await new MysqlStorage(appDir).init();lib=await new Library(appDir,{directoryClassification:true}).init();storage.attach(lib);
 // Capture the actual first SQL cause only for this wholly synthetic scene.
 const connect=storage.connect.bind(storage);storage.connect=async(...args)=>{const c=await connect(...args);for(const method of ['query','execute']){const call=c[method].bind(c);c[method]=async(...q)=>{try{return await call(...q);}catch(e){logs+='\nSYNTHETIC SQL FAILURE '+JSON.stringify({code:e.code,message:e.message,sql:q[0]});throw e;}};}return c;};
 const store=new PromptTemplates(lib).init();const sqlite=lifecycle(store);orderLifecycle(store);const before=store.snapshot();
 await storage.activate(config);
 check('Actual SQLite → MySQL migration preserves all four tables, soft-deleted data, timestamps and full history',()=>{assert.equal(lib.db.kind,'mysql');assert.deepEqual(store.snapshot(),before);assert.deepEqual(store.list().items.map(r=>r.sort_order),before.prompt_templates.filter(r=>r.deleted_at===null).sort((a,b)=>a.sort_order-b.sort_order).map(r=>r.sort_order));assert.equal(storage.state.counts.prompt_template_versions,before.prompt_template_versions.length);});
 check('MySQL lifecycle and manual order use the same store after live DB-handle switch',()=>{store.init();lifecycle(store);orderLifecycle(store);});
 const snapshot=store.backup();
 const backups=await fs.readdir(path.join(appDir,'backups'));assert.ok(backups.some(n=>n.startsWith('before-mysql-')&&n.endsWith('.sqlite')));
 check('Migrated MySQL schema retains unique version and draft constraints',()=>{const versionRow=store.snapshot().prompt_template_versions[0];assert.throws(()=>lib.db.prepare('INSERT INTO prompt_template_versions SELECT ?,template_id,version,definition,rollback_of,created_at,updated_at FROM prompt_template_versions WHERE id=?').run('11111111-1111-1111-1111-111111111111',versionRow.id),e=>e.code==='ER_DUP_ENTRY');});
 await connection.query('CREATE DATABASE prompt_fresh CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');freshDB=new MysqlDatabase({...config,database:'prompt_fresh'});
 const fresh=new PromptTemplates({db:freshDB,dataDir:path.join(base,'fresh-app')}).init();await fresh.restore(snapshot);
 check('Native MySQL schema creation and complete MySQL → MySQL restore',()=>assert.deepEqual(fresh.snapshot(),store.snapshot()));
 freshDB.exec('ALTER TABLE prompt_templates DROP COLUMN sort_order');fresh.init();
 check('Existing MySQL schema backs up before adding the nullable order column',()=>{assert.ok(fresh.list().items.every(r=>r.sort_order===null));});
 const oldBackupFiles=(await fs.readdir(path.join(base,'fresh-app','backups'))).filter(n=>n.startsWith('prompt-templates-before-order-'));assert.equal(oldBackupFiles.length,1);
 // Restore known order via the public transactional method after this deliberate old-schema fixture.
 const expectedOrder=store.list().items.map(r=>r.id),currentOrder=fresh.list().items.map(r=>r.id);fresh.reorder({ids:expectedOrder,expected_ids:currentOrder});
 const returnDir=path.join(base,'return');await fs.mkdir(returnDir);targetDB=new Database(path.join(returnDir,'library.sqlite'));const returned=new PromptTemplates({db:targetDB,dataDir:returnDir}).init();await returned.restore(fresh.backup());
 check('MySQL → fresh SQLite logical migration preserves IDs, timestamps and deleted records',()=>assert.deepEqual(returned.snapshot(),fresh.snapshot()));
 const conflict=store.get(sqlite.id);store.setDeleted(sqlite.id,false,conflict.revision);
 await assert.rejects(store.restore(snapshot),e=>e.status===409);
 const failing=fresh.create(fixture());const hash=fresh.backup().checksum;
 freshDB.exec("CREATE TRIGGER refuse_prompt_version BEFORE INSERT ON prompt_template_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic rollback'");
 assert.throws(()=>fresh.save(failing.id,{...fixture(),name:'不得保存'},1),/synthetic rollback/);assert.equal(fresh.backup().checksum,hash);
 freshDB.exec('DROP TRIGGER refuse_prompt_version');
 check('MySQL rollback leaves head/history unchanged; stale backup cannot overwrite current data',()=>assert.equal(fresh.get(failing.id).current_version,1));
 passed=true;
}catch(e){await fs.writeFile(path.join(evidence,'mysql-failure.txt'),e.stack);throw e;}
finally{
 targetDB?.close();const workers=[];
 for(const db of [freshDB,lib?.db])if(db?.kind==='mysql'){const exited=db.worker.threadId===-1?Promise.resolve():once(db.worker,'exit');db.close();workers.push(exited);}else if(db?.open)db.close();
 await within(Promise.all(workers),10000,'MySQL workers did not exit');workerExitKnown=true;await connection?.end();
 if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill('SIGTERM');await within(exited,15000,'Owned mysqld did not close');}
 const stopped=!server||server.exitCode!==null||server.signalCode!==null;
 await fs.writeFile(path.join(evidence,'mysql-server.log'),logs);
 if(passed&&stopped)await fs.rm(base,{recursive:true,force:true});
 await fs.writeFile(path.join(evidence,'mysql-result.json'),JSON.stringify({passed,version,checks,resources:{workerExitKnown,mysqldExitKnown:stopped,tempRemoved:passed&&stopped,...(!passed?{retainedEvidenceDirectory:base}:{})},scope:'Fresh isolated mysqld --no-defaults; no author database, credentials or materials.'},null,2));
}
