// A/B 对比页（SPEC 3.4）：两版同时走，只放出其中一版；空格切换，停在同一位置。
// 响度按服务端估算对齐：只把较响的那版音量调低，不改原文件。盲听时显示 1 号、2 号，听完再揭晓。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ArrowLeft, Check, Eye, EyeOff, Flag, Pause, Play, Repeat, Star, Trash2, Volume2} from 'lucide-react';
import {Waveform} from './Waveform';
import {clock} from './Player';
import type {Request, Side, Song, Version} from './types';

const message = (e: unknown) => e instanceof Error ? e.message : String(e || '请求失败');
const uuid = (): string => crypto.randomUUID();
type Slot = 'left' | 'right';
const other = (s: Slot): Slot => s === 'left' ? 'right' : 'left';

export function defaultPair(song: Song): [string, string] | null {
  const all = song.rounds.flatMap(r => r.versions).filter(v => v.status !== 'rejected');
  if (all.length < 2) return null;
  const best = all.find(v => v.id === song.bestVersionId);
  const latest = [...all].reverse().find(v => v.id !== best?.id)!;
  // 默认：当前最好 对 最新版本；没有当前最好时比最新的两个。
  if (best) return [best.id, latest.id];
  return [all[all.length - 2].id, all[all.length - 1].id];
}

