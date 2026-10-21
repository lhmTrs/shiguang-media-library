import { useEffect, useRef, useState } from "react";
import { Check, FileUp, LoaderCircle, Search, Undo2, X } from "lucide-react";
import type { Asset } from "./main";
import type { ProjectRequest } from "./ProjectManager";
import { PaginationControls } from "./PaginationControls";
import { elapsed as clock } from "./TimelineUsage";

type Candidate = Pick<Asset,"id"|"name"|"path"|"kind">;
type Occurrence = {track:number;start:number|null;end:number|null;sourceIn:number|null;sourceOut:number|null;disabled:boolean};
type Row = {key:string;name:string;sourcePath:string|null;assetId:string|null;match:string;eligible:boolean;candidates:Candidate[];occurrences:Occurrence[]};
type Preview = {token:string;name:string;timelineId:string|null;rows:Row[];warnings:string[];diff:{added:number;removed:number};fps:number};
type State = {timelines:{id:string;name:string;head_id:string;references:number;used:number}[];batches:{id:string;timeline_id:string;status:string;created_at:number}[]};
type Choice = {key:string;assetId:string|null;used:boolean};

function MatchRow({ row, choice, change, request, locked }: {row:Row;choice:Choice;change:(value:Choice)=>void;request:ProjectRequest;locked:boolean}) {
  const [query,setQuery] = useState(row.name), [candidates,setCandidates] = useState(row.candidates);
  const [busy,setBusy] = useState(false), [error,setError] = useState("");
  async function search() {
    setBusy(true);setError("");
    try {
      const result=await request<{items:Asset[]}>("/assets?"+new URLSearchParams({q:query,qField:"name",sort:"name",pageSize:"20"}));
      const items=result.items.filter(a=>["music","sfx"].includes(a.kind)&&!["mp4","mov","m4v","mkv","avi","mts","m2ts","webm","ncm"].includes(a.ext));
      setCandidates(previous=>[...new Map([...previous.filter(a=>a.id===choice.assetId),...items].map(a=>[a.id,a])).values()]);
      if(!items.length)setError("没有匹配的可用音频，可修改关键词");
    } catch(e) {setError(e instanceof Error?e.message:"搜索失败");} finally {setBusy(false);}
  }
  return <article className="timeline-match-row">
    <div className="timeline-reference"><strong>{row.name}</strong><small>{row.sourcePath || "无可用本地路径"}</small><span>{row.occurrences.length} 次引用 · {row.match==="path"?"路径准确匹配":choice.assetId?"人工匹配":"待匹配"}{!row.eligible?" · 全部禁用／静音":""}</span>
      <details><summary>使用位置</summary>{row.occurrences.map((o,i)=><div className="timeline-position" key={i}>A{o.track} · 时间线 {clock(o.start)}—{clock(o.end)} · 源 {clock(o.sourceIn)}—{clock(o.sourceOut)}{o.disabled?" · 禁用／静音":""}</div>)}</details>
    </div>
    <div className="timeline-matching">
      <select aria-label={`匹配素材：${row.name}`} disabled={locked} value={choice.assetId||""} onChange={e=>change({...choice,assetId:e.target.value||null,used:!!e.target.value&&row.eligible})}>
        <option value="">未匹配，保留为待确认引用</option>{candidates.map(a=><option value={a.id} key={a.id}>{a.name} — {a.path}</option>)}
      </select>
      <details><summary>手动查找素材</summary><div className="timeline-match-search"><input aria-label={`查找素材：${row.name}`} value={query} maxLength={2000} onChange={e=>setQuery(e.target.value)} disabled={locked}/><button className="icon-button" aria-label={`搜索匹配：${row.name}`} disabled={locked||busy||!query.trim()} onClick={()=>void search()}>{busy?<LoaderCircle size={15} className="spin"/>:<Search size={15}/>}</button></div></details>
      {error&&<small role="status">{error}</small>}
      <label className="check-label"><input type="checkbox" disabled={locked||!choice.assetId||!row.eligible} checked={choice.used} onChange={e=>change({...choice,used:e.target.checked})}/>确认为已使用</label>
    </div>
  </article>;
}

