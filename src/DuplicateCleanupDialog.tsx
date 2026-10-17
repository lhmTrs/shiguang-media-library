import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, LoaderCircle, RefreshCw, Trash2, X } from "lucide-react";

type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type Root = { id: string; name: string; path: string; management_order: number; managed_added_ms: number | null; retired: number };
type File = { id: string; name: string; path: string; rootName: string; rootPath: string };
type Skipped = { sha256: string; name: string; reason: string };
type Preview = { confirmation: string; groups: { sha256: string; keep: File; remove: File[] }[]; skipped: Skipped[]; removeCount: number; bytes: number; roots: Root[]; requiresOrderConfirmation: boolean };
type Result = { removed: number; bytes: number; skipped: Skipped[]; warnings: string[]; results: { id: string; ok: boolean }[] };
export function DuplicateCleanupDialog({ scope, reportId, request, close, changed, stopAudio, runTask }: {
  scope: string; reportId: string; request: Request; close: () => void; changed: (ids: string[]) => void;
  stopAudio?: () => void; runTask?: (label: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null), [roots, setRoots] = useState<Root[]>([]);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [result, setResult] = useState<Result | null>(null);
  const [dirty, setDirty] = useState(false), [acknowledged, setAcknowledged] = useState(false), [visible, setVisible] = useState(20);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const previous = document.activeElement as HTMLElement | null;
    request<Preview>("/duplicate-audio/cleanup/preview", { scope, reportId }).then(p => { if (live) { setPreview(p); setRoots(p.roots); } }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; previous?.focus(); };
  }, []);
  useEffect(() => { if (!busy) panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }, [busy]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (!busy) close(); }
      if (e.key === "Tab") {
        const nodes = [...panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]') || []].filter(n => n.offsetParent !== null);
        if (!nodes.length) { e.preventDefault(); return; }
        if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
        if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", handler, true); return () => document.removeEventListener("keydown", handler, true);
  });
  function reorder(index: number, delta: number) {
    const next = [...roots]; [next[index], next[index + delta]] = [next[index + delta], next[index]];
    setRoots(next); setDirty(true); setAcknowledged(false);
  }
  async function saveOrder() {
    setBusy(true); setError(""); setPreview(null);
    try {
      await request("/roots/management-order", { ids: roots.map(r => r.id) });
      const p = await request<Preview>("/duplicate-audio/cleanup/preview", { scope, reportId });
      setPreview(p); setRoots(p.roots); setDirty(false);
    } catch (e) { setError(e instanceof Error ? e.message : "顺序保存失败，请重新打开预览"); }
    finally { setBusy(false); }
  }
  async function clean() {
    if (!preview || busy || dirty) return;
    setBusy(true); setError("");
    const perform = async () => {
      try {
        stopAudio?.();
        const done = await request<Result>("/duplicate-audio/cleanup", { confirmation: preview.confirmation, acknowledgeOrder: acknowledged });
        setResult(done); setPreview(null); changed(done.results.filter(r => r.ok).map(r => r.id));
      } catch (e) {
        setPreview(null); setError(e instanceof Error ? e.message : "清理失败，请重新预览并查看操作记录"); changed([]);
      }
    };
    try { if (runTask) await runTask("正在校验并清理重复音频…", perform); else await perform(); }
    catch (e) { setPreview(null); setError(e instanceof Error ? e.message : "清理失败，请重新预览并查看操作记录"); changed([]); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <div ref={panel} className="modal duplicate-cleanup-dialog" role="dialog" aria-modal="true" aria-label="清理重复音频确认" aria-busy={busy}>
      <div className="modal-head"><h2>{result ? "清理结果" : "清理重复项"}</h2><button className="icon-button" title="关闭" aria-label="关闭重复清理" disabled={busy} onClick={close}><X size={18}/></button></div>
      <div className="modal-body">
        {!result && <p className="muted duplicate-cleanup-scope">范围：{({ sfx: "音效", music: "音乐", all: "全部音频" } as Record<string, string>)[scope]} · 当前完整检测结果</p>}
        {busy && <p className="duplicate-cleanup-loading" role="status"><LoaderCircle className="spin" size={18}/>正在校验文件，请稍候…</p>}
        {!!roots.length && !result && <details className="duplicate-root-order" open={preview?.requiresOrderConfirmation || dirty}>
          <summary>素材库保留顺序</summary>
          <p className="muted">排在前面的素材库优先保留。旧库未记录真实加入时间，请确认顺序。</p>
          <ol>{roots.map((root, i) => <li key={root.id}><span className="duplicate-order-number">{i + 1}</span><div><strong>{root.name}{root.retired ? " · 已注销" : ""}</strong><small title={root.path}>{root.path}</small><small>{root.managed_added_ms ? `加入管理：${new Date(root.managed_added_ms).toLocaleString("zh-CN")}` : "历史加入时间未知"}</small></div><button className="icon-button" title="提高保留优先级" aria-label={`上移素材库：${root.path}`} disabled={busy || i === 0} onClick={() => reorder(i, -1)}><ArrowUp size={16}/></button><button className="icon-button" title="降低保留优先级" aria-label={`下移素材库：${root.path}`} disabled={busy || i === roots.length - 1} onClick={() => reorder(i, 1)}><ArrowDown size={16}/></button></li>)}</ol>
          {dirty && <button className="plain" disabled={busy} onClick={() => void saveOrder()}><RefreshCw size={15}/>应用顺序并更新预览</button>}
        </details>}
        {preview && !result && <>
          <div className="duplicate-cleanup-total"><strong>{preview.removeCount} 份副本</strong><span>{preview.groups.length} 组 · {(preview.bytes / 1e6).toFixed(2)} MB</span></div>
          <p className="duplicate-cleanup-warning">仅移入废纸篓，每组保留一份。剪辑工程引用的旧路径可能失效；项目引用、独立标签或备注冲突的组会跳过。</p>
          {preview.requiresOrderConfirmation && <label className="duplicate-order-ack"><input type="checkbox" disabled={busy || dirty} checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)}/>我已确认上述素材库保留顺序</label>}
          <div className="duplicate-cleanup-groups">{preview.groups.slice(0, visible).map(g => <details key={g.sha256}><summary><CheckCircle2 size={15}/><strong>保留 {g.keep.rootName} / {g.keep.name}</strong><span>清理 {g.remove.length} 份</span></summary><div className="duplicate-keep"><b>保留 · {g.keep.rootName}</b><p>{g.keep.path}</p></div>{g.remove.map(f => <div key={f.id} className="duplicate-remove"><b>移入废纸篓 · {f.rootName}</b><p>{f.path}</p></div>)}</details>)}</div>
          {preview.groups.length > visible && <button className="text-button" onClick={() => setVisible(n => n + 20)}>显示更多（剩余 {preview.groups.length - visible} 组）</button>}
        </>}
        {result && <p className="duplicate-cleanup-total" role="status"><CheckCircle2 size={20}/>已移入废纸篓 {result.removed} 份，跳过 {result.skipped.length} 组</p>}
        {!!(result?.skipped.length || preview?.skipped.length) && <details className="duplicate-cleanup-skipped"><summary>跳过的重复组 · {(result?.skipped || preview?.skipped || []).length}</summary>{(result?.skipped || preview?.skipped || []).map((item, i) => <p key={item.sha256 + i}><strong>{item.name}</strong><small>{item.reason}</small></p>)}</details>}
        {result?.warnings.map(w => <p className="banner" key={w}>{w}</p>)}
        {error && <p className="banner error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button className="plain" disabled={busy} onClick={close}>{result || error ? "关闭" : "取消"}</button>{!result && <button className="danger" disabled={busy || dirty || !preview?.removeCount || preview.requiresOrderConfirmation && !acknowledged} onClick={() => void clean()}><Trash2 size={16}/>确认清理{preview?.removeCount ? ` ${preview.removeCount} 份` : ""}</button>}</div>
    </div>
  </div>;
}
