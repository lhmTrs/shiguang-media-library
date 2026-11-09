import {useFeedbackToast} from '../global-feedback';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Save, Globe2, Archive, Copy, ImagePlus, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, X, Search, FolderKanban, FolderOpen, MoreHorizontal, Undo2, Maximize2, History, Star, Users } from 'lucide-react';
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
type Receipt = { id: string; status: string; mediaAssetId?: string; fileName: string; error?: string; candidates: { id: string; name: string; reason: string; previewUrl: string }[] };
// 每个拖入项固定导入编号、绑定编号和新造型编号：回应丢失后按原编号核对，不重新上传、不重复绑定。
type DropStage = 'create' | 'look' | 'import' | 'bind' | 'done';
type DropItem = { key: string; file: File; preview: string; name: string; include: boolean; state: 'waiting' | 'working' | 'unknown' | 'duplicate' | 'failed' | 'done'; message: string; stage: DropStage; requestId: string; bindingId: string; newLookId: string; startedAt: number; createPending?: boolean; createAt?: number; preExisting?: string[]; pendingName?: string; adopted?: boolean; claims?: { id: string; name: string; revision: number; created_at: number; images: number; archived: boolean }[]; claimChoice?: string; assetId?: string; lookId?: string | null; mediaAssetId?: string; fileName?: string; receipt?: Receipt; candidate?: string };
type DropJob = { mode: 'create' | 'attach'; kind: Kind; projectId: string; asset?: { id: string; name: string; looks: Look[] }; lookId: string | null; items: DropItem[]; running: boolean };
const labels: Record<Kind, string> = { character: '人物', scene: '场景', prop: '道具' };
const date = (v: number) => new Date(v).toLocaleString('zh-CN');
const preview = (b: Binding) => '/api/project-assets/bindings/' + b.id + '/preview';
const bindingSrc = (b: Binding) => b.revision ? preview(b) : '/api/project-assets/media/' + b.media_asset_id + '/preview';
const empty = (s: string) => <div className="ca-empty">{s}</div>;
const imageFile = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i.test(f.name);
const baseName = (n: string) => n.replace(/\.[^.]+$/, '').trim().slice(0, 120) || '未命名';
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
const detailFields: Record<'scene' | 'prop', string[]> = { scene: ['空间结构','出入口','固定陈设','人物活动区域','主要材质','光源'], prop: ['剧情用途','尺寸比例','材质','外观','使用人物','状态说明'] };
function Tags({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState('');
  const add = () => { const next = input.split(/[,，\n]/).map(s => s.trim()).filter(Boolean); if (next.length) onChange([...new Set([...value, ...next])]); setInput(''); };
  return <div className="ca-field"><span>造型类型（可多选、自定义）</span><div className="ca-tag-options">{[...new Set(['日常','职业','特定场合','年龄阶段','剧情状态', ...value])].map(tag => <button type="button" key={tag} aria-pressed={value.includes(tag)} onClick={() => onChange(value.includes(tag) ? value.filter(t => t !== tag) : [...value, tag])}>{tag}</button>)}</div><input aria-label="造型类型（逗号分隔，可多选自定义）" value={input} placeholder="输入自定义类型，回车或离开输入框添加" onChange={e => setInput(e.target.value)} onBlur={add} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}/></div>;
}
function CroppedImage({ binding, alt = '' }: { binding: Binding; alt?: string }) {
  const { x, y, zoom } = binding.crop;
  // Position over the full overflow of the zoomed, cover-fitted source.
  // Moving both the image box and its fitted content keeps either edge reachable.
  return <ReferencePreview src={bindingSrc(binding)} alt={alt}
    style={{ position: 'absolute', width: `${zoom * 100}%`, height: `${zoom * 100}%`, maxWidth: 'none',
      left: `${(1 - zoom) * x}%`, top: `${(1 - zoom) * y}%`, objectFit: 'cover', objectPosition: `${x}% ${y}%` }}
    />
}
function coverOf(a: Asset) { const l = a.looks?.find(l => l.id === a.default_look_id); return a.images?.find(b => b.id === (a.kind === 'character' ? l?.default_image_id : a.default_image_id)) ?? null; }
function Avatar({ a }: { a: Asset }) { const b = coverOf(a); return <span className="ca-avatar">{b ? <CroppedImage binding={b}/> : a.name.slice(0, 1)}</span>; }
function Cover({ a }: { a: Asset }) { const b = coverOf(a); return <span className={'ca-card-cover' + (b ? '' : ' is-empty')}>{b ? <CroppedImage binding={b}/> : <span className="ca-card-initial">{a.name.slice(0, 1)}</span>}</span>; }

