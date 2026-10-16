import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ExternalLink, Folder, FolderOpen, FolderInput, RefreshCw, Search, Tag, X, Play, Pause, Image, Film, Music2 } from "lucide-react";
import type { Asset } from "./main";
import { TagRuleFilter, emptyTagRules } from "./TagRuleFilter";
import { ProjectMediaDialog } from "./ProjectManager";

type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type Root = { id: string; name: string; path: string; online: number };
type Child = { name: string; directory: string; direct: number; total: number };
type Branch = { root: { id: string; name: string }; directory: string; state: string; direct: number; total: number; children: Child[] };
const branchUrl = (root: string, directory: string) => "/folder-browser?" + new URLSearchParams({ root, directory });

function FolderPreview({ asset, playing, click }: { asset: Asset; playing: boolean; click: () => void }) {
  const [failed, setFailed] = useState(false), visual = ["photo", "video"].includes(asset.kind);
  const Icon = asset.kind === "photo" ? Image : asset.kind === "video" ? Film : Music2;
  const direct = asset.kind === "photo" && ["jpg", "jpeg", "png", "webp", "gif"].includes(asset.ext);
  return <button className="folder-asset-preview" data-kind={asset.kind} title={(visual ? "预览素材：" : "试听素材：") + asset.name} aria-label={(visual ? "预览素材：" : "试听素材：") + asset.name} disabled={!asset.online || asset.ext === "ncm"} onClick={click}>
    {visual && asset.online && !failed ? <img src={`/api/media/${asset.id}/${direct ? "original" : "thumb"}`} alt={asset.name} loading="lazy" onError={() => setFailed(true)}/> : visual ? <Icon size={23}/> : playing ? <Pause size={21}/> : <Play size={21}/>}
  </button>;
}

