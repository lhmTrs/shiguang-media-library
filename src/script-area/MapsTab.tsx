// 「泳道图」标签：这一集所有的图（不按版本筛）。每张写清画在哪份稿子上、那份和当前稿是否相同。用户只看，不在这里编辑。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { contentDigestOf, dateTime, errorText, readPages, scriptBase, timeout } from './api';
import { CausalMap } from './CausalMap';
import { IssueList } from './IssueList';
import { boundLabel, isBigChange, sourceCaption } from './map-layout.mjs';
import { MapReadingMode } from './MapReadingMode';
import { BookOpen } from 'lucide-react';
import type { MapDetail, MapSummary, ObjectRef, Paged, ScriptRequest } from './types';

/** 画在的那份和当前稿比：相同用平常色，改过用提醒色；空串就什么都不写。 */
function Sameness({ text }: { text: string }) {
  return text ? <span className={'sa-sameness' + (text === '和当前稿相同' ? '' : ' is-changed')}> · {text}</span> : null;
}


/** 一个项目的全部图摘要（首版最多 100 张）：标签数字和列表共用。 */
/** 这一集的图摘要：先读最近 100 张，「再显示后面的」按 100 张一页接着读；刷新时按已经显示的张数重读。 */
export function useMapList(request: ScriptRequest, projectId: string, active: boolean, reload: number) {
  const [state, setState] = useState<{ projectId: string; items: MapSummary[]; total: number; error: string; loading: boolean }>({ projectId, items: [], total: 0, error: '', loading: false });
  const [want, setWant] = useState({ projectId, count: 100 });
  const count = want.projectId === projectId ? want.count : 100;
  useEffect(() => {
    if (!active || !projectId) return;
    const c = new AbortController();
    setState(s => ({ ...s, projectId, loading: true, error: '', ...(s.projectId !== projectId ? { items: [], total: 0 } : {}) }));
    readPages<MapSummary>(request, scriptBase(projectId) + '/maps', { want: count, signal: c.signal })
      .then(r => setState({ projectId, items: r.items, total: r.total, error: '', loading: false }))
      .catch(e => { if (!c.signal.aborted) setState(s => ({ ...s, loading: false, error: errorText(e) })); });
    return () => c.abort();
  }, [request, projectId, active, reload, count]);
  const loadMore = useCallback(() => setWant({ projectId, count: count + 100 }), [projectId, count]);
  return { ...(state.projectId === projectId ? state : { projectId, items: [], total: 0, error: '', loading: true }), loadMore };
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

export function MapsTab({ projectId, request, list, currentDigest, onBack }: { projectId: string; request: ScriptRequest; list: ReturnType<typeof useMapList>; /** 当前稿（已保存的草稿）的摘要；不知道时为 null。 */ currentDigest: string | null; onBack?: () => void }) {
  const maps = list.items;
  // 图画在哪份稿子上：按「项目 + 种类 + id」记那份的摘要（null 表示没算出来），同一份只读一次
  const [targetDigests, setTargetDigests] = useState<Record<string, string | null>>({});
  const asked = useRef(new Set<string>());
  const targetKey = (t: ObjectRef) => projectId + '\u0000' + t.kind + '\u0000' + t.id;
  const loadTarget = useCallback((t: ObjectRef) => {
    const k = projectId + '\u0000' + t.kind + '\u0000' + t.id;
    if (asked.current.has(k)) return; asked.current.add(k);
    const url = scriptBase(projectId) + (t.kind === 'snapshot' ? '/draft/snapshots/' : '/versions/') + encodeURIComponent(t.id);
    request<{ title: string; content: string }>(url, undefined, undefined, timeout())
      .then(d => contentDigestOf(d.title, d.content))
      .catch(() => null)
      .then(digest => { if (alive.current) setTargetDigests(x => ({ ...x, [k]: digest })); });
  }, [projectId, request]);
  /** 「和当前稿相同 / 当前稿已经改过」；两边摘要有一个拿不到就不写。 */
  const sameness = (t: ObjectRef) => { const d = targetDigests[targetKey(t)]; return !d || !currentDigest ? '' : d === currentDigest ? '和当前稿相同' : '当前稿已经改过'; };
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
  const openMap = (id: string) => { setOpenState(id); load(id, true); const m = maps.find(x => x.id === id); if (m) loadTarget(m.binding.target); };
  useEffect(() => { setOpenState(null); }, [projectId]);
  useEffect(() => { for (const m of maps.slice(0, 30)) { load(m.id); loadTarget(m.binding.target); } }, [maps, load, loadTarget]);

  const [reading, setReading] = useState(false);
  const closeReading = useCallback(() => setReading(false), []);
  useEffect(() => { setReading(false); }, [open, projectId]);
  const current = open ? details[keyOf(open)] : undefined;
  if (open) return <section className="sa-map-view" aria-label="泳道图">
    <div className="sa-map-view-bar"><button type="button" onClick={() => { setOpenState(null); onBack?.(); }}>← 返回泳道图列表</button>
      {current && 'map' in current && <button type="button" onClick={() => setReading(true)} title="整屏只看泳道图 · Esc 退出"><BookOpen size={15}/>阅读模式</button>}
      {current && 'map' in current && <span className="sa-map-on">画在 {boundLabel(current.renderData.binding.target)}<Sameness text={sameness(current.map.binding.target)}/></span>}</div>
    {!current ? <p className="ca-muted">正在读取这张图…</p> : 'error' in current ? <p className="ca-alert" role="alert">这张图没有读到：{current.error}　<button type="button" onClick={() => load(open, true)}>重试</button></p> : <>
      <IssueList issues={current.issues} title={current.issues.length ? `上传时的 ${current.issues.length} 条提醒` : undefined}/>
      <div className="sa-map-scroll"><CausalMap data={current.renderData} fit={1.4}/></div>
      {reading && <MapReadingMode data={current.renderData} onClose={closeReading}/>}
    </>}
  </section>;

  return <section className="sa-maps" aria-label="泳道图列表">
    {list.error && <p className="ca-alert" role="alert">泳道图列表没有读到：{list.error}</p>}
    {list.loading && !list.items.length ? <p className="sa-empty-line">正在读取泳道图…</p> : !maps.length ? <p className="sa-empty-line" role="status">
      <b>这一集还没有泳道图。</b>泳道图由 agent 读剧本后画好传上来，这里只看不改。
    </p> : <ul className="sa-map-cards">{maps.map(m => {
      const d = details[keyOf(m.id)], detail = d && 'map' in d ? d : undefined;
      return <li key={m.id}><button type="button" className="sa-map-card" onClick={() => openMap(m.id)} aria-label={'打开泳道图：' + (m.title || '未命名')}>
        <span className="sa-map-kind">{kindText(m, detail)}</span>
        <strong>{m.title || '未命名泳道图'}</strong>
        <small className="sa-map-on">画在 {detail ? boundLabel(detail.renderData.binding.target) : '…'}<Sameness text={sameness(m.binding.target)}/></small>
        <small>{detail ? '依据：' + (detail.renderData.sources.map(sourceCaption).join('、') || '—') : d && 'error' in d ? '详情没有读到：' + d.error : '正在读取依据…'}</small>
        <small>agent 画于 {dateTime(m.createdAt)}{detail && ' · ' + countText(detail)}</small>
      </button></li>;
    })}</ul>}
    {list.total > list.items.length && <p className="sa-more"><button type="button" disabled={list.loading} onClick={list.loadMore}>{list.loading ? '正在读取…' : `再显示后面的 ${Math.min(100, list.total - list.items.length)} 张`}</button><span className="ca-muted">已显示最近 {list.items.length} 张，共 {list.total} 张</span></p>}
  </section>;
}
