// UPDREAM-PROGRESS-V1：顶栏「Updream 视频任务」入口 + 只读进度面板。
// 只展示本机后台跟进队列里明确登记的任务；不提供生成、暂停、继续、取消、重试或改目标。
// 网页只读本机接口：面板展开 3 秒一次，收起 15 秒一次，标签页隐藏时暂停；不会触发平台查询。
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Check, CircleAlert, Clapperboard, Copy, FolderOpen, History, X} from 'lucide-react';
import {notifyFeedback} from '../global-feedback';
import {markUpdreamRead, readAllUpdreamTasks, readUpdreamTasks, UPDREAM_OPEN_EVENT} from './api';
import {isFinished, needsAttention, STAGE_LABEL, UPDREAM_STAGES, type UpdreamRequest, type UpdreamStage, type UpdreamTask, type UpdreamTaskList, type UpdreamView} from './types';
import '../codex-task-drawer.css';
import './updream.css';

const OPEN_INTERVAL = 3000, CLOSED_INTERVAL = 15000;
const clock = (v?: number | null) => v ? new Date(v).toLocaleTimeString('zh-CN', {hour12: false}) : '';
const fullTime = (v?: number | null) => v ? new Date(v).toLocaleString('zh-CN', {hour12: false}) : '';
function ago(v: number, now: number) {
  const s = Math.max(0, Math.round((now - v) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(v), today = new Date(now);
  return d.toDateString() === today.toDateString() ? `今天 ${d.toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit'})}` : d.toLocaleString('zh-CN', {hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}
const ackKey = (id: string, version: string) => id + '@' + version;
type Tab = 'active' | 'attention' | 'done';
type Mode = 'recent' | 'history';
// 通知状态和视频结果互不影响；disabled / none 表示这项任务没有设通知，不显示。
const NOTIFY: Record<string, string> = {
  unprepared: '还没准备', prepared: '待发送', pending: '待发送', sending: '发送中', queued: '已排队', sent: '已发送', delivered: '已送达', answered: '已回复',
  send_uncertain: '发送结果不确定', failed: '发送失败（不影响视频结果）',
};
const NO_NOTIFY = new Set(['disabled', 'none']);
const IDENTITY: Record<string, [string, string] | undefined> = {
  unconfirmed: ['目标未核准', '首次交付前，素材库里的目标还没固定；这里只按登记时的信息显示'],
  other_library: ['不在当前素材库', '这项任务登记的目标属于另一个素材库，不能在这里打开'],
  unknown: ['目标待核对', '记录里没有可确认的目标'],
};

/** 读取本机状态。迟到的响应（比后来发出的请求晚回来）直接丢掉；读不到时保留最后已知状态。 */
function useUpdreamTasks(request: UpdreamRequest, open: boolean, mode: Mode) {
  const [recent, setRecent] = useState<(UpdreamTaskList & {complete: boolean}) | null>(null), [history, setHistory] = useState<UpdreamTaskList | null>(null);
  // 已读保护：记下每个「id@eventVersion」被服务端确认已读时的发号。所有列表共用一个发号器；
  // 任何读取请求只要发号早于这次确认，它带回来的同一版本一律按已读处理，不管另一个列表是否已经拿到了更新的结果。
  // 确认之后发出的请求以服务端为准；新 eventVersion 的键不同，照常提醒。条目很少（只有看过的任务），不需要清理。
  const issued = useRef(0), acked = useRef(new Map<string, number>());
  const settle = useCallback(<L extends UpdreamTaskList>(list: L, at: number): L => {
    let cleared = 0;
    const tasks = list.tasks.map(t => {
      if (!t.unread) return t;
      const ackAt = acked.current.get(ackKey(t.taskId, t.version));
      if (ackAt === undefined || at > ackAt) return t;
      cleared++; return {...t, unread: false};
    });
    return cleared ? {...list, tasks, summary: {...list.summary, unread: Math.max(0, list.summary.unread - cleared)}} : list;
  }, []);
  const [error, setError] = useState(''), [historyError, setHistoryError] = useState(''), [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0), applied = useRef(0), historySeq = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++seq.current, at = ++issued.current;
    try {
      const data = await readAllUpdreamTasks(request);
      if (id < applied.current) return;
      applied.current = id; setRecent(settle(data, at)); setError('');
    } catch (e) {
      if (id < applied.current) return;
      applied.current = id; setError((e as Error).message || '读取失败');
    }
  }, [request, settle]);
  const loadHistory = useCallback(async (offset = 0) => {
    const id = ++historySeq.current, at = ++issued.current; if (offset) setLoadingMore(true);
    try {
      const data = await readUpdreamTasks(request, 'history', offset);
      if (id !== historySeq.current) return;
      const fresh = settle(data, at);
      setHistory(old => offset && old ? {...fresh, offset: 0, tasks: [...old.tasks, ...fresh.tasks.filter(t => !old.tasks.some(o => o.taskId === t.taskId))]} : fresh); setHistoryError('');
    } catch (e) { if (id === historySeq.current) setHistoryError((e as Error).message || '读取失败'); }
    finally { if (id === historySeq.current) setLoadingMore(false); }
  }, [request, settle]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) { await refresh(); if (open && mode === 'history') await loadHistory(); }
      if (!stopped) timer = setTimeout(tick, open ? OPEN_INTERVAL : CLOSED_INTERVAL);
    };
    void tick();
    const visible = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [refresh, loadHistory, open, mode]);
  /** 服务端确认已记的才在本地清掉；版本对不上的（后台已有新版本）保持未读。 */
  const applyRead = useCallback((done: {taskId: string; version: string}[]) => {
    const at = ++issued.current;   // 确认到达时的发号：在此之前发出的读取都可能是确认前的旧状态
    for (const d of done) acked.current.set(ackKey(d.taskId, d.version), at);
    const clear = (list: UpdreamTaskList | null) => {
      if (!list) return list;
      let cleared = 0;
      const tasks = list.tasks.map(t => { if (t.unread && done.some(d => d.taskId === t.taskId && d.version === t.version)) { cleared++; return {...t, unread: false}; } return t; });
      return {...list, tasks, summary: {...list.summary, unread: Math.max(0, list.summary.unread - cleared)}};
    };
    setRecent(old => old && {...clear(old)!, complete: old.complete}); setHistory(clear);
  }, []);
  return {recent, history, error, historyError, loadingMore, refresh, loadHistory, applyRead};
}

