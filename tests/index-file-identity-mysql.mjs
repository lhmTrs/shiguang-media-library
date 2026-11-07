import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { Library } from '../server/library.mjs';
import { MysqlStorage } from '../server/mysql.mjs';
import { MysqlDatabase } from '../server/mysql-db.mjs';
import { Projects } from '../server/projects.mjs';
import { ProjectAssets } from '../server/project-assets/store.mjs';
import { reconcilePaths, reconcileRoot } from '../server/reconcile.mjs';

const evidence = path.resolve(process.env.CREATIVE_MYSQL_EVIDENCE || 'collab/results/MYSQL-UNSAFE-INODE-20261104/mysql'); await fs.mkdir(evidence, { recursive: true });
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creative-mysql-'))), data = path.join(base, 'mysql'); await fs.mkdir(data, { mode: 0o700 });
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
const config = { host: '127.0.0.1', port, user: 'root', password: '', database: 'creative_migration' };
let server, connection, lib, storage, freshDB, returnedDB, logs = '', version, passed = false, workersKnown = false; const checks = [];
async function bounded(p, ms, label) { let timer; try { return await Promise.race([p, new Promise((_, reject) => timer = setTimeout(() => reject(Error(label)), ms))]); } finally { clearTimeout(timer); } }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
process.env.MEDIA_SKIP_IMPORT = '1'; process.env.MEDIA_SKIP_RECONCILE = '1'; process.env.MEDIA_NO_WATCH = '1'; process.env.MEDIA_READONLY_FILES = '1'; process.env.SHIGUANG_AUDIO_ANALYSIS = '0';
const nativeStat = fs.stat;

