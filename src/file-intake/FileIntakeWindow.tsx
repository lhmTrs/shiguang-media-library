import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {AlertCircle, CheckCircle2, RefreshCw, ShieldCheck} from 'lucide-react';
import {GlobalFeedback, notifyFeedback, useFeedbackToast} from '../global-feedback';
import {applyTheme, readTheme} from '../theme';
import type {ThemeId} from '../theme-list';
import {THEME_LIST} from '../theme-list';
import '../themes.css';
import {BatchDetails} from './BatchDetails';
import {intakeSession} from './session';
import {TargetEditor, initialDestination, submittedDestination, type DestinationDraft} from './TargetEditor';
import {barDefault, stem, suggestAll} from './routing.mjs';
import {CategoryPopover, FolderPopover, GroupHeader, Popover, PutPopover, RowName, Thumb, fileMeta, libraryTitle, type Group, type Row} from './SimpleIntake';
import {INTAKE_API, bytes, encoded, errorMessage, knownRefusal, sameTarget, type ConfirmInput, type Handoff, type ImageProposal, type IntakeBatch, type IntakeRequest, type MediaKind, type NamePreviewItem, type RoutingOptions} from './types';
import './file-intake.css';

type Draft = {destination: DestinationDraft | null; manual: boolean; fileName?: string};
type ProposalState = {state: 'loading' | 'ready' | 'error'; proposal?: ImageProposal; error?: string};
type Bridge = {postMessage: (message: string) => void};
type Handlers = {intake?: Bridge; intakeAppearance?: Bridge};
const handlers = (): Handlers | undefined => (window as Window & {webkit?: {messageHandlers?: Handlers}}).webkit?.messageHandlers;
const bridge = () => handlers()?.intake;
// 'accepted' means a durable receipt arrived; the shell closes a few seconds later.
// 'close' closes at once. Appearance goes on its own channel so receipts stay unambiguous.
const post = (message: 'accepted' | 'close') => {try {bridge()?.postMessage(message);} catch { /* Ordinary browsers have no native shell. */ }};
const CLOSE_AFTER_SECONDS = 3;
// The intake window only reads the shared theme; it must never write its own default back.
const applyLocal = (id: ThemeId) => (applyTheme as (id: ThemeId, options?: {syncIntake?: boolean}) => void)(id, {syncIntake: false});
const FINDER_NAMES: Record<string, string> = {Downloads: '下载', Desktop: '桌面', Documents: '文稿', Pictures: '图片', Movies: '影片', Music: '音乐'};
const folderLabel = (p: string) => {const name = p.split('/').slice(-2, -1)[0] || '访达'; return FINDER_NAMES[name] || name;};

function readAttempt(id: string): ConfirmInput | null {
  try {const v = JSON.parse(sessionStorage.getItem('shiguang.file-intake.' + id) || 'null'); return v && typeof v.requestId === 'string' && ['copy', 'move'].includes(v.mode) && Array.isArray(v.fileIds) && v.fileIds.every((f: unknown) => typeof f === 'string') && (v.version===2&&Array.isArray(v.targets)||typeof v.projectId==='string'&&typeof v.folderId==='string') ? v : null;} catch {return null;}
}
const proposalKey = (d: DestinationDraft) => [d.projectId, d.characterName, d.lookName].join('\u0000');
// Where a previewed standard name was computed for; a stale preview is never shown under a new destination.
const nameKey = (d: DestinationDraft) => [d.kind, d.scope, d.projectId, d.folderId, d.assetId, d.characterName, d.lookName].join('|');
const isCharacter = (d: DestinationDraft | null): d is DestinationDraft => !!d && d.kind === 'photo' && d.scope === 'project' && !d.assetKind;
const groupKey = (d: DestinationDraft | null, pending: boolean) => pending || !d ? 'decide'
  : d.scope === 'library' ? 'library:' + d.kind + ':' + (d.directory || '')
  : d.kind === 'video' ? 'video:' + d.projectId + ':' + (d.folderId || 'root')
  : d.assetKind ? 'asset:' + d.projectId : 'character:' + d.projectId;

/** Tell the native shell which appearance the page settled on, so its title area matches. */
function syncAppearance() {
  requestAnimationFrame(() => {
    const style = getComputedStyle(document.body), dark = getComputedStyle(document.documentElement).colorScheme.includes('dark');
    const bg = style.backgroundColor.match(/\d+/g)?.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
    try {handlers()?.intakeAppearance?.postMessage((dark ? 'dark' : 'light') + (bg ? ':#' + bg : ''));} catch { /* No native shell. */ }
  });
}

