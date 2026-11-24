import {createHash} from 'node:crypto';
const canonical=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export const hash=value=>createHash('sha256').update(value).digest('hex');
export const taskId=value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,128}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const text=(value,max=240)=>typeof value==='string'&&value.length<=max&&!/[\x00-\x1f\x7f]|https?:|bearer\s|token=/i.test(value)?value:null;
const folder=value=>text(value,300)&&!value.startsWith('/')&&!/^[A-Za-z]:|^\\\\/.test(value)&&!value.split(/[\\/]/).includes('..')?value:null;
const timestamp=value=>Number.isFinite(value)&&value>0&&value<=Date.now()+86400000?Math.floor(value):null;
export const registeredAt=q=>typeof q?.created==='number'?timestamp(q.created*1000):null;
const activeStages=new Set(['monitoring','waiting_library','notifying']);
const stages=new Set([...activeStages,'done','failed','cancelled','needs_user']);
const terminalStages=new Set(['done','failed','cancelled']);
const diagnosticReasons=new Set(['state_missing','read_limit','record_changed','unsafe_record']);
const notificationStates=new Set(['unprepared','prepared','sending','send_uncertain','queued','delivered','answered','failed']);
export function taskDiagnostic(id, reason, queueEntry) {
 const stage = stages.has(queueEntry?.stage) ? queueEntry.stage : null;
 return {
  id, reason: diagnosticReasons.has(reason) ? reason : 'invalid_record',
  legacyStatus: stage, registeredAt: registeredAt(queueEntry),
  historicalMissing: reason === 'state_missing' && terminalStages.has(stage),
 };
}
export function degradedTask(id,reason='invalid_record'){
 const eventVersion=hash(JSON.stringify({id,reason}));
 return {id,name:'任务记录待核对',eventVersion,phase:'needs_review',active:false,attention:{code:reason,message:'本机任务记录暂不可核对，原任务未改动'},unread:false,createdAt:null,upstreamUpdatedAt:null,localRecordUpdatedAt:null,progress:null,lastCompletedPhase:null,stale:null,target:{projectId:null,projectName:null,folderLabel:null,folderId:null,identity:'unconfirmed'},delivery:null,notification:{state:'unknown'},recordUrl:'/api/updream-progress/tasks/'+encodeURIComponent(id)};
}
export function projectTask(q,s,mtime,{libraryId,resolveVideo=()=>false,projectName=()=>null}={}){
 if(q.version!==1||!taskId(q.task_id)||!stages.has(q.stage)||!s?.generation||s.generation.task_id!==q.task_id||s.count!==1||(s.version!==undefined&&s.version!==1))throw Error('invalid_record');
 const g=s.generation,d=s.delivery,t=q.target;
 if(!t||!uuid(t.project)||!folder(t.folder)||(!text(t.filename)||!t.filename.toLowerCase().endsWith('.mp4')||/[\\/]/.test(t.filename))||!/^http:\/\/127\.0\.0\.1:\d+$/.test(t.origin||''))throw Error('invalid_record');
 let phase='needs_review';
 if(g.status==='pending'||g.status==='processing')phase='generating';
 else if(g.status==='failed'||g.status==='cancelled')phase=g.status;
 else if(g.status==='completed'){
  if(d?.stage==='importing')phase='importing';
  else if(s.download_result?.probe&&/^[a-f0-9]{64}$/.test(s.download_result.sha256||''))phase='waiting_import';
  else phase='downloading';
 }
 const deliverySignature=d?hash(canonical(Object.fromEntries(['target','file','sha256','prompt_id','video_id','verified','stage'].map(k=>[k,d[k]??null])))):null;
 const signatureValid=!q.delivery_sha256||q.delivery_sha256===deliverySignature;
 const recorded=signatureValid&&d?.stage==='ready'&&d.verified===true&&d.target?.project===t.project&&d.target?.filename===t.filename&&d.target?.origin===t.origin&&uuid(d.target?.instance)&&uuid(d.target?.folder_id)&&uuid(d.video_id)&&/^[a-f0-9]{64}$/.test(d.sha256||'');
 if(recorded)phase='imported';
 else if(d?.stage==='ready'||q.stage==='done'||q.stage==='notifying')phase='needs_review';
 if(q.stage==='failed'&&!recorded)phase='failed';
 const locallyStopped=q.stage==='cancelled'&&!recorded&&g.status!=='cancelled';
 if(q.stage==='cancelled'&&!recorded&&g.status==='cancelled')phase='cancelled';
 else if(locallyStopped&&!['failed'].includes(phase))phase='needs_review';
 let attention=null;
 if(q.stage==='needs_user')attention={code:recorded?'notification_needs_review':'followup_needs_review',message:recorded?'视频已有入库核验记录，后续通知需核对':'跟进需要人工核对，原任务和结果保留'};
 if(phase==='needs_review')attention={code:'unknown_state',message:'当前阶段无法从记录确认，请核对原任务'};
 if(locallyStopped)attention={code:'local_followup_stopped',message:'仅本机跟进已停止，不能据此确认平台生成已取消'};
 if(phase==='failed')attention={code:'task_failed',message:'原任务记录为失败，未自动重做'};
 if(q.stage==='needs_user'&&!recorded&&!['failed','cancelled'].includes(phase))phase='needs_review';
 const instance=d?.target?.project===t.project&&d?.target?.filename===t.filename&&d?.target?.origin===t.origin&&uuid(d?.target?.instance)?d.target.instance:null;
 const identity=instance?(!libraryId?'recorded':instance===libraryId?'current':'other_library'):'unconfirmed';
 const target={projectId:t.project,projectName:identity==='current'?text(projectName(t.project)):null,folderLabel:folder(t.folder),folderId:uuid(d?.target?.folder_id)?d.target.folder_id:null,identity};
 const delivery=recorded?{verification:'executor_recorded',projectId:t.project,folderId:d.target.folder_id,videoId:d.video_id,relatedImportRequestId:uuid(d.request_id)?d.request_id:null,canView:identity==='current'&&resolveVideo(t.project,d.video_id)===true}:null;
 const ns=q.notification?.bridge_status||q.notification?.stage;
 const notification={state:q.notification?notificationStates.has(ns)?ns:'unknown':'disabled'};
 const active=activeStages.has(q.stage)&&!['imported','failed','cancelled','needs_review'].includes(phase);
 const progress=typeof g.progress==='string'&&/^\d{1,3}(\.\d+)?%$/.test(g.progress)&&parseFloat(g.progress)<=100?{percent:parseFloat(g.progress)}:null;
 const lastCompletedPhase=recorded?'imported':s.download_result?.probe?'validating':g.status==='completed'?'generating':null;
 const stale=active&&Number.isFinite(mtime)&&Date.now()-mtime>120000?{since:Math.floor(mtime),reason:'local_record_old'}:null;
 const semantic={id:q.task_id,name:text(s.name)||text(t.filename)||'Updream 视频任务',phase,active,attention,target,delivery};
 return {...semantic,eventVersion:hash(JSON.stringify({...semantic,attentionRevision:attention?hash(String(q.attention??g.error_code??'').slice(0,1000)):null,deliverySignature:recorded?deliverySignature:null})),unread:!!attention||['imported','failed','cancelled'].includes(phase),createdAt:registeredAt(q),upstreamUpdatedAt:null,localRecordUpdatedAt:timestamp(mtime),progress,lastCompletedPhase,stale,notification,recordUrl:'/api/updream-progress/tasks/'+encodeURIComponent(q.task_id)};
}
