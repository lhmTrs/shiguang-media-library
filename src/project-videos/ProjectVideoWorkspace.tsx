import {notifyFeedback, useFeedbackToast} from '../global-feedback';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Check, ChevronDown, ChevronRight, CornerDownRight, Ellipsis, Film, Folder as FolderIcon, FolderOpen, FolderPlus, Layers, Play, RefreshCw, Search, Upload, X } from 'lucide-react';
import type {
  AdoptedShot, ImportRequest, ProjectVideo, ProjectVideoCollection, ProjectVideoWorkspaceProps,
  PromptInput, Receipt, ReferencePrompt, UpdateVideoRequest, UpgradePreview,
} from './types';
import './project-videos.css';
import {MediaViewer} from '../MediaViewer';
import {Modal, ModalActions} from './Modal';
import {FolderCards} from './FolderBrowser';
import {FolderOperations, type FolderAction} from './FolderOperations';
import {VIDEO_DRAG_TYPE, folderTarget, folderContains, folderTrail, readVideoDrag} from './folders';
import {rememberImportTarget} from '../import-presets.mjs';
import type {FolderView} from './types';

type MenuName = 'more' | 'dir' | 'detail';
type PromptDraft = { mode: PromptInput['mode']; id: string; title: string; text: string };
type EditDraft = { expectedRevision: number; title: string; notes: string; prompt: PromptDraft };
type Task = {
  kind: 'import' | 'upgrade' | 'relink'; requestId: string; queryId: string;
  receipt: Receipt | null; uploadAttempted: boolean; error: string;
  api: <T = any>(suffix: string, body?: unknown, method?: string) => Promise<T>;
  file?: File; folderId: string; folderName: string;
};
type Confirmation = { kind: 'remove'; video: ProjectVideo; adoptionStamp: string }
  | { kind: 'relink'; video: ProjectVideo; path: string } | null;
const noPrompt = (): PromptDraft => ({ mode: 'none', id: '', title: '', text: '' });
const promptInput = (p: PromptDraft): PromptInput => p.mode === 'new'
  ? { mode: 'new', title: p.title.trim() || undefined, text: p.text.trim() }
  : p.mode === 'existing' ? { mode: 'existing', id: p.id } : { mode: 'none' };
const promptValid = (p: PromptDraft, prompts: ReferencePrompt[]) => p.mode === 'none'
  || (p.mode === 'new' ? !!p.text.trim() : prompts.some(item => item.id === p.id));
