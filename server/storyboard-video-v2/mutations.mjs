import {confirmUnbind} from './confirmation.mjs';
import {randomUUID} from 'node:crypto';
import {idOK} from '../project-assets/model.mjs';
import {hash,canonical,fail,orderedShotIds,rows} from './model.mjs';
const decode=value=>value==null?null:JSON.parse(value);
const keys=(input,allowed)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k)))fail('VIDEO_V2_INVALID_INPUT','请求字段不符合视频绑定v2合同');};
const bindKeys=['action','expectedBindingRevision','targetProjectId','expectedStoryboardRevision','expectedAssetStamp','shotIds'];
const selectKeys=['action','expectedSelectionRevision','expectedStoryboardRevision','sourceProjectId','videoId','bindingId','expectedBindingRevision','shotId'];
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const relation=s=>[s.target_project_id,s.document_id,s.initialized_at,s.shot_id].join(':');
export const videoV2Mutations={
 async reserve(projectId,input){keys(input,['requestId','expectedStoryboardRevision','expectedAssetStamp','shotIds']);this.require();if(!idOK(input.requestId))fail('VIDEO_V2_INVALID_INPUT','请求ID无效');const replay=this.replay('reserve',projectId,input);if(replay)return replay;const seen=this.read(()=>this.view(projectId));this.expectedView(seen,input.expectedStoryboardRevision,input.expectedAssetStamp);orderedShotIds(seen.project,input.shotIds);const proofs=await this.dependencyProof(seen,input.shotIds);return this.mutation('reserve',projectId,input,[projectId],()=>{
  this.assertIoProofs(proofs,{code:'ASSET_CONTEXT_CHANGED'});const view=this.view(projectId,true);this.expectedView(view,input.expectedStoryboardRevision,input.expectedAssetStamp);orderedShotIds(view.project,input.shotIds);this.historyVersion(view);
  const snapshot=this.capture(view,input.shotIds);if(snapshot.shots.some(s=>s.unverifiable.length))fail('VIDEO_V2_UNSETTLED','生成使用的外部依赖尚不能核验，未预留出处',503);
  const now=Date.now(),row={id:randomUUID(),project_id:projectId,document_id:view.head.id,initialized_at:view.head.initialized_at,storyboard_revision:view.head.revision,instance_id:this.instanceId,shot_ids_json:canonical(input.shotIds),snapshot_json:canonical(snapshot),input_hash:snapshot.inputHash,status:'reserved',request_id:input.requestId,revision:1,created_at:now,updated_at:now};
  this.insert('storyboard_video_v2_provenance',row);return {provenance:this.provenanceDTO(row),revision:1,status:'reserved'};
 });},
 provenance(provenanceId){return this.read(()=>{const row=this.provenanceRow(provenanceId);return {provenance:this.provenanceDTO(row),revision:row.revision,status:row.status};});},
 release(provenanceId,input){this.require();keys(input,['requestId','expectedProvenanceRevision','reason']);const prior=this.provenanceRow(provenanceId);return this.mutation('release',provenanceId,input,[prior.project_id],()=>{
  const row=this.provenanceRow(provenanceId);if(row.revision!==input.expectedProvenanceRevision)fail('VIDEO_ORIGIN_CONFLICT','出处预留已变化',409);
  if(!['not-submitted','failed','cancelled'].includes(input.reason))fail('VIDEO_V2_INVALID_INPUT','只能明确未提交、失败或取消后释放，不能释放未知在途任务');
  if(row.status==='bound'||this.db.prepare('SELECT id FROM storyboard_video_v2_bindings WHERE provenance_id=?').get(provenanceId))fail('VIDEO_ORIGIN_CONFLICT','成功绑定的出处不可释放',409);
  if(row.status!=='released')this.db.prepare('UPDATE storyboard_video_v2_provenance SET status=?,revision=?,updated_at=? WHERE id=?').run('released',row.revision+1,Date.now(),provenanceId);
  const current=this.provenanceRow(provenanceId);return {provenance:this.provenanceDTO(current),revision:current.revision,status:current.status};
 });},
 bindingPlan(sourceProjectId,videoId,input,{write=false}={}){
  if(!integer(input.expectedBindingRevision))fail('VIDEO_V2_INVALID_INPUT','期望绑定修订无效');
  const info=this.videoInfo(sourceProjectId,videoId),old=this.bindingRow(videoId);
  if((old?.revision??0)!==input.expectedBindingRevision)fail('VIDEO_BINDING_CONFLICT','视频绑定已变化，请重新预览',409);
  const targets=this.allowedTargets(sourceProjectId);if(!['bind','unbind'].includes(input.action))fail('VIDEO_V2_INVALID_INPUT','绑定操作无效');
  const previousView=old?.target_project_id?this.view(old.target_project_id,write):null,before=this.bindingDTO(old,previousView),contexts=previousView?[previousView.context]:[];
  let next=null,view=null,snapshot=null;
  if(input.action==='bind'){
   if(!targets.some(t=>t.projectId===input.targetProjectId))fail('VIDEO_TARGET_SCOPE_CHANGED','目标集已不在该片允许范围',409);
   this.assertBindable(sourceProjectId,videoId);view=this.view(input.targetProjectId,write);this.expectedView(view,input.expectedStoryboardRevision,input.expectedAssetStamp);orderedShotIds(view.project,input.shotIds);this.historyVersion(view);
   snapshot=this.capture(view,input.shotIds);snapshot.videoIdentity=info.identity;
   if(!contexts.some(c=>c.projectId===view.context.projectId))contexts.push(view.context);
   const oldShots=old?this.bindingShots(old):[],oldByRelation=new Map(oldShots.map(s=>[relation(s),s]));
   next={bindingId:old?.id??videoId,revision:(old?.revision??0)+1,targetProjectId:input.targetProjectId,documentId:view.head.id,initializedAt:view.head.initialized_at,storyboardRevision:view.head.revision,boundAt:old?.bound_at??0,origin:'manual',provenance:old?.provenance_id?this.provenanceDTO(this.provenanceRow(old.provenance_id)):null,shots:snapshot.shots.map((s,i)=>({shotId:s.shotId,numberAtBinding:s.number,durationMs:s.durationMs,associationSeq:oldByRelation.get([input.targetProjectId,view.head.id,view.head.initialized_at,s.shotId].join(':'))?.association_seq??0,existsInCurrent:true,currentNumber:s.number}))};
  }else if(input.targetProjectId!==null||!Array.isArray(input.shotIds)||input.shotIds.length||input.expectedStoryboardRevision!==null||input.expectedAssetStamp!==null)fail('VIDEO_V2_INVALID_INPUT','解绑须显式空目标、空镜头和空目标版本');
  const oldSnapshot=decode(old?.snapshot_json),same=!!old&&(next?old.target_project_id===next.targetProjectId&&old.document_id===next.documentId&&old.initialized_at===next.initializedAt&&old.storyboard_revision===next.storyboardRevision&&canonical(before?.shots.map(s=>s.shotId))===canonical(input.shotIds)&&hash(oldSnapshot.shots.map(s=>s.categories))===hash(snapshot.shots.map(s=>s.categories))&&oldSnapshot.videoIdentity===snapshot.videoIdentity:old.target_project_id===null);
  if(same)next=before;
  const retained=new Set((next?.shots??[]).map(s=>[next.targetProjectId,next.documentId,next.initializedAt,s.shotId].join(':'))),affected=[];
  for(const s of old?this.db.prepare('SELECT * FROM storyboard_video_v2_selections WHERE binding_id=?').all(old.id):[]){if(retained.has(relation(s)))continue;const oldView=previousView??this.view(s.target_project_id),number=rows(oldView.project??{scenes:[]}).find(r=>r.shot.id===s.shot_id)?.number??before?.shots.find(q=>q.shotId===s.shot_id)?.numberAtBinding??'';affected.push({projectId:s.target_project_id,projectName:this.board.project(s.target_project_id).name,shotId:s.shot_id,number,before:this.selectionView(s),after:null});}
  const plan={before,after:next,contexts,affectedShots:affected,requiresConfirmation:affected.length>0};
  const previewHash=hash({scope:[sourceProjectId,videoId],intent:input,bindingRevision:old?.revision??0,before,after:next,contexts,affected,targets,videoRevision:info.videoRevision,videoIdentity:info.identity,snapshot:snapshot?.inputHash??null});
  return {...plan,previewHash,_old:old,_info:info,_view:view,_snapshot:snapshot,_same:same};
 },
 async previewBinding(sourceProjectId,videoId,input){keys(input,bindKeys);this.require();if(input.action==='bind'){await this.mediaProof(sourceProjectId,videoId);const view=this.read(()=>this.view(input.targetProjectId));this.expectedView(view,input.expectedStoryboardRevision,input.expectedAssetStamp);orderedShotIds(view.project,input.shotIds);await this.dependencyProof(view,input.shotIds);}return this.read(()=>{const plan=this.bindingPlan(sourceProjectId,videoId,input);return Object.fromEntries(Object.entries(plan).filter(([k])=>!k.startsWith('_')));});},
 async bind(sourceProjectId,videoId,input){keys(input,[...bindKeys,'requestId','previewHash','confirmUnbind','confirmedUnbindShotRefs','confirmedUnbindShotIds']);this.require();if(!idOK(input.requestId))fail('VIDEO_V2_INVALID_INPUT','请求ID无效');const replay=this.replay('binding',sourceProjectId+':'+videoId,input);if(replay)return replay;const proofs=[];if(input.action==='bind'){proofs.push(await this.mediaProof(sourceProjectId,videoId));const view=this.read(()=>this.view(input.targetProjectId));this.expectedView(view,input.expectedStoryboardRevision,input.expectedAssetStamp);orderedShotIds(view.project,input.shotIds);proofs.push(...await this.dependencyProof(view,input.shotIds));}const intent=Object.fromEntries(bindKeys.map(k=>[k,input[k]]));return this.mutation('binding',sourceProjectId+':'+videoId,input,[sourceProjectId,input.targetProjectId],()=>{
  this.assertIoProofs(proofs,{code:'VIDEO_BINDING_CONFLICT'});const plan=this.bindingPlan(sourceProjectId,videoId,intent,{write:true});
  if(plan.previewHash!==input.previewHash)fail('VIDEO_BINDING_CONFLICT','预览期间绑定、采用、分镜或依赖已变化',409);
  confirmUnbind(input,plan.affectedShots,{missingCode:'VIDEO_REPLACEMENT_CONFIRMATION_REQUIRED'});
  const old=plan._old;
  if(!plan._same){
   const now=Date.now(),id=old?.id??videoId,after=plan.after;
   const next={id,video_id:videoId,source_project_id:sourceProjectId,target_project_id:after?.targetProjectId??null,document_id:after?.documentId??null,initialized_at:after?.initializedAt??null,storyboard_revision:after?.storyboardRevision??null,origin:after?'manual':old?.origin??'manual',provenance_id:old?.provenance_id??null,snapshot_json:after?canonical(plan._snapshot):null,review_json:null,review_revision:null,reviewed_at:null,bound_at:after?now:null,revision:(old?.revision??0)+1,created_at:old?.created_at??now,updated_at:now};
   if(old)this.db.prepare('DELETE FROM storyboard_video_v2_bindings WHERE id=?').run(old.id);this.insert('storyboard_video_v2_bindings',next);
   const previous=new Map((old?this.bindingShots(old):[]).map(s=>[relation(s),s]));this.db.prepare('DELETE FROM storyboard_video_v2_shots WHERE binding_id=?').run(id);
   for(const [ordinal,shot]of (after?.shots??[]).entries()){const key=[after.targetProjectId,after.documentId,after.initializedAt,shot.shotId].join(':'),prior=previous.get(key);this.insert('storyboard_video_v2_shots',{id:prior?.id??randomUUID(),binding_id:id,video_id:videoId,source_project_id:sourceProjectId,target_project_id:after.targetProjectId,document_id:after.documentId,initialized_at:after.initializedAt,shot_id:shot.shotId,ordinal,number_at_binding:shot.numberAtBinding,duration_ms:shot.durationMs,association_seq:prior?.association_seq??this.sequence(),created_at:prior?.created_at??now,updated_at:now});}
   for(const change of plan.affectedShots)this.db.prepare('DELETE FROM storyboard_video_v2_selections WHERE binding_id=? AND target_project_id=? AND shot_id=?').run(id,change.projectId,change.shotId);
   for(const projectId of new Set(plan.affectedShots.map(s=>s.projectId)))this.bumpSelection(projectId);
   this.event(after?'bind':'unbind',{binding:after?next:old,before:plan.before,after:this.bindingDTO(next,plan._view),view:plan._view});
  }
  const current=this.bindingRow(videoId),view=current?.target_project_id?this.view(current.target_project_id):null;return {context:view?.context??null,binding:this.bindingDTO(current,view),review:this.reviewDTO(current,view),changes:plan.affectedShots};
 });},
 selectionPlan(projectId,input,{write=false}={}){
  const view=this.view(projectId,write);if(!view.head||view.head.revision!==input.expectedStoryboardRevision)fail('STORYBOARD_CONFLICT','分镜版本已变化',409);
  if(view.context.selectionRevision!==input.expectedSelectionRevision)fail('VIDEO_SELECTION_CONFLICT','采用选择已变化，请重读后预览',409);
  if(!['adopt-video','adopt-shot','clear-video','clear-shot'].includes(input.action))fail('VIDEO_V2_INVALID_INPUT','采用操作无效');
  const numbered=new Map(rows(view.project).map(r=>[r.shot.id,r.number])),existing=new Map(this.selectionRows(projectId,view).map(s=>[s.shot_id,s]));let selected=[];let binding=null;
  if(input.action!=='clear-shot'){
   binding=this.bindingRow(input.videoId);if(!binding||binding.id!==input.bindingId||binding.source_project_id!==input.sourceProjectId||binding.target_project_id!==projectId||binding.document_id!==view.head.id||binding.initialized_at!==view.head.initialized_at)fail('VIDEO_BINDING_CONFLICT','片子不属于当前集当前分镜对应关系',409);
   if(binding.revision!==input.expectedBindingRevision)fail('VIDEO_BINDING_CONFLICT','视频绑定已变化',409);
   if(input.action.startsWith('adopt'))this.assertBindable(input.sourceProjectId,input.videoId);
   selected=this.bindingShots(binding).map(s=>s.shot_id).filter(id=>numbered.has(id));
  }
  if(input.action.endsWith('shot')){if(!numbered.has(input.shotId))fail('SHOT_NOT_FOUND','镜头不在当前分镜',404);if(input.action==='adopt-shot'&&!selected.includes(input.shotId))fail('VIDEO_BINDING_CONFLICT','该片未对应此镜头',409);selected=[input.shotId];}
  const changes=[];const records=[];
  for(const id of selected){const old=existing.get(id)??null,isAdopt=input.action.startsWith('adopt');if(!isAdopt&&input.action==='clear-video'&&old?.video_id!==input.videoId)continue;
   const next=isAdopt?{target_project_id:projectId,document_id:view.head.id,initialized_at:view.head.initialized_at,shot_id:id,binding_id:binding.id,video_id:binding.video_id,source_project_id:binding.source_project_id,kind:input.action==='adopt-video'?'whole':'shot',selected_at:0}:null;
   if((!old&&!next)||(old&&next&&old.video_id===next.video_id&&old.binding_id===next.binding_id&&old.kind===next.kind))continue;
   const before=this.selectionView(old),after=next?{...this.selectionView({...next,selected_at:0})}:null;
   changes.push({projectId,shotId:id,number:numbered.get(id),before,after});records.push({old,next});
  }
  return {context:view.context,previewHash:hash({input,context:view.context,bindingRevision:binding?.revision??null,changes}),requiresConfirmation:changes.some(c=>c.before!==null),changes,_records:records};
 },
 previewSelection(projectId,input){keys(input,selectKeys);return this.read(()=>{const plan=this.selectionPlan(projectId,input);return Object.fromEntries(Object.entries(plan).filter(([k])=>!k.startsWith('_')));});},
 select(projectId,input){keys(input,[...selectKeys,'requestId','previewHash','confirmReplace']);const intent=Object.fromEntries(selectKeys.filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));return this.mutation('selection',projectId,input,[projectId],()=>{
  const plan=this.selectionPlan(projectId,intent,{write:true});if(plan.previewHash!==input.previewHash)fail('VIDEO_SELECTION_CONFLICT','预览期间选择或分镜已变化',409);
  if(plan.requiresConfirmation&&input.confirmReplace!==true)fail('VIDEO_REPLACEMENT_CONFIRMATION_REQUIRED','请确认完整采用替换清单',409,{changes:plan.changes});
  const now=Date.now();
  for(const [index,{old,next}]of plan._records.entries()){
   if(old)this.db.prepare('DELETE FROM storyboard_video_v2_selections WHERE id=?').run(old.id);
   if(next){const row={...next,id:old?.id??randomUUID(),selection_seq:this.sequence(),selected_at:now,created_at:old?.created_at??now,updated_at:now};this.insert('storyboard_video_v2_selections',row);plan.changes[index].after=this.selectionView(row);}
  }
  if(plan._records.length)this.bumpSelection(projectId);
  return {context:this.view(projectId).context,changes:plan.changes};
 });},
 async review(sourceProjectId,videoId,input){this.require();keys(input,['requestId','action','expectedBindingRevision','seenStoryboardRevision','expectedComparisonHash']);if(!idOK(input.requestId))fail('VIDEO_V2_INVALID_INPUT','请求ID无效');const replay=this.replay('review',sourceProjectId+':'+videoId,input);if(replay)return replay;const before=this.bindingRow(videoId),proofs=[];if(input.action==='confirm'&&before?.target_project_id){proofs.push(await this.mediaProof(sourceProjectId,videoId,{code:'VIDEO_REVIEW_CONFLICT'}));try{proofs.push(...await this.dependencyProof(this.read(()=>this.view(before.target_project_id)),decode(before.snapshot_json).shotIds));}catch(error){fail('VIDEO_REVIEW_CONFLICT','复核使用的外部依赖无法核验',409,{dependencyErrorCode:error.code??'UNVERIFIED'});}}return this.mutation('review',sourceProjectId+':'+videoId,input,[sourceProjectId,before?.target_project_id],()=>{
  this.assertIoProofs(proofs);const row=this.bindingRow(videoId);this.source(sourceProjectId,videoId);if(!row?.target_project_id||row.source_project_id!==sourceProjectId||row.revision!==input.expectedBindingRevision)fail('VIDEO_REVIEW_CONFLICT','绑定或复核记录已变化',409);
  const view=this.view(row.target_project_id,true),info=this.videoInfo(sourceProjectId,videoId),review=this.reviewDTO(row,view,info);
  if(view.context.storyboardRevision!==input.seenStoryboardRevision||review.comparisonHash!==input.expectedComparisonHash)fail('VIDEO_REVIEW_CONFLICT','所见分镜、依赖或视频内容已变化',409);
  if(!['confirm','undo'].includes(input.action))fail('VIDEO_V2_INVALID_INPUT','复核操作无效');
  if(input.action==='confirm'&&!review.canReview)fail('VIDEO_REVIEW_CONFLICT','当前对应或媒体依赖不可核验，不能清复核标记',409,{disabledReason:review.disabledReason});
  const now=Date.now(),snapshot=input.action==='confirm'?this.capture(view,decode(row.snapshot_json).shotIds):null;if(snapshot)this.historyVersion(view);
  const reviewJson=snapshot?canonical({snapshot,videoIdentity:info.identity}):null;
  this.db.prepare('UPDATE storyboard_video_v2_bindings SET review_json=?,review_revision=?,reviewed_at=?,revision=?,updated_at=? WHERE id=?').run(reviewJson,snapshot?view.head.revision:null,snapshot?now:null,row.revision+1,now,row.id);
  const current=this.bindingRow(videoId);this.event(input.action==='confirm'?'review':'review-undo',{binding:current,before:{reviewedToRevision:row.review_revision},after:{reviewedToRevision:current.review_revision},view});
  return {context:view.context,binding:this.bindingDTO(current,view),review:this.reviewDTO(current,view,info)};
 });}
};
