import {useEffect,useRef,useState} from 'react';
import {useFeedbackToast} from '../global-feedback';
import {BookOpen,Bot,Expand,FileText,Globe,LoaderCircle,MessageSquare,Minimize2,Paperclip,RefreshCw,Send,Settings2,Square,X} from 'lucide-react';
import type {PromptRequest} from '../PromptTemplateWorkspace';
import type {Project} from '../ProjectManager';
import type {CodexTask} from '../codex-task-types';
import {CodexTaskDrawer,type CodexTaskController} from '../CodexTaskDrawer';
import {Conversation} from './Conversation';
import {ReferencePanel} from './ReferencePanel';
import {ConciergeTasks} from './ConciergeTasks';
import {running,taskLabel} from './types';
import {useConcierge} from './useConcierge';
import './concierge.css';

export type ConciergeWorkspaceProps={request:PromptRequest;activeProject:string;projects:Project[];controller:CodexTaskController;onNavigate:(task:CodexTask)=>Promise<void>};
export function ConciergeWorkspace({request,activeProject,projects,controller:c,onNavigate}:ConciergeWorkspaceProps){
  // A project change always selects the new current project, even when global was open.
  const [selection,setSelection]=useState({project:activeProject,scope:activeProject||'global'});
  const scope=selection.project===activeProject?selection.scope:activeProject||'global';
  const [tab,setTab]=useState<'chat'|'tasks'>('chat'),[expanded,setExpanded]=useState(false),[reference,setReference]=useState<'rules'|'docs'|null>(null),[dragging,setDragging]=useState(false);
  const client=useConcierge(request,scope,c.open,c.open&&tab==='chat'),s=client.current,closeButton=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null),dragDepth=useRef(0),previousFocus=useRef<HTMLElement|null>(null),root=useRef<HTMLElement>(null);
  useFeedbackToast(s.error,{source:'自由管家',active:c.open});
  useFeedbackToast(s.task?.error,{source:'管家当前任务',active:c.open});
  useFeedbackToast(s.storageError,{source:'管家草稿',active:c.open});
  useFeedbackToast(client.status?.error,{source:'Codex 连接',active:c.open});
  useFeedbackToast(s.attachments.filter(a=>a.error).map(a=>a.name+'：'+a.error).join('；'),{source:'管家附件',active:c.open});
  const active=running(s.task),unknown=!!s.pending||s.task?.status==='unknown',issue=client.sendIssue();
  const model=client.status?.models.find(m=>m.id===s.model),models=client.status?.models||[];
  const title=scope==='global'?'全局管家':projects.find(p=>p.id===scope)?.name||s.info?.title||'当前项目';
  useEffect(()=>{if(selection.project!==activeProject)setSelection({project:activeProject,scope:activeProject||'global'});},[activeProject]);
  useEffect(()=>{setReference(null);setDragging(false);dragDepth.current=0;},[scope]);
  useEffect(()=>{
    if(!c.open)return;previousFocus.current=document.activeElement as HTMLElement|null;closeButton.current?.focus({preventScroll:true});
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!e.defaultPrevented&&!document.querySelector('dialog[open]')&&!reference){e.preventDefault();c.setOpen(false);}};
    document.addEventListener('keydown',key);return()=>{document.removeEventListener('keydown',key);previousFocus.current?.isConnected&&previousFocus.current.focus({preventScroll:true});};
  },[c.open,reference]);
  const add=(files:FileList|null)=>{if(files?.length)void client.addFiles([...files]);};
  const dropEvents={onDragEnter:(e:React.DragEvent)=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth.current++;setDragging(true);}},onDragOver:(e:React.DragEvent)=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';}},onDragLeave:(e:React.DragEvent)=>{e.preventDefault();if(--dragDepth.current<=0){dragDepth.current=0;setDragging(false);}},onDrop:(e:React.DragEvent)=>{e.preventDefault();setDragging(false);dragDepth.current=0;add(e.dataTransfer.files);}};
  const connection=client.status?.connecting?'后台正在连接…':client.connecting?'正在连接…':!client.status?'尚未读取连接':!client.status.connected?'未连接':!client.status.authenticated?'需要本机登录':!models.length?'没有可用模型':'已连接';
  return <aside ref={root} hidden={!c.open} id="codex-global-task-drawer" className={'concierge-workspace'+(expanded?' concierge-expanded':'')} aria-label="Codex 自由管家">
    <header className="concierge-heading"><div><span><Bot size={17}/>本地 Codex</span><h2>自由管家</h2></div><div><button aria-label={expanded?'收起阅读区域':'展开阅读'} title={expanded?'收起阅读区域':'展开阅读'} aria-pressed={expanded} onClick={()=>setExpanded(v=>!v)}>{expanded?<Minimize2 size={16}/>:<Expand size={16}/>}</button><button ref={closeButton} aria-label="关闭自由管家" onClick={()=>c.setOpen(false)}><X size={18}/></button></div></header>
    <nav className="concierge-tabs" role="tablist" aria-label="自由管家栏目"><button id="concierge-chat-tab" role="tab" aria-selected={tab==='chat'} aria-controls="concierge-chat-panel" onClick={()=>setTab('chat')}><MessageSquare size={14}/>对话</button><button id="concierge-tasks-tab" role="tab" aria-selected={tab==='tasks'} aria-controls="concierge-tasks-panel" onClick={()=>setTab('tasks')}><FileText size={14}/>任务{c.overview?.activeCount?` · ${c.overview.activeCount}`:''}{c.unread?` · 待查看 ${c.unread}`:''}</button></nav>
    <section id="concierge-chat-panel" role="tabpanel" aria-labelledby="concierge-chat-tab" hidden={tab!=='chat'} className="concierge-chat-panel" {...dropEvents}>
      <div className="concierge-context"><label><span>{scope==='global'?<Globe size={14}/>:<Bot size={14}/>}对话上下文</span><select aria-label="管家上下文" value={scope} onChange={e=>setSelection({project:activeProject,scope:e.target.value})}><option value="global">global · 全局管家</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}{p.id===activeProject?' · 当前项目':''}</option>)}{scope!=='global'&&!projects.some(p=>p.id===scope)&&<option value={scope}>{title}</option>}</select></label><div><button aria-label="查看编辑管家规则" title="查看编辑规则" onClick={()=>setReference(reference==='rules'?null:'rules')}><Settings2 size={15}/></button><button aria-label="查看能力文档" title="按需能力文档" onClick={()=>setReference(reference==='docs'?null:'docs')}><BookOpen size={15}/></button><button aria-label="重新读取对话" title="只读取，不重新发送" disabled={s.loading||!!s.operation} onClick={()=>{void client.refreshStatus();void client.load();}}><RefreshCw size={15}/></button></div></div>
      <div className="concierge-connection"><span role="status">{connection}{active?' · '+taskLabel(s.task!.status):''}</span><button disabled={client.connecting||!!client.identityError||active||unknown||!!client.status?.activeCount||!!client.status?.unsettled} onClick={()=>void client.connect()}>{client.status?.connecting?'后台正在连接…':client.connecting?'正在连接…':'重新连接'}</button></div>
      {client.statusError&&<p className="concierge-alert" role="alert">连接读取失败：{client.statusError}</p>}
      {client.status?.connectionError&&<p className="concierge-alert" role="alert">{client.status.connectionErrorCode&&client.status.connectionErrorCode+' · '}{client.status.connectionError}</p>}
      {client.status?.error&&<p className="concierge-alert" role="alert">{client.status.error}</p>}
      {client.identityError&&<p className="concierge-alert" role="alert">{client.identityError}</p>}
      <div className="concierge-thread-line"><strong>{title}</strong><small>{s.info?.threadId?'持续对话':s.info?.phase==='unavailable'?'上下文不可用':'首次发送准备上下文'}</small></div>
      <div className="concierge-reading-area">
        <Conversation scope={scope} state={s} older={client.older} saveScroll={client.persistScroll}/>
        {reference&&<ReferencePanel key={scope+reference} scope={scope} kind={reference} client={client} close={()=>setReference(null)}/>}
      </div>
      <form hidden={!!reference} className={'concierge-composer'+(dragging?' concierge-dragging':'')} aria-label="发送管家需求" onSubmit={e=>{e.preventDefault();void(active?client.stop():client.send());}}>
        {dragging&&<div className="concierge-drop-hint">放开以添加到「{title}」</div>}
        <div className="concierge-model-row"><label>模型<select aria-label="管家模型" value={s.model} disabled={!models.length||s.operation==='sending'} onChange={e=>{const m=models.find(m=>m.id===e.target.value);client.update({model:e.target.value,effort:m?.defaultEffort||''});}}><option value="">{models.length?'选择模型':'先连接 Codex 加载模型'}</option>{s.model&&!model&&<option value={s.model}>{s.model}（当前不可用）</option>}{models.map(m=><option key={m.id} value={m.id}>{m.name||m.id}</option>)}</select></label><label>推理强度<select aria-label="管家推理强度" value={s.effort} disabled={!model||s.operation==='sending'} onChange={e=>client.update({effort:e.target.value})}><option value="">模型默认</option>{s.effort&&!model?.efforts.some(e=>e.id===s.effort)&&<option value={s.effort}>{s.effort}（不可用）</option>}{model?.efforts.map(e=><option key={e.id} value={e.id}>{e.id}{e.description?' · '+e.description:''}</option>)}</select></label></div>
        <label className="concierge-write-option"><input type="checkbox" checked={s.allowWrites} disabled={s.operation==='sending'||!!client.identityError} onChange={e=>client.update({allowWrites:e.target.checked})}/>可修改项目资料</label><p className="concierge-mode-hint">{s.allowWrites?'本轮允许按需求保存当前范围内的剧本、分镜和资产资料。':'分析建议模式：阅读和讨论资料。勾选后才允许保存修改。'}</p>
        {!!s.attachments.length&&<ul className="concierge-attachments" aria-label="本轮附件">{s.attachments.map(a=><li key={a.id}><FileText size={15}/><div><strong>{a.name}</strong><small>{(a.size/1024/1024).toFixed(1)} MiB · {a.localBusy?'正在上传…':({ready:'已就绪',pending:'等待上传',uploading:'正在解析',failed:'未就绪'}[a.status])}</small>{a.description&&<small>{a.description}</small>}{a.kind==='video'&&<small>视频最多读取12帧，音轨未分析。</small>}{a.error&&<small className="concierge-attachment-error">{a.error}</small>}{a.analysis&&<details><summary>查看解析信息</summary><pre>{JSON.stringify(a.analysis,null,2)}</pre></details>}</div>{a.localBusy?<LoaderCircle size={14}/>:<div className="concierge-attachment-actions">{a.status!=='ready'&&<button type="button" title="查询原附件状态，不重传" aria-label={'查询附件 '+a.name} disabled={!!s.operation} onClick={()=>void client.checkAttachment(a)}><RefreshCw size={13}/></button>}<button type="button" aria-label={'移除附件 '+a.name} disabled={!!s.operation||unknown} onClick={()=>void client.removeAttachment(a)}><X size={14}/></button></div>}</li>)}</ul>}
        <textarea aria-label="管家需求" value={s.text} disabled={s.operation==='sending'||!!client.identityError} onChange={e=>client.update({text:e.target.value})} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'&&!e.nativeEvent.isComposing){e.preventDefault();if(!active&&!issue)void client.send();}}} placeholder={'与「'+title+'」讨论，或拖入图片、文档、视频…'} rows={3}/>
        {s.error&&<p className="concierge-alert" role="alert">{s.error}</p>}{s.task?.error&&<p className="concierge-alert" role="alert">本轮：{s.task.error}</p>}{s.storageError&&<p className="concierge-alert" role="alert">{s.storageError}</p>}{s.notice&&<p className="concierge-notice" role="status">{s.notice}</p>}
        {(unknown||s.task?.status==='failed'&&!s.task.turnId||s.info?.phase==='unavailable'||s.info?.phase==='creating')&&<div className="concierge-recovery"><small>原编号：{s.pending?.id||s.task?.id||s.info?.threadId||'正在准备的原上下文'}</small><button type="button" disabled={!!s.operation||!!client.identityError} onClick={()=>void client.recover()}><RefreshCw size={14}/>{s.operation==='checking'?'正在核对…':'核对原上下文 / 本轮'}</button></div>}
        <footer><div><input ref={input} type="file" multiple hidden onChange={e=>{add(e.currentTarget.files);e.currentTarget.value='';}}/><button type="button" disabled={s.attachments.length>=10||s.operation==='sending'||unknown||!!client.identityError} onClick={()=>input.current?.click()}><Paperclip size={15}/>附件</button><small>{s.attachments.length}/10 · 可从任意来源拖入</small></div><button type="submit" className={active?'concierge-stop':'concierge-primary'} disabled={active?!!s.operation||s.task?.status==='stop_requested'||!!client.identityError:!!issue} title={active?'仅中止当前轮次':issue||'发送（⌘/Ctrl + Enter）'}>{active?<Square size={14}/>:s.operation==='sending'?<LoaderCircle size={14}/>:<Send size={14}/>}<span>{active?s.task?.status==='stop_requested'||s.operation==='stopping'?'正在中止…':'中止本轮':s.operation==='sending'?'正在发送…':'发送'}</span></button></footer>
        {issue&&!active&&<small className="concierge-send-hint">{issue}</small>}
      </form>
    </section>
    <section id="concierge-tasks-panel" role="tabpanel" aria-labelledby="concierge-tasks-tab" hidden={tab!=='tasks'} className="concierge-tasks-panel">{client.identityError?<p role="alert" className="concierge-alert">{client.identityError}</p>:<ConciergeTasks enabled={c.open&&tab==='tasks'} client={client} open={id=>{setSelection({project:activeProject,scope:id});setTab('chat');}}/>}<div className="concierge-legacy-heading">模板与分镜任务</div><CodexTaskDrawer controller={c} request={request} onNavigate={onNavigate} embedded/></section>
  </aside>;
}
