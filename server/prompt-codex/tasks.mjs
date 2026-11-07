import {fault} from '../prompt-templates/model.mjs';
import {validId} from './media.mjs';

export const isActive=status=>['queued','running','stopping'].includes(status);
export const parseJSON=value=>{try{return JSON.parse(value);}catch{return null;}};
export const safeError=value=>typeof value==='string'&&/^[A-Z_]{1,80}$/.test(value)?value:'';
// This is a deliberately small display projection, never a serialization of model output.
export function safeText(value,max=240){
  if(typeof value!=='string')return '';
  return value.slice(0,65536)
    .replace(/data:[^\s"'<>]*|\b[A-Za-z0-9+/=_-]{80,}\b/gi,'[已隐藏数据]')
    .replace(/\b(?:bearer\s+|sk-)[^\s"'<>]+/gi,'[已隐藏凭据]')
    .replace(/["']?(?:api[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|secret|authorization)["']?\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,'[已隐藏凭据]')
    .replace(/(?:file:\/\/|[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+|(?:~?\/)[^\s"'<>]+/g,'[已隐藏路径]')
    .replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
}
const imageProjection=block=>{
  const attachmentId=validId(block?.attachmentId)?block.attachmentId:null;
  const status=block?.status==='ready'&&!attachmentId?'failed':['processing','ready','failed'].includes(block?.status)?block.status:'failed';
  const saved=status==='ready'&&!!attachmentId;
  const libraryStatus=block?.library?.status==='failed'?'failed':['ready','saved'].includes(block?.library?.status)?'saved':'notRequested';
  return {attachmentId:saved?attachmentId:null,url:saved?`/api/prompt-codex/images/${attachmentId}`:null,status,saved,libraryStatus,errorCode:status==='failed'?'IMAGE_RECEIVE_FAILED':libraryStatus==='failed'?'IMAGE_LIBRARY_FAILED':null};
};
export function taskSummary({blocks=[],actual={},request={}}={}){
  let preview='',imageCount=0,responding=false,imageProcessing=false;const images=[],reasons=new Set();
  // The write path already limits complete blocks to 4MB. Process all blocks so a late
  // image/library failure cannot disappear behind the sixteen thumbnail limit.
  for(const block of Array.isArray(blocks)?blocks:[]){
    if(block?.type==='text'&&typeof block.text==='string'&&block.text){preview=safeText(block.text);responding=true;}
    if(block?.type!=='image')continue;
    const image=imageProjection(block);imageCount++;if(images.length<16)images.push(image);
    if(image.status==='processing')imageProcessing=true;
    if(image.errorCode)reasons.add(image.errorCode);
  }
  return {version:1,model:safeText(actual?.model??request?.model,200)||null,effort:safeText(actual?.effort??request?.effort,80)||null,preview,images,imageCount,responding,imageProcessing,reasons:[...reasons]};
}
export function displaySummary(summary){
  if(summary?.version!==1||!Array.isArray(summary.images)||!Array.isArray(summary.reasons))return null;
  const images=summary.images.slice(0,16).map(i=>imageProjection({status:i?.status,attachmentId:i?.attachmentId,library:{status:i?.libraryStatus}}));
  return {model:safeText(summary.model,200)||null,effort:safeText(summary.effort,80)||null,preview:safeText(summary.preview),images,imageCount:Number.isSafeInteger(summary.imageCount)?Math.max(images.length,summary.imageCount):images.length,responding:summary.responding===true,imageProcessing:summary.imageProcessing===true,reasons:summary.reasons.filter(r=>['IMAGE_RECEIVE_FAILED','IMAGE_LIBRARY_FAILED'].includes(r))};
}
export function taskDTO(row,summary,project){
  const unavailable=!summary,view=summary??taskSummary(),errorCode=safeError(row.error_code),reasons=new Set(view.reasons);
  if(row.status==='failed')reasons.add('TASK_FAILED');
  if(row.status==='interrupted'&&errorCode!=='USER_STOPPED')reasons.add('TASK_INTERRUPTED');
  if(['STOP_SCOPE_CHANGED','STOP_SCOPE_EXPIRED','CODEX_CLOSE_UNSETTLED'].includes(errorCode))reasons.add(errorCode);
  if(unavailable)reasons.add('SUMMARY_UNAVAILABLE');
  const phase=row.status==='stopping'?'stopping':row.status==='completed'?'completed':row.status==='interrupted'?(errorCode==='USER_STOPPED'?'stopped':'interrupted'):row.status==='failed'?'failed':view.imageProcessing?'imageProcessing':view.responding?'responding':'waiting';
  return {taskId:row.id,conversationId:row.conversation_id,templateId:row.template_id,title:safeText(row.title,200),templateName:safeText(row.template_name,120),templateDeleted:row.template_deleted_at!==null,conversationDeleted:row.conversation_deleted_at!==null,sequence:row.sequence_no,status:row.status,errorCode,createdAt:row.created_at,updatedAt:row.updated_at,project,model:view.model,effort:view.effort,phase,attention:{required:reasons.size>0,reasons:[...reasons]},preview:view.preview,images:view.images,imageCount:view.imageCount,summaryUnavailable:unavailable,terminalRevision:isActive(row.status)?null:`${row.status}:${errorCode}:${row.updated_at}`};
}
export function taskPageOptions({limit=50,cursor}={}){
  if(!/^\d+$/.test(String(limit))||Number(limit)<1)throw fault('任务分页数量无效');
  const size=Math.min(Number(limit),100);let before=null;
  if(cursor!==undefined&&cursor!==null&&cursor!==''){
    if(typeof cursor!=='string'||cursor.length>256)throw fault('任务分页游标无效');
    before=parseJSON(Buffer.from(cursor,'base64url').toString('utf8'));
    if(before?.v!==1||!Number.isSafeInteger(before.time)||before.time<0||!validId(before.id))throw fault('任务分页游标无效');
  }
  return {limit:size,before};
}
export const taskCursor=row=>Buffer.from(JSON.stringify({v:1,time:row.created_at,id:row.id})).toString('base64url');
