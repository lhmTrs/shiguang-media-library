import {useFeedbackToast} from '../global-feedback';
import {useEffect,useRef,useState} from 'react';
import type {PromptRequest} from '../PromptTemplateWorkspace';
import {blankScope,errorText,running,scopeQuery,type Attachment,type LocalAttachment,type Pending,type Scope,type ScopeState,type Session,type Status,type Task,type Turn} from './types';

const MiB=1024*1024;
// 423 is a pre-handler host/identity refusal; /turns rejects 409/429 before store.begin.
// Other failures need an explicit not-accepted receipt matching this original request.
const knownRejected=(e:unknown,requestId:string)=>{
  const error=e as {status?:number;accepted?:unknown;requestId?:unknown}|null;
  return [400,401,403,404,409,413,415,422,423,429].includes(error?.status||0)||error?.accepted===false&&error.requestId===requestId;
};
const abortError=(e:unknown)=>(e as Error)?.name==='AbortError';

export function useConcierge(request:PromptRequest,scope:string,enabled:boolean){
  const states=useRef(new Map<string,ScopeState>()),alive=useRef(true),identity=useRef(''),blocked=useRef(false),epoch=useRef(0);
  const [,render]=useState(0),[status,setStatus]=useState<Status|null>(null),[statusError,setStatusError]=useState(''),[connecting,setConnecting]=useState(false),[identityError,setIdentityError]=useState('');
  useFeedbackToast(statusError, {source: '自由管家'});
  useFeedbackToast(identityError, {source: '自由管家'});
  const statusRef=useRef(status),statusVersion=useRef(0),connectingRef=useRef(false);
  const currentScope=useRef(scope);currentScope.current=scope;
  const submissions=useRef(new Map<string,{id:string;text:string;attachments:LocalAttachment[];revision:number}>());
  const readers=useRef(new Set<AbortController>());
  const loads=useRef(new Map<string,{version:number;signal?:AbortSignal}>());
  const state=(id=scope)=>{if(!states.current.has(id))states.current.set(id,blankScope());return states.current.get(id)!;};
  const notify=()=>{if(alive.current)render(n=>n+1);};
  const assertAlive=(generation:number)=>{if(!alive.current||generation!==epoch.current||blocked.current)throw new DOMException('上下文已变化','AbortError');};
  function storageKey(id:string){return 'shiguang.concierge.draft.v1:'+identity.current+':'+id;}
  function persist(id:string){
    if(!identity.current||blocked.current)return;
    const s=state(id);
    if(!s.loaded)return;
    try{sessionStorage.setItem(storageKey(id),JSON.stringify({text:s.text,model:s.model,effort:s.effort,pending:s.pending,scrollTop:s.scrollTop}));s.storageError='';}
    catch{s.storageError='浏览器无法保存草稿；请保留本页。';}
  }
  function restore(id:string){
    const s=state(id);
    try{
      const raw=sessionStorage.getItem(storageKey(id));if(!raw)return;
      const v=JSON.parse(raw);
      if(s.draftRevision===0){
        if(typeof v.text==='string')s.text=v.text;
        if(typeof v.model==='string')s.model=v.model;
        if(typeof v.effort==='string')s.effort=v.effort;
      }
      if(Number.isFinite(v.scrollTop))s.scrollTop=v.scrollTop;
      if(v.pending&&typeof v.pending.id==='string'&&/^[a-f0-9-]{36}$/i.test(v.pending.id)&&typeof v.pending.text==='string'&&Array.isArray(v.pending.attachmentIds))s.pending=v.pending;
    }catch{s.storageError='无法恢复浏览器草稿；未恢复任何生成请求。';}
  }
  function invalidate(){
    if(blocked.current)return;
    blocked.current=true;epoch.current++;for(const c of readers.current)c.abort();
    states.current.clear();submissions.current.clear();statusVersion.current++;setStatus(null);
    setIdentityError('素材库实例已变化。请刷新页面核对当前素材库；原草稿和未确认任务保留在原实例下。');notify();
  }
  async function session(generation=epoch.current){
    const v=await request<Session>('/session');assertAlive(generation);
    if(!v||typeof v.token!=='string'||!v.token||typeof v.instanceId!=='string'||!v.instanceId||v.app&&v.app!=='shiguang-local-media')throw Error('无法确认本机服务身份');
    if(identity.current&&identity.current!==v.instanceId){invalidate();throw Error('素材库实例已变化，请刷新页面核对');}
    identity.current=v.instanceId;return v;
  }
  async function read<T>(path:string,signal?:AbortSignal):Promise<T>{
    const generation=epoch.current;await session(generation);
    const controller=new AbortController();readers.current.add(controller);
    try{
      const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(20000),...(signal?[signal]:[])]);
      const value=await request<T>('/concierge'+path,undefined,undefined,{signal:combined});
      assertAlive(generation);return value;
    }finally{readers.current.delete(controller);}
  }
  async function write<T>(path:string,body:unknown,method='POST'):Promise<T>{
    const generation=epoch.current;await session(generation);
    const value=await request<T>('/concierge'+path,body,method);
    assertAlive(generation);return value;
  }
  async function refreshStatus(signal?:AbortSignal){
    if(connectingRef.current)return;
    const version=++statusVersion.current;
    try{const v=await read<Status>('/status',signal);if(version!==statusVersion.current)return;statusRef.current=v;setStatus(v);setStatusError('');}
    catch(e){if(!abortError(e)&&version===statusVersion.current){setStatusError(errorText(e));statusRef.current=null;setStatus(null);}}
  }
  async function connect(){
    if(connectingRef.current||blocked.current)return;
    connectingRef.current=true;setConnecting(true);const version=++statusVersion.current;setStatusError('');
    try{const v=await write<Status>('/connect',{});if(version===statusVersion.current){statusRef.current=v;setStatus(v);await load(currentScope.current);}}
    catch(e){if(!abortError(e)){setStatusError(errorText(e));setStatus(null);statusRef.current=null;}}
    finally{connectingRef.current=false;if(alive.current)setConnecting(false);}
  }
  function update(patch:Partial<ScopeState>,id=scope){Object.assign(state(id),patch);if('text'in patch||'model'in patch||'effort'in patch)state(id).draftRevision++;persist(id);notify();}
  function selectDefaults(s:ScopeState){
    const models=statusRef.current?.models||[];
    // A disappeared model remains visible as unavailable; never silently change the user's choice.
    if(!s.model&&models[0]){s.model=models[0].id;s.effort=models[0].defaultEffort||'';}
  }
  async function load(id=scope,signal?:AbortSignal){
    const s=state(id),previous=loads.current.get(id);
    if(s.loading&&!previous?.signal?.aborted||blocked.current)return;
    const version=(previous?.version||0)+1,generation=epoch.current;loads.current.set(id,{version,signal});s.loading=true;s.error='';notify();
    try{
      await session();if(!s.loaded){restore(id);s.loaded=true;}
      const results=await Promise.allSettled([
        read<Scope>('/scope'+scopeQuery(id),signal),
        read<{turns:Turn[];nextCursor:string|null}>('/history'+scopeQuery(id)+'&limit=10',signal),
        read<{attachments:Attachment[]}>('/attachments'+scopeQuery(id),signal)
      ]);
      assertAlive(generation);if(signal?.aborted||loads.current.get(id)?.version!==version)throw new DOMException('读取已更新','AbortError');
      const [context,historyResult,filesResult]=results;
      if(context.status==='fulfilled'){
        if(context.value.scope!==id)throw Error('返回的项目上下文不符');
        s.info=context.value;
        if(context.value.activeTask)s.task=context.value.activeTask;
        else if(s.task&&running(s.task)&&!s.operation&&!s.pending)await checkTask(id,signal);
      }
      if(historyResult.status==='fulfilled'){
        const hadOlder=s.turns.length>10,fresh=[...historyResult.value.turns].reverse(),ids=new Set(fresh.map(t=>t.id));
        s.turns=[...s.turns.filter(t=>!ids.has(t.id)),...fresh];if(!hadOlder)s.nextCursor=historyResult.value.nextCursor;
      }
      if(historyResult.status==='rejected'&&['CODEX_THREAD_EMPTY','CODEX_THREAD_NOT_FOUND','CODEX_THREAD_NOT_LOADED'].includes(historyResult.reason?.code)&&s.info)s.info={...s.info,phase:'unavailable',error:errorText(historyResult.reason)};
      const attached=new Map(s.attachments.map(a=>[a.id,a]));
      if(filesResult.status==='fulfilled')for(const a of filesResult.value.attachments.filter(a=>!a.sent))if(!attached.get(a.id)?.localBusy)attached.set(a.id,a);
      s.attachments=[...attached.values()].filter(a=>!a.sent);selectDefaults(s);
      if(s.pending&&s.task?.id===s.pending.id)accept(s,s.task,id);
      const failed=results.find(r=>r.status==='rejected'&&!abortError(r.reason));if(failed?.status==='rejected')s.error=errorText(failed.reason);
    }catch(e){if(!abortError(e))s.error=errorText(e);}
    finally{if(loads.current.get(id)?.version===version){s.loading=false;persist(id);}notify();}
  }
  async function older(){
    const id=scope,s=state(id);if(s.historyLoading||!s.nextCursor)return;
    s.historyLoading=true;notify();const cursor=s.nextCursor;
    try{
      const v=await read<{turns:Turn[];nextCursor:string|null}>('/history'+scopeQuery(id)+'&limit=10&cursor='+encodeURIComponent(cursor));
      const seen=new Set(s.turns.map(t=>t.id));s.turns=[...v.turns].reverse().filter(t=>!seen.has(t.id)).concat(s.turns);s.nextCursor=v.nextCursor;s.error='';
    }catch(e){if(!abortError(e))s.error=errorText(e);}finally{s.historyLoading=false;notify();}
  }
  function accept(s:ScopeState,task:Task,id:string){
    if(task.scope!==id||s.pending&&task.id!==s.pending.id)throw Error('返回的轮次与原请求不符');
    const p=s.pending;s.task=task;
    if(p)submissions.current.set(id,{id:p.id,text:p.text,attachments:s.attachments.filter(a=>p.attachmentIds.includes(a.id)),revision:s.draftRevision});
    if(p){if(s.text===p.text)s.text='';s.attachments=s.attachments.filter(a=>!p.attachmentIds.includes(a.id));s.pending=null;persist(id);}
    const submitted=submissions.current.get(id);
    if(submitted?.id===task.id&&running(task)&&!task.items.some(i=>i.type==='user'))s.task={...task,items:[{id:task.id+'-user',type:'user',text:submitted.text,attachmentIds:submitted.attachments.map(a=>a.id)},...task.items]};
    if(submitted?.id===task.id){
      if(task.status==='failed'&&!task.turnId){
        if(!s.text&&s.draftRevision===submitted.revision){s.text=submitted.text;const ids=new Set(s.attachments.map(a=>a.id));s.attachments.push(...submitted.attachments.filter(a=>!ids.has(a.id)));s.notice='本轮未取得生成编号，输入已恢复；请核对原上下文后手动发送。';persist(id);}
        submissions.current.delete(id);
      }else if(task.turnId||!running(task))submissions.current.delete(id);
    }
  }
  async function checkTask(id=scope,signal?:AbortSignal,background=false){
    const s=state(id),taskId=s.pending?.id||s.task?.id;if(!taskId||blocked.current)return;
    const v=await read<{task:Task}>('/tasks/'+encodeURIComponent(taskId)+scopeQuery(id),signal);
    if(v.task.id!==taskId||v.task.scope!==id)throw Error('原任务身份不符');
    const wasRunning=running(s.task)||!!s.pending;accept(s,v.task,id);if(!background||s.error.startsWith('进度读取失败：'))s.error='';
    if(v.task.turnId&&!running(v.task)&&v.task.status!=='unknown'&&(wasRunning||!s.turns.some(t=>t.id===(v.task.turnId||v.task.id)))){
      const h=await read<{turns:Turn[];nextCursor:string|null}>('/history'+scopeQuery(id)+'&limit=10',signal);
      const fresh=[...h.turns].reverse(),ids=new Set(fresh.map(t=>t.id));s.turns=[...s.turns.filter(t=>!ids.has(t.id)),...fresh];
      // Preserve the older-page cursor when the user has already paged backwards.
      if(s.turns.length<=10)s.nextCursor=h.nextCursor;
      void refreshStatus(signal);
    }
    notify();
  }
  async function recover(){
    const id=scope,s=state(id);if(s.operation)return;s.operation='checking';s.error='';notify();
    try{
      const v=await write<Scope>('/scope/recover',{scope:id});if(v.scope!==id)throw Error('核对返回了其他项目');s.info=v;
      if(s.pending||s.task)await checkTask(id);else{s.task=v.activeTask;await load(id);}
      s.notice=v.recoveryNotice||'已核对原上下文；没有重新提交。';
    }catch(e){if(!abortError(e))s.error='原任务尚无法核对：'+errorText(e)+'。保留原编号，不会自动重发。';}
    finally{s.operation='';notify();}
  }
  function sendIssue(s=state()){
    const st=statusRef.current,model=st?.models.find(m=>m.id===s.model);
    if(blocked.current)return '素材库身份已变化，请刷新页面';
    if(s.pending||s.task?.status==='unknown')return '上次提交状态待核对，请查询原任务';
    if(s.operation)return '正在处理本次操作';
    if(s.loading||!s.info)return '请先读取项目上下文';
    if(s.info.phase==='unavailable'||s.info.phase==='creating')return s.info.error||'原上下文尚未可用，请核对原上下文';
    if(!st?.connected)return '请先连接本机 Codex';
    if(!st.authenticated)return '请先在本机 Codex 登录';
    if(!model)return '请选择当前可用模型';
    if(s.effort&&!model.efforts.some(e=>e.id===s.effort))return '请选择当前模型支持的推理强度';
    if(!s.text.trim()&&!s.attachments.length)return '输入需求或添加附件';
    if(s.attachments.some(a=>a.status!=='ready'||a.localBusy))return '请等待全部附件上传并解析就绪，或移除失败附件';
    if(s.attachments.some(a=>a.kind==='image'||a.kind==='video')&&!model.inputModalities?.includes('image'))return '当前模型不支持图片或视频帧，请更换支持图像的模型';
    return '';
  }
  async function send(){
    const id=scope,s=state(id);if(running(s.task)||sendIssue(s))return;
    const p:Pending={createdAt:Date.now(),id:crypto.randomUUID(),text:s.text,attachmentIds:s.attachments.map(a=>a.id)};
    const payload={scope:id,id:p.id,text:p.text,model:s.model,effort:s.effort,attachmentIds:p.attachmentIds,allowWrites:s.allowWrites};
    s.operation='sending';s.error='';s.notice='';s.pending=p;persist(id);notify();let submitted=false;
    try{
      await session();submitted=true;
      const v=await write<{task:Task}>('/turns',payload);accept(s,v.task,id);
      if(!running(v.task))await checkTask(id);else void refreshStatus();
    }catch(e){
      if(!abortError(e)){
        if(!submitted||knownRejected(e,p.id)){
          s.pending=null;persist(id);
          const status=(e as {status?:number}).status;
          if(submitted&&(status===409||status===429))await load(id);
          s.error=errorText(e);s.notice='本次发送未接受，输入已保留；没有自动重试。';
        }
        else s.error='发送结果未确认：'+errorText(e)+'。请按原编号核对；不会重发。';
      }
    }finally{s.operation='';notify();}
  }
  async function stop(){
    const id=scope,s=state(id),task=s.task;if(!task||!running(task)||s.operation||task.status==='stop_requested')return;
    s.operation='stopping';s.error='';notify();
    try{
      const v=await write<{task:Task}>('/tasks/'+encodeURIComponent(task.id)+'/stop',{scope:id});
      if(v.task.id!==task.id||v.task.scope!==id)throw Error('中止返回的任务身份不符');s.task=v.task;
      if(!running(v.task))await checkTask(id);
      s.notice='仅中止本轮。已提交的资料修改不会随中止撤销。';
    }catch(e){if(!abortError(e))s.error='中止尚未确认：'+errorText(e)+'。请重新读取本轮状态。';}
    finally{s.operation='';notify();}
  }
  async function addFiles(files:File[]){
    const id=scope,s=state(id);if(blocked.current||s.pending||s.operation==='sending')return;
    s.error='';let total=s.attachments.reduce((n,a)=>n+a.size,0);const accepted:{file:File;attachment:LocalAttachment}[]=[];
    for(const file of files){
      const kind:Attachment['kind']=/^image\//.test(file.type)?'image':/^video\//.test(file.type)||/\.(mp4|mov|webm|mkv)$/i.test(file.name)?'video':/\.(pdf|docx?|pptx?|xlsx?|odt|rtf)$/i.test(file.name)?'document':'text';
      const limit=(kind==='video'?256:kind==='image'?20:25)*MiB;
      if(s.attachments.length>=10||total+file.size>512*MiB||file.size>limit){s.error='附件限制：每轮10个、总512MiB；图片20MiB、文档25MiB、视频256MiB。超限文件未添加。';continue;}
      const attachment:LocalAttachment={id:crypto.randomUUID(),name:file.name,size:file.size,mime:file.type||'application/octet-stream',kind,status:'pending',localBusy:true};
      s.attachments.push(attachment);total+=file.size;accepted.push({file,attachment});
    }
    notify();
    // Serial uploads keep memory bounded and reserve every selected slot before the first await.
    for(const {file,attachment:a} of accepted){
      const generation=epoch.current;
      try{
        const before=await session(generation);
        const prepared=await write<{attachment:Attachment}>('/attachments',{scope:id,id:a.id,name:a.name,size:a.size,mime:a.mime});
        if(prepared.attachment.id!==a.id)throw Error('附件准备返回的编号不符');Object.assign(a,prepared.attachment,{localBusy:true});notify();
        const uploadSession=await session(generation);if(before.instanceId!==uploadSession.instanceId)throw Error('上传前素材库身份已变化');
        a.status='uploading';notify();
        const response=await fetch('/api/concierge/attachments/'+encodeURIComponent(a.id)+'/content'+scopeQuery(id),{method:'PUT',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/octet-stream','x-local-token':uploadSession.token},body:file,signal:AbortSignal.timeout(180000)});
        const data=await response.json();await session(generation);assertAlive(generation);
        if(!response.ok)throw Error(data.error||'附件上传失败');
        if(data.attachment?.id!==a.id)throw Error('上传返回的附件编号不符');Object.assign(a,data.attachment,{localBusy:false});
      }catch(e){a.status='failed';a.error=errorText(e);a.localBusy=false;if(!abortError(e))s.error='附件未就绪：'+a.name+' · '+errorText(e);}
      finally{a.localBusy=false;notify();}
    }
  }
  async function checkAttachment(attachment:LocalAttachment){
    const id=scope,s=state(id);if(s.operation||attachment.localBusy)return;s.operation='attachment';notify();
    try{const v=await read<{attachment:Attachment}>('/attachments/'+encodeURIComponent(attachment.id)+scopeQuery(id));if(v.attachment.id!==attachment.id)throw Error('附件编号不符');Object.assign(attachment,v.attachment);s.error='';}
    catch(e){if(!abortError(e))s.error=errorText(e);}finally{s.operation='';notify();}
  }
  async function removeAttachment(a:LocalAttachment){
    const id=scope,s=state(id);if(a.sent||a.localBusy||s.pending||s.operation)return;s.operation='attachment';notify();
    try{await write('/attachments/'+encodeURIComponent(a.id),{scope:id},'DELETE');s.attachments=s.attachments.filter(v=>v.id!==a.id);s.error='';}
    catch(e){if((e as {status?:number}).status===404)s.attachments=s.attachments.filter(v=>v.id!==a.id);else if(!abortError(e))s.error=(e as {status?:number}).status===409&&running(s.task)?'本轮仍在运行，后台暂不允许移除附件。可继续准备下一轮，结束后再移除。':errorText(e);}finally{s.operation='';notify();}
  }
  useEffect(()=>{alive.current=true;const changed=()=>invalidate();window.addEventListener('shiguang-library-identity-changed',changed);return()=>{alive.current=false;epoch.current++;for(const c of readers.current)c.abort();window.removeEventListener('shiguang-library-identity-changed',changed);};},[]);
  useEffect(()=>{
    if(!enabled||blocked.current)return;const controller=new AbortController();readers.current.add(controller);
    void refreshStatus(controller.signal);void load(scope,controller.signal);
    return()=>{controller.abort();readers.current.delete(controller);};
  },[enabled,scope,request]);
  useEffect(()=>{if(status){for(const [id,s] of states.current){selectDefaults(s);persist(id);}notify();}},[status]);
  useEffect(()=>{
    if(!enabled)return;let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,busy=false;
    const controller=new AbortController();readers.current.add(controller);
    const tick=async()=>{
      if(stopped||busy||document.visibilityState==='hidden'||blocked.current)return;busy=true;
      try{
        // Pending POSTs are checked only explicitly. Poll accepted active rounds by their original id.
        for(const [id,s] of states.current)if(running(s.task)&&!s.operation&&!s.pending){try{await checkTask(id,controller.signal,true);}catch(e){if(!abortError(e)){s.error='进度读取失败：'+errorText(e)+'。保留最后已知状态；没有重发。';notify();}}}
        for(const a of state(scope).attachments)if(!a.localBusy&&['pending','uploading'].includes(a.status))await checkAttachment(a);
      }finally{busy=false;if(!stopped)timer=setTimeout(tick,2200);}
    };
    const visible=()=>{clearTimeout(timer);if(document.visibilityState==='visible')void tick();};
    timer=setTimeout(tick,2200);document.addEventListener('visibilitychange',visible);
    return()=>{stopped=true;clearTimeout(timer);controller.abort();readers.current.delete(controller);document.removeEventListener('visibilitychange',visible);};
  },[enabled,scope,request]);
  return {current:state(),status,statusError,connecting,identityError,update,load,older,send,stop,recover,refreshStatus,connect,sendIssue:()=>sendIssue(),addFiles,checkAttachment,removeAttachment,persistScroll:(top:number)=>{state().scrollTop=top;persist(scope);},read,write};
}
