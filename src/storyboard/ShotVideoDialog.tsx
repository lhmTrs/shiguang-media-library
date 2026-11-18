import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, Play, RotateCcw, X} from 'lucide-react';
import {bindPlaybackSpace} from '../playback-shortcuts';
import {
  MEDIA_STATUS_TEXT, REVIEW_FIELD_LABELS, canPlayStatus, clockLabel, coveredShotsText, defaultClip, estimateStart,
  newClipCount, safeMediaUrl, selectionChanges, startText,
  type SelectionAction, type SelectionChange, type ShotClip, type ShotVideoSummary,
} from './shot-video-model.mjs';
import type {ShotVideoApi} from './shot-video-api';
import './shot-video.css';

type Pending = { action: SelectionAction; clip: ShotClip; rows: SelectionChange[] };
type Props = {
  api: ShotVideoApi; shotId: string; shotNumber: string;
  summaries: Record<string, ShotVideoSummary>; onChanged: () => Promise<void> | void; onClose: () => void;
};

const actionTitle: Record<SelectionAction, string> = {
  'adopt-video': '采用这条片子', 'adopt-shot': '这一镜改用这条片子', 'clear-shot': '取消这一镜的采用', 'clear-video': '取消整条片子的采用',
};
const CONFLICT_CODES = new Set(['SELECTION_CONFLICT', 'BINDING_CONFLICT', 'REVIEW_CONFLICT']);
const timeText = (ms: number) => new Date(ms).toLocaleString('zh-CN', {hour12: false});

