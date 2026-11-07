import {randomUUID} from 'node:crypto';
import {canonical,compile,definition,fault} from '../prompt-templates/model.mjs';
import {CODEX_TABLES,codexSchema} from './schema.mjs';
import {validId} from './media.mjs';
import {parseJSON,safeText,taskSummary,displaySummary,taskDTO,taskPageOptions,taskCursor} from './tasks.mjs';

export const ACTIVE=['queued','running','stopping'];
export const STATUSES=[...ACTIVE,'completed','interrupted','failed'];
const json=value=>JSON.parse(value);
const requireId=id=>{if(!validId(id))throw fault('对话或任务 ID 无效');};
export function turnRequest(input) {
  if(!input||!validId(input.id))throw fault('生成任务 ID 无效');
  if(typeof input.model!=='string'||!input.model||input.model.length>200||typeof input.effort!=='string'||input.effort.length>80)throw fault('请选择模型与推理强度');
  const output=input.output===undefined?'mixed':input.output;
  if(!['text','mixed','image'].includes(output))throw fault('输出偏好无效');
  if(input.text!==undefined&&(typeof input.text!=='string'||input.text.length>200000))throw fault('追问内容过长或无效');
  if(input.retry_of!==undefined&&input.retry_of!==null&&!validId(input.retry_of))throw fault('原回答 ID 无效');
  if(input.project_id!==undefined&&!validId(input.project_id))throw fault('图片所属项目无效');
  return {model:input.model,effort:input.effort,output,text:input.text??'',retry_of:input.retry_of??null,...(input.project_id!==undefined?{project_id:input.project_id}:{})};
}
export class CodexStore {
  constructor(lib,prompts){this.lib=lib;this.prompts=prompts;}
  get db(){return this.lib.db;}
  tx(fn){const action=this.db.transaction(fn);return(action.immediate??action)();}
  init(){for(const sql of codexSchema(this.db.kind==='mysql'))this.db.exec(sql);return this;}
  head(id,lock=false){requireId(id);const row=this.db.prepare('SELECT * FROM codex_conversations WHERE id=?'+(lock&&this.db.kind==='mysql'?' FOR UPDATE':'')).get(id);if(!row)throw fault('对话不存在',404);return row;}
  list({templateId,deleted=false}={}){if(templateId)requireId(templateId);return this.db.prepare(`SELECT id,template_id,title,revision,deleted_at,created_at,updated_at FROM codex_conversations WHERE deleted_at IS ${deleted?'NOT ':''}NULL${templateId?' AND template_id=?':''} ORDER BY updated_at DESC,id`).all(...(templateId?[templateId]:[]));}
  create(input){requireId(input.id);return this.tx(()=>{
    const template=this.prompts.head(input.template_id,true);this.prompts.expected(template,input.template_revision);
    const def=this.prompts.version(template.id,template.current_version).definition,result=compile(def,input.values);
    if(result.errors.length)throw fault(result.errors.join('；'));if(result.prompt.length>200000)throw fault('完整提示词最多 20 万字符');
    const context={template_id:template.id,version:template.current_version,definition:def,values:result.values,prompt:result.prompt};
    const existing=this.db.prepare('SELECT * FROM codex_conversations WHERE id=?').get(input.id);
    if(existing){if(existing.context_json!==canonical(context))throw fault('对话 ID 已用于其他内容',409);return this.get(existing.id);}
    const firstValue=Object.values(result.values).find(v=>typeof v==='string'&&v.trim());
    const title=(def.name+(firstValue?' · '+firstValue.replace(/\s+/g,' ').slice(0,36):'')).slice(0,200);
    const now=Date.now();this.db.prepare('INSERT INTO codex_conversations(id,template_id,title,context_json,revision,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(input.id,template.id,title,canonical(context),1,null,now,now);
    return this.get(input.id);
  });}
  get(id){const head=this.head(id);return {...head,context:json(head.context_json),turns:this.db.prepare('SELECT * FROM codex_turns WHERE conversation_id=? ORDER BY sequence_no').all(id).map(row=>this.turn(row))};}
  turn(row){return{...row,request:json(row.request_json),actual:json(row.actual_json),blocks:json(row.blocks_json),usage:json(row.usage_json)};}
  getTurn(id){requireId(id);const row=this.db.prepare('SELECT * FROM codex_turns WHERE id=?').get(id);if(!row)throw fault('生成任务不存在',404);return this.turn(row);}
  taskHead(id){requireId(id);const row=this.db.prepare('SELECT id,conversation_id,status FROM codex_turns WHERE id=?').get(id);if(!row)throw fault('生成任务不存在',404);return row;}
  begin(id,input){const request=turnRequest(input);return this.tx(()=>{
    const head=this.head(id,true),previous=this.db.prepare('SELECT * FROM codex_turns WHERE id=?').get(input.id);
    if(previous){if(previous.conversation_id!==id||previous.request_json!==canonical(request))throw fault('任务 ID 已用于其他内容',409);return{turn:this.turn(previous),existing:true};}
    if(head.deleted_at!==null)throw fault('对话已删除，请先恢复',409);
    if(head.revision!==input.expected_revision)throw fault('对话已更新，请重新读取后发送',409);
    const turns=this.get(id).turns;if(turns.some(t=>ACTIVE.includes(t.status)))throw fault('这个对话仍在生成，请等待或停止',409);
    if(request.retry_of){const source=turns.find(t=>t.id===request.retry_of);if(!source)throw fault('只能重新生成当前对话的回答');if(request.text!==source.request.text)throw fault('重新生成须保留原问题');}
    else if(turns.length&&!request.text.trim())throw fault('请填写追问内容');
    let pictureProject=null;
    if(request.project_id){const project=this.db.prepare('SELECT id,name,project_kind FROM media_projects WHERE id=?').get(request.project_id);if(!project||project.project_kind!=='normal')throw fault('图片所属项目不存在或不可用，请重新选择',409);pictureProject={id:project.id,name:project.name};}
    const sequence=turns.length+1,now=Math.max(Date.now(),head.updated_at+1);
    const actual={...(pictureProject?{pictureProject}:{}),_taskSummary:taskSummary({request})};
    this.db.prepare('INSERT INTO codex_turns(id,conversation_id,sequence_no,request_json,actual_json,blocks_json,usage_json,status,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(input.id,id,sequence,canonical(request),canonical(actual),'[]','{}','queued','',now,now);
    this.bump(head,now);return{turn:this.getTurn(input.id),existing:false,pictureProject};
  });}
  bump(head,now){this.db.prepare('UPDATE codex_conversations SET revision=?,updated_at=? WHERE id=?').run(head.revision+1,now,head.id);}
  updateTurn(id,{blocks,actual,usage,status,errorCode}={}){return this.tx(()=>{
    const old=this.getTurn(id);if(!ACTIVE.includes(old.status))return old;
    if(status&&!STATUSES.includes(status))throw fault('生成状态无效');
    const next={blocks:blocks??old.blocks,actual:actual??old.actual,usage:usage??old.usage,status:status??old.status,errorCode:errorCode??old.error_code};
    // Preserve the accepted project even if execution fails before thread/start.
    next.actual={...next.actual,...(old.actual.pictureProject?{pictureProject:old.actual.pictureProject}:{}),_taskSummary:taskSummary({blocks:next.blocks,actual:next.actual,request:old.request})};
    const blockJSON=canonical(next.blocks);if(blockJSON.length>4_000_000)throw fault('回答内容过大，已停止保存');
    const now=Math.max(Date.now(),old.updated_at+1);
    this.db.prepare('UPDATE codex_turns SET blocks_json=?,actual_json=?,usage_json=?,status=?,error_code=?,updated_at=? WHERE id=?').run(blockJSON,canonical(next.actual),canonical(next.usage),next.status,next.errorCode,now,id);
    if(!ACTIVE.includes(next.status)){const head=this.head(old.conversation_id,true);this.bump(head,Math.max(now,head.updated_at+1));}
    return this.getTurn(id);
  });}
  taskOverview(options={}){
    const {limit,before}=taskPageOptions(options);
    // Do not load conversation context, usage, prompts or unbounded output. New rows
    // carry a small summary on business writes; legacy rows have a bounded fallback.
    const columns=`t.id,t.conversation_id,t.sequence_no,t.status,t.error_code,t.created_at,t.updated_at,
      substr(c.title,1,1024) AS title,c.template_id,c.deleted_at AS conversation_deleted_at,
      substr(p.name,1,1024) AS template_name,p.deleted_at AS template_deleted_at,
      CASE WHEN length(t.actual_json)<=65536 THEN t.actual_json ELSE NULL END AS actual_small,
      CASE WHEN length(t.actual_json)<=65536 AND t.actual_json LIKE '%"_taskSummary":%' THEN NULL WHEN length(t.blocks_json)<=65536 THEN t.blocks_json ELSE NULL END AS blocks_small,
      CASE WHEN length(t.request_json)<=4096 THEN t.request_json ELSE NULL END AS request_small`;
    const source=`FROM codex_turns t JOIN codex_conversations c ON c.id=t.conversation_id LEFT JOIN prompt_templates p ON p.id=c.template_id`;
    const active=this.db.prepare(`SELECT ${columns} ${source} WHERE t.status IN ('queued','running','stopping') ORDER BY t.created_at DESC,t.id DESC`).all();
    const terminal=this.db.prepare(`SELECT ${columns} ${source} WHERE t.status NOT IN ('queued','running','stopping')${before?' AND (t.created_at<? OR (t.created_at=? AND t.id<?))':''} ORDER BY t.created_at DESC,t.id DESC LIMIT ?`).all(...(before?[before.time,before.time,before.id]:[]),limit+1);
    const hasMore=terminal.length>limit,selected=terminal.slice(0,limit);
    const items=[...active,...selected].map(row=>{
      const actual=parseJSON(row.actual_small),blocks=parseJSON(row.blocks_small),request=parseJSON(row.request_small);
      const summary=displaySummary(actual?._taskSummary)??(Array.isArray(blocks)?taskSummary({blocks,actual:actual??{},request:request??{}}):null);
      let project=null;
      if(validId(actual?.pictureProject?.id)){
        const snapshot=actual.pictureProject,current=this.db.prepare('SELECT id,project_kind FROM media_projects WHERE id=?').get(snapshot.id);
        project={id:snapshot.id,name:safeText(snapshot.name,120),available:current?.project_kind==='normal'};
      }
      if(summary)for(const image of summary.images){
        if(image.attachmentId&&!this.db.prepare('SELECT id FROM codex_attachments WHERE id=? AND turn_id=?').get(image.attachmentId,row.id)){
          Object.assign(image,{attachmentId:null,url:null,saved:false,status:'failed',errorCode:'IMAGE_RECEIVE_FAILED'});
          if(!summary.reasons.includes('IMAGE_RECEIVE_FAILED'))summary.reasons.push('IMAGE_RECEIVE_FAILED');
        }
      }
      return taskDTO(row,summary,project);
    });
    return {activeCount:active.length,items,nextCursor:hasMore?taskCursor(selected.at(-1)):null,historyScope:{kind:'recent',order:'createdAtDesc',limit,hasMore,includesDeleted:true}};
  }
  setDeleted(id,deleted,revision){return this.tx(()=>{const head=this.head(id,true);if(head.revision!==revision)throw fault('对话已更新，请重新读取',409);if(this.get(id).turns.some(t=>ACTIVE.includes(t.status)))throw fault('请先停止生成再删除或恢复',409);const now=Math.max(Date.now(),head.updated_at+1);this.db.prepare('UPDATE codex_conversations SET deleted_at=?,revision=?,updated_at=? WHERE id=?').run(deleted?now:null,head.revision+1,now,id);return this.get(id);});}
  attachment(id){requireId(id);const row=this.db.prepare('SELECT * FROM codex_attachments WHERE id=?').get(id);if(!row)throw fault('图片不存在',404);return row;}
  addAttachment(row){const columns=Object.keys(CODEX_TABLES.codex_attachments);this.db.prepare(`INSERT INTO codex_attachments(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>row[k]));return row;}
  recover(){const stale=this.db.prepare("SELECT id FROM codex_turns WHERE status IN ('queued','running','stopping')").all();for(const row of stale)this.updateTurn(row.id,{status:'interrupted',errorCode:'APPLICATION_RESTARTED'});return stale.length;}
  snapshot(){return Object.fromEntries(Object.keys(CODEX_TABLES).map(table=>[table,this.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));}
}
