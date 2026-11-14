import {useFeedbackToast} from '../global-feedback';
import React, { useEffect, useRef, useState } from 'react';
import { Plus, Save, Globe2, Archive, Copy, ImagePlus, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, X, Search, FolderKanban, FolderOpen, MoreHorizontal, Undo2, Maximize2, History, Star, Users, ScanFace, Radar, SlidersHorizontal, ZoomIn, Layers } from 'lucide-react';
import type { ProjectAssetProps } from '../ProjectAssetWorkspace';
import { readMemory, readStored, saveStored } from '../browser-preferences';
import {imageNamePreset} from '../import-presets.mjs';
import './asset-library.css';
import {AssociatedShots} from './AssociatedShots';
import {contextUnavailable, ownerLabel, scopePath, scopedWrite, type AssetContext, type AssetOwner, type ScopedItem, type ScopedList} from './scoped';
import {ScopeOverrides, withEffective, type AppendHandlers, type AppendPreview, type OverrideField, type ScoreDimension} from './ScopeOverrides';
import {ImpactPreview, type ImpactPreviewData} from './ImpactPreview';
import {SeasonSettings} from './SeasonSettings';
import {SeriesAlignment} from './SeriesAlignment';
import {MergeBanner, MergeDialog, MergeDoneBar, UndoMergeDialog, useMergeGroups} from './CharacterMerge';
import {memberPlaces, mergeErrorText, pendingStore, siblingHint, type MergeGroup, type MergeReceipt, type RelatedCharacters} from './merge';
import {ProjectScript} from './ProjectScript';
import {CharacterVoice} from './CharacterVoice';
import {CharacterAttributes} from './CharacterAttributes';
import {AttributeConfig} from './AttributeConfig';
import {AttributePopover} from './AttributePopover';
import {ReferenceImageImport,ReferencePreview} from './ReferenceImageImport';
import {ReferenceImageViewer} from './ReferenceImageViewer';
import {CropBox,type Crop} from './CropBox';
import {useImageDesktopAction, capability, actionPending, skippedText, revealDispatched, type ImageCapabilities, type ImageCopyMode, type ImageSelectionItem} from './image-desktop';

type Kind = 'character' | 'scene' | 'prop';
type Look = { id: string; name: string; description: string; tags: string[]; default_image_id: string | null; archived_at: number | null; revision?: number };
// 裁切来源（后端记录）：null 旧记录未知；untouched 从未调整；manual 用户拖过；auto 采用了自动框到头部。
// crop_manually_edited 是后端保留的人工历史：拖过一次以后，即使框又回到默认值、来源回到 untouched，也不再自动框。
type CropSource = 'untouched' | 'manual' | 'auto';
type HeadState = 'idle' | 'loading' | 'found' | 'not_found' | 'unsupported' | 'busy' | 'error' | 'stale';
const headText: Record<HeadState, string> = {
  idle: '', loading: '正在找头部…', found: '已自动框到头部，可以再拖', not_found: '没认出头部，请自己拖动框',
  unsupported: '这张图暂不支持自动框（目前只认写实照片），请自己拖动框', busy: '识别正忙，稍后再点「重新框到头部」',
  error: '自动框没有完成，请自己拖动框', stale: '这张图刚在别处改过，请关掉面板重新打开',
};
// 「重新框到头部」：认不出、不支持、图已变化时再点也没用，先停用；正忙或出错可以再试。
const headRetry = (h: HeadState) => !['loading', 'not_found', 'unsupported', 'stale'].includes(h);
type Binding = { id: string; look_id: string | null; media_asset_id: string; reference_type: string; purpose: string; locks: string; ignores: string; confirmed: boolean; archived_at: number | null; crop: { x: number; y: number; zoom: number }; last_known_name?: string; accept_current?: boolean; revision?: number; expected_sha256?: string | null; crop_source?: CropSource | null; crop_manually_edited?: boolean; was_card_default?: boolean };
type Asset = { id: string; project_id: string; kind: Kind; name: string; base_info: string; performance_info: string; details: Record<string, string>; revision: number; default_look_id: string | null; default_image_id: string | null; archived_at: number; storyboard_protected?: boolean; looks: Look[]; images: Binding[]; updated_at: number; created_at: number; source: null | { project_name: string; asset_name: string; revision: number; copied_at: number }; cover?: Binding | null; look_count?: number };
type Scope = { id: string; name: string; project_kind: string };
type Health = { id: string; state: string; label: string };
type Receipt = { id: string; status: string; mediaAssetId?: string; fileName: string; error?: string; candidates: { id: string; name: string; reason: string; previewUrl: string }[] };
// 每个拖入项固定导入编号、绑定编号和新造型编号：回应丢失后按原编号核对，不重新上传、不重复绑定。
type DropStage = 'create' | 'look' | 'import' | 'bind' | 'done';
type DropItem = { key: string; file: File; preview: string; name: string; lookName: string; nameEdited?: boolean; lookEdited?: boolean; include: boolean; state: 'waiting' | 'working' | 'unknown' | 'duplicate' | 'failed' | 'done'; message: string; stage: DropStage; requestId: string; bindingId: string; newLookId: string; startedAt: number; createPending?: boolean; createAt?: number; preExisting?: string[]; pendingName?: string; adopted?: boolean; claims?: { id: string; name: string; revision: number; created_at: number; images: number; archived: boolean }[]; claimChoice?: string; assetId?: string; lookId?: string | null; mediaAssetId?: string; fileName?: string; receipt?: Receipt; candidate?: string };
type DropJob = { mode: 'create' | 'attach'; kind: Kind; projectId: string; asset?: { id: string; name: string; looks: Look[] }; lookId: string | null; items: DropItem[]; running: boolean };
const labels: Record<Kind, string> = { character: '人物', scene: '场景', prop: '道具' };
const date = (v: number) => new Date(v).toLocaleString('zh-CN');
const preview = (b: Binding) => '/api/project-assets/bindings/' + b.id + '/preview';
const bindingSrc = (b: Binding) => b.revision ? preview(b) : '/api/project-assets/media/' + b.media_asset_id + '/preview';
const empty = (s: string) => <div className="ca-empty">{s}</div>;
/** How long a reference-tile click waits before opening 图片设置, so a second click can still become a double click. */
const TILE_OPEN_DELAY = 400;
const imageFile = (f: File) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i.test(f.name);
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
type CropBase = { id: string; identity: string; crop: Binding['crop']; source: CropSource | null; edited: boolean };
const cropBase = (b: Binding): CropBase => ({ id: b.id, identity: imageIdentity(b), crop: { ...b.crop }, source: b.crop_source ?? null, edited: !!b.crop_manually_edited });
// 保存头像前的前提：仍是同一张默认图（同一绑定、同一图片内容），裁切、来源和人工历史都没被别处改过
// （别处拖过再撤销，框和来源回到原值，但人工历史已经留下，也算改过）。
function cropBaseHolds(a: Asset, base: CropBase) {
  const b = a.images.find(i => i.id === base.id);
  return !!b && !b.archived_at && coverOf(a)?.id === base.id && imageIdentity(b) === base.identity && sameValue(b.crop, base.crop) && (b.crop_source ?? null) === base.source && !!b.crop_manually_edited === base.edited;
}
function coverOf(a: Asset) { const l = a.looks?.find(l => l.id === a.default_look_id); return a.images?.find(b => b.id === (a.kind === 'character' ? l?.default_image_id : a.default_image_id)) ?? null; }
// Display fields a card quick action may change, recorded before/after so 撤销 can reverse exactly them.
type DisplayChange = { field: 'default_look_id' | 'default_image_id' | 'look_default' | 'crop'; id?: string };
// guards: the images this change is about, as they were right after the quick save. 撤销 only runs
// while each is still live and still the same picture (same media, look and content digest).
type DisplayChangeEntry = DisplayChange & { before: unknown; after: unknown; guards: { id: string; identity: string }[] };
const imageIdentity = (b: Binding) => JSON.stringify([b.media_asset_id, b.look_id ?? null, b.expected_sha256 ?? null]);
const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function readDisplay(a: Asset, c: DisplayChange): unknown {
  if (c.field === 'default_look_id' || c.field === 'default_image_id') return a[c.field];
  if (c.field === 'look_default') return a.looks.find(l => l.id === c.id)?.default_image_id;
  // 裁切与裁切来源同组：一起核对、一起撤销。
  const b = a.images.find(b => b.id === c.id); return b ? { crop: b.crop, crop_source: b.crop_source ?? null } : undefined;
}
// Writes a value back; refuses when the look or image it points at is gone or archived.
function guardsHold(a: Asset, c: DisplayChangeEntry): boolean {
  return c.guards.every(g => { const b = a.images.find(i => i.id === g.id); return !!b && !b.archived_at && imageIdentity(b) === g.identity
    && (!b.look_id || a.looks.some(l => l.id === b.look_id && !l.archived_at)); });
}
function writeDisplay(a: Asset, c: DisplayChange, value: unknown): boolean {
  const liveImage = (id: unknown) => id === null || a.images.some(b => b.id === id && !b.archived_at);
  if (c.field === 'default_look_id') { if (value !== null && !a.looks.some(l => l.id === value && !l.archived_at)) return false; a.default_look_id = value as string | null; return true; }
  if (c.field === 'default_image_id') { if (!liveImage(value)) return false; a.default_image_id = value as string | null; return true; }
  if (c.field === 'look_default') { const l = a.looks.find(l => l.id === c.id); if (!l || l.archived_at || !liveImage(value)) return false; l.default_image_id = value as string | null; return true; }
  const b = a.images.find(b => b.id === c.id), v = value as { crop: Binding['crop']; crop_source: CropSource | null } | undefined;
  if (!b || b.archived_at || !v) return false; b.crop = v.crop; b.crop_source = v.crop_source; return true;
}
function displayChanges(before: Asset, after: Asset): DisplayChangeEntry[] {
  const out: DisplayChangeEntry[] = [];
  const guard = (id: unknown) => { const b = typeof id === 'string' ? after.images.find(i => i.id === id) : undefined; return b ? [{ id: b.id, identity: imageIdentity(b) }] : []; };
  const add = (c: DisplayChange) => {
    const b = readDisplay(before, c), a = readDisplay(after, c); if (sameValue(b, a)) return;
    const guards = c.field === 'crop' ? guard(c.id) : c.field === 'default_look_id' ? [] : [...guard(b), ...guard(a)];
    out.push({ ...c, before: b, after: a, guards });
  };
  add({ field: 'default_look_id' }); add({ field: 'default_image_id' });
  after.looks.forEach(l => add({ field: 'look_default', id: l.id }));
  after.images.forEach(b => add({ field: 'crop', id: b.id }));
  return out;
}
// 换默认图时后端在同一次保存里给首次成为默认、从未调整过的图自动框头部；提示里说出来，撤销会一起恢复。
const autoNote = (before: Asset, saved: Asset, id: string) => saved.images.find(b => b.id === id)?.crop_source === 'auto' && before.images.find(b => b.id === id)?.crop_source !== 'auto' ? '，头像已自动框到头部' : '';
function Avatar({ a }: { a: Asset }) { const b = coverOf(a); return <span className="ca-avatar">{b ? <CroppedImage binding={b}/> : a.name.slice(0, 1)}</span>; }
function Cover({ a, binding }: { a: Asset; binding?: Binding | null }) { const b = binding === undefined ? coverOf(a) : binding; return <span className={'ca-card-cover' + (b ? '' : ' is-empty')}>{b ? <CroppedImage binding={b}/> : <span className="ca-card-initial">{a.name.slice(0, 1)}</span>}</span>; }