export function ShotVideoDialog({api, shotId, shotNumber, summaries, onChanged, onClose}: Props) {
  const [clips, setClips] = useState<ShotClip[] | null>(null);
  const [playing, setPlaying] = useState<ShotClip | null>(null);
  const [mediaError, setMediaError] = useState('');
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const root = useRef<HTMLElement>(null), video = useRef<HTMLVideoElement>(null), revision = useRef(0), storyboardRevision = useRef(0);
  const retry = useRef<{key: string; requestId: string} | null>(null), live = useRef(true);
  const summariesRef = useRef(summaries); summariesRef.current = summaries;
  const summary = summaries[shotId], adopted = summary?.adopted ?? null, fresh = newClipCount(summary);

  const load = useCallback(async () => {
    const next = await api.clips(shotId);
    if (!live.current) return;
    revision.current = next.selectionRevision; storyboardRevision.current = next.storyboardRevision;
    setClips(next.clips);
    // 只在第一次选片。之后重读列表不改变正在播放的片子。
    setPlaying(old => old ?? defaultClip(next.clips, summariesRef.current[shotId]));
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

  const estimate = useMemo(() => playing ? estimateStart(playing, shotId) : null, [playing, shotId]);
  const mediaUrl = playing ? safeMediaUrl(playing.mediaUrl, location.origin) : '';
  const playable = !!playing && canPlayStatus(playing.status) && !!mediaUrl;
  const seekToStart = () => { const el = video.current; if (el && estimate) el.currentTime = estimate.startMs / 1000; };
  const choose = (clip: ShotClip) => { setMediaError(''); setPlaying(clip); };

  const submit = async (key: string, send: (requestId: string) => Promise<void>, done: string, failed: string) => {
    const requestId = retry.current?.key === key ? retry.current.requestId : crypto.randomUUID();
    retry.current = {key, requestId};
    setBusy(true); setError(''); setNotice('');
    try {
      await send(requestId);
      retry.current = null; setPending(null);
      await Promise.all([onChanged(), load()]);
      if (live.current) setNotice(done);
    } catch (e) {
      const failure = e as Error & {code?: string; status?: number};
      if (failure.status) retry.current = null;
      if (!live.current) return;
      setPending(null);
      if (CONFLICT_CODES.has(failure.code ?? '')) {
        await Promise.all([onChanged(), load()]).catch(() => {});
        setError('其他窗口刚改过，这次没有写入。已读取最新结果，请核对后再操作。');
      } else setError(failure.message || failed);
    } finally { if (live.current) setBusy(false); }
  };
  const write = (action: SelectionAction, clip: ShotClip) => submit([action, clip.id, shotId, revision.current].join(':'),
    requestId => api.writeSelection({action, videoId: clip.id, shotId, expectedRevision: revision.current, requestId}),
    '已更新采用。正在播放的片子没有变。', '采用没有写入，请重试');
  const review = (action: 'mark' | 'undo', clip: ShotClip) => submit([action, clip.id, clip.bindingRevision, storyboardRevision.current].join(':'),
    requestId => api.writeReview({action, videoId: clip.id, expectedBindingRevision: clip.bindingRevision, storyboardRevision: storyboardRevision.current, requestId}),
    action === 'mark' ? '已标记复核。' : '已撤销复核，按原来的基准重新判断。', '复核没有写入，请重试');
  const request = (action: SelectionAction, clip: ShotClip) => {
    const {rows, needsConfirm} = selectionChanges(action, clip, shotId, summariesRef.current);
    if (needsConfirm) setPending({action, clip, rows}); else void write(action, clip);
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
      <div className="sv-body">
        <div className="sv-stage">
          {!clips && <div className="sv-screen sv-empty" role="status">正在读取片子…</div>}
          {clips && !playing && <div className="sv-screen sv-empty"><strong>这一镜还没有对应的片子</strong><span>到生成视频页右键片子，选「对应到分镜镜头…」。</span></div>}
          {playing && (playable
            ? <video key={playing.id} ref={video} className="sv-screen" aria-label={'正在播放 ' + playing.name} src={mediaUrl} controls playsInline preload="metadata"
                onLoadedMetadata={() => { seekToStart(); void video.current?.play().catch(() => {}); }}
                onError={() => setMediaError('这条视频无法读取或编码不受浏览器支持，请到生成视频页核对。')}/>
            : <div className="sv-screen sv-empty" role="alert"><AlertTriangle size={20}/><span>{MEDIA_STATUS_TEXT[playing.status] ?? '这条视频现在不能播放，请到生成视频页核对。'}</span></div>)}
          {mediaError && <p className="sv-message" data-tone="bad" role="alert">{mediaError}</p>}
          {playing && estimate && <div className="sv-now">
            <div><strong>{playing.name}</strong><small data-testid="sv-start">{startText(estimate)}</small></div>
            {playable && estimate.state === 'estimated' && <button type="button" onClick={seekToStart}><RotateCcw size={13}/>回到估算位置</button>}
          </div>}
        </div>
        <aside className="sv-clips" aria-label="这一镜的片子">
          <h3>这一镜的片子{clips ? ' · ' + clips.length + ' 条' : ''}</h3>
          {clips?.map(clip => {
            const isPlaying = clip.id === playing?.id, isAdopted = adopted?.videoId === clip.id;
            const adoptedElsewhere = clip.shots.some(shot => shot.currentNumber !== null && summaries[shot.shotId]?.adopted?.videoId === clip.id);
            return <article key={clip.id} className="sv-clip" data-playing={isPlaying} aria-label={clip.name}>
              <div className="sv-clip-title">
                <button type="button" className="sv-play" aria-pressed={isPlaying} aria-label={'播放 ' + clip.name} onClick={() => choose(clip)}><Play size={13}/></button>
                <strong>{clip.name}</strong><small>{clockLabel(clip.durationMs)}</small>
              </div>
              <div className="sv-tags">
                {isAdopted && <span data-tone="good">{adopted?.kind === 'shot' ? '这一镜单独选用' : '已采用'}</span>}
                {clip.needsReview && <span data-tone="warn" title={clip.reviewFields.map(f => REVIEW_FIELD_LABELS[f] ?? f).join('、')}>需复核</span>}
                {!canPlayStatus(clip.status) && <span data-tone="bad">不能播放</span>}
              </div>
              <p>覆盖 {coveredShotsText(clip)}</p>
              <p className="sv-source">照第 {clip.boundRevision} 版分镜 · {clip.origin === 'manual' ? '手动对应' : '生成时记录'} · {timeText(clip.boundAt)}</p>
              {clip.needsReview && !!clip.reviewFields.length && <p className="sv-source">有变化：{clip.reviewFields.map(f => REVIEW_FIELD_LABELS[f] ?? f).join('、')}</p>}
              {clip.review && <p className="sv-source">{clip.needsReview ? '上次复核到第 ' + clip.review.revision + ' 版，之后又有变化' : '已复核到第 ' + clip.review.revision + ' 版'} · {timeText(clip.review.at)}</p>}
              <div className="sv-actions">
                {clip.needsReview && <button type="button" disabled={busy} onClick={() => void review('mark', clip)}>已复核</button>}
                {clip.review && !clip.needsReview && <button type="button" disabled={busy} onClick={() => void review('undo', clip)}>撤销复核</button>}
                {!(isAdopted && adopted?.kind === 'video') && <button type="button" disabled={busy} onClick={() => request('adopt-video', clip)}>采用（{coveredShotsText(clip)}）</button>}
                {!(isAdopted && adopted?.kind === 'shot') && <button type="button" disabled={busy} onClick={() => request('adopt-shot', clip)}>只这一镜用</button>}
                {isAdopted && <button type="button" disabled={busy} onClick={() => request('clear-shot', clip)}>取消这一镜的采用</button>}
                {adoptedElsewhere && <button type="button" disabled={busy} onClick={() => request('clear-video', clip)}>取消整条的采用</button>}
              </div>
            </article>;
          })}
        </aside>
      </div>
      {pending && <div className="sv-confirm" role="alertdialog" aria-label={actionTitle[pending.action]}>
        <h3>{actionTitle[pending.action]}：确认前后变化</h3>
        <table><thead><tr><th>镜头</th><th>现在</th><th>确认后</th></tr></thead>
          <tbody>{pending.rows.map(row => <tr key={row.shotId}><td>镜 {row.number}</td><td>{row.beforeText}</td><td>{row.afterText}</td></tr>)}</tbody></table>
        <div className="sv-actions">
          <button type="button" disabled={busy} onClick={() => setPending(null)}>取消</button>
          <button type="button" className="sv-primary" disabled={busy} onClick={() => void write(pending.action, pending.clip)}>确认修改</button>
        </div>
      </div>}
    </section>
  </div>;
}
