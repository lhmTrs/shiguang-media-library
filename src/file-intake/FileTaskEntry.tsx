import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Download, FolderInput, RefreshCw, X} from 'lucide-react';
import {notifyFeedback, useFeedbackToast} from '../global-feedback';
import {BatchDetails} from './BatchDetails';
import {INTAKE_API, batchLabel, encoded, errorMessage, knownRefusal, type IntakeBatch, type IntakeItem, type IntakeRequest, type IntakeStatus, type IntakeView, type ResolveInput} from './types';
import './file-intake.css';

type Uncertain = {itemId: string; status: IntakeItem['status']};
export function FileTaskEntry({request, onView}: {request: IntakeRequest; onView: IntakeView}) {
  const [open, setOpen] = useState(false), [visible, setVisible] = useState(() => !document.hidden), [status, setStatus] = useState<IntakeStatus | null>(null);
  const [batches, setBatches] = useState<IntakeBatch[]>([]), [selection, setSelection] = useState(''), [error, setError] = useState(''), [statusError, setStatusError] = useState(''), [readError, setReadError] = useState(''), [reading, setReading] = useState(false), [busy, setBusy] = useState(''), [installedMessage, setInstalledMessage] = useState('');
  const [history, setHistory] = useState(false), historyRef = useRef(false);
  const [uncertain, setUncertain] = useState<Record<string, Uncertain>>({});
  const mountedAt = useRef(Date.now()), completionRead = useRef(false), completionKey = useRef('');
  const api = useRef(request), alive = useRef(true), writing = useRef(false), batchRead = useRef(false), statusRead = useRef(false), readVersion = useRef(0), statusVersion = useRef(0), rows = useRef(batches), selectionRef = useRef(selection), openRef = useRef(open), entry = useRef<HTMLButtonElement>(null), close = useRef<HTMLButtonElement>(null), observed = useRef(new Map<string, string>());
  api.current = request; rows.current = batches; selectionRef.current = selection; openRef.current = open; historyRef.current = history;
  useFeedbackToast(error, {source: '文件任务'}); useFeedbackToast(statusError, {source: '文件任务状态'}); useFeedbackToast(readError, {source: '文件任务读取'});
  useEffect(() => {alive.current = true; const changed = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', changed); return () => {alive.current = false; readVersion.current++; statusVersion.current++; document.removeEventListener('visibilitychange', changed);};}, []);
  function installRows(next: IntakeBatch[]) {
    rows.current = next; setBatches(next);
    const shown = next.filter(b => !!b.acknowledged === historyRef.current);
    if (!shown.some(b => b.id === selectionRef.current)) {selectionRef.current = shown[0]?.id || ''; setSelection(selectionRef.current);}
    for (const batch of next) for (const item of batch.items) {
      const key = batch.id + ':' + item.id, previous = observed.current.get(key);
      if (!batch.acknowledged && previous && previous !== item.status && ['failed', 'unknown', 'source_retained'].includes(item.status)) notifyFeedback({kind: item.status === 'source_retained' ? 'warning' : 'error', source: '文件任务', message: item.name + '：' + (item.error || ({failed: '收纳失败', unknown: '结果待核对', source_retained: '已收纳，原文件未移除'} as Record<string, string>)[item.status]), key: 'intake:' + key + ':' + item.status});
      observed.current.set(key, item.status);
    }
  }
  function installBatch(value: IntakeBatch) {
    if (!value?.id || !Array.isArray(value.items)) throw Error('文件任务回执格式不符，请核对原任务');
    installRows(rows.current.some(b => b.id === value.id) ? rows.current.map(b => b.id === value.id ? value : b) : [value, ...rows.current].slice(0, 50));
  }
  async function readStatus(signal?: AbortSignal) {
    if (statusRead.current) return; statusRead.current = true;
    const version = ++statusVersion.current;
    try {
      const value = await api.current<IntakeStatus>(INTAKE_API + '/status', undefined, undefined, {signal});
      if (alive.current && version === statusVersion.current) {
        const completion = value.latestCompletion, key = completion ? completion.id + ':' + completion.updatedAt : '';
        if (completionRead.current && completion && key !== completionKey.current && completion.updatedAt > mountedAt.current) notifyFeedback({
          kind: completion.status === 'completed' ? 'success' : 'warning', source: '文件任务', key: 'file-intake-completion:' + key,
          message: completion.status === 'completed' ? '视频已收纳到' + completion.projectName : completion.projectName + '收纳结果：已收纳 ' + completion.completed + '，失败 ' + completion.failed + '，原件保留 ' + completion.retained,
        });
        completionRead.current = true; completionKey.current = key;
        setStatus(value); setStatusError('');
      }
    }
    catch (e) {if (alive.current && !signal?.aborted && version === statusVersion.current) setStatusError(errorMessage(e));}
    finally {statusRead.current = false;}
  }
  async function readBatches(signal?: AbortSignal) {
    if (writing.current || batchRead.current) return; batchRead.current = true;
    const version = ++readVersion.current; setReading(true);
    try {const value = await api.current<{batches: IntakeBatch[]}>(INTAKE_API + '/batches', undefined, undefined, {signal}); if (alive.current && version === readVersion.current) {installRows(value.batches); setReadError('');}}
    catch (e) {if (alive.current && !signal?.aborted && version === readVersion.current) setReadError(errorMessage(e));}
    finally {batchRead.current = false; if (alive.current && version === readVersion.current) setReading(false);}
  }
  useEffect(() => {
    if (!visible) return; let stopped = false, timer: ReturnType<typeof setTimeout>; const controller = new AbortController();
    const tick = async () => {if (stopped || document.hidden) return; await readStatus(controller.signal); if (!stopped) timer = setTimeout(tick, 5000);};
    void tick(); return () => {stopped = true; clearTimeout(timer); controller.abort(); statusVersion.current++;};
  }, [visible]);
  useEffect(() => {
    if (!open || !visible) return; let stopped = false, timer: ReturnType<typeof setTimeout>; const controller = new AbortController();
    const tick = async () => {if (stopped || document.hidden) return; await readBatches(controller.signal); if (!stopped) timer = setTimeout(tick, 1000);};
    void tick(); return () => {stopped = true; clearTimeout(timer); controller.abort(); readVersion.current++;};
  }, [open, visible]);
  useEffect(() => {
    if (!open) return; close.current?.focus(); const key = (event: KeyboardEvent) => {if (event.key === 'Escape') {event.preventDefault(); setOpen(false); entry.current?.focus();}};
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, [open]);

  async function mutate(batch: IntakeBatch, item: IntakeItem | null, suffix: string, body: unknown, label: string) {
    if (writing.current) return;
    const current = rows.current.find(b => b.id === batch.id), currentItem = current?.items.find(i => i.id === item?.id);
    if (item && (uncertain[batch.id] || !currentItem || currentItem.status !== item.status)) return;
    writing.current = true; readVersion.current++; setReading(false); setBusy(label); setError('');
    try {
      const value = await api.current<IntakeBatch>(INTAKE_API + '/batches/' + encoded(batch.id) + suffix, body);
      if (value.id !== batch.id || value.projectId !== batch.projectId || value.folderId !== batch.folderId || value.mode !== batch.mode) throw Error('回执固定目标不符，请保留原批次核对');
      if (!alive.current) return; installBatch(value);
      if (!item) setUncertain(old => {
        const pending = old[batch.id], nextItem = value.items.find(i => i.id === pending?.itemId);
        if (pending && nextItem?.status === pending.status) return old;
        const next = {...old}; delete next[batch.id]; return next;
      });
    } catch (e) {
      if (!alive.current) return;
      const refused = knownRefusal(e) || (e as {status?: number})?.status === 409;
      setError(batch.projectName + '：' + errorMessage(e) + (refused ? '。请核对更新后的原任务。' : '。响应未确认，不会自动重复操作。'));
      if (!refused && item) setUncertain(old => ({...old, [batch.id]: {itemId: item.id, status: item.status}}));
      if (refused) {
        try {const value = await api.current<IntakeBatch>(INTAKE_API + '/batches/' + encoded(batch.id)); if (alive.current && value.id === batch.id) installBatch(value);} catch { /* Keep the original error and inputs until another explicit check. */ }
      }
    } finally {writing.current = false; if (alive.current) {setBusy(''); if (!document.hidden) void readStatus();}}
  }
  async function install() {
    if (writing.current || !status?.supported || statusError) return;
    writing.current = true; setBusy('正在安装访达入口'); setError('');
    try {const value = await api.current<{installed: true; message: string}>(INTAKE_API + '/install', {}); if (alive.current) {setInstalledMessage(value.message || '已安装。首次使用请在系统设置中启用拾光快速操作。'); await readStatus();}}
    catch (e) {if (alive.current) setError(errorMessage(e));}
    finally {writing.current = false; if (alive.current) setBusy('');}
  }
  async function view(projectId: string, videoId?: string) {
    try {await onView(projectId, videoId); if (alive.current) setOpen(false);}
    catch (e) {if (alive.current) setError(errorMessage(e));}
  }
  const shown = batches.filter(b => !!b.acknowledged === history);
  const selected = shown.find(b => b.id === selection) || shown[0];
  function switchHistory(value: boolean) {
    historyRef.current = value; setHistory(value);
    selectionRef.current = rows.current.find(b => !!b.acknowledged === value)?.id || ''; setSelection(selectionRef.current);
  }
  return <div className="fi-root fi-entry">
    <button className="fi-entry-button" ref={entry} aria-expanded={open} aria-controls="file-intake-tasks" onClick={() => setOpen(v => !v)}><FolderInput size={17}/><span>文件任务</span>{!!status?.activeCount && <span className="fi-count">{status.activeCount}</span>}{!!status?.needsAttention && <span className="fi-attention">{status.needsAttention} 待处理</span>}</button>
    {open && createPortal(<aside className="fi-root fi-drawer" role="dialog" aria-label="文件任务" id="file-intake-tasks">
      <header className="fi-heading"><FolderInput size={21}/><div><h2>文件任务</h2><p>确认时的目标固定，关闭抽屉后仍在后台继续</p></div><button ref={close} aria-label="关闭文件任务" onClick={() => {setOpen(false); entry.current?.focus();}}><X size={18}/></button></header>
      <div className="fi-drawer-body">
        {statusError && <p className="fi-error" role="alert">状态读取失败：{statusError}</p>}
        {readError && <p className="fi-error" role="alert">任务读取失败：{readError}</p>}
        {error && <p className="fi-error" role="alert">{error}</p>}
        <div className="fi-task-tabs" role="group" aria-label="文件任务分类"><button aria-pressed={!history} onClick={() => switchHistory(false)}>最近任务</button><button aria-pressed={history} onClick={() => switchHistory(true)}>已处理</button></div>
        <div className="fi-task-toolbar"><label>最近批次<select aria-label="选择文件收纳批次" value={selected?.id || ''} onChange={e => {selectionRef.current = e.target.value; setSelection(e.target.value);}}><option value="" disabled>暂无收纳批次</option>{shown.map(b => <option key={b.id} value={b.id}>{b.projectName} / {b.folderName || '根目录'} · {batchLabel[b.status]} · {b.items.length} 项</option>)}</select></label><button disabled={reading || !!busy} aria-label="刷新文件任务" onClick={() => void readBatches()}><RefreshCw size={15}/></button></div>
        {busy && <p className="fi-muted" role="status">{busy}…</p>}
        {!selected && <div className="fi-empty"><FolderInput size={28}/><h3>{reading ? '正在读取文件任务…' : history ? '暂无已处理任务' : '暂无文件任务'}</h3><p>{history ? '标记已处理后可在这里查看原结果，并恢复待处理。' : '在访达选择视频，右键“收纳视频到拾光”，确认目标后在这里查看。'}</p></div>}
        {selected?.canAcknowledge && <div className="fi-acknowledge"><span>{selected.acknowledged ? '原始结果保留，可随时恢复。' : '已知结果可收起，不再计入待处理；不会重试或移除文件。'}</span><button disabled={!!busy || !!uncertain[selected.id]} onClick={() => void mutate(selected, null, '/acknowledge', {acknowledged: !selected.acknowledged, resultKey: selected.resultKey}, selected.acknowledged ? '正在恢复待处理' : '正在标记已处理')}>{selected.acknowledged ? '恢复待处理' : '标记已处理'}</button></div>}
        {selected && <BatchDetails batch={selected} busy={!!busy} uncertain={!!uncertain[selected.id]} onView={view} resolve={(item, input: ResolveInput) => {if (item.status === 'duplicate') void mutate(selected, item, '/items/' + encoded(item.id) + '/resolve', input, '正在处理此重名项');}} retry={item => {if (item.status === 'failed') void mutate(selected, item, '/items/' + encoded(item.id) + '/retry', {}, '正在重试此失败项');}} reconcile={() => void mutate(selected, null, '/reconcile', {}, '正在核对原回执')}/>}
        <section className="fi-install"><h3>访达右键入口</h3><p>{status ? !status.supported ? '当前系统不支持访达快速操作。' : status.installed ? '入口已安装。若菜单尚未出现，请在系统设置中启用拾光快速操作。' : '安装后可从访达右键收纳视频。首次使用需在系统设置中手动启用快速操作。' : '正在读取系统能力…'}</p><button disabled={!status?.supported || !!busy || !!statusError} onClick={() => void install()}><Download size={14}/>{status?.installed ? '重新安装访达入口' : '安装访达入口'}</button>{installedMessage && <p role="status">{installedMessage}</p>}</section>
      </div>
    </aside>, document.body)}
  </div>;
}
