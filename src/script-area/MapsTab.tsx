// 「泳道图」标签：挂在当前所选那一份（某一版、迁移基线，或草稿 = 各草稿快照）上的图。用户只看，不在这里编辑。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dateTime, errorText, scriptBase, timeout } from './api';
import { CausalMap } from './CausalMap';
import { IssueList } from './IssueList';
import { boundLabel, isBigChange, sourceCaption } from './map-layout.mjs';
import { MapReadingMode } from './MapReadingMode';
import { BookOpen } from 'lucide-react';
import type { MapDetail, MapSummary, Paged, ScriptRequest } from './types';

export type Viewing = { kind: 'draft' } | { kind: 'version' | 'legacy'; id: string };
export const mapBelongs = (m: MapSummary, v: Viewing) => v.kind === 'draft' ? m.binding.target.kind === 'snapshot' : m.binding.target.kind === v.kind && m.binding.target.id === v.id;

/** 一个项目的全部图摘要（首版最多 100 张）：标签数字和列表共用。 */
export function useMapList(request: ScriptRequest, projectId: string, active: boolean, reload: number) {
  const [state, setState] = useState<{ projectId: string; items: MapSummary[]; total: number; error: string; loading: boolean }>({ projectId, items: [], total: 0, error: '', loading: false });
  useEffect(() => {
    if (!active || !projectId) return;
    const c = new AbortController();
    setState(s => ({ ...s, projectId, loading: true, error: '', ...(s.projectId !== projectId ? { items: [], total: 0 } : {}) }));
    request<Paged<MapSummary>>(scriptBase(projectId) + '/maps?limit=100', undefined, undefined, { signal: c.signal })
      .then(r => setState({ projectId, items: r.items, total: r.total, error: '', loading: false }))
      .catch(e => { if (!c.signal.aborted) setState(s => ({ ...s, loading: false, error: errorText(e) })); });
    return () => c.abort();
  }, [request, projectId, active, reload]);
  return state.projectId === projectId ? state : { projectId, items: [], total: 0, error: '', loading: true };
}

function kindText(m: MapSummary, d: MapDetail | undefined) {
  if (m.kind === 'diff') { const b = d?.renderData.binding; return b?.before ? `改动 ${boundLabel(b.before)}→${boundLabel(b.target)}` : '改动图'; }
  return m.binding.target.kind === 'snapshot' ? '草稿图' : '单版';
}
function countText(d: MapDetail | undefined) {
  if (!d) return '';
  const g = d.renderData.graph;
  if (g.kind === 'diff') {
    const big = g.nodes.filter(n => isBigChange('diff', n)).length, minor = g.nodes.filter(n => n.change === 'minor').length;
    return `改了 ${big} 处因果或动机` + (minor ? `，${minor} 处措辞` : '');
  }
  const ai = g.nodes.filter(n => n.ai).length;
  return ai ? `AI 补了 ${ai} 处` : '没有 AI 补的';
}

