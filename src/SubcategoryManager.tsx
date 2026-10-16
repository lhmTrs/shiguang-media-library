import { useEffect, useState } from "react";
import { Check, FilePenLine, Plus, Trash2, X } from "lucide-react";
import type { Subcategory } from "./CategoryPairFields";
type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
export function SubcategoryManager({ parentId, request, revision, selected, select, changed }: {
  parentId: string; request: Request; revision: number; selected: string; select: (id: string) => void; changed: () => void;
}) {
  const [rows, setRows] = useState<Subcategory[]>([]);
  const [editor, setEditor] = useState<{ id?: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function load() { setRows(await request<Subcategory[]>("/subcategories?categoryId=" + encodeURIComponent(parentId))); }
  useEffect(() => {
    let live = true;
    request<Subcategory[]>("/subcategories?categoryId=" + encodeURIComponent(parentId)).then(r => { if (live) setRows(r); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [parentId, revision]);
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError("");
    try { await fn(); await load(); changed(); } catch (e) { setError(e instanceof Error ? e.message : "子类操作失败"); }
    finally { setBusy(false); }
  }
  return <section className="subcategory-management" aria-label="子类管理">
    <div className="subcategory-toolbar"><strong>子类</strong><select aria-label="筛选子类" value={selected} onChange={e => select(e.target.value)}>
      <option value="">全部子类</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name}（{row.n}）</option>)}
    </select><button className="icon-button" title="新建子类" aria-label="新建子类" disabled={busy} onClick={() => setEditor({ name: "" })}><Plus size={17}/></button></div>
    {editor && <form className="subcategory-editor" onSubmit={e => { e.preventDefault(); if (busy) return; void action(async () => {
      await request(editor.id ? "/subcategories/" + editor.id : "/subcategories", { categoryId: parentId, name: editor.name }, editor.id ? "PATCH" : "POST"); setEditor(null);
    }); }}><input aria-label="子类名称" autoFocus maxLength={120} value={editor.name} disabled={busy} onChange={e => setEditor({ ...editor, name: e.target.value })}/>
      <button type="submit" className="icon-button" title="保存子类" aria-label="保存子类" disabled={busy || !editor.name.trim()}><Check size={17}/></button>
      <button type="button" className="icon-button" title="取消编辑子类" aria-label="取消编辑子类" disabled={busy} onClick={() => setEditor(null)}><X size={17}/></button></form>}
    <div className="subcategory-rows">{rows.map(row => <div className="subcategory-row" key={row.id}><span>{row.name}</span><small>{row.n} 项</small>
      <button className="icon-button" title="重命名子类" aria-label={"重命名子类：" + row.name} disabled={busy} onClick={() => setEditor({ id: row.id, name: row.name })}><FilePenLine size={15}/></button>
      <button className="icon-button" title="删除子类" aria-label={"删除子类：" + row.name} disabled={busy} onClick={() => {
        if (window.confirm(`删除子类“${row.name}”？关联素材只清空子类，保留主分类和原文件。`)) void action(async () => { await request("/subcategories/" + row.id, {}, "DELETE"); if (selected === row.id) select(""); });
      }}><Trash2 size={15}/></button></div>)}</div>
    {error && <p role="alert" className="database-error">{error}</p>}
  </section>;
}
