// Explicit, bounded single-asset restore. No startup work, traversal or automatic recovery.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { AssetFingerprints } from './asset-fingerprints.mjs';
import { fingerprintRootIdentity, fingerprintFileIdentity, stableFileSha256, within, kindForExt } from './fs-identity.mjs';
import { readManifest, writeManifest, entryFromAsset, filesReadonly, validateRepairMarkers } from './fs-manifest.mjs';
import { directoryClass } from './directory-classification.mjs';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code,status=409) => { throw Object.assign(Error(code),{code,status}); };
const rootKey = r => ({id:r.id,path:r.path,kind:r.kind,revision:Number(r.revision||0),retired:Number(r.retired||0)});
const active = new Set(['queued','running','cancelling']);
export const REPAIR_LIMITS = Object.freeze({previews:16,ttl:300000,bytes:128*1024*1024,milliseconds:10000,payload:262144,roots:64});
export function initRepairJournal(db) {
 const mysql=db.kind==='mysql', id=mysql?'VARCHAR(36)':'TEXT', text=mysql?'LONGTEXT':'TEXT', hash=mysql?'CHAR(64)':'TEXT', integer=mysql?'BIGINT':'INTEGER';
 db.exec(`CREATE TABLE IF NOT EXISTS asset_repair_journal (operation_id ${id} PRIMARY KEY,idempotency_key ${hash} NOT NULL UNIQUE,canonical_asset_id ${id} NOT NULL,alias_asset_id ${id} UNIQUE,from_root_id ${id} NOT NULL,to_root_id ${id} NOT NULL,phase VARCHAR(24) NOT NULL,version ${integer} NOT NULL,input_sha256 ${hash} NOT NULL,payload ${text} NOT NULL,created_ms ${integer} NOT NULL,updated_ms ${integer} NOT NULL)${mysql?' ENGINE=InnoDB':''}`);
}
// A committed alias is read-only history; never forward old write credentials.
export function mergeAlias(lib,id) {
 if(!UUID.test(id||''))return null;
 const size=lib.db.prepare('SELECT operation_id,LENGTH(payload) n FROM asset_repair_journal WHERE alias_asset_id=?').get(id);
 if(!size)return null;if(Number(size.n)>REPAIR_LIMITS.payload)fail('MERGE_STATE_UNKNOWN');
 const row=lib.db.prepare('SELECT * FROM asset_repair_journal WHERE operation_id=?').get(size.operation_id);let p;try{p=JSON.parse(row.payload);}catch{fail('MERGE_STATE_UNKNOWN');}const {snapshotSha256,...before}=p;
 if(Buffer.byteLength(row.payload)>REPAIR_LIMITS.payload||p.format!==2||p.mode!=='merge'||!['DB_COMMITTED','MIRROR_PENDING','COMPLETE'].includes(row.phase)||p.donor?.a?.id!==id||p.source?.assetId!==row.canonical_asset_id||digest(before)!==snapshotSha256)fail('MERGE_STATE_UNKNOWN');
 return {originalId:id,canonicalAssetId:row.canonical_asset_id,operationId:row.operation_id,phase:row.phase};
}
export function assertMergeHistoryRetained(lib,{assetId=null,rootId=null}={}) {
 const clauses=[],params=[];if(assetId){clauses.push('(canonical_asset_id=? OR alias_asset_id=?)');params.push(assetId,assetId);}if(rootId){clauses.push('(from_root_id=? OR to_root_id=?)');params.push(rootId,rootId);}if(!clauses.length)fail('INVALID_SELECTION',400);
 const row=lib.db.prepare("SELECT operation_id FROM asset_repair_journal WHERE (alias_asset_id IS NOT NULL OR phase NOT IN ('COMPLETE','ABORTED')) AND ("+clauses.join(' OR ')+') LIMIT 1').get(...params);
 if(row)fail('MERGE_HISTORY_RETAINED');
}
export function repairRootState(lib,root,manifest=null) {
 try {
  const sizes=lib.db.prepare(`SELECT LENGTH(CAST(payload AS ${lib.db.kind==='mysql'?'BINARY':'BLOB'})) n FROM asset_repair_journal WHERE from_root_id=? OR to_root_id=? LIMIT 65`).all(root.id,root.id);
  if(sizes.length>64||sizes.reduce((n,r)=>n+Number(r.n),0)>1048576)return {blocked:true,code:'REPAIR_LIMIT'};
  const rows=lib.db.prepare('SELECT operation_id,canonical_asset_id,alias_asset_id,phase,payload FROM asset_repair_journal WHERE from_root_id=? OR to_root_id=? LIMIT 65').all(root.id,root.id);
  if(rows.length>64)return {blocked:true,code:'REPAIR_LIMIT'};
  const markers=manifest?.repairOperations||{};
  if(validateRepairMarkers(markers))return {blocked:true,code:'REPAIR_MARKER_INVALID'};
  for(const [id,m] of Object.entries(markers)) {
   const row=rows.find(r=>r.operation_id===id);
   if(!row||!['COMPLETE','ABORTED'].includes(row.phase))return {blocked:true,code:'REPAIR_PENDING'};
   const p=JSON.parse(row.payload),{snapshotSha256,...before}=p;
   if(snapshotSha256!==m.snapshotSha256||digest(before)!==snapshotSha256||m.assetId!==row.canonical_asset_id||m.fromRootId!==p.source?.r?.id||m.toRootId!==p.targetRoot?.id||m.targetRelativePath!==p.targetRelativePath)return {blocked:true,code:'REPAIR_STATE_CONFLICT'};
   if(p.mode==='merge'?(m.format!==2||m.mode!=='merge'||m.aliasAssetId!==p.donor?.a?.id):(m.format!==undefined||m.mode!==undefined||m.aliasAssetId!==undefined))return {blocked:true,code:'REPAIR_STATE_CONFLICT'};
   if(m.phase==='COMPLETE'&&row.phase!=='COMPLETE')return {blocked:true,code:'REPAIR_STATE_CONFLICT'};
  }
  for(const row of rows) {
   if(!['COMPLETE','ABORTED'].includes(row.phase))return {blocked:true,code:'REPAIR_PENDING'};
   if(row.phase==='COMPLETE') {
    const p=JSON.parse(row.payload);if(p.mode==='merge'){const{snapshotSha256,...before}=p;if(digest(before)!==snapshotSha256)return{blocked:true,code:'MERGE_STATE_CONFLICT'};if(p.format!==2||!UUID.test(row.alias_asset_id||'')||p.donor?.a?.id!==row.alias_asset_id||lib.db.prepare('SELECT id FROM assets WHERE id=?').get(row.alias_asset_id))return {blocked:true,code:'MERGE_STATE_CONFLICT'};if(manifest)delete manifest.entries[row.alias_asset_id];}const live=lib.db.prepare('SELECT root_id,path FROM assets WHERE id=?').get(row.canonical_asset_id);
    if(!live)return {blocked:true,code:'REPAIR_STATE_CONFLICT'};
    // COMPLETE is historical, not a permanent veto of later legitimate moves or
    // freshly established fingerprints. Always project the current owner/path.
    if(manifest&&live.root_id!==root.id)delete manifest.entries[row.canonical_asset_id];
    if(manifest&&live.root_id===root.id){const a=lib.db.prepare('SELECT * FROM assets WHERE id=?').get(row.canonical_asset_id);if(!within(root.path,a.path))return {blocked:true,code:'REPAIR_STATE_CONFLICT'};const previous=manifest.entries[a.id];manifest.entries[a.id]={...previous,...entryFromAsset({...a,rel_path:path.relative(root.path,a.path).split(path.sep).join('/')}),dev:a.dev,ino:a.ino};if(!a.sha256||previous?.fingerprintBinding?.asset?.path!==a.path){delete manifest.entries[a.id].fingerprintBinding;if(!a.sha256)delete manifest.entries[a.id].sha256;}}
   }
  }
  return {blocked:false};
 }catch{return {blocked:true,code:'REPAIR_STATE_UNKNOWN'};}
}
export class AssetRepair {
 constructor(lib,{upload=null,batchStore=null,clock=()=>Date.now(),hook=async()=>{}}={}) {
  this.lib=lib;this.upload=upload;this.batchStore=batchStore;this.clock=clock;this.hook=hook;this.previews=new Map();this.held=new Set();this.busy=false;this.transactionDepth=0;
  const proxy=Object.create(lib);proxy.locks={has:id=>lib.locks.has(id)&&!this.held.has(id)};
  this.fingerprints=new AssetFingerprints(proxy);
 }
 state(){return {start:performance.now(),controller:new AbortController(),job:{checked:0,bytesRead:0,metadataBytesRead:0,contentBytesRead:0}};}
 check(s){this.fingerprints.check(s);}
 owner(owner){if(typeof owner!=='string'||!owner||owner.length>512)fail('INVALID_SESSION',403);return digest(owner);}
 root(id){return this.fingerprints.root(id);}
 raw(id){return this.fingerprints.asset(id);}
 transaction(fn){const tx=this.lib.db.transaction(()=>{this.transactionDepth++;try{return fn();}finally{this.transactionDepth--;}});return tx.immediate?tx.immediate():tx();}
 exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail('INVALID_REQUEST',400);}
 row(id){if(!UUID.test(id||''))fail('INVALID_OPERATION',400);const size=this.lib.db.prepare('SELECT LENGTH(payload) n FROM asset_repair_journal WHERE operation_id=?').get(id);if(!size)fail('REPAIR_NOT_FOUND',404);if(Number(size.n)>REPAIR_LIMITS.payload)fail('REPAIR_STATE_UNKNOWN');const row=this.lib.db.prepare('SELECT * FROM asset_repair_journal WHERE operation_id=?').get(id);if(Buffer.byteLength(row.payload)>REPAIR_LIMITS.payload)fail('REPAIR_STATE_UNKNOWN');const data=JSON.parse(row.payload),{snapshotSha256,...snapshot}=data;if(digest(snapshot)!==snapshotSha256||data.source?.assetId!==row.canonical_asset_id||data.source?.r?.id!==row.from_root_id||data.targetRoot?.id!==row.to_root_id||!['PREPARED','DB_COMMITTED','MIRROR_PENDING','COMPLETE','ABORTED'].includes(row.phase))fail('REPAIR_STATE_UNKNOWN');if(data.mode!==undefined&&(data.mode!=='merge'||data.format!==2||!UUID.test(data.donor?.a?.id||'')||data.donor.a.id===row.canonical_asset_id||(['PREPARED','ABORTED'].includes(row.phase)?row.alias_asset_id!==null:row.alias_asset_id!==data.donor.a.id)))fail('MERGE_STATE_UNKNOWN');return {...row,data};}
 public(row){return {...(row.data.mode==='merge'?{mode:'merge',aliasAssetId:row.data.donor.a.id}:{}),operationId:row.operation_id,assetId:row.canonical_asset_id,phase:row.phase,version:Number(row.version),complete:row.phase==='COMPLETE',needsRecovery:['PREPARED','DB_COMMITTED','MIRROR_PENDING'].includes(row.phase),code:row.phase==='COMPLETE'?(row.data.mode==='merge'?'MERGED':'RESTORED'):'REPAIR_NOT_COMPLETE',inFlight:!['COMPLETE','ABORTED'].includes(row.phase)&&this.busy&&this.currentOperation===row.operation_id,targetRootId:row.to_root_id,targetRelativePath:row.data.targetRelativePath};}
 get(id){return this.public(this.row(id));}
 history(input){
  this.exact(input,['assetIds','after','limit']);const ids=input.assetIds,limit=input.limit??20,after=input.after;
  if(!Array.isArray(ids)||!ids.length||ids.length>50||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(id||''))||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('INVALID_REQUEST',400);
  if(after!==undefined&&(!after||Object.keys(after).some(k=>!['createdMs','operationId'].includes(k))||!Number.isSafeInteger(after.createdMs)||after.createdMs<0||!UUID.test(after.operationId||'')))fail('INVALID_CURSOR',400);
  const where=`(canonical_asset_id IN (${ids.map(()=>'?').join(',')}) OR alias_asset_id IN (${ids.map(()=>'?').join(',')}))`+(after?' AND (created_ms>? OR (created_ms=? AND operation_id>?))':''),params=[...ids,...ids,...(after?[after.createdMs,after.createdMs,after.operationId]:[])];
  const rows=this.lib.db.prepare(`SELECT operation_id,created_ms FROM asset_repair_journal WHERE ${where} ORDER BY created_ms,operation_id LIMIT ?`).all(...params,limit+1),page=rows.slice(0,limit),last=page.at(-1);
  return{items:page.map(r=>this.get(r.operation_id)),nextCursor:rows.length>limit?{createdMs:Number(last.created_ms),operationId:last.operation_id}:null,complete:rows.length<=limit};
 }
 resolve(input){
  this.exact(input,['assetId','previewId','commandId']);if(![input.assetId,input.previewId,input.commandId].every(id=>UUID.test(id||'')))fail('INVALID_REQUEST',400);
  // Preserve the existing confirmation hash; do not rewrite old journal keys.
  const hashes=[digest({previewId:input.previewId,commandId:input.commandId}),digest({commandId:input.commandId,previewId:input.previewId})];
  const rows=this.lib.db.prepare('SELECT operation_id FROM asset_repair_journal WHERE canonical_asset_id=? AND input_sha256 IN (?,?) LIMIT 3').all(input.assetId,...hashes);if(rows.length>1)fail('REPAIR_STATE_UNKNOWN');if(!rows.length)return{found:false,code:'RESULT_UNCONFIRMED'};return{found:true,operation:this.get(rows[0].operation_id)};
 }
 references(id){
  const tables={operations:'id,asset_id,action,source,target,status,error,created_at,undone',project_assets:'id,project_id,asset_id,status,note,source,added_at,used_at,updated_at,snapshot',project_manual_assets:'id,project_id,asset_id,payload',project_timelines:'id,project_id,name,snapshot,revision,head_id,updated_at',project_timeline_batches:'id,project_id,timeline_id,payload,status,created_at',metadata_batches:'id,created_ms,status,payload',music_analyses:'id,asset_id,cache_key,payload,created_ms'};const result={};let bytes=0;
  for(const [table,columns] of Object.entries(tables)){
   const exists=this.lib.db.kind==='mysql'?this.lib.db.prepare('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?').get(table):this.lib.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
   if(!exists){result[table]=null;continue;}
   // Bound every historical carrier; no arbitrary table/JSON/string replacements.
   const direct=['operations','project_assets','project_manual_assets','music_analyses'].includes(table),where=direct?' WHERE asset_id=?':'',params=direct?[id]:[];
   const sizeSql=columns.split(',').map(c=>`COALESCE(LENGTH(CAST(${c} AS ${this.lib.db.kind==='mysql'?'BINARY':'BLOB'})),0)`).join('+');
   const sizes=this.lib.db.prepare(`SELECT (${sizeSql}) n FROM ${table}${where} LIMIT 129`).all(...params);if(sizes.length>128)fail('REFERENCE_LIMIT');for(const row of sizes){bytes+=Number(row.n);if(!Number.isSafeInteger(bytes)||bytes>131072)fail('REFERENCE_LIMIT');}
   const rows=this.lib.db.prepare(`SELECT ${columns} FROM ${table}${where} ORDER BY id LIMIT 129`).all(...params);
   const related=(value,depth=0,key='')=>{if(depth>20)fail('REFERENCE_LIMIT');if(typeof value==='string'){if(value===id)return true;if(['snapshot','payload'].includes(key)){try{return related(JSON.parse(value),depth+1);}catch(e){if(e.code)throw e;fail('REFERENCE_UNKNOWN');}}return false;}if(Array.isArray(value))return value.some(v=>related(v,depth+1));if(value&&typeof value==='object')return Object.entries(value).some(([k,v])=>related(v,depth+1,k));return false;};
   result[table]=direct?rows:rows.filter(row=>{for(const field of ['payload','snapshot'])if(typeof row[field]==='string'){let parsed;try{parsed=JSON.parse(row[field]);}catch{fail('REFERENCE_UNKNOWN');}if(related(parsed))return true;}return false;});
  }
  return result;
 }
 syncUpload(ids,expected){
  if(!this.upload?.repairMemoryState||!this.batchStore?.repairState)fail('UPLOAD_STATE_UNKNOWN');
  const ram=this.upload.repairMemoryState(ids), batch=this.batchStore.repairState(ids,{inTransaction:this.transactionDepth>0});
  if(!ram.known||!batch.known)fail('UPLOAD_STATE_UNKNOWN');
  if(ram.state!=='idle'||batch.state!=='idle')fail('BLOCKED_UPLOAD_REFERENCE');
  if(expected&&(!same(ram,expected.ram)||!same(batch,expected.batch)))fail('UPLOAD_STATE_CHANGED');
  if(expected?.disk){const disk=this.upload.repairDiskState?.(ids);if(!disk?.known||disk.state!=='idle'||disk.version!==expected.disk.version)fail('UPLOAD_STATE_CHANGED');}
  return {ram,batch};
 }
 async uploadState(ids,s){
  const before=this.syncUpload(ids);if(!this.upload.repairState)fail('UPLOAD_STATE_UNKNOWN');
  const disk=await this.upload.repairState(ids);this.check(s);
  if(!disk.known)fail('UPLOAD_STATE_UNKNOWN');if(disk.state!=='idle')fail('BLOCKED_UPLOAD_REFERENCE');
  const after=this.syncUpload(ids,before);return {...after,disk};
 }
 guard(p,s,{references=true,own=false,committed=false}={}){
  this.check(s);const a=this.raw(p.source.assetId);
  for(const [r,key]of [[p.source.r,p.source.rootIdentity],[p.targetRoot,p.targetIdentity]]){const st=lstatSync(r.path);if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(r.path)!==r.path||`${st.dev}:${st.ino}`!==key)fail('ROOT_CHANGED');}
  try{lstatSync(p.source.a.path);fail('ORIGINAL_PRESENT');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(realpathSync(p.targetPath)!==p.targetPath||!same(fingerprintFileIdentity(lstatSync(p.targetPath)),p.targetFile))fail('TARGET_CHANGED');
  if(!committed&&!same(a,p.source.a))fail('SOURCE_CHANGED');
  if(!same(rootKey(this.root(p.source.r.id)),rootKey(p.source.r))||!same(rootKey(this.root(p.targetRoot.id)),rootKey(p.targetRoot)))fail('ROOT_CHANGED');
  if(this.lib.locks.has(a.id)&&!own||this.lib.db.prepare("SELECT id FROM operations WHERE asset_id=? AND status='pending'").get(a.id))fail('BUSY');
  if(this.lib.db.prepare("SELECT operation_id FROM asset_repair_journal WHERE canonical_asset_id=? AND phase NOT IN ('COMPLETE','ABORTED') AND operation_id<>? LIMIT 1").get(a.id,this.currentOperation||''))fail('REPAIR_PENDING');
  for(const r of [p.source.r,p.targetRoot]){if(this.lib.db.prepare("SELECT operation_id FROM asset_repair_journal WHERE (from_root_id=? OR to_root_id=?) AND phase NOT IN ('COMPLETE','ABORTED') AND operation_id<>? LIMIT 1").get(r.id,r.id,this.currentOperation||''))fail('REPAIR_PENDING');}
  if([...this.lib.jobs.values()].some(j=>active.has(j.status)))fail('BUSY');
  if(this.lib.workers!==0||this.lib.metadataPending.size>0)fail('BUSY');
  const conflict=this.lib.db.prepare('SELECT id FROM assets WHERE path=? AND id<>?').get(p.targetPath,a.id);if(conflict)fail('NEEDS_MERGE');
  if(references&&!same(this.references(a.id),p.references))fail('REFERENCES_CHANGED');
  this.syncUpload([a.id],p.upload);
  return a;
 }
 capacity(p){for(const r of [p.source.r,p.targetRoot]){const row=this.lib.db.prepare(`SELECT COUNT(*) n,COALESCE(SUM(LENGTH(CAST(payload AS ${this.lib.db.kind==='mysql'?'BINARY':'BLOB'}))),0) bytes FROM asset_repair_journal WHERE (from_root_id=? OR to_root_id=?) AND operation_id<>?`).get(r.id,r.id,this.currentOperation||'');if(Number(row.n)>=64||Number(row.bytes)+Buffer.byteLength(JSON.stringify(p))+512>1048576)fail('REPAIR_LIMIT');}}
 async source(id,s){const source=await this.fingerprints.source(s,id);if(source.state!=='missing')fail(source.code||'SOURCE_UNAVAILABLE');return source;}
 async checkManifests(p,s){for(const r of [p.source.r,p.targetRoot].filter((r,i,a)=>a.findIndex(v=>v.id===r.id)===i)){const manifest=await this.manifest(r,s);const state=repairRootState(this.lib,r,manifest);if(state.blocked)fail(state.code||'REPAIR_PENDING');}}
 async inspect(source,targetRoot,rel,s){
  if(typeof rel!=='string'||!rel||rel.length>4096||/^[\\/]|^[A-Za-z]:/.test(rel)||rel.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))fail('INVALID_TARGET',400);
  const file=path.join(targetRoot.path,rel);if(!within(targetRoot.path,file)||!kindForExt(path.extname(file).slice(1),targetRoot.kind))fail('INVALID_TARGET',400);
  if(this.lib.db.prepare('SELECT id FROM assets WHERE path=? AND id<>?').get(file,source.assetId))fail('NEEDS_MERGE');
  const result=await this.fingerprints.hashFile(s,targetRoot,file);if(result.sha256!==source.sha256)fail('CONTENT_MISMATCH');
  return {targetPath:file,targetFile:result.file,targetIdentity:result.rootIdentity};
 }
 async preview(input,owner){
  this.exact(input,['assetId','targetRootId','targetRelativePath']);if(!UUID.test(input.assetId||'')||!UUID.test(input.targetRootId||''))fail('INVALID_SELECTION',400);
  const s=this.state(),source=await this.source(input.assetId,s),targetRoot=this.root(input.targetRootId);
  if(this.lib.db.prepare('SELECT operation_id FROM asset_repair_journal WHERE canonical_asset_id=? AND phase NOT IN (?,?)').get(source.assetId,'COMPLETE','ABORTED'))fail('REPAIR_PENDING');
  const target=await this.inspect(source,targetRoot,input.targetRelativePath,s),references=this.references(source.assetId),upload=await this.uploadState([source.assetId],s);
  const p={source,targetRoot,targetRelativePath:input.targetRelativePath,...target,references,upload};await this.checkManifests(p,s);this.guard(p,s);this.capacity(p);
  if(this.lib.directoryClassification&&directoryClass(targetRoot,p.targetPath)?.review&&source.a.confirmed)fail('TARGET_PENDING_CONFIRMATION_CONFLICT');
  if(await fingerprintRootIdentity(source.r)!==source.rootIdentity||await fingerprintRootIdentity(targetRoot)!==p.targetIdentity||!same(fingerprintFileIdentity(await fs.lstat(p.targetPath)),p.targetFile))fail('FILE_CHANGED');
  this.guard(p,s);
  if(!await this.fingerprints.missing(s,source.r,source.a.path))fail('ORIGINAL_PRESENT');this.guard(p,s);
  const now=this.clock();for(const [id,v]of this.previews)if(v.expiresAt<=now)this.previews.delete(id);if(this.previews.size>=REPAIR_LIMITS.previews)fail('PREVIEW_LIMIT');
  const previewId=crypto.randomUUID();this.previews.set(previewId,{...p,owner:this.owner(owner),expiresAt:now+REPAIR_LIMITS.ttl});
  return {previewId,assetId:source.assetId,targetRootId:targetRoot.id,targetRelativePath:input.targetRelativePath,contentMatch:true,physicalIdentityProven:false,expiresAt:now+REPAIR_LIMITS.ttl,confirmationRequired:true};
 }
 async manifest(root,s){const meta=await this.fingerprints.metadata(s,root);return meta.manifest;}
 marker(row,p,phase){return {operationId:row.operation_id,assetId:p.source.assetId,fromRootId:p.source.r.id,toRootId:p.targetRoot.id,phase,snapshotSha256:row.data?.snapshotSha256||digest(p),targetRelativePath:p.targetRelativePath};}
 async mark(row,p,phase,s,guard){
  const roots=[p.source.r,p.targetRoot].filter((r,i,a)=>a.findIndex(v=>v.id===r.id)===i).sort((a,b)=>a.id.localeCompare(b.id));
  for(const r of roots){
   const manifest=await this.manifest(r,s);guard();manifest.repairOperations||={};
   for(const id of Object.keys(manifest.repairOperations)){if(id!==row.operation_id){const known=this.lib.db.prepare('SELECT phase FROM asset_repair_journal WHERE operation_id=?').get(id);if(!known||!['COMPLETE','ABORTED'].includes(known.phase))fail('REPAIR_STATE_UNKNOWN');}}
   if(Object.keys(manifest.repairOperations).length>=64&&!manifest.repairOperations[row.operation_id])fail('REPAIR_LIMIT');
   manifest.repairOperations[row.operation_id]=this.marker(row,p,phase);
   let metadataSnapshot;
   if(phase==='COMPLETE'){
    if(r.id===p.source.r.id&&r.id!==p.targetRoot.id)delete manifest.entries[p.source.assetId];
    if(r.id===p.targetRoot.id){const a=this.raw(p.source.assetId);metadataSnapshot=a;manifest.entries[a.id]={...manifest.entries[a.id],...entryFromAsset({...a,rel_path:p.targetRelativePath}),dev:a.dev,ino:a.ino};delete manifest.entries[a.id].fingerprintBinding;delete manifest.entries[a.id].sha256;}
   }
   const writeGuard=()=>{guard();if(metadataSnapshot&&!same(this.raw(p.source.assetId),metadataSnapshot))fail('SOURCE_CHANGED');};
   await this.hook('before-marker-write',{phase,rootId:r.id});writeGuard();
   const result=await writeManifest(r,manifest,{guard:writeGuard,maxBytes:Math.min(4*1024*1024,REPAIR_LIMITS.bytes-s.job.bytesRead),onRead:n=>{s.job.bytesRead+=n;}});if(result.skipped)fail('MANIFEST_WRITE_FAILED');writeGuard();
  }
 }
 updatePhase(id,phase){const row=this.row(id);const result=this.lib.db.prepare('UPDATE asset_repair_journal SET phase=?,version=version+1,updated_ms=? WHERE operation_id=? AND version=?').run(phase,this.clock(),id,row.version);if(result.changes!==1)fail('REPAIR_VERSION_CHANGED');return this.row(id);}
 lock(id){if(this.busy||this.lib.locks.size)fail('BUSY');this.busy=true;this.currentOperation=null;this.lib.locks.add(id);this.held.add(id);const readers=this.lib.repairIndexReaders??0;if(readers!==0){this.unlock(id);fail('BUSY');}}
 unlock(id){this.held.delete(id);this.lib.locks.delete(id);this.busy=false;this.currentOperation=null;}
 async confirm(input,owner){
  this.exact(input,['previewId','commandId']);if(!UUID.test(input.previewId||'')||!UUID.test(input.commandId||''))fail('INVALID_REQUEST',400);
  const actor=this.owner(owner),key=digest([actor,input.commandId]),inputHash=digest(input),existing=this.lib.db.prepare('SELECT operation_id,input_sha256 FROM asset_repair_journal WHERE idempotency_key=?').get(key);
  if(existing){if(existing.input_sha256!==inputHash||this.row(existing.operation_id).data.mode==='merge')fail('IDEMPOTENCY_CONFLICT');return this.get(existing.operation_id);}
  const cached=this.previews.get(input.previewId);if(!cached||cached.owner!==actor||cached.expiresAt<=this.clock())fail('PREVIEW_EXPIRED');
  if(filesReadonly())fail('MANIFEST_READONLY');const p=structuredClone(cached),s=this.state();this.lock(p.source.assetId);let row;
  try{
   this.guard(p,s,{own:true});await this.checkManifests(p,s);const fresh=await this.source(p.source.assetId,s);if(!same(fresh.binding,p.source.binding))fail('SOURCE_CHANGED');
   const target=await this.inspect(fresh,p.targetRoot,p.targetRelativePath,s);if(!same(target,{targetPath:p.targetPath,targetFile:p.targetFile,targetIdentity:p.targetIdentity}))fail('TARGET_CHANGED');
   const upload=await this.uploadState([p.source.assetId],s);if(!same(upload,p.upload))fail('UPLOAD_STATE_CHANGED');
   this.guard(p,s,{own:true});
   const data={...p};delete data.owner;delete data.expiresAt;data.snapshotSha256=digest(data);const payload=JSON.stringify(data);if(Buffer.byteLength(payload)>REPAIR_LIMITS.payload)fail('REFERENCE_LIMIT');
   await this.hook('before-backup');this.guard(p,s,{own:true});this.capacity(p);const id=crypto.randomUUID(),now=this.clock();
   this.transaction(()=>{this.guard(p,s,{own:true});this.lib.db.prepare('INSERT INTO asset_repair_journal(operation_id,idempotency_key,canonical_asset_id,alias_asset_id,from_root_id,to_root_id,phase,version,input_sha256,payload,created_ms,updated_ms) VALUES(?,?,?,NULL,?,?,?,0,?,?,?,?)').run(id,key,p.source.assetId,p.source.r.id,p.targetRoot.id,'PREPARED',inputHash,payload,now,now);});row=this.row(id);this.currentOperation=id;
   await this.hook('after-backup',{operationId:id});await this.mark(row,p,'PREPARED',s,()=>this.guard(p,s,{own:true}));
   const final=await this.inspect(fresh,p.targetRoot,p.targetRelativePath,s);if(!same(final,target)||!await this.fingerprints.missing(s,p.source.r,p.source.a.path)||await fingerprintRootIdentity(p.source.r)!==p.source.rootIdentity)fail('FILE_CHANGED');
   await this.hook('before-transaction',{operationId:id});this.guard(p,s,{own:true});
   this.transaction(()=>{
    if(this.lib.db.kind==='mysql'){this.lib.db.prepare('SELECT id FROM assets WHERE id=? FOR UPDATE').get(p.source.assetId);for(const r of [p.source.r,p.targetRoot].sort((a,b)=>a.id.localeCompare(b.id)))this.lib.db.prepare('SELECT id FROM roots WHERE id=? FOR UPDATE').get(r.id);}
    this.guard(p,s,{own:true});const cls=this.lib.directoryClassification?directoryClass(p.targetRoot,p.targetPath):null;
    this.lib.db.prepare("UPDATE assets SET root_id=?,path=?,name=?,ext=?,kind=?,size=?,mtime=?,dev=?,ino=?,sha256=NULL,online=1,file_status='online',file_checked_ms=0,file_check_path=NULL,file_root_identity=NULL,file_check_reason='' WHERE id=?").run(p.targetRoot.id,p.targetPath,path.basename(p.targetPath),path.extname(p.targetPath).slice(1).toLowerCase(),kindForExt(path.extname(p.targetPath).slice(1),p.targetRoot.kind),p.targetFile.size,p.targetFile.mtimeMs,p.targetFile.dev,p.targetFile.ino,p.source.assetId);
    if(cls)this.lib.db.prepare('UPDATE assets SET category=?,sub=?,review=? WHERE id=?').run(cls.category,cls.sub,cls.review,p.source.assetId);
    row=this.updatePhase(id,'DB_COMMITTED');
   });
   await this.hook('after-transaction',{operationId:id});
   return await this.finish(row,s);
  }catch(e){
   if(row){const current=this.row(row.operation_id);if(current.phase==='DB_COMMITTED'||current.phase==='MIRROR_PENDING'){this.updatePhase(row.operation_id,'MIRROR_PENDING');return this.get(row.operation_id);}return {...this.get(row.operation_id),error:publicRepairCode(e)};}
   throw e;
  }finally{this.unlock(p.source.assetId);}
 }
 async finish(row,s){
  const p=row.data;const guard=()=>{const a=this.guard(p,s,{own:true,references:false,committed:true});if(a.path!==p.targetPath||a.root_id!==p.targetRoot.id||Number(a.dev)!==p.targetFile.dev||Number(a.ino)!==p.targetFile.ino||Number(a.size)!==p.targetFile.size||Number(a.mtime)!==p.targetFile.mtimeMs)fail('TARGET_CHANGED');};
  guard();const result=await stableFileSha256(p.targetRoot,p.targetPath,{remainingBytes:REPAIR_LIMITS.bytes-s.job.bytesRead,check:()=>this.check(s),onRead:n=>s.job.bytesRead+=n});if(result.sha256!==p.source.sha256||!same(result.file,p.targetFile))fail('TARGET_CHANGED');
  if(!await this.fingerprints.missing(s,p.source.r,p.source.a.path))fail('ORIGINAL_PRESENT');guard();
  await this.mark(row,p,'COMPLETE',s,guard);guard();row=this.updatePhase(row.operation_id,'COMPLETE');return this.public(row);
 }
 async recover(id,input,owner){
  this.owner(owner);this.exact(input,['expectedVersion']);const row=this.row(id);if(row.data.mode==='merge')fail('USE_MERGE_RECOVERY');if(row.phase==='COMPLETE'||row.phase==='ABORTED')return this.public(row);if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0||input.expectedVersion!==Number(row.version))fail('REPAIR_VERSION_CHANGED');if(filesReadonly())fail('MANIFEST_READONLY');
  const p=row.data,s=this.state();this.lock(p.source.assetId);this.currentOperation=id;
  try{const now=await this.uploadState([p.source.assetId],s);
   if(row.phase==='PREPARED'){
    const guard=()=>{this.check(s);const a=this.raw(p.source.assetId);if(a.path!==p.source.a.path||a.root_id!==p.source.r.id)fail('REPAIR_STATE_CONFLICT');for(const r of [p.source.r,p.targetRoot])if(!same(rootKey(this.root(r.id)),rootKey(r)))fail('ROOT_CHANGED');this.syncUpload([a.id],now);};
    guard();await this.mark(row,p,'ABORTED',s,guard);guard();return this.public(this.updatePhase(id,'ABORTED'));
   }
   return await this.finish({...row,data:{...row.data,upload:now}},s);
  }catch(e){if(row.phase!=='PREPARED')this.updatePhase(id,'MIRROR_PENDING');return {...this.get(id),error:publicRepairCode(e)};}finally{this.unlock(p.source.assetId);}
 }
}
export function publicRepairCode(e){return /^[A-Z_]+$/.test(e?.code||'')?e.code:'REPAIR_UNAVAILABLE';}