export function TimelineImportDialog({ projectId = "", request, close, changed }: {projectId?:string;request:ProjectRequest;close:()=>void;changed:(projectId?:string,used?:number)=>void}) {
  const creating = !projectId;
  const endpoint = creating ? "/projects/timeline-import" : `/projects/${projectId}/timeline-import`;
  const [projectName,setProjectName] = useState("");
  const [state,setState]=useState<State>({timelines:[],batches:[]});
  const [target,setTarget]=useState(""),[name,setName]=useState(""),[filename,setFilename]=useState("");
  const [xml,setXml]=useState(""),[preview,setPreview]=useState<Preview|null>(null),[choices,setChoices]=useState<Record<string,Choice>>({});
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [confirmed,setConfirmed]=useState(false),[removeMissing,setRemoveMissing]=useState(false),[page,setPage]=useState(1);
  const root=useRef<HTMLDivElement>(null), fileGeneration=useRef(0), alive=useRef(true);
  const load=()=>creating ? Promise.resolve() : request<State>(`/projects/${projectId}/timelines`).then(value=>{if(alive.current)setState(value);});
  useEffect(()=>{alive.current=true;void load().catch(e=>setError(e.message));const previous=document.activeElement as HTMLElement;root.current?.querySelector<HTMLButtonElement>("button")?.focus();return()=>{alive.current=false;fileGeneration.current++;previous?.focus();};},[projectId,request]);
  function resetPreview(){setPreview(null);setChoices({});setConfirmed(false);setRemoveMissing(false);setMessage("");setPage(1);}
  async function chooseFile(file:File|undefined){
    const generation=++fileGeneration.current;resetPreview();setXml("");setFilename("");setError("");
    if(!file)return;
    if(!file.name.toLowerCase().endsWith(".xml")||file.size>4*1024*1024){setError("请选择不超过 4MB 的 FCP 7 XML 文件");return;}
    setBusy(true);
    try{const value=await file.text();if(alive.current&&generation===fileGeneration.current){setXml(value);setFilename(file.name);if(creating)await analyse(value,true);}}catch{if(alive.current)setError("文件读取失败");}finally{if(alive.current&&generation===fileGeneration.current)setBusy(false);}
  }
  async function analyse(valueXml = xml, autofill = false){
    setBusy(true);setError("");resetPreview();
    try{const value=await request<Preview>(`${endpoint}/preview`,{xml:valueXml,timelineId:target||null,name:name.trim()||undefined});if(!alive.current)return;if(creating&&(autofill||!projectName.trim()))setProjectName(value.name);setPreview(value);setChoices(Object.fromEntries(value.rows.map(row=>[row.key,{key:row.key,assetId:row.assetId,used:!!row.assetId&&row.eligible}])));}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:"解析失败");}finally{if(alive.current)setBusy(false);}
  }
  async function apply(){
    if(!preview)return;setBusy(true);setError("");
    try{const result=await request<{alreadyImported:boolean;timelineId:string;projectId:string;used?:number}>(`${endpoint}/confirm`,{token:preview.token,selections:Object.values(choices),confirmUsed:confirmed,removeMissing,projectName:creating?projectName.trim():undefined});if(!alive.current)return;resetPreview();if(creating){changed(result.projectId,result.used);close();return;}setTarget(result.timelineId);setMessage(result.alreadyImported?"与当前时间线记录一致，未重复导入":"导入完成，项目使用统计已更新");changed();await load();}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:"导入失败");}finally{if(alive.current)setBusy(false);}
  }
  async function undo(id:string){
    if(!window.confirm("撤销这次时间线导入？保留之后的手动修改和其他时间线记录，不改原文件。"))return;
    setBusy(true);setError("");
    try{await request(`/projects/${projectId}/timeline-import/${id}/undo`,{});if(!alive.current)return;resetPreview();setTarget("");setMessage("已撤销时间线导入");changed();await load();}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:"撤销失败");}finally{if(alive.current)setBusy(false);}
  }
  const selected=Object.values(choices), used=selected.filter(choice=>choice.assetId&&choice.used).length, matched=selected.filter(choice=>choice.assetId).length;
  return <div className="modal-backdrop"><div className="modal timeline-import-dialog" ref={root} role="dialog" aria-modal="true" aria-label={creating?"从达芬奇 XML 创建项目":"导入达芬奇时间线"} onKeyDown={e=>{
    if(e.key==="Escape"&&!busy){e.stopPropagation();close();}
    if(e.key==="Tab"){const nodes=Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')||[]).filter(node=>node.getClientRects().length>0),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  }}>
    <div className="modal-head"><h2>{creating?"从达芬奇 XML 创建项目":"导入达芬奇时间线"}</h2><button className="icon-button" aria-label="关闭时间线导入" title="关闭" disabled={busy} onClick={close}><X size={18}/></button></div>
    <div className="modal-body timeline-import-body">
      <div className="timeline-import-fields">{creating?<><label className="field">项目名称<input aria-label="XML 项目名称" maxLength={120} placeholder="选择 XML 后自动填入" disabled={busy} value={projectName} onChange={e=>setProjectName(e.target.value)}/></label><label className="field">剪辑软件<input aria-label="XML 项目剪辑软件" value="达芬奇" readOnly/></label></>:<><label className="field">更新对象<select aria-label="时间线更新对象" disabled={busy} value={target} onChange={e=>{setTarget(e.target.value);setName("");resetPreview();}}><option value="">新增时间线</option>{state.timelines.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <label className="field">时间线名称<input aria-label="导入时间线名称" maxLength={120} placeholder="使用 XML 中的名称" disabled={busy} value={name} onChange={e=>{setName(e.target.value);resetPreview();}}/></label></>}</div>
      <div className="timeline-file-picker"><label className="plain"><FileUp size={16}/>{filename||"选择 FCP 7 XML"}<input aria-label="选择达芬奇 XML" type="file" accept=".xml" disabled={busy} onChange={e=>void chooseFile(e.target.files?.[0])}/></label><button className="primary" disabled={busy||!xml} onClick={()=>void analyse()}>{busy?<LoaderCircle size={15} className="spin"/>:<Search size={15}/>}预览匹配</button></div>
      {error&&<p className="banner error" role="alert">{error}</p>}{message&&<p className="banner" role="status">{message}</p>}
      {preview&&<section className="timeline-preview"><header><h3>{preview.name}</h3><span>{matched} / {preview.rows.length} 个文件已匹配 · {used} 个文件选择已使用 · {preview.fps.toFixed(3)} fps</span></header>
        <div className="timeline-warnings">{preview.warnings.map(w=><p key={w}>{w}</p>)}</div>
        {preview.rows.slice((page-1)*20,page*20).map(row=><MatchRow key={row.key} row={row} choice={choices[row.key]} locked={busy} request={request} change={choice=>setChoices(previous=>({...previous,[row.key]:choice}))}/>)}
        {!preview.rows.length&&<p className="timeline-empty">没有可解析的直接音频引用，请核对是否为音频时间线或包含嵌套片段。</p>}
        {preview.rows.length>20&&<PaginationControls label="引用预览分页" page={page} pages={Math.ceil(preview.rows.length/20)} change={setPage} disabled={busy}/>}
        {target&&<label className="check-label timeline-confirm"><input type="checkbox" checked={removeMissing} disabled={busy} onChange={e=>setRemoveMissing(e.target.checked)}/>同步移除本条时间线不再引用的素材；不影响手动或其他时间线记录（预估 {preview.diff.removed} 个）</label>}
        <label className="check-label timeline-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>我已核对匹配与静音情况，确认所选引用为项目已使用；其余保留为待确认引用</label>
      </section>}
      {state.timelines.length>0&&<section className="timeline-records"><h3>已导入的时间线</h3>{state.timelines.map(t=><div key={t.id}><span><strong>{t.name}</strong><small>{t.used} 个已使用音频 · {t.references} 条文件引用</small></span><button className="plain" disabled={busy} onClick={()=>{setTarget(t.id);setName("");resetPreview();}}><FileUp size={14}/>更新</button><button className="icon-button" title="撤销最新导入" aria-label={`撤销时间线：${t.name}`} disabled={busy||!t.head_id} onClick={()=>void undo(t.head_id)}><Undo2 size={16}/></button></div>)}</section>}
    </div>
    <div className="modal-footer"><button className="plain" disabled={busy} onClick={close}>{creating?"取消":"关闭"}</button><button className="primary" disabled={busy||!preview||!confirmed||(creating&&!projectName.trim())} onClick={()=>void apply()}><Check size={15}/>{creating?"创建并导入":"确认更新项目"}</button></div>
  </div></div>;
}
