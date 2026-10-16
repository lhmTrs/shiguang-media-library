import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search, Tag, X } from "lucide-react";
export type TagRules = { all: string[]; any: string[]; none: string[] };
export const emptyTagRules = (): TagRules => ({ all: [], any: [], none: [] });
export function TagRuleFilter({ value, tags, change }: { value: TagRules; tags: { name: string; n: number }[]; change: (rules: TagRules) => void }) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState<keyof TagRules>("all"), [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => { if (open) { setSearch(""); setMode("all"); input.current?.focus(); } }, [open]);
  const names = { all: "同时包含", any: "任意包含", none: "排除" };
  const included = value.all.length + value.any.length, count = included + value.none.length;
  const visible = tags.filter(t => t.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const remove = (group: keyof TagRules, tag: string) => change({ ...value, [group]: value[group].filter(t => t !== tag) });
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const toggle = (tag: string) => {
    if (value[mode].includes(tag)) { remove(mode, tag); return; }
    if (value[mode].length >= 20) return;
    // Each tag has one role, avoiding contradictory include/exclude conditions.
    const next = emptyTagRules();
    for (const group of Object.keys(next) as (keyof TagRules)[]) next[group] = value[group].filter(t => t !== tag);
    next[mode].push(tag);
    change(next);
  };
  return <div className="tag-rule-filter" ref={root} onKeyDown={e => { if (e.key === "Escape") { close(); e.stopPropagation(); } }}>
    <button type="button" className="plain" ref={trigger} aria-label="标签筛选" aria-expanded={open} aria-controls="asset-tag-filter-panel" onClick={() => setOpen(v => !v)}><Tag size={16}/><span>{count ? `包含 ${included} · 排除 ${value.none.length}` : "全部标签"}</span><ChevronDown size={14}/></button>
    {open && <div id="asset-tag-filter-panel" className="tag-rule-panel" role="region" aria-label="标签筛选条件">
      <div className="tag-rule-add"><select aria-label="标签匹配方式" value={mode} onChange={e => setMode(e.target.value as keyof TagRules)}>{Object.entries(names).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <label className="tag-rule-search"><Search size={15}/><input ref={input} aria-label="搜索筛选标签" placeholder="搜索标签" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === "Enter") e.preventDefault(); }}/></label></div>
      {count > 0 && <div className="tag-rule-selected">{(Object.keys(names) as (keyof TagRules)[]).filter(k => value[k].length).map(k => <div className="tag-rule-group" key={k}><strong>{names[k]}</strong><div className="tags">{value[k].map(tag => <span key={tag}>{tag}<button type="button" className="icon-button" aria-label={`移除${names[k]}标签：${tag}`} title="移除标签条件" onClick={() => remove(k, tag)}><X size={12}/></button></span>)}</div></div>)}</div>}
      <div className="tag-rule-options" role="group" aria-label="可选筛选标签">{visible.map(tag => {
        const checked = value[mode].includes(tag.name), other = (Object.keys(names) as (keyof TagRules)[]).find(k => k !== mode && value[k].includes(tag.name));
        return <label className="tag-rule-option" key={tag.name}><input type="checkbox" aria-label={tag.name} checked={checked} disabled={!checked && value[mode].length >= 20} onChange={() => toggle(tag.name)}/><span>{tag.name}</span>{other && <small>{names[other]}</small>}<small>{tag.n}</small></label>;
      })}{!visible.length && <p role="status">{search ? "没有匹配的标签" : "暂无标签"}</p>}</div>
      {value[mode].length >= 20 && <p className="tag-rule-limit" role="status">每组最多选择 20 个标签</p>}
      <div className="tag-rule-footer"><button type="button" className="plain" disabled={!count} onClick={() => change(emptyTagRules())}>清空标签条件</button><button type="button" className="primary" onClick={close}>完成</button></div>
    </div>}
  </div>;
}
