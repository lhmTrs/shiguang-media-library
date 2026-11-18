import {videoV2Io} from './io-proof.mjs';
import {videoV2Backup} from './backup.mjs';
import {videoV2Migration} from './migration.mjs';
import {videoV2Protection} from './protection.mjs';
import {videoV2Origin} from './origin.mjs';
import {videoV2Mutations} from './mutations.mjs';
import {randomUUID} from 'node:crypto';
import {tablePresent} from '../storyboard/history-schema.mjs';
import {idOK} from '../project-assets/model.mjs';
import {V2_TABLES,v2Schema,SCHEMA_VERSION} from './schema.mjs';
import {captureSnapshot,compareSnapshot,rows,hash,canonical,fail,orderedShotIds} from './model.mjs';
import {snapshotDependencies} from './dependencies.mjs';
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const decode=value=>value==null?null:JSON.parse(value);
export class VideoBindingV2 {
 constructor({videos,instanceId}){this.videos=videos;this.lib=videos.lib;this.board=videos.storyboards;this.assets=videos.assets;this._instanceId=instanceId;this.closing=false;this.dependencyChecks=new Map();}
 get instanceId(){return typeof this._instanceId==='function'?this._instanceId():this._instanceId;}
 get db(){return this.lib.db;}
 get catalog(){return this.videos.catalog;}
 init({fresh=false}={}){
  const present=Object.keys(V2_TABLES).filter(t=>tablePresent(this.db,t));
  const empty=fresh&&!this.db.prepare("SELECT id FROM media_projects WHERE COALESCE(system_key,'')='' LIMIT 1").get()&&!this.db.prepare('SELECT id FROM roots LIMIT 1').get()&&!this.db.prepare('SELECT id FROM storyboard_documents LIMIT 1').get();
  if(empty&&!present.length)this.installSchema({fresh:true});
  this.videos.bindingV2=this;this.board.videoBindingV2=this;this.lib.videoBindingV2=this;return this;
 }
 installSchema({fresh=false}={}){
  for(const sql of v2Schema(this.db.kind==='mysql'))this.db.exec(sql);
  const now=Date.now();
  for(const [id,data]of [['global',{schemaVersion:SCHEMA_VERSION,instanceId:this.instanceId}],['migration',{schemaVersion:SCHEMA_VERSION,status:fresh?'complete':'pending',instanceId:this.instanceId}]])if(!this.db.prepare('SELECT id FROM storyboard_video_v2_state WHERE id=?').get(id))this.db.prepare('INSERT INTO storyboard_video_v2_state VALUES(?,?,?,?,?,?)').run(id,1,0,canonical(data),now,now);
  this.checkedDb=null;return this.schemaState();
 }
 schemaState(){
  const present=Object.keys(V2_TABLES).filter(t=>tablePresent(this.db,t));if(present.length!==7)return {schemaVersion:SCHEMA_VERSION,status:'schema-required'};
  const row=this.db.prepare('SELECT * FROM storyboard_video_v2_state WHERE id=?').get('migration');if(!row)return {schemaVersion:SCHEMA_VERSION,status:'unknown'};let data;try{data=decode(row.data_json);}catch{return {schemaVersion:SCHEMA_VERSION,status:'unknown'};}return {schemaVersion:data.schemaVersion,status:['complete','pending'].includes(data.status)?data.status:'unknown',...(data.counts&&{counts:Object.fromEntries(Object.entries(data.counts).filter(([k,v])=>['storyboard_video_takes','storyboard_video_plans','storyboard_video_requests'].includes(k)&&Number.isSafeInteger(v)&&v>=0))}),...(/^[a-f0-9]{64}$/.test(data.exportHash??'')&&{exportHash:data.exportHash})};
 }
 requireSchema(){
  if(this.checkedDb===this.db)return;
  for(const [table,columns]of Object.entries(V2_TABLES)){
   if(!tablePresent(this.db,table))fail('VIDEO_V2_MIGRATION_REQUIRED','视频绑定v2需要受控安装与迁移',503);
   const cols=this.db.kind==='mysql'?this.db.prepare('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?').all(table):this.db.prepare('PRAGMA table_info('+table+')').all();
   if(canonical(cols.map(c=>c.name).sort())!==canonical(Object.keys(columns).sort()))fail('VIDEO_V2_UNSETTLED','视频绑定v2表结构无法核验',503);
  }
  const row=this.stateRow('global');if(!row||decode(row.data_json).schemaVersion!==SCHEMA_VERSION)fail('VIDEO_V2_UNSETTLED','视频绑定v2实例状态无法核验',503);
  this.checkedDb=this.db;
 }
 require(){this.requireSchema();const migration=this.schemaState();if(migration.schemaVersion!==SCHEMA_VERSION)fail('VIDEO_V2_UNSETTLED','视频绑定v2版本无法核验',503);if(migration.status!=='complete')fail('VIDEO_V2_MIGRATION_REQUIRED','旧绑定尚未完成受控迁移',503,{migration});if(this.closing||this.videos.media.closing||this.lib.migrating)fail('VIDEO_V2_UNSETTLED','视频绑定正在关闭或迁移',503);}
 stateRow(id,lock=false){return this.db.prepare('SELECT * FROM storyboard_video_v2_state WHERE id=?'+(lock&&this.db.kind==='mysql'?' FOR UPDATE':'')).get(id);}
 lock(projectIds=[]){this.assets.lockDirectory();this.require();const row=this.stateRow('global',true);if(!row||!integer(row.sequence))fail('VIDEO_V2_UNSETTLED','全局事件序无法核验',503);for(const id of [...new Set(projectIds.filter(Boolean))].sort())this.board.project(id,true);}
 sequence(){const r=this.stateRow('global',true),sequence=r.sequence+1;if(!integer(sequence,1))fail('VIDEO_V2_UNSETTLED','事件序已达边界',503);this.db.prepare('UPDATE storyboard_video_v2_state SET sequence=?,revision=?,updated_at=? WHERE id=?').run(sequence,r.revision+1,Date.now(),'global');return sequence;}
 selectionRevision(projectId){const row=this.stateRow('selection:'+projectId);return row?.revision??0;}
 bumpSelection(projectId){const key='selection:'+projectId,old=this.stateRow(key),now=Date.now();if(old)this.db.prepare('UPDATE storyboard_video_v2_state SET revision=?,updated_at=? WHERE id=?').run(old.revision+1,now,key);else this.db.prepare('INSERT INTO storyboard_video_v2_state VALUES(?,?,?,?,?,?)').run(key,1,0,canonical({projectId}),now,now);return (old?.revision??0)+1;}
 insert(table,row){const keys=Object.keys(V2_TABLES[table]);this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`).run(...keys.map(k=>row[k]??null));}
 read(fn,{allowPending=false}={}){if(allowPending)this.requireSchema();else this.require();if(this.db.kind==='mysql')this.db.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');return this.db.transaction(fn)();}
 view(projectId,lock=false){
  this.board.project(projectId,lock);const head=this.board.head(projectId,lock),selectionRevision=this.selectionRevision(projectId);
  if(!head)return {head:null,project:null,context:{instanceId:this.instanceId,projectId,documentId:null,initializedAt:null,storyboardRevision:null,assetStamp:null,selectionRevision}};
  let view;try{view=this.board.hydrate(head);}catch(error){view={project:decode(head.document_json),project_id:projectId,asset_stamp:null,dependencyError:true};}
  return {...view,head,context:{instanceId:this.instanceId,projectId,documentId:head.id,initializedAt:head.initialized_at,storyboardRevision:head.revision,assetStamp:view.asset_stamp??null,selectionRevision}};
 }
 capture(view,shotIds,{allowMissing=false}={}){if(!view.project)fail('STORYBOARD_CONFLICT','目标尚未初始化分镜',409);return captureSnapshot({project:view.project,context:view.context,shotIds,dependencies:this.applyDependencyChecks(snapshotDependencies(this.board,view,shotIds)),allowMissing});}
 expectedView(view,revision,assetStamp){if(!view.head||view.head.revision!==revision)fail('STORYBOARD_CONFLICT','分镜版本已变化，请重新读取',409);if(!view.context.assetStamp||view.context.assetStamp!==assetStamp)fail('ASSET_CONTEXT_CHANGED','分镜使用的资产上下文已变化或无法核验',409);}
 historyVersion(view){this.board.history.require();const row=this.board.history.row(view.head.id,view.head.revision);if(!row)fail('VIDEO_V2_UNSETTLED','当前分镜尚未记录完整历史，不能伪造来历',503);if(row.document_json===null)fail('VERSION_PRUNED','当前版没有可保留的完整历史，不能补造生成出处',410);return row;}
 provenanceRow(id){if(!idOK(id))fail('VIDEO_V2_INVALID_INPUT','出处ID无效');const row=this.db.prepare('SELECT * FROM storyboard_video_v2_provenance WHERE id=?').get(id);if(!row)fail('VIDEO_V2_NOT_FOUND','出处不存在',404);return row;}
 provenanceDTO(row){return {provenanceId:row.id,instanceId:row.instance_id,projectId:row.project_id,documentId:row.document_id,initializedAt:row.initialized_at,storyboardRevision:row.storyboard_revision,shotIds:decode(row.shot_ids_json),createdAt:row.created_at,inputHash:row.input_hash};}
 bindingRow(videoId){return this.db.prepare('SELECT * FROM storyboard_video_v2_bindings WHERE video_id=?').get(videoId);}
 bindingShots(binding){return this.db.prepare('SELECT * FROM storyboard_video_v2_shots WHERE binding_id=? ORDER BY ordinal,id').all(binding.id);}
 assertBindable(sourceProjectId,videoId){try{return this.catalog.assertBindable(sourceProjectId,videoId);}catch(error){fail('VIDEO_BINDING_CONFLICT','视频当前不可用于绑定或采用',409,{mediaErrorCode:error.code??'SOURCE_UNVERIFIED'});}}
 source(sourceProjectId,videoId){this.board.project(sourceProjectId);if(!idOK(videoId))fail('VIDEO_V2_INVALID_INPUT','视频ID无效');return this.videos.source(sourceProjectId,videoId);}
 videoInfo(sourceProjectId,videoId){
  const source=this.source(sourceProjectId,videoId),meta=this.catalog.metadata(sourceProjectId,source),verification=this.catalog.verification.view(source);
  let status='unchecked',errorCode=null;
  if(meta.data.removedAt){status='missing';errorCode='SOURCE_REMOVED';}else if(!this.videos.authorized(source)||!this.catalog.isManaged(sourceProjectId,source)){status='untrusted';errorCode='SOURCE_UNTRUSTED';}else if(!source.supported){status='unsupported';errorCode='CODEC_UNSUPPORTED';}else if(verification.errorCode==='SOURCE_MISSING'){status='missing';errorCode='SOURCE_MISSING';}else if(verification.errorCode){status=verification.errorCode==='SOURCE_UNTRUSTED'?'untrusted':'changed';errorCode=verification.errorCode;}else if(verification.state==='verified')status='available';else if(verification.state==='content_changed'){status='changed';errorCode='SOURCE_CHANGED';}
  return {source,meta,status,errorCode,name:meta.data.title,videoRevision:meta.row?.revision??0,identity:hash({id:source.id,sha256:meta.data.contentFingerprint?null:meta.data.sha256,fingerprint:meta.data.contentFingerprint??null,durationMs:source.durationMs,codec:source.codec})};
 }
 bindingDTO(row,view=null){
  if(!row?.target_project_id)return null;view??=this.view(row.target_project_id);
  const same=view.context.documentId===row.document_id&&view.context.initializedAt===row.initialized_at,numbers=new Map((view.project?rows(view.project):[]).map(r=>[r.shot.id,r.number]));
  return {bindingId:row.id,revision:row.revision,targetProjectId:row.target_project_id,documentId:row.document_id,initializedAt:row.initialized_at,storyboardRevision:row.storyboard_revision,boundAt:row.bound_at,origin:row.origin,provenance:row.provenance_id?this.provenanceDTO(this.provenanceRow(row.provenance_id)):null,shots:this.bindingShots(row).map(s=>({shotId:s.shot_id,numberAtBinding:s.number_at_binding,durationMs:s.duration_ms,associationSeq:s.association_seq,existsInCurrent:same&&numbers.has(s.shot_id),currentNumber:same?(numbers.get(s.shot_id)??null):null}))};
 }
 reviewDTO(row,view=null,info=null){
  if(!row?.target_project_id)return null;view??=this.view(row.target_project_id);info??=this.videoInfo(row.source_project_id,row.video_id);
  const original=decode(row.snapshot_json),review=decode(row.review_json),base=review?.snapshot??original;
  let current;if(view.project)current=this.capture(view,base.shotIds,{allowMissing:true});else current={...base,context:view.context,shots:[],order:[]};
  const media=review?.videoIdentity??original.videoIdentity;
  const comparison=compareSnapshot(base,current,{videoChanged:media!==info.identity,mediaVerified:info.status==='available'});
  const semantic=current.shots.map(s=>({shotId:s.shotId,categories:s.categories,unverifiable:s.unverifiable}));
  return {...comparison,reviewedToRevision:row.review_revision,reviewedAt:row.reviewed_at,comparisonHash:hash({bindingId:row.id,bindingRevision:row.revision,context:current.context,semantic,order:current.order,videoIdentity:info.identity,mediaStatus:info.status})};
 }
 allowedTargets(sourceProjectId){
  const source=this.board.project(sourceProjectId),membership=this.lib.projectSeries?.membership(sourceProjectId),seriesId=membership?.series_id??null;
  const ids=seriesId?this.db.prepare('SELECT id FROM project_series_members WHERE series_id=?').all(seriesId).map(r=>r.id):[];
  return [...new Set([source.id,...ids])].map(id=>{const p=this.board.project(id);return {projectId:id,name:p.name,seriesId:this.lib.projectSeries?.membership(id).series_id??null};});
 }
 selectionRows(projectId,view){return view.head?this.db.prepare('SELECT * FROM storyboard_video_v2_selections WHERE target_project_id=? AND document_id=? AND initialized_at=?').all(projectId,view.head.id,view.head.initialized_at):[];}
 selectionView(row){if(!row)return null;const info=this.videoInfo(row.source_project_id,row.video_id);return {videoId:row.video_id,sourceProjectId:row.source_project_id,bindingId:row.binding_id,name:info.name,kind:row.kind,selectedAt:row.selected_at};}
 sourceBinding(sourceProjectId,videoId){return this.read(()=>{const info=this.videoInfo(sourceProjectId,videoId),row=this.bindingRow(videoId),view=row?.target_project_id?this.view(row.target_project_id):null;return {sourceProjectId,videoId,videoRevision:info.videoRevision,bindingRevision:row?.revision??0,binding:this.bindingDTO(row,view),review:this.reviewDTO(row,view,info),allowedTargets:this.allowedTargets(sourceProjectId),context:view?.context??null};});}
 state(projectId){return this.read(()=>{
  const view=this.view(projectId);if(!view.head)return {schemaVersion:2,initialized:false,context:view.context,migration:this.schemaState(),shots:[]};
  const candidates=this.db.prepare('SELECT s.* FROM storyboard_video_v2_shots s JOIN storyboard_video_v2_bindings b ON b.id=s.binding_id WHERE s.target_project_id=? AND s.document_id=? AND s.initialized_at=? AND b.target_project_id=s.target_project_id AND b.initialized_at=s.initialized_at ORDER BY s.association_seq DESC,s.video_id DESC').all(projectId,view.head.id,view.head.initialized_at);
  const grouped=Map.groupBy(candidates,c=>c.shot_id),selections=new Map(this.selectionRows(projectId,view).map(s=>[s.shot_id,s])),cache=new Map();
  const binding=id=>{if(!cache.has(id)){const row=this.bindingRow(id);cache.set(id,{row,info:this.videoInfo(row.source_project_id,id),review:this.reviewDTO(row,view)});}return cache.get(id);};
  const shots=rows(view.project).map(r=>{const list=grouped.get(r.shot.id)??[],selection=selections.get(r.shot.id),defaultId=selection?.video_id??list[0]?.video_id,chosen=defaultId?binding(defaultId):null;return {shotId:r.shot.id,number:r.number,adopted:this.selectionView(selection),defaultVideo:chosen?{videoId:defaultId,sourceProjectId:chosen.row.source_project_id,bindingId:chosen.row.id,name:chosen.info.name}:null,candidateCount:list.length,newVideoCount:selection?new Set(list.filter(c=>c.association_seq>selection.selection_seq&&c.video_id!==selection.video_id).map(c=>c.video_id)).size:0,needsReview:chosen?.review.needsReview??false,reviewReasons:chosen?.review.reasons??[]};});
  return {schemaVersion:2,initialized:true,context:view.context,migration:this.schemaState(),shots};
 });}
 shotVideos(projectId,shotId,{offset=0,limit=20}={}){return this.read(()=>{
  if(!integer(offset)||!integer(limit,1)||limit>100)fail('VIDEO_V2_INVALID_INPUT','分页范围无效');const view=this.view(projectId);if(!view.project||!rows(view.project).some(r=>r.shot.id===shotId))fail('SHOT_NOT_FOUND','当前镜头不存在',404);
  const args=[projectId,view.head.id,view.head.initialized_at,shotId],total=this.db.prepare('SELECT COUNT(*) n FROM storyboard_video_v2_shots WHERE target_project_id=? AND document_id=? AND initialized_at=? AND shot_id=?').get(...args).n;
  const selected=this.db.prepare('SELECT * FROM storyboard_video_v2_shots WHERE target_project_id=? AND document_id=? AND initialized_at=? AND shot_id=? ORDER BY association_seq DESC,video_id DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
  const items=selected.map(s=>{const row=this.bindingRow(s.video_id),info=this.videoInfo(s.source_project_id,s.video_id);return {videoId:s.video_id,sourceProjectId:s.source_project_id,name:info.name,durationMs:info.source.durationMs,status:info.status,errorCode:info.errorCode,mediaUrl:`/api/project-videos/projects/${s.source_project_id}/videos/${s.video_id}/media`,thumbnailUrl:info.status==='available'&&info.meta.data.mediaAssetId?`/api/media/${info.meta.data.mediaAssetId}/thumb`:null,videoRevision:info.videoRevision,binding:this.bindingDTO(row,view),review:this.reviewDTO(row,view,info)};});
  return {context:view.context,shotId,total,offset,limit,items};
 });}
 replay(operation,scope,input){const row=this.db.prepare('SELECT * FROM storyboard_video_v2_requests WHERE id=?').get(input.requestId);if(!row)return null;if(row.operation!==operation||row.scope!==scope||row.request_hash!==hash(input))fail('REQUEST_ID_CONFLICT','请求编号已用于其他输入或项目',409);const result=decode(row.result_json);if(row.status==='rejected')fail(result.code,result.message,result.status,result.details);return {...result,repeated:true};}
 request(requestId){if(!idOK(requestId))fail('VIDEO_V2_INVALID_INPUT','请求ID无效');return this.read(()=>{const row=this.db.prepare('SELECT * FROM storyboard_video_v2_requests WHERE id=?').get(requestId);if(!row)fail('VIDEO_V2_NOT_FOUND','未发现此请求回执',404);return {requestId,status:row.status,operation:row.operation,...(row.status==='committed'?{result:decode(row.result_json)}:{error:decode(row.result_json)})};},{allowPending:true});}
 mutation(operation,scope,input,projectIds,fn){
  this.require();if(!input||!idOK(input.requestId))fail('VIDEO_V2_INVALID_INPUT','请保留有效requestId');
  const run=()=>{this.lock(projectIds);const repeated=this.replay(operation,scope,input);if(repeated)return repeated;const result={...fn(),requestId:input.requestId,repeated:false},now=Date.now();this.insert('storyboard_video_v2_requests',{id:input.requestId,operation,scope,request_hash:hash(input),status:'committed',result_json:canonical(result),created_at:now,updated_at:now});return result;};
  try{return this.assets.tx(run);}catch(error){
   if([400,404,409,410].includes(error.status)&&error.code!=='REQUEST_ID_CONFLICT')try{this.assets.tx(()=>{this.lock(projectIds);if(this.db.prepare('SELECT id FROM storyboard_video_v2_requests WHERE id=?').get(input.requestId))return;const now=Date.now();this.insert('storyboard_video_v2_requests',{id:input.requestId,operation,scope,request_hash:hash(input),status:'rejected',result_json:canonical({code:error.code,message:error.message,status:error.status,details:error.details??{}}),created_at:now,updated_at:now});});}catch{}
   throw error;
  }
 }
 event(type,{binding=null,provenance=null,before=null,after=null,view=null}={}){const now=Date.now(),context=view?.context??(binding?.target_project_id?{projectId:binding.target_project_id,documentId:binding.document_id,initializedAt:binding.initialized_at,storyboardRevision:binding.storyboard_revision}:null);this.insert('storyboard_video_v2_events',{id:randomUUID(),binding_id:binding?.id??null,provenance_id:provenance?.id??binding?.provenance_id??null,project_id:context?.projectId??null,document_id:context?.documentId??null,initialized_at:context?.initializedAt??null,storyboard_revision:context?.storyboardRevision??null,event_type:type,sequence:this.sequence(),before_json:before===null?null:canonical(before),after_json:after===null?null:canonical(after),created_at:now,updated_at:now});}
 retainedVersionNumbers(documentId){this.checkedDb=null;this.require();const result=new Set();for(const p of this.db.prepare('SELECT status FROM storyboard_video_v2_provenance WHERE document_id=?').all(documentId))if(!['reserved','bound','released'].includes(p.status))fail('VIDEO_V2_UNSETTLED','未知出处保留状态，已停止裁剪',503);for(const row of this.db.prepare("SELECT storyboard_revision version FROM storyboard_video_v2_provenance WHERE document_id=? AND status IN ('reserved','bound') UNION SELECT storyboard_revision version FROM storyboard_video_v2_bindings WHERE document_id=? UNION SELECT storyboard_revision version FROM storyboard_video_v2_events WHERE document_id=?").all(documentId,documentId,documentId)){if(!integer(row.version,1))fail('VIDEO_V2_UNSETTLED','保留版本引用损坏',503);result.add(row.version);}return result;}
}
export const V2_INTERNAL={integer,decode};

Object.assign(VideoBindingV2.prototype,videoV2Mutations);

Object.assign(VideoBindingV2.prototype,videoV2Origin);

Object.assign(VideoBindingV2.prototype,videoV2Protection);

Object.assign(VideoBindingV2.prototype,videoV2Backup,videoV2Migration);

Object.assign(VideoBindingV2.prototype,videoV2Io);
