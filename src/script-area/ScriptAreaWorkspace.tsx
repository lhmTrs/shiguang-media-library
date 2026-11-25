// 侧栏「剧本」：一集（或单独项目）的剧本区。头部、版本条、三个标签（剧本｜泳道图 N｜甲方资料 N）、定稿对话框。
// 选剧和集走顶栏（和「项目资产」一样），这里只读宿主给的当前项目。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ProjectScript, ScriptMentions, type ScriptName } from '../project-assets/ProjectScript';
import { ScriptMarkdown, scriptOutline } from '../project-assets/ScriptMarkdown';
import '../project-assets/asset-library.css';
import { buildTree, displayPath, type GroupedProject, type Series } from '../series/model';
import { dateTime, errorText, scriptBase, timeout } from './api';
import { FinalizeDialog } from './FinalizeDialog';
import { MapsTab, useMapList } from './MapsTab';
import { MaterialsTab, useMaterialList } from './MaterialsTab';
import { versionLabel } from './objects';
import type { Draft, Paged, ScriptRequest, VersionDetail, VersionSummary } from './types';
import { ChevronDown } from 'lucide-react';
import './script-area.css';

type Viewing = { kind: 'draft' } | { kind: 'version' | 'legacy'; id: string };

type Tab = 'script' | 'maps' | 'materials';
export type ScriptAreaProps = {
  active: boolean; projectId: string; projects: GroupedProject[]; series: Series[]; request: ScriptRequest;
  /** 宿主切换当前项目前调用；返回 false 表示不切换。卸载时登记 null。 */
  registerProjectSwitchGuard?: (guard: (() => boolean) | null) => void;
  /** 每变一次就回到「剧本」标签、看草稿（从项目资产的「剧本」标签跳过来时用）。 */
  scriptFocus?: number;
};

function useNames(request: ScriptRequest, projectId: string, active: boolean) {
  const [state, setState] = useState<{ project: string; names: ScriptName[]; status: 'loading' | 'ok' | 'error' }>({ project: '', names: [], status: 'loading' });
  useEffect(() => {
    if (!active || !projectId) return;
    let live = true; setState({ project: projectId, names: [], status: 'loading' });
    void Promise.all((['character', 'scene', 'prop'] as const).map(k => request<{ items: { name: string }[] }>('/project-assets/assets?' + new URLSearchParams({ project_id: projectId, kind: k, q: '', archived: 'false', page: '1' })).then(r => r.items.map(a => ({ kind: k, name: a.name })))))
      .then(all => { if (live) setState({ project: projectId, names: all.flat(), status: 'ok' }); })
      .catch(() => { if (live) setState({ project: projectId, names: [], status: 'error' }); });
    return () => { live = false; };
  }, [request, projectId, active]);
  return state.project === projectId ? state : { project: projectId, names: [], status: 'loading' as const };
}

/** 历史版本（正式版本和原稿存档）：只读阅读视图，样子和草稿的「阅读」一样。 */
function ReadOnlyScript({ request, projectId, version, names }: { request: ScriptRequest; projectId: string; version: VersionSummary; names: ReturnType<typeof useNames> }) {
  const [doc, setDoc] = useState<VersionDetail | null>(null), [error, setError] = useState('');
  const reader = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true; setDoc(null); setError('');
    request<VersionDetail>(scriptBase(projectId) + '/versions/' + encodeURIComponent(version.id), undefined, undefined, timeout())
      .then(d => { if (live) { if (d.id !== version.id) throw Error('版本回执不一致'); setDoc(d); } }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [request, projectId, version.id]);
  const outline = doc ? scriptOutline(doc.content) : [];
  const jump = (line: number) => { const host = reader.current; if (!host) return; let t: HTMLElement | null = null; host.querySelectorAll<HTMLElement>('[data-line]').forEach(el => { if (Number(el.dataset.line) <= line) t = el; }); if (t) host.scrollTop = Math.max(0, (t as HTMLElement).offsetTop - host.offsetTop - 8); };
  return <section className="ca-project-script is-mid sa-readonly" aria-label="项目剧本（只读）">
    <header><div><h2>剧本 · {versionLabel(version)}</h2><p role="status">{error ? '读取失败' : !doc ? '读取中…' : version.kind === 'legacy' ? '剧本区上线前保存的稿子，只读' : `只读 · ${dateTime(version.finalizedAt)} 定稿`}</p></div></header>
    {error && <p className="ca-alert" role="alert">{error}</p>}
    {doc && <div className="ca-script-cols">
      <nav className="ca-script-outline" aria-label="场次大纲"><h3>场次大纲</h3>{outline.length ? <ol>{outline.map(o => <li key={o.line + ':' + o.offset}><button type="button" title={o.text} onClick={() => jump(o.line)}>{o.text}</button></li>)}</ol> : <p className="ca-muted">这一份没有场次标题。</p>}</nav>
      <div className="ca-script-editor">
        <div className="ca-field"><span>剧本标题</span><p className="ca-script-title">{doc.title || '未命名剧本'}</p></div>
        <div className="ca-field ca-script-body"><span>剧本正文</span><div ref={reader} className="ca-script-reader" role="document" aria-label="剧本正文（只读）" tabIndex={0}><ScriptMarkdown text={doc.content}/></div></div>
        <small>{doc.content.length.toLocaleString()} 字</small>
      </div>
      <ScriptMentions text={doc.content} names={names.names} namesStatus={names.status}/>
    </div>}
  </section>;
}

