import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ListMusic, LogIn, LogOut, Pause, Play, Repeat2, RotateCcw, SkipBack, SkipForward, Star, Volume2, X } from "lucide-react";
import type { Asset } from "./main";
const clock = (n: number) => `${Math.floor(n / 60).toString().padStart(2, "0")}:${Math.floor(n % 60).toString().padStart(2, "0")}`;
export function AuditionControls({ asset, playing, position, length, volume, inPoint, outPoint, loop, continuous, setContinuous, canContinue, toggle, seek, previous, next, hasPrevious, hasNext, setVolume, setRange, setLoop, favorite, close }: {
  asset: Asset; playing: boolean; position: number; length: number; volume: number; inPoint: number; outPoint: number; loop: boolean;
  toggle: (active?: boolean) => void; seek: (n: number) => void; previous: () => void; next: () => void; hasPrevious: boolean; hasNext: boolean;
  setVolume: (n: number) => void; setRange: (start: number, end: number) => void; setLoop: (v: boolean) => void; favorite: () => void; close: () => void;
  continuous: boolean; setContinuous: (v: boolean) => void; canContinue: boolean;
}) {
  const [expanded, setExpanded] = useState(true), [failed, setFailed] = useState(false);
  const pausedOnPress = useRef(false);
  const [startDraft, setStartDraft] = useState(String(inPoint)), [endDraft, setEndDraft] = useState(String(outPoint)), [rangeError, setRangeError] = useState("");
  useEffect(() => { setStartDraft(String(Number(inPoint.toFixed(2)))); setRangeError(""); }, [inPoint, asset.id]);
  useEffect(() => { setEndDraft(String(Number(outPoint.toFixed(2)))); setRangeError(""); }, [outPoint, asset.id]);
  function commitRange(start: boolean) {
    const a = start ? Number(startDraft) : inPoint, b = start ? outPoint : Number(endDraft);
    if (!(start ? startDraft : endDraft).trim() || !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b > length + 0.01 || b - a < 0.05) {
      setRangeError("选段需在音频时长内，出点须晚于入点"); setStartDraft(String(Number(inPoint.toFixed(2)))); setEndDraft(String(Number(outPoint.toFixed(2)))); return;
    }
    setRangeError(""); setRange(a, b);
  }
  useEffect(() => setFailed(false), [asset.id, asset.mtime]);
  const percent = (n: number) => `${length ? Math.min(100, Math.max(0, n / length * 100)) : 0}%`;
  return <>
    <div className="audition-transport">
      <button className="icon-button" title="上一首" aria-label="上一首试听" disabled={!hasPrevious} onClick={previous}><SkipBack size={18}/></button>
      <button className="player-toggle" title={playing ? "暂停试听" : "播放试听"} aria-label={playing ? "暂停试听" : "播放试听"}
        onPointerDown={e => { pausedOnPress.current = e.button === 0 && playing; if (pausedOnPress.current) toggle(false); }}
        onPointerCancel={() => { pausedOnPress.current = false; }}
        onKeyDown={e => { pausedOnPress.current = false; if ([" ", "Enter"].includes(e.key)) { e.preventDefault(); if (!e.repeat) toggle(!playing); } }}
        onClick={() => { if (pausedOnPress.current) { pausedOnPress.current = false; return; } toggle(!playing); }}>{playing ? <Pause size={20}/> : <Play size={20}/>}</button>
      <button className="icon-button" title="下一首" aria-label="下一首试听" disabled={!hasNext} onClick={next}><SkipForward size={18}/></button>
      <div className="player-title"><strong title={asset.name}>{asset.name}</strong><span>{asset.category || "未分类"}</span></div>
      <span className="mono audition-clock">{clock(position)} / {clock(length)}</span>
      <input className="audition-progress" type="range" aria-label="试听进度" min={0} max={length || 1} step={0.01} value={Math.min(position, length || 1)} onChange={e => seek(Number(e.target.value))}/>
      <button className="icon-button" title={asset.favorite ? "取消试听素材收藏" : "收藏试听素材"} aria-label={asset.favorite ? "取消试听素材收藏" : "收藏试听素材"} onClick={favorite}><Star size={17} fill={asset.favorite ? "currentColor" : "none"}/></button>
      <Volume2 size={17} className="audition-volume-icon"/><input className="volume" type="range" aria-label="音量" min={0} max={1} step={0.05} value={volume} onChange={e => setVolume(Number(e.target.value))}/>
      <button className="icon-button" title={expanded ? "收起试听选段" : "展开试听选段"} aria-label={expanded ? "收起试听选段" : "展开试听选段"} aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>{expanded ? <ChevronDown size={17}/> : <ChevronUp size={17}/>}</button>
      <button className="icon-button" title="关闭播放器" aria-label="关闭播放器" onClick={close}><X size={17}/></button>
    </div>
    <div className="audition-options"><label className="check-label" title={canContinue ? "播完后自动播放当前筛选结果的下一条，最后一条播完停止" : "连续试听仅用于素材库及搜索结果"}><input type="checkbox" aria-label="连续试听" checked={continuous} disabled={!canContinue} onChange={e => setContinuous(e.target.checked)}/><ListMusic size={15}/>连续试听</label></div>
    {expanded && <div className="audition-segment">
      <div className="audition-wave" role="slider" tabIndex={0} aria-label="波形试听位置" aria-valuemin={0} aria-valuemax={length} aria-valuenow={Math.min(position, length)}
        onPointerDown={e => { if (!length) return; const b = e.currentTarget.getBoundingClientRect(); seek(Math.max(0, Math.min(length, (e.clientX - b.left) / b.width * length))); e.currentTarget.focus(); }}
        onKeyDown={e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); seek(e.key === "Home" ? 0 : e.key === "End" ? length : position + (e.key === "ArrowRight" ? 1 : -1)); } }}>
        {!failed ? <img src={`/api/media/${asset.id}/wave`} alt="试听选段波形" draggable={false} onError={() => setFailed(true)}/> : <span>波形暂不可用</span>}
        <div className="audition-range" style={{ left: percent(inPoint), width: percent(Math.max(0, outPoint - inPoint)) }}/><i className="audition-playhead" style={{ left: percent(position) }}/>
      </div>
      <div className="audition-range-tools">
        <label>入点（秒）<input type="number" aria-label="试听入点" min={0} max={Math.max(0, outPoint - 0.05)} step={0.01} value={startDraft} onChange={e => setStartDraft(e.target.value)} onBlur={() => commitRange(true)} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}/></label>
        <button className="icon-button" title="将当前位置设为入点" aria-label="将当前位置设为入点" onClick={() => setRange(position, outPoint)} disabled={!length || position > outPoint - 0.05}><LogIn size={16}/></button>
        <label>出点（秒）<input type="number" aria-label="试听出点" min={inPoint + 0.05} max={length} step={0.01} value={endDraft} onChange={e => setEndDraft(e.target.value)} onBlur={() => commitRange(false)} onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}/></label>
        <button className="icon-button" title="将当前位置设为出点" aria-label="将当前位置设为出点" onClick={() => setRange(inPoint, position)} disabled={!length || position < inPoint + 0.05}><LogOut size={16}/></button>
        <label className="check-label"><input type="checkbox" aria-label="循环试听选段" checked={loop} disabled={outPoint - inPoint < 0.05} onChange={e => setLoop(e.target.checked)}/><Repeat2 size={15}/>循环</label>
        <button className="icon-button" title="重置试听选段" aria-label="重置试听选段" onClick={() => { setLoop(false); setRange(0, length); }}><RotateCcw size={16}/></button>
        {rangeError && <small className="database-error" role="alert">{rangeError}</small>}
      </div>
    </div>}
  </>;
}
