// 顶栏「待处理 N」入口 + 右侧抽屉（新画风，变量和配色同项目音乐的 .sg-music）。
// N 只算「要你拍板」且还没处理的卡；点过「稍后」的不算。只有你能在这里做决定；AI 和后台程序只放卡片、读决定、回报结果。
// 点「重做…」先弹确认框写清花费；确认后只是记下决定，拾光不会自己去执行，也不会花钱。
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {ArrowUpRight, ChevronDown, CircleAlert, Inbox, X} from 'lucide-react';
import {readPalette, type Palette} from '../project-music/palette';
import {beijingTime} from '../project-music/time';
import {startPolling} from './poll';
import type {Notice, NoticeAction, NoticeList, NoticesOpenLink, NoticesRequest} from './types';
import '../project-music/project-music.css';
import './notices.css';

const OPEN_INTERVAL = 10_000, CLOSED_INTERVAL = 30_000;
const DAY = 86_400_000, HOUR = 3_600_000;
const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');

/** 已经挂了多久：不到 1 小时写「刚刚」，不到 1 天写小时，其余写天。 */
export function hangingFor(since: number, now: number) {
  const d = Math.max(0, now - since);
  if (d < HOUR) return '刚刚';
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时`;
  return `${Math.floor(d / DAY)} 天`;
}

function ownerText(n: Notice) {
  if (n.unassigned) return null;
  return n.owner?.session || n.owner?.id || null;
}

function Card({n, now, busy, onAct, onRedo, onLink}: {n: Notice; now: number; busy: boolean; onAct: (n: Notice, a: NoticeAction) => void; onRedo: (n: Notice) => void; onLink: (n: Notice, i: number) => void}) {
  const owner = ownerText(n);
  const inflight = n.status === 'redo_decided' || n.status === 'running';
  const ended = n.group === 'ended';
  const since = inflight && n.decision ? n.decision.at : n.occurredAt;
  const tone = n.status === 'failed' ? 'is-danger' : n.status === 'done' || n.status === 'resolved' ? 'is-ok' : inflight ? 'is-accent' : '';
  return <article className={'sgn-card' + (ended ? ' is-ended' : '')} data-notice-id={n.id} data-status={n.status} aria-label={`${n.typeLabel}：${n.title}`}>
    <div className="sgn-card-top">
      <span className={'sgn-type' + (n.kind === 'decision' && !ended ? ' is-decision' : '')}>{n.typeLabel}</span>
      {(n.status !== 'open') && <span className={'sgn-state ' + tone}>{n.status === 'redo_decided' ? '已决定重做 · 等执行' : n.statusLabel}</span>}
    </div>
    <h3 className="sgn-title">{n.title}</h3>
    <p className="sgn-meta">
      <span>{n.sourceLabel}</span>
      <span aria-hidden="true">·</span>
      {owner ? <span>负责：{owner}</span> : <span className="sgn-unassigned" title={n.owner?.gone ? `原来负责的会话（${n.owner.session || n.owner.id}）已经不在了，等项目总监或开发统筹认领` : '还没有负责的会话，等项目总监或开发统筹认领'}>待分派</span>}
    </p>
    <p className="sgn-meta">
      <time dateTime={new Date(n.occurredAt).toISOString()}>{beijingTime(n.occurredAt)}</time>
      {!ended && <><span aria-hidden="true">·</span><span className="sgn-age">{now - since < HOUR ? (inflight ? '刚决定' : '刚出现') : `${inflight ? '决定后已过' : '已挂'} ${hangingFor(since, now)}`}</span></>}
      {ended && n.updatedAt && <><span aria-hidden="true">·</span><span>结束于 {beijingTime(n.updatedAt)}</span></>}
    </p>
    {n.context && <p className="sgn-context">{n.context}</p>}
    {n.costNote && n.kind === 'decision' && !ended && <p className="sgn-cost">{n.costNote}</p>}
    {n.result?.note && <p className="sgn-context">执行方回报：{n.result.note}</p>}
    {n.resolution && <p className="sgn-context">{n.resolution.note}</p>}
    {n.status === 'failed' && n.nextId && <p className="sgn-context">已经另开了一张新卡，等你重新决定。</p>}
    {(n.links.length > 0 || n.awaitingUser) && <div className="sgn-foot">
      {n.links.length > 0 && <div className="sgn-links">
        {n.links.map((l, i) => <button key={i} type="button" className="sgn-link" onClick={() => onLink(n, i)}>{l.label}<ArrowUpRight size={13} aria-hidden="true"/></button>)}
      </div>}
      {n.awaitingUser && <div className="sgn-actions">
        {n.kind === 'decision' ? <>
          <button type="button" className="sgn-btn is-primary" disabled={busy} onClick={() => onRedo(n)}>重做…</button>
          <button type="button" className="sgn-btn" disabled={busy} onClick={() => onAct(n, 'skip')}>知道了，不重做</button>
          {n.status === 'open' && <button type="button" className="sgn-btn is-ghost" disabled={busy} onClick={() => onAct(n, 'later')}>稍后</button>}
        </> : <button type="button" className="sgn-btn" disabled={busy} onClick={() => onAct(n, 'read')}>已读</button>}
      </div>}
    </div>}
  </article>;
}

function RedoConfirm({n, busy, error, onConfirm, onClose}: {n: Notice; busy: boolean; error: string; onConfirm: () => void; onClose: () => void}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('button.is-primary')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [busy, onClose]);
  const owner = ownerText(n);
  return <div className="sgn-backdrop" onPointerDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div ref={box} className="sgn-modal" role="dialog" aria-modal="true" aria-labelledby="sgn-redo-title">
      <h2 id="sgn-redo-title">确定重做？</h2>
      <p className="sgn-modal-target">{n.typeLabel} · {n.title}</p>
      <p className="sgn-modal-cost"><strong>花费</strong>{n.costNote || '来源没有写明花费，可能要花钱'}</p>
      <p className="sgn-modal-note">点了只是记下你的决定，拾光不会自己去执行。由{owner ? `「${owner}」` : '认领这张卡的会话'}去重做，做完回报结果；又失败会另开一张新卡。</p>
      {error && <p className="sgn-error" role="alert">{error}</p>}
      <footer>
        <button type="button" className="sgn-btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="sgn-btn is-primary" disabled={busy} onClick={onConfirm}>{busy ? '正在记下…' : '确定重做'}</button>
      </footer>
    </div>
  </div>;
}

export function NoticesEntry({request, onOpenLink}: {request: NoticesRequest; onOpenLink: NoticesOpenLink}) {
  const [open, setOpen] = useState(false), [list, setList] = useState<NoticeList | null>(null), [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState(''), [actionError, setActionError] = useState(''), [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Notice | null>(null), [confirmError, setConfirmError] = useState('');
  const [now, setNow] = useState(Date.now()), [palette, setPalette] = useState<Palette>(readPalette), [top, setTop] = useState<number>();
  const entry = useRef<HTMLButtonElement>(null), closeBtn = useRef<HTMLButtonElement>(null), seq = useRef(0);

  const refresh = useCallback(async (full: boolean) => {
    const id = ++seq.current;
    try {
      if (full) {
        const data = await request<NoticeList>('/notices');
        if (id !== seq.current) return;
        setList(data); setPending(data.summary.pending);
      } else {
        const data = await request<{summary: NoticeList['summary']}>('/notices/summary');
        if (id !== seq.current) return;
        setPending(data.summary.pending);
      }
      setError('');
    } catch (e) { if (id === seq.current) setError(message(e)); }
  }, [request]);

  // 最多一条轮询链（见 poll.ts）：页面从隐藏变回可见时不会多出一条。
  useEffect(() => startPolling(() => refresh(open), open ? OPEN_INTERVAL : CLOSED_INTERVAL), [open, refresh]);

  const show = useCallback(() => { setPalette(readPalette()); setNow(Date.now()); setActionError(''); setOpen(true); }, []);
  const hide = useCallback(() => { setOpen(false); setConfirm(null); entry.current?.focus(); }, []);
  useEffect(() => {
    if (!open) return;
    closeBtn.current?.focus();
    const t = setInterval(() => setNow(Date.now()), 60_000);
    const owns = () => { const a = document.activeElement, panel = document.getElementById('notices-drawer'); return !!a && (panel?.contains(a) || a === entry.current); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && owns()) { e.preventDefault(); e.stopPropagation(); hide(); } };
    const measure = () => { const bar = document.querySelector('.library-topbar'); setTop(bar ? Math.max(0, bar.getBoundingClientRect().bottom) : undefined); };
    const storage = (e: StorageEvent) => { if (e.key === 'shiguang.musicPalette.v1') setPalette(readPalette()); };
    measure();
    document.addEventListener('keydown', key, true); window.addEventListener('resize', measure); window.addEventListener('storage', storage);
    return () => { clearInterval(t); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', measure); window.removeEventListener('storage', storage); };
  }, [open, hide]);

  const decide = useCallback(async (n: Notice, action: NoticeAction) => {
    setBusy(n.id); setActionError(''); if (action === 'redo') setConfirmError('');
    try {
      await request(`/notices/${n.id}/decision`, {action, expectedRevision: n.revision, ...(action === 'redo' ? {costAcknowledged: true} : {})}, 'PATCH');
      if (action === 'redo') setConfirm(null);
      await refresh(true);
    } catch (e) {
      const err = e as Error & {code?: string; details?: {notice?: Notice}};
      const changed = err.code === 'REVISION_CONFLICT' || err.code === 'ALREADY_DECIDED';
      if (action === 'redo' && changed) {
        // 来源中途改了花费等：确认框换成最新的这张卡，再点「确定重做」用的就是新的版本号。
        const latest = err.details?.notice ?? await request<{notice: Notice}>(`/notices/${n.id}`).then(r => r.notice, () => null);
        if (latest?.awaitingUser) {
          setConfirm(latest);
          setConfirmError(latest.costNote !== n.costNote ? '这张卡刚刚有了变化，花费也变了，框里已经换成最新的，请再看一眼。' : '这张卡刚刚有了变化，框里已经换成最新的，请再看一眼。');
        } else {
          setConfirm(null);
          setActionError('这张卡刚刚有了变化，已经不用再决定了，已经刷新。');
        }
      } else {
        const text = changed ? '这张卡刚刚有了变化，已经刷新，请看一眼再决定。' : message(e);
        if (action === 'redo') setConfirmError(text); else setActionError(text);
      }
      await refresh(true);
    } finally { setBusy(null); }
  }, [request, refresh]);

  const link = useCallback((n: Notice, i: number) => {
    const l = n.links[i];
    if (!l) return;
    if (onOpenLink(l) !== false) hide();
    else setActionError('没能直接打开：这个项目可能已经不在当前素材库了；如果是当前页面有没保存的改动，确认之后会自动跳过去。');
  }, [onOpenLink, hide]);

  const notices = list?.notices ?? [];
  const groups = useMemo(() => ({
    decision: notices.filter(n => n.group === 'decision' && n.awaitingUser),
    inflight: notices.filter(n => n.group === 'decision' && !n.awaitingUser),
    info: notices.filter(n => n.group === 'info'),
    later: notices.filter(n => n.group === 'later'),
    ended: notices.filter(n => n.group === 'ended'),
  }), [notices]);
  const card = (n: Notice) => <Card key={n.id} n={n} now={now} busy={busy === n.id} onAct={(x, a) => void decide(x, a)} onRedo={x => { setConfirmError(''); setConfirm(x); }} onLink={link}/>;
  const count = pending ?? 0;

  return <>
    <button ref={entry} type="button" className={'sgn-entry' + (count ? ' has-pending' : '')} aria-expanded={open} aria-controls="notices-drawer"
      aria-label={count ? `待处理，${count} 件要你拍板` : '待处理'} title={error && !open ? `待处理读取失败：${error}` : '后台任务的结果：要你拍板的、只是告知的'} onClick={() => open ? hide() : show()}>
      <Inbox size={15} aria-hidden="true"/><span>待处理</span>{count > 0 && <b className="sgn-count">{count}</b>}
      {error && <CircleAlert size={13} aria-hidden="true" className="sgn-entry-alert"/>}
    </button>
    {open && createPortal(<aside className="sg-notices" id="notices-drawer" data-sg-palette={palette} aria-label="待处理" style={top === undefined ? undefined : {top}}>
      <header className="sgn-head">
        <div>
          <h2>待处理</h2>
          <p>后台任务的结果。只有你能在这里拍板；AI 只放卡片、读你的决定。</p>
        </div>
        <button ref={closeBtn} type="button" className="sgn-icon" aria-label="关闭待处理" onClick={hide}><X size={18}/></button>
      </header>
      <div className="sgn-body">
        {error && <p className="sgn-alert" role="alert"><CircleAlert size={15} aria-hidden="true"/><span>{list ? `刷新失败：${error}。下面是最后读到的内容。` : `没有读到待处理：${error}`}</span></p>}
        {actionError && <p className="sgn-alert" role="alert"><CircleAlert size={15} aria-hidden="true"/><span>{actionError}</span></p>}
        {!list && !error && <p className="sgn-empty">正在读取…</p>}
        {list && <>
          <section className="sgn-group" aria-labelledby="sgn-g-decision">
            <h3 id="sgn-g-decision">要你拍板<span className="sgn-group-count">{groups.decision.length}</span></h3>
            {groups.decision.length ? groups.decision.map(card) : <p className="sgn-empty">没有要你拍板的事。</p>}
            {groups.inflight.length > 0 && <>
              <h4 className="sgn-subhead">已决定，等执行<span className="sgn-group-count">{groups.inflight.length}</span></h4>
              {groups.inflight.map(card)}
            </>}
          </section>
          {groups.info.length > 0 && <section className="sgn-group" aria-labelledby="sgn-g-info">
            <h3 id="sgn-g-info">只是告知<span className="sgn-group-count">{groups.info.length}</span></h3>
            {groups.info.map(card)}
          </section>}
          {groups.later.length > 0 && <section className="sgn-group" aria-labelledby="sgn-g-later">
            <h3 id="sgn-g-later">稍后<span className="sgn-group-count">{groups.later.length}</span></h3>
            <p className="sgn-hint">不会自动提醒，卡片上写着已经挂了几天。</p>
            {groups.later.map(card)}
          </section>}
          <details className="sgn-group sgn-ended">
            <summary><h3>已结束<span className="sgn-group-count">{list.endedTotal}</span></h3><ChevronDown size={16} aria-hidden="true"/></summary>
            {groups.ended.length ? groups.ended.map(card) : <p className="sgn-empty">还没有结束的卡片。</p>}
            {list.endedTotal > groups.ended.length && <p className="sgn-hint">这里只列最近 {groups.ended.length} 张，更早的历史都保留着。</p>}
          </details>
        </>}
      </div>
      {confirm && <RedoConfirm n={confirm} busy={busy === confirm.id} error={confirmError} onConfirm={() => void decide(confirm, 'redo')} onClose={() => setConfirm(null)}/>}
    </aside>, document.body)}
  </>;
}
