import './project-path-bar.css';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, FolderKanban, Search } from "lucide-react";
import { buildTree, neighbors, seasonName, type Container, type GroupedProject, type Series, type SeriesNode, type Tree } from './model';

// 顶部层级栏（原型 H1–H3）：剧 ▾ › 季 ▾ › 第N集 ▾ + 上一集 / 下一集。每段只列一层，带搜索。
// 剧里有季时中间段一直在（散放的集显示「剧里」），这样从散放集也能切到某一季。
// 只负责“选哪一集”；切换前的草稿 / 忙碌检查、最近打开与各层上次看的集由宿主维护（onSelect 成功后更新）。
export type ProjectPathBarProps = {
  projects: GroupedProject[]; series: Series[]; value: string;
  /** 最近打开的项目 ID，新的在前。 */
  recent: string[];
  /** 各层上次看的集：季用 season_id，剧根用 "root:"+series_id，剧用 "series:"+series_id。 */
  lastInContainer: Record<string, string>;
  onSelect: (projectId: string) => void;
  /** 某部剧或某季还没有集时，给一个去项目页的入口。 */
  onManage?: () => void;
  disabled?: boolean;
};
type Segment = 'series' | 'season' | 'episode';
type Option = { key: string; label: ReactNode; text: string; hint?: string; projectId?: string; disabled?: boolean; current?: boolean; group?: string };

const numberOf = (t: string) => { const v = t.replace(/[第集季]/g, ''); return /^\d+$/.test(v) ? Number(v) : null; };
const pathText = (tree: Tree, p: GroupedProject) => {
  const hit = tree.byProject.get(p.id);
  if (!hit) return p.name;
  return [hit.node.series.name, hit.container.season ? seasonName(hit.container.season) : null, `第${p.episode_no}集`].filter(Boolean).join(' › ');
};
/** 进入一个容器：优先上次看过且仍在里面的集，否则编号最小的现存集。 */
const landIn = (c: Container, last: Record<string, string>) => {
  const remembered = last[c.season ? c.season.id : 'root:' + c.series.id];
  return c.episodes.find(e => e.id === remembered) ?? c.episodes[0] ?? null;
};
const landInSeries = (n: SeriesNode, last: Record<string, string>) => {
  const remembered = last['series:' + n.series.id];
  for (const c of [...n.seasons, n.root]) { const hit = c.episodes.find(e => e.id === remembered); if (hit) return hit; }
  for (const c of [...n.seasons].reverse()) if (c.episodes.length) return landIn(c, last);
  return landIn(n.root, last);
};

