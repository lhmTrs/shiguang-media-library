import {canonical,digest,idOK} from '../project-assets/model.mjs';
export function usageFail(code,message,status=400,details={}){throw Object.assign(Error(message),{code,status,details});}
const fail=usageFail;

// Shared operation table, distinct namespace. A receipt is never an instruction
// to repeat a desktop side effect after a lost response or an App restart.
export class VideoActionJournal {
  constructor(catalog, {imageActions=false}={}) {
    this.catalog=catalog;this.active=new Map();this.tail=Promise.resolve();this.closed=false;
    this.table=imageActions?'project_asset_desktop_actions':'project_video_operations';
    this.namespace=imageActions?'asset-image-desktop-v1':'video-desktop-v1';
    this.routeBase=imageActions?'project-assets':'project-videos';
    this.label=imageActions?'图片':'视频';
    this.closingCode=imageActions?'ASSET_DESKTOP_CLOSING':'VIDEO_CLOSING';
  }
  get db(){return this.catalog.db;}
  row(id,requestId) {
    this.catalog.project(id);
    if(!idOK(requestId))fail('INVALID_REQUEST_ID','请求编号无效');
    const row=this.db.prepare(`SELECT * FROM ${this.table} WHERE id=? AND project_id=?`).get(requestId,id);
    if(!row)fail('DESKTOP_ACTION_NOT_FOUND','未找到原操作，请勿自动重新发送',404);
    const s=JSON.parse(row.data_json);
    if(s.namespace!==this.namespace)fail('REQUEST_ID_CONFLICT','请求编号属于其他文件操作',409);
    return s;
  }
  save(s) {(s.admittedDb||this.db).prepare(`UPDATE ${this.table} SET data_json=?,updated_at=? WHERE id=? AND project_id=?`).run(canonical(s),Date.now(),s.requestId,s.projectId);}
  begin(id,action,input) {
    this.catalog.project(id);
    if(this.closed||this.catalog.media.closing)fail(this.closingCode,`${this.label}模块正在关闭`,503);
    if(!idOK(input?.requestId))fail('INVALID_REQUEST_ID','请提供固定请求编号');
    const args=digest({action,input}),old=this.db.prepare(`SELECT * FROM ${this.table} WHERE id=?`).get(input.requestId);
    if(old) {
      const s=JSON.parse(old.data_json);
      if(old.project_id!==id||s.namespace!==this.namespace||s.args!==args)fail('REQUEST_ID_CONFLICT','请求编号已用于其他操作或输入',409);
      return {s,repeated:true};
    }
    if(this.active.size>=16)fail('DESKTOP_QUEUE_FULL',`后台${this.label}任务较多，请等待原任务完成`,429);
    const s={namespace:this.namespace,requestId:input.requestId,projectId:id,action,args,instance:this.catalog.instance,status:'checking',createdAt:Date.now(),progress:{checked:0,total:input.ids?.length||input.items?.length||1}};
    Object.defineProperty(s,'admittedDb',{value:this.db});
    this.db.prepare(`INSERT INTO ${this.table}(id,project_id,data_json,created_at,updated_at) VALUES(?,?,?,?,?)`).run(s.requestId,id,canonical(s),s.createdAt,s.createdAt);
    return {s,repeated:false};
  }
  dto(s) {
    if(['checking','running'].includes(s.status)&&!this.active.has(s.requestId))return {requestId:s.requestId,projectId:s.projectId,action:s.action,status:'unknown',code:'ACTION_INTERRUPTED',error:'上次操作未取得最终回执；没有自动重复执行，请核对原请求',reason:'上次操作未取得最终回执；没有自动重复执行，请核对原请求',...(s.partial||{})};
    if(['checking','running'].includes(s.status))return {requestId:s.requestId,projectId:s.projectId,action:s.action,status:s.status==='running'?'dispatching':'checking',progress:s.progress,processed:s.progress.checked,total:s.progress.total,statusUrl:`/api/${this.routeBase}/projects/${s.projectId}/desktop-actions/${s.requestId}`};
    return s.result||{requestId:s.requestId,projectId:s.projectId,action:s.action,status:s.status,progress:s.progress,code:s.code,reason:s.reason};
  }
  start(id,action,input,run,prepare) {
    const {s,repeated}=this.begin(id,action,input);
    if(repeated)return this.dto(s);
    const admitted=prepare?Promise.resolve().then(()=>prepare(s)):null;admitted?.catch(()=>{});
    const work=this.tail.catch(()=>{}).then(()=>this.catalog.media.track(async()=>{
      try {
        if(this.closed)fail(this.closingCode,`${this.label}模块正在关闭`,503);
        s.result=await run(s,admitted);if(s.admittedDb!==this.db)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化，请核对原请求',409);s.status=s.result.status||'completed';this.save(s);
      } catch(e) {
        // Once dispatched, lack of an ACK means UNKNOWN, never "not done".
        s.status=s.dispatched?'unknown':'failed';s.code=e.code||(this.routeBase==='project-assets'?'ASSET_DESKTOP_FAILED':'VIDEO_ACTION_FAILED');s.reason=e.status?e.message:`${this.label}操作未完成，请查询原请求`;
        s.result={requestId:s.requestId,projectId:id,action,status:s.status,code:s.code,error:s.reason,reason:s.reason,...(s.partial||{})};this.save(s);
      }
      return this.dto(s);
    })).finally(()=>this.active.delete(s.requestId));
    this.active.set(s.requestId,work);this.tail=work;work.catch(()=>{});
    return this.dto(s);
  }
  async settle(){this.closed=true;await this.tail;}
}

