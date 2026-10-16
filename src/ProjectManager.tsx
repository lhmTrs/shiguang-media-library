import { useEffect, useRef, useState } from "react";
import { AudioLines, Check, ChevronLeft, ChevronRight, ExternalLink, FilePenLine, Film, FolderKanban, Image, Layers, Music2, Pause, Play, Plus, Search, Trash2, X } from "lucide-react";
import type { Asset } from "./main";

export type Project = { id: string; name: string; software: string; note: string; total: number; candidates: number; used: number };
export type ProjectRequest = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type Item = { asset_id: string; status: "candidate" | "used"; note: string; added_at: number; used_at: number | null; source: string; asset: Asset; unavailable: boolean };
const softwareNames: Record<string, string> = { "": "未指定", jianying: "剪映", resolve: "达芬奇", other: "其他" };
const date = (n: number | null) => n ? new Date(n).toLocaleString("zh-CN") : "—";
const mediaTypes = [{ kind: "", name: "全部", icon: Layers }, { kind: "music", name: "音乐", icon: Music2 }, { kind: "sfx", name: "音效", icon: AudioLines }, { kind: "photo", name: "照片", icon: Image }, { kind: "video", name: "视频", icon: Film }];
const emptyKinds = () => ({ all: 0, music: 0, sfx: 0, photo: 0, video: 0 });
const duration = (n: number | null) => n == null ? "—" : `${Math.floor(n / 60).toString().padStart(2, "0")}:${Math.floor(n % 60).toString().padStart(2, "0")}`;
const thumbnail = (asset: Asset) => `/api/media/${asset.id}/${asset.kind === "photo" && ["jpg", "jpeg", "png", "webp", "gif"].includes(asset.ext) ? "original" : "thumb"}`;

function ProjectAssetPreview({ asset, unavailable, playing, click }: { asset: Asset; unavailable: boolean; playing: boolean; click: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id, asset.mtime]);
  const Icon = mediaTypes.find(t => t.kind === asset.kind)?.icon || Layers, visual = ["photo", "video"].includes(asset.kind);
  return <button className="project-media-preview" data-kind={asset.kind} title={visual ? "预览素材" : "试听项目素材"} aria-label={(visual ? "预览项目素材：" : "试听项目素材：") + asset.name} disabled={unavailable || (!visual && asset.ext === "ncm")} onClick={click}>
    {visual && !failed && !unavailable ? <img src={thumbnail(asset)} alt={asset.name} loading="lazy" onError={() => setFailed(true)}/> : <Icon size={23}/>}
    {!unavailable && asset.kind !== "photo" && asset.ext !== "ncm" && <span className={"project-preview-play" + (playing ? " playing" : "")}>{playing ? <Pause size={17}/> : <Play size={17}/>}</span>}
  </button>;
}

export function ProjectMediaDialog({ asset, close, stopAudio, label = "项目素材预览" }: { asset: Asset; close: () => void; stopAudio: () => void; label?: string }) {
  const [failed, setFailed] = useState(false), root = useRef<HTMLDivElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; root.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => previous?.focus(); }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><div className="modal project-media-dialog" role="dialog" aria-modal="true" aria-label={label} ref={root} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); close(); } if (e.key === "Tab") { const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>("button,video") || []), first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } } }}>
    <div className="modal-head"><h2 title={asset.name}>{asset.name}</h2><button className="icon-button" aria-label="关闭项目素材预览" title="关闭预览" onClick={close}><X size={18}/></button></div><div className="project-media-stage">{failed ? <p role="status">此格式暂时无法预览，可在访达中查看原文件。</p> : asset.kind === "photo" ? <img src={thumbnail(asset)} alt={asset.name} onError={() => setFailed(true)}/> : <video src={`/api/media/${asset.id}/original`} poster={thumbnail(asset)} controls preload="metadata" onPlay={stopAudio} onError={() => setFailed(true)}/>}</div>
  </div></div>;
}

