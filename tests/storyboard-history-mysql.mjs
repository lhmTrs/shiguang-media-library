// Owned disposable native MySQL scene. No defaults, credentials or existing instance are read.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Worker} from 'node:worker_threads';
import {randomUUID,createHash} from 'node:crypto';
import mysql from 'mysql2/promise';
import {Library} from '../server/library.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'storyboard-history-mysql-')));await fs.chmod(root,0o700);
const data=path.join(root,'mysql');await fs.mkdir(data,{mode:0o700});
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const config={host:'127.0.0.1',port,user:'root',password:'',database:'storyboard_history_test'};
const checks=[];let server,control,lib,logs='',passed=false,version,workerExit=false;const peers=[];
async function bounded(p,ms,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(label)),ms))]);}finally{clearTimeout(timer);}}
const capture=child=>{child.stdout.on('data',v=>{logs+=v;});child.stderr.on('data',v=>{logs+=v;});};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const check=async(name,fn)=>{await fn();checks.push(name);console.log('PASS '+name);};
process.env.MEDIA_SKIP_IMPORT='1';process.env.MEDIA_SKIP_RECONCILE='1';process.env.MEDIA_NO_WATCH='1';process.env.MEDIA_DISABLE_DESKTOP_NATIVE='1';
try{
 const binary=process.env.STORYBOARD_HISTORY_MYSQLD||'/usr/local/mysql/bin/mysqld';
 const init=spawn(binary,['--no-defaults','--initialize-insecure','--datadir='+data],{stdio:['ignore','pipe','pipe']});capture(init);assert.equal((await bounded(once(init,'exit'),30000,'owned init timeout'))[0],0);
 server=spawn(binary,['--no-defaults','--datadir='+data,'--port='+port,'--bind-address=127.0.0.1','--socket='+path.join(root,'mysql.sock'),'--pid-file='+path.join(root,'mysql.pid'),'--mysqlx=OFF'],{stdio:['ignore','pipe','pipe']});capture(server);
 for(let i=0;i<150;i++){if(server.exitCode!==null)throw Error('owned server exited');try{control=await mysql.createConnection({socketPath:path.join(root,'mysql.sock'),user:'root',password:'',connectTimeout:500});break;}catch{await wait(100);}}
 assert.ok(control);const [[identity]]=await control.query('SELECT @@datadir datadir,@@port port,VERSION() version');assert.equal(await fs.realpath(identity.datadir),await fs.realpath(data));assert.equal(identity.port,port);assert.equal(Number((await fs.readFile(path.join(root,'mysql.pid'),'utf8')).trim()),server.pid);version=identity.version;
 const app=path.join(root,'app'),storage=await new MysqlStorage(app).init();lib=await new Library(app,{directoryClassification:true}).init();storage.attach(lib);const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),board=new StoryboardDatabase(lib,assets).init(),p=projects.save(null,{name:'合成历史项目'});
 board.initialize(p.id,{source:syntheticSource(),request_id:randomUUID(),expected_revision:null});
 await check('real SQLite-to-MySQL migration preserves all history/pending/snapshot records',async()=>{const before=board.backup();await storage.activate(config);assert.equal(lib.db.kind,'mysql');assert.deepEqual(board.backup(),before);board.init();});
 const save=(label='change')=>{const current=board.read(p.id),project=structuredClone(current.project);project.scenes[0].shots[0].action=label+randomUUID();return board.save(p.id,{project,expected_revision:current.revision,request_id:randomUUID(),change:{author:'agent',reason_text:'请调整这个镜头',reason_category:'shot_feel'}});};
 await check('MySQL document/history/pending failure injection rolls back whole save',async()=>{
  for(const table of ['storyboard_versions','storyboard_changes','storyboard_pending']){const before=board.backup().checksum;lib.db.exec(`CREATE TRIGGER fail_history BEFORE INSERT ON ${table} FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='owned history rollback'`);assert.throws(()=>save(),/owned history rollback/);assert.equal(board.backup().checksum,before);lib.db.exec('DROP TRIGGER fail_history');}
 });
 await check('MySQL pending clear respects seen revision and restore remains monotonic',async()=>{board.history.clear(p.id,{all:true,through_version:1});const v2=save(),v3=save();board.history.clear(p.id,{all:true,through_version:v2.revision});assert.ok(board.history.pending(p.id).items.every(i=>i.versions.every(v=>v>v2.revision)));const restored=board.restoreVersion(p.id,1,{expected_revision:v3.revision,request_id:randomUUID()});assert.equal(restored.revision,v3.revision+1);assert.equal(board.history.version(p.id,restored.revision).restored_from,1);});
 await check('two real concurrent MySQL connections with one expected revision only commit once',async()=>{
  const current=board.read(p.id),source=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const [{MysqlDatabase},{Projects},{ProjectAssets},{StoryboardDatabase}]=await Promise.all(workerData.modules.map(x=>import(x)));const db=new MysqlDatabase(workerData.config),lib={db,dataDir:workerData.dataDir};new Projects(lib).init();const assets=new ProjectAssets(lib).init(),board=new StoryboardDatabase(lib,assets).init();parentPort.postMessage({ready:true});parentPort.once('message',async()=>{let result;try{const p=workerData.project;p.scenes[0].shots[0].action=workerData.label;const saved=board.save(workerData.projectId,{project:p,expected_revision:workerData.revision,request_id:workerData.requestId});result={ok:true,version:saved.version};}catch(e){result={ok:false,status:e.status,code:e.code,message:e.message};}const exited=new Promise(r=>db.worker.once('exit',r));db.close();await exited;parentPort.postMessage(result);parentPort.close();});})();`;
  const modules=['../server/mysql-db.mjs','../server/projects.mjs','../server/project-assets/store.mjs','../server/storyboard/database.mjs'].map(x=>new URL(x,import.meta.url).href);
  const workers=[],exits=[];
  for(const i of [0,1]){const worker=new Worker(source,{eval:true,workerData:{modules,config,dataDir:path.join(root,'peer'+i),project:current.project,revision:current.revision,projectId:p.id,label:'peer'+i,requestId:randomUUID()}});workers.push(worker);peers.push(worker);exits.push(new Promise(resolve=>worker.once('exit',resolve)));await once(worker,'message');}
  const results=workers.map(w=>once(w,'message'));workers.forEach(w=>w.postMessage('go'));const values=(await bounded(Promise.all(results),15000,'peer saves timeout')).map(r=>r[0]);await bounded(Promise.all(exits),5000,'peer exits timeout');await fs.writeFile(path.join(root,'peer-results.json'),JSON.stringify(values));console.log('PEER_RESULTS '+JSON.stringify(values));assert.equal(values.filter(r=>r.ok).length,1);assert.equal(values.filter(r=>r.status===409).length,1);assert.equal(board.head(p.id).revision,current.revision+1);
 });
 await check('MySQL full retention limit and permanent events survive pruning; cleanup failure stays committed',async()=>{
  while(board.head(p.id).revision<50)save('retention');lib.db.exec("CREATE TRIGGER fail_prune BEFORE UPDATE ON storyboard_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='owned prune rollback'");const saved=save();assert.equal(saved.version,51);assert.equal(saved.history_cleanup,'failed');assert.equal(board.history.versions(p.id).storage.kept_full,51);lib.db.exec('DROP TRIGGER fail_prune');save();assert.equal(board.history.versions(p.id).storage.kept_full,50);assert.throws(()=>board.history.version(p.id,1),{code:'VERSION_PRUNED'});assert.equal(board.history.versions(p.id).total,52);
 });
 passed=true;
}catch(error){await fs.writeFile(path.join(root,'first-error.txt'),error.stack);await fs.writeFile(path.join(root,'mysql.log'),logs);console.error('TEST_FAILURE '+root+' '+error.stack);throw error;
}finally{
 for(const peer of peers)if(peer.threadId!==-1){await peer.terminate();}
 // Parent-owned test actors only; no server process signals or system instances.
 if(lib?.db.kind==='mysql'){const exited=once(lib.db.worker,'exit');lib.db.close();await bounded(exited,5000,'business worker exit unconfirmed');workerExit=true;}else lib?.db.close();
 if(control&&server?.exitCode===null){const exited=once(server,'exit');try{await control.query('SHUTDOWN');}catch(e){if(!['PROTOCOL_CONNECTION_LOST','ECONNRESET'].includes(e.code))throw e;}const [code,signal]=await bounded(exited,15000,'owned server exit unconfirmed');assert.equal(code,0);assert.equal(signal,null);}
 const sourceHashes=Object.fromEntries(await Promise.all(['server/storyboard/database.mjs','server/storyboard/history.mjs','server/storyboard/history-schema.mjs','server/storyboard/shared/change-diff.mjs','server/mysql.mjs','server/storyboard-generation/store.mjs','tests/storyboard-history-mysql.mjs'].map(async file=>[file,createHash('sha256').update(await fs.readFile(file)).digest('hex')])));
 await control?.end().catch(()=>{});await fs.writeFile(path.join(root,'mysql.log'),logs,{mode:0o600});await fs.writeFile(path.join(root,'evidence.json'),JSON.stringify({passed,version,checks,workerExit,serverExit:server?.exitCode,root,sourceHashes},null,2),{mode:0o600});console.log('EVIDENCE '+root);
}
