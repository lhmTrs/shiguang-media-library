import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, Play, RotateCcw, X} from 'lucide-react';
import {bindPlaybackSpace} from '../playback-shortcuts';
import {
  MEDIA_STATUS_TEXT, canPlayStatus, clockLabel, coveredShotsText, defaultClip, estimateStart, migrationText, newClipCount,
  originText, reviewReasonText, safeMediaUrl, selectionIntent, startText, wholeAdopted,
  type MigrationView, type SelectionAction, type SelectionIntent, type ShotClip, type ShotVideoSummary,
} from './shot-video-model.mjs';
import type {SelectionPreview, ShotVideoApi} from './shot-video-api';
import './video-binding-v2.css';

type Pending = { action: SelectionAction; intent: SelectionIntent; preview: SelectionPreview };
type Props = {
  api: ShotVideoApi; shotId: string; shotNumber: string;
  summaries: Record<string, ShotVideoSummary>; onChanged: () => Promise<void> | void; onClose: () => void;
};

const actionTitle: Record<SelectionAction, string> = {
  'adopt-video': '采用这条片子', 'adopt-shot': '这一镜改用这条片子', 'clear-shot': '取消这一镜的采用', 'clear-video': '取消整条片子的采用',
};
const CONFLICT_CODES = new Set(['VIDEO_SELECTION_CONFLICT', 'VIDEO_BINDING_CONFLICT', 'VIDEO_REVIEW_CONFLICT', 'STORYBOARD_CONFLICT', 'ASSET_CONTEXT_CHANGED', 'VIDEO_REPLACEMENT_CONFIRMATION_REQUIRED']);
const timeText = (ms: number) => new Date(ms).toLocaleString('zh-CN', {hour12: false});

