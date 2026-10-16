import { useEffect, useRef, useState } from "react";
import { Check, X, Play, FilePenLine, Plus, LoaderCircle } from "lucide-react";
import type { Asset } from "./main";
import { CategoryPairFields } from "./CategoryPairFields";
import { ProjectHistory } from "./ProjectManager";

type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type Category = { id: string; name: string };
type RenamePlan = { items: { ok: boolean; target?: string; error?: string }[]; confirmation: string };
export function AssetEditDialog({ asset, request, close, changed, play, legacyCategories = true }: {
  asset: Asset; request: Request; close: () => void;
  changed: (asset: Asset) => Promise<void>; play: (asset: Asset) => void;
  legacyCategories?: boolean;
}) {
  const [current, setCurrent] = useState(asset);
  const [tags, setTags] = useState(asset.tags);
  const [tagInput, setTagInput] = useState("");
  const [note, setNote] = useState(asset.note);
  const [category, setCategory] = useState(asset.category);
  const [sub, setSub] = useState(asset.sub);
  const [kind, setKind] = useState(asset.kind);
  const [favorite, setFavorite] = useState(!!asset.favorite);
  const [confirmed, setConfirmed] = useState(!!asset.confirmed);
  const [name, setName] = useState(asset.name);
  const [suggestions, setSuggestions] = useState<{ name: string }[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [members, setMembers] = useState<Category[]>([]);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [plan, setPlan] = useState<RenamePlan | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const dirty = tagInput.trim() || JSON.stringify(tags) !== JSON.stringify(current.tags) || note !== current.note || category !== current.category || sub !== current.sub || kind !== current.kind || favorite !== !!current.favorite || confirmed !== !!current.confirmed || name !== current.name;
  function dismiss() { if (!busy && (!dirty || window.confirm("还有未保存的修改，确定放弃并关闭？"))) close(); }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { if (dialog.current?.querySelector('[role="combobox"][aria-expanded="true"]')) return; e.preventDefault(); e.stopImmediatePropagation(); dismiss(); }
      if (e.key === "Tab") {
        const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') || []);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  });
  useEffect(() => {
    let live = true;
    Promise.all([
      request<{ id: string; name: string }[]>("/tags"), legacyCategories ? request<Category[]>("/categories") : Promise.resolve([]),
      legacyCategories ? request<Category[]>(`/assets/${asset.id}/categories`) : Promise.resolve([]),
    ]).then(([t, c, m]) => { if (live) { setSuggestions(t.filter(t => t.id !== "untagged")); setCategories(c); setMembers(m); } })
      .catch(e => { if (live) setError("读取标签或分类失败：" + e.message); });
    return () => { live = false; };
  }, [asset.id, legacyCategories]);
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  }
  function combinedTags() { return [...new Set([...tags, ...tagInput.split(/[,，、\n]/).map(t => t.trim()).filter(Boolean)])]; }
  function addTags() { setTags(combinedTags()); setTagInput(""); }
  async function save() {
    const next = await request<Asset>(`/assets/${asset.id}`, { tags: combinedTags(), note, ... (legacyCategories ? { category, sub } : {}), kind, favorite, confirmed }, "PATCH");
    setCurrent(next); setTags(next.tags); setTagInput("");
    setCategory(next.category); setSub(next.sub); setNote(next.note);
    if (legacyCategories) setMembers(await request<Category[]>(`/assets/${asset.id}/categories`));
    await changed(next); setMessage(legacyCategories ? "标签、属性及主分类已保存" : "标签与属性已保存");
  }
  return <div className="modal-backdrop asset-editor-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div ref={dialog} className="modal asset-editor" role="dialog" aria-modal="true" aria-label="编辑素材详情">
      <div className="modal-head"><h2>编辑素材详情</h2><button className="icon-button" title="关闭编辑" aria-label="关闭编辑" disabled={busy} onClick={dismiss}><X size={18}/></button></div>
      <div className="modal-body">
        <div className="asset-editor-summary"><div><strong>{current.name}</strong><small>{current.ext.toUpperCase()} · {current.duration === null ? "时长未知" : `${Math.floor(current.duration / 60)}:${String(Math.floor(current.duration % 60)).padStart(2, "0")}`} · {(current.size / 1e6).toFixed(1)} MB · {current.online ? "在线" : "离线"}</small></div>
          {["music", "sfx"].includes(current.kind) && <button className="plain" disabled={current.ext === "ncm"} onClick={() => play(current)}><Play size={15}/>试听</button>}</div>
        <fieldset disabled={busy}>
          <h3>标签与备注</h3>
          <div className="tags editable-tags">{tags.map(t => <span key={t}>{t}<button type="button" aria-label={`移除标签：${t}`} onClick={() => setTags(tags.filter(x => x !== t))}><X size={12}/></button></span>)}</div>
          <div className="asset-editor-tag-input"><input aria-label="新增素材标签" placeholder="输入标签，回车添加" value={tagInput} onChange={e => setTagInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addTags(); } }}/><button className="icon-button" title="添加标签" disabled={!tagInput.trim()} onClick={addTags}><Plus size={18}/></button></div>
          <div className="asset-editor-suggestions">{suggestions.filter(t => !tags.includes(t.name) && (!tagInput || t.name.includes(tagInput))).slice(0, 16).map(t => <button key={t.name} className="text-button" onClick={() => { setTags([...tags, t.name]); setTagInput(""); }}><Plus size={12}/>{t.name}</button>)}</div>
          <label className="field">备注<textarea aria-label="素材备注" rows={3} value={note} onChange={e => setNote(e.target.value)}/></label>
          <h3>{legacyCategories ? "属性与分类" : "素材属性"}</h3>
          <div className="asset-editor-grid">
            <label className="field">素材类型<select aria-label="编辑素材类型" value={kind} onChange={e => setKind(e.target.value)}><option value="music">音乐</option><option value="sfx">音效</option><option value="photo">摄影照片</option><option value="video">视频</option></select></label>
            {legacyCategories && <CategoryPairFields category={category} sub={sub} categories={categories} request={request} disabled={busy}
              categoryLabel="编辑主分类" subLabel="编辑子类" onChange={(parent, child) => { setCategory(parent); setSub(child); }}/>}
            <div className="asset-editor-checks"><label><input type="checkbox" checked={favorite} onChange={e => setFavorite(e.target.checked)}/>收藏</label><label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>人工确认</label></div>
          </div>
          {legacyCategories && <div className="asset-editor-members"><small>已归属分类：{members.map(c => c.name).join("、") || "未分类"}</small><div className="asset-editor-tag-input"><select aria-label="选择额外分类" value={extra} onChange={e => setExtra(e.target.value)}><option value="">添加到其他分类</option>{categories.filter(c => c.id !== "uncategorized" && !members.some(m => m.id === c.id)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><button className="plain" disabled={!extra} onClick={() => void perform(async () => { await request("/categories/add", { assetId: asset.id, categoryId: extra }); setMembers(await request<Category[]>(`/assets/${asset.id}/categories`)); setExtra(""); await changed(current); setMessage("已添加到额外分类（即时保存）"); })}><Plus size={15}/>添加</button></div></div>}
          <button className="primary asset-editor-save" onClick={() => void perform(save)}><Check size={15}/>保存标签与属性</button>
          <h3>文件重命名</h3>
          <div className="asset-editor-tag-input"><input aria-label="新文件名" disabled={!current.online} value={name} onChange={e => { setName(e.target.value); setPlan(null); }}/><button className="plain" disabled={!current.online || !name.trim() || name === current.name} onClick={() => void perform(async () => { setPlan(await request<RenamePlan>("/operations/preview", { ids: [asset.id], action: "rename", name })); })}><FilePenLine size={15}/>检查改名</button></div>
          {plan && <div className="asset-editor-rename-plan"><p>{plan.items[0]?.ok ? plan.items[0].target : plan.items[0]?.error}</p>{plan.items[0]?.ok && <button className="plain" onClick={() => void perform(async () => { const result = await request<{ ok: boolean; error?: string }[]>("/operations", { confirmation: plan.confirmation }); setPlan(null); if (!result[0]?.ok) throw Error(result[0]?.error || "改名失败，请重新检查"); const next = await request<Asset>(`/assets/${asset.id}`); setCurrent(next); setName(next.name); await changed(next); setMessage("文件已重命名；未保存的标签仍保留在编辑框中"); })}>确认修改原文件名</button>}</div>}
          <p className="asset-editor-path">{current.path}</p>
          <ProjectHistory assetId={asset.id} request={request}/>
        </fieldset>
      </div>
      <div className="modal-footer asset-editor-footer"><div aria-live="polite">{busy ? <span><LoaderCircle size={15} className="spin"/>处理中…</span> : error ? <span role="alert" className="database-error">{error}</span> : message ? <span>{message}</span> : dirty ? <span>有未保存的修改</span> : null}</div><button className="plain" disabled={busy} onClick={dismiss}>关闭</button></div>
    </div>
  </div>;
}
