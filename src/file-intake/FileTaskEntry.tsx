import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {AlertCircle, Check, Download, FolderInput, RefreshCw, Settings, X} from 'lucide-react';
import {notifyFeedback, useFeedbackToast} from '../global-feedback';
import {BatchDetails} from './BatchDetails';
import {INTAKE_API, batchLabel, encoded, errorMessage, knownRefusal, type IntakeBatch, type IntakeItem, type IntakeRequest, type IntakeStatus, type IntakeView, type InstallJob, type ResolveInput} from './types';
import './file-intake.css';

type Uncertain = {itemId: string; status: IntakeItem['status']};
// 访达入口安装反馈（INSTALL-FEEDBACK）：状态显示在按钮正下方；>3 秒展开真实阶段和已用时间；>2 分钟提示可能卡在编译器。
const SLOW_MS = 3000, STUCK_MS = 120000, RECENT_MS = 10 * 60 * 1000;
const STEPS: {stage: InstallJob['stage']; label: string}[] = [{stage: 'checking', label: '检查系统和旧入口'}, {stage: 'preparing-window', label: '准备窗口组件'}, {stage: 'writing', label: '写入右键入口'}, {stage: 'done', label: '完成'}];
const running = (job: InstallJob | null | undefined) => !!job && job.stage !== 'done' && job.stage !== 'failed';
const seconds = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'; };
const ago = (at: number, now: number) => { const d = Math.max(0, now - at); return d < 60000 ? '刚刚' : d < 3600000 ? Math.floor(d / 60000) + ' 分钟前' : d < 86400000 ? Math.floor(d / 3600000) + ' 小时前' : new Date(at).toLocaleString(); };
type SettingsState = {state: 'idle'} | {state: 'opening'} | {state: 'opened'; target: string} | {state: 'error'; message: string};
export function FileTaskEntry({request, onView}: {request: IntakeRequest; onView: IntakeView}) {
  const [open, setOpen] = useState(false), [visible, setVisible] = useState(() => !document.hidden), [status, setStatus] = useState<IntakeStatus | null>(null);
  const [batches, setBatches] = useState<IntakeBatch[]>([]), [selection, setSelection] = useState(''), [error, setError] = useState(''), [statusError, setStatusError] = useState(''), [readError, setReadError] = useState(''), [reading, setReading] = useState(false), [busy, setBusy] = useState('');
  const [history, setHistory] = useState(false), historyRef = useRef(false);
  const [uncertain, setUncertain] = useState<Record<string, Uncertain>>({});
  const [job, setJob] = useState<InstallJob | null>(null), [starting, setStarting] = useState(false), [installError, setInstallError] = useState(''), [now, setNow] = useState(() => Date.now()), [seenJob, setSeenJob] = useState(''), [settings, setSettings] = useState<SettingsState>({state: 'idle'});
  const jobRef = useRef<InstallJob | null>(null); jobRef.current = job;
  /** 只接受同一任务的更新状态或更新的任务，避免迟到的旧读数把进度往回拨。 */
  function acceptJob(next: InstallJob | null | undefined) {
    if (next === undefined) return;
    const old = jobRef.current;
    if (next && old && next.id === old.id && STEPS.findIndex(x => x.stage === next.stage) < STEPS.findIndex(x => x.stage === old.stage) && old.stage !== 'failed' && next.stage !== 'failed') return;
    if (next && old && next.id !== old.id && next.startedAt < old.startedAt) return;
    jobRef.current = next; setJob(next);
  }
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
          message: completion.status === 'completed' ? '素材已收纳到' + completion.projectName : completion.projectName + '收纳结果：已收纳 ' + completion.completed + '，失败 ' + completion.failed + '，原件保留 ' + completion.retained,
        });
        completionRead.current = true; completionKey.current = key;
        setStatus(value); setStatusError(''); acceptJob(value.installJob);
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
  const installing = running(job);
  useEffect(() => {
    if (!installing || !visible) return; let stopped = false; const controller = new AbortController();
    const timer = setInterval(() => {
      setNow(Date.now()); if (stopped) return;
      void api.current<{job: InstallJob | null}>(INTAKE_API + '/install/job', undefined, undefined, {signal: controller.signal}).then(value => {
        if (stopped || !alive.current) return; acceptJob(value.job); if (!running(value.job)) void readStatus();
      }).catch(() => { /* 读不到时保留最后已知状态，状态轮询也会继续带回 installJob */ });
    }, 1000);
    return () => {stopped = true; clearInterval(timer); controller.abort();};
  }, [installing, visible, job?.id]);
  // 抽屉打开时看到的结束结果，顶栏按钮上的 ✓ / ! 就收起
  useEffect(() => { if (open && job && !running(job)) setSeenJob(job.id); }, [open, job?.id, job?.stage]);
  useEffect(() => { if (!open) return; setNow(Date.now()); }, [open]);
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
      if (value.id !== batch.id || value.projectId !== batch.projectId || value.folderId !== batch.folderId || value.mode !== batch.mode || JSON.stringify(value.items.map(i=>i.destination))!==JSON.stringify(batch.items.map(i=>i.destination))) throw Error('回执固定目标不符，请保留原批次核对');
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
    if (starting || running(jobRef.current) || !status?.supported || statusError) return;
    setStarting(true); setInstallError(''); setSettings({state: 'idle'}); setNow(Date.now());
    try {const value = await api.current<{job: InstallJob}>(INTAKE_API + '/install/job', {}); if (alive.current) acceptJob(value.job);}
    catch (e) {if (alive.current) setInstallError(errorMessage(e));}
    finally {if (alive.current) setStarting(false);}
  }
  async function openSettings() {
    if (settings.state === 'opening') return; setSettings({state: 'opening'});
    try {const value = await api.current<{opened: boolean; target: string}>(INTAKE_API + '/open-services-settings', {}); if (alive.current) setSettings({state: 'opened', target: value.target});}
    catch (e) {if (alive.current) setSettings({state: 'error', message: errorMessage(e)});}
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
    <button className="fi-entry-button" ref={entry} aria-expanded={open} aria-controls="file-intake-tasks" onClick={() => setOpen(v => !v)}><FolderInput size={17}/><span>文件任务</span>{!!status?.activeCount && <span className="fi-count">{status.activeCount}</span>}{!!status?.needsAttention && <span className="fi-attention">{status.needsAttention} 待处理</span>}{installing ? <span className="fi-install-chip" role="img" aria-label="访达入口安装中"><span className="fi-spinner"/></span> : job && job.id !== seenJob && (job.finishedAt ?? 0) >= mountedAt.current ? <span className={'fi-install-chip ' + (job.stage === 'done' ? 'is-ok' : 'is-bad')} role="img" aria-label={job.stage === 'done' ? '访达入口已安装，未查看' : '访达入口安装没有完成，未查看'}>{job.stage === 'done' ? <Check size={13}/> : <AlertCircle size={13}/>}</span> : null}</button>
    {open && createPortal(<aside className="fi-root fi-drawer" role="dialog" aria-label="文件任务" id="file-intake-tasks">
      <header className="fi-heading"><FolderInput size={21}/><div><h2>文件任务</h2><p>确认时的目标固定，关闭抽屉后仍在后台继续</p></div><button ref={close} aria-label="关闭文件任务" onClick={() => {setOpen(false); entry.current?.focus();}}><X size={18}/></button></header>
      <div className="fi-drawer-body">
        {statusError && <p className="fi-error" role="alert">状态读取失败：{statusError}</p>}
        {readError && <p className="fi-error" role="alert">任务读取失败：{readError}</p>}
        {error && <p className="fi-error" role="alert">{error}</p>}
        <div className="fi-task-tabs" role="group" aria-label="文件任务分类"><button aria-pressed={!history} onClick={() => switchHistory(false)}>最近任务</button><button aria-pressed={history} onClick={() => switchHistory(true)}>已处理</button></div>
        <div className="fi-task-toolbar"><label>最近批次<select aria-label="选择文件收纳批次" value={selected?.id || ''} onChange={e => {selectionRef.current = e.target.value; setSelection(e.target.value);}}><option value="" disabled>暂无收纳批次</option>{shown.map(b => <option key={b.id} value={b.id}>{b.projectName} / {b.folderName || '根目录'} · {batchLabel[b.status]} · {b.items.length} 项</option>)}</select></label><button disabled={reading || !!busy} aria-label="刷新文件任务" onClick={() => void readBatches()}><RefreshCw size={15}/></button></div>
        {busy && <p className="fi-muted" role="status">{busy}…</p>}
        {!selected && <div className="fi-empty"><FolderInput size={28}/><h3>{reading ? '正在读取文件任务…' : history ? '暂无已处理任务' : '暂无文件任务'}</h3><p>{history ? '标记已处理后可在这里查看原结果，并恢复待处理。' : '在访达选择素材，右键“收纳素材到拾光”，确认目标后在这里查看。'}</p></div>}
        {selected?.canAcknowledge && <div className="fi-acknowledge"><span>{selected.acknowledged ? '原始结果保留，可随时恢复。' : '已知结果可收起，不再计入待处理；不会重试或移除文件。'}</span><button disabled={!!busy || !!uncertain[selected.id]} onClick={() => void mutate(selected, null, '/acknowledge', {acknowledged: !selected.acknowledged, resultKey: selected.resultKey}, selected.acknowledged ? '正在恢复待处理' : '正在标记已处理')}>{selected.acknowledged ? '恢复待处理' : '标记已处理'}</button></div>}
        {selected && <BatchDetails batch={selected} busy={!!busy} uncertain={!!uncertain[selected.id]} onView={view} resolve={(item, input: ResolveInput) => {if (item.status === 'duplicate') void mutate(selected, item, '/items/' + encoded(item.id) + '/resolve', input, '正在处理此重名项');}} retry={item => {if (item.status === 'failed') void mutate(selected, item, '/items/' + encoded(item.id) + '/retry', {}, '正在重试此失败项');}} reconcile={() => void mutate(selected, null, '/reconcile', {}, '正在核对原回执')}/>}
        <section className="fi-install"><h3>访达右键入口</h3><p>{status ? !status.supported ? '当前系统不支持访达快速操作。' : status.upgradeNeeded ? '原视频入口已安装，点击升级后可收纳图片和音频。' : status.installed ? '入口已安装。若菜单尚未出现，请在系统设置中启用拾光快速操作。' : '安装后可从访达右键收纳图片、视频、音乐和音效。首次使用需在系统设置中手动启用快速操作。' : '正在读取系统能力…'}</p>
          <button disabled={!status?.supported || !!statusError || installing || starting} aria-busy={installing || starting} onClick={() => void install()}>{installing || starting ? <><span className="fi-spinner"/>正在安装…</> : <><Download size={14}/>{job?.stage === 'failed' ? '重试安装' : status?.upgradeNeeded ? '升级访达入口' : status?.installed ? '重新安装访达入口' : '安装访达入口'}</>}</button>
          <InstallState job={job} starting={starting} error={installError} now={now} settings={settings} onSettings={() => void openSettings()}/>
        </section>
      </div>
    </aside>, document.body)}
  </div>;
}