export function ShotVideoDialog({api, shotId, shotNumber, summaries, onChanged, onClose}: Props) {
  const [clips, setClips] = useState<ShotClip[] | null>(null);
  const [playing, setPlaying] = useState<ShotClip | null>(null);
  const [mediaError, setMediaError] = useState(''), [mediaMs, setMediaMs] = useState<number | undefined>(undefined);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [migration, setMigration] = useState<MigrationView | null>(null), writesOff = !!migration?.blocked, relationUnknown = migration?.adoptionKnown === false;
  const root = useRef<HTMLElement>(null), confirmRef = useRef<HTMLDivElement>(null), video = useRef<HTMLVideoElement>(null), revision = useRef(0), storyboardRevision = useRef(0), picked = useRef(false);
  // 结果未知的写入：同一操作再点时原样重发同一请求，不重新预览。
  const retry = useRef<{key: string; requestId: string; again: () => Promise<void>} | null>(null), live = useRef(true);
  const summary = summaries[shotId], adopted = summary?.adopted ?? null, fresh = newClipCount(summary);

  const load = useCallback(async () => {
    const [next, state] = await Promise.all([api.clips(shotId), api.summaries()]);
    if (!live.current) return;
    revision.current = next.selectionRevision; storyboardRevision.current = next.storyboardRevision;
    setClips(next.clips); setMigration(next.migration ?? state.migration);
    // 只在第一次选片。之后重读列表不改变正在播放的片子；选片按刚读到的采用状态，不等角标轮询。
    if (!picked.current) { picked.current = true; setPlaying(defaultClip(next.clips, state.shots[shotId])); }
  }, [api, shotId]);

  useEffect(() => {
    live.current = true;
    load().catch(e => { if (live.current) { setClips([]); setError((e as Error).message || '片子列表读取失败'); } });
    return () => { live.current = false; };
  }, [load]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    if (!root.current) return;
    return bindPlaybackSpace(root.current, () => { const el = video.current; if (el) void (el.paused ? el.play().catch(() => {}) : el.pause()); });
  }, []);

  // 预览和写入时按钮会暂时禁用，焦点不能丢，否则 Esc 和 Tab 失效。
  useEffect(() => { if (pending) confirmRef.current?.focus(); }, [pending]);
  useEffect(() => { if (!busy && !pending && (!document.activeElement || document.activeElement === document.body)) root.current?.focus(); }, [busy, pending]);

  const estimate = useMemo(() => playing ? estimateStart(playing, shotId, mediaMs) : null, [playing, shotId, mediaMs]);
  const mediaUrl = playing ? safeMediaUrl(playing.mediaUrl, location.origin) : '';
  const playable = !!playing && canPlayStatus(playing.status) && !!mediaUrl;
  const seekToStart = (known = mediaMs) => { const el = video.current; if (el && playing) el.currentTime = estimateStart(playing, shotId, known).startMs / 1000; };
  const metadataLoaded = () => {
    const seconds = video.current?.duration, known = seconds && Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
    setMediaMs(known); seekToStart(known); void video.current?.play().catch(() => {});
  };
  const choose = (clip: ShotClip) => { setMediaError(''); setMediaMs(undefined); setPlaying(clip); };

  const failed = async (e: unknown, fallback: string) => {
    const failure = e as Error & {code?: string};
    if (!live.current) return;
    setPending(null);
    if (CONFLICT_CODES.has(failure.code ?? '')) {
      await Promise.all([onChanged(), load()]).catch(() => {});
      setError('其他窗口刚改过，或内容刚有变化，这次没有写入。已读取最新结果，请核对后再操作。');
    } else setError(failure.message || fallback);
  };
  const submit = async (key: string, send: (requestId: string) => Promise<void>, done: string, fallback: string) => {
    const requestId = retry.current?.key === key ? retry.current.requestId : crypto.randomUUID();
    retry.current = {key, requestId, again: () => submit(key, send, done, fallback)};
    setBusy(true); setError(''); setNotice('');
    try {
      await send(requestId);
      retry.current = null; setPending(null);
      await Promise.all([onChanged(), load()]);
      if (live.current) setNotice(done);
    } catch (e) {
      if ((e as {status?: number}).status) retry.current = null;
      await failed(e, fallback);
    } finally { if (live.current) setBusy(false); }
  };
  const commit = (key: string, intent: SelectionIntent, preview: SelectionPreview) => submit(key,
    requestId => api.writeSelection({intent, requestId, previewHash: preview.previewHash, confirmReplace: preview.requiresConfirmation}),
    '已更新采用。正在播放的片子没有变。', '采用没有写入，请重试');
  const review = (action: 'confirm' | 'undo', clip: ShotClip) => {
    if (writesOff) return;
    const seenStoryboardRevision = storyboardRevision.current;
    return submit([action, clip.id, clip.bindingRevision, seenStoryboardRevision, clip.comparisonHash].join(':'),
      requestId => api.writeReview({action, clip, seenStoryboardRevision, requestId}),
      action === 'confirm' ? '已标记复核。' : '已撤销复核，按原来的基准重新判断。', '复核没有写入，请重试');
  };
  const request = async (action: SelectionAction, clip: ShotClip) => {
    if (writesOff) return;
    const intent = selectionIntent(action, clip, shotId, {selectionRevision: revision.current, storyboardRevision: storyboardRevision.current});
    const key = JSON.stringify(intent);
    if (retry.current?.key === key) return retry.current.again();
    setBusy(true); setError(''); setNotice('');
    try {
      const preview = await api.previewSelection(intent);
      if (!live.current) return;
      if (!preview.rows.length) setNotice('没有需要改变的采用。');
      else if (preview.requiresConfirmation) setPending({action, intent, preview});
      else await commit(key, intent, preview);
    } catch (e) { await failed(e, '采用预览失败，请重试'); }
    finally { if (live.current) setBusy(false); }
  };

  const keydown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (pending) setPending(null); else if (!busy) onClose(); return; }
    if (e.key !== 'Tab') return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),video[controls]') ?? [])].filter(el => el.getClientRects().length);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === root.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  };

  return <div className="sv-overlay">
    <section ref={root} className="sv-dialog" role="dialog" aria-modal="true" aria-label={'镜 ' + shotNumber + ' 的片子'} tabIndex={-1} onKeyDown={keydown}>
      <header>
        <div><small>点镜头看片</small><h2>镜 {shotNumber}</h2></div>
        {fresh > 0 && <span className="sv-fresh" role="status">有 {fresh} 条新片子</span>}
        <button type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button>
      </header>
      {error && <p className="sv-message" data-tone="bad" role="alert">{error}</p>}
      {notice && <p className="sv-message" role="status">{notice}</p>}
      {migration && <p className="sv-message" data-tone={migration.status === 'failed' ? 'bad' : undefined} role="status">{migrationText(migration)}</p>}
      <div className="sv-body">
        <div className="sv-stage">
          {!clips && <div className="sv-screen sv-empty" role="status">正在读取片子…</div>}
          {clips && !playing && (relationUnknown
            ? <div className="sv-screen sv-empty" role="status"><AlertTriangle size={20}/><strong>暂时读不到这一镜对应的片子</strong><span>片子还在，可以到生成视频页播放。</span></div>
            : adopted
            ? <div className="sv-screen sv-empty" role="alert"><AlertTriangle size={20}/><strong>采用的片子暂时读不到</strong><span>没有自动换成别的片子，可以从右边选一条来看。</span></div>
            : <div className="sv-screen sv-empty"><strong>这一镜还没有对应的片子</strong><span>到生成视频页右键片子，选「对应到分镜镜头…」。</span></div>)}
          {playing && (playable
            ? <video key={playing.id} ref={video} className="sv-screen" aria-label={'正在播放 ' + playing.name} src={mediaUrl} controls playsInline preload="metadata"
                onLoadedMetadata={metadataLoaded}
                onError={() => setMediaError('这条视频无法读取或编码不受浏览器支持，请到生成视频页核对。')}/>
            : <div className="sv-screen sv-empty" role="alert"><AlertTriangle size={20}/><span>{MEDIA_STATUS_TEXT[playing.status] ?? '这条视频现在不能播放，请到生成视频页核对。'}</span></div>)}
          {mediaError && <p className="sv-message" data-tone="bad" role="alert">{mediaError}</p>}
          {playing && estimate && <div className="sv-now">
            <div><strong>{playing.name}</strong><small data-testid="sv-start">{startText(estimate)}</small></div>
            {playable && (estimate.state === 'estimated' || estimate.state === 'beyond-end') && <button type="button" onClick={() => seekToStart()}><RotateCcw size={13}/>回到估算位置</button>}
          </div>}
        </div>
        <aside className="sv-clips" aria-label="这一镜的片子">
          <h3>这一镜的片子{clips ? ' · ' + (relationUnknown ? '待确认' : clips.length + ' 条') : ''}</h3>
          {clips?.map(clip => {
            const isPlaying = clip.id === playing?.id, isAdopted = adopted?.videoId === clip.id;
            const adoptedElsewhere = clip.shots.some(shot => shot.currentNumber !== null && summaries[shot.shotId]?.adopted?.videoId === clip.id);
            const reasons = reviewReasonText(clip.reviewReasons);
            return <article key={clip.id} className="sv-clip" data-playing={isPlaying} aria-label={clip.name}>
              <div className="sv-clip-title">
                <button type="button" className="sv-play" aria-pressed={isPlaying} aria-label={'播放 ' + clip.name} onClick={() => choose(clip)}><Play size={13}/></button>
                <strong>{clip.name}</strong><small>{clockLabel(clip.durationMs)}</small>
              </div>
              <div className="sv-tags">
                {isAdopted && <span data-tone="good">{adopted?.kind === 'shot' ? '这一镜单独选用' : '已采用'}</span>}
                {clip.needsReview && <span data-tone="warn" title={reasons}>需复核</span>}
                {!canPlayStatus(clip.status) && <span data-tone="bad">不能播放</span>}
              </div>
              <p>覆盖 {coveredShotsText(clip)}</p>
              <p className="sv-source">{originText(clip)} · {timeText(clip.boundAt)}</p>
              {clip.needsReview && !!reasons && <p className="sv-source">有变化：{reasons}</p>}
              {clip.needsReview && !clip.canReview && <p className="sv-source">暂时不能复核：{clip.reviewBlockedReason || '当前内容无法核对'}</p>}
              {clip.review && <p className="sv-source">{clip.needsReview ? '上次复核到第 ' + clip.review.revision + ' 版，之后又有变化' : '已复核到第 ' + clip.review.revision + ' 版'} {clip.review.at ? ' · ' + timeText(clip.review.at) : ''}</p>}
              <div className="sv-actions">
                {clip.needsReview && <button type="button" disabled={busy || writesOff || !clip.canReview} onClick={() => void review('confirm', clip)}>已复核</button>}
                {clip.review && !clip.needsReview && <button type="button" disabled={busy || writesOff} onClick={() => void review('undo', clip)}>撤销复核</button>}
                {!wholeAdopted(clip, summaries) && <button type="button" disabled={busy || writesOff} onClick={() => void request('adopt-video', clip)}>采用（{coveredShotsText(clip)}）</button>}
                {!(isAdopted && adopted?.kind === 'shot') && <button type="button" disabled={busy || writesOff} onClick={() => void request('adopt-shot', clip)}>只这一镜用</button>}
                {isAdopted && <button type="button" disabled={busy || writesOff} onClick={() => void request('clear-shot', clip)}>取消这一镜的采用</button>}
                {adoptedElsewhere && <button type="button" disabled={busy || writesOff} onClick={() => void request('clear-video', clip)}>取消整条的采用</button>}
              </div>
            </article>;
          })}
        </aside>
      </div>
      {pending && <div ref={confirmRef} tabIndex={-1} className="sv-confirm" role="alertdialog" aria-label={actionTitle[pending.action]}>
        <h3>{actionTitle[pending.action]}：确认前后变化</h3>
        <table><thead><tr><th>镜头</th><th>现在</th><th>确认后</th></tr></thead>
          <tbody>{pending.preview.rows.map(row => <tr key={row.shotId}><td>镜 {row.number}</td><td>{row.beforeText}</td><td>{row.afterText}</td></tr>)}</tbody></table>
        <div className="sv-actions">
          <button type="button" disabled={busy} onClick={() => setPending(null)}>取消</button>
          <button type="button" className="sv-primary" disabled={busy} onClick={() => void commit(JSON.stringify(pending.intent), pending.intent, pending.preview)}>确认修改</button>
        </div>
      </div>}
    </section>
  </div>;
}
