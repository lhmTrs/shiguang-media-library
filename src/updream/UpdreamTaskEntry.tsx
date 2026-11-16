// UPDREAM-PROGRESS-V1：顶栏「Updream 视频任务」入口 + 只读进度面板。
// 只展示本机后台跟进队列里明确登记的任务；不提供生成、暂停、继续、取消、重试或改目标。
// 网页只读本机接口：面板展开 3 秒一次，收起 15 秒一次，标签页隐藏时暂停；不会触发平台查询。
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Check, CircleAlert, Clapperboard, Copy, FolderOpen, History, X} from 'lucide-react';
import {notifyFeedback} from '../global-feedback';
import {markUpdreamRead, readUpdreamTasks, UPDREAM_OPEN_EVENT} from './api';
import {isActive, isFailed, isImported, isUncertain, STAGE_LABEL, UPDREAM_STAGES, type UpdreamCounts, type UpdreamRequest, type UpdreamStage, type UpdreamTask, type UpdreamTaskList, type UpdreamView} from './types';
import '../codex-task-drawer.css';
import './updream.css';

const OPEN_INTERVAL = 3000, CLOSED_INTERVAL = 15000;
const clock = (v?: number | null) => v ? new Date(v).toLocaleTimeString('zh-CN', {hour12: false}) : '';
const fullTime = (v?: number | null) => v ? new Date(v).toLocaleString('zh-CN', {hour12: false}) : '';
function ago(v: number | null | undefined, now: number) {
  if (!v) return '暂无记录';
  const s = Math.max(0, Math.round((now - v) / 1000));
  if (s < 10) return '刚刚';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  const d = new Date(v), today = new Date(now);
  return d.toDateString() === today.toDateString() ? `今天 ${d.toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit'})}` : d.toLocaleString('zh-CN', {hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'});
}
const sameCounts = (a?: UpdreamCounts, b?: UpdreamCounts) => !!a && !!b && a.active === b.active && a.attention === b.attention && a.unread === b.unread;
type Tab = 'active' | 'attention' | 'done';
type Mode = 'recent' | 'history';

/** 读取本机状态。迟到的响应（比后来发出的请求晚回来）直接丢掉；读不到时保留最后已知状态。 */
function useUpdreamTasks(request: UpdreamRequest, open: boolean, mode: Mode) {
  const [recent, setRecent] = useState<UpdreamTaskList | null>(null), [history, setHistory] = useState<UpdreamTaskList | null>(null);
  const [error, setError] = useState(''), [historyError, setHistoryError] = useState(''), [loadingMore, setLoadingMore] = useState(false);
  const seq = useRef(0), applied = useRef(0), historySeq = useRef(0);
  const refresh = useCallback(async () => {
    const id = ++seq.current;
    try {
      const data = await readUpdreamTasks(request, 'recent');
      if (id < applied.current) return;
      applied.current = id; setRecent(data); setError('');
    } catch (e) {
      if (id < applied.current) return;
      applied.current = id; setError((e as Error).message || '读取失败');
    }
  }, [request]);
  const loadHistory = useCallback(async (cursor?: string | null) => {
    const id = ++historySeq.current; if (cursor) setLoadingMore(true);
    try {
      const data = await readUpdreamTasks(request, 'history', cursor);
      if (id !== historySeq.current) return;
      setHistory(old => cursor && old ? {...data, tasks: [...old.tasks, ...data.tasks.filter(t => !old.tasks.some(o => o.taskId === t.taskId))]} : data); setHistoryError('');
    } catch (e) { if (id === historySeq.current) setHistoryError((e as Error).message || '读取失败'); }
    finally { if (id === historySeq.current) setLoadingMore(false); }
  }, [request]);
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
  const applyRead = useCallback((done: {taskId: string; version: string}[], counts: UpdreamCounts) => {
    const clear = (list: UpdreamTaskList | null) => list && {...list, counts: sameCounts(list.counts, counts) ? list.counts : counts, tasks: list.tasks.map(t => done.some(d => d.taskId === t.taskId && d.version === t.version) ? {...t, unread: false} : t)};
    setRecent(clear); setHistory(clear);
  }, []);
  return {recent, history, error, historyError, loadingMore, refresh, loadHistory, applyRead};
}

function copyText(t: UpdreamTask) {
  const lines = [
    `Updream 任务 ${t.taskId}`,
    `名称：${t.name}`,
    `目标：${targetText(t)}${t.target.state === 'verified' ? '' : '（目标未核准）'}`,
    `当前阶段：${STAGE_LABEL[t.stage]}${isFailed(t) ? '（失败）' : t.stageState === 'unknown' ? '（待核对）' : ''}`,
    `最后已完成步骤：${t.lastCompletedStage ? STAGE_LABEL[t.lastCompletedStage] : '无'}`,
  ];
  if (t.error) lines.push(`异常：${[t.error.code, t.error.message].filter(Boolean).join(' · ')}`);
  lines.push(`上游最近成功更新：${fullTime(t.upstreamUpdatedAt) || '暂无记录'}`);
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
const targetText = (t: UpdreamTask) => [t.target.projectName, t.target.folderLabel].filter(Boolean).join(' / ') || '目标未记录';

function stateLabel(t: UpdreamTask, stale: boolean) {
  if (isImported(t)) return '已入库';
  if (isFailed(t)) return `${STAGE_LABEL[t.stage]}失败`;
  if (isUncertain(t)) return '待核对';
  return (stale ? '最后已知：' : '') + STAGE_LABEL[t.stage] + '中';
}

function Steps({t}: {t: UpdreamTask}) {
  const at = UPDREAM_STAGES.indexOf(t.stage as typeof UPDREAM_STAGES[number]);
  const last = t.lastCompletedStage ? UPDREAM_STAGES.indexOf(t.lastCompletedStage as typeof UPDREAM_STAGES[number]) : -1;
  return <ol className="ud-steps" aria-label={at < 0 ? '进度：阶段待核对' : `进度：第 ${at + 1} 步「${STAGE_LABEL[t.stage]}」，共 6 步`}>
    {UPDREAM_STAGES.map((s, i) => {
      const state = isImported(t) ? 'done' : i < at || (at < 0 && i <= last) ? 'done' : i === at ? (isFailed(t) ? 'error' : t.stageState === 'unknown' ? 'unknown' : 'current') : 'todo';
      return <li key={s} className={'ud-step is-' + state} aria-current={i === at ? 'step' : undefined}>
        <i aria-hidden="true">{state === 'done' ? <Check size={10} strokeWidth={3}/> : state === 'error' ? '!' : state === 'unknown' ? '?' : null}</i><span>{STAGE_LABEL[s as UpdreamStage]}</span>
      </li>;
    })}
  </ol>;
}

function TaskCard({t, now, stale, onView, observe}: {t: UpdreamTask; now: number; stale: boolean; onView: UpdreamView; observe: (el: HTMLElement | null) => void}) {
  const cardStale = stale || !!t.stale;
  const kind = isImported(t) ? 'done' : isFailed(t) ? 'error' : isUncertain(t) ? 'unknown' : 'active';
  const notify = t.notification && t.notification.state !== 'none' ? t.notification : null;
  return <article ref={t.unread ? observe : undefined} data-task-id={t.taskId} data-version={t.version} className={`ud-card is-${kind}${t.unread ? ' is-unread' : ''}${cardStale && kind === 'active' ? ' is-stale' : ''}`}>
    <div className="ud-card-main">
      <div className="ud-card-head">
        <strong title={t.name}>{t.unread && <span className="ud-new" role="img" aria-label="未读"/>}<span className="ud-name">{t.name}</span></strong>
        <span className="ud-state">{kind === 'error' && <CircleAlert size={13} aria-hidden="true"/>}{stateLabel(t, cardStale)}</span>
      </div>
      <div className="ud-target"><FolderOpen size={13} aria-hidden="true"/><span>{targetText(t)}</span>{t.target.state !== 'verified' && <em className="ud-unverified" title="首次交付前，素材库里的目标还没固定；这里只按登记时的信息显示">目标未核准</em>}</div>
      <Steps t={t}/>
      {kind === 'active' && <p className="ud-detail">{STAGE_LABEL[t.stage]}中{t.stage === 'generate' ? '（平台没有提供百分比）' : ''}</p>}
      {kind === 'error' && <p className="ud-detail">{t.error?.message || '这一步失败了，原因没有记录。'}{t.error?.code && <code> {t.error.code}</code>}</p>}
      {kind === 'unknown' && <p className="ud-detail">状态待核对：记录不完整或版本未知，没有当成失败或完成。</p>}
      {kind === 'done' && <div className="ud-result"><p className="ud-detail">已入库 {t.result!.videos.length} 条视频 · 入库回读核对通过</p>
        <ul>{t.result!.videos.slice(0, 4).map(v => <li key={v.videoId}><button type="button" className="ud-link" onClick={() => void onView(v.projectId, v.videoId)}><FolderOpen size={12} aria-hidden="true"/>{v.name}</button></li>)}
          {t.result!.videos.length > 4 && <li className="ud-more">另有 {t.result!.videos.length - 4} 条</li>}</ul></div>}
      {kind !== 'done' && t.lastCompletedStage && <p className="ud-meta">最后已完成：{STAGE_LABEL[t.lastCompletedStage]}</p>}
      <p className="ud-meta"><History size={12} aria-hidden="true"/>上游最近成功更新 {ago(t.upstreamUpdatedAt, now)}{t.upstreamUpdatedAt ? `（${clock(t.upstreamUpdatedAt)}）` : ''}</p>
      {t.stale && <p className="ud-meta ud-stale-line"><CircleAlert size={12} aria-hidden="true"/>跟进中断{t.stale.since ? `：${ago(t.stale.since, now)}起没有新状态` : ''}{t.stale.reason ? `（${t.stale.reason}）` : ''}</p>}
      {notify && <p className={'ud-notify' + (notify.state === 'failed' ? ' is-bad' : '')}>通知：{({sent: '已发送', failed: '发送失败（不影响视频结果）', pending: '待发送', unknown: '状态待核对', none: ''} as const)[notify.state]}</p>}
      {t.alsoInFileTasks && <p className="ud-meta">这次导入也显示在「文件任务」里，是同一笔记录。</p>}
    </div>
    <footer><button type="button" onClick={() => void copy(t)}><Copy size={13} aria-hidden="true"/>复制任务信息</button></footer>
  </article>;
}

export function UpdreamTaskEntry({request, onView}: {request: UpdreamRequest; onView: UpdreamView}) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState<Mode>('recent'), [tab, setTab] = useState<Tab | null>(null), [now, setNow] = useState(Date.now());
  const {recent, history, error, historyError, loadingMore, refresh, loadHistory, applyRead} = useUpdreamTasks(request, open, mode);
  const entry = useRef<HTMLButtonElement>(null), close = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement | null>(null);
  const pending = useRef(new Map<string, string>()), flushTimer = useRef<ReturnType<typeof setTimeout>>(), observer = useRef<IntersectionObserver | null>(null);

  const show = useCallback((view: Mode) => { returnFocus.current = document.activeElement as HTMLElement | null; setMode(view); setOpen(true); }, []);
  const hide = useCallback(() => { setOpen(false); setMode('recent'); setTab(null); const back = returnFocus.current; (back && document.contains(back) ? back : entry.current)?.focus(); }, []);
  useEffect(() => { const on = (e: Event) => show((e as CustomEvent<{view?: Mode}>).detail?.view === 'recent' ? 'recent' : 'history'); window.addEventListener(UPDREAM_OPEN_EVENT, on); return () => window.removeEventListener(UPDREAM_OPEN_EVENT, on); }, [show]);
  useEffect(() => { if (open) { close.current?.focus(); if (mode === 'history') void loadHistory(); } }, [open, mode, loadHistory]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('dialog[open]')) { e.preventDefault(); hide(); } };
    const t = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); clearInterval(t); };
  }, [open, hide]);

  // 已读：卡片真的进入面板可见区域、停留片刻后才记；按 taskId+version，后台有新版本会重新提醒。
  const flush = useCallback(() => {
    const items = [...pending.current].map(([taskId, version]) => ({taskId, version})); pending.current.clear();
    if (!items.length) return;
    markUpdreamRead(request, items).then(r => applyRead(items, r.counts)).catch(() => { /* 记已读失败只影响提醒，不打扰；下次可见时再记 */ });
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

  const counts = recent?.counts ?? {active: 0, attention: 0, unread: 0};
  const tasks = recent?.tasks ?? [];
  const groups = useMemo(() => ({
    active: tasks.filter(t => isActive(t) || isUncertain(t)),
    attention: tasks.filter(isFailed),
    done: tasks.filter(isImported),
  }), [tasks]);
  const unreadIn = (list: UpdreamTask[]) => list.filter(t => t.unread).length;
  const defaultTab: Tab = groups.active.length ? 'active' : unreadIn(groups.attention) ? 'attention' : unreadIn(groups.done) ? 'done' : groups.attention.length ? 'attention' : 'done';
  const current = tab ?? defaultTab;
  const stale = !!error && !!recent;
  const visible = counts.active > 0 || counts.unread > 0;
  const label = counts.active ? `Updream · 进行中 ${counts.active}` : 'Updream 视频任务';
  const failedUnread = unreadIn(groups.attention), doneUnread = counts.unread - failedUnread;

  const list = mode === 'history' ? history?.tasks ?? [] : groups[current];
  return <>
    {(visible || open) && <button ref={entry} type="button" className={'ud-entry' + (failedUnread ? ' has-attention' : '')} aria-expanded={open} aria-controls="updream-task-drawer"
      title={stale ? '进度读取中断，显示最后已知状态' : 'Updream 视频任务'} onClick={() => open ? hide() : show('recent')}>
      <Clapperboard size={15} aria-hidden="true"/><span className="ud-entry-label">{label}</span><span className="ud-entry-short" aria-hidden="true">{counts.active || counts.unread || ''}</span>
      {stale && <span className="ud-stale-icon" role="img" aria-label="进度待确认"><CircleAlert size={13}/></span>}
      {failedUnread > 0 && <span className="ud-chip-att" aria-label={`${failedUnread} 个异常未查看`}>{failedUnread} 异常</span>}
      {doneUnread > 0 && <span className="codex-task-unread ud-chip-new" aria-label={`${doneUnread} 个新结果未查看`}>{doneUnread} 新</span>}
    </button>}
    {open && createPortal(<aside className="codex-task-drawer ud-drawer" id="updream-task-drawer" aria-label="Updream 视频任务" style={top === undefined ? undefined : {top}}>
      <header><div><h2>{mode === 'history' ? 'Updream 任务记录' : 'Updream 视频任务'}</h2><small>只显示本机登记过的任务，不扫描账号里的全部历史</small></div><button ref={close} type="button" aria-label="关闭 Updream 视频任务" onClick={hide}><X size={18}/></button></header>
      {mode === 'recent' && <nav aria-label="任务分类">
        {([['active', `进行中 ${groups.active.length}`], ['attention', `异常 ${groups.attention.length}`], ['done', `已完成${doneUnread > 0 ? ` · ${doneUnread} 新` : ''}`]] as const).map(([key, text]) =>
          <button key={key} type="button" aria-pressed={current === key} onClick={() => setTab(key)}>{text}</button>)}
      </nav>}
      <p className="codex-task-observation">网页最近读取 {recent ? clock(recent.observedAt) : '—'}{stale ? '（之后读取失败）' : ''} · 只读本机状态，多个窗口不会加快平台查询</p>
      {stale && <p className="codex-task-alert" role="alert"><CircleAlert size={15}/><span>本机进度读取中断：{error}。下面是最后已知状态，任务在后台照常进行，没有重复提交。</span></p>}
      {!recent && error && <p className="codex-task-alert" role="alert"><CircleAlert size={15}/><span>没有读到 Updream 任务：{error}</span></p>}
      {recent?.source.state === 'unreadable' && <p className="codex-task-alert" role="status"><CircleAlert size={15}/><span>本机任务记录读不了{recent.source.message ? `：${recent.source.message}` : ''}。不影响素材库其他功能。</span></p>}
      {recent?.source.state === 'partial' && <p className="codex-task-alert" role="status"><CircleAlert size={15}/><span>有部分任务记录不完整，已跳过{recent.source.message ? `：${recent.source.message}` : ''}。</span></p>}
      {mode === 'history' && historyError && <p className="codex-task-alert" role="alert"><CircleAlert size={15}/><span>任务记录读取失败：{historyError}</span></p>}
      <div className="codex-task-list">
        {!recent && !error ? <p>正在读取任务…</p>
          : mode === 'history' && !history ? <p>正在读取任务记录…</p>
          : !list.length ? <p>{mode === 'history' ? '本机还没有登记过 Updream 任务。' : current === 'active' ? '暂无进行中的任务' : current === 'attention' ? '最近没有异常任务' : '最近没有已完成的任务'}</p>
          : list.map(t => <TaskCard key={t.taskId} t={t} now={now} stale={stale && mode === 'recent'} onView={onView} observe={observe}/>)}
        {mode === 'history' && history?.nextCursor && <button type="button" className="ud-load-more" disabled={loadingMore} onClick={() => void loadHistory(history.nextCursor)}>{loadingMore ? '正在加载…' : '加载更早的记录'}</button>}
      </div>
      <div className="ud-drawer-foot">
        {mode === 'history'
          ? <button type="button" onClick={() => { setMode('recent'); void refresh(); }}>返回最近任务</button>
          : <button type="button" onClick={() => setMode('history')}><History size={13} aria-hidden="true"/>查看全部记录</button>}
      </div>
    </aside>, document.body)}
  </>;
}
