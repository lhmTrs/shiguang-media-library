import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {upgradeRenderSchemaAtStartup,renderSchemaStatus,inspectRenderSchema} from '../server/render-schema-startup.mjs';
import {validateRenderPayload} from '../server/project-renders.mjs';
const payload=()=>JSON.stringify({path:'/synthetic-only/clip.mov',offset:0,dev:'1',ino:'2',size:40,mtime:1,updatedAt:1});
async function fixture(t,{ready=false,rows=1}={}){
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-render-startup-sqlite-'))),file=path.join(dir,'library.sqlite');let db=new Database(file);db.exec('CREATE TABLE project_renders(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,payload TEXT NOT NULL'+(ready?',revision INTEGER NOT NULL DEFAULT 1':'')+')');
 for(let i=0;i<rows;i++)db.prepare('INSERT INTO project_renders(id,project_id,payload) VALUES(?,?,?)').run('timeline'+i,'project',payload());
 const lib={db,dataDir:dir};t.after(async()=>{if(db.open)db.close();if(lib.db!==db&&lib.db.open)lib.db.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,file,lib,get db(){return db;},reopen(){db.close();db=new Database(file);lib.db=db;},run(){return upgradeRenderSchemaAtStartup(lib,{validatePayload:validateRenderPayload});}};
}
for(const count of [0,2])test('SQLite legacy '+count+' rows: durable private backup, one ALTER and exact original bytes',{timeout:5000},async t=>{
 const f=await fixture(t,{rows:count}),before=f.db.prepare('SELECT * FROM project_renders ORDER BY id').all();assert.equal((await f.run()).writable,true);assert.equal(inspectRenderSchema(f.db).kind,'ready');
 const after=f.db.prepare('SELECT * FROM project_renders ORDER BY id').all();assert.deepEqual(after.map(({revision,...r})=>r),before);assert.ok(after.every(r=>r.revision===1));
 const dir=path.join(f.dir,'backups/render-schema-startup'),files=await fs.readdir(dir),backups=files.filter(x=>x.endsWith('.backup.json'));assert.equal(backups.length,1);const backup=JSON.parse(await fs.readFile(path.join(dir,backups[0]),'utf8'));assert.deepEqual(backup.rows,before);assert.equal(backup.rowCount,count);assert.equal((await fs.stat(dir)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(dir,backups[0]))).mode&0o777,0o600);
 const unchanged=await Promise.all(files.map(async name=>[name,await fs.readFile(path.join(dir,name),'utf8')]));await f.run();assert.deepEqual(await Promise.all(files.map(async name=>[name,await fs.readFile(path.join(dir,name),'utf8')])),unchanged);
});
test('qualified existing revision: zero backup writes or DDL; ordinary read stays read-only',{timeout:5000},async t=>{
 const f=await fixture(t,{ready:true}),before=await fs.readFile(f.file);assert.deepEqual(renderSchemaStatus(f.db),{writable:true,details:null});assert.equal((await f.run()).writable,true);assert.deepEqual(await fs.readFile(f.file),before);await assert.rejects(fs.access(path.join(f.dir,'backups')),e=>e.code==='ENOENT');
});
test('pre-start status and unknown shape never migrate on read',{timeout:5000},async t=>{
 const f=await fixture(t);assert.equal(renderSchemaStatus(f.db).writable,false);assert.equal(inspectRenderSchema(f.db).kind,'legacy');await assert.rejects(fs.access(path.join(f.dir,'backups')),e=>e.code==='ENOENT');
 f.db.exec('ALTER TABLE project_renders ADD COLUMN unexpected TEXT');const state=await f.run();assert.equal(state.details.renderSchemaUpgrade.reason,'unsupported_schema');assert.equal(f.db.prepare('PRAGMA table_info(project_renders)').all().some(x=>x.name==='revision'),false);
});
test('untrusted backup parent fails before ALTER without touching the link destination',{timeout:5000},async t=>{
 const f=await fixture(t),other=path.join(f.dir,'other');await fs.mkdir(other);await fs.symlink(other,path.join(f.dir,'backups'));const state=await f.run();assert.equal(state.writable,false);assert.equal(inspectRenderSchema(f.db).kind,'legacy');assert.deepEqual(await fs.readdir(other),[]);
});
test('SQLite other connection writer prevents upgrade within busy bound',{timeout:5000},async t=>{
 const f=await fixture(t),holder=new Database(f.file);holder.exec('BEGIN IMMEDIATE');try{const began=performance.now(),state=await f.run();assert.ok(performance.now()-began<2000);assert.equal(state.details.renderSchemaUpgrade.reason,'busy');assert.equal(inspectRenderSchema(f.db).kind,'legacy');}finally{holder.exec('ROLLBACK');holder.close();}
});
test('lost COMMIT observation retains prepared fence across restart even when revision exists',{timeout:5000},async t=>{
 const f=await fixture(t);const wrapped=new Proxy(f.db,{get(db,key){if(key==='exec')return sql=>{const result=db.exec(sql);if(sql==='COMMIT')throw Error('fixture lost commit observation');return result;};const value=Reflect.get(db,key,db);return typeof value==='function'?value.bind(db):value;}});f.lib.db=wrapped;
 const state=await f.run();assert.equal(state.details.renderSchemaUpgrade.state,'needs_review');assert.equal(inspectRenderSchema(wrapped).kind,'ready');f.reopen();const retry=await f.run();assert.equal(retry.writable,false);assert.equal(retry.details.renderSchemaUpgrade.state,'needs_review');
});
test('wrong existing revision constraints are refused, not altered',{timeout:5000},async t=>{
 const f=await fixture(t);f.db.exec('ALTER TABLE project_renders ADD COLUMN revision TEXT');const state=await f.run();assert.equal(state.details.renderSchemaUpgrade.reason,'unsupported_schema');assert.equal(f.db.prepare('PRAGMA table_info(project_renders)').all().find(x=>x.name==='revision').type,'TEXT');
});
test('two actual SQLite processes serialize startup and create only one backup/DDL',{timeout:10000},async t=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events');const f=await fixture(t,{rows:2});
 const moduleUrl=new URL('../server/render-schema-startup.mjs',import.meta.url).href,payloadUrl=new URL('../server/project-renders.mjs',import.meta.url).href;
 const script=`import Database from 'better-sqlite3';import {upgradeRenderSchemaAtStartup} from ${JSON.stringify(moduleUrl)};import {validateRenderPayload} from ${JSON.stringify(payloadUrl)};const db=new Database(process.argv[1]);const result=await upgradeRenderSchemaAtStartup({db,dataDir:process.argv[2]},{validatePayload:validateRenderPayload});console.log(JSON.stringify(result));db.close();if(!result.writable)process.exitCode=1;`;
 const workers=[1,2].map(()=>{const child=spawn(process.execPath,['--input-type=module','-e',script,f.file,f.dir],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',b=>text+=b);child.stderr.on('data',b=>text+=b);return {child,done:once(child,'close'),output:()=>text};});
 for(const w of workers){const [code]=await w.done;assert.equal(code,0,w.output());assert.equal(JSON.parse(w.output()).writable,true);}
 assert.equal((await fs.readdir(path.join(f.dir,'backups/render-schema-startup'))).filter(x=>x.endsWith('.backup.json')).length,1);assert.ok(f.db.prepare('SELECT revision FROM project_renders').all().every(r=>r.revision===1));
});
test('runtime DB replacement has its own read-only required state, not previous startup qualification',{timeout:5000},async t=>{
 const f=await fixture(t);assert.equal((await f.run()).writable,true);const other=new Database(path.join(f.dir,'other.sqlite'));other.exec('CREATE TABLE project_renders(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,payload TEXT NOT NULL)');f.lib.db=other;
 assert.equal(renderSchemaStatus(other).writable,false);assert.equal(inspectRenderSchema(other).kind,'legacy');assert.equal(other.prepare('PRAGMA table_info(project_renders)').all().length,3);
});
test('invalid legacy payload is preserved and refused before backup or ALTER',{timeout:5000},async t=>{
 const f=await fixture(t);f.db.prepare('UPDATE project_renders SET payload=?').run('{not-json');const state=await f.run();assert.equal(state.details.renderSchemaUpgrade.reason,'unsupported_schema');assert.equal(inspectRenderSchema(f.db).kind,'legacy');assert.equal(f.db.prepare('SELECT payload FROM project_renders').get().payload,'{not-json');
});
