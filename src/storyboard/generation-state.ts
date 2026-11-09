import {useFeedbackToast} from '../global-feedback';
import {useEffect,useRef,useState} from 'react';
import type {PromptRequest} from '../PromptTemplateWorkspace';
import {generationActive,type GenerationConfig,type GenerationInput,type GenerationProjectState,type GenerationTask} from './generation-types';
export type GenerationDraft=GenerationConfig&{taskId:string;pending:boolean;submitted?:GenerationInput;preflightHash?:string;ruleEditor?:unknown;blockedReason?:string};
const drafts=new Map<string,GenerationDraft>();
export const generationScope=(library:string,project:string)=>library+':'+project;
const storageKey=(scope:string)=>'shiguang.storyboard.generation.request.v1.'+scope;
export const notifyGeneration=(library:string,project:string)=>{window.dispatchEvent(new CustomEvent('shiguang-storyboard-generation-changed',{detail:{library,project}}));window.dispatchEvent(new Event('shiguang-codex-tasks-changed'));};
export function getGenerationDraft(scope:string):GenerationDraft{
 let entry=drafts.get(scope);if(entry)return entry;
 let blockedReason='';if(drafts.size>=20){const removable=[...drafts].find(([,v])=>!v.script&&!v.requirements&&!v.pending&&!v.ruleEditor&&!v.auxiliaryRules.length);if(removable)drafts.delete(removable[0]);else blockedReason='已保留20个项目的生成草稿，请先回到已有项目处理，未丢弃任何输入';}
 entry={format:'2.0.0',script:'',requirements:'',duration_seconds:null,aspect_ratio:'16:9',mainRule:{id:'',version:1},auxiliaryRules:[],model:'',effort:'',taskId:'',pending:false,...(blockedReason?{blockedReason}:{})};
 try{const saved=JSON.parse(localStorage.getItem(storageKey(scope))||'null');if(saved&&typeof saved.taskId==='string'&&/^[a-f0-9-]{36}$/i.test(saved.taskId)){entry.taskId=saved.taskId;entry.pending=saved.pending===true;}}catch{}
 if(!blockedReason)drafts.set(scope,entry);return entry;
}
export function persistGenerationRequest(scope:string,entry:GenerationDraft){const text=JSON.stringify({taskId:entry.taskId,pending:entry.pending});try{localStorage.setItem(storageKey(scope),text);if(localStorage.getItem(storageKey(scope))!==text)throw Error();}catch{throw Error('无法保存本次请求编号，未发送生成；请检查浏览器存储后重试');}}
export function readPendingGeneration(scope:string){try{return getGenerationDraft(scope).pending;}catch{return true;}}
export function useGenerationProjectState(request:PromptRequest,projectId:string,visible:boolean){
 const [libraryId,setLibrary]=useState(''),[state,setState]=useState<GenerationProjectState|null>(null),[error,setError]=useState(''),[known,setKnown]=useState(false),[pendingLocal,setPending]=useState(false);
  useFeedbackToast(error, {source: '分镜设计', active: visible});const refreshCurrent=useRef<()=>void>(()=>{}),latest=useRef(state);latest.current=state;
 useEffect(()=>{let alive=true,reading=false,reread=false;const controller=new AbortController();setKnown(false);let timer:ReturnType<typeof setTimeout>|undefined,library='',fingerprint='';
  const read=async()=>{if(!alive||!visible||document.hidden)return;if(reading){reread=true;return;}reading=true;try{const session=await request<{instanceId:string}>('/session');if(!alive)return;if(library&&library!==session.instanceId)throw Error('素材库已变化，请刷新页面重新核对');library=session.instanceId;setLibrary(library);const local=readPendingGeneration(generationScope(library,projectId));setPending(local);const next=await request<GenerationProjectState>('/storyboard-generation/projects/'+encodeURIComponent(projectId)+'/state',undefined,undefined,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});if(!alive)return;if(next.projectId!==projectId||typeof next.locked!=='boolean')throw Error('分镜生成锁状态不兼容');setPending(readPendingGeneration(generationScope(library,projectId)));latest.current=next;setState(next);setKnown(true);setError('');}catch(e){if(alive){setKnown(false);setError((e as Error).message);}}finally{reading=false;if(alive&&visible){if(reread){reread=false;timer=setTimeout(()=>void read(),0);}else if(latest.current?.locked||readPendingGeneration(generationScope(library,projectId)))timer=setTimeout(()=>void read(),1500);}}};
  const refresh=()=>{clearTimeout(timer);void read();};refreshCurrent.current=refresh;
  const changed=(event:Event)=>{const d=(event as CustomEvent).detail;if(d?.project===projectId&&(!library||d.library===library))refresh();};
  const overview=(event:Event)=>{const tasks=((event as CustomEvent).detail??[]) as {projectId?:string;taskId:string;status:string;terminalRevision?:string}[];const next=tasks.filter(t=>t.projectId===projectId).map(t=>[t.taskId,t.status,t.terminalRevision].join(':')).join('|');if(next!==fingerprint){fingerprint=next;refresh();}};
  const storage=(e:StorageEvent)=>{if(!library||e.key===null||e.key===storageKey(generationScope(library,projectId))){try{const saved=JSON.parse(localStorage.getItem(storageKey(generationScope(library,projectId)))||'null');if(saved?.taskId){const draft=getGenerationDraft(generationScope(library,projectId));draft.taskId=saved.taskId;draft.pending=saved.pending===true;}}catch{}refresh();}};
  refresh();window.addEventListener('shiguang-storyboard-generation-changed',changed);window.addEventListener('shiguang-storyboard-task-overview',overview);window.addEventListener('storage',storage);window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  return()=>{alive=false;refreshCurrent.current=()=>{};controller.abort();clearTimeout(timer);window.removeEventListener('shiguang-storyboard-generation-changed',changed);window.removeEventListener('shiguang-storyboard-task-overview',overview);window.removeEventListener('storage',storage);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);};
 },[request,projectId,visible]);
 return{libraryId,state,error,known,pendingLocal,blocked:!known||!!state?.locked||pendingLocal,refresh:()=>refreshCurrent.current()};
}
