import { useEffect, useState } from "react";
import { AudioLines, Check, Download, ExternalLink, LoaderCircle, Pause, Play, RefreshCw, Search, Tag, Trash2, X } from "lucide-react";
import type { Asset } from "./main";
type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type DuplicateFile = Asset & { actualSize: number };
type Group = { sha256: string; files: DuplicateFile[]; size: number; extraBytes: number };
type Report = { id: string; scope: string; createdAt: number; total: number; duplicateFiles: number; extraCopies: number; extraBytes: number; cached: number; hashed: number; groups: Group[]; skipped: { id: string; name: string; path: string; reason: string }[]; markResult?: MarkResult };
type MarkResult = { marked: number; alreadyMarked: number; skipped: { sha256: string; reason: string }[] };
type State = { active: { id: string; scope: string; phase: string; count: number; total: number; cancelled?: boolean } | null; marking: boolean; lastJob?: { status: string; error?: string }; report: Report | null };
const size = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : (n / 1e6).toFixed(2) + " MB";
export function DuplicateAudioManager({ request, play, edit, playingId, isPlaying, changed, trash, canTrash, revision: assetRevision }: {
  request: Request; play: (a: Asset) => void; edit: (a: Asset) => void; playingId?: string; isPlaying: boolean; changed: () => void;
  trash: (a: Asset) => void; canTrash: boolean; revision: number;
}) {
  const [scope, setScope] = useState("sfx"), [force, setForce] = useState(false);
  const [state, setState] = useState<State>({ active: null, marking: false, report: null });
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    setLoading(true);
    async function load() {
      try { const next = await request<State>("/duplicate-audio?scope=" + scope); if (!live) return; setState(next); setError(""); if (next.active || next.marking) timer = setTimeout(() => void load(), 1200); }
      catch (e) { if (live) setError(e instanceof Error ? e.message : "检测结果读取失败"); }
      finally { if (live) setLoading(false); }
    }
    void load(); return () => { live = false; clearTimeout(timer); };
  }, [scope, revision, assetRevision]);
  useEffect(() => { setPage(1); }, [scope, query, state.report?.id]);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setRevision(n => n + 1); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  const report = state.report?.scope === scope ? state.report : null;
  const keyword = query.trim().toLocaleLowerCase();
  const groups = (report?.groups || []).filter(g => g.files.some(f => [f.name, f.path, f.category, f.sub, f.tags.join(" ")].join(" ").toLocaleLowerCase().includes(keyword)));
  const running = !!state.active || state.marking || busy;
  useEffect(() => { setPage(n => Math.min(n, Math.max(1, Math.ceil(groups.length / 20)))); }, [groups.length]);
  return <div className="duplicate-audio-page">
    <section className="library-heading"><div><h1>重复音频</h1><p>文件内容一致 · SHA-256</p></div><div className="heading-tools">
      <button className="plain" disabled={running || loading} onClick={() => void action(async () => { await request("/duplicate-audio/start", { scope, force }); })}><RefreshCw size={16}/>开始检查</button>
      <button className="plain" disabled={!state.active || busy} onClick={() => void action(async () => { await request("/duplicate-audio/cancel", {}); })}><X size={16}/>停止检查</button>
      <button className="primary" disabled={running || !report?.groups.length || loading} onClick={() => {
        if (report && window.confirm(`为这 ${report.duplicateFiles} 个文件添加“重复音频”标签？保留原标签，不删除文件；文件状态已变化的组将跳过。`)) void action(async () => {
          const result = await request<MarkResult>("/duplicate-audio/mark", { scope, reportId: report.id });
          setNotice(`新增标记 ${result.marked} 个，已有标记 ${result.alreadyMarked} 个，跳过 ${result.skipped.length} 组`); changed();
        });
      }}><Tag size={16}/>标记重复音频</button>
    </div></section>
    <div className="duplicate-tools"><select aria-label="重复音频检查范围" value={scope} disabled={running} onChange={e => { setScope(e.target.value); setNotice(""); }}><option value="sfx">音效</option><option value="music">音乐</option><option value="all">全部音频（音乐与音效）</option></select>
      <label className="check-label"><input type="checkbox" checked={force} disabled={running} onChange={e => setForce(e.target.checked)}/>重新计算校验值</label>
      <button className="icon-button" title="刷新检测结果" aria-label="刷新检测结果" disabled={busy} onClick={() => setRevision(n => n + 1)}><RefreshCw size={17}/></button>
      <button className="icon-button" title="导出检测报告" aria-label="导出检测报告" disabled={!report} onClick={() => {
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), url = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = url; a.download = `重复音频-${scope}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}><Download size={17}/></button>
    </div>
    {error && <div className="banner error" role="alert">{error}</div>}
    {notice && <div className="banner" role="status">{notice}</div>}
    {state.lastJob?.error && !state.active && <div className="banner" role="status">{state.lastJob.error}</div>}
    {state.active && <div className="duplicate-progress" role="status"><LoaderCircle size={17} className="spin"/><span>{state.active.cancelled ? "正在停止" : state.active.phase === "stat" ? "核对文件状态" : "校验文件内容"} · {state.active.count} / {state.active.total}</span><progress max={Math.max(1, state.active.total)} value={state.active.count}/></div>}
    {loading && !report ? <div className="empty-state"><LoaderCircle className="spin" size={26}/><p>读取检测结果中…</p></div> : report ? <>
      <div className="duplicate-stats"><div><strong>{report.groups.length}</strong><span>重复组</span></div><div><strong>{report.duplicateFiles}</strong><span>涉及文件</span></div><div><strong>{report.extraCopies}</strong><span>额外副本</span></div><div><strong>{size(report.extraBytes)}</strong><span>额外副本逻辑大小</span></div></div>
      <div className="duplicate-summary"><span>{new Date(report.createdAt).toLocaleString("zh-CN")} · 范围 {report.total} 个 · 跳过 {report.skipped.length} 个 · 复用校验 {report.cached} 个</span><label className="search"><Search size={16}/><input aria-label="搜索重复音频" placeholder="搜索名称、路径或分类" value={query} onChange={e => setQuery(e.target.value)}/></label></div>
      <div className="duplicate-groups">{groups.slice((page - 1) * 20, page * 20).map((group, i) => <details key={group.sha256} className="duplicate-group" open={i < 2 || !!query}>
        <summary><strong>{group.files[0].name}</strong><span>{group.files.length} 个副本 · 单个 {size(group.size)}</span></summary>
        {group.files.map(file => <div className="duplicate-file" key={file.id}><button className="icon-button" title="试听音频" aria-label={"试听重复音频：" + file.name} disabled={file.ext === "ncm" || busy} onClick={() => play(file)}>{playingId === file.id && isPlaying ? <Pause size={17}/> : <Play size={17}/>}</button>
          <div className="duplicate-file-info"><button className="asset-name-button" onClick={() => void action(async () => edit(await request<Asset>("/assets/" + file.id)))}>{file.name}</button><small>{file.path}</small><span>{file.category || "未分类"}{file.sub ? " / " + file.sub : ""}{file.tags.includes("重复音频") && <b className="duplicate-badge"><Check size={12}/>重复音频</b>}</span></div>
          <div className="duplicate-file-actions"><button className="icon-button" title="打开访达所在位置" aria-label={"定位重复音频：" + file.name} disabled={busy} onClick={() => void action(async () => { await request("/assets/" + file.id + "/reveal", {}); changed(); })}><ExternalLink size={17}/></button>
          <button className="icon-button" title="删除音频（移入废纸篓）" aria-label={"删除重复音频：" + file.name} disabled={!canTrash || running || loading || !file.online} onClick={() => void action(async () => {
            const current = await request<Asset>("/assets/" + file.id);
            if (current.trashed || !current.online) throw Error("文件已删除或暂时离线，请刷新检测结果");
            trash(current);
          })}><Trash2 size={17}/></button></div>
        </div>)}
        <small className="duplicate-hash">SHA-256: {group.sha256}</small>
      </details>)}</div>
      {!groups.length && <div className="empty-state"><AudioLines size={30}/><p>{query ? "没有匹配的重复音频" : "未发现内容完全相同的重复音频"}</p></div>}
      {groups.length > 20 && <div className="pagination"><button className="plain" disabled={page <= 1} onClick={() => setPage(n => n - 1)}>上一页</button><span>{page} / {Math.ceil(groups.length / 20)}</span><button className="plain" disabled={page >= Math.ceil(groups.length / 20)} onClick={() => setPage(n => n + 1)}>下一页</button></div>}
      {!!report.skipped.length && <details className="duplicate-skipped"><summary>未完成检查 · {report.skipped.length} 项</summary>{report.skipped.map(file => <p key={file.id}>{file.name}<small>{file.path} · {file.reason}</small></p>)}</details>}
      {!!report.markResult?.skipped.length && <div className="banner" role="status">{report.markResult.skipped.map(g => g.reason).join("；")}</div>}
    </> : <div className="empty-state"><AudioLines size={34}/><p>尚无检测结果</p></div>}
  </div>;
}
