import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import {Library} from '../server/library.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {PromptTemplates} from '../server/prompt-templates/store.mjs';
import {CodexStore} from '../server/prompt-codex/store.mjs';
import {CodexMedia} from '../server/prompt-codex/media.mjs';
import {CodexBackup} from '../server/prompt-codex/backup.mjs';
import {fixture,inputs} from './helpers/prompt-lifecycle.mjs';

const evidence=path.resolve(process.env.CODEX_TEST_EVIDENCE||'collab/results/CODEX-PROMPT-CHAT-20261104');await fs.mkdir(evidence,{recursive:true});const base=await fs.mkdtemp(path.join(os.tmpdir(),'codex-mysql-')),data=path.join(base,'mysql');await fs.mkdir(data,{mode:0o700});
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
let server,connection,lib,nativeDB,returnDB,logs='',passed=false,version;const checks=[];
async function within(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),ms))]);}finally{clearTimeout(timer);}}
const config={host:'127.0.0.1',port,user:'root',password:'',database:'codex_migrate'};
process.env.MEDIA_SKIP_IMPORT='1';process.env.MEDIA_SKIP_RECONCILE='1';process.env.MEDIA_NO_WATCH='1';process.env.MEDIA_READONLY_FILES='1';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
function scene(owner){const prompts=new PromptTemplates(owner).init(),store=new CodexStore(owner,prompts).init(),media=new CodexMedia(owner.dataDir),backup=new CodexBackup(store,media,{tasks:new Map()});return{owner,prompts,store,media,backup};}
try{
 const binary=process.env.PROMPT_MYSQLD||'/usr/local/mysql/bin/mysqld';const init=spawn(binary,['--no-defaults','--initialize-insecure','--datadir='+data],{stdio:['ignore','pipe','pipe']});init.stdout.on('data',b=>logs+=b);init.stderr.on('data',b=>logs+=b);assert.equal((await within(once(init,'exit'),30000,'Initialization timed out'))[0],0);
 server=spawn(binary,['--no-defaults','--datadir='+data,'--port='+port,'--bind-address=127.0.0.1','--socket='+path.join(base,'mysql.sock'),'--pid-file='+path.join(base,'mysql.pid'),'--mysqlx=OFF'],{stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>logs+=b);server.stderr.on('data',b=>logs+=b);
 for(let n=0;n<100;n++){try{connection=await mysql.createConnection({...config,database:undefined,connectTimeout:500});break;}catch{if(server.exitCode!==null)throw Error('Owned mysqld exited');await new Promise(r=>setTimeout(r,150));}}
 assert.ok(connection);version=(await connection.query('SELECT VERSION() version'))[0][0].version;assert.match(version,/^8\.2\./);
 const appDir=path.join(base,'app'),storage=await new MysqlStorage(appDir).init();lib=await new Library(appDir,{directoryClassification:true}).init();storage.attach(lib);const source=scene(lib);await source.media.init();
 const template=source.prompts.create(fixture());let conversation=source.store.create({id:randomUUID(),template_id:template.id,template_revision:1,values:inputs});const turn=source.store.begin(conversation.id,{id:randomUUID(),expected_revision:1,model:'synthetic-model',effort:'high',output:'mixed',text:''}).turn;
 const image=await source.media.save(png,turn.id);source.store.addAttachment(image);source.store.updateTurn(turn.id,{blocks:[{type:'text',itemId:'text',text:'中文图文数据库验收 🧪',phase:'final_answer'},{type:'image',itemId:'image',status:'ready',attachmentId:image.id}],actual:{model:'synthetic-model',effort:'high'},usage:{total:{totalTokens:42}},status:'completed'});conversation=source.store.get(conversation.id);source.store.setDeleted(conversation.id,true,conversation.revision);
 const before=source.store.snapshot(),templateBefore=source.prompts.snapshot();
 await storage.activate(config);assert.equal(lib.db.kind,'mysql');assert.deepEqual(source.store.snapshot(),before);assert.deepEqual(source.prompts.snapshot(),templateBefore);source.store.init();checks.push('Actual SQLite → MySQL preserves all seven tables, deleted conversations, ordered image blocks and timestamps');
 const deleted=source.store.get(conversation.id);source.store.setDeleted(conversation.id,false,deleted.revision);const next=source.store.begin(conversation.id,{id:randomUUID(),expected_revision:source.store.get(conversation.id).revision,model:'synthetic-model',effort:'low',output:'text',text:'继续追问'}).turn;source.store.updateTurn(next.id,{blocks:[{type:'text',itemId:'next',text:'MySQL 中保存的新回答',phase:'final_answer'}],status:'completed'});
 assert.equal(source.store.get(conversation.id).turns.length,2);assert.throws(()=>lib.db.prepare('INSERT INTO codex_turns SELECT ?,conversation_id,sequence_no,request_json,actual_json,blocks_json,usage_json,status,error_code,created_at,updated_at FROM codex_turns WHERE id=?').run(randomUUID(),next.id),e=>e.code==='ER_DUP_ENTRY');checks.push('MySQL follow-ups, model settings, soft restore and unique conversation sequence constraint');
 const exported=await source.backup.backup();await connection.query('CREATE DATABASE codex_native CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');nativeDB=new MysqlDatabase({...config,database:'codex_native'});const native=scene({db:nativeDB,dataDir:path.join(base,'native')});await native.media.init();
 nativeDB.exec("CREATE TRIGGER refuse_codex_turn BEFORE INSERT ON codex_turns FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic codex restore rollback'");await assert.rejects(native.backup.restore(exported),/synthetic codex restore rollback/);for(const rows of Object.values(native.store.snapshot()))assert.equal(rows.length,0);assert.equal(native.prompts.snapshot().prompt_templates.length,0);assert.deepEqual(await fs.readdir(native.media.directory),[]);nativeDB.exec('DROP TRIGGER refuse_codex_turn');checks.push('Real MySQL transaction failure rolls back template and conversation rows and removes only new staged images');
 await native.backup.restore(exported);assert.deepEqual(native.store.snapshot(),source.store.snapshot());assert.deepEqual(await native.media.read(image),png);checks.push('Native MySQL schema and complete graph/image restoration');
 const returnDir=path.join(base,'return');await fs.mkdir(returnDir);returnDB=new Database(path.join(returnDir,'library.sqlite'));const returned=scene({db:returnDB,dataDir:returnDir});await returned.media.init();await returned.backup.restore(await native.backup.backup());assert.deepEqual(returned.store.snapshot(),source.store.snapshot());assert.deepEqual(returned.prompts.snapshot(),source.prompts.snapshot());assert.deepEqual(await returned.media.read(image),png);checks.push('MySQL → new SQLite full image/history roundtrip, original UUIDs and creation/update times retained');
 passed=true;for(const check of checks)console.log('PASS '+check);
}catch(e){await fs.writeFile(path.join(evidence,'mysql-failure.txt'),e.stack);throw e;}
finally{
 returnDB?.close();const workers=[];for(const db of [nativeDB,lib?.db])if(db?.kind==='mysql'){const exit=db.worker.threadId===-1?Promise.resolve():once(db.worker,'exit');db.close();workers.push(exit);}else if(db?.open)db.close();await within(Promise.all(workers),10000,'MySQL workers not closed');await connection?.end();
 if(server&&server.exitCode===null){const exit=once(server,'exit');server.kill('SIGTERM');await within(exit,15000,'Owned mysqld not closed');}const known=!server||server.exitCode!==null||server.signalCode!==null;await fs.writeFile(path.join(evidence,'mysql-server.log'),logs);if(passed&&known)await fs.rm(base,{recursive:true,force:true});await fs.writeFile(path.join(evidence,'mysql-result.json'),JSON.stringify({passed,version,checks,realModelCalls:0,resources:{workersClosedKnown:true,mysqldClosedKnown:known,tempRemoved:passed&&known,...(!passed?{retainedEvidenceDirectory:base}:{})},scope:'New isolated MySQL 8.2 server; synthetic text/image fixtures only; no author configuration or database.'},null,2));
}
