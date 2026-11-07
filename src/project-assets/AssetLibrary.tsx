import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Save, Users, Globe2, Archive, Copy, ImagePlus, ArrowUp, ArrowDown, GripVertical, Settings, X, RefreshCw, Search, FolderKanban, FolderOpen } from 'lucide-react';
import type { ProjectAssetProps } from '../ProjectAssetWorkspace';
import { readMemory, readStored, saveStored } from '../browser-preferences';
import './asset-library.css';
import {AssociatedShots} from './AssociatedShots';
import {ProjectScript} from './ProjectScript';
import {CharacterVoice} from './CharacterVoice';
import {ReferenceImageImport,ReferencePreview} from './ReferenceImageImport';
import {ProjectSelector} from '../ProjectSelector';
import {ReferenceImageViewer} from './ReferenceImageViewer';

type Kind = 'character' | 'scene' | 'prop';
type Look = { id: string; name: string; description: string; tags: string[]; default_image_id: string | null; archived_at: number | null; revision?: number };
type Binding = { id: string; look_id: string | null; media_asset_id: string; reference_type: string; purpose: string; locks: string; ignores: string; confirmed: boolean; archived_at: number | null; crop: { x: number; y: number; zoom: number }; last_known_name?: string; accept_current?: boolean; revision?: number };
type Asset = { id: string; project_id: string; kind: Kind; name: string; base_info: string; performance_info: string; details: Record<string, string>; revision: number; default_look_id: string | null; default_image_id: string | null; archived_at: number; storyboard_protected?: boolean; looks: Look[]; images: Binding[]; updated_at: number; created_at: number; source: null | { project_name: string; asset_name: string; revision: number; copied_at: number }; cover?: Binding | null; look_count?: number };
type Scope = { id: string; name: string; project_kind: string };
type Health = { id: string; state: string; label: string };
const labels: Record<Kind, string> = { character: '人物', scene: '场景', prop: '道具' };
const date = (v: number) => new Date(v).toLocaleString('zh-CN');
const preview = (b: Binding) => '/api/project-assets/bindings/' + b.id + '/preview';
const empty = (s: string) => <div className="ca-empty">{s}</div>;
function Field({ label, value, onChange, long = false, placeholder, rows = 4 }: { label: string; value: string; onChange: (v: string) => void; long?: boolean; placeholder?: string; rows?: number }) {
  return <label className="ca-field"><span>{label}</span>{long
    ? <textarea aria-label={label} rows={rows} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/>
    : <input aria-label={label} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)}/>}</label>;
}
const referenceHints: Record<Kind, { purpose: string; locks: string; ignores: string }> = {
  character: {
    purpose: '说明这张图用来参考什么。\n例如：用于确认人物外貌、服装与三视图结构。',
    locks: '写下需要保持一致的特征。\n例如：发色、脸型、服装款式与标志性配饰。',
    ignores: '写下不需要沿用的内容。\n例如：背景、图片文字、排版与当前姿势。',
  },
  scene: {
    purpose: '说明这张图用来参考什么。\n例如：用于确认空间布局、材质与光线氛围。',
    locks: '写下需要保持一致的特征。\n例如：门窗位置、固定陈设与主要材质。',
    ignores: '写下不需要沿用的内容。\n例如：画面中的路人、文字与临时物品。',
  },
  prop: {
    purpose: '说明这张图用来参考什么。\n例如：用于确认道具外观、结构与使用方式。',
    locks: '写下需要保持一致的特征。\n例如：形状、尺寸比例、材质与磨损痕迹。',
    ignores: '写下不需要沿用的内容。\n例如：拍摄背景、标注文字与无关配件。',
  },
};
function Tags({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState('');
  const add = () => { const next = input.split(/[,，\n]/).map(s => s.trim()).filter(Boolean); if (next.length) onChange([...new Set([...value, ...next])]); setInput(''); };
  return <div className="ca-field"><span>造型类型（可多选、自定义）</span><div className="ca-tag-options">{[...new Set(['日常','职业','特定场合','年龄阶段','剧情状态', ...value])].map(tag => <button type="button" key={tag} aria-pressed={value.includes(tag)} onClick={() => onChange(value.includes(tag) ? value.filter(t => t !== tag) : [...value, tag])}>{tag}</button>)}</div><input aria-label="造型类型（逗号分隔，可多选自定义）" value={input} placeholder="输入自定义类型，回车或离开输入框添加" onChange={e => setInput(e.target.value)} onBlur={add} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}/></div>;
}
function CroppedImage({ binding, alt = '' }: { binding: Binding; alt?: string }) {
  const { x, y, zoom } = binding.crop;
  // Position over the full overflow of the zoomed, cover-fitted source.
  // Moving both the image box and its fitted content keeps either edge reachable.
  return <ReferencePreview src={binding.revision ? preview(binding) : '/api/project-assets/media/' + binding.media_asset_id + '/preview'} alt={alt}
    style={{ position: 'absolute', width: `${zoom * 100}%`, height: `${zoom * 100}%`, maxWidth: 'none',
      left: `${(1 - zoom) * x}%`, top: `${(1 - zoom) * y}%`, objectFit: 'cover', objectPosition: `${x}% ${y}%` }}
    />
}
function Avatar({ a }: { a: Asset }) { const l = a.looks.find(l => l.id === a.default_look_id), b = a.images.find(b => b.id === (a.kind === 'character' ? l?.default_image_id : a.default_image_id)); return <span className="ca-avatar">{b ? <CroppedImage binding={b}/> : a.name.slice(0, 1)}</span>; }

