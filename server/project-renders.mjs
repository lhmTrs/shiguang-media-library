import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,idOK} from './project-assets/model.mjs';
import {usageFail as fail} from './project-videos/action-journal.mjs';
import {renderFault} from './project-videos/media-info.mjs';
import express from 'express';
import {usageError} from './project-videos/action-journal.mjs';

export const RENDER_SCHEMA_VERSION=2;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const emptyVerification=()=>({state:'unchecked',match:null,metadataChanged:false});
const sameContent=(a,b)=>a?.sha256&&a.sha256===b?.sha256||a?.contentFingerprint&&b?.contentFingerprint&&canonical(a.contentFingerprint)===canonical(b.contentFingerprint);
const legacyMatches=(st,p)=>st.isFile()&&!st.isSymbolicLink()&&String(st.dev)===p.dev&&String(st.ino)===p.ino&&st.size===p.size&&st.mtimeMs===p.mtime;
function shape(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||canonical(Object.keys(v).sort())!==canonical([...keys].sort()))fail('RENDER_BACKUP_INVALID','成片资料结构无效');}
export function validateRenderPayload(p){
 if(p?.schemaVersion!==2){shape(p,['path','offset','dev','ino','size','mtime','updatedAt']);if(typeof p.dev!=='string'||typeof p.ino!=='string'||!integer(p.size)||!Number.isFinite(p.mtime))fail('RENDER_BACKUP_INVALID','旧成片身份无效');}
 else {
  shape(p,['schemaVersion','link','sourceId','offset','linkedTimelineRevision','linkedSourceRevision','proof','snapshot','updatedAt']);
  if(![null,'project-video','legacy-path'].includes(p.link))fail('RENDER_BACKUP_INVALID','成片关联类型无效');
  if(p.link===null){if(p.sourceId!==null||p.proof!==null||p.snapshot!==null||p.linkedSourceRevision!==null||p.linkedTimelineRevision!==null||p.offset!==0)fail('RENDER_BACKUP_INVALID','成片解除记录无效');}
  else if(p.link==='project-video'){
   if(!idOK(p.sourceId)||!integer(p.linkedSourceRevision)||typeof p.linkedTimelineRevision!=='string'||!p.linkedTimelineRevision||p.linkedTimelineRevision.length>240)fail('RENDER_BACKUP_INVALID','成片来源修订无效');
   shape(p.proof,['sha256','contentFingerprint']);if(!/^[a-f0-9]{64}$/.test(p.proof.sha256))fail('RENDER_BACKUP_INVALID','成片内容证明无效');
   if(p.proof.contentFingerprint!==null){shape(p.proof.contentFingerprint,['version','hash']);if(p.proof.contentFingerprint.version!=='sg-media-content-v1'||!/^[a-f0-9]{64}$/.test(p.proof.contentFingerprint.hash))fail('RENDER_BACKUP_INVALID','成片媒体证明无效');}
   shape(p.snapshot,['name','path','folder','video']);if(typeof p.snapshot.name!=='string'||p.snapshot.name.length>240||!validPath(p.snapshot.path))fail('RENDER_BACKUP_INVALID','成片显示快照无效');
   if(p.snapshot.folder!==null){shape(p.snapshot.folder,['id','parentId','name','relativePath','role','locked','available']);const f=p.snapshot.folder;if(!idOK(f.id)||f.parentId!=='root'&&!idOK(f.parentId)||typeof f.name!=='string'||typeof f.relativePath!=='string'||![null,'final','reject'].includes(f.role)||typeof f.locked!=='boolean'||typeof f.available!=='boolean')fail('RENDER_BACKUP_INVALID','成片目录快照无效');}
   shape(p.snapshot.video,['codec','width','height','durationMs','bytes']);const v=p.snapshot.video;if(v.codec!==null&&typeof v.codec!=='string'||['width','height','durationMs','bytes'].some(k=>v[k]!==null&&(!integer(v[k])||v[k]<1)))fail('RENDER_BACKUP_INVALID','成片媒体快照无效');
  }else {if(p.sourceId!==null||p.linkedSourceRevision!==null||p.linkedTimelineRevision!==null||p.proof!==null)fail('RENDER_BACKUP_INVALID','旧成片关联无效');validateRenderPayload(p.snapshot);}
 }
 if(!Number.isFinite(p.offset)||Math.abs(p.offset)>86400||!integer(p.updatedAt)||p.updatedAt<1||p.schemaVersion!==2&&!validPath(p.path))fail('RENDER_BACKUP_INVALID','成片偏移或时间无效');
 return p;
}