/** 没有项目名时不把整串编号铺出来：显示「项目 + 前 8 位」，完整编号放在悬停提示和复制内容里。 */
const projectText = (t: UpdreamTask) => t.target.projectName ?? (t.target.projectId ? `项目 ${t.target.projectId.slice(0, 8)}` : null);
const targetText = (t: UpdreamTask) => [projectText(t), t.target.folderLabel].filter(Boolean).join(' / ') || '目标未记录';
const targetFull = (t: UpdreamTask) => [t.target.projectName ? `${t.target.projectName}（${t.target.projectId ?? '无编号'}）` : t.target.projectId, t.target.folderLabel].filter(Boolean).join(' / ') || '目标未记录';
function stateLabel(t: UpdreamTask, stale: boolean) {
  if (t.status === 'done') return '已入库';
  if (t.status === 'failed') return '失败';
  if (t.status === 'cancelled') return '已取消';
  if (t.status === 'review') return '待核对';
  return (stale ? '最后已知：' : '') + STAGE_LABEL[t.stage] + '中';
}

function copyText(t: UpdreamTask) {
  const identity = IDENTITY[t.target.identity]?.[0];
  const lines = [
    `Updream 任务 ${t.taskId}`,
    `名称：${t.name}`,
    `目标：${targetFull(t)}${identity ? `（${identity}）` : ''}`,
    `当前状态：${stateLabel(t, false)}`,
  ];
  if (t.lastCompleted) lines.push(`最后已完成步骤：${STAGE_LABEL[t.lastCompleted]}`);
  if (t.attention) lines.push(`需要留意：${[t.attention.code, t.attention.message].filter(Boolean).join(' · ')}`);
  lines.push(`上游最近成功更新：${fullTime(t.upstreamUpdatedAt) || '未知'}`);
  if (t.localRecordUpdatedAt) lines.push(`本机记录更新：${fullTime(t.localRecordUpdatedAt)}`);
  return lines.join('\n');
}
async function copy(t: UpdreamTask) {
  const text = copyText(t);
  try { await navigator.clipboard.writeText(text); }
  catch {
    const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    const ok = document.execCommand('copy'); area.remove();
    if (!ok) { notifyFeedback({kind: 'error', source: 'Updream 任务', message: '复制失败，浏览器没有允许写入剪贴板。'}); return; }
  }
  notifyFeedback({kind: 'success', source: 'Updream 任务', message: '已复制任务信息（不含账号和凭据）', key: 'updream-copy'});
}

