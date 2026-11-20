// 页面底部播放条：行为沿用音乐库（播放/暂停、波形点按跳播、上一首/下一首、音量、空格键），外观按新画风重画。
// 用「想播放」意图 + 请求代次，避免快速切歌或亚秒音频出现「暂停后又自己播起来」。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pause, Play, SkipBack, SkipForward, Volume2, X} from 'lucide-react';
import {Waveform} from './Waveform';
// 能放进播放条的东西：歌曲版本，或者「文件」区里的一个音频（title 写文件名，没有轮次）。
export type Playable = {id: string; mediaUrl: string; peaks: number[] | null; durationMs: number | null; label: string; roundNo?: number; songId?: string; title?: string};

export const clock = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) return '--:--';
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const VOLUME_KEY = 'shiguang.musicVolume.v1';

export type PlayerState = ReturnType<typeof usePlayer>;

export function usePlayer(active: boolean) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Playable | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState('');
  const [volume, setVolumeState] = useState(() => {
    try { const v = Number(localStorage.getItem(VOLUME_KEY)); return v > 0 && v <= 1 ? v : 0.9; } catch { return 0.9; }
  });
  const wants = useRef(false), generation = useRef(0), pendingSeek = useRef<number | null>(null);

  if (!audio.current && typeof Audio !== 'undefined') audio.current = new Audio();

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    a.preload = 'metadata';
    const sync = () => { setPosition(a.currentTime); setDuration(Number.isFinite(a.duration) ? a.duration : 0); };
    const onMeta = () => {
      sync();
      if (pendingSeek.current != null && Number.isFinite(a.duration)) { a.currentTime = pendingSeek.current * a.duration; pendingSeek.current = null; }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => { wants.current = false; setPlaying(false); };
    const onError = () => { if (a.getAttribute('src')) { wants.current = false; setPlaying(false); setError('这个版本暂时无法播放：文件可能已变化或缺失'); } };
    a.addEventListener('timeupdate', sync); a.addEventListener('loadedmetadata', onMeta); a.addEventListener('durationchange', sync);
    a.addEventListener('play', onPlay); a.addEventListener('pause', onPause); a.addEventListener('ended', onEnded); a.addEventListener('error', onError);
    return () => {
      a.removeEventListener('timeupdate', sync); a.removeEventListener('loadedmetadata', onMeta); a.removeEventListener('durationchange', sync);
      a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause); a.removeEventListener('ended', onEnded); a.removeEventListener('error', onError);
      a.pause();
    };
  }, []);

  useEffect(() => { if (audio.current) audio.current.volume = volume; try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* 只在本页生效 */ } }, [volume]);
  useEffect(() => { if (!active && audio.current) { wants.current = false; audio.current.pause(); } }, [active]);

  const start = useCallback((ticket: number) => {
    const a = audio.current;
    if (!a || !wants.current || ticket !== generation.current) return;
    a.play().catch(e => { if (e?.name !== 'AbortError' && ticket === generation.current) { wants.current = false; setError('浏览器没有开始播放，请再点一次播放'); } });
  }, []);

  const play = useCallback((version: Playable, at: number | null = null) => {
    const a = audio.current;
    if (!a) return;
    setError('');
    const ticket = ++generation.current;
    wants.current = true;
    if (current?.id === version.id && a.getAttribute('src') === version.mediaUrl) {
      if (at != null && Number.isFinite(a.duration)) a.currentTime = at * a.duration;
      start(ticket);
      return;
    }
    setCurrent(version); setPosition(0); setDuration((version.durationMs ?? 0) / 1000);
    pendingSeek.current = at;
    a.src = version.mediaUrl;
    a.load();
    start(ticket);
  }, [current, start]);

  const pause = useCallback(() => { wants.current = false; generation.current++; audio.current?.pause(); }, []);
  const toggle = useCallback(() => { if (!current) return; if (playing || wants.current) pause(); else play(current); }, [current, playing, pause, play]);
  const seek = useCallback((fraction: number) => {
    const a = audio.current;
    if (!a) return;
    if (Number.isFinite(a.duration) && a.duration > 0) { a.currentTime = fraction * a.duration; setPosition(a.currentTime); }
    else pendingSeek.current = fraction;
  }, []);
  const close = useCallback(() => {
    pause();
    const a = audio.current;
    if (a) { a.removeAttribute('src'); a.load(); }
    setCurrent(null); setPosition(0); setDuration(0); setError('');
  }, [pause]);

  return {current, playing, position, duration, volume, error, play, pause, toggle, seek, close, setVolume: setVolumeState, audio};
}

export function PlayerBar({player, title, subtitle, onPrevious, onNext, hasPrevious, hasNext}: {
  player: PlayerState; title: string; subtitle: string;
  onPrevious: () => void; onNext: () => void; hasPrevious: boolean; hasNext: boolean;
}) {
  const v = player.current;
  if (!v) return null;
  const length = player.duration || (v.durationMs ?? 0) / 1000;
  const progress = length ? Math.min(1, player.position / length) : 0;
  return <div className="sgm-player" role="region" aria-label="项目音乐播放条">
    <div className="sgm-player-controls">
      <button type="button" className="sgm-icon" aria-label="上一个版本" title="上一个版本" disabled={!hasPrevious} onClick={onPrevious}><SkipBack size={17}/></button>
      <button type="button" className="sgm-play is-large" aria-label={player.playing ? '暂停' : '播放'} title={player.playing ? '暂停' : '播放'} onClick={player.toggle}>
        {player.playing ? <Pause size={20}/> : <Play size={20}/>}
      </button>
      <button type="button" className="sgm-icon" aria-label="下一个版本" title="下一个版本" disabled={!hasNext} onClick={onNext}><SkipForward size={17}/></button>
    </div>
    <div className="sgm-player-title">
      <strong title={title}>{title}</strong>
      <span>{subtitle}</span>
    </div>
    <Waveform className="sgm-player-wave" peaks={v.peaks} bars={160} progress={progress} active onSeek={player.seek} label="播放位置"/>
    <span className="sgm-player-clock">{clock(player.position * 1000)} / {clock(length * 1000)}</span>
    <label className="sgm-player-volume" title="音量"><Volume2 size={16} aria-hidden="true"/>
      <input type="range" aria-label="音量" min={0} max={1} step={0.05} value={player.volume} onChange={e => player.setVolume(Number(e.target.value))}/>
    </label>
    <button type="button" className="sgm-icon" aria-label="关闭播放条" title="关闭播放条" onClick={player.close}><X size={17}/></button>
    {player.error && <p className="sgm-player-error" role="alert">{player.error}</p>}
  </div>;
}
