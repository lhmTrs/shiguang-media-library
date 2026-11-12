import {useFeedbackToast} from './global-feedback';
import { useEffect, useRef, useState } from "react";
import { Check, FileUp, FolderKanban, X } from "lucide-react";
import type { TimelineReference } from "./TimelineUsage";
import { softwareNames } from "./ProjectUsage";
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