export function ProjectHistory({ assetId, request, revision = 0 }: { assetId: string; request: ProjectRequest; revision?: number }) {
  const [rows, setRows] = useState<(Omit<Item, "asset" | "unavailable"> & { project_name: string; project_id: string })[]>([]), [error, setError] = useState("");
  useEffect(() => {
    let live = true; setRows([]); setError("");
    request<typeof rows>(`/assets/${assetId}/projects`).then(r => { if (live) setRows(r); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [assetId, revision, request]);
  return <section className="project-history" aria-label="项目使用历史"><h3>项目使用历史</h3>
    {error ? <p role="alert">{error}</p> : !rows.length ? <p className="muted">暂无项目记录</p> : <><p>已用于 {rows.filter(r => r.status === "used").length} 个项目</p>{rows.map(r => <div className="project-history-row" key={r.project_id}><strong>{r.project_name}</strong><span>{r.status === "used" ? "已使用" : "候选"} · 手动确认</span><small>{r.status === "used" ? date(r.used_at) : date(r.added_at)}</small>{r.note && <p>{r.note}</p>}</div>)}</>}
  </section>;
}

function ProjectEditor({ project, request, close, saved }: { project: Project | null; request: ProjectRequest; close: () => void; saved: (id: string) => void }) {
  const [name, setName] = useState(project?.name || ""), [software, setSoftware] = useState(project?.software || ""), [note, setNote] = useState(project?.note || "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const root = useRef<HTMLFormElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement; root.current?.querySelector("input")?.focus(); return () => previous?.focus(); }, []);
  return <div className="modal-backdrop"><form className="modal project-editor" ref={root} role="dialog" aria-modal="true" aria-label={project ? "编辑项目" : "新建项目"}
    onKeyDown={e => {
      if (e.key === "Escape" && !busy) { e.stopPropagation(); close(); }
      if (e.key === "Tab") { const nodes = Array.from(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select,textarea") || []), first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } }
    }} onSubmit={e => { e.preventDefault(); setBusy(true); setError(""); void request<Project>(project ? `/projects/${project.id}` : "/projects", { name, software, note }, project ? "PATCH" : "POST").then(p => saved(p.id)).catch(e => setError(e.message)).finally(() => setBusy(false)); }}>
    <div className="modal-head"><h2>{project ? "编辑项目" : "新建项目"}</h2><button className="icon-button" type="button" aria-label="关闭项目编辑" title="关闭" disabled={busy} onClick={close}><X size={18}/></button></div>
    <fieldset className="modal-body" disabled={busy}><label className="field">项目名称<input aria-label="项目名称" required maxLength={120} value={name} onChange={e => setName(e.target.value)}/></label><label className="field">剪辑软件<select aria-label="项目剪辑软件" value={software} onChange={e => setSoftware(e.target.value)}>{Object.entries(softwareNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="field">备注<textarea aria-label="项目备注" maxLength={2000} value={note} onChange={e => setNote(e.target.value)}/></label>{error && <p className="database-error" role="alert">{error}</p>}</fieldset>
    <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={close}>取消</button><button className="primary" type="submit" disabled={busy || !name.trim()}><Check size={15}/>{busy ? "保存中…" : "保存项目"}</button></div>
  </form></div>;
}

export function ProjectManager({ projects, activeId, select, request, revision, changed, play, playingId, isPlaying, edit, stopAudio }: {
  projects: Project[]; activeId: string; select: (id: string) => void; request: ProjectRequest; revision: number; changed: (id?: string) => void;
  play: (a: Asset) => void; playingId?: string; isPlaying: boolean; edit: (a: Asset) => void;
  stopAudio: () => void;
}) {
  const active = projects.find(p => p.id === activeId);
  const [tab, setTab] = useState("candidate"), [q, setQ] = useState(""), [search, setSearch] = useState(""), [projectSearch, setProjectSearch] = useState("");
  const [items, setItems] = useState<Item[]>([]), [total, setTotal] = useState(0), [pages, setPages] = useState(0), [page, setPage] = useState(1);
  const [kind, setKind] = useState(""), [kinds, setKinds] = useState(emptyKinds), [preview, setPreview] = useState<Asset | null>(null);
  const [checked, setChecked] = useState<string[]>([]), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [editor, setEditor] = useState<{ project: Project | null } | null>(null), [noteEditor, setNoteEditor] = useState<{ id: string; note: string } | null>(null);
  useEffect(() => { const timer = setTimeout(() => setSearch(q), 200); return () => clearTimeout(timer); }, [q]);
  useEffect(() => { setKind(""); setPreview(null); }, [activeId]);
  useEffect(() => { setPage(1); setChecked([]); setNoteEditor(null); }, [activeId, tab, search, kind]);
  useEffect(() => {
    let live = true; setError("");
    if (!activeId) { setItems([]); setTotal(0); setPages(0); setKinds(emptyKinds()); return; }
    setLoading(true);
    request<{ items: Item[]; total: number; pages: number; kinds: ReturnType<typeof emptyKinds> }>(`/projects/${activeId}/items?` + new URLSearchParams({ status: tab, q: search, kind, page: String(page) }))
      .then(r => { if (live) { if (page > Math.max(1, r.pages)) { setPage(Math.max(1, r.pages)); return; } setItems(r.items); setTotal(r.total); setPages(r.pages); setKinds(r.kinds || emptyKinds()); setChecked(ids => ids.filter(id => r.items.some(i => i.asset_id === id))); } })
      .catch(e => { if (live) { setError(e.message); setItems([]); } }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [activeId, tab, search, kind, page, revision, request]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } }
  async function update(ids: string[], status: string) { await request(`/projects/${activeId}/items`, { ids, status }, "PATCH"); setChecked([]); changed(); }
  async function markItem(item: Item, status: "candidate" | "used") {
    setItems(rows => rows.map(row => row.asset_id === item.asset_id ? { ...row, status } : row));
    try { await update([item.asset_id], status); }
    catch (e) { setItems(rows => rows.map(row => row.asset_id === item.asset_id ? item : row)); throw e; }
  }
  async function remove(ids: string[]) {
    if (!window.confirm(`从项目移出 ${ids.length} 个素材？不会删除原文件。`)) return;
    await request(`/projects/${activeId}/items`, { ids }, "DELETE"); setChecked([]); changed();
  }
  return <div className="project-manager">
    <header className="project-heading"><div><h1>项目</h1><p>{projects.length} 个项目</p></div><button className="primary" onClick={() => setEditor({ project: null })}><Plus size={16}/>新建项目</button></header>
    <div className="project-workspace"><aside className="project-list" aria-label="项目列表"><label className="search"><Search size={16}/><input aria-label="搜索项目" placeholder="搜索项目" value={projectSearch} onChange={e => setProjectSearch(e.target.value)}/></label>
      {projects.filter(p => p.name.toLocaleLowerCase().includes(projectSearch.toLocaleLowerCase())).map(p => <button key={p.id} aria-pressed={p.id === activeId} className={p.id === activeId ? "selected" : ""} onClick={() => { select(p.id); setQ(""); }}><FolderKanban size={17}/><span><strong>{p.name}</strong><small>候选 {p.candidates} · 已使用 {p.used}</small></span></button>)}
      {!projects.length && <p className="muted">暂无项目</p>}
    </aside><section className="project-content" aria-label="项目素材篮">
      {error && <p className="banner error" role="alert">{error}</p>}
      {active ? <><div className="project-title"><div><h2>{active.name}</h2><small>{softwareNames[active.software] || "其他"}</small>{active.note && <p>{active.note}</p>}</div><div className="project-title-actions"><button className="icon-button" disabled={busy} title="编辑项目" aria-label="编辑当前项目" onClick={() => setEditor({ project: active })}><FilePenLine size={17}/></button><button className="icon-button" disabled={busy} title="删除项目（保留原文件）" aria-label="删除当前项目" onClick={() => { if (window.confirm(`删除项目“${active.name}”及其使用记录？不会删除原文件。`)) void perform(async () => { await request(`/projects/${active.id}`, {}, "DELETE"); changed(""); }); }}><Trash2 size={17}/></button></div></div>
        <div className="project-toolbar"><div className="segmented" role="tablist" aria-label="项目素材状态"><button role="tab" aria-selected={tab === "candidate"} className={tab === "candidate" ? "active" : ""} onClick={() => setTab("candidate")}>候选素材 {active.candidates}</button><button role="tab" aria-selected={tab === "used"} className={tab === "used" ? "active" : ""} onClick={() => setTab("used")}>已使用 {active.used}</button></div><label className="search"><Search size={16}/><input aria-label="搜索项目素材" placeholder="搜索素材或使用备注" value={q} onChange={e => setQ(e.target.value)}/></label></div>
        <div className="project-type-filters" role="group" aria-label="项目素材类型">{mediaTypes.map(({ kind: type, name, icon: Icon }) => <button key={type} data-kind={type || "all"} aria-label={"筛选项目" + name} aria-pressed={kind === type} disabled={busy} onClick={() => setKind(type)}><Icon size={17}/><span>{name}</span><b>{kinds[(type || "all") as keyof typeof kinds]}</b></button>)}</div>
        <div className="project-selection"><label className="check-label"><input type="checkbox" aria-label="选择本页项目素材" disabled={loading || !items.length} checked={items.length > 0 && items.every(i => checked.includes(i.asset_id))} onChange={e => setChecked(e.target.checked ? items.map(i => i.asset_id) : [])}/>本页</label><span>{checked.length ? `已选 ${checked.length} 项` : `${total} 个素材`}</span>{checked.length > 0 && <><button className="plain" disabled={busy || loading} onClick={() => void perform(() => update(checked, tab === "used" ? "candidate" : "used"))}><Check size={15}/>{tab === "used" ? "退回候选" : "标记已使用"}</button><button className="icon-button" title="移出所选项目素材" aria-label="移出所选项目素材" disabled={busy || loading} onClick={() => void perform(() => remove(checked))}><X size={16}/></button></>}</div>
        <div className="project-list-heading"><span>素材</span><span>使用与操作</span></div>
        <div className="project-items" aria-busy={loading}>{loading ? <p>正在读取…</p> : !items.length ? <div className="empty-state"><FolderKanban size={32}/><p>{search ? "没有匹配的项目素材" : kind ? `暂无${mediaTypes.find(t => t.kind === kind)?.name || "此类"}素材` : tab === "candidate" ? "暂无候选素材" : "暂无已使用素材"}</p></div> : items.map(item => <article className="project-item" key={item.asset_id} data-project-asset={item.asset_id}>
          <input type="checkbox" aria-label={"选择项目素材：" + item.asset.name} checked={checked.includes(item.asset_id)} onChange={e => setChecked(ids => e.target.checked ? [...ids, item.asset_id] : ids.filter(id => id !== item.asset_id))}/>
          <ProjectAssetPreview asset={item.asset} unavailable={item.unavailable} playing={playingId === item.asset_id && isPlaying} click={() => ["photo", "video"].includes(item.asset.kind) ? setPreview(item.asset) : ["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm"].includes(item.asset.ext) ? setPreview({ ...item.asset, kind: "video" }) : play(item.asset)}/>
          <div className="project-item-info"><button className="asset-name-button" title={item.asset.name} disabled={item.unavailable} onClick={() => edit(item.asset)}>{item.asset.name}</button><div className="project-item-meta"><span className="project-kind-label" data-kind={item.asset.kind}>{mediaTypes.find(t => t.kind === item.asset.kind)?.name || "素材"}</span><span>{item.asset.ext.toUpperCase()}</span>{item.asset.duration != null && <span>{duration(item.asset.duration)}</span>}{!!item.asset.width && <span>{item.asset.width} × {item.asset.height}</span>}{item.unavailable && <span className="project-offline">离线 / 原文件不可用</span>}</div><small className="project-item-path" title={item.asset.path}>{item.asset.path}</small><span>{item.status === "used" ? `首次确认 ${date(item.used_at)}` : `加入 ${date(item.added_at)}`} · {item.status === "used" ? "手动确认" : "手动加入"}</span>
            {noteEditor?.id === item.asset_id ? <div className="project-note-editor"><textarea aria-label="使用位置备注" maxLength={2000} value={noteEditor.note} onChange={e => setNoteEditor({ ...noteEditor, note: e.target.value })}/><button className="plain" disabled={busy} onClick={() => void perform(async () => { await request(`/projects/${activeId}/items`, { ids: [item.asset_id], note: noteEditor.note }, "PATCH"); setNoteEditor(null); changed(); })}>保存备注</button><button className="icon-button" title="取消备注编辑" aria-label="取消备注编辑" onClick={() => setNoteEditor(null)}><X size={15}/></button></div> : <button className="text-button project-note" onClick={() => setNoteEditor({ id: item.asset_id, note: item.note })}>{item.note || "添加使用位置备注"}</button>}
          </div><div className="project-item-actions"><label className="check-label"><input type="checkbox" aria-label={"已使用：" + item.asset.name} checked={item.status === "used"} disabled={busy || loading} onChange={e => { const status = e.target.checked ? "used" : "candidate"; void perform(() => markItem(item, status)); }}/ >已使用</label><button className="icon-button" title="在访达中显示" aria-label={"定位项目素材：" + item.asset.name} disabled={busy || item.unavailable} onClick={() => void perform(async () => { await request(`/assets/${item.asset_id}/reveal`, {}); })}><ExternalLink size={16}/></button><button className="icon-button" title="移出项目（不删文件）" aria-label={"移出项目素材：" + item.asset.name} disabled={busy} onClick={() => void perform(() => remove([item.asset_id]))}><X size={16}/></button></div>
        </article>)}</div>
        {pages > 1 && <div className="pagination"><button className="icon-button" title="上一页项目素材" aria-label="上一页项目素材" disabled={page <= 1 || loading} onClick={() => { setChecked([]); setPage(p => p - 1); }}><ChevronLeft size={17}/></button><span>{page} / {pages}</span><button className="icon-button" title="下一页项目素材" aria-label="下一页项目素材" disabled={page >= pages || loading} onClick={() => { setChecked([]); setPage(p => p + 1); }}><ChevronRight size={17}/></button></div>}
      </> : <div className="empty-state"><FolderKanban size={34}/><p>暂无项目</p></div>}
    </section></div>
    {editor && <ProjectEditor project={editor.project} request={request} close={() => setEditor(null)} saved={id => { setEditor(null); changed(id); }}/>}
    {preview && <ProjectMediaDialog key={preview.id} asset={preview} close={() => setPreview(null)} stopAudio={stopAudio}/>}
  </div>;
}
