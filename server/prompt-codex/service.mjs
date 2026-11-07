import {randomUUID} from 'node:crypto';
import {canonical,fault} from '../prompt-templates/model.mjs';
import {ACTIVE} from './store.mjs';
import {CodexTransport,codexError} from './transport.mjs';
import {safeText} from './tasks.mjs';

const safeCode=e=>/^[A-Z_]{1,80}$/.test(e?.code||'')?e.code:'CODEX_GENERATION_FAILED';
const toolName=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_.:-]{0,95}$/.test(value)?value:undefined;
const prefs={
  text:'本次只输出文字，不生成图片。',
  mixed:'本次可按任务需要输出文字和图片；如图片工具不可用，请明确说明，不要伪造图片链接。',
  image:'本次只生成并返回图片。请直接根据上述内容生成图片，不先输出分析、设计方案或等待确认；本次输出偏好优先于模板或历史中先讨论、只整理提示词的流程要求。回复中仅展示实际生成的图片，不附加标题、解释、提示词、分析过程或其他文字，不用文字描述或链接代替图片。若图片工具不可用或生成失败，请简短说明原因，不要伪造图片或图片链接。',
};
export class CodexService {
  constructor(store,media,{transportFactory,withActivity,pictures,timeoutMs=30*60*1000,stopTimeoutMs=3000}={}) {
    this.store=store;this.media=media;this.transportFactory=transportFactory||((cwd)=>new CodexTransport({cwd}));
    this.withActivity=withActivity||(fn=>fn());this.timeoutMs=timeoutMs;this.stopTimeoutMs=stopTimeoutMs;
    this.pictures=pictures;
    this.tasks=new Map();this.threads=new Map();this.models=[];this.account=null;this.listeners=new Set();this.closing=false;
    this.instanceId=randomUUID();this.impactTokens=new Map();this.exitedClients=new WeakSet();
  }
  status(){return{connected:!!this.client&&!this.client.closed,authenticated:!!this.account?.authenticated,accountType:this.account?.type??null,models:this.models,active:this.tasks.size,transport:'stdio'};}
  taskOverview(options){const page=this.store.taskOverview(options);return{instanceId:this.instanceId,observedAt:Date.now(),connection:{connected:!!this.client&&!this.client.closed,authenticated:!!this.account?.authenticated,active:this.tasks.size,unsettled:!!this.transportUnsettled},...page};}
  async connect(){
    if(this.resetting||this.transportUnsettled)throw codexError('CODEX_BUSY','连接正在结清，请稍后重连',423);
    if(this.closing)throw codexError('CODEX_CLOSING','应用正在关闭');
    if(this.connecting)return this.connecting;
    if(this.tasks.size)throw fault('其他对话仍在生成，请停止后重新连接',409);
    this.connecting=(async()=>{
      if(this.client&&!this.client.closed){if(this.tasks.size)throw fault('其他对话仍在生成，请停止后重新连接',409);await this.disconnect();}
      await this.media.init();const client=this.transportFactory(this.media.work);this.client=client;
      client.on('notification',(method,params)=>this.notification(method,params));
      client.on('closed',()=>{this.exitedClients.add(client);if(this.client===client){this.threads.clear();this.transportUnsettled=false;}for(const task of this.tasks.values())if(task.client===client){task.quiesced();task.resolve({status:'interrupted',errorCode:task.stopReason||'CODEX_DISCONNECTED'});}this.publish();});
      try{
        await client.start();const auth=await client.call('account/read',{refreshToken:false});
        this.account={authenticated:!!auth.account||auth.requiresOpenaiAuth===false,type:auth.account?.type??null};
        if(this.account.authenticated){
          const models=[];let cursor=null;
          for(let i=0;i<30;i++){const page=await client.call('model/list',{cursor,limit:100,includeHidden:false});if(!Array.isArray(page.data))throw codexError('CODEX_PROTOCOL_MISMATCH','当前 Codex 模型协议不兼容，请更新 Codex 后重连');models.push(...page.data);cursor=page.nextCursor;if(!cursor)break;}
          this.models=models.filter(m=>!m.hidden&&typeof m.model==='string').map(m=>({id:m.model,name:m.displayName||m.model,description:m.description||'',default:!!m.isDefault,efforts:(m.supportedReasoningEfforts||[]).filter(e=>typeof e.reasoningEffort==='string').map(e=>({id:e.reasoningEffort,description:e.description||''})),defaultEffort:m.defaultReasoningEffort??'',inputModalities:m.inputModalities||[]}));
        }else this.models=[];
        this.publish();return this.status();
      }catch(e){await client.close().catch(()=>{});this.client=null;this.account=null;this.models=[];throw e;}
    })();
    try{return await this.connecting;}finally{this.connecting=null;}
  }
  validateChoice(input){
    if(!this.client||this.client.closed)throw codexError('CODEX_DISCONNECTED','请先连接 Codex');
    if(!this.account?.authenticated)throw codexError('CODEX_LOGIN_REQUIRED','请先在本机 Codex 完成登录，再重新连接');
    const model=this.models.find(m=>m.id===input.model);if(!model)throw fault('所选模型当前不可用，请重新连接更新模型列表');
    if(input.effort&&!model.efforts.some(e=>e.id===input.effort))throw fault('所选模型不支持这个推理强度');
    return model;
  }
  async start(id,input){
    if(this.closing||this.resetting||this.transportUnsettled||this.store.lib.migrating)throw codexError('CODEX_BUSY','应用正在迁移或关闭，请稍后发送',423);
    this.validateChoice(input);
    if(this.pictures&&(input.output??'mixed')!=='text'&&!input.project_id)throw fault('请先选择图片所属项目');
    if(this.tasks.size>=4&&!this.tasks.has(input.id))throw fault('最多同时生成四个任务，请等待或停止已有任务',429);
    const begun=this.store.begin(id,input);
    if(begun.existing)return begun.turn;
    const task={id:begun.turn.id,conversationId:id,pictureProject:begun.pictureProject,blocks:[],actual:{},usage:{},queue:Promise.resolve(),resolve:()=>{},remoteTurnId:null,threadId:null,stopRequested:false,client:this.client};
    task.result=new Promise(resolve=>task.resolve=resolve);task.exitEvidence=new Promise(resolve=>task.quiesced=resolve);this.tasks.set(task.id,task);
    const job={id:task.id,type:'codex-generation',status:'running',count:0,errors:[],created:Date.now()};this.store.lib.jobs?.set(task.id,job);
    // Ownership spans the asynchronous generation, beyond the initiating HTTP response.
    task.work=Promise.resolve().then(()=>this.withActivity(()=>this.execute(task))).catch(e=>{
      this.store.updateTurn(task.id,{blocks:task.blocks,status:'failed',errorCode:safeCode(e)});
    }).finally(()=>{this.tasks.delete(task.id);const result=this.store.getTurn(task.id);job.status=result.status==='completed'?'done':result.status==='interrupted'?'interrupted':'failed';job.count=result.status==='completed'?1:0;if(result.error_code)job.errors.push(result.error_code);this.publish(id);});
    this.publish(id);return begun.turn;
  }
  async execute(task){
    let timer;
    try{
      const conversation=this.store.get(task.conversationId),turn=this.store.getTurn(task.id),request=turn.request;
      const scratch=await this.media.scratch(conversation.id);task.scratch=scratch;
      const key=canonical({model:request.model,effort:request.effort});let remote=this.threads.get(conversation.id),replay=false;
      if(!remote||remote.key!==key){
        const reply=await task.client.call('thread/start',{model:request.model,cwd:scratch,approvalPolicy:'never',sandbox:'workspace-write',ephemeral:true,
          baseInstructions:'你是提示词和图文内容助手。遵守用户的模板和原文约束。只能处理用户发送的内容。不要运行命令、读取无关文件、修改项目或调用外部 MCP。若生成图片，将结果保存到当前任务目录。',
          config:{...(request.effort?{model_reasoning_effort:request.effort}:{}),'features.shell_tool':false,'features.apply_patch_freeform':false,'features.multi_agent':false,'features.apps':false,mcp_servers:{},sandbox_workspace_write:{writable_roots:[scratch],network_access:false,exclude_tmpdir_env_var:true,exclude_slash_tmp:true}},
        });
        if(!reply.thread?.id)throw codexError('CODEX_PROTOCOL_MISMATCH','Codex 未返回有效会话');
        if(reply.model&&reply.model!==request.model||request.effort&&reply.reasoningEffort&&reply.reasoningEffort!==request.effort)throw codexError('CODEX_SETTINGS_MISMATCH','Codex 返回的模型或推理强度与所选设置不一致，尚未发送生成请求。');
        remote={id:reply.thread.id,key,model:reply.model??null,effort:reply.reasoningEffort??null};this.threads.set(conversation.id,remote);replay=true;
      }
      task.threadId=remote.id;task.actual={model:remote.model,effort:remote.effort,confirmedBy:'thread/start',contextRestored:replay&&conversation.turns.length>1,...(task.pictureProject?{pictureProject:task.pictureProject}:{})};
      this.store.updateTurn(task.id,{status:'running',actual:task.actual});this.publish(conversation.id);
      if(task.stopRequested){task.resolve({status:'interrupted',errorCode:'USER_STOPPED'});}
      else{
        const firstQuestion=turn.sequence_no===1||conversation.turns.find(t=>t.id===request.retry_of)?.sequence_no===1;
        let text=firstQuestion?conversation.context.prompt+(request.text?'\n\n本次补充要求：\n'+request.text:''):request.text;
        if(replay){
          const old=conversation.turns.filter(t=>t.sequence_no<turn.sequence_no&&t.id!==request.retry_of);
          const history=old.map(t=>({user:t.sequence_no===1?conversation.context.prompt+(t.request.text?'\n补充要求：'+t.request.text:''):t.request.text,assistant:t.blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'),status:t.status,...(t.error_code?{applicationError:t.error_code,...(t.actual.blockedTool?{blockedTool:t.actual.blockedTool}:{})}:{})}));
          if(history.length)text='以下是本应用保存的先前对话，请将其作为上下文：\n'+JSON.stringify(history)+'\n\n本次用户消息：\n'+text;
        }
        if(conversation.turns.some(t=>t.sequence_no<turn.sequence_no&&t.error_code==='UNEXPECTED_TOOL_REQUEST'))text+='\n\n工作台提示：先前任务因尝试不支持的工具而停止。此工作台仅处理文字与原生图片生成，不提供命令执行、文件改写、外部 MCP 或其他智能体。请直接回答当前问题；确需不可用工具时说明限制，不再尝试调用。';
        text+='\n\n输出偏好：'+prefs[request.output];
        if(text.length>1_000_000)throw fault('对话上下文超过限制，请新建任务或缩短内容');
        const input=[{type:'text',text,text_elements:[]}];
        // Restore the latest generated image as a reference only for image-capable models.
        if(replay&&this.models.find(m=>m.id===request.model)?.inputModalities.includes('image')){
          const prior=conversation.turns.filter(t=>t.sequence_no<turn.sequence_no).flatMap(t=>t.blocks).filter(b=>b.type==='image'&&b.attachmentId).slice(-4);
          for(const block of prior){const row=this.store.attachment(block.attachmentId);await this.media.read(row);input.push({type:'localImage',path:this.media.file(row)});}
        }
        task.generationAttempted=true;
        const reply=await task.client.call('turn/start',{threadId:remote.id,model:request.model,...(request.effort?{effort:request.effort}:{}),input,
          approvalPolicy:'never',sandboxPolicy:{type:'workspaceWrite',writableRoots:[scratch],networkAccess:false,excludeTmpdirEnvVar:true,excludeSlashTmp:true}});
        task.remoteTurnId=reply.turn?.id??null;
        if(!task.remoteTurnId)throw codexError('CODEX_PROTOCOL_MISMATCH','Codex 未返回有效生成任务');
        if(task.stopRequested)await this.interrupt(task);
        timer=setTimeout(()=>this.requestStop(task,'TIME_LIMIT'),this.timeoutMs);
      }
      const ending=await task.result;await task.queue;
      await this.settleTaskClient(task,ending.errorCode||'CODEX_UNCONFIRMED');await task.queue;
      const status=task.stopReason==='UNEXPECTED_TOOL_REQUEST'?'failed':ending.status==='completed'?'completed':ending.status==='interrupted'?'interrupted':'failed';
      this.store.updateTurn(task.id,{blocks:task.blocks,actual:task.actual,usage:task.usage,status,errorCode:task.stopReason==='UNEXPECTED_TOOL_REQUEST'?task.stopReason:ending.errorCode||''});
    }catch(e){
      await this.settleTaskClient(task,safeCode(e));
      this.threads.delete(task.conversationId);
      this.store.updateTurn(task.id,{blocks:task.blocks,actual:task.actual,usage:task.usage,status:task.stopRequested?'interrupted':'failed',errorCode:safeCode(e)});
    }finally{if(task.stopReason==='UNEXPECTED_TOOL_REQUEST')this.threads.delete(task.conversationId);clearTimeout(timer);clearTimeout(task.stopTimer);clearTimeout(task.saveTimer);this.publish(task.conversationId);}
  }
  notification(method,params){
    for(const task of this.tasks.values()){
      if(params.threadId!==task.threadId)continue;
      if(task.remoteTurnId&&params.turnId&&params.turnId!==task.remoteTurnId)continue;
      if(method==='turn/started'){task.remoteTurnId=params.turn?.id??task.remoteTurnId;}
      else if(method==='item/agentMessage/delta'){
        let block=task.blocks.find(b=>b.itemId===params.itemId);if(!block){block={type:'text',itemId:params.itemId,text:'',phase:'final_answer'};task.blocks.push(block);}
        if(typeof params.delta==='string')block.text+=params.delta;
        if(task.blocks.reduce((n,b)=>n+(b.text?.length||0),0)>2_000_000){this.requestStop(task,'OUTPUT_TOO_LARGE');}
        this.scheduleSave(task);
      }else if(method==='item/started'||method==='item/completed'){
        task.queue=task.queue.then(()=>this.item(task,params.item,method==='item/completed')).then(()=>this.scheduleSave(task)).catch(()=>{task.resolve({status:'failed',errorCode:'RESULT_SAVE_FAILED'});});
      }else if(method==='thread/tokenUsage/updated'){task.usage=params.tokenUsage??{};this.scheduleSave(task);}
      else if(method==='turn/completed'){
        task.remoteEnded=true;task.quiesced();
        task.queue=task.queue.then(async()=>{for(const item of params.turn?.items||[])await this.item(task,item,true);});
        task.resolve({status:params.turn?.status??'failed',errorCode:params.turn?.status==='failed'?'CODEX_TURN_FAILED':task.stopReason|| (task.stopRequested?'USER_STOPPED':'')});
      }else if(method==='error'&&params.willRetry!==true){task.resolve({status:'failed',errorCode:'CODEX_TURN_FAILED'});}
    }
  }
  async item(task,item,completed){
    if(!item?.id)return;
    if(item.type==='agentMessage'){
      let block=task.blocks.find(b=>b.itemId===item.id);if(!block){block={type:'text',itemId:item.id,text:'',phase:item.phase||'final_answer'};task.blocks.push(block);}
      block.phase=item.phase||'final_answer';if(completed&&typeof item.text==='string')block.text=item.text;
    }else if(item.type==='imageGeneration'){
      let block=task.blocks.find(b=>b.itemId===item.id);if(!block){block={type:'image',itemId:item.id,status:'processing',alt:'Codex 生成图片'};task.blocks.push(block);}
      if(!completed||block.status==='ready'||block.status==='failed')return;
      try{
        if(item.status==='failed'||item.failure)throw fault('图片生成失败');
        const bytes=await this.media.receive(item,{scratch:task.scratch,threadId:task.threadId});
        const row=await this.media.save(bytes,task.id);this.store.addAttachment(row);
        Object.assign(block,{status:'ready',attachmentId:row.id,mime:row.mime,bytes:row.bytes});
        if(this.pictures){try{block.library=await this.pictures.publish(row,bytes,task.pictureProject);}catch(e){block.library={status:'failed',error:e.status?e.message:'原图已保留，但自动保存到 picture 失败，请检查磁盘空间和目录权限。'};}}
      }catch(e){Object.assign(block,{status:'failed',error:'图片未能保存：'+(e.status?e.message:e.code==='ENOENT'?'生成的原图文件不存在或尚未交付':e.code==='EACCES'||e.code==='EPERM'?'没有读取原图的权限':'接收原图时发生错误')+'。文字内容已保留。'});}
    }else if(['commandExecution','fileChange','mcpToolCall','collabAgentToolCall','collabToolCall','dynamicToolCall'].includes(item.type)){
      // Fail closed if a Codex version exposes a tool despite the disabled tool config.
      if(!task.actual.blockedTool)task.actual={...task.actual,blockedTool:{type:item.type,...(toolName(item.server)?{server:toolName(item.server)}:{}),...(toolName(item.tool)?{tool:toolName(item.tool)}:{})}};
      this.requestStop(task,'UNEXPECTED_TOOL_REQUEST');
    }
  }
  scheduleSave(task){if(task.saveTimer)return;task.saveTimer=setTimeout(()=>{task.saveTimer=null;try{this.store.updateTurn(task.id,{blocks:task.blocks,actual:task.actual,usage:task.usage});this.publish(task.conversationId);}catch{task.resolve({status:'failed',errorCode:'RESULT_SAVE_FAILED'});}},150);}
  async interrupt(task){if(task.threadId&&task.remoteTurnId&&task.client&&!task.client.closed)await task.client.call('turn/interrupt',{threadId:task.threadId,turnId:task.remoteTurnId}).catch(()=>{});}
  async settleTaskClient(task,reason){
    if(!task.generationAttempted||task.remoteEnded||this.exitedClients.has(task.client))return;
    try{await this.terminateOwnedClient(reason,task.stopReason==='USER_STOPPED'?task.stopGrant:undefined);}
    catch(e){
      this.store.updateTurn(task.id,{status:'stopping',errorCode:['STOP_SCOPE_CHANGED','STOP_SCOPE_EXPIRED'].includes(e.code)?e.code:'CODEX_CLOSE_UNSETTLED'});this.publish(task.conversationId);
      // Do not release ownership or report a terminal state without a remote turn
      // completion or the actual client's exit event, including error cleanup paths.
      await task.exitEvidence;
    }
  }
  cohort(client){return [...this.tasks.values()].filter(task=>task.client===client).map(task=>task.id).sort();}
  stopImpact(turnId){
    const row=this.store.taskHead(turnId),task=this.tasks.get(turnId),client=task?.client??null,ids=client?this.cohort(client):[];
    const now=Date.now();for(const [token,grant]of this.impactTokens)if(grant.expiresAt<=now)this.impactTokens.delete(token);
    while(this.impactTokens.size>=128)this.impactTokens.delete(this.impactTokens.keys().next().value);
    const impactToken=randomUUID(),expiresAt=now+30000;
    this.impactTokens.set(impactToken,{taskId:turnId,client,ids,expiresAt});
    const otherTasks=ids.filter(id=>id!==turnId).map(id=>{const other=this.tasks.get(id),head=this.store.db.prepare('SELECT title FROM codex_conversations WHERE id=?').get(other.conversationId);return{taskId:id,conversationId:other.conversationId,title:safeText(head?.title,200),status:this.store.taskHead(id).status};});
    return{taskId:row.id,requiresConfirmation:otherTasks.length>0,otherTasks,impactToken,expiresAt};
  }
  checkStopGrant(grant,{exact=false}={}){
    if(!grant||grant.expiresAt<=Date.now())throw codexError('STOP_SCOPE_EXPIRED','停止确认已过期，请重新检查影响范围',409);
    const current=this.cohort(grant.client);
    if(grant.client!==this.client||current.some(id=>!grant.ids.includes(id))||(exact&&current.join(',')!==grant.ids.join(',')))throw codexError('STOP_SCOPE_CHANGED','任务或连接已变化，请重新检查停止影响范围',409);
  }
  async stopTask(turnId,options){const row=this.store.getTurn(turnId);return this.stop(row.conversation_id,turnId,options,true);}
  async stop(conversationId,turnId,options={},requireImpact=false){
    const row=this.store.getTurn(turnId);if(row.conversation_id!==conversationId)throw fault('生成任务不属于当前对话');
    const task=this.tasks.get(turnId);if(!task){if(ACTIVE.includes(row.status))throw codexError('TASK_STATE_UNKNOWN','任务实际状态待确认，尚不能报告已停止',409);return this.store.get(conversationId);}
    if(this.transportUnsettled)throw codexError('CODEX_CLOSE_UNSETTLED','连接退出尚未确认，请保留当前状态',423);
    if(this.resetting||this.closing)throw codexError('CODEX_BUSY','连接正在结清，请稍后检查',423);
    let grant;
    if(options?.impactToken){
      grant=this.impactTokens.get(options.impactToken);
      if(!grant)throw codexError('STOP_SCOPE_EXPIRED','停止确认已过期，请重新检查影响范围',409);
      if(grant.taskId!==turnId||grant.client!==task.client)throw codexError('STOP_SCOPE_CHANGED','停止确认不属于当前任务或连接',409);
      this.checkStopGrant(grant,{exact:true});
    }else{
      if(requireImpact)throw codexError('STOP_IMPACT_REQUIRED','请先检查停止影响范围',409);
      const ids=this.cohort(task.client);if(ids.length!==1)throw codexError('STOP_CONFIRMATION_REQUIRED','共享连接中还有其他任务，请先检查并确认影响范围',409);
      grant={taskId:turnId,client:task.client,ids,expiresAt:Date.now()+30000};this.checkStopGrant(grant,{exact:true});
    }
    if(grant.ids.length>1&&options?.confirmSharedClose!==true)throw codexError('STOP_CONFIRMATION_REQUIRED','停止超时可能中断其他任务，请明确确认影响范围',409);
    task.stopGrant=grant;
    this.store.updateTurn(turnId,{status:'stopping',errorCode:''});this.requestStop(task,'USER_STOPPED');this.publish(conversationId);return this.store.get(conversationId);
  }
  requestStop(task,reason){
    task.stopRequested=true;if(!task.stopReason||reason==='UNEXPECTED_TOOL_REQUEST')task.stopReason=reason;
    if(!task.stopTimer)task.stopTimer=setTimeout(()=>{
      // An interrupt ACK does not prove turn completion. Close our owned process before
      // accepting more work if the completion notification never arrives.
      task.stopTimer=null;
      const closeReason=task.stopReason||reason;
      void this.terminateOwnedClient(closeReason,closeReason==='USER_STOPPED'?task.stopGrant:undefined).catch(e=>{
        // No completion/exit evidence: keep the actual task owned and block admission
        // when close is unsettled. Scope changes require a fresh explicit decision.
        this.store.updateTurn(task.id,{status:'stopping',errorCode:['STOP_SCOPE_CHANGED','STOP_SCOPE_EXPIRED'].includes(e.code)?e.code:'CODEX_CLOSE_UNSETTLED'});this.publish(task.conversationId);
      });
    },this.stopTimeoutMs);
    void this.interrupt(task);
  }
  async terminateOwnedClient(reason,grant){
    if(grant)this.checkStopGrant(grant);
    else if(reason==='USER_STOPPED')throw codexError('STOP_IMPACT_REQUIRED','停止关闭缺少影响范围确认',409);
    if(this.resetting)return this.resetting;
    const client=this.client;if(!client)return;
    for(const task of this.tasks.values())if(task.client===client)task.stopReason=task.stopReason||(reason==='USER_STOPPED'&&grant?.taskId!==task.id?'SHARED_CONNECTION_CLOSED':reason);
    // Seal admission synchronously, then recheck immediately before the actual close.
    // close() implementations may yield or call application code synchronously.
    this.resetting=Promise.resolve().then(async()=>{
      if(grant)this.checkStopGrant(grant);
      try{await client.close();if(!this.exitedClients.has(client))throw codexError('CODEX_CLOSE_UNSETTLED','Codex 进程尚未结清');this.client=null;this.account=null;this.models=[];this.threads.clear();}
      catch(e){this.transportUnsettled=true;throw e;}
      finally{this.publish();}
    });
    try{await this.resetting;}finally{this.resetting=null;}
  }

  subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
  publish(id){for(const listener of this.listeners){try{listener(id);}catch{}}}
  async disconnect(){if(this.tasks.size)throw fault('请先停止正在生成的任务',409);await this.terminateOwnedClient('USER_DISCONNECTED');this.publish();}
  async close(){this.closing=true;this.publish();const work=[...this.tasks.values()].map(t=>t.work);for(const task of this.tasks.values()){task.stopRequested=true;task.stopReason='APPLICATION_CLOSING';}await this.terminateOwnedClient('APPLICATION_CLOSING');await Promise.all(work);if(this.transportUnsettled)throw codexError('CODEX_CLOSE_UNSETTLED','Codex 进程尚未结清');this.client=null;this.listeners.clear();}
}
