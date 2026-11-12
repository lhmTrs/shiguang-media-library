import {useFeedbackToast} from './global-feedback';
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, FilePenLine, FileUp, FolderKanban, Plus, Search, SearchX, Trash2, X } from "lucide-react";
import type { Asset } from "./main";
import { TimelineImportDialog } from "./TimelineImportDialog";
import type { TimelineReference } from "./TimelineUsage";
import { AgentShare } from "./AgentShare";
import { ProjectUsage, mediaTypes, softwareNames } from "./ProjectUsage";
export { ProjectMediaDialog } from "./ProjectUsage";

export type Project = { id: string; name: string; software: string; note: string; total: number; candidates: number; used: number };
export type ProjectRequest = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type HistoryRow = { asset_id: string; status: "candidate" | "used"; note: string; added_at: number; used_at: number | null; source: string; timelineReferences?: TimelineReference[] };
const date = (n: number | null) => n ? new Date(n).toLocaleString("zh-CN") : "—";

export function ProjectHistory({ assetId, request, revision = 0 }: { assetId: string; request: ProjectRequest; revision?: number }) {
  const [rows, setRows] = useState<(HistoryRow & { project_name: string; project_id: string })[]>([]), [error, setError] = useState("");
  useFeedbackToast(error, {source: '项目管理'});
  useEffect(() => {
    let live = true; setRows([]); setError("");
    request<typeof rows>(`/assets/${assetId}/projects`).then(r => { if (live) setRows(r); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [assetId, revision, request]);
  return <section className="project-history" aria-label="项目使用历史"><h3>项目使用历史</h3>
    {error ? <p role="alert">{error}</p> : !rows.length ? <p className="muted">暂无项目记录</p> : <><p>已用于 {rows.filter(r => r.status === "used").length} 个项目</p>{rows.map(r => <div className="project-history-row" key={r.project_id}><strong>{r.project_name}</strong><span>{r.status === "used" ? "已使用" : r.source === "resolve" ? "时间线待确认引用" : "候选"} · {r.source === "resolve" ? "达芬奇导入" : r.source === "mixed" ? "手动＋时间线" : "手动确认"}</span><small>{r.status === "used" ? date(r.used_at) : date(r.added_at)}</small>{r.timelineReferences?.map(ref=><small key={ref.timelineId}>{ref.timelineName} · {ref.occurrences.length} 次引用{ref.used?" · 已确认":" · 待确认"}</small>)}{r.note && <p>{r.note}</p>}</div>)}</>}
  </section>;
}

export function ProjectEditor({ project, request, close, saved, importXml }: { project: Project | null; request: ProjectRequest; close: () => void; saved: (id: string) => void; importXml?:()=>void }) {
  const [name, setName] = useState(project?.name || ""), [software, setSoftware] = useState(project?.software || ""), [note, setNote] = useState(project?.note || "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useFeedbackToast(error, {source: '项目管理'});
  const root = useRef<HTMLFormElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; root.current?.querySelector("input")?.focus(); return () => previous?.focus(); }, []);
  return <div className="modal-backdrop"><form className="modal project-editor" ref={root} role="dialog" aria-modal="true" aria-label={project ? "编辑项目" : "新建项目"}
    onKeyDown={e => {
      if (e.key === "Escape" && !busy) { e.stopPropagation(); close(); }
      if (e.key === "Tab") { const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select,textarea") || []), first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }} onSubmit={e => { e.preventDefault(); setBusy(true); setError(""); void request<Project>(project ? `/projects/${project.id}` : "/projects", { name, software, note }, project ? "PATCH" : "POST").then(p => saved(p.id)).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>
    <div className="modal-head"><h2>{project ? "编辑项目" : "新建项目"}</h2><button className="icon-button" type="button" aria-label="关闭项目编辑" title="关闭" disabled={busy} onClick={close}><X size={18}/></button></div>
    {!project&&importXml&&<div className="project-create-modes" role="group" aria-label="创建项目方式"><button type="button" aria-pressed="true" disabled={busy}><FolderKanban size={15}/>空白项目</button><button type="button" aria-pressed="false" disabled={busy} onClick={importXml}><FileUp size={15}/>从达芬奇 XML 创建</button></div>}
    <fieldset className="modal-body" disabled={busy}><label className="field">项目名称<input aria-label="项目名称" required maxLength={120} value={name} onChange={e => setName(e.target.value)}/></label><label className="field">剪辑软件<select aria-label="项目剪辑软件" value={software} onChange={e => setSoftware(e.target.value)}>{Object.entries(softwareNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">备注<textarea aria-label="项目备注" maxLength={2000} value={note} onChange={e => setNote(e.target.value)}/></label>{error && <p className="database-error" role="alert">{error}</p>}</fieldset>
    <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !name.trim()}><Check size={15}/>{busy ? "保存中…" : "保存项目"}</button></div>
  </form></div>;
}

export function ProjectManager({ projects, activeId, select, request, revision, changed, play, playingId, isPlaying, edit, stopAudio, browseLibrary }: {
  projects: Project[]; activeId: string; select: (id: string) => void; request: ProjectRequest; revision: number; changed: (id?: string) => void;
  play: (a: Asset) => void; playingId?: string; isPlaying: boolean; edit: (a: Asset) => void;
  stopAudio: () => void;
  browseLibrary?: () => void;
}) {
  const active = projects.find(p => p.id === activeId);
  const [projectSearch, setProjectSearch] = useState(""), [busy, setBusy] = useState(false), [usageBusy, setUsageBusy] = useState(false), [error, setError] = useState("");
  useFeedbackToast(error, {source: '项目管理'});
  const [editor, setEditor] = useState<{ project: Project | null } | null>(null), [creatingFromXml, setCreatingFromXml] = useState(false);
  const [requestedTab, setRequestedTab] = useState<{ tab: "candidate" | "used"; n: number } | undefined>();
  const onUsageBusy = useCallback((b: boolean) => setUsageBusy(b), []);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } }
  const locked = busy || usageBusy;
  const visibleProjects = projects.filter(p => p.name.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase()));
  return <div className="project-manager">
    <header className="project-heading"><div className="project-page-title"><h1>项目</h1><span className="project-count">{projects.length}</span></div><div className="project-heading-actions">{projects.length > 0 && <button className="primary" onClick={() => setEditor({ project: null })}><Plus size={16}/>新建项目</button>}</div></header>
    {!projects.length ? <section className="project-blank" aria-label="暂无项目"><div className="project-blank-symbol"><FolderKanban size={32} strokeWidth={1.5}/></div><h2>还没有项目</h2><div className="project-blank-types">{mediaTypes.filter(t => t.kind).map(({kind,name,icon:Icon}) => <span key={kind} data-kind={kind}><Icon size={16}/>{name}</span>)}</div><div className="project-blank-actions"><button className="primary" onClick={() => setCreatingFromXml(true)}><FileUp size={16}/>从达芬奇 XML 导入</button><button className="plain" onClick={() => setEditor({ project: null })}><Plus size={16}/>新建项目</button></div></section> : <div className="project-workspace"><aside className="project-list" aria-label="项目列表"><div className="project-list-caption"><span>项目列表</span><small>{projects.length}</small></div><label className="search"><Search size={16}/><input aria-label="搜索项目" placeholder="搜索项目" value={projectSearch} onChange={e => setProjectSearch(e.target.value)}/>{projectSearch && <button className="icon-button" title="清除项目搜索" aria-label="清除项目搜索" onClick={() => setProjectSearch("")}><X size={14}/></button>}</label>
      {visibleProjects.map(p => <button key={p.id} title={p.name} aria-pressed={p.id === activeId} className={p.id === activeId ? "selected" : ""} onClick={() => select(p.id)}><FolderKanban size={18}/><span><strong>{p.name}</strong><small>候选 {p.candidates} <i>·</i> 已使用 {p.used}</small></span>{p.id === activeId && <span className="project-active-dot" aria-label="当前项目"/>}</button>)}
      {!visibleProjects.length && <div className="project-search-empty" role="status"><SearchX size={20}/><p>没有匹配的项目</p></div>}
    </aside><section className="project-content" aria-label="项目素材篮">
      {error && <p className="banner error" role="alert">{error}</p>}
      {active ? <ProjectUsage project={active} request={request} revision={revision} changed={changed} play={play} playingId={playingId} isPlaying={isPlaying} edit={edit} stopAudio={stopAudio} browseLibrary={browseLibrary} requestedTab={requestedTab} onBusyChange={onUsageBusy}
        headerActions={<>
          <AgentShare key={active.id} projectId={active.id} projectName={active.name} disabled={locked}/>
          <button className="icon-button" disabled={locked} title="编辑项目" aria-label="编辑当前项目" onClick={() => setEditor({ project: active })}><FilePenLine size={17}/></button><button className="icon-button" disabled={locked} title="删除项目（保留原文件）" aria-label="删除当前项目" onClick={() => { if (window.confirm(`删除项目“${active.name}”及其使用记录？不会删除原文件。`)) void perform(async () => { await request(`/projects/${active.id}`, {}, "DELETE"); changed(""); }); }}><Trash2 size={17}/></button>
        </>}/>
        : <div className="project-items-empty project-unselected"><FolderKanban size={32} strokeWidth={1.5}/><h2>选择一个项目</h2><button className="plain" onClick={() => select(projects[0].id)}>打开项目<ArrowRight size={15}/></button></div>}
    </section></div>}
    {editor && <ProjectEditor project={editor.project} request={request} close={() => setEditor(null)} saved={id => { setEditor(null); changed(id); }} importXml={()=>{setEditor(null);setCreatingFromXml(true);}}/>}
    {creatingFromXml&&<TimelineImportDialog key="create-from-xml" request={request} close={()=>setCreatingFromXml(false)} changed={(id,used)=>{setCreatingFromXml(false);setRequestedTab(t=>({tab:used?"used":"candidate",n:(t?.n??0)+1}));changed(id);}}/>}
  </div>;
}
