import { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, FileVideo, FolderOpen, Link, Play, Unlink, X } from "lucide-react";
import type { ProjectRequest } from "./ProjectManager";
import { elapsed, type TimelineReference } from "./TimelineUsage";

type Render = {path:string;offset:number;updatedAt:number};
export function TimelineReview({ reference: ref, projectId, projectName, initialIndex, request, close, stopAudio }: {
  reference:TimelineReference;projectId:string;projectName?:string;initialIndex:number;request:ProjectRequest;close:()=>void;stopAudio?:()=>void;
}) {
  const occurrences = [...ref.occurrences].sort((a,b)=>(a.start??Infinity)-(b.start??Infinity)||a.track-b.track);
  const [selected,setSelected]=useState(initialIndex), [position,setPosition]=useState(occurrences[initialIndex]?.start??0);
  const [render,setRender]=useState<Render|null>(null), [file,setFile]=useState(""), [offset,setOffset]=useState("0"), [busy,setBusy]=useState(false), [loading,setLoading]=useState(true), [error,setError]=useState(""), [mediaError,setMediaError]=useState(false), [videoDuration,setVideoDuration]=useState(0);
  const [settingsOpen,setSettingsOpen]=useState(true);
  const video=useRef<HTMLVideoElement>(null), dialog=useRef<HTMLDivElement>(null), pending=useRef<number|null>(occurrences[initialIndex]?.start??0);
  const endpoint=`/projects/${projectId}/timelines/${ref.timelineId}/render`;
  const duration=ref.duration && ref.duration>0 ? ref.duration : videoDuration>0 ? Math.max(0,videoDuration-(render?.offset??0)) : Math.max(1,...occurrences.map(o=>o.end??0));
  const selectedOccurrence=occurrences[selected];
  useEffect(()=>{
    let live=true;
    request<Render|null>(endpoint).then(value=>{if(live){setRender(value);setFile(value?.path??"");setOffset(String(value?.offset??0));setSettingsOpen(!value);}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[endpoint,request]);
  useEffect(()=>{const previous=document.activeElement as HTMLElement;dialog.current?.focus();return()=>previous?.focus();},[]);
  function seek(seconds:number, play=false) {
    const at=Math.max(0,Math.min(duration,seconds));setPosition(at);pending.current=at;
    const player=video.current;
    if(player && player.readyState>=1 && render) {
      const target=at+render.offset;
      if(target<0 || target>=player.duration) {player.pause();setError("该时间点超出成片范围，请检查成片版本或偏移秒数。");return;}
      player.currentTime=target;pending.current=null;
      if(play){stopAudio?.();void player.play().catch(()=>setError("请点击视频播放按钮开始播放。"));}
    }
  }
  async function associate(choose:boolean) {
    setBusy(true);setError("");
    try {
      const saved=await request<Render>(endpoint+(choose?"/choose":""),{path:file,offset:Number(offset)});
      video.current?.pause();pending.current=position;setRender(saved);setFile(saved.path);setOffset(String(saved.offset));setMediaError(false);setVideoDuration(0);setSettingsOpen(false);
    } catch(e){setError(e instanceof Error?e.message:"关联失败");setSettingsOpen(true);}finally{setBusy(false);}
  }
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)close();}}><div className="modal timeline-review" role="dialog" aria-modal="true" aria-label="时间线使用位置" tabIndex={-1} ref={dialog} onKeyDown={e=>{
    if(e.key==="Escape"&&!busy){e.stopPropagation();close();}
    if(e.key==="Tab"){const nodes=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),video,summary')||[]).filter(node=>node.getClientRects().length>0),first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}
  }}>
    <div className="modal-head"><div><h2>{projectName || ref.timelineName}</h2><small>时间线：{ref.timelineName} · 从片头起算</small></div><button className="icon-button" title="关闭" aria-label="关闭时间线使用位置" disabled={busy} onClick={close}><X size={18}/></button></div>
    <div className="timeline-review-body">
      {loading ? <p role="status">正在读取成片关联…</p> : render && !mediaError ? <video key={render.updatedAt} ref={video} className="timeline-render-video" controls preload="metadata" src={`/api${endpoint}/media?v=${render.updatedAt}`} onLoadedMetadata={()=>{const p=video.current;if(p){setVideoDuration(p.duration);seek(pending.current??position,true);}}} onPlay={stopAudio} onTimeUpdate={()=>{if(video.current)setPosition(Math.max(0,video.current.currentTime-(render?.offset??0)));}} onError={()=>{setMediaError(true);setError("成片无法播放：文件可能离线、已变更，或浏览器不支持其编码。可重新关联 H.264 / AAC 的 MP4。");}}/> : <div className="timeline-render-empty"><FileVideo size={28}/><span>{render?"成片暂不可播放":"尚未关联成片"}</span><strong>{elapsed(position)}</strong></div>}
      <div className="timeline-review-position"><strong>{elapsed(position)}</strong><span>{selectedOccurrence ? `A${selectedOccurrence.track} · 使用区间 ${elapsed(selectedOccurrence.start)} → ${elapsed(selectedOccurrence.end)}` : ""}</span></div>
      <div className="timeline-position-bar timeline-review-bar" aria-label="素材使用区间" onClick={e=>{const rect=e.currentTarget.getBoundingClientRect();seek((e.clientX-rect.left)/rect.width*duration);}}>
        {occurrences.map((o,i)=>o.start!=null&&o.end!=null&&o.end>=o.start&&o.start<duration&&<button type="button" key={i} className={(selected===i?"selected ":"")+(o.disabled?"disabled-clip":"")} style={{left:`${Math.max(0,o.start/duration*100)}%`,width:`${Math.max(0,Math.min(duration,o.end)-o.start)/duration*100}%`}} title={`A${o.track} · ${elapsed(o.start)} → ${elapsed(o.end)}`} aria-label={`定位第 ${i+1} 次使用`} onClick={e=>{e.stopPropagation();setSelected(i);seek(o.start!,true);}}/>)}
        <i className="timeline-playhead" style={{left:`${Math.min(100,position/duration*100)}%`}}/>
      </div>
      <input className="timeline-review-seek" type="range" min="0" max={duration} step="0.001" value={Math.min(duration,position)} aria-label="时间线播放位置" onChange={e=>seek(Number(e.target.value))}/>
      <div className="timeline-bar-scale"><span>片头 00:00</span><span>{!ref.duration&&!videoDuration?"参考范围：最后一次引用结束 ":""}{elapsed(duration)}</span></div>
      <section className="timeline-location-list" aria-label="素材使用位置列表"><div className="timeline-location-heading"><strong>使用位置 <span>{occurrences.length}</span></strong><small>已选 {selected+1} / {occurrences.length}</small></div>
        <div className="timeline-location-columns" aria-hidden="true"><span/><span>轨道</span><span>时间区间</span><span>时长</span><span/></div>
        <div className="timeline-review-occurrences">{occurrences.map((o,i)=><button type="button" key={i} aria-label={`播放第 ${i+1} 次使用，A${o.track}，${elapsed(o.start)} 至 ${elapsed(o.end)}`} aria-pressed={selected===i} onClick={()=>{setSelected(i);if(o.start!=null)seek(o.start,true);}} disabled={o.start==null}>
          <span className="timeline-location-number">{String(i+1).padStart(2,"0")}</span><span className="timeline-location-track">A{o.track}</span><span className="timeline-location-range"><strong>{elapsed(o.start)}</strong><ArrowRight size={12}/><strong>{elapsed(o.end)}</strong>{o.disabled&&<small>已禁用 / 静音</small>}</span><span className="timeline-location-duration">{o.start!=null&&o.end!=null&&o.end>=o.start?`${Number((o.end-o.start).toFixed(3))} 秒`:"—"}</span><Play size={13}/>
        </button>)}</div>
      </section>
      <details className="timeline-render-settings" open={settingsOpen} onToggle={e=>setSettingsOpen(e.currentTarget.open)}><summary><FileVideo size={15}/><strong>成片设置</strong><span title={render?.path}>{render ? render.path.split(/[\\/]/).pop() : "未关联成片"}</span><ChevronDown size={14}/></summary>
      <form className="timeline-render-form" onSubmit={e=>{e.preventDefault();void associate(false);}}>
        <label>本地成片路径<input aria-label="本地成片路径" placeholder="/Users/…/成片.mp4" value={file} onChange={e=>setFile(e.target.value)} disabled={busy||loading}/></label>
        <div className="timeline-render-actions"><button className="plain" type="button" disabled={busy||loading} onClick={()=>void associate(true)}><FolderOpen size={15}/>选择成片文件</button><button className="plain" type="submit" disabled={busy||loading||!file.trim()}><Link size={15}/>关联成片</button>{render&&<button className="icon-button" type="button" title="解除成片关联，不删除文件" aria-label="解除成片关联" disabled={busy} onClick={()=>{setBusy(true);void request(endpoint,{},"DELETE").then(()=>{video.current?.pause();setRender(null);setFile("");setMediaError(false);setVideoDuration(0);setSettingsOpen(true);}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}><Unlink size={16}/></button>}</div>
        <label className="timeline-render-offset">成片偏移（秒）<input type="number" step="0.001" min="-86400" max="86400" value={offset} onChange={e=>setOffset(e.target.value)} aria-label="成片偏移秒数" disabled={busy}/></label>
        <small>完整时间线导出填 0；成片额外有 3 秒片头填 3。每条时间线独立关联，文件不上传。</small>
      </form>
      </details>
      {error&&<p className="timeline-review-error" role="alert">{error}</p>}
    </div>
  </div></div>;
}