/** 标题旁的「历史版本 ▾」：列出正式版本（写定稿时间）和原稿存档，点了只读打开。没有历史版本时宿主不渲染它。 */
function HistoryMenu({ items, viewing, onPick }: { items: VersionSummary[]; viewing: Viewing; onPick: (v: VersionSummary) => void }) {
  const [open, setOpen] = useState(false), box = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    box.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return <div className="sa-history" ref={box}>
    <button ref={button} type="button" className="sa-history-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)}>历史版本<ChevronDown size={14}/></button>
    {open && <div className="sa-history-menu" role="menu" aria-label="历史版本">
      {items.map(v => <button key={v.id} type="button" role="menuitem" aria-current={viewing.kind !== 'draft' && viewing.id === v.id ? 'true' : undefined} onClick={() => { setOpen(false); onPick(v); }}>
        <b>{versionLabel(v)}</b><small>{v.kind === 'version' ? `${dateTime(v.finalizedAt)} 定稿` : '剧本区上线前保存的稿子'}</small>
      </button>)}
    </div>}
  </div>;
}

export function ScriptAreaWorkspace(props: ScriptAreaProps) {
  const [started, setStarted] = useState(false); useEffect(() => { if (props.active) setStarted(true); }, [props.active]);
  return started ? <div hidden={!props.active}><Workspace {...props}/></div> : null;
}