export function ProjectPathBar({ projects, series, value, recent, lastInContainer, onSelect, onManage, disabled }: ProjectPathBarProps) {
  const tree = useMemo(() => buildTree(projects, series), [projects, series]);
  const current = projects.find(p => p.id === value);
  const hit = current ? tree.byProject.get(current.id) : null;
  const [open, setOpen] = useState<Segment | null>(null), [query, setQuery] = useState(''), [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null), triggers = useRef<Partial<Record<Segment, HTMLButtonElement | null>>>({});
  const near = current && hit ? neighbors(tree, current.id) : { previous: null, next: null };

  useEffect(() => { setQuery(''); setCursor(0); }, [open]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(null); };
    window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => { if (disabled) setOpen(null); }, [disabled]);

  const choose = (id?: string) => { if (!id || disabled) return; const seg = open; setOpen(null); if (id !== value) onSelect(id); if (seg) triggers.current[seg]?.focus(); };

  // —— 各段的选项 ——
  const options: Option[] = useMemo(() => {
    if (!open) return [];
    const q = query.trim();
    if (open === 'episode' && hit) {
      const n = numberOf(q);
      return hit.container.episodes
        .filter(e => !q || (n != null ? String(e.episode_no).startsWith(String(n)) : e.name.toLowerCase().includes(q.toLowerCase())))
        .sort((a, b) => n != null ? Number(b.episode_no === n) - Number(a.episode_no === n) : 0)
        .map(e => ({ key: e.id, projectId: e.id, current: e.id === value, text: `第${e.episode_no}集`, label: <><b>第 {e.episode_no} 集</b><small>{e.name}</small></> }));
    }
    if (open === 'season' && hit) {
      const n = hit.node, list = [...n.seasons, ...(n.root.episodes.length || !n.seasons.length ? [n.root] : [])];
      return list.filter(c => !q || (c.season ? seasonName(c.season) : '剧里直接放的集').includes(q) || (numberOf(q) != null && c.season?.season_no === numberOf(q)))
        .map(c => { const target = landIn(c, lastInContainer); return { key: c.key, projectId: target?.id, disabled: !target, current: c === hit.container, text: c.season ? seasonName(c.season) : '剧里直接放的集', hint: target ? `${c.episodes.length} 集` : '暂无集', label: <><b>{c.season ? seasonName(c.season) : '剧里直接放的集'}</b><small>{target ? `${c.episodes.length} 集` : '暂无集'}</small></> }; });
    }
    // 剧这一段：有输入就是全局搜索；否则最近打开 + 本剧各层 + 剧 + 未分组。
    if (q) {
      const tokens = q.split(/\s+/).filter(Boolean), nums = tokens.map(numberOf).filter((v): v is number => v != null), words = tokens.filter(t => numberOf(t) == null).map(t => t.toLowerCase());
      return projects.filter(p => {
        const h = tree.byProject.get(p.id), hay = [p.name, h?.node.series.name, h?.container.season ? seasonName(h.container.season) : ''].join(' ').toLowerCase();
        if (!words.every(w => hay.includes(w))) return false;
        if (nums.length === 1) return p.episode_no === nums[0];
        if (nums.length >= 2) return h?.container.season?.season_no === nums[0] && p.episode_no === nums[1];
        return true;
      }).slice(0, 30).map(p => ({ key: 's:' + p.id, projectId: p.id, current: p.id === value, group: '搜索结果', text: pathText(tree, p), label: <span className="ppb-path">{pathText(tree, p)}</span> }));
    }
    const out: Option[] = [];
    for (const id of recent.filter(id => id !== value).slice(0, 5)) { const p = projects.find(x => x.id === id); if (p) out.push({ key: 'r:' + id, projectId: id, group: '最近打开', text: pathText(tree, p), label: <span className="ppb-path">{pathText(tree, p)}</span> }); }
    for (const n of tree.series) { const target = landInSeries(n, lastInContainer); out.push({ key: 'series:' + n.series.id, projectId: target?.id, disabled: !target, current: hit?.node === n, group: '剧', text: n.series.name, label: <><b>{n.series.name}</b><small>{target ? `${n.seasons.length ? n.seasons.length + ' 季 · ' : ''}${n.episodeCount} 集` : '暂无集'}</small></> }); }
    for (const p of tree.ungrouped) out.push({ key: 'u:' + p.id, projectId: p.id, current: p.id === value, group: '未分组', text: p.name, label: <b>{p.name}</b> });
    return out;
  }, [open, query, hit, tree, projects, recent, value, lastInContainer]);

  const enabled = options.filter(o => !o.disabled && o.projectId);
  useEffect(() => { setCursor(c => Math.min(c, Math.max(0, enabled.length - 1))); }, [enabled.length]);
  function popoverKeys(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); const seg = open; setOpen(null); if (seg) triggers.current[seg]?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(c + 1, enabled.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(enabled[cursor]?.projectId); }
  }
  useEffect(() => { root.current?.querySelector<HTMLElement>('.ppb-option[data-active]')?.scrollIntoView?.({ block: 'nearest' }); }, [cursor, open]);

  const segment = (seg: Segment, text: string, title?: string) =>
    <button type="button" className="ppb-seg" data-segment={seg} ref={el => { triggers.current[seg] = el; }} aria-haspopup="dialog" aria-expanded={open === seg} title={title ?? text} disabled={disabled}
      onClick={() => setOpen(o => o === seg ? null : seg)}><span>{text}</span><ChevronDown size={12} aria-hidden="true"/></button>;
  const placeholder = { series: '搜索全部：剧名、季、集号、项目名', season: '搜索季', episode: '输入集号或名字，如 12' }[open ?? 'series'];
  let lastGroup = '';
  const listId = 'ppb-list-' + (open ?? 'none');

  return <div className="ppb" ref={root} data-project={value || undefined} data-disabled={disabled || undefined}>
    <nav className="ppb-crumbs" aria-label="当前项目">
      {!current ? segment('series', '选择项目') : !hit ? segment('series', current.name) : <>
        {segment('series', hit.node.series.name)}
        {hit.node.seasons.length > 0 && <><span className="ppb-sep" aria-hidden="true">›</span>{hit.container.season ? segment('season', seasonName(hit.container.season)) : segment('season', '剧里', '直接放在剧里、不在任何季的集')}</>}
        <span className="ppb-sep" aria-hidden="true">›</span>{segment('episode', `第${current.episode_no}集`, current.name)}
      </>}
    </nav>
    {hit && <>
      <button type="button" className="ppb-step" aria-label={near.previous ? `上一集：第${near.previous.episode_no}集` : '已是这一组的第一集'} title={near.previous ? `上一集：第${near.previous.episode_no}集` : '已是这一组的第一集'} disabled={disabled || !near.previous} onClick={() => near.previous && onSelect(near.previous.id)}><ChevronLeft size={16}/></button>
      <button type="button" className="ppb-step" aria-label={near.next ? `下一集：第${near.next.episode_no}集` : '已是这一组的最后一集'} title={near.next ? `下一集：第${near.next.episode_no}集` : '已是这一组的最后一集'} disabled={disabled || !near.next} onClick={() => near.next && onSelect(near.next.id)}><ChevronRight size={16}/></button>
    </>}
    {open && <div className="ppb-pop" role="dialog" aria-label={open === 'episode' ? '选择这一组的集' : open === 'season' ? '选择季' : '切换剧或项目'} data-seg={open} onKeyDown={popoverKeys}>
      <label className="ppb-search"><Search size={14} aria-hidden="true"/><input autoFocus aria-label={placeholder} placeholder={placeholder} value={query} role="combobox" aria-expanded="true" aria-controls={listId} aria-activedescendant={enabled[cursor] ? 'ppb-opt-' + enabled[cursor].key : undefined} onChange={e => { setQuery(e.target.value); setCursor(0); }}/></label>
      {open === 'episode' && hit && <div className="ppb-head">{hit.container.season ? seasonName(hit.container.season) : hit.node.series.name} · {hit.container.episodes.length} 集</div>}
      <div className="ppb-list" role="listbox" id={listId} aria-label="选项">
        {options.map(o => { const group = o.group && o.group !== lastGroup ? o.group : ''; if (o.group) lastGroup = o.group; const active = !!o.projectId && !o.disabled && enabled[cursor]?.key === o.key; return <div key={o.key}>
          {group && <div className="ppb-group" role="presentation">{group}</div>}
          <div className="ppb-option" role="option" id={'ppb-opt-' + o.key} data-target-project={o.projectId} aria-selected={!!o.current} aria-disabled={o.disabled || !o.projectId || undefined} data-active={active || undefined} data-current={o.current || undefined}
            onPointerDown={e => e.preventDefault()} onClick={() => { if (!o.disabled) choose(o.projectId); }}>{o.label}{o.current && <span className="ppb-check" aria-hidden="true">✓</span>}</div>
        </div>; })}
        {!options.length && <div className="ppb-empty" role="status">{query ? '没有匹配的项' : '暂无项目'}</div>}
      </div>
      {open === 'series' && onManage && <button type="button" className="ppb-manage" onClick={() => { setOpen(null); onManage(); }}><FolderKanban size={14}/>去项目页管理剧和集</button>}
      {open === 'series' && !query && <div className="ppb-foot">输入「穿越 2 37」可直接找到第 2 季第 37 集</div>}
    </div>}
  </div>;
}