export function projectRenderRouter(store,{sendMedia,withActivity=fn=>fn()}={}){
 const router=express.Router({mergeParams:true}),wrap=fn=>(req,res,next)=>{try{Promise.resolve(withActivity(()=>store.catalog.media.track(()=>fn(req,res)))).catch(next);}catch(e){next(e);}};
 const ids=req=>[req.params.projectId,req.params.timelineId],send=(res,v)=>res.status(['checking','running'].includes(v.status)?202:200).json(v);
 router.use(express.json({limit:'2mb'}));router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
 router.get('/',wrap(async(req,res)=>res.json(await store.get(...ids(req),{schema:req.query.schema}))));
 router.get('/sources',wrap(async(req,res)=>res.json(await store.sources(...ids(req),req.query))));
 router.get('/requests/:requestId',wrap((req,res)=>res.json(store.request(...ids(req),req.params.requestId))));
 router.post('/',wrap(async(req,res)=>send(res,await store.save(...ids(req),req.body))));
 router.delete('/',wrap(async(req,res)=>send(res,await store.remove(...ids(req),req.body))));
 router.post('/choose',wrap(()=>fail('RENDER_LEGACY_SELECTION_DISABLED','请先将视频导入项目，再选择成片',410)));
 const media=wrap(async(req,res)=>{
  const c=store.catalog,opened=await store.open(...ids(req),{renderRevision:req.query.renderRevision});let released=false;
  const release=()=>{if(released)return;released=true;c.media.responses.delete(res);void c.media.release(opened.handle).catch(()=>{});};
  c.media.responses.add(res);res.once('close',release);res.once('finish',release);
  try{await sendMedia(req,res,opened.path,opened.handle);}catch(e){release();throw e;}
 });
 router.get('/media',media);router.head('/media',media);
 router.use((e,_req,res,_next)=>{if(res.destroyed||res.writableEnded)return;if(res.headersSent){res.destroy();return;}res.status(e.status||503).json(usageError(e));});return router;
}
const validPath=v=>typeof v==='string'&&path.isAbsolute(v)&&v.length<=8192&&!/[\x00-\x1f\x7f]/.test(v);
export function renderColumns(db){return db.kind==='mysql'?db.prepare("SELECT COLUMN_NAME name,DATA_TYPE type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_renders'").all():db.prepare('PRAGMA table_info(project_renders)').all();}
export async function migrateRenderSchema(db,{apply=false,backupFile}={}){
 const columns=renderColumns(db),names=columns.map(c=>c.name).sort();
 if(canonical(names)!==canonical(['id','payload','project_id'])&&canonical(names)!==canonical(['id','payload','project_id','revision']))fail('RENDER_SCHEMA_UNSUPPORTED','成片表包含未知表列，未执行迁移',503);
 const revision=columns.find(c=>c.name==='revision');if(revision&&!/^(integer|bigint|int)$/i.test(revision.type))fail('RENDER_SCHEMA_UNSUPPORTED','成片修订必须是整数类型',503);
 if(revision)return{schemaVersion:2,needed:false,applied:false};
 const rows=db.prepare('SELECT * FROM project_renders ORDER BY id').all();for(const row of rows)validateRenderPayload(JSON.parse(row.payload));
 const sql=`ALTER TABLE project_renders ADD COLUMN revision ${db.kind==='mysql'?'BIGINT':'INTEGER'} NOT NULL DEFAULT 1`;
 if(!apply)return{schemaVersion:1,needed:true,applied:false,rowCount:rows.length,sql};
 if(!validPath(backupFile))fail('INVALID_INPUT','显式迁移必须指定新的绝对备份文件路径');
 const backup={format:'shiguang-project-renders',schemaVersion:1,columns,rows};await fs.writeFile(backupFile,JSON.stringify(backup),{flag:'wx',mode:0o600});
 const current=db.prepare('SELECT * FROM project_renders ORDER BY id').all();if(canonical(current)!==canonical(rows))fail('RENDER_CONFLICT','备份后成片记录变化，未执行迁移',409);
 db.exec(sql);const after=db.prepare('SELECT * FROM project_renders ORDER BY id').all();
 if(canonical(after.map(({revision,...row})=>row))!==canonical(rows)||after.some(r=>r.revision!==1))fail('RENDER_SCHEMA_UNSUPPORTED','迁移后核对失败，请保留备份与现场',503);
 return{schemaVersion:2,needed:true,applied:true,rowCount:rows.length,backupFile};
}
export class ProjectRenders {
 constructor(projects){this.projects=projects;this.lib=projects.lib;}
 get db(){return this.lib.db;}
 get catalog(){const c=this.lib.storyboardVideos?.catalog;if(!c)fail('RENDER_INFO_UNAVAILABLE','项目视频管理尚未就绪',503);return c;}
 init(){const mysql=this.db.kind==='mysql';this.db.exec(`CREATE TABLE IF NOT EXISTS project_renders (id ${mysql?'VARCHAR(36)':'TEXT'} PRIMARY KEY,project_id ${mysql?'VARCHAR(36)':'TEXT'} NOT NULL,payload ${mysql?'LONGTEXT':'TEXT'} NOT NULL,revision ${mysql?'BIGINT':'INTEGER'} NOT NULL DEFAULT 1)${mysql?' ENGINE=InnoDB':''}`);this.lib.projectRenders=this;return this;}
 validate(projectId,timelineId){this.projects.get(projectId);const t=this.db.prepare('SELECT * FROM project_timelines WHERE project_id=? AND id=?').get(projectId,timelineId);if(!t)fail('TIMELINE_NOT_FOUND','时间线不存在，请重新读取',404);return t;}
 row(projectId,timelineId){return this.db.prepare('SELECT * FROM project_renders WHERE project_id=? AND id=?').get(projectId,timelineId);}
 revision(row){const value=row?(row.revision??1):0;if(!integer(value))fail('RENDER_SCHEMA_UNSUPPORTED','成片修订号不是有效整数',503);return value;}
 payload(row){return row?validateRenderPayload(JSON.parse(row.payload)):null;}
 async get(projectId,timelineId,{schema=1}={}){
  const timeline=this.validate(projectId,timelineId),db=this.db,row=this.row(projectId,timelineId),p=this.payload(row),revision=this.revision(row),link=p?.schemaVersion===2?p.link:p?'legacy-path':null;
  const result={schemaVersion:2,projectId,timelineId,link,sourceId:null,name:null,folder:null,path:null,offset:p?.offset??0,revision,updatedAt:p?.updatedAt??null,sourceRevision:null,linkedSourceRevision:null,timelineRevision:timeline.revision,linkedTimelineRevision:null,availability:null,verification:emptyVerification(),playback:{supported:null,canPlay:false,reasonCode:'RENDER_NOT_LINKED',mediaUrl:null},sync:{state:'not_linked',canSynchronize:false},video:null};
  const mediaUrl=`/api/projects/${projectId}/timelines/${timelineId}/render/media?renderRevision=${revision}`;
  if(link==='legacy-path'){
   const old=p.schemaVersion===2?p.snapshot:p;Object.assign(result,{path:old.path,name:path.basename(old.path),availability:'available',sync:{state:'legacy_unverified',canSynchronize:false}});
   try{const st=await fs.lstat(old.path);if(!legacyMatches(st,old)||await fs.realpath(old.path)!==old.path)throw Error('changed');result.verification={state:'verified',match:'legacy_stat',metadataChanged:false};result.playback={supported:null,canPlay:true,reasonCode:null,mediaUrl};}
   catch(e){result.availability=e.code==='ENOENT'?'missing':'unavailable';result.verification={state:'needs_verification',match:null,metadataChanged:false};result.playback.reasonCode=e.code==='ENOENT'?'RENDER_LEGACY_PATH_MISSING':'RENDER_LEGACY_REVIEW_REQUIRED';}
  }else if(link==='project-video'){
   Object.assign(result,{sourceId:p.sourceId,name:p.snapshot.name,path:p.snapshot.path,folder:p.snapshot.folder,video:p.snapshot.video,linkedSourceRevision:p.linkedSourceRevision,linkedTimelineRevision:p.linkedTimelineRevision});
   let source;try{source=this.catalog.videos.source(projectId,p.sourceId);}catch{}
   let sourceChanged=true;
   if(source){
    const c=this.catalog,dto=await c.mediaInfo.project(projectId,source),meta=c.metadata(projectId,source).data;
    Object.assign(result,{sourceRevision:dto.sourceRevision,availability:dto.availability,verification:dto.verification,video:{codec:dto.codec,width:dto.width,height:dto.height,durationMs:dto.durationMs,bytes:dto.bytes}});
    if(dto.managed){result.path=source.path;result.name=dto.name;result.folder=dto.folder;}
    const matches=!!sameContent(p.proof,meta);if(!matches)result.verification={state:'content_changed',match:null,metadataChanged:false};
    const reason=!matches?'RENDER_SOURCE_CHANGED':dto.disabledReasons.find(r=>r.code!=='RENDER_IN_REJECT_AREA')?.code??null;
    result.playback={supported:dto.playback.supported,canPlay:!reason,reasonCode:reason,mediaUrl:reason?null:mediaUrl};
    sourceChanged=!!reason;
   }else{result.availability='removed';result.playback.reasonCode='RENDER_SOURCE_REMOVED';}
   let state=sourceChanged?'source_changed':timeline.revision!==p.linkedTimelineRevision?'timeline_changed':'aligned';
   const duration=JSON.parse(timeline.snapshot).duration;
   if(state==='aligned'&&Number.isFinite(duration)&&result.video?.durationMs!=null&&Math.abs(result.video.durationMs/1000-(duration+p.offset))>1)state='duration_mismatch';
   result.sync={state,canSynchronize:state==='aligned'};
  }
  if(this.db!==db)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化',409);
  return Number(schema)===2?result:link?{path:result.path,offset:result.offset,updatedAt:result.updatedAt}:null;
 }
 async sources(projectId,timelineId,options={}){
  const timeline=this.validate(projectId,timelineId),c=this.catalog,db=this.db,page=options.page===undefined?1:Number(options.page),pageSize=options.pageSize===undefined?50:Number(options.pageSize),q=options.q??'',folderId=options.folderId??'all';
  if(!Number.isSafeInteger(page)||page<1||![20,50,60,100,200].includes(pageSize)||typeof q!=='string'||q.length>240||typeof folderId!=='string')fail('INVALID_INPUT','选片分页或筛选条件无效');
  const rows=c.folders.rows(projectId),roles=await c.finalFolder.roles(projectId);if(!['all','root'].includes(folderId)&&!rows.some(r=>r.id===folderId))fail('FOLDER_NOT_FOUND','文件夹不属于本项目',404);
  const candidates=c.videos.sources(projectId).filter(s=>!c.metadata(projectId,s).data.removedAt&&(folderId==='all'||c.folders.folderId(projectId,s.path,rows)===folderId)).filter(s=>{const m=c.metadata(projectId,s).data;return (m.title+'\n'+s.name).toLowerCase().includes(q.toLowerCase());});
  const items=[];for(const s of candidates.slice((page-1)*pageSize,page*pageSize))items.push(await c.mediaInfo.project(projectId,s,{rows,roles}));
  if(this.db!==db)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化',409);
  return{schemaVersion:1,projectId,timelineId,timelineRevision:timeline.revision,items,total:candidates.length,page,pages:Math.max(1,Math.ceil(candidates.length/pageSize)),pageSize,folders:rows.map(r=>({id:r.id,parentId:r.parentId,name:r.name,relativePath:r.relativePath,role:r.id===roles.finalFolderId?'final':r.id===roles.rejectFolderId?'reject':null,locked:r.id===roles.finalFolderId,available:r.id!==roles.finalFolderId||roles.finalState==='ready'})),folderRoles:roles};
 }
 normalize(input,unlink=false){
  if(input&&Object.hasOwn(input,'path'))fail('RENDER_PATH_NOT_ALLOWED','请从本项目视频中选择成片');
  if(!input||!idOK(input.requestId))fail('INVALID_REQUEST_ID','请提供固定请求编号');
  const keys=unlink?['requestId','expectedRevision']:['requestId','sourceId','offset','expectedRevision','expectedSourceRevision','expectedTimelineRevision'];
  if(Object.keys(input).some(k=>!keys.includes(k))||!integer(input.expectedRevision)||!unlink&&(!idOK(input.sourceId)||!integer(input.expectedSourceRevision)||typeof input.expectedTimelineRevision!=='string'||!input.expectedTimelineRevision||input.expectedTimelineRevision.length>240||!Number.isFinite(input.offset)||Math.abs(input.offset)>86400))fail('INVALID_INPUT','请提供来源、修订号与有限秒数偏移');
  return Object.fromEntries(keys.map(k=>[k,input[k]]));
 }
 requireSchema(){if(!renderColumns(this.db).some(c=>c.name==='revision'))fail('RENDER_SCHEMA_MIGRATION_REQUIRED','旧库需先显式备份并迁移成片修订列',503);}
 assertRevision(id,tid,n){const current=this.revision(this.row(id,tid));if(current!==n)fail('RENDER_CONFLICT','成片关联已被其他操作更新，请重新读取',409,{currentRevision:current});if(current>=Number.MAX_SAFE_INTEGER)fail('RENDER_CONFLICT','成片修订号已到上限',409);}
 write(id,tid,input,p){this.requireSchema();this.assertRevision(id,tid,input.expectedRevision);const row=this.row(id,tid);if(row){const r=this.db.prepare('UPDATE project_renders SET payload=?,revision=? WHERE project_id=? AND id=? AND revision=?').run(canonical(p),input.expectedRevision+1,id,tid,input.expectedRevision);if(r.changes!==1)fail('RENDER_CONFLICT','成片关联已变化',409);}else{try{this.db.prepare('INSERT INTO project_renders(id,project_id,payload,revision) VALUES(?,?,?,?)').run(tid,id,canonical(p),1);}catch(e){if(['SQLITE_CONSTRAINT_PRIMARYKEY','SQLITE_CONSTRAINT_UNIQUE','ER_DUP_ENTRY'].includes(e.code))fail('RENDER_CONFLICT','成片关联已变化',409);throw e;}}}
 async mutate(id,tid,raw,unlink=false){
  this.validate(id,tid);let input;try{input=this.normalize(raw,unlink);}catch(e){e.accepted=false;e.requestId=idOK(raw?.requestId)?raw.requestId:undefined;throw e;}
  const c=this.catalog,j=c.usageJournal;if(!unlink){try{c.mediaInfo.source(id,input.sourceId);}catch(e){e.accepted=false;e.requestId=input.requestId;throw e;}}
  return j.start(id,tid,unlink?'render-unlink':'render-link',input,'render:'+tid,async s=>{
   j.guard(s);this.requireSchema();this.assertRevision(id,tid,input.expectedRevision);const t=this.validate(id,tid);
   let p={schemaVersion:2,link:null,sourceId:null,offset:0,linkedTimelineRevision:null,linkedSourceRevision:null,proof:null,snapshot:null,updatedAt:Date.now()},dto;
   if(!unlink){
    let source=c.mediaInfo.source(id,input.sourceId),meta=c.metadata(id,source);
    if(meta.row?.revision!==input.expectedSourceRevision||t.revision!==input.expectedTimelineRevision)fail('RENDER_CONFLICT','来源或时间线修订已变化',409);
    if(meta.data.removedAt)renderFault('RENDER_SOURCE_REMOVED');if(!c.isManaged(id,source))renderFault('RENDER_SOURCE_UNTRUSTED');
    if(c.folders.inRejectArea(id,c.folders.folderId(id,source.path)))renderFault('RENDER_IN_REJECT_AREA',{sourceId:source.id,folderId:c.folders.folderId(id,source.path)});
    const info=c.mediaInfo.info(source,meta.data);if(info.supported!==true)renderFault(info.supported===false?'RENDER_CODEC_UNSUPPORTED':'RENDER_INFO_REQUIRED',{sourceId:source.id,codec:info.codec});
    try{source=await c.verifiedSource(id,source.id);}catch(e){j.guard(s);if(e.code==='SOURCE_MISSING')renderFault('RENDER_SOURCE_MISSING');renderFault(c.verification.view(source).state==='content_changed'?'RENDER_SOURCE_CHANGED':'RENDER_SOURCE_REVIEW_REQUIRED');}
    j.guard(s);this.assertRevision(id,tid,input.expectedRevision);if(this.validate(id,tid).revision!==input.expectedTimelineRevision)fail('RENDER_CONFLICT','时间线在核验期间变化',409);
    meta=c.metadata(id,source);const context=await c.verification.capture(id,source.id);j.guard(s);
    const checked=await c.hash(source.path,source.identity);j.guard(s);if(checked.hash!==meta.data.sha256)renderFault('RENDER_SOURCE_REVIEW_REQUIRED');
    await c.verification.checkLocation(context);j.guard(s);await c.media.verify(source);j.guard(s);
    dto=await c.mediaInfo.project(id,source);j.guard(s);if(!dto.selectable)renderFault(dto.disabledReasons[0].code);
    c.verification.assertAuthority(context);
    p={schemaVersion:2,link:'project-video',sourceId:source.id,offset:input.offset,linkedTimelineRevision:t.revision,linkedSourceRevision:meta.row.revision,proof:{sha256:meta.data.sha256,contentFingerprint:meta.data.contentFingerprint??null},snapshot:{name:dto.name,path:source.path,folder:dto.folder,video:{codec:dto.codec,width:dto.width,height:dto.height,durationMs:dto.durationMs,bytes:dto.bytes}},updatedAt:Date.now()};
    s.checkedAuthority=context.authority;
   }
   // Compose without asynchronous IO inside the transaction. The receipt is
   // the exact historical result committed with revision+1.
   const prior=await this.get(id,tid,{schema:2});j.guard(s);
   let held;try{if(!unlink){const current=c.videos.source(id,input.sourceId);held=await c.media.open(current);j.guard(s);if(c.verification.authority(id,input.sourceId)!==s.checkedAuthority)fail('RENDER_CONFLICT','来源在确认前变化',409);}
   c.videos.tx(()=>{
    j.guard(s);c.project(id,true);const current=this.validate(id,tid);
    if(!unlink&&(current.revision!==input.expectedTimelineRevision||c.verification.authority(id,input.sourceId)!==s.checkedAuthority))fail('RENDER_CONFLICT','来源、权限或时间线在确认时变化',409);
    this.write(id,tid,input,p);
    const render={...prior,link:p.link,sourceId:p.sourceId,name:p.snapshot?.name??null,path:p.snapshot?.path??null,folder:p.snapshot?.folder??null,offset:p.offset,revision:input.expectedRevision+1,updatedAt:p.updatedAt,sourceRevision:p.linkedSourceRevision,linkedSourceRevision:p.linkedSourceRevision,timelineRevision:current.revision,linkedTimelineRevision:p.linkedTimelineRevision,availability:unlink?null:'available',verification:unlink?emptyVerification():dto.verification,playback:{supported:unlink?null:dto.playback.supported,canPlay:!unlink,reasonCode:unlink?'RENDER_NOT_LINKED':null,mediaUrl:unlink?null:`/api/projects/${id}/timelines/${tid}/render/media?renderRevision=${input.expectedRevision+1}`},sync:{state:unlink?'not_linked':'aligned',canSynchronize:!unlink},video:p.snapshot?.video??null};
    const duration=JSON.parse(current.snapshot).duration;if(!unlink&&Number.isFinite(duration)&&Math.abs(render.video.durationMs/1000-(duration+p.offset))>1)render.sync={state:'duration_mismatch',canSynchronize:false};
    j.complete(s,{render});
   });}finally{if(held)await c.media.release(held.handle);}
  });
 }
 save(id,tid,input){return this.mutate(id,tid,input);}
 remove(id,tid,input){return this.mutate(id,tid,input,true);}
 request(id,tid,requestId){this.validate(id,tid);return this.catalog.usageJournal.dto(this.catalog.usageJournal.row(id,requestId,tid));}
 async open(id,tid,{renderRevision}={}){
  this.validate(id,tid);const c=this.catalog,db=this.db,row=this.row(id,tid),revision=this.revision(row),p=this.payload(row);
  if(renderRevision!==undefined&&(!/^\d+$/.test(String(renderRevision))||!integer(Number(renderRevision))||Number(renderRevision)!==revision))fail('RENDER_CONFLICT','成片关联已变化，请重新读取',409,{currentRevision:revision});
  if(!p||p.schemaVersion===2&&p.link===null)fail('RENDER_NOT_LINKED','尚未关联成片',404);
  const guard=()=>{if(this.db!==db)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化',409);this.validate(id,tid);if(this.revision(this.row(id,tid))!==revision||this.row(id,tid).payload!==row.payload)fail('RENDER_CONFLICT','成片关联已变化，请重新读取',409);};
  let opened,file;
  try{
   if(p.schemaVersion!==2||p.link==='legacy-path'){
    const old=p.schemaVersion===2?p.snapshot:p;file=old.path;
    const st=await fs.lstat(file);guard();if(!legacyMatches(st,old))fail('RENDER_LEGACY_REVIEW_REQUIRED','旧成片文件身份已变化，请先核对',409);
    opened=await c.media.open({path:file,identity:{dev:old.dev,ino:old.ino,size:old.size,mtimeMs:old.mtime,ctimeMs:st.ctimeMs}});guard();if(!legacyMatches(await opened.handle.stat(),old))fail('RENDER_LEGACY_REVIEW_REQUIRED','旧成片文件身份已变化',409);
   }else{
    let source=c.mediaInfo.source(id,p.sourceId),m=c.metadata(id,source);if(m.data.removedAt)renderFault('RENDER_SOURCE_REMOVED');if(!c.isManaged(id,source))renderFault('RENDER_SOURCE_UNTRUSTED');
    try{source=await c.verifiedSource(id,p.sourceId);}catch(e){guard();if(e.code==='SOURCE_MISSING')renderFault('RENDER_SOURCE_MISSING');renderFault(c.verification.view(source).state==='content_changed'?'RENDER_SOURCE_CHANGED':'RENDER_SOURCE_REVIEW_REQUIRED');}
    guard();m=c.metadata(id,source);if(!sameContent(p.proof,m.data))renderFault('RENDER_SOURCE_CHANGED');
    const authority=c.verification.authority(id,p.sourceId),context=await c.verification.capture(id,p.sourceId);guard();
    const info=c.mediaInfo.info(source,m.data);if(info.supported!==true)renderFault(info.supported===false?'RENDER_CODEC_UNSUPPORTED':'RENDER_INFO_REQUIRED');
    file=source.path;opened=await c.media.open(source);guard();await c.verification.checkLocation(context);guard();
    if(c.verification.authority(id,p.sourceId)!==authority)fail('RENDER_CONFLICT','播放核验期间来源已变化',409);
   }
   guard();return{...opened,path:file};
  }catch(e){if(opened)await c.media.release(opened.handle);if(e.code==='VIDEO_CONFLICT')fail('RENDER_CONFLICT','核验期间来源或权限已变化，请重新读取',409);if(e.code==='TARGET_CHANGED'||e.code==='SOURCE_CHANGED')renderFault('RENDER_SOURCE_REVIEW_REQUIRED');if(e.code==='ENOENT'||e.code==='SOURCE_MISSING')fail(p.schemaVersion!==2||p.link==='legacy-path'?'RENDER_LEGACY_PATH_MISSING':'RENDER_SOURCE_MISSING','成片视频文件已移动或丢失',404);throw e;}
 }
 references(source){
  const result=[];for(const row of this.db.prepare('SELECT * FROM project_renders').all()){
   if(!this.db.prepare('SELECT id FROM project_timelines WHERE id=? AND project_id=?').get(row.id,row.project_id))continue;
   const p=this.payload(row);if(p.schemaVersion===2&&p.link===null)continue;
   let other=p.schemaVersion===2&&p.link==='project-video'?this.db.prepare('SELECT * FROM storyboard_video_sources WHERE id=? AND project_id=?').get(p.sourceId,row.project_id):null;
   other=other?{...JSON.parse(other.data_json),id:other.id,project_id:other.project_id}:null;
   // A project-video snapshot is display history, never a reservation of its
   // former pathname. Only legacy links use a saved path as their live target.
   const old=p.schemaVersion===2?(p.link==='legacy-path'?p.snapshot:null):p;
   if(p.sourceId===source.id&&row.project_id===source.project_id||other&&(other.path===source.path||other.identity.dev===source.identity.dev&&other.identity.ino===source.identity.ino)||old?.path===source.path||old?.dev===source.identity.dev&&old?.ino===source.identity.ino)result.push({projectId:row.project_id,timelineId:row.id,renderRevision:this.revision(row)});
  }return result;
 }
 assertNotInUse(source){const references=this.references(source);if(references.length)fail('RENDER_IN_USE','此视频正作为成片使用，请先解除或更换成片关联',409,{sourceId:source.id??null,references});}
 snapshot(){return{format:'shiguang-project-renders',schemaVersion:renderColumns(this.db).some(c=>c.name==='revision')?2:1,rows:this.db.prepare('SELECT * FROM project_renders ORDER BY id').all()};}
 validateBackup(input){
  shape(input,['format','schemaVersion','rows']);if(input.format!=='shiguang-project-renders'||![1,2].includes(input.schemaVersion)||!Array.isArray(input.rows)||input.rows.length>100000)fail('RENDER_BACKUP_INVALID','成片备份无效');
  const seen=new Set();return input.rows.map(row=>{shape(row,input.schemaVersion===1?['id','project_id','payload']:['id','project_id','payload','revision']);if(!idOK(row.id)||!idOK(row.project_id)||seen.has(row.id)||typeof row.payload!=='string'||row.payload.length>1048576||input.schemaVersion===2&&(!integer(row.revision)||row.revision<1))fail('RENDER_BACKUP_INVALID','成片备份行无效');seen.add(row.id);validateRenderPayload(JSON.parse(row.payload));return{...row,revision:row.revision??1};});
 }
 restoreRows(input){const rows=this.validateBackup(input);this.requireSchema();this.db.transaction(()=>{for(const row of rows){this.validate(row.project_id,row.id);const p=JSON.parse(row.payload);if(p.schemaVersion===2&&p.link==='project-video'&&!this.db.prepare('SELECT id FROM storyboard_video_sources WHERE id=? AND project_id=?').get(p.sourceId,row.project_id))fail('RENDER_BACKUP_INVALID','成片备份来源不属于同一项目');const old=this.row(row.project_id,row.id);if(old&&canonical(old)!==canonical(row))fail('RENDER_CONFLICT','已有不同成片记录，未覆盖',409);if(!old)this.db.prepare('INSERT INTO project_renders(id,project_id,payload,revision) VALUES(?,?,?,?)').run(row.id,row.project_id,row.payload,row.revision);}})();}
}

// Explicit offline SQLite migration, never reached by application startup/GET.
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [command,file,...args]=process.argv.slice(2);
 if(command!=='migrate-sqlite'||!validPath(file))throw Error('Usage: node server/project-renders.mjs migrate-sqlite /absolute/library.sqlite [--apply --backup /absolute/new-backup.json]');
 const {default:Database}=await import('better-sqlite3'),apply=args.includes('--apply'),backupFile=args[args.indexOf('--backup')+1],db=new Database(file,{fileMustExist:true,readonly:!apply});
 try{console.log(JSON.stringify(await migrateRenderSchema(db,{apply,backupFile}),null,2));}finally{db.close();}
}