function Workspace({ active, projectId, projects, series, request, registerProjectSwitchGuard, scriptFocus }: ScriptAreaProps) {
  const tree = useMemo(() => buildTree(projects, series), [projects, series]);
  const project = projects.find(p => p.id === projectId);
  const seriesHit = tree.byProject.get(projectId) ?? null;
  const name = project ? displayPath(tree, projectId, project.name) : '';

  const [tab, setTab] = useState<Tab>('script');
  const [viewing, setViewing] = useState<Viewing>({ kind: 'draft' });
  const [draft, setDraft] = useState<Draft | null>(null), [draftError, setDraftError] = useState('');
  const [versions, setVersions] = useState<{ projectId: string; items: VersionSummary[]; error: string } | null>(null);
  const [dirty, setDirty] = useState(false), dirtyRef = useRef(false); dirtyRef.current = dirty;
  const [finalizing, setFinalizing] = useState(false), [notice, setNotice] = useState('');
  const [reloadMaps, setReloadMaps] = useState(0), [reloadMaterials, setReloadMaterials] = useState(0), [reloadVersions, setReloadVersions] = useState(0);
  const names = useNames(request, projectId, active);
  const maps = useMapList(request, projectId, active, reloadMaps);
  const materials = useMaterialList(request, projectId, active, reloadMaterials);

  useEffect(() => { setViewing({ kind: 'draft' }); setNotice(''); setFinalizing(false); }, [projectId]);
  useEffect(() => { if (scriptFocus) { setTab('script'); setViewing({ kind: 'draft' }); } }, [scriptFocus]);
  // 草稿元信息（头部时间、定稿前的空稿判断）：每次读取领一个编号，回来时不是最新一次、或已经换了项目，就丢掉，
  // 成功和失败都一样（PR154 独验 P2：切项目后旧项目的空草稿晚到，挡住了新项目定稿）。
  const draftTicket = useRef(0), projectRef = useRef(projectId); projectRef.current = projectId;
  const readDraft = useCallback(() => {
    const mine = ++draftTicket.current, pid = projectId;
    if (!pid) return;
    const current = () => mine === draftTicket.current && pid === projectRef.current;
    request<Draft>(scriptBase(pid) + '/draft', undefined, undefined, timeout())
      .then(d => { if (current() && d.projectId === pid) { setDraft(d); setDraftError(''); } })
      .catch(e => { if (current()) setDraftError(errorText(e)); });
  }, [request, projectId]);
  useEffect(() => { setDraft(null); setDraftError(''); if (active) readDraft(); else draftTicket.current++; }, [active, readDraft]);
  useEffect(() => {
    if (!active || !projectId) return;
    const c = new AbortController();
    request<Paged<VersionSummary>>(scriptBase(projectId) + '/versions?limit=100', undefined, undefined, { signal: c.signal })
      .then(r => setVersions({ projectId, items: r.items, error: '' }))
      .catch(e => { if (!c.signal.aborted) setVersions(v => ({ projectId, items: v?.projectId === projectId ? v.items : [], error: errorText(e) })); });
    return () => c.abort();
  }, [request, projectId, active, reloadVersions]);

  // 宿主切项目前：草稿有未保存修改时问一次（未保存内容仍留在页面里，切回来还在）
  useEffect(() => {
    if (!registerProjectSwitchGuard) return;
    registerProjectSwitchGuard(() => !dirtyRef.current || window.confirm('剧本草稿尚未保存，确定切换吗？未保存内容仍保留在当前页面。'));
    return () => registerProjectSwitchGuard(null);
  }, [registerProjectSwitchGuard]);

  const list = versions?.projectId === projectId ? versions.items : [];
  const formal = list.filter(v => v.kind === 'version'), legacy = list.find(v => v.kind === 'legacy');
  const nextNo = Math.max(0, ...formal.map(v => v.versionNo ?? 0)) + 1;
  const viewed = viewing.kind === 'draft' ? null : list.find(v => v.id === viewing.id) ?? null;
  const history = [...formal, ...(legacy ? [legacy] : [])];

  function startFinalize() {
    setNotice('');
    if (dirty) { setNotice('草稿有未保存的修改：先点「保存剧本」，再定稿。定稿只认已经保存的草稿。'); setTab('script'); return; }
    if (draft && draft.projectId === projectId && !draft.content.trim()) { setNotice('草稿是空的，不能定稿。'); return; }
    setFinalizing(true);
  }

  if (!projectId) return <div className="ca-workspace sa-workspace"><div className="ca-welcome"><h2>剧本</h2><p>在顶部选一集，或一个单独项目。</p></div></div>;
  const viewingText = viewing.kind === 'draft'
    ? (draft && draft.projectId === projectId ? (draft.updatedAt ? `当前稿（${dateTime(draft.updatedAt)} 存过）` : '当前稿（还没保存过）') : '当前稿')
    : viewed ? `正在看 ${versionLabel(viewed)}（只读）` + (viewed.kind === 'version' ? ` · ${dateTime(viewed.finalizedAt)} 定稿` : '') : '';
  const currentDigest = draft && draft.projectId === projectId ? draft.contentDigest : null;

  return <div className="ca-workspace ca-v2 sa-workspace" aria-label="剧本区" role="region">
    <header className="sa-head">
      <div>
        <div className="sa-title-row"><h1>{name || '（项目没有读到）'}</h1>
          {history.length > 0 && <HistoryMenu items={history} viewing={viewing} onPick={v => { setViewing({ kind: v.kind, id: v.id }); setTab('script'); }}/>}</div>
        <p className={'sa-viewing' + (viewing.kind === 'draft' ? '' : ' is-readonly')} aria-label="当前看的是">{viewingText}{draftError && viewing.kind === 'draft' && <span className="sa-muted"> · 草稿信息没有读到</span>}
          {viewing.kind !== 'draft' && <button type="button" className="sa-back-current" onClick={() => setViewing({ kind: 'draft' })}>回到当前稿</button>}</p>
        {versions?.error && <p className="sa-muted" role="alert">历史版本没有读到：{versions.error}</p>}
      </div>
      {viewing.kind === 'draft' && <div className="ca-actions"><button className="ca-primary" type="button" onClick={startFinalize}>定稿</button></div>}
    </header>
    {notice && <p className="ca-notice" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></p>}
    <div className="ca-tabs sa-tabs" role="tablist" aria-label="剧本区">
      <button role="tab" aria-selected={tab === 'script'} onClick={() => setTab('script')}>剧本</button>
      <button role="tab" aria-selected={tab === 'maps'} onClick={() => { setTab('maps'); setReloadMaps(n => n + 1); }}>泳道图<span className="ca-tab-count">{maps.loading && !maps.items.length ? '…' : maps.total}</span></button>
      <button role="tab" aria-selected={tab === 'materials'} onClick={() => setTab('materials')}>甲方资料<span className="ca-tab-count">{materials.loading && !materials.items.length ? '…' : materials.items.length}</span></button>
    </div>
    <div className="sa-body">
      <div className="ca-script-host" hidden={tab !== 'script' || viewing.kind !== 'draft'}>
        <ProjectScript projectId={projectId} visible={active && tab === 'script' && viewing.kind === 'draft'} request={request} onDirtyChange={setDirty} names={names.names} namesStatus={names.status}
          draft={{ onSaved: () => readDraft() }}/>
      </div>
      {tab === 'script' && viewed && <ReadOnlyScript request={request} projectId={projectId} version={viewed} names={names}/>}
      {tab === 'maps' && <MapsTab projectId={projectId} request={request} list={maps} currentDigest={currentDigest}/>}
      {tab === 'materials' && <MaterialsTab projectId={projectId} seriesId={seriesHit?.node.series.id ?? null} seriesName={seriesHit?.node.series.name ?? ''} request={request} list={materials} onChanged={() => setReloadMaterials(n => n + 1)}/>}
    </div>
    {finalizing && <FinalizeDialog projectId={projectId} nextNo={nextNo} request={request} onClose={() => setFinalizing(false)} onDone={v => {
      setFinalizing(false); setNotice(`已定稿成 V${v.versionNo}。草稿照旧留着，可以接着改。`); setReloadVersions(n => n + 1); setReloadMaps(n => n + 1); readDraft();
    }}/>}
  </div>;
}