export function MapsTab({ projectId, request, viewing, list, onBack }: { projectId: string; request: ScriptRequest; viewing: Viewing; list: ReturnType<typeof useMapList>; onBack?: () => void }) {
  const maps = useMemo(() => list.items.filter(m => mapBelongs(m, viewing)), [list.items, viewing]);
  // 图详情：按「项目 + 图 id」记结果和正在发的请求。请求的去留不跟列表数组走——列表刷新只是换了一个数组，
  // 已经发出的请求照样把结果写回来（PR154 独验 P2-1）。失败的记下错误，点开或点「重试」再发。
  const [details, setDetails] = useState<Record<string, MapDetail | { error: string }>>({});
  const detailsRef = useRef(details); detailsRef.current = details;
  const inflight = useRef(new Set<string>()), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const keyOf = (id: string) => projectId + '\u0000' + id;
  const load = useCallback((id: string, retry = false) => {
    const k = projectId + '\u0000' + id, have = detailsRef.current[k];
    if (inflight.current.has(k) || have && ('map' in have || !retry)) return;
    inflight.current.add(k);
    if (have) setDetails(x => { const { [k]: _, ...rest } = x; return rest; });
    request<MapDetail>(scriptBase(projectId) + '/maps/' + encodeURIComponent(id), undefined, undefined, timeout())
      .then(d => { if (alive.current) setDetails(x => ({ ...x, [k]: d })); })
      .catch(e => { if (alive.current) setDetails(x => ({ ...x, [k]: { error: errorText(e) } })); })
      .finally(() => inflight.current.delete(k));
  }, [projectId, request]);
  const [open, setOpenState] = useState<string | null>(null);
  // 点开任一张卡片都要能取到详情：先预取的只是前 30 张，其余点开时再取（PR154 独验 P2-2）
  const openMap = (id: string) => { setOpenState(id); load(id, true); };
  useEffect(() => { setOpenState(null); }, [projectId, viewing.kind, viewing.kind === 'draft' ? '' : viewing.id]);
  useEffect(() => { for (const m of maps.slice(0, 30)) load(m.id); }, [maps, load]);

  const [reading, setReading] = useState(false);
  const closeReading = useCallback(() => setReading(false), []);
  useEffect(() => { setReading(false); }, [open, projectId]);
  const current = open ? details[keyOf(open)] : undefined;
  if (open) return <section className="sa-map-view" aria-label="泳道图">
    <div className="sa-map-view-bar"><button type="button" onClick={() => { setOpenState(null); onBack?.(); }}>← 返回泳道图列表</button>
      {current && 'map' in current && <button type="button" onClick={() => setReading(true)} title="整屏只看泳道图 · Esc 退出"><BookOpen size={15}/>阅读模式</button>}
      {current && 'map' in current && current.map.isDraftStale && <span className="sa-stale">基于较早的草稿</span>}</div>
    {!current ? <p className="ca-muted">正在读取这张图…</p> : 'error' in current ? <p className="ca-alert" role="alert">这张图没有读到：{current.error}　<button type="button" onClick={() => load(open, true)}>重试</button></p> : <>
      <IssueList issues={current.issues} title={current.issues.length ? `上传时的 ${current.issues.length} 条提醒` : undefined}/>
      <div className="sa-map-scroll"><CausalMap data={current.renderData} fit={1.4}/></div>
      {reading && <MapReadingMode data={current.renderData} onClose={closeReading}/>}
    </>}
  </section>;

  return <section className="sa-maps" aria-label="泳道图列表">
    {list.error && <p className="ca-alert" role="alert">泳道图列表没有读到：{list.error}</p>}
    {list.loading && !list.items.length ? <p className="sa-empty-line">正在读取泳道图…</p> : !maps.length ? <p className="sa-empty-line" role="status">
      <b>{viewing.kind === 'draft' ? '草稿上还没有泳道图。' : '这一版上还没有泳道图。'}</b>泳道图由 agent 读剧本后画好传上来，这里只看不改。
    </p> : <ul className="sa-map-cards">{maps.map(m => {
      const d = details[keyOf(m.id)], detail = d && 'map' in d ? d : undefined;
      return <li key={m.id}><button type="button" className="sa-map-card" onClick={() => openMap(m.id)} aria-label={'打开泳道图：' + (m.title || '未命名')}>
        <span className="sa-map-kind">{kindText(m, detail)}</span>
        {m.isDraftStale && <span className="sa-stale">基于较早的草稿</span>}
        <strong>{m.title || '未命名泳道图'}</strong>
        <small>{detail ? '依据：' + (detail.renderData.sources.map(sourceCaption).join('、') || '—') : d && 'error' in d ? '详情没有读到：' + d.error : '正在读取依据…'}</small>
        <small>agent 画于 {dateTime(m.createdAt)}{detail && ' · ' + countText(detail)}</small>
      </button></li>;
    })}</ul>}
    {list.total > list.items.length && <p className="ca-muted">只列出了最近 {list.items.length} 张（共 {list.total} 张）。</p>}
  </section>;
}
