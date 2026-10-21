import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Layers, RefreshCw } from "lucide-react";
import type { ProjectRequest } from "./ProjectManager";
import { elapsed, type TimelineReference } from "./TimelineUsage";
import { TimelineReview } from "./TimelineReview";

type Reference = {assetId:string|null;name:string;kind:string;used:boolean;occurrences:TimelineReference["occurrences"]};
type Timeline = {id:string;name:string;fps:number;duration:number|null;startTimecode:string|null;references:Reference[]};
export function ProjectTimelineOverview({projectId,projectName,revision,request,stopAudio}:{projectId:string;projectName:string;revision:number;request:ProjectRequest;stopAudio:()=>void}) {
  const [timelines,setTimelines]=useState<Timeline[]>([]),[timelineId,setTimelineId]=useState(""),[expanded,setExpanded]=useState(true),[music,setMusic]=useState(false),[zoom,setZoom]=useState(1),[error,setError]=useState(""),[reload,setReload]=useState(0),[loading,setLoading]=useState(true);
  const [review,setReview]=useState<{ref:TimelineReference;index:number;name:string}|null>(null);
  useEffect(()=>{
    let live=true;setLoading(true);setError("");setReview(null);
    request<{timelines:Timeline[]}>(`/projects/${projectId}/timeline-overview`).then(data=>{if(live){setTimelines(data.timelines);setTimelineId(id=>data.timelines.some(t=>t.id===id)?id:data.timelines[0]?.id||"");}}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[projectId,revision,request,reload]);
  const timeline=timelines.find(t=>t.id===timelineId);
  const references=timeline?.references.filter(r=>r.kind==="sfx"||(music&&r.kind==="music"))??[];
  const clips=references.flatMap(r=>[...r.occurrences].sort((a,b)=>(a.start??Infinity)-(b.start??Infinity)||a.track-b.track).map((o,index)=>({r,o,index}))).filter(({o})=>o.start!=null&&o.end!=null&&o.start>=0&&o.end>=o.start);
  const lanes=new Map<number,typeof clips>();
  for(const clip of clips){const lane=lanes.get(clip.o.track)??[];lane.push(clip);lanes.set(clip.o.track,lane);}
  const tracks=[...lanes.keys()].sort((a,b)=>a-b);
  const assetCount=new Set(references.map(r=>r.assetId??r.name)).size;
  const lastEnd=Math.max(1,...(timeline?.references.flatMap(r=>r.occurrences.map(o=>o.end??0))??[]));
  const duration=timeline?.duration&&timeline.duration>0?timeline.duration:lastEnd;
  const open=(r:Reference,index:number)=>{
    if(!timeline)return;
    setReview({ref:{timelineId:timeline.id,timelineName:timeline.name,used:r.used,fps:timeline.fps,duration:timeline.duration,startTimecode:timeline.startTimecode,occurrences:r.occurrences},index,name:r.name});
  };
  if(!loading&&!error&&!timeline)return null;
  return <section className="project-overview" aria-label="项目音效时间线总览" aria-busy={loading}>
    <div className="project-overview-head"><button type="button" className="project-overview-title" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><Layers size={15}/><strong>时间线总览</strong><ChevronDown size={14} className={expanded?"is-expanded":""}/></button><span>{loading?"正在读取…":`${assetCount} 个素材 · ${clips.length} 处使用`}</span>
      {expanded&&timeline&&<div className="project-overview-options">{timelines.length>1?<select aria-label="总览时间线" value={timelineId} onChange={e=>{setTimelineId(e.target.value);setZoom(1);setReview(null);}}>{timelines.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select>:<small title={timeline.name}>{timeline.name}</small>}<label className="check-label"><input type="checkbox" checked={music} onChange={e=>setMusic(e.target.checked)}/>含音乐</label><label className="project-overview-zoom">缩放<input aria-label="时间线总览缩放" type="range" min={1} max={8} step={1} value={zoom} onChange={e=>setZoom(Number(e.target.value))}/></label></div>}
    </div>
    {error&&<div className="project-overview-error" role="alert">总览读取失败：{error}<button type="button" className="icon-button" title="重新读取时间线总览" aria-label="重新读取时间线总览" onClick={()=>setReload(n=>n+1)}><RefreshCw size={14}/></button></div>}
    {expanded&&timeline&&!loading&&<>
      {clips.length?<div className="project-overview-scroll" tabIndex={0} aria-label="音效轨道与使用区间"><div className="project-overview-grid" style={{width:`${zoom*100}%`}}>
        <div className="project-overview-lane project-overview-ruler"><span>轨道</span><div>{[0,1,2,3,4].map(i=><small key={i} style={{left:`${i*25}%`,transform:i===4?"translateX(-100%)":i===0?"none":"translateX(-50%)"}}>{elapsed(duration*i/4).replace(/\.\d{3}$/,"")}</small>)}</div></div>
        {tracks.map(track=><div className="project-overview-lane" key={track}><span>A{track}</span><div>{lanes.get(track)!.map(({r,o,index},i)=><button type="button" key={i} className="project-overview-clip" data-kind={r.kind} data-confirmed={r.used&&!o.disabled} style={{left:`${Math.min(100,o.start!/duration*100)}%`,width:`${Math.max(0,Math.min(duration,o.end!)-o.start!)/duration*100}%`}} aria-label={`${r.name}，A${track}，${elapsed(o.start)} 至 ${elapsed(o.end)}`} title={`${r.name}\nA${track} · ${elapsed(o.start)} → ${elapsed(o.end)}${o.disabled?" · 已禁用 / 静音":!r.used?" · 待确认":""}`} onClick={()=>open(r,index)}><span>{r.name}</span></button>)}</div></div>)}
      </div></div>:<p className="project-overview-empty">此时间线暂无可定位的{music?"音乐或音效":"音效"}引用</p>}
      <div className="project-overview-foot"><span>片头 0 起算 · {!timeline.duration?"参考范围至最后一处引用":"全片 "+elapsed(duration)}{references.some(r=>r.occurrences.some(o=>o.start==null||o.end==null))?" · 部分引用缺少位置":""}</span><span><i/>已确认 <i className="unconfirmed"/>待确认 / 静音</span></div>
    </>}
    {review&&createPortal(<div className="project-overview-review"><TimelineReview key={review.ref.timelineId+review.name+review.index} reference={review.ref} projectId={projectId} projectName={`${projectName} · ${review.name}`} initialIndex={review.index} request={request} stopAudio={stopAudio} close={()=>setReview(null)}/></div>,document.body)}
  </section>;
}
