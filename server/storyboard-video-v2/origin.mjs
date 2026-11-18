import {randomUUID} from 'node:crypto';
import {idOK} from '../project-assets/model.mjs';
import {canonical,hash,fail} from './model.mjs';
const decode=JSON.parse;
export const videoV2Origin={
 validateImportOrigin(sourceProjectId,origin){
  if(!origin||Object.keys(origin).sort().join(',')!=='expectedProvenanceRevision,provenanceId'||!idOK(origin.provenanceId))fail('VIDEO_V2_INVALID_INPUT','storyboardOrigin只接受出处ID及期望修订');
  this.require();const row=this.provenanceRow(origin.provenanceId);
  if(row.instance_id!==this.instanceId||!['reserved','bound'].includes(row.status)||row.revision!==origin.expectedProvenanceRevision)fail('VIDEO_ORIGIN_CONFLICT','出处不在本实例有效预留状态',409);
  if(!this.allowedTargets(sourceProjectId).some(p=>p.projectId===row.project_id))fail('VIDEO_TARGET_SCOPE_CHANGED','出处目标集已不在来源项目允许范围',409);
  const version=this.board.history.row(row.document_id,row.storyboard_revision);if(!version||version.document_json===null)fail('VERSION_PRUNED','原生成出处版本已无法读取',410);
  return row;
 },
 attachOriginInTransaction(sourceProjectId,videoId,input,{receipt=null,reuse=false}={}){
  const provenance=this.provenanceRow(input.provenanceId),existing=this.bindingRow(videoId),info=this.videoInfo(sourceProjectId,videoId);
  const row=this.db.prepare('SELECT * FROM project_video_imports WHERE id=? AND project_id=?').get(input.importRequestId,sourceProjectId),imported=receipt??(row?decode(row.data_json):null);
  if(!imported||imported.id!==input.importRequestId||imported.projectId!==sourceProjectId||imported.status!=='ready'||imported.videoId!==videoId||imported.storyboardOrigin?.provenanceId!==provenance.id||imported.storyboardOrigin?.expectedProvenanceRevision!==input.expectedProvenanceRevision||imported.reusedExisting)fail('VIDEO_ORIGIN_CONFLICT','入库回执与固定出处不匹配',409);
  if(!this.allowedTargets(sourceProjectId).some(p=>p.projectId===provenance.project_id))fail('VIDEO_TARGET_SCOPE_CHANGED','出处目标集已不在来源项目允许范围',409);
  if(existing?.provenance_id===provenance.id){if(existing.source_project_id!==sourceProjectId||existing.origin!=='agent'||existing.target_project_id!==provenance.project_id||existing.document_id!==provenance.document_id||existing.initialized_at!==provenance.initialized_at||existing.storyboard_revision!==provenance.storyboard_revision||decode(existing.snapshot_json).videoIdentity!==info.identity)fail('VIDEO_ORIGIN_CONFLICT','原出处归属异常',409);return {status:'bound',bindingId:existing.id,bindingRevision:existing.revision,provenanceId:provenance.id,targetProjectId:existing.target_project_id,storyboardRevision:existing.storyboard_revision};}
  if(existing||reuse||info.meta.data.removedAt)fail('VIDEO_ORIGIN_CONFLICT','该旧片已有对应或来自复用，不能覆盖原来历',409);
  if((existing?.revision??0)!==input.expectedBindingRevision)fail('VIDEO_BINDING_CONFLICT','视频绑定已变化',409);
  this.validateImportOrigin(sourceProjectId,{provenanceId:input.provenanceId,expectedProvenanceRevision:input.expectedProvenanceRevision});
  if(imported.hash!==info.meta.data.sha256)fail('VIDEO_ORIGIN_CONFLICT','入库内容身份与固定出处不匹配',409);
  this.assertBindable(sourceProjectId,videoId);
  const target=this.board.head(provenance.project_id,true);if(!target||target.id!==provenance.document_id)fail('VIDEO_ORIGIN_CONFLICT','原出处文档不存在，未伪造新对应',409);
  const snapshot=decode(provenance.snapshot_json);snapshot.videoIdentity=info.identity;
  const now=Date.now(),binding={id:videoId,video_id:videoId,source_project_id:sourceProjectId,target_project_id:provenance.project_id,document_id:provenance.document_id,initialized_at:provenance.initialized_at,storyboard_revision:provenance.storyboard_revision,origin:'agent',provenance_id:provenance.id,snapshot_json:canonical(snapshot),review_json:null,review_revision:null,reviewed_at:null,bound_at:now,revision:1,created_at:now,updated_at:now};
  this.insert('storyboard_video_v2_bindings',binding);
  for(const [ordinal,shot]of snapshot.shots.entries())this.insert('storyboard_video_v2_shots',{id:randomUUID(),binding_id:binding.id,video_id:videoId,source_project_id:sourceProjectId,target_project_id:provenance.project_id,document_id:provenance.document_id,initialized_at:provenance.initialized_at,shot_id:shot.shotId,ordinal,number_at_binding:shot.number,duration_ms:shot.durationMs,association_seq:this.sequence(),created_at:now,updated_at:now});
  this.db.prepare('UPDATE storyboard_video_v2_provenance SET status=?,revision=?,updated_at=? WHERE id=?').run('bound',provenance.revision+1,now,provenance.id);
  this.event('record-origin',{binding,provenance,after:this.bindingDTO(binding)});
  return {status:'bound',bindingId:binding.id,bindingRevision:1,provenanceId:provenance.id,targetProjectId:provenance.project_id,storyboardRevision:provenance.storyboard_revision};
 },
 autoRecordOrigin(sourceProjectId,videoId,receipt,{reuse=false}={}){
  this.lock([sourceProjectId,this.provenanceRow(receipt.storyboardOrigin.provenanceId).project_id]);
  const input={requestId:receipt.id,provenanceId:receipt.storyboardOrigin.provenanceId,expectedProvenanceRevision:receipt.storyboardOrigin.expectedProvenanceRevision,expectedBindingRevision:0,importRequestId:receipt.id};
  const scope=sourceProjectId+':'+videoId,repeated=this.replay('record-origin',scope,input);if(repeated)return repeated.binding;
  const binding=this.attachOriginInTransaction(sourceProjectId,videoId,input,{receipt,reuse}),now=Date.now();this.insert('storyboard_video_v2_requests',{id:input.requestId,operation:'record-origin',scope,request_hash:hash(input),status:'committed',result_json:canonical({binding,requestId:input.requestId,repeated:false}),created_at:now,updated_at:now});return binding;
 },
 async recordOrigin(sourceProjectId,videoId,input){
  if(!input||Object.keys(input).some(k=>!['requestId','provenanceId','expectedProvenanceRevision','expectedBindingRevision','importRequestId'].includes(k)))fail('VIDEO_V2_INVALID_INPUT','补记出处请求字段无效');
  if(!idOK(input.provenanceId)||!idOK(input.importRequestId)||!Number.isSafeInteger(input.expectedProvenanceRevision)||input.expectedProvenanceRevision<1||!Number.isSafeInteger(input.expectedBindingRevision)||input.expectedBindingRevision<0)fail('VIDEO_V2_INVALID_INPUT','出处确认的ID或期望修订无效');
  this.require();const replay=this.replay('record-origin',sourceProjectId+':'+videoId,input);if(replay)return replay;
  const checked=await this.catalog.verifiedSource(sourceProjectId,videoId),proof=this.videos.proof(checked),p=this.provenanceRow(input.provenanceId);
  return this.mutation('record-origin',sourceProjectId+':'+videoId,input,[sourceProjectId,p.project_id],()=>{if(this.videos.proof(this.source(sourceProjectId,videoId))!==proof)fail('VIDEO_ORIGIN_CONFLICT','核验期间视频身份变化',409);return {binding:this.attachOriginInTransaction(sourceProjectId,videoId,input)};});
 }
};