export function ComparePanel({song, projectId, request, initial, onChanged, onClose}: {
  song: Song; projectId: string; request: Request; initial: [string, string];
  onChanged: (s: Song) => void; onClose: () => void;
}) {
  const versions = useMemo(() => song.rounds.flatMap(r => r.versions), [song]);
  const [ids, setIds] = useState<Record<Slot, string>>({left: initial[0], right: initial[1]});
  const v: Record<Slot, Version | undefined> = {left: versions.find(x => x.id === ids.left), right: versions.find(x => x.id === ids.right)};
  const audio = useRef<Record<Slot, HTMLAudioElement | null>>({left: null, right: null});
  const [active, setActive] = useState<Slot>('left');
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState<Record<Slot, number>>({left: 0, right: 0});
  const [len, setLen] = useState<Record<Slot, number>>({left: 0, right: 0});
  const offset = useRef(0); // 右边相对左边的时间差（秒）。点歌词时两版各跳到自己的那一句，之后保持这个差。
  const [matched, setMatched] = useState(true);
  const [volume, setVolume] = useState(0.9);
  const [blind, setBlind] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [firstSlot, setFirstSlot] = useState<Slot>('left'); // 盲听时「1 号」是哪一边
  const [markers, setMarkers] = useState<{label: string; ms: number}[]>([]);
  const [segments, setSegments] = useState<{label: string; winner: Side; note: string}[]>([]);
  const [summary, setSummary] = useState('');
  const [winner, setWinner] = useState<Side | null>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [saved, setSaved] = useState<Song | null>(null);
  const requestId = useRef(uuid());

  const hidden = blind && !revealed;
  const slotNo = (s: Slot) => s === firstSlot ? 1 : 2;
  const name = (s: Slot) => hidden ? `${slotNo(s)} 号` : v[s] ? `第 ${v[s]!.roundNo} 轮 ${v[s]!.label}` : '未选择';
  const order: Slot[] = hidden ? [firstSlot, other(firstSlot)] : ['left', 'right'];

  // 响度对齐：只调低较响的一版。没有响度估算时不对齐，并如实说明。
  const gain = useMemo(() => {
    const a = v.left?.loudnessDb, b = v.right?.loudnessDb;
    if (a == null || b == null) return null;
    return a - b; // 正数：左边更响
  }, [v.left?.loudnessDb, v.right?.loudnessDb]);
  const levels: Record<Slot, number> = useMemo(() => {
    if (!matched || gain == null) return {left: volume, right: volume};
    return {left: volume * Math.pow(10, -Math.max(0, gain) / 20), right: volume * Math.pow(10, -Math.max(0, -gain) / 20)};
  }, [matched, gain, volume]);

  useEffect(() => {
    for (const s of ['left', 'right'] as Slot[]) {
      const a = audio.current[s];
      if (a) a.volume = s === active ? Math.min(1, levels[s]) : 0;
    }
  }, [active, levels]);

  // 两版一起走：只核对静音的那一版，偏差超过 40ms 才悄悄对齐，不打断正在听的那版。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const l = audio.current.left, r = audio.current.right;
      if (!l || !r) return;
      setPos({left: l.currentTime, right: r.currentTime});
      if (!playing) return;
      const lead = active === 'left' ? l : r, follow = active === 'left' ? r : l;
      const target = active === 'left' ? l.currentTime + offset.current : r.currentTime - offset.current;
      if (Number.isFinite(follow.duration) && target < follow.duration && Math.abs(follow.currentTime - target) > 0.04) follow.currentTime = Math.max(0, target);
      if (lead.ended) setPlaying(false);
    }, 250);
    return () => window.clearInterval(timer);
  }, [playing, active]);

  useEffect(() => () => { audio.current.left?.pause(); audio.current.right?.pause(); }, []);

  const playBoth = useCallback(() => {
    const l = audio.current.left, r = audio.current.right;
    if (!l || !r) return;
    r.currentTime = Math.max(0, l.currentTime + offset.current);
    Promise.all([l.play(), r.play()]).then(() => setPlaying(true)).catch(e => { if (e?.name !== 'AbortError') setError('浏览器没有开始播放，请再点一次'); });
  }, []);
  const pauseBoth = useCallback(() => { audio.current.left?.pause(); audio.current.right?.pause(); setPlaying(false); }, []);
  const seekTo = (seconds: number) => {
    const l = audio.current.left, r = audio.current.right;
    if (!l || !r) return;
    offset.current = 0;
    const t = Math.max(0, seconds);
    l.currentTime = t; r.currentTime = t;
    setPos({left: t, right: t});
  };
  const switchSide = useCallback(() => setActive(a => other(a)), []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input,textarea,select,[contenteditable="true"]')) return;
      if (e.key === ' ') { e.preventDefault(); switchSide(); }
      else if (e.key.toLowerCase() === 'k') { e.preventDefault(); playing ? pauseBoth() : playBoth(); }
    };
    // 焦点在按钮上时，浏览器会在空格抬起时「按下」那个按钮；这里只要切换，不要同时触发按钮。
    const up = (e: KeyboardEvent) => { if (e.key === ' ' && !(e.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]')) e.preventDefault(); };
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', up); };
  }, [switchSide, playing, pauseBoth, playBoth]);

  // 换了要对比的版本：停下，从头开始。
  useEffect(() => { pauseBoth(); offset.current = 0; setPos({left: 0, right: 0}); setSaved(null); }, [ids.left, ids.right, pauseBoth]);

  const lyrics = v.left?.lyricTimes && v.right?.lyricTimes ? {left: v.left.lyricTimes.lines, right: v.right.lyricTimes.lines} : null;
  const jumpLine = (i: number) => {
    const l = audio.current.left, r = audio.current.right;
    if (!l || !r || !lyrics) return;
    const a = (lyrics.left[i]?.startMs ?? 0) / 1000, b = (lyrics.right[i]?.startMs ?? lyrics.left[i]?.startMs ?? 0) / 1000;
    offset.current = b - a;
    l.currentTime = a; r.currentTime = b;
    setPos({left: a, right: b});
  };

  const activeTime = pos[active];
  const addMarker = () => setMarkers(m => [...m, {label: `标记 ${m.length + 1}`, ms: Math.round((active === 'left' ? activeTime : activeTime - offset.current) * 1000)}].sort((a, b) => a.ms - b.ms));
  const sideFromChoice = (choice: 1 | 2 | 'same'): Side => choice === 'same' ? 'same' : choice === 1 ? firstSlot : other(firstSlot);
  const choiceLabel = (s: Side) => s === 'same' ? '差不多' : `${name(s as Slot)} 更好`;

  const save = async () => {
    setSaving(true); setError('');
    try {
      const s = await request<Song>(`/project-music/projects/${projectId}/songs/${song.id}/comparisons`, {
        requestId: requestId.current, leftVersionId: ids.left, rightVersionId: ids.right, blind, markers,
        segments: segments.filter(x => x.label.trim()), summary, winner,
        loudness: gain == null ? null : {matched, gainDb: Math.abs(gain)},
      });
      onChanged(s); setSaved(s); setRevealed(true);
      requestId.current = uuid();
    } catch (e) { setError(message(e)); } finally { setSaving(false); }
  };
  const winnerVersion = winner && winner !== 'same' ? v[winner as Slot] : undefined;
  const setBest = async () => {
    if (!winnerVersion || !saved) return;
    setSaving(true); setError('');
    try { const s = await request<Song>(`/project-music/projects/${projectId}/songs/${song.id}`, {expectedRevision: saved.revision, bestVersionId: winnerVersion.id}, 'PATCH'); onChanged(s); setSaved(s); }
    catch (e) { setError(message(e)); } finally { setSaving(false); }
  };

  const options = versions.map(x => <option key={x.id} value={x.id}>{`第 ${x.roundNo} 轮 ${x.label}${x.isBest ? '（当前最好）' : ''}${x.status === 'rejected' ? '（淘汰区）' : ''}`}</option>);

  return <section className="sgm-compare" aria-label="A/B 对比">
    <header className="sgm-compare-head">
      <button type="button" className="sgm-btn ghost" onClick={() => { pauseBoth(); onClose(); }}><ArrowLeft size={16}/>返回</button>
      <h2>对比 · {song.title}</h2>
      <div className="sgm-compare-toggles">
        <button type="button" className="sgm-btn small sgm-choice" aria-pressed={matched} onClick={() => setMatched(m => !m)}>{matched ? <Check size={14}/> : <Volume2 size={14}/>}音量对齐</button>
        <button type="button" className="sgm-btn small sgm-choice" aria-pressed={blind}
          onClick={() => { setBlind(b => !b); setRevealed(false); setFirstSlot(Math.random() < 0.5 ? 'left' : 'right'); }}>{blind ? <EyeOff size={14}/> : <Eye size={14}/>}盲听</button>
        {blind && !revealed && <button type="button" className="sgm-btn small" onClick={() => setRevealed(true)}>揭晓</button>}
      </div>
    </header>

    {!hidden && <div className="sgm-compare-pick">
      <label className="sgm-field">左边<select aria-label="左边版本" value={ids.left} onChange={e => setIds(x => ({...x, left: e.target.value}))}>{options}</select></label>
      <label className="sgm-field">右边<select aria-label="右边版本" value={ids.right} onChange={e => setIds(x => ({...x, right: e.target.value}))}>{options}</select></label>
    </div>}
    <p className="sgm-hint">
      空格切换两版，停在同一位置；K 播放或暂停。
      {gain == null ? ' 有一版没有响度估算，音量没有对齐。' : matched ? ` 已对齐音量：${Math.abs(gain) < 0.1 ? '两版差不多响' : `${name(gain > 0 ? 'left' : 'right')} 调低 ${Math.abs(gain).toFixed(1)} dB`}（只在浏览器里调，不改原文件）。` : ' 音量未对齐，较响的一版会听起来更好，比较时请留意。'}
    </p>

    <div className="sgm-compare-tracks">
      {order.map(s => {
        const ver = v[s], length = len[s] || (ver?.durationMs ?? 0) / 1000, ended = !hidden && playing && length > 0 && pos[s] >= length - 0.05;
        // 盲听时不露出时长和波形：两版用同一时间刻度的中性进度条，只显示当前位置。
        const common = Math.max(len.left || (v.left?.durationMs ?? 0) / 1000, len.right || (v.right?.durationMs ?? 0) / 1000);
        return <div key={s} className={`sgm-compare-track ${active === s ? 'is-active' : ''}`}>
          <button type="button" className="sgm-compare-side" aria-pressed={active === s} aria-label={`听 ${name(s)}`} onClick={() => setActive(s)}>
            <span className="sgm-compare-badge">{hidden ? slotNo(s) : ver?.label ?? '?'}</span>
            <span><strong>{name(s)}</strong><small>{active === s ? (ended ? '这一版已播完' : '正在听') : '静音同步'}</small></span>
          </button>
          {hidden
            ? <div className="sgm-neutral-bar" role="slider" tabIndex={0} aria-label={`${name(s)} 播放位置`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={common ? Math.round(Math.min(1, pos[s] / common) * 100) : 0}
                onPointerDown={e => { const b = e.currentTarget.getBoundingClientRect(); seekTo(Math.max(0, Math.min(1, (e.clientX - b.left) / b.width)) * common); }}>
                <span style={{width: `${common ? Math.min(100, pos[s] / common * 100) : 0}%`}}/>
              </div>
            : <Waveform peaks={ver?.peaks ?? null} bars={140} progress={length ? Math.min(1, pos[s] / length) : 0} active={active === s}
                onSeek={f => seekTo(f * length)} label={`${name(s)} 波形`}/>}
          <span className="sgm-version-time">{hidden ? clock(pos[s] * 1000) : `${clock(pos[s] * 1000)} / ${clock(length * 1000)}`}</span>
          {ver && <audio ref={el => { audio.current[s] = el; }} src={ver.mediaUrl} preload="auto"
            onLoadedMetadata={e => { const d = e.currentTarget.duration; setLen(x => ({...x, [s]: Number.isFinite(d) ? d : 0})); }}/>}
        </div>;
      })}
    </div>

    <div className="sgm-compare-transport">
      <button type="button" className="sgm-play is-large" aria-label={playing ? '暂停两版' : '播放两版'} onClick={() => playing ? pauseBoth() : playBoth()}>{playing ? <Pause size={20}/> : <Play size={20}/>}</button>
      <button type="button" className="sgm-btn" onClick={switchSide}><Repeat size={16}/>切换（空格）</button>
      <button type="button" className="sgm-btn ghost" onClick={addMarker}><Flag size={15}/>在当前位置打点</button>
      <label className="sgm-player-volume" title="音量"><Volume2 size={16} aria-hidden="true"/><input type="range" aria-label="对比音量" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))}/></label>
    </div>

    {markers.length > 0 && <div className="sgm-markers" aria-label="段落标记">
      {markers.map((m, i) => <span key={i} className="sgm-marker">
        <button type="button" className="sgm-marker-jump" onClick={() => seekTo(m.ms / 1000)} aria-label={`跳到 ${m.label}`}>{clock(m.ms)}</button>
        <input aria-label={`标记 ${i + 1} 名称`} value={m.label} maxLength={40} onChange={e => setMarkers(list => list.map((x, j) => j === i ? {...x, label: e.target.value} : x))}/>
        <button type="button" className="sgm-icon" aria-label={`删除标记 ${m.label}`} onClick={() => setMarkers(list => list.filter((_, j) => j !== i))}><Trash2 size={14}/></button>
      </span>)}
    </div>}

    {lyrics && <div className="sgm-compare-lyrics" aria-label="歌词（点一句，两版各跳到自己的那一句）">
      <p className="sgm-hint">歌词时间由 AI 提供（{v.left?.lyricTimes?.method}）。点一句，两版各跳到自己的那一句。</p>
      <ol>{lyrics.left.map((l, i) => <li key={i}><button type="button" onClick={() => jumpLine(i)}>{l.text}</button></li>)}</ol>
    </div>}

    <div className="sgm-compare-result">
      <h3>比完记一下</h3>
      <div className="sgm-compare-winner" role="radiogroup" aria-label="整体哪一版更好">
        {([1, 2, 'same'] as const).map(c => {
          const side = hidden ? sideFromChoice(c) : c === 'same' ? 'same' : c === 1 ? 'left' : 'right';
          return <button key={String(c)} type="button" role="radio" aria-checked={winner === side} className="sgm-btn small sgm-choice" onClick={() => setWinner(w => w === side ? null : side)}>{winner === side && <Check size={14} aria-hidden="true"/>}{choiceLabel(side)}</button>;
        })}
      </div>
      <label className="sgm-field">一句话结果（选填，也可以按段落记）<textarea rows={2} value={summary} maxLength={2000} onChange={e => setSummary(e.target.value)} placeholder="例如：副歌 2 号好，前奏 1 号好"/></label>
      {segments.map((sg, i) => <div key={i} className="sgm-segment-row">
        <input aria-label={`第 ${i + 1} 段名称`} value={sg.label} maxLength={40} placeholder="段落，如 副歌" onChange={e => setSegments(l => l.map((x, j) => j === i ? {...x, label: e.target.value} : x))}/>
        <select aria-label={`第 ${i + 1} 段结果`} value={sg.winner} onChange={e => setSegments(l => l.map((x, j) => j === i ? {...x, winner: e.target.value as Side} : x))}>
          {order.map(s => <option key={s} value={s}>{name(s)} 更好</option>)}<option value="same">差不多</option>
        </select>
        <button type="button" className="sgm-icon" aria-label={`删除第 ${i + 1} 段`} onClick={() => setSegments(l => l.filter((_, j) => j !== i))}><Trash2 size={14}/></button>
      </div>)}
      <div className="sgm-block-actions">
        <button type="button" className="sgm-btn small ghost" onClick={() => setSegments(l => [...l, {label: markers[l.length]?.label ?? '', winner: order[0], note: ''}])}>按段落记一条</button>
        <button type="button" className="sgm-btn small primary" disabled={saving || (!summary.trim() && !winner && !segments.some(x => x.label.trim()))} onClick={save}>{saving ? '保存中…' : '保存对比结果'}</button>
      </div>
      {saved && <p className="sgm-note" role="status">已存进第 {saved.rounds.find(r => r.comparisons.some(c => c.left.versionId === ids.left && c.right.versionId === ids.right))?.roundNo ?? ''} 轮的记录。{blind && `1 号是 ${name(firstSlot)}，2 号是 ${name(other(firstSlot))}。`}
        {winnerVersion && !winnerVersion.isBest && saved.bestVersionId !== winnerVersion.id && <button type="button" className="sgm-btn small" disabled={saving} onClick={setBest}><Star size={13}/>把 {name(winner as Slot)} 设为当前最好</button>}
        {winnerVersion && saved.bestVersionId === winnerVersion.id && <span className="sgm-pill accent">已是当前最好</span>}
      </p>}
      {error && <p className="sgm-error" role="alert">{error}</p>}
    </div>
  </section>;
}
