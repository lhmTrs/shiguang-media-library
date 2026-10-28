// Passive ownership/registration only. No scheduler/router construction, recovery,
// default DDL, network, uploads, or ownership of the shared application DB.
import fs from 'node:fs/promises';
import { constants, lstatSync, realpathSync, openSync, writeSync, fsyncSync, fstatSync, closeSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CloudUploadBatchStore, UPLOAD_TABLES, uploadConstraints, sqlName } from './cloud-upload-batch-store.mjs';
import { AssetMerge } from './asset-merge.mjs';
import { AssetRepair } from './asset-repair.mjs';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,status=409)=>{throw Object.assign(Error(code),{code,status});};
const sizes=Object.freeze({registration:4096,before:65536});
const tableNames=Object.keys(UPLOAD_TABLES), sourceSchema=sha(UPLOAD_TABLES);
export class CloudUploadHost {
 constructor(lib,{upload,sourceId,readMaintenance,hook=async()=>{}}={}){
  this.lib=lib;this.upload=upload;this.sourceId=sourceId;this.readMaintenance=readMaintenance;this.hook=hook;
  this.db=lib.db;this.active=0;this.exclusive=false;this.closed=false;this.registration=null;this.loadCode=null;this.store=null;
  this.fieldRegistration=new FieldRegistration(this);
  this.repair=new AssetRepair(lib,{upload,batchStore:null});this.merge=new AssetMerge(lib,{upload,batchStore:null});
 }
 async init(){
  // Merely read a bounded registration; absence never creates tables or a ledger.
  try{this.base=await fs.realpath(this.lib.dataDir);this.file=path.join(this.base,'cloud-upload-host-registration.json');this.registration=await this.readRegistration();}
  catch(e){this.loadCode=e.code==='ENOENT'?null:'REGISTRATION_UNKNOWN';}
  return this;
 }
 async readRegistration(){
  const h=await fs.open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const st=await h.stat();if(!st.isFile()||st.nlink!==1||st.size>sizes.registration||(st.mode&0o077))fail('REGISTRATION_UNKNOWN');const b=Buffer.alloc(st.size);let n=0;while(n<b.length){const r=await h.read(b,n,b.length-n,n);if(!r.bytesRead)fail('REGISTRATION_UNKNOWN');n+=r.bytesRead;}const after=await h.stat(),named=await fs.lstat(this.file);if([after,named].some(v=>v.dev!==st.dev||v.ino!==st.ino||v.size!==st.size||v.mtimeMs!==st.mtimeMs||v.ctimeMs!==st.ctimeMs))fail('REGISTRATION_UNKNOWN');const v=JSON.parse(b.toString());if(!v||v.format!==1||!UUID.test(v.sourceId||'')||!UUID.test(v.generation||'')||!UUID.test(v.commandId||'')||!Number.isSafeInteger(v.version)||v.version<1||!['INIT_PENDING','READY'].includes(v.phase)||typeof v.dbIdentity!=='object'||!Number.isSafeInteger(v.dbIdentity?.dev)||!Number.isSafeInteger(v.dbIdentity?.ino)||v.schema!==sourceSchema||!(/^[a-f0-9]{64}$/).test(v.requestSha256||''))fail('REGISTRATION_UNKNOWN');return v;}finally{await h.close();}
 }
 descriptor(allowClosed=false){
  if(this.closed&&!allowClosed)fail('HOST_CLOSED',503);if(this.lib.db!==this.db)fail('STORE_BINDING_CHANGED');if(this.db.kind==='mysql')fail('MYSQL_REGISTRATION_NOT_VALIDATED');
  if(!UUID.test(this.sourceId||'')||!this.base||realpathSync(this.lib.dataDir)!==this.base)fail('STORE_BINDING_CHANGED');
  const name=this.db.name;if(typeof name!=='string'||!path.isAbsolute(name)||realpathSync(name)!==name||!name.startsWith(this.base+path.sep))fail('STORE_BINDING_CHANGED');
  const st=lstatSync(name);if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)fail('STORE_BINDING_CHANGED');return{engine:'sqlite',dev:st.dev,ino:st.ino,birthtimeMs:st.birthtimeMs};
 }
 schema(){
  const present=this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tableNames.map(()=>'?').join(',')}) ORDER BY name`).all(...tableNames);
  if(!present.length)return{state:'ABSENT',before:[]};if(present.length!==tableNames.length)fail('STORE_SCHEMA_PARTIAL');
  const before=[];let bytes=0;
  for(const table of tableNames){const def=UPLOAD_TABLES[table],cols=this.db.prepare('SELECT * FROM pragma_table_info(?) LIMIT 65').all(table);if(cols.length!==Object.keys(def.columns).length)fail('STORE_SCHEMA_MISMATCH');
   for(const [key,spec]of Object.entries(def.columns)){const col=cols.find(c=>c.name===sqlName(key));if(!col||col.type.toUpperCase()!==spec.type.toUpperCase()||!!col.notnull!==!!spec.required)fail('STORE_SCHEMA_MISMATCH');}
   const pk=cols.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);if(!same(pk,def.pk.map(sqlName)))fail('STORE_SCHEMA_MISMATCH');
   const indexes=this.db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 LIMIT 33').all(table);if(indexes.length>32)fail('STORE_SCHEMA_MISMATCH');const unique=indexes.map(i=>this.db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno LIMIT 33').all(i.name).map(c=>c.name));
   for(const keys of def.unique)if(!unique.some(v=>same(v,keys.map(sqlName))))fail('STORE_SCHEMA_MISMATCH');
   const len=this.db.prepare("SELECT length(sql) n FROM sqlite_master WHERE name=? AND type='table'").get(table);bytes+=Number(len.n);if(!Number.isSafeInteger(bytes)||bytes>32768)fail('STORE_SCHEMA_MISMATCH');const sql=this.db.prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'").get(table).sql;
   const normalized=sql.replace(/\s/g,'').toLowerCase();for(const check of uploadConstraints(table).filter(c=>c.startsWith('CHECK')))if(!normalized.includes(check.replace(/\s/g,'').toLowerCase()))fail('STORE_SCHEMA_MISMATCH');
   const rows=this.db.prepare(`SELECT COUNT(*) n FROM (SELECT 1 FROM ${table} LIMIT 129)`).get().n;
   before.push({table,sql,observedRows:rows,truncated:rows===129});
  }
  return{state:'VALID',before};
 }
 clearStore(){this.store=null;this.repair.batchStore=null;this.merge.batchStore=null;}
 async readiness(){
  const version=this.registration?.version||0;
  try{if(this.exclusive)return{ready:false,phase:'REGISTERING',version,code:'MAINTENANCE_BUSY'};if(this.loadCode)fail(this.loadCode);const identity=this.descriptor(),schema=this.schema();
   if(!this.upload?.repairInitialized||this.upload.disposing){this.clearStore();return{ready:false,phase:'UNKNOWN',version,code:'UPLOAD_STATE_UNKNOWN',canRegister:false};}
   if(!this.registration){this.clearStore();return{ready:false,phase:'NOT_REGISTERED',version,code:'STORE_NOT_REGISTERED',canRegister:true};}
   if(this.registration.phase!=='READY')fail('REGISTRATION_INIT_PENDING');if(!same(identity,this.registration.dbIdentity)||this.registration.sourceId!==this.sourceId||schema.state!=='VALID')fail('STORE_BINDING_CHANGED');
   if(!this.store)this.store=new CloudUploadBatchStore(this.db);this.repair.batchStore=this.store;this.merge.batchStore=this.store;
   return{ready:true,phase:'READY',version,code:'STORE_READY'};
  }catch(e){this.clearStore();return{ready:false,phase:'UNKNOWN',version,code:publicHostCode(e),canRegister:false};}
 }
 baseGuard(identity,lock){
  if(!same(this.descriptor(),identity))fail('STORE_BINDING_CHANGED');
  if(this.lib.locks.size!==1||!this.lib.locks.has(lock)||this.lib.workers!==0||this.lib.metadataPending.size||this.lib.metadataQueue.length||(this.lib.repairIndexReaders??0)!==0||[...this.lib.jobs.values()].some(j=>['running','queued','cancelling'].includes(j.status)))fail('HOST_BUSY',423);
 }
 async quiet(assetIds,identity,lock,guard=()=>this.baseGuard(identity,lock)){
  guard();if(!this.upload?.repairInitialized)fail('UPLOAD_STATE_UNKNOWN');
  if(this.upload.jobs.length||this.upload.busy||this.upload.controllers.size||this.upload.operations.size||this.upload.settledTasks.size)fail('BLOCKED_UPLOAD_REFERENCE');
  const proof=await this.upload.repairState(assetIds);guard();if(!proof.known||proof.state!=='idle')fail('UPLOAD_STATE_UNKNOWN');
  await this.upload.dirGuard();guard();const entries=await fs.opendir(this.upload.dir);try{guard();let count=0;for await(const e of entries){if(++count>256||e.name!=='intents.json')fail('UPLOAD_RESOURCE_UNKNOWN');guard();}}finally{await entries.close().catch(e=>{if(e.code!=='ERR_DIR_CLOSED')throw e;});}
  const maintenance=await this.readMaintenance?.();guard();if(maintenance?.known!==true||maintenance.allowed!==true)fail('MAINTENANCE_BUSY',423);
  const current=this.upload.repairDiskState(assetIds);if(!current.known||!same(current,proof))fail('UPLOAD_STATE_CHANGED');return proof;
 }
 async write(name,value,limit,guard,{exclusive=false}={}){
  const raw=Buffer.from(JSON.stringify(value)+'\n');if(raw.length>limit)fail('REGISTRATION_LIMIT');guard();const target=path.join(this.base,name),temp=exclusive?target:path.join(this.base,`.host-registration-${crypto.randomUUID()}.tmp`);const h=await fs.open(temp,'wx',0o600);try{guard();await h.writeFile(raw);guard();await h.sync();guard();}finally{await h.close();}guard();if(!exclusive){await fs.rename(temp,target);guard();}const d=await fs.open(this.base,'r');try{guard();await d.sync();guard();}finally{await d.close();}guard();
 }
 async register(input,options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>k!=='assertCurrent')||options.assertCurrent!==undefined&&typeof options.assertCurrent!=='function')fail('HOST_ASSERT_INVALID',400);
  const capability=options.assertCurrent;
  const assertCurrent=()=>{if(capability===undefined)return;const result=capability();if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});fail('HOST_ASSERT_ASYNC');}if(result!==true)fail('HOST_IDENTITY_UNKNOWN');};
  assertCurrent();
  const currentReadiness=async()=>{const value=await this.readiness();assertCurrent();return value;};
  if(!input||Object.keys(input).some(k=>!['clientCommandId','expectedVersion','assetIds'].includes(k))||!UUID.test(input.clientCommandId||'')||!Number.isSafeInteger(input.expectedVersion)||!Array.isArray(input.assetIds)||!input.assetIds.length||input.assetIds.length>50||new Set(input.assetIds).size!==input.assetIds.length||input.assetIds.some(id=>!UUID.test(id)))fail('INVALID_REQUEST',400);
  const requestSha256=sha([...input.assetIds].sort());
  if(this.registration?.phase==='READY'&&this.registration.commandId===input.clientCommandId){if(this.registration.requestSha256!==requestSha256)fail('IDEMPOTENCY_CONFLICT');return currentReadiness();}
  if(input.expectedVersion!==(this.registration?.version||0))fail('REGISTRATION_VERSION_CHANGED');if(this.registration||this.loadCode)fail(this.registration?.phase==='INIT_PENDING'?'REGISTRATION_INIT_PENDING':'REGISTRATION_UNKNOWN');
  if(this.exclusive||this.active||this.lib.locks.size)fail('HOST_BUSY',423);for(const id of input.assetIds)this.lib.asset(id);
  const identity=this.descriptor(),sourceId=this.sourceId,lock=crypto.randomUUID();this.exclusive=true;this.lib.locks.add(lock);let pending=false,proof=null;
  const guard=()=>{assertCurrent();this.baseGuard(identity,lock);if(this.sourceId!==sourceId)fail('STORE_BINDING_CHANGED');if(proof){const now=this.upload.repairDiskState(input.assetIds);if(!now.known||!same(now,proof)||this.upload.jobs.length)fail('UPLOAD_STATE_CHANGED');}};
  try{proof=await this.quiet(input.assetIds,identity,lock,guard);guard();const schema=this.schema();guard();
   if(schema.state==='VALID'){const state=new CloudUploadBatchStore(this.db).repairState(input.assetIds);if(!state.known)fail('UPLOAD_STATE_UNKNOWN');if(state.state!=='idle')fail('BLOCKED_UPLOAD_REFERENCE');}
   const generation=crypto.randomUUID(),record={format:1,sourceId:this.sourceId,dbIdentity:identity,schema:sourceSchema,generation,phase:'INIT_PENDING',version:1,commandId:input.clientCommandId,requestSha256};
   await this.hook('before-backup');guard();await this.write(`cloud-upload-store-before-${input.clientCommandId}.json`,{sourceId:this.sourceId,dbIdentity:identity,schema:schema.before,generation},sizes.before,guard,{exclusive:true});guard();
   this.registration=record;pending=true;await this.write('cloud-upload-host-registration.json',record,sizes.registration,guard);guard();
   await this.hook('before-schema');guard();await this.quiet(input.assetIds,identity,lock,guard);guard();
   if(schema.state==='ABSENT')this.db.transaction(()=>{guard();if(this.schema().state!=='ABSENT')fail('STORE_SCHEMA_CHANGED');new CloudUploadBatchStore(this.db).init();guard();})();
   if(this.schema().state!=='VALID')fail('STORE_SCHEMA_MISMATCH');await this.hook('after-schema');guard();await this.quiet(input.assetIds,identity,lock,guard);guard();
   const done={...record,phase:'READY',version:2};await this.write('cloud-upload-host-registration.json',done,sizes.registration,guard);guard();this.registration=done;this.store=new CloudUploadBatchStore(this.db);this.repair.batchStore=this.store;this.merge.batchStore=this.store;
  }catch(e){this.clearStore();if(pending){this.registration={...this.registration,phase:'INIT_PENDING',version:1};try{const bindingGuard=()=>{if(!same(this.descriptor(true),identity)||this.sourceId!==sourceId)fail('STORE_BINDING_CHANGED');};await this.write('cloud-upload-host-registration.json',this.registration,sizes.registration,bindingGuard);}catch{this.loadCode='REGISTRATION_UNKNOWN';}return{ready:false,phase:'INIT_PENDING',version:this.registration.version,code:publicHostCode(e)};}throw e;}
  finally{this.lib.locks.delete(lock);this.exclusive=false;}
  return currentReadiness();
 }
 async track(work,{maintenance=false}={}){
  if(this.closed||this.exclusive||maintenance&&this.active)fail('HOST_BUSY',423);this.active++;if(maintenance)this.exclusive=true;
  try{return await work();}finally{this.active--;if(maintenance)this.exclusive=false;}
 }
 async repairCall(method,args){
  const readiness=await this.readiness();if(['preview','confirm','recover'].includes(method)&&!readiness.ready)fail(readiness.code==='STORE_NOT_REGISTERED'?'UPLOAD_STATE_UNKNOWN':readiness.code);
  const result=await this.repair[method](...args);
  return result?.operationId?{...result,...this.repair.get(result.operationId)}:result;
 }
 async mergeCall(method,args){
  const readiness=await this.readiness();const mutation=['preview','confirm','recover'].includes(method);
  if(mutation&&!readiness.ready)fail(readiness.code==='STORE_NOT_REGISTERED'?'UPLOAD_STATE_UNKNOWN':readiness.code);
  const exclusive=['confirm','recover'].includes(method);if(exclusive&&(this.exclusive||this.active>1))fail('HOST_BUSY',423);
  if(exclusive)this.exclusive=true;
  try{
   if(mutation){const maintenance=await this.readMaintenance?.();if(maintenance?.known!==true||maintenance.allowed!==true)fail('MAINTENANCE_BUSY',423);}
   const result=await this.merge[method](...args);if(result?.operationId){const actual=this.merge.get(result.operationId);if(actual.mode!=='merge')fail('MERGE_NOT_FOUND');return{...result,...actual};}return result;
  }finally{if(exclusive)this.exclusive=false;}
 }
 async dispose(){this.closed=true;this.clearStore();return{closed:this.active===0&&!this.exclusive,unknown:this.active!==0||this.exclusive,sharedDatabaseClosed:false,sharedUploadClosed:false};}
}
export function publicHostCode(e){return /^[A-Z_]{1,64}$/.test(e?.code||'')?e.code:'HOST_UNAVAILABLE';}

// Registration receipts bind an explicit command to A's existing field domain.
// They are not another field clock or business ledger. Nothing runs at startup.
const fieldObjects=['asset_metadata_clock','asset_metadata_fields',...['note','favorite','confirmed','tags','capture'].map(f=>'sg_metadata_changed_'+f),'sg_metadata_insert','sg_metadata_delete'];
const fieldLimits=Object.freeze({attempts:32,files:128,temps:32,fileBytes:8192,totalBytes:1048576,previews:16,ttl:300000,milliseconds:10000});
export class FieldRegistration {
 constructor(host,{hook=async()=>{}}={}){this.h=host;this.hook=hook;this.previews=new Map();this.owner=null;this.uncertain=new Set();}
 exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('INVALID_REQUEST',400);}
 ids(v){if(!Array.isArray(v)||!v.length||v.length>50||new Set(v).size!==v.length||v.some(id=>!UUID.test(id)))fail('INVALID_REQUEST',400);for(const id of v)if(!this.h.db.prepare('SELECT id FROM assets WHERE id=?').get(id))fail('INVALID_REQUEST',400);return[...v].sort();}
 actor(v){if(typeof v!=='string'||!v||v.length>4096)fail('INVALID_SESSION',403);return sha(v);}
 context(){return{start:performance.now(),bytes:0,sourceId:this.h.sourceId};}
 binding(allowClosed=false){const identity=this.h.descriptor(allowClosed);if(!this.h.lib.directoryClassification)fail('METADATA_LEGACY_MODE_UNSUPPORTED');return identity;}
 check(c,identity,{allowClosed=false}={}){if(c.sourceId!==this.h.sourceId)fail('STORE_BINDING_CHANGED');if(performance.now()-c.start>fieldLimits.milliseconds||c.bytes>fieldLimits.totalBytes)fail('METADATA_REGISTRATION_LIMIT');if(!same(this.binding(allowClosed),identity))fail('METADATA_DB_CHANGED');}
 absent(){const rows=this.h.db.prepare(`SELECT name FROM sqlite_master WHERE name COLLATE NOCASE IN (${fieldObjects.map(()=>'?').join(',')}) LIMIT 10`).all(...fieldObjects);return rows.length===0;}
 syncUpload(ids,requireDisk=true){const h=this.h;if(h.registration?.phase!=='READY'||h.registration.sourceId!==h.sourceId||!same(h.registration.dbIdentity,h.descriptor())||h.schema().state!=='VALID'||!h.upload?.repairInitialized||h.upload.disposing)fail('UPLOAD_STATE_UNKNOWN');if(!h.store){h.store=new CloudUploadBatchStore(h.db);h.repair.batchStore=h.store;h.merge.batchStore=h.store;}if(h.store.db!==h.db)fail('STORE_BINDING_CHANGED');const ram=h.upload.repairMemoryState(ids),disk=h.upload.repairDiskState(ids),batch=h.store.repairState(ids,{inTransaction:!!h.db.inTransaction});if(!ram.known||!batch.known||requireDisk&&!disk.known)fail('UPLOAD_STATE_UNKNOWN');if([ram,batch,...(disk.known?[disk]:[])].some(p=>p.state!=='idle'))fail('BLOCKED_UPLOAD_REFERENCE');if(h.upload.jobs.length||h.upload.busy||h.upload.controllers.size||h.upload.operations.size||h.upload.settledTasks.size)fail('BLOCKED_UPLOAD_REFERENCE');return{ram,disk:disk.known?disk:null,batch};}
 guard(owner){const h=this.h;this.check(owner.c,owner.identity);if(this.owner!==owner||!h.exclusive||h.active!==1)fail('METADATA_OWNER_CHANGED');h.baseGuard(owner.identity,owner.lock);const proof=this.syncUpload(owner.ids,!!owner.proof);if(owner.proof&&!same(owner.proof,proof))fail('UPLOAD_STATE_CHANGED');if(owner.dir){const s=lstatSync(owner.dir.path);if(!s.isDirectory()||s.isSymbolicLink()||realpathSync(owner.dir.path)!==owner.dir.path||s.dev!==owner.dir.dev||s.ino!==owner.dir.ino||(s.mode&0o077)||typeof process.getuid==='function'&&s.uid!==process.getuid())fail('METADATA_REGISTRATION_UNKNOWN');}}
 enter(ids){const h=this.h;if(!h.exclusive||h.active!==1||this.owner||h.lib.locks.size)fail('HOST_BUSY',423);const owner={ids,identity:this.binding(),lock:crypto.randomUUID(),c:this.context(),proof:null,dir:null};this.owner=owner;h.lib.locks.add(owner.lock);try{this.guard(owner);return owner;}catch(e){this.leave(owner);throw e;}}
 leave(owner){this.h.lib.locks.delete(owner.lock);if(this.owner===owner)this.owner=null;}
 async quiet(owner){this.guard(owner);const proof=await this.h.quiet(owner.ids,owner.identity,owner.lock,()=>this.guard(owner));this.guard(owner);if(!proof.known||proof.state!=='idle')fail('UPLOAD_STATE_UNKNOWN');owner.proof=this.syncUpload(owner.ids);this.guard(owner);}
 async directory(c,identity,create=false,guard=()=>this.check(c,identity)){
  const dir=path.join(this.h.base,'asset-metadata-registration');guard();if(create){try{await fs.mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}guard();}
  let s;try{s=await fs.lstat(dir);}catch(e){if(e.code==='ENOENT'&&!create)return null;throw e;}guard();if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||typeof process.getuid==='function'&&s.uid!==process.getuid()||await fs.realpath(dir)!==dir)fail('METADATA_REGISTRATION_UNKNOWN');guard();return{path:dir,dev:s.dev,ino:s.ino};
 }
 async inventory(dir,c,guard){if(!dir)return new Map();const groups=new Map(),handle=await fs.opendir(dir.path);let count=0,temps=0;try{guard();for await(const e of handle){guard();if(++count>fieldLimits.files)fail('METADATA_REGISTRATION_LIMIT');const match=/^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.(before|receipt|proof)\.json$/.exec(e.name);const temporary=/^\.tmp-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(e.name);if((!match&&!temporary)||!e.isFile())fail('METADATA_REGISTRATION_UNKNOWN');const st=await fs.lstat(path.join(dir.path,e.name));guard();if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||(st.mode&0o077)||st.size>fieldLimits.fileBytes||typeof process.getuid==='function'&&st.uid!==process.getuid())fail('METADATA_REGISTRATION_UNKNOWN');c.bytes+=st.size;guard();if(temporary){if(++temps>fieldLimits.temps)fail('METADATA_REGISTRATION_LIMIT');continue;}const parts=groups.get(match[1])||new Set();parts.add(match[2]);groups.set(match[1],parts);if(groups.size>fieldLimits.attempts)fail('METADATA_REGISTRATION_LIMIT');}}finally{await handle.close().catch(e=>{if(e.code!=='ERR_DIR_CLOSED')throw e;});}guard();groups.files=count;groups.temps=temps;return groups;}
 seal(v){return{...v,sha256:sha(v)};}
 async read(dir,id,kind,c,guard,{optional=false}={}){
  const file=path.join(dir.path,id+'.'+kind+'.json');let h;try{h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}try{guard();const before=await h.stat();guard();if(!before.isFile()||before.nlink!==1||(before.mode&0o077)||before.size>fieldLimits.fileBytes||typeof process.getuid==='function'&&before.uid!==process.getuid())fail('METADATA_REGISTRATION_UNKNOWN');c.bytes+=before.size;guard();const b=Buffer.alloc(before.size);let n=0;while(n<b.length){const r=await h.read(b,n,b.length-n,n);guard();if(!r.bytesRead)fail('METADATA_REGISTRATION_UNKNOWN');n+=r.bytesRead;}const after=await h.stat(),named=await fs.lstat(file);guard();if([after,named].some(s=>s.dev!==before.dev||s.ino!==before.ino||s.size!==before.size||s.mtimeMs!==before.mtimeMs||s.ctimeMs!==before.ctimeMs))fail('METADATA_REGISTRATION_UNKNOWN');let value;try{value=JSON.parse(b.toString());}catch{fail('METADATA_REGISTRATION_UNKNOWN');}const{sha256,...plain}=value;if(sha(plain)!==sha256||plain.format!==1||plain.commandId!==id||plain.sourceId!==this.h.sourceId)fail('METADATA_REGISTRATION_UNKNOWN');return value;}finally{await h.close();}}
 async write(dir,id,kind,value,guard,{exclusive=false}={}){
  const data=Buffer.from(JSON.stringify(this.seal(value))+'\n');if(data.length>fieldLimits.fileBytes)fail('METADATA_REGISTRATION_LIMIT');guard();const inventory=await this.inventory(dir,this.owner.c,guard);guard();if(inventory.files>=fieldLimits.files||!exclusive&&inventory.temps>=fieldLimits.temps)fail('METADATA_REGISTRATION_LIMIT');const dest=path.join(dir.path,id+'.'+kind+'.json'),temp=exclusive?dest:path.join(dir.path,'.tmp-'+crypto.randomUUID()),h=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{guard();await h.writeFile(data);guard();await h.sync();guard();}finally{await h.close();}guard();if(!exclusive){await fs.rename(temp,dest);guard();}const d=await fs.open(dir.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await d.sync();guard();}finally{await d.close();}guard();}
 proofSync(owner,id,value){const data=Buffer.from(JSON.stringify(this.seal(value))+'\n');if(data.length>fieldLimits.fileBytes)fail('METADATA_REGISTRATION_LIMIT');const guard=()=>this.guard(owner);guard();const file=path.join(owner.dir.path,id+'.proof.json'),h=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{guard();let n=0;while(n<data.length){const wrote=writeSync(h,data,n,data.length-n);if(!wrote)fail('METADATA_REGISTRATION_UNKNOWN');n+=wrote;guard();}fsyncSync(h);guard();const s=fstatSync(h),named=lstatSync(file);if(!s.isFile()||s.nlink!==1||s.dev!==named.dev||s.ino!==named.ino||s.size!==data.length)fail('METADATA_REGISTRATION_UNKNOWN');}finally{closeSync(h);}guard();const d=openSync(owner.dir.path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(d);guard();}finally{closeSync(d);}guard();}
 async readiness(){const c=this.context(),identity=this.binding(),upload=await this.h.readiness();this.check(c,identity);const fields=this.h.lib.metadataVersions.readiness();return{instanceId:this.h.sourceId,ready:fields.ready,code:fields.code,uploadReady:upload.ready,canPreview:upload.ready&&!fields.ready&&fields.code==='METADATA_NOT_REGISTERED',objects:9,oldValuesKnown:false};}
 async preview(input,actor){this.exact(input,['assetIds','expectedVersion']);if(input.expectedVersion!==0)fail('METADATA_INVALID_REGISTRATION',400);const ids=this.ids(input.assetIds),c=this.context(),identity=this.binding(),who=this.actor(actor),upload=await this.h.readiness();this.check(c,identity);if(!upload.ready)fail('UPLOAD_STATE_UNKNOWN');if(this.h.lib.metadataVersions.readiness().code!=='METADATA_NOT_REGISTERED'||!this.absent())fail('METADATA_REGISTRATION_UNKNOWN');const guard=()=>this.check(c,identity),dir=await this.directory(c,identity),groups=await this.inventory(dir,c,guard);guard();if(groups.size>=fieldLimits.attempts||groups.temps>=fieldLimits.temps)fail('METADATA_REGISTRATION_LIMIT');for(const[id,parts]of groups){if(!parts.has('before')||!parts.has('receipt'))fail('METADATA_REGISTRATION_UNKNOWN');const state=await this.observe(id,{c,identity,dir,guard});guard();if(state.phase!=='ABORTED')fail('METADATA_REGISTRATION_UNKNOWN');}const now=Date.now();for(const[id,p]of this.previews)if(p.expiresAt<=now)this.previews.delete(id);if(this.previews.size>=fieldLimits.previews)fail('METADATA_REGISTRATION_LIMIT');const previewId=crypto.randomUUID();this.previews.set(previewId,{ids,identity,actor:who,expiresAt:now+fieldLimits.ttl});return{previewId,expiresAt:now+fieldLimits.ttl,expectedVersion:0,objects:9,oldValuesKnown:false,confirmationRequired:true,noMerge:true};}
 async observe(id,options={}){
  if(!UUID.test(id||''))fail('INVALID_REQUEST',400);const c=options.c||this.context(),identity=options.identity||this.binding(!!options.allowClosed),guard=options.guard||(()=>this.check(c,identity,{allowClosed:!!options.allowClosed})),dir=options.dir||await this.directory(c,identity,false,guard);guard();if(!dir)return{commandId:id,found:false,phase:'UNKNOWN',ready:false,code:'METADATA_COMMAND_UNKNOWN'};const receipt=await this.read(dir,id,'receipt',c,guard,{optional:true});if(!receipt)return{commandId:id,found:false,phase:'UNKNOWN',ready:false,code:'METADATA_COMMAND_UNKNOWN'};const before=await this.read(dir,id,'before',c,guard),proof=await this.read(dir,id,'proof',c,guard,{optional:true});guard();if(!same(receipt.dbIdentity,identity)||!same(before.dbIdentity,identity)||receipt.beforeSha256!==before.sha256||!Number.isSafeInteger(receipt.version)||receipt.version<1||!['PREPARED','READY','ABORTED'].includes(receipt.phase)||!UUID.test(receipt.input?.previewId||'')||receipt.input?.clientCommandId!==id||receipt.input.expectedVersion!==0||receipt.input.confirm!==true||receipt.requestSha256!==sha(receipt.input)||before.requestSha256!==receipt.requestSha256||!same(before.objects,fieldObjects)||!Array.isArray(before.assetIds)||before.assetIds.length<1||before.assetIds.length>50||new Set(before.assetIds).size!==before.assetIds.length||before.assetIds.some(v=>!UUID.test(v)))fail('METADATA_REGISTRATION_UNKNOWN');
  const fields=this.h.lib.metadataVersions.readiness(),matched=proof&&proof.beforeSha256===before.sha256&&proof.requestSha256===receipt.requestSha256&&same(proof.dbIdentity,identity)&&UUID.test(proof.domainId||'')&&fields.ready&&fields.domainId===proof.domainId&&fields.version===proof.fieldVersion&&Number.isSafeInteger(proof.initialSeq)&&proof.initialSeq===0&&fields.seq>=proof.initialSeq;
  let phase='UNKNOWN';if(matched&&receipt.phase!=='ABORTED')phase=receipt.phase==='READY'&&!this.uncertain.has(id)?'READY':'APPLIED_PENDING';else if(fields.code==='METADATA_NOT_REGISTERED'&&this.absent()&&receipt.phase!=='READY')phase=receipt.phase==='ABORTED'?'ABORTED':'PREPARED';
  return{commandId:id,found:true,phase,version:receipt.version,ready:phase==='READY',code:phase==='READY'?'METADATA_READY':phase==='APPLIED_PENDING'?'METADATA_AUDIT_PENDING':phase==='PREPARED'?'METADATA_NOT_COMMITTED':phase==='ABORTED'?'METADATA_REGISTRATION_ABORTED':'METADATA_REGISTRATION_UNKNOWN',canFinalize:phase==='APPLIED_PENDING',canAbort:phase==='PREPARED',...options.internal?{receipt,before,proof,dir}: {}};
 }
 async confirm(input,actor){this.exact(input,['previewId','clientCommandId','expectedVersion','confirm']);if(!UUID.test(input.previewId||'')||!UUID.test(input.clientCommandId||'')||input.expectedVersion!==0||input.confirm!==true)fail('INVALID_REQUEST',400);this.actor(actor);const admission=this.binding(),existing=await this.observe(input.clientCommandId,{internal:true});if(!same(this.binding(),admission))fail('METADATA_DB_CHANGED');if(existing.found){if(existing.receipt.requestSha256!==sha(input))fail('IDEMPOTENCY_CONFLICT');return this.public(existing);}const p=this.previews.get(input.previewId);if(!p||p.actor!==this.actor(actor)||p.expiresAt<=Date.now())fail('PREVIEW_EXPIRED');const owner=this.enter(p.ids);let prepared=false;try{
   if(!same(owner.identity,p.identity))fail('METADATA_DB_CHANGED');await this.quiet(owner);this.guard(owner);owner.dir=await this.directory(owner.c,owner.identity,true,()=>this.guard(owner));this.guard(owner);const groups=await this.inventory(owner.dir,owner.c,()=>this.guard(owner));this.guard(owner);if(groups.size>=fieldLimits.attempts||groups.temps>=fieldLimits.temps)fail('METADATA_REGISTRATION_LIMIT');for(const[id,parts]of groups){if(!parts.has('before')||!parts.has('receipt'))fail('METADATA_REGISTRATION_UNKNOWN');const old=await this.observe(id,{c:owner.c,identity:owner.identity,dir:owner.dir,guard:()=>this.guard(owner)});this.guard(owner);if(old.phase!=='ABORTED')fail('METADATA_REGISTRATION_UNKNOWN');}
   if(!this.absent()||this.h.lib.metadataVersions.readiness().code!=='METADATA_NOT_REGISTERED')fail('METADATA_REGISTRATION_UNKNOWN');const common={format:1,commandId:input.clientCommandId,sourceId:this.h.sourceId,dbIdentity:owner.identity,requestSha256:sha(input)},before={...common,objects:fieldObjects,assetIds:owner.ids},sealed=this.seal(before),receipt={...common,input,phase:'PREPARED',version:1,beforeSha256:sealed.sha256};await this.hook('metadata-before-backup');this.guard(owner);await this.write(owner.dir,input.clientCommandId,'before',before,()=>this.guard(owner),{exclusive:true});await this.write(owner.dir,input.clientCommandId,'receipt',receipt,()=>this.guard(owner),{exclusive:true});prepared=true;await this.hook('metadata-after-prepared');this.guard(owner);await this.quiet(owner);await this.hook('metadata-before-ddl');this.guard(owner);
   const transaction=this.h.db.transaction(()=>{this.guard(owner);if(!owner.proof)fail('UPLOAD_STATE_UNKNOWN');if(!this.absent())fail('METADATA_REGISTRATION_UNKNOWN');const ready=this.h.lib.metadataVersions.register({expectedVersion:0});this.guard(owner);if(!ready.ready||ready.seq!==0)fail('METADATA_REGISTRATION_UNKNOWN');this.proofSync(owner,input.clientCommandId,{...common,beforeSha256:sealed.sha256,domainId:ready.domainId,fieldVersion:ready.version,initialSeq:ready.seq});this.guard(owner);});transaction.immediate?transaction.immediate():transaction();await this.hook('metadata-after-ddl');this.guard(owner);await this.write(owner.dir,input.clientCommandId,'receipt',{...receipt,phase:'READY',version:2},()=>this.guard(owner));this.guard(owner);return this.public(await this.observe(input.clientCommandId,{c:owner.c,identity:owner.identity,dir:owner.dir,guard:()=>this.guard(owner)}));
  }catch(e){if(prepared){this.uncertain.add(input.clientCommandId);return{commandId:input.clientCommandId,found:true,phase:'UNKNOWN',ready:false,code:publicHostCode(e),needsQuery:true};}throw e;}finally{this.leave(owner);}}
 public(value){const{receipt,before,proof,dir,...v}=value;return v;}
 async result(id){const admission=this.binding(),value=await this.observe(id);if(!same(this.binding(),admission))fail('METADATA_DB_CHANGED');return this.public(value);}
 async finish(id,input,abort=false){this.exact(input,['expectedVersion']);if(!Number.isSafeInteger(input.expectedVersion))fail('INVALID_REQUEST',400);const admission=this.binding(),initial=await this.observe(id,{internal:true});if(!same(this.binding(),admission))fail('METADATA_DB_CHANGED');if(!initial.found)fail('METADATA_COMMAND_UNKNOWN');if(initial.version!==input.expectedVersion)fail('REGISTRATION_VERSION_CHANGED');if(abort?initial.phase!=='PREPARED':initial.phase!=='APPLIED_PENDING')fail('METADATA_REGISTRATION_UNKNOWN');const owner=this.enter(initial.before.assetIds);try{await this.quiet(owner);this.guard(owner);owner.dir=await this.directory(owner.c,owner.identity,false,()=>this.guard(owner));this.guard(owner);await this.hook('metadata-before-finalize');this.guard(owner);const current=await this.observe(id,{c:owner.c,identity:owner.identity,dir:owner.dir,guard:()=>this.guard(owner),internal:true});this.guard(owner);if(current.version!==input.expectedVersion||(abort?current.phase!=='PREPARED':current.phase!=='APPLIED_PENDING'))fail('REGISTRATION_VERSION_CHANGED');await this.write(owner.dir,id,'receipt',{...current.receipt,sha256:undefined,phase:abort?'ABORTED':'READY',version:current.version+1},()=>this.guard(owner));this.guard(owner);this.uncertain.delete(id);return this.public(await this.observe(id,{c:owner.c,identity:owner.identity,dir:owner.dir,guard:()=>this.guard(owner)}));}catch(e){this.uncertain.add(id);return{commandId:id,found:true,phase:'UNKNOWN',ready:false,code:publicHostCode(e),needsQuery:true};}finally{this.leave(owner);}}
}
