import {useFeedbackToast} from './global-feedback';
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AudioLines, Check, ChevronLeft, ChevronRight, ExternalLink, FileUp, Film, FolderKanban, Image, Layers, Music2, Pause, Play, Plus, Search, X } from "lucide-react";
import type { Asset } from "./main";
import type { Project, ProjectRequest } from "./ProjectManager";
import { TimelineImportDialog } from "./TimelineImportDialog";
import { TimelineUsage, type TimelineReference } from "./TimelineUsage";
import { RenderWorkbench } from "./project-usage/RenderWorkbench";
import {MediaViewer, assetMediaView, mediaDoubleClick} from './MediaViewer';

// 某一集的素材使用账本：候选 / 已使用、类型筛选、时间线总览、逐条操作、导入时间线。
// 只认传入的 project；切换项目由宿主负责。
type Item = { asset_id: string; status: "candidate" | "used"; note: string; added_at: number; used_at: number | null; source: string; asset: Asset; unavailable: boolean; manualStatus?: "candidate"|"used"|null; referenceCount?:number; timelineReferences?:TimelineReference[] };
export const softwareNames: Record<string, string> = { "": "未指定", jianying: "剪映", resolve: "达芬奇", other: "其他" };
const date = (n: number | null) => n ? new Date(n).toLocaleString("zh-CN") : "—";
export const mediaTypes = [{ kind: "", name: "全部", icon: Layers }, { kind: "music", name: "音乐", icon: Music2 }, { kind: "sfx", name: "音效", icon: AudioLines }, { kind: "photo", name: "照片", icon: Image }, { kind: "video", name: "视频", icon: Film }];
const emptyKinds = () => ({ all: 0, music: 0, sfx: 0, photo: 0, video: 0 });
const duration = (n: number | null) => n == null ? "—" : `${Math.floor(n / 60).toString().padStart(2, "0")}:${Math.floor(n % 60).toString().padStart(2, "0")}`;
const thumbnail = (asset: Asset) => `/api/media/${asset.id}/${asset.kind === "photo" && ["jpg", "jpeg", "png", "webp", "gif"].includes(asset.ext) ? "original" : "thumb"}`;

function ProjectAssetPreview({ asset, unavailable, playing, click }: { asset: Asset; unavailable: boolean; playing: boolean; click: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id, asset.mtime]);
  const Icon = mediaTypes.find(t => t.kind === asset.kind)?.icon || Layers, visual = ["photo", "video"].includes(asset.kind);
  return <button className="project-media-preview" data-kind={asset.kind} title={visual ? "查看原图或视频" : "试听项目素材"} aria-label={(visual ? "预览项目素材：" : "试听项目素材：") + asset.name} disabled={!visual && (unavailable || asset.ext === "ncm")} onClick={click}>
    {visual && !failed && !unavailable ? <img src={thumbnail(asset)} alt={asset.name} loading="lazy" onError={() => setFailed(true)}/> : !visual && !unavailable && asset.ext !== "ncm" ? playing ? <Pause size={21}/> : <Play size={21}/> : <Icon size={23}/>}
    {!unavailable && visual && asset.kind !== "photo" && <span className={"project-preview-play" + (playing ? " playing" : "")}>{playing ? <Pause size={17}/> : <Play size={17}/>}</span>}
  </button>;
}

export function ProjectMediaDialog({ asset, close, stopAudio, label = "项目素材预览" }: { asset: Asset; close: () => void; stopAudio: () => void; label?: string }) {
  return <MediaViewer target={assetMediaView(asset)} label={label} onClose={close} onPlay={stopAudio}/>;
}

export type ProjectUsageProps = {
  project: Project; request: ProjectRequest; revision: number; changed: (id?: string) => void;
  play: (a: Asset) => void; playingId?: string; isPlaying: boolean; edit: (a: Asset) => void;
  stopAudio: () => void; browseLibrary?: () => void;
  /** 标题右侧由宿主放的管理按钮（编辑、删除、分享给 Agent 等）。 */
  headerActions?: ReactNode;
  /** 宿主要求切到某个标签（例如从 XML 新建后直接看已使用）；n 变化才生效。 */
  requestedTab?: { tab: "candidate" | "used"; n: number };
  /** 每次打开导入框、切项目时通知宿主当前是否忙（用于宿主禁用按钮）。 */
  onBusyChange?: (busy: boolean) => void;
};

