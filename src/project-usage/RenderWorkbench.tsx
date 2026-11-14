// 素材使用页上半部分：成片播放器 + 跟随播放的轨道 + 此刻时间线上的音效（合同 PROJECT-USAGE-RENDER v1 第 7、8 节）。
// 同步规则：t = video.currentTime − offset（秒）；此刻 start ≤ t < end；接下来 t < start ≤ t + 10；
// 排除已禁用/静音、上次导入保留和位置未知的引用；成片与时间线未确认匹配时不做自动对照。
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Film, Pause, Play, RefreshCw, Unlink } from "lucide-react";
import type { ProjectRequest } from "../ProjectManager";
import { useFeedbackToast } from "../global-feedback";
import { clock, newRequestId, reasonOf, renderApi, renderStatus, settle, type RenderV2, type RequestError } from "./render";
import { RenderPicker } from "./RenderPicker";
import "./usage.css";

export type Occurrence = { occurrenceId?: string; clipId?: string; clipName?: string; track: number; start: number | null; end: number | null; disabled?: boolean };
export type OverviewRef = { assetId: string | null; key?: string; name: string; kind: string; used: boolean; retained?: boolean; occurrences: Occurrence[] };
export type OverviewTimeline = { id: string; name: string; revision?: string; fps: number; duration: number | null; startTimecode: string | null; warnings?: string[]; references: OverviewRef[] };
type Clip = { ref: OverviewRef; occ: Occurrence; start: number; end: number; key: string };

const AHEAD = 10;