try {
 const binary = process.env.CREATIVE_MYSQLD || '/usr/local/mysql/bin/mysqld';
 const init = spawn(binary, ['--no-defaults', '--initialize-insecure', '--datadir=' + data], { stdio: ['ignore','pipe','pipe'] }); init.stdout.on('data', b => logs += b); init.stderr.on('data', b => logs += b); assert.equal((await bounded(once(init, 'exit'), 30000, 'MySQL init timed out'))[0], 0);
 server = spawn(binary, ['--no-defaults', '--datadir=' + data, '--port=' + port, '--bind-address=127.0.0.1', '--socket=' + path.join(base, 'mysql.sock'), '--pid-file=' + path.join(base, 'mysql.pid'), '--mysqlx=OFF'], { stdio: ['ignore','pipe','pipe'] }); server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
 for (let i = 0; i < 100; i++) { try { connection = await mysql.createConnection({ ...config, database: undefined, connectTimeout: 500 }); break; } catch { if (server.exitCode !== null) throw Error('Owned mysqld exited'); await new Promise(r => setTimeout(r, 150)); } }
 assert.ok(connection); version = (await connection.query('SELECT VERSION() version'))[0][0].version; assert.match(version, /^8\.2\./); console.log('MySQL ' + version);
 const appDir = path.join(base, 'app'); storage = await new MysqlStorage(appDir).init(); lib = await new Library(appDir, { directoryClassification: true }).init(); storage.attach(lib); lib.enqueue=()=>{};
 const photoDir=path.join(base,'synthetic-images');await fs.mkdir(photoDir);
 const ordinary=path.join(photoDir,'ordinary.jpg');await fs.writeFile(ordinary,'synthetic');
 const root=await lib.addRoot(photoDir,'photo');
 async function scan(){const job=lib.scan(root.id);for(let i=0;i<300&&job.status==='running';i++)await new Promise(r=>setTimeout(r,10));assert.equal(job.status,'done',JSON.stringify(job));assert.deepEqual(job.errors,[]);}
 await scan();const oldId=lib.list().items[0].id;
 await storage.activate(config);assert.equal(lib.db.kind,'mysql');
 await check('真实MySQL复现原始BIGINT溢出且原行未改写',async()=>{
  assert.throws(()=>lib.db.prepare('UPDATE assets SET ino=? WHERE id=?').run(18446744073709550000,oldId),e=>e.errno===1264);
  assert.ok(Number.isSafeInteger(lib.asset(oldId).ino));
 });
 const a=path.join(photoDir,'unsafe-a.jpg'),b=path.join(photoDir,'unsafe-b.jpg'),huge=new Set([a,b]);await fs.writeFile(a,'synthetic-a');await fs.writeFile(b,'synthetic-b');
 fs.stat=async(...args)=>{const st=await nativeStat(...args);if(huge.has(String(args[0])))Object.defineProperty(st,'ino',{value:18446744073709550000});return st;};
 assert.equal((await fs.stat(a)).ino,18446744073709550000);
 await check('真实MySQL新增和重复扫描大编号图片，索引与正常文件同时保留',async()=>{
  await scan();await scan();assert.equal(lib.list().total,3);
  for(const file of [a,b]){const row=lib.list().items.find(r=>r.path===file);assert.equal(row.ino,null);assert.equal(row.dev,null);}
  assert.ok(Number.isSafeInteger(lib.asset(oldId).ino));
 });
 const opts={tagFiles:false,hashBudgetFiles:0,hashBudgetBytes:0,matchHashBudgetFiles:0,matchHashBudgetBytes:0};
 await check('真实MySQL全量及监听快路径均不溢出，稳态不重复写入',async()=>{
  const r=await reconcileRoot(lib,root,opts);assert.deepEqual(r.conflicts,[]);const again=await reconcileRoot(lib,root,opts);assert.equal(again.skipped,3);assert.equal(again.added,0);
  const quick=await reconcilePaths(lib,root,['unsafe-a.jpg'],opts);assert.equal(quick.touched,1);assert.equal(lib.list().total,3);
 });
 await check('相同舍入编号不误合并，未确认的改名保留原记录和元数据',async()=>{
  const before=lib.list().items.find(r=>r.path===a);lib.patch(before.id,{note:'original-metadata'});
  const renamed=path.join(photoDir,'renamed.jpg');await fs.rename(a,renamed);huge.add(renamed);
  const quick=await reconcilePaths(lib,root,['unsafe-a.jpg','renamed.jpg'],opts);assert.equal(quick.adopted,0);assert.equal(quick.needFullReconcile,true);
  const result=await reconcileRoot(lib,root,opts);assert.equal(result.added,1);assert.deepEqual(result.conflicts,[]);
  assert.equal(lib.asset(before.id).note,'original-metadata');assert.equal(lib.asset(before.id).online,0);assert.notEqual(lib.list().items.find(r=>r.path===renamed).id,before.id);
 });
 passed = true;
} catch (e) { await fs.writeFile(path.join(evidence, 'failure.txt'), e.stack); throw e; }
finally {
 fs.stat=nativeStat;
 returnedDB?.close(); const workers = [];
 for (const db of [freshDB, lib?.db]) if (db?.kind === 'mysql') { const done = db.worker.threadId === -1 ? Promise.resolve() : once(db.worker, 'exit'); db.close(); workers.push(done); } else if (db?.open) db.close();
 await bounded(Promise.all(workers), 10000, 'MySQL worker exit unknown'); workersKnown = true; await connection?.end();
 if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await bounded(done, 15000, 'Owned mysqld exit unknown'); }
 const mysqlKnown = !server || server.exitCode !== null || server.signalCode !== null; await fs.writeFile(path.join(evidence, 'mysql.log'), logs);
 await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed, version, checks, resources: { workersKnown, mysqlKnown, tempRemoved: passed && mysqlKnown, ...(!passed ? { retained: base } : {}) }, scope: 'Fresh --no-defaults isolated MySQL and synthetic library only; author service/credentials/data untouched.' }, null, 2));
 if (passed && mysqlKnown) await fs.rm(base, { recursive: true, force: true });
}
