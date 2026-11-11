import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowRight, ChevronDown, ChevronRight, Film, Image as ImageIcon, Music, RefreshCw, X} from 'lucide-react';
import {INTAKE_API, bytes, encoded, kindLabel, type IntakeFile, type RoutingOptions, type RoutingProject} from './types';
import type {DestinationDraft} from './TargetEditor';

export type Row = {
  file: IntakeFile; name: string; destination: DestinationDraft | null; reason: string; hint?: string;
  decision?: 'new-character' | 'audio-kind'; alternative?: {directory: string; name: string}; ready: boolean; checking?: string; problem?: string; newName?: string | null;
};
export type Group = {key: string; title: string; detail: string; tone: 'decide' | 'project' | 'video' | 'library' | 'audio'; rows: Row[]; photos: boolean};

const toneDot: Record<Group['tone'], string> = {decide: 'fi-dot-decide', project: 'fi-dot-project', video: 'fi-dot-video', library: 'fi-dot-library', audio: 'fi-dot-audio'};

/** Small anchored panel. Esc or a click outside closes it; focus moves inside. */
export function Popover({label, onClose, children, align = 'right'}: {label: string; onClose: () => void; children: ReactNode; align?: 'left' | 'right' | 'fixed'}) {
  const ref = useRef<HTMLDivElement>(null), [up, setUp] = useState(false);
  // Open upward when the page below has no room (the footer stays fixed).
  useLayoutEffect(() => {if (align === 'fixed') return; const r = ref.current?.getBoundingClientRect(); if (r && r.bottom > window.innerHeight - 72 && r.top - r.height > 60) setUp(true);}, []);
  useEffect(() => {
    const node = ref.current; node?.querySelector<HTMLElement>('select,input,button')?.focus();
    const down = (e: MouseEvent) => {if (node && !node.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-popover-trigger]')) onClose();};
    document.addEventListener('mousedown', down); return () => document.removeEventListener('mousedown', down);
  }, []);
  return <div ref={ref} role="dialog" aria-label={label} className={'fi-popover fi-popover-' + align + (up ? ' fi-popover-up' : '')} onKeyDown={e => {if (e.key === 'Escape') {e.stopPropagation(); onClose();}}}>{children}</div>;
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

export function FolderPopover({options, projectId, folderId, count, onApply, onClose}: {options: RoutingOptions; projectId: string; folderId: string; count: number; onApply: (projectId: string, folderId: string) => void; onClose: () => void}) {
  const [p, setP] = useState(projectId), [f, setF] = useState(folderId), project = options.projects.find(x => x.id === p);
  return <Popover label="改视频去处" onClose={onClose}>
    <div className="fi-pop-title">把 {count} 个视频放进</div>
    <label>项目<select aria-label="视频项目" value={p} onChange={e => {setP(e.target.value); setF('root');}}>{options.projects.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
    <label>文件夹<select aria-label="视频文件夹" value={f} onChange={e => setF(e.target.value)}>{(project?.videoFolders || []).map(x => <option key={x.id} value={x.id}>{x.id === 'root' ? '项目根目录' : x.relativePath || x.name}</option>)}</select></label>
    <div className="fi-pop-actions"><button onClick={onClose}>取消</button><button className="fi-primary" disabled={!project} onClick={() => onApply(p, f)}>放进去</button></div>
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
