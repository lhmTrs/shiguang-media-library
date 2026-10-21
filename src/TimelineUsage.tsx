import { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Copy, Film } from "lucide-react";
import { TimelineReview } from "./TimelineReview";
import type { ProjectRequest } from "./ProjectManager";

export type TimelineReference = {
  timelineId: string; timelineName: string; used: boolean;
  fps?: number; duration?: number | null; startTimecode?: string | null;
  occurrences: { track: number; start: number | null; end: number | null;
    sourceIn?: number | null; sourceOut?: number | null;
    startFrame?: number | null; endFrame?: number | null; disabled: boolean }[];
};

export function elapsed(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "未知";
  const ms = Math.round(value * 1000), seconds = Math.floor(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${seconds >= 3600 ? pad(Math.floor(seconds / 3600)) + ":" : ""}${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}.${String(ms % 1000).padStart(3, "0")}`;
}

type ReviewOptions = {projectId?:string;projectName?:string;request?:ProjectRequest;stopAudio?:()=>void;compact?:boolean};
function Usage({ reference: ref, projectId, projectName, request, stopAudio, compact = false }: { reference: TimelineReference } & ReviewOptions) {
  const [selected, setSelected] = useState(0), [expanded, setExpanded] = useState(false), [copied, setCopied] = useState("");
  const [reviewing,setReviewing] = useState(false);
  const occurrences = [...ref.occurrences].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.track - b.track);
  const current = occurrences[Math.min(selected, occurrences.length - 1)];
  if (!current) return null;
  const duration = ref.duration != null && ref.duration > 0 ? ref.duration : null;
  const valid = (o: typeof current) => o.start != null && o.end != null && o.start >= 0 && o.end >= o.start;
  const range = (o: typeof current) => `${elapsed(o.start)} → ${elapsed(o.end)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${projectName ? `项目：${projectName} · ` : ""}时间线：${ref.timelineName} · A${current.track} · 距片头 ${range(current)}${current.startFrame != null && current.endFrame != null ? ` · 帧 ${current.startFrame}–${current.endFrame}（出点不含）` : ""}`);
      setCopied("已复制");
    } catch { setCopied("复制失败，请手动选择时间文字"); }
  };
  return <section className={"timeline-usage" + (compact ? " compact" : "")} aria-label={`${projectName ? projectName + " · " : ""}${ref.timelineName} 使用位置`}>
    <div className="timeline-usage-heading">{compact && <Film size={12}/>}<strong title={compact ? `时间线：${ref.timelineName}` : projectName || ref.timelineName}>{compact ? ref.timelineName : projectName ? `项目：${projectName}` : `时间线：${ref.timelineName}`}</strong><span className="timeline-reference-state" data-confirmed={ref.used}>{occurrences.length} 次引用 · {ref.used ? "已确认" : "待确认"}</span></div>
    {projectName && !compact && <div className="timeline-usage-source">时间线：{ref.timelineName}</div>}
    <div className="timeline-usage-position"><span className="timeline-track">A{current.track}</span>{projectId&&request ? <button type="button" className="timeline-position-link" title="查看时间线位置 / 播放成片" onClick={()=>setReviewing(true)}>距片头 {range(current)}</button> : <strong>距片头 {range(current)}</strong>}{current.disabled && <span>已禁用 / 静音</span>}
      <button type="button" className="icon-button" title="复制使用位置" aria-label="复制使用位置" onClick={() => void copy()}><Copy size={14}/></button>{copied && <small role="status">{copied}</small>}
      {compact && <button type="button" className="timeline-usage-toggle" aria-label={expanded ? "收起位置明细" : "展开位置明细"} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>明细<ChevronDown size={13} className={expanded ? "is-expanded" : ""}/></button>}
    </div>
    {duration ? <>
      <div className="timeline-position-bar" aria-label="整条时间线中的使用位置">
        {occurrences.map((o, i) => valid(o) && o.start! < duration && <button key={i} type="button" className={(i === selected ? "selected " : "") + (o.disabled ? "disabled-clip" : "")} style={{left:`${Math.min(100,o.start! / duration * 100)}%`,width:`${Math.min(100 - o.start! / duration * 100,Math.max(0,(o.end! - o.start!) / duration * 100))}%`}} aria-label={`第 ${i + 1} 次引用，A${o.track}，${range(o)}`} title={`A${o.track} · ${range(o)}`} onClick={() => { setSelected(i); setExpanded(true); setCopied(""); }}/>) }
      </div>
      {(!compact || expanded) && <div className="timeline-bar-scale"><span>片头 00:00</span><span>{elapsed(duration)}</span></div>}
    </> : (!compact || expanded) && <small className="timeline-usage-warning">记录缺少时间线总长，无法显示全片比例；可重新导入包含总时长的 XML。</small>}
    {!compact && <button type="button" className="timeline-usage-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起位置明细" : `展开位置明细${occurrences.length > 1 ? `（${occurrences.length} 次）` : ""}`}</button>}
    {expanded && <div className="timeline-usage-details">
      {compact && projectName && <small className="timeline-usage-source">项目：{projectName} · 时间线：{ref.timelineName}</small>}
      <small>位置从片头 0 起算{ref.fps ? ` · ${Number(ref.fps.toFixed(3))} fps` : ""}{ref.startTimecode ? ` · 达芬奇起始时间码 ${ref.startTimecode}` : ""} · 出点不含</small>
      {occurrences.map((o,i) => <div className={"timeline-occurrence" + (selected === i ? " selected" : "")} key={i}>
        <button type="button" onClick={() => {setSelected(i);setCopied("");if(projectId&&request)setReviewing(true);}} aria-pressed={selected === i}><span>#{i+1} · A{o.track}</span><strong>{range(o)}</strong></button>
        <small>{valid(o) ? `使用 ${elapsed(o.end! - o.start!)} · ` : "位置不完整 · "}源素材 {elapsed(o.sourceIn)} → {elapsed(o.sourceOut)}{o.disabled ? " · 已禁用 / 静音" : ""}</small>
        {o.startFrame != null && o.endFrame != null && <small>时间线帧 {o.startFrame}–{o.endFrame}（从 0 起算）</small>}
      </div>)}
    </div>}
    {reviewing&&projectId&&request&&createPortal(<TimelineReview reference={ref} projectId={projectId} projectName={projectName} initialIndex={selected} request={request} stopAudio={stopAudio} close={()=>setReviewing(false)}/>,document.body)}
  </section>;
}

export function TimelineUsage({ references, ...options }: { references?: TimelineReference[] } & ReviewOptions) {
  return <>{references?.map(ref => <Usage key={ref.timelineId} reference={ref} {...options}/>)}</>;
}
