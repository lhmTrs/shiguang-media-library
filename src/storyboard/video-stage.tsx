import React,{useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {VideoPreviewPlayer,type PreviewRun,type PreviewSource,type PlayerSnapshot} from './video-player';
import {bindPlaybackSpace} from '../playback-shortcuts';
export type PreviewShot={id:string;number:string;startMs:number;durationMs:number};
export const videoClock=(ms:number)=>{const value=Math.max(0,Math.round(ms));return Math.floor(value/60000)+':'+String(Math.floor(value/1000)%60).padStart(2,'0')+'.'+String(value%1000).padStart(3,'0');};
const positions=new Map<string,number>();
const ShotStrip=React.memo(function ShotStrip({shots,currentId,onSeek,onManual,strip,disabled}:{disabled:boolean;shots:PreviewShot[];currentId?:string;onSeek:(ms:number)=>void;onManual:()=>void;strip:React.RefObject<HTMLDivElement>}){return <div className="sbv-shot-strip" ref={strip} aria-label="全片镜号条" onWheel={onManual} onPointerDown={onManual} onTouchStart={onManual} onKeyDown={e=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(e.key))onManual();}}>{shots.map(s=><button disabled={disabled} key={s.id} data-preview-shot={s.id} aria-label={'跳转到镜'+s.number} aria-current={currentId===s.id?'true':undefined} onClick={()=>onSeek(s.startMs)}><strong>{s.number}</strong><small>{videoClock(s.startMs)}</small></button>)}</div>;});
export function VideoStage({scope,version,runs,sources,shots,durationMs,startShot,disabled=false,autoPlay=false,onPosition,seekRequest,pauseSignal,initialPositionMs}:{scope:string;version:string;runs:PreviewRun[];sources:PreviewSource[];shots:PreviewShot[];durationMs:number;startShot?:string;disabled?:boolean;autoPlay?:boolean;onPosition?:(position:number)=>void;seekRequest?:{shotId:string;request:number};pauseSignal?:number;initialPositionMs?:number}){
 const host=useRef<HTMLDivElement>(null),engine=useRef<VideoPreviewPlayer|null>(null),last=useRef(0),strip=useRef<HTMLDivElement>(null),[state,setState]=useState<PlayerSnapshot>({positionMs:0,playing:false,buffering:false,error:'',runIndex:-1}),[manual,setManual]=useState(false);
 const callback=useRef(onPosition),initialized=useRef(false);callback.current=onPosition;
 const autoStart=useRef(autoPlay),autoStarted=useRef(false),blocked=useRef(disabled);blocked.current=disabled;
 const seek=useCallback((ms:number)=>{if(!disabled)engine.current?.seek(ms);},[disabled]),browse=useCallback(()=>setManual(true),[]);
 useLayoutEffect(()=>{if(!host.current)return;const player=new VideoPreviewPlayer(host.current,s=>{last.current=s.positionMs;setState(s);callback.current?.(s.positionMs);});engine.current=player;const hidden=()=>{if(document.hidden)player.pause();};document.addEventListener('visibilitychange',hidden);return()=>{positions.delete(scope);positions.set(scope,last.current);if(positions.size>20)positions.delete(positions.keys().next().value!);document.removeEventListener('visibilitychange',hidden);player.dispose();engine.current=null;};},[scope]);
 useEffect(()=>{const initial=initialized.current?last.current:startShot?shots.find(s=>s.id===startShot)?.startMs:initialPositionMs??positions.get(scope);initialized.current=true;engine.current?.setPlan(runs,sources,durationMs,initial??last.current);},[scope,version,runs,sources,durationMs]);
 useLayoutEffect(()=>{if(disabled)engine.current?.pause();},[disabled]);
 useLayoutEffect(()=>{if(pauseSignal)engine.current?.pause();},[pauseSignal]);
 useEffect(()=>{if(seekRequest&&!disabled){const shot=shots.find(s=>s.id===seekRequest.shotId);if(shot)engine.current?.seek(shot.startMs);}},[seekRequest]);
 useEffect(()=>{if(startShot&&!disabled){const shot=shots.find(s=>s.id===startShot);if(shot)engine.current?.seek(shot.startMs);}},[startShot]);
 useEffect(()=>{if(autoStart.current&&!autoStarted.current&&!disabled&&durationMs>0){autoStarted.current=true;if(!document.hidden)engine.current?.play();}},[disabled,durationMs]);
 useEffect(()=>{const node=host.current?.closest<HTMLElement>('[role="dialog"]')??host.current?.closest<HTMLElement>('.sbv-stage');if(!node)return;return bindPlaybackSpace(node,()=>{const player=engine.current;if(player)player.snapshot.playing?player.pause():player.play();},()=>!blocked.current&&!document.hidden);},[scope]);
 const current=shots.find(s=>state.positionMs>=s.startMs&&state.positionMs<s.startMs+s.durationMs)??(state.positionMs===durationMs?shots.at(-1):undefined),run=runs[state.runIndex];
 const followCurrent=()=>{const list=strip.current;if(!list||!current)return;const button=Array.from(list.querySelectorAll<HTMLElement>('[data-preview-shot]')).find(b=>b.dataset.previewShot===current.id);if(!button)return;const item=button.getBoundingClientRect(),area=list.getBoundingClientRect();if(item.top<area.top)list.scrollTop-=area.top-item.top;else if(item.bottom>area.bottom)list.scrollTop+=item.bottom-area.bottom;};
 useEffect(()=>{if(!manual)followCurrent();},[current?.id,manual]);
 return <section className="sbv-stage" aria-label="全片视频播放器" data-position-ms={state.positionMs} data-playing={state.playing} data-buffering={state.buffering} data-run={state.runIndex}>
  <div className="sbv-viewer">
  <div className="sbv-screen"><div className="sbv-media" ref={host}/>{(!run||run.kind==='black')&&<div className="sbv-black">{!run?'全片预览结束':current?'镜 '+current.number+' · 缺少视频':'缺少视频'}<small>{run?.kind==='black'?'按计划时长播放黑场与静音':''}</small></div>}{state.buffering&&<span className="sbv-buffer" role="status">正在读取视频 · 全片时间暂停</span>}</div>
  <div className="sbv-controls"><button onClick={()=>state.playing?engine.current?.pause():engine.current?.play()} disabled={!durationMs||disabled}>{state.playing?'暂停':'播放'}</button><output aria-label="全片播放时间">{videoClock(state.positionMs)} / {videoClock(durationMs)}</output><span>{current?'镜 '+current.number:'—'}</span><button disabled={disabled} onClick={()=>engine.current?.seek(0)}>回到开头</button></div>
  <input className="sbv-progress" disabled={disabled} type="range" aria-label="全片预览位置" min={0} max={Math.max(1,durationMs)} step={1} value={state.positionMs} onChange={e=>engine.current?.seek(Number(e.target.value))}/>
  {state.error&&<div className="sbv-error" role="alert">{state.error}<button disabled={disabled} onClick={()=>engine.current?.retry()}>重新读取本段</button></div>}
  <p className="sbv-hint">空格播放 / 暂停，编辑输入时除外。正常速度预览；浏览器定位有时间精度差异。缺镜为黑场，文件错误会暂停；不导出成片。</p>
  </div>
  <aside className="sbv-shot-nav" aria-label="全片镜号导航">
   <div className="sbv-strip-heading"><strong>全片镜号</strong><small>{shots.length} 镜</small></div>
   <ShotStrip disabled={disabled} shots={shots} currentId={current?.id} onSeek={seek} onManual={browse} strip={strip}/>
   <button className="sbv-follow-current" disabled={!current} onClick={()=>{setManual(false);followCurrent();}}>回到当前镜头</button>
  </aside>
 </section>;
}
