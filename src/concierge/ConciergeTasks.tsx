import {useEffect,useRef,useState} from 'react';
import {RefreshCw,Square} from 'lucide-react';
import {errorText,running,taskLabel,type Task} from './types';

type Client={read:<T>(path:string,signal?:AbortSignal)=>Promise<T>;write:<T>(path:string,body:unknown,method?:string)=>Promise<T>};
export function ConciergeTasks({enabled,client,open}:{enabled:boolean;client:Client;open:(scope:string)=>void}){
  const [tasks,setTasks]=useState<Task[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(''),[reading,setReading]=useState(false);
  const current=useRef(client),alive=useRef(true),pending=useRef(false),operation=useRef(false),generation=useRef(0);current.current=client;
  async function load(signal?:AbortSignal){
    if(pending.current)return;pending.current=true;setReading(true);const version=generation.current;
    try{const v=await current.current.read<{tasks:Task[]}>('/tasks?scope=all',signal);if(alive.current&&version===generation.current){setTasks(v.tasks);setError('');}}
    catch(e){if(alive.current&&version===generation.current&&(e as Error).name!=='AbortError')setError(errorText(e));}
    finally{pending.current=false;if(alive.current)setReading(false);}
  }
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  useEffect(()=>{
    if(!enabled)return;const controller=new AbortController();let timer:ReturnType<typeof setTimeout>,stopped=false;
    const tick=async()=>{if(document.visibilityState!=='hidden')await load(controller.signal);if(!stopped)timer=setTimeout(tick,3000);};
    void tick();return()=>{stopped=true;controller.abort();clearTimeout(timer);generation.current++;};
  },[enabled]);
  async function stop(task:Task){
    if(operation.current)return;operation.current=true;setBusy(task.id);setError('');const version=generation.current;
    try{
      const v=await current.current.write<{task:Task}>('/tasks/'+encodeURIComponent(task.id)+'/stop',{scope:task.scope});
      if(v.task.id!==task.id||v.task.scope!==task.scope)throw Error('返回的中止任务身份不符');
      if(alive.current&&version===generation.current)setTasks(t=>t.map(a=>a.id===task.id?v.task:a));
    }catch(e){if(alive.current&&version===generation.current)setError('中止尚未确认：'+errorText(e)+'。请查询原任务，不会重发。');}
    finally{operation.current=false;if(alive.current)setBusy('');}
  }
  return <section className="concierge-recent-tasks" aria-label="管家最近任务"><header><strong>自由管家 · 最近任务</strong><button aria-label="重新读取管家任务" disabled={reading} onClick={()=>void load()}><RefreshCw size={13}/></button></header>{error&&<p role="alert" className="concierge-alert">{error}</p>}<div>{!tasks.length&&<p>{reading?'正在读取…':'暂无管家任务'}</p>}{tasks.map(t=><article key={t.id}><button className="concierge-task-open" onClick={()=>open(t.scope)}><strong>{t.title}</strong><span>{taskLabel(t.status)}</span><small>{t.model} · {t.effort||'模型默认'} · {new Date(t.updatedAt).toLocaleString('zh-CN')}</small>{t.error&&<small>{t.error}</small>}</button>{running(t)&&<button disabled={!!busy||t.status==='stop_requested'} aria-label={'中止管家任务 '+t.id} onClick={()=>void stop(t)}><Square size={12}/>{busy===t.id||t.status==='stop_requested'?'正在中止':'中止本轮'}</button>}</article>)}</div><small>显示最近50条。完整对话在各上下文中从 Codex 分页读取。</small></section>;
}
