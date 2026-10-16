import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import type { Asset } from "./main";
import { CategoryPairFields } from "./CategoryPairFields";

export function AssetCategoryDialog({ asset, request, close, changed }: {
  asset: Asset;
  request: <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
  close: () => void;
  changed: (asset: Asset) => Promise<void>;
}) {
  const [category, setCategory] = useState(asset.category);
  const [sub, setSub] = useState(asset.sub);
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const [initialExtras, setInitialExtras] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const saved = useRef(false);
  const dirty = !saved.current && (category !== asset.category || sub !== asset.sub || JSON.stringify(extras) !== JSON.stringify(initialExtras));
  function dismiss() {
    if (!busy && (!dirty || window.confirm("分类修改尚未保存，确定关闭？"))) close();
  }
  useEffect(() => {
    let live = true;
    Promise.all([request<{ id: string; name: string }[]>("/categories"), request<{ id: string; name: string }[]>(`/assets/${asset.id}/categories`)])
      .then(([all, members]) => {
        if (!live) return;
        setOptions(all.filter(c => c.id !== "uncategorized"));
        const ids = members.filter(c => c.name !== asset.category).map(c => c.id);
        setExtras(ids); setInitialExtras(ids);
        setLoaded(true);
      }).catch(e => { if (live) setError("分类读取失败：" + e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [asset.id]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    function keydown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (dialog.current?.querySelector('[role="combobox"][aria-expanded="true"]')) return;
        e.preventDefault(); e.stopImmediatePropagation(); dismiss();
      }
      if (e.key === "Tab") {
        const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)") || []);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  });
  async function save() {
    setBusy(true); setError("");
    try {
      const updated = await request<Asset>("/categories/save", { assetId: asset.id, category: category.trim(), sub: sub.trim(), extraIds: extras });
      saved.current = true;
      await changed(updated);
      close();
    } catch (e) { setError(e instanceof Error ? e.message : "分类保存失败"); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div ref={dialog} className="modal review-category-dialog" role="dialog" aria-modal="true" aria-label="修改素材分类">
      <div className="modal-head"><h2>修改素材分类</h2><button className="icon-button" aria-label="关闭分类编辑" title="关闭" disabled={busy} onClick={dismiss}><X size={17}/></button></div>
      <form onSubmit={e => { e.preventDefault(); if (!busy && !loading && loaded) void save(); }}>
        <div className="modal-body">
          <p className="quick-song-title">{asset.name}</p>
          <CategoryPairFields category={category} sub={sub} categories={options} request={request} disabled={busy || loading || !loaded}
            categoryLabel="待确认主分类" subLabel="待确认子类" onChange={(parent, child) => { saved.current = false; setCategory(parent); setSub(child); }}/>
          <h3 className="category-members-heading">额外分类</h3>
          <label className="field"><input aria-label="搜索额外分类" placeholder="搜索分类" value={query} onChange={e => setQuery(e.target.value)}/></label>
          <div className="category-members-list" role="group" aria-label="素材额外分类">
            {options.filter(c => c.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(c => <label key={c.id}>
              <input type="checkbox" aria-label={"归属分类：" + c.name} checked={c.name === category.trim() || extras.includes(c.id)} disabled={busy || loading || c.name === category.trim()}
                onChange={e => { saved.current = false; setExtras(prev => e.target.checked ? [...prev, c.id] : prev.filter(id => id !== c.id)); }}/>
              <span>{c.name}</span>{c.name === category.trim() && <small>主分类</small>}
            </label>)}
            {loading && <p>读取分类中…</p>}
          </div>
          {error && <p className="database-error" role="alert">{error}</p>}
        </div>
        <div className="modal-footer"><button type="button" className="plain" disabled={busy} onClick={dismiss}>取消</button><button className="primary" disabled={busy || loading || !loaded || (!!category && !options.some(c => c.name === category))} type="submit"><Check size={15}/>{busy ? "保存中…" : "保存分类"}</button></div>
      </form>
    </div>
  </div>;
}