const editFor = (v: ProjectVideo): EditDraft => ({
  expectedRevision: v.revision, title: v.name, notes: v.notes || '',
  prompt: { ...noPrompt(), mode: v.promptId ? 'existing' : 'none', id: v.promptId || '' },
});
const pending = (t: Task | null) => !!t && (!t.receipt || ['waiting', 'uploading', 'running'].includes(t.receipt.status));
const terminal = (r: Receipt | null) => !!r && ['ready', 'failed', 'cancelled'].includes(r.status);
const message = (error: unknown) => error instanceof Error ? error.message : String(error || '请求失败');
const receiptLabel: Record<Receipt['status'], string> = {
  waiting: '等待处理', uploading: '正在接收文件', duplicate: '目标文件夹有同名视频，等待选择',
  running: '后台处理中', ready: '处理已结束', failed: '处理失败', unknown: '结果待核对', cancelled: '已取消导入',
};
const statusLabel: Record<ProjectVideo['status'], string> = {
  available: '可预览', unsupported: '格式不支持预览', missing: '文件缺失', changed: '文件状态待核验', untrusted: '文件待核验', unchecked: '尚未核验，打开时检查',
};
const statusShort: Record<ProjectVideo['status'], string> = {
  available: '', unsupported: '格式不支持', missing: '文件缺失', changed: '待核验', untrusted: '待核验', unchecked: '未核验',
};
function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return '未知';
  if (value < 1024) return `${value} B`;
  const i = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i === 1 ? 0 : 2)} ${['B', 'KB', 'MB', 'GB'][i]}`;
}
function duration(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '时长待读取';
  const seconds = Math.floor(value / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function shotsLabel(shots: AdoptedShot[]) {
  return shots.length ? shots.map(shot => `镜 ${shot.number}`).join('、') : '尚未被分镜采用';
}


function PromptFields({ value, prompts, disabled, onChange }: {
  value: PromptDraft; prompts: ReferencePrompt[]; disabled: boolean; onChange: (next: PromptDraft) => void;
}) {
  const id = useId();
  const selected = prompts.find(p => p.id === value.id);
  return <fieldset className="pv-prompt-fields" disabled={disabled}>
    <legend>参考提示词</legend>
    <div className="pv-prompt-modes">
      {([{ mode: 'none', label: '无参考提示词' }, { mode: 'new', label: '粘贴新提示词' }, { mode: 'existing', label: '选择已存提示词' }] as const).map(item =>
        <label key={item.mode}><input type="radio" name={id} checked={value.mode === item.mode}
          onChange={() => onChange({ ...value, mode: item.mode })}/>{item.label}</label>)}
    </div>
    {value.mode === 'none' && <p className="pv-muted">可直接保存视频，稍后补充参考提示词。提示词关联与是否采用相互独立。</p>}
    {value.mode === 'new' && <>
      <label className="pv-field">提示词标题（可选）<input value={value.title} onChange={e => onChange({ ...value, title: e.target.value })}/></label>
      <label className="pv-field">提示词正文<textarea rows={7} value={value.text} required onChange={e => onChange({ ...value, text: e.target.value })} placeholder="粘贴用于生成该视频的完整提示词"/></label>
    </>}
    {value.mode === 'existing' && <>
      <label className="pv-field">本项目已存提示词<select aria-label="本项目已存提示词" value={value.id} onChange={e => onChange({ ...value, id: e.target.value })}>
        <option value="">请选择参考提示词</option>
        {value.id && !selected && <option value={value.id} disabled>原提示词已不可用，请重新选择</option>}
        {prompts.map(p => <option key={p.id} value={p.id}>{p.title || p.text.slice(0, 50) || '未命名提示词'}</option>)}
      </select></label>
      {!prompts.length && <p className="pv-muted">本项目暂无已存提示词，可以选择粘贴新提示词。</p>}
      {selected && <details className="pv-prompt-preview" open><summary>预览提示词 · {selected.title || '未命名'}</summary><pre>{selected.text}</pre></details>}
    </>}
  </fieldset>;
}

function Player({ name, mediaUrl, thumbnailUrl, available = true }: {
  name: string; mediaUrl: string; thumbnailUrl?: string | null; available?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return <div className="pv-player">
    {available && mediaUrl && !failed
      ? <video key={mediaUrl} src={mediaUrl} poster={thumbnailUrl || undefined} controls playsInline preload="metadata" aria-label={`预览：${name}`} onError={() => setFailed(true)}/>
      : <div className="pv-player-empty"><Film size={36}/><p>{failed ? '浏览器无法播放此文件，可在访达中打开查看。' : '此视频当前无法在页面中预览。'}</p></div>}
  </div>;
}

/** Sessions remain mounted so switching projects or hiding this page preserves drafts. */
export function ProjectVideoWorkspace(props: ProjectVideoWorkspaceProps) {
  const [sessions, setSessions] = useState<string[]>(() => props.active && props.projectId ? [props.projectId] : []);
  const [importOwner, setImportOwner] = useState('');
  const importOwnerRef = useRef('');
  const acquireImport = useCallback((id: string) => {
    if (importOwnerRef.current) return false;
    importOwnerRef.current = id; setImportOwner(id); return true;
  }, []);
  const releaseImport = useCallback((id: string) => {
    if (importOwnerRef.current === id) { importOwnerRef.current = ''; setImportOwner(''); }
  }, []);
  const currentId = props.projectId;
  useEffect(() => {
    if (props.active && props.projectId) setSessions(old => old.includes(props.projectId) ? old : [...old, props.projectId]);
  }, [props.active, props.projectId]);
  return <section className="pv-workspace" hidden={!props.active} aria-label="项目生成视频">
    <header className="pv-header">
      <div className="pv-title"><Film size={20}/><h1>生成视频</h1><span>项目视频库</span></div>
    </header>
    {importOwner && importOwner !== currentId && <div className="pv-notice" role="status">“{props.projects.find(p => p.id === importOwner)?.name || '原项目'}”有一笔导入待结束，浏览与切换不受影响。<button type="button" onClick={() => props.onProject(importOwner)}>返回原导入任务</button></div>}
    {!currentId && <div className="pv-empty"><Film size={38}/><h2>先选择一个项目</h2><p>在页面顶部的“当前项目”中选择。导入的视频固定归属于该项目。</p></div>}
    {sessions.map(id => <ProjectVideoSession key={id} {...props} projectId={id}
      active={props.active && id === currentId} importOwner={importOwner} acquireImport={acquireImport} releaseImport={releaseImport}/>) }
  </section>;
}

function ProjectVideoSession({ active, projectId, projects, request, onStoryboard, importOwner, acquireImport, releaseImport, focusVideo }: ProjectVideoWorkspaceProps & {
  importOwner: string; acquireImport: (id: string) => boolean; releaseImport: (id: string) => void;
}) {
  const [collection, setCollection] = useState<ProjectVideoCollection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useFeedbackToast(error, {source: '生成视频'});
  const [notice, setNotice] = useState('');
  useFeedbackToast(notice, {source: '生成视频', kind: 'auto'});
  const [folderId, setFolderId] = useState<FolderView>('all');
  const folderRef = useRef<FolderView>('all');
  const [folderAction, setFolderAction] = useState<FolderAction | null>(null);
  const [operationPending, setOperationPending] = useState(false);
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false);
  const [taskSending, setTaskSending] = useState(false);
  const taskSendingRef = useRef(false);
  const [sending, setSending] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const focusedRequest = useRef<number>();
  const [expandedId, setExpandedId] = useState('');
  const relinkButton = useRef<HTMLButtonElement>(null);
  const playbackPositions = useRef(new Map<string, {content: string; seconds: number}>());
  const playbackContent = useRef(new Map<string, string>());
  const positionKey = (video: ProjectVideo) => `shiguang.projectVideoPosition.v1:${projectId}:${video.id}`;
  const contentKey = (video: ProjectVideo) => JSON.stringify([video.bytes, video.durationMs, video.codec]);
  function forgetPosition(video: ProjectVideo) { playbackPositions.current.delete(video.id); try { localStorage.removeItem(positionKey(video)); } catch { /* Memory still works without browser storage. */ } }
  function initialPosition(video: ProjectVideo) {
    if (video.status === 'changed') return 0;
    let saved = playbackPositions.current.get(video.id);
    if (!saved) { try { saved = JSON.parse(localStorage.getItem(positionKey(video)) || 'null') || undefined; } catch { /* Ignore invalid optional cache. */ } }
    return saved?.content === contentKey(video) && Number.isFinite(saved.seconds) && saved.seconds >= 0 ? saved.seconds : 0;
  }
  function rememberPosition(video: ProjectVideo, seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0 || playbackContent.current.get(video.id) !== contentKey(video)) return;
    const saved = {content: contentKey(video), seconds}; playbackPositions.current.set(video.id, saved);
    try { localStorage.setItem(positionKey(video), JSON.stringify(saved)); } catch { /* Preserve position within the mounted session. */ }
  }
  const [edits, setEdits] = useState<Record<string, EditDraft>>({});
  const [view, setView] = useState<'videos' | 'prompts'>('videos');
  const [query, setQuery] = useState('');
  const [queryScope, setQueryScope] = useState<'all' | 'name' | 'prompt'>('all');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuName | ''>('');
  const sessionRef = useRef<HTMLDivElement>(null);
  const [adoptionFilter, setAdoptionFilter] = useState<'all' | 'candidate' | 'adopted'>('all');
  const [importOpen, setImportOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [importPrompt, setImportPrompt] = useState<PromptDraft>(noPrompt);
  const [importConfirm, setImportConfirm] = useState(false);
  const [candidateId, setCandidateId] = useState('');
  const [task, setTaskState] = useState<Task | null>(null);
  const taskRef = useRef<Task | null>(null);
  const [querying, setQuerying] = useState(false);
  const queryRef = useRef(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [upgrade, setUpgrade] = useState<UpgradePreview | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const requestRef = useRef(request); requestRef.current = request;
  const libraryId = useRef<string>();
  useEffect(() => {
    let current = true;
    void request<{instanceId: string}>('/session').then(value => {if (current) libraryId.current = value.instanceId;}).catch(() => {});
    return () => {current = false; libraryId.current = undefined;};
  }, [request]);
  const activeRef = useRef(active); activeRef.current = active;
  const generation = useRef(0);
  const listSerial = useRef(0);
  const sendingRef = useRef(false);
  const terminalSeen = useRef(new Set<string>());
  const prompts = collection?.prompts || [];
  const videos = collection?.videos || [];
  const projectName = collection?.project.name || projects.find(p => p.id === projectId)?.name || '当前项目';
  const readOnly = !!collection?.readOnly;
  const locked = !!sending || readOnly;
  const importUnavailable = !!importOwner && importOwner !== projectId;
  const unresolved = !!task && !terminal(task.receipt);
  const selected = videos.find(v => v.id === selectedId);
  const draft = selected ? edits[selected.id] || editFor(selected) : null;
  const importTask = task?.kind === 'import' ? task : null;
  const duplicate = importOpen && importTask?.receipt?.status === 'duplicate';
  const candidates = duplicate ? importTask?.receipt?.candidates || [] : [];
  const candidate = candidates.find(c => c.id === candidateId) || candidates[0];
  useEffect(() => setOverwriteConfirmed(false), [importTask?.requestId, importTask?.receipt?.adoptionStamp]);
  const isCurrent = (ticket: number) => activeRef.current && generation.current === ticket;
  const api = <T,>(suffix: string, body?: unknown, method?: string) => requestRef.current<T>(
    `/project-videos/projects/${encodeURIComponent(projectId)}${suffix}`, body, method,
  );
  const putTask = (next: Task | null) => {
    taskRef.current = next;
    setTaskState(next);
  };

  function frozenAPI() {
    const original = requestRef.current;
    const base = `/project-videos/projects/${encodeURIComponent(projectId)}`;
    return <T,>(suffix: string, body?: unknown, method?: string) => original<T>(base + suffix, body, method);
  }
  const folders = collection?.folders || [];
  // 显示用的位置一律是项目内的文件夹名路径（如“第一场 / 补拍”），不显示 folder.path 这类磁盘绝对路径。
  const folderLabel = (id: string) => id === 'root' ? '项目根目录' : folderTrail(folders, id).map(f => f.name).join(' / ');
  const folderName = folderId === 'all' || folderId === 'root' ? '项目根目录' : folderLabel(folderId) || '当前文件夹';
  const folderBlocked = (id: string) => !!taskRef.current && !terminal(taskRef.current.receipt) && taskRef.current.kind === 'import' && folderContains(folders, id, taskRef.current.folderId);
  function navigateFolder(id: FolderView) {
    // Re-clicking the current folder must not blank the list: the folder effect would not run again.
    if (id === folderRef.current) { void refresh(); return; }
    folderRef.current = id; listSerial.current += 1; setFolderId(id); setSelectedId(''); setExpandedId('');
    setCollection(old => old ? {...old, videos: [], breadcrumbs: [], currentFolderId: id} : old);
  }
  const warnedDrafts = useRef(new Set<string>());
  const priorEditing = useRef<{id: string; key: string; dirty: boolean} | null>(null);
  useEffect(() => {
    const prior = priorEditing.current;
    if (prior?.dirty && (!active || selectedId !== prior.id) && !warnedDrafts.current.has(prior.key)) {
      warnedDrafts.current.add(prior.key);
      notifyFeedback({source: '生成视频', kind: 'warning', message: '视频资料尚未保存，草稿已按视频保留。返回该视频可继续编辑。'});
    }
    priorEditing.current = active && selected && draft ? {id: selected.id, key: selected.id + JSON.stringify(draft), dirty: JSON.stringify(draft) !== JSON.stringify(editFor(selected))} : null;
  });

  async function refresh(selectId?: string) {
    if (!activeRef.current) return;
    const ticket = generation.current; const serial = ++listSerial.current; const targetFolder = folderRef.current;
    setLoading(true); setError('');
    try {
      const next = await api<ProjectVideoCollection>(`?folderId=${encodeURIComponent(targetFolder)}`);
      if (!isCurrent(ticket) || serial !== listSerial.current || folderRef.current !== targetFolder) return;
      if (next.project.id !== projectId || next.videos.some(v => v.projectId !== projectId)) throw Error('项目响应不匹配，已保留原页面。');
      for (const video of next.videos) {
        const content = video.status === 'changed' ? 'changed' : contentKey(video);
        const prior = playbackContent.current.get(video.id);
        if (video.status === 'changed' || prior && prior !== content) forgetPosition(video);
        playbackContent.current.set(video.id, content);
      }
      setCollection(next);
      setSelectedId(old => selectId && next.videos.some(v => v.id === selectId) ? selectId : next.videos.some(v => v.id === old) ? old : '');
    } catch (e) { if (isCurrent(ticket) && serial === listSerial.current) setError(message(e)); }
    finally { if (isCurrent(ticket) && serial === listSerial.current) setLoading(false); }
  }

  function receive(receipt: Receipt) {
    const current = taskRef.current;
    if (!current) return;
    if (receipt.id !== current.requestId || receipt.projectId && receipt.projectId !== projectId || receipt.folderId && current.kind === 'import' && receipt.folderId !== current.folderId) throw Error('任务回执与原项目或目录不匹配，请查询原请求。');
    putTask({ ...current, queryId: receipt.id, receipt, error: '' });
    if (receipt.status === 'unknown') setError(`${projectName}：${receipt.error || '原任务结果待核对，请返回原导入任务查询；不会自动重发。'}`);
    if (receipt.status === 'duplicate') {
      const key = `${receipt.id}:duplicate:${receipt.adoptionStamp || ''}`;
      if (!terminalSeen.current.has(key)) { terminalSeen.current.add(key); setNotice(`${projectName} / ${current.folderName} 有同名视频，请返回原导入任务选择处理方式；已接收的文件不会重传。`); }
    }
    if (!terminal(receipt)) return;
    if (current.kind === 'import') releaseImport(projectId);
    const key = `${receipt.id}:${receipt.status}`;
    if (terminalSeen.current.has(key)) return;
    terminalSeen.current.add(key);
    if (receipt.status === 'ready') {
      setNotice(current.kind === 'import' ? `已保存到 ${projectName} / ${receipt.folderName || current.folderName}：${receipt.finalName || receipt.fileName || current.file?.name || '视频'}。`
        : current.kind === 'relink' ? '重新定位任务已结束，请核对视频状态。' : receipt.results?.length ? '旧视频升级任务已结束，请核对逐项结果。' : '旧视频升级检查已完成，本项目无需复制旧视频。');
      void refresh(receipt.videoId);
    } else if (receipt.status === 'failed') setError(`${projectName}：${receipt.error || '任务失败，请核对原请求。'}`);
  }

  useEffect(() => {
    generation.current += 1;
    if (active) {
      setTaskState(taskRef.current);
      setLoading(false);
      void refresh();
      if (taskRef.current?.receipt && terminal(taskRef.current.receipt)) receive(taskRef.current.receipt);
    }
    return () => { generation.current += 1; listSerial.current += 1; };
    // request identity changes must not discard inputs or invalidate an in-flight operation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, projectId, folderId]);

  useEffect(() => {
    if (!active || !focusVideo || focusVideo.projectId !== projectId || focusedRequest.current === focusVideo.request) return;
    // A specific result may be in another folder. Browse all, preserving every
    // per-video edit draft, then select only the explicitly requested video.
    if (folderId !== 'all') {folderRef.current = 'all'; setFolderId('all'); return;}
    focusedRequest.current = focusVideo.request;
    void refresh(focusVideo.videoId);
  }, [active, projectId, folderId, focusVideo]);

  async function queryTask() {
    const current = taskRef.current;
    if (!current?.queryId || queryRef.current || taskSendingRef.current) return;
    queryRef.current = true; setQuerying(true);
    try {
      const receipt = await current.api<Receipt>(`/imports/${encodeURIComponent(current.queryId)}`);
      if (taskRef.current?.requestId !== current.requestId) return;
      if (current.error) setError('');
      receive(receipt);
      if (receipt.status === 'waiting' && !taskRef.current?.uploadAttempted) await uploadContent();
    } catch (e) { taskError(e); }
    finally { queryRef.current = false; setQuerying(false); }
  }

  useEffect(() => {
    if (!pending(task) || task?.error || taskSending || querying || !task?.queryId) return;
    const timer = window.setTimeout(() => { void queryTask(); }, 1600);
    return () => window.clearTimeout(timer);
  }, [task, taskSending, querying]);

  async function run(label: string, work: (ticket: number) => Promise<void>) {
    if (sendingRef.current || !activeRef.current) return;
    sendingRef.current = true; setSending(label); setError(''); setNotice('');
    const ticket = generation.current;
    try { await work(ticket); }
    catch (e) { if (isCurrent(ticket)) setError(message(e)); }
    finally { sendingRef.current = false; setSending(''); }
  }

  function acceptFiles(files: FileList | File[]) {
    if (locked || importUnavailable || taskRef.current && !terminal(taskRef.current.receipt)) return;
    if (files.length !== 1) { setError('一次只能选择一个视频文件。'); return; }
    const next = files[0];
    if (!next.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm|mkv|avi|mpeg|mpg|mts|m2ts)$/i.test(next.name)) {
      setError('请选择一个视频文件。'); return;
    }
    if (!next.size) { setError('不能导入空文件。'); return; }
    setOverwriteConfirmed(false); setCandidateId(''); putTask(null); setFile(next); setImportConfirm(false); setImportOpen(true); setError('');
  }

  async function uploadContent() {
    const current = taskRef.current;
    if (!current?.file || current.kind !== 'import' || current.uploadAttempted || current.receipt?.status !== 'waiting') return;
    putTask({ ...current, uploadAttempted: true, error: '' });
    const receipt = await current.api<Receipt>(`/imports/${encodeURIComponent(current.queryId)}/content`, current.file, 'PUT');
    if (taskRef.current?.requestId === current.requestId) receive(receipt);
  }

  function taskError(e: unknown) {
    const current = taskRef.current;
    const text = `结果尚未确认：${message(e)}。输入已保留，请查询原请求；不会自动重发。`;
    if (current) putTask({ ...current, error: text });
    setError(`${projectName}：${text}`);
  }

  async function startImport() {
    if (!file || taskRef.current || taskSendingRef.current || readOnly || !promptValid(importPrompt, prompts) || !acquireImport(projectId)) return;
    taskSendingRef.current = true; setTaskSending(true); setError('');
    const requestId = crypto.randomUUID();
    const target = folderTarget(folderRef.current);
    rememberImportTarget(libraryId.current, 'video', {projectId, folderId: target});
    const body: ImportRequest = { requestId, folderId: target, fileName: file.name, bytes: file.size,
      title: title.trim() || undefined, notes: notes.trim() || undefined, prompt: promptInput(importPrompt) };
    const original = {kind: 'import' as const, requestId, queryId: requestId, receipt: null, uploadAttempted: false, error: '', api: frozenAPI(), file, folderId: target, folderName};
    putTask(original);
    try { receive(await original.api<Receipt>('/imports', body, 'POST')); await uploadContent(); }
    catch (e) { taskError(e); }
    finally { taskSendingRef.current = false; setTaskSending(false); }
  }

  async function resolveDuplicate(choice: 'overwrite' | 'rename' | 'cancel') {
    const current = taskRef.current;
    if (!current || current.receipt?.status !== 'duplicate' || taskSendingRef.current || querying || current.error || readOnly) return;
    if (choice === 'overwrite' && (!candidate || !overwriteConfirmed)) return;
    taskSendingRef.current = true; setTaskSending(true); setError('');
    try {
      const receipt = await current.api<Receipt>(`/imports/${encodeURIComponent(current.queryId)}/resolve`,
        {choice, ...(candidate ? {candidateId: candidate.id} : {}), ...(choice === 'overwrite' ? {adoptionStamp: current.receipt.adoptionStamp, confirmUnbind: true} : {})}, 'POST');
      if (choice === 'cancel' && ['failed', 'cancelled'].includes(receipt.status)) { releaseImport(projectId); putTask(null); setImportConfirm(false); setError(''); setNotice('已取消本次导入，文件与资料输入保留。'); return; }
      receive(receipt); await uploadContent();
    } catch (e) { taskError(e); }
    finally { taskSendingRef.current = false; setTaskSending(false); }
  }

  async function saveVideo(video: ProjectVideo, value: EditDraft) {
    if (!value.title.trim() || !promptValid(value.prompt, prompts)) return;
    await run('正在保存视频资料…', async ticket => {
      const body: UpdateVideoRequest = { expectedRevision: value.expectedRevision, title: value.title.trim(), notes: value.notes, prompt: promptInput(value.prompt) };
      const next = await api<ProjectVideo>(`/videos/${encodeURIComponent(video.id)}`, body, 'PATCH');
      if (next.projectId !== projectId || next.id !== video.id) throw Error('保存响应不匹配，请刷新资料核对。');
      setEdits(old => { if (old[video.id] && JSON.stringify(old[video.id]) !== JSON.stringify(value)) return old; const copy = { ...old }; delete copy[video.id]; return copy; });
      setCollection(old => old ? { ...old, videos: old.videos.map(v => v.id === next.id ? next : v) } : old);
      setNotice('视频资料已保存。'); void refresh();
    });
  }

  async function previewUpgrade() {
    if (taskRef.current?.kind === 'upgrade' && !terminal(taskRef.current.receipt)) { setUpgradeOpen(true); return; }
    if (taskRef.current && !terminal(taskRef.current.receipt)) return;
    putTask(null);
    setUpgradeOpen(true); setUpgrade(null);
    await run('正在读取旧视频升级预览…', async ticket => {
      const next = await api<UpgradePreview>('/upgrade');
      if (isCurrent(ticket)) setUpgrade(next);
    });
  }

  async function startUpgrade() {
    if (!upgrade || taskRef.current && !terminal(taskRef.current.receipt)) return;
    await run('正在提交旧视频升级…', async ticket => {
      const requestId = crypto.randomUUID();
      putTask({ kind: 'upgrade', requestId, queryId: requestId, receipt: null, uploadAttempted: false, error: '', api: frozenAPI(), folderId: 'root', folderName: '项目根目录' });
      try {
        const receipt = await api<Receipt>('/upgrade', { requestId, previewHash: upgrade.previewHash }, 'POST');
        receive(receipt);
      } catch (e) { taskError(e); }
    });
  }

  async function confirmAction() {
    const action = confirmation;
    if (!action) return;
    await run(action.kind === 'remove' ? '正在移除视频记录…' : '正在检查并复制视频…', async ticket => {
      if (action.kind === 'remove') {
        const result = await api<{ removed: true }>(`/videos/${encodeURIComponent(action.video.id)}/remove`, {
          expectedRevision: action.video.revision, adoptionStamp: action.adoptionStamp, confirmUnbind: true,
        }, 'POST');
        if (!isCurrent(ticket)) return;
        if (!result.removed) throw Error('未取得移除成功回执，请刷新资料核对。');
        setConfirmation(null); setNotice('视频记录已移除，文件保留。'); void refresh();
      } else {
        const requestId = crypto.randomUUID();
        putTask({ kind: 'relink', requestId, queryId: requestId, receipt: null, uploadAttempted: false, error: '', api: frozenAPI(), folderId: 'root', folderName: '项目根目录' });
        try {
          const receipt = await api<Receipt>(`/videos/${encodeURIComponent(action.video.id)}/relink`, {
            requestId, expectedRevision: action.video.revision, path: action.path.trim(),
          }, 'POST');
          receive(receipt); setConfirmation(null);
        } catch (e) { taskError(e); }
      }
    });
  }

  const attention = (v: ProjectVideo) => !v.managed || ['missing', 'changed', 'untrusted', 'unsupported'].includes(v.status);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return videos.filter(v => {
      const reference = prompts.find(p => p.id === v.promptId);
      const nameHit = `${v.name}\n${v.fileName}`.toLocaleLowerCase().includes(q);
      const promptHit = `${reference?.title || ''}\n${reference?.text || ''}`.toLocaleLowerCase().includes(q);
      return (!q || queryScope !== 'prompt' && nameHit || queryScope !== 'name' && promptHit)
        && (adoptionFilter === 'all' || (adoptionFilter === 'adopted' ? v.adoptedShots.length > 0 : v.adoptedShots.length === 0))
        && (!attentionOnly || attention(v));
    });
  }, [videos, prompts, query, queryScope, adoptionFilter, attentionOnly]);
  const groups = useMemo(() => {
    if (view === 'videos') return [{ id: 'all', title: '', text: '', videos: filtered }];
    const result = new Map<string, { id: string; title: string; text: string; videos: ProjectVideo[] }>();
    for (const video of filtered) {
      const id = video.promptId || 'none'; const prompt = prompts.find(p => p.id === video.promptId);
      if (!result.has(id)) result.set(id, { id, title: prompt?.title || (video.promptId ? '未命名参考提示词' : '无参考提示词'), text: prompt?.text || '', videos: [] });
      result.get(id)!.videos.push(video);
    }
    return Array.from(result.values());
  }, [view, filtered, prompts]);

  function taskPanel(current: Task) {
    return <div className="pv-task" role="status" aria-live="polite">
      <strong>{current.kind === 'upgrade' ? '旧视频升级' : current.kind === 'relink' ? '重新定位' : '视频导入'} · {current.receipt ? receiptLabel[current.receipt.status] : '提交结果待核对'}</strong>
      {sending && <p>{sending}</p>}
      {pending(current) && !current.error && <progress aria-label="后台任务处理中"/>}
      <p>请求编号：<code>{current.queryId || current.requestId}</code></p>
      {current.receipt?.fileName && <p>保存文件名：{current.receipt.finalName || current.receipt.fileName}</p>}<p>固定保存位置：{projectName} / {current.folderName}</p>
      {(current.error || current.receipt?.error) && <p className="pv-error">{current.error || current.receipt?.error}</p>}
      {current.kind === 'relink' && !current.queryId && <p>尚未取得后台回执编号，请刷新视频资料核对位置与状态，再决定后续操作。</p>}
      <div className="pv-actions">
        <button type="button" disabled={taskSending || querying || !current.queryId} onClick={() => void queryTask()}><RefreshCw size={14}/>{querying ? '正在核对…' : '查询原请求'}</button>
        {current.kind === 'relink' && !current.queryId && <button type="button" disabled={loading || !!sending} onClick={() => void refresh()}>刷新视频资料核对</button>}
        {current.kind === 'import' && current.receipt?.status === 'waiting' && !current.uploadAttempted && <button type="button" disabled={taskSending || querying || !current.file} onClick={() => void queryTask()}>确认上传所选文件</button>}
      </div>
      {!!current.receipt?.results?.length && <ul className="pv-task-results">{current.receipt.results.map((item, i) => <li key={`${item.sourceId}:${i}`}><strong>{item.name}</strong><span>{item.status}</span>{item.error && <p className="pv-error">{item.error}</p>}</li>)}</ul>}
      {current.receipt?.status === 'ready' && <p>后台回执已完成；请以刷新后的视频记录和逐项结果为准。</p>}
    </div>;
  }

  const modalOpen = importOpen || upgradeOpen || !!confirmation || !!folderAction;
  const expandedVideo = active && !modalOpen ? videos.find(video => video.id === expandedId) : undefined;
  useEffect(() => setExpandedId(''), [active, projectId, modalOpen]);
  useEffect(() => { if (expandedId && !videos.some(video => video.id === expandedId)) setExpandedId(''); }, [collection, expandedId]);
  const importFrozen = !!taskRef.current || !!sending;
  const editChanged = !!selected && !!draft && JSON.stringify(draft) !== JSON.stringify(editFor(selected));
  const childFolderCount = folders.filter(f => f.parentId === (folderId === 'all' ? 'root' : folderId)).length;
  const draftDirty = (video: ProjectVideo) => !!edits[video.id] && JSON.stringify(edits[video.id]) !== JSON.stringify(editFor(video));
  // “全部视频”聚合时服务端不逐个核验，状态都是“尚未核验”；页头已说明，卡片上不再逐张重复。
  const showStatus = (video: ProjectVideo) => video.status !== 'available' && !(folderId === 'all' && video.status === 'unchecked');
  const cardFolder = (video: ProjectVideo) => !video.folderId || video.folderId === 'root' ? '项目根目录' : folderLabel(video.folderId) || (video.folderName && !/^([/\\]|[A-Za-z]:)/.test(video.folderName) ? video.folderName : '未核对目录');
  const discardDraft = (id: string) => setEdits(old => { const next = { ...old }; delete next[id]; return next; });
  const openRelink = (video: ProjectVideo) => { if (terminal(taskRef.current?.receipt || null)) putTask(null); setConfirmation({ kind: 'relink', video, path: '' }); };
  // Video moves always open the move-video preview; nothing is moved by the drop itself.
  const moveVideoTo = (videoId: string, target: string) => {
    if (readOnly || operationPending || sending || modalOpen) return;
    const video = videos.find(v => v.id === videoId); if (!video || video.folderId === target || !video.managed) return;
    setOpenMenu(''); setExpandedId(''); setFolderAction({kind: 'move-video', sourceId: videoId, destinationFolderId: target, label: video.name});
  };
  const folderCards = <FolderCards folders={folders} current={folderId} breadcrumbs={collection?.breadcrumbs} projectId={projectId} onNavigate={navigateFolder} onMoveVideo={readOnly || operationPending || !!sending || modalOpen ? undefined : moveVideoTo}/>;
  const orderedFolders = useMemo(() => {
    const out: {folder: typeof folders[number]; depth: number}[] = [];
    const walk = (parentId: string, depth: number, seen: Set<string>) => {
      for (const folder of folders.filter(f => f.parentId === parentId && !seen.has(f.id))) { out.push({folder, depth}); walk(folder.id, depth + 1, new Set([...seen, folder.id])); }
    };
    walk('root', 0, new Set());
    return out;
  }, [folders]);
  const [dropFolder, setDropFolder] = useState('');
  // Folder chips accept internal video drags only; external files are stopped here and sent to the import entry.
  const folderDrop = (id: string, available = true) => ({
    onDragOver: (e: React.DragEvent) => {
      const types = Array.from(e.dataTransfer.types);
      if (types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'none'; return; }
      if (!types.includes(VIDEO_DRAG_TYPE) || !available || readOnly || operationPending || sending || modalOpen) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropFolder(id);
    },
    onDragLeave: (e: React.DragEvent) => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDropFolder(old => old === id ? '' : old); },
    onDrop: (e: React.DragEvent) => {
      setDropFolder('');
      if (Array.from(e.dataTransfer.types).includes('Files')) { e.preventDefault(); e.stopPropagation(); notifyFeedback({source: '生成视频', kind: 'info', message: '请用“导入视频”入口导入外部文件。'}); return; }
      const videoId = readVideoDrag(e.dataTransfer, projectId); if (!videoId || !available) return;
      e.preventDefault(); e.stopPropagation(); moveVideoTo(videoId, id);
    },
  });
  useEffect(() => { setOpenMenu(''); }, [active, projectId, modalOpen, folderId, selectedId]);
  useEffect(() => {
    if (!openMenu) return;
    sessionRef.current?.querySelector<HTMLElement>(`[data-pv-menu="${openMenu}"] [role^="menuitem"]:not(:disabled)`)?.focus();
    const down = (e: PointerEvent) => { if (!(e.target instanceof Element) || !e.target.closest(`[data-pv-menu-wrap="${openMenu}"]`)) setOpenMenu(''); };
    document.addEventListener('pointerdown', down);
    return () => document.removeEventListener('pointerdown', down);
  }, [openMenu]);
  function menuKeys(e: React.KeyboardEvent<HTMLDivElement>, name: string) {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpenMenu(''); sessionRef.current?.querySelector<HTMLElement>(`[data-pv-menu-wrap="${name}"] > button`)?.focus(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (items.length) items[(index + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpenMenu('');
  }
  const menuWrap = (name: MenuName, trigger: React.ReactNode, props: {label?: string; className?: string; disabled?: boolean; title?: string}, items: React.ReactNode, align: 'left' | 'right' = 'right') =>
    <div className="pv-menu-wrap" data-pv-menu-wrap={name}>
      <button type="button" className={props.className} aria-label={props.label} title={props.title} disabled={props.disabled} aria-haspopup="menu" aria-expanded={openMenu === name} onClick={() => setOpenMenu(old => old === name ? '' : name)}>{trigger}</button>
      {openMenu === name && <div className={`pv-menu pv-menu-${align}`} role="menu" data-pv-menu={name} onKeyDown={e => menuKeys(e, name)}>{items}</div>}
    </div>;
  const menuItem = (label: string, onClick: () => void, options: {disabled?: boolean; danger?: boolean; hint?: string} = {}) =>
    <button type="button" role="menuitem" className={options.danger ? 'pv-danger' : undefined} disabled={options.disabled} onClick={() => { setOpenMenu(''); onClick(); }}><span>{label}</span>{options.hint && <small>{options.hint}</small>}</button>;
  const legacyCount = collection?.legacyUpgrade?.count;
  const upgradeBlocked = locked || !collection || unresolved && task?.kind !== 'upgrade';
  const dirBlocked = !['all', 'root'].includes(folderId) && folderBlocked(folderId);
  const dirDisabled = locked || operationPending || dirBlocked;
  const receivingId = task?.kind === 'import' && !terminal(task.receipt) ? task.folderId : '';
  const attentionCount = videos.filter(attention).length;
  const formId = `pv-detail-form-${projectId}`;
  const taskTone = !task ? '' : task.error || task.receipt?.status === 'unknown' || task.receipt?.status === 'duplicate' ? 'warn' : task.receipt?.status === 'failed' ? 'bad' : '';
  return <div className="pv-session" hidden={!active} ref={sessionRef}>
    <div className="pv-content" aria-hidden={modalOpen || undefined}>
      <div className="pv-bar">
        <div className="pv-bar-row">
          <label className="pv-search"><Search size={15} aria-hidden="true"/><input type="search" aria-label="搜索视频" value={query} onChange={e => setQuery(e.target.value)} placeholder={folderId === 'all' ? '搜索全部视频' : '搜索当前目录'}/>
            <select aria-label="搜索范围" value={queryScope} onChange={e => setQueryScope(e.target.value as typeof queryScope)}><option value="all">名称和提示词</option><option value="name">只搜名称</option><option value="prompt">只搜提示词</option></select></label>
          <div className="pv-chips" role="group" aria-label="按采用状态筛选">
            {(['all', 'candidate', 'adopted'] as const).map(key => <button key={key} type="button" aria-pressed={adoptionFilter === key} onClick={() => setAdoptionFilter(key)}>{{all: '全部', candidate: '候选', adopted: '已采用'}[key]}<span>{key === 'all' ? videos.length : videos.filter(v => (key === 'adopted') === v.adoptedShots.length > 0).length}</span></button>)}
            {(attentionCount > 0 || attentionOnly) && <button type="button" className="pv-chip-attention" aria-pressed={attentionOnly} title="文件缺失、待核验、格式不支持或待升级" onClick={() => setAttentionOnly(on => !on)}>需处理<span>{attentionCount}</span></button>}
          </div>
          <div className="pv-bar-actions">
            <button type="button" className="pv-primary" disabled={readOnly || !collection || importUnavailable || unresolved && task?.kind !== 'import'} title={importUnavailable ? '另一个项目有一笔导入待结束；浏览和切换不受影响' : undefined} onClick={() => {
              if (taskRef.current?.kind !== 'import' && terminal(taskRef.current?.receipt || null)) putTask(null);
              setImportOpen(true); setUpgradeOpen(false);
            }}><Upload size={16}/>导入视频</button>
            {menuWrap('more', <Ellipsis size={18}/>, {label: '更多视频操作', className: 'pv-icon-button'}, <>
              <button type="button" role="menuitemcheckbox" aria-checked={view === 'prompts'} onClick={() => { setOpenMenu(''); setView(old => old === 'prompts' ? 'videos' : 'prompts'); }}><span>按参考提示词分组</span>{view === 'prompts' && <Check size={14}/>}</button>
              {menuItem(loading ? '正在刷新…' : '刷新视频资料', () => void refresh(), {disabled: loading})}
              {!collection?.legacyUpgrade?.completed && <><hr/>{menuItem('升级旧视频…', () => void previewUpgrade(), {disabled: upgradeBlocked, hint: legacyCount !== undefined ? `${legacyCount} 个待升级` : undefined})}</>}
            </>)}
          </div>
        </div>
        <nav className="pv-folder-bar" aria-label="视频文件夹（可把视频卡片拖到这里）">
          <button type="button" className="pv-folder-chip" aria-current={folderId === 'all' ? 'page' : undefined} title="聚合所有文件夹；文件状态在进入文件夹或打开视频时核验" onClick={() => navigateFolder('all')}><Layers size={14}/><span>全部视频</span></button>
          <button type="button" className={`pv-folder-chip${dropFolder === 'root' ? ' is-drop-target' : ''}`} aria-current={folderId === 'root' ? 'page' : undefined} onClick={() => navigateFolder('root')} {...folderDrop('root')}><FolderOpen size={14}/><span>项目根目录</span>{receivingId === 'root' && <small className="pv-receiving">接收中</small>}</button>
          {orderedFolders.map(({folder, depth}) => <button key={folder.id} type="button" className={`pv-folder-chip${dropFolder === folder.id ? ' is-drop-target' : ''}`} aria-current={folderId === folder.id ? 'page' : undefined} title={folderLabel(folder.id) || folder.name} onClick={() => navigateFolder(folder.id)} {...folderDrop(folder.id, folder.available)}>
            {depth ? <CornerDownRight size={13}/> : <FolderIcon size={14}/>}<span>{folder.name}</span>{!folder.available && <small>不可用</small>}{receivingId === folder.id && <small className="pv-receiving">接收中</small>}</button>)}
          <button type="button" className="pv-folder-chip pv-folder-new" disabled={locked || operationPending || !collection} onClick={() => setFolderAction({kind: 'create', parentId: folderTarget(folderId)})}><FolderPlus size={14}/><span>新建文件夹</span></button>
          {menuWrap('dir', <><span>当前目录</span><ChevronDown size={13}/></>, {className: 'pv-folder-chip', disabled: folderId === 'all', title: folderId === 'all' ? '“全部视频”不是一个具体目录' : `管理“${folderName}”`}, <>
            {!['all', 'root'].includes(folderId) && <>
              {menuItem('重命名文件夹…', () => setFolderAction({kind: 'rename-folder', folderId, label: folderName}), {disabled: dirDisabled})}
              {menuItem('移动文件夹…', () => setFolderAction({kind: 'move-folder', folderId, label: folderName}), {disabled: dirDisabled})}
              {menuItem('删除文件夹…', () => setFolderAction({kind: 'delete-folder', folderId, label: folderName}), {disabled: dirDisabled, danger: true})}
              {dirBlocked && <p className="pv-menu-note">该文件夹或其子目录正在接收视频，等原导入结束后再操作。</p>}
              <hr/>
            </>}
            {menuItem('刷新当前目录', () => void run('正在刷新当前目录…', async () => { await api('/folders/refresh', {folderId}, 'POST'); void refresh(); }), {disabled: locked || loading || folderId === 'all', hint: '重新认领访达中改过名的目录和文件'})}
          </>, 'left')}
        </nav>
      </div>
      <div className="pv-notices">
        {sending && <p className="pv-banner" role="status"><RefreshCw size={14} className="pv-spin"/>{sending}</p>}
        {error && <div className="pv-banner" data-tone="bad" role="alert"><AlertCircle size={15}/><span className="pv-banner-text">{error}</span><button type="button" className="pv-banner-close" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14}/></button></div>}
        {notice && <p className="pv-banner" role="status"><Check size={15}/><span className="pv-banner-text">{notice}</span></p>}
        {task && !modalOpen && <div className="pv-banner pv-task-banner" data-tone={taskTone || undefined} role="status" aria-live="polite">
          <strong>{task.kind === 'upgrade' ? '旧视频升级' : task.kind === 'relink' ? '重新定位' : '视频导入'} · {task.receipt ? receiptLabel[task.receipt.status] : '提交结果待核对'}</strong>
          <span className="pv-banner-text">{task.kind === 'import' ? `固定保存到 ${projectName} / ${task.folderName}：${task.receipt?.finalName || task.receipt?.fileName || task.file?.name || '视频'} ` : ''}<code>{task.queryId || task.requestId}</code></span>
          {pending(task) && !task.error && <progress aria-label="后台任务处理中"/>}
          <button type="button" disabled={taskSending || querying || !task.queryId} onClick={() => void queryTask()}><RefreshCw size={13}/>{querying ? '正在核对…' : '查询原请求'}</button>
          {task.kind === 'import' && task.receipt?.status === 'waiting' && !task.uploadAttempted && <button type="button" disabled={taskSending || querying || !task.file} onClick={() => void queryTask()}>确认上传所选文件</button>}
          {task.kind === 'relink' && !task.queryId && <button type="button" disabled={loading || !!sending} onClick={() => void refresh()}>刷新视频资料核对</button>}
          {task.kind === 'import' && <button type="button" onClick={() => setImportOpen(true)}>{task.receipt?.status === 'duplicate' ? '选择处理方式' : '打开导入详情'}<ChevronRight size={13}/></button>}
          {task.kind === 'upgrade' && <button type="button" onClick={() => setUpgradeOpen(true)}>查看升级结果<ChevronRight size={13}/></button>}
          {terminal(task.receipt) && <button type="button" className="pv-banner-close" aria-label="收起任务提示" onClick={() => putTask(null)}><X size={13}/></button>}
        </div>}
        {!!collection && !collection.legacyUpgrade?.completed && (legacyCount ?? 0) > 0 && !(task?.kind === 'upgrade' && unresolved) && <div className="pv-banner" data-tone="warn"><AlertTriangle size={15}/><span className="pv-banner-text">{legacyCount} 个旧视频还不是项目托管副本。升级前保留既有采用，但不能在分镜中新增绑定。</span><button type="button" disabled={upgradeBlocked} onClick={() => void previewUpgrade()}>核对并升级…</button></div>}
      </div>
      <div className={`pv-main${selected && draft ? ' pv-has-detail' : ''}`}>
        {/* 外部视频文件拖到列表区任意位置即可导入（先核对再复制）；提示只在拖动时出现，平时不占一行。 */}
        <section className={`pv-library${dragging ? ' pv-dragging' : ''}`} aria-label="视频列表"
          onDragOver={e => { if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(VIDEO_DRAG_TYPE)) return; e.preventDefault(); if (!locked && !importUnavailable && !(task && !terminal(task.receipt))) { e.dataTransfer.dropEffect = 'copy'; setDragging(true); } else e.dataTransfer.dropEffect = 'none'; }}
          onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
          onDrop={e => { setDragging(false); if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(VIDEO_DRAG_TYPE)) return; e.preventDefault(); if (!locked) acceptFiles(e.dataTransfer.files); }}>
          <div className="pv-library-head"><span>{childFolderCount ? `${childFolderCount} 个文件夹 · ` : ''}{filtered.length} / {videos.length} 个视频{folderId === 'all' ? ' · 全部文件夹聚合，文件状态打开时核验' : ''}{loading && collection ? ' · 正在刷新…' : ''}</span><span className="pv-save-location" title={folderName}>导入到：<strong>{folderName}</strong></span></div>
          {dragging && <div className="pv-drop-overlay" role="status"><Upload size={18}/><span>松开导入一个视频到“{folderName}”，会先核对再复制</span></div>}
          {!collection && loading && <p className="pv-empty">正在读取项目视频…</p>}
          {view === 'prompts' && childFolderCount > 0 && <div className="pv-cards pv-folder-cards" role="group" aria-label="当前层子文件夹">{folderCards}</div>}
          {groups.map(group => <section key={group.id} className="pv-group">
            {view === 'prompts' && <header><h2>{group.title}<small>{group.videos.length} 个视频</small></h2>{group.text && <details><summary>查看完整参考提示词</summary><pre>{group.text}</pre></details>}</header>}
            <div className="pv-cards" role="group" aria-label={view === 'videos' ? '当前目录的文件夹与视频' : group.title}>{view === 'videos' && folderCards}{group.videos.map(video => <div className="pv-card-entry" key={video.id}><button type="button" className={`pv-card${selectedId === video.id ? ' pv-selected' : ''}`} aria-pressed={selectedId === video.id} draggable={video.managed && !readOnly && !operationPending} onDragStart={e => { e.dataTransfer.setData(VIDEO_DRAG_TYPE, JSON.stringify({projectId, videoId: video.id})); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDropFolder('')} onClick={() => setSelectedId(video.id)} onDoubleClick={() => { setSelectedId(video.id); setExpandedId(video.id); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); if (!e.repeat) { setSelectedId(video.id); setExpandedId(video.id); } } }} aria-haspopup="dialog" aria-keyshortcuts="Enter" title="单击查看资料，双击或按 Enter 查看原视频">
              <span className="pv-thumbnail">{(video.thumbnailUrl || video.thumbUrl) ? <img src={video.thumbnailUrl || video.thumbUrl} alt="" loading="lazy" onError={e => { e.currentTarget.hidden = true; }}/> : null}<Film size={30} aria-hidden="true"/>
                <span className={`pv-adoption-badge${video.adoptedShots.length ? ' is-adopted' : ''}`}>{video.adoptedShots.length ? `已采用 · ${video.adoptedShots.length} 镜` : '候选'}</span><span className="pv-duration">{duration(video.durationMs)}</span></span>
              <span className="pv-card-body"><strong title={video.name || video.fileName}>{video.name || video.fileName}</strong>
                <small className="pv-card-prompt">{video.promptId ? prompts.find(p => p.id === video.promptId)?.title || '已关联参考提示词' : '无参考提示词'}</small>
                {folderId === 'all' && <small className="pv-card-folder" title={cardFolder(video)}>{cardFolder(video)}</small>}
                {(showStatus(video) || !video.managed || draftDirty(video)) && <span className="pv-card-flags">{showStatus(video) && <span data-status={video.status} title={statusLabel[video.status]}>{statusShort[video.status]}</span>}{!video.managed && <span data-tone="warn">待升级</span>}{draftDirty(video) && <span data-tone="draft">草稿未保存</span>}</span>}</span>
            </button></div>)}</div>
          </section>)}
          {!loading && !filtered.length && <div className="pv-empty"><Film size={32}/><h2>{videos.length ? '没有符合筛选条件的视频' : folderId === 'all' ? '本项目还没有生成视频' : '当前目录还没有视频'}</h2><p>{videos.length ? '调整搜索、采用状态或“需处理”筛选。' : childFolderCount ? '可进入上方子文件夹，或导入视频到当前目录。' : '导入一个生成结果，保存后即可在分镜中采用。'}</p></div>}
        </section>
        {selected && draft && <aside className="pv-detail" aria-label="视频详情">
          <header className="pv-detail-head"><div className="pv-detail-title"><small>视频详情</small><h2 title={selected.name || selected.fileName}>{selected.name || selected.fileName}</h2></div>
            {menuWrap('detail', <Ellipsis size={17}/>, {label: '视频操作', className: 'pv-icon-button pv-ghost'}, <>
              {menuItem('移动到…', () => { setExpandedId(''); setFolderAction({kind: 'move-video', sourceId: selected.id, label: selected.name}); }, {disabled: locked || operationPending || !selected.managed, hint: selected.managed ? '会先核对影响' : '升级后可移动'})}
              {menuItem('在访达中显示', () => void run('正在访达中显示…', async () => { await api(`/videos/${encodeURIComponent(selected.id)}/reveal`, {}, 'POST'); }), {disabled: locked})}
              {menuItem('重新定位…', () => openRelink(selected), {disabled: locked || unresolved})}
              <hr/>
              {menuItem('移除视频记录…', () => setConfirmation({ kind: 'remove', video: selected, adoptionStamp: collection!.adoptionStamp }), {disabled: locked || unresolved || !collection, danger: true})}
            </>)}
            <button type="button" className="pv-icon-button pv-ghost" aria-label="关闭详情" onClick={() => setSelectedId('')}><X size={17}/></button>
          </header>
          <div className="pv-detail-meta"><span className={`pv-pill${selected.adoptedShots.length ? ' is-adopted' : ''}`}>{selected.adoptedShots.length ? `已采用 · ${selected.adoptedShots.length} 镜` : '候选'}</span><span className="pv-pill" data-status={selected.status}>{statusLabel[selected.status]}</span>{!selected.managed && <span className="pv-pill" data-tone="warn">旧视频 · 待升级</span>}
            <button type="button" className="pv-view-button" title="也可以双击卡片或按 Enter" onClick={() => setExpandedId(selected.id)}><Play size={13}/>查看原视频</button></div>
          <div className="pv-detail-scroll">
            {draft.expectedRevision !== selected.revision && <div className="pv-callout" data-tone="bad" role="alert"><strong>资料已被其他操作更新，草稿仍保留。</strong><span>请核对最新资料后重新编辑保存；当前草稿不能直接覆盖。</span><button type="button" onClick={() => discardDraft(selected.id)}>放弃草稿，使用当前资料</button></div>}
            {['missing', 'changed', 'untrusted'].includes(selected.status) && <div className="pv-callout" data-tone={selected.status === 'missing' ? 'bad' : 'warn'}><strong>{selected.status === 'missing' ? '原视频文件缺失' : '文件状态待核验'}</strong><span>{selected.status === 'missing' ? '指定同一内容文件的新位置，后台核验一致后复制回项目托管位置；原采用关系保持。' : '文件状态与登记时不一致，需要核验后预览。这不一定代表内容改变，原采用关系保持。'}</span><button type="button" ref={relinkButton} disabled={locked || unresolved} onClick={() => openRelink(selected)}>重新定位…</button></div>}
            {selected.status === 'unsupported' && <div className="pv-callout" data-tone="warn"><span>浏览器不支持此视频格式（{selected.codec || '未知编码'}）的预览，可在访达中打开。采用不受影响。</span></div>}
            {!selected.managed && <div className="pv-callout" data-tone="warn"><span>旧视频保留既有采用。请先显式升级为项目托管副本，再到分镜中新增绑定。</span>{!collection?.legacyUpgrade?.completed && <button type="button" disabled={upgradeBlocked} onClick={() => void previewUpgrade()}>核对并升级…</button>}</div>}
            <form id={formId} className="pv-detail-form" onSubmit={e => { e.preventDefault(); if (!locked) void saveVideo(selected, draft); }}>
              <fieldset disabled={locked}><legend className="pv-sr-only">编辑视频资料</legend>
                <PromptFields value={draft.prompt} prompts={prompts} disabled={locked} onChange={prompt => setEdits(old => ({ ...old, [selected.id]: { ...draft, prompt } }))}/>
                <div className="pv-basic-fields"><h3>视频资料</h3>
                <label className="pv-field">视频名称<input value={draft.title} required onChange={e => setEdits(old => ({ ...old, [selected.id]: { ...draft, title: e.target.value } }))}/></label>
                <label className="pv-field">备注（可选）<textarea value={draft.notes} rows={2} onChange={e => setEdits(old => ({ ...old, [selected.id]: { ...draft, notes: e.target.value } }))}/></label>
                </div>
              </fieldset>
            </form>
            <section className="pv-adoption"><h3>实际采用镜号</h3><p>{shotsLabel(selected.adoptedShots)}</p><button type="button" disabled={locked} onClick={onStoryboard}>前往分镜查看采用<ChevronRight size={14}/></button></section>
            <details className="pv-file-info"><summary>文件信息与路径</summary><dl className="pv-metadata"><div><dt>原文件名</dt><dd>{selected.fileName}</dd></div><div><dt>时长 / 编码</dt><dd>{duration(selected.durationMs)} · {selected.codec || '未知编码'}</dd></div><div><dt>文件大小</dt><dd>{bytes(selected.bytes)}</dd></div><div><dt>存放</dt><dd>{selected.managed ? '项目托管副本' : '旧视频 · 原位置'}</dd></div><div><dt>存放位置</dt><dd className="pv-path">{selected.path || '未提供路径'}</dd></div></dl></details>
          </div>
          <footer className={`pv-savebar${editChanged ? ' is-dirty' : ''}`}><span role="status">{draft.expectedRevision !== selected.revision ? '资料已更新，草稿不能直接保存' : editChanged ? '有未保存的修改（草稿按视频保留）' : '已保存'}</span>
            {editChanged && draft.expectedRevision === selected.revision && <button type="button" disabled={locked} onClick={() => discardDraft(selected.id)}>放弃草稿</button>}
            <button className="pv-primary" type="submit" form={formId} disabled={locked || !editChanged || !draft.title.trim() || !promptValid(draft.prompt, prompts) || draft.expectedRevision !== selected.revision}>保存资料</button></footer>
        </aside>}
      </div>
    </div>
    {expandedVideo && <MediaViewer label="项目原视频预览" initialTime={initialPosition(expandedVideo)} onPosition={seconds => rememberPosition(expandedVideo, seconds)} target={{
      key: [projectId, expandedVideo.id, expandedVideo.revision, expandedVideo.status, expandedVideo.supported].join(':'),
      name: expandedVideo.name || expandedVideo.fileName, kind: 'video', src: expandedVideo.mediaUrl, poster: expandedVideo.thumbnailUrl,
      reason: expandedVideo.status === 'changed' ? '视频内容或文件属性与登记时不同，需核验后预览；原采用关系保持。'
        : expandedVideo.status === 'missing' ? '原视频文件缺失，请返回详情重新定位同内容文件。'
        : expandedVideo.status === 'untrusted' ? '原视频身份待核验，请返回详情重新定位，已有采用关系不会自动改变。'
        : expandedVideo.status === 'unchecked' ? undefined
        : expandedVideo.status === 'unsupported' || !expandedVideo.supported ? '浏览器不支持此视频格式，请返回详情核对格式信息。'
        : expandedVideo.status !== 'available' ? '原视频当前不可用，请返回详情核对。' : undefined,
    }} onClose={() => setExpandedId('')} repairLabel="返回详情重新定位" onRepair={() => { requestAnimationFrame(() => relinkButton.current?.focus()); }}/>} 
    <input className="pv-sr-only" ref={fileInput} type="file" tabIndex={-1} accept="video/*,.mkv,.m2ts,.mts" onChange={e => { if (e.target.files?.length) acceptFiles(e.target.files); e.target.value = ''; }}/>
    {active && importOpen && <Modal title={duplicate ? '目标文件夹有同名视频' : importConfirm ? '确认导入视频' : '导入视频'} locked={false} onClose={() => { setImportOpen(false); setImportConfirm(false); }}>
      <p className="pv-notice">固定归属项目：<strong>{projectName}</strong> / <strong>{importTask?.folderName || folderName}</strong>。复制原文件到项目托管位置，原文件保留。</p>
      {error && <p className="pv-error" role="alert">{error}</p>}
      {importTask && taskPanel(importTask)}
      {duplicate ? <>
        <p>目标文件夹有同名文件。请选择覆盖、递增重命名保留双方，或取消导入；相同内容可以另存为独立副本。</p>
        <label className="pv-field">同名目标视频<select aria-label="同名目标视频" value={candidate?.id || ''} disabled={taskSending || querying} onChange={e => {setCandidateId(e.target.value); setOverwriteConfirmed(false);}}>{candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        {candidate && <><Player key={candidate.id} name={candidate.name} mediaUrl={candidate.mediaUrl}/><h3>覆盖将解除的精确镜号</h3><p>{shotsLabel(candidate.adoptedShots || [])}</p><label className="pv-check"><input type="checkbox" checked={overwriteConfirmed} disabled={taskSending || querying} onChange={e => setOverwriteConfirmed(e.target.checked)}/>我已核对目标及上述镜号，确认覆盖并解除目标采用</label></>}
        <ModalActions><button type="button" disabled={readOnly || taskSending || querying || !!importTask?.error} onClick={() => void resolveDuplicate('cancel')}>取消本次导入，保留输入</button><button type="button" disabled={readOnly || taskSending || querying || !!importTask?.error} onClick={() => void resolveDuplicate('rename')}>保留双方，递增重命名</button><button type="button" className="pv-danger" disabled={readOnly || taskSending || querying || !!importTask?.error || !candidate || !overwriteConfirmed} onClick={() => void resolveDuplicate('overwrite')}>确认覆盖同名目标</button></ModalActions>

      </> : <>
        <div className="pv-import-file"><Film size={24}/><div><strong>{file?.name || '尚未选择视频'}</strong><p>{file ? bytes(file.size) : '一次导入一个视频文件'}</p></div><button type="button" disabled={importFrozen} onClick={() => fileInput.current?.click()}>{file ? '更换文件' : '选择文件'}</button></div>
        <form onSubmit={e => { e.preventDefault(); if (importConfirm) void startImport(); else if (file && promptValid(importPrompt, prompts)) setImportConfirm(true); }}>
          <fieldset disabled={importFrozen || importConfirm}><legend className="pv-sr-only">导入资料</legend>
            <label className="pv-field">视频名称（可选）<input value={title} onChange={e => setTitle(e.target.value)} placeholder="留空使用文件名"/></label>
            <label className="pv-field">备注（可选）<textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)}/></label>
            <PromptFields value={importPrompt} prompts={prompts} disabled={importFrozen || importConfirm} onChange={setImportPrompt}/>
          </fieldset>
          {importConfirm && !importTask && <p className="pv-notice">确认将“{file?.name}”复制并保存到“{projectName}”？视频记录立即持久保存，稍后可选择是否在分镜中采用。</p>}
          {!importTask && <ModalActions><button type="button" disabled={locked} onClick={() => { setImportOpen(false); setImportConfirm(false); }}>取消</button>{importConfirm && <button type="button" disabled={locked} onClick={() => setImportConfirm(false)}>返回修改</button>}<button type="submit" className="pv-primary" disabled={locked || taskSending || importUnavailable || !file || !promptValid(importPrompt, prompts)}>{importConfirm ? '确认复制并导入' : '下一步，核对导入'}</button></ModalActions>}
        </form>
        {importTask && terminal(importTask.receipt) && <ModalActions><button type="button" disabled={locked} onClick={() => { setImportOpen(false); setImportConfirm(false); }}>返回视频列表</button><button type="button" className="pv-primary" disabled={locked} onClick={() => { putTask(null); setFile(null); setTitle(''); setNotes(''); setImportPrompt(noPrompt()); setImportConfirm(false); }}>开始另一笔导入</button></ModalActions>}
      </>}
    </Modal>}
    {active && upgradeOpen && <Modal title="旧视频升级" locked={false} onClose={() => setUpgradeOpen(false)}>
      <p className="pv-notice">项目：<strong>{projectName}</strong>。{upgrade && !upgrade.items.length ? '无需复制文件，确认后完成本次升级检查。' : '升级会复制旧视频至本项目托管位置，保留原文件与既有采用关系。'}</p>
      {error && <p className="pv-error" role="alert">{error}</p>}
      {task?.kind === 'upgrade' ? taskPanel(task) : <>
        {!upgrade ? <p>{sending ? '正在读取预览…' : '未取得升级预览。'}{!sending && <button type="button" onClick={() => void previewUpgrade()}>重新读取预览</button>}</p> : <>
          <dl className="pv-metadata"><div><dt>需复制</dt><dd>{bytes(upgrade.bytes)}</dd></div><div><dt>可用空间</dt><dd>{upgrade.freeBytes === null ? '暂时无法读取，提交时由后台检查' : bytes(upgrade.freeBytes)}</dd></div></dl>
          {upgrade.freeBytes !== null && upgrade.freeBytes < upgrade.bytes && <p className="pv-error">可用空间不足，无法开始升级。</p>}
          <ul className="pv-upgrade-items">{upgrade.items.map(item => <li key={item.id}><strong>{item.name}</strong><p className="pv-path">{item.path}</p><p>{bytes(item.bytes)} · {item.status}</p><p>采用镜号：{shotsLabel(item.adoptedShots)}</p></li>)}</ul>
          {!upgrade.items.length && <p className="pv-muted">本项目无需复制旧视频。确认完成后，将停用升级入口。</p>}
          <ModalActions><button type="button" onClick={() => setUpgradeOpen(false)}>取消</button><button type="button" className="pv-primary" disabled={locked || upgrade.freeBytes !== null && upgrade.freeBytes < upgrade.bytes || !!task && !terminal(task.receipt)} onClick={() => void startUpgrade()}>{upgrade.items.length ? '确认一次，后台复制升级' : '确认完成并停用升级入口'}</button></ModalActions>
        </>}
      </>}
      {task?.kind === 'upgrade' && terminal(task.receipt) && <ModalActions><button type="button" onClick={() => setUpgradeOpen(false)}>返回视频列表</button>{!collection?.legacyUpgrade?.completed && <button type="button" className="pv-primary" onClick={() => { putTask(null); void previewUpgrade(); }}>重新核对剩余旧视频</button>}</ModalActions>}
    </Modal>}
    <FolderOperations action={folderAction} active={active} folders={folders} projectId={projectId} request={request} canTrash={!!collection?.canTrash} readOnly={readOnly} folderBlocked={folderBlocked} onClose={() => setFolderAction(null)} onComplete={receipt => {if (receipt?.status === 'ready' && folderAction?.kind === 'delete-folder') navigateFolder('root'); else void refresh();}} onPending={setOperationPending}/>
    {active && confirmation && <Modal title={confirmation.kind === 'remove' ? '移除视频记录' : '重新定位视频'} locked={locked} onClose={() => setConfirmation(null)}>
      <p>项目：<strong>{projectName}</strong> · {confirmation.video.name}</p>
      {error && <p className="pv-error" role="alert">{error}</p>}
      {confirmation.kind === 'remove' ? <>
        <p className="pv-notice">将移除本项目的视频记录并解除以下实际采用关系，原文件和托管文件均保留。</p>
        <h3>受影响镜号</h3><p>{shotsLabel(confirmation.video.adoptedShots)}</p>
        <p className="pv-muted">若分镜时序或采用关系已经变化，请先前往分镜预览清空旧关联，再重新读取资料确认。</p>
        <ModalActions><button type="button" disabled={locked || loading} onClick={() => { setConfirmation(null); void refresh(); }}>取消并刷新资料</button><button type="button" disabled={locked} onClick={() => { setConfirmation(null); onStoryboard(); }}>前往分镜查看</button><button type="button" className="pv-danger" disabled={locked} onClick={() => void confirmAction()}>确认移除并解除关联</button></ModalActions>
      </> : <>
        <p className="pv-notice">明确指定同一内容文件的新位置。后台核验内容一致后复制到项目托管位置，保留既有绑定与新位置的原文件。</p>
        <p className="pv-path">记录位置：{confirmation.video.path}</p>
        <label className="pv-field">同内容视频文件的绝对路径<input value={confirmation.path} disabled={locked || task?.kind === 'relink' && unresolved} placeholder="粘贴文件的完整路径" onChange={e => setConfirmation({ ...confirmation, path: e.target.value })}/></label>
        {task?.kind === 'relink' && taskPanel(task)}
        <ModalActions><button type="button" disabled={locked} onClick={() => setConfirmation(null)}>取消</button><button type="button" className="pv-primary" disabled={locked || !confirmation.path.trim() || task?.kind === 'relink' && unresolved} onClick={() => void confirmAction()}>确认核验并复制</button></ModalActions>
      </>}
    </Modal>}
  </div>;
}

export default ProjectVideoWorkspace;
