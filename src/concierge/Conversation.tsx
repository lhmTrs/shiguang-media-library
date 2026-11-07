import {useCallback,useLayoutEffect,useRef} from 'react';
import {Bot,ChevronUp,FileText,LoaderCircle,MessageSquare} from 'lucide-react';
import {ResponseText} from './ResponseText';
import {taskLabel,type Item,type ScopeState,type Turn} from './types';

const date=(v?:number|string)=>v?new Date(v).toLocaleString('zh-CN'):'';
function Message({item,animate,onProgress}:{item:Item;animate:boolean;onProgress:()=>void}){
  if(item.type==='tool'||item.type==='info')return <details className="concierge-tool"><summary>{item.type==='tool'?'工具执行记录':'运行说明'} · {item.text.slice(0,90)}</summary><pre>{item.text}</pre></details>;
  return <article className={'concierge-message concierge-'+item.type}><header>{item.type==='user'?<MessageSquare size={14}/>:<Bot size={15}/>}<strong>{item.type==='user'?'你':'Codex'}</strong></header>{item.type==='assistant'?<ResponseText text={item.text} animate={animate} onProgress={onProgress}/>:<div className="concierge-message-text">{item.text||'（无文字内容）'}</div>}{!!item.attachmentIds?.length&&<small><FileText size={12}/>附件 {item.attachmentIds.length} 个 · {item.attachmentIds.join('、')}</small>}</article>;
}
export function Conversation({scope,state:s,older,saveScroll}:{scope:string;state:ScopeState;older:()=>Promise<void>;saveScroll:(top:number)=>void}){
  const ref=useRef<HTMLDivElement>(null),previous=useRef(''),nearBottom=useRef(true),waitingForLoad=useRef(false),paging=useRef<{height:number;top:number}|null>(null);
  const animated=useRef({scope,ids:new Set<string>()});if(animated.current.scope!==scope)animated.current={scope,ids:new Set()};
  const follow=useCallback(()=>{const el=ref.current;if(el&&nearBottom.current&&window.getSelection()?.isCollapsed!==false)el.scrollTop=el.scrollHeight;},[]);
  const turns:Turn[]=[...s.turns];
  if(s.task){const index=turns.findIndex(t=>t.id===(s.task!.turnId||s.task!.id)||t.id===s.task!.id);if(index<0)turns.push(s.task);else if(s.task.items.length)turns[index]={...s.task,id:turns[index].id};}
  if(s.pending&&s.pending.id!==s.task?.id)turns.push({id:s.pending.id,status:s.operation==='sending'?'sending':'awaiting_confirmation',createdAt:s.pending.createdAt,items:[{id:s.pending.id+'-user',type:'user',text:s.pending.text,attachmentIds:s.pending.attachmentIds}]});
  for(const turn of turns)if(['sending','starting','running','stop_requested'].includes(turn.status))animated.current.ids.add(s.task?.turnId===turn.id?s.task.id:turn.id);
  const signature=turns.map(t=>t.id+':'+t.status+':'+t.items.map(i=>i.text.length).join(',')).join('|');
  useLayoutEffect(()=>{
    const el=ref.current;if(!el)return;
    if(previous.current!==scope){previous.current=scope;waitingForLoad.current=!s.loaded||s.loading;el.scrollTop=s.scrollTop??el.scrollHeight;nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}
    else if(waitingForLoad.current&&!s.loading&&s.info){waitingForLoad.current=false;el.scrollTop=s.scrollTop??el.scrollHeight;nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}
    else if(paging.current&&!s.historyLoading){el.scrollTop=paging.current.top+el.scrollHeight-paging.current.height;paging.current=null;}
    else if(nearBottom.current&&!s.historyLoading)el.scrollTop=el.scrollHeight;
  },[scope,signature,s.historyLoading,s.loading]);
  const more=()=>{if(ref.current)paging.current={height:ref.current.scrollHeight,top:ref.current.scrollTop};void older();};
  return <div ref={ref} className="concierge-conversation" role="log" aria-label="管家对话记录" aria-live="off" onScroll={e=>{const el=e.currentTarget;nearBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;saveScroll(el.scrollTop);}}>
    {s.nextCursor&&<button className="concierge-history-more" disabled={s.historyLoading} onClick={more}><ChevronUp size={14}/>{s.historyLoading?'正在读取…':'读取更早10轮'}</button>}
    {!turns.length&&<div className="concierge-empty"><Bot size={29}/><h3>{s.loading?'正在读取原上下文…':'从这里开始讨论'}</h3><p>梳理项目、阅读附件、查阅剧本与分镜。每个项目持续使用自己的对话，global 单独保留。</p><p>对话保留在本机 Codex，可继续阅读更早记录。</p></div>}
    {turns.map(turn=>{
      const key=s.task?.turnId===turn.id?s.task.id:turn.id;
      const active=['sending','starting','running','stop_requested'].includes(turn.status),uncertain=turn.status==='awaiting_confirmation';
      const answered=turn.items.some(i=>i.type==='assistant'&&i.text.trim());
      const waiting=(active||uncertain)&&!answered;
      const label=turn.status==='sending'?'正在发送…':turn.status==='stop_requested'?'正在中止本轮…':uncertain?'发送结果待核对，未自动重发。':'已发送，正在思考…';
      return <section key={key} className="concierge-turn" data-turn-id={turn.id}><div className="concierge-turn-meta"><time>{date(turn.createdAt)}</time><span>{taskLabel(turn.status)}</span></div>
        {turn.items.map((item,i)=><Message key={item.id||i} item={item} animate={animated.current.ids.has(key)} onProgress={follow}/>)}
        {waiting&&<article className="concierge-message concierge-thinking" role="status" aria-live="polite"><header><Bot size={15}/><strong>Codex</strong></header><p>{!uncertain&&<LoaderCircle size={15} className="concierge-spin" aria-hidden="true"/>}<span>{label}</span></p></article>}
        {!turn.items.length&&!waiting&&<p className="concierge-wait">{turn.status==='failed'&&'turnId'in turn&&!turn.turnId?'本轮未取得生成编号。请核对原上下文；不会自动重发。':'原轮次内容请重新读取 Codex 历史。'}</p>}
      </section>;
    })}
  </div>;
}