export function AssetLibrary({ focusProject, openSeasonSettings: seasonFocus, active, request, activeProject, refreshSeconds, onSettings, onOpenShot, registerProjectSwitchGuard }: ProjectAssetProps) {
  const api = <T = any,>(url: string, body?: unknown, method?: string) => request<T>('/project-assets' + url, body, method);
  // v2：新画廊默认卡片显示，不沿用旧版窄列表时期保存的“列表”偏好。
  const prefKey = 'shiguang.creative.preferences.v2';
  const remembered = () => readMemory().display ? readStored<{ kind: Kind; layout: string }>(prefKey, { kind: 'character', layout: 'grid' }, (v): v is { kind: Kind; layout: string } => !!v && typeof v === 'object' && ['character', 'scene', 'prop'].includes((v as any).kind) && ['grid','list'].includes((v as any).layout)) : { kind: 'character' as Kind, layout: 'grid' };
  const [scopes, setScopes] = useState<Scope[]>([]), [scope, setScope] = useState(activeProject);
  const readScopePrefs = (id: string) => readMemory().display ? readStored('shiguang.creative.scope.v2.' + id, { ...remembered(), archived: false }, (v): v is { kind: Kind; layout: string; archived: boolean } => !!v && typeof v === 'object' && ['character','scene','prop'].includes((v as any).kind) && ['grid','list'].includes((v as any).layout) && typeof (v as any).archived === 'boolean') : { kind: 'character' as Kind, layout: 'grid', archived: false };
  const [kind, setKind] = useState<Kind>(() => readScopePrefs(scope).kind), [layout, setLayout] = useState(() => readScopePrefs(scope).layout), [q, setQ] = useState(''), [archived, setArchived] = useState(() => readScopePrefs(scope).archived), [page, setPage] = useState(1);
  const [rows, setRows] = useState<Asset[]>([]), [total, setTotal] = useState(0), [draft, setDraft] = useState<Asset | null>(null), [base, setBase] = useState(''), [lookId, setLookId] = useState('');
  const [busy, setBusy] = useState(''), [notice, setNotice] = useState(''), [error, setError] = useState(''), [conflict, setConflict] = useState<Asset | null>(null), [health, setHealth] = useState<Health[]>([]);
  useFeedbackToast(notice, {source: '项目资产', active: active, kind: 'auto'});
  useFeedbackToast(error, {source: '项目资产', active: active});
  // from: 'card' = opened from a gallery card (stays while the detail of that card loads); otherwise it belongs to the open detail.
  const [imageViewer, setImageViewer] = useState<{src:string;name:string;from?:'card'}|null>(null);
  const [modal, setModal] = useState<any>(null), [mediaQ, setMediaQ] = useState(''), [mediaPage, setMediaPage] = useState(1), [mediaRows, setMediaRows] = useState<any[]>([]), [mediaTotal, setMediaTotal] = useState(0), [versions, setVersions] = useState<any[]>([]);
  const [scopesKnown,setScopesKnown]=useState(false),[scopesError,setScopesError]=useState(''),[scopesRetry,retryScopes]=useState(0);
  useFeedbackToast(scopesError, {source: '项目资产', active: active});
  const [mediaLoading, setMediaLoading] = useState(false), [listLoading, setListLoading] = useState(false);
  const [scriptView,setScriptView]=useState(false),[scriptDirty,setScriptDirty]=useState(false);const scriptDirtyRef=useRef(scriptDirty);scriptDirtyRef.current=scriptDirty;
  // 新界面状态：参考图弹窗、菜单、画廊筛选、拖入导入、剧本中出现的资产名称
  const [imageId, setImageId] = useState<string | null>(null), [menu, setMenu] = useState<'' | 'page' | 'detail'>(''), [missingOnly, setMissingOnly] = useState(false);
  const [dragTarget, setDragTarget] = useState(''), [dropJob, setDropJob] = useState<DropJob | null>(null), [scriptNames, setScriptNames] = useState<{ kind: Kind; name: string }[]>([]), [scriptNamesRead, setScriptNamesRead] = useState<{ project: string; status: 'loading' | 'ok' | 'error' }>({ project: '', status: 'loading' });
  const dropJobRef = useRef(dropJob); dropJobRef.current = dropJob;
  const dragDepth = useRef(0), detailScroll = useRef<HTMLDivElement>(null);
  useEffect(() => setImageViewer(null), [active, scope, kind, scriptView]);
  useEffect(() => setImageViewer(v => v?.from === 'card' ? v : null), [draft?.id, lookId]);
  useEffect(() => setImageId(null), [active, scope, draft?.id, lookId, kind, scriptView]);
  const [cropOpen, setCropOpen] = useState(false);
  useEffect(() => setCropOpen(false), [imageId]);
  // Card quick actions (menu / pick default image / adjust avatar) and the 撤销 toast after a quick save.
  // crop 面板：source 是这次要提交的裁切来源（拖过 manual，采用建议 auto）；head 是自动框状态；
  // seq 每次请求或拖动都加一，晚于用户操作返回的识别结果按 seq 丢弃。
  // base：打开「调整头像」时的默认图身份与裁切，点「完成」前用最新记录核对，变了就不覆盖。
  const [quick, setQuick] = useState<{ id: string; mode: 'menu' | 'multi' | 'pick' | 'crop' | 'attrs' | 'compare'; ids?: string[]; x: number; y: number; crop?: Crop; source?: CropSource; head?: HeadState; seq?: number; base?: CropBase } | null>(null);
  // 详情图片设置里的裁切：只有「重新框到头部」，不在打开时自动改草稿。
  // 当前浮层（菜单 / 面板）的实例：异步打开「调整头像」只在发起它的那个菜单仍然开着时才生效。
  const quickNow = useRef(quick); quickNow.current = quick;
  const [detailHead, setDetailHead] = useState<{ id: string; head: HeadState } | null>(null);
  const headSeq = useRef(0), detailSeq = useRef(0);
  const [undo, setUndo] = useState<{ id: string; text: string; changes: DisplayChangeEntry[] } | null>(null);
  useEffect(() => setQuick(null), [active, scope, kind, scriptView]);
  useEffect(() => { detailSeq.current++; setDetailHead(null); }, [imageId, draft?.id]);
  useEffect(() => { if (!undo) return; const t = setTimeout(() => setUndo(null), 10000); return () => clearTimeout(t); }, [undo]);
  const quickRef = useRef<HTMLDivElement>(null);
  // 人物属性：维度配置弹窗；配置保存后递增版本让详情里的属性重新读取。
  // attrDialog = the number of the open dimension dialog (0 = closed). Each opening gets a new number, so a late reply
  // from an older dialog (e.g. another project's save) can only close itself, never the one now on screen.
  const [attrDialog, setAttrDialog] = useState(0), attrSeq = useRef(0), [attrConfigVersion, setAttrConfigVersion] = useState(0);
  const openAttrConfig = () => setAttrDialog(++attrSeq.current);
  // The dimension dialog belongs to one project: switching project (from any entry) closes it, so a draft never follows.
  useEffect(() => { setAttrDialog(0); }, [scope]);
  // Characters pick like the video page (Finder): a click selects one and shows its detail; ⌘ adds or removes;
  // Shift picks the run from the anchor; dragging on empty space draws a box; ⌘A / ⌘C / Esc; right-click acts on the picks.
  // pickedAssets only holds two or more (a single pick is the open detail). Reference images keep option A (checkbox / ⌘ / Shift).
  const [pickedAssets, setPickedAssets] = useState<string[]>([]), [pickedImages, setPickedImages] = useState<string[]>([]);
  const lastPick = useRef<{ assets?: string; images?: string }>({});
  const [caps, setCaps] = useState<ImageCapabilities | null>(null), [revealAsk, setRevealAsk] = useState<string | null>(null);
  const desktop = useImageDesktopAction(scope, request);
  useEffect(() => { setPickedAssets([]); lastPick.current.assets = undefined; }, [scope, kind, archived, page]);
  useEffect(() => { setPickedImages([]); lastPick.current.images = undefined; }, [draft?.id]);
  useEffect(() => {
    if (!active || !scope) return; let live = true; setCaps(null);
    request<ImageCapabilities>('/project-assets/projects/' + encodeURIComponent(scope) + '/desktop-capabilities').then(c => { if (live) setCaps(c); }).catch(() => { if (live) setCaps(null); });
    return () => { live = false; };
  }, [active, scope]);
  useEffect(() => {
    if (!quick) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setQuick(null); };
    const down = (e: MouseEvent) => { const t = e.target as HTMLElement; if (quickRef.current && !quickRef.current.contains(t) && !t.closest?.('[data-quick-trigger]')) setQuick(null); };
    window.addEventListener('keydown', key); document.addEventListener('mousedown', down);
    quickRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    return () => { window.removeEventListener('keydown', key); document.removeEventListener('mousedown', down); };
  }, [quick?.id, quick?.mode]);
  useEffect(() => {
    if (!pickedAssets.length && !pickedImages.length) return;
    const key = (e: KeyboardEvent) => { if (e.key !== 'Escape' || quick || imageId || modal) return; if (pickedImages.length) setPickedImages([]); else setPickedAssets([]); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [pickedAssets.length, pickedImages.length, !!quick, !!imageId, !!modal]);
  const modalScroll = useRef<HTMLDivElement>(null);
  // Reference tiles: a click opens 图片设置 and a double click opens the large view. The settings dialog covers the
  // tile, so it opens after a short wait; a second click within it becomes the double click. Keyboard (detail 0) opens at once.
  const tileTimer = useRef<number>();
  /** Drop a queued 图片设置 that has not opened yet (double click, multi-select, switching look/character, leaving the page). */
  const cancelTileOpen = () => { if (tileTimer.current) { clearTimeout(tileTimer.current); tileTimer.current = undefined; } };
  const tileClick = (id: string, detail: number) => {
    cancelTileOpen();
    if (detail === 0) { setImageId(id); return; }
    tileTimer.current = window.setTimeout(() => { tileTimer.current = undefined; setImageId(id); }, TILE_OPEN_DELAY);
  };
  useEffect(() => cancelTileOpen, []);
  useEffect(cancelTileOpen, [draft?.id, lookId, active, scriptView]);
  // The script view covers the gallery: no image settings stay open (or reopen) across it.
  useEffect(() => { if (scriptView) setImageId(null); }, [scriptView]);
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
  const scopeRef = useRef(scope); scopeRef.current = scope; const scopeBaseRef = useRef(''); const listTokenRef = useRef<{ base: string; token: string } | null>(null);
  /** 当前作用域列表返回的 context_token；作用域变了就不用旧的。 */
  const scopeToken = () => listTokenRef.current && listTokenRef.current.base === scopeBaseRef.current ? listTokenRef.current.token : undefined;
  const healthGeneration = useRef(0);
  const generation = useRef(0), drag = useRef<string | null>(null), draftIdRef = useRef(draft?.id); draftIdRef.current = draft?.id;
  const draftRef = useRef(draft); draftRef.current = draft;
  const lookRef=useRef(lookId);lookRef.current=lookId;
  const selectionGeneration = useRef(0);
  // 第二期 P2a：当前项目所属的剧 / 季（读不到 = 后端还没有作用域接口或项目未归剧，保持原有行为）
  const [assetCtx, setAssetCtx] = useState<AssetContext | null>(null), [seriesView, setSeriesView] = useState(false);
  const [metas, setMetas] = useState<Record<string, Omit<ScopedItem<Asset>, 'asset'>>>({});
  const seriesViewRef = useRef(seriesView); seriesViewRef.current = seriesView;
  /** 当前是否按作用域读写：项目属于某部剧，且不在公共人物库。 */
  const scoped = !!assetCtx?.series && scopes.find(x => x.id === scope)?.project_kind !== 'public' && assetCtx.project.id === scope;
  const scopeBase = scoped ? (seriesView ? scopePath('series', assetCtx!.series!.id) : scopePath('episode', assetCtx!.project.id)) : ''; scopeBaseRef.current = scopeBase;
  // 归组版本只对作用域列表有意义：未归剧的项目读回归组时不应重读列表（否则会把刚出现的读取错误冲掉）
  const listRevision = scopeBase ? assetCtx?.membership_revision ?? '' : '';
  const listContext = `${active}:${scope}:${kind}:${q}:${archived}:${page}:${scopeBase}:${listRevision}`;
  const listContextRef = useRef(listContext); listContextRef.current = listContext;
  const importedBindings=useRef(new Set<string>()),importActivity=useRef(new Set<string>());
  const seriesImportRef = useRef('');
  const importBusy=(working:boolean,owner:string)=>{if(working){importActivity.current.add(owner);setNotice('');setBusy('正在导入图片…');}else{importActivity.current.delete(owner);setBusy(old=>old==='正在导入图片…'&&!importActivity.current.size?'':old);}};
  function importedImage(r:{target:{assetId:string;projectId:string;lookId:string|null};mediaAssetId?:string;fileName:string}){
    // 全剧视图导入：目标是剧（projectId = 剧编号），全剧资产本身没有 project_id
    const seriesTarget = !!seriesImportRef.current && seriesImportRef.current === r.target.projectId;
    if(!r.mediaAssetId||draftIdRef.current!==r.target.assetId||(!seriesTarget&&scopeRef.current!==r.target.projectId)||r.target.lookId!==null&&lookRef.current!==r.target.lookId)return;
    const id=crypto.randomUUID();
    setDraft(old=>{if(!old||old.archived_at||old.id!==r.target.assetId||(seriesTarget?old.project_id!==null:old.project_id!==r.target.projectId))return old;const a=structuredClone(old),look=a.looks.find(l=>l.id===r.target.lookId);if(a.kind==='character'&&(!look||look.archived_at))return old;
      a.images.push({id,look_id:r.target.lookId,media_asset_id:r.mediaAssetId!,reference_type:a.kind==='character'?'人物身份':'',purpose:'',locks:'',ignores:'',confirmed:false,archived_at:null,crop:{x:50,y:50,zoom:1},last_known_name:r.fileName});
      if(look&&!look.default_image_id)look.default_image_id=id;else if(a.kind!=='character'&&!a.default_image_id)a.default_image_id=id;importedBindings.current.add(id);return a;});
  }
  const publicScope = scopes.find(s => s.id === scope)?.project_kind === 'public';
  const owner = draft ? scopes.find(s => s.id === draft.project_id) : null;
  // 第二期 P2a 第 1 步：继承资产（集视图）和全剧视图先只读；本集覆盖与全剧编辑在下一步接入，后端同样会拒绝越权写入
  const draftOwner: AssetOwner | undefined = draft && scopeBase ? metas[draft.id]?.owner : undefined;
  /** 全剧视图里打开的是全剧资产时，本地文件导入到剧（series_context_token）；值为剧编号。 */
  const seriesImport = scopeBase && seriesView && draftOwner?.type === 'series' && assetCtx?.series ? assetCtx.series.id : '';
  seriesImportRef.current = seriesImport;
  const draftMeta = draft && scopeBase ? metas[draft.id] : undefined;
  /** 集视图里继承自全剧的资产：基础字段只读，默认造型 / 默认图在「本集设置」里覆盖。 */
  const inheritedHere = !!draftMeta && !seriesView && draftOwner?.type === 'series';
  const scopeLock = !draft || !scopeBase ? '' : seriesView ? (draftMeta?.capabilities.edit_base === false ? '当前没有编辑全剧资料的权限。' : '') : inheritedHere ? '这是全剧共享的资产：名字、造型、图片和裁切在本集只读；默认造型和默认图可以在上方「本集设置」里单独改。要改全剧资料，请切到「全剧」。' : '';
  // 集视图共享人物的评分维度：按人物读（服务端按归属返回剧级维度），版本与详情里的 attribute_config_revision 对齐才可改分
  const [scopeDims, setScopeDims] = useState<{ revision: number; dims: ScoreDimension[] } | null>(null);
  useEffect(() => {
    setScopeDims(null); if (!inheritedHere || draft?.kind !== 'character' || !scopeBase) return; let live = true;
    api<{ revision: number; dimensions: ScoreDimension[] }>(scopeBase + '/attribute-config?asset_id=' + encodeURIComponent(draft.id)).then(c => { if (live) setScopeDims({ revision: c.revision, dims: c.dimensions ?? [] }); }).catch(e => { if (live) setError('评分维度读取失败：' + (e.message || '请稍后重试')); });
    return () => { live = false; };
  }, [inheritedHere, draft?.id, draft?.kind, scopeBase]);
  const effectiveConfigRevision = (draftMeta?.effective as { attribute_config_revision?: number } | undefined)?.attribute_config_revision;
  const dimsAligned = !!scopeDims && (effectiveConfigRevision === undefined || effectiveConfigRevision === scopeDims.revision);
  /** 全剧视图里归档 / 解绑造型和图片要先看影响范围（P2a 第 4 步接入），这里暂不开放。 */
  const archiveViaPreview = !!scopeBase && seriesView;
  /** 全剧共享资产 / 造型 / 图片的「恢复」合同 v1 还没有作用域接口（旧接口会被拒绝）：先不显示，并说明。 */
  const sharedRestoreBlocked = !!scopeBase && draftOwner?.type === 'series';
  const sharedRestoreNote = '全剧共享资产归档后，这一版还不能在页面里恢复。';
  const locked = !!draft?.archived_at || !!scopeLock;
  const run = async (label: string, fn: () => Promise<void>) => { if (busy) return; setBusy(label); setError(''); try { await fn(); } catch (e: any) { setError(e.message || '操作失败'); } finally { setBusy(''); } };
  const canLeave = () => (!scriptDirtyRef.current || window.confirm('剧本尚未保存，确定切换吗？未保存内容仍保留在当前页面。')) && (!dirtyRef.current || window.confirm('当前修改尚未保存，确定放弃这些修改吗？'));
  // 顶栏统一（TOPBAR-UNIFY）：资产页范围 = 顶栏的当前项目，或页内切到的公共人物库。
  // 切项目由宿主先调用登记的保护（下方 registerProjectSwitchGuard），通过后这里只负责重置，不再二次询问。
  /** 复制完成后：目标是顶栏当前项目或公共库时在页内打开副本，否则留在原处提示去哪里看。 */
  async function afterCopy(a: Asset, done: string) {
    const target = scopes.find(x => x.id === a.project_id);
    setModal(null);
    if (a.project_id !== activeProject && target?.project_kind !== 'public') { setNotice(`${done}：已放进「${target?.name ?? '目标项目'}」。在顶部切到该项目即可查看`); return; }
    setScope(a.project_id); install(a); setKind('character'); setArchived(false); setQ(''); setPage(1); setNotice(done);
    if (a.project_id === scope) await loadList();
  }
  function applyScope(next: string) {
    if (next === scopeRef.current) return;
    const pref = readScopePrefs(next); selectionGeneration.current++; setDetailLoading(false); generation.current++; healthGeneration.current++; scopeRef.current = next;
    setScope(next); setRows([]); setTotal(0); setListLoading(!!next && active);
    setDraft(null); setBase(''); setLookId(''); setConflict(null); setHealth([]); setVersions([]); setError(''); setNotice('');
    if(scopes.find(s=>s.id===next)?.project_kind==='public')setScriptView(false);
    setKind(scopes.find(s => s.id === next)?.project_kind === 'public' ? 'character' : pref.kind); setLayout(pref.layout); setArchived(pref.archived); setPage(1); setQ('');
  }
  const publicId = scopes.find(s => s.project_kind === 'public')?.id ?? '';
  const currentScope = scopes.find(s => s.id === activeProject && s.project_kind === 'normal');
  // 归组（剧 / 季）随时可能在别处被改（另一窗口移集、换季）：刷新列表、回到窗口、写入遇 ASSET_SCOPE_CHANGED 时都重读；
  // 只采用最新一次请求的结果。返回读到的归组，供「本季设定」打开前确认当前季。
  const ctxSeq = useRef(0), activeProjectRef = useRef(activeProject); activeProjectRef.current = activeProject;
  // 归组新旧的唯一判定：同一集只采用 membership_revision 不比已采用的更旧的结果。后台重读与「本季设定」打开都经过这里，
  // 谁的请求先发、谁的回应后到都不影响：旧版本的回应既不改页面显示的归属，也不能打开旧季。
  const ctxRef = useRef<AssetContext | null>(null);
  function adoptContext(c: AssetContext | null): boolean {
    const cur = ctxRef.current;
    if (c && cur && cur.project.id === c.project.id && Number(cur.membership_revision) > Number(c.membership_revision)) return false;
    ctxRef.current = c; setAssetCtx(c); return true;
  }
  async function fetchContext(): Promise<AssetContext | null> {
    const project = activeProjectRef.current, seq = ++ctxSeq.current;
    if (!project) { adoptContext(null); return null; }
    try {
      const c = await request<AssetContext>('/projects/' + encodeURIComponent(project) + '/asset-context');
      if (seq !== ctxSeq.current || project !== activeProjectRef.current) return null;
      const next = c?.project?.id === project ? c : null; if (!adoptContext(next)) return ctxRef.current; return next;
    } catch (e: any) {
      if (seq !== ctxSeq.current) return null;
      adoptContext(null); if (!contextUnavailable(e)) setError('读取项目所属的剧和季失败：' + (e.message || '请稍后重试')); return null;
    }
  }
  useEffect(() => { if (!active || !activeProject) { ctxSeq.current++; adoptContext(null); return; } void fetchContext(); return () => { ctxSeq.current++; }; }, [active, activeProject]);
  useEffect(() => {
    if (!active) return; const again = () => { if (!document.hidden) void fetchContext(); };
    document.addEventListener('visibilitychange', again); window.addEventListener('focus', again);
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('focus', again); };
  }, [active, activeProject]);
  // 换项目回到「第 N 集」；不在任何剧里时「全剧」不可选
  useEffect(() => { setSeriesView(false); }, [activeProject]);
  useEffect(() => { if (!assetCtx?.series) setSeriesView(false); }, [assetCtx?.series?.id]);
  // 维度对话框按视图区分本集 / 全剧配置：切视图就关掉，草稿不会跟到另一层
  useEffect(() => { setAttrDialog(0); }, [seriesView]);
  // 集里的维度已由全剧统一（合同 v1 · A1）：「去全剧设置」切到全剧视图后再打开全剧的维度设置
  const attrAfterSeries = useRef(false);
  useEffect(() => { if (seriesView && attrAfterSeries.current) { attrAfterSeries.current = false; openAttrConfig(); } }, [seriesView]); // eslint-disable-line react-hooks/exhaustive-deps
  function goSeriesAttrConfig() {
    setAttrDialog(0); if (!assetCtx?.series) return;
    if (seriesView) { openAttrConfig(); return; }
    attrAfterSeries.current = true; if (!showSeries(true)) attrAfterSeries.current = false;
  }
  /** 页内「第 N 集 ｜ 全剧」切换：走同一套离开确认，只改资产页看的层级。 */
  function showSeries(on: boolean): boolean {
    if (on === seriesView && !publicScope) return true;
    if (busy || modal || dropJob || !canLeave()) return false;
    if (publicScope) applyScope(activeProject);
    selectionGeneration.current++; generation.current++; setDetailLoading(false);
    setDraft(null); setBase(''); setRows([]); setTotal(0); setPage(1); setQ(''); setPickedAssets([]); setSeriesView(on);
    return true;
  }
  /** 页内「本集 ｜ 公共人物库」切换：走同一套离开确认，只改资产页范围，不改全局当前项目。 */
  function showPublic(on: boolean) {
    const next = on ? publicId : activeProject;
    if (!next || next === scope || busy || modal || dropJob || !canLeave()) return;
    // 离开检查通过后才一起切换：取消时仍留在全剧视图，不会先退出全剧
    applyScope(next); setSeriesView(false);
  }
  // 宿主切项目前问一次：忙碌、对话框、图片导入中直接拦下；有未保存的资产或剧本修改时沿用原确认文案。
  const switchGuard = useRef<() => boolean>(() => true);
  switchGuard.current = () => {
    if (busy || modal || dropJob) { setNotice('项目资产正在处理（' + (busy || (dropJob ? '图片导入' : '对话框未关闭')) + '），完成后再切换项目'); return false; }
    return canLeave();
  };
  useEffect(() => { if (!registerProjectSwitchGuard) return; registerProjectSwitchGuard(() => switchGuard.current()); return () => registerProjectSwitchGuard(null); }, [registerProjectSwitchGuard]);
  function install(a: Asset) { if (draftRef.current?.id !== a.id || draftRef.current?.kind !== a.kind) setVersions([]); if (draftRef.current?.id !== a.id || draftRef.current?.revision !== a.revision) setHealth([]); setDraft(a); setBase(JSON.stringify(a)); setLookId(old => draftIdRef.current === a.id && a.looks.some(l => l.id === old) ? old : a.default_look_id ?? a.looks.find(l => !l.archived_at)?.id ?? ''); setConflict(null); }
  const edit = (fn: (a: Asset) => void) => setDraft(old => { if (!old || old.archived_at) return old; const next = structuredClone(old); fn(next); return next; });
  // The last list query that came back successfully, with its own count. "Empty" is only shown when that confirmed
  // result belongs to the query on screen and was itself zero (FE1-R1: a failed read is not empty; FE2-R3: coming
  // back to a kind while its reload is pending must not reuse the cleared rows as "zero").
  const [listOk, setListOk] = useState<{ key: string; total: number } | null>(null);
  const listKey = [scope, kind, q, archived, page, scopeBase, listRevision].join('|');
  async function loadList() {
    if (!active || !scope) return;
    const ticket = ++generation.current, context = listContext, key = listKey; setListLoading(true);
    try {
      const params = new URLSearchParams({ kind, q, archived: String(archived), page: String(page) });
      if (scopeBase) {
        const result = await api<ScopedList<Asset>>(scopeBase + '/assets?' + params);
        if (ticket !== generation.current || scopeRef.current !== scope || listContextRef.current !== context) return;
        setMetas(old => { const next = { ...old }; for (const { asset, ...meta } of result.items) next[asset.id] = meta; return next; });
        listTokenRef.current = { base: scopeBase, token: result.context_token }; // 同作用域列表的令牌：新建等写入要用它（合同 v1）
        setRows(result.items.map(i => i.asset)); setTotal(result.total); setListOk({ key, total: result.total });
        return;
      }
      params.set('project_id', scope);
      const result = await api<{ items: Asset[]; total: number }>('/assets?' + params);
      if (ticket !== generation.current || scopeRef.current !== scope || listContextRef.current !== context) return;
      // 画廊优先：不再自动打开第一项，由使用者点选后在右侧查看详情。
      setRows(result.items); setTotal(result.total); setListOk({ key, total: result.total });
    } catch (e) {
      if (ticket === generation.current && scopeRef.current === scope) { setRows([]); setTotal(0); setListOk(null); throw e; }
    } finally { if (ticket === generation.current) setListLoading(false); }
  }
  /** 共享资产的附属读取（图片状态、版本历史）要带作用域；本集自有、普通项目与公共库走原路由。 */
  const assetReadBase = (id: string) => scopeBaseRef.current && metas[id]?.owner.type === 'series' ? scopeBaseRef.current : '';
  async function loadHealth(a: Asset) { const ticket = ++healthGeneration.current; const result = await api<{ revision: number; images: Health[] }>(assetReadBase(a.id) + '/assets/' + a.id + '/health'); if (ticket === healthGeneration.current && draftIdRef.current === a.id && result.revision === a.revision) setHealth(result.images); }
  useEffect(() => {
    if (!active) return;
    let live = true;
    setScopesError('');
    void api<{ items: Scope[]; storage: string }>('/scopes').then(r => {
      if (!live) return;
      setScopes(r.items); setScopesKnown(true);
      // 当前项目还没确定或已不存在时留空，不自动落到别的项目或公共库
      if (!r.items.some(p => p.id === scopeRef.current)) { const next = activeProject && r.items.some(p => p.id === activeProject) ? activeProject : ''; scopeRef.current = next; setScope(next); }
    }).catch(e => { if (live) setScopesError(e.message); });
    return () => { live = false; };
  }, [active, activeProject,scopesRetry]);
  // 当前项目变了（宿主已问过保护）：跟过去；在公共人物库里换集也回到那一集
  useEffect(() => { if (lastActiveProject.current === activeProject) return; lastActiveProject.current = activeProject; applyScope(activeProject); }, [activeProject]);
  useEffect(() => {
    let live = true;
    setRows([]); setTotal(0); setListLoading(false);
    if (active) { setError(''); void loadList().catch(e => { if (live) setError(e.message); }); }
    return () => { live = false; generation.current++; };
  }, [active, scope, kind, q, archived, page, scopeBase, listRevision]);
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
  useEffect(() => { if (readMemory().display) { saveStored(prefKey, { kind, layout }); if (scope) saveStored('shiguang.creative.scope.v2.' + scope, { kind, layout, archived }); } }, [kind, layout, scope, archived]);
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
  useEffect(()=>{if(active&&focusProject?.id&&lastFocusProject.current!==focusProject.request){lastFocusProject.current=focusProject.request;if(scope!==focusProject.id&&canLeave())applyScope(focusProject.id);}},[active,focusProject?.request]);
  useEffect(() => {
    if (!active || modal?.type !== 'history' || !draft) return;
    let live = true; setVersions([]);
    if (inheritedHere) { setVersions([]); return; } // 集里看不到全剧的版本历史：在「来源与版本」里提示切到全剧
    void api<any[]>(assetReadBase(draft.id) + '/assets/' + draft.id + '/versions').then(r => { if (live && draftIdRef.current === draft.id && scopeRef.current === scope) setVersions(r); }).catch(e => { if (live && draftIdRef.current === draft.id && scopeRef.current === scope) setError(e.message); });
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
    let live = true; setScriptNamesRead({ project: scope, status: 'loading' });
    void Promise.all((['character', 'scene', 'prop'] as Kind[]).map(k => api<{ items: Asset[] }>('/assets?' + new URLSearchParams({ project_id: scope, kind: k, q: '', archived: 'false', page: '1' })).then(r => r.items.map(a => ({ kind: k, name: a.name })))))
      .then(all => { if (live) { setScriptNames(all.flat()); setScriptNamesRead({ project: scope, status: 'ok' }); } }).catch(() => { if (live) { setScriptNames([]); setScriptNamesRead({ project: scope, status: 'error' }); } });
    return () => { live = false; };
  }, [active, scriptView, scope, publicScope]);
  // Opening a detail is a quiet read: no page-wide busy bar (it pushed the page down and greyed every button, so each
  // click flashed). Only the detail panel is held while it loads; a short note appears if it takes longer than 300 ms.
  const [detailLoading, setDetailLoading] = useState(false), [detailSlow, setDetailSlow] = useState(false), detailRef = useRef<HTMLElement>(null);
  useEffect(() => { if (!detailLoading) { setDetailSlow(false); return; } const t = window.setTimeout(() => setDetailSlow(true), 300); return () => clearTimeout(t); }, [detailLoading]);
  async function openAsset(id: string, asked = false) {
    if (busy || !asked && !canLeave()) return;
    const ticket = ++selectionGeneration.current, project = scope; setDetailLoading(true); setError('');
    // The old detail stays on screen but must not take input while it is being replaced (keyboard included).
    if (detailRef.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const base = scopeBase;
    try {
      if (base) {
        const r = await api<ScopedItem<Asset>>(base + '/assets/' + id);
        if (ticket === selectionGeneration.current && project === scopeRef.current && base === scopeBaseRef.current) { const { asset, ...meta } = r; setMetas(old => ({ ...old, [asset.id]: { ...old[asset.id], ...meta } })); install(!seriesViewRef.current && meta.owner?.type === 'series' ? withEffective(asset, meta) : asset); }
        return;
      }
      const a = await api<Asset>('/assets/' + id); if (ticket === selectionGeneration.current && project === scopeRef.current && a.project_id === project) install(a);
    }
    catch (e: any) { if (ticket === selectionGeneration.current) setError(e.message || '读取资料失败'); }
    finally { if (ticket === selectionGeneration.current) setDetailLoading(false); }
  }
  /** 异步写入 / 读取回来后采用详情：必须仍在发出时的作用域、仍是打开的那份资料；有未保存修改时不覆盖（版本变了只给冲突提示）。 */
  function adopt(base: string, asset: Asset, meta: Omit<ScopedItem<Asset>, 'asset'> | null) {
    if (base !== scopeBaseRef.current) return false;
    if (meta) setMetas(old => ({ ...old, [asset.id]: { ...old[asset.id], ...meta } }));
    const open = draftRef.current; if (!open || open.id !== asset.id) return false;
    const next = meta && !seriesViewRef.current && meta.owner?.type === 'series' ? withEffective(asset, meta) : asset;
    if (dirtyRef.current || scriptDirtyRef.current) { if (open.revision !== asset.revision) setConflict(next); return false; }
    install(next); return true;
  }
  /** 后台刷新打开的资料（写入被拒、季设置改动后）：不切换选择、不打断编辑，规则同 adopt。 */
  async function refreshDetail(id: string) {
    const base = scopeBaseRef.current; if (!base) return;
    try { const r = await api<ScopedItem<Asset>>(base + '/assets/' + id); const { asset, ...meta } = r; adopt(base, asset, meta); } catch { /* 刷新失败不影响当前编辑 */ }
  }
  /** Clicking the character whose detail is already open does nothing (no reload, no flash). */
  const alreadyOpen = (id: string) => draft?.id === id && !detailLoading;
  function dropDetail() { selectionGeneration.current++; setDetailLoading(false); setDraft(null); setBase(''); setLookId(''); setConflict(null); setHealth([]); setVersions([]); setImageId(null); setMenu(''); }
  function closeDetail() { if (busy || !canLeave()) return false; dropDetail(); return true; }
  function discard() { if (!draft || !dirty || busy || !window.confirm('放弃当前修改，恢复到上次读取的资料？已导入的图片文件仍保留在项目文件夹。')) return; install(JSON.parse(base)); setNotice('已放弃修改'); }
  type NameCheck = { status: 'available' | 'existing_local' | 'inherit_shared' | 'conflict'; match?: { id: string; name: string }; conflicts?: { id: string; name: string; scope_name?: string }[]; context_token?: string; related_characters?: RelatedCharacters };
  /** 新建：作用域模式先查同名（全剧已有 → 问继承还是另建；本集已有或冲突 → 说明改名），再按选择创建；旧模式照旧。 */
  async function submitCreate(name: string, onShared: 'reject' | 'reuse') {
    const base = scopeBaseRef.current;
    await run('正在创建资产…', async () => {
      if (!base) { const a = await api<Asset>('/assets', { project_id: scope, kind, name }); install(a); setModal(null); setArchived(false); setQ(''); await loadList(); return; }
      if (onShared === 'reject') {
        const c = await api<NameCheck>(base + '/names/check', { kind, name }, 'POST');
        if (c.status === 'inherit_shared') { setModal((m: any) => m && m.type === 'create' ? { ...m, check: c } : m); return; }
        if (c.status === 'existing_local') throw Error('本集已有同名的「' + name + '」，请换个名字');
        // 合同 B0：别的集已有同名人物（集与集允许同名，但多半是同一个人）→ 先问是合并 / 提升到全剧，还是换个名字
        if (c.related_characters && c.related_characters.action !== 'none' && c.related_characters.items.length) { setModal((m: any) => m && m.type === 'create' ? { ...m, check: c } : m); return; }
        if (c.status === 'conflict') throw Error('和' + (c.conflicts ?? []).map(x => '「' + (x.scope_name ? x.scope_name + ' · ' : '') + x.name + '」').join('、') + '同名冲突，请换个名字');
      }
      const r = await scopedWrite<(ScopedItem<Asset> & { reused?: boolean }) | ({ id: string; reused?: boolean })>(api, base + '/assets', { request_id: crypto.randomUUID(), context_token: scopeToken() ?? assetCtx?.context_token, kind, name, on_shared: onShared }, 'POST');
      setModal(null); setArchived(false); setQ(''); await loadList();
      const id = 'asset' in r && r.asset ? r.asset.id : (r as { id: string }).id;
      if ('asset' in r && r.asset) { const { asset, ...meta } = r; setMetas(old => ({ ...old, [asset.id]: { ...old[asset.id], ...meta } })); }
      await openAsset(id, true);
      setNotice(r.reused ? '已继承全剧的「' + name + '」，本集可在「本集设置」里单独调整' : '已新建「' + name + '」');
    });
  }
  /** 集里追加造型：预览 → 确认，确认后以服务端读回的详情为准。 */
  const appendHandlers: AppendHandlers = {
    preview: async name => {
      const d = draftRef.current, base = scopeBaseRef.current; if (!d || !base) throw Error('没有打开的人物');
      try { return await api<AppendPreview>(base + '/assets/' + d.id + '/append/preview', { context_token: metas[d.id]?.context_token ?? scopeToken() ?? assetCtx?.context_token, item: { type: 'look', name } }, 'POST'); }
      catch (e: any) { setError(e.message || '预览失败'); throw e; }
    },
    confirm: async (token, allowSeriesDefault) => {
      const d = draftRef.current, base = scopeBaseRef.current; if (!d || !base) return false;
      // run() 会接住错误只显示提示：用 ok 告诉调用方是否真的追加成功，失败时确认框留着，不能当成功关掉
      let ok = false;
      await run('正在追加到全剧…', async () => {
        try {
          const r = await scopedWrite<ScopedItem<Asset>>(api, base + '/assets/' + d.id + '/append', { request_id: crypto.randomUUID(), context_token: metas[d.id]?.context_token ?? scopeToken() ?? assetCtx?.context_token, preview_token: token, ...(allowSeriesDefault ? { allow_series_default: true } : {}) }, 'POST');
          const { asset, ...meta } = r; adopt(base, asset, meta);
          ok = true; await loadList(); setNotice('已加到全剧，并记下来源是本集');
        } catch (e: any) {
          if (['ASSET_SCOPE_CHANGED', 'ASSET_STALE', 'ASSET_IMPACT_CHANGED'].includes(e.code)) { if (e.code === 'ASSET_SCOPE_CHANGED') void fetchContext(); void refreshDetail(d.id); throw Error('影响范围或资料刚变了，已重新读取，请重新预览后再确认'); }
          throw e;
        }
      });
      return ok;
    },
  };
  // 第二期 P2a 第 4 步：全剧里的归档（资产 / 造型 / 图片）和本集资产提升到全剧，都先看影响再确认
  type ImpactState = { kind: 'archive' | 'promotion'; base: string; assetId: string; target?: { type: 'asset' | 'look' | 'image'; id: string }; replacement: string | null; data: ImpactPreviewData; label: string };
  const [impactState, setImpactState] = useState<ImpactState | null>(null), [seasonOpen, setSeasonOpen] = useState<{ id: string; name: string; seriesName: string; source: { projectId: string; token: string } } | null>(null);
  /** 打开本季设定前重读归组，锁定在确认后的季；这一集已不在任何季时说明。 */
  // 每次打开动作带编号，绑定发起时的集：切集或新的打开动作让旧结果作废，不会用切换后的集去重读、打开别的季
  const seasonOpenSeq = useRef(0);
  useEffect(() => { seasonOpenSeq.current++; }, [activeProject]);
  async function openSeasonSettings(expectSeasonId?: string) {
    if (!canLeave()) return;
    const project = activeProjectRef.current, seq = ++seasonOpenSeq.current;
    const stale = () => seq !== seasonOpenSeq.current || project !== activeProjectRef.current;
    if (!project) return;
    let c: AssetContext;
    try { c = await request<AssetContext>('/projects/' + encodeURIComponent(project) + '/asset-context'); }
    catch (e: any) { if (!stale()) setError('读取这一集所属的季失败：' + (e.message || '请稍后重试')); return; }
    if (stale() || c?.project?.id !== project) return;
    // 页面已经采用了更新的归组（例如回到窗口时读到这集已换季）：这次的旧结果作废，不改显示、不打开旧季
    if (!adoptContext(c)) { setNotice('这一集的所属季刚变了，没有打开旧的本季设定；请按现在的季重新打开'); return; }
    if (expectSeasonId && c.season?.id !== expectSeasonId) { setNotice('这一集的所属季已变化，没有打开本季设定；请从项目目录重新打开'); return; }
    if (!c.season || !c.series) { setNotice('这一集现在不属于任何季，没有本季设定'); return; }
    // 记下打开时的来源集和它的归组令牌：季写入时一起提交，服务端在写事务里核对这集仍在这一季
    setSeasonOpen({ id: c.season.id, name: c.season.name, seriesName: c.series.name, source: { projectId: c.project.id, token: c.context_token } });
  }
  // 项目目录季菜单「本季设定…」：宿主核对归组并切到资产页后传来；同一 request 只处理一次
  const seasonFocusDone = useRef(0);
  useEffect(() => {
    if (!active || !seasonFocus || seasonFocus.request === seasonFocusDone.current) return;
    seasonFocusDone.current = seasonFocus.request; void openSeasonSettings(seasonFocus.seasonId);
  }, [active, seasonFocus?.request]); // eslint-disable-line react-hooks/exhaustive-deps
  // 切到别的集：本季设定是借这一集打开的，旧弹窗关掉
  useEffect(() => { setSeasonOpen(cur => cur && cur.source.projectId !== activeProject ? null : cur); }, [activeProject]);
  useEffect(() => { if (seasonOpen && assetCtx && assetCtx.season?.id !== seasonOpen.id) { setSeasonOpen(null); setNotice('这一集的所属季刚变了，本季设定已关闭；请重新打开，会按现在的季显示'); } }, [assetCtx?.season?.id]);
  async function previewArchive(target: { type: 'asset' | 'look' | 'image'; id: string }, label: string, replacement: string | null = null) {
    const d = draftRef.current, base = scopeBaseRef.current; if (!d || !base) return;
    if (dirtyRef.current || scriptDirtyRef.current) { setError('这份资料有未保存的修改：请先保存或放弃修改，再归档'); return; }
    await run('正在核对归档影响…', async () => {
      const data = await api<ImpactPreviewData>(base + '/assets/' + d.id + '/archive-impact', { context_token: metas[d.id]?.context_token ?? scopeToken() ?? assetCtx?.context_token, target, ...(replacement ? { replacement_id: replacement } : {}) }, 'POST');
      if (base !== scopeBaseRef.current || draftRef.current?.id !== d.id) return; // 等待期间换了集或资料：预览作废
      setImpactState({ kind: 'archive', base, assetId: d.id, target, replacement, data, label });
    });
  }
  async function previewPromotion() {
    const d = draftRef.current, base = scopeBaseRef.current; if (!d || !base) return;
    if (dirtyRef.current || scriptDirtyRef.current) { setError('这份资料有未保存的修改：请先保存或放弃修改，再提升到全剧'); return; }
    await run('正在核对提升影响…', async () => {
      const data = await api<ImpactPreviewData>(base + '/assets/' + d.id + '/promotion/preview', { context_token: metas[d.id]?.context_token ?? scopeToken() ?? assetCtx?.context_token }, 'POST');
      if (base !== scopeBaseRef.current || draftRef.current?.id !== d.id) return;
      setImpactState({ kind: 'promotion', base, assetId: d.id, replacement: null, data, label: '「' + d.name + '」' });
    });
  }
  async function confirmImpact() {
    const st = impactState, base = st?.base; if (!st || !base) return;
    if (base !== scopeBaseRef.current) { setImpactState(null); setError('预览之后换了集或视图：没有提交，请重新预览'); return; }
    // 确认开始时再核对：打开的仍是这份资料、没有未保存修改；否则不提交
    if (draftRef.current?.id !== st.assetId || dirtyRef.current || scriptDirtyRef.current) { setImpactState(null); setError('预览之后资料有了未保存的修改或换了资料：没有提交，请先保存后重新预览'); return; }
    await run(st.kind === 'archive' ? '正在归档…' : '正在提升到全剧…', async () => {
      try {
        await scopedWrite(api, base + '/assets/' + st.assetId + (st.kind === 'archive' ? '/archive' : '/promotion'), { request_id: crypto.randomUUID(), context_token: metas[st.assetId]?.context_token ?? scopeToken() ?? assetCtx?.context_token, preview_token: st.data.preview_token }, 'POST');
      } catch (e: any) {
        if (e.code === 'ASSET_IMPACT_CHANGED' || e.code === 'ASSET_STALE') { setImpactState(null); if (st.kind === 'archive' && st.target) void previewArchive(st.target, st.label, st.replacement); else void previewPromotion(); throw Error('影响范围刚变了，已重新预览，请核对后再确认'); }
        throw e;
      }
      setImpactState(null); await loadList();
      await refreshDetail(st.assetId);
      setNotice(st.kind === 'archive' ? '已归档' + st.label + '，受影响的季和集已按预览回退' : '已把' + st.label + '提升到全剧，原有造型、图片和镜头引用保持不变');
    });
  }
  // 换集 / 切视图：旧作用域的影响预览、追加图片确认作废，不能在新作用域里确认
  useEffect(() => { setImpactState(cur => cur && cur.base !== scopeBase ? null : cur); setModal((cur: { type?: string } | null) => cur?.type === 'append-image' ? null : cur); }, [scopeBase]);
  const impactNameOf = (id: string) => draft?.looks.find(l => l.id === id)?.name ?? draft?.images.find(b => b.id === id)?.last_known_name ?? scopeDims?.dims.find(d => d.id === id)?.name ?? (impactState?.data.impact.blockers ?? []).flatMap(b => b.candidates ?? []).find(c => c.id === id)?.name ?? id;
  /** 集内追加图片：素材库选图 → 签发回执 → 预览，再在确认框里确认（回执过期或内容变化时提示重选）。 */
  async function appendImagePick(m: { id: string; name: string }) { await appendFromMedia(m, modal?.append?.lookId ?? null); }
  /** 本集追加图片：素材库选图、或本地文件上传完成（append_context_token）后，都走签发图片回执 → 预览 → 明确确认。 */
  async function appendFromMedia(m: { id: string; name: string }, lookIdFor: string | null) {
    const d = draftRef.current, base = scopeBaseRef.current; if (!d || !base) return;
    await run('正在核验图片…', async () => {
      const ctxToken = metas[d.id]?.context_token ?? scopeToken() ?? assetCtx?.context_token;
      const receipt = await api<{ media_receipt_id: string; file_name?: string; preview_url?: string; expires_at?: number }>(base + '/assets/' + d.id + '/append/media-receipt', { context_token: ctxToken, look_id: lookIdFor, media_asset_id: m.id }, 'POST');
      const preview = await api<AppendPreview>(base + '/assets/' + d.id + '/append/preview', { context_token: ctxToken, item: { type: 'image', look_id: lookIdFor, media_receipt_id: receipt.media_receipt_id } }, 'POST');
      if (base !== scopeBaseRef.current || draftRef.current?.id !== d.id) return; // 等待期间换了集或资料：不弹旧资料的确认框
      setModal({ type: 'append-image', preview, fileName: receipt.file_name || m.name, previewUrl: receipt.preview_url, lookId: lookIdFor, allow: false });
    });
  }
  // 本地文件上传完成时导入组件还占着忙碌状态：先记下，忙碌结束后再进入追加确认
  const [appendReady, setAppendReady] = useState<{ assetId: string; projectId: string; mediaId: string; name: string; lookId: string | null } | null>(null);
  useEffect(() => {
    if (!appendReady || busy) return; const x = appendReady; setAppendReady(null);
    if (draftRef.current?.id !== x.assetId || x.projectId !== scopeRef.current || seriesViewRef.current) { setNotice('图片已上传到本集文件夹，但打开的资料已换：没有追加，可以之后从素材库选择这张图'); return; }
    void appendFromMedia({ id: x.mediaId, name: x.name }, x.lookId);
  }, [appendReady, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  /** 作用域导入前核对目标：读本作用域详情，比对版本、类型和归档。 */
  async function verifyScopedTarget(t: { assetId: string; lookId: string | null }) {
    const base = scopeBaseRef.current; if (!base) throw Error('当前不在剧集作用域，请重新打开资料');
    const r = await api<ScopedItem<Asset>>(base + '/assets/' + t.assetId);
    return { revision: r.asset.revision, kind: r.asset.kind, archived: !!r.asset.archived_at, lookArchived: !!r.asset.looks.find(l => l.id === t.lookId)?.archived_at };
  }
  /** 本集设置：默认造型 / 默认图的设置或恢复上层。返回更新后的详情；作用域或版本已变时重读并说明。 */
  async function applyOverride(field: OverrideField, action: 'set' | 'inherit', value: unknown, writeToken: string) {
    const d = draftRef.current, base = scopeBaseRef.current; if (!d || !base) return;
    await run(action === 'set' ? '正在保存本集设置…' : '正在恢复上层…', async () => {
      try {
        const r = await scopedWrite<ScopedItem<Asset>>(api, base + '/assets/' + d.id + '/overrides', { request_id: crypto.randomUUID(), context_token: metas[d.id]?.context_token ?? scopeToken() ?? assetCtx?.context_token, write_token: writeToken, field, action, ...(action === 'set' ? { value } : {}) }, 'PATCH');
        const { asset, ...meta } = r; adopt(base, asset, meta);
        await loadList(); setNotice(action === 'set' ? '已保存本集设置，只影响这一集' : field.key === 'attribute_score' ? '已恢复全剧评分' : '已恢复上层设置');
      } catch (e: any) {
        if (['ASSET_SCOPE_CHANGED', 'ASSET_STALE', 'ASSET_IMPACT_CHANGED'].includes(e.code)) { if (e.code === 'ASSET_SCOPE_CHANGED') void fetchContext(); void refreshDetail(d.id); throw Error((e.code === 'ASSET_SCOPE_CHANGED' ? '这一集的所属剧或季刚变了' : '这份资料刚在别处更新过') + '，已重新读取，请核对后再设置'); }
        throw e;
      }
    });
  }
  /** 读一份资料：作用域模式读 <scope>/assets/:id（同时更新来源与令牌），否则走原接口。 */
  async function readAsset(id: string): Promise<Asset> {
    const base = scopeBaseRef.current; if (!base) return api<Asset>('/assets/' + id);
    const r = await api<ScopedItem<Asset>>(base + '/assets/' + id); const { asset, ...meta } = r; setMetas(old => ({ ...old, [asset.id]: { ...old[asset.id], ...meta } })); return asset;
  }
  /** 整份保存：作用域模式带 request_id 与 context_token 写 <scope>/assets/:id，以服务端读回为准。 */
  async function writeAsset(id: string, asset: Asset, expected: number): Promise<Asset> {
    const base = scopeBaseRef.current; if (!base) return api<Asset>('/assets/' + id, { asset, expected_revision: expected }, 'PUT');
    const r = await scopedWrite<ScopedItem<Asset> | Asset>(api, base + '/assets/' + id, { request_id: crypto.randomUUID(), context_token: metas[id]?.context_token ?? scopeToken() ?? assetCtx?.context_token, expected_revision: expected, asset }, 'PUT');
    if ('asset' in r && r.asset) { const { asset: saved, ...meta } = r; setMetas(old => ({ ...old, [saved.id]: { ...old[saved.id], ...meta } })); return saved; }
    return r as Asset;
  }
  async function save() { if (!draft || draft.archived_at || scopeLock || importActivity.current.size) return; await run('正在保存资产…', async () => { try { const a = await writeAsset(draft.id, draft, draft.revision); install(a); await loadList(); const adopted=a.images.some(b=>!b.archived_at&&importedBindings.current.has(b.id));a.images.forEach(b=>importedBindings.current.delete(b.id));setNotice((adopted?(a.kind==='character'?'已绑定到造型 · ':'已绑定参考图片 · '):'')+'已保存 · V'+a.revision); } catch (e: any) { if (e.message.includes('已经更新') || e.code === 'ASSET_STALE') setConflict(await readAsset(draft.id)); if (e.code === 'ASSET_IN_USE' && Array.isArray(e.details?.shots) && e.details.shots.length) throw Error('还有镜头明确绑定了要归档或替换的造型 / 图片：' + e.details.shots.map((x: any) => '镜 ' + x.number).join('、') + '。请先在分镜里处理这些镜头，再保存'); throw e; } }); }
  // ---- Card quick actions: copy the default image, change it, adjust the avatar crop. ----
  // The default image and crop only change how a card shows, so they save at once (with 撤销);
  // everything else keeps the draft + 「保存」 flow. Each save starts from the stored record, so
  // nothing half-edited elsewhere rides along, and a newer revision is refused, not overwritten.
  async function quickSave(id: string, label: string, mutate: (a: Asset) => void, message: (saved: Asset, before: Asset) => string, undoable = true) {
    if (draftRef.current?.id === id && dirtyRef.current) { setError('这个' + labels[draftRef.current.kind] + '有未保存的修改，请先保存或放弃修改，再改默认图或头像'); return; }
    await run(label, async () => {
      if (scopeBaseRef.current && !seriesViewRef.current && metas[id]?.owner.type === 'series') throw Error('这是全剧共享的资产：在本集请用详情里的「本集设置」改默认图；要改全剧的默认图请切到「全剧」');
      const fresh = await readAsset(id);
      if (fresh.archived_at) throw Error('已归档的资料是只读的，恢复后才能修改');
      const next = structuredClone(fresh); mutate(next);
      let saved: Asset;
      try { saved = await writeAsset(id, next, fresh.revision); }
      catch (e: any) { throw Error(String(e.message || '').includes('已经更新') ? '这份资料刚在别处更新过，没有覆盖，请再试一次' : e.message || '保存失败'); }
      if (draftRef.current?.id === id && !dirtyRef.current) install(saved);
      await loadList();
      const text = message(saved, fresh), changes = displayChanges(fresh, saved);
      setUndo(undoable && changes.length ? { id, text, changes } : null);
      if (!undoable || !changes.length) setNotice(text);
    });
  }
  // 撤销 reverses exactly the fields this quick save changed, and only while each still holds the
  // value it saved: a field changed elsewhere since then is a conflict (nothing is written), and any
  // other field — including other display settings saved meanwhile — keeps its current value.
  // Unsaved edits of the same asset in the open detail would be orphaned by the new revision.
  const undoBlocked = (id: string) => draftRef.current?.id === id && dirtyRef.current;
  async function undoQuick(u: { id: string; changes: DisplayChangeEntry[] }) {
    await run('正在撤销…', async () => {
      const current = await api<Asset>('/assets/' + u.id);
      if (current.archived_at) throw Error('资料已归档，没有撤销');
      const moved = u.changes.filter(c => !sameValue(readDisplay(current, c), c.after));
      if (moved.length) throw Error('这些显示设置在别处又改过了，没有撤销，保留了现在的设置');
      if (u.changes.some(c => !guardsHold(current, c))) throw Error('相关图片已经归档或换成了别的图，没有撤销');
      const next = structuredClone(current);
      for (const c of u.changes) if (!writeDisplay(next, c, c.before)) throw Error('原来的图片或造型已经不在了，没有撤销');
      let saved: Asset;
      try { saved = await api<Asset>('/assets/' + u.id, { asset: next, expected_revision: current.revision }, 'PUT'); }
      catch (e: any) { throw Error(String(e.message || '').includes('已经更新') ? '这份资料刚在别处更新过，没有撤销' : e.message || '撤销失败'); }
      if (draftRef.current?.id === u.id && !dirtyRef.current) install(saved);
      await loadList(); setNotice('已撤销');
    });
  }
  // ---- 自动框到头部（只做写实）。识别结果只是建议：只改面板或草稿里的框，点「完成」/「保存」才写入。----
  async function headBox(b: Binding): Promise<{ head: HeadState; crop?: Crop }> {
    try {
      const r = await api<{ status: string; bindingId?: string; bindingRevision?: number; crop?: Crop }>('/bindings/' + encodeURIComponent(b.id) + '/head-box' + (b.revision ? '?bindingRevision=' + b.revision : ''));
      if (r.bindingId && r.bindingId !== b.id || b.revision && r.bindingRevision && r.bindingRevision !== b.revision) return { head: 'stale' };
      if (r.status === 'found' && r.crop && ['x', 'y', 'zoom'].every(k => Number.isFinite((r.crop as any)[k]))) return { head: 'found', crop: r.crop };
      return { head: (['not_found', 'unsupported', 'busy'] as string[]).includes(r.status) ? r.status as HeadState : 'error' };
    } catch (e: any) { return { head: e?.status === 409 || e?.code === 'IMAGE_BINDING_STALE' ? 'stale' : 'error' }; }
  }
  // 卡片「调整头像」：裁切从未调整过（untouched）才在打开时自动请求；人工调过或旧记录不动。
  // 打开前先读最新资料：列表可能是旧的（别处刚换了图或改了框），面板和保存前提都以最新记录为准；
  // 列表和最新记录不一致时顺带刷新列表，面板里显示的就是最新的默认图。
  // 读取期间按 Esc、点外部、换卡片或改用别的菜单项，发起它的菜单实例就变了，这次打开作废。
  async function openCrop(a: Asset, at: { x: number; y: number }) {
    const seq = ++headSeq.current, origin = quickNow.current;
    const live = () => headSeq.current === seq && quickNow.current === origin;
    let fresh = a;
    try { fresh = await api<Asset>('/assets/' + a.id); } catch { /* 读不到就按列表打开；保存前仍会核对最新记录 */ }
    if (!live()) return;
    const cover = coverOf(fresh), listed = coverOf(a);
    if (!cover || fresh.archived_at) { setQuick(q => q === origin ? null : q); setError('「' + a.name + '」' + (fresh.archived_at ? '已归档，不能调整头像' : '现在没有默认图') + '，列表已刷新'); void loadList(); return; }
    if (!listed || JSON.stringify(cropBase(listed)) !== JSON.stringify(cropBase(cover))) { await loadList(); if (!live()) return; }
    setQuick(q => q !== origin ? q : { id: a.id, mode: 'crop', x: at.x, y: at.y, crop: cover.crop, head: 'idle', seq, base: cropBase(cover) });
    if (cover.crop_source === 'untouched' && !cover.crop_manually_edited) void reframeQuick(a.id, cover, seq);
  }
  async function reframeQuick(id: string, cover: Binding, seq = ++headSeq.current) {
    setQuick(q => q && q.id === id && q.mode === 'crop' ? { ...q, head: 'loading', seq } : q);
    const r = await headBox(cover);
    // 用户已经拖过、关掉面板或又点了一次（seq 变了）：这次结果作废。
    if (headSeq.current !== seq) return;
    setQuick(q => !q || q.id !== id || q.mode !== 'crop' || q.seq !== seq ? q : r.crop ? { ...q, crop: r.crop, source: 'auto', head: 'found' } : { ...q, head: r.head });
  }
  function dragQuick(c: Crop) {
    headSeq.current++;
    setQuick(q => q && { ...q, crop: c, source: 'manual', head: q.head === 'loading' || q.head === 'found' ? 'idle' : q.head, seq: headSeq.current });
  }
  async function reframeDetail(b: Binding) {
    const seq = ++detailSeq.current, id = b.id;
    setDetailHead({ id, head: 'loading' });
    const r = await headBox(b);
    if (detailSeq.current !== seq) return;
    setDetailHead({ id, head: r.head });
    if (r.crop) { const c = r.crop; edit(a => { const x = a.images.find(i => i.id === id); if (x) { x.crop = c; x.crop_source = 'auto'; } }); }
  }
  // 详情里拖框或拉滑块：记为人工裁切，并作废还没回来的识别结果。
  function dragDetail(id: string, change: (crop: Crop) => Crop) {
    detailSeq.current++; setDetailHead(d => d && d.id === id && (d.head === 'loading' || d.head === 'found') ? { id, head: 'idle' } : d);
    edit(a => { const b = a.images.find(i => i.id === id); if (b) { b.crop = change(b.crop); b.crop_source = 'manual'; } });
  }
  function setCover(a: Asset, image: Binding) {
    if (a.kind === 'character') { const look = a.looks.find(l => l.id === image.look_id); if (!look) return; look.default_image_id = image.id; a.default_look_id = look.id; }
    else a.default_image_id = image.id;
  }
  async function copyDefault(a: Asset) {
    const cover = coverOf(a); setQuick(null);
    if (!cover) return;
    // 人物：只复制原图文件（保留文件名和格式，和生成视频一样）。本机能力不可用、还没读到或没有当前版本时
    // 说明原因，不退回浏览器 PNG——那会悄悄换格式（HEIC 变 PNG），不是同一个操作。
    if (a.kind === 'character') {
      if (!clipCap.available) { setError('没有复制「' + a.name + '」的默认图：' + clipCap.reason); return; }
      if (!cover.revision) { setError('没有复制「' + a.name + '」的默认图：这张图还没有当前版本，请刷新页面后再试'); return; }
      await copyFiles('defaults', [{ bindingId: cover.id, bindingRevision: cover.revision }]); return;
    }
    // 场景、道具不在原图文件接口范围内，仍按原来的方式复制整张图（PNG）。
    if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') { setError('这个浏览器不允许网页往剪贴板写图片。请在运行拾光的这台电脑上，用 Chrome 打开拾光再复制'); return; }
    // The preview route streams the full original (HEIC as JPEG); the clipboard takes it as PNG.
    const png = (async () => {
      const r = await fetch(bindingSrc(cover)); if (!r.ok) throw Error('默认图读取失败（' + r.status + '）');
      const bitmap = await createImageBitmap(await r.blob()), canvas = document.createElement('canvas');
      canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext('2d')!.drawImage(bitmap, 0, 0); bitmap.close?.();
      return await new Promise<Blob>((ok, fail) => canvas.toBlob(b => b ? ok(b) : fail(Error('图片转换失败')), 'image/png'));
    })();
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); setError(''); setNotice('已复制「' + a.name + '」的默认图（整张原图，PNG），到画布平台按 ⌘V 粘贴'); }
    catch (e: any) { setError('没能复制默认图：' + (e?.message || '浏览器拒绝了剪贴板写入')); }
  }
  // ---- Multi-select and file copy (原图文件放进系统剪贴板 / 在访达中显示) ----
  const clipCap = capability(caps, 'clipboard'), revealCap = capability(caps, 'revealMany'), maxPick = caps?.maxSelection || 50;
  const desktopBusy = actionPending(desktop.action) || !!desktop.action?.unknown;
  // Reference images: a plain pick toggles one; Shift picks the run from the last picked in the shown order.
  function pickRange(list: string[], order: string[], id: string, shift: boolean, last?: string) {
    if (shift && last && order.includes(last) && order.includes(id)) {
      const [a, b] = [order.indexOf(last), order.indexOf(id)].sort((x, y) => x - y);
      return [...new Set([...list, ...order.slice(a, b + 1)])].slice(0, maxPick);
    }
    return list.includes(id) ? list.filter(x => x !== id) : list.length >= maxPick ? list : [...list, id];
  }
  // File copy covers characters (the backend's scope); scenes and props keep the single PNG copy.
  const pickableAsset = (a: Asset) => a.kind === 'character' && !!coverOf(a)?.revision;
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
  const pickOrder = () => visibleRows.filter(pickableAsset).map(r => r.id);
  // The current selection in shown order: the multi-pick, else the open character as a single pick.
  const pickedNow = () => pickedAssets.length ? pickedAssets : draft && pickOrder().includes(draft.id) ? [draft.id] : [];
  /** Two or more → multi (the detail closes); one → open it; none → clear. Unsaved edits are asked about first (unless
   *  `asked`); a refused switch returns false and leaves the picks, the detail and the Shift anchor exactly as they were. */
  function applyPick(ids: string[], asked = false) {
    if (busy) return false;
    const order = pickOrder(), next = order.filter(id => ids.includes(id));
    if (next.length > 1) { if (draft) { if (asked) dropDetail(); else if (!closeDetail()) return false; } setPickedAssets(next); return true; }
    if (next.length === 1 && draft?.id !== next[0]) { if (!asked && !canLeave()) return false; setPickedAssets([]); void openAsset(next[0], true); return true; }
    setPickedAssets([]); return true;
  }
  // —— 合并同名人物（合同 v1 · B）：同一部剧里各集同名人物的候选组；全剧提示条、卡片提示、菜单入口、新建撞名都用它 ——
  const [mergeVersion, setMergeVersion] = useState(0), [mergeOpen, setMergeOpen] = useState<{ group: MergeGroup; primary?: string } | null>(null);
  const [mergeDone, setMergeDone] = useState<{ receipt: MergeReceipt; name: string; lookCount?: number } | null>(null), [mergeUndo, setMergeUndo] = useState<{ mergeId: string; name: string } | null>(null);
  const mergeSeries = scoped && !publicScope && assetCtx?.series ? assetCtx.series.id : null;
  const merges = useMergeGroups(request, mergeSeries, !!mergeSeries && kind === 'character' && active, `${mergeVersion}:${listRevision}:${total}`);
  const mergeGroupOf = (id: string) => merges.byAsset.get(id);
  function openMerge(group: MergeGroup, primary?: string) {
    // 组合验收 R1：这部剧有一次合并结果还不明，先核对它，不发起新的合并
    const held = mergeSeries ? pendingStore.merge(mergeSeries) : null;
    if (held && held.group.group_id !== group.group_id) { setNotice('上次合并「' + held.group.name + '」的结果还没核对到，先核对它，再合并别的'); group = held.group; primary = undefined; }
    if (merges.data?.alignment_status === 'pending') { setError(mergeErrorText.ATTRIBUTE_ALIGNMENT_REQUIRED); return; }
    if (dirty) { setError('当前人物有未保存的修改：请先保存或放弃修改，再合并同名人物'); return; }
    if (!canLeave()) return;
    setMenu(''); setQuick(null); setMergeDone(null); setError(''); setMergeOpen({ group, primary });
  }
  async function afterMerge(r: MergeReceipt, group: MergeGroup, lookCount?: number) {
    setMergeOpen(null); setMergeDone({ receipt: r, name: group.name, lookCount }); setMergeVersion(v => v + 1);
    if (draftRef.current && group.members.some(m => m.asset_id === draftRef.current!.id)) dropDetail();
    await loadList().catch(e => setError(e.message)); // 设计稿 B4：只在顶部提示，不替用户打开人物
  }
  async function nextMerge(r: MergeReceipt) {
    const fresh = await merges.reload().catch(() => null);
    const g = fresh?.items.find(x => x.group_id === r.next_group_id) ?? fresh?.items[0];
    if (!g) { setMergeDone(null); setNotice('这部剧里已经没有需要合并的同名人物了'); return; }
    openMerge(g);
  }
  function afterUndo(name: string) {
    setMergeUndo(null); setMergeDone(null); setMergeVersion(v => v + 1); dropDetail();
    setNotice('已撤销合并「' + name + '」，恢复成合并前的几份');
    void loadList().catch(e => setError(e.message));
  }
  /** 新建撞名里的「合并这几个…」：按检查给的组编号找组（列表还没读到就重读一次）。 */
  async function mergeFromCreate(rel: RelatedCharacters) {
    const data = merges.data?.items.some(g => g.group_id === rel.group_id) ? merges.data : await merges.reload().catch(() => null);
    const g = data?.items.find(x => x.group_id === rel.group_id);
    if (!g) { setError('没找到这几个同名人物的合并组，请刷新列表后再试'); return; }
    setModal(null); openMerge(g);
  }
  const relatedText = (rel: RelatedCharacters, name: string) => {
    const places = memberPlaces(rel.items), where = places.join('、') + (places.length > 1 ? '已经各有一个' : '已经有一个') + '「' + name + '」。';
    return rel.action === 'merge' ? <>{where}<br/>· 是同一个人：合并成一个全剧人物，各集共用。<br/>· 不是同一个人：换个名字再创建。</>
      : <>{where}<br/>· 是同一个人：到{places[0]}把它提升到全剧，各集共用。<br/>· 不是同一个人：换个名字再创建。</>;
  };

  function pickCard(e: React.MouseEvent, a: Asset) {
    const mod = e.metaKey || e.ctrlKey && !isMac;
    if (!mod && !e.shiftKey) { if (!pickedAssets.length && alreadyOpen(a.id)) { lastPick.current.assets = a.id; return; } if (busy || !canLeave()) return; setPickedAssets([]); lastPick.current.assets = a.id; void openAsset(a.id, true); return; }
    e.preventDefault();
    if (!pickableAsset(a)) { setNotice('「' + a.name + '」还没有默认图，不能选'); return; }
    const now = pickedNow();
    if (mod) {
      const rest = now.filter(id => id !== a.id);
      const done = !now.includes(a.id) ? applyPick([...now, a.id]) : rest.length ? applyPick(rest) : closeDetail();
      if (done) lastPick.current.assets = a.id;
      return;
    }
    const order = pickOrder(), last = lastPick.current.assets, anchor = last && order.includes(last) ? last : now[0];
    if (!anchor) { if (applyPick([a.id])) lastPick.current.assets = a.id; return; }
    const [i, j] = [order.indexOf(anchor), order.indexOf(a.id)].sort((x, y) => x - y);
    applyPick(order.slice(i, j + 1));
  }
  // Box select on the gallery's empty space, same rules as the video page; ⌘ / Shift keep what is already picked.
  // While dragging, only `marqueeHits` changes (a highlight that does not move anything); the pick, the toolbar and the
  // side list update once on release, so the cards never shift under the box.
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null), [marqueeHits, setMarqueeHits] = useState<string[] | null>(null);
  function marqueeStart(e: React.PointerEvent<HTMLElement>) {
    if (kind !== 'character' || e.button !== 0 || busy || (e.target as Element).closest('.ca-card-wrap, .ca-card, button, a, input, select, textarea, label, .ca-pickbar, .ca-gallery-bar, .ca-pagination')) return;
    const host = e.currentTarget, start = { x: e.clientX, y: e.clientY }, add = e.metaKey || e.ctrlKey || e.shiftKey;
    const edge = host.getBoundingClientRect(); if (e.clientX >= edge.left + host.clientLeft + host.clientWidth || e.clientY >= edge.top + host.clientTop + host.clientHeight) return; // the gallery's own scrollbar
    const base = add ? pickedNow() : [], cards = Array.from(host.querySelectorAll<HTMLElement>('[data-pick-id]')), order = pickOrder();
    let moved = false, cancelled = false, last = base;
    e.preventDefault(); setQuick(null); setMenu('');
    host.setPointerCapture?.(e.pointerId);
    const end = () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerup', up); host.removeEventListener('pointercancel', cancel); setMarquee(null); setMarqueeHits(null); };
    const move = (ev: PointerEvent) => {
      if (!moved) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 5) return;
        // Unsaved edits: ask once before the box starts (the same confirm as switching characters); cancel changes nothing.
        if (draft && dirtyRef.current && !canLeave()) { cancelled = true; end(); return; }
        moved = true;
      }
      const box = host.getBoundingClientRect();
      const left = Math.min(start.x, ev.clientX), top = Math.min(start.y, ev.clientY), right = Math.max(start.x, ev.clientX), bottom = Math.max(start.y, ev.clientY);
      setMarquee({ x: left - box.left + host.scrollLeft, y: top - box.top + host.scrollTop, w: right - left, h: bottom - top });
      const hits = cards.filter(c => { const r = c.getBoundingClientRect(); return r.left < right && r.right > left && r.top < bottom && r.bottom > top; }).map(c => c.dataset.pickId || '');
      last = order.filter(id => base.includes(id) || hits.includes(id));
      setMarqueeHits(last);
    };
    const up = () => { end(); focusGallery(); if (cancelled) return; if (!moved) { if (!add) setPickedAssets([]); return; } applyPick(last, true); };
    const cancel = () => { end(); if (!cancelled && moved) applyPick(last, true); };
    host.addEventListener('pointermove', move); host.addEventListener('pointerup', up); host.addEventListener('pointercancel', cancel);
  }
  // Right-click on a picked card acts on all picks; on any other card it drops the multi-pick and acts on that one.
  function openMenu(a: Asset, x: number, y: number) {
    if (pickedAssets.length > 1 && pickedAssets.includes(a.id)) { setQuick({ id: a.id, mode: 'multi', x, y }); return; }
    if (pickedAssets.length) setPickedAssets([]);
    setQuick({ id: a.id, mode: 'menu', x, y });
  }
  const pickableImage = (b: Binding) => draft?.kind === 'character' && !b.archived_at && !!b.revision;
  function pickImage(b: Binding, shift: boolean) {
    cancelTileOpen();
    if (!pickableImage(b)) { setNotice(b.archived_at ? '已归档的图片不能选' : '这张图片还没保存，保存后才能复制'); return; }
    const order = images.filter(pickableImage).map(i => i.id);
    setPickedImages(list => pickRange(list, order, b.id, shift, lastPick.current.images)); lastPick.current.images = b.id;
  }
  const defaultsItems = (ids: string[]): ImageSelectionItem[] => ids.map(id => coverOf(rows.find(r => r.id === id)!)).filter((b): b is Binding => !!b?.revision).map(b => ({ bindingId: b.id, bindingRevision: b.revision }));
  const referenceItems = (ids: string[]): ImageSelectionItem[] => (draft?.images ?? []).filter(b => ids.includes(b.id) && pickableImage(b)).map(b => ({ bindingId: b.id, bindingRevision: b.revision }));
  const busyText = '上一笔复制或在访达中显示还没有结束或结果待核对，请先查看它的结果。';
  const overPick = (n: number) => n > maxPick ? '一次最多 ' + maxPick + ' 张，当前选了 ' + n + ' 张' : '';
  async function copyFiles(mode: ImageCopyMode, items: ImageSelectionItem[]) {
    if (!items.length) return;
    if (!clipCap.available) { setError(clipCap.reason); return; }
    if (overPick(items.length)) { setError('没有复制：' + overPick(items.length)); return; }
    if (desktopBusy) { setError(busyText); return; }
    setError(''); await desktop.start('clipboard', mode, items);
  }
  async function revealFiles(mode: ImageCopyMode, items: ImageSelectionItem[]) {
    if (!items.length) return;
    if (!revealCap.available) { setError(revealCap.reason); return; }
    if (overPick(items.length)) { setError('没有在访达中显示：' + overPick(items.length)); return; }
    if (desktopBusy) { setError(busyText); return; }
    setError(''); setRevealAsk(null); await desktop.start('reveal-preview', mode, items);
  }
  // Same folder: open at once. Several folders: ask first (they open several Finder windows).
  useEffect(() => {
    const a = desktop.action, r = a?.receipt;
    if (!a || a.kind !== 'reveal-preview' || a.busy || a.unknown || !r || !['completed', 'partial', 'ready'].includes(r.status) || !r.previewToken) return;
    if ((r.folderCount ?? 1) <= 1) void desktop.start('reveal', a.mode, a.items, { previewToken: r.previewToken });
    else setRevealAsk(a.requestId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop.action?.receipt?.status, desktop.action?.requestId]);
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
  async function create() { if (!scope || !canLeave()) return; selectionGeneration.current++; setDetailLoading(false); setModal({ type: 'create', name: '' }); }
  const currentLook = draft?.looks.find(l => l.id === lookId), images = draft?.images.filter(b => b.look_id === (draft.kind === 'character' ? lookId : null)) ?? [];
  const representative = draft?.kind === 'character' ? currentLook?.default_image_id : draft?.default_image_id;
  function setDefault(a: Asset, id: string | null) { if (a.kind === 'character') { const l = a.looks.find(l => l.id === lookId); if (l) l.default_image_id = id; } else a.default_image_id = id; }
  function moveImage(id: string, delta: number, target?: string) { if (draft?.archived_at || currentLook?.archived_at || images.find(b => b.id === id)?.archived_at) return; edit(a => { const activeIds = a.images.filter(b => b.look_id === (a.kind === 'character' ? lookId : null) && !b.archived_at).map(b => b.id), from = activeIds.indexOf(id), to = target ? activeIds.indexOf(target) : from + delta; if (from < 0 || to < 0 || to >= activeIds.length) return; const [moved] = activeIds.splice(from, 1); activeIds.splice(to, 0, moved); const byId = new Map(a.images.map(b => [b.id, b])); let cursor = 0; a.images = a.images.map(b => activeIds.includes(b.id) ? byId.get(activeIds[cursor++])! : b); }); }
  async function openCopy() { if (!draft || dirty) { setError('请先保存当前人物，再复制到其他项目'); return; } const target = scopes.find(s => s.id !== draft.project_id && s.project_kind === 'normal')?.id ?? scope; await run('正在准备复制…', async () => { const p = await api<any>('/assets/' + draft.id + '/copy-preview?project_id=' + target); setModal({ type: 'copy', ...p, project_id: target, name: draft.name, base_info: draft.base_info, performance_info: draft.performance_info }); }); }

  /* ------------------------------------------------ 从访达拖入图片：新建或添加参考图 */
  const fileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
  const dropBlocked = () => !active || scriptView || !!busy || !!modal || !!dropJob || !scope || !!imageId || !!scopeBase && seriesView;
  function readDropFiles(e: React.DragEvent): File[] | null {
    if (Array.from(e.dataTransfer.items).some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setError('请拖入图片文件，暂不支持文件夹'); return null; }
    const files = Array.from(e.dataTransfer.files);
    if (!files.length) { setError('请拖入本地图片文件；网页链接暂不支持'); return null; }
    const accepted = files.filter(imageFile);
    if (!accepted.length) { setError('拖入的文件不是图片'); return null; }
    if (accepted.length < files.length) setNotice(`已忽略 ${files.length - accepted.length} 个非图片文件`);
    return accepted.slice(0, 20);
  }
  const makeItems = (files: File[], mode: 'create' | 'attach', targetKind: Kind): DropItem[] => files.map(f => ({ key: crypto.randomUUID(), file: f, preview: URL.createObjectURL(f), ...imageNamePreset(f.name, targetKind), include: true, state: 'waiting', message: '', stage: mode === 'create' ? 'create' : 'look', requestId: crypto.randomUUID(), bindingId: crypto.randomUUID(), newLookId: crypto.randomUUID(), startedAt: 0 }));
  function dropOnGallery(e: React.DragEvent) {
    e.preventDefault(); dragDepth.current = 0; setDragTarget('');
    if (dropBlocked()) { setError('请先完成当前操作，再拖入图片'); return; }
    if (publicScope && kind !== 'character') return;
    const files = readDropFiles(e); if (!files) return;
    setDropJob({ mode: 'create', kind, projectId: scope, lookId: null, items: makeItems(files, 'create', kind), running: false });
  }
  async function dropOnCard(e: React.DragEvent, a: Asset) {
    e.preventDefault(); e.stopPropagation(); dragDepth.current = 0; setDragTarget('');
    if (dropBlocked()) { setError('请先完成当前操作，再拖入图片'); return; }
    if (a.archived_at) { setError('已归档的资料不能添加图片，请先恢复'); return; }
    if (scopeBase && (seriesView || metas[a.id]?.owner.type === 'series')) { setError('全剧共享的资产暂不能直接拖入图片：在本集追加造型和图片会在下一步接入'); return; }
    if (draft?.id === a.id && dirty) { setError('当前资料有未保存的修改，请先保存或放弃修改，再拖入图片'); return; }
    const files = readDropFiles(e); if (!files) return;
    await run('正在读取资料…', async () => {
      const full = await api<Asset>('/assets/' + a.id);
      const looks = full.looks.filter(l => !l.archived_at);
      setDropJob({ mode: 'attach', kind: full.kind, projectId: full.project_id, asset: { id: full.id, name: full.name, looks }, lookId: full.kind === 'character' ? (looks.find(l => l.id === full.default_look_id)?.id ?? looks[0]?.id ?? null) : null, items: makeItems(files, 'attach', full.kind), running: false });
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
  async function ensureLook(assetId: string, fixedId: string, requestedName?: string): Promise<string> {
    const a = await api<Asset>('/assets/' + assetId);
    if (a.looks.some(l => l.id === fixedId && !l.archived_at)) return fixedId;
    const existing = requestedName ? a.looks.find(l => l.name === requestedName && !l.archived_at)
      : a.looks.find(l => l.id === a.default_look_id && !l.archived_at) ?? a.looks.find(l => !l.archived_at);
    if (existing) return existing.id;
    if (a.archived_at) throw definite('资料已归档，图片没有添加');
    const next = structuredClone(a);
    next.looks.push({ id: fixedId, name: requestedName || '默认', description: '', tags: [], default_image_id: null, archived_at: null }); next.default_look_id ??= fixedId;
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
        if (job.kind === 'character' && !it.lookId) { const lookId = job.mode === 'attach' ? job.lookId : await ensureLook(it.assetId!, it.newLookId, it.lookEdited || imageNamePreset(it.file.name).structured ? it.lookName.trim() : undefined); if (!lookId) throw definite('请先为这个人物新建造型，再添加图片'); sync({ lookId }); }
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
    if (job.mode === 'create' && todo.some(i => !i.name.trim() || i.name.trim().length > 120)) { setError('请为每张图片填写不超过 120 字的名称'); return; }
    if (job.mode === 'create' && job.kind === 'character' && todo.some(i => !i.lookName.trim() || i.lookName.trim().length > 120)) { setError('请为每张图片填写不超过 120 字的造型名称'); return; }
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
  const coverFor = (a: Asset) => { const c = metas[a.id]?.cover as Binding | undefined; return scopeBase && c && typeof c === 'object' && 'media_asset_id' in c ? c : coverOf(a); };
  const visibleRows = rows.filter(a => (scopeBase ? true : a.project_id === scope) && (!missingOnly || !coverFor(a)));
  // Truly empty (this kind has nothing yet, not a search or filter result): no filters or count, and the add card says so.
  const trulyEmpty = !!scope && scopesKnown && listOk?.key === listKey && listOk.total === 0 && !listLoading && !archived && !q.trim() && total === 0 && !rows.length;
  // A filter that hides picked characters drops them, so ⌘C never copies what is not shown (same as the video page).
  const visiblePickKey = visibleRows.filter(pickableAsset).map(r => r.id).join('|');
  useEffect(() => { setPickedAssets(list => { const order = visiblePickKey.split('|'), next = list.filter(id => order.includes(id)); return next.length === list.length ? list : next.length > 1 ? next : []; }); }, [visiblePickKey]);
  // ⌘A / ⌘C belong to the character list itself (as on the video page): they only act while focus is inside the gallery,
  // never from the toolbar, the detail panel, a menu or a dialog, and not while typing or with text selected.
  const galleryRef = useRef<HTMLElement>(null);
  const focusGallery = () => galleryRef.current?.focus({ preventScroll: true });
  const pickKeys = useRef<(e: KeyboardEvent) => void>(() => {});
  pickKeys.current = e => {
    const mod = e.metaKey || e.ctrlKey && !isMac, k = e.key.toLowerCase();
    if (!mod || e.altKey || e.shiftKey || k !== 'a' && k !== 'c') return;
    if (!active || scriptView || kind !== 'character' || busy || quick || imageId || modal || dropJob) return;
    const t = e.target as HTMLElement | null;
    if (!t || !galleryRef.current?.contains(t) || t.closest('input, textarea, select, [contenteditable="true"], .ca-pickbar, [role="dialog"], [role="menu"]')) return;
    if (k === 'a') { const order = pickOrder(); if (!order.length) return; e.preventDefault(); if (applyPick(order)) lastPick.current.assets = order[0]; return; }
    if (String(window.getSelection?.() || '')) return;
    if (pickedAssets.length > 1) { e.preventDefault(); void copyFiles('defaults', defaultsItems(pickedAssets)); return; }
    const one = draft && rows.find(r => r.id === draft.id);
    if (one && coverOf(one)) { e.preventDefault(); void copyDefault(one); }
  };
  const listStatus = !scopesKnown && !rows.length ? (scopesError ? '范围未能读取' : '正在读取项目范围…') : listLoading ? '加载中…' : `${total} 个${archived ? '已归档的' : ''}${labels[kind]}`;
  const dialogImage = imageId ? images.find(b => b.id === imageId) ?? null : null;
  const dialogHealth = dialogImage ? health.find(h => h.id === dialogImage.id) : undefined;
  const cropAspect = draft?.kind === 'character' ? 3 / 4 : 16 / 10; // 与画廊卡片封面比例一致
  const imageLocked = (b?: Binding | null) => locked || !!currentLook?.archived_at || !!b?.archived_at;
  const activeImageIds = images.filter(b => !b.archived_at).map(b => b.id);
  const jump = (id: string) => { const node = detailScroll.current?.querySelector('#' + id) as HTMLElement | null; node?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); };
  const switchKind = (k: Kind) => {
    if (!scriptView && kind === k) return;
    if (!canLeave()) return;
    setScriptView(false);
    if (kind === k) {
      if (draft?.project_id === scope && draft.kind === k) return;
      selectionGeneration.current++; setDetailLoading(false);
      setDraft(null);
      void loadList().catch(e => setError(e.message));
      return;
    }
    selectionGeneration.current++; setDetailLoading(false); setKind(k); setDraft(null); setPage(1); setMissingOnly(false);
  };

  // Progress and result of the current copy / reveal; lost answers can only be looked up, never resent.
  function desktopStatus() {
    const a = desktop.action!, r = a.receipt, n = a.items.length, pending = actionPending(a);
    const skipped = r?.skipped ?? [], done = r?.count ?? (a.kind === 'clipboard' ? r?.copied?.length : r?.requested?.length) ?? 0;
    let text = '', tone = 'ok';
    if (a.unknown) { text = a.error || '结果尚未确认，请查询原请求。'; tone = 'warn'; }
    else if (a.error) { text = a.error; tone = 'bad'; }
    else if (pending) text = a.kind === 'clipboard' ? '正在核对并复制 ' + n + ' 张原图…' : a.kind === 'reveal-preview' ? '正在核对 ' + n + ' 张图片的位置…' : '正在请求访达…';
    else if (a.kind === 'clipboard') text = done ? '已复制 ' + done + ' 张原图文件，到画布平台按 ⌘V 粘贴' : '没有复制任何图片';
    else if (a.kind === 'reveal') text = revealDispatched(r) ? '已请求在访达中显示 ' + done + ' 张' : '没有可以显示的图片';
    else if (a.kind === 'reveal-preview') { if (revealAsk === a.requestId) return null; text = '正在核对图片位置…'; }
    if (!a.unknown && !a.error && !pending && skipped.length) tone = 'warn';
    return <div className={'ca-desktop-status is-' + tone} role="status">
      <span>{text}</span>
      {!a.unknown && !pending && skipped.length > 0 && <small>跳过 {skipped.length} 张：{skippedText(skipped).join('；')}</small>}
      <span className="ca-desktop-actions">
        {a.unknown && <button type="button" disabled={a.busy} onClick={() => void desktop.query()}>查询原请求</button>}
        {a.unknown ? <button type="button" disabled={a.busy} onClick={() => desktop.clear(true)}>已核对，收起</button>
          : !pending && <button type="button" className="ca-undo-close" aria-label="关闭提示" onClick={() => desktop.clear()}><X size={13}/></button>}
      </span>
    </div>;
  }
  // Floating panel for one card: the action menu, the default-image picker, or the avatar crop.
  // Rendered by a plain function (not a nested component) so the crop box keeps its state while dragging.
  function quickPanel(a: Asset) {
    const ref = quickRef, cover = coverOf(a), aspect = a.kind === 'character' ? 3 / 4 : 16 / 10;
    const width = quick!.mode === 'menu' ? 196 : quick!.mode === 'multi' ? 252 : quick!.mode === 'attrs' ? 480 : quick!.mode === 'compare' ? 520 : quick!.mode === 'pick' ? 560 : 540;
    const left = Math.max(12, Math.min(quick!.x, window.innerWidth - width - 12)), top = Math.max(12, Math.min(quick!.y, window.innerHeight - (quick!.mode === 'menu' || quick!.mode === 'multi' ? 200 : 520)));
    const usable = (a.images ?? []).filter(b => !b.archived_at);
    const groups = a.kind === 'character' ? a.looks.filter(l => !l.archived_at).map(l => ({ key: l.id, title: '造型 · ' + l.name, images: usable.filter(b => b.look_id === l.id) })).filter(g => g.images.length) : [{ key: 'all', title: '参考图', images: usable }];
    const style = { left, top, width };
    if (quick!.mode === 'multi') { const n = pickedAssets.length, over = overPick(n); return <div ref={ref} className="ca-quick ca-quick-menu" role="menu" aria-label={'已选 ' + n + ' 个' + labels[kind] + '的操作'} style={style}>
      <button role="menuitem" disabled={!clipCap.available || desktopBusy || !!over} title={clipCap.reason || over || undefined} onClick={() => { setQuick(null); focusGallery(); void copyFiles('defaults', defaultsItems(pickedAssets)); }}><Copy size={14}/>复制 {n} 张默认图<kbd>⌘C</kbd></button>
      <button role="menuitem" disabled={!revealCap.available || desktopBusy || !!over} title={revealCap.reason || over || undefined} onClick={() => { setQuick(null); focusGallery(); void revealFiles('defaults', defaultsItems(pickedAssets)); }}><FolderOpen size={14}/>在访达中显示 {n} 张</button>
      {kind === 'character' && !publicScope && <button role="menuitem" disabled={n > 3} title={n > 3 ? '一次最多对比 3 个人物' : undefined} onClick={() => setQuick({ ...quick!, mode: 'compare', ids: [...pickedAssets] })}><Radar size={14}/>对比属性图（{n} 人）{n > 3 && <small>最多 3 人</small>}</button>}
      <hr/>
      <button role="menuitem" disabled><Star size={14}/>换默认图…<small>一次只能换一个</small></button>
      <button role="menuitem" disabled><Maximize2 size={14}/>调整头像…<small>一次只能调一个</small></button>
    </div>; }
    if (quick!.mode === 'menu') return <div ref={ref} className="ca-quick ca-quick-menu" role="menu" aria-label={a.name + '的操作'} style={style}>
      <button role="menuitem" disabled={!cover} onClick={() => void copyDefault(a)}><Copy size={14}/>复制默认图</button>
      <button role="menuitem" disabled={!usable.length || !!a.archived_at} onClick={() => setQuick({ ...quick!, mode: 'pick' })}><Star size={14}/>换默认图…</button>
      <button role="menuitem" disabled={!cover || !!a.archived_at} onClick={() => void openCrop(a, quick!)}><Maximize2 size={14}/>调整头像…</button>
      <hr/>
      <button role="menuitem" disabled={!cover} onClick={() => { setQuick(null); setImageViewer({ src: bindingSrc(cover!), name: cover!.last_known_name || a.name, from: 'card' }); }}><ZoomIn size={14}/>放大查看</button>
      {a.kind === 'character' && !publicScope && <button role="menuitem" onClick={() => setQuick({ ...quick!, mode: 'attrs' })}><Radar size={14}/>查看属性图</button>}
      {a.kind === 'character' && !a.archived_at && mergeGroupOf(a.id) && <button role="menuitem" onClick={() => openMerge(mergeGroupOf(a.id)!, a.id)}><Users size={14}/>合并同名人物…</button>}
      <button role="menuitem" onClick={() => { setQuick(null); if (!alreadyOpen(a.id)) void openAsset(a.id); }}>打开详情</button>
    </div>;
    if (quick!.mode === 'attrs' || quick!.mode === 'compare') {
      const people = quick!.mode === 'attrs' ? [{ id: a.id, name: a.name }] : (quick!.ids ?? []).map(id => rows.find(r => r.id === id)).filter((r): r is Asset => !!r).map(r => ({ id: r.id, name: r.name }));
      return <div ref={ref} className="ca-quick ca-quick-panel ca-attr-pop" role="dialog" aria-label={quick!.mode === 'attrs' ? a.name + '的属性图' : '属性对比'} style={style}>
        <AttributePopover projectId={a.project_id} people={people} request={request} onClose={() => setQuick(null)} onEdit={quick!.mode === 'attrs' ? id => { setQuick(null); void openAsset(id).then(() => setTimeout(() => jump('ca-sec-attrs'), 60)); } : undefined}/>
      </div>;
    }
    if (quick!.mode === 'pick') return <div ref={ref} className="ca-quick ca-quick-panel" role="dialog" aria-label={'换' + a.name + '的默认图'} style={style}>
      <header><strong>换「{a.name}」的默认图</strong><small>点一张就换，马上生效</small></header>
      <div className="ca-quick-body">{groups.map(g => <section key={g.key} aria-label={g.title}><h4>{g.title}</h4><div className="ca-quick-grid">{g.images.map(b => { const name = b.last_known_name || '参考图片', current = b.id === cover?.id; return <button key={b.id} type="button" className={'ca-quick-thumb' + (current ? ' is-current' : '')} aria-pressed={current} aria-label={(current ? '当前默认图：' : '设为默认：') + name} disabled={current || !!busy} onClick={() => { setQuick(null); void quickSave(a.id, '正在更换默认图…', x => { const img = x.images.find(i => i.id === b.id); if (img) setCover(x, img); }, (saved, before) => { const look = saved.looks.find(l => l.id === saved.default_look_id), was = before.looks.find(l => l.id === before.default_look_id); return '已把「' + a.name + '」的默认图换成「' + name + '」' + (a.kind === 'character' && look && was && look.id !== was.id ? '，默认造型也换成了「' + look.name + '」' : '') + autoNote(before, saved, b.id); }); }}>
        <ReferencePreview src={bindingSrc(b)} alt={name}/>{current ? <span className="ca-quick-badge">默认</span> : <span className="ca-quick-set">设为默认</span>}</button>; })}</div></section>)}</div>
      <footer><small>换好后可以接着「调整头像」</small><button type="button" onClick={() => setQuick(null)}>关闭</button></footer>
    </div>;
    const crop = quick!.crop || cover!.crop, head = quick!.head ?? 'idle', source = quick!.source;
    return <div ref={ref} className="ca-quick ca-quick-panel" role="dialog" aria-label={'调整' + a.name + '的头像'} style={style}>
      <header><strong>调整「{a.name}」的头像</strong><small title={cover!.last_known_name || ''}>{cover!.last_known_name || '默认图'}</small></header>
      <div className="ca-quick-crop">
        <div className="ca-quick-cropbox"><CropBox src={bindingSrc(cover!)} alt={cover!.last_known_name || '默认图'} crop={crop} aspect={aspect} onChange={dragQuick}/>{head !== 'idle' && <span className={'ca-head-hint' + (head === 'found' ? ' is-found' : head === 'loading' ? '' : ' is-miss')} role="status">{headText[head]}</span>}</div>
        <div className="ca-quick-preview"><small>列表里会这样显示</small><span className={'ca-quick-cover' + (a.kind === 'character' ? '' : ' is-landscape')}><CroppedImage binding={{ ...cover!, crop }}/></span><button type="button" className="ca-head-reframe" disabled={!headRetry(head) || !!busy} onClick={() => void reframeQuick(a.id, cover!)}><ScanFace size={14}/>重新框到头部</button><small>只改列表里怎么显示，原图不动；复制出去的仍是整张原图。</small></div>
      </div>
      <footer><span/><span className="ca-quick-actions"><button type="button" onClick={() => setQuick(null)}>取消</button><button type="button" className="ca-primary" disabled={!!busy} onClick={() => { const c = crop, base = quick!.base ?? cropBase(cover!); setQuick(null); void quickSave(a.id, '正在保存头像…', x => {
        // 以打开面板时的默认图为前提：别处换了图、换了默认图或改了裁切，就不覆盖，请用户重新打开。
        // 拒绝时顺带刷新列表，按提示重新打开就是最新的图和框。
        if (!cropBaseHolds(x, base)) { void loadList(); throw Error('「' + a.name + '」的默认图或头像刚在别处改过，没有覆盖。请重新打开「调整头像」'); }
        const img = x.images.find(i => i.id === base.id)!; img.crop = c; if (source) img.crop_source = source; }, () => '已更新「' + a.name + '」的头像'); }}>完成</button></span></footer>
    </div>;
  }

  return <section className="ca-workspace ca-v2" aria-label="项目资产库" aria-busy={!!busy}>
    <header className="ca-head">
      <div className="ca-head-row">
        <div className="ca-head-title"><h1>项目资产</h1>
          {(!!publicId || !!assetCtx?.series) && <div className="ca-scope-switch" role="group" aria-label="看哪里的资产">
            <button type="button" aria-pressed={!publicScope && !seriesView} disabled={!currentScope || !!busy || !!modal || !!dropJob} title={currentScope?.name} onClick={() => { if (seriesView) showSeries(false); else showPublic(false); }}><FolderKanban size={13} aria-hidden="true"/><span>{currentScope?.name ?? '未选项目'}</span></button>
            {/* 第二期 P2a：当前项目属于某部剧时才有「全剧」；顶栏不变，只改资产页看的层级 */}
            {!!assetCtx?.series && <button type="button" aria-pressed={!publicScope && seriesView} disabled={!!busy || !!modal || !!dropJob} title={'「' + assetCtx.series.name + '」全剧共享的资产'} onClick={() => showSeries(true)}><Layers size={13} aria-hidden="true"/><span>全剧</span></button>}
            {!!publicId && <button type="button" aria-pressed={publicScope} disabled={!!busy || !!modal || !!dropJob} onClick={() => showPublic(true)}><Globe2 size={13} aria-hidden="true"/><span>公共人物库</span></button>}
          </div>}
          {!!assetCtx?.season && !publicScope && <button type="button" className="ca-season-entry" disabled={!!busy || !!modal || !!dropJob} onClick={() => void openSeasonSettings()}>{assetCtx.season.name}设定</button>}</div>
        {!scriptView && <div className="ca-head-tools">
          <label className="ca-search"><Search size={15} aria-hidden="true"/><input aria-label="搜索资产" placeholder={'搜索' + labels[kind]} value={q} onChange={e => { setQ(e.target.value); setPage(1); }}/></label>
          <button className="ca-primary" disabled={!scope || !!busy} onClick={() => void create()}><Plus size={15}/>新建{labels[kind]}</button>
          <div className="ca-menu-wrap"><button className="ca-icon-button" aria-label="更多资产操作" aria-haspopup="menu" aria-expanded={menu === 'page'} onClick={() => setMenu(m => m === 'page' ? '' : 'page')}><MoreHorizontal size={17}/></button>
            {menu === 'page' && <div className="ca-menu" role="menu">
              {kind === 'character' && <button role="menuitem" disabled={!!busy} onClick={() => { setMenu(''); if (!canLeave()) return; setModal({ type: 'import', source_project: scopes.find(s => s.id !== scope)?.id ?? '', source_rows: [], selected: '' }); }}><Copy size={15}/>从项目／公共库复制</button>}
              <button role="menuitemcheckbox" aria-checked={archived} onClick={() => { setMenu(''); setArchived(v => !v); setPage(1); }}><Archive size={15}/>{archived ? '返回未归档' : '查看已归档'}</button>
              <button role="menuitemradio" aria-checked={layout === 'grid'} onClick={() => { setMenu(''); setLayout('grid'); }}>卡片显示{layout === 'grid' && ' ✓'}</button>
              <button role="menuitemradio" aria-checked={layout === 'list'} onClick={() => { setMenu(''); setLayout('list'); }}>列表显示{layout === 'list' && ' ✓'}</button>
              <button role="menuitem" disabled={!!busy || listLoading} onClick={() => { setMenu(''); setError(''); void fetchContext(); void loadList().catch(e => setError(e.message)); }}>刷新列表</button>
              {kind === 'character' && !publicScope && !!scope && <button role="menuitem" onClick={() => { setMenu(''); openAttrConfig(); }}><SlidersHorizontal size={15}/>人物属性维度…</button>}
              <hr/>
              <button role="menuitem" onClick={() => { setMenu(''); onSettings(); }}>界面设置</button>
            </div>}
          </div>
        </div>}
      </div>
      {!publicScope && seriesView && assetCtx?.series && <p className="ca-public-note ca-series-note" role="note"><Layers size={13} aria-hidden="true"/>正在看「{assetCtx.series.name}」全剧的资产：这里的改动影响所有没有单独覆盖的集。顶栏的当前项目没有变，点「{currentScope?.name ?? '当前集'}」回到它的资产。只在某一集的资产不在这里显示。</p>}
      {!publicScope && seriesView && assetCtx?.series && <SeriesAlignment request={request} seriesId={assetCtx.series.id} seriesName={assetCtx.series.name} active={active} onAligned={() => setAttrConfigVersion(v => v + 1)}/>}
      {!publicScope && seriesView && assetCtx?.series && kind === 'character' && !mergeDone && <MergeBanner groups={merges.data} seriesName={assetCtx.series.name} onStart={g => openMerge(g)}/>}
      {mergeDone && <MergeDoneBar receipt={mergeDone.receipt} name={mergeDone.name} lookCount={mergeDone.lookCount} onUndo={() => setMergeUndo({ mergeId: mergeDone.receipt.merge_id, name: mergeDone.name })} onNext={() => void nextMerge(mergeDone.receipt)} onClose={() => setMergeDone(null)}/>}
      {publicScope && <p className="ca-public-note" role="note"><Globe2 size={13} aria-hidden="true"/>正在看公共人物库：这里的人物所有项目都能复制使用。顶栏的当前项目没有变{currentScope ? <>，点「{currentScope.name}」回到它的资产</> : null}。</p>}
      <div className="ca-tabs" role="tablist" aria-label="资产类别">{(Object.keys(labels) as Kind[]).map(k => <button role="tab" key={k} aria-selected={!scriptView && kind === k} disabled={!!busy || publicScope && k !== 'character'} onClick={() => switchKind(k)}>{labels[k]}{!scriptView && kind === k && !listLoading && scopesKnown && <span className="ca-tab-count">{total}</span>}</button>)}<button role="tab" aria-selected={scriptView} disabled={!!busy||publicScope||!scopes.some(s=>s.id===scope&&s.project_kind==='normal')} onClick={()=>{if(scriptView||!canLeave())return;selectionGeneration.current++; setDetailLoading(false);setModal(null);setScriptView(true);}}>剧本</button></div>
    </header>
    {(error||scopesError) && <div className="ca-alert" role="alert">{error||scopesError}{scopesError&&<button onClick={()=>retryScopes(n=>n+1)}>重试项目范围</button>}<button aria-label="关闭错误" onClick={() => {setError('');if(scopesKnown)setScopesError('');}}><X size={14}/></button></div>}{notice && <div className="ca-notice" role="status">{notice}<button aria-label="关闭通知" onClick={() => setNotice('')}><X size={14}/></button></div>}
    {busy && <div className="ca-progress" role="status"><span className="spinner"/>{busy}</div>}
    <div className="ca-script-host" hidden={!scriptView}><ProjectScript projectId={scope} visible={active&&scriptView&&!publicScope} request={request} onDirtyChange={setScriptDirty} names={scriptNames} namesStatus={scriptNamesRead.project === scope ? scriptNamesRead.status : 'loading'}/></div>
    <div className="ca-stage" hidden={scriptView}><fieldset className="ca-interaction" disabled={!!busy}>
      <div className={'ca-body' + (draft || pickedAssets.length > 1 ? ' has-detail' : '')}>
        <section className={'ca-gallery' + (dragTarget === 'gallery' ? ' is-drop' : '') + (marquee ? ' is-marquee' : '')} aria-label={labels[kind] + '画廊'} aria-busy={listLoading||!scopesKnown&&!scopesError}
          ref={galleryRef} tabIndex={-1} onKeyDown={e => pickKeys.current(e.nativeEvent)} onPointerDown={marqueeStart} {...dragProps('gallery', dropOnGallery)} onDragLeave={e => { if (!(e.currentTarget as Element).contains(e.relatedTarget as Node)) setDragTarget(''); }}>
          {!trulyEmpty && <div className="ca-gallery-bar">
            <div className="ca-filters" role="group" aria-label="筛选"><button type="button" aria-pressed={!missingOnly} onClick={() => setMissingOnly(false)}>全部</button><button type="button" aria-pressed={missingOnly} onClick={() => setMissingOnly(true)}>缺参考图</button></div>
            <span className="ca-count">{listStatus}{missingOnly && !listLoading ? ` · 本页缺参考图 ${visibleRows.length} 个` : ''}</span>
          </div>}
          {!scopesKnown&&!scopesError&&<div className="ca-progress" role="status">正在读取项目范围…</div>}
          {listLoading && <div className="ca-progress" role="status"><span className="spinner"/>正在加载当前项目的{labels[kind]}…</div>}
          {pickedAssets.length > 0 && <div className="ca-pickbar" role="toolbar" aria-label={'已选' + labels[kind] + '操作'}>
            <strong>已选 {pickedAssets.length} 个{labels[kind]}</strong><small>每个复制一张默认图（原图文件）· ⌘C 也可以复制</small><span className="ca-grow"/>
            <button type="button" className="ca-primary" disabled={!clipCap.available || desktopBusy || !!overPick(pickedAssets.length)} title={clipCap.reason || overPick(pickedAssets.length) || undefined} onClick={() => void copyFiles('defaults', defaultsItems(pickedAssets))}><Copy size={14}/>复制</button>
            <button type="button" disabled={!revealCap.available || desktopBusy || !!overPick(pickedAssets.length)} title={revealCap.reason || overPick(pickedAssets.length) || undefined} onClick={() => void revealFiles('defaults', defaultsItems(pickedAssets))}><FolderOpen size={14}/>在访达中显示</button>
            <button type="button" className="ca-link-button" onClick={() => setPickedAssets([])}>取消选择</button>
            {!clipCap.available && <small className="ca-pickbar-reason">{clipCap.reason}</small>}
          </div>}
          <div className={'ca-cards ca-' + layout + (kind === 'character' ? ' ca-portrait' : ' ca-landscape') + (pickedAssets.length ? ' is-picking' : '')}>
            {visibleRows.map(a => { const cover = coverFor(a), owner = scopeBase ? metas[a.id]?.owner : undefined, imageCount = (a.images ?? []).filter(b => !b.archived_at).length; const picked = (marqueeHits ?? pickedAssets).includes(a.id); return <div key={a.id} className={'ca-card-wrap' + (quick?.id === a.id ? ' is-quick' : '') + (picked ? ' is-picked' : '')} data-pick-id={pickableAsset(a) ? a.id : undefined}
              onContextMenu={e => { e.preventDefault(); openMenu(a, e.clientX, e.clientY); }}><button className={'ca-card' + (draft?.id === a.id ? ' selected' : '') + (dragTarget === a.id ? ' is-drop' : '') + (a.archived_at ? ' is-archived' : '')} aria-current={draft?.id === a.id ? 'true' : undefined} aria-pressed={kind === 'character' && pickedAssets.length ? picked : undefined} onClick={e => { if (kind === 'character') pickCard(e, a); else if (!alreadyOpen(a.id)) void openAsset(a.id); }} onDoubleClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; const c = coverOf(a); if (c) setImageViewer({ src: bindingSrc(c), name: c.last_known_name || a.name, from: 'card' }); }} {...dragProps(a.id, e => void dropOnCard(e, a))}>
              <Cover a={a} binding={cover}/>
              <span className="ca-card-body"><strong>{a.name}</strong>{owner && <span className={'ca-owner-src ' + (owner.type === 'series' ? 'is-series' : 'is-local')}>{ownerLabel(owner)}</span>}<small>{a.base_info?.slice(0, 65) || '基础信息待完善'}</small>{a.kind === 'character' && (() => { const g = mergeGroupOf(a.id); return g ? <span className="cm-card-hint">{siblingHint(g, a.id)}</span> : null; })()}
                <span className="ca-card-meta">{a.kind === 'character' ? <span className="ca-pill">{a.look_count ?? a.looks?.length ?? 0} 造型 · {imageCount} 图</span> : <span className="ca-pill">{imageCount} 张参考图</span>}{!cover && <span className="ca-pill warn">缺参考图</span>}{!!a.archived_at && <span className="ca-pill">已归档</span>}{a.source && <span className="ca-pill" title={'复制自 ' + a.source.project_name}>复制自 {a.source.project_name}</span>}</span>
              </span>
              {dragTarget === a.id && <span className="ca-card-drop">添加为“{a.name}”的参考图</span>}
            </button>
              <span className="ca-card-quick">
                {cover && <button type="button" className="ca-card-copy" aria-label={'复制' + a.name + '的默认图'} title="复制默认图（整张原图），到画布平台按 ⌘V 粘贴" onClick={() => void copyDefault(a)}><Copy size={13}/>复制</button>}
                <button type="button" className="ca-card-more" aria-label={a.name + '的更多操作'} aria-haspopup="menu" data-quick-trigger onClick={e => { const r = e.currentTarget.getBoundingClientRect(); setQuick(q => q?.id === a.id && q.mode === 'menu' ? null : { id: a.id, mode: 'menu', x: r.right - 196, y: r.bottom + 6 }); }}><MoreHorizontal size={15}/></button>
              </span>
            </div>; })}
            {!archived && (() => { const off = !scope || !!busy || publicScope && kind !== 'character'; return <button className={'ca-card ca-card-add' + (trulyEmpty ? ' is-empty' : '')} disabled={off} onClick={() => void create()}><Plus size={18}/>{trulyEmpty ? <span><strong>还没有{labels[kind]}</strong>{!off && <small>拖入图片或点击新建</small>}</span> : <span>新建{labels[kind]}</span>}</button>; })()}
          </div>
          {scopesKnown && !listLoading && !rows.length && !error && !scopesError && (archived || !scope) && empty(scope ? '暂无归档' + labels[kind] : '请先选择项目')}
          {missingOnly && !listLoading && !!rows.length && !visibleRows.length && empty('本页的' + labels[kind] + '都已有参考图')}
          {total > 40 && <div className="ca-pagination"><button disabled={page === 1} onClick={() => setPage(v => v - 1)}>上一页</button><span>{page} / {Math.ceil(total / 40)}</span><button disabled={page * 40 >= total} onClick={() => setPage(v => v + 1)}>下一页</button></div>}
          {dragTarget === 'gallery' && <div className="ca-drop-hint" aria-hidden="true"><ImagePlus size={26}/>松开以新建{labels[kind]}</div>}
          {marquee && <div className="ca-marquee" aria-hidden="true" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}/>}
        </section>
        {!draft && pickedAssets.length > 1 && <aside className="ca-detail ca-pick-summary" aria-label={'已选' + labels[kind]}>
          <h3>已选 {pickedAssets.length} 个{labels[kind]}</h3>
          <ul>{pickedAssets.map(id => rows.find(r => r.id === id)).filter((r): r is Asset => !!r).map(r => <li key={r.id}><Avatar a={r}/><span>{r.name}</span></li>)}</ul>
          <p className="ca-muted">多选时这里只列出已选的{labels[kind]}。单击某一张卡片，回到只选它并显示详情。</p>
        </aside>}
        {draft && <aside ref={detailRef} className={'ca-detail' + (detailLoading ? ' is-loading' : '')} aria-label={labels[draft.kind] + '详情'} aria-busy={detailLoading || undefined} {...(detailLoading ? { inert: '' } : {})}>
          {detailSlow && <div className="ca-detail-loading" role="status">正在读取资料…</div>}
          <div className="ca-detail-head">
            <Avatar a={draft}/>
            <div className="ca-detail-title">
              <input className="ca-name-input" aria-label={labels[draft.kind] + '名称'} value={draft.name} disabled={locked} onChange={e => { const v = e.target.value; edit(a => { a.name = v; }); }}/>
              <span className="ca-owner-tag">{owner?.project_kind === 'public' ? <><Globe2 size={12}/>公共人物</> : draftOwner?.type === 'series' ? <><Layers size={12}/>全剧{labels[draft.kind]} · {draftOwner.name}</> : <><FolderKanban size={12}/>项目{labels[draft.kind]} · {owner?.name || '所属项目读取中'}</>}</span>
            </div>
            <div className="ca-menu-wrap"><button className="ca-icon-button" aria-label="资料操作" aria-haspopup="menu" aria-expanded={menu === 'detail'} onClick={() => setMenu(m => m === 'detail' ? '' : 'detail')}><MoreHorizontal size={17}/></button>
              {menu === 'detail' && <div className="ca-menu" role="menu">
                {draft.kind === 'character' && <button role="menuitem" disabled={!!busy || dirty || locked} title={dirty ? '请先保存当前修改' : undefined} onClick={() => { setMenu(''); void openCopy(); }}><Copy size={15}/>复制到其他项目</button>}
                <button role="menuitem" onClick={() => { setMenu(''); setModal({ type: 'history' }); }}><History size={15}/>来源与版本（V{draft.revision}）</button>
                <hr/>
                {draft.kind === 'character' && !draft.archived_at && mergeGroupOf(draft.id) && <button role="menuitem" disabled={!!busy || dirty} title={dirty ? '请先保存当前修改' : undefined} onClick={() => openMerge(mergeGroupOf(draft.id)!, draft.id)}><Users size={15}/>合并同名人物…</button>}
                {!!scopeBase && !seriesView && draftOwner?.type === 'project' && draftMeta?.capabilities.promote && !draft.archived_at && <button role="menuitem" disabled={!!busy || dirty} title={dirty ? '请先保存当前修改' : undefined} onClick={() => { setMenu(''); void previewPromotion(); }}><Layers size={15}/>提升到全剧…</button>}
                {!(draft.archived_at && sharedRestoreBlocked) && <button role="menuitem" title={draft.storyboard_protected ? '属于当前分镜清单，请重新初始化后移出清单再归档' : dirty ? '请先保存当前修改' : undefined} disabled={!!busy || dirty || !!draft.storyboard_protected || inheritedHere} onClick={() => { setMenu(''); if (archiveViaPreview && !draft.archived_at) void previewArchive({ type: 'asset', id: draft.id }, '「' + draft.name + '」'); else void toggleArchive(); }}><Archive size={15}/>{draft.archived_at ? '恢复' : archiveViaPreview ? '归档…' : '归档'}</button>}
              </div>}
            </div>
            <button className="ca-icon-button" aria-label="关闭详情" disabled={!!busy} onClick={closeDetail}><X size={17}/></button>
          </div>
          {draft.storyboard_protected && <p className="ca-detail-note">分镜清单已保护 · 可编辑，移出清单后可归档。</p>}
          {!!scopeLock && !draft.archived_at && <div className="ca-archive-note ca-scope-lock" role="status"><Layers size={15}/>{scopeLock}</div>}
          {inheritedHere && !draft.archived_at && draftMeta && <ScopeOverrides key={draft.id + ':' + scopeBase} asset={draft} meta={draftMeta} lookId={lookId || null} busy={!!busy} dims={dimsAligned ? scopeDims!.dims : undefined} onPickImage={lk => { setMediaQ(''); setMediaPage(1); setModal({ type: 'media', append: { lookId: lk } }); }} append={appendHandlers} seriesName={assetCtx?.series?.name} dimsNote={scopeDims && !dimsAligned ? '评分维度刚在全剧改过，请重新打开这个人物后再改分' : ''} thumb={b => <ReferencePreview src={bindingSrc(b as Binding)} alt={b.last_known_name || '参考图片'}/>} onOverride={(f, a, v, t) => void applyOverride(f, a, v, t)}/>}
          {!!draft.archived_at && <div className="ca-archive-note" role="status"><Archive size={15}/>该{labels[draft.kind]}已归档，资料和图片设置只读。{sharedRestoreBlocked ? sharedRestoreNote : '在右上角“⋯”中选择“恢复”后可继续编辑。'}</div>}
          {conflict && <div className="ca-conflict" role="alert"><strong>{labels[draft.kind]}已经更新：当前 V{draft.revision}，数据库 V{conflict.revision}</strong><p>本地修改仍保留。请先比较变化，再决定采用最新资料或核对后合并保存。</p><button onClick={() => setModal({ type: 'compare', latest: conflict })}>比较资料</button><button onClick={() => { if (canLeave()) install(conflict); }}>载入最新资料</button></div>}
          <nav className="ca-detail-nav" aria-label="详情分区">{([['ca-sec-info', '资料'], ['ca-sec-refs', draft.kind === 'character' ? '造型与参考图' : '参考图'], ...(draft.kind === 'character' && owner?.project_kind !== 'public' ? [['ca-sec-attrs', '属性']] : []), ...(draft.kind === 'character' ? [['ca-sec-voice', '语音']] : []), ['ca-sec-shots', '出场镜头']] as [string, string][]).map(([id, l]) => <button type="button" key={id} onClick={() => jump(id)}>{l}</button>)}</nav>
          <div className="ca-detail-scroll" ref={detailScroll}>
            <section className="ca-sec" id="ca-sec-info" aria-label="资料">
              <h3>资料</h3>
              <fieldset disabled={locked} className="ca-form ca-edit-fields">
                <Field label={draft.kind === 'character' ? '基础信息' : '自由描述'} long rows={3} value={draft.base_info} onChange={v => edit(a => { a.base_info = v; })}/>
                {draft.kind === 'character' ? <><Field label="性格与表演" long rows={3} value={draft.performance_info} onChange={v => edit(a => { a.performance_info = v; })}/><label className="ca-field"><span>默认造型</span><select aria-label="默认造型" value={draft.default_look_id ?? ''} onChange={e => { const v = e.target.value; edit(a => { a.default_look_id = v || null; }); }}>{!draft.looks.some(l => !l.archived_at) && <option value="">待完善</option>}{draft.looks.filter(l => !l.archived_at).map(l => <option value={l.id} key={l.id}>{l.name}</option>)}</select></label></>
                  : <div className="ca-field-grid">{detailFields[draft.kind].map(k => <Field key={k} label={k} long rows={2} value={draft.details[k] ?? ''} onChange={v => edit(a => { a.details[k] = v; })}/>)}</div>}
                <p className="ca-muted">名称在本项目内唯一。其他资料可后补；姓名和排序变化不会改变永久编号。</p>
              </fieldset>
            </section>
            <section className="ca-sec" id="ca-sec-refs" aria-label={draft.kind === 'character' ? '造型与参考图' : '参考图'}>
              <h3>{draft.kind === 'character' ? '造型与参考图' : '参考图'} <small>第一张是代表图 · 拖动排序 · 黄点表示参考职责未确认 · 保存后生效</small></h3>
              {draft.kind === 'character' && <>
                <div className="ca-look-list">{draft.looks.map(l => <button type="button" key={l.id} className={l.id === lookId ? 'selected' : ''} aria-pressed={l.id === lookId} onClick={() => setLookId(l.id)}>{l.id === draft.default_look_id && <Star size={12} className="ca-star" aria-label="默认造型"/>}{l.name}{l.archived_at ? '（归档）' : ''}<span className="ca-count-chip">{draft.images.filter(b => b.look_id === l.id && !b.archived_at).length}</span></button>)}<button type="button" disabled={locked} onClick={() => { const id = crypto.randomUUID(); edit(a => { a.looks.push({ id, name: '新造型', description: '', tags: [], default_image_id: null, archived_at: null }); a.default_look_id ??= id; }); setLookId(id); }}><Plus size={14}/>新增造型</button></div>
                {!draft.looks.length && empty('先新增造型，再绑定参考图片')}
                {currentLook && <>
                  <div className="ca-look-summary"><span>{currentLook.description || '没有造型说明'}</span>{currentLook.tags.map(t => <span key={t} className="ca-pill">{t}</span>)}{currentLook.id !== draft.default_look_id && !currentLook.archived_at && <button type="button" className="ca-link-button" disabled={locked} onClick={() => edit(a => { a.default_look_id = lookId; })}>设为默认造型</button>}</div>
                  <details className="ca-look-config" key={currentLook.id}><summary><span>造型设置</span><small>名称、说明、类型、排序与归档</small></summary><div className="ca-look-form"><fieldset className="ca-look-fields ca-edit-fields" disabled={locked || !!currentLook.archived_at}><Field label="造型名称" placeholder="例如：日常造型、工作造型、雨夜造型" value={currentLook.name} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.name = v; })}/><Field label="造型说明" long placeholder="描述这套造型的使用情境与外观特点。例如：工作时穿着，深色外套，衣角略有磨损。" value={currentLook.description} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.description = v; })}/><Tags key={currentLook.id} value={currentLook.tags} onChange={v => edit(a => { a.looks.find(l => l.id === lookId)!.tags = v; })}/></fieldset><div className="ca-actions"><button disabled={locked || !!currentLook.archived_at} aria-label="造型上移" onClick={() => edit(a => { const i = a.looks.findIndex(l => l.id === lookId); if (i > 0) [a.looks[i - 1], a.looks[i]] = [a.looks[i], a.looks[i - 1]]; })}><ArrowUp size={14}/>上移</button><button disabled={locked || !!currentLook.archived_at} aria-label="造型下移" onClick={() => edit(a => { const i = a.looks.findIndex(l => l.id === lookId); if (i >= 0 && i < a.looks.length - 1) [a.looks[i + 1], a.looks[i]] = [a.looks[i], a.looks[i + 1]]; })}><ArrowDown size={14}/>下移</button><button disabled={locked || !!currentLook.archived_at || currentLook.id === draft.default_look_id} onClick={() => edit(a => { a.default_look_id = lookId; })}>设为默认造型</button>{!(currentLook.archived_at && sharedRestoreBlocked) && <button disabled={locked} onClick={() => { if (archiveViaPreview && !currentLook.archived_at) { void previewArchive({ type: 'look', id: currentLook.id }, '造型「' + currentLook.name + '」'); return; } if (!currentLook.archived_at && currentLook.id === draft.default_look_id && draft.looks.some(l => !l.archived_at && l.id !== lookId)) { setError('请先将其他造型设为默认，再归档当前造型'); return; } edit(a => { const l = a.looks.find(l => l.id === lookId)!; l.archived_at = l.archived_at ? null : Date.now(); if (l.archived_at && a.default_look_id === l.id) a.default_look_id = null; if (!l.archived_at && !a.default_look_id) a.default_look_id = l.id; }); }}>{currentLook.archived_at ? '恢复造型' : '归档造型'}</button>}</div></div></details>
                  {currentLook.archived_at && <p className="ca-muted">{sharedRestoreBlocked ? '该造型已归档，图片不显示。' + sharedRestoreNote : '该造型已归档，图片不显示；恢复造型后可继续编辑。'}</p>}
                </>}
              </>}
              {(draft.kind !== 'character' || currentLook && !currentLook.archived_at) && <>
                {pickedImages.length > 0 && <div className="ca-pickbar" role="toolbar" aria-label="已选参考图操作">
                  <strong>已选 {pickedImages.length} 张</strong>{pickedImages.some(id => !images.some(b => b.id === id)) && <small>含其他造型 {pickedImages.filter(id => !images.some(b => b.id === id)).length} 张</small>}<span className="ca-grow"/>
                  <button type="button" className="ca-primary" disabled={!clipCap.available || desktopBusy} title={clipCap.reason || undefined} onClick={() => void copyFiles('references', referenceItems(pickedImages))}><Copy size={14}/>复制</button>
                  <button type="button" disabled={!revealCap.available || desktopBusy} title={revealCap.reason || undefined} onClick={() => void revealFiles('references', referenceItems(pickedImages))}><FolderOpen size={14}/>在访达中显示</button>
                  <button type="button" className="ca-link-button" onClick={() => setPickedImages([])}>取消选择</button>
                  {!clipCap.available && <small className="ca-pickbar-reason">{clipCap.reason}</small>}
                </div>}
                <div className={'ca-image-grid-v2' + (pickedImages.length ? ' is-picking' : '')} role="list" aria-label={'参考图片，共 ' + images.length + ' 张'}>{images.map(b => { const h = health.find(h => h.id === b.id), name = b.last_known_name || '参考图片', locked = imageLocked(b); const tilePicked = pickedImages.includes(b.id); return <div role="listitem" key={b.id} className={'ca-tile' + (b.archived_at ? ' archived' : '') + (b.id === representative ? ' is-cover' : '') + (tilePicked ? ' is-picked' : '')} draggable={!locked} onDragStart={e => { if (locked) return; drag.current = b.id; e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { drag.current = null; }} onDragOver={e => { if (drag.current) e.preventDefault(); }} onDrop={e => { if (!drag.current) return; e.preventDefault(); e.stopPropagation(); if (!locked) moveImage(drag.current, 0, b.id); drag.current = null; }}>
                  <button type="button" className="ca-tile-open" aria-label={'设置参考图片：' + name} aria-haspopup="dialog" title="单击设置 · 双击放大" onClick={e => { if (draft.kind === 'character' && (pickedImages.length || e.metaKey || e.ctrlKey || e.shiftKey)) { pickImage(b, e.shiftKey); return; } tileClick(b.id, e.detail); }} onDoubleClick={() => { cancelTileOpen(); setImageViewer({ src: bindingSrc(b), name }); }}>{h && h.state !== 'available' ? <span className="ca-tile-state">{h.label}</span> : <ReferencePreview src={bindingSrc(b)} alt={name}/>}</button>
                  {draft.kind === 'character' && <button type="button" role="checkbox" className="ca-tile-pick" aria-checked={tilePicked} aria-label={'选择 ' + name} disabled={!pickableImage(b)} title={pickableImage(b) ? '选择（按住 ⌘ 或 Shift 点图片也可以）' : b.archived_at ? '已归档的图片不能选' : '保存后才能选'} onClick={e => pickImage(b, e.shiftKey)}>{tilePicked ? '✓' : ''}</button>}
                  <span className="ca-tile-badge">{b.id === representative ? '代表图' : b.archived_at ? '已归档' : (b.reference_type || '补充参考')}</span>
                  {(!h || h.state === 'available') && <button type="button" className="ca-tile-zoom" aria-label={'放大查看：' + name} title="放大查看" onClick={() => { cancelTileOpen(); setImageViewer({ src: bindingSrc(b), name }); }}><ZoomIn size={14}/></button>}
                  {b.id !== representative && !b.archived_at && !locked && !draft.archived_at && (!h || h.state === 'available') && <button type="button" className="ca-tile-default" aria-label={'设为代表图：' + name}
                    onClick={() => { if (dirty) { edit(x => setDefault(x, b.id)); setNotice('已设为代表图；还有其他未保存的修改，点下方「保存」后一起生效'); return; }
                      void quickSave(draft.id, '正在设置代表图…', x => { if (x.kind === 'character') { const l = x.looks.find(l => l.id === b.look_id); if (l) l.default_image_id = b.id; } else x.default_image_id = b.id; }, (saved, before) => '已把「' + name + '」设为代表图' + autoNote(before, saved, b.id)); }}><Star size={12}/>设为代表图</button>}
                  {!b.confirmed && !b.archived_at && <span className="ca-tile-dot" title="参考职责未确认" aria-label="参考职责未确认"/>}
                  <span className="ca-tile-name" title={name}>{name}</span>
                </div>; })}</div>
                {!images.length && empty('还没有参考图片，可以在下方导入，或从访达拖到这里')}
                <details className="ca-add-images" key={draft.id+':'+lookId} open={images.length ? undefined : true}><summary><ImagePlus size={14}/>添加参考图片<span>导入文件 / 从素材库绑定</span></summary>{seriesImport ? <ReferenceImageImport key={'series:'+draft.id+':'+(currentLook?.id||'')} libraryAction={<button disabled={!!busy || locked} onClick={() => { setMediaQ(''); setMediaPage(1); setModal({ type: 'media' }); }}><ImagePlus size={16}/>从素材库绑定图片</button>} target={{assetId:draft.id,projectId:seriesImport,lookId:draft.kind==='character'?currentLook!.id:null}} context={{projectName:'全剧「'+(assetCtx?.series?.name??'')+'」',assetName:draft.name,lookName:currentLook?.name||'',revision:draft.revision,kind:draft.kind,available:active&&!scriptView&&!draft.archived_at&&!dropJob&&(!currentLook||!currentLook.archived_at)}} disabled={!!busy||locked} request={request} onReady={importedImage} onBusy={importBusy} scoped={{startExtra:{series_context_token:scopeToken() ?? draftMeta?.context_token ?? ''},verify:verifyScopedTarget,note:'关联需点击“保存”，保存后各集沿用',confirmNote:'确认后复制到这部剧的 picture 文件夹；关联仍需点击下方“保存”，保存后各集都能看到。'}}/>
                  : inheritedHere ? (draftMeta?.capabilities.append && !draft.archived_at ? <ReferenceImageImport key={'append:'+draft.id+':'+(currentLook?.id||'')} libraryAction={<button disabled={!!busy} onClick={() => { setMediaQ(''); setMediaPage(1); setModal({ type: 'media', append: { lookId: draft.kind==='character'?currentLook!.id:null } }); }}><ImagePlus size={16}/>从素材库选择</button>} target={{assetId:draft.id,projectId:assetCtx?.project.id??scope,lookId:draft.kind==='character'?currentLook!.id:null}} context={{projectName:currentScope?.name||'本集',assetName:draft.name,lookName:currentLook?.name||'',revision:draft.revision,kind:draft.kind,available:active&&!scriptView&&!draft.archived_at&&!dropJob&&(!currentLook||!currentLook.archived_at)}} disabled={!!busy} request={request} onReady={r=>{if(r.mediaAssetId)setAppendReady({assetId:r.target.assetId,projectId:r.target.projectId,mediaId:r.mediaAssetId,name:r.fileName,lookId:r.target.lookId});}} onBusy={importBusy} scoped={{startExtra:{append_context_token:scopeToken() ?? draftMeta?.context_token ?? ''},verify:verifyScopedTarget,note:'上传后先预览，确认才追加到全剧',confirmNote:'确认后复制到本集的 picture 文件夹，接着预览「追加到全剧」的影响，需要你再确认一次。'}}/> : <p className="ca-muted">这是全剧共享的资产，当前没有在本集追加图片的权限。</p>)
                  : <ReferenceImageImport libraryAction={<button disabled={!!busy || locked} onClick={() => { setMediaQ(''); setMediaPage(1); setModal({ type: 'media' }); }}><ImagePlus size={16}/>从素材库绑定图片</button>} key={draft.id+':'+(currentLook?.id||'')} target={{assetId:draft.id,projectId:draft.project_id,lookId:draft.kind==='character'?currentLook!.id:null}} context={{projectName:owner?.name||'当前项目',assetName:draft.name,lookName:currentLook?.name||'',revision:draft.revision,kind:draft.kind,available:active&&!scriptView&&!draft.archived_at&&!dropJob&&(!currentLook||!currentLook.archived_at)}} disabled={!!busy||locked} request={request} onReady={importedImage} onBusy={importBusy}/>}<details className="ca-reference-help"><summary>导入与保存说明</summary><p>导入文件会立即保留在 picture 的项目文件夹；图片关联和代表图需点击下方“保存”后生效，放弃修改不会删除文件。</p><p>拖动图片调整顺序，或在图片设置里前移、后移；代表图仅用于列表展示。参考说明选填，不会自动发送给生成工具。</p></details></details>
              </>}
            </section>
            {draft.kind === 'character' && owner?.project_kind !== 'public' && !(scopeBase && draftOwner?.type === 'series' && !seriesView) && <section className="ca-sec" id="ca-sec-attrs" aria-label="属性"><CharacterAttributes key={draft.id + (seriesView ? ':series' : '')} assetId={draft.id} projectId={draft.project_id} name={draft.name} request={request} active={active && !scriptView} readOnly={!!draft.archived_at} onOpenConfig={() => openAttrConfig()} configVersion={attrConfigVersion} seriesScope={scopeBase && seriesView && draftOwner?.type === 'series' ? { base: scopeBase, contextToken: draftMeta?.context_token ?? scopeToken() ?? assetCtx?.context_token ?? '' } : undefined}/></section>}
            {draft.kind === 'character' && !!scopeBase && draftOwner?.type === 'series' && !seriesView && <section className="ca-sec" id="ca-sec-attrs" aria-label="属性"><h3>属性</h3><p className="ca-muted">这是全剧共享的人物：评分在上方「本集设置」里按维度覆盖，没有覆盖的维度沿用全剧。</p></section>}
            {draft.kind === 'character' && <section className="ca-sec" id="ca-sec-voice" aria-label="语音"><CharacterVoice key={draft.id} assetId={draft.id} revision={draft.revision} value={draft.details.character_voice} disabled={locked||!!busy} active={active&&!scriptView} request={request} onChange={value=>{const ownerId=draft.id;edit(a=>{if(a.id===ownerId)a.details.character_voice=value;});}} onBusy={value=>setBusy(current=>value?'正在添加角色语音…':current==='正在添加角色语音…'?'':current)}/></section>}
            <section className="ca-sec" id="ca-sec-shots" aria-label="出场镜头">{!!scopeBase && seriesView && draftOwner?.type === 'series' ? <p className="ca-muted">全剧没有单集的镜号列表：切到某一集，可以看这个人物在那一集的出场镜头。</p> : <AssociatedShots key={draft.id + (inheritedHere ? ':ep' : '')} assetId={draft.id} active={active} request={request} onOpen={onOpenShot} basePath={inheritedHere ? '/project-assets' + scopeBase : undefined}/>}</section>
          </div>
          <footer className={'ca-savebar' + (dirty ? ' is-dirty' : '')}>
            <span className="ca-save-status" role="status"><i aria-hidden="true"/>{dirty ? '有未保存的修改' : '已保存'} · V{draft.revision} · 更新于 {date(draft.updated_at)}</span>
            {dirty && <button type="button" disabled={!!busy || locked} onClick={discard}><Undo2 size={15}/>放弃修改</button>}
            <button type="button" className="ca-primary" aria-label="保存资料" disabled={!!busy || !dirty || locked} onClick={() => void save()}><Save size={15}/>保存</button>
          </footer>
        </aside>}
      </div>
    </fieldset></div>
    {active && !scriptView && quick && (() => { const a = rows.find(r => r.id === quick.id); return a ? quickPanel(a) : null; })()}
    {active && attrDialog > 0 && scope && !publicScope && (() => {
      const seq = attrDialog, ser = seriesView && scopeBase && assetCtx?.series ? assetCtx.series : null;
      // 全剧视图改的是全剧维度（<series>/attribute-config），不能落到本集的配置上
      return <AttributeConfig key={(ser ? 'series:' + ser.id : scope) + ':' + seq} projectId={ser ? ser.id : scope} projectName={ser ? '全剧「' + ser.name + '」' : scopes.find(s => s.id === scope)?.name ?? ''} request={request}
        series={ser ? { base: scopeBase, token: () => scopeToken() ?? assetCtx?.context_token } : undefined} onGoSeries={!ser && assetCtx?.series ? goSeriesAttrConfig : undefined}
        onClose={() => setAttrDialog(cur => cur === seq ? 0 : cur)} onSaved={c => { if (ser || c.project_id === scopeRef.current) setAttrConfigVersion(v => v + 1); }}/>; })()}
    {active && desktop.action && desktopStatus()}
    {active && revealAsk && desktop.action?.requestId === revealAsk && desktop.action.receipt && <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setRevealAsk(null); }}>
      <div className="ca-modal ca-reveal-ask" role="dialog" aria-label="在访达中显示所选图片">
        <h2>会打开 {desktop.action.receipt.folderCount} 个访达窗口</h2>
        <p className="ca-muted">所选图片分在这些文件夹里：</p>
        <ul>{(desktop.action.receipt.folders || []).map(f => <li key={f.key}>{f.label} · {f.count} 张</li>)}</ul>
        {!!desktop.action.receipt.skipped?.length && <p className="ca-muted">跳过：{skippedText(desktop.action.receipt.skipped).join('；')}</p>}
        <footer><button type="button" onClick={() => { setRevealAsk(null); desktop.clear(); }}>取消</button><button type="button" className="ca-primary" onClick={() => { const a = desktop.action!; setRevealAsk(null); void desktop.start('reveal', a.mode, a.items, { previewToken: a.receipt!.previewToken }); }}>打开</button></footer>
      </div>
    </div>}
    {active && undo && <div className="ca-undo-toast" role="status"><span>{undo.text}</span><button type="button" disabled={!!busy} onClick={() => { const u = undo; if (undoBlocked(u.id)) { setError('这个' + labels[draftRef.current!.kind] + '有未保存的修改，请先保存或放弃修改，再撤销'); return; } setUndo(null); void undoQuick(u); }}>撤销</button><button type="button" className="ca-undo-close" aria-label="关闭提示" onClick={() => setUndo(null)}><X size={13}/></button></div>}
    {active && !scriptView && imageViewer && <ReferenceImageViewer src={imageViewer.src} name={imageViewer.name} onClose={() => setImageViewer(null)}/>}
    {draft && dialogImage && !imageViewer && !scriptView && active && <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setImageId(null); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setImageId(null); } }}>
      <div className="ca-modal ca-image-dialog" role="dialog" aria-modal="true" aria-label={'参考图片设置：' + (dialogImage.last_known_name || '参考图片')}>
        <div className="ca-image-dialog-visual">
          {dialogHealth && dialogHealth.state !== 'available' ? <span className="ca-tile-state">{dialogHealth.label}</span> : cropOpen ? <CropBox src={bindingSrc(dialogImage)} alt={dialogImage.last_known_name || '参考图片'} crop={dialogImage.crop} aspect={cropAspect} disabled={imageLocked(dialogImage)} onChange={(c: Crop) => dragDetail(dialogImage.id, () => c)}/> : <ReferencePreview src={bindingSrc(dialogImage)} alt={dialogImage.last_known_name || '参考图片'}/>}
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
            {dialogImage.archived_at && sharedRestoreBlocked ? <small className="ca-muted">{sharedRestoreNote}</small> : <button className="ca-danger-text" disabled={locked || !!currentLook?.archived_at} onClick={() => { if (archiveViaPreview && !dialogImage.archived_at) { setImageId(null); void previewArchive({ type: 'image', id: dialogImage.id }, '图片「' + (dialogImage.last_known_name || '参考图片') + '」'); return; } const b = dialogImage; if (!b.archived_at && b.id === representative && images.some(i => !i.archived_at && i.id !== b.id)) { setError('请先选择另一张默认代表图，再解绑当前图片'); return; } edit(a => { const image = a.images.find(i => i.id === b.id)!; image.archived_at = image.archived_at ? null : Date.now(); if (image.archived_at && representative === b.id) setDefault(a, null); if (!image.archived_at && !representative) setDefault(a, image.id); }); }}>{dialogImage.archived_at ? '恢复绑定' : '解绑归档'}</button>}
          </div>
          <details className="ca-crop" open={cropOpen} onToggle={e => setCropOpen((e.currentTarget as HTMLDetailsElement).open)}><summary>封面裁切与库内使用</summary>{(() => { const h = detailHead?.id === dialogImage.id ? detailHead.head : 'idle'; return <div className="ca-head-row-detail"><button type="button" className="ca-head-reframe" disabled={imageLocked(dialogImage) || !headRetry(h) || !!dialogHealth && dialogHealth.state !== 'available'} onClick={() => { setCropOpen(true); void reframeDetail(dialogImage); }}><ScanFace size={14}/>重新框到头部</button>{h !== 'idle' && <span className={'ca-head-hint is-inline' + (h === 'found' ? ' is-found' : h === 'loading' ? '' : ' is-miss')} role="status">{h === 'found' ? '已框到头部，可以再拖；点下方「保存」后生效' : headText[h]}</span>}</div>; })()}<p className="ca-muted">在图片上拖动框调整位置，拖四个角缩放（最多 3 倍）；也可以用下面的滑块微调。卡片封面按裁切框显示；头像按方形比例显示，使用相同的位置和缩放参数，框外内容也可能出现在头像里，以下方预览为准。</p>{(['x','y','zoom'] as const).map(k => <label key={k} className="ca-field"><span>{k === 'x' ? '水平位置' : k === 'y' ? '垂直位置' : '缩放'}</span><input disabled={imageLocked(dialogImage)} aria-label={'裁切' + k} type="range" min={k === 'zoom' ? 1 : 0} max={k === 'zoom' ? 3 : 100} step={k === 'zoom' ? .05 : 1} value={dialogImage.crop[k]} onChange={e => { const v = Number(e.target.value); dragDetail(dialogImage.id, c => ({ ...c, [k]: v })); }}/></label>)}<span className="ca-crop-previews"><span className="ca-crop-preview-item"><span className="ca-crop-card-preview" style={{ aspectRatio: String(cropAspect) }}><CroppedImage binding={dialogImage} alt="卡片封面预览"/></span><small>卡片封面</small></span><span className="ca-crop-preview-item"><span className="ca-avatar ca-crop-preview"><CroppedImage binding={dialogImage} alt="头像裁切预览"/></span><small>方形头像</small></span></span><button onClick={() => void run('正在查询使用位置…', async () => { const rows = await api<any[]>('/media/' + dialogImage.media_asset_id + '/usage'); setImageId(null); setModal({ type: 'usage', rows }); })}>查看库内使用位置</button></details>
          <p className="ca-muted">修改在点击详情栏下方“保存”后生效。</p>
        </div>
      </div>
    </div>}
    {dropJob && <div className="ca-modal-backdrop" onKeyDown={e => { if (e.key === 'Escape') closeDropJob(); }}><div className="ca-modal ca-drop-dialog" role="dialog" aria-modal="true" aria-label={dropJob.mode === 'create' ? '拖入图片新建' + labels[dropJob.kind] : '添加参考图'}>
      <header><h2>{dropJob.mode === 'create' ? `用 ${dropJob.items.length} 张图片新建${labels[dropJob.kind]}` : `添加到“${dropJob.asset?.name}”`}</h2><button aria-label="关闭" disabled={dropJob.running} autoFocus onClick={closeDropJob}><X size={18}/></button></header>
      <div className="ca-modal-scroll"><div className="ca-modal-content">
        {dropJob.mode === 'create' && <label className="ca-field ca-drop-kind"><span>类别</span><select aria-label="新建类别" value={dropJob.kind} disabled={dropJob.running || dropJob.items.some(i => i.state !== 'waiting') || publicScope} onChange={e => { const v = e.target.value as Kind; setDropJob(j => j && { ...j, kind: v, items: j.items.map(i => { const preset = imageNamePreset(i.file.name, v); return { ...i, ...(!i.nameEdited ? { name: preset.name } : {}), ...(!i.lookEdited ? { lookName: preset.lookName } : {}) }; }) }); }}>{(Object.keys(labels) as Kind[]).map(k => <option key={k} value={k}>{labels[k]}</option>)}</select></label>}
        {dropJob.mode === 'attach' && dropJob.kind === 'character' && (dropJob.asset?.looks.length ? <label className="ca-field ca-drop-kind"><span>放进造型</span><select aria-label="放进造型" value={dropJob.lookId ?? ''} disabled={dropJob.running || dropJob.items.some(i => i.state !== 'waiting')} onChange={e => { const v = e.target.value; setDropJob(j => j && { ...j, lookId: v }); }}>{dropJob.asset.looks.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label> : <p className="ca-alert">这个人物还没有造型。请先在详情里新增造型，再添加图片。</p>)}
        <p className="ca-muted">{dropJob.mode === 'create' ? '每张图片建立一个资料；人物按“人物_造型”预填，其余名称仅作建议，可在下方修改。拖到已有资料时以落点为准。图片复制后立即保存关联；已有代表图保持不变。' : '图片会复制到项目的 picture 文件夹并立即保存到这份资料；还没有代表图时设为代表图。'}</p>
        <ul className="ca-drop-list">{dropJob.items.map(i => <li key={i.key} className={'is-' + i.state}>
          {dropJob.items.length > 1 && <input type="checkbox" aria-label={'包含 ' + i.file.name} checked={i.include} disabled={dropJob.running || i.state !== 'waiting'} onChange={e => { const v = e.target.checked; patchItem(i.key, { include: v }); }}/>}
          <span className="ca-drop-thumb"><ReferencePreview src={i.preview} alt={i.file.name}/></span>
          <span className="ca-drop-main">{dropJob.mode === 'create' ? <input aria-label={'名称：' + i.file.name} value={i.name} maxLength={120} disabled={dropJob.running || !i.include || !(i.state === 'waiting' || (i.state === 'failed' || i.state === 'unknown') && i.stage === 'create' && !i.assetId)} onChange={e => { const v = e.target.value; patchItem(i.key, { name: v, nameEdited: true }); }}/> : <strong>{i.file.name}</strong>}
            {dropJob.mode === 'create' && dropJob.kind === 'character' && <input aria-label={'造型：' + i.file.name} title="造型名称" placeholder="造型名称" value={i.lookName} maxLength={120} disabled={dropJob.running || !i.include || !(i.state === 'waiting' || (i.state === 'failed' || i.state === 'unknown') && i.stage === 'create' && !i.assetId)} onChange={e => patchItem(i.key, { lookName: e.target.value, lookEdited: true })}/>}
            <small>{i.file.name} · {(i.file.size / 1024 / 1024).toFixed(2)} MB{dropJob.mode === 'create' && dropJob.kind === 'character' ? ` · 人物：${i.name || '请填写'} / 造型：${i.lookName || '请填写'}` : ''}</small>
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
    {seasonOpen && <SeasonSettings key={seasonOpen.id + ':' + seasonOpen.source.projectId} api={api} base={scopePath('season', seasonOpen.id)} source={seasonOpen.source} seasonName={seasonOpen.name} seriesName={seasonOpen.seriesName} onClose={() => setSeasonOpen(null)} onScopeChanged={() => { const opened = seasonOpen; setSeasonOpen(cur => cur === opened ? null : cur); void fetchContext(); setNotice('这一集的所属剧或季刚变了，已重新读取；请重新打开本季设定'); }} onChanged={() => { void loadList(); const d = draftRef.current; if (d) void refreshDetail(d.id); }}/>}
    {mergeOpen && mergeSeries && <MergeDialog key={mergeOpen.group.group_id} api={request} seriesId={mergeSeries} group={mergeOpen.group} initialPrimary={mergeOpen.primary} contextToken={merges.data?.context_token} reloadGroups={merges.reload} onClose={() => setMergeOpen(null)} onMerged={(r, g, n) => void afterMerge(r, g, n)}/>}
    {mergeUndo && mergeSeries && <UndoMergeDialog api={request} seriesId={mergeSeries} mergeId={mergeUndo.mergeId} name={mergeUndo.name} contextToken={merges.data?.context_token} reloadToken={async () => (await merges.reload())?.context_token} onClose={() => setMergeUndo(null)} onUndone={() => afterUndo(mergeUndo.name)}/>}
    {impactState && <ImpactPreview title={impactState.kind === 'archive' ? '归档' + impactState.label : '把' + impactState.label + '提升到全剧'} confirmLabel={impactState.kind === 'archive' ? '确认归档' : '确认提升'}
      intro={impactState.kind === 'archive' ? <>归档后，下面这些季和集里的显示会按预览回退；这些层上相关的单独设置会失效（记录留在操作历史里）。明确引用它的镜头需要先在分镜里处理。</> : <>提升后它变成整部剧共享：原来的造型、图片、版本和镜头引用都保持不变，只是归属从本集变成全剧，其他集也能看到它。</>}
      data={impactState.data} nameOf={impactNameOf} busy={!!busy} replacement={impactState.replacement}
      onReplacement={id => impactState.target && void previewArchive(impactState.target, impactState.label, id)} onConfirm={() => void confirmImpact()} onClose={() => setImpactState(null)}/>}
    {modal && <div className="ca-modal-backdrop"><div className={"ca-modal" + (modal.type === 'media' ? ' ca-media-modal' : '')} role="dialog" aria-modal="true" aria-label={modal.type === 'media' ? '选择素材库图片' : modal.type === 'copy' ? '复制人物' : modal.type === 'import' ? '选择来源人物' : modal.type === 'create' ? '新建资产' : modal.type === 'history' ? '来源与版本' : modal.type === 'append-image' ? '确认追加图片' : '资料记录'}><header><h2>{modal.type === 'media' ? '选择素材库图片' : modal.type === 'copy' ? '复制人物' : modal.type === 'import' ? '选择来源人物' : modal.type === 'create' ? '新建' + labels[kind] : modal.type === 'history' ? '来源与版本' : modal.type === 'append-image' ? '确认追加图片' : '资料记录'}</h2><button aria-label="关闭弹窗" disabled={!!busy} onClick={() => setModal(null)}><X size={18}/></button></header>
      {modal.type === 'media' && <div className="ca-media-toolbar"><label className="ca-media-search"><Search size={17}/><input aria-label="搜索图片素材" placeholder="按名称搜索素材库图片" value={mediaQ} onChange={e => { setMediaQ(e.target.value); setMediaPage(1); }}/></label><div className="ca-media-info" role="status">{mediaLoading ? '正在查找图片…' : <>共 {mediaTotal} 张图片<span>{modal.replace_id ? '点击图片，替换当前绑定' : '点击图片，绑定到当前资料'}</span></>}</div></div>}
      <div className="ca-modal-scroll" ref={modalScroll} tabIndex={0} aria-label={modal.type === 'media' ? '可滚动图片列表' : '可滚动弹窗内容'}><fieldset disabled={!!busy} className="ca-modal-content">{error && <div className="ca-alert" role="alert">{error}</div>}
      {modal.type === 'create' && <><Field label="新资产名称" value={modal.name} onChange={v => setModal({ ...modal, name: v, check: null })}/>
        {modal.check?.status !== 'inherit_shared' && modal.check?.related_characters && modal.check.related_characters.action !== 'none' && <p className="cm-create-ask" role="alert">{relatedText(modal.check.related_characters, modal.check.match?.name ?? modal.name)}</p>}
        {modal.check?.status === 'inherit_shared' && <p className="ca-inherit-ask" role="alert">全剧已经有「{modal.check.match?.name ?? modal.name}」。要在本集用全剧的这个人，还是新建另一个？继承后本集可以单独设置默认造型、默认图和评分。</p>}
        {modal.renameHint && !modal.check && <p className="ca-muted">同一部剧里不能有两个同名的{labels[kind]}，请换个名字再创建。</p>}
        {!!scopeBase && seriesView && <p className="ca-muted">在「全剧」新建：这个{labels[kind]}会在整部剧共享。如果某一集已有同名的，会提示冲突。</p>}</>}
      {modal.type === 'media' && <><div className="ca-media-picker">{mediaRows.map(m => <button disabled={!!busy || mediaLoading} key={m.id} onClick={() => modal.append ? void appendImagePick(m) : void run('正在校验图片…', async () => { const h = await api<any>('/media/' + m.id + '/inspect'); if (h.state !== 'available') throw Error(h.label); edit(a => { if (modal.replace_id) { const b = a.images.find(b => b.id === modal.replace_id)!; b.media_asset_id = m.id; b.accept_current = true; b.last_known_name = m.name; } else { const id = crypto.randomUUID(); a.images.push({ id, look_id: a.kind === 'character' ? lookId : null, media_asset_id: m.id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: false, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: m.name }); if (!representative) setDefault(a, id); } }); setModal(null); })}><span className="ca-media-thumb"><img loading="lazy" src={'/api/media/' + m.id + '/original'} alt=""/></span><span className="ca-media-name" title={m.name}>{m.name}</span></button>)}</div>{!mediaLoading && !mediaRows.length && <div className="ca-empty">{mediaQ ? '没有匹配的图片，试试其他名称。' : '暂无图片，请先在素材库添加图片目录。'}</div>}</>}
      {modal.type === 'import' && <><label className="ca-field"><span>来源项目</span><select aria-label="来源项目" value={modal.source_project} onChange={e => setModal({ ...modal, source_project: e.target.value, source_rows: [] })}>{scopes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button disabled={!!busy} onClick={() => void run('正在读取来源人物…', async () => { const r = await api<any>('/assets?' + new URLSearchParams({ project_id: modal.source_project, kind: 'character', page: String(modal.source_page ?? 1) })); setModal({ ...modal, source_rows: r.items, source_total: r.total }); })}>读取人物</button>{modal.source_rows.map((a: Asset) => <button className="ca-source-choice" key={a.id} onClick={() => void run('正在准备复制…', async () => { const p = await api<any>('/assets/' + a.id + '/copy-preview?project_id=' + scope); setModal({ type: 'copy', ...p, project_id: scope, name: a.name, base_info: a.base_info, performance_info: a.performance_info }); })}>{a.name} · V{a.revision}</button>)}{modal.source_total > 40 && <div className="ca-pagination"><button disabled={(modal.source_page ?? 1) === 1} onClick={() => setModal({ ...modal, source_page: (modal.source_page ?? 1) - 1, source_rows: [] })}>上一页</button><span>第 {modal.source_page ?? 1} 页，切换后点击读取人物</span><button disabled={(modal.source_page ?? 1) * 40 >= modal.source_total} onClick={() => setModal({ ...modal, source_page: (modal.source_page ?? 1) + 1, source_rows: [] })}>下一页</button></div>}</>}
      {modal.type === 'copy' && <><p>复制来源：{modal.source.name} · V{modal.source_revision}。将复制未归档造型、图片绑定、职责和默认设置，原图片文件复用。</p><label className="ca-field"><span>目标项目</span><select aria-label="目标项目" value={modal.project_id} disabled={!!modal.pending} onChange={e => setModal({ ...modal, project_id: e.target.value })}>{scopes.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label><Field label="复制后人物名称" value={modal.name} onChange={v => setModal({ ...modal, name: v })}/><Field label="复制后基础信息" long value={modal.base_info} onChange={v => setModal({ ...modal, base_info: v })}/><Field label="复制后性格与表演" long value={modal.performance_info} onChange={v => setModal({ ...modal, performance_info: v })}/><p>{modal.source.looks.filter((l: Look) => !l.archived_at).length} 套造型 · {modal.source.images.filter((b: Binding) => !b.archived_at).length} 张图片绑定</p>{modal.pending && <p role="alert">上次复制结果尚未确认，请先查询结果。不要再次创建另一份复制。</p>}</>}
      {modal.type === 'history' && draft && <div className="ca-form"><p>创建于 {date(draft.created_at)} · 当前 V{draft.revision}</p>{inheritedHere && <p className="ca-muted" role="note">这是全剧共享的资产：版本历史属于全剧，请切到「全剧」后在这里查看。</p>}{draft.source ? <div className="ca-source"><strong>复制来源：{draft.source.project_name} / {draft.source.asset_name}</strong><p>来源 V{draft.source.revision} · {date(draft.source.copied_at)}</p><small>当前副本独立编辑；共用的原图片文件仍受素材库可用性影响。</small></div> : <p className="ca-muted">在当前项目创建</p>}<code>{draft.id}</code><h3>数据版本</h3>{!versions.length && <p className="ca-muted">正在读取版本…</p>}{versions.map(v => <div className="ca-version" key={v.id ?? v.merge_id + ':' + v.kind}><strong>{v.version != null ? 'V' + v.version : v.kind === 'character_merge_undo' ? '撤销合并' : '合并'}</strong><span>{v.summary ?? (v.kind === 'character_merge' ? '合并同名人物' : v.kind === 'character_merge_undo' ? '撤销合并' : '')} · {date(v.created_at ?? v.at)}</span>{v.kind === 'character_merge' && v.can_undo && mergeSeries && <button onClick={() => { setModal(null); setMergeUndo({ mergeId: v.merge_id, name: draft.name }); }}>撤销这次合并…</button>}{v.version != null && <button onClick={() => void run('正在读取版本…', async () => { setModal({ type: 'version', data: await api(assetReadBase(draft.id) + '/assets/' + draft.id + '/versions/' + v.version) }); })}>查看</button>}</div>)}</div>}
      {modal.type === 'append-image' && draft && <div className="ca-form ca-append-image" role="group" aria-label="确认追加图片">
        {modal.previewUrl && <img className="ca-append-thumb" src={modal.previewUrl} alt=""/>}
        <p>图片「{modal.fileName}」会加到{assetCtx?.series ? '「' + assetCtx.series.name + '」' : ''}全剧「{draft.name}」{modal.lookId ? '的造型「' + (draft.looks.find(l => l.id === modal.lookId)?.name ?? '') + '」' : ''}，记下来源是本集。其他集也能看到这张图，但不会改它们的默认图。</p>
        {modal.preview.sets_series_default && <label className="ca-append-default"><input type="checkbox" checked={!!modal.allow} onChange={e => setModal({ ...modal, allow: e.target.checked })}/>这是{modal.lookId ? '这个造型' : '这个资产'}的第一张图，会成为<b>全剧默认图</b>。我已了解</label>}
      </div>}
      {modal.type === 'version' && <pre>{JSON.stringify(modal.data, null, 2)}</pre>}{modal.type === 'usage' && <>{modal.rows.map((r: any) => <p key={r.id}>{scopes.find(s => s.id === r.project_id)?.name} / {r.name}{r.archived_at ? '（归档）' : ''} · {r.look_id ? '造型图片' : '资产参考图'}</p>)}{!modal.rows.length && <p>尚无已保存的库内使用记录</p>}</>}
      {modal.type === 'compare' && <><div className="ca-compare"><section><h3>本地编辑</h3><pre>{JSON.stringify(draft, null, 2)}</pre></section><section><h3>数据库最新 V{modal.latest.revision}</h3><pre>{JSON.stringify(modal.latest, null, 2)}</pre></section></div><p>请核对资料。合并以当前本地内容为基础，采用最新版本号后仍需再次保存；再次发生更新时仍会阻止覆盖。</p><button onClick={() => { edit(a => { a.revision = modal.latest.revision; }); setConflict(null); setModal(null); setNotice('已保留本地内容，请完成核对后点击保存'); }}>保留本地内容，进入核对保存</button></>}
    </fieldset></div><footer>{modal.type === 'media' && <div className="ca-pagination ca-media-pagination"><span>第 {mediaPage} / {Math.max(1, Math.ceil(mediaTotal / 40))} 页</span><button disabled={!!busy || mediaLoading || mediaPage === 1} onClick={() => setMediaPage(v => v - 1)}>上一页</button><button disabled={!!busy || mediaLoading || mediaPage * 40 >= mediaTotal} onClick={() => setMediaPage(v => v + 1)}>下一页</button></div>}{modal.type === 'append-image' && <><button disabled={!!busy} onClick={() => setModal(null)}>取消</button><button className="ca-primary" disabled={!!busy || modal.preview.sets_series_default && !modal.allow} onClick={() => void appendHandlers.confirm(modal.preview.preview_token, modal.preview.sets_series_default && !!modal.allow).then(ok => { if (ok) setModal(null); }, () => {})}>确认追加</button></>}{modal.type === 'create' && !modal.check && <button className="ca-primary" disabled={!!busy || !modal.name.trim()} onClick={() => void submitCreate(modal.name.trim(), 'reject')}>创建并编辑</button>}{modal.type === 'create' && modal.check?.status !== 'inherit_shared' && modal.check?.related_characters && modal.check.related_characters.action !== 'none' && <><button disabled={!!busy} onClick={() => setModal({ ...modal, check: null, renameHint: true })}>换个名字</button>{modal.check.related_characters.action === 'merge' && <button className="ca-primary" disabled={!!busy} onClick={() => void mergeFromCreate(modal.check.related_characters)}>合并这几个「{modal.name}」…</button>}</>}{modal.type === 'create' && modal.check?.status === 'inherit_shared' && <><button disabled={!!busy} onClick={() => setModal({ ...modal, check: null, renameHint: true })}>新建另一个（改个名字）</button><button className="ca-primary" disabled={!!busy} onClick={() => void submitCreate(modal.name.trim(), 'reuse')}>继承全剧的「{modal.check.match?.name ?? modal.name}」</button></>}{modal.type === 'copy' && <>{modal.pending ? <button onClick={() => void run('正在查询复制结果…', async () => { const r = await api<any>('/copies/' + modal.request_id); if (r.completed) await afterCopy(r.asset, '人物已复制'); else setModal({ ...modal, pending: false }); })}>查询复制结果</button> : <button className="ca-primary" disabled={!!busy || !modal.name.trim()} onClick={() => void run('正在复制人物…', async () => { try { const a = await api<Asset>('/assets/' + modal.source.id + '/copy', { project_id: modal.project_id, name: modal.name, base_info: modal.base_info, performance_info: modal.performance_info, source_revision: modal.source_revision, request_id: modal.request_id }); await afterCopy(a, '已复制人物，副本可独立编辑'); } catch (e: any) { if (!/同名|已经更新|无效|归档/.test(e.message)) setModal({ ...modal, pending: true }); throw e; } })}><Copy size={15}/>确认复制</button>}</>}<button disabled={!!busy} onClick={() => setModal(null)}>关闭</button></footer></div></div>}
  </section>;
}
