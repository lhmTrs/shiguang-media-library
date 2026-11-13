import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {canonical,digest,fault,idOK} from '../project-assets/model.mjs';
import {generationSchema} from './schema.mjs';
import {safeText,taskPageOptions,taskCursor} from '../prompt-codex/tasks.mjs';
export const ACTIVE=['accepted','generating','validating','importing','stopping'];
const DISPLAY_COLUMNS='id,project_id,status,phase,error_code,error_json,result_json,expected_revision,lock_generation,deadline_at,resource_state,created_at,updated_at,model,effort,project_name';
const error=(code,message,status=409,extra={})=>fault(message,status,{code,...extra});
export class GenerationStore{
 constructor(lib,storyboards){this.lib=lib;this.storyboards=storyboards;this.context=new AsyncLocalStorage();}
 get db(){return this.lib.db;}
 tx(fn){const t=this.db.transaction(fn);return(t.immediate??t)();}
 init(){for(const sql of generationSchema(this.db.kind==='mysql'))this.db.exec(sql);this.storyboards.generationLocks=this;this.storyboards.assets.generationLocks=this;return this;}
 sqlLock(){return this.db.kind==='mysql'?' FOR UPDATE':'';}
 head(id){if(!idOK(id))throw error('INVALID_TASK_ID','任务编号无效',400);const row=this.db.prepare('SELECT * FROM sb_generation_tasks WHERE id=?').get(id);if(!row)throw error('TASK_NOT_FOUND','分镜任务不存在',404);return row;}
 display(id){if(!idOK(id))throw error("INVALID_TASK_ID","任务编号无效",400);const row=this.db.prepare(`SELECT ${DISPLAY_COLUMNS} FROM sb_generation_tasks WHERE id=?`).get(id);if(!row)throw error("TASK_NOT_FOUND","分镜任务不存在",404);return row;}
 lock(projectId){return this.db.prepare('SELECT * FROM sb_generation_locks WHERE id=?'+this.sqlLock()).get(projectId);}
 assertWritable(projectId){const row=this.lock(projectId),owner=this.context.getStore();if(row?.owner_task_id&&!(owner?.id===row.owner_task_id&&owner.generation===row.generation))throw error('STORYBOARD_GENERATION_LOCKED','当前项目正在生成分镜，全部分镜和关联资料编辑暂时冻结',423,{taskId:row.owner_task_id});}
 assertRestoreProjects(ids){for(const id of [...new Set(ids)].sort()){this.storyboards.assets.project(id,true);this.assertWritable(id);}}
 assetStamp(projectId){
  const member=this.storyboards.lib.projectSeries?.membership(projectId);
  const local=this.db.prepare('SELECT id,revision,name,archived_at FROM creative_assets WHERE project_id=? ORDER BY id').all(projectId);
  if(!member?.series_id)return digest(local);
  const shared=this.db.prepare("SELECT id,revision,name,archived_at FROM creative_assets WHERE owner_type='series' AND owner_id=? ORDER BY id").all(member.series_id);
  const overrides=this.db.prepare(`SELECT id,revision,value_json FROM creative_asset_overrides WHERE
    (scope_type='episode' AND scope_id=?) OR (scope_type='season' AND scope_id=?) ORDER BY id`).all(projectId,member.season_id);
  const config=this.db.prepare('SELECT revision FROM series_attribute_configs WHERE id=?').get(member.series_id);
  const scores=this.db.prepare('SELECT id,revision FROM series_character_attributes WHERE series_id=? ORDER BY id').all(member.series_id);
  return digest({member,local,shared,overrides,config,scores});
 }
 admit(id,snapshot,inputHash,deadlineAt){return this.tx(()=>{this.storyboards.assets.lockDirectory();this.storyboards.project(snapshot.project.id,true);const existing=this.db.prepare('SELECT * FROM sb_generation_tasks WHERE id=?').get(id);if(existing){if(existing.input_hash!==inputHash)throw error('REQUEST_ID_CONFLICT','请求编号已用于不同生成配置');return{row:existing,repeated:true};}this.assertWritable(snapshot.project.id);this.storyboards.expected(this.storyboards.head(snapshot.project.id),snapshot.expected_revision);if(this.assetStamp(snapshot.project.id)!==snapshot.assetStamp)throw error('PROJECT_ASSETS_CHANGED','项目资料已更新，请重新检查后发送');
  if(this.db.prepare('SELECT id FROM storyboard_import_requests WHERE id=?').get(id))throw error('REQUEST_ID_CONFLICT','请求编号已用于其他分镜初始化');
  if(this.db.prepare('SELECT id FROM codex_turns WHERE id=?').get(id))throw error('REQUEST_ID_CONFLICT','任务编号已用于其他Codex任务');
  const now=Date.now(),old=this.lock(snapshot.project.id),generation=(old?.generation??0)+1;
  if(old)this.db.prepare('UPDATE sb_generation_locks SET owner_task_id=?,generation=?,updated_at=? WHERE id=?').run(id,generation,now,snapshot.project.id);else this.db.prepare('INSERT INTO sb_generation_locks VALUES(?,?,?,?,?)').run(snapshot.project.id,id,generation,now,now);
  this.db.prepare('INSERT INTO sb_generation_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,snapshot.project.id,inputHash,canonical(snapshot),'accepted','waitingConnection','','[]','{}','',snapshot.expected_revision,generation,deadlineAt,'owned',now,now,snapshot.model,snapshot.effort,snapshot.project.name);
  for(const rule of snapshot.rules)this.db.prepare('UPDATE sb_rules SET last_used=? WHERE id=?').run(now,rule.id);
  return{row:this.head(id),repeated:false};});}
 update(id,patch){const old=this.head(id),fields={...patch,updated_at:Math.max(Date.now(),old.updated_at+1)},keys=Object.keys(fields);if(keys.some(k=>!['status','phase','error_code','error_json','result_json','output_text','resource_state','updated_at'].includes(k)))throw error('INVALID_TASK_UPDATE','任务字段无效',400);this.db.prepare('UPDATE sb_generation_tasks SET '+keys.map(k=>k+'=?').join(',')+' WHERE id=?').run(...keys.map(k=>fields[k]),id);return this.head(id);}
 release(row){this.db.prepare('UPDATE sb_generation_locks SET owner_task_id=NULL,updated_at=? WHERE id=? AND owner_task_id=? AND generation=?').run(Date.now(),row.project_id,row.id,row.lock_generation);}
 revoke(id,code,status='failed',errors=[]){return this.tx(()=>{const row=this.head(id);this.storyboards.project(row.project_id,true);if(!ACTIVE.includes(row.status))return row;this.update(id,{status,phase:status,error_code:code,error_json:canonical(errors)});this.release(row);return this.head(id);});}
 commit(id,validated){return this.tx(()=>{this.storyboards.assets.lockDirectory();const row=this.head(id);this.storyboards.project(row.project_id,true);const lock=this.lock(row.project_id);if(!ACTIVE.includes(row.status)||lock?.owner_task_id!==id||lock.generation!==row.lock_generation||Date.now()>=row.deadline_at)throw error('GENERATION_REVOKED','任务已作废，迟到结果不能覆盖分镜');const snapshot=JSON.parse(row.snapshot_json);this.storyboards.expected(this.storyboards.head(row.project_id),row.expected_revision);if(this.assetStamp(row.project_id)!==snapshot.assetStamp)throw error('PROJECT_ASSETS_CHANGED','项目资料发生变化，未覆盖分镜');
  return this.context.run({id,generation:row.lock_generation},()=>{const result=this.storyboards.initializeInTransaction(row.project_id,{request_id:id,expected_revision:row.expected_revision,source:validated.source,filename:'Codex分镜.json',timing:'duration'});this.update(id,{status:'completed',phase:'completed',error_code:'',error_json:'[]',result_json:canonical(result.receipt)});this.release(row);return this.head(id);});
 });}
 recover(){return this.tx(()=>{const rows=this.db.prepare(`SELECT ${DISPLAY_COLUMNS} FROM sb_generation_tasks WHERE status IN ('accepted','generating','validating','importing','stopping')`).all();for(const row of rows){this.storyboards.assets.project(row.project_id,true);const receipt=this.db.prepare('SELECT result_json FROM storyboard_import_requests WHERE id=? AND project_id=?').get(row.id,row.project_id);this.update(row.id,receipt?{status:'completed',phase:'completed',result_json:receipt.result_json,resource_state:'restartUnknown'}:{status:'interrupted',phase:'interrupted',error_code:'APPLICATION_RESTARTED',resource_state:'restartUnknown'});this.release(row);}return rows.length;});}
 dto(row){const receipt=JSON.parse(row.result_json),errors=JSON.parse(row.error_json),project=this.db.prepare('SELECT id,name,project_kind FROM media_projects WHERE id=?').get(row.project_id);return{taskId:row.id,type:'storyboard',projectId:row.project_id,status:row.status,phase:row.phase,model:row.model,effort:row.effort,errorCode:row.error_code,errors,receipt:Object.keys(receipt).length?receipt:null,expectedRevision:row.expected_revision,generation:row.lock_generation,deadlineAt:row.deadline_at,resourceState:row.resource_state,createdAt:row.created_at,updatedAt:row.updated_at,project:project?{id:project.id,name:safeText(row.project_name,120),available:project.project_kind==='normal'}:{id:row.project_id,name:'项目不可用',available:false},terminalRevision:ACTIVE.includes(row.status)?null:`${row.status}:${row.error_code}:${row.updated_at}`};}
 overview(options={}){const {limit,before}=taskPageOptions(options),active=this.db.prepare(`SELECT ${DISPLAY_COLUMNS} FROM sb_generation_tasks WHERE status IN ('accepted','generating','validating','importing','stopping') ORDER BY created_at DESC,id DESC`).all(),terminal=this.db.prepare(`SELECT ${DISPLAY_COLUMNS} FROM sb_generation_tasks WHERE status NOT IN ('accepted','generating','validating','importing','stopping')`+(before?' AND (created_at<? OR (created_at=? AND id<?))':'')+' ORDER BY created_at DESC,id DESC LIMIT ?').all(...(before?[before.time,before.time,before.id]:[]),limit+1),hasMore=terminal.length>limit;
  const items=[...active,...terminal.slice(0,limit)].map(r=>{const item=this.dto(r),status=ACTIVE.includes(r.status)?(r.status==='accepted'?'queued':r.status==='stopping'?'stopping':'running'):r.status==='completed'?'completed':r.status==='stopped'?'interrupted':r.status==='interrupted'?'interrupted':'failed';return{...item,status,storyboardStatus:r.status,conversationId:null,templateId:null,title:item.project.name+' · 分镜生成',templateName:'导演分镜 JSON',templateDeleted:false,conversationDeleted:false,sequence:1,model:r.model,effort:r.effort,preview:'',images:[],imageCount:0,summaryUnavailable:false,attention:{required:['failed','timed_out','interrupted'].includes(r.status),reasons:r.error_code?[r.error_code]:[]},errorCode:r.status==='stopped'?'USER_STOPPED':r.error_code};});
  return{activeCount:active.length,items,nextCursor:hasMore?taskCursor(terminal[limit-1]):null,historyScope:{kind:'recent',order:'createdAtDesc',limit,hasMore,includesDeleted:true}};
 }
 projectState(id){this.storyboards.project(id);const lock=this.db.prepare('SELECT * FROM sb_generation_locks WHERE id=?').get(id),task=lock?.owner_task_id?this.dto(this.display(lock.owner_task_id)):null;return{projectId:id,locked:!!lock?.owner_task_id,ownerTaskId:lock?.owner_task_id??null,generation:lock?.generation??0,task};}
}
