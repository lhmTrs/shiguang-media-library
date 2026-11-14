import {Fragment, useEffect, useRef, useState} from 'react';
import {Check, Plus} from 'lucide-react';
import {ProjectPicker} from './SimpleIntake';
import {findSibling, newFolderProblem, type DestinationDraft} from './TargetEditor';
import type {IntakeFolder, RoutingProject} from './types';

/**
 * Next single-letter folder at the episode's top level: the largest existing single letter + 1,
 * gaps are not refilled; A when there is none; nothing after Z.
 */
export function nextFolderLetter(folders: IntakeFolder[]) {
  let highest = 0;
  for (const f of folders) {
    if (f.id === 'root' || (f.relativePath || f.name).includes('/')) continue;
    const name = (f.relativePath || f.name).trim().toUpperCase();
    if (/^[A-Z]$/.test(name)) highest = Math.max(highest, name.charCodeAt(0) - 64);
  }
  return highest >= 26 ? null : String.fromCharCode(65 + highest);
}

/** 剧 › 季 › 集 for an episode, the project name otherwise. */
export function placeSegments(project: RoutingProject) {
  const s = project.series;
  return s ? [s.name, ...(s.seasonNo != null ? [s.seasonLabel?.trim() || '第' + s.seasonNo + '季'] : []), '第' + s.episodeNo + '集'] : [project.name];
}

const sorted = (folders: IntakeFolder[]) => folders.filter(f => f.id !== 'root')
  .sort((a, b) => (a.relativePath || a.name).localeCompare(b.relativePath || b.name, 'zh-Hans-CN', {numeric: true}));

/**
 * 放到 + 文件夹: one path from the series down to the folder, and every folder of the episode as a button
 * (sub folders show their path). 「＋ 新建 X」 only names a folder at the episode's top level; it is created
 * when 收纳 is confirmed, and disappears as soon as another folder is picked.
 * Renders four grid cells (two label/value rows) for the parent form grid.
 */
export function VideoDestination({project, projects, recent, destination, remembered, locked, count, onChange}: {
  project: RoutingProject; projects: RoutingProject[]; recent: {id: string; why: string}[];
  destination: DestinationDraft; remembered?: string; locked: boolean; count?: number;
  onChange: (destination: DestinationDraft) => void;
}) {
  const folders = sorted(project.videoFolders || []);
  const folderId = destination.folderId || 'root', pending = destination.newFolder?.name;
  const current = folders.find(f => f.id === folderId);
  const letter = nextFolderLetter(project.videoFolders || []);
  const to = (patch: Partial<DestinationDraft>) => onChange({...destination, newFolder: undefined, ...patch});
  const pick = (id: string) => to({folderId: id});
  const parts = current ? (current.relativePath || current.name).split('/') : [];
  // A path segment goes back to that level; the last one is where the file lands.
  const segments: {text: string; go?: () => void; note?: string}[] = [
    ...placeSegments(project).map((text, i, all) => ({text, go: i === all.length - 1 && (current || pending) ? () => pick('root') : undefined})),
    ...parts.map((text, i) => {
      const id = i < parts.length - 1 ? folders.find(f => (f.relativePath || f.name) === parts.slice(0, i + 1).join('/'))?.id : undefined;
      return {text, go: id ? () => pick(id) : undefined};
    }),
    ...(pending ? [{text: pending, note: '收纳时新建'}] : []),
  ];
  const switchProject = (id: string) => {
    if (id === destination.projectId) return;
    onChange({kind: 'video', scope: 'project', projectId: id, folderId: 'root'});
  };
  return <>
    <span className="fi-form-label">放到</span>
    <nav className="fi-place" aria-label="去处路径">
      {segments.map((s, i) => <Fragment key={i}>
        {i > 0 && <span className="fi-place-sep" aria-hidden="true">›</span>}
        {i === segments.length - 1 ? <strong className="fi-place-end">{s.text}{s.note && <small>（{s.note}）</small>}</strong>
          : s.go && !locked ? <button type="button" className="fi-place-link" onClick={s.go}>{s.text}</button>
          : <span className="fi-place-part">{s.text}</span>}
      </Fragment>)}
      {count && count > 1 ? <span className="fi-muted fi-place-count">{count} 个都放这里</span> : null}
      <span className="fi-grow"/>
      <ProjectPicker projects={projects} value={destination.projectId || ''} placeholder="选择项目" recent={recent} disabled={locked} linkLabel="换集…" onChange={switchProject}/>
    </nav>
    <span className="fi-form-label fi-form-label-top">文件夹</span>
    <div className="fi-chips-wrap">
      <div className="fi-chips" role="group" aria-label="文件夹">
        {folders.map(f => {
          const on = !pending && f.id === folderId, path = f.relativePath || f.name, slash = path.lastIndexOf('/');
          return <button key={f.id} type="button" className={'fi-chip' + (on ? ' fi-chip-on' : '')} aria-pressed={on} aria-label={path} disabled={locked}
            title={on ? '再点一次放回「' + placeSegments(project)[placeSegments(project).length - 1] + '」本身' : path + (f.id === remembered ? '（上次用的）' : '')}
            onClick={() => on ? pick('root') : pick(f.id)}>
            {on && <Check size={13} aria-hidden="true"/>}<span>{slash > 0 && <span className="fi-chip-parent">{path.slice(0, slash + 1)}</span>}{path.slice(slash + 1)}</span>
          </button>;
        })}
        {pending !== undefined ? <PendingFolder name={pending} folders={project.videoFolders || []} locked={locked}
          onRename={name => onChange({...destination, folderId: 'root', newFolder: {name}})}
          onExisting={id => pick(id)} onDrop={() => pick('root')}/>
          : <button type="button" className="fi-chip fi-chip-new" disabled={locked} onClick={() => to({folderId: 'root', newFolder: {name: letter || ''}})}>
            <Plus size={13} aria-hidden="true"/>{letter ? '新建 ' + letter : '新建'}</button>}
      </div>
      {pending !== undefined && newFolderProblem(pending) && pending.trim() && <small className="fi-error" role="alert">{newFolderProblem(pending)}</small>}
    </div>
  </>;
}