/** 安装区按钮正下方的状态：进行中 / 慢 / 疑似卡住 / 成功（还差一步）/ 失败。 */
function InstallState({job, starting, error, now, settings, onSettings}: {job: InstallJob | null; starting: boolean; error: string; now: number; settings: SettingsState; onSettings: () => void}) {
  if (error) return <div className="fi-install-state is-bad" role="alert"><AlertCircle size={15}/><div><b>安装没有开始</b><p>{error}</p></div></div>;
  if (starting && !running(job)) return <div className="fi-install-state" role="status"><span className="fi-spinner"/><div>正在安装访达入口</div></div>;
  if (!job) return null;
  if (running(job)) {
    const elapsed = now - job.startedAt, at = STEPS.findIndex(x => x.stage === job.stage);
    if (elapsed < SLOW_MS) return <div className="fi-install-state" role="status"><span className="fi-spinner"/><div>正在安装访达入口</div></div>;
    return <div className="fi-install-state" role="status"><div className="fi-install-body">
      <b>正在安装 · 已用 {seconds(elapsed)}</b>
      <ol className="fi-install-steps">{STEPS.map((x, i) => <li key={x.stage} data-state={i < at ? 'done' : i === at ? 'active' : 'todo'}>{i < at ? <Check size={12}/> : i === at ? <span className="fi-spinner"/> : <i aria-hidden="true"/>}<span>{x.label}{x.stage === 'preparing-window' && job.window === 'compiling' ? <small>（本机编译，首次约 1–2 分钟）</small> : x.stage === 'preparing-window' && job.window === 'skipped' ? <small> · 已有，跳过</small> : null}</span></li>)}</ol>
      <p>{elapsed >= STUCK_MS ? '已超过 2 分钟仍未完成，可能卡在系统编译器。可以先关闭抽屉，稍后回来查看；安装结束前不会再开第二次。' : '可以关闭抽屉，安装会在后台继续；完成后这里和顶部「文件任务」按钮会显示结果。'}</p>
    </div></div>;
  }
  const when = job.finishedAt ?? job.startedAt;
  if (job.stage === 'done') {
    if (now - when > RECENT_MS) return null;
    return <div className="fi-install-state is-ok" role="status"><Check size={15}/><div className="fi-install-body">
      <b>已安装 · {ago(when, now)}{job.window === 'skipped' ? <small>（窗口组件已有，未重新编译）</small> : null}</b>
      <p>{job.message || '还差一步：在系统设置中启用拾光的快速操作。'}</p>
      <button type="button" disabled={settings.state === 'opening'} onClick={onSettings}><Settings size={14}/>{settings.state === 'opening' ? '正在打开…' : '打开系统设置'}</button>
      {settings.state === 'opened' && <p className="fi-install-hint">已打开系统设置{settings.target === 'services' ? '的「服务」' : '的「键盘」'}。{settings.target === 'services' ? '' : '请点「键盘快捷键…」→「服务」，'}按上面的说明勾选。勾选需要你在设置里完成，这里检测不到。</p>}
      {settings.state === 'error' && <p className="fi-install-hint is-bad" role="alert">没有打开系统设置：{settings.message}</p>}
    </div></div>;
  }
  return <div className="fi-install-state is-bad" role="alert"><AlertCircle size={15}/><div className="fi-install-body">
    <b>{job.error?.code === 'INSTALL_INTERRUPTED' ? '上次安装被中断' : '安装没有完成'} · {ago(when, now)}</b>
    <p>{job.error?.message || '安装失败，请重试。'}</p>
    {job.previousKept === true && <p>原来的右键入口保持不变，可以继续使用。</p>}
  </div></div>;
}
