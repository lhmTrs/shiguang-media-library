import fs from 'node:fs/promises';
import {canonical,idOK} from '../project-assets/model.mjs';
import {usageFail as fail} from './action-journal.mjs';
import {fileStamp} from './verification.mjs';

const unchecked=()=>({state:'unchecked',match:null,metadataChanged:false});
export const renderReasons={
 RENDER_CODEC_UNSUPPORTED:'当前网页播放器不支持此编码',RENDER_INFO_REQUIRED:'先刷新视频信息',
 RENDER_IN_REJECT_AREA:'在废片收纳处，先移回项目里',RENDER_SOURCE_MISSING:'视频文件已移动或丢失',
 RENDER_SOURCE_UNTRUSTED:'先升级或重新定位为本项目托管视频',RENDER_SOURCE_REMOVED:'视频记录已移除',
 RENDER_SOURCE_REVIEW_REQUIRED:'文件状态变化，先核对当前内容',RENDER_SOURCE_CHANGED:'视频内容已变化，请先核对',
};
export function renderFault(code,details={}){fail(code,renderReasons[code]||'视频暂时不可用',code==='RENDER_CODEC_UNSUPPORTED'?415:code==='RENDER_SOURCE_UNTRUSTED'?403:['RENDER_SOURCE_MISSING','RENDER_SOURCE_REMOVED'].includes(code)?404:409,details);}
export class ProjectVideoMediaInfo {
 constructor(catalog){this.catalog=catalog;}
 get c(){return this.catalog;}
 info(source,data){
  const cached=data.mediaInfo?.basisSha256===data.sha256?data.mediaInfo:null;
  const codec=cached?cached.codec:source.codec&&source.codec!=='unknown'?source.codec:null;
  return {codec,width:cached?.width??null,height:cached?.height??null,durationMs:cached?.durationMs??source.durationMs??null,bytes:source.identity.size,
   supported:cached?cached.supported:codec===null?null:source.supported};
 }
 folder(id,source,rows,roles){const folderId=this.c.folders.folderId(id,source.path,rows),row=rows.find(r=>r.id===folderId);return row?{id:row.id,parentId:row.parentId,name:row.name,relativePath:row.relativePath,role:row.id===roles.finalFolderId?'final':row.id===roles.rejectFolderId?'reject':null,locked:row.id===roles.finalFolderId,available:!(row.id===roles.finalFolderId&&roles.finalState!=='ready')}:null;}
 async project(id,source,{rows=this.c.folders.rows(id),roles=null}={}){
  const c=this.c,db=c.db,token=c.databaseToken(),{data,row}=c.metadata(id,source),managed=c.isManaged(id,source),video=this.info(source,data);
  roles??=await c.finalFolder.roles(id);
  const folder=this.folder(id,source,rows,roles),inRejectArea=c.folders.inRejectArea(id,c.folders.folderId(id,source.path,rows),rows);
  let availability=data.removedAt?'removed':managed?'available':'untrusted',verification=managed?c.verification.view(source):unchecked();
  // Only lightweight identity/stat reads here. Never hash, probe or prepare.
  if(managed&&!data.removedAt){
   try{
    const location=await c.folders.resolve(id,c.folders.folderId(id,source.path,rows));
    const st=await fs.lstat(source.path);
    if(!location.exists||!st.isFile()||st.isSymbolicLink()||await fs.realpath(source.path)!==source.path)throw Object.assign(Error(),{code:'TARGET_CHANGED'});
    if(canonical(fileStamp(st))!==canonical(source.identity))verification={state:verification.state==='content_changed'?'content_changed':'needs_verification',match:null,metadataChanged:false};
    else if(c.verification.results.get(source.id)?.proof!==c.videos.proof(source))verification=unchecked();
   }catch(e){availability=e.code==='ENOENT'?'missing':'unavailable';}
  }
  if(c.db!==db||c.databaseToken()!==token)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化',409);
  const disabledReasons=[],add=code=>disabledReasons.push({code,message:renderReasons[code]});
  if(availability!=='available')add(availability==='missing'?'RENDER_SOURCE_MISSING':availability==='removed'?'RENDER_SOURCE_REMOVED':availability==='untrusted'?'RENDER_SOURCE_UNTRUSTED':'RENDER_SOURCE_REVIEW_REQUIRED');
  if(verification.state==='content_changed')add('RENDER_SOURCE_CHANGED');else if(verification.state==='needs_verification')add('RENDER_SOURCE_REVIEW_REQUIRED');
  if(video.supported===false)add('RENDER_CODEC_UNSUPPORTED');else if(video.supported===null)add('RENDER_INFO_REQUIRED');
  if(inRejectArea)add('RENDER_IN_REJECT_AREA');
  const reasonCode=video.supported===false?'RENDER_CODEC_UNSUPPORTED':video.supported===null?'RENDER_INFO_REQUIRED':null,selectable=disabledReasons.length===0;
  return {sourceId:source.id,projectId:id,name:data.title,fileName:source.name,sourceRevision:row?.revision||0,folder,managed,inRejectArea,availability,verification,
   codec:video.codec,width:video.width,height:video.height,durationMs:video.durationMs,bytes:video.bytes,playback:{supported:video.supported,reasonCode},selectable,disabledReasons,
   previewUrl:selectable?`/api/project-videos/projects/${id}/videos/${source.id}/media`:null};
 }
 source(id,sourceId){try{return this.c.videos.source(id,sourceId);}catch{fail('RENDER_SOURCE_NOT_FOUND','未找到本项目的视频来源',404);}}
 refresh(id,sourceId,input){
  this.c.project(id);this.source(id,sourceId);
  if(!input||!idOK(input.requestId))fail('INVALID_REQUEST_ID','请求编号无效');
  if(Object.keys(input).some(k=>!['requestId','expectedRevision'].includes(k))||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)fail('INVALID_INPUT','请提供视频修订号');
  return this.c.usageJournal.start(id,null,'video-info-refresh',{...input,sourceId},'info:'+sourceId,async s=>{
   const c=this.c,j=c.usageJournal;let source=this.source(id,sourceId),m=c.metadata(id,source);
   if(m.row?.revision!==input.expectedRevision)fail('RENDER_CONFLICT','视频资料已更新，请重新读取',409);
   if(!c.isManaged(id,source))renderFault('RENDER_SOURCE_UNTRUSTED');
   try{source=await c.verifiedSource(id,sourceId);}catch(e){j.guard(s);renderFault(c.verification.view(source).state==='content_changed'?'RENDER_SOURCE_CHANGED':'RENDER_SOURCE_REVIEW_REQUIRED');}
   j.guard(s);m=c.metadata(id,source);const authority=c.verification.authority(id,sourceId);
   const context=await c.verification.capture(id,sourceId);j.guard(s);
   let probe;
   try{probe=await c.media.probe(source.path,{identity:source.identity,includeDimensions:true});}
   catch(e){j.guard(s);if(e.code==='SOURCE_CHANGED')renderFault('RENDER_SOURCE_REVIEW_REQUIRED');fail('RENDER_INFO_UNAVAILABLE','视频信息暂时无法确认，请核对原请求后再处理',503);}
   j.guard(s);await c.verification.checkLocation(context);j.guard(s);
   if(c.verification.authority(id,sourceId)!==authority||canonical(probe.identity)!==canonical(source.identity))fail('RENDER_CONFLICT','探测期间视频或授权已更新',409);
   const mediaInfo={basisSha256:m.data.sha256,codec:probe.codec==='unknown'?null:probe.codec,width:probe.width??null,height:probe.height??null,durationMs:probe.durationMs,supported:probe.codec==='unknown'?null:probe.supported,updatedAt:Date.now()};
   const projected=await this.project(id,source);j.guard(s);
   const nextSource={path:source.path,name:source.name,identity:probe.identity,durationMs:probe.durationMs,codec:probe.codec,supported:probe.supported};
   c.videos.tx(()=>{
    j.guard(s);c.project(id,true);if(c.verification.authority(id,sourceId)!==authority)fail('RENDER_CONFLICT','视频资料在确认时变化',409);
    c.db.prepare('UPDATE storyboard_video_sources SET data_json=?,updated_at=? WHERE id=? AND project_id=?').run(canonical(nextSource),Date.now(),sourceId,id);
    c.record(id,sourceId,{...m.data,mediaInfo},m.row.revision+1);source=c.videos.source(id,sourceId);c.videos.approve(source);c.approveManaged(source);c.verification.remember(source,{state:'verified',match:'file',metadataChanged:false});
    const dto={...projected,sourceRevision:m.row.revision+1,codec:mediaInfo.codec,width:mediaInfo.width,height:mediaInfo.height,durationMs:mediaInfo.durationMs,verification:{state:'verified',match:'file',metadataChanged:false},playback:{supported:mediaInfo.supported,reasonCode:mediaInfo.supported===null?'RENDER_INFO_REQUIRED':mediaInfo.supported===false?'RENDER_CODEC_UNSUPPORTED':null}};
    dto.disabledReasons=dto.disabledReasons.filter(r=>!['RENDER_INFO_REQUIRED','RENDER_CODEC_UNSUPPORTED','RENDER_SOURCE_REVIEW_REQUIRED'].includes(r.code));if(dto.playback.reasonCode)dto.disabledReasons.push({code:dto.playback.reasonCode,message:renderReasons[dto.playback.reasonCode]});dto.selectable=dto.disabledReasons.length===0;dto.previewUrl=dto.selectable?`/api/project-videos/projects/${id}/videos/${sourceId}/media`:null;j.complete(s,{source:dto});
   });
  });
 }
}