export function AssetLibrary({ focusProject, active, projectSelectorHost, request, activeProject, selectProject, refreshSeconds, onSettings, onOpenShot }: ProjectAssetProps) {
  const api = <T = any,>(url: string, body?: unknown, method?: string) => request<T>('/project-assets' + url, body, method);
  // v2：新画廊默认卡片显示，不沿用旧版窄列表时期保存的“列表”偏好。
  const prefKey = 'shiguang.creative.preferences.v2';
  const remembered = () => readMemory().display ? readStored<{ kind: Kind; layout: string }>(prefKey, { kind: 'character', layout: 'grid' }, (v): v is { kind: Kind; layout: string } => !!v && typeof v === 'object' && ['character', 'scene', 'prop'].includes((v as any).kind) && ['grid','list'].includes((v as any).layout)) : { kind: 'character' as Kind, layout: 'grid' };
  const [scopes, setScopes] = useState<Scope[]>([]), [scope, setScope] = useState(() => readMemory().display ? readStored('shiguang.creative.lastScope.v1', activeProject, (v): v is string => typeof v === 'string') : activeProject);
  const readScopePrefs = (id: string) => readMemory().display ? readStored('shiguang.creative.scope.v2.' + id, { ...remembered(), archived: false }, (v): v is { kind: Kind; layout: string; archived: boolean } => !!v && typeof v === 'object' && ['character','scene','prop'].includes((v as any).kind) && ['grid','list'].includes((v as any).layout) && typeof (v as any).archived === 'boolean') : { kind: 'character' as Kind, layout: 'grid', archived: false };
  const [kind, setKind] = useState<Kind>(() => readScopePrefs(scope).kind), [layout, setLayout] = useState(() => readScopePrefs(scope).layout), [q, setQ] = useState(''), [archived, setArchived] = useState(() => readScopePrefs(scope).archived), [page, setPage] = useState(1);
  const [rows, setRows] = useState<Asset[]>([]), [total, setTotal] = useState(0), [draft, setDraft] = useState<Asset | null>(null), [base, setBase] = useState(''), [lookId, setLookId] = useState('');
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState(''), [conflict, setConflict] = useState<Asset | null>(null), [health, setHealth] = useState<Health[]>([]);
  useFeedbackToast(notice, {source: '项目资产', active: active, kind: 'auto'});
  useFeedbackToast(error, {source: '项目资产', active: active});
  const [imageViewer, setImageViewer] = useState<{src:string;name:string}|null>(null);
  const [modal, setModal] = useState<any>(null), [mediaQ, setMediaQ] = useState(''), [mediaPage, setMediaPage] = useState(1), [mediaRows, setMediaRows] = useState<any[]>([]), [mediaTotal, setMediaTotal] = useState(0), [versions, setVersions] = useState<any[]>([]);
  const [scopesKnown,setScopesKnown]=useState(false),[scopesError,setScopesError]=useState(''),[scopesRetry,retryScopes]=useState(0);
  useFeedbackToast(scopesError, {source: '项目资产', active: active});
  const [mediaLoading, setMediaLoading] = useState(false), [listLoading, setListLoading] = useState(false);
  const [scriptView,setScriptView]=useState(false),[scriptDirty,setScriptDirty]=useState(false);const scriptDirtyRef=useRef(scriptDirty);scriptDirtyRef.current=scriptDirty;
  // 新界面状态：参考图弹窗、菜单、画廊筛选、拖入导入、剧本中出现的资产名称
  const [imageId, setImageId] = useState<string | null>(null), [menu, setMenu] = useState<'' | 'page' | 'detail'>(''), [missingOnly, setMissingOnly] = useState(false);
  const [dragTarget, setDragTarget] = useState(''), [dropJob, setDropJob] = useState<DropJob | null>(null), [scriptNames, setScriptNames] = useState<{ kind: Kind; name: string }[]>([]);
  const dropJobRef = useRef(dropJob); dropJobRef.current = dropJob;
  const dragDepth = useRef(0), detailScroll = useRef<HTMLDivElement>(null);
  useEffect(() => setImageViewer(null), [active, scope, draft?.id, lookId, kind, scriptView]);
  useEffect(() => setImageId(null), [active, scope, draft?.id, lookId, kind, scriptView]);
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
  const selectionGeneration = useRef(0);
  const listContext = `${active}:${scope}:${kind}:${q}:${archived}:${page}`;
  const listContextRef = useRef(listContext); listContextRef.current = listContext;
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
    const pref = readScopePrefs(next); selectionGeneration.current++; generation.current++; healthGeneration.current++; scopeRef.current = next;
    setScope(next); setRows([]); setTotal(0); setListLoading(!!next && active);
    setDraft(null); setBase(''); setLookId(''); setConflict(null); setHealth([]); setVersions([]); setError(''); setNotice('');
    if(scopes.find(s=>s.id===next)?.project_kind==='public')setScriptView(false);
    setKind(scopes.find(s => s.id === next)?.project_kind === 'public' ? 'character' : pref.kind); setLayout(pref.layout); setArchived(pref.archived); setPage(1); setQ('');
    if (scopes.find(s => s.id === next)?.project_kind === 'normal') selectProject(next);
  }
  function install(a: Asset) { if (draftRef.current?.id !== a.id || draftRef.current?.kind !== a.kind) setVersions([]); if (draftRef.current?.id !== a.id || draftRef.current?.revision !== a.revision) setHealth([]); setDraft(a); setBase(JSON.stringify(a)); setLookId(old => draftIdRef.current === a.id && a.looks.some(l => l.id === old) ? old : a.default_look_id ?? a.looks.find(l => !l.archived_at)?.id ?? ''); setConflict(null); }
  const edit = (fn: (a: Asset) => void) => setDraft(old => { if (!old || old.archived_at) return old; const next = structuredClone(old); fn(next); return next; });
  async function loadList() {
    if (!active || !scope) return;
    const ticket = ++generation.current, context = listContext; setListLoading(true);
    try {
      const result = await api<{ items: Asset[]; total: number }>('/assets?' + new URLSearchParams({ project_id: scope, kind, q, archived: String(archived), page: String(page) }));
      if (ticket !== generation.current || scopeRef.current !== scope || listContextRef.current !== context) return;
      // 画廊优先：不再自动打开第一项，由使用者点选后在右侧查看详情。
      setRows(result.items); setTotal(result.total);
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
      setScopes(r.items); setScopesKnown(true);
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
  useEffect(() => { if (readMemory().display) { saveStored(prefKey, { kind, layout }); saveStored('shiguang.creative.lastScope.v1', scope); if (scope) saveStored('shiguang.creative.scope.v2.' + scope, { kind, layout, archived }); } }, [kind, layout, scope, archived]);
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
    if (!modal && !imageId && !dropJob) return;
    const previous = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, [!!modal || !!imageId || !!dropJob]);
  const lastFocusProject=useRef(-1);
  useEffect(()=>{if(active&&focusProject?.id&&lastFocusProject.current!==focusProject.request){lastFocusProject.current=focusProject.request;if(scope!==focusProject.id)changeScope(focusProject.id);}},[active,focusProject?.request]);
  useEffect(() => {
    if (!active || modal?.type !== 'history' || !draft) return;
    let live = true; setVersions([]);
    void api<any[]>('/assets/' + draft.id + '/versions').then(r => { if (live && draftIdRef.current === draft.id && scopeRef.current === scope) setVersions(r); }).catch(e => { if (live && draftIdRef.current === draft.id && scopeRef.current === scope) setError(e.message); });
    return () => { live = false; };
  }, [active, modal?.type, draft?.id, scope]);
  // 菜单：点击外部或按 Esc 关闭
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !(e.target as Element)?.closest?.('.ca-menu-wrap')) setMenu(''); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [menu]);
  // 剧本右栏：读取本项目三类资产的名称（各取第一页）
  useEffect(() => {
    if (!active || !scriptView || !scope || publicScope) return;
    let live = true;
    void Promise.all((['character', 'scene', 'prop'] as Kind[]).map(k => api<{ items: Asset[] }>('/assets?' + new URLSearchParams({ project_id: scope, kind: k, q: '', archived: 'false', page: '1' })).then(r => r.items.map(a => ({ kind: k, name: a.name })))))
      .then(all => { if (live) setScriptNames(all.flat()); }).catch(() => { if (live) setScriptNames([]); });
    return () => { live = false; };
  }, [active, scriptView, scope, publicScope]);
  async function openAsset(id: string) { if (busy || !canLeave()) return; const ticket = ++selectionGeneration.current, project = scope; await run('正在读取资料…', async () => { const a = await api<Asset>('/assets/' + id); if (ticket === selectionGeneration.current && project === scopeRef.current && a.project_id === project) install(a); }); }
  function closeDetail() { if (busy || !canLeave()) return; selectionGeneration.current++; setDraft(null); setBase(''); setLookId(''); setConflict(null); setHealth([]); setVersions([]); setImageId(null); setMenu(''); }
  function discard() { if (!draft || !dirty || busy || !window.confirm('放弃当前修改，恢复到上次读取的资料？已导入的图片文件仍保留在项目文件夹。')) return; install(JSON.parse(base)); setNotice('已放弃修改'); }
  async function save() { if (!draft || draft.archived_at || importActivity.current.size) return; await run('正在保存资产…', async () => { try { const a = await api<Asset>('/assets/' + draft.id, { asset: draft, expected_revision: draft.revision }, 'PUT'); install(a); await loadList(); const adopted=a.images.some(b=>!b.archived_at&&importedBindings.current.has(b.id));a.images.forEach(b=>importedBindings.current.delete(b.id));setNotice((adopted?(a.kind==='character'?'已绑定到造型 · ':'已绑定参考图片 · '):'')+'已保存 · V'+a.revision); } catch (e: any) { if (e.message.includes('已经更新')) setConflict(await api<Asset>('/assets/' + draft.id)); throw e; } }); }
  async function toggleArchive() {
    if (!draft || dirty || busy) return;
    await run('正在更新归档状态并重新读取资料…', async () => {
      const updated = await api<Asset>('/assets/' + draft.id + '/archive', { archived: !draft.archived_at, expected_revision: draft.revision });
      // Install the confirmed state first, so a later read failure cannot leave an editable stale draft.
      install(updated); setModal(null);
      setNotice(updated.archived_at ? '已归档，资料只读；恢复后可继续编辑。' : '已恢复，可继续编辑。');
      await loadList();
      install(await api<Asset>('/assets/' + updated.id));
    });
  }
  async function create() { if (!scope || !canLeave()) return; selectionGeneration.current++; setModal({ type: 'create', name: '' }); }
  const currentLook = draft?.looks.find(l => l.id === lookId), images = draft?.images.filter(b => b.look_id === (draft.kind === 'character' ? lookId : null)) ?? [];
  const representative = draft?.kind === 'character' ? currentLook?.default_image_id : draft?.default_image_id;
  function setDefault(a: Asset, id: string | null) { if (a.kind === 'character') { const l = a.looks.find(l => l.id === lookId); if (l) l.default_image_id = id; } else a.default_image_id = id; }
  function moveImage(id: string, delta: number, target?: string) { if (draft?.archived_at || currentLook?.archived_at || images.find(b => b.id === id)?.archived_at) return; edit(a => { const activeIds = a.images.filter(b => b.look_id === (a.kind === 'character' ? lookId : null) && !b.archived_at).map(b => b.id), from = activeIds.indexOf(id), to = target ? activeIds.indexOf(target) : from + delta; if (from < 0 || to < 0 || to >= activeIds.length) return; const [moved] = activeIds.splice(from, 1); activeIds.splice(to, 0, moved); const byId = new Map(a.images.map(b => [b.id, b])); let cursor = 0; a.images = a.images.map(b => activeIds.includes(b.id) ? byId.get(activeIds[cursor++])! : b); }); }
  async function openCopy() { if (!draft || dirty) { setError('请先保存当前人物，再复制到其他项目'); return; } const target = scopes.find(s => s.id !== draft.project_id && s.project_kind === 'normal')?.id ?? scope; await run('正在准备复制…', async () => { const p = await api<any>('/assets/' + draft.id + '/copy-preview?project_id=' + target); setModal({ type: 'copy', ...p, project_id: target, name: draft.name, base_info: draft.base_info, performance_info: draft.performance_info }); }); }

  /* ------------------------------------------------ 从访达拖入图片：新建或添加参考图 */
  const fileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const dropBlocked = () => !active || scriptView || !!busy || !!modal || !!dropJob || !scope || !!imageId;
  function readDropFiles(e: React.DragEvent): File[] | null {
    if (Array.from(e.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setError('请拖入图片文件，暂不支持文件夹'); return null; }
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) { setError('请拖入本地图片文件；网页链接暂不支持'); return null; }
    const accepted = files.filter(imageFile);
    if (!accepted.length) { setError('拖入的文件不是图片'); return null; }
    if (accepted.length < files.length) setNotice(`已忽略 ${files.length - accepted.length} 个非图片文件`);
    return accepted.slice(0, 20);
  }
  const makeItems = (files: File[], mode: 'create' | 'attach'): DropItem[] => files.map(f => ({ key: crypto.randomUUID(), file: f, preview: URL.createObjectURL(f), name: baseName(f.name), include: true, state: 'waiting', message: '', stage: mode === 'create' ? 'create' : 'look', requestId: crypto.randomUUID(), bindingId: crypto.randomUUID(), newLookId: crypto.randomUUID(), startedAt: 0 }));
  function dropOnGallery(e: React.DragEvent) {
    e.preventDefault(); dragDepth.current = 0; setDragTarget('');
    if (dropBlocked()) { setError('请先完成当前操作，再拖入图片'); return; }
    if (publicScope && kind !== 'character') return;
    const files = readDropFiles(e); if (!files) return;
    setDropJob({ mode: 'create', kind, projectId: scope, lookId: null, items: makeItems(files, 'create'), running: false });
  }
  async function dropOnCard(e: React.DragEvent, a: Asset) {
    e.preventDefault(); e.stopPropagation(); dragDepth.current = 0; setDragTarget('');
    if (dropBlocked()) { setError('请先完成当前操作，再拖入图片'); return; }
    if (a.archived_at) { setError('已归档的资料不能添加图片，请先恢复'); return; }
    if (draft?.id === a.id && dirty) { setError('当前资料有未保存的修改，请先保存或放弃修改，再拖入图片'); return; }
    const files = readDropFiles(e); if (!files) return;
    await run('正在读取资料…', async () => {
      const full = await api<Asset>('/assets/' + a.id);
      const looks = full.looks.filter(l => !l.archived_at);
      setDropJob({ mode: 'attach', kind: full.kind, projectId: full.project_id, asset: { id: full.id, name: full.name, looks }, lookId: full.kind === 'character' ? (looks.find(l => l.id === full.default_look_id)?.id ?? looks[0]?.id ?? null) : null, items: makeItems(files, 'attach'), running: false });
    });
  }
  useEffect(() => { if (!dropJob) return; const job = dropJob; return () => { if (dropJobRef.current !== job && dropJobRef.current?.items[0]?.key !== job.items[0]?.key) job.items.forEach(i => URL.revokeObjectURL(i.preview)); }; }, [dropJob?.items[0]?.key]);
  const patchItem = (key: string, patch: Partial<DropItem>) => setDropJob(j => j && { ...j, items: j.items.map(i => i.key === key ? { ...i, ...patch } : i) });
  // 明确的失败（服务器已回应）带 status；没有 status 的是回应丢失，结果未知。
  const definite = (message: string) => Object.assign(Error(message), { status: 400 });
  const pendingNote = '结果待核对：没有收到服务器回应，操作可能已经完成。点击“核对结果”会先按原编号查询导入回执和资料，不会重复上传或绑定。';
  // 本项目中与名称完全相同的资料（含已归档），用于新建前检查和回应丢失后的找回。
  async function sameName(job: DropJob, name: string) {
    const rows = await Promise.all(['false', 'true'].map(archived => api<{ items: Asset[] }>('/assets?' + new URLSearchParams({ project_id: job.projectId, kind: job.kind, q: name, archived, page: '1' }))));
    return rows.flatMap(r => r.items).filter(a => a.name === name);
  }
  async function ensureLook(assetId: string, fixedId: string): Promise<string> {
    const a = await api<Asset>('/assets/' + assetId);
    if (a.looks.some(l => l.id === fixedId && !l.archived_at)) return fixedId;
    const existing = a.looks.find(l => l.id === a.default_look_id && !l.archived_at) ?? a.looks.find(l => !l.archived_at);
    if (existing) return existing.id;
    if (a.archived_at) throw definite('资料已归档，图片没有添加');
    const next = structuredClone(a);
    next.looks.push({ id: fixedId, name: '默认', description: '', tags: [], default_image_id: null, archived_at: null }); next.default_look_id ??= fixedId;
    await api<Asset>('/assets/' + assetId, { asset: next, expected_revision: a.revision }, 'PUT');
    return fixedId;
  }
  // 绑定使用预先分配的编号：资料里已有这条绑定就是之前已保存成功，不再追加。
  async function bindOnce(it: DropItem, kind: Kind): Promise<'saved' | 'existing'> {
    const a = await api<Asset>('/assets/' + it.assetId);
    if (a.images.some(b => b.id === it.bindingId)) return 'existing';
    if (a.archived_at) throw definite('资料已归档，图片文件已导入但没有绑定');
    const lookId = kind === 'character' ? it.lookId ?? null : null;
    if (kind === 'character' && !a.looks.some(l => l.id === lookId && !l.archived_at)) throw definite('目标造型已不存在或已归档，图片文件已导入但没有绑定');
    const next = structuredClone(a);
    next.images.push({ id: it.bindingId, look_id: lookId, media_asset_id: it.mediaAssetId!, reference_type: kind === 'character' ? '人物身份' : '', purpose: '', locks: '', ignores: '', confirmed: false, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: it.fileName || it.file.name });
    if (kind === 'character') { const l = next.looks.find(l => l.id === lookId)!; if (!l.default_image_id) l.default_image_id = it.bindingId; } else if (!next.default_image_id) next.default_image_id = it.bindingId;
    await api<Asset>('/assets/' + it.assetId, { asset: next, expected_revision: a.revision }, 'PUT');
    return 'saved';
  }
  async function processItem(job: DropJob, item: DropItem, choice?: { choice: 'reuse' | 'import'; candidateId?: string }, adopt?: string) {
    const it: DropItem = { ...item }, retrying = item.state === 'failed';
    const sync = (patch: Partial<DropItem>) => { Object.assign(it, patch); patchItem(it.key, patch); };
    sync({ state: 'working', message: '', startedAt: it.startedAt || Date.now() });
    try {
      if (it.stage === 'create') {
        const name = it.name.trim();
        if (!it.assetId && adopt && it.claims?.some(c => c.id === adopt)) sync({ assetId: adopt, adopted: true, createPending: false, claims: undefined });
        // 新建结果未知：前端无法证明同名资料由这次请求建立（可能是其他窗口同时新建的），不自动认领。
        if (!it.assetId && it.createPending) {
          if (name !== it.pendingName) sync({ createPending: false, claims: undefined });
          else {
            const candidates = (await sameName(job, name)).filter(a => !it.preExisting?.includes(a.id));
            if (candidates.length) { sync({ state: 'unknown', claims: candidates.map(a => ({ id: a.id, name: a.name, revision: a.revision, created_at: a.created_at, images: (a.images ?? []).filter(b => !b.archived_at).length, archived: !!a.archived_at })), claimChoice: candidates.some(c => c.id === it.claimChoice) ? it.claimChoice : candidates[0].id, message: `没有收到新建结果。本项目现在有同名${labels[job.kind]}，但无法确认是否由这次操作建立，也可能是其他窗口新建的。请查看后明确选择是否把图片加到这份资料，或修改名称后继续；未选择前不会改动它。` }); return; }
            sync({ createPending: false, claims: undefined }); // 同名资料不存在：上次新建确实没有生效，可以重新新建
          }
        }
        if (!it.assetId) {
          const before = await sameName(job, name);
          if (before.length) throw definite(`本项目已有同名${labels[job.kind]}“${name}”${before.some(a => a.archived_at) ? '（已归档）' : ''}，请修改名称后继续；不会把图片加到已有资料`);
          sync({ preExisting: before.map(a => a.id), createAt: Date.now(), createPending: true, pendingName: name, claims: undefined });
          const created = await api<Asset>('/assets', { project_id: job.projectId, kind: job.kind, name });
          sync({ assetId: created.id });
        }
        sync({ createPending: false, stage: 'look' });
      }
      if (job.mode === 'attach' && !it.assetId) sync({ assetId: job.asset!.id });
      if (it.stage === 'look') {
        if (job.kind === 'character' && !it.lookId) { const lookId = job.mode === 'attach' ? job.lookId : await ensureLook(it.assetId!, it.newLookId); if (!lookId) throw definite('请先为这个人物新建造型，再添加图片'); sync({ lookId }); }
        sync({ stage: 'import' });
      }
      if (it.stage === 'import') {
        const imports = '/project-assets/image-imports';
        const start = () => request<Receipt>(imports, { requestId: it.requestId, assetId: it.assetId, projectId: job.projectId, lookId: job.kind === 'character' ? it.lookId : null, fileName: it.file.name, bytes: it.file.size });
        let r: Receipt;
        if (choice) r = await request<Receipt>(imports + '/' + it.requestId + '/resolve', choice);
        else {
          // 同一编号再次发送只会返回原回执，用来核对上次是否已经上传。
          r = await start();
          if (retrying && (r.status === 'failed' || r.status === 'cancelled')) { sync({ requestId: crypto.randomUUID() }); r = await start(); }
          if (r.status === 'waiting') r = await request<Receipt>(imports + '/' + it.requestId + '/content', it.file, 'PUT');
        }
        if (r.status === 'duplicate') { sync({ state: 'duplicate', receipt: r, candidate: r.candidates.some(c => c.id === it.candidate) ? it.candidate : r.candidates[0]?.id, message: '发现同名或相同内容的图片，请选择使用原图或继续导入' }); return; }
        if (r.status === 'preparing' || r.status === 'uploading') { sync({ state: 'unknown', message: '服务器仍在接收或保存这张图片，请稍后点击“核对结果”' }); return; }
        if (r.status !== 'ready' || !r.mediaAssetId) { sync({ state: 'failed', receipt: undefined, message: (r.status === 'cancelled' ? '导入已取消' : r.error || '导入未完成') + '；可以重试' + (job.mode === 'create' ? '，或归档刚建立的资料' : '') }); return; }
        sync({ mediaAssetId: r.mediaAssetId, fileName: r.fileName, receipt: undefined, stage: 'bind' });
      }
      if (it.stage === 'bind') {
        const result = await bindOnce(it, job.kind);
        sync({ stage: 'done', state: 'done', message: result === 'existing' ? '已核对：图片此前已保存，没有重复添加' : job.mode === 'create' ? (it.adopted ? '已按你的选择加到所选资料' : '已新建并添加参考图') : '已添加' });
      }
    } catch (e: any) {
      if (!e?.status) sync({ state: 'unknown', message: pendingNote });
      else sync({ ...(it.stage === 'create' && !it.assetId ? { createPending: false } : {}), state: 'failed', message: (e.message || '未完成') + (/已经更新/.test(e.message || '') ? '；资料在其他地方已更新，重试会重新读取最新资料后再核对绑定' : '') + (it.stage !== 'create' && job.mode === 'create' && it.assetId ? '；资料已建立，可重试或归档' : '') });
    }
  }
  async function runDropJob() {
    const job = dropJobRef.current; if (!job || job.running) return;
    const todo = job.items.filter(i => i.include && (i.state === 'waiting' || i.state === 'failed' || i.state === 'unknown'));
    if (job.mode === 'create' && todo.some(i => !i.name.trim())) { setError('请为每张图片填写名称'); return; }
    if (job.kind === 'character' && job.mode === 'attach' && !job.lookId) { setError('请先为这个人物新建造型，再添加图片'); return; }
    setDropJob(j => j && { ...j, running: true }); setBusy('正在导入图片…');
    try { for (const item of todo) await processItem(job, dropJobRef.current?.items.find(i => i.key === item.key) ?? item); }
    finally { setDropJob(j => j && { ...j, running: false }); setBusy(''); }
    await afterDropChange(job);
  }
  async function afterDropChange(job: DropJob) {
    await loadList().catch(e => setError(e.message));
    const open = draftRef.current;
    if (open && !dirtyRef.current && (job.asset?.id === open.id || job.items.some(i => i.assetId === open.id))) install(await api<Asset>('/assets/' + open.id).catch(() => open));
  }
  async function resolveDuplicate(item: DropItem, choice: 'reuse' | 'import') {
    const job = dropJobRef.current; if (!job || job.running || !item.receipt) return;
    setDropJob(j => j && { ...j, running: true }); setBusy('正在导入图片…');
    try { await processItem(job, item, choice === 'reuse' ? { choice, candidateId: item.candidate } : { choice }); }
    finally { setDropJob(j => j && { ...j, running: false }); setBusy(''); }
    await afterDropChange(job);
  }
  async function adoptClaim(item: DropItem) {
    const job = dropJobRef.current; if (!job || job.running || !item.claimChoice) return;
    const c = item.claims?.find(c => c.id === item.claimChoice); if (!c || !window.confirm(`把这张图片加到已有的“${c.name}”（V${c.revision}，${c.images} 张图）？这份资料可能是其他窗口建立的。`)) return;
    setDropJob(j => j && { ...j, running: true }); setBusy('正在导入图片…');
    try { await processItem(job, item, undefined, c.id); }
    finally { setDropJob(j => j && { ...j, running: false }); setBusy(''); }
    await afterDropChange(job);
  }
  async function archiveCreated(item: DropItem) {
    if (!item.assetId) return;
    try { const a = await api<Asset>('/assets/' + item.assetId); await api('/assets/' + a.id + '/archive', { archived: true, expected_revision: a.revision }); patchItem(item.key, { state: 'done', message: '已归档刚建立的资料' }); await loadList(); }
    catch (e: any) { patchItem(item.key, { message: e.message || '归档失败' }); }
  }
  function closeDropJob() {
    const job = dropJobRef.current; if (!job || job.running) return;
    if (job.items.some(i => i.state === 'unknown') && !window.confirm('还有图片的结果待核对。关闭后请在资料中核对是否已添加，确定关闭吗？')) return;
    const done = job.items.filter(i => i.state === 'done' && i.assetId);
    job.items.forEach(i => URL.revokeObjectURL(i.preview)); setDropJob(null);
    if (job.mode === 'create' && done.length === 1 && !dirtyRef.current) void openAsset(done[0].assetId!);
  }
  const dragProps = (target: string, onDrop: (e: React.DragEvent) => void) => ({
    onDragEnter: (e: React.DragEvent) => { if (!fileDrag(e)) return; e.preventDefault(); e.stopPropagation(); if (!dropBlocked()) setDragTarget(target); },
    onDragOver: (e: React.DragEvent) => { if (!fileDrag(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = dropBlocked() ? 'none' : 'copy'; if (!dropBlocked() && dragTarget !== target) setDragTarget(target); },
    onDrop,
  });

  /* ------------------------------------------------------------------ 界面 */
  const visibleRows = rows.filter(a => a.project_id === scope && (!missingOnly || !coverOf(a)));
  const listStatus = !scopesKnown && !rows.length ? (scopesError ? '范围未能读取' : '正在读取项目范围…') : listLoading ? '加载中…' : `${total} 个${archived ? '已归档的' : ''}${labels[kind]}`;
  const dialogImage = imageId ? images.find(b => b.id === imageId) ?? null : null;
  const dialogHealth = dialogImage ? health.find(h => h.id === dialogImage.id) : undefined;
  const imageLocked = (b?: Binding | null) => !!draft?.archived_at || !!currentLook?.archived_at || !!b?.archived_at;
  const activeImageIds = images.filter(b => !b.archived_at).map(b => b.id);
  const jump = (id: string) => { const node = detailScroll.current?.querySelector('#' + id) as HTMLElement | null; node?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };
  const switchKind = (k: Kind) => {
    if (!scriptView && kind === k) return;
    if (!canLeave()) return;
    setScriptView(false);
    if (kind === k) {
      if (draft?.project_id === scope && draft.kind === k) return;
      selectionGeneration.current++;
      setDraft(null);
      void loadList().catch(e => setError(e.message));
      return;
    }
    selectionGeneration.current++; setKind(k); setDraft(null); setPage(1); setMissingOnly(false);
  };

  return <section className="ca-workspace ca-v2" aria-label="项目资产库" aria-busy={!!busy}>
    {active && projectSelectorHost && createPortal(<ProjectSelector projects={scopes} value={scope} disabled={!!busy||!!modal||!!dropJob} onChange={changeScope} label="资产所属项目" caption="资产所属" allowEmpty={false}/>, projectSelectorHost)}
    <header className="ca-head">
      <div className="ca-head-row">
        <div className="ca-head-title"><h1>项目资产</h1>{publicScope && <span className="ca-scope-note"><Globe2 size={13}/>公共人物可复制到任意项目</span>}</div>
        {!scriptView && <div className="ca-head-tools">
          <label className="ca-search"><Search size={15} aria-hidden="true"/><input aria-label="搜索资产" placeholder={'搜索' + labels[kind]} value={q} onChange={e => { setQ(e.target.value); setPage(1); }}/></label>
          <button className="ca-primary" disabled={!scope || !!busy} onClick={() => void create()}><Plus size={15}/>新建{labels[kind]}</button>
          <div className="ca-menu-wrap"><button className="ca-icon-button" aria-label="更多资产操作" aria-haspopup="menu" aria-expanded={menu === 'page'} onClick={() => setMenu(m => m === 'page' ? '' : 'page')}><MoreHorizontal size={17}/></button>
            {menu === 'page' && <div className="ca-menu" role="menu">
              {kind === 'character' && <button role="menuitem" disabled={!!busy} onClick={() => { setMenu(''); if (!canLeave()) return; setModal({ type: 'import', source_project: scopes.find(s => s.id !== scope)?.id ?? '', source_rows: [], selected: '' }); }}><Copy size={15}/>从项目／公共库复制</button>}
              <button role="menuitemcheckbox" aria-checked={archived} onClick={() => { setMenu(''); setArchived(v => !v); setPage(1); }}><Archive size={15}/>{archived ? '返回未归档' : '查看已归档'}</button>
              <button role="menuitemradio" aria-checked={layout === 'grid'} onClick={() => { setMenu(''); setLayout('grid'); }}>卡片显示{layout === 'grid' && ' ✓'}</button>
              <button role="menuitemradio" aria-checked={layout === 'list'} onClick={() => { setMenu(''); setLayout('list'); }}>列表显示{layout === 'list' && ' ✓'}</button>
              <button role="menuitem" disabled={!!busy || listLoading} onClick={() => { setMenu(''); setError(''); void loadList().catch(e => setError(e.message)); }}>刷新列表</button>
              <hr/>
              <button role="menuitem" onClick={() => { setMenu(''); onSettings(); }}>界面设置</button>
            </div>}
          </div>
        </div>}
      </div>
      <div className="ca-tabs" role="tablist" aria-label="资产类别">{(Object.keys(labels) as Kind[]).map(k => <button role="tab" key={k} aria-selected={!scriptView && kind === k} disabled={!!busy || publicScope && k !== 'character'} onClick={() => switchKind(k)}>{labels[k]}{!scriptView && kind === k && !listLoading && scopesKnown && <span className="ca-tab-count">{total}</span>}</button>)}<button role="tab" aria-selected={scriptView} disabled={!!busy||publicScope||!scopes.some(s=>s.id===scope&&s.project_kind==='normal')} onClick={()=>{if(scriptView||!canLeave())return;selectionGeneration.current++;setModal(null);setScriptView(true);}}>剧本</button></div>
    </header>
    {(error||scopesError) && <div className="ca-alert" role="alert">{error||scopesError}{scopesError&&<button onClick={()=>retryScopes(n=>n+1)}>重试项目范围</button>}<button aria-label="关闭错误" onClick={() => {setError('');if(scopesKnown)setScopesError('');}}><X size={14}/></button></div>}{notice && <div className="ca-notice" role="status">{notice}<button aria-label="关闭通知" onClick={() => setNotice('')}><X size={14}/></button></div>}
    {busy && <div className="ca-progress" role="status"><span className="spinner"/>{busy}</div>}
    <div className="ca-script-host" hidden={!scriptView}><ProjectScript projectId={scope} visible={active&&scriptView&&!publicScope} request={request} onDirtyChange={setScriptDirty} names={scriptNames}/></div>
    <div className="ca-stage" hidden={scriptView}><fieldset className="ca-interaction" disabled={!!busy}>
      <div className={'ca-body' + (draft ? ' has-detail' : '')}>
        <section className={'ca-gallery' + (dragTarget === 'gallery' ? ' is-drop' : '')} aria-label={labels[kind] + '画廊'} aria-busy={listLoading||!scopesKnown&&!scopesError}
          {...dragProps('gallery', dropOnGallery)} onDragLeave={e => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDragTarget(''); }}>
          <div className="ca-gallery-bar">
            <div className="ca-filters" role="group" aria-label="筛选"><button type="button" aria-pressed={!missingOnly} onClick={() => setMissingOnly(false)}>全部</button><button type="button" aria-pressed={missingOnly} onClick={() => setMissingOnly(true)}>缺参考图</button></div>
            <span className="ca-count">{listStatus}{missingOnly && !listLoading ? ` · 本页缺参考图 ${visibleRows.length} 个` : ''}</span>
          </div>
          {!scopesKnown&&!scopesError&&<div className="ca-progress" role="status">正在读取项目范围…</div>}
          {listLoading && <div className="ca-progress" role="status"><span className="spinner"/>正在加载当前项目的{labels[kind]}…</div>}
          <div className={'ca-cards ca-' + layout + (kind === 'character' ? ' ca-portrait' : ' ca-landscape')}>
            {visibleRows.map(a => { const cover = coverOf(a), imageCount = (a.images ?? []).filter(b => !b.archived_at).length; return <button key={a.id} className={'ca-card' + (draft?.id === a.id ? ' selected' : '') + (dragTarget === a.id ? ' is-drop' : '') + (a.archived_at ? ' is-archived' : '')} aria-current={draft?.id === a.id ? 'true' : undefined} onClick={() => void openAsset(a.id)} {...dragProps(a.id, e => void dropOnCard(e, a))}>
              <Cover a={a}/>
              <span className="ca-card-body"><strong>{a.name}</strong><small>{a.base_info?.slice(0, 65) || '基础信息待完善'}</small>
                <span className="ca-card-meta">{a.kind === 'character' ? <span className="ca-pill">{a.look_count ?? a.looks?.length ?? 0} 造型 · {imageCount} 图</span> : <span className="ca-pill">{imageCount} 张参考图</span>}{!cover && <span className="ca-pill warn">缺参考图</span>}{!!a.archived_at && <span className="ca-pill">已归档</span>}{a.source && <span className="ca-pill" title={'复制自 ' + a.source.project_name}>复制自 {a.source.project_name}</span>}</span>
              </span>
              {dragTarget === a.id && <span className="ca-card-drop">添加为“{a.name}”的参考图</span>}
            </button>; })}
            {!archived && <button className="ca-card ca-card-add" disabled={!scope || !!busy || publicScope && kind !== 'character'} onClick={() => void create()}><Plus size={18}/><span>新建{labels[kind]}<small>或把图片拖到这里</small></span></button>}
          </div>
          {scopesKnown && !listLoading && !rows.length && !error && !scopesError && (archived || !scope) && empty(scope ? '暂无归档' + labels[kind] : '请先选择项目')}
          {missingOnly && !listLoading && !!rows.length && !visibleRows.length && empty('本页的' + labels[kind] + '都已有参考图')}
          {total > 40 && <div className="ca-pagination"><button disabled={page === 1} onClick={() => setPage(v => v - 1)}>上一页</button><span>{page} / {Math.ceil(total / 40)}</span><button disabled={page * 40 >= total} onClick={() => setPage(v => v + 1)}>下一页</button></div>}
          {dragTarget === 'gallery' && <div className="ca-drop-hint" aria-hidden="true"><ImagePlus size={26}/>松开以新建{labels[kind]}</div>}
        </section>
        {draft && <aside className="ca-detail" aria-label={labels[draft.kind] + '详情'}>
          <div className="ca-detail-head">
            <Avatar a={draft}/>
            <div className="ca-detail-title">
              <input className="ca-name-input" aria-label={labels[draft.kind] + '名称'} value={draft.name} disabled={!!draft.archived_at} onChange={e => { const v = e.target.value; edit(a => { a.name = v; }); }}/>
              <span className="ca-owner-tag">{owner?.project_kind === 'public' ? <><Globe2 size={12}/>公共人物</> : <><FolderKanban size={12}/>项目{labels[draft.kind]} · {owner?.name || '所属项目读取中'}</>}</span>
            </div>
            <div className="ca-menu-wrap"><button className="ca-icon-button" aria-label="资料操作" aria-haspopup="menu" aria-expanded={menu === 'detail'} onClick={() => setMenu(m => m === 'detail' ? '' : 'detail')}><MoreHorizontal size={17}/></button>
              {menu === 'detail' && <div className="ca-menu" role="menu">
                {draft.kind === 'character' && <button role="menuitem" disabled={!!busy || dirty || !!draft.archived_at} title={dirty ? '请先保存当前修改' : undefined} onClick={() => { setMenu(''); void openCopy(); }}><Copy size={15}/>复制到其他项目</button>}
                <button role="menuitem" onClick={() => { setMenu(''); setModal({ type: 'history' }); }}><History size={15}/>来源与版本（V{draft.revision}）</button>
                <hr/>
                <button role="menuitem" title={draft.storyboard_protected ? '属于当前分镜清单，请重新初始化后移出清单再归档' : dirty ? '请先保存当前修改' : undefined} disabled={!!busy || dirty || !!draft.storyboard_protected} onClick={() => { setMenu(''); void toggleArchive(); }}><Archive size={15}/>{draft.archived_at ? '恢复' : '归档'}</button>
              </div>}
            </div>
            <button className="ca-icon-button" aria-label="关闭详情" disabled={!!busy} onClick={closeDetail}><X size={17}/></button>
          </div>
          {draft.storyboard_protected && <p className="ca-detail-note">分镜清单已保护 · 可编辑，移出清单后可归档。</p>}
          {!!draft.archived_at && <div className="ca-archive-note" role="status"><Archive size={15}/>该{labels[draft.kind]}已归档，资料和图片设置只读。在右上角“⋯”中选择“恢复”后可继续编辑。</div>}
          {conflict && <div className="ca-conflict" role="alert"><strong>{labels[draft.kind]}已经更新：当前 V{draft.revision}，数据库 V{conflict.revision}</strong><p>本地修改仍保留。请先比较变化，再决定采用最新资料或核对后合并保存。</p><button onClick={() => setModal({ type: 'compare', latest: conflict })}>比较资料</button><button onClick={() => { if (canLeave()) install(conflict); }}>载入最新资料</button></div>}
          <nav className="ca-detail-nav" aria-label="详情分区">{([['ca-sec-info', '资料'], ['ca-sec-refs', draft.kind === 'character' ? '造型与参考图' : '参考图'], ...(draft.kind === 'character' ? [['ca-sec-voice', '语音']] : []), ['ca-sec-shots', '出场镜头']] as [string, string][]).map(([id, l]) => <button type="button" key={id} onClick={() => jump(id)}>{l}</button>)}</nav>
          <div className="ca-detail-scroll" ref={detailScroll}>
            <section className="ca-sec" id="ca-sec-info" aria-label="资料">
              <h3>资料</h3>
              <fieldset disabled={!!draft.archived_at} className="ca-form ca-edit-fields">
                <Field label={draft.kind === 'character' ? '基础信息' : '自由描述'} long rows={3} value={draft.base_info} onChange={v => edit(a => { a.base_info = v; })}/>
                {draft.kind === 'character' ? <><Field label="性格与表演" long rows={3} value={draft.performance_info} onChange={v => edit(a => { a.performance_info = v; })}/><label className="ca-field"><span>默认造型</span><select aria-label="默认造型" value={draft.default_look_id ?? ''} onChange={e => { const v = e.target.value; edit(a => { a.default_look_id = v || null; }); }}>{!draft.looks.some(l => !l.archived_at) && <option value="">待完善</option>}{draft.looks.filter(l => !l.archived_at).map(l => <option value={l.id} key={l.id}>{l.name}</option>)}</select></label></>
                  : <div className="ca-field-grid">{detailFields[draft.kind].map(k => <Field key={k} label={k} long rows={2} value={draft.details[k] ?? ''} onChange={v => edit(a => { a.details[k] = v; })}/>)}</div>}
                <p className="ca-muted">名称在本项目内唯一。其他资料可后补；姓名和排序变化不会改变永久编号。</p>
              </fieldset>
            </section>
            <section className="ca-sec" id="ca-sec-refs" aria-label={draft.kind === 'character' ? '造型与参考图' : '参考图'}>
              <h3>{draft.kind === 'character' ? '造型与参考图' : '参考图'} <small>第一张是代表图 · 拖动排序 · 黄点表示参考职责未确认 · 保存后生效</small></h3>
              {draft.kind === 'character' && <>
                <div className="ca-look-list">{draft.looks.map(l => <button type="button" key={l.id} className={l.id === lookId ? 'selected' : ''} aria-pressed={l.id === lookId} onClick={() => setLookId(l.id)}>{l.id === draft.default_look_id && <Star size={12} className="ca-star" aria-label="默认造型"/>}{l.name}{l.archived_at ? '（归档）' : ''}<span className="ca-count-chip">{draft.images.filter(b => b.look_id === l.id && !b.archived_at).length}</span></button>)}<button type="button" disabled={!!draft.archived_at} onClick={() => { const id = crypto.randomUUID(); edit(a => { a.looks.push({ id, name: '新造型', description: '', tags: [], default_image_id: null, archived_at: null }); a.default_look_id ??= id; }); setLookId(id); }}><Plus size={14}/>新增造型</button></div>
                {!draft.looks.length && empty('先新增造型，再绑定参考图片')}
                {currentLook && <>
                  <div className="ca-look-summary"><span>{currentLook.description || '没有造型说明'}</span>{currentLook.tags.map(t => <span key={t} className="ca-pill">{t}</span>)}{currentLook.id !== draft.default_look_id && !currentLook.archived_at && <button type="button" className="ca-link-button" disabled={!!draft.archived_at} onClick={() => edit(a => { a.default_look_id = lookId; })}>设为默认造型</button>}</div>
                  <details className="ca-look-config" key={currentLook.id}><summary><span>造型设置</span><small>名称、说明、类型、排序与归档</small></summary><div className="ca-look-form"><fieldset className="ca-look-fields ca-edit-fields" disabled={!!draft.archived_at || !!currentLook.archived_at}><Field label="造型名称" placeholder="例如：日常造型、工作造型、雨夜造型" value={currentLook.name} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.name = v; })}/><Field label="造型说明" long placeholder="描述这套造型的使用情境与外观特点。例如：工作时穿着，深色外套，衣角略有磨损。" value={currentLook.description} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.description = v; })}/><Tags key={currentLook.id} value={currentLook.tags} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.tags = v; })}/></fieldset><div className="ca-actions"><button disabled={!!draft.archived_at || !!currentLook.archived_at} aria-label="造型上移" onClick={() => edit(a => { const i = a.looks.findIndex(l => l.id === lookId); if (i > 0) [a.looks[i - 1], a.looks[i]] = [a.looks[i], a.looks[i - 1]]; })}><ArrowUp size={14}/>上移</button><button disabled={!!draft.archived_at || !!currentLook.archived_at} aria-label="造型下移" onClick={() => edit(a => { const i = a.looks.findIndex(l => l.id === lookId); if (i >= 0 && i < a.looks.length - 1) [a.looks[i + 1], a.looks[i]] = [a.looks[i], a.looks[i + 1]]; })}><ArrowDown size={14}/>下移</button><button disabled={!!draft.archived_at || !!currentLook.archived_at || currentLook.id === draft.default_look_id} onClick={() => edit(a => { a.default_look_id = lookId; })}>设为默认造型</button><button disabled={!!draft.archived_at} onClick={() => { if (!currentLook.archived_at && currentLook.id === draft.default_look_id && draft.looks.some(l => !l.archived_at && l.id !== lookId)) { setError('请先将其他造型设为默认，再归档当前造型'); return; } edit(a => { const l = a.looks.find(l => l.id === lookId)!; l.archived_at = l.archived_at ? null : Date.now(); if (l.archived_at && a.default_look_id === l.id) a.default_look_id = null; if (!l.archived_at && !a.default_look_id) a.default_look_id = l.id; }); }}>{currentLook.archived_at ? '恢复造型' : '归档造型'}</button></div></div></details>
                  {currentLook.archived_at && <p className="ca-muted">该造型已归档，图片不显示；恢复造型后可继续编辑。</p>}
                </>}
              </>}
              {(draft.kind !== 'character' || currentLook && !currentLook.archived_at) && <>
                <div className="ca-image-grid-v2" role="list" aria-label={'参考图片，共 ' + images.length + ' 张'}>{images.map(b => { const h = health.find(h => h.id === b.id), name = b.last_known_name || '参考图片', locked = imageLocked(b); return <div role="listitem" key={b.id} className={'ca-tile' + (b.archived_at ? ' archived' : '') + (b.id === representative ? ' is-cover' : '')} draggable={!locked} onDragStart={e => { if (locked) return; drag.current = b.id; e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { drag.current = null; }} onDragOver={e => { if (drag.current) e.preventDefault(); }} onDrop={e => { if (!drag.current) return; e.preventDefault(); e.stopPropagation(); if (!locked) moveImage(drag.current, 0, b.id); drag.current = null; }}>
                  <button type="button" className="ca-tile-open" aria-label={'设置参考图片：' + name} aria-haspopup="dialog" title="单击设置 · 双击放大" onClick={() => setImageId(b.id)} onDoubleClick={() => setImageViewer({ src: bindingSrc(b), name })}>{h && h.state !== 'available' ? <span className="ca-tile-state">{h.label}</span> : <ReferencePreview src={bindingSrc(b)} alt={name}/>}</button>
                  <span className="ca-tile-badge">{b.id === representative ? '代表图' : b.archived_at ? '已归档' : (b.reference_type || '补充参考')}</span>
                  {!b.confirmed && !b.archived_at && <span className="ca-tile-dot" title="参考职责未确认" aria-label="参考职责未确认"/>}
                  <span className="ca-tile-name" title={name}>{name}</span>
                </div>; })}</div>
                {!images.length && empty('还没有参考图片，可以在下方导入，或从访达拖到这里')}
                <details className="ca-add-images" key={draft.id+':'+lookId} open={images.length ? undefined : true}><summary><ImagePlus size={14}/>添加参考图片<span>导入文件 / 从素材库绑定</span></summary><ReferenceImageImport libraryAction={<button disabled={!!busy || !!draft.archived_at} onClick={() => { setMediaQ(''); setMediaPage(1); setModal({ type: 'media' }); }}><ImagePlus size={16}/>从素材库绑定图片</button>} key={draft.id+':'+(currentLook?.id||'')} target={{assetId:draft.id,projectId:draft.project_id,lookId:draft.kind==='character'?currentLook!.id:null}} context={{projectName:owner?.name||'当前项目',assetName:draft.name,lookName:currentLook?.name||'',revision:draft.revision,kind:draft.kind,available:active&&!scriptView&&!draft.archived_at&&!dropJob&&(!currentLook||!currentLook.archived_at)}} disabled={!!busy||!!draft.archived_at} request={request} onReady={importedImage} onBusy={importBusy}/><details className="ca-reference-help"><summary>导入与保存说明</summary><p>导入文件会立即保留在 picture 的项目文件夹；图片关联和代表图需点击下方“保存”后生效，放弃修改不会删除文件。</p><p>拖动图片调整顺序，或在图片设置里前移、后移；代表图仅用于列表展示。参考说明选填，不会自动发送给生成工具。</p></details></details>
              </>}
            </section>
            {draft.kind === 'character' && <section className="ca-sec" id="ca-sec-voice" aria-label="语音"><CharacterVoice key={draft.id} assetId={draft.id} revision={draft.revision} value={draft.details.character_voice} disabled={!!draft.archived_at||!!busy} active={active&&!scriptView} request={request} onChange={value=>{const ownerId=draft.id;edit(a=>{if(a.id===ownerId)a.details.character_voice=value;});}} onBusy={value=>setBusy(current=>value?'正在添加角色语音…':current==='正在添加角色语音…'?'':current)}/></section>}
            <section className="ca-sec" id="ca-sec-shots" aria-label="出场镜头"><AssociatedShots key={draft.id} assetId={draft.id} active={active} request={request} onOpen={onOpenShot}/></section>
          </div>
          <footer className={'ca-savebar' + (dirty ? ' is-dirty' : '')}>
            <span className="ca-save-status" role="status"><i aria-hidden="true"/>{dirty ? '有未保存的修改' : '已保存'} · V{draft.revision} · 更新于 {date(draft.updated_at)}</span>
            {dirty && <button type="button" disabled={!!busy || !!draft.archived_at} onClick={discard}><Undo2 size={15}/>放弃修改</button>}
            <button type="button" className="ca-primary" aria-label="保存资料" disabled={!!busy || !dirty || !!draft.archived_at} onClick={() => void save()}><Save size={15}/>保存</button>
          </footer>
        </aside>}
      </div>
    </fieldset></div>
    {active && !scriptView && imageViewer && <ReferenceImageViewer src={imageViewer.src} name={imageViewer.name} onClose={() => setImageViewer(null)}/>}
    {draft && dialogImage && !imageViewer && <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setImageId(null); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setImageId(null); } }}>
      <div className="ca-modal ca-image-dialog" role="dialog" aria-modal="true" aria-label={'参考图片设置：' + (dialogImage.last_known_name || '参考图片')}>
        <div className="ca-image-dialog-visual">
          {dialogHealth && dialogHealth.state !== 'available' ? <span className="ca-tile-state">{dialogHealth.label}</span> : <ReferencePreview src={bindingSrc(dialogImage)} alt={dialogImage.last_known_name || '参考图片'}/>}
          <div className="ca-image-dialog-tools"><button type="button" onClick={() => setImageViewer({ src: bindingSrc(dialogImage), name: dialogImage.last_known_name || '参考图片' })}><Maximize2 size={15}/>放大</button><button type="button" disabled={!!busy || revealing.includes(dialogImage.id)} aria-busy={revealing.includes(dialogImage.id)} onClick={() => void revealImage(dialogImage)}><FolderOpen size={15}/>{revealing.includes(dialogImage.id) ? '正在定位…' : '在访达中显示'}</button></div>
        </div>
        <div className="ca-image-dialog-side">
          <header><h2>{dialogImage.id === representative ? '代表图' : dialogImage.archived_at ? '已归档的参考图' : '参考图片'}</h2><button aria-label="关闭图片设置" autoFocus onClick={() => setImageId(null)}><X size={18}/></button></header>
          <p className="ca-muted ca-image-file" title={dialogImage.last_known_name || ''}>{dialogImage.last_known_name || '参考图片'} · {dialogHealth?.label ?? (dialogImage.revision ? '正在检查…' : '保存时校验图片')}</p>
          <fieldset className="ca-reference-fields ca-edit-fields" disabled={imageLocked(dialogImage)}>
            <Field label="参考类型" placeholder="例如：身份、服装、材质或空间结构" value={dialogImage.reference_type} onChange={v => edit(a => { a.images.find(i => i.id === dialogImage.id)!.reference_type = v; })}/>
            {[['purpose','用途说明'],['locks','锁定内容'],['ignores','忽略内容']].map(([k,l]) => <Field key={k} label={l} long rows={3} placeholder={referenceHints[draft.kind][k as 'purpose']} value={dialogImage[k as 'purpose']} onChange={v => edit(a => { (a.images.find(i => i.id === dialogImage.id)! as any)[k] = v; })}/>)}
            <label className="ca-check"><input type="checkbox" checked={dialogImage.confirmed} onChange={e => { const v = e.target.checked; edit(a => { a.images.find(i => i.id === dialogImage.id)!.confirmed = v; }); }}/>已确认参考职责</label>
          </fieldset>
          <div className="ca-actions">
            <button disabled={imageLocked(dialogImage) || representative === dialogImage.id || !!dialogHealth && dialogHealth.state !== 'available'} onClick={() => edit(a => setDefault(a, dialogImage.id))}><Star size={14}/>设为代表图</button>
            <button aria-label="图片前移" disabled={imageLocked(dialogImage) || activeImageIds.indexOf(dialogImage.id) <= 0} onClick={() => moveImage(dialogImage.id, -1)}><ArrowLeft size={14}/>前移</button>
            <button aria-label="图片后移" disabled={imageLocked(dialogImage) || activeImageIds.indexOf(dialogImage.id) < 0 || activeImageIds.indexOf(dialogImage.id) >= activeImageIds.length - 1} onClick={() => moveImage(dialogImage.id, 1)}><ArrowRight size={14}/>后移</button>
            <button disabled={imageLocked(dialogImage)} onClick={() => { setImageId(null); setMediaQ(''); setMediaPage(1); setModal({ type: 'media', replace_id: dialogImage.id }); }}>重新选择</button>
            {dialogHealth?.state === 'changed' && <button disabled={imageLocked(dialogImage)} onClick={() => edit(a => { a.images.find(i => i.id === dialogImage.id)!.accept_current = true; })}>确认采用当前内容</button>}
            <button className="ca-danger-text" disabled={!!draft.archived_at || !!currentLook?.archived_at} onClick={() => { const b = dialogImage; if (!b.archived_at && b.id === representative && images.some(i => !i.archived_at && i.id !== b.id)) { setError('请先选择另一张默认代表图，再解绑当前图片'); return; } edit(a => { const image = a.images.find(i => i.id === b.id)!; image.archived_at = image.archived_at ? null : Date.now(); if (image.archived_at && representative === b.id) setDefault(a, null); if (!image.archived_at && !representative) setDefault(a, image.id); }); }}>{dialogImage.archived_at ? '恢复绑定' : '解绑归档'}</button>
          </div>
          <details className="ca-crop"><summary>头像裁切与库内使用</summary>{(['x','y','zoom'] as const).map(k => <label key={k} className="ca-field"><span>{k === 'x' ? '水平位置' : k === 'y' ? '垂直位置' : '缩放'}</span><input disabled={imageLocked(dialogImage)} aria-label={'裁切' + k} type="range" min={k === 'zoom' ? 1 : 0} max={k === 'zoom' ? 3 : 100} step={k === 'zoom' ? .05 : 1} value={dialogImage.crop[k]} onChange={e => { const v = Number(e.target.value); edit(a => { a.images.find(i => i.id === dialogImage.id)!.crop[k] = v; }); }}/></label>)}<span className="ca-avatar ca-crop-preview"><CroppedImage binding={dialogImage} alt="头像裁切预览"/></span><button onClick={() => void run('正在查询使用位置…', async () => { const rows = await api<any[]>('/media/' + dialogImage.media_asset_id + '/usage'); setImageId(null); setModal({ type: 'usage', rows }); })}>查看库内使用位置</button></details>
          <p className="ca-muted">修改在点击详情栏下方“保存”后生效。</p>
        </div>
      </div>
    </div>}
    {dropJob && <div className="ca-modal-backdrop" onKeyDown={e => { if (e.key === 'Escape') closeDropJob(); }}><div className="ca-modal ca-drop-dialog" role="dialog" aria-modal="true" aria-label={dropJob.mode === 'create' ? '拖入图片新建' + labels[dropJob.kind] : '添加参考图'}>
      <header><h2>{dropJob.mode === 'create' ? `用 ${dropJob.items.length} 张图片新建${labels[dropJob.kind]}` : `添加到“${dropJob.asset?.name}”`}</h2><button aria-label="关闭" disabled={dropJob.running} autoFocus onClick={closeDropJob}><X size={18}/></button></header>
      <div className="ca-modal-scroll"><div className="ca-modal-content">
        {dropJob.mode === 'create' && <label className="ca-field ca-drop-kind"><span>类别</span><select aria-label="新建类别" value={dropJob.kind} disabled={dropJob.running || dropJob.items.some(i => i.state !== 'waiting') || publicScope} onChange={e => { const v = e.target.value as Kind; setDropJob(j => j && { ...j, kind: v }); }}>{(Object.keys(labels) as Kind[]).map(k => <option key={k} value={k}>{labels[k]}</option>)}</select></label>}
        {dropJob.mode === 'attach' && dropJob.kind === 'character' && (dropJob.asset?.looks.length ? <label className="ca-field ca-drop-kind"><span>放进造型</span><select aria-label="放进造型" value={dropJob.lookId ?? ''} disabled={dropJob.running || dropJob.items.some(i => i.state !== 'waiting')} onChange={e => { const v = e.target.value; setDropJob(j => j && { ...j, lookId: v }); }}>{dropJob.asset.looks.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label> : <p className="ca-alert">这个人物还没有造型。请先在详情里新增造型，再添加图片。</p>)}
        <p className="ca-muted">{dropJob.mode === 'create' ? '每张图片建立一个资料，名称默认取文件名，可以修改。图片会复制到项目的 picture 文件夹，并设为代表图。' : '图片会复制到项目的 picture 文件夹并立即保存到这份资料；还没有代表图时设为代表图。'}</p>
        <ul className="ca-drop-list">{dropJob.items.map(i => <li key={i.key} className={'is-' + i.state}>
          {dropJob.items.length > 1 && <input type="checkbox" aria-label={'包含 ' + i.file.name} checked={i.include} disabled={dropJob.running || i.state !== 'waiting'} onChange={e => { const v = e.target.checked; patchItem(i.key, { include: v }); }}/>}
          <span className="ca-drop-thumb"><ReferencePreview src={i.preview} alt={i.file.name}/></span>
          <span className="ca-drop-main">{dropJob.mode === 'create' ? <input aria-label={'名称：' + i.file.name} value={i.name} maxLength={120} disabled={dropJob.running || !i.include || !(i.state === 'waiting' || (i.state === 'failed' || i.state === 'unknown') && i.stage === 'create' && !i.assetId)} onChange={e => { const v = e.target.value; patchItem(i.key, { name: v }); }}/> : <strong>{i.file.name}</strong>}
            <small>{i.file.name} · {(i.file.size / 1024 / 1024).toFixed(2)} MB</small>
            {i.message && <small className={'ca-drop-message' + (i.state === 'failed' ? ' is-error' : '')} role={i.state === 'failed' || i.state === 'unknown' ? 'alert' : 'status'}>{i.message}</small>}
            {i.state === 'duplicate' && i.receipt && <span className="ca-drop-duplicate">{i.receipt.candidates.map(c => <label key={c.id}><input type="radio" name={'dup-' + i.key} checked={i.candidate === c.id} onChange={() => patchItem(i.key, { candidate: c.id })}/><span className="ca-drop-thumb small"><ReferencePreview src={c.previewUrl} alt={c.name}/></span>{c.name}<small>{c.reason}</small></label>)}<span className="ca-actions"><button disabled={dropJob.running || !i.candidate} onClick={() => void resolveDuplicate(i, 'reuse')}>使用原图</button><button disabled={dropJob.running} onClick={() => void resolveDuplicate(i, 'import')}>继续导入（重命名）</button></span></span>}
            {i.state === 'unknown' && !!i.claims?.length && <span className="ca-drop-duplicate" role="group" aria-label="待确认的同名资料">{i.claims.map(c => <label key={c.id}><input type="radio" name={'claim-' + i.key} checked={i.claimChoice === c.id} onChange={() => patchItem(i.key, { claimChoice: c.id })}/>{c.name}<small>V{c.revision} · {c.images} 张图 · 建立于 {date(c.created_at)}{c.archived ? ' · 已归档' : ''}</small></label>)}<span className="ca-actions"><button disabled={dropJob.running || !i.claimChoice || !!i.claims.find(c => c.id === i.claimChoice)?.archived} onClick={() => void adoptClaim(i)}>使用这份资料并添加图片</button></span></span>}
            {i.state === 'unknown' && <span className="ca-actions"><button disabled={dropJob.running} onClick={() => void runDropJob()}>核对结果</button></span>}{i.state === 'failed' && i.assetId && !i.adopted && dropJob.mode === 'create' && <span className="ca-actions"><button disabled={dropJob.running} onClick={() => void runDropJob()}>重试导入</button><button disabled={dropJob.running} onClick={() => void archiveCreated(i)}>归档刚建立的资料</button></span>}
          </span>
          <span className="ca-drop-state">{i.state === 'working' ? '处理中…' : i.state === 'done' ? '完成' : i.state === 'failed' ? '未完成' : i.state === 'unknown' ? '结果待核对' : i.state === 'duplicate' ? '待选择' : i.include ? '待处理' : '不处理'}</span>
        </li>)}</ul>
      </div></div>
      <footer>{(() => { const todo = dropJob.items.filter(i => i.include && (i.state === 'waiting' || i.state === 'failed' || i.state === 'unknown')), checkOnly = todo.length > 0 && todo.every(i => i.state === 'unknown'); return todo.length && !(dropJob.mode === 'attach' && dropJob.kind === 'character' && !dropJob.lookId) ? <button className="ca-primary" disabled={dropJob.running || !!busy && !dropJob.running} onClick={() => void runDropJob()}>{dropJob.running ? '正在处理…' : checkOnly ? '核对结果' : todo.some(i => i.state !== 'waiting') ? '继续处理' : dropJob.mode === 'create' ? `新建 ${todo.length} 个${labels[dropJob.kind]}` : '添加图片'}</button> : null; })()}<button disabled={dropJob.running} onClick={closeDropJob}>{dropJob.items.some(i => i.state === 'done') ? '完成' : '取消'}</button></footer>
    </div></div>}
    {modal && <div className="ca-modal-backdrop"><div className={"ca-modal" + (modal.type === 'media' ? ' ca-media-modal' : '')} role="dialog" aria-modal="true" aria-label={modal.type === 'media' ? '选择素材库图片' : modal.type === 'copy' ? '复制人物' : modal.type === 'import' ? '选择来源人物' : modal.type === 'create' ? '新建资产' : modal.type === 'history' ? '来源与版本' : '资料记录'}><header><h2>{modal.type === 'media' ? '选择素材库图片' : modal.type === 'copy' ? '复制人物' : modal.type === 'import' ? '选择来源人物' : modal.type === 'create' ? '新建' + labels[kind] : modal.type === 'history' ? '来源与版本' : '资料记录'}</h2><button aria-label="关闭弹窗" disabled={!!busy} onClick={() => setModal(null)}><X size={18}/></button></header>
      {modal.type === 'media' && <div className="ca-media-toolbar"><label className="ca-media-search"><Search size={17}/><input aria-label="搜索图片素材" placeholder="按名称搜索素材库图片" value={mediaQ} onChange={e => { setMediaQ(e.target.value); setMediaPage(1); }}/></label><div className="ca-media-info" role="status">{mediaLoading ? '正在查找图片…' : <>共 {mediaTotal} 张图片<span>{modal.replace_id ? '点击图片，替换当前绑定' : '点击图片，绑定到当前资料'}</span></>}</div></div>}
      <div className="ca-modal-scroll" ref={modalScroll} tabIndex={0} aria-label={modal.type === 'media' ? '可滚动图片列表' : '可滚动弹窗内容'}><fieldset disabled={!!busy} className="ca-modal-content">{error && <div className="ca-alert" role="alert">{error}</div>}
      {modal.type === 'create' && <Field label="新资产名称" value={modal.name} onChange={v => setModal({ ...modal, name: v })}/>}
      {modal.type === 'media' && <><div className="ca-media-picker">{mediaRows.map(m => <button disabled={!!busy || mediaLoading} key={m.id} onClick={() => void run('正在校验图片…', async () => { const h = await api<any>('/media/' + m.id + '/inspect'); if (h.state !== 'available') throw Error(h.label); edit(a => { if (modal.replace_id) { const b = a.images.find(b => b.id === modal.replace_id)!; b.media_asset_id = m.id; b.accept_current = true; b.last_known_name = m.name; } else { const id = crypto.randomUUID(); a.images.push({ id, look_id: a.kind === 'character' ? lookId : null, media_asset_id: m.id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: false, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: m.name }); if (!representative) setDefault(a, id); } }); setModal(null); })}><span className="ca-media-thumb"><img loading="lazy" src={'/api/media/' + m.id + '/original'} alt=""/></span><span className="ca-media-name" title={m.name}>{m.name}</span></button>)}</div>{!mediaLoading && !mediaRows.length && <div className="ca-empty">{mediaQ ? '没有匹配的图片，试试其他名称。' : '暂无图片，请先在素材库添加图片目录。'}</div>}</>}
      {modal.type === 'import' && <><label className="ca-field"><span>来源项目</span><select aria-label="来源项目" value={modal.source_project} onChange={e => setModal({ ...modal, source_project: e.target.value, source_rows: [] })}>{scopes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button disabled={!!busy} onClick={() => void run('正在读取来源人物…', async () => { const r = await api<any>('/assets?' + new URLSearchParams({ project_id: modal.source_project, kind: 'character', page: String(modal.source_page ?? 1) })); setModal({ ...modal, source_rows: r.items, source_total: r.total }); })}>读取人物</button>{modal.source_rows.map((a: Asset) => <button className="ca-source-choice" key={a.id} onClick={() => void run('正在准备复制…', async () => { const p = await api<any>('/assets/' + a.id + '/copy-preview?project_id=' + scope); setModal({ type: 'copy', ...p, project_id: scope, name: a.name, base_info: a.base_info, performance_info: a.performance_info }); })}>{a.name} · V{a.revision}</button>)}{modal.source_total > 40 && <div className="ca-pagination"><button disabled={(modal.source_page ?? 1) === 1} onClick={() => setModal({ ...modal, source_page: (modal.source_page ?? 1) - 1, source_rows: [] })}>上一页</button><span>第 {modal.source_page ?? 1} 页，切换后点击读取人物</span><button disabled={(modal.source_page ?? 1) * 40 >= modal.source_total} onClick={() => setModal({ ...modal, source_page: (modal.source_page ?? 1) + 1, source_rows: [] })}>下一页</button></div>}</>}
      {modal.type === 'copy' && <><p>复制来源：{modal.source.name} · V{modal.source_revision}。将复制未归档造型、图片绑定、职责和默认设置，原图片文件复用。</p><label className="ca-field"><span>目标项目</span><select aria-label="目标项目" value={modal.project_id} disabled={!!modal.pending} onChange={e => setModal({ ...modal, project_id: e.target.value })}>{scopes.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><Field label="复制后人物名称" value={modal.name} onChange={v => setModal({ ...modal, name: v })}/><Field label="复制后基础信息" long value={modal.base_info} onChange={v => setModal({ ...modal, base_info: v })}/><Field label="复制后性格与表演" long value={modal.performance_info} onChange={v => setModal({ ...modal, performance_info: v })}/><p>{modal.source.looks.filter((l: Look) => !l.archived_at).length} 套造型 · {modal.source.images.filter((b: Binding) => !b.archived_at).length} 张图片绑定</p>{modal.pending && <p role="alert">上次复制结果尚未确认，请先查询结果。不要再次创建另一份复制。</p>}</>}
      {modal.type === 'history' && draft && <div className="ca-form"><p>创建于 {date(draft.created_at)} · 当前 V{draft.revision}</p>{draft.source ? <div className="ca-source"><strong>复制来源：{draft.source.project_name} / {draft.source.asset_name}</strong><p>来源 V{draft.source.revision} · {date(draft.source.copied_at)}</p><small>当前副本独立编辑；共用的原图片文件仍受素材库可用性影响。</small></div> : <p className="ca-muted">在当前项目创建</p>}<code>{draft.id}</code><h3>数据版本</h3>{!versions.length && <p className="ca-muted">正在读取版本…</p>}{versions.map(v => <div className="ca-version" key={v.id}><strong>V{v.version}</strong><span>{v.summary} · {date(v.created_at)}</span><button onClick={() => void run('正在读取版本…', async () => { setModal({ type: 'version', data: await api('/assets/' + draft.id + '/versions/' + v.version) }); })}>查看</button></div>)}</div>}
      {modal.type === 'version' && <pre>{JSON.stringify(modal.data, null, 2)}</pre>}{modal.type === 'usage' && <>{modal.rows.map((r: any) => <p key={r.id}>{scopes.find(s => s.id === r.project_id)?.name} / {r.name}{r.archived_at ? '（归档）' : ''} · {r.look_id ? '造型图片' : '资产参考图'}</p>)}{!modal.rows.length && <p>尚无已保存的库内使用记录</p>}</>}
      {modal.type === 'compare' && <><div className="ca-compare"><section><h3>本地编辑</h3><pre>{JSON.stringify(draft, null, 2)}</pre></section><section><h3>数据库最新 V{modal.latest.revision}</h3><pre>{JSON.stringify(modal.latest, null, 2)}</pre></section></div><p>请核对资料。合并以当前本地内容为基础，采用最新版本号后仍需再次保存；再次发生更新时仍会阻止覆盖。</p><button onClick={() => { edit(a => { a.revision = modal.latest.revision; }); setConflict(null); setModal(null); setNotice('已保留本地内容，请完成核对后点击保存'); }}>保留本地内容，进入核对保存</button></>}
    </fieldset></div><footer>{modal.type === 'media' && <div className="ca-pagination ca-media-pagination"><span>第 {mediaPage} / {Math.max(1, Math.ceil(mediaTotal / 40))} 页</span><button disabled={!!busy || mediaLoading || mediaPage === 1} onClick={() => setMediaPage(v => v - 1)}>上一页</button><button disabled={!!busy || mediaLoading || mediaPage * 40 >= mediaTotal} onClick={() => setMediaPage(v => v + 1)}>下一页</button></div>}{modal.type === 'create' && <button className="ca-primary" disabled={!!busy || !modal.name.trim()} onClick={() => void run('正在创建资产…', async () => { const a = await api<Asset>('/assets', { project_id: scope, kind, name: modal.name }); install(a); setModal(null); setArchived(false); setQ(''); await loadList(); })}>创建并编辑</button>}{modal.type === 'copy' && <>{modal.pending ? <button onClick={() => void run('正在查询复制结果…', async () => { const r = await api<any>('/copies/' + modal.request_id); if (r.completed) { setScope(r.asset.project_id); install(r.asset); setModal(null); setNotice('人物已复制'); } else setModal({ ...modal, pending: false }); })}>查询复制结果</button> : <button className="ca-primary" disabled={!!busy || !modal.name.trim()} onClick={() => void run('正在复制人物…', async () => { try { const a = await api<Asset>('/assets/' + modal.source.id + '/copy', { project_id: modal.project_id, name: modal.name, base_info: modal.base_info, performance_info: modal.performance_info, source_revision: modal.source_revision, request_id: modal.request_id }); setScope(a.project_id); if (scopes.find(s => s.id === a.project_id)?.project_kind === 'normal') selectProject(a.project_id); install(a); setKind('character'); setArchived(false); setQ(''); setPage(1); setModal(null); setNotice('已复制人物，副本可独立编辑'); if (a.project_id === scope) await loadList(); } catch (e: any) { if (!/同名|已经更新|无效|归档/.test(e.message)) setModal({ ...modal, pending: true }); throw e; } })}><Copy size={15}/>确认复制</button>}</>}<button disabled={!!busy} onClick={() => setModal(null)}>关闭</button></footer></div></div>}
  </section>;
}
