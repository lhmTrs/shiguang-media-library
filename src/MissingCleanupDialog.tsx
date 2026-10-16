import { useEffect, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";

export type CleanupResult = { removed: number; removedIds: string[]; skipped: { id: string; name: string; reason: string }[] };
type Preview = { confirmation: string; items: { id: string; name: string; path: string; reason: string }[] };
export function MissingCleanupDialog({ ids, request, close, changed }: {
  ids: string[]; request: <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
  close: () => void; changed: (result: CleanupResult) => Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<CleanupResult | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    request<Preview>("/maintenance/files/cleanup/preview", { ids }).then(p => { if (live) setPreview(p); }).catch(e => { if (live) setError(e.message); });
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { live = false; previous?.focus(); };
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (!busy) close(); }
      if (e.key === "Tab") {
        const nodes = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
        if (e.shiftKey && document.activeElement === nodes[0]) { e.preventDefault(); nodes.at(-1)?.focus(); }
        if (!e.shiftKey && document.activeElement === nodes.at(-1)) { e.preventDefault(); nodes[0]?.focus(); }
      }
    };
    document.addEventListener("keydown", handler, true); return () => document.removeEventListener("keydown", handler, true);
  });
  async function clean() {
    if (!preview || busy) return;
    setBusy(true); setError("");
    try {
      const done = await request<CleanupResult>("/maintenance/files/cleanup", { confirmation: preview.confirmation });
      setResult(done); setPreview(null); await changed(done);
    } catch (e) { setPreview(null); setError(e instanceof Error ? e.message : "清理失败，请关闭后重新核对"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <div className="modal" ref={panel} role="dialog" aria-modal="true" aria-label="确认清理失效记录">
      <div className="modal-head"><h2>确认清理失效记录</h2><button className="icon-button" aria-label="关闭清理确认" title="关闭" disabled={busy} onClick={close}><X size={17}/></button></div>
      <div className="modal-body">
        {!result && <p>将清理所选 {ids.length} 条素材的索引、分类关联、分析缓存和操作记录。清理前再次核对文件并备份元数据，不删除原文件。</p>}
        {!preview && !result && !error && <p>核对记录中…</p>}
        {preview?.items.map(a => <div className="missing-cleanup-item" key={a.id}><strong>{a.name}</strong><p>{a.path}</p><small>{a.reason}</small></div>)}
        {result && <><p role="status">已清理 {result.removed} 条，保留 {result.skipped.length} 条。</p>{result.skipped.map(a => <div className="missing-cleanup-item" key={a.id}><strong>{a.name}</strong><p>{a.reason}</p></div>)}</>}
        {error && <p className="database-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer"><button className="plain" disabled={busy} onClick={close}>{result || error ? "关闭" : "取消"}</button>{!result && <button className="danger" disabled={!preview || busy} onClick={() => void clean()}><Trash2 size={15}/>{busy ? "重新检查并清理中…" : "确认清理关联记录"}</button>}</div>
    </div>
  </div>;
}
