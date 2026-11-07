import {createHash} from 'node:crypto';
import {conciergeSchema} from './schema.mjs';
import {canonical} from '../prompt-templates/model.mjs';
import {AsyncLocalStorage} from 'node:async_hooks';
export const activeStatuses=['starting','running','stop_requested','unknown'];
export const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export const fault=(message,status=400,code='CONCIERGE_INVALID_REQUEST')=>Object.assign(Error(message),{status,code});
export const digest=v=>createHash('sha256').update(typeof v==='string'?v:canonical(v)).digest('hex');
export function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw fault('管家请求参数无效');}
export class ConciergeStore{
  constructor(lib){this.lib=lib;this.databaseContext=new AsyncLocalStorage();}
  get db(){return this.databaseContext.getStore()??this.lib.db;}
  capture(fn){return this.databaseContext.getStore()?fn():this.databaseContext.run(this.lib.db,fn);}
  inDatabase(db,fn){return this.databaseContext.run(db,fn);}
  init(){for(const sql of conciergeSchema(this.db.kind==='mysql'))this.db.exec(sql);return this;}
  tx(fn){const tx=this.db.transaction(fn);return(tx.immediate??tx)();}
  scope(value){
    if(value==='global')return{scope:'global',title:'全局管家',projectId:null};
    if(!uuid(value))throw fault('请选择管家所属项目');
    const p=this.db.prepare('SELECT id,name,project_kind FROM media_projects WHERE id=?').get(value);
    if(!p)throw fault('管家所属项目不存在',404);
    if(p.project_kind==='public')throw fault('公共人物请使用全局管家');
    return{scope:p.id,projectId:p.id,title:p.name+' · 管家'};
  }
  binding(scope){this.scope(scope);return this.db.prepare('SELECT * FROM concierge_scopes WHERE scope=?').get(scope)??null;}
  createBinding(scope){return this.tx(()=>{const old=this.binding(scope);if(old)return old;const now=Date.now();this.db.prepare('INSERT INTO concierge_scopes VALUES(?,?,?,?,?,?)').run(scope,'','empty','',now,now);return this.binding(scope);});}
  bindingPhase(scope,phase,threadId,error=''){this.db.prepare('UPDATE concierge_scopes SET phase=?,thread_id=?,error=?,updated_at=? WHERE scope=?').run(phase,threadId??'',error,Date.now(),scope);return this.binding(scope);}
  rule(scope){this.scope(scope);const row=this.db.prepare('SELECT * FROM concierge_rules WHERE scope=?').get(scope);return row?{text:row.content,revision:Number(row.revision)}:{text:'',revision:0};}
  saveRule(input){exact(input,['scope','text','expected_revision']);this.scope(input.scope);if(typeof input.text!=='string'||input.text.length>32000||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<0)throw fault('管家说明或版本无效');return this.tx(()=>{const row=this.rule(input.scope);if(row.revision!==input.expected_revision)throw fault('管家说明已更新，请重新读取后保存',409,'CONCIERGE_RULE_CONFLICT');const now=Date.now();if(row.revision)this.db.prepare('UPDATE concierge_rules SET content=?,revision=?,updated_at=? WHERE scope=? AND revision=?').run(input.text,row.revision+1,now,input.scope,row.revision);else this.db.prepare('INSERT INTO concierge_rules VALUES(?,?,?,?,?)').run(input.scope,input.text,1,now,now);return this.rule(input.scope);});}
  rawTask(id){return this.db.prepare('SELECT * FROM concierge_tasks WHERE id=?').get(id)??null;}
  task(id,scope){const row=this.rawTask(id);if(!row||scope&&row.scope!==scope)throw fault('未找到这个管家任务',404);return this.dto(row);}
  dto(row){let title='已移除项目的管家';try{title=this.scope(row.scope).title;}catch{}return{id:row.id,scope:row.scope,title,threadId:row.thread_id||null,turnId:row.turn_id||null,status:row.status,model:row.model,effort:row.effort,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),error:row.error,items:[],attachmentIds:JSON.parse(row.attachment_ids),allowWrites:!!row.allow_writes};}
  tasks(scope='all'){if(scope!=='all')this.scope(scope);const rows=scope==='all'?this.db.prepare('SELECT * FROM concierge_tasks ORDER BY created_at DESC LIMIT 50').all():this.db.prepare('SELECT * FROM concierge_tasks WHERE scope=? ORDER BY created_at DESC LIMIT 50').all(scope);return rows.map(r=>this.dto(r));}
  active(scope){return this.tasks(scope).find(t=>activeStatuses.includes(t.status))??null;}
  begin(input,hash,ruleHash){return this.tx(()=>{const old=this.rawTask(input.id);if(old){if(old.scope!==input.scope||old.request_hash!==hash)throw fault('请求编号已用于其他内容',409,'CONCIERGE_REQUEST_CONFLICT');return{task:this.dto(old),existing:true};}if(this.active(input.scope))throw fault('此对话仍在运行或结果待核对，请先查看原任务',409,'CONCIERGE_BUSY');const now=Date.now();this.db.prepare('INSERT INTO concierge_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.id,input.scope,'','',hash,'starting',input.model,input.effort,JSON.stringify(input.attachmentIds),input.allowWrites?1:0,ruleHash,'',now,now);return{task:this.task(input.id),existing:false};});}
  update(id,values){const allowed=['thread_id','turn_id','status','error'];const entries=Object.entries(values);if(entries.some(([k])=>!allowed.includes(k)))throw Error('Invalid task update');this.db.prepare(`UPDATE concierge_tasks SET ${entries.map(([k])=>k+'=?').join(',')},updated_at=? WHERE id=?`).run(...entries.map(([,v])=>v??''),Date.now(),id);return this.task(id);}
  recoverInterrupted(){this.db.prepare("UPDATE concierge_tasks SET status='unknown',error=?,updated_at=? WHERE status IN ('starting','running','stop_requested')").run('服务曾重新启动，本轮结果待核对，未自动重发。',Date.now());}
}