function Steps({t}: {t: UpdreamTask}) {
  const at = UPDREAM_STAGES.indexOf(t.stage as typeof UPDREAM_STAGES[number]);
  const label = at < 0 ? `进度：${stateLabel(t, false)}，没有可确认的阶段` : `进度：第 ${at + 1} 步「${STAGE_LABEL[t.stage]}」，共 6 步`;
  return <ol className={'ud-steps' + (at < 0 ? ' is-unplaced' : '')} aria-label={label}>
    {UPDREAM_STAGES.map((s, i) => {
      const state = t.status === 'done' || i < at ? 'done' : i === at ? 'current' : 'todo';
      return <li key={s} className={'ud-step is-' + state} aria-current={i === at && t.status !== 'done' ? 'step' : undefined}>
        <i aria-hidden="true">{state === 'done' ? <Check size={10} strokeWidth={3}/> : null}</i><span>{STAGE_LABEL[s as UpdreamStage]}</span>
      </li>;
    })}
  </ol>;
}

function TaskCard({t, now, stale, onView, observe}: {t: UpdreamTask; now: number; stale: boolean; onView: UpdreamView; observe: (el: HTMLElement | null) => void}) {
  const kind = t.status === 'running' ? (t.attention ? 'error' : 'active') : t.status === 'done' ? (t.attention ? 'error' : 'done') : t.status === 'failed' ? 'error' : t.status === 'cancelled' ? 'cancelled' : 'unknown';
  const identity = IDENTITY[t.target.identity];
  const notify = NO_NOTIFY.has(t.notification) ? null : NOTIFY[t.notification] ?? '状态待核对';
  const canView = !!t.delivery?.canView && t.status === 'done';
  return <article ref={t.unread ? observe : undefined} data-task-id={t.taskId} data-version={t.version} className={`ud-card is-${kind}${t.unread ? ' is-unread' : ''}${stale && t.active ? ' is-stale' : ''}`}>
    <div className="ud-card-main">
      <div className="ud-card-head">
        <strong title={t.name}>{t.unread && <span className="ud-new" role="img" aria-label="未读"/>}<span className="ud-name">{t.name}</span></strong>
        <span className="ud-state">{(kind === 'error' || kind === 'unknown') && <CircleAlert size={13} aria-hidden="true"/>}{stateLabel(t, stale && t.active)}</span>
      </div>
      <div className="ud-target"><FolderOpen size={13} aria-hidden="true"/><span title={targetFull(t)}>{targetText(t)}</span>{identity && <em className="ud-unverified" title={identity[1]}>{identity[0]}</em>}</div>
      <Steps t={t}/>
      {t.status === 'running' && <p className="ud-detail">{STAGE_LABEL[t.stage]}中{t.progress !== null ? ` · ${Math.round(t.progress)}%` : '（没有可靠的百分比）'}</p>}
      {t.status === 'done' && <p className="ud-detail">已入库 · 原执行方回读核对通过</p>}
      {t.status === 'failed' && !t.attention && <p className="ud-detail">失败了，原因没有记录。</p>}
      {t.status === 'review' && <p className="ud-detail">状态待核对：记录不完整或无法确认，没有当成失败或完成。</p>}
      {t.status === 'cancelled' && <p className="ud-detail">任务已取消（不是在拾光里取消的）。</p>}
      {t.attention && <p className="ud-attention">{t.attention.message || '需要留意，原因没有记录。'}{t.attention.code && <code> {t.attention.code}</code>}</p>}
      {t.lastCompleted && t.status !== 'done' && <p className="ud-meta">最后已完成：{STAGE_LABEL[t.lastCompleted]}</p>}
      {t.stale && t.active && <p className="ud-meta ud-stale-line"><CircleAlert size={12} aria-hidden="true"/>本机记录{t.stale.since ? `自 ${ago(t.stale.since, now)}起` : '已有一段时间'}没有变化（不代表平台失败）</p>}
      <p className="ud-meta"><History size={12} aria-hidden="true"/>{t.upstreamUpdatedAt ? `上游最近成功更新 ${ago(t.upstreamUpdatedAt, now)}（${clock(t.upstreamUpdatedAt)}）` : '上游最近成功更新时间未知'}{t.localRecordUpdatedAt ? ` · 本机记录更新于 ${ago(t.localRecordUpdatedAt, now)}` : ''}</p>
      {notify && <p className={'ud-notify' + (t.notification === 'failed' || t.notification === 'send_uncertain' ? ' is-bad' : '')}>通知：{notify}</p>}
    </div>
    <footer>
      <button type="button" onClick={() => void copy(t)}><Copy size={13} aria-hidden="true"/>复制任务信息</button>
      {canView && <button type="button" onClick={() => void onView(t.delivery!.projectId, t.delivery!.videoId)}><FolderOpen size={13} aria-hidden="true"/>查看视频</button>}
    </footer>
  </article>;
}

