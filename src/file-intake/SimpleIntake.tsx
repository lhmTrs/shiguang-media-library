import {useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode} from 'react';
import {ArrowRight, ChevronDown, ChevronRight, Film, Image as ImageIcon, Music, RefreshCw, X} from 'lucide-react';
import {INTAKE_API, bytes, encoded, kindLabel, type IntakeFile, type RoutingOptions, type RoutingProject} from './types';
import {findSibling, newFolderProblem, type DestinationDraft} from './TargetEditor';

export type Row = {
  file: IntakeFile; name: string; destination: DestinationDraft | null; reason: string; hint?: string;
  decision?: 'new-character' | 'new-look' | 'audio-kind'; alternative?: {directory: string; name: string}; fallbackLook?: string | null; manual?: boolean; ready: boolean; checking?: string; problem?: string; newName?: string | null;
};
export type Group = {key: string; title: string; detail: string; tone: 'decide' | 'project' | 'video' | 'library' | 'audio'; rows: Row[]; photos: boolean};

const toneDot: Record<Group['tone'], string> = {decide: 'fi-dot-decide', project: 'fi-dot-project', video: 'fi-dot-video', library: 'fi-dot-library', audio: 'fi-dot-audio'};

/** Small anchored panel. Esc or a click outside closes it; focus moves inside. */
export function Popover({label, onClose, children, align = 'right', style}: {label: string; onClose: () => void; children: ReactNode; align?: 'left' | 'right' | 'fixed'; style?: {top: number; left: number; maxHeight?: number}}) {
  const ref = useRef<HTMLDivElement>(null), [up, setUp] = useState(false);
  // Open upward when the page below has no room (the footer stays fixed).
  useLayoutEffect(() => {if (align === 'fixed') return; const r = ref.current?.getBoundingClientRect(); if (r && r.bottom > window.innerHeight - 72 && r.top - r.height > 60) setUp(true);}, []);
  useEffect(() => {
    const node = ref.current; node?.querySelector<HTMLElement>('select,input,button')?.focus();
    const down = (e: MouseEvent) => {if (node && !node.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-popover-trigger]')) onClose();};
    document.addEventListener('mousedown', down); return () => document.removeEventListener('mousedown', down);
  }, []);
  return <div ref={ref} role="dialog" aria-label={label} className={'fi-popover fi-popover-' + align + (up ? ' fi-popover-up' : '')} style={style} onKeyDown={e => {if (e.key === 'Escape') {e.stopPropagation(); onClose();}}}>{children}</div>;
}

export function Thumb({file, handoffId, ready, size}: {file: IntakeFile; handoffId: string; ready: boolean; size: 'small' | 'large'}) {
  const [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(-1);
  if (file.mediaKind !== 'photo') return <span className={'fi-thumb fi-thumb-' + size + ' fi-thumb-icon'} aria-hidden="true">{file.mediaKind === 'audio' ? <Music size={16}/> : <Film size={16}/>}</span>;
  if (!ready) return <span className={'fi-thumb fi-thumb-' + size + ' fi-thumb-wait'} role="status" aria-label={'正在准备预览 ' + file.name}><span className="fi-spinner"/></span>;
  if (failed === attempt) return <span className={'fi-thumb fi-thumb-' + size + ' fi-thumb-failed'} role="alert">图片预览未能显示<button onClick={() => setAttempt(n => n + 1)}><RefreshCw size={11}/>重新读取</button></span>;
  const src = '/api' + INTAKE_API + '/handoffs/' + encoded(handoffId) + '/files/' + encoded(file.id) + '/preview' + (attempt ? '?retry=' + attempt : '');
  return <img key={src} className={'fi-thumb fi-thumb-' + size} src={src} alt={file.name} onError={() => setFailed(attempt)}/>;
}

/** Project picker + three asset kinds. Only existing projects; new looks need the usual confirmation. */
export function PutPopover({options, count, defaultProject, onApply, onClose}: {
  options: RoutingOptions; count: number; defaultProject?: string; onClose: () => void;
  onApply: (destination: DestinationDraft) => void;
}) {
  const [projectId, setProjectId] = useState(defaultProject && options.projects.some(p => p.id === defaultProject) ? defaultProject : options.projects[0]?.id || '');
  const project: RoutingProject | undefined = options.projects.find(p => p.id === projectId);
  const [tab, setTab] = useState<'character' | 'scene' | 'prop'>('character');
  const characters = project?.assets.filter(a => a.kind === 'character') || [], assets = project?.assets.filter(a => a.kind === tab) || [];
  const [characterId, setCharacterId] = useState(''), [lookId, setLookId] = useState(''), [newLook, setNewLook] = useState(''), [assetId, setAssetId] = useState('');
  const character = characters.find(c => c.id === characterId) || characters[0], look = character?.looks.find(l => l.id === lookId);
  const lookName = lookId === '__new' ? newLook.trim() : look?.name || character?.looks.find(l => l.id === character.defaultLookId)?.name || character?.looks[0]?.name || '';
  const asset = assets.find(a => a.id === assetId);
  const can = !!project && (tab === 'character' ? !!character && !!lookName : !!asset);
  const apply = () => {
    if (!can || !project) return;
    onApply(tab === 'character' ? {kind: 'photo', scope: 'project', projectId: project.id, characterName: character!.name, lookName}
      : {kind: 'photo', scope: 'project', projectId: project.id, assetKind: tab, assetId: asset!.id, assetRevision: asset!.revision});
  };
  return <Popover label="放进项目" onClose={onClose}>
    <div className="fi-pop-title">把 {count} 张放进
      <select aria-label="放进哪个项目" value={projectId} onChange={e => {setProjectId(e.target.value); setCharacterId(''); setLookId(''); setAssetId('');}}>{options.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    </div>
    {!options.projects.length ? <p className="fi-muted">还没有可用的项目。请先在拾光里新建项目，再回来刷新。</p> : <>
      <div className="fi-seg fi-seg-wide" role="group" aria-label="放进哪一类">{(['character', 'scene', 'prop'] as const).map(k => <button key={k} aria-pressed={tab === k} onClick={() => {setTab(k); setAssetId('');}}>{k === 'character' ? '人物' : k === 'scene' ? '场景' : '道具'}</button>)}</div>
      {tab === 'character' ? characters.length ? <>
        <label>人物<select aria-label="人物" value={character?.id || ''} onChange={e => {setCharacterId(e.target.value); setLookId('');}}>{characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>造型<select aria-label="造型" value={lookId || ''} onChange={e => setLookId(e.target.value)}>{!lookId && <option value="">默认造型{character?.looks.length ? '' : '（将新建）'}</option>}{character?.looks.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}<option value="__new">新造型…</option></select></label>
        {lookId === '__new' && <label>新造型名称<input aria-label="新造型名称" value={newLook} onChange={e => setNewLook(e.target.value)} placeholder="例如：泳衣"/></label>}
      </> : <p className="fi-muted">这个项目还没有人物。名字写成「人物_造型」可以在窗口里确认新建。</p>
        : assets.length ? <div className="fi-pop-list" role="radiogroup" aria-label={tab === 'scene' ? '场景' : '道具'}>{assets.map(a => <button key={a.id} role="radio" aria-checked={asset?.id === a.id} onClick={() => setAssetId(a.id)}>{a.name}</button>)}</div>
        : <p className="fi-muted">这个项目还没有{tab === 'scene' ? '场景' : '道具'}。</p>}
      {can && <p className="fi-pop-result">{tab === 'character' ? (lookId === '__new' ? '将新建造型「' + lookName + '」' : '放到「' + character!.name + ' · ' + lookName + '」') : '放到' + (tab === 'scene' ? '场景' : '道具') + '「' + asset!.name + '」'}</p>}
    </>}
    <div className="fi-pop-actions"><button onClick={onClose}>取消</button><button className="fi-primary" disabled={!can} onClick={apply}>放进去</button></div>
  </Popover>;
}

export function CategoryPopover({categories, count, onApply, onClose}: {categories: {id: string; name: string; relativePath: string}[]; count: number; onApply: (directory: string) => void; onClose: () => void}) {
  return <Popover label="改分类" onClose={onClose}>
    <div className="fi-pop-title">把 {count} 张移到</div>
    <div className="fi-pop-list" role="list">{categories.map(c => <button key={c.id || 'pending'} role="listitem" onClick={() => onApply(c.id)}>{c.id ? c.relativePath || c.name : '待确认'}</button>)}</div>
    <p className="fi-muted">要新建分类，点照片旁的「改…」。</p>
  </Popover>;
}

export function FolderPopover({options, projectId, folderId, count, onApply, onClose}: {options: RoutingOptions; projectId: string; folderId: string; count: number; onApply: (projectId: string, folderId: string, newFolder?: string) => void; onClose: () => void}) {
  const [p, setP] = useState(projectId), [f, setF] = useState(folderId), [name, setName] = useState(''), project = options.projects.find(x => x.id === p);
  const folders = project?.videoFolders || [], same = findSibling(folders, f, name), problem = name.trim() ? newFolderProblem(name) : '';
  const apply = () => {if (!project || problem) return; if (name.trim() && !same) onApply(p, f, name.trim().normalize('NFC')); else onApply(p, same ? same.id : f);};
  return <Popover label="改视频去处" onClose={onClose}>
    <div className="fi-pop-title">把 {count} 个视频放进</div>
    <label>项目<select aria-label="视频项目" value={p} onChange={e => {setP(e.target.value); setF('root');}}>{options.projects.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    <label>文件夹<select aria-label="视频文件夹" value={f} onChange={e => setF(e.target.value)}>{folders.map(x => <option key={x.id} value={x.id}>{x.id === 'root' ? '项目根目录' : x.relativePath || x.name}</option>)}</select></label>
    <label>在这里新建（可不填）<input aria-label="新文件夹名字" value={name} onChange={e => setName(e.target.value)} placeholder="例如：A"/></label>
    <small className={problem ? 'fi-error' : 'fi-muted'}>{problem || (same ? '已有同名文件夹「' + same.relativePath + '」，直接放进去' : name.trim() ? '点「收纳」时才真正建；取消收纳不会留下空文件夹' : '')}</small>
    <div className="fi-pop-actions"><button onClick={onClose}>取消</button><button className="fi-primary" disabled={!project || !!problem} onClick={apply}>放进去</button></div>
  </Popover>;
}

export function RowName({row, compact = false}: {row: Row; compact?: boolean}) {
  // Narrow tiles show the new name first and keep the original as a quiet second line.
  if (compact && row.newName && row.newName !== row.file.name) return <><strong className="fi-row-name" title={row.newName}>{row.newName}</strong><small title={row.file.name}>原名 {row.file.name}</small></>;
  return row.newName && row.newName !== row.file.name
    ? <span className="fi-rename"><span className="fi-rename-from" title={row.file.name}>{row.file.name}</span><ArrowRight size={13} aria-label="改名为"/><strong title={row.newName}>{row.newName}</strong></span>
    : <strong className="fi-row-name" title={row.name}>{row.name}</strong>;
}

export function GroupHeader({group, open, toggle, children, strip}: {group: Group; open: boolean; toggle: () => void; children?: ReactNode; strip?: ReactNode}) {
  return <div className="fi-group-head">
    <button className="fi-group-toggle" aria-expanded={open} onClick={toggle}>{open ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}<span className={'fi-dot ' + toneDot[group.tone]}/><strong>{group.title}</strong><span className="fi-muted">{group.rows.length} {group.photos ? '张' : '个'}{group.detail ? ' · ' + group.detail : ''}</span></button>
    {!open && strip}
    <span className="fi-group-actions">{children}</span>
  </div>;
}

export function RemoveButton({file, disabled, onRemove}: {file: IntakeFile; disabled: boolean; onRemove: () => void}) {
  return <button className="fi-icon-button" disabled={disabled} aria-label={'移除 ' + file.name} onClick={onRemove}><X size={14}/></button>;
}

export const fileMeta = (row: Row) => [row.file.mediaKind === 'photo' ? '照片' : row.file.mediaKind === 'audio' ? '音频' : '视频', bytes(row.file.bytes)].join(' · ');
export const libraryTitle = (kind: keyof typeof kindLabel, directory: string) => kindLabel[kind] + ' › ' + (directory || '待确认');
export {ImageIcon};

/**
 * Project picker drawn by the page (not a native <select>): the macOS menu a native select opens
 * in the intake window can't take the page's font and falls back to a serif face. Recently used
 * projects come first with the reason; a search box appears once there are more than eight.
 */
export function ProjectPicker({projects, value, placeholder, recent, disabled, onChange, linkLabel}: {
  projects: RoutingProject[]; value: string; placeholder: string; recent: {id: string; why: string}[];
  disabled?: boolean; onChange: (projectId: string) => void;
  /** Shown as a quiet text link (e.g. 换集…) instead of the project-name button. */
  linkLabel?: string;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase(), match = (p: RoutingProject) => !q || p.name.toLowerCase().includes(q);
  const recentRows = recent.map(r => ({project: projects.find(p => p.id === r.id), why: r.why})).filter((r): r is {project: RoutingProject; why: string} => !!r.project && match(r.project));
  const rest = projects.filter(p => match(p) && !recentRows.some(r => r.project.id === p.id));
  const flat = [...recentRows.map(r => r.project), ...rest];
  const current = projects.find(p => p.id === value);
  const close = () => {setOpen(false); setQuery(''); setActive(0);};
  const pick = (p: RoutingProject | undefined) => {if (p) onChange(p.id); close();};
  useEffect(() => {if (!open) return; setActive(Math.max(0, flat.findIndex(p => p.id === value))); if (projects.length <= 8) listRef.current?.focus();}, [open]);
  useEffect(() => {listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({block: 'nearest'});}, [active, open]);
  const keys = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {e.preventDefault(); setActive(i => Math.min(flat.length - 1, i + 1));}
    else if (e.key === 'ArrowUp') {e.preventDefault(); setActive(i => Math.max(0, i - 1));}
    else if (e.key === 'Enter') {e.preventDefault(); pick(flat[active]);}
  };
  const option = (p: RoutingProject, i: number, why?: string) => <div key={p.id} id={'fi-project-' + p.id} role="option" aria-selected={p.id === value} data-active={i === active}
    className="fi-picker-option" onMouseEnter={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => pick(p)}>
    <span>{p.name}</span>{why && <small>{why}</small>}</div>;
  return <span className="fi-anchor">
    {linkLabel ? <button type="button" className="fi-link fi-picker-link" data-popover-trigger aria-label={linkLabel.replace(/…$/, '')} aria-haspopup="listbox" aria-expanded={open}
      data-value={value} disabled={disabled} onClick={() => open ? close() : setOpen(true)}>{linkLabel}</button>
    : <button type="button" className={'fi-picker' + (open ? ' fi-picker-open' : '')} data-popover-trigger aria-label="整批项目" aria-haspopup="listbox" aria-expanded={open}
      data-value={value} disabled={disabled} title="选一个项目，名字里没写项目的文件都去这里；名字里写了项目的、单独设置过的不受影响"
      onClick={() => open ? close() : setOpen(true)} onKeyDown={e => {if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {e.preventDefault(); setOpen(true);}}}>
      <span className={current ? '' : 'fi-picker-placeholder'}>{current ? current.name : placeholder}</span><ChevronDown size={14} aria-hidden="true"/>
    </button>}
    {open && <Popover label="选择项目" align={linkLabel ? 'right' : 'left'} onClose={close}>
      <div className="fi-picker-pop" onKeyDown={keys}>
        {projects.length > 8 && <input className="fi-picker-search" aria-label="搜索项目" placeholder="搜索项目" value={query} autoFocus
          onChange={e => {setQuery(e.target.value); setActive(0);}} aria-controls="fi-project-list" aria-activedescendant={flat[active] ? 'fi-project-' + flat[active].id : undefined}/>}
        <div ref={listRef} id="fi-project-list" className="fi-picker-list" role="listbox" aria-label="项目" tabIndex={projects.length > 8 ? -1 : 0}
          aria-activedescendant={flat[active] ? 'fi-project-' + flat[active].id : undefined}>
          {recentRows.length > 0 && <div className="fi-picker-label" role="presentation">最近用过</div>}
          {recentRows.map((r, i) => option(r.project, i, r.why))}
          {recentRows.length > 0 && rest.length > 0 && <div className="fi-picker-sep" role="presentation"/>}
          {rest.length > 0 && recentRows.length > 0 && <div className="fi-picker-label" role="presentation">全部项目</div>}
          {rest.map((p, i) => option(p, recentRows.length + i))}
          {!flat.length && <p className="fi-muted fi-picker-empty">没有名字含「{query.trim()}」的项目</p>}
        </div>
      </div>
    </Popover>}
  </span>;
}

