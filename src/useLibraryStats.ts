import {useCallback,useEffect,useRef,useState} from 'react';
import type {PromptRequest} from './PromptTemplateWorkspace';
type Shape={total:number;favorites:number;review:number;offline:number;missing:number;kinds:{kind:string;n:number}[];categories:unknown[];formats:string[]};
function checked<T extends Shape>(value:T):T{
 const count=(n:unknown)=>{const number=typeof n==='string'&&/^\d+$/.test(n)?Number(n):n;if(!Number.isSafeInteger(number)||Number(number)<0)throw Error('侧栏数量格式无效，已保留上次确认值');return number as number;};
 if(!value||!Array.isArray(value.kinds)||value.kinds.length>32||!Array.isArray(value.categories)||!Array.isArray(value.formats)||value.formats.some(f=>typeof f!=='string'))throw Error('侧栏数量格式无效');
 const kinds=value.kinds.map(k=>{if(!k||typeof k.kind!=='string')throw Error('侧栏分类数量无效');return{kind:k.kind,n:count(k.n)};});if(new Set(kinds.map(k=>k.kind)).size!==kinds.length)throw Error('侧栏分类数量重复');
 return{...value,total:count(value.total),favorites:count(value.favorites),review:count(value.review),offline:count(value.offline),missing:count(value.missing),kinds};
}
export function useLibraryStats<T extends Shape>({ready,request,readIdentity,refreshSeconds,blocked}:{ready:boolean;request:PromptRequest;readIdentity:()=>Promise<string>;refreshSeconds:number;blocked:()=>boolean}){
 const [stats,setStats]=useState<T|null>(null),[error,setError]=useState(''),[reading,setReading]=useState(false),[identityChanged,setIdentityChanged]=useState(false);
 const alive=useRef(true),revision=useRef(0),pending=useRef<{promise:Promise<void>;controller:AbortController}|null>(null),queued=useRef(false),current=useRef(stats),identityFault=useRef(false),blockedRef=useRef(blocked),refreshRef=useRef<(changed?:boolean)=>Promise<void>>(async()=>{});current.current=stats;blockedRef.current=blocked;
 const invalidate=useCallback(()=>{revision.current++;pending.current?.controller.abort();pending.current=null;queued.current=false;current.current=null;setStats(null);setError('');setReading(false);identityFault.current=false;setIdentityChanged(false);},[]);
 const refresh=useCallback((changed=false):Promise<void>=>{
  if(!ready||!alive.current)return Promise.resolve();
  if(pending.current){if(changed)queued.current=true;return pending.current.promise;}
  const ticket=++revision.current,controller=new AbortController();setReading(true);
  const promise=(async()=>{
   try{
    const identity=await readIdentity();if(ticket!==revision.current||!alive.current)return;
    let value:T|undefined,readError:unknown;
    try{value=checked(await request<T>('/stats',undefined,undefined,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])}));}catch(e){readError=e;}
    if(ticket!==revision.current||!alive.current)return;
    const after=await readIdentity();if(identity!==after)throw Object.assign(Error('素材库身份已变化，请刷新页面核对'),{code:'LOCAL_INSTANCE_CHANGED'});
    if(readError)throw readError;
    if(ticket===revision.current&&alive.current){setStats(value!);setError('');identityFault.current=false;setIdentityChanged(false);}
   }catch(e:any){if(ticket!==revision.current||!alive.current)return;
    if(e.code==='LOCAL_INSTANCE_CHANGED'){identityFault.current=true;setStats(null);setIdentityChanged(true);}setError(e.message||'侧栏数量读取失败，请重试');
   }finally{if(ticket===revision.current&&alive.current){pending.current=null;setReading(false);if(queued.current){queued.current=false;void refreshRef.current();}}}
  })();pending.current={promise,controller};return promise;
 },[ready,request,readIdentity]);refreshRef.current=refresh;
 useEffect(()=>{alive.current=true;const changed=()=>{invalidate();identityFault.current=true;setIdentityChanged(true);setError('素材库身份已变化，请刷新页面核对，旧数量已清除');};window.addEventListener('shiguang-library-identity-changed',changed);return()=>{alive.current=false;revision.current++;pending.current?.controller.abort();pending.current=null;queued.current=false;window.removeEventListener('shiguang-library-identity-changed',changed);};},[invalidate]);
 useEffect(()=>{
  if(!ready)return;if(document.visibilityState==='visible')void refresh();
  const automatic=()=>{if(document.visibilityState==='visible'&&!identityFault.current&&!blockedRef.current())void refresh();};
  const visible=()=>{if(document.visibilityState==='visible'&&(current.current===null||refreshSeconds>0))automatic();};
  document.addEventListener('visibilitychange',visible);const timer=refreshSeconds>0?setInterval(automatic,Math.max(3000,refreshSeconds*1000)):undefined;
  return()=>{if(timer)clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[ready,refreshSeconds,refresh]);
 return{stats,error,reading,identityChanged,refresh,invalidate};
}
