import {useFeedbackToast,useTaskFailureToast} from '../global-feedback';
import React,{useEffect,useId,useRef,useState} from 'react';
import {ArrowUp,Check,Copy,Download,Image as ImageIcon,LoaderCircle,CircleAlert,MessageSquare,Plus,RotateCcw,Square,Trash2,X,Zap} from 'lucide-react';
import type {PromptRequest} from '../PromptTemplateWorkspace';
import type {Values} from '../../server/prompt-templates/model.mjs';
import './codex-chat.css';
import {readTextPreference,saveTextPreference} from '../browser-preferences';
import {CodexStopConfirmation,readStopImpact,stopCodexTask,notifyCodexTasksChanged} from '../CodexTaskDrawer';
import type {CodexTaskTarget,CodexTaskImpact} from '../codex-task-types';

type Model={id:string;name:string;description:string;default:boolean;efforts:{id:string;description:string}[];defaultEffort:string};
type Connection={connecting:boolean;connectionAttempted:boolean;connectionError:string;connectionErrorCode:string;unsettled?:boolean;connected:boolean;authenticated:boolean;accountType:string|null;models:Model[];active:number};
type Block={type:'text'|'image';itemId:string;text?:string;phase?:string;status?:string;attachmentId?:string;alt?:string;error?:string;library?:{status:string;rootId?:string;assetId?:string;fileName?:string;error?:string;projectName?:string}};
type Turn={id:string;sequence_no:number;status:string;error_code:string;created_at:number;updated_at:number;request:{model:string;effort:string;text:string;output:string;retry_of:string|null};actual:{model?:string;effort?:string;contextRestored?:boolean;pictureProject?:{id:string;name:string};blockedTool?:{type:string;server?:string;tool?:string}};blocks:Block[];usage:Record<string,unknown>};
type Head={id:string;title:string;revision:number;deleted_at:number|null;updated_at:number};
type Conversation=Head&{template_id:string;context:{prompt:string;version:number};turns:Turn[]};
export type CodexTaskFocus={target:CodexTaskTarget;conversation:Conversation};
type Template={id:string;name:string;revision:number;deleted_at:number|null};
type Submission={conversationId:string;turnId?:string;path:string;body:unknown};
const activeStatuses=['queued','running','stopping'];
const labels:Record<string,string>={low:'低',medium:'中',high:'高',xhigh:'极高',minimal:'最少',none:'无',max:'最高',ultra:'极致',queued:'准备中',running:'生成中',stopping:'正在停止',completed:'已完成',interrupted:'已停止',failed:'失败'};
const errors:Record<string,string>={APPLICATION_RESTARTED:'应用曾重启，已保留部分结果，请核对后手动重新生成。',USER_STOPPED:'已按你的操作停止生成。',APPLICATION_CLOSING:'服务关闭前已停止任务，收到的内容已保留。',CODEX_DISCONNECTED:'Codex 连接中断，收到的内容已保留。',CODEX_TURN_FAILED:'Codex 未完成本次生成，请检查登录、模型权限或额度。',CODEX_RPC_ERROR:'Codex 拒绝本次请求，请检查模型、登录或额度。',CODEX_RPC_TIMEOUT:'Codex 响应超时，未自动重发请求。',UNEXPECTED_TOOL_REQUEST:'生成过程中请求了此工作台不提供的工具，任务已停止。',RESULT_SAVE_FAILED:'部分结果保存失败，请导出可见内容并检查存储空间。',TIME_LIMIT:'本次生成达到时间上限，已保留收到的内容。'};
const preflightCodes=['CODEX_DISCONNECTED','CODEX_LOGIN_REQUIRED','CODEX_BUSY','CODEX_CLOSING','LOCAL_SESSION_RESTORED','LOCAL_INSTANCE_CHANGED'];
function turnFailure(turn:Turn){const base=errors[turn.error_code]||'本次生成未正常完成，已收到的内容保留。';if(turn.error_code!=='UNEXPECTED_TOOL_REQUEST')return base;const blocked=turn.actual.blockedTool,types:Record<string,string>={commandExecution:'执行命令',fileChange:'修改文件',mcpToolCall:'外部工具',dynamicToolCall:'客户端工具',collabAgentToolCall:'其他智能体',collabToolCall:'其他智能体'};return base+(blocked?' 被拦截：'+(types[blocked.type]||blocked.type)+(blocked.tool?'（'+[blocked.server,blocked.tool].filter(Boolean).join('.')+'）':'')+'。':' 这条旧记录没有保存具体工具名称。')+' 可继续追问，连接断开时会先重新连接。';}
const date=(value:number)=>new Date(value).toLocaleString('zh-CN');
const imageURL=(id:string)=>'/api/prompt-codex/images/'+encodeURIComponent(id);
function download(name:string,body:string,type='text/plain;charset=utf-8'){const url=URL.createObjectURL(new Blob([body],{type})),link=document.createElement('a');link.href=url;link.download=name.replace(/[\\/:*?"<>|]/g,'-');link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}

// Render a small safe Markdown subset. HTML is always text; remote images are links.
function Inline({text}:{text:string}){
 const parts:React.ReactNode[]=[];const regex=/(!?\[[^\]\n]*\]\([^\s)]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`)/g;let last=0;
 for(const match of text.matchAll(regex)){parts.push(text.slice(last,match.index));const value=match[0];
  if(value.startsWith('**'))parts.push(<strong key={match.index}>{value.slice(2,-2)}</strong>);
  else if(value.startsWith('`'))parts.push(<code key={match.index}>{value.slice(1,-1)}</code>);
  else{const link=value.match(/^(!?)\[([^\]]*)\]\(([^)]+)\)$/)!;const href=link[3];parts.push(/^https?:\/\//i.test(href)?<a key={match.index} href={href} target="_blank" rel="noopener noreferrer">{link[1]?'引用图片：':''}{link[2]||'查看链接'}</a>:<span key={match.index}>{link[1]?'图片引用：':''}{link[2]||href}</span>);}
  last=match.index!+value.length;
 }parts.push(text.slice(last));return <>{parts}</>;
}
function RichText({text}:{text:string}){
 const chunks=text.split(/(```[\s\S]*?(?:```|$))/g);
 return <div className="codex-markdown">{chunks.map((chunk,index)=>chunk.startsWith('```')?<pre key={index}><code>{chunk.replace(/^```[^\n]*\n?/,'').replace(/```$/,'')}</code></pre>:<React.Fragment key={index}>{chunk.split('\n').map((line,i)=>/^#{1,4} /.test(line)?<h4 key={i}><Inline text={line.replace(/^#{1,4} /,'')}/></h4>:<div key={i} className={/^\s*([-*]|\d+\.) /.test(line)?'codex-list-line':''}><Inline text={line||'\u00a0'}/></div>)}</React.Fragment>)}</div>;
}
function Dialog({label,children,close}:{label:string;children:React.ReactNode;close:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close()},[]);
 return <dialog className="codex-dialog" ref={ref} aria-label={label} onCancel={e=>{e.preventDefault();close()}}><header><strong>{label}</strong><button onClick={close} aria-label="关闭 Codex 面板"><X size={18}/></button></header>{children}</dialog>;
}
export function CodexChat({active,request,template,values,canGenerate,templateIssue,beforeSend,templateBusy,revision,activeProject,projects,taskFocus,registerNavigationGuard,onTaskViewing}:{active:boolean;request:PromptRequest;template:Template|null;values:Values;canGenerate:boolean;templateIssue:string;beforeSend:()=>Promise<boolean>;templateBusy:boolean;revision:number;activeProject:string;projects:{id:string;name:string}[];taskFocus?:CodexTaskFocus|null;registerNavigationGuard?:(fn:()=>void)=>void;onTaskViewing?:(ids:string[])=>void}){
 const api=<T=any,>(p:string,body?:unknown,method?:string,options?:{signal?:AbortSignal})=>request<T>('/prompt-codex'+p,body,method,options);
 const [connection,setConnection]=useState<Connection>({connecting:false,connectionAttempted:false,connectionError:'',connectionErrorCode:'',connected:false,authenticated:false,accountType:null,models:[],active:0});
 const [connectionPhase,setConnectionPhase]=useState<'checking'|'idle'|'connecting'|'connected'|'login-required'|'empty'|'failed'|'unknown'>('checking');
 const [connectionError,setConnectionError]=useState(''),[connectionStarted,setConnectionStarted]=useState(0),[connectionSeconds,setConnectionSeconds]=useState(0);
  useFeedbackToast(connectionError, {source: '提示词模板', active: active});
 const connectionSeq=useRef(0),connectionAbort=useRef<AbortController|null>(null);
 const [model,setModel]=useState(()=>readTextPreference('shiguang.codex.model')||''),[effort,setEffort]=useState(()=>readTextPreference('shiguang.codex.effort')||''),[output,setOutput]=useState('mixed');
 const [heads,setHeads]=useState<Head[]>([]),[conversation,setConversation]=useState<Conversation|null>(null),[deleted,setDeleted]=useState(false),[draft,setDraft]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[reconnecting,setReconnecting]=useState(false),[lightbox,setLightbox]=useState<Block|null>(null),[destination,setDestination]=useState<{imageId:string;roots:{id:string;name:string}[];root:string}|null>(null);
  useFeedbackToast(error, {source: '提示词模板', active: active});
  useFeedbackToast(notice, {source: '提示词模板', active: active, kind: 'auto'});
 const section=useRef<HTMLElement>(null),inputRef=useRef<HTMLTextAreaElement>(null),current=useRef<Conversation|null>(null),loadSeq=useRef(0),busyRef=useRef(false),pending=useRef<{signature:string;id:string}|null>(null),newId=useRef(randomId());
 const sendHintId=useId();
 const [stopImpact,setStopImpact]=useState<CodexTaskImpact|null>(null),[highlightTurn,setHighlightTurn]=useState(''),[visible,setVisible]=useState(document.visibilityState==='visible');
 const drafts=useRef(new Map<string,string>()),draftRef=useRef(''),draftKey=useRef('new:'),focusRequest=useRef(0),highlightTimer=useRef<ReturnType<typeof setTimeout>>(),viewingRef=useRef(onTaskViewing);viewingRef.current=onTaskViewing;
 const [sendPhase,setSendPhase]=useState(''),[sendStarted,setSendStarted]=useState(0),[now,setNow]=useState(Date.now()),[sendResult,setSendResult]=useState(''),[unconfirmed,setUnconfirmed]=useState<Submission|null>(null);
 const templateId=template?.id,templateRef=useRef(template);templateRef.current=template;
 function changeDraft(text:string){draftRef.current=text;drafts.current.set(draftKey.current,text);setDraft(text);}
 function install(next:Conversation|null){const previous=current.current;if(next&&previous?.id===next.id){if(next.revision<previous.revision)return;if(next.revision===previous.revision&&Math.max(next.updated_at,...next.turns.map(t=>t.updated_at))<Math.max(previous.updated_at,...previous.turns.map(t=>t.updated_at)))return;}const key=next?.id||'new:'+templateId;if(key!==draftKey.current){drafts.current.set(draftKey.current,draftRef.current);draftKey.current=key;draftRef.current=drafts.current.get(key)||'';setDraft(draftRef.current);}if(next&&previous?.id===next.id&&next.turns.some(t=>!activeStatuses.includes(t.status)&&activeStatuses.includes(previous.turns.find(old=>old.id===t.id)?.status||'')))notifyCodexTasksChanged();current.current=next;setConversation(next);if(next&&templateId)saveTextPreference('shiguang.codex.conversation.'+templateId,next.id);}
 useEffect(()=>{registerNavigationGuard?.(()=>{if(busyRef.current)throw Error('对话正在提交或处理，请等待回执后再跳转；草稿已保留');if(unconfirmed)throw Error('原提交结果待确认，请先在原对话核对；未自动重发');drafts.current.set(draftKey.current,draftRef.current);});},[unconfirmed,registerNavigationGuard]);
 useEffect(()=>{const changed=()=>setVisible(document.visibilityState==='visible');document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
 function applyConnection(next:Connection){if(!next||typeof next.connected!=='boolean'||typeof next.authenticated!=='boolean'||!Array.isArray(next.models))throw Error('连接状态格式不兼容，请更新 Codex 后重试');setConnection(next);setConnectionError(next.connectionError?((next.connectionErrorCode?next.connectionErrorCode+' · ':'')+next.connectionError):'');if(next.connecting)setConnectionStarted(old=>old||Date.now());else setConnectionStarted(0);setConnectionPhase(next.connecting?'connecting':next.connectionError?'failed':!next.connected?'idle':!next.authenticated?'login-required':!next.models.length?'empty':'connected');const chosen=next.models.find(m=>m.id===model)||next.models.find(m=>m.default)||next.models[0];if(chosen){setModel(chosen.id);if(!chosen.efforts.some(e=>e.id===effort))setEffort(chosen.defaultEffort||'');}}
 async function run(fn:()=>Promise<unknown>){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await fn()}catch(e){setError(connectionFailure(e))}finally{busyRef.current=false;setBusy(false);setSendPhase('')}}
 function sendProgress(label:string){setSendPhase(label);setSendStarted(Date.now());setNow(Date.now());setSendResult('');}
 async function sendRequest<T>(label:string,p:string,body?:unknown){sendProgress(label);try{return await api<T>(p,body,undefined,{signal:AbortSignal.timeout(30000)});}catch(e){const failure=e as Error;if(['TimeoutError','AbortError'].includes(failure.name))throw Error(label+'等待超时。请检查本机服务；没有自动重发。');throw e;}}
 function uncertainFailure(e:unknown){const failure=e as {status?:number;code?:string};if(preflightCodes.includes(failure.code||''))return false;return !failure.status||failure.status>=500;}
 async function checkSubmission(){
  const target=unconfirmed;if(!target)return;
  const next=await sendRequest<Conversation>('正在检查提交结果…','/conversations/'+target.conversationId);
  if(next.template_id===templateRef.current?.id)install(next);
  if(target.turnId&&!next.turns.some(t=>t.id===target.turnId)){setSendResult('尚未查到这次生成，结果仍待确认。请稍后再次检查，不要重复发送。');return;}
  pending.current=null;setUnconfirmed(null);setSendResult(target.turnId?'已确认这次生成，结果显示在上方对话中。':'模板对话已保存，但尚未发送生成请求。可再次点击生成。');
 }
 async function retrySubmission(){const target=unconfirmed;if(!target)return;await sendRequest('正在重试原提交…',target.path,target.body);await checkSubmission();}
 async function list(showDeleted=deleted){const owner=templateRef.current?.id,seq=loadSeq.current;const rows=await api<Head[]>('/conversations?'+new URLSearchParams({...(templateId?{template_id:templateId}:{}),deleted:showDeleted?'1':'0'}),undefined,undefined,{signal:AbortSignal.timeout(15000)});if(seq===loadSeq.current&&owner===templateRef.current?.id)setHeads(rows);return rows;}
 async function reload(){if(current.current)install(await api<Conversation>('/conversations/'+current.current.id,undefined,undefined,{signal:AbortSignal.timeout(15000)}));await list();setError('');}
 useEffect(()=>{if(!active||!visible)return;const controller=new AbortController();void checkConnection(controller.signal);return()=>{connectionSeq.current++;controller.abort();};},[active,visible]);
 useEffect(()=>()=>{connectionSeq.current++;connectionAbort.current?.abort();},[]);
 useEffect(()=>{if(!active||!visible||!connection.connecting||connectionAbort.current||connectionPhase==='unknown')return;let stopped=false,timer:ReturnType<typeof setTimeout>;const controller=new AbortController();const tick=async()=>{if(stopped||document.hidden)return;await checkConnection(controller.signal,true);if(!stopped)timer=setTimeout(tick,1200);};timer=setTimeout(tick,1200);return()=>{stopped=true;clearTimeout(timer);controller.abort();};},[active,visible,connection.connecting,connectionPhase]);
 useEffect(()=>{if(!active||!visible||connectionPhase!=='connecting')return;const update=()=>setConnectionSeconds(Math.floor((Date.now()-connectionStarted)/1000));update();const timer=setInterval(update,1000);return()=>clearInterval(timer);},[active,visible,connectionPhase,connectionStarted]);
 useEffect(()=>{
  const seq=++loadSeq.current;drafts.current.set(draftKey.current,draftRef.current);setError('');setSendResult('');pending.current=null;newId.current=randomId();
  if(taskFocus&&taskFocus.target.templateId===templateId){const next=taskFocus.conversation;install(next);setDeleted(!!next.deleted_at);void list(!!next.deleted_at).catch(e=>{if(seq===loadSeq.current)setError('对话已打开，但历史列表未刷新：'+e.message);});return;}
  current.current=null;setConversation(null);setDeleted(false);if(!templateId){setHeads([]);return;}
  void api<Head[]>('/conversations?template_id='+templateId).then(async rows=>{if(seq!==loadSeq.current)return;setHeads(rows);const saved=readTextPreference('shiguang.codex.conversation.'+templateId);const id=rows.find(h=>h.id===saved)?.id||rows[0]?.id;if(id){const next=await api<Conversation>('/conversations/'+id);if(seq===loadSeq.current)install(next);}}).catch(e=>{if(seq===loadSeq.current)setError(e.message)});
 },[templateId,revision,taskFocus?.target.request]);
 const focusPresent=!!taskFocus&&conversation?.id===taskFocus.target.conversationId&&!!conversation.turns.some(t=>t.id===taskFocus.target.turnId);
 useEffect(()=>{if(!active||!taskFocus||!focusPresent||focusRequest.current===taskFocus.target.request)return;const element=section.current?.querySelector<HTMLElement>('[data-turn-id="'+CSS.escape(taskFocus.target.turnId)+'"]');if(!element)return;focusRequest.current=taskFocus.target.request;element.scrollIntoView({block:'center',behavior:'smooth'});clearTimeout(highlightTimer.current);setHighlightTurn(taskFocus.target.turnId);highlightTimer.current=setTimeout(()=>setHighlightTurn(''),4000);},[active,taskFocus?.target.request,focusPresent]);
 useEffect(()=>()=>clearTimeout(highlightTimer.current),[]);
 useEffect(()=>{if(!active||!visible){viewingRef.current?.([]);return;}const viewed=new Set<string>(),observer=new IntersectionObserver(entries=>{for(const entry of entries){const id=(entry.target as HTMLElement).dataset.turnId!;if(entry.isIntersecting)viewed.add(id);else viewed.delete(id);}viewingRef.current?.([...viewed]);},{threshold:.1});section.current?.querySelectorAll('[data-turn-id]').forEach(e=>observer.observe(e));return()=>{observer.disconnect();viewingRef.current?.([]);};},[active,visible,conversation?.id,conversation?.turns.length]);
 useEffect(()=>{saveTextPreference('shiguang.codex.model',model);saveTextPreference('shiguang.codex.effort',effort)},[model,effort]);
 useEffect(()=>{
  if(!active||!visible||!conversation?.id)return;const id=conversation.id;let alive=true;
  const events=new EventSource('/api/prompt-codex/conversations/'+id+'/events');
  const receive=(event:MessageEvent)=>{if(!alive||current.current?.id!==id)return;try{const next=JSON.parse(event.data) as Conversation;install(next);setReconnecting(false);}catch{setReconnecting(true)}};
  events.addEventListener('snapshot',receive as EventListener);events.onerror=()=>{if(alive)setReconnecting(true)};
  return()=>{alive=false;events.close();setReconnecting(false)};
 },[active,visible,conversation?.id]);
 useEffect(()=>{if(!active||!visible||!reconnecting||!conversation?.id)return;let pending=false,alive=true;const id=conversation.id;const timer=setInterval(()=>{if(pending)return;pending=true;void api<Conversation>('/conversations/'+id,undefined,undefined,{signal:AbortSignal.timeout(15000)}).then(next=>{if(alive&&current.current?.id===id)install(next)}).catch(()=>{}).finally(()=>pending=false)},2000);return()=>{alive=false;clearInterval(timer)}},[active,visible,reconnecting,conversation?.id]);
 const selectedModel=connection.models.find(m=>m.id===model),last=conversation?.turns.at(-1),generating=!!last&&activeStatuses.includes(last.status),readonly=!!conversation?.deleted_at;
  useTaskFailureToast(last?.id,generating,last?.error_code&&last.error_code!=='USER_STOPPED'?turnFailure(last):'',{source:'Codex 生成',active});
 const selectedProject=projects.find(p=>p.id===activeProject);
 useEffect(()=>{if(last?.status==='completed')setSendResult('本轮已完成，结果显示在上方对话中。');},[last?.id,last?.status]);
 useEffect(()=>{if(last?.error_code&&!activeStatuses.includes(last.status))void checkConnection();},[last?.id,last?.status,last?.error_code]);
 useEffect(()=>{if(!sendPhase&&!generating)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[sendPhase,generating]);
 async function checkConnection(signal?:AbortSignal,background=false){
  if(connectionAbort.current)return null;
  const seq=++connectionSeq.current;if(!background){setConnectionPhase('checking');setConnectionError('');}
  try{const status=await api<Connection>('/status',undefined,undefined,{signal:AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])])});if(seq===connectionSeq.current){applyConnection(status);return status;}return null;}
  catch(e){if(signal?.aborted)return null;if(seq===connectionSeq.current){setConnectionPhase('failed');setConnectionError('无法读取连接状态：'+connectionFailure(e));setConnection(previous=>({...previous,connecting:false,connected:false,authenticated:false}));}return null;}
 }
 function connectionFailure(error:unknown){if(error instanceof Error){if(['AbortError','TimeoutError'].includes(error.name))return'请求超时，请检查本机服务后重试';if(error.message==='Failed to fetch')return'无法连接素材管理器服务，请确认服务仍在运行';return error.message;}return'连接未完成，请检查本机 Codex 后重试';}
 async function connect(){
  const observed=await api<Connection>('/status',undefined,undefined,{signal:AbortSignal.timeout(15000)});if(observed.connecting){applyConnection(observed);return observed;}if(observed.active||observed.unsettled||unconfirmed)throw Error('还有生成尚未结清，不能重新连接共享连接。请先检查任务状态。');
  if(connectionAbort.current||connectionPhase==='unknown')return null;
  const seq=++connectionSeq.current,controller=new AbortController();connectionAbort.current=controller;let timedOut=false;
  setConnectionPhase('connecting');setConnectionError('');setConnectionStarted(Date.now());setConnectionSeconds(0);
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},65000);
  try{const status=await api<Connection>('/connect',{},'POST',{signal:controller.signal});if(seq===connectionSeq.current){applyConnection(status);return status;}return null;}
  catch(e){if(seq===connectionSeq.current){setConnectionPhase(timedOut?'unknown':'failed');setConnectionError(timedOut?'连接等待已超时，后台结果尚未确认。请先检查连接状态，再决定是否重试；没有发送生成请求。':connectionFailure(e));setConnection(previous=>({...previous,connected:false,authenticated:false}));}return null;}
  finally{clearTimeout(timer);if(connectionAbort.current===controller)connectionAbort.current=null;}
 }
 const connecting=connectionPhase==='connecting',checking=connectionPhase==='checking';
 const connectionTitle={checking:'正在检查连接…',idle:'尚未连接',connecting:connection.connecting?'后台正在连接…':'正在连接…',connected:'已连接', 'login-required':'需要本机登录',empty:'未读取到可用模型',failed:'连接失败',unknown:'连接结果待确认'}[connectionPhase];
 const connectionDetail=connecting?(connectionSeconds>=8?'连接较慢，正在等待本机 Codex 响应，请勿重复点击。':(connection.connecting?'后台正在连接…确认登录并读取模型列表。':'正在建立本机连接、确认登录并读取模型列表…'))+' 已等待 '+connectionSeconds+' 秒。':connectionPhase==='connected'?'连接成功 · '+(connection.accountType==='chatgpt'?'ChatGPT 登录':connection.accountType==='apiKey'?'API 登录':'本机已授权')+' · 已读取 '+connection.models.length+' 个可用模型。'+(generating?'正在生成，结果会自动保存。':conversation?.turns.length?'对话已保存，可继续追问。':'点击下方「使用 Codex 生成」发送完整提示词。'):connectionPhase==='login-required'?'已连接本机 Codex，但尚未登录。请在本机 Codex 登录后点击重新连接。':connectionPhase==='empty'?'已确认本机登录，但没有可用模型。请检查账号模型权限，再点击重新连接。':connectionPhase==='checking'?'正在读取当前连接状态，不会发起生成。':connectionError||'后台连接未就绪。请检查本机安装与登录状态，再点击“重新连接”；输入不会自动发送。';
 const sendBlockedReason=template?.deleted_at?'当前模板已删除，请先在上方恢复模板。':!conversation&&!template?'请先在左侧选择模板；没有模板时，可点击上方「新建模板」或「选用内置模板」。':!conversation&&!canGenerate?'请先完成上方模板输入：'+(templateIssue||'检查并补全必填项。'):!selectedProject?'请先在顶部选择项目。':unconfirmed?'上次提交结果尚未确认，请先检查提交结果。':templateBusy?'模板正在处理，请稍候。':busy?(connecting?'正在连接 Codex，请稍候。':checking?'正在检查连接状态，请稍候。':'正在处理，请稍候。'):connecting?'后台正在连接…':checking?'正在读取连接状态…':!connection.connected?'尚未连接，请点击“重新连接”':!connection.authenticated?'请先在本机 Codex 登录后点击“重新连接”':!connection.models.length?'没有可用模型，请检查权限后点击“重新连接”':!selectedModel?'请先选择一个可用的对话模型。':'';
 const sendHint=sendBlockedReason;
 async function generateFromTemplate(){
  if(unconfirmed)throw Error('上次提交结果尚未确认，请先点击「检查提交结果」。');
  sendProgress('正在准备生成…');
  const snapshot=templateRef.current;
  if(!snapshot||!canGenerate||snapshot.deleted_at)throw Error(templateIssue||'请先选择模板并完整填写必填项');
  if(!selectedProject)throw Error('请先在顶部选择项目');const projectId=selectedProject.id;
  if(generating)throw Error('请先等待或停止当前生成');
  loadSeq.current++;
  const status=await checkConnection();
  if(!status){setSendResult('尚未发送生成请求，请查看连接结果后重试。');return;}
  if(status.connecting||!status.connected||!status.authenticated)throw Error(status.connecting?'后台正在连接…尚未发送，输入已保留':status.connectionError||'尚未准备好，请登录并点击“重新连接”；输入已保留');
  const chosen=status.models.find(m=>m.id===model)||status.models.find(m=>m.default)||status.models[0];
  if(!chosen)throw Error('没有可用模型，请检查账号模型权限后重试');
  if(templateRef.current?.id!==snapshot.id||templateRef.current?.revision!==snapshot.revision)throw Error('模板已切换或更新，请核对上方提示词后再次点击生成');
  if(!pending.current)newId.current=randomId();
  await send(undefined,{template:snapshot,values,model:chosen,effort:chosen.efforts.some(e=>e.id===effort)?effort:chosen.defaultEffort||'',projectId});
 }
 async function send(retry?:Turn,fresh?:{template:Template;values:Values;model:Model;effort:string;projectId:string}){
  if(unconfirmed)throw Error('上次提交结果尚未确认，请先点击「检查提交结果」。');
  if(!fresh&&sendBlockedReason)throw Error(sendBlockedReason);
  let usedModel=fresh?.model||selectedModel,usedEffort=fresh?.effort??effort;
  const projectId=fresh?.projectId||selectedProject?.id;if(!projectId)throw Error('请先在顶部选择项目');
  let head=fresh?null:current.current;
  const text=fresh?'':retry?retry.request.text:draft;
  if(!fresh&&head?.turns.length&&!retry&&!text.trim())throw Error('请填写追问内容');
  if(!fresh){sendProgress('正在只读核对连接…');const status=await checkConnection();if(!status||status.connecting||!status.connected||!status.authenticated)throw Error(status?.connectionError||'连接尚未准备，输入已保留；请核对状态或点击“重新连接”');usedModel=status.models.find(m=>m.id===model);usedEffort=usedModel?.efforts.some(e=>e.id===effort)?effort:usedModel?.defaultEffort||'';if(head&&current.current?.id!==head.id)throw Error('对话已切换，尚未发送这次追问，请核对当前对话后重试。');}
  if(!usedModel)throw Error('请选择当前可用的模型');
  if(!head){const source=fresh?.template||templateRef.current;if(!source||!canGenerate)throw Error('请先完整填写模板的必填项');sendProgress('正在保存模板输入…');if(!await beforeSend())throw Error('尚未发送生成请求：模板输入未能保存，请先处理草稿错误。');
    const target={conversationId:newId.current,path:'/conversations',body:{id:newId.current,template_id:source.id,template_revision:source.revision,values:fresh?.values||values}};
    try{head=await sendRequest<Conversation>('正在保存模板对话…',target.path,target.body);}catch(e){if(uncertainFailure(e))setUnconfirmed(target);throw e;}install(head);}
  const payload={model:usedModel.id,effort:usedEffort,output,text,retry_of:retry?.id??null,project_id:projectId},signature=JSON.stringify({conversationId:head.id,...payload});
  if(!pending.current||pending.current.signature!==signature)pending.current={signature,id:randomId()};
  const target={conversationId:head.id,turnId:pending.current.id,path:'/conversations/'+head.id+'/turns',body:{...payload,id:pending.current.id,expected_revision:head.revision}};
  let accepted:Turn;try{accepted=await sendRequest<Turn>('正在提交生成请求…',target.path,target.body);}catch(e){if(uncertainFailure(e))setUnconfirmed(target);if(['CODEX_DISCONNECTED','CODEX_LOGIN_REQUIRED'].includes((e as {code?:string}).code||''))applyConnection({connecting:false,connectionAttempted:true,connectionError:'',connectionErrorCode:'',connected:false,authenticated:false,models:[],accountType:null,active:0});throw e;}
  pending.current=null;notifyCodexTasksChanged();if(!retry)changeDraft('');
  // The receipt is enough to show a task immediately; history refresh must not gate feedback.
  const observed=current.current?.id===head.id?current.current:head;
  if(!observed.turns.some(t=>t.id===accepted.id))install({...observed,revision:Math.max(observed.revision,head.revision+1),turns:[...observed.turns,accepted]});
  setSendResult('生成请求已接收，结果会显示在上方对话中。');
  void api<Conversation>('/conversations/'+head.id,undefined,undefined,{signal:AbortSignal.timeout(15000)}).then(next=>{if(current.current?.id===next.id)install(next)}).catch(()=>setReconnecting(true));
  void list().catch(()=>setNotice('生成已提交；对话列表暂未刷新，可稍后重新读取。'));
 }
 async function copy(text:string){try{await navigator.clipboard.writeText(text);setNotice('已复制回答')}catch{setNotice('请使用 TXT 下载保存回答')}}
 async function switchDeleted(value:boolean){const rows=await list(value);setDeleted(value);install(rows[0]?await api<Conversation>('/conversations/'+rows[0].id):null);}
 async function removeOrRestore(){if(!conversation)return;if(!readonly&&!confirm('删除只隐藏这段对话，文字、图片和历史全部保留。继续？'))return;await api('/conversations/'+conversation.id+(readonly?'/restore':''),{expected_revision:conversation.revision},readonly?'POST':'DELETE');const rows=await list();install(rows[0]?await api<Conversation>('/conversations/'+rows[0].id):null);}
 function newConversation(){loadSeq.current++;install(null);newId.current=randomId();pending.current=null;setDeleted(false);changeDraft('');setError('');setSendResult('');void list(false).catch(e=>setError(connectionFailure(e)));inputRef.current?.focus();}
 async function stopCurrent(){if(!current.current)return;const turn=current.current.turns.at(-1);if(!turn)return;const impact=await readStopImpact(request,turn.id);if(impact.requiresConfirmation){setStopImpact(impact);return;}await stopCodexTask(request,impact,false);await reload();}
 async function addToLibrary(block:Block){const roots=await api<{id:string;name:string}[]>('/library-destinations');if(!roots.length)throw Error('请先在素材管理器登记一个照片或混合素材目录，也可以直接下载图片。');setDestination({imageId:block.attachmentId!,roots,root:roots[0].id});}
 function renderFeedback(location:string){const failed=!!(error||unconfirmed||last?.error_code||connectionError);return <div className={'codex-action-feedback '+location+(failed?' failed':'')} role={failed?'alert':'status'} aria-live="polite">
  {failed&&!sendPhase&&!generating&&<p className="codex-error-title"><CircleAlert size={16}/>操作未完成，请查看以下原因</p>}
  {error&&<p>{error}</p>}
  {unconfirmed&&sendPhase&&<p>{sendPhase} 已等待 {Math.max(0,Math.floor((now-sendStarted)/1000))} 秒。</p>}
  {unconfirmed?<><p>提交结果待确认，未自动重发。请检查这次提交，避免重复生成。</p>{sendResult&&<p>{sendResult}</p>}<button disabled={busy} onClick={()=>void run(checkSubmission)}>检查提交结果</button><p>若一直查不到，可手动重试原提交；使用原任务编号和原内容，不会新建重复任务。</p><button disabled={busy} onClick={()=>void run(retrySubmission)}>重试原提交</button></>:sendPhase?<p>{connecting?connectionDetail:sendPhase+' 已等待 '+Math.max(0,Math.floor((now-sendStarted)/1000))+' 秒。'}{!connecting&&now-sendStarted>=8000?'处理较慢，请勿重复点击。':''}</p>:generating?<p>{last.status==='stopping'?'正在停止，已收到的内容会保留。':last.blocks.length?'正在生成，收到的内容持续显示在上方。':'请求已接收，正在等待 Codex 返回内容。'} 已等待 {Math.max(0,Math.floor((now-last.created_at)/1000))} 秒。<button disabled={busy} onClick={()=>void run(reload)}>检查生成进度</button></p>:<>{sendResult&&<p>{sendResult}</p>}{last?.error_code&&<p>{turnFailure(last)}</p>}</>}
  {!unconfirmed&&!sendPhase&&!generating&&connectionError&&<p>{connectionError}</p>}
  {!unconfirmed&&!generating&&(!connection.connected||!connection.authenticated)&&<button disabled={busy||connecting||!!connection.unsettled||connectionPhase==='unknown'} onClick={()=>void run(connect)}>重新连接</button>}
 </div>;}
 return <section className="codex-chat" aria-label="Codex 图文对话" ref={section}>
  <header className="codex-chat-heading"><div><span className="codex-eyebrow"><Zap size={13}/>CODEX</span><h2>让模板开始对话</h2><p>选择模型与推理强度，生成文字或图文，继续追问并保留每一版。</p></div><div className="codex-header-actions">
    <span className={'codex-connection '+connectionPhase} role="status" aria-live="polite">{(connecting||checking)&&<LoaderCircle size={14} className="codex-connection-spinner"/>}{connectionPhase==='connected'&&<Check size={14}/>} {connectionTitle}</span>
    <button className="codex-connect-button" disabled={busy||connecting||generating||connection.active>0||connection.unsettled||unconfirmed!==null||connectionPhase==='unknown'} aria-busy={connecting} onClick={()=>void run(connect)}>{connecting?<><LoaderCircle size={14} className="codex-connection-spinner"/>{connectionTitle}</>:'重新连接'}</button>
    <button disabled={busy||connecting||checking} onClick={()=>void run(checkConnection)}>检查连接状态</button>
    {connection.connected&&<button disabled={busy||generating||connection.active>0} onClick={()=>void run(async()=>{const status=await api<Connection>('/status');if(status.active)throw Error('还有生成未结清，不能断开共享连接');applyConnection(await api('/disconnect',{}));})}>断开</button>}
  </div></header>
  <div className={'codex-connection-detail '+connectionPhase} role={connectionPhase==='failed'||connectionPhase==='unknown'?'alert':'status'} aria-live="polite">{connectionPhase==='failed'||connectionPhase==='unknown'?<CircleAlert size={16}/>:connectionPhase==='connected'?<Check size={16}/>:null}<span>{connectionDetail}</span></div>
  <div className="codex-settings"><label>对话模型<select aria-label="Codex 对话模型" disabled={busy||generating||!connection.connected||!connection.authenticated} value={model} onChange={e=>{const next=connection.models.find(m=>m.id===e.target.value)!;setModel(next.id);setEffort(next.defaultEffort||'');setNotice('已切换模型，推理强度采用该模型默认值')}}><option value="">{connection.connected?'选择模型':'连接后读取模型'}</option>{connection.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>推理强度<select aria-label="Codex 推理强度" disabled={busy||generating||!selectedModel} value={effort} onChange={e=>setEffort(e.target.value)}><option value="">模型默认</option>{selectedModel?.efforts.map(e=><option key={e.id} value={e.id}>{labels[e.id]||e.id}{e.id===selectedModel.defaultEffort?' · 推荐':''}</option>)}</select></label><label>输出偏好<select aria-label="Codex 输出偏好" disabled={busy||generating} value={output} onChange={e=>setOutput(e.target.value)}><option value="mixed">图文</option><option value="image">只生成图片</option></select></label><small>{selectedModel?.efforts.find(e=>e.id===effort)?.description||selectedModel?.description||'使用本机 Codex 的登录和可用模型。只在你点击生成时发送内容。'}</small></div>
  <div className="codex-tip"><ImageIcon size={15}/>原图保存到 personal_item/picture/项目文件夹 并自动加入素材库；以每次发送时所选项目为准{selectedProject?'（当前：'+selectedProject.name+'）':'，请先在顶部选择项目'}。</div>
  {error&&<div className="codex-error" role="alert">{error}<button onClick={()=>void run(reload)}>重新读取</button></div>}
  {notice&&<div className="codex-notice" role="status">{notice}<button aria-label="关闭 Codex 提示" onClick={()=>setNotice('')}><X size={13}/></button></div>}
  <div className="codex-body"><aside className="codex-history"><header><strong>对话记录</strong><button title="使用当前模板开启新对话" aria-label="Codex 新对话" disabled={busy||!template||!!template.deleted_at} onClick={newConversation}><Plus size={16}/></button></header><div className="codex-tabs"><button className={!deleted?'selected':''} onClick={()=>void run(()=>switchDeleted(false))}>正常对话</button><button className={deleted?'selected':''} onClick={()=>void run(()=>switchDeleted(true))}>已删除对话</button></div><div className="codex-history-list">{heads.map(h=><button key={h.id} data-conversation-id={h.id} className={h.id===conversation?.id?'selected':''} disabled={busy} onClick={()=>void run(async()=>install(await api('/conversations/'+h.id)))}><MessageSquare size={14}/><span><strong>{h.title}</strong><small>{date(h.updated_at)}</small></span></button>)}{!heads.length&&<p>此模板还没有{deleted?'已删除的':''}对话。</p>}</div><small>对话和图片跟随素材库保存。</small></aside>
   <div className="codex-conversation"><header><div><strong>{conversation?conversation.title:template?'从当前模板开始':'先选择提示词模板'}</strong><small>{conversation?'模板快照 v'+conversation.context.version+' · '+conversation.turns.length+' 次回答':template?'先填写上方模板，再选择模型生成。':'在左侧选择模板，或新建、选用内置模板。'}</small></div><div>{conversation&&<><button disabled={busy} onClick={()=>download('Codex对话-'+conversation.id+'.json',JSON.stringify(conversation,null,2),'application/json')} title="导出对话文字与图片引用">导出记录</button><button disabled={busy||generating} onClick={()=>void run(removeOrRestore)}>{readonly?<RotateCcw size={14}/>:<Trash2 size={14}/>} {readonly?'恢复对话':'删除对话'}</button></>}</div></header>
    <div className="codex-messages" aria-live="polite">{!conversation?.turns.length&&<div className="codex-chat-empty"><MessageSquare size={28}/><h3>{!template?'选择模板后开始生成':!canGenerate?'填写完成后开始生成':'模板已就绪，让 Codex 接着完成'}</h3><p>{!template?'先选择模板并填写关键内容，再点击下方「使用 Codex 生成」。':'首条消息发送整份模板提示词。后续可以补充要求、修改回答或重新生成。'}</p></div>}
     {conversation?.turns.map(turn=><article className={"codex-turn"+(highlightTurn===turn.id?" codex-turn-focused":"")} data-turn-id={turn.id} key={turn.id} data-testid={'codex-turn-'+turn.sequence_no}><div className="codex-user"><span>你</span><details open={!!turn.request.text}><summary>{turn.request.retry_of?'重新生成原问题':turn.request.text?'本次追问':'完整模板提示词'}</summary><pre>{turn.request.text||conversation.context.prompt}</pre></details></div><div className="codex-answer"><header><span><Zap size={14}/>{turn.actual.model||turn.request.model}<small>{labels[turn.actual.effort||turn.request.effort]||turn.actual.effort||turn.request.effort||'模型默认'}</small></span><span className={'codex-status '+turn.status}>{turn.status==='interrupted'&&turn.error_code!=='USER_STOPPED'?'生成中断':labels[turn.status]||turn.status}</span></header>
      {turn.actual.contextRestored&&<small className="codex-restored">已从保存记录恢复上下文</small>}
      {turn.actual.pictureProject&&<small className="codex-restored">图片所属项目：{turn.actual.pictureProject.name}</small>}
      {turn.blocks.map(block=>block.type==='text'?(block.phase==='commentary'?<details className="codex-progress" key={block.itemId}><summary>生成过程</summary><RichText text={block.text||''}/></details>:<RichText key={block.itemId} text={block.text||''}/>):<figure key={block.itemId} className="codex-image">{block.status==='ready'&&block.attachmentId?<><button className="codex-image-preview" onClick={()=>setLightbox(block)}><img src={imageURL(block.attachmentId)} alt={block.alt||'Codex 生成图片'} loading="lazy"/></button><figcaption><span>{block.library?.status==='ready'?'已保存原图 · 已自动入库 picture':'生成图片 · 已保存原图'}</span><div><button onClick={()=>setLightbox(block)}>放大</button><a href={imageURL(block.attachmentId)+'?download=1'} download>下载</a><button onClick={()=>void run(()=>addToLibrary(block))}>{block.library?.status==='ready'?'另存到素材库':'加入素材库'}</button></div></figcaption>{block.library?.status==='failed'&&<p className="codex-turn-error">{block.library.error}</p>}</>:<div className={block.status==='failed'?'codex-image-failed':'codex-image-pending'}><ImageIcon size={22}/>{block.status==='failed'?block.error:'正在生成并保存图片…'}</div>}</figure>)}
      {activeStatuses.includes(turn.status)&&!turn.blocks.length&&<p className="codex-waiting" role="status"><LoaderCircle size={16} className="codex-connection-spinner"/>请求已接收，正在等待 Codex 返回内容…</p>}
      {turn.error_code&&<p className="codex-turn-error">{turnFailure(turn)}</p>}
      {!activeStatuses.includes(turn.status)&&<footer><small>{date(turn.created_at)}</small><div><button onClick={()=>void copy(turn.blocks.filter(b=>b.type==='text'&&b.phase!=='commentary').map(b=>b.text).join('\n\n'))}><Copy size={13}/>复制文字</button><button onClick={()=>download('Codex回答-'+turn.sequence_no+'.txt',turn.blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n\n'))}><Download size={13}/>TXT</button>{turn.id===last?.id&&!readonly&&<button disabled={busy||generating||!connection.authenticated} onClick={()=>void run(()=>send(turn))}><RotateCcw size={13}/>重新生成</button>}</div></footer>}
     </div></article>)}
    </div>
    {reconnecting&&<div className="codex-tip" role="status">进度连接中断，后台状态待确认。最后已知内容保留，正在只读核对；不会重新发送生成。</div>}
    {readonly?<div className="codex-tip">已删除的对话和图片仍保留，恢复后可继续使用。</div>:<div className="codex-composer">
     {sendHint&&<p id={sendHintId} className="codex-send-hint" role="status"><CircleAlert size={15}/><span>{sendHint}</span></p>}
     {!!conversation?.turns.length&&<><textarea ref={inputRef} aria-label="Codex 追问内容" placeholder="继续追问，或说明你希望怎样修改…" value={draft} maxLength={200000} disabled={busy||generating} onChange={e=>changeDraft(e.target.value)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();if(!generating)void run(()=>send())}}}/>{renderFeedback('codex-composer-feedback')}</>}
     <footer><small>{generating?'回答正在保存，可以停止生成。':conversation?.turns.length?'⌘ / Ctrl + Enter 发送 · 每次回答自动保存':'点击下方「使用 Codex 生成」，直接发送完整提示词。'}</small>{generating?<button className="codex-stop" disabled={busy} onClick={()=>void run(stopCurrent)}><Square size={14}/>停止生成</button>:!!conversation?.turns.length&&<button className="prompt-primary" disabled={!!sendBlockedReason} aria-describedby={sendHint?sendHintId:undefined} onClick={()=>void run(()=>send())}><ArrowUp size={16}/>{busy?(connecting?'正在连接…':checking?'正在检查…':'正在处理…'):'发送追问'}</button>}</footer>
    </div>}
   </div>
  </div>
  <div className="codex-generate-action"><p>{template?.deleted_at?'当前模板已删除，请先恢复模板。':!canGenerate?(templateIssue||'请先选择模板并填写上方必填项。'):!selectedProject?'请先在顶部选择项目。':templateBusy?'模板正在处理，请稍候。':'将上方完整提示词直接发送给 Codex，回答自动保存。'}</p>
   {renderFeedback('codex-generation-feedback')}
   <button className="prompt-primary codex-generate-button" disabled={templateBusy||busy||generating||!!unconfirmed||!canGenerate||!selectedProject||!!template?.deleted_at} aria-busy={busy||generating} onClick={()=>void run(generateFromTemplate)}>{busy||generating?<LoaderCircle size={20} className="codex-connection-spinner"/>:<Zap size={20}/>} {connecting?'正在连接 Codex…':busy?'正在提交…':generating?'正在生成…':unconfirmed?'请先检查提交结果':'使用 Codex 生成'}</button></div>
  {stopImpact&&<CodexStopConfirmation impact={stopImpact} busy={busy} close={()=>setStopImpact(null)} submit={()=>void run(async()=>{try{await stopCodexTask(request,stopImpact,true);}finally{setStopImpact(null);}await reload();})}/>}
  {lightbox&&<Dialog label="Codex 图片预览" close={()=>setLightbox(null)}><img className="codex-full-image" src={imageURL(lightbox.attachmentId!)} alt="Codex 生成原图"/><footer><a href={imageURL(lightbox.attachmentId!)+'?download=1'} download>下载原图</a></footer></Dialog>}
  {destination&&<Dialog label="加入素材库" close={()=>setDestination(null)}><div className="codex-dialog-body"><p>将这张图片复制为新文件到所选目录，已有文件不会被覆盖。</p><label>素材目录<select aria-label="Codex 图片目标目录" value={destination.root} onChange={e=>setDestination({...destination,root:e.target.value})}>{destination.roots.map(root=><option key={root.id} value={root.id}>{root.name}</option>)}</select></label></div><footer><button onClick={()=>setDestination(null)}>取消</button><button disabled={busy} className="prompt-primary" onClick={()=>void run(async()=>{await api('/images/'+destination.imageId+'/add-to-library',{root_id:destination.root,confirm:true});setDestination(null);setNotice('图片已复制，素材库正在建立索引')})}><Check size={14}/>确认加入</button></footer></Dialog>}
 </section>;
}
function randomId(){return crypto.randomUUID();}
