import {idOK} from '../project-assets/model.mjs';
import {V2_TABLES,SCHEMA_VERSION} from './schema.mjs';
import {canonical,hash,fail,rows} from './model.mjs';
const decode=value=>value==null?null:JSON.parse(value);
const bad=message=>fail('VIDEO_V2_UNSETTLED',message,503);
export const videoV2Backup={
 snapshot(){this.requireSchema();return {format:'shiguang-video-binding-v2',schemaVersion:SCHEMA_VERSION,tables:Object.fromEntries(Object.keys(V2_TABLES).map(table=>[table,this.db.prepare('SELECT * FROM '+table+' ORDER BY id').all()]))};},
 validateSnapshot(input,{documents,projects,sources,history}={}){
  if(!input||input.format!=='shiguang-video-binding-v2'||input.schemaVersion!==SCHEMA_VERSION||canonical(Object.keys(input.tables??{}).sort())!==canonical(Object.keys(V2_TABLES).sort()))bad('视频绑定v2备份格式无效');
  const maps={};
  for(const [table,columns]of Object.entries(V2_TABLES)){
   const data=input.tables[table];if(!Array.isArray(data)||data.length>100000)bad('视频绑定v2备份行数量无效');const entries=new Map();maps[table]=entries;
   for(const row of data){
    if(!row||canonical(Object.keys(row).sort())!==canonical(Object.keys(columns).sort())||entries.has(row.id))bad('视频绑定v2备份权威行字段重复或缺失');
    for(const [key,type]of Object.entries(columns)){
     const value=row[key];if(value===null&&type.startsWith('nullable'))continue;
     if(['integer','nullableInteger'].includes(type)){if(!Number.isSafeInteger(value)||value<0)bad('视频绑定v2整数无效');}
     else if(typeof value!=='string'||value.includes('\0')||value.length>(type.endsWith('Text')||type==='text'?4*1024*1024:type==='hash'?64:160))bad('视频绑定v2文字字段无效');
     if(['id','ref','nullableRef'].includes(type)&&!idOK(value))bad('视频绑定v2权威ID无效');
     if(type==='hash'&&!/^[a-f0-9]{64}$/.test(value))bad('视频绑定v2摘要无效');
     if(key.endsWith('_json')&&value!==null)try{JSON.parse(value);}catch{bad('视频绑定v2快照JSON无效');}
    }
    if(row.updated_at<row.created_at)bad('视频绑定v2时间无效');entries.set(row.id,row);
   }
  }
  const state=maps.storyboard_video_v2_state,global=state.get('global'),migration=state.get('migration');if(!global||!migration||decode(global.data_json).schemaVersion!==SCHEMA_VERSION||!['complete','pending'].includes(decode(migration.data_json).status))bad('视频绑定v2全局/迁移状态无效');
  const docs=new Map((documents??[]).map(d=>[d.id,d])),pids=new Set((projects??[]).map(p=>p.id)),sourceMap=new Map((sources??[]).map(s=>[s.id,s])),versions=new Map((history?.tables?.storyboard_versions??[]).map(v=>[v.document_id+':'+v.version,v]));
  const context=(row,required=true)=>{if(!row.document_id)return;if(documents&&(docs.get(row.document_id)?.project_id!==row.project_id&&docs.get(row.document_id)?.project_id!==row.target_project_id))bad('视频绑定v2引用文档跨项目');if(required&&history){const v=versions.get(row.document_id+':'+row.storyboard_revision);if(!v?.document_json)bad('视频绑定v2被引用版本缺少完整版');}};
  const snapshot=(row,encoded,revision=row.storyboard_revision)=>{const s=decode(encoded);if(!s||s.schemaVersion!==1||s.context?.projectId!==(row.project_id??row.target_project_id)||s.context.documentId!==row.document_id||s.context.initializedAt!==row.initialized_at||s.context.storyboardRevision!==revision||!Array.isArray(s.shots)||!Array.isArray(s.shotIds)||canonical(s.shots.map(q=>q.shotId))!==canonical(s.shotIds))bad('快照与权威行身份不一致');const {inputHash,videoIdentity,...original}=s;if(inputHash!==hash(original))bad('规范化输入摘要无效');
   const version=versions.get(row.document_id+':'+revision);if(version?.document_json){const project=decode(version.document_json),actual=rows(project),byId=new Map(actual.map(r=>[r.shot.id,r]));if(project.document_id!==row.document_id||canonical(s.order)!==canonical(actual.map(r=>r.shot.id))||new Set(s.shotIds).size!==s.shotIds.length||!s.shots.length)bad('快照镜头范围与被引用完整版不一致');let previous=-1;for(const shot of s.shots){const q=byId.get(shot.shotId);if(!q||q.index<=previous||q.index!==shot.ordinal||q.number!==shot.number||q.shot.duration_ms!==shot.durationMs)bad('快照镜头身份与被引用完整版不一致');previous=q.index;}}
   return s;};
  const bindings=maps.storyboard_video_v2_bindings,provenance=maps.storyboard_video_v2_provenance,videoIds=new Set(),requestIds=new Set();
  for(const row of provenance.values()){if(!['reserved','bound','released'].includes(row.status)||row.revision<1||requestIds.has(row.request_id)||projects&&!pids.has(row.project_id))bad('出处状态或项目无效');requestIds.add(row.request_id);const s=snapshot(row,row.snapshot_json);if(s.inputHash!==row.input_hash||s.context.instanceId!==row.instance_id||canonical(s.shotIds)!==canonical(decode(row.shot_ids_json)))bad('出处身份/输入不一致');context(row,row.status!=='released');}
  for(const row of bindings.values()){
   if(videoIds.has(row.video_id)||row.revision<1||!['manual','agent'].includes(row.origin)||sources&&sourceMap.get(row.video_id)?.project_id!==row.source_project_id||row.provenance_id&&!provenance.has(row.provenance_id))bad('视频绑定权威归属或唯一身份无效');videoIds.add(row.video_id);
   if(row.target_project_id){snapshot(row,row.snapshot_json);context(row);if(row.review_json){const review=decode(row.review_json);snapshot(row,canonical(review.snapshot),row.review_revision);if(!Number.isSafeInteger(row.review_revision)||!row.reviewed_at||!review.videoIdentity)bad('复核基准无效');if(history&&!versions.get(row.document_id+':'+row.review_revision)?.document_json)bad('复核版缺少完整版');}}
   else if(['document_id','initialized_at','storyboard_revision','snapshot_json','review_json','review_revision','reviewed_at','bound_at'].some(k=>row[k]!==null))bad('解绑行残留有效对应快照');
  }
  const relations=new Set();for(const row of maps.storyboard_video_v2_shots.values()){const binding=bindings.get(row.binding_id),s=binding?.snapshot_json?decode(binding.snapshot_json).shots[row.ordinal]:null,key=row.binding_id+':'+row.shot_id;if(!binding||relations.has(key)||!s||s.shotId!==row.shot_id||s.number!==row.number_at_binding||s.durationMs!==row.duration_ms||row.association_seq<1||row.association_seq>global.sequence||['video_id','source_project_id','target_project_id','document_id','initialized_at'].some(k=>row[k]!==binding[k]))bad('镜头索引与绑定快照不一致');relations.add(key);}
  for(const b of bindings.values())if(b.target_project_id){const count=input.tables.storyboard_video_v2_shots.filter(s=>s.binding_id===b.id).length;if(count!==decode(b.snapshot_json).shots.length)bad('绑定镜头索引未全覆盖');}
  const chosen=new Set();for(const row of maps.storyboard_video_v2_selections.values()){const binding=bindings.get(row.binding_id),key=canonical([row.target_project_id,row.document_id,row.initialized_at,row.shot_id]);if(chosen.has(key)||!['whole','shot'].includes(row.kind)||!binding||['video_id','source_project_id','target_project_id','document_id','initialized_at'].some(k=>row[k]!==binding[k])||!relations.has(row.binding_id+':'+row.shot_id)||row.selection_seq<1||row.selection_seq>global.sequence)bad('采用身份或对应关系无效');chosen.add(key);}
  for(const row of maps.storyboard_video_v2_events.values()){if(row.binding_id&&!bindings.has(row.binding_id)||row.provenance_id&&!provenance.has(row.provenance_id)||row.sequence<1||row.sequence>global.sequence)bad('历史绑定事件引用无效');context(row);for(const value of [decode(row.before_json),decode(row.after_json)])if(value?.bindingId&&value.bindingId!==row.binding_id)bad('事件JSON不能覆盖权威绑定ID');}
  for(const row of maps.storyboard_video_v2_requests.values()){const result=decode(row.result_json);if(!['committed','rejected'].includes(row.status)||row.status==='committed'&&result.requestId!==row.id||row.status==='rejected'&&typeof result.code!=='string')bad('请求回执身份无效');}
  return input;
 },
 restoreRows(input){
  this.requireSchema();this.validateSnapshot(input,{documents:this.db.prepare('SELECT * FROM storyboard_documents').all(),projects:this.db.prepare('SELECT * FROM media_projects').all(),sources:this.db.prepare('SELECT * FROM storyboard_video_sources').all(),history:this.board.history.snapshot()});
  const current=this.snapshot();const business=Object.entries(current.tables).filter(([table])=>table!=='storyboard_video_v2_state').some(([,data])=>data.length>0);
  if(business){if(canonical(current)!==canonical(input))fail('VIDEO_BINDING_CONFLICT','目标已有不同视频绑定v2记录，未覆盖',409);return;}
  for(const table of Object.keys(V2_TABLES)){if(table==='storyboard_video_v2_state')this.db.exec('DELETE FROM storyboard_video_v2_state');for(const row of input.tables[table])this.insert(table,row);}
 },
 markLegacyRestored(){this.requireSchema();const hasLegacy=['storyboard_video_takes','storyboard_video_plans','storyboard_video_requests'].some(table=>this.db.prepare('SELECT id FROM '+table+' LIMIT 1').get());if(hasLegacy){const row=this.stateRow('migration'),data={...decode(row.data_json),status:'pending',legacyRestored:true};this.db.prepare('UPDATE storyboard_video_v2_state SET revision=?,data_json=?,updated_at=? WHERE id=?').run(row.revision+1,canonical(data),Date.now(),'migration');}}
};