function FolderNode({ root, directory = "", name, active, choose, request, revision, level = 0 }: {
  root: Root; directory?: string; name: string; active: { root: string; directory: string };
  choose: (root: string, directory: string) => void; request: Request; revision: number; level?: number;
}) {
  const selected = active.root === root.id && active.directory === directory;
  const ancestor = active.root === root.id && (!directory || active.directory.startsWith(directory + "/"));
  const [open, setOpen] = useState(ancestor), [branch, setBranch] = useState<Branch | null>(null), [error, setError] = useState("");
  useEffect(() => { if (ancestor) setOpen(true); }, [ancestor]);
  useEffect(() => {
    if (!open) return;
    let live = true; setError(""); setBranch(null);
    request<Branch>(branchUrl(root.id, directory)).then(b => { if (live) setBranch(b); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [root.id, directory, open, revision, request]);
  return <div className="folder-tree-node">
    <div className={"folder-tree-row" + (selected ? " selected" : "")} style={{ paddingLeft: Math.min(level, 8) * 12 }}>
      <button className="icon-button" title={(open ? "收起目录：" : "展开目录：") + name} aria-label={(open ? "收起目录：" : "展开目录：") + name} aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? <ChevronDown size={14}/> : <ChevronRight size={14}/>}</button>
      <button title={root.path + (directory ? "/" + directory : "")} aria-label={"选择文件夹：" + name} aria-current={selected ? "location" : undefined} onClick={() => choose(root.id, directory)}><Folder size={16}/><span>{name}</span>{branch && <small>{branch.total}</small>}</button>
    </div>
    {open && <div>{error ? <p className="folder-tree-status" role="alert">{error}</p> : !branch ? <p className="folder-tree-status">读取中…</p> : branch.children.map(child => <FolderNode key={child.directory} root={root} directory={child.directory} name={child.name} active={active} choose={choose} request={request} revision={revision} level={level + 1}/>)}</div>}
  </div>;
}

export function FolderBrowser({ roots, request, revision, play, playingId, isPlaying, tags, move, addToProject, stopAudio }: {
  roots: Root[]; request: Request; revision: number; play: (asset: Asset) => void;
  playingId?: string; isPlaying: boolean; tags: (asset: Asset) => void;
  move: (asset: Asset) => void;
  addToProject: (ids: string[]) => Promise<void>; stopAudio: () => void;
}) {
  const [active, setActive] = useState({ root: roots[0]?.id || "", directory: "" });
  const [branch, setBranch] = useState<Branch | null>(null), [refresh, setRefresh] = useState(0);
  const [q, setQ] = useState(""), [search, setSearch] = useState(""), [kind, setKind] = useState("");
  const [rules, setRules] = useState(emptyTagRules), [tagOptions, setTagOptions] = useState<{ name: string; n: number }[]>([]);
  const [descendants, setDescendants] = useState(true), [page, setPage] = useState(1);
  const [result, setResult] = useState<{ items: Asset[]; total: number; pages: number }>({ items: [], total: 0, pages: 0 });
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [scanJob, setScanJob] = useState("");
  const [preview, setPreview] = useState<Asset | null>(null);
  const root = roots.find(r => r.id === active.root);
  const choose = (root: string, directory: string) => { setActive({ root, directory }); setPage(1); };
  useEffect(() => { if (!roots.some(r => r.id === active.root)) setActive({ root: roots[0]?.id || "", directory: "" }); }, [roots, active.root]);
  useEffect(() => { const timer = setTimeout(() => { setSearch(q); setPage(1); }, 220); return () => clearTimeout(timer); }, [q]);
  useEffect(() => {
    if (!scanJob) return;
    let live = true, checking = false;
    const check = async () => {
      if (checking) return; checking = true;
      try {
        const jobs = await request<{ jobs: { id: string; status: string; errors: string[] }[] }>("/jobs");
        if (!live) return;
        const job = jobs.jobs.find(j => j.id === scanJob);
        if (!job || job.status !== "running") { setScanJob(""); setRefresh(n => n + 1); if (job?.errors.length) setError(job.errors.slice(0, 3).join("；")); }
      } catch (e) { if (live) { setError(e instanceof Error ? e.message : "无法读取扫描进度"); setScanJob(""); } }
      finally { checking = false; }
    };
    void check(); const timer = setInterval(() => void check(), 1200);
    return () => { live = false; clearInterval(timer); };
  }, [scanJob, request]);
  useEffect(() => {
    let live = true;
    request<{ id: string; name: string; n: number }[]>("/tags").then(t => { if (live) setTagOptions(t.filter(t => t.id !== "untagged" && t.n > 0)); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [revision, request]);
  useEffect(() => {
    let live = true; setBranch(null);
    if (root) request<Branch>(branchUrl(root.id, active.directory)).then(b => { if (live) setBranch(b); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [active.root, active.directory, refresh, revision, request]);
  useEffect(() => {
    let live = true; setError(""); setResult({ items: [], total: 0, pages: 0 });
    if (!root) return;
    setLoading(true);
    const params = new URLSearchParams({ directoryRoot: root.id, directory: active.directory, includeChildren: descendants ? "1" : "0", q: search, kind, tagRules: JSON.stringify(rules), page: String(page), sort: "name" });
    request<typeof result>("/assets?" + params).then(r => { if (live) { if (page > Math.max(1, r.pages)) setPage(Math.max(1, r.pages)); else setResult(r); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [active.root, active.directory, descendants, search, kind, rules, page, refresh, revision, request]);
  async function perform(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } }
  const filters = !!q || !!kind || Object.values(rules).some(v => v.length);
  return <section className="folder-browser" aria-label="真实文件夹浏览">
    <header className="folder-browser-heading"><div><h1>文件夹</h1><p>{roots.length} 个登记目录</p></div><div className="folder-heading-actions"><button className="plain" disabled={!root || busy || !!scanJob} onClick={() => void perform(async () => { const job = await request<{ id: string }>(`/roots/${root!.id}/scan`, {}); setScanJob(job.id); })}><RefreshCw size={15} className={scanJob ? "spin" : ""}/>{scanJob ? "扫描中…" : "扫描当前素材目录"}</button><button className="icon-button" title="刷新文件夹" aria-label="刷新文件夹" onClick={() => setRefresh(n => n + 1)}><RefreshCw size={18}/></button></div></header>
    {error && <p className="banner error" role="alert">{error}</p>}
    <div className="folder-browser-workspace"><aside className="folder-tree" aria-label="真实文件夹树">{roots.map(r => <FolderNode key={r.id} root={r} name={r.name} active={active} choose={choose} request={request} revision={refresh + revision}/>)}{!roots.length && <p className="muted">暂无登记目录</p>}</aside>
      <div className="folder-browser-content">
        {root ? <>
          <nav className="folder-breadcrumbs" aria-label="文件夹路径"><button onClick={() => choose(root.id, "")}><FolderOpen size={16}/>{root.name}</button>{active.directory.split("/").filter(Boolean).map((name, i, parts) => <span key={i}><ChevronRight size={13}/><button onClick={() => choose(root.id, parts.slice(0, i + 1).join("/"))}>{name}</button></span>)}</nav>
          {branch && branch.state !== "online" && <p className="folder-state" role="status">{{ offline: "目录离线，显示已索引记录", missing: "文件夹不存在，保留原索引", unavailable: "目录无法读取，显示已索引记录" }[branch.state]}</p>}
          <div className="folder-children" aria-label="直接子文件夹">{branch?.children.map(child => <button key={child.directory} onClick={() => choose(root.id, child.directory)}><Folder size={21}/><span>{child.name}<small>{child.total} 个已索引素材</small></span><ChevronRight size={15}/></button>)}</div>
          <div className="folder-search"><label className="search"><Search size={17}/><input aria-label="搜索文件夹素材" placeholder="搜索名称、标签或备注" value={q} onChange={e => setQ(e.target.value)}/>{q && <button className="icon-button" title="清空文件夹搜索" onClick={() => setQ("")}><X size={14}/></button>}</label><TagRuleFilter value={rules} tags={tagOptions} change={r => { setRules(r); setPage(1); }}/><select aria-label="文件夹素材类型" value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}><option value="">全部类型</option><option value="music">音乐</option><option value="sfx">音效</option><option value="photo">照片</option><option value="video">视频</option></select></div>
          <div className="folder-list-toolbar"><label className="check-label"><input type="checkbox" aria-label="包含子文件夹" checked={descendants} onChange={e => { setDescendants(e.target.checked); setPage(1); }}/>包含子文件夹</label><span>{loading ? "读取中…" : `${result.total} 个素材`}</span>{filters && <button className="text-button" onClick={() => { setQ(""); setSearch(""); setKind(""); setRules(emptyTagRules()); setPage(1); }}>清空筛选</button>}</div>
          <div className="folder-assets" aria-busy={loading}>{!loading && !result.items.length && <div className="empty-state"><FolderOpen size={30}/><p>{filters ? "没有匹配的素材" : "暂无已索引素材"}</p></div>}{result.items.map(asset => {
            const visual = ["photo", "video"].includes(asset.kind);
            const playing = playingId === asset.id && isPlaying;
            return <article className="folder-asset" key={asset.id}>
              <FolderPreview asset={asset} playing={playing} click={() => visual ? setPreview(asset) : play(asset)}/>
              <div className="folder-asset-info"><button className="asset-name-button" title={asset.name} onClick={() => tags(asset)}>{asset.name}</button><small>{asset.ext.toUpperCase()} · {(asset.size / 1024).toFixed(1)} KB{asset.duration != null ? ` · ${asset.duration.toFixed(1)} 秒` : ""}{!asset.online ? " · 离线" : ""}</small><div className="tags">{asset.tags.map(t => <span key={t}>{t}</span>)}</div></div>
              <div className="folder-asset-actions"><button className="icon-button" title={"编辑标签：" + asset.name} onClick={() => tags(asset)}><Tag size={16}/></button><button className="icon-button" title={"移动到文件夹：" + asset.name} disabled={busy || !asset.online} onClick={() => move(asset)}><FolderInput size={16}/></button><button className="icon-button" title={"加入项目：" + asset.name} disabled={busy} onClick={() => void perform(() => addToProject([asset.id]))}><FolderOpen size={16}/></button><button className="icon-button" title={"定位素材：" + asset.name} disabled={busy || !asset.online} onClick={() => void perform(async () => { await request(`/assets/${asset.id}/reveal`, {}); })}><ExternalLink size={16}/></button></div>
            </article>;
          })}</div>
          {result.pages > 1 && <div className="pagination"><button className="icon-button" title="上一页文件夹素材" disabled={page === 1 || loading} onClick={() => setPage(p => p - 1)}><ChevronLeft size={17}/></button><span>{page} / {result.pages}</span><button className="icon-button" title="下一页文件夹素材" disabled={page >= result.pages || loading} onClick={() => setPage(p => p + 1)}><ChevronRight size={17}/></button></div>}
        </> : <div className="empty-state"><FolderOpen size={34}/><p>暂无素材目录</p></div>}
      </div>
    </div>
    {preview && <ProjectMediaDialog key={preview.id} asset={preview} close={() => setPreview(null)} stopAudio={stopAudio} label="文件夹素材预览"/>}
  </section>;
}
