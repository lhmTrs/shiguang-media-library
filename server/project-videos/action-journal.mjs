import {canonical,digest,idOK} from '../project-assets/model.mjs';
import {fail} from '../storyboard-video/model.mjs';

// Shared operation table, distinct namespace. A receipt is never an instruction
// to repeat a desktop side effect after a lost response or an App restart.
export class VideoActionJournal {
  constructor(catalog) { this.catalog=catalog;this.active=new Map();this.tail=Promise.resolve();this.closed=false; }
  get db(){return this.catalog.db;}
  row(id,requestId) {
    this.catalog.project(id);
    if(!idOK(requestId))fail('INVALID_REQUEST_ID','请求编号无效');
    const row=this.db.prepare('SELECT * FROM project_video_operations WHERE id=? AND project_id=?').get(requestId,id);
    if(!row)fail('DESKTOP_ACTION_NOT_FOUND','未找到原操作，请勿自动重新发送',404);
    const s=JSON.parse(row.data_json);
    if(s.namespace!=='video-desktop-v1')fail('REQUEST_ID_CONFLICT','请求编号属于其他文件操作',409);
    return s;
  }
  save(s) {this.db.prepare('UPDATE project_video_operations SET data_json=?,updated_at=? WHERE id=? AND project_id=?').run(canonical(s),Date.now(),s.requestId,s.projectId);}
  begin(id,action,input) {
    this.catalog.project(id);
    if(this.closed||this.catalog.media.closing)fail('VIDEO_CLOSING','视频模块正在关闭',503);
    if(!idOK(input?.requestId))fail('INVALID_REQUEST_ID','请提供固定请求编号');
    const args=digest({action,input}),old=this.db.prepare('SELECT * FROM project_video_operations WHERE id=?').get(input.requestId);
    if(old) {
      const s=JSON.parse(old.data_json);
      if(old.project_id!==id||s.namespace!=='video-desktop-v1'||s.args!==args)fail('REQUEST_ID_CONFLICT','请求编号已用于其他操作或输入',409);
      return {s,repeated:true};
    }
    if(this.active.size>=16)fail('DESKTOP_QUEUE_FULL','后台视频任务较多，请等待原任务完成',429);
    const s={namespace:'video-desktop-v1',requestId:input.requestId,projectId:id,action,args,instance:this.catalog.instance,status:'checking',createdAt:Date.now(),progress:{checked:0,total:input.ids?.length||1}};
    this.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(s.requestId,id,canonical(s),s.createdAt,s.createdAt);
    return {s,repeated:false};
  }
  dto(s) {
    if(['checking','running'].includes(s.status)&&!this.active.has(s.requestId))return {requestId:s.requestId,projectId:s.projectId,action:s.action,status:'unknown',code:'ACTION_INTERRUPTED',error:'上次操作未取得最终回执；没有自动重复执行，请核对原请求',reason:'上次操作未取得最终回执；没有自动重复执行，请核对原请求',...(s.partial||{})};
    if(['checking','running'].includes(s.status))return {requestId:s.requestId,projectId:s.projectId,action:s.action,status:s.status==='running'?'dispatching':'checking',progress:s.progress,processed:s.progress.checked,total:s.progress.total,statusUrl:`/api/project-videos/projects/${s.projectId}/desktop-actions/${s.requestId}`};
    return s.result||{requestId:s.requestId,projectId:s.projectId,action:s.action,status:s.status,progress:s.progress,code:s.code,reason:s.reason};
  }
  start(id,action,input,run) {
    const {s,repeated}=this.begin(id,action,input);
    if(repeated)return this.dto(s);
    const work=this.tail.catch(()=>{}).then(()=>this.catalog.media.track(async()=>{
      try {
        if(this.closed)fail('VIDEO_CLOSING','视频模块正在关闭',503);
        s.result=await run(s);s.status=s.result.status||'completed';this.save(s);
      } catch(e) {
        // Once dispatched, lack of an ACK means UNKNOWN, never "not done".
        s.status=s.dispatched?'unknown':'failed';s.code=e.code||'VIDEO_ACTION_FAILED';s.reason=e.status?e.message:'视频操作未完成，请查询原请求';
        s.result={requestId:s.requestId,projectId:id,action,status:s.status,code:s.code,error:s.reason,reason:s.reason,...(s.partial||{})};this.save(s);
      }
      return this.dto(s);
    })).finally(()=>this.active.delete(s.requestId));
    this.active.set(s.requestId,work);this.tail=work;work.catch(()=>{});
    return this.dto(s);
  }
  async settle(){this.closed=true;await this.tail;}
}