/** onSummary：只给「新样子（试用）」顶栏的「后台任务」入口汇总用；不传时行为不变。 */
export function UpdreamTaskEntry({request, onView, onSummary}: {request: UpdreamRequest; onView: UpdreamView; onSummary?: (s: {active: number; attention: number; shown?: boolean}) => void}) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState<Mode>('recent'), [tab, setTab] = useState<Tab | null>(null), [now, setNow] = useState(Date.now());
  const {recent, history, error, historyError, loadingMore, refresh, loadHistory, applyRead} = useUpdreamTasks(request, open, mode);
  const entry = useRef<HTMLButtonElement>(null), close = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const pending = useRef(new Map<string, string>()), flushTimer = useRef<ReturnType<typeof setTimeout>>(), observer = useRef<IntersectionObserver | null>(null);
  const [readError, setReadError] = useState('');

  const show = useCallback((view: Mode) => { returnFocus.current = document.activeElement as HTMLElement | null; setMode(view); setOpen(true); }, []);
  const hide = useCallback(() => { setOpen(false); setMode('recent'); setTab(null); const back = returnFocus.current; (back && document.contains(back) ? back : entry.current)?.focus(); }, []);
  useEffect(() => { const on = (e: Event) => show((e as CustomEvent<{view?: Mode}>).detail?.view === 'recent' ? 'recent' : 'history'); window.addEventListener(UPDREAM_OPEN_EVENT, on); return () => window.removeEventListener(UPDREAM_OPEN_EVENT, on); }, [show]);
  useEffect(() => { if (open) { close.current?.focus(); if (mode === 'history') void loadHistory(); } }, [open, mode, loadHistory]);
  useEffect(() => {
    if (!open) return;
    // Escape 归属：焦点在 Updream 面板或入口上时由它先处理并截住，背后的其他抽屉（如 Codex 自由管家）不受影响；
    // 焦点在别的面板里时不抢；焦点不在任何控件上时，才按普通顺序处理。
    const owns = () => { const a = document.activeElement, panel = document.getElementById('updream-task-drawer'); return !!a && (panel?.contains(a) || a === entry.current); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]') || !owns()) return;
      e.preventDefault(); e.stopPropagation(); hide();
    };
    const idle = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      const a = document.activeElement; if (a && a !== document.body) return;
      e.preventDefault(); hide();
    };
    const t = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('keydown', key, true); document.addEventListener('keydown', idle);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('keydown', idle); clearInterval(t); };
  }, [open, hide]);

  // 已读：卡片真的进入面板可见区域后才记；按 id+eventVersion，后台有新版本会重新提醒。
  const flush = useCallback(() => {
    const items = [...pending.current].map(([taskId, version]) => ({taskId, version})); pending.current.clear();
    if (!items.length) return;
    markUpdreamRead(request, items).then(r => {
      const marked = new Set(r.marked ?? []); applyRead(items.filter(i => marked.has(i.taskId))); setReadError('');
    }).catch(e => setReadError((e as Error).message || '保存失败'));
  }, [request, applyRead]);
  useEffect(() => {
    if (!open) return;
    observer.current = new IntersectionObserver(entries => {
      for (const e of entries) {
        const el = e.target as HTMLElement, id = el.dataset.taskId, version = el.dataset.version;
        if (!id || !version || e.intersectionRatio < 0.6 || document.hidden) continue;
        pending.current.set(id, version);
      }
      clearTimeout(flushTimer.current); flushTimer.current = setTimeout(flush, 800);
    }, {threshold: [0.6]});
    // 首批卡片的 ref 回调早于这里执行（那时观察器还没建），补登记已经渲染出来的未读卡片。
    document.querySelectorAll<HTMLElement>('#updream-task-drawer .ud-card.is-unread').forEach(el => observer.current?.observe(el));
    return () => { observer.current?.disconnect(); observer.current = null; clearTimeout(flushTimer.current); };
  }, [open, flush]);
  const observe = useCallback((el: HTMLElement | null) => { if (el) observer.current?.observe(el); }, []);
  // 面板贴在顶栏下方（顶栏在窄屏会换行变高），和 Codex 任务面板的位置一致。
  const [top, setTop] = useState<number>();
  useEffect(() => {
    if (!open) return;
    const measure = () => { const bar = document.querySelector('.library-topbar'); setTop(bar ? Math.max(0, bar.getBoundingClientRect().bottom) : undefined); };
    measure(); window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  const summary = recent?.summary ?? {active: 0, unread: 0, attention: 0, showEntry: false};
  const tasks = recent?.tasks ?? [];
  const groups = useMemo(() => ({
    active: tasks.filter(t => t.active),
    attention: tasks.filter(t => !t.active && needsAttention(t)),
    done: tasks.filter(t => !t.active && isFinished(t)),
  }), [tasks]);
  const unreadIn = (list: UpdreamTask[]) => list.filter(t => t.unread).length;
  const attentionUnread = unreadIn(groups.attention), doneUnread = Math.max(0, summary.unread - attentionUnread);
  const defaultTab: Tab = groups.active.length ? 'active' : attentionUnread ? 'attention' : unreadIn(groups.done) ? 'done' : groups.attention.length ? 'attention' : 'done';
  const current = tab ?? defaultTab;
  const stale = !!error && !!recent;
  const queueBad = !!recent && (recent.queue.state === 'degraded' || recent.queue.state === 'unavailable');
  const visible = summary.showEntry;
  const summaryActive = summary.active, summaryAttention = attentionUnread + doneUnread;
  useEffect(() => { onSummary?.({active: summaryActive, attention: summaryAttention, shown: visible}); }, [onSummary, summaryActive, summaryAttention, visible]);
  const label = summary.active ? `Updream · 进行中 ${summary.active}` : 'Updream 视频任务';
  const list = mode === 'history' ? history?.tasks ?? [] : groups[current];
  const moreHistory = mode === 'history' && !!history && history.tasks.length < history.total;
  return <>
    {(visible || open) && <button ref={entry} type="button" className={'ud-entry' + (attentionUnread ? ' has-attention' : '')} aria-expanded={open} aria-controls="updream-task-drawer"
      title={stale ? '进度读取中断，显示最后已知状态' : queueBad ? '本机任务记录读取不完整' : 'Updream 视频任务'} onClick={() => open ? hide() : show('recent')}>
      <Clapperboard size={15} aria-hidden="true"/><span className="ud-entry-label">{label}</span><span className="ud-entry-short" aria-hidden="true">{summary.active || summary.unread || ''}</span>
      {(stale || queueBad) && <span className="ud-stale-icon" role="img" aria-label="进度待确认"><CircleAlert size={13}/></span>}
      {attentionUnread > 0 && <span className="ud-chip-att" aria-label={`${attentionUnread} 个待处理未查看`}>{attentionUnread} 待处理</span>}
      {doneUnread > 0 && <span className="codex-task-unread ud-chip-new" aria-label={`${doneUnread} 个新结果未查看`}>{doneUnread} 新</span>}
    </button>}
    {open && createPortal(<aside className="codex-task-drawer ud-drawer" id="updream-task-drawer" aria-label="Updream 视频任务" style={top === undefined ? undefined : {top}}>
      <header><div><h2>{mode === 'history' ? 'Updream 任务记录' : 'Updream 视频任务'}</h2><small>只显示本机登记过的任务，不扫描账号里的全部历史</small></div><button ref={close} type="button" aria-label="关闭 Updream 视频任务" onClick={hide}><X size={18}/></button></header>
      {mode === 'recent' && <nav aria-label="任务分类">
        {([['active', `进行中 ${groups.active.length}`], ['attention', `待处理 ${groups.attention.length}`], ['done', `已完成${unreadIn(groups.done) ? ` · ${unreadIn(groups.done)} 新` : ''}`]] as const).map(([key, text]) =>
          <button key={key} type="button" aria-pressed={current === key} onClick={() => setTab(key)}>{text}</button>)}
      </nav>}
      <p className="codex-task-observation">网页最近读取 {recent ? clock(recent.readAt) : '—'}{stale ? '（之后读取失败）' : ''} · 只读本机状态，多个窗口不会加快平台查询{recent?.preferences === 'unavailable' || readError ? ' · 已读状态暂时保存不了，提醒会继续显示' : ''}</p>
      {stale && <p className="codex-task-alert" role="alert"><CircleAlert size={15}/><span>本机进度读取中断：{error}。下面是最后已知状态，任务在后台照常进行，没有重复提交。</span></p>}
      {!recent && error && <p className="codex-task-alert" role="alert"><CircleAlert size={15}/><span>没有读到 Updream 任务：{error}</span></p>}
      {recent?.queue.state === 'unavailable' && <p className="codex-task-alert" role="status"><CircleAlert size={15}/><span>本机任务记录暂时读不了{recent.queue.reason ? `（${recent.queue.reason}）` : ''}。不影响素材库其他功能。</span></p>}
      {recent?.queue.state === 'degraded' && <p className="codex-task-alert" role="status"><CircleAlert size={15}/><span>任务记录不完整{recent.queue.invalidCount ? `：有 ${recent.queue.invalidCount} 条读不了，已跳过` : ''}{recent.queue.truncated ? '；记录太多，只读了一部分' : ''}。下面的列表可能不全。</span></p>}
      {recent && !recent.complete && mode === 'recent' && <p className="codex-task-alert" role="status"><CircleAlert size={15}/><span>登记的任务太多，最近视图只读了前 {recent.tasks.length} 条（共 {recent.total} 条）；更早的请在「查看全部记录」里看。</span></p>}
      {mode === 'history' && historyError && <p className="codex-task-alert" role="alert"><CircleAlert size={15}/><span>任务记录读取失败：{historyError}</span></p>}
      <div className="codex-task-list">
        {!recent && !error ? <p>正在读取任务…</p>
          : mode === 'history' && !history ? <p>正在读取任务记录…</p>
          : !list.length ? <p>{mode === 'history' ? (recent?.queue.state === 'absent' ? '本机还没有 Updream 任务记录。' : '没有已结束的任务记录。') : current === 'active' ? '暂无进行中的任务' : current === 'attention' ? '最近没有需要处理的任务' : '最近没有已完成的任务'}</p>
          : list.map(t => <TaskCard key={t.taskId} t={t} now={now} stale={stale && mode === 'recent'} onView={onView} observe={observe}/>)}
        {moreHistory && <button type="button" className="ud-load-more" disabled={loadingMore} onClick={() => void loadHistory(history!.tasks.length)}>{loadingMore ? '正在加载…' : '加载更早的记录'}</button>}
      </div>
      <div className="ud-drawer-foot">
        {mode === 'history'
          ? <button type="button" onClick={() => { setMode('recent'); void refresh(); }}>返回最近任务</button>
          : <button type="button" onClick={() => setMode('history')}><History size={13} aria-hidden="true"/>查看全部记录</button>}
      </div>
    </aside>, document.body)}
  </>;
}
