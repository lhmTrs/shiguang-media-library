import {notifyFeedback, useFeedbackToast} from '../global-feedback';
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, ChevronRight, Film, FolderOpen, RefreshCw, Upload, X } from 'lucide-react';
import type {
  AdoptedShot, ImportRequest, ProjectVideo, ProjectVideoCollection, ProjectVideoWorkspaceProps,
  PromptInput, Receipt, ReferencePrompt, UpdateVideoRequest, UpgradePreview,
} from './types';
import './project-videos.css';
import {MediaViewer} from '../MediaViewer';
import {Modal, ModalActions} from './Modal';
import {FolderTree, FolderBreadcrumbs, FolderCards} from './FolderBrowser';
import {FolderOperations, type FolderAction} from './FolderOperations';
import {VIDEO_DRAG_TYPE, folderTarget, folderContains} from './folders';
import type {FolderView} from './types';

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
      <label className="pv-project">当前项目<select aria-label="生成视频所属项目" value={currentId} onChange={e => props.onProject(e.target.value)}>
        <option value="" disabled>请选择项目</option>
        {currentId && !props.projects.some(p => p.id === currentId) && <option value={currentId}>当前项目</option>}
        {props.projects.filter(p => p.project_kind !== 'public').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select></label>
    </header>
    {importOwner && importOwner !== currentId && <div className="pv-notice" role="status">“{props.projects.find(p => p.id === importOwner)?.name || '原项目'}”有一笔导入待结束，浏览与切换不受影响。<button type="button" onClick={() => props.onProject(importOwner)}>返回原导入任务</button></div>}
    {!currentId && <div className="pv-empty"><Film size={38}/><h2>先选择一个项目</h2><p>导入的视频固定归属于该项目。</p></div>}
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
  const [nameFilter, setNameFilter] = useState('');
  const [promptFilter, setPromptFilter] = useState('');
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
  const folderName = folderId === 'all' || folderId === 'root' ? '项目根目录' : folders.find(f => f.id === folderId)?.path || folders.find(f => f.id === folderId)?.name || '当前文件夹';
  const folderBlocked = (id: string) => !!taskRef.current && !terminal(taskRef.current.receipt) && taskRef.current.kind === 'import' && folderContains(folders, id, taskRef.current.folderId);
  function navigateFolder(id: FolderView) {
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
      setSelectedId(old => selectId && next.videos.some(v => v.id === selectId) ? selectId : next.videos.some(v => v.id === old) ? old : next.videos[0]?.id || '');
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

  const filtered = useMemo(() => {
    const name = nameFilter.trim().toLocaleLowerCase(); const prompt = promptFilter.trim().toLocaleLowerCase();
    return videos.filter(v => {
      const reference = prompts.find(p => p.id === v.promptId);
      return (!name || `${v.name}\n${v.fileName}`.toLocaleLowerCase().includes(name))
        && (!prompt || `${reference?.title || ''}\n${reference?.text || ''}`.toLocaleLowerCase().includes(prompt))
        && (adoptionFilter === 'all' || (adoptionFilter === 'adopted' ? v.adoptedShots.length > 0 : v.adoptedShots.length === 0));
    });
  }, [videos, prompts, nameFilter, promptFilter, adoptionFilter]);
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
  const folderCards = <FolderCards folders={folders} current={folderId} breadcrumbs={collection?.breadcrumbs} projectId={projectId} onNavigate={navigateFolder} onMoveVideo={readOnly || operationPending || !!sending || modalOpen ? undefined : (videoId, target) => {
        if (readOnly || operationPending || sending) return;
        const video = videos.find(v => v.id === videoId); if (!video || video.folderId === target || !video.managed) return;
        setExpandedId(''); setFolderAction({kind: 'move-video', sourceId: videoId, destinationFolderId: target, label: video.name});
      }}/>;
  return <div className="pv-session" hidden={!active}>
    <div className="pv-content" aria-hidden={modalOpen || undefined}>
      <div className="pv-columns">
        <aside className="pv-sidebar" aria-label="项目视频目录">
          <div className="pv-sidebar-heading"><h2>文件夹</h2><button type="button" disabled={locked || operationPending || !collection} onClick={() => setFolderAction({kind: 'create', parentId: folderTarget(folderId)})}>新建文件夹</button></div>
      <FolderTree folders={folders} current={folderId} breadcrumbs={collection?.breadcrumbs} projectId={projectId} onNavigate={navigateFolder} onMoveVideo={(videoId, target) => {
        if (readOnly || operationPending || sending) return;
        const video = videos.find(v => v.id === videoId); if (!video || video.folderId === target || !video.managed) return;
        setExpandedId(''); setFolderAction({kind: 'move-video', sourceId: videoId, destinationFolderId: target, label: video.name});
      }}/>
          <div className="pv-directory-tools">
        {!['all', 'root'].includes(folderId) && <details className="pv-directory-menu"><summary>管理当前目录</summary><div className="pv-actions">
          <button type="button" disabled={locked || operationPending || folderBlocked(folderId)} onClick={() => setFolderAction({kind: 'rename-folder', folderId, label: folderName})}>重命名文件夹</button>
          <button type="button" disabled={locked || operationPending || folderBlocked(folderId)} onClick={() => setFolderAction({kind: 'move-folder', folderId, label: folderName})}>移动文件夹</button>
          <button type="button" className="pv-danger" disabled={locked || operationPending || folderBlocked(folderId)} onClick={() => setFolderAction({kind: 'delete-folder', folderId, label: folderName})}>删除文件夹</button>
        </div></details>}
        <button type="button" disabled={locked || loading || folderId === 'all'} onClick={() => void run('正在刷新当前目录…', async () => { await api('/folders/refresh', {folderId}, 'POST'); void refresh(); })}>刷新当前目录</button>
          </div>
          <p className="pv-sidebar-hint">可将视频卡片拖到目标文件夹</p>
        </aside>
        <section className="pv-library" aria-label="视频列表">
          <div className="pv-library-toolbar">
      <div className="pv-toolbar">
        <div className="pv-actions"><button type="button" className="pv-primary" disabled={readOnly || !collection || importUnavailable || unresolved && task?.kind !== 'import'} onClick={() => {
          if (taskRef.current?.kind !== 'import' && terminal(taskRef.current?.receipt || null)) putTask(null);
          setImportOpen(true); setUpgradeOpen(false);
        }}><Upload size={16}/>导入视频</button>
          {!collection?.legacyUpgrade?.completed && <button type="button" disabled={locked || !collection || unresolved && task?.kind !== 'upgrade'} onClick={() => void previewUpgrade()}>升级旧视频{collection?.legacyUpgrade?.count !== undefined ? `（${collection.legacyUpgrade.count}）` : ''}</button>}</div>
        <button type="button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'pv-spin' : ''}/>{loading ? '正在刷新…' : '刷新资料'}</button>
      </div>
            <div className="pv-location-row">
      <FolderBreadcrumbs folders={folders} current={folderId} breadcrumbs={collection?.breadcrumbs} projectId={projectId} onNavigate={navigateFolder} onMoveVideo={(videoId, target) => {
        if (readOnly || operationPending || sending) return;
        const video = videos.find(v => v.id === videoId); if (!video || video.folderId === target || !video.managed) return;
        setExpandedId(''); setFolderAction({kind: 'move-video', sourceId: videoId, destinationFolderId: target, label: video.name});
      }}/>
              <span className="pv-save-location" title={folderName}>导入到：{folderName}</span>
            </div>
      <div className="pv-filters">
        <label>名称<input type="search" value={nameFilter} onChange={e => setNameFilter(e.target.value)} placeholder="视频标题或原文件名"/></label>
        <label>参考提示词<input type="search" value={promptFilter} onChange={e => setPromptFilter(e.target.value)} placeholder="提示词标题或正文"/></label>
        <label>采用状态<select value={adoptionFilter} onChange={e => setAdoptionFilter(e.target.value as typeof adoptionFilter)}><option value="all">全部视频</option><option value="candidate">候选 · 尚未采用</option><option value="adopted">已采用</option></select></label>
      </div>
      <div className="pv-list-heading"><div className="pv-actions" role="group" aria-label="视频排列方式"><button type="button" aria-pressed={view === 'videos'} onClick={() => setView('videos')}>按视频</button><button type="button" aria-pressed={view === 'prompts'} onClick={() => setView('prompts')}>按参考提示词分组</button></div><span>{childFolderCount ? `${childFolderCount} 个文件夹 · ` : ''}{filtered.length} / {videos.length} 个视频</span></div>
          </div>
      <div className="pv-feedback" aria-live="polite">
        {sending && <p className="pv-notice"><RefreshCw size={15} className="pv-spin"/>{sending}</p>}
        {error && <div className="pv-error" role="alert"><AlertCircle size={16}/><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={14}/></button></div>}
        {notice && <p className="pv-notice"><Check size={16}/>{notice}</p>}
      </div>
      {task && !modalOpen && <div className="pv-task-summary">{taskPanel(task)}{task.kind === 'import' && <button type="button" onClick={() => setImportOpen(true)}>打开导入详情<ChevronRight size={14}/></button>}{task.kind === 'upgrade' && <button type="button" onClick={() => setUpgradeOpen(true)}>查看升级结果<ChevronRight size={14}/></button>}</div>}
          <div className={`pv-dropzone${dragging ? ' pv-dragging' : ''}`} onDragOver={e => { if (e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes(VIDEO_DRAG_TYPE)) { e.preventDefault(); if (!locked && !importUnavailable) setDragging(true); } }} onDragLeave={() => setDragging(false)} onDrop={e => { setDragging(false); if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(VIDEO_DRAG_TYPE)) return; e.preventDefault(); if (!locked) acceptFiles(e.dataTransfer.files); }}>
            <Upload size={16}/><span>拖入一个视频到当前导入位置</span><button type="button" disabled={locked || !collection || importUnavailable || !!task && !terminal(task.receipt)} onClick={() => fileInput.current?.click()}>选择文件</button>
          </div>
          {!collection && loading && <p className="pv-empty">正在读取项目视频…</p>}
          {view === 'prompts' && childFolderCount > 0 && <div className="pv-cards pv-folder-cards" role="group" aria-label="当前层子文件夹">{folderCards}</div>}
          {groups.map(group => <section key={group.id} className="pv-group">
            {view === 'prompts' && <header><h2>{group.title}<small>{group.videos.length} 个视频</small></h2>{group.text && <details><summary>查看完整参考提示词</summary><pre>{group.text}</pre></details>}</header>}
            <div className="pv-cards" role="group" aria-label={view === 'videos' ? '当前目录的文件夹与视频' : group.title}>{view === 'videos' && folderCards}{group.videos.map(video => <div className="pv-card-entry" key={video.id}><button type="button" className={`pv-card${selectedId === video.id ? ' pv-selected' : ''}`} aria-pressed={selectedId === video.id} draggable={video.managed && !readOnly && !operationPending} onDragStart={e => { e.dataTransfer.setData(VIDEO_DRAG_TYPE, JSON.stringify({projectId, videoId: video.id})); e.dataTransfer.effectAllowed = 'move'; }} onClick={() => setSelectedId(video.id)} onDoubleClick={() => { setSelectedId(video.id); setExpandedId(video.id); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); if (!e.repeat) { setSelectedId(video.id); setExpandedId(video.id); } } }} aria-haspopup="dialog" aria-keyshortcuts="Enter" title="单击选择，双击查看原视频；也可按 Enter 打开">
              <span className="pv-thumbnail">{(video.thumbnailUrl || video.thumbUrl) ? <img src={video.thumbnailUrl || video.thumbUrl} alt="" loading="lazy" onError={e => { e.currentTarget.hidden = true; }}/>: null}<Film size={30} aria-hidden="true"/><span>{duration(video.durationMs)}</span></span>
              <span className="pv-card-body"><strong title={video.name || video.fileName}>{video.name || video.fileName}</strong><small className="pv-card-folder" title={video.folderName || video.fileName}>{video.folderName || (video.folderId === 'root' ? '项目根目录' : '未核对目录')}</small><span className="pv-badges"><span className={video.adoptedShots.length ? 'pv-adopted' : 'pv-candidate'}>{video.adoptedShots.length ? `已采用 · ${video.adoptedShots.length} 镜` : '候选'}</span>{!video.managed && <span>待升级</span>}{video.status !== 'available' && <span className="pv-card-status" data-status={video.status} title={statusLabel[video.status]}>{statusLabel[video.status]}</span>}</span><small className="pv-card-prompt">{video.promptId ? prompts.find(p => p.id === video.promptId)?.title || '已关联参考提示词' : '无参考提示词'}</small></span>
            </button></div>)}</div>
          </section>)}
          {!loading && !filtered.length && <div className="pv-empty"><Film size={32}/><h2>{videos.length ? '没有符合筛选条件的视频' : folderId === 'all' ? '本项目还没有生成视频' : '当前目录还没有视频'}</h2><p>{videos.length ? '调整名称、提示词或采用状态筛选。' : childFolderCount ? '可进入上方子文件夹，或导入视频到当前目录。' : '导入一个生成结果，保存后即可在分镜中采用。'}</p></div>}
        </section>
        <aside className="pv-detail" aria-label="视频详情">
          {selected && draft ? <>
            <header><small>视频详情</small><h2 title={selected.name || selected.fileName}>{selected.name || selected.fileName}</h2></header>
            {draft.expectedRevision !== selected.revision && <p className="pv-error">资料已被其他操作更新，草稿仍保留。请核对最新资料后重新编辑保存。</p>}
            <form className="pv-detail-form" onSubmit={e => { e.preventDefault(); if (!locked) void saveVideo(selected, draft); }}>
              <fieldset disabled={locked}><legend className="pv-sr-only">编辑视频资料</legend>
                <PromptFields value={draft.prompt} prompts={prompts} disabled={locked} onChange={prompt => setEdits(old => ({ ...old, [selected.id]: { ...draft, prompt } }))}/>
                <div className="pv-basic-fields"><h3>视频资料</h3>
                <label className="pv-field">视频名称<input value={draft.title} required onChange={e => setEdits(old => ({ ...old, [selected.id]: { ...draft, title: e.target.value } }))}/></label>
                <label className="pv-field">备注（可选）<textarea value={draft.notes} rows={2} onChange={e => setEdits(old => ({ ...old, [selected.id]: { ...draft, notes: e.target.value } }))}/></label>
                </div>
                <div className="pv-actions"><button className="pv-primary" type="submit" disabled={!editChanged || !draft.title.trim() || !promptValid(draft.prompt, prompts) || draft.expectedRevision !== selected.revision}>保存资料</button>{editChanged && <button type="button" onClick={() => setEdits(old => { const next = { ...old }; delete next[selected.id]; return next; })}>放弃草稿，使用当前资料</button>}</div>
              </fieldset>
            </form>
            <div className="pv-badges"><span>{statusLabel[selected.status]}</span><span>{selected.managed ? '项目托管副本' : '旧视频 · 待升级'}</span></div>
            {!selected.managed && <p className="pv-notice">旧视频保留既有采用。请先显式升级为项目托管副本，再到分镜中新增绑定。</p>}
            <details className="pv-file-info"><summary>文件信息与路径</summary><dl className="pv-metadata"><div><dt>原文件名</dt><dd>{selected.fileName}</dd></div><div><dt>时长 / 编码</dt><dd>{duration(selected.durationMs)} · {selected.codec || '未知编码'}</dd></div><div><dt>文件大小</dt><dd>{bytes(selected.bytes)}</dd></div><div><dt>存放位置</dt><dd className="pv-path">{selected.path || '未提供路径'}</dd></div></dl></details>
            <div className="pv-actions"><button type="button" disabled={locked || operationPending || !selected.managed} onClick={() => {setExpandedId(''); setFolderAction({kind: 'move-video', sourceId: selected.id, label: selected.name});}}>移动到…</button></div>
            <section className="pv-adoption"><h3>实际采用镜号</h3><p>{shotsLabel(selected.adoptedShots)}</p><button type="button" disabled={locked} onClick={onStoryboard}>前往分镜查看采用<ChevronRight size={14}/></button></section>
            <div className="pv-file-actions"><button type="button" disabled={locked} onClick={() => void run('正在访达中显示…', async () => { await api(`/videos/${encodeURIComponent(selected.id)}/reveal`, {}, 'POST'); })}><FolderOpen size={15}/>在访达中显示</button><button type="button" disabled={locked || unresolved} onClick={() => {
              if (terminal(taskRef.current?.receipt || null)) putTask(null);
              setConfirmation({ kind: 'relink', video: selected, path: '' });
            }} ref={relinkButton}>重新定位</button><button type="button" className="pv-danger" disabled={locked || unresolved || !collection} onClick={() => setConfirmation({ kind: 'remove', video: selected, adoptionStamp: collection!.adoptionStamp })}>移除视频记录</button></div>
          </> : <div className="pv-empty"><Film size={32}/><p>单击视频查看参考提示词与采用镜号，双击查看原视频。</p></div>}
        </aside>
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
