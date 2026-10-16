import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

export function CategoryFilter({ value, categories, onChange, ariaLabel = "筛选分类", allLabel = "全部分类", listLabel = "可选分类", emptyMessage = "没有匹配的分类", formatName = name => name.replace(/^\d+_/, ""), disabled = false, showCounts = true, expandLabel }: {
  value: string;
  categories: { category: string; n: number }[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  allLabel?: string;
  listLabel?: string;
  emptyMessage?: string;
  formatName?: (name: string) => string;
  disabled?: boolean;
  showCounts?: boolean;
  expandLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const label = formatName;
  const toggleLabel = expandLabel || ariaLabel.replace(/^筛选/, "展开");
  const keyword = query.trim().toLocaleLowerCase();
  const options = [
    ...(!keyword ? [{ category: "", n: 0 }] : []),
    ...categories.filter(c => c.category.toLocaleLowerCase().includes(keyword)),
  ];
  const index = Math.min(active, Math.max(0, options.length - 1));
  function choose(category: string) {
    onChange(category);
    setOpen(false);
    setQuery("");
  }
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    function outside(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" });
  }, [index, open, listId]);
  return <div className="category-filter" ref={root} onBlur={e => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
  }}>
    <div className="category-filter-control" data-open={open}>
      <input ref={input} role="combobox" aria-label={ariaLabel} aria-autocomplete="list" disabled={disabled}
        aria-expanded={open} aria-controls={listId}
        aria-activedescendant={open && options.length ? `${listId}-${index}` : undefined}
        placeholder={value ? label(value) : allLabel}
        value={open ? query : value ? label(value) : ""}
        onFocus={() => { setQuery(""); setActive(0); setOpen(true); }}
        onClick={() => { if (!open) { setQuery(""); setActive(0); setOpen(true); } }}
        onChange={e => { setQuery(e.target.value); setActive(0); setOpen(true); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setQuery(""); }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) { setQuery(""); setActive(0); setOpen(true); }
            else setActive(Math.max(0, Math.min(options.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
          }
          if (e.key === "Enter" && open) { e.preventDefault(); if (options[index]) choose(options[index].category); }
        }}/>
      <button type="button" className="icon-button" title={toggleLabel} aria-label={toggleLabel} disabled={disabled}
        onMouseDown={e => e.preventDefault()}
        onClick={() => { if (open) setOpen(false); else { input.current?.focus(); setQuery(""); setActive(0); setOpen(true); } }}><ChevronDown size={15}/></button>
    </div>
    {open && <div className="category-filter-menu" role="listbox" id={listId} aria-label={listLabel}>
      {options.map((c, i) => <button type="button" key={c.category} id={`${listId}-${i}`} role="option"
        aria-selected={value === c.category} tabIndex={-1}
        className={index === i ? "is-active" : ""}
        onMouseDown={e => e.preventDefault()}
        onMouseEnter={() => setActive(i)} onClick={() => choose(c.category)}>
        <span>{c.category ? label(c.category) : allLabel}</span>
        {showCounts && !!c.category && <small>{c.n}</small>}
        {value === c.category && <Check size={14}/>}
      </button>)}
      {!options.length && <p role="status">{emptyMessage}</p>}
    </div>}
  </div>;
}