export function AssetLibrary({ focusProject, active, projectSelectorHost, request, activeProject, selectProject, refreshSeconds, onSettings, onOpenShot }: ProjectAssetProps) {
  const api = <T = any,>(url: string, body?: unknown, method?: string) => request<T>('/project-assets' + url, body, method);
  const prefKey = 'shiguang.creative.preferences.v1';
  const remembered = () => readMemory().display ? readStored<{ kind: Kind; layout: string }>(prefKey, { kind: 'character', layout: 'grid' }, (v): v is { kind: Kind; layout: string } => !!v && typeof v === 'object' && ['character', 'scene', 'prop'].includes((v as any).kind) && ['grid','list'].includes((v as any).layout)) : { kind: 'character' as Kind, layout: 'grid' };
  const [scopes, setScopes] = useState<Scope[]>([]), [scope, setScope] = useState(() => readMemory().display ? readStored('shiguang.creative.lastScope.v1', activeProject, (v): v is string => typeof v === 'string') : activeProject), [storage, setStorage] = useState('');
  const readScopePrefs = (id: string) => readMemory().display ? readStored('shiguang.creative.scope.' + id, { ...remembered(), archived: false }, (v): v is { kind: Kind; layout: string; archived: boolean } => !!v && typeof v === 'object' && ['character','scene','prop'].includes((v as any).kind) && ['grid','list'].includes((v as any).layout) && typeof (v as any).archived === 'boolean') : { kind: 'character' as Kind, layout: 'grid', archived: false };
  const [kind, setKind] = useState<Kind>(() => readScopePrefs(scope).kind), [layout, setLayout] = useState(() => readScopePrefs(scope).layout), [q, setQ] = useState(''), [archived, setArchived] = useState(() => readScopePrefs(scope).archived), [page, setPage] = useState(1);
  const [rows, setRows] = useState<Asset[]>([]), [total, setTotal] = useState(0), [draft, setDraft] = useState<Asset | null>(null), [base, setBase] = useState(''), [lookId, setLookId] = useState(''), [tab, setTab] = useState('overview');
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState(''), [conflict, setConflict] = useState<Asset | null>(null), [health, setHealth] = useState<Health[]>([]);
  const [imageViewer, setImageViewer] = useState<{src:string;name:string}|null>(null);
  const [modal, setModal] = useState<any>(null), [mediaQ, setMediaQ] = useState(''), [mediaPage, setMediaPage] = useState(1), [mediaRows, setMediaRows] = useState<any[]>([]), [mediaTotal, setMediaTotal] = useState(0), [versions, setVersions] = useState<any[]>([]);
  const [scopesKnown,setScopesKnown]=useState(false),[scopesError,setScopesError]=useState(''),[scopesRetry,retryScopes]=useState(0);
  const [mediaLoading, setMediaLoading] = useState(false), [listLoading, setListLoading] = useState(false);
  const [scriptView,setScriptView]=useState(false),[scriptDirty,setScriptDirty]=useState(false);const scriptDirtyRef=useRef(scriptDirty);scriptDirtyRef.current=scriptDirty;
  useEffect(() => setImageViewer(null), [active, scope, draft?.id, lookId, tab, kind, scriptView]);
  const modalScroll = useRef<HTMLDivElement>(null);
  const revealingRef=useRef(new Set<string>()),[revealing,setRevealing]=useState<string[]>([]);
  async function revealImage(b:Binding){
    if(revealingRef.current.has(b.id))return;
    if(revealingRef.current.size>=4){setError('正在定位其他图片，请稍后再试');return;}
    revealingRef.current.add(b.id);setRevealing([...revealingRef.current]);setError('');
    try{await request('/assets/'+encodeURIComponent(b.media_asset_id)+'/reveal',{});setNotice('已请求在文件管理器中显示：'+(b.last_known_name||'所选图片'));}
    catch(e:any){setError(e.message||'无法显示图片位置，请检查文件及素材目录是否可用');}
    finally{revealingRef.current.delete(b.id);setRevealing([...revealingRef.current]);}
  }
  const dirty = !!draft && JSON.stringify(draft) !== base, dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const lastActiveProject = useRef(activeProject);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const healthGeneration = useRef(0);
  const generation = useRef(0), drag = useRef<string | null>(null), draftIdRef = useRef(draft?.id); draftIdRef.current = draft?.id;
  const draftRef = useRef(draft); draftRef.current = draft;
  const lookRef=useRef(lookId);lookRef.current=lookId;
  const importedBindings=useRef(new Set<string>()),importActivity=useRef(new Set<string>());
  const importBusy=(working:boolean,owner:string)=>{if(working){importActivity.current.add(owner);setNotice('');setBusy('正在导入图片…');}else{importActivity.current.delete(owner);setBusy(old=>old==='正在导入图片…'&&!importActivity.current.size?'':old);}};
  function importedImage(r:{target:{assetId:string;projectId:string;lookId:string|null};mediaAssetId?:string;fileName:string}){
    if(!r.mediaAssetId||draftIdRef.current!==r.target.assetId||scopeRef.current!==r.target.projectId||r.target.lookId!==null&&lookRef.current!==r.target.lookId)return;
    const id=crypto.randomUUID();
    setDraft(old=>{if(!old||old.archived_at||old.id!==r.target.assetId||old.project_id!==r.target.projectId)return old;const a=structuredClone(old),look=a.looks.find(l=>l.id===r.target.lookId);if(a.kind==='character'&&(!look||look.archived_at))return old;
      a.images.push({id,look_id:r.target.lookId,media_asset_id:r.mediaAssetId!,reference_type:a.kind==='character'?'人物身份':'',purpose:'',locks:'',ignores:'',confirmed:false,archived_at:null,crop:{x:50,y:50,zoom:1},last_known_name:r.fileName});
      if(look&&!look.default_image_id)look.default_image_id=id;else if(a.kind!=='character'&&!a.default_image_id)a.default_image_id=id;importedBindings.current.add(id);return a;});
  }
  const publicScope = scopes.find(s => s.id === scope)?.project_kind === 'public';
  const owner = draft ? scopes.find(s => s.id === draft.project_id) : null;
  const run = async (label: string, fn: () => Promise<void>) => { if (busy) return; setBusy(label); setError(''); try { await fn(); } catch (e: any) { setError(e.message || '操作失败'); } finally { setBusy(''); } };
  const canLeave = () => (!scriptDirtyRef.current || window.confirm('剧本尚未保存，确定切换吗？未保存内容仍保留在当前页面。')) && (!dirtyRef.current || window.confirm('当前修改尚未保存，确定放弃这些修改吗？'));
  function changeScope(next: string) {
    if (next === scope || !canLeave()) return;
    const pref = readScopePrefs(next); generation.current++; healthGeneration.current++; scopeRef.current = next;
    setScope(next); setRows([]); setTotal(0); setListLoading(!!next && active);
    setDraft(null); setBase(''); setLookId(''); setTab('overview'); setConflict(null); setHealth([]); setVersions([]); setError(''); setNotice('');
    if(scopes.find(s=>s.id===next)?.project_kind==='public')setScriptView(false);
    setKind(scopes.find(s => s.id === next)?.project_kind === 'public' ? 'character' : pref.kind); setLayout(pref.layout); setArchived(pref.archived); setPage(1); setQ('');
    if (scopes.find(s => s.id === next)?.project_kind === 'normal') selectProject(next);
  }
  function install(a: Asset) { if (draftRef.current?.id !== a.id || draftRef.current?.revision !== a.revision) setHealth([]); setDraft(a); setBase(JSON.stringify(a)); setLookId(old => draftIdRef.current === a.id && a.looks.some(l => l.id === old) ? old : a.default_look_id ?? a.looks.find(l => !l.archived_at)?.id ?? ''); setConflict(null); }
  const edit = (fn: (a: Asset) => void) => setDraft(old => { if (!old || old.archived_at) return old; const next = structuredClone(old); fn(next); return next; });
  async function loadList() {
    if (!active || !scope) return;
    const ticket = ++generation.current; setListLoading(true);
    try {
      const result = await api<{ items: Asset[]; total: number }>('/assets?' + new URLSearchParams({ project_id: scope, kind, q, archived: String(archived), page: String(page) }));
      if (ticket === generation.current && scopeRef.current === scope) { setRows(result.items); setTotal(result.total); }
    } catch (e) {
      if (ticket === generation.current && scopeRef.current === scope) { setRows([]); setTotal(0); throw e; }
    } finally { if (ticket === generation.current) setListLoading(false); }
  }
  async function loadHealth(a: Asset) { const ticket = ++healthGeneration.current; const result = await api<{ revision: number; images: Health[] }>('/assets/' + a.id + '/health'); if (ticket === healthGeneration.current && draftIdRef.current === a.id && result.revision === a.revision) setHealth(result.images); }
  useEffect(() => {
    if (!active) return;
    let live = true;
    setScopesError('');
    void api<{ items: Scope[]; storage: string }>('/scopes').then(r => {
      if (!live) return;
      setScopes(r.items); setStorage(r.storage);setScopesKnown(true);
      if (!r.items.some(p => p.id === scopeRef.current)) setScope(activeProject && r.items.some(p => p.id === activeProject) ? activeProject : r.items.find(s => s.project_kind === 'normal')?.id || r.items[0]?.id || '');
    }).catch(e => { if (live) setScopesError(e.message); });
    return () => { live = false; };
  }, [active, activeProject,scopesRetry]);
  useEffect(() => { if (lastActiveProject.current === activeProject) return; lastActiveProject.current = activeProject; if (activeProject && activeProject !== scope && !dirtyRef.current && !scriptDirtyRef.current) { changeScope(activeProject); } }, [activeProject]);
  useEffect(() => {
    let live = true;
    setRows([]); setTotal(0); setListLoading(false);
    if (active) { setError(''); void loadList().catch(e => { if (live) setError(e.message); }); }
    return () => { live = false; generation.current++; };
  }, [active, scope, kind, q, archived, page]);
  useEffect(() => {
    if (!active || !draft || draft.project_id !== scope || dirty || busy || modal) return;
    let live = true;
    // Other pages can update this asset's manifest protection without changing its revision.
    void api<Asset>('/assets/' + draft.id).then(a => {
      if (live && scopeRef.current === scope && draftIdRef.current === a.id) {
        if (!dirtyRef.current && a.revision >= (draftRef.current?.revision ?? 0)) install(a);
        else if (dirtyRef.current && a.revision > (draftRef.current?.revision ?? 0)) setConflict(a);
      }
    }).catch(e => { if (live && scopeRef.current === scope && draftIdRef.current === draft.id) setError(e.message); });
    return () => { live = false; };
  }, [active, scope]);
  useEffect(() => { if (readMemory().display) { saveStored(prefKey, { kind, layout }); saveStored('shiguang.creative.lastScope.v1', scope); if (scope) saveStored('shiguang.creative.scope.' + scope, { kind, layout, archived }); } }, [kind, layout, scope, archived]);
  useEffect(() => { if (!active || !draft) return; let live = true; void loadHealth(draft).catch(e => { if (live) setError(e.message); }); return () => { live = false; healthGeneration.current++; }; }, [active, draft?.id, draft?.revision]);
  useEffect(() => { const before = (e: BeforeUnloadEvent) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', before); return () => window.removeEventListener('beforeunload', before); }, []);
  useEffect(() => {
    if (!active || !refreshSeconds || !draft) return;
    let running = false, live = true; const timer = window.setInterval(async () => { if (running || dirtyRef.current || document.hidden || modal || busy) return; running = true; try { const current = await api<Asset>('/assets/' + draft.id); if (live && draftIdRef.current === draft.id && current.revision !== draft.revision) setConflict(current); } catch (e: any) { if (live && draftIdRef.current === draft.id) setError(e.message); } finally { running = false; } }, refreshSeconds * 1000);
    return () => { live = false; clearInterval(timer); };
  }, [active, refreshSeconds, draft?.id, draft?.revision, modal, busy]);
  useEffect(() => {
    if (modal?.type !== 'media') return;
    let live = true; setMediaLoading(true); modalScroll.current?.scrollTo(0, 0);
    request<any>('/assets?' + new URLSearchParams({ kind: 'photo', q: mediaQ, page: String(mediaPage), pageSize: '40' }))
      .then(r => { if (live) { setMediaRows(r.items ?? r.assets ?? []); setMediaTotal(r.total ?? 0); } })
      .catch(e => { if (live) { setMediaRows([]); setMediaTotal(0); setError(e.message); } })
      .finally(() => { if (live) setMediaLoading(false); });
    return () => { live = false; };
  }, [modal?.type, mediaQ, mediaPage]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [!!modal]);
  const lastFocusProject=useRef(-1);
  useEffect(()=>{if(active&&focusProject?.id&&lastFocusProject.current!==focusProject.request){lastFocusProject.current=focusProject.request;if(scope!==focusProject.id)changeScope(focusProject.id);}},[active,focusProject?.request]);
  async function openAsset(id: string) { if (!canLeave()) return; await run('正在读取资料…', async () => { const a = await api<Asset>('/assets/' + id); if (a.project_id === scopeRef.current) { install(a); setTab('overview'); } }); }
  async function save() { if (!draft || draft.archived_at || importActivity.current.size) return; await run('正在保存资产…', async () => { try { const a = await api<Asset>('/assets/' + draft.id, { asset: draft, expected_revision: draft.revision }, 'PUT'); install(a); await loadList(); const adopted=a.images.some(b=>!b.archived_at&&importedBindings.current.has(b.id));a.images.forEach(b=>importedBindings.current.delete(b.id));setNotice((adopted?(a.kind==='character'?'已绑定到造型 · ':'已绑定参考图片 · '):'')+'已保存 · V'+a.revision); } catch (e: any) { if (e.message.includes('已经更新')) setConflict(await api<Asset>('/assets/' + draft.id)); throw e; } }); }
  async function toggleArchive() {
    if (!draft || dirty || busy) return;
    await run('正在更新归档状态并重新读取资料…', async () => {
      const updated = await api<Asset>('/assets/' + draft.id + '/archive', { archived: !draft.archived_at, expected_revision: draft.revision });
      // Install the confirmed state first, so a later read failure cannot leave an editable stale draft.
      install(updated); setModal(null); setTab('overview');
      setNotice(updated.archived_at ? '已归档，资料只读；恢复后可继续编辑。' : '已恢复，可继续编辑。');
      await loadList();
      install(await api<Asset>('/assets/' + updated.id));
    });
  }
  async function create() { if (!scope || !canLeave()) return; setModal({ type: 'create', name: '' }); }
  const currentLook = draft?.looks.find(l => l.id === lookId), images = draft?.images.filter(b => b.look_id === (draft.kind === 'character' ? lookId : null)) ?? [];
  const representative = draft?.kind === 'character' ? currentLook?.default_image_id : draft?.default_image_id;
  function setDefault(a: Asset, id: string | null) { if (a.kind === 'character') { const l = a.looks.find(l => l.id === lookId); if (l) l.default_image_id = id; } else a.default_image_id = id; }
  function moveImage(id: string, delta: number, target?: string) { if (draft?.archived_at || currentLook?.archived_at || images.find(b => b.id === id)?.archived_at) return; edit(a => { const activeIds = a.images.filter(b => b.look_id === (a.kind === 'character' ? lookId : null) && !b.archived_at).map(b => b.id), from = activeIds.indexOf(id), to = target ? activeIds.indexOf(target) : from + delta; if (from < 0 || to < 0 || to >= activeIds.length) return; const [moved] = activeIds.splice(from, 1); activeIds.splice(to, 0, moved); const byId = new Map(a.images.map(b => [b.id, b])); let cursor = 0; a.images = a.images.map(b => activeIds.includes(b.id) ? byId.get(activeIds[cursor++])! : b); }); }
  async function openCopy() { if (!draft || dirty) { setError('请先保存当前人物，再复制到其他项目'); return; } const target = scopes.find(s => s.id !== draft.project_id && s.project_kind === 'normal')?.id ?? scope; await run('正在准备复制…', async () => { const p = await api<any>('/assets/' + draft.id + '/copy-preview?project_id=' + target); setModal({ type: 'copy', ...p, project_id: target, name: draft.name, base_info: draft.base_info, performance_info: draft.performance_info }); }); }

  return <section className="ca-workspace" aria-label="项目资产库" aria-busy={!!busy}>
    {active && projectSelectorHost && createPortal(<ProjectSelector projects={scopes} value={scope} disabled={!!busy||!!modal} onChange={changeScope} label="资产所属项目" caption="资产所属" allowEmpty={false}/>, projectSelectorHost)}
    <header className="ca-toolbar"><div><small>项目设计和管理</small><h1>项目资产 <span>{storage.toUpperCase()}</span></h1></div><div className="ca-tools"><button onClick={onSettings}><Settings size={16}/>界面设置</button></div></header>
    <div className="ca-tabs" role="tablist" aria-label="资产类别">{(Object.keys(labels) as Kind[]).map(k => <button role="tab" key={k} aria-selected={!scriptView && kind === k} disabled={!!busy || publicScope && k !== 'character'} onClick={() => { if (!canLeave()) return;setScriptView(false); setKind(k); setDraft(null); setPage(1); }}>{labels[k]}</button>)}<button role="tab" aria-selected={scriptView} disabled={!!busy||publicScope||!scopes.some(s=>s.id===scope&&s.project_kind==='normal')} onClick={()=>{if(scriptView||!canLeave())return;setModal(null);setScriptView(true);}}>剧本</button><span>{publicScope ? <><Globe2 size={14}/>公共人物可复制到任意项目</> : '资料保存到当前素材管理器数据库'}</span></div>
    {(error||scopesError) && <div className="ca-alert" role="alert">{error||scopesError}{scopesError&&<button onClick={()=>retryScopes(n=>n+1)}>重试项目范围</button>}<button aria-label="关闭错误" onClick={() => {setError('');if(scopesKnown)setScopesError('');}}><X size={14}/></button></div>}{notice && <div className="ca-notice" role="status">{notice}<button aria-label="关闭通知" onClick={() => setNotice('')}><X size={14}/></button></div>}
    {busy && <div className="ca-progress" role="status"><span className="spinner"/>{busy}</div>}
    <div hidden={!scriptView}><ProjectScript projectId={scope} visible={active&&scriptView&&!publicScope} request={request} onDirtyChange={setScriptDirty}/></div>
    <div hidden={scriptView}><fieldset className="ca-interaction" disabled={!!busy}><div className="ca-columns"><aside className="ca-library" aria-label="当前项目资产列表" aria-busy={listLoading||!scopesKnown&&!scopesError}><div className="ca-library-tools"><input aria-label="搜索资产" placeholder={'搜索' + labels[kind]} value={q} onChange={e => { setQ(e.target.value); setPage(1); }}/><button className="ca-primary" disabled={!scope || !!busy} onClick={() => void create()}><Plus size={15}/>新建{labels[kind]}</button></div><div className="ca-list-options"><label><input type="checkbox" checked={archived} onChange={e => { setArchived(e.target.checked); setPage(1); }}/>查看归档</label><select aria-label="资产显示方式" value={layout} onChange={e => setLayout(e.target.value)}><option value="grid">卡片</option><option value="list">列表</option></select><span>{!scopesKnown&&!rows.length?(scopesError?'范围未能读取':'正在读取项目范围…'):listLoading?'加载中…':total+' 项'}</span></div>
      {kind === 'character' && <button className="ca-copy-source" onClick={() => { if (!canLeave()) return; setModal({ type: 'import', source_project: scopes.find(s => s.id !== scope)?.id ?? '', source_rows: [], selected: '' }); }}><Copy size={15}/>从其他项目／公共人物库复制</button>}
      {!scopesKnown&&!scopesError&&<div className="ca-progress" role="status">正在读取项目范围…</div>}
      {listLoading && <div className="ca-progress" role="status"><span className="spinner"/>正在加载当前项目的{labels[kind]}…</div>}
      <div className={'ca-cards ca-' + layout}>{rows.filter(a => a.project_id === scope).map(a => <button key={a.id} className={'ca-card' + (draft?.id === a.id ? ' selected' : '')} onClick={() => void openAsset(a.id)}><Avatar a={a}/><div><strong>{a.name}</strong><small>{a.base_info?.slice(0, 65) || '基础信息待完善'}</small><span>{a.kind === 'character' ? `${a.look_count} 套造型` : '参考资料'} · V{a.revision}{a.archived_at ? ' · 已归档' : ''}</span>{a.source && <em>复制自 {a.source.project_name}</em>}</div></button>)}</div>{scopesKnown && !listLoading && !rows.length && !error && !scopesError && empty(scope ? '暂无' + (archived ? '归档' : '') + labels[kind] : '请先选择项目')}
      {total > 40 && <div className="ca-pagination"><button disabled={page === 1} onClick={() => setPage(v => v - 1)}>上一页</button><span>{page} / {Math.ceil(total / 40)}</span><button disabled={page * 40 >= total} onClick={() => setPage(v => v + 1)}>下一页</button></div>}
    </aside><main className="ca-editor">{!draft ? <div className="ca-welcome"><Users size={42}/><h2>建立可复用的{labels[kind]}资料</h2><p>从左侧选择一项，或新建{labels[kind]}。资料与图片可以逐步完善。</p><button className="ca-primary" disabled={!scope || !!busy} onClick={() => void create()}>新建{labels[kind]}</button></div> : <>
      <div className="ca-detail-head"><Avatar a={draft}/><div><div className="ca-asset-title"><h2>{draft.name}</h2><span className="ca-owner-tag">{owner?.project_kind === 'public' ? <><Globe2 size={12}/>公共人物</> : <><FolderKanban size={12}/>项目{labels[draft.kind]} · {owner?.name || '所属项目读取中'}</>}</span></div><small>V{draft.revision} · {dirty ? '有未保存修改' : '已保存'} · 更新于 {date(draft.updated_at)}</small></div><div className="ca-actions">{draft.kind === 'character' && <button disabled={!!busy || dirty || !!draft.archived_at} onClick={() => void openCopy()}><Copy size={15}/>复制到项目</button>}<button title={draft.storyboard_protected?"属于当前分镜清单，请重新初始化后移出清单再归档":undefined} disabled={!!busy || dirty || !!draft.storyboard_protected} onClick={() => void toggleArchive()}><Archive size={15}/>{draft.archived_at ? '恢复' : '归档'}</button><button className="ca-primary" disabled={!!busy || !dirty || !!draft.archived_at} onClick={() => void save()}><Save size={15}/>保存资料</button></div></div>
      {draft.storyboard_protected && <p className="ca-muted">已关联当前项目分镜素材清单：可修改资料与姓名，不能归档。重新初始化并移出清单后解除保护。</p>}
      {!!draft.archived_at && <div className="ca-archive-note" role="status"><Archive size={15}/>该{labels[draft.kind]}已归档，资料和图片设置只读。点击上方“恢复”后可继续编辑。</div>}
      {conflict && <div className="ca-conflict" role="alert"><strong>角色已经更新：当前 V{draft.revision}，数据库 V{conflict.revision}</strong><p>本地修改仍保留。请先比较变化，再决定采用最新资料或核对后合并保存。</p><button onClick={() => setModal({ type: 'compare', latest: conflict })}>比较资料</button><button onClick={() => { if (canLeave()) install(conflict); }}>载入最新资料</button></div>}
      <div className="ca-detail-tabs">{[['overview','资料概览'],['images',draft.kind === 'character' ? '造型与图片' : '参考图片'],...(draft.kind==='character'?[['voice','角色语音']]:[]),['shots','关联镜号'],['history','来源与版本']].map(([v,l]) => <button key={v} className={tab === v ? 'selected' : ''} onClick={() => { setTab(v); if (v === 'history') void api<any[]>('/assets/' + draft.id + '/versions').then(r => { if (draftIdRef.current === draft.id && scopeRef.current === scope) setVersions(r); }).catch(e => { if (draftIdRef.current === draft.id && scopeRef.current === scope) setError(e.message); }); }}>{l}</button>)}</div>
      {tab === 'voice' && draft.kind==='character' && <CharacterVoice key={draft.id} assetId={draft.id} revision={draft.revision} value={draft.details.character_voice} disabled={!!draft.archived_at||!!busy} active={active&&!scriptView} request={request} onChange={value=>{const ownerId=draft.id;edit(a=>{if(a.id===ownerId)a.details.character_voice=value;});}} onBusy={value=>setBusy(current=>value?'正在添加角色语音…':current==='正在添加角色语音…'?'':current)}/> }
      {tab === 'shots' && <AssociatedShots key={draft.id} assetId={draft.id} active={active} request={request} onOpen={onOpenShot}/>}
      {tab === 'overview' && <fieldset disabled={!!draft.archived_at} className="ca-form ca-edit-fields"><Field label={labels[draft.kind] + '名称'} value={draft.name} onChange={v => edit(a => { a.name = v; })}/><Field label={draft.kind === 'character' ? '基础信息' : '自由描述'} long value={draft.base_info} onChange={v => edit(a => { a.base_info = v; })}/>{draft.kind === 'character' ? <><Field label="性格与表演" long value={draft.performance_info} onChange={v => edit(a => { a.performance_info = v; })}/><label className="ca-field"><span>默认造型</span><select aria-label="默认造型" value={draft.default_look_id ?? ''} onChange={e => edit(a => { a.default_look_id = e.target.value || null; })}>{!draft.looks.some(l => !l.archived_at) && <option value="">待完善</option>}{draft.looks.filter(l => !l.archived_at).map(l => <option value={l.id} key={l.id}>{l.name}</option>)}</select></label></> : (draft.kind === 'scene' ? ['空间结构','出入口','固定陈设','人物活动区域','主要材质','光源'] : ['剧情用途','尺寸比例','材质','外观','使用人物','状态说明']).map(k => <Field key={k} label={k} long value={draft.details[k] ?? ''} onChange={v => edit(a => { a.details[k] = v; })}/>)}<p className="ca-muted">名称在本项目内唯一。其他资料可后补；姓名和排序变化不会改变永久编号。</p></fieldset>}
      {tab === 'images' && <div className="ca-image-editor">{draft.kind === 'character' && <><div className="ca-look-list">{draft.looks.map(l => <button key={l.id} className={l.id === lookId ? 'selected' : ''} onClick={() => setLookId(l.id)}>{l.name}{l.id === draft.default_look_id ? ' ★' : ''}{l.archived_at ? '（归档）' : ''}</button>)}<button disabled={!!draft.archived_at} onClick={() => { const id = crypto.randomUUID(); edit(a => { a.looks.push({ id, name: '新造型', description: '', tags: [], default_image_id: null, archived_at: null }); a.default_look_id ??= id; }); setLookId(id); }}><Plus size={14}/>新增造型</button></div>{currentLook && <div className="ca-look-form"><fieldset className="ca-look-fields ca-edit-fields" disabled={!!draft.archived_at || !!currentLook.archived_at}><Field label="造型名称" placeholder="例如：日常造型、工作造型、雨夜造型" value={currentLook.name} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.name = v; })}/><Field label="造型说明" long placeholder="描述这套造型的使用情境与外观特点。例如：工作时穿着，深色外套，衣角略有磨损。" value={currentLook.description} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.description = v; })}/><Tags key={currentLook.id} value={currentLook.tags} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.tags = v; })}/></fieldset><div className="ca-actions"><button disabled={!!draft.archived_at || !!currentLook.archived_at} aria-label="造型上移" onClick={() => edit(a => { const i = a.looks.findIndex(l => l.id === lookId); if (i > 0) [a.looks[i - 1], a.looks[i]] = [a.looks[i], a.looks[i - 1]]; })}><ArrowUp size={14}/>上移</button><button disabled={!!draft.archived_at || !!currentLook.archived_at} aria-label="造型下移" onClick={() => edit(a => { const i = a.looks.findIndex(l => l.id === lookId); if (i >= 0 && i < a.looks.length - 1) [a.looks[i + 1], a.looks[i]] = [a.looks[i], a.looks[i + 1]]; })}><ArrowDown size={14}/>下移</button><button disabled={!!draft.archived_at || !!currentLook.archived_at || currentLook.id === draft.default_look_id} onClick={() => edit(a => { a.default_look_id = lookId; })}>设为默认造型</button><button disabled={!!draft.archived_at} onClick={() => { if (!currentLook.archived_at && currentLook.id === draft.default_look_id && draft.looks.some(l => !l.archived_at && l.id !== lookId)) { setError('请先将其他造型设为默认，再归档当前造型'); return; } edit(a => { const l = a.looks.find(l => l.id === lookId)!; l.archived_at = l.archived_at ? null : Date.now(); if (l.archived_at && a.default_look_id === l.id) a.default_look_id = null; if (!l.archived_at && !a.default_look_id) a.default_look_id = l.id; }); }}>{currentLook.archived_at ? '恢复造型' : '归档造型'}</button></div></div>}</>}
      {(draft.kind !== 'character' || currentLook && !currentLook.archived_at) && <><div className="ca-section-head"><h3>参考图片</h3></div><ReferenceImageImport libraryAction={<button disabled={!!busy || !!draft.archived_at} onClick={() => { setMediaQ(''); setMediaPage(1); setModal({ type: 'media' }); }}><ImagePlus size={16}/>从素材库绑定图片</button>} key={draft.id+':'+(currentLook?.id||'')} target={{assetId:draft.id,projectId:draft.project_id,lookId:draft.kind==='character'?currentLook!.id:null}} context={{projectName:owner?.name||'当前项目',assetName:draft.name,lookName:currentLook?.name||'',revision:draft.revision,kind:draft.kind,available:active&&!scriptView&&!draft.archived_at&&(!currentLook||!currentLook.archived_at)}} disabled={!!busy||!!draft.archived_at} request={request} onReady={importedImage} onBusy={importBusy}/><details className="ca-reference-help"><summary>导入与保存说明</summary><p>导入文件会立即保留在 picture 的项目文件夹；图片关联和代表图需点击“保存资料”后生效，放弃资料不会删除文件。</p><p>拖动或使用箭头调整图片顺序；代表图仅用于列表展示。参考说明选填，不会自动发送给生成工具。</p></details></>}
      <div className="ca-image-grid">{images.map(b => { const h = health.find(h => h.id === b.id); return <article key={b.id} className={'ca-image-card' + (b.archived_at ? ' archived' : '')} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!draft.archived_at && !currentLook?.archived_at && !b.archived_at && drag.current) moveImage(drag.current, 0, b.id); drag.current = null; }}><div className="ca-image-visual"><div className="ca-image-preview">{h && h.state !== 'available' ? <span>{h.label}</span> : <button type="button" className="ca-image-zoom-trigger" aria-label={'放大参考图片：'+(b.last_known_name || '参考图片')} aria-haspopup="dialog" title="双击放大图片" onDoubleClick={() => setImageViewer({src:b.revision ? preview(b) : '/api/project-assets/media/' + b.media_asset_id + '/preview',name:b.last_known_name || '参考图片'})} onClick={e => {if(e.detail===0)setImageViewer({src:b.revision ? preview(b) : '/api/project-assets/media/' + b.media_asset_id + '/preview',name:b.last_known_name || '参考图片'});}}><ReferencePreview src={b.revision ? preview(b) : '/api/project-assets/media/' + b.media_asset_id + '/preview'} alt={b.last_known_name || '参考图片'}/></button>}<span className="ca-image-badge">{b.id === representative ? '默认代表图' : b.archived_at ? '已归档' : '补充参考'}</span></div><div className="ca-image-caption" title={b.last_known_name || '参考图片'}>{b.last_known_name || '参考图片'}</div><button className="ca-reveal-image" disabled={!!busy || revealing.includes(b.id)} aria-busy={revealing.includes(b.id)} onClick={() => void revealImage(b)}><FolderOpen size={15}/>{revealing.includes(b.id)?'正在定位…':'在访达中显示'}</button></div><div className="ca-image-body"><div className="ca-image-actions"><button disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at} draggable={!draft.archived_at && !currentLook?.archived_at && !b.archived_at} aria-label="拖动图片排序" onDragStart={() => { drag.current = b.id; }} onDragEnd={() => { drag.current = null; }}><GripVertical size={14}/></button><button disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at} aria-label="图片上移" onClick={() => moveImage(b.id, -1)}><ArrowUp size={14}/></button><button disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at} aria-label="图片下移" onClick={() => moveImage(b.id, 1)}><ArrowDown size={14}/></button><small>{h?.label ?? (b.revision ? '正在检查…' : '保存时校验图片')}</small></div><fieldset className="ca-reference-fields ca-edit-fields" disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at}><Field label="参考类型" placeholder="例如：身份、服装、材质或空间结构" value={b.reference_type} onChange={v => edit(a => { a.images.find(i => i.id === b.id)!.reference_type = v; })}/>{[['purpose','用途说明'],['locks','锁定内容'],['ignores','忽略内容']].map(([k,l]) => <Field key={k} label={l} long rows={3} placeholder={referenceHints[draft.kind][k as 'purpose']} value={b[k as 'purpose']} onChange={v => edit(a => { (a.images.find(i => i.id === b.id)! as any)[k] = v; })}/>)}</fieldset><div className="ca-reference-footer"><label className="ca-check"><input type="checkbox" disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at} checked={b.confirmed} onChange={e => edit(a => { a.images.find(i => i.id === b.id)!.confirmed = e.target.checked; })}/>已确认参考职责</label><div className="ca-actions"><button disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at || representative === b.id || !!h && h.state !== 'available'} onClick={() => edit(a => setDefault(a, b.id))}>设为代表图</button><button disabled={!!draft.archived_at || !!currentLook?.archived_at} onClick={() => { if (!b.archived_at && b.id === representative && images.some(i => !i.archived_at && i.id !== b.id)) { setError('请先选择另一张默认代表图，再解绑当前图片'); return; } edit(a => { const image = a.images.find(i => i.id === b.id)!; image.archived_at = image.archived_at ? null : Date.now(); if (image.archived_at && representative === b.id) setDefault(a, null); if (!image.archived_at && !representative) setDefault(a, image.id); }); }}>{b.archived_at ? '恢复绑定' : '解绑归档'}</button><button disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at} onClick={() => { setMediaQ(''); setMediaPage(1); setModal({ type: 'media', replace_id: b.id }); }}>重新选择</button>{h?.state === 'changed' && <button disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at} onClick={() => edit(a => { a.images.find(i => i.id === b.id)!.accept_current = true; })}>确认采用当前内容</button>}</div></div><details><summary>头像裁切与库内使用</summary>{(['x','y','zoom'] as const).map(k => <label key={k} className="ca-field"><span>{k === 'x' ? '水平位置' : k === 'y' ? '垂直位置' : '缩放'}</span><input disabled={!!draft.archived_at || !!currentLook?.archived_at || !!b.archived_at} aria-label={'裁切' + k} type="range" min={k === 'zoom' ? 1 : 0} max={k === 'zoom' ? 3 : 100} step={k === 'zoom' ? .05 : 1} value={b.crop[k]} onChange={e => edit(a => { a.images.find(i => i.id === b.id)!.crop[k] = Number(e.target.value); })}/></label>)}<span className="ca-avatar ca-crop-preview"><CroppedImage binding={b} alt="头像裁切预览"/></span><button onClick={() => void run('正在查询使用位置…', async () => { const rows = await api<any[]>('/media/' + b.media_asset_id + '/usage'); setModal({ type: 'usage', rows }); })}>查看库内使用位置</button></details></div></article>; })}</div>{!images.length && empty(draft.kind === 'character' && !currentLook ? '先新增造型，再绑定参考图片' : '还没有参考图片，可稍后补充')}</div>}
      {tab === 'history' && <div className="ca-form"><p>创建于 {date(draft.created_at)} · 当前 V{draft.revision}</p>{draft.source ? <div className="ca-source"><strong>复制来源：{draft.source.project_name} / {draft.source.asset_name}</strong><p>来源 V{draft.source.revision} · {date(draft.source.copied_at)}</p><small>当前副本独立编辑；共用的原图片文件仍受素材库可用性影响。</small></div> : <p className="ca-muted">在当前项目创建</p>}<code>{draft.id}</code><h3>数据版本</h3>{versions.map(v => <div className="ca-version" key={v.id}><strong>V{v.version}</strong><span>{v.summary} · {date(v.created_at)}</span><button onClick={() => void run('正在读取版本…', async () => { setModal({ type: 'version', data: await api('/assets/' + draft.id + '/versions/' + v.version) }); })}>查看</button></div>)}</div>}
    </>}</main></div></fieldset></div>
    {active && !scriptView && tab==='images' && imageViewer && <ReferenceImageViewer src={imageViewer.src} name={imageViewer.name} onClose={() => setImageViewer(null)}/>}
    {modal && <div className="ca-modal-backdrop"><div className={"ca-modal" + (modal.type === 'media' ? ' ca-media-modal' : '')} role="dialog" aria-modal="true" aria-label={modal.type === 'media' ? '选择素材库图片' : modal.type === 'copy' ? '复制人物' : modal.type === 'import' ? '选择来源人物' : modal.type === 'create' ? '新建资产' : '资料记录'}><header><h2>{modal.type === 'media' ? '选择素材库图片' : modal.type === 'copy' ? '复制人物' : modal.type === 'import' ? '选择来源人物' : modal.type === 'create' ? '新建' + labels[kind] : '资料记录'}</h2><button aria-label="关闭弹窗" disabled={!!busy} onClick={() => setModal(null)}><X size={18}/></button></header>
      {modal.type === 'media' && <div className="ca-media-toolbar"><label className="ca-media-search"><Search size={17}/><input aria-label="搜索图片素材" placeholder="按名称搜索素材库图片" value={mediaQ} onChange={e => { setMediaQ(e.target.value); setMediaPage(1); }}/></label><div className="ca-media-info" role="status">{mediaLoading ? '正在查找图片…' : <>共 {mediaTotal} 张图片<span>{modal.replace_id ? '点击图片，替换当前绑定' : '点击图片，绑定到当前资料'}</span></>}</div></div>}
      <div className="ca-modal-scroll" ref={modalScroll} tabIndex={0} aria-label={modal.type === 'media' ? '可滚动图片列表' : '可滚动弹窗内容'}><fieldset disabled={!!busy} className="ca-modal-content">{error && <div className="ca-alert" role="alert">{error}</div>}
      {modal.type === 'create' && <Field label="新资产名称" value={modal.name} onChange={v => setModal({ ...modal, name: v })}/>}
      {modal.type === 'media' && <><div className="ca-media-picker">{mediaRows.map(m => <button disabled={!!busy || mediaLoading} key={m.id} onClick={() => void run('正在校验图片…', async () => { const h = await api<any>('/media/' + m.id + '/inspect'); if (h.state !== 'available') throw Error(h.label); edit(a => { if (modal.replace_id) { const b = a.images.find(b => b.id === modal.replace_id)!; b.media_asset_id = m.id; b.accept_current = true; b.last_known_name = m.name; } else { const id = crypto.randomUUID(); a.images.push({ id, look_id: a.kind === 'character' ? lookId : null, media_asset_id: m.id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: false, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: m.name }); if (!representative) setDefault(a, id); } }); setModal(null); })}><span className="ca-media-thumb"><img loading="lazy" src={'/api/media/' + m.id + '/original'} alt=""/></span><span className="ca-media-name" title={m.name}>{m.name}</span></button>)}</div>{!mediaLoading && !mediaRows.length && <div className="ca-empty">{mediaQ ? '没有匹配的图片，试试其他名称。' : '暂无图片，请先在素材库添加图片目录。'}</div>}</>}
      {modal.type === 'import' && <><label className="ca-field"><span>来源项目</span><select aria-label="来源项目" value={modal.source_project} onChange={e => setModal({ ...modal, source_project: e.target.value, source_rows: [] })}>{scopes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button disabled={!!busy} onClick={() => void run('正在读取来源人物…', async () => { const r = await api<any>('/assets?' + new URLSearchParams({ project_id: modal.source_project, kind: 'character', page: String(modal.source_page ?? 1) })); setModal({ ...modal, source_rows: r.items, source_total: r.total }); })}>读取人物</button>{modal.source_rows.map((a: Asset) => <button className="ca-source-choice" key={a.id} onClick={() => void run('正在准备复制…', async () => { const p = await api<any>('/assets/' + a.id + '/copy-preview?project_id=' + scope); setModal({ type: 'copy', ...p, project_id: scope, name: a.name, base_info: a.base_info, performance_info: a.performance_info }); })}>{a.name} · V{a.revision}</button>)}{modal.source_total > 40 && <div className="ca-pagination"><button disabled={(modal.source_page ?? 1) === 1} onClick={() => setModal({ ...modal, source_page: (modal.source_page ?? 1) - 1, source_rows: [] })}>上一页</button><span>第 {modal.source_page ?? 1} 页，切换后点击读取人物</span><button disabled={(modal.source_page ?? 1) * 40 >= modal.source_total} onClick={() => setModal({ ...modal, source_page: (modal.source_page ?? 1) + 1, source_rows: [] })}>下一页</button></div>}</>}
      {modal.type === 'copy' && <><p>复制来源：{modal.source.name} · V{modal.source_revision}。将复制未归档造型、图片绑定、职责和默认设置，原图片文件复用。</p><label className="ca-field"><span>目标项目</span><select aria-label="目标项目" value={modal.project_id} disabled={!!modal.pending} onChange={e => setModal({ ...modal, project_id: e.target.value })}>{scopes.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><Field label="复制后人物名称" value={modal.name} onChange={v => setModal({ ...modal, name: v })}/><Field label="复制后基础信息" long value={modal.base_info} onChange={v => setModal({ ...modal, base_info: v })}/><Field label="复制后性格与表演" long value={modal.performance_info} onChange={v => setModal({ ...modal, performance_info: v })}/><p>{modal.source.looks.filter((l: Look) => !l.archived_at).length} 套造型 · {modal.source.images.filter((b: Binding) => !b.archived_at).length} 张图片绑定</p>{modal.pending && <p role="alert">上次复制结果尚未确认，请先查询结果。不要再次创建另一份复制。</p>}</>}
      {modal.type === 'version' && <pre>{JSON.stringify(modal.data, null, 2)}</pre>}{modal.type === 'usage' && <>{modal.rows.map((r: any) => <p key={r.id}>{scopes.find(s => s.id === r.project_id)?.name} / {r.name}{r.archived_at ? '（归档）' : ''} · {r.look_id ? '造型图片' : '资产参考图'}</p>)}{!modal.rows.length && <p>尚无已保存的库内使用记录</p>}</>}
      {modal.type === 'compare' && <><div className="ca-compare"><section><h3>本地编辑</h3><pre>{JSON.stringify(draft, null, 2)}</pre></section><section><h3>数据库最新 V{modal.latest.revision}</h3><pre>{JSON.stringify(modal.latest, null, 2)}</pre></section></div><p>请核对资料。合并以当前本地内容为基础，采用最新版本号后仍需再次保存；再次发生更新时仍会阻止覆盖。</p><button onClick={() => { edit(a => { a.revision = modal.latest.revision; }); setConflict(null); setModal(null); setNotice('已保留本地内容，请完成核对后点击保存资料'); }}>保留本地内容，进入核对保存</button></>}
    </fieldset></div><footer>{modal.type === 'media' && <div className="ca-pagination ca-media-pagination"><span>第 {mediaPage} / {Math.max(1, Math.ceil(mediaTotal / 40))} 页</span><button disabled={!!busy || mediaLoading || mediaPage === 1} onClick={() => setMediaPage(v => v - 1)}>上一页</button><button disabled={!!busy || mediaLoading || mediaPage * 40 >= mediaTotal} onClick={() => setMediaPage(v => v + 1)}>下一页</button></div>}{modal.type === 'create' && <button className="ca-primary" disabled={!!busy || !modal.name.trim()} onClick={() => void run('正在创建资产…', async () => { const a = await api<Asset>('/assets', { project_id: scope, kind, name: modal.name }); install(a); setModal(null); setTab('overview'); setArchived(false); setQ(''); await loadList(); })}>创建并编辑</button>}{modal.type === 'copy' && <>{modal.pending ? <button onClick={() => void run('正在查询复制结果…', async () => { const r = await api<any>('/copies/' + modal.request_id); if (r.completed) { setScope(r.asset.project_id); install(r.asset); setModal(null); setNotice('人物已复制'); } else setModal({ ...modal, pending: false }); })}>查询复制结果</button> : <button className="ca-primary" disabled={!!busy || !modal.name.trim()} onClick={() => void run('正在复制人物…', async () => { try { const a = await api<Asset>('/assets/' + modal.source.id + '/copy', { project_id: modal.project_id, name: modal.name, base_info: modal.base_info, performance_info: modal.performance_info, source_revision: modal.source_revision, request_id: modal.request_id }); setScope(a.project_id); if (scopes.find(s => s.id === a.project_id)?.project_kind === 'normal') selectProject(a.project_id); install(a); setKind('character'); setArchived(false); setQ(''); setPage(1); setModal(null); setNotice('已复制人物，副本可独立编辑'); if (a.project_id === scope) await loadList(); } catch (e: any) { if (!/同名|已经更新|无效|归档/.test(e.message)) setModal({ ...modal, pending: true }); throw e; } })}><Copy size={15}/>确认复制</button>}</>}<button disabled={!!busy} onClick={() => setModal(null)}>关闭</button></footer></div></div>}
  </section>;
}
