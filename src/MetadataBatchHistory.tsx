import { useEffect, useState } from "react";
import { ChevronDown, LoaderCircle, Undo2 } from "lucide-react";

type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type Batch = { id: string; created_ms: number; status: string; reason: string; basis: string; updated: number; skipped: number; undone: number };
type Item = { id: string; before: { name: string; path: string; tags: string[]; note: string }; after: { tags: string[]; note: string }; fields: ("tags" | "note")[]; undone: boolean };
type Detail = { items: Item[]; skipped: { id: string; reason: string }[] };
export function MetadataBatchHistory({ request, changed, runTask }: { request: Request; changed: () => void; runTask: (label: string, fn: () => Promise<void>) => Promise<void> }) {
  const [rows, setRows] = useState<Batch[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [open, setOpen] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(null), [limit, setLimit] = useState(20);
  useEffect(() => {
    let live = true;
    request<Batch[]>("/metadata/batches").then(data => { if (live) setRows(data); }).catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true; setDetail(null); setLimit(20);
    if (open) request<Detail>("/metadata/batches/" + open).then(d => { if (live) setDetail(d); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [open]);
  async function undo(row: Batch) {
    if (!window.confirm(`撤销这批 ${row.updated - row.undone} 个素材的标注修改？\n仅恢复仍与本批结果一致的字段；后续修改、移动或注销的项会保留并跳过。`)) return;
    setBusy(true); setError(""); setNotice("");
    await runTask("正在撤销批量标注…", async () => {
      try {
        const result = await request<{ restored: number; skipped: { id: string; reason: string }[] }>(`/metadata/batches/${row.id}/undo`, {});
        setNotice(`已恢复 ${result.restored} 项，跳过 ${result.skipped.length} 项${result.skipped.length ? "：" + [...new Set(result.skipped.map(i => i.reason))].join("；") : ""}`);
        setRows(await request<Batch[]>("/metadata/batches")); setOpen(null); changed();
      } catch (e) { setError(e instanceof Error ? e.message : "撤销失败"); }
      finally { setBusy(false); }
    });
  }
  return <section className="metadata-history" aria-label="批量标注记录">
    <h3>批量标注记录</h3>
    {loading && <p className="muted"><LoaderCircle className="spin" size={15}/>读取中…</p>}
    {!loading && !rows.length && !error && <p className="muted">暂无批量标注记录</p>}
    {rows.map(row => <div className="metadata-history-row" key={row.id}>
      <div className="metadata-history-heading"><div><strong>{row.reason || "批量标注"}</strong><small>{new Date(row.created_ms).toLocaleString("zh-CN")} · 修改 {row.updated} 项 · 跳过 {row.skipped} 项 · 已撤销 {row.undone} 项</small><small>{({ metadata: "文件名与目录建议", listened: "调用方声明已试听", manual: "人工标注" } as Record<string, string>)[row.basis]}</small></div>
        <button className="icon-button" title="查看修改前后值" aria-label={"查看标注批次：" + row.id} aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}><ChevronDown size={16}/></button>
        <button className="plain" disabled={busy || row.updated === row.undone} onClick={() => void undo(row)}><Undo2 size={14}/>撤销</button>
      </div>
      {open === row.id && <div className="metadata-history-detail">{!detail ? <p className="muted">读取中…</p> : <>
        {detail.items.slice(0, limit).map(item => <div key={item.id}><strong>{item.before.name}{item.undone ? " · 已撤销" : ""}</strong><small>{item.before.path}</small>{item.fields.includes("tags") && <p>标签：{item.before.tags.join("、") || "空"} → {item.after.tags.join("、") || "空"}</p>}{item.fields.includes("note") && <><small>原备注</small><pre>{item.before.note || "（空）"}</pre><small>新备注</small><pre>{item.after.note || "（空）"}</pre></>}</div>)}
        {detail.items.length > limit && <button className="text-button" onClick={() => setLimit(n => n + 20)}>显示更多（剩余 {detail.items.length - limit} 项）</button>}
        {detail.skipped.map((i, n) => <p className="muted" key={i.id + n}>{i.id} · {i.reason}</p>)}
      </>}</div>}
    </div>)}
    {notice && <p className="banner" role="status">{notice}</p>}
    {error && <p className="banner error" role="alert">{error}</p>}
  </section>;
}