// Same durable table as file/desktop operations, with an isolated, versioned
// receipt format. Completion and the business write share a short transaction.
export class ProjectUsageJournal {
  constructor(catalog){this.catalog=catalog;this.active=new Map();this.namespace='project-usage-render-v1';}
  get db(){return this.catalog.db;}
  url(s){return s.timelineId?`/api/projects/${s.projectId}/timelines/${s.timelineId}/render/requests/${s.requestId}`:`/api/project-videos/projects/${s.projectId}/operations/${s.requestId}`;}
  row(id,requestId,timelineId=null){
    this.catalog.project(id);if(!idOK(requestId))fail('INVALID_REQUEST_ID','请求编号无效');
    const row=this.db.prepare('SELECT * FROM project_video_operations WHERE id=? AND project_id=?').get(requestId,id);
    if(!row)fail('OPERATION_NOT_FOUND','未找到原请求回执；不能据此认定操作未发生',404);
    const s=JSON.parse(row.data_json);
    if(s.namespace!==this.namespace||s.timelineId!==timelineId)fail('OPERATION_NOT_FOUND','未找到本项目、时间线的原请求回执',404);
    return s;
  }
  save(s){(s.admittedDb||this.db).prepare('UPDATE project_video_operations SET data_json=?,updated_at=? WHERE id=? AND project_id=?').run(canonical(s),Date.now(),s.requestId,s.projectId);}
  guard(s){if(s.admittedDb!==this.db||s.databaseToken!==this.catalog.databaseToken())fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化，请回到原素材库查询原请求',409);}
  dto(s){
    const interrupted=['checking','running'].includes(s.status)&&!this.active.has(s.requestId),status=interrupted?'unknown':s.status;
    const unknown=status==='unknown',final=s.action==='final-folder-ensure';
    const message=final?'原目录操作结果尚未核清，请查询原请求':'原请求结果尚未核清，请查询原请求';
    return {schemaVersion:1,requestId:s.requestId,projectId:s.projectId,timelineId:s.timelineId,action:s.action,status,statusUrl:this.url(s),
      result:unknown?(final?{created:null,adopted:null,contentsMoved:false}:null):s.result??null,
      error:unknown?{code:final?'FINAL_FOLDER_OPERATION_UNSETTLED':'RENDER_OPERATION_UNSETTLED',message,error:message,details:{}}:s.error??null};
  }
  complete(s,result){s.status='completed';s.result=result;s.error=null;this.save(s);}
  assertSettled(id,scope,except){
    for(const row of this.db.prepare('SELECT * FROM project_video_operations WHERE project_id=?').all(id)){
      const s=JSON.parse(row.data_json);if(row.id!==except&&s.namespace===this.namespace&&s.scope===scope&&this.dto(s).status==='unknown'){
        const code=s.action==='final-folder-ensure'?'FINAL_FOLDER_OPERATION_UNSETTLED':'RENDER_OPERATION_UNSETTLED';
        fail(code,'原请求结果尚未核清，请查询原请求',409,{requestId:s.requestId,statusUrl:this.url(s)});
      }
    }
  }
  async start(id,timelineId,action,input,scope,run){
    this.catalog.project(id);
    if(this.catalog.closing||this.catalog.media.closing)fail('VIDEO_CLOSING','视频模块正在关闭',503);
    if(!idOK(input?.requestId))fail('INVALID_REQUEST_ID','请提供固定请求编号');
    const args=digest({projectId:id,timelineId,action,input}),old=this.db.prepare('SELECT * FROM project_video_operations WHERE id=?').get(input.requestId);
    let s;
    if(old){s=JSON.parse(old.data_json);if(old.project_id!==id||s.namespace!==this.namespace||s.args!==args)fail('REQUEST_ID_CONFLICT','请求编号已用于其他操作或输入',409);}
    else{
      s={namespace:this.namespace,kind:action,action,requestId:input.requestId,projectId:id,timelineId,scope,args,instance:this.catalog.instance,databaseToken:this.catalog.databaseToken(),status:'checking',result:null,error:null};
      Object.defineProperty(s,'admittedDb',{value:this.db});
      const now=Date.now();this.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(s.requestId,id,canonical(s),now,now);
      const work=this.catalog.withActivity(()=>this.catalog.media.track(()=>this.catalog.serial(async()=>{
        try{this.guard(s);this.catalog.project(id,true);this.assertSettled(id,scope,s.requestId);await run(s);}
        catch(e){
          // A write whose ACK was lost may already have committed its receipt.
          let durable;try{durable=JSON.parse(s.admittedDb.prepare('SELECT data_json FROM project_video_operations WHERE id=? AND project_id=?').get(s.requestId,id).data_json);}catch{return;}
          if(durable.status==='completed')return;
          if(['render-link','video-info-refresh'].includes(s.action)){const mapped={VIDEO_CONFLICT:'RENDER_CONFLICT',TARGET_CHANGED:'RENDER_SOURCE_REVIEW_REQUIRED',SOURCE_CHANGED:'RENDER_SOURCE_REVIEW_REQUIRED',SOURCE_UNTRUSTED:'RENDER_SOURCE_UNTRUSTED',SOURCE_MISSING:'RENDER_SOURCE_MISSING'};if(mapped[e.code])e.code=mapped[e.code];}
          s.status=s.dispatched?'unknown':'failed';s.httpStatus=e.status||503;
          const message=e.status?e.message:'操作结果暂时无法确认，请核对原请求';
          s.error={code:e.code||'RENDER_INFO_UNAVAILABLE',message,error:message,details:e.details||{}};this.save(s);
        }
      }))).finally(()=>this.active.delete(s.requestId));
      this.active.set(s.requestId,work);work.catch(()=>{});
      // Fast completions/rejections keep their HTTP semantics; long IO returns
      // a queryable 202. Disconnecting the caller never cancels the intent.
      let timer;try{await Promise.race([work,new Promise(r=>{timer=setTimeout(r,35);})]);}finally{clearTimeout(timer);}
    }
    if(s.admittedDb&&s.admittedDb!==this.db)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化，请回到原素材库查询原请求',409,{requestId:s.requestId});
    const result=this.dto(this.row(id,s.requestId,timelineId));
    if(result.status==='failed'){
      const stored=this.row(id,s.requestId,timelineId),e=Object.assign(Error(result.error.message),{code:result.error.code,status:stored.httpStatus||409,accepted:true,requestId:s.requestId,statusUrl:result.statusUrl,details:{...result.error.details,statusUrl:result.statusUrl}});throw e;
    }
    return result;
  }
  async settle(){await Promise.allSettled([...this.active.values()]);}
}

export function usageError(e){const message=e.status?e.message:'操作结果暂时无法确认，请查询原请求';return{code:e.code||'RENDER_INFO_UNAVAILABLE',message,error:message,details:e.details||{},...(e.requestId?{requestId:e.requestId,accepted:e.accepted===true}:{}),...(e.statusUrl?{statusUrl:e.statusUrl}:{})};}