/** Standalone native/browser confirmation entry. It never boots the full App. */
export function FileIntakeWindow({handoffId}: {handoffId: string}) {
  const [api, setApi] = useState<IntakeRequest | null>(null), [handoff, setHandoff] = useState<Handoff | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [mode, setMode] = useState<'copy' | 'move'>('copy'), [standardNames, setStandardNames] = useState(false);
  const [options, setOptions] = useState<RoutingOptions | null>(null), [optionsError, setOptionsError] = useState(''), [optionsReload, setOptionsReload] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({}), [proposals, setProposals] = useState<Record<string, ProposalState>>({});
  const [names, setNames] = useState<Record<string, NamePreviewItem & {for?: string}>>({}), [namesError, setNamesError] = useState('');
  const [checked, setChecked] = useState<string[]>([]), [open, setOpen] = useState<Record<string, boolean>>({}), [popover, setPopover] = useState('');
  // Project bar (whole batch), the per-file panel's position and the just-moved file's short highlight.
  const [projectOverride, setProjectOverride] = useState(''), [panelAt, setPanelAt] = useState<{top: number; left: number; maxHeight: number} | null>(null), [flash, setFlash] = useState('');
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [unknown, setUnknown] = useState(false), [batch, setBatch] = useState<IntakeBatch | null>(null), [reload, setReload] = useState(0);
  const [receiptKind, setReceiptKind] = useState<'submitted' | 'existing' | 'other'>('existing'), [closeIn, setCloseIn] = useState(0);
  const alive = useRef(true), sending = useRef(false), initialized = useRef(''), attempt = useRef<ConfirmInput | null>(null), accepted = useRef('');
  useFeedbackToast(error, {source: '素材收纳'});
  useEffect(() => {applyLocal(readTheme()); syncAppearance(); alive.current = true; return () => {alive.current = false;};}, []);
  const native = !!bridge();
  const remember = (value: ConfirmInput | null) => {attempt.current = value; try {if (value) sessionStorage.setItem('shiguang.file-intake.' + handoffId, JSON.stringify(value)); else sessionStorage.removeItem('shiguang.file-intake.' + handoffId);} catch { /* Handoff binding remains authoritative if browser storage is unavailable. */ }};
  function accept(value: IntakeBatch) {
    if (!value?.id || !Array.isArray(value.items)) throw Error('收纳回执格式不符，请核对原请求');
    const submitted = attempt.current;
    if (submitted && !sameTarget(value, submitted)) {
      setBatch(value); setReceiptKind('other'); setUnknown(false);
      setError('该选择已由另一窗口接收。以下为原批次，本窗口请求未获匹配回执；没有重复提交。');
      return;
    }
    setReceiptKind(submitted ? 'submitted' : 'existing');
    setBatch(value); setUnknown(false); remember(null);
    if (submitted && accepted.current !== value.id) {
      accepted.current = value.id; notifyFeedback({kind: 'success', source: '素材收纳', message: '收纳任务已接收，可在拾光顶栏“文件任务”查看真实进度。'});
      if (bridge()) {post('accepted'); setCloseIn(CLOSE_AFTER_SECONDS);}
    }
  }
  useEffect(() => {if (!flash) return; const t = setTimeout(() => setFlash(''), 1200); return () => clearTimeout(t);}, [flash]);
  // Countdown only mirrors the shell's own close timer so the summary stays readable.
  useEffect(() => {
    if (!closeIn) return;
    const timer = setTimeout(() => setCloseIn(n => Math.max(0, n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [closeIn]);
  useEffect(() => {
    let current = true; const controller = new AbortController(); setLoading(true); setError('');
    void (async () => {
      if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(handoffId)) throw Error('收纳确认编号无效，请从访达重新打开本次选择');
      const request = await intakeSession(controller.signal), value = await request<Handoff>(INTAKE_API + '/handoffs/' + encoded(handoffId), undefined, undefined, {signal: controller.signal});
      if (!current) return;
      if (value.id !== handoffId) throw Error('收纳选择身份不符，请核对原窗口');
      setApi(() => request); setHandoff(value);
      const theme = THEME_LIST.find(t => t.id === value.themeId); if (theme) {applyLocal(theme.id); syncAppearance();}
      const saved = readAttempt(handoffId); attempt.current = saved;
      // Freeze the original attempt before awaiting a possibly lost batch read.
      setUnknown(!!saved || !!value.batchId);
      if (initialized.current !== handoffId) {
        initialized.current = handoffId; setSelected(saved?.fileIds || value.files.map(f => f.id));
        const prefs = value.routingPreferences;
        setMode(saved?.mode || prefs?.mode || 'copy');
        setStandardNames(saved?.version === 2 ? !!saved.standardNames : !!prefs?.standardNames);
        if (saved) setDrafts(Object.fromEntries(value.files.map(f => {
          const d = saved.version === 2 ? saved.targets.find(t => t.fileId === f.id)?.destination || null : {kind: 'video' as const, scope: 'project' as const, projectId: saved.projectId, folderId: saved.folderId};
          return [f.id, {destination: d, manual: true, fileName: d?.fileName}];
        })));
      }
      if (value.batchId) {const receipt = await request<IntakeBatch>(INTAKE_API + '/batches/' + encoded(value.batchId), undefined, undefined, {signal: controller.signal}); if (current) accept(receipt);}
      else if (saved) {setUnknown(true); setError('原提交结果尚未确认。请核对原请求，不会再次发送。');}
    })().catch(e => {if (current && !controller.signal.aborted) setError(errorMessage(e));}).finally(() => {if (current) setLoading(false);});
    return () => {current = false; controller.abort();};
  }, [handoffId, reload]);
  useEffect(() => {
    if(!api||handoff?.preparation!=='checking'||batch)return;
    let current=true,timer:ReturnType<typeof setTimeout>;const controller=new AbortController();
    const tick=async()=>{
      try {
        const value=await api<Handoff>(INTAKE_API+'/handoffs/'+encoded(handoffId),undefined,undefined,{signal:controller.signal});
        if(!current)return;
        if(value.id!==handoffId)throw Error('返回了其他收纳选择，请重新打开原窗口');
        setHandoff(value);
        if(value.preparation==='checking')timer=setTimeout(tick,1000);
      }catch(e){if(current&&!controller.signal.aborted){setError(errorMessage(e));timer=setTimeout(tick,2000);}}
    };
    timer=setTimeout(tick,1000);
    return()=>{current=false;clearTimeout(timer);controller.abort();};
  }, [api,handoff?.preparation,handoffId,batch?.id]);
  // Routing options are read-only; a failure leaves per-file editing available.
  useEffect(() => {
    if (!api || !handoff || batch) return;
    const controller = new AbortController(); let current = true; setOptionsError('');
    api<RoutingOptions>(INTAKE_API + '/routing-options', undefined, undefined, {signal: controller.signal})
      .then(v => {if (current) setOptions(v && Array.isArray(v.projects) ? v : {projects: [], photoCategories: []});})
      .catch(e => {if (current && !controller.signal.aborted && (e as {status?: number}).status !== 404 && !(e instanceof SyntaxError)) setOptionsError(errorMessage(e));}); // Older service without this route: per-file editing still works
    return () => {current = false; controller.abort();};
  }, [api, !!handoff, optionsReload, !!batch]);

  const locked = loading || busy || unknown || !!batch || !!attempt.current || !!handoff?.batchId;
  const files = handoff?.files.filter(f => selected.includes(f.id)) || [], removed = handoff?.files.filter(f => !selected.includes(f.id)) || [];
  const prefs = handoff?.routingPreferences;
  // Last general category per kind: new routing preferences first, older per-kind presets as fallback.
  const libraryDir = (kind: MediaKind) => prefs?.lastLibraryDirectory?.[kind] ?? (handoff?.preferences?.[kind]?.scope === 'library' ? handoff.preferences[kind]!.directory || '' : '');
  const named = useMemo(() => files.map(f => drafts[f.id]?.fileName ? {...f, name: drafts[f.id].fileName!} : f), [files.map(f => f.id + (drafts[f.id]?.fileName || '') + (f.durationSec ?? '')).join('|')]);
  const suggestions = useMemo(() => options ? suggestAll(named, options, prefs, projectOverride || undefined) : {}, [named, options, prefs, projectOverride]);
  // Shown value == effective value: one shared project, or 「各自沿用上次」 when photo and video history differ.
  const bar = options && !projectOverride ? barDefault(named, options, suggestions, prefs) : null;
  const barProject = !options ? '' : projectOverride || bar?.projectId || '';
  const barMixed = !!bar?.mixed;
  const rows: Row[] = files.map((file, i) => {
    const draft = drafts[file.id], s = suggestions[file.id];
    const fallback = !options ? initialDestination(file, handoff?.preferences || {}) : null;
    const destination = draft?.manual ? draft.destination : s ? s.destination : fallback;
    const decision = draft?.manual ? undefined : s?.decision;
    const p = isCharacter(destination) && destination.projectId && destination.characterName && destination.lookName ? proposals[proposalKey(destination)] : undefined;
    const needsProposal = isCharacter(destination) && !decision;
    const ready = !!destination && !decision && (!needsProposal || p?.state === 'ready') && (destination.kind !== 'video' || destination.scope !== 'project' || !!destination.projectId);
    const reason = draft?.manual ? '手动设置' : s?.reason || (fallback ? '沿用上次的选择' : '');
    return {file, name: named[i].name, destination: destination ? {...destination, ...(draft?.fileName ? {fileName: draft.fileName} : {}), ...(p?.proposal ? {imageProposal: p.proposal} : {})} : null,
      reason, hint: s?.hint, manual: !!draft?.manual, decision, alternative: decision ? s?.alternative : undefined, ready, checking: needsProposal && p?.state === 'loading' ? '正在核对人物和造型…' : undefined,
      problem: needsProposal && p?.state === 'error' ? p.error : !destination && !decision ? '请选择去处' : undefined, newName: destination && names[file.id]?.for === nameKey(destination) ? names[file.id]!.proposedFileName ?? null : null};
  });
  // Character targets are checked against the project before confirmation. Each key is
  // fetched once; a late answer only fills its own key, so it cannot overwrite a newer choice.
  const requested = useRef(new Set<string>());
  const wanted = [...new Set(rows.filter(r => isCharacter(r.destination) && !r.decision && r.destination!.characterName && r.destination!.lookName).map(r => proposalKey(r.destination!)))];
  useEffect(() => {
    if (!api || locked) return;
    for (const key of wanted) {
      if (requested.current.has(key)) continue;
      requested.current.add(key); setProposals(old => ({...old, [key]: {state: 'loading'}}));
      const [projectId, name, look] = key.split('\u0000');
      api<{destination: ImageProposal}>(INTAKE_API + '/image-proposal?projectId=' + encoded(projectId) + '&name=' + encoded(name) + '&lookName=' + encoded(look))
        .then(v => {if (alive.current) setProposals(old => ({...old, [key]: {state: 'ready', proposal: v.destination}}));})
        .catch(e => {requested.current.delete(key); if (alive.current) setProposals(old => ({...old, [key]: {state: 'error', error: errorMessage(e)}}));});
    }
  }, [api, locked, wanted.join('|')]);
  // Standard names are previewed read-only; the server allocates the real numbers on confirm.
  const renameable = rows.filter(r => r.destination && r.destination.scope === 'project' && !drafts[r.file.id]?.fileName);
  const previewBody = standardNames && !locked ? JSON.stringify({targets: rows.filter(r => r.ready && r.destination!.scope === 'project').map(r => ({fileId: r.file.id, destination: submittedDestination(r.destination!), nameMode: drafts[r.file.id]?.fileName ? 'keep' : 'standard'}))}) : '';
  useEffect(() => {
    if (!api || !previewBody) {setNames({}); setNamesError(''); return;}
    const controller = new AbortController(); let current = true;
    const keys = Object.fromEntries(rows.filter(r => r.destination).map(r => [r.file.id, nameKey(r.destination!)]));
    const timer = setTimeout(() => {
      api<{items: NamePreviewItem[]}>(INTAKE_API + '/handoffs/' + encoded(handoffId) + '/name-preview', JSON.parse(previewBody), undefined, {signal: controller.signal})
        .then(v => {if (current) {setNames(Object.fromEntries((v.items || []).map(i => [i.fileId, {...i, for: keys[i.fileId]}]))); setNamesError('');}})
        .catch(e => {if (current && !controller.signal.aborted) {setNames({}); setNamesError(errorMessage(e));}});
    }, 250);
    return () => {current = false; clearTimeout(timer); controller.abort();};
  }, [api, previewBody, handoffId]);

  const setDestination = (ids: string[], destination: DestinationDraft | null) => setDrafts(old => ({...old, ...Object.fromEntries(ids.map(id => [id, {...old[id], destination, manual: true}]))}));
  const rename = (id: string, fileName: string) => setDrafts(old => ({...old, [id]: {...old[id], destination: old[id]?.destination ?? null, manual: !!old[id]?.manual, fileName}}));
  const remove = (id: string) => {setSelected(old => old.filter(x => x !== id)); setChecked(old => old.filter(x => x !== id));};
  const pending = rows.filter(r => !r.ready).length;
  const checking = handoff?.preparation === 'checking', prepFailed = handoff?.preparation === 'failed';
  const canConfirm = !loading && !busy && !checking && !prepFailed && !!api && files.length > 0 && !pending && !(mode === 'move' && !handoff?.canTrash);

  async function reconcile() {
    if (!api || sending.current) return; sending.current = true; setBusy(true); setError('');
    try {
      const value = await api<Handoff>(INTAKE_API + '/handoffs/' + encoded(handoffId));
      if (value.id !== handoffId) throw Error('返回了其他收纳选择，原请求保留');
      if (value.batchId) {const receipt = await api<IntakeBatch>(INTAKE_API + '/batches/' + encoded(value.batchId)); if (alive.current) accept(receipt);}
      else if (alive.current) {setUnknown(true); setError('尚未取得权威批次回执，原请求仍待核对；没有重新提交。');}
    } catch (e) {if (alive.current) {setUnknown(true); setError(errorMessage(e));}}
    finally {sending.current = false; if (alive.current) setBusy(false);}
  }
  async function confirm() {
    if (!api || !handoff || handoff.preparation!=='ready'||sending.current || attempt.current || unknown || handoff.batchId || batch || !canConfirm) return;
    const input: ConfirmInput = {version: 2, requestId: crypto.randomUUID(), mode, fileIds: rows.map(r => r.file.id), standardNames,
      targets: rows.map(r => ({fileId: r.file.id, destination: submittedDestination(r.destination!), ...(standardNames && r.destination!.scope === 'project' && !drafts[r.file.id]?.fileName ? {nameMode: 'standard' as const} : {})}))};
    sending.current = true; remember(input); setBusy(true); setError('');
    try {const value = await api<IntakeBatch>(INTAKE_API + '/handoffs/' + encoded(handoffId) + '/confirm', input); if (alive.current) accept(value);}
    catch (e) {if (alive.current) {if (knownRefusal(e, input.requestId)) remember(null); else setUnknown(true); setError(errorMessage(e) + (knownRefusal(e, input.requestId) ? '。选择已保留。' : '。原结果未确认，请只读核对，不会自动重发。'));}}
    finally {sending.current = false; if (alive.current) setBusy(false);}
  }

  // Groups: what needs a decision first, then project targets, then the general library.
  const projectName = (id?: string) => options?.projects.find(p => p.id === id)?.name || handoff?.projects.find(p => p.id === id)?.name || '项目';
  const folderName = (pid?: string, fid?: string) => !fid || fid === 'root' ? '项目根目录' : options?.projects.find(p => p.id === pid)?.videoFolders.find(f => f.id === fid)?.relativePath || '项目文件夹';
  const destLabel = (d: DestinationDraft) => d.scope === 'library' ? libraryTitle(d.kind, d.directory || '')
    : d.kind === 'video' ? projectName(d.projectId) + ' › ' + folderName(d.projectId, d.folderId)
    : d.assetKind ? projectName(d.projectId) + ' › ' + (options?.projects.find(p => p.id === d.projectId)?.assets.find(a => a.id === d.assetId)?.name || (d.assetKind === 'scene' ? '场景' : '道具'))
    : projectName(d.projectId) + ' › ' + d.characterName + ' › ' + d.lookName;
  const groups: Group[] = [];
  for (const r of rows) {
    const key = groupKey(r.destination, !!r.decision); let g = groups.find(x => x.key === key);
    if (!g) {
      const d = r.destination;
      g = key === 'decide' ? {key, title: '需要你决定', detail: '', tone: 'decide', rows: [], photos: false}
        : key.startsWith('video:') ? {key, title: '项目「' + projectName(d!.projectId) + '」 › ' + folderName(d!.projectId, d!.folderId), detail: r.reason, tone: 'video', rows: [], photos: false}
        : key.startsWith('character:') ? {key, title: '项目「' + projectName(d!.projectId) + '」 · 人物照片', detail: '', tone: 'project', rows: [], photos: true}
        : key.startsWith('asset:') ? {key, title: '项目「' + projectName(d!.projectId) + '」 · 场景和道具', detail: '', tone: 'project', rows: [], photos: true}
        : {key, title: libraryTitle(d!.kind, d!.directory || ''), detail: d!.kind === 'photo' && !d!.directory ? '名字认不出，将进入摄影照片' : '', tone: d!.kind === 'music' || d!.kind === 'sfx' ? 'audio' : 'library', rows: [], photos: d!.kind === 'photo'};
      groups.push(g);
    }
    g.rows.push(r);
  }
  const order = (g: Group) => g.key === 'decide' ? 0 : g.photos && g.key.startsWith('library:photo:') && !g.key.endsWith(':') ? 3 : g.photos ? g.key.startsWith('library') ? 2 : 1 : g.tone === 'video' ? 4 : 5;
  groups.sort((a, b) => order(a) - order(b));
  const crowded = rows.length > 6 && groups.length > 2;
  const isOpen = (g: Group) => open[g.key] ?? (!crowded || g.key === 'decide' || g.key === 'library:photo:');
  const lastPhotoProject = rows.find(r => r.destination?.kind === 'photo' && r.destination.scope === 'project')?.destination?.projectId || prefs?.lastProjectId?.photo || undefined;
  // Character photos already named 人物_造型 keep their name, so the switch only shows when it changes something.
  const willRename = rows.some(r => r.destination?.scope === 'project' && !(isCharacter(r.destination) && stem(r.name) === r.destination.characterName + '_' + r.destination.lookName));
  const decided = rows.length - pending;

  // One floating panel for the whole window: a row that changes group must not remount it.
  // It opens under the clicked file; the rest of the window dims; 完成 shows where the file went.
  const openPanel = (id: string, from: HTMLElement) => {
    if (popover === 'edit:' + id) {setPopover(''); return;}
    // Prefer just below the file; stay clear of the footer so 收纳 / 核对 remain reachable
    // (the panel scrolls inside when short of room).
    const footer = document.querySelector('.fi-foot')?.getBoundingClientRect().top ?? window.innerHeight;
    const r = from.getBoundingClientRect(), width = 352, top = Math.max(60, Math.min(r.bottom + 8, footer - 380));
    setPanelAt({top, left: Math.max(12, Math.min(r.left + 16, window.innerWidth - width - 12)), maxHeight: Math.max(220, footer - top - 8)});
    setPopover('edit:' + id);
  };
  // 完成: open the group the file now lives in and bring it into view, so the highlight is seen.
  const closePanel = (moved?: string) => {
    setPopover('');
    if (!moved) return;
    const r = rows.find(x => x.file.id === moved); if (r) setOpen(o => ({...o, [groupKey(r.destination, !!r.decision)]: true}));
    setFlash(moved);
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-file-id="' + CSS.escape(moved) + '"]')?.scrollIntoView({block: 'nearest', behavior: 'smooth'}));
  };
  const resultLine = (r: Row) => !r.destination ? '' : r.decision ? r.reason
    : isCharacter(r.destination) && r.destination.imageProposal ? (r.destination.imageProposal.newCharacter ? '将在「' + projectName(r.destination.projectId) + '」新建人物「' + r.destination.characterName + '」' : '放到「' + r.destination.characterName + '」') + (r.destination.imageProposal.newLook ? '，新建造型「' + r.destination.lookName + '」' : ' · ' + r.destination.lookName)
    : '收到「' + destLabel(r.destination) + '」';
  const editor = (r: Row) => api && handoff && <Popover label={'收纳设置 ' + r.file.name} align="fixed" style={panelAt || undefined} onClose={() => closePanel()}>
    <div className="fi-panel-head"><Thumb file={r.file} handoffId={handoffId} ready={!checking && !prepFailed} size="small"/>
      <div><strong title={r.name}>{r.name}</strong><small>{fileMeta(r)} · 来自「{folderLabel(r.file.path)}」</small></div>
      <button className="fi-icon-button" aria-label="关闭" onClick={() => closePanel()}>×</button></div>
    <div className="fi-panel-body"><TargetEditor file={r.file} handoffId={handoffId} api={api} projects={handoff.projects} value={r.destination} locked={locked} previewReady={false} showPreview={false}
      onChange={(v, manual = true) => {if (!manual && !drafts[r.file.id]?.manual) return; // Picking music/sfx sends a bare {kind, scope, directory:''}. The first explicit pick starts from that
      // kind's last category (as before); later switches start at 待确认, and the same kind keeps its category.
      const pickedKind = (v.kind === 'music' || v.kind === 'sfx') && v.scope === 'library' && !v.directory && Object.keys(v).length === 3;
      const next = !pickedKind ? v : {...v, directory: r.destination?.kind === v.kind ? r.destination.directory || '' : drafts[r.file.id]?.manual ? '' : libraryDir(v.kind)}; setDrafts(old => ({...old, [r.file.id]: {...old[r.file.id], destination: next, manual: true, fileName: v.fileName ?? old[r.file.id]?.fileName}}));}} onReady={() => undefined}/>
      {!r.decision && !isCharacter(r.destination) && resultLine(r) && <p className="fi-pop-result" role="status">{resultLine(r)}</p>}</div>
    <div className="fi-panel-foot">
      <button className="fi-link-muted" disabled={locked || !drafts[r.file.id]?.manual} onClick={() => setDrafts(old => {const next = {...old}; delete next[r.file.id]; return next;})}>恢复自动分</button>
      <button className="fi-link-muted" disabled={locked} aria-label={'移除 ' + r.file.name} onClick={() => {remove(r.file.id); closePanel();}}>从这次移除</button>
      <span className="fi-grow"/>
      <button className="fi-primary" onClick={() => closePanel(r.file.id)}>完成</button>
    </div>
  </Popover>;
  // The file itself opens its settings: the row/tile main area is a real button.
  const openButton = (r: Row, children: ReactNode, className: string) => <button className={className} data-popover-trigger data-file-id={r.file.id}
    aria-label={(locked ? '查看 ' : '单独设置 ') + r.file.name} title="单独设置这个文件" onClick={e => openPanel(r.file.id, (e.currentTarget.closest('.fi-row, .fi-tile') as HTMLElement) || e.currentTarget)}>{children}</button>;
  const rowClass = (r: Row, base: string) => base + (popover === 'edit:' + r.file.id ? ' fi-active' : '') + (flash === r.file.id ? ' fi-flash' : '');
  const decisionControls = (r: Row) => r.decision === 'new-character'
    ? <span className="fi-choice" role="group" aria-label={'去向 ' + r.file.name}>
        <button disabled={locked} onClick={() => setDestination([r.file.id], r.destination)}>新建人物</button>
        {r.alternative ? <button disabled={locked} onClick={() => setDestination([r.file.id], {kind: 'photo', scope: 'library', directory: r.alternative!.directory})}>分类·{r.alternative.name}</button>
          : <button disabled={locked} onClick={() => setDestination([r.file.id], {kind: 'photo', scope: 'library', directory: libraryDir('photo')})}>摄影照片</button>}
      </span>
    : audioSwitch(r);
  const audioSwitch = (r: Row) => <span className="fi-choice" role="group" aria-label={'素材类型 ' + r.file.name}>{(['music', 'sfx'] as const).map(k => <button key={k} disabled={locked} aria-pressed={!r.decision && r.destination?.kind === k} onClick={() => setDestination([r.file.id], {kind: k, scope: 'library', directory: libraryDir(k)})}>{k === 'music' ? '音乐' : '音效'}</button>)}</span>;
  const subLine = (r: Row, text: string) => <small className={r.problem ? 'fi-error' : ''}>{r.problem || r.checking || text}{r.manual && !r.problem && !r.checking && text !== '手动设置' && <span className="fi-tag">手动设置</span>}</small>;

  function renderGroup(g: Group) {
    const opened = isOpen(g), ids = g.rows.map(r => r.file.id), sel = ids.filter(id => checked.includes(id)), targets = sel.length ? sel : ids;
    const first = g.rows[0].destination;
    const actions = <>
      {g.photos && sel.length > 0 && <span className="fi-selected">已选 {sel.length} 张</span>}
      {g.photos && options && <span className="fi-anchor"><button className="fi-link" data-popover-trigger disabled={locked} onClick={() => setPopover(p => p === 'put:' + g.key ? '' : 'put:' + g.key)}>放进项目…</button>
        {popover === 'put:' + g.key && <PutPopover options={options} count={targets.length} defaultProject={first?.projectId || barProject || lastPhotoProject} onClose={() => setPopover('')} onApply={d => {setDestination(targets, d); setChecked([]); setPopover('');}}/>}</span>}
      {g.photos && g.key.startsWith('library:') && options && <span className="fi-anchor"><button className="fi-link" data-popover-trigger disabled={locked} onClick={() => setPopover(p => p === 'cat:' + g.key ? '' : 'cat:' + g.key)}>改分类…</button>
        {popover === 'cat:' + g.key && <CategoryPopover categories={options.photoCategories} count={targets.length} onClose={() => setPopover('')} onApply={dir => {setDestination(targets, {kind: 'photo', scope: 'library', directory: dir}); setChecked([]); setPopover('');}}/>}</span>}
      {g.tone === 'video' && options && first && <span className="fi-anchor"><button className="fi-link" data-popover-trigger disabled={locked} onClick={() => setPopover(p => p === 'folder:' + g.key ? '' : 'folder:' + g.key)}>改文件夹…</button>
        {popover === 'folder:' + g.key && <FolderPopover options={options} projectId={first.projectId || ''} folderId={first.folderId || 'root'} count={ids.length} onClose={() => setPopover('')} onApply={(projectId, folderId) => {setDestination(ids, {kind: 'video', scope: 'project', projectId, folderId}); setPopover('');}}/>}</span>}
    </>;
    return <section key={g.key} className={'fi-group fi-group-' + g.tone} aria-label={g.title}>
      <GroupHeader group={g} open={opened} toggle={() => setOpen(o => ({...o, [g.key]: !opened}))}
        strip={g.photos ? <span className="fi-strip" aria-hidden="true">{g.rows.slice(0, 6).map(r => <Thumb key={r.file.id} file={r.file} handoffId={handoffId} ready={!checking && !prepFailed} size="small"/>)}</span>
          : <span className="fi-strip-text">{g.rows.length === 1 ? (g.rows[0].newName || g.rows[0].name) : g.rows.map(r => r.newName || r.name).join('、')}</span>}>{actions}</GroupHeader>
      {!opened ? null : g.photos ? <div className="fi-grid">{g.rows.map(r => <figure key={r.file.id} className={rowClass(r, 'fi-tile' + (checked.includes(r.file.id) ? ' fi-tile-on' : ''))}>
          <label className="fi-tile-check"><input type="checkbox" disabled={locked} aria-label={'选择 ' + r.file.name} checked={checked.includes(r.file.id)} onChange={e => setChecked(old => e.target.checked ? [...old, r.file.id] : old.filter(x => x !== r.file.id))}/></label>
          {openButton(r, <><Thumb file={r.file} handoffId={handoffId} ready={!checking && !prepFailed} size="small"/>
            <figcaption><RowName row={r} compact/>{subLine(r, g.key.startsWith('character') ? r.destination?.characterName + ' · ' + r.destination?.lookName : r.reason)}{r.hint && <small>{r.hint}</small>}</figcaption></>, 'fi-tile-open')}
        </figure>)}</div>
        : <ul className="fi-rows">{g.rows.map(r => <li key={r.file.id} className={rowClass(r, 'fi-row')}
            onClick={e => {if (!(e.target as HTMLElement).closest('button, input, select, label, a')) openPanel(r.file.id, e.currentTarget);}}>
          {openButton(r, <><Thumb file={r.file} handoffId={handoffId} ready={!checking && !prepFailed} size="small"/>
            <span className="fi-row-main"><RowName row={r}/>{subLine(r, g.key === 'decide' ? r.reason : fileMeta(r) + (g.tone === 'audio' ? ' · ' + r.reason : ''))}</span></>, 'fi-row-open')}
          {g.key === 'decide' ? decisionControls(r) : g.tone === 'audio' ? audioSwitch(r) : null}
        </li>)}</ul>}
    </section>;
  }

  const single = rows.length === 1 && rows[0];
  const status = checking ? <span className="fi-pill" role="status"><span className="fi-spinner"/>正在核验原文件</span>
    : prepFailed ? null : handoff && !batch ? <span className="fi-pill fi-pill-ok"><ShieldCheck size={13}/>已核验</span> : null;
  const summary = files.length ? (pending ? '已分好 ' + decided + ' 个 · 还差 ' + pending + ' 个' : '全部已分好') + ' · ' + bytes(files.reduce((s, f) => s + f.bytes, 0)) : '';
  const countLabel = (n: number) => {const kinds = new Set(files.map(f => f.mediaKind)); return kinds.size === 1 ? n + (files[0].mediaKind === 'photo' ? ' 张照片' : files[0].mediaKind === 'audio' ? ' 个音频' : ' 个视频') : n + ' 个文件';};

  return <main className={'fi-root fi-window fi-simple' + (native ? ' fi-native' : '')}><section className="fi-shell" aria-label="收纳素材到拾光" aria-busy={loading || busy}>
    <header className="fi-bar">
      <h1 className="fi-sr">收纳素材到拾光</h1>
      <div className="fi-bar-title"><strong>{batch ? receiptKind === 'submitted' ? '已交给后台收纳' : receiptKind === 'other' ? '另一窗口已接收此选择' : '查看既有任务' : files.length ? '收纳 ' + countLabel(files.length) : '收纳素材'}</strong>{!batch && <span className={pending ? 'fi-warn-text' : 'fi-muted'}>{summary}</span>}</div>
      {status}
    </header>

    {options && !batch && !locked && options.projects.length > 0 && files.some(f => f.mediaKind !== 'audio') && <div className="fi-projectbar">
      <label><span>项目</span><select aria-label="整批项目" title="选一个项目，名字里没写项目的文件都去这里；名字里写了项目的、单独设置过的不受影响" value={barProject} onChange={e => setProjectOverride(e.target.value)}>
        {!barProject && <option value="">{barMixed ? '各自沿用上次' : '选择项目'}</option>}{options.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {barMixed && <span className="fi-muted">照片和视频上次用的项目不同，选一个就统一</span>}
    </div>}
    <div className="fi-body">
      {loading && <p role="status" className="fi-muted">正在读取本次访达选择…</p>}
      {!loading && !handoff && <div className="fi-empty"><AlertCircle size={24}/><p>尚未读取到本次收纳选择。请先启动拾光，再重试读取。</p><button onClick={() => setReload(n => n + 1)}><RefreshCw size={14}/>启动拾光后重新读取</button></div>}
      {handoff?.batchId&&!batch&&!attempt.current&&<p className="fi-muted" role="status">正在核对既有收纳任务，原目标以任务回执为准；不会重新提交。</p>}
      {handoff && !batch && !(handoff.batchId&&!attempt.current) && <>
        {checking && <p className="fi-muted" role="status">正在后台核验原文件，可先选择项目和文件夹；完成后即可确认收纳。</p>}
        {prepFailed && <p className="fi-error" role="alert">{handoff.preparationError}</p>}
        {optionsError && !locked && <p className="fi-error" role="alert">没能读取项目和分类，自动分组暂不可用：{optionsError}<button onClick={() => setOptionsReload(n => n + 1)}><RefreshCw size={13}/>重新读取</button></p>}
        {!files.length && <p className="fi-muted">请至少保留一个文件。</p>}
        {single ? <div className="fi-single">
          <Thumb file={single.file} handoffId={handoffId} ready={!checking && !prepFailed} size="large"/>
          <div className="fi-single-name"><RowName row={single}/><small>{fileMeta(single)} · 来自「{folderLabel(single.file.path)}」</small></div>
          <div className={'fi-single-dest' + (single.decision || single.problem ? ' fi-single-warn' : '')}>
            {single.decision ? <><span>{single.reason}</span>{decisionControls(single)}</>
              : single.destination ? <><span>收到 <strong>{destLabel(single.destination)}</strong></span><small>{single.problem || single.checking || single.reason}</small>{single.hint && <small className="fi-single-hint">{single.hint}</small>}{single.file.mediaKind === 'audio' && audioSwitch(single)}</>
              : <span>{single.problem}</span>}
            <button className="fi-link" data-popover-trigger data-file-id={single.file.id} aria-label={(locked ? '查看 ' : '单独设置 ') + single.file.name} onClick={e => openPanel(single.file.id, e.currentTarget)}>{locked ? '查看…' : '单独设置…'}</button>
          </div>
          {single.file.mediaKind === 'photo' && options && <span className="fi-anchor"><button className="fi-link" data-popover-trigger disabled={locked} onClick={() => setPopover(p => p === 'put:single' ? '' : 'put:single')}>放进项目…</button>
            {popover === 'put:single' && <PutPopover options={options} count={1} defaultProject={single.destination?.projectId || barProject || lastPhotoProject} onClose={() => setPopover('')} onApply={d => {setDestination([single.file.id], d); setPopover('');}}/>}</span>}
        </div> : groups.map(renderGroup)}
        {removed.length > 0 && <p className="fi-removed-line">已移除 {removed.length} 个{removed.map(f => <button key={f.id} className="fi-link" disabled={locked} aria-label={'恢复 ' + f.name} onClick={() => setSelected(old => [...old, f.id])}>恢复 {f.name}</button>)}</p>}
        {namesError && standardNames && <p className="fi-muted">暂时算不出新名字；确认后仍会按规范命名。</p>}
        {popover.startsWith('edit:') && (() => {const r = rows.find(x => 'edit:' + x.file.id === popover); return r ? <div key={r.file.id}>{!locked && <div className="fi-scrim" aria-hidden="true"/>}{editor(r)}</div> : null;})()}
      </>}
      {batch && receiptKind === 'submitted' && <div className="fi-done">
        <CheckCircle2 size={40}/>
        <p className="fi-accepted" role="status">任务已接收，请在网页顶栏“文件任务”查看后续进度。</p>
        <p className="fi-muted">这不代表已经收完。复制、核验、登记都在后台进行，关掉窗口也不影响。遇到重名或内容相同的文件，会在「文件任务」里请你选择。</p>
        <BatchDetails batch={batch}/>
      </div>}
      {batch && receiptKind !== 'submitted' && <><p className={receiptKind === 'other' ? 'fi-warning-copy' : 'fi-muted'} role="status">{receiptKind === 'other' ? '此选择已由另一窗口接收，以下为原批次；本窗口未确认成功。' : '这是此选择的既有回执，没有新建任务。'}</p><BatchDetails batch={batch}/></>}
      {error && <p className="fi-error" role="alert">{error}</p>}
      {unknown && <p className="fi-muted">原请求编号：<code>{attempt.current?.requestId || '由本次访达选择核对'}</code></p>}
      {receiptKind === 'other' && attempt.current && <p className="fi-muted">本窗口原请求编号：<code>{attempt.current.requestId}</code></p>}
    </div>

    <footer className="fi-foot">
      {batch ? <>
        <span className="fi-muted fi-foot-note">{closeIn ? '窗口 ' + closeIn + ' 秒后自动关闭' : ''}</span>
        <a className="fi-button" href="/#/project-videos" target="_blank" rel="noopener noreferrer">打开拾光 · 文件任务</a>
        {native && <button className="fi-primary" onClick={() => post('close')}>关闭</button>}
      </> : <>
        <fieldset className="fi-seg fi-mode" disabled={locked}><legend className="fi-sr">原文件处理方式</legend>
          <label><input type="radio" name="intake-mode" checked={mode === 'copy'} onChange={() => setMode('copy')}/>复制</label>
          <label title={handoff?.canTrash ? '' : '当前系统不支持安全移入废纸篓'}><input type="radio" name="intake-mode" checked={mode === 'move'} disabled={!handoff?.canTrash} onChange={() => setMode('move')}/>移动</label>
        </fieldset>
        <div className="fi-foot-note">
          {willRename && <label className="fi-check-inline"><input type="checkbox" disabled={locked} checked={standardNames} onChange={e => setStandardNames(e.target.checked)}/>收纳时按规范改名</label>}
          <span className="fi-muted">{mode === 'move' ? '收纳成功后，原文件移入废纸篓（不会永久删除）' : '原文件留在原处'}{prefs && mode === prefs.mode ? '（沿用上次的选择）' : ''}</span>
        </div>
        {pending > 0 && !locked && <span className="fi-warn-text">还差 {pending} 个</span>}
        {unknown ? <button className="fi-primary" disabled={busy || !api} onClick={() => void reconcile()}>{busy ? '正在核对…' : '核对原提交结果'}</button>
          : <button className="fi-primary fi-confirm-button" disabled={!canConfirm} onClick={() => void confirm()}>{busy ? '正在提交，请勿重复点击…' : files.length === 1 ? '收纳' : '收纳 ' + countLabel(files.length)}</button>}
      </>}
    </footer>
  </section><GlobalFeedback/></main>;
}
