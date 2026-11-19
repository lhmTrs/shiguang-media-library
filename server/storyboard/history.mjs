import {randomUUID} from 'node:crypto';
import {canonical,digest,fault,idOK} from '../project-assets/model.mjs';
import {storyboardDiff} from './shared/change-diff.mjs';
import {HISTORY_TABLES,tablePresent,installHistory} from './history-schema.mjs';
import {classifyVersion,pendingCounts,pendingView,versionView} from './pending-view.mjs';
export const HISTORY_CATEGORIES=['shot_feel','miscommunication','prompt_wrong'];
const fail=(code,message,status=400,extra={})=>fault(message,status,{code,...extra});
const integer=v=>Number.isSafeInteger(v)&&v>=1;
const CLASS_CACHE_LIMIT=500,COUNT_CACHE_LIMIT=200;
export function changeAuthor(change,kind=null,reason=''){
 if(kind)return {author_kind:kind,reason_category:null,reason_text:typeof reason==='string'?reason:''};
 if(!change||change.author==='user')return {author_kind:'user',reason_category:null,reason_text:'用户手动保存'};
 if(change.author!=='agent'||!HISTORY_CATEGORIES.includes(change.reason_category)||typeof change.reason_text!=='string'||!change.reason_text.trim()||change.reason_text.length>20000)throw fail('CHANGE_REASON_REQUIRED','agent保存必须包含用户原话及有效原因分类');
 return {author_kind:'agent',reason_category:change.reason_category,reason_text:change.reason_text};
}
export class StoryboardHistory{
 constructor(board){this.board=board;}
 get db(){return this.board.db;}
 ready(){
  if(this.checkedDb===this.db)return true;
  const present=Object.keys(HISTORY_TABLES).filter(t=>tablePresent(this.db,t));this.schemaState=present.length?'unsupported':'absent';
  if(present.length!==3)return false;
  for(const [t,cols]of Object.entries(HISTORY_TABLES)){
   const actual=this.db.kind==='mysql'?this.db.prepare('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?').all(t):this.db.prepare('PRAGMA table_info('+t+')').all();
   if(canonical(actual.map(c=>c.name).sort())!==canonical(Object.keys(cols).sort()))return false;
  }
  this.schemaState='ready';this.checkedDb=this.db;return true;
 }
 require({fresh=false}={}){if(fresh)this.checkedDb=null;if(!this.ready())throw fail(this.schemaState==='unsupported'?'STORYBOARD_HISTORY_SCHEMA_UNSUPPORTED':'STORYBOARD_HISTORY_MIGRATION_REQUIRED','分镜历史需要先核准表结构并显式迁移',503);}
 install(){const result=installHistory(this.db);this.checkedDb=null;return result;}
 init(fresh=false){if(fresh&&!this.ready()&&this.schemaState==='absent'&&!this.db.prepare('SELECT id FROM storyboard_documents LIMIT 1').get())this.install();return this;}
 row(documentId,version){this.require();if(!integer(version))throw fail('INVALID_VERSION','版本号无效');return this.db.prepare('SELECT * FROM storyboard_versions WHERE document_id=? AND version=?').get(documentId,version);}
 full(row){if(!row)throw fail('VERSION_NOT_FOUND','此版本尚未记录',404);if(row.document_json===null)throw fail('VERSION_PRUNED','此版本完整版已裁剪，改动记录仍保留',410);return JSON.parse(row.document_json);}
 meta(r){return {version:r.version,created_at:r.created_at,author_kind:r.author_kind,reason_category:r.reason_category,reason_text:r.reason_text,reason_missing:!r.reason_text,summary_only:!!r.summary_only,changed_shot_count:r.changed_shot_count,restored_from:r.restored_from,full_available:r.document_json!==null,baseline:!!r.baseline,byte_size:r.byte_size};}
 replay(projectId,input,hash){
  if(!input.request_id)return null;if(!idOK(input.request_id))throw fail('INVALID_REQUEST_ID','保存请求编号无效');
  const r=this.db.prepare('SELECT * FROM storyboard_versions WHERE request_id=?').get(input.request_id);if(!r)return null;
  const head=this.board.head(projectId);if(!head||r.document_id!==head.id||r.request_hash!==hash)throw fail('REQUEST_ID_CONFLICT','请求编号已用于其它保存',409);
  return {...this.board.readInTransaction(projectId),saved_version:r.version,repeated:true,request_id:input.request_id};
 }
 add(old,next,author,{baseline=false,restoredFrom=null,requestId=null,requestHash=null}={}){
  this.require();
  const previous=old?JSON.parse(old.document_json):null;
  if(old&&!this.row(old.id,old.revision))this.add(null,old,changeAuthor(null,'baseline','功能启用前版本，原作者未知'),{baseline:true});
  const project=JSON.parse(next.document_json),diff=baseline?{summary_only:false,changes:[],metrics:{}}:storyboardDiff(previous,project),now=next.updated_at;
  const version={id:randomUUID(),document_id:next.id,version:next.revision,created_at:now,updated_at:now,...author,summary_only:Number(diff.summary_only),restored_from:restoredFrom,changed_shot_count:new Set(diff.changes.filter(c=>c.shot_id!==null).map(c=>c.shot_id)).size,byte_size:Buffer.byteLength(next.document_json),document_json:next.document_json,baseline:Number(baseline),request_id:requestId,request_hash:requestHash};
  this.insert('storyboard_versions',version);
  const changes=diff.summary_only?[{target_kind:'document',target_id:'document:$document',shot_id:null,shot_number_at_time:null,field:'$summary',before:null,after:null,deleted:false,metrics:diff.metrics},...diff.changes.filter(c=>c.segment_event)]:diff.changes;
  for(const c of changes)this.insert('storyboard_changes',{id:randomUUID(),document_id:next.id,version:next.revision,target_kind:c.target_kind,target_id:c.target_id,shot_id:c.shot_id,shot_number_at_time:c.shot_number_at_time,field:c.field,change_json:canonical(c),created_at:now,updated_at:now});
  // Pending is a review queue for Codex writes, independent of the permanent log.
  if(!['agent','generation'].includes(author.author_kind))return;
  const groups=Map.groupBy(diff.changes,c=>c.target_id);
  for(const [target,items]of groups){const c=items[0];this.insert('storyboard_pending',{id:randomUUID(),document_id:next.id,version:next.revision,target_kind:c.target_kind,target_id:target,shot_id:c.shot_id,shot_number_at_time:c.shot_number_at_time,fields_json:canonical(items.map(x=>x.field)),deleted:Number(c.deleted),created_at:now,updated_at:now,cleared_at:null});}
 }
 insert(table,row){const keys=Object.keys(HISTORY_TABLES[table]);this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`).run(...keys.map(k=>row[k]));}
 pendingRows(id,{countsOnly=false}={}){return this.db.prepare("SELECT "+(countsOnly?"p.id,p.version,p.target_kind,p.target_id,p.fields_json,v.id version_row_id,v.summary_only version_summary_only":"p.*,v.id version_row_id,v.created_at version_created_at,v.author_kind,v.reason_category,v.reason_text,v.summary_only version_summary_only")+" FROM storyboard_pending p JOIN storyboard_versions v ON v.document_id=p.document_id AND v.version=p.version WHERE p.document_id=? AND p.cleared_at IS NULL AND v.author_kind IN ('agent','generation') ORDER BY p.version,p.id").all(id).map(r=>({...r,version:Number(r.version)}));}
 changeRows(id,versions){
  const out=new Map();if(!versions.length)return out;
  // storyboard_changes 只有主键，这里一次读完范围，不按版本逐条扫表。
  for(const r of this.db.prepare('SELECT version,change_json FROM storyboard_changes WHERE document_id=? AND version>=? AND version<=?').all(id,Math.min(...versions),Math.max(...versions))){const v=Number(r.version);if(!out.has(v))out.set(v,[]);out.get(v).push(JSON.parse(r.change_json));}
  return out;
 }
 snapshots(id,version){const read=this.db.prepare('SELECT document_json FROM storyboard_versions WHERE document_id=? AND version=?'),before=read.get(id,version-1)?.document_json,after=read.get(id,version)?.document_json;return before&&after?[JSON.parse(before),JSON.parse(after)]:null;}
 /** wanted: 版本号 → {rowId,summaryOnly}。一版的改动记录不再变化，所以按版本行（随机 id，回滚重存不会撞）缓存。 */
 classes(id,wanted,loaded=null){
  this.classCache??=new Map();const out=new Map(),missing=[];
  for(const [version,w]of wanted){if(w.summaryOnly)out.set(version,null);else if(this.classCache.has(w.rowId))out.set(version,this.classCache.get(w.rowId));else missing.push(version);}
  if(!missing.length)return out;
  const changes=loaded??this.changeRows(id,missing);
  for(const version of missing){
   const list=changes.get(version),cls=list?.length?classifyVersion(list,()=>this.snapshots(id,version)):null;out.set(version,cls);
   this.classCache.set(wanted.get(version).rowId,cls);if(this.classCache.size>CLASS_CACHE_LIMIT)this.classCache.delete(this.classCache.keys().next().value);
  }
  return out;
 }
 /** 分镜每次读取都会算。改动记录不可变，所以未看记录集合（随机行 id）不变时直接用上次结果；清除或新增记录即失效。 */
 counts(id){
  this.require();const rows=this.pendingRows(id,{countsOnly:true}),key=rows.map(r=>r.id).join();
  this.countCache??=new Map();const hit=this.countCache.get(id);if(hit?.key===key)return {...hit.value};
  const wanted=new Map(rows.map(r=>[r.version,{rowId:r.version_row_id,summaryOnly:!!r.version_summary_only}])),changes=this.changeRows(id,[...wanted.keys()]);
  const value=pendingCounts({rows,classes:this.classes(id,wanted,changes),changes});
  this.countCache.delete(id);this.countCache.set(id,{key,value});if(this.countCache.size>COUNT_CACHE_LIMIT)this.countCache.delete(this.countCache.keys().next().value);
  return {...value};
 }
 attach(view){return {...view,version:view.revision,...(this.ready()?this.counts(view.project.document_id):{pending_count:null,pending_document_count:null}),history_available:this.ready()};}
 afterCommit(view){
  if(!view)return view;let state='complete';
  try{this.prune(view.project?.document_id??view.document_id);}catch{state='failed';}
  return {...view,history_cleanup:state};
 }
 prune(documentId){
  this.require();if(!documentId)return;
  this.board.tx(()=>{this.board.assets.lockDirectory();const head=this.db.prepare('SELECT * FROM storyboard_documents WHERE id=?').get(documentId);if(!head)return;this.board.project(head.project_id,true);const rows=this.db.prepare('SELECT id,version,updated_at FROM storyboard_versions WHERE document_id=? AND document_json IS NOT NULL ORDER BY version DESC').all(documentId);const retained=this.board.videoBindingV2?.retainedVersionNumbers(documentId);for(const r of rows.slice(50))if(r.version!==head.revision&&!retained?.has(r.version))this.db.prepare('UPDATE storyboard_versions SET document_json=NULL,byte_size=0,updated_at=? WHERE id=?').run(Math.max(Date.now(),r.updated_at+1),r.id);});
 }
 head(projectId){this.board.project(projectId);const head=this.board.head(projectId);if(!head)throw fail('STORYBOARD_NOT_INITIALIZED','请先初始化分镜',404);this.require();return head;}
 read(fn){if(this.db.kind==='mysql')this.db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');return this.db.transaction(fn)();}
 versions(projectId,{offset=0,limit=20}={}){
  if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw fail('INVALID_PAGE','分页无效');
  const h=this.head(projectId),metaCols=Object.keys(HISTORY_TABLES.storyboard_versions).map(k=>k==='document_json'?"CASE WHEN document_json IS NULL THEN NULL ELSE '' END AS document_json":k).join(',');
  const total=this.db.prepare('SELECT COUNT(*) n FROM storyboard_versions WHERE document_id=?').get(h.id).n;
  const rows=this.db.prepare(`SELECT ${metaCols} FROM storyboard_versions WHERE document_id=? ORDER BY version DESC LIMIT ? OFFSET ?`).all(h.id,limit,offset);
  const stats=this.db.prepare('SELECT SUM(byte_size) bytes, SUM(CASE WHEN document_json IS NULL THEN 0 ELSE 1 END) kept FROM storyboard_versions WHERE document_id=?').get(h.id);
  const length=this.db.kind==='mysql'?'OCTET_LENGTH(change_json)':'length(CAST(change_json AS BLOB))';
  const record=this.db.prepare(`SELECT SUM(${length}) bytes FROM storyboard_changes WHERE document_id=?`).get(h.id);
  const classes=this.classes(h.id,new Map(rows.map(r=>[r.version,{rowId:r.id,summaryOnly:!!r.summary_only}])));
  const contentShots=r=>{const cls=classes.get(r.version);return cls?[...cls.targets.keys()].filter(t=>t.startsWith('shot:')).length:r.changed_shot_count;};
  return {document_id:h.id,current_revision:h.revision,total,storage:{bytes:Number(stats.bytes||0),record_bytes:Number(record.bytes||0),kept_full:Number(stats.kept||0),limit:50,physical_bytes:null},items:rows.map(r=>({...this.meta(r),content_shot_count:contentShots(r)}))};
 }
 version(projectId,v){const h=this.head(projectId),r=this.row(h.id,v);const project=this.full(r);return {document_id:h.id,...this.meta(r),project};}
 diff(projectId,v,against='current'){const h=this.head(projectId),left=this.full(this.row(h.id,v)),right=against==='current'?JSON.parse(h.document_json):this.full(this.row(h.id,Number(against)));return {document_id:h.id,from_version:v,to_version:against==='current'?h.revision:Number(against),...storyboardDiff(left,right)};}
 changes(projectId,limit=20){const page=this.versions(projectId,{limit});return {document_id:page.document_id,current_revision:page.current_revision,items:page.items.map(v=>({...v,changes:this.db.prepare('SELECT change_json FROM storyboard_changes WHERE document_id=? AND version=? ORDER BY id').all(page.document_id,v.version).map(r=>JSON.parse(r.change_json))}))};}
 /** 改动记录展开一版：只读，不碰待看标记。只记摘要的大改在前后完整版都还在时重新比对出明细。 */
 versionChanges(projectId,v){
  const h=this.head(projectId),row=this.row(h.id,v);if(!row)throw fail('VERSION_NOT_FOUND','此版本尚未记录',404);
  const stored=this.changeRows(h.id,[v]).get(v)??[],pair=row.summary_only?this.snapshots(h.id,v):null,changes=pair?storyboardDiff(pair[0],pair[1]).changes:stored,meta=this.meta(row);
  const cls=classifyVersion(changes,()=>this.snapshots(h.id,v));
  return {document_id:h.id,current_revision:h.revision,...meta,detail:!row.summary_only?'full':pair?'rebuilt':'summary',metrics:stored.find(c=>c.field==='$summary')?.metrics??null,...versionView({meta:{version:meta.version,created_at:meta.created_at,author_kind:meta.author_kind,reason_category:meta.reason_category,reason_text:meta.reason_text,summary_only:false},changes,cls,project:JSON.parse(h.document_json)})};
 }
 pending(projectId){
  const h=this.head(projectId),rows=this.pendingRows(h.id),wanted=new Map(rows.map(r=>[r.version,{rowId:r.version_row_id,summaryOnly:!!r.version_summary_only}]));
  const changes=this.changeRows(h.id,[...wanted.keys()]),classes=this.classes(h.id,wanted,changes),view=pendingView({rows,classes,changes,project:JSON.parse(h.document_json),revision:h.revision});
  return {document_id:h.id,current_revision:h.revision,...this.counts(h.id),...view};
 }
 /** 原有 through_version + all/shot_ids 语义不变；version（只清这一版）和 target_ids（按目标）必须带 expected_revision。 */
 clear(projectId,input){return this.board.tx(()=>{
  this.board.assets.lockDirectory();this.board.project(projectId,true);const h=this.head(projectId);
  if(!integer(input.through_version))throw fail('VIEW_VERSION_REQUIRED','必须指定实际看过的版本');
  if(input.through_version>h.revision)throw fail('INVALID_VIEW_VERSION','看过的版本不能超出当前版本');
  const list=v=>Array.isArray(v)&&v.length>0&&v.length<=1000&&v.every(id=>typeof id==='string');
  const scopes=[input.all===true,input.shot_ids!==undefined,input.target_ids!==undefined].filter(Boolean).length;
  if(input.all===true&&scopes>1)throw fail('INVALID_INPUT','全部与指定镜头不能混用');
  if(scopes!==1||input.shot_ids!==undefined&&!list(input.shot_ids)||input.target_ids!==undefined&&!list(input.target_ids))throw fail('INVALID_INPUT','请指定镜头或全部实体');
  if(input.version!==undefined&&(!integer(input.version)||input.version>input.through_version))throw fail('INVALID_VIEW_VERSION','要清除的版本无效');
  if(input.version!==undefined||input.target_ids!==undefined){
   if(!integer(input.expected_revision))throw fail('EXPECTED_REVISION_REQUIRED','必须带上看到的当前版本');
   if(input.expected_revision!==h.revision)throw fail('PENDING_REVISION_CHANGED','分镜已有新版本，请重新查看后再确认',409,{current_revision:h.revision});
  }
  const shots=new Set(input.shot_ids??[]),targets=new Set(input.target_ids??[]),selected=this.pendingRows(h.id).filter(r=>r.version<=input.through_version&&(input.version===undefined||r.version===input.version)&&(input.all===true||shots.has(r.shot_id)||targets.has(r.target_id)));
  for(const row of selected){const now=Math.max(Date.now(),row.updated_at+1);this.db.prepare('UPDATE storyboard_pending SET cleared_at=?,updated_at=? WHERE id=? AND cleared_at IS NULL').run(now,now,row.id);}
  return {cleared_events:selected.length,skipped_shot_ids:(input.shot_ids??[]).filter(id=>!selected.some(r=>r.shot_id===id)),current_revision:h.revision,...this.counts(h.id)};
 });}
 category(projectId,v,input){return this.board.tx(()=>{this.board.assets.lockDirectory();this.board.project(projectId,true);const h=this.head(projectId),row=this.row(h.id,v);if(!row)throw fail('VERSION_NOT_FOUND','版本不存在',404);if(row.author_kind!=='agent'||!HISTORY_CATEGORIES.includes(input.reason_category))throw fail('INVALID_CHANGE_CATEGORY','只能修改agent事件的三类分类');if(input.expected_reason_category!==row.reason_category)throw fail('CHANGE_CATEGORY_CONFLICT','分类已被修改',409);this.db.prepare('UPDATE storyboard_versions SET reason_category=?,updated_at=? WHERE id=?').run(input.reason_category,Math.max(Date.now(),row.updated_at+1),row.id);return this.meta(this.row(h.id,v));});}
 snapshot(){this.require();return {schema_version:1,tables:Object.fromEntries(Object.keys(HISTORY_TABLES).map(t=>[t,this.db.prepare('SELECT * FROM '+t+' ORDER BY id').all()]))};}
 validateSnapshot(input,documents){
  if(!input||input.schema_version!==1||canonical(Object.keys(input.tables??{}).sort())!==canonical(Object.keys(HISTORY_TABLES).sort()))throw fail('HISTORY_BACKUP_INVALID','历史备份结构无效');
  const docs=new Map(documents.map(d=>[d.id,d])),versions=new Map(),ids=new Set(),requests=new Set();
  for(const [table,cols]of Object.entries(HISTORY_TABLES)){
   if(!Array.isArray(input.tables[table]))throw fail('HISTORY_BACKUP_INVALID','历史备份表无效');
   for(const row of input.tables[table]){
    if(canonical(Object.keys(row).sort())!==canonical(Object.keys(cols).sort())||!idOK(row.id)||ids.has(row.id)||!docs.has(row.document_id)||!integer(row.version)||row.version>docs.get(row.document_id).revision)throw fail('HISTORY_BACKUP_INVALID','历史备份身份无效');ids.add(row.id);
    for(const [col,type]of Object.entries(cols)){
     const value=row[col];if(type.startsWith('nullable')&&value===null)continue;
     if(type==='integer'||type==='nullableInteger'){if(!Number.isSafeInteger(value)||value<0)throw fail('HISTORY_BACKUP_INVALID','历史备份数字无效');}
     else if(typeof value!=='string')throw fail('HISTORY_BACKUP_INVALID','历史备份文字无效');
    }
    if(row.updated_at<row.created_at)throw fail('HISTORY_BACKUP_INVALID','历史时间无效');
    if(table==='storyboard_versions'){
     const key=row.document_id+':'+row.version;if(versions.has(key)||row.request_id&&requests.has(row.request_id)||!['user','agent','import','generation','restore','baseline'].includes(row.author_kind)||row.reason_category!==null&&!HISTORY_CATEGORIES.includes(row.reason_category))throw fail('HISTORY_BACKUP_INVALID','历史版本无效');
     if(row.request_id&&!idOK(row.request_id)||row.request_hash!==null&&!/^[a-f0-9]{64}$/.test(row.request_hash))throw fail('HISTORY_BACKUP_INVALID','历史请求无效');
     if(row.document_json!==null){const p=JSON.parse(row.document_json);if(p.document_id!==row.document_id||p.bound_project_id!==docs.get(row.document_id).project_id||p.revision!==row.version||Buffer.byteLength(row.document_json)!==row.byte_size)throw fail('HISTORY_BACKUP_INVALID','历史完整版无效');}else if(row.byte_size!==0)throw fail('HISTORY_BACKUP_INVALID','裁剪大小无效');
     versions.set(key,row);if(row.request_id)requests.add(row.request_id);
    }else if(!['shot','scene','document','segment'].includes(row.target_kind))throw fail('HISTORY_BACKUP_INVALID','历史实体无效');
    if(table==='storyboard_changes')JSON.parse(row.change_json);if(table==='storyboard_pending'&&!Array.isArray(JSON.parse(row.fields_json)))throw fail('HISTORY_BACKUP_INVALID','待看字段无效');
   }
  }
  for(const table of ['storyboard_changes','storyboard_pending'])for(const row of input.tables[table])if(!versions.has(row.document_id+':'+row.version))throw fail('HISTORY_BACKUP_INVALID','历史事件缺版本');
  return input;
 }
 restoreRows(input){
  this.require();for(const [table,rows]of Object.entries(input.tables))for(const row of rows){const old=this.db.prepare('SELECT * FROM '+table+' WHERE id=?').get(row.id);if(old){if(canonical(old)!==canonical(row))throw fail('HISTORY_BACKUP_CONFLICT','目标有不同历史，未覆盖',409);}else this.insert(table,row);}
 }

}
