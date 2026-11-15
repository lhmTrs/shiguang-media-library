// One explicit startup boundary; ordinary init, GET and runtime DB switching never migrate.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const states=new WeakMap(),MAX_ROWS=100000,MAX_BYTES=64*1024*1024;
const digest=s=>createHash('sha256').update(s).digest('hex');
const error=(reason)=>Object.assign(Error('Render schema upgrade unavailable'),{upgradeReason:reason});
const summary=(state,reason)=>({writable:false,details:{renderSchemaUpgrade:{state,reason}}});
const ready=()=>({writable:true,details:null});
export function inspectRenderSchema(db){
 const rows=db.kind==='mysql'?db.prepare("SELECT COLUMN_NAME name,DATA_TYPE type,CHARACTER_MAXIMUM_LENGTH maxLength,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLUMN_KEY columnKey FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_renders' ORDER BY ORDINAL_POSITION").all():db.prepare('PRAGMA table_info(project_renders)').all();
 if(!rows.length)return {kind:'absent',columns:rows};
 const names=rows.map(r=>r.name).sort().join(',');
 if(!['id,payload,project_id','id,payload,project_id,revision'].includes(names))throw error('unsupported_schema');
 for(const r of rows){
  const mysql=db.kind==='mysql',notNull=mysql?r.nullable==='NO':r.notnull===1;
  if(r.name==='id'&&!(mysql?r.columnKey==='PRI'&&r.type==='varchar'&&Number(r.maxLength)===36:r.pk===1&&r.type.toUpperCase()==='TEXT'))throw error('unsupported_schema');
  if(['project_id','payload'].includes(r.name)&&((mysql?r.columnKey==='PRI':r.pk!==0)||!notNull||!(mysql?r.type===(r.name==='payload'?'longtext':'varchar')&&(r.name!=='project_id'||Number(r.maxLength)===36):r.type.toUpperCase()==='TEXT')))throw error('unsupported_schema');
  if(r.name==='revision'){
   const def=String(mysql?r.defaultValue:r.dflt_value).replace(/^\((.*)\)$/,'$1').replace(/^'(.*)'$/,'$1');
   if(!notNull||def!=='1'||!(mysql?r.type==='bigint':r.type.toUpperCase()==='INTEGER'))throw error('unsupported_schema');
  }
 }
 return {kind:names.endsWith(',revision')?'ready':'legacy',columns:rows};
}
export function renderSchemaStatus(db){
 const prior=states.get(db);
 if(prior&&!prior.writable)return prior;
 try{const shape=inspectRenderSchema(db);return ['ready','absent'].includes(shape.kind)?ready():summary('required','unknown_outcome');}
 catch{return summary('failed','unsupported_schema');}
}
function currentSQLite(db,identity){
 if(db.open===false||db.name!==identity.path)throw error('unknown_outcome');
}
async function identityFor(db){
 if(db.kind==='mysql'){
  const value=db.identity||db.prepare('SELECT DATABASE() AS `database`,@@server_uuid serverUuid,CONNECTION_ID() connectionId').get();
  if(!value||typeof value.serverUuid!=='string'||typeof value.database!=='string')throw error('unknown_outcome');
  return {engine:'mysql',serverUuid:value.serverUuid,database:value.database};
 }
 if(!db.name||db.name===':memory:'||!path.isAbsolute(db.name))throw error('backup_failed');
 const st=await fs.lstat(db.name);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw error('backup_failed');
 return {engine:'sqlite',path:db.name,dev:String(st.dev),ino:String(st.ino),birthtimeMs:st.birthtimeMs};
}
async function checkIdentity(db,identity){
 if(db.kind!=='mysql')currentSQLite(db,identity);
 const now=await identityFor(db);if(JSON.stringify(now)!==JSON.stringify(identity))throw error('unknown_outcome');
}
async function directory(dataDir,create){
 const declared=path.resolve(dataDir),baseStat=await fs.lstat(declared);if(!baseStat.isDirectory()||baseStat.isSymbolicLink())throw error('backup_failed');const base=await fs.realpath(declared);
 let p=base;
 for(const name of ['backups','render-schema-startup']){
  p=path.join(p,name);if(create)try{await fs.mkdir(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  let st;try{st=await fs.lstat(p);}catch(e){if(!create&&e.code==='ENOENT')return null;throw e;}
  if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(p)!==p||name==='render-schema-startup'&&process.platform!=='win32'&&(st.mode&0o077))throw error('backup_failed');
 }
 return p;
}
async function readPrivate(file){
 const f=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const st=await f.stat();if(!st.isFile()||st.nlink!==1||st.size>MAX_BYTES||process.platform!=='win32'&&(st.mode&0o077))throw error('backup_failed');const data=await f.readFile();if(data.length!==st.size)throw error('backup_failed');return data;}
 finally{await f.close();}
}
async function syncDir(dir){if(process.platform==='win32')return;const f=await fs.open(dir,'r');try{await f.sync();}finally{await f.close();}}
async function exclusiveFile(file,bytes){
 const f=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}
 if(!Buffer.from(await readPrivate(file)).equals(Buffer.from(bytes)))throw error('backup_failed');await syncDir(path.dirname(file));
}
async function writeState(dir,key,state){
 const file=path.join(dir,key+'.json'),temp=path.join(dir,'.'+key+'-'+randomUUID()+'.tmp');
 // Only replace this identity's private state, never a link or unrelated file.
 try{const prior=JSON.parse((await readPrivate(file)).toString());if(prior.format!=='render-schema-startup-v1'||prior.key!==key)throw error('backup_failed');}catch(e){if(e.code!=='ENOENT')throw e;}
 await exclusiveFile(temp,JSON.stringify(state));await fs.rename(temp,file);await syncDir(dir);
}
async function readState(dir,key){
 if(!dir)return null;try{const v=JSON.parse((await readPrivate(path.join(dir,key+'.json'))).toString());if(v.format!=='render-schema-startup-v1'||v.key!==key||!['prepared','ready'].includes(v.state))throw error('backup_failed');return v;}catch(e){if(e.code==='ENOENT')return null;throw e;}
}
function rowsFor(db,validatePayload){
 const count=db.prepare('SELECT COUNT(*) n FROM project_renders').get().n;if(!Number.isSafeInteger(Number(count))||Number(count)>MAX_ROWS)throw error('backup_failed');
 const rows=db.prepare('SELECT id,project_id,payload FROM project_renders ORDER BY id LIMIT 100001').all();
 if(rows.length!==Number(count))throw error('verification_failed');
 for(const row of rows){if(typeof row.id!=='string'||typeof row.project_id!=='string'||typeof row.payload!=='string')throw error('unsupported_schema');try{validatePayload(JSON.parse(row.payload));}catch{throw error('unsupported_schema');}}
 const bytes=JSON.stringify(rows);if(Buffer.byteLength(bytes)>MAX_BYTES)throw error('backup_failed');return {rows,bytes};
}
function reasonFor(e){return e.upgradeReason||e.details?.renderSchemaUpgrade?.reason||(['SQLITE_BUSY','SQLITE_LOCKED','ER_LOCK_WAIT_TIMEOUT','ER_LOCK_DEADLOCK'].includes(e.code)?'busy':['EACCES','EPERM','ER_TABLEACCESS_DENIED_ERROR','ER_DBACCESS_DENIED_ERROR'].includes(e.code)?'permission_denied':'backup_failed');}
export async function upgradeRenderSchemaAtStartup(lib,{dataDir=lib.dataDir,validatePayload}={}){
 const db=lib.db,deadline=Date.now()+15000;let ddlStarted=false,identity,dir,key,prepared;
 const assertDb=()=>{if(Date.now()>deadline)throw error(ddlStarted?'unknown_outcome':'busy');if(lib.db!==db)throw error('unknown_outcome');};
 try{
  assertDb();const initial=inspectRenderSchema(db);
  // Empty/new tables remain the responsibility of ordinary init.
  identity=await identityFor(db);assertDb();key=digest(JSON.stringify(identity));dir=await directory(dataDir,false);
  const prior=await readState(dir,key);
  if(prior?.state!=='prepared'&&['ready','absent'].includes(initial.kind)){const value=ready();states.set(db,value);return value;}
  // POSIX modes are not Windows ACLs: retain the old schema until a private
  // backup can be guaranteed there. New/qualified tables need no such write.
  if(process.platform==='win32')throw error('permission_denied');
  if(typeof validatePayload!=='function')throw error('verification_failed');
  const run=async locked=>{
   if(db.kind!=='mysql'&&locked!==db||locked.kind!==db.kind&&db.kind==='mysql')throw error('unknown_outcome');assertDb();await checkIdentity(locked,identity);
   const shape=inspectRenderSchema(locked);let existing=await readState(await directory(dataDir,false),key);
   // A predecessor may be completing its durable success marker just after
   // releasing the DB lock. Observe only; never overwrite its pending fence.
   if(shape.kind==='ready'&&existing?.state==='prepared'){
    const end=Date.now()+500;while(existing?.state==='prepared'&&Date.now()<end){await new Promise(r=>setTimeout(r,10));existing=await readState(await directory(dataDir,false),key);}
   }
   if(existing?.state==='prepared')throw error('unknown_outcome');
   if(shape.kind==='ready')return;
   if(shape.kind!=='legacy')throw error('unsupported_schema');
   const before=rowsFor(locked,validatePayload);dir=await directory(dataDir,true);await checkIdentity(locked,identity);assertDb();
   const schemaObjects=db.kind==='mysql'?locked.prepare('SHOW CREATE TABLE project_renders').all():locked.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='project_renders' ORDER BY type,name").all();
   const backup={schemaObjects,connectionIdentity:db.kind==='mysql'?locked.identity:null,format:'shiguang-render-schema-startup',version:1,identity,columns:shape.columns,rowCount:before.rows.length,rows:before.rows,rowsSha256:digest(before.bytes)};
   const backupName=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID()+'.backup.json';
   const backupBytes=JSON.stringify(backup);if(Buffer.byteLength(backupBytes)>MAX_BYTES)throw error('backup_failed');
   await exclusiveFile(path.join(dir,backupName),backupBytes);
   const verified=JSON.parse((await readPrivate(path.join(dir,backupName))).toString());if(verified.rowCount!==before.rows.length||digest(JSON.stringify(verified.rows))!==backup.rowsSha256)throw error('backup_failed');
   assertDb();await checkIdentity(locked,identity);if(rowsFor(locked,validatePayload).bytes!==before.bytes||inspectRenderSchema(locked).kind!=='legacy')throw error('verification_failed');
   prepared={format:'render-schema-startup-v1',key,state:'prepared',identity,backup:backupName,rowCount:before.rows.length,rowsSha256:backup.rowsSha256};
   await writeState(dir,key,prepared);assertDb();await checkIdentity(locked,identity);
   ddlStarted=true;locked.exec(`ALTER TABLE project_renders ADD COLUMN revision ${db.kind==='mysql'?'BIGINT':'INTEGER'} NOT NULL DEFAULT 1`);
   assertDb();await checkIdentity(locked,identity);if(inspectRenderSchema(locked).kind!=='ready')throw error('verification_failed');
   const after=locked.prepare('SELECT id,project_id,payload,revision FROM project_renders ORDER BY id LIMIT 100001').all();
   if(JSON.stringify(after.map(({revision,...row})=>row))!==before.bytes||after.some(row=>Number(row.revision)!==1))throw error('verification_failed');
  };
  if(db.kind==='mysql'){
   if(typeof db.withRenderSchemaUpgradeLock!=='function')throw error('permission_denied');
   await db.withRenderSchemaUpgradeLock(run,{timeoutMs:3000});
  }else{
   const oldTimeout=db.pragma('busy_timeout',{simple:true});db.pragma('busy_timeout = 1000');let began=false;
   try{db.exec('BEGIN IMMEDIATE');began=true;await run(db);assertDb();db.exec('COMMIT');began=false;}
   catch(e){if(began)try{db.exec('ROLLBACK');}catch{e.upgradeReason='unknown_outcome';}throw e;}
   finally{db.pragma('busy_timeout = '+Number(oldTimeout));}
  }
  assertDb();await checkIdentity(db,identity);
  if(prepared)await writeState(dir,key,{...prepared,state:'ready'});
  const value=ready();states.set(db,value);return value;
 }catch(e){
  const value=summary(ddlStarted||e.renderUpgradeCleanupUnknown||e.details?.renderSchemaUpgrade?.state==='needs_review'||e.upgradeReason==='unknown_outcome'?'needs_review':'failed',ddlStarted?(e.upgradeReason==='verification_failed'?'verification_failed':'unknown_outcome'):reasonFor(e));
  states.set(db,value);return value;
 }
}