/** The pending folder is the selected chip itself, already editable with its name selected. */
function PendingFolder({name, folders, locked, onRename, onExisting, onDrop}: {
  name: string; folders: IntakeFolder[]; locked: boolean;
  onRename: (name: string) => void; onExisting: (id: string) => void; onDrop: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null), [width, setWidth] = useState(0);
  useEffect(() => {ref.current?.focus(); ref.current?.select();}, []);
  useEffect(() => {setWidth(Math.max(3, [...name].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 2 : 1), 0) + 1));}, [name]);
  // Leaving the field settles it: empty means never mind, an existing name means that folder.
  const settle = () => {
    const same = findSibling(folders, 'root', name);
    if (!name.trim()) onDrop(); else if (same) onExisting(same.id);
  };
  return <label className="fi-chip fi-chip-on fi-chip-edit">
    <Check size={13} aria-hidden="true"/>
    <input ref={ref} aria-label="新文件夹名字" value={name} disabled={locked} style={{width: width + 'ch'}}
      onChange={e => onRename(e.target.value)} onBlur={settle}
      onKeyDown={e => {if (e.key === 'Enter' && !(e.metaKey || e.ctrlKey)) {e.preventDefault(); settle(); ref.current?.blur();} else if (e.key === 'Escape') {e.preventDefault(); e.stopPropagation(); onDrop();}}}/>
  </label>;
}

type ClipboardReply = {kind: 'text'; text: string} | {kind: 'empty'} | {kind: 'tooLong'; length: number};
type ClipboardBridge = {postMessage: (message: 'read') => Promise<ClipboardReply>};
const clipboardBridge = () => (window as Window & {webkit?: {messageHandlers?: {readClipboardText?: ClipboardBridge}}}).webkit?.messageHandlers?.readClipboardText;
export const promptLength = (text: string) => Array.from(text.trim()).length;

/**
 * 提示词: a quiet 「＋ 粘贴提示词」 until used. Clicking it asks the native shell for the clipboard text once
 * (only on that click); text arrives in the box, fully selected, so a wrong clipboard is seen at once.
 * No shell, no text, refused or failed: an empty box for ⌘V. Leaving the box folds it into one line.
 */
export function PromptField({value, locked, problem, onChange}: {value: string; locked: boolean; problem?: string; onChange: (text: string) => void}) {
  const [open, setOpen] = useState(false), [notice, setNotice] = useState(''), [reading, setReading] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null), request = useRef(0), edited = useRef(false), alive = useRef(true);
  useEffect(() => () => {alive.current = false;}, []);
  const focusBox = (selectAll: boolean) => requestAnimationFrame(() => {box.current?.focus(); if (selectAll) box.current?.select();});
  async function start() {
    const id = ++request.current; edited.current = false; setNotice(''); setOpen(true); onChange('');
    const bridge = clipboardBridge();
    if (!bridge) {focusBox(false); return;}
    setReading(true);
    try {
      const reply = await bridge.postMessage('read');
      // A late reply never overwrites what was typed meanwhile, nor a newer request.
      if (!alive.current || id !== request.current || edited.current) return;
      if (reply?.kind === 'text' && typeof reply.text === 'string' && reply.text.trim()) {onChange(reply.text); focusBox(true); return;}
      if (reply?.kind === 'tooLong') setNotice('剪贴板里有 ' + reply.length + ' 字，超过 1 万字没有自动填。确实是提示词的话，请直接 ⌘V 粘贴。');
    } catch { /* No clipboard: fall back to the empty box. */ }
    finally {if (alive.current && id === request.current) setReading(false);}
    if (alive.current && id === request.current && !edited.current) focusBox(false);
  }
  const fold = () => {if (!value.trim()) {onChange(''); setOpen(false);} else setOpen(false); setNotice('');};
  const length = promptLength(value);
  return <div className="fi-prompt">
    {open ? <>
      <textarea ref={box} aria-label="提示词" className="fi-prompt-box" value={value} disabled={locked} placeholder={reading ? '正在读取剪贴板…' : '在这里 ⌘V 粘贴提示词'}
        onChange={e => {edited.current = true; onChange(e.target.value);}} onBlur={fold}/>
      <span className="fi-prompt-meta"><span>{length} 字</span><span>· ⌘V 粘贴，点别处收起</span><span className="fi-grow"/>
        <button type="button" className="fi-link-muted" disabled={locked} onMouseDown={e => e.preventDefault()} onClick={() => {request.current++; onChange(''); setOpen(false); setNotice('');}}>不附了</button></span>
    </> : value.trim() ? <div className="fi-prompt-line">
      <span className="fi-prompt-count">已附 {length} 字</span><span className="fi-prompt-head" title={value}>{value.trim().replace(/\s+/g, ' ')}</span>
      <button type="button" className="fi-link" disabled={locked} onClick={() => {setOpen(true); focusBox(false);}}>改</button>
      <button type="button" className="fi-link-muted" disabled={locked} onClick={() => onChange('')}>去掉</button>
    </div> : <button type="button" className="fi-chip fi-chip-new fi-prompt-add" disabled={locked} onClick={() => void start()}><Plus size={13} aria-hidden="true"/>粘贴提示词</button>}
    {notice && <small className="fi-warn-text" role="status">{notice}</small>}
    {problem && <small className="fi-error" role="alert">{problem}</small>}
  </div>;
}