export function ProjectUsage({ project, request, revision, changed, play, playingId, isPlaying, edit, stopAudio, browseLibrary, headerActions, requestedTab, onBusyChange }: ProjectUsageProps) {
  const activeId = project.id;
  const [tab, setTab] = useState<"candidate" | "used">("candidate"), [q, setQ] = useState(""), [search, setSearch] = useState("");
  const [items, setItems] = useState<Item[]>([]), [total, setTotal] = useState(0), [pages, setPages] = useState(0), [page, setPage] = useState(1);
  const [kind, setKind] = useState(""), [kinds, setKinds] = useState(emptyKinds), [preview, setPreview] = useState<Asset | null>(null);
  const [checked, setChecked] = useState<string[]>([]), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [noteEditor, setNoteEditor] = useState<{ id: string; note: string } | null>(null), [importing, setImporting] = useState(false);
  useFeedbackToast(error, {source: '项目管理'});
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { if (requestedTab) setTab(requestedTab.tab); }, [requestedTab?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const previewContext = [activeId, tab, search, kind, page, revision].join(':');
  const previewScope = useRef('');
  const openPreview = (asset: Asset, unavailable = false) => {
    previewScope.current = previewContext;
    setPreview(unavailable ? {...asset, online: 0} : asset);
  };
  useEffect(() => setPreview(null), [previewContext]);
  useEffect(() => { const timer = setTimeout(() => setSearch(q), 200); return () => clearTimeout(timer); }, [q]);
  useEffect(() => { setKind(""); setPreview(null); setImporting(false); setQ(""); }, [activeId]);
  useEffect(() => { setPage(1); setChecked([]); setNoteEditor(null); }, [activeId, tab, search, kind]);
  useEffect(() => {
    let live = true; setError("");
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
  const active = project;
  return <>
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="project-title"><div><span className="project-section-label">当前项目</span><h2>{active.name}</h2><small className="project-software"><Film size={13}/>{softwareNames[active.software] || "其他"}</small>{active.note && <p>{active.note}</p>}</div><div className="project-title-actions"><button className="plain" disabled={busy} onClick={()=>setImporting(true)}><FileUp size={16}/>导入达芬奇时间线</button>{browseLibrary && <button className="plain project-add-assets" disabled={busy} onClick={browseLibrary}><Plus size={15}/>添加素材</button>}
      {headerActions}</div></div>
    <div className="project-toolbar"><div className="segmented" role="tablist" aria-label="项目素材状态"><button role="tab" aria-selected={tab === "candidate"} className={tab === "candidate" ? "active" : ""} onClick={() => setTab("candidate")}>候选素材 {active.candidates}</button><button role="tab" aria-selected={tab === "used"} className={tab === "used" ? "active" : ""} onClick={() => setTab("used")}>已使用 {active.used}</button></div><label className="search"><Search size={16}/><input aria-label="搜索项目素材" placeholder="搜索素材或使用备注" value={q} onChange={e => setQ(e.target.value)}/></label></div>
    <div className="project-type-filters" role="group" aria-label="项目素材类型">{mediaTypes.map(({ kind: type, name, icon: Icon }) => <button key={type} data-kind={type || "all"} aria-label={"筛选项目" + name} aria-pressed={kind === type} disabled={busy} onClick={() => setKind(type)}><Icon size={17}/><span>{name}</span><b>{kinds[(type || "all") as keyof typeof kinds]}</b></button>)}</div>
    <RenderWorkbench key={active.id} projectId={active.id} projectName={active.name} revision={revision} request={request} stopAudio={stopAudio}/>
    <div className="project-selection"><label className="check-label"><input type="checkbox" aria-label="选择本页项目素材" disabled={loading || !items.length} checked={items.length > 0 && items.every(i => checked.includes(i.asset_id))} onChange={e => setChecked(e.target.checked ? items.map(i => i.asset_id) : [])}/>本页</label><span>{checked.length ? `已选 ${checked.length} 项` : `${total} 个素材`}</span>{checked.length > 0 && <><button className="plain" disabled={busy || loading} onClick={() => void perform(() => update(checked, tab === "used" ? "candidate" : "used"))}><Check size={15}/>{tab === "used" ? "退回候选" : "标记已使用"}</button><button className="icon-button" title="移出所选项目素材" aria-label="移出所选项目素材" disabled={busy || loading} onClick={() => void perform(() => remove(checked))}><X size={16}/></button></>}</div>
    <div className="project-list-heading"><span>素材</span><span>使用与操作</span></div>
    <div className="project-items" aria-busy={loading}>{loading ? <p className="project-loading" role="status">正在读取…</p> : !items.length ? <div className="project-items-empty"><FolderKanban size={28} strokeWidth={1.5}/><p>{search ? "没有匹配的项目素材" : kind ? `暂无${mediaTypes.find(t => t.kind === kind)?.name || "此类"}素材` : tab === "candidate" ? "暂无候选素材" : "暂无已使用素材"}</p>{search || kind ? <button className="plain" onClick={() => { setQ(""); setKind(""); }}><X size={14}/>清除素材筛选</button> : tab === "used" ? <button className="plain" onClick={() => setTab("candidate")}><Layers size={15}/>查看候选素材</button> : browseLibrary && <button className="plain" onClick={browseLibrary}><Plus size={15}/>添加素材</button>}</div> : items.map(item => <article className="project-item" key={item.asset_id} data-project-asset={item.asset_id}
      onDoubleClick={event => { if (['photo', 'video'].includes(item.asset.kind) && mediaDoubleClick(event)) openPreview(item.asset, item.unavailable); }}>
      <input type="checkbox" aria-label={"选择项目素材：" + item.asset.name} checked={checked.includes(item.asset_id)} onChange={e => setChecked(ids => e.target.checked ? [...ids, item.asset_id] : ids.filter(id => id !== item.asset_id))}/>
      <ProjectAssetPreview asset={item.asset} unavailable={item.unavailable} playing={playingId === item.asset_id && isPlaying} click={() => ["photo", "video"].includes(item.asset.kind) ? openPreview(item.asset, item.unavailable) : ["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm"].includes(item.asset.ext) ? openPreview({ ...item.asset, kind: "video" }, item.unavailable) : play(item.asset)}/>
      <div className="project-item-info"><button className="asset-name-button" title={item.asset.name} disabled={item.unavailable} onClick={() => edit(item.asset)}>{item.asset.name}</button><div className="project-item-meta"><span className="project-kind-label" data-kind={item.asset.kind}>{mediaTypes.find(t => t.kind === item.asset.kind)?.name || "素材"}</span><span>{item.asset.ext.toUpperCase()}</span>{item.asset.duration != null && <span>{duration(item.asset.duration)}</span>}{!!item.asset.width && <span>{item.asset.width} × {item.asset.height}</span>}<span>{item.source==="resolve"?"达芬奇导入":item.source==="mixed"?"手动＋时间线":item.status === "used" ? "手动确认" : "手动加入"}</span>{item.unavailable && <span className="project-offline">离线 / 原文件不可用</span>}</div>
        <TimelineUsage references={item.timelineReferences} projectId={active.id} projectName={active.name} request={request} stopAudio={stopAudio} compact/>
        <details className="project-file-details"><summary>文件信息</summary><div><span>原文件路径</span><p>{item.asset.path}</p><span>{item.status === "used" ? `首次确认 ${date(item.used_at)}` : `加入 ${date(item.added_at)}`}</span></div></details>
        {noteEditor?.id === item.asset_id ? <div className="project-note-editor"><textarea aria-label="使用位置备注" maxLength={2000} value={noteEditor.note} onChange={e => setNoteEditor({ ...noteEditor, note: e.target.value })}/><button className="plain" disabled={busy} onClick={() => void perform(async () => { await request(`/projects/${activeId}/items`, { ids: [item.asset_id], note: noteEditor.note }, "PATCH"); setNoteEditor(null); changed(); })}>保存备注</button><button className="icon-button" title="取消备注编辑" aria-label="取消备注编辑" onClick={() => setNoteEditor(null)}><X size={15}/></button></div> : <button className="text-button project-note" onClick={() => setNoteEditor({ id: item.asset_id, note: item.note })}>{item.note || "添加使用位置备注"}</button>}
      </div><div className="project-item-actions"><label className="check-label"><input type="checkbox" aria-label={"手动已使用：" + item.asset.name} checked={item.manualStatus!==undefined?item.manualStatus==="used":item.status==="used"} disabled={busy || loading} onChange={e => { const status = e.target.checked ? "used" : "candidate"; void perform(() => markItem(item, status)); }}/ >{item.source==="manual"?"已使用":"手动已使用"}</label><button className="icon-button" title="在访达中显示" aria-label={"定位项目素材：" + item.asset.name} disabled={busy || item.unavailable} onClick={() => void perform(async () => { await request(`/assets/${item.asset_id}/reveal`, {}); })}><ExternalLink size={16}/></button><button className="icon-button" title="移出项目（不删文件）" aria-label={"移出项目素材：" + item.asset.name} disabled={busy} onClick={() => void perform(() => remove([item.asset_id]))}><X size={16}/></button></div>
    </article>)}</div>
    {pages > 1 && <div className="pagination"><button className="icon-button" title="上一页项目素材" aria-label="上一页项目素材" disabled={page <= 1 || loading} onClick={() => { setChecked([]); setPage(p => p - 1); }}><ChevronLeft size={17}/></button><span>{page} / {pages}</span><button className="icon-button" title="下一页项目素材" aria-label="下一页项目素材" disabled={page >= pages || loading} onClick={() => { setChecked([]); setPage(p => p + 1); }}><ChevronRight size={17}/></button></div>}
    {preview && previewScope.current === previewContext && <ProjectMediaDialog key={preview.id} asset={preview} close={() => setPreview(null)} stopAudio={stopAudio}/>}
    {importing && <TimelineImportDialog key={active.id} projectId={active.id} request={request} close={()=>setImporting(false)} changed={changed}/>}
  </>;
}