export function RenderWorkbench({ projectId, projectName, revision, request, stopAudio }: { projectId: string; projectName: string; revision: number; request: ProjectRequest; stopAudio: () => void }) {
  const [timelines, setTimelines] = useState<OverviewTimeline[]>([]), [timelineId, setTimelineId] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [reload, setReload] = useState(0);
  const [render, setRender] = useState<RenderV2 | null>(null), [renderError, setRenderError] = useState(""), [renderReload, setRenderReload] = useState(0);
  const [t, setT] = useState(0), [playing, setPlaying] = useState(false), [music, setMusic] = useState(true), [overlay, setOverlay] = useState(true), [zoom, setZoom] = useState(1);
  const [picking, setPicking] = useState(false), [mediaError, setMediaError] = useState(""), [busy, setBusy] = useState("");
  const video = useRef<HTMLVideoElement>(null), generation = useRef(0);
  useFeedbackToast(error || renderError, { source: "素材使用" });

  useEffect(() => {
    let live = true; setLoading(true); setError("");
    request<{ timelines: OverviewTimeline[] }>(`/projects/${projectId}/timeline-overview`)
      .then(data => { if (!live) return; setTimelines(data.timelines); setTimelineId(id => data.timelines.some(x => x.id === id) ? id : data.timelines[0]?.id || ""); })
      .catch(e => { if (live) setError(e.message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, revision, request, reload]);

  useEffect(() => {
    if (!timelineId) { setRender(null); return; }
    const g = ++generation.current; setRenderError(""); setMediaError("");
    renderApi.get(request, projectId, timelineId).then(r => { if (g === generation.current) setRender(r); })
      .catch(e => { if (g === generation.current) { setRender(null); setRenderError((e as Error).message); } });
  }, [projectId, timelineId, request, renderReload, revision]);

  const timeline = timelines.find(x => x.id === timelineId);
  const offset = render?.offset ?? 0;
  const playable = !!render?.link && !!render.playback.canPlay && !!render.playback.mediaUrl && !mediaError;
  const canSync = !!render?.sync.canSynchronize && playable;
  const clips = useMemo(() => {
    const out: Clip[] = [];
    for (const ref of timeline?.references ?? []) {
      if (ref.retained) continue;
      if (ref.kind !== "sfx" && !(music && ref.kind === "music")) continue;
      ref.occurrences.forEach((occ, i) => {
        if (occ.start == null || occ.end == null || occ.end < occ.start) return;
        out.push({ ref, occ, start: occ.start, end: occ.end, key: occ.occurrenceId || `${ref.key || ref.name}:${i}` });
      });
    }
    return out.sort((a, b) => a.start - b.start || a.occ.track - b.occ.track);
  }, [timeline, music]);
  const tracks = [...new Set(clips.map(c => c.occ.track))].sort((a, b) => a - b);
  const lastEnd = Math.max(1, ...clips.map(c => c.end));
  const duration = timeline?.duration && timeline.duration > 0 ? timeline.duration : lastEnd;
  const audible = clips.filter(c => !c.occ.disabled);
  const now = audible.filter(c => c.start <= t && t < c.end);
  const next = audible.filter(c => t < c.start && c.start <= t + AHEAD);
  const unknownCount = (timeline?.references ?? []).reduce((n, r) => n + (r.retained ? 0 : r.occurrences.filter(o => o.start == null || o.end == null).length), 0);
  const uses = useMemo(() => { const m = new Map<string, number>(); for (const c of clips) m.set(c.ref.key || c.ref.name, (m.get(c.ref.key || c.ref.name) ?? 0) + 1); return m; }, [clips]);

  const seek = (time: number) => {
    const v = video.current;
    if (v && playable) { v.currentTime = Math.max(0, time + offset); }
    setT(time);
  };
  const jump = (dir: 1 | -1) => {
    const target = dir > 0 ? audible.find(c => c.start > t + 0.05) : [...audible].reverse().find(c => c.start < t - 0.3);
    seek(target ? target.start : 0);
  };
  const toggle = () => { const v = video.current; if (!v) return; if (v.paused) { stopAudio(); void v.play().catch(() => {}); } else v.pause(); };
  const status = renderStatus(render);

  async function unlink() {
    if (!render?.link || !timeline) return;
    if (!window.confirm("解除这条时间线的成片关联？不会删除项目视频，也不影响其他用处。")) return;
    setBusy("正在解除…");
    try {
      const first = await renderApi.unlink(request, projectId, timeline.id, { requestId: newRequestId(), expectedRevision: render.revision });
      const receipt = await settle(request, first, () => true);
      if (receipt.status === "completed") setRenderReload(n => n + 1);
      else if (receipt.status === "failed") setRenderError(receipt.error?.message || "解除失败");
      else setRenderError("解除结果尚未核清，请稍后刷新再看；不会自动重试。");
    } catch (e) { setRenderError((e as RequestError).message); setRenderReload(n => n + 1); }
    finally { setBusy(""); }
  }

  if (!loading && !error && !timeline) return <section className="usage-start" aria-label="开始">
    <h3>两步就能边看成片边对照音效</h3>
    <p>先用上方「导入达芬奇时间线」导入剪辑用的时间线（FCP 7 XML），拾光就知道每个音效用在片子的哪一秒；再从这一集的项目视频里选出成片，就能一边播放一边看到当时时间线上的音效。</p>
  </section>;

  return <section className="usage-workbench" aria-label="成片与时间线" aria-busy={loading}>
    {error && <div className="usage-error" role="alert">时间线读取失败：{error}<button type="button" className="icon-button" aria-label="重新读取时间线" title="重新读取时间线" onClick={() => setReload(n => n + 1)}><RefreshCw size={14} /></button></div>}
    {timeline && <>
      <div className="usage-render-bar">
        {timelines.length > 1 ? <select aria-label="时间线" value={timelineId} onChange={e => { setTimelineId(e.target.value); setT(0); setPlaying(false); }}>{timelines.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select> : <span className="usage-timeline-name" title={timeline.name}>时间线「{timeline.name}」</span>}
        <span className="usage-render-status" data-tone={status.tone}><Film size={13} aria-hidden="true" />{status.text}{render?.link && render.name ? <> · <span title={render.folder ? `${render.folder.relativePath}/${render.name}` : render.name}>{render.folder ? `${render.folder.name} / ` : ""}{render.name}</span></> : null}</span>
        <button type="button" className="plain" disabled={!!busy} onClick={() => setPicking(true)}>{render?.link ? "更换成片" : "选择成片"}</button>
        {render?.link && <button type="button" className="icon-button" aria-label="解除成片关联" title="解除成片关联" disabled={!!busy} onClick={() => void unlink()}><Unlink size={15} /></button>}
        {busy && <span role="status" className="usage-busy">{busy}</span>}
      </div>

      <div className="usage-stage">
        <div className="usage-player">
          {playable ? <div className="usage-video-frame">
            <video ref={video} key={render!.playback.mediaUrl!} src={render!.playback.mediaUrl!} preload="metadata" aria-label={`成片：${render!.name ?? ""}`}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
              onLoadedMetadata={e => { e.currentTarget.currentTime = Math.max(0, t + offset); }}
              onTimeUpdate={e => setT(e.currentTarget.currentTime - offset)}
              onError={e => { const code = e.currentTarget.error?.code; setPlaying(false); setMediaError(code === 4 ? "当前浏览器无法播放这个成片" : "成片读取失败"); setRenderReload(n => n + 1); }} />
            {overlay && canSync && now.length > 0 && <div className="usage-overlay" aria-hidden="true">{now.map(c => <span key={c.key}>{c.ref.name}</span>)}</div>}
          </div> : <div className="usage-player-empty" role="status">
            <strong>{!render?.link ? "还没关联成片" : mediaError || reasonOf(render.playback.reasonCode, status.text)}</strong>
            {render?.link === "legacy-path" && render.path && <code>{render.path}</code>}
            <span>{!render?.link ? "从这一集的项目视频里选出成片，就能边看边对照。" : "成片只能从这一集的项目视频里选；须是浏览器能播放的视频（H.264 的 MP4）。"}</span>
            <button type="button" className="primary" onClick={() => setPicking(true)}>从项目视频里选择成片…</button>
          </div>}
          <div className="usage-transport">
            <button type="button" className="usage-play" aria-label={playing ? "暂停成片" : "播放成片"} disabled={!playable} onClick={toggle}>{playing ? <Pause size={18} /> : <Play size={18} />}</button>
            <span className="usage-clock">{clock(t)} / {clock(duration)}</span>
            <input type="range" aria-label="时间线位置" min={0} max={duration} step={0.1} value={Math.min(duration, Math.max(0, t))} onChange={e => seek(Number(e.target.value))} />
            <button type="button" className="plain" onClick={() => jump(-1)}><ChevronLeft size={15} />上一个音效</button>
            <button type="button" className="plain" onClick={() => jump(1)}>下一个音效<ChevronRight size={15} /></button>
            <label className="check-label"><input type="checkbox" checked={overlay} onChange={e => setOverlay(e.target.checked)} />画面上显示音效名</label>
          </div>
        </div>

        <aside className="usage-now" aria-label="此刻时间线上的音效">
          <div className="usage-now-head"><h3>此刻时间线上的音效</h3><span>{clock(t)}</span></div>
          {render?.link && playable && !render.sync.canSynchronize && <p className="usage-note" role="note">{render.sync.state === "timeline_changed" ? "时间线重新导入过，成片和新时间线还没确认是否对得上，暂不自动对照。" : "成片和时间线还没确认对得上，暂不自动对照。"}可以点下方轨道查看每段位置。</p>}
          {now.length ? now.map(c => <div className="usage-now-item" key={c.key}>
            <strong title={c.ref.name}>{c.ref.name}</strong>
            <span>{c.ref.kind === "music" ? "音乐" : "音效"} · A{c.occ.track} · {clock(c.start)}–{clock(c.end)}</span>
            <span>本集共用 {uses.get(c.ref.key || c.ref.name) ?? 1} 次{c.ref.used ? "" : " · 待确认"}</span>
          </div>) : <p className="usage-muted">这一刻时间线上没有音效</p>}
          <h4>接下来 {AHEAD} 秒</h4>
          {next.length ? next.map(c => <button type="button" className="usage-next-item" key={c.key} onClick={() => seek(c.start)}>
            <span className="usage-next-in">{(c.start - t).toFixed(1)} 秒后</span><span title={c.ref.name}>{c.ref.name}</span><span>A{c.occ.track}</span>
          </button>) : <p className="usage-muted">没有新的音效</p>}
          <p className="usage-hint">按时间线推定，看不出混音、音量变化和嵌套片段。{unknownCount ? `另有 ${unknownCount} 处引用缺少位置。` : ""}</p>
        </aside>
      </div>

      <div className="usage-tracks">
        <div className="usage-tracks-head"><h3>轨道</h3><span>点任意一段，跳到那里</span><label className="check-label"><input type="checkbox" checked={music} onChange={e => setMusic(e.target.checked)} />显示音乐</label><label className="usage-zoom">缩放<input aria-label="轨道缩放" type="range" min={1} max={8} step={1} value={zoom} onChange={e => setZoom(Number(e.target.value))} /></label></div>
        {clips.length ? <div className="usage-tracks-scroll" tabIndex={0} aria-label="音效轨道与使用区间"><div className="usage-tracks-grid" style={{ width: `${zoom * 100}%` }}>
          {tracks.map(track => <div className="usage-lane" key={track}><span>A{track}</span><div>
            {clips.filter(c => c.occ.track === track).map(c => {
              const active = !c.occ.disabled && c.start <= t && t < c.end;
              return <button type="button" key={c.key} className="usage-clip" data-kind={c.ref.kind} data-muted={!!c.occ.disabled} data-confirmed={c.ref.used && !c.occ.disabled} data-active={active}
                style={{ left: `${Math.min(100, c.start / duration * 100)}%`, width: `${Math.max(0, Math.min(duration, c.end) - c.start) / duration * 100}%` }}
                aria-label={`${c.ref.name}，A${track}，${clock(c.start)} 至 ${clock(c.end)}${c.occ.disabled ? "，已禁用或静音" : !c.ref.used ? "，待确认" : ""}`}
                onClick={() => seek(c.start)}><span>{c.ref.name}</span></button>;
            })}
          </div></div>)}
          <div className="usage-playhead" aria-hidden="true" style={{ left: `calc(56px + (100% - 56px) * ${Math.min(1, Math.max(0, t / duration))})` }} />
        </div></div> : <p className="usage-muted">这条时间线里没有可定位的{music ? "音乐或音效" : "音效"}</p>}
        <div className="usage-legend"><span><i />音效 · 已确认</span><span><i className="music" />音乐</span><span><i className="soft" />待确认 / 已禁用或静音</span>{(timeline.warnings ?? []).slice(0, 1).map(w => <span key={w} className="usage-warning">{w}</span>)}</div>
      </div>
    </>}
    {picking && timeline && <RenderPicker projectId={projectId} projectName={projectName} timelineId={timeline.id} render={render} request={request} close={() => setPicking(false)} linked={() => { setPicking(false); setMediaError(""); setRenderReload(n => n + 1); }} />}
  </section>;
}
