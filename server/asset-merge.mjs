// Explicit two-ID merge, bounded to the supported SQLite directory-mode domain.
// No startup work, physical file moves/deletes, alias credential forwarding or UI.
import {lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {AssetRepair,REPAIR_LIMITS,repairRootState,mergeAlias,publicRepairCode} from './asset-repair.mjs';
import {METADATA_FIELDS} from './asset-metadata-versions.mjs';
import {UPLOAD_TABLES} from './cloud-upload-batch-store.mjs';
import {fingerprintFileIdentity,stableFileSha256,within,kindForExt} from './fs-identity.mjs';
import {directoryClass} from './directory-classification.mjs';
import {writeManifest,entryFromAsset,filesReadonly} from './fs-manifest.mjs';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(code,details={})=>{throw Object.assign(Error(code),{code,status:409,...details});};
const rootKey=r=>({id:r.id,path:r.path,kind:r.kind,revision:Number(r.revision||0),retired:Number(r.retired||0)});
const fields=['note','favorite','confirmed','capture'];
const relations={operations:null,project_assets:'snapshot',project_manual_assets:'payload',project_timelines:'snapshot',project_timeline_batches:'payload',metadata_batches:'payload',music_analyses:'payload',music_category_links:null,openai_diagnostics:'payload',duplicate_audio_reports:'payload'};
const knownTables=new Set(['roots','assets','asset_tags','music_categories','asset_subcategories','category_hierarchy_meta','media_projects','project_renders','asset_repair_journal','asset_metadata_clock','asset_metadata_fields','shiguang_database_meta','app_secrets',...Object.keys(relations),...Object.keys(UPLOAD_TABLES)]);
const terminal=new Set(['COMPLETE','ABORTED']);
// Recognized ID slots must remain scalar UUID/null. Container atoms are NULL
// in json_tree, so filtering containers before validation would prove nothing.
function typedReferenceRows(rows){
 if(rows.length>4096)fail('REFERENCE_LIMIT');
 for(const row of rows)if(row.kind!=='null'&&(row.kind!=='text'||!UUID.test(row.ref||'')))fail('MERGE_REFERENCE_UNKNOWN');
 return rows.map(({rowId,ref})=>({rowId,ref}));
}

export class AssetMerge extends AssetRepair{
 constructor(lib,options={}){super(lib,options);this.boundDb=lib.db;}
 supported(){if(this.lib.db!==this.boundDb)fail('MERGE_DB_CHANGED');if(this.lib.db.kind==='mysql')fail('MYSQL_MERGE_NOT_VALIDATED');if(!this.lib.directoryClassification)fail('MERGE_MODE_UNSUPPORTED');const m=this.lib.metadataVersions.readiness();if(!m.ready)fail('MERGE_METADATA_UNKNOWN');return m;}
 preflightAssets(ids){
  const cols=this.lib.db.prepare("SELECT name FROM pragma_table_info('assets') LIMIT 129").all();if(cols.length>128||cols.some(c=>!/^[a-z_][a-z0-9_]*$/.test(c.name)))fail('MERGE_STATE_UNKNOWN');
  const sql=cols.map(c=>`COALESCE(LENGTH(CAST("${c.name}" AS BLOB)),0)`).join('+');const sizes=this.lib.db.prepare(`SELECT (${sql}) n FROM assets WHERE id IN (?,?) LIMIT 3`).all(...ids);if(sizes.some(r=>!Number.isSafeInteger(r.n))||sizes.reduce((n,r)=>n+r.n,0)>65536)fail('REFERENCE_LIMIT');
 }
 metadataProof(ids){const ready=this.supported(),rows=this.lib.db.prepare('SELECT LENGTH(domain_id)+LENGTH(field)+LENGTH(value_sha256)+LENGTH(provenance) n FROM asset_metadata_fields WHERE asset_id IN (?,?) LIMIT 11').all(...ids);if(rows.length>10||rows.some(r=>r.n>256))fail('MERGE_METADATA_UNKNOWN');const before=this.lib.db.prepare('SELECT * FROM asset_metadata_fields WHERE asset_id IN (?,?) ORDER BY asset_id,field LIMIT 11').all(...ids);return{ready,before,witnesses:ids.map(id=>Object.fromEntries(METADATA_FIELDS.map(field=>[field,this.lib.metadataVersions.field(id,field)])))};}
 associationProof(ids){
  const tables=this.lib.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 65").all();
  if(tables.length>64)fail('REFERENCE_LIMIT');for(const t of tables)if(!knownTables.has(t.name))fail('MERGE_REFERENCE_UNKNOWN');
  const expected={operations:'id,asset_id,action,source,target,status,error,created_at,undone',project_assets:'id,project_id,asset_id,status,note,source,added_at,used_at,updated_at,snapshot',project_manual_assets:'id,project_id,asset_id,payload',project_timelines:'id,project_id,name,snapshot,revision,head_id,updated_at',project_timeline_batches:'id,project_id,timeline_id,payload,status,created_at',metadata_batches:'id,created_ms,status,payload',music_analyses:'id,asset_id,cache_key,payload,created_ms',music_category_links:'id,asset_id,category_id',openai_diagnostics:'id,created_ms,payload',duplicate_audio_reports:'id,payload'};
  const result={};let bytes=0;
  const depth=alias=>`(LENGTH(${alias}.path)-LENGTH(REPLACE(${alias}.path,'.',''))+LENGTH(${alias}.path)-LENGTH(REPLACE(${alias}.path,'[','')))`;
  for(const [table,json]of Object.entries(relations)){
   if(!tables.some(t=>t.name===table)){result[table]=null;continue;}
   const cols=this.lib.db.prepare('SELECT name FROM pragma_table_info(?) LIMIT 65').all(table),names=expected[table].split(',');
   if(cols.length!==names.length||cols.some(c=>!names.includes(c.name)))fail('MERGE_REFERENCE_UNKNOWN');
   const direct=['operations','music_category_links','music_analyses'].includes(table),where=direct?' WHERE asset_id IN (?,?)':'',params=direct?ids:[];
   const size=cols.map(c=>`COALESCE(LENGTH(CAST("${c.name}" AS BLOB)),0)`).join('+');
   const sizes=this.lib.db.prepare(`SELECT (${size}) n FROM ${table}${where} LIMIT 129`).all(...params);if(sizes.length>128)fail('REFERENCE_LIMIT');
   for(const r of sizes){bytes+=Number(r.n);if(!Number.isSafeInteger(bytes)||bytes>131072)fail('REFERENCE_LIMIT');}
   if(direct){if(sizes.length)fail('MERGE_UNSUPPORTED_REFERENCE',{relation:table});result[table]={rows:[],refs:[]};continue;}
   // Inspect only typed ID projections, never return or archive unrelated note,
   // diagnostics/analysis bodies or secret values. SQL JSON work is byte-bounded.
   const valid=this.lib.db.prepare(`SELECT json_valid(${json}) valid FROM ${table} ORDER BY id LIMIT 129`).all();if(valid.some(r=>r.valid!==1))fail('MERGE_REFERENCE_UNKNOWN');
   const shapes=this.lib.db.prepare(`SELECT json_type(${json}) kind FROM ${table} ORDER BY id LIMIT 129`).all();if(shapes.some(r=>r.kind!=='object'))fail('MERGE_REFERENCE_UNKNOWN');
   const d=this.lib.db.prepare(`SELECT MAX(${depth('j')}) n FROM ${table} t,json_tree(t.${json}) j`).get();if(Number(d.n)>20)fail('REFERENCE_LIMIT');
   const rows=this.lib.db.prepare(`SELECT id${cols.some(c=>c.name==='asset_id')?',asset_id':''} FROM ${table} ORDER BY id LIMIT 129`).all();
   // Validate only known reference containers; do not search ordinary text.
   const shape=[];
   if(['project_timelines','project_timeline_batches'].includes(table))shape.push("(j.key='refs' AND j.type<>'array')", "(j.path LIKE '%.refs' AND j.type<>'object')");
   if(table==='project_timeline_batches')shape.push("(j.key='affected' AND j.path='$' AND j.type<>'array')");
   if(table==='metadata_batches')shape.push("(j.key IN ('items','skipped') AND j.path='$' AND j.type<>'array')", "(j.path IN ('$.items','$.skipped') AND j.type<>'object')");
   if(table==='duplicate_audio_reports')shape.push("(j.key IN ('groups','skipped') AND j.path='$' AND j.type<>'array')", "(j.key='fingerprints' AND j.path='$' AND j.type<>'object')", "(j.path IN ('$.groups','$.skipped') AND j.type<>'object')", "(j.key='files' AND j.path LIKE '$.groups[%]' AND j.type<>'array')", "(j.path LIKE '$.groups[%].files' AND j.type<>'object')");
   if(shape.length&&this.lib.db.prepare(`SELECT COUNT(*) n FROM ${table} t,json_tree(t.${json}) j WHERE ${shape.join(' OR ')}`).get().n)fail('MERGE_REFERENCE_UNKNOWN');
   let selector="j.key IN ('assetId','asset_id')";
   if(table==='project_timeline_batches')selector+=" OR j.path='$.affected'";
   if(table==='project_assets'||table==='project_manual_assets')selector+=" OR (j.key='id' AND j.path='$')";
   if(table==='metadata_batches')selector+=" OR (j.key='id' AND (j.path LIKE '$.items[%]' OR j.path LIKE '$.skipped[%]'))";
   if(table==='duplicate_audio_reports')selector+=" OR j.key='id' OR j.path='$.fingerprints'";
   const expression=table==='duplicate_audio_reports'?"CASE WHEN j.path='$.fingerprints' THEN j.key ELSE j.atom END":'j.atom';
   const kind=table==='duplicate_audio_reports'?"CASE WHEN j.path='$.fingerprints' THEN 'text' ELSE j.type END":'j.type';
   const refs=typedReferenceRows(this.lib.db.prepare(`SELECT t.id rowId,${expression} ref,${kind} kind FROM ${table} t,json_tree(t.${json}) j WHERE (${selector}) ORDER BY t.id,j.id LIMIT 4097`).all());
   if(['project_manual_assets','project_timeline_batches'].includes(table)){
    const nested=this.lib.db.prepare(`SELECT LENGTH(CAST(p.atom AS BLOB)) bytes FROM ${table} t,json_tree(t.${json}) p WHERE p.key='snapshot' AND p.type='text' LIMIT 129`).all();
    if(nested.length>128)fail('REFERENCE_LIMIT');
    // Only the SQL engine receives these bounded serialized snapshots; do not
    // materialize their bodies in the audit or expose them in the public DTO.
    for(const row of nested)if(!Number.isSafeInteger(row.bytes)||row.bytes>131072)fail('MERGE_REFERENCE_UNKNOWN');
    const bad=this.lib.db.prepare(`SELECT COUNT(*) n FROM ${table} t,json_tree(t.${json}) p WHERE p.key='snapshot' AND (p.type NOT IN ('text','object','null') OR (p.type='text' AND json_valid(p.atom)<>1))`).get();if(bad.n)fail('MERGE_REFERENCE_UNKNOWN');
    const nestedShape=this.lib.db.prepare(`SELECT COUNT(*) n FROM ${table} t,json_tree(t.${json}) p WHERE p.key='snapshot' AND p.type='text' AND json_type(p.atom)<>'object'`).get();if(nestedShape.n)fail('MERGE_REFERENCE_UNKNOWN');
    const nestedDepth=this.lib.db.prepare(`SELECT MAX(${depth('p')}+${depth('j')}+1) n FROM ${table} t,json_tree(t.${json}) p,json_tree(CASE WHEN p.key='snapshot' AND p.type='text' AND json_valid(p.atom) THEN p.atom ELSE '{}' END) j WHERE p.key='snapshot' AND p.type='text'`).get();if(Number(nestedDepth.n)>20)fail('REFERENCE_LIMIT');
    const nestedContainers=this.lib.db.prepare(`SELECT COUNT(*) n FROM ${table} t,json_tree(t.${json}) p,json_tree(CASE WHEN p.key='snapshot' AND p.type='text' AND json_valid(p.atom) THEN p.atom ELSE '{}' END) j WHERE p.key='snapshot' AND p.type='text' AND ((j.key='refs' AND j.path='$' AND j.type<>'array') OR (j.path='$.refs' AND j.type<>'object'))`).get();if(nestedContainers.n)fail('MERGE_REFERENCE_UNKNOWN');
    const hidden=this.lib.db.prepare(`SELECT COUNT(*) n FROM ${table} t,json_tree(t.${json}) p,json_tree(CASE WHEN p.key='snapshot' AND p.type='text' AND json_valid(p.atom) THEN p.atom ELSE '{}' END) j WHERE p.key='snapshot' AND p.type='text' AND j.key IN ('snapshot','payload') AND j.type='text'`).get();if(hidden.n)fail('MERGE_REFERENCE_UNKNOWN');
    refs.push(...typedReferenceRows(this.lib.db.prepare(`SELECT t.id rowId,j.atom ref,j.type kind FROM ${table} t,json_tree(t.${json}) p,json_tree(CASE WHEN p.key='snapshot' AND p.type='text' AND json_valid(p.atom) THEN p.atom ELSE '{}' END) j WHERE p.key='snapshot' AND p.type='text' AND (j.key IN ('assetId','asset_id') OR (j.key='id' AND j.path='$')) ORDER BY t.id,p.id,j.id LIMIT 4097`).all()));
   }
   if(refs.length>4096)fail('REFERENCE_LIMIT');if(rows.some(r=>ids.includes(r.asset_id))||refs.some(r=>ids.includes(r.ref)))fail('MERGE_UNSUPPORTED_REFERENCE',{relation:table});
   result[table]={rows,refs};
  }
  return result;
 }
 decide(canonical,donor,metadata,choices){
  const after={},decisions={},conflicts=[];
  for(const field of fields){const a=metadata.witnesses[0][field],b=metadata.witnesses[1][field];if(!Object.hasOwn(a,'value')||!Object.hasOwn(b,'value'))fail('MERGE_METADATA_UNKNOWN');let side=null,reason;
   if(same(a.value,b.value)){side='canonical';reason='same';}
   else if(a.known&&b.known&&a.domainId===b.domainId&&a.seq!==b.seq){side=a.seq>b.seq?'canonical':'donor';reason='latest';}
   else{reason='explicit';side=choices[field]||null;if(!side)conflicts.push(field);}
   if(choices[field]&&reason!=='explicit'&&choices[field]!==side)fail('MERGE_CHOICE_CONFLICT');
   if(side)after[field]=side==='canonical'?a.value:b.value;
   decisions[field]={canonical:a,donor:b,selected:side,reason};
  }
  const values=metadata.witnesses.map(v=>v.tags.value);if(values.some(v=>!Array.isArray(v)||v.some(t=>typeof t!=='string'||!t||t.trim()!==t||t.length>60)))fail('MERGE_TAG_CONFLICT');const tags=[...new Set([...values[0],...values[1]])];if(tags.length>40)fail('MERGE_TAG_LIMIT');after.tags=tags;return{after,decisions,conflicts};
 }
 afterAsset(p,selection){
  const a={...p.source.a},b=p.donor.a,cls=directoryClass(p.targetRoot,p.targetPath);if(!cls)fail('INVALID_TARGET');if(cls.review&&selection.confirmed)fail('TARGET_PENDING_CONFIRMATION_CONFLICT');
  Object.assign(a,{root_id:p.targetRoot.id,path:p.targetPath,name:path.basename(p.targetPath),ext:path.extname(p.targetPath).slice(1).toLowerCase(),kind:kindForExt(path.extname(p.targetPath).slice(1),p.targetRoot.kind),size:p.targetFile.size,mtime:p.targetFile.mtimeMs,created_ms:p.targetFile.birthtimeMs||b.created_ms,dev:p.targetFile.dev,ino:p.targetFile.ino,sha256:null,online:1,file_status:'online',file_checked_ms:0,file_check_path:null,file_root_identity:null,file_check_reason:'',category:cls.category,sub:cls.sub,review:cls.review,tags:JSON.stringify(selection.tags),note:selection.note,favorite:selection.favorite?1:0,confirmed:selection.confirmed?1:0,captured_ms:selection.capture[0],capture_source:selection.capture[1]});
  for(const field of ['duration','width','height','codec','probe','error'])a[field]=b[field];const captureSide=p.decisions.capture.selected==='donor'?b:p.source.a;for(const field of ['capture_status','capture_error'])a[field]=captureSide[field];return a;
 }
 public(row){return super.public(row);}
 guardMerge(p,s,{own=false,committed=false,abort=false}={}){
  this.check(s);this.supported();const ids=[p.source.assetId,p.donor.a.id];this.preflightAssets(ids);
  if(this.lib.db.prepare('SELECT operation_id FROM asset_repair_journal WHERE canonical_asset_id=? AND alias_asset_id IS NOT NULL LIMIT 1').get(ids[1]))fail('MERGE_DONOR_HAS_ALIASES');
  for(const [r,key]of [[p.source.r,p.source.rootIdentity],[p.targetRoot,p.targetIdentity]]){const st=lstatSync(r.path);if(!st.isDirectory()||st.isSymbolicLink()||realpathSync(r.path)!==r.path||`${st.dev}:${st.ino}`!==key||!same(rootKey(this.root(r.id)),rootKey(r)))fail('ROOT_CHANGED');}
  if(own){if(this.lib.locks.size!==2||ids.some(id=>!this.lib.locks.has(id)||!this.held.has(id)))fail('BUSY');}else if(this.lib.locks.size)fail('BUSY');
  if(this.lib.workers||this.lib.metadataPending.size||this.lib.metadataQueue.length||(this.lib.repairIndexReaders??0)||[...this.lib.jobs.values()].some(j=>['running','queued','cancelling'].includes(j.status)))fail('BUSY');
  const current=this.raw(ids[0]),other=this.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(ids[1]);
  if(abort){if(current.path!==p.source.a.path||current.root_id!==p.source.r.id||!other||other.path!==p.donor.a.path||other.root_id!==p.targetRoot.id||mergeAlias(this.lib,ids[1]))fail('MERGE_STATE_CONFLICT');return current;}
  try{lstatSync(p.source.a.path);fail('ORIGINAL_PRESENT');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(realpathSync(p.targetPath)!==p.targetPath||!same(fingerprintFileIdentity(lstatSync(p.targetPath)),p.targetFile))fail('TARGET_CHANGED');
  if(committed){const alias=mergeAlias(this.lib,ids[1]);if(other||!alias||alias.operationId!==this.currentOperation||current.path!==p.targetPath||current.root_id!==p.targetRoot.id||Number(current.dev)!==p.targetFile.dev||Number(current.ino)!==p.targetFile.ino||Number(current.size)!==p.targetFile.size||Number(current.mtime)!==p.targetFile.mtimeMs)fail('MERGE_STATE_CONFLICT');}
  else{if(!same(current,p.source.a)||!same(other,p.donor.a))fail('SOURCE_CHANGED');if(mergeAlias(this.lib,ids[0])||mergeAlias(this.lib,ids[1]))fail('ASSET_IS_ALIAS');if(!same(this.metadataProof(ids),p.metadata))fail('MERGE_METADATA_CHANGED');const selected=this.decide(p.source.a,p.donor.a,p.metadata,p.choices);if(!same(selected.after,p.selection)||!same(selected.decisions,p.decisions)||!same(selected.conflicts,p.conflicts))fail('MERGE_SELECTION_CHANGED');if(p.afterCanonical&&!same(this.afterAsset({...p,decisions:selected.decisions},selected.after),p.afterCanonical))fail('MERGE_SELECTION_CHANGED');if(!same(this.associationProof(ids),p.references))fail('REFERENCES_CHANGED');}
  const owner=this.lib.db.prepare('SELECT id FROM assets WHERE path=?').get(p.targetPath);if(!owner||owner.id!==(committed?ids[0]:ids[1]))fail('TARGET_CHANGED');
  for(const id of ids){if(this.lib.db.prepare("SELECT id FROM operations WHERE asset_id=? AND status='pending' LIMIT 1").get(id))fail('BUSY');}
  for(const r of [p.source.r,p.targetRoot])if(this.lib.db.prepare("SELECT operation_id FROM asset_repair_journal WHERE (from_root_id=? OR to_root_id=?) AND phase NOT IN ('COMPLETE','ABORTED') AND operation_id<>? LIMIT 1").get(r.id,r.id,this.currentOperation||''))fail('REPAIR_PENDING');
  this.syncUpload(ids,p.upload);return current;
 }
 async preview(input,owner){
  this.exact(input,['canonicalAssetId','donorAssetId','choices']);if(!UUID.test(input.canonicalAssetId||'')||!UUID.test(input.donorAssetId||'')||input.canonicalAssetId===input.donorAssetId)fail('INVALID_SELECTION');const choices=structuredClone(input.choices??{});if(!choices||typeof choices!=='object'||Array.isArray(choices)||Object.keys(choices).some(k=>!fields.includes(k)||!['canonical','donor'].includes(choices[k])))fail('INVALID_SELECTION');
  this.supported();const ids=[input.canonicalAssetId,input.donorAssetId];this.preflightAssets(ids);if(this.lib.db.prepare('SELECT operation_id FROM asset_repair_journal WHERE canonical_asset_id=? AND alias_asset_id IS NOT NULL LIMIT 1').get(ids[1]))fail('MERGE_DONOR_HAS_ALIASES');for(const id of ids)if(mergeAlias(this.lib,id))fail('ASSET_IS_ALIAS');
  const actor=this.owner(owner),s=this.state(),source=await this.source(ids[0],s),donor=this.raw(ids[1]),targetRoot=this.root(donor.root_id);if(!donor.online||['missing','offline','unavailable'].includes(donor.file_status)||!within(targetRoot.path,donor.path))fail('TARGET_CHANGED');
  const result=await this.fingerprints.hashFile(s,targetRoot,donor.path);if(result.sha256!==source.sha256)fail('CONTENT_MISMATCH');if(Number(donor.dev)!==result.file.dev||Number(donor.ino)!==result.file.ino||Number(donor.size)!==result.file.size||Number(donor.mtime)!==result.file.mtimeMs)fail('TARGET_CHANGED');
  for(const [a,r] of [[source.a,source.r],[donor,targetRoot]]){const cls=directoryClass(r,a.path);if(a.basis==='人工指定素材类型'||a.kind!==kindForExt(a.ext,r.kind))fail('MERGE_UNSUPPORTED_MANUAL_FIELD',{field:'kind'});if(!cls||a.category!==cls.category||a.sub!==cls.sub||Number(a.review)!==cls.review)fail('MERGE_UNSUPPORTED_MANUAL_FIELD',{field:'classification'});}
  const metadata=this.metadataProof(ids),selection=this.decide(source.a,donor,metadata,choices),references=this.associationProof(ids),upload=await this.uploadState(ids,s);
  const p={format:2,mode:'merge',source,donor:{a:donor},targetRoot,targetRelativePath:path.relative(targetRoot.path,donor.path).split(path.sep).join('/'),targetPath:donor.path,targetFile:result.file,targetIdentity:result.rootIdentity,metadata,references,upload,choices,selection:selection.after,decisions:selection.decisions,conflicts:selection.conflicts,beforeEntries:[]};
  for(const r of [source.r,targetRoot].filter((r,i,a)=>a.findIndex(v=>v.id===r.id)===i)){const manifest=await this.manifest(r,s);const state=repairRootState(this.lib,r,manifest);if(state.blocked)fail(state.code||'REPAIR_PENDING');p.beforeEntries.push({rootId:r.id,revision:manifest.revision??0,updatedAt:manifest.updatedAt??null,entries:Object.fromEntries(ids.map(id=>[id,manifest.entries[id]??null]))});}
  this.guardMerge(p,s);if(!selection.conflicts.length)p.afterCanonical=this.afterAsset(p,selection.after);this.capacity(p);if(Buffer.byteLength(JSON.stringify(p))>REPAIR_LIMITS.payload)fail('REFERENCE_LIMIT');
  const now=this.clock();for(const[id,v]of this.previews)if(v.expiresAt<=now)this.previews.delete(id);if(this.previews.size>=REPAIR_LIMITS.previews)fail('PREVIEW_LIMIT');const previewId=crypto.randomUUID();this.previews.set(previewId,{...structuredClone(p),owner:actor,expiresAt:now+REPAIR_LIMITS.ttl});
  return{previewId,canonicalAssetId:ids[0],donorAssetId:ids[1],targetRootId:targetRoot.id,targetRelativePath:p.targetRelativePath,fields:selection.decisions,tags:selection.after.tags,conflicts:selection.conflicts,canConfirm:selection.conflicts.length===0,confirmationRequired:true,contentMatch:true,physicalIdentityProven:false,expiresAt:now+REPAIR_LIMITS.ttl};
 }
 lockPair(ids){if(this.busy||this.lib.locks.size||(this.lib.repairIndexReaders??0))fail('BUSY');this.busy=true;this.currentOperation=null;for(const id of [...ids].sort()){this.lib.locks.add(id);this.held.add(id);}}
 unlockPair(){for(const id of this.held)this.lib.locks.delete(id);this.held.clear();this.busy=false;this.currentOperation=null;}
 marker(row,p,phase){return{...super.marker(row,p,phase),format:2,mode:'merge',aliasAssetId:p.donor.a.id};}
 async mark(row,p,phase,s,guard){
  for(const r of [p.source.r,p.targetRoot].filter((r,i,a)=>a.findIndex(v=>v.id===r.id)===i).sort((a,b)=>a.id.localeCompare(b.id))){
   const manifest=await this.manifest(r,s);guard();manifest.repairOperations||={};if(Object.keys(manifest.repairOperations).length>=64&&!manifest.repairOperations[row.operation_id])fail('REPAIR_LIMIT');
   for(const id of Object.keys(manifest.repairOperations)){if(id!==row.operation_id){const prior=this.lib.db.prepare('SELECT phase FROM asset_repair_journal WHERE operation_id=?').get(id);if(!prior||!terminal.has(prior.phase))fail('REPAIR_STATE_UNKNOWN');}}
   if(phase==='PREPARED'){const expected=p.beforeEntries.find(e=>e.rootId===r.id);if(!expected||Object.entries(expected.entries).some(([id,v])=>!same(manifest.entries[id]??null,v)))fail('MANIFEST_CHANGED');}
   manifest.repairOperations[row.operation_id]=this.marker(row,p,phase);let metadataSnapshot=null;
   if(phase==='COMPLETE'){delete manifest.entries[p.donor.a.id];if(r.id!==p.targetRoot.id)delete manifest.entries[p.source.assetId];else{const a=this.raw(p.source.assetId);metadataSnapshot=a;manifest.entries[a.id]={...manifest.entries[a.id],...entryFromAsset({...a,rel_path:p.targetRelativePath}),dev:a.dev,ino:a.ino};delete manifest.entries[a.id].fingerprintBinding;delete manifest.entries[a.id].sha256;}}
   const writeGuard=()=>{guard();if(metadataSnapshot&&!same(this.raw(p.source.assetId),metadataSnapshot))fail('SOURCE_CHANGED');};await this.hook('before-marker-write',{phase,rootId:r.id});writeGuard();const written=await writeManifest(r,manifest,{guard:writeGuard,maxBytes:Math.min(4*1024*1024,REPAIR_LIMITS.bytes-s.job.bytesRead),onRead:n=>s.job.bytesRead+=n});if(written.skipped)fail('MANIFEST_WRITE_FAILED');writeGuard();
  }
 }
 async confirm(input,owner){
  this.exact(input,['previewId','commandId']);if(!UUID.test(input.previewId||'')||!UUID.test(input.commandId||''))fail('INVALID_REQUEST');this.supported();const actor=this.owner(owner),key=digest([actor,input.commandId]),inputHash=digest(input),existing=this.lib.db.prepare('SELECT operation_id,input_sha256 FROM asset_repair_journal WHERE idempotency_key=?').get(key);
  if(existing){if(existing.input_sha256!==inputHash||this.row(existing.operation_id).data.mode!=='merge')fail('IDEMPOTENCY_CONFLICT');return this.get(existing.operation_id);}
  const cached=this.previews.get(input.previewId);if(!cached||cached.owner!==actor||cached.expiresAt<=this.clock())fail('PREVIEW_EXPIRED');if(cached.conflicts.length)fail('MERGE_SELECTION_REQUIRED');if(filesReadonly())fail('MANIFEST_READONLY');const p=structuredClone(cached);delete p.owner;delete p.expiresAt;const ids=[p.source.assetId,p.donor.a.id],s=this.state();this.lockPair(ids);let row;
  try{
   this.guardMerge(p,s,{own:true});await this.checkManifests(p,s);const fresh=await this.source(ids[0],s);if(!same(fresh.binding,p.source.binding))fail('SOURCE_CHANGED');const target=await this.fingerprints.hashFile(s,p.targetRoot,p.targetPath);if(target.sha256!==p.source.sha256||!same(target.file,p.targetFile)||target.rootIdentity!==p.targetIdentity)fail('TARGET_CHANGED');const upload=await this.uploadState(ids,s);if(!same(upload,p.upload))fail('UPLOAD_STATE_CHANGED');
   await this.hook('before-backup');this.guardMerge(p,s,{own:true});this.capacity(p);p.snapshotSha256=digest(p);const payload=JSON.stringify(p);if(Buffer.byteLength(payload)>REPAIR_LIMITS.payload)fail('REFERENCE_LIMIT');const id=crypto.randomUUID(),now=this.clock();
   this.transaction(()=>{this.guardMerge(p,s,{own:true});this.lib.db.prepare('INSERT INTO asset_repair_journal(operation_id,idempotency_key,canonical_asset_id,alias_asset_id,from_root_id,to_root_id,phase,version,input_sha256,payload,created_ms,updated_ms) VALUES(?,?,?,NULL,?,?,?,0,?,?,?,?)').run(id,key,ids[0],p.source.r.id,p.targetRoot.id,'PREPARED',inputHash,payload,now,now);});row=this.row(id);this.currentOperation=id;
   await this.hook('after-backup',{operationId:id});await this.mark(row,p,'PREPARED',s,()=>this.guardMerge(p,s,{own:true}));const final=await this.fingerprints.hashFile(s,p.targetRoot,p.targetPath);if(final.sha256!==p.source.sha256||!same(final.file,p.targetFile)||!await this.fingerprints.missing(s,p.source.r,p.source.a.path))fail('FILE_CHANGED');await this.hook('before-transaction',{operationId:id});this.guardMerge(p,s,{own:true});
   this.transaction(()=>{
    this.guardMerge(p,s,{own:true});this.lib.metadataVersions.edit(ids[0],()=>{this.lib.db.prepare('DELETE FROM assets WHERE id=?').run(ids[1]);const keys=['root_id','path','name','ext','kind','size','mtime','created_ms','dev','ino','sha256','online','file_status','file_checked_ms','file_check_path','file_root_identity','file_check_reason','category','sub','review','tags','note','favorite','confirmed','captured_ms','capture_source','duration','width','height','codec','probe','error','capture_status','capture_error'];this.lib.db.prepare('UPDATE assets SET '+keys.map(k=>k+'=?').join(',')+' WHERE id=?').run(...keys.map(k=>p.afterCanonical[k]),ids[0]);},{source:'manual'});
    if(!same(this.raw(ids[0]),p.afterCanonical)||this.lib.db.prepare('SELECT id FROM assets WHERE id=?').get(ids[1]))fail('MERGE_STATE_CONFLICT');if(!same(this.associationProof(ids),p.references))fail('REFERENCES_CHANGED');this.syncUpload(ids,p.upload);const changed=this.lib.db.prepare("UPDATE asset_repair_journal SET alias_asset_id=?,phase='DB_COMMITTED',version=version+1,updated_ms=? WHERE operation_id=? AND phase='PREPARED' AND alias_asset_id IS NULL AND version=?").run(ids[1],this.clock(),id,row.version);if(changed.changes!==1)fail('REPAIR_VERSION_CHANGED');row=this.row(id);
   });await this.hook('after-transaction',{operationId:id});return await this.finish(row,s);
  }catch(e){if(row){const current=this.row(row.operation_id);if(['DB_COMMITTED','MIRROR_PENDING'].includes(current.phase))this.updatePhase(row.operation_id,'MIRROR_PENDING');return{...this.get(row.operation_id),error:publicRepairCode(e)};}throw e;}finally{this.unlockPair();}
 }
 async finish(row,s){const p=row.data,guard=()=>this.guardMerge(p,s,{own:true,committed:true});guard();const current=await stableFileSha256(p.targetRoot,p.targetPath,{remainingBytes:REPAIR_LIMITS.bytes-s.job.bytesRead,check:()=>this.check(s),onRead:n=>s.job.bytesRead+=n});if(current.sha256!==p.source.sha256||!same(current.file,p.targetFile))fail('TARGET_CHANGED');guard();await this.mark(row,p,'COMPLETE',s,guard);guard();return this.public(this.updatePhase(row.operation_id,'COMPLETE'));}
 async recover(id,input,owner){this.owner(owner);this.supported();this.exact(input,['expectedVersion']);const row=this.row(id);if(row.data.mode!=='merge')fail('USE_RESTORE_RECOVERY');if(terminal.has(row.phase))return this.public(row);if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion!==Number(row.version))fail('REPAIR_VERSION_CHANGED');if(filesReadonly())fail('MANIFEST_READONLY');const p=row.data,s=this.state();this.lockPair([p.source.assetId,p.donor.a.id]);this.currentOperation=id;
  try{const now=await this.uploadState([p.source.assetId,p.donor.a.id],s),copy={...p,upload:now};if(row.phase==='PREPARED'){const guard=()=>{this.guardMerge(copy,s,{own:true,abort:true});this.syncUpload([p.source.assetId,p.donor.a.id],now);};guard();await this.mark(row,copy,'ABORTED',s,guard);guard();return this.public(this.updatePhase(id,'ABORTED'));}return await this.finish({...row,data:copy},s);}catch(e){if(row.phase!=='PREPARED')this.updatePhase(id,'MIRROR_PENDING');return{...this.get(id),error:publicRepairCode(e)};}finally{this.unlockPair();}
 }
}
