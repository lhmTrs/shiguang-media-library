// 泳道图（剧本因果图）：renderer/template.html 的 React 移植，纯 SVG，只读。
// 输入是合同里的 renderData；正式图详情和试画回包共用这一个组件。样子照模板，配色用拾光的 --c-* 变量。
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAP_GEOMETRY, boundLabel, excerptKey, isBigChange, layoutMap, lineRange, pillWidth, shortDate, sourceCaption } from './map-layout.mjs';
import type { MapLayout } from './map-layout.d.mts';
import type { MapRef, RenderData } from './types';
import './causal-map.css';

type Props = { data: RenderData; /** 打开后直接弹出这个框（试画页地址栏 open=…）。 */ openId?: string };
type Pop = { id: string; left: number; top: number };

/** 「**重点**」加粗，其余一律当文字。 */
function Gist({ text }: { text: string }) {
  const parts: React.ReactNode[] = []; let last = 0;
  for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) { parts.push(text.slice(last, m.index)); parts.push(<b key={m.index}>{m[1]}</b>); last = m.index! + m[0].length; }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function Pill({ cx, cy, label, cls }: { cx: number; cy: number; label: string; cls?: 'ai' | 'ghost' }) {
  const w = pillWidth(label); const x = cx - (w / 2 - 8);
  return <g className={'sm-pill' + (cls ? ' is-' + cls : '')}>
    <rect x={x - w / 2} y={cy - 8.5} width={w} height={17} rx={8.5}/>
    <text x={x} y={cy + 4} textAnchor="middle" fontSize={11} fontWeight={600}>{label}</text>
  </g>;
}

export function CausalMap({ data, openId }: Props) {
  const layout: MapLayout = useMemo(() => layoutMap(data.graph), [data.graph]);
  const { mode, lanes, laneById, nodes, bands, edges, delMarks, all, W, H, PADX } = layout;
  const g = data.graph, vs = g.versions || {};
  const sourceByKey = useMemo(() => Object.fromEntries((data.sources || []).map(s => [s.key, s])), [data.sources]);
  const excerpts = useMemo(() => new Map((data.excerpts || []).map(e => [excerptKey(e.source, e.start, e.end), e])), [data.excerpts]);
  const board = useRef<HTMLDivElement>(null), popRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const arrow = 'sm-ar' + useId().replace(/[^a-zA-Z0-9]/g, '');

  const laneName = (id: string) => laneById[id]?.name ?? id;
  const before = data.binding?.before, target = data.binding?.target;
  const shortA = vs.v1?.short || boundLabel(before) || '旧版', shortB = vs.v2?.short || boundLabel(target) || '新版';
  const named = (g.sources || []).length > 1;

  // 副标题：写了 subtitle 就用它；改动图自动写「前稿（时间）→ 当前稿（时间）」；再接依据的来源和画图的人
  let sub = g.subtitle || '';
  if (!sub && mode === 'diff' && vs.v1 && vs.v2) sub = `${vs.v1.label}（${shortDate(before?.at, true)}）→ ${vs.v2.label}（${shortDate(target?.at, true)}）`;
  if (data.sources?.length) sub += (sub ? ' · ' : '') + '依据：' + data.sources.map(sourceCaption).join('、');
  if (g.madeBy) sub += (sub ? ' · ' : '') + g.madeBy;

  const hero = lanes.find(l => l.hero), hn = hero ? hero.name : '主角';
  const kinds = new Set(g.nodes.map(n => n.kind || 'seen'));
  const bigs = mode === 'diff' ? g.nodes.filter(n => isBigChange(mode, n)).map(n => all[n.id]).filter(Boolean).sort((a, b) => (a.num ?? 0) - (b.num ?? 0)) : [];
  const minors = mode === 'diff' ? g.nodes.filter(n => n.change === 'minor') : [];
  const ais = mode === 'single' ? g.nodes.filter(n => n.ai).map(n => all[n.id]).filter(Boolean).sort((a, b) => (a.num ?? 0) - (b.num ?? 0)) : [];

  function open(id: string, el: Element) {
    const b = board.current; if (!b) return;
    const br = b.getBoundingClientRect(), tr = el.getBoundingClientRect();
    let left = tr.right - br.left + 10; if (left + 380 > br.width) left = tr.left - br.left - 390;
    if (left < 0) left = Math.max(6, Math.min(br.width - 386, tr.left - br.left));
    setPop({ id, left, top: tr.top - br.top });
  }
  // 卡片超出画板底部时往上挪（模板同样的处理）
  useLayoutEffect(() => {
    const b = board.current, p = popRef.current; if (!pop || !b || !p) return;
    const ph = p.offsetHeight, bh = b.getBoundingClientRect().height;
    if (pop.top + ph > bh) { const top = Math.max(6, bh - ph - 6); if (top !== pop.top) setPop({ ...pop, top }); }
  }, [pop]);
  useEffect(() => {
    if (!pop) return;
    const away = (e: MouseEvent) => { if (!popRef.current?.contains(e.target as Node) && !(e.target as Element)?.closest?.('.sm-nd')) setPop(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    document.addEventListener('click', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('click', away); document.removeEventListener('keydown', esc); };
  }, [pop]);
  useEffect(() => setPop(null), [data]);
  useEffect(() => {
    if (!openId) return;
    const el = board.current?.querySelector(`[data-id="${CSS.escape(openId)}"]`); if (el) open(openId, el);
  }, [openId, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const nodeProps = (id: string, label: string) => ({
    className: 'sm-nd', 'data-id': id, role: 'button', tabIndex: 0, 'aria-label': label,
    onClick: (e: React.MouseEvent<SVGGElement>) => { e.stopPropagation(); open(id, e.currentTarget); },
    onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(id, e.currentTarget); } },
  });

  // 引文：服务器按 source+start+end 回填的原句；原件删了先说明这是存档摘录
  function quoted(ref: MapRef, tag: (range: string, sourceLabel: string) => string, cls = '') {
    const s = sourceByKey[ref.source], ex = excerpts.get(excerptKey(ref.source, ref.start, ref.end));
    const text = ex ? ex.lines.map(l => l.text).join('\n') : '（没有取到这几行的原文）';
    return <div className={'sm-ver ' + cls} key={ref.source + ':' + ref.start + ':' + (ref.end ?? '')}>
      {s?.sourceState === 'deleted' && <span className="sm-gone">原件已删除，以下为存档摘录</span>}
      <span className="sm-tag">{tag(lineRange(ref.start, ref.end), s?.label || ref.source)}</span><span className="sm-txt">{text}</span>
    </div>;
  }
  const plain = (tag: string, text: string, cls = '') => <div className={'sm-ver ' + cls}><span className="sm-tag">{tag}</span><span className="sm-txt">{text}</span></div>;

  function popup(id: string) {
    const n = all[id]; if (!n) return null;
    let head: React.ReactNode[] = [];
    if (mode === 'diff') {
      if (isBigChange(mode, n)) head.push(<span key="b" className={'sm-badge' + (n.change === 'del' ? ' is-ghost' : '')}>{n.change === 'new' ? '新' : n.change === 'del' ? '删' : ''}{n.num}</span>);
      else if (n.change === 'minor') head.push(<span key="b" className="sm-dot sm-dot-head"/>);
    } else if (n.ai) head.push(<span key="b" className="sm-badge is-ai">{n.num}</span>);
    head.push(<b key="lane">{laneName(n.lane)}</b>, <span key="lab" className="sm-lab">{n.label.join('')}</span>);
    if (mode === 'single') head.push(n.ai ? <span key="k" className="sm-kind is-ai">AI 补的</span> : <span key="k" className="sm-kind">剧本原文</span>);
    let body: React.ReactNode[] = [];
    if (mode === 'diff') {
      const olds = (n.old || []).map(r => quoted(r, range => `${shortA} 原文 ${range}`, 'is-old'));
      const news = (n.new || []).map(r => quoted(r, range => `${shortB} 原文 ${range}`));
      if (n.change === 'del') body = [...(n.old || []).map(r => quoted(r, range => `${shortA} 原文 ${range}`)), <React.Fragment key="e">{plain(shortB, '这一拍删掉了', 'is-empty')}</React.Fragment>];
      else if (n.change === 'new') body = [<React.Fragment key="e">{plain(shortA, '没有这一拍', 'is-empty')}</React.Fragment>, ...news];
      else if (n.change) body = [...olds, ...news];
      else body = (n.new || []).map(r => quoted(r, range => `新版原文 ${range}`));
      if (n.why) body.push(<div key="why" className="sm-sec"><b>为什么改：</b>{n.why}</div>);
    } else {
      const refs = (n.refs || []).map(r => quoted(r, (range, label) => named ? `${label} ${range}` : `原文 ${range}`));
      if (refs.length && n.ai) body.push(<div key="t" className="sm-tag">依据的原文</div>);
      body.push(...refs);
      if (n.ai?.why) body.push(<div key="why" className="sm-sec"><b>为什么这样补：</b>{n.ai.why}</div>);
      if (n.ai?.unsure) body.push(<div key="unsure" className="sm-sec"><b>拿不准的地方：</b>{n.ai.unsure}</div>);
    }
    return <>{<div className="sm-hd">{head}<button type="button" className="sm-x" title="关闭" aria-label="关闭" onClick={() => setPop(null)}>×</button></div>}{body}</>;
  }

  const R = MAP_GEOMETRY.R;
  return <div className="sm-sheet" data-map-kind={mode}>
    {g.title && <h1 className="sm-title">{g.title}</h1>}
    <div className="sm-sub">{sub}</div>
    {g.gist && <div className="sm-gist"><Gist text={g.gist}/></div>}
    <div className="sm-legend">
      {kinds.has('self') && <span><i className="sm-sw is-self"/>{hn}本人</span>}
      {kinds.has('seen') && <span><i className="sm-sw is-seen"/>别人的行为，{hn}在场</span>}
      {kinds.has('away') && <span><i className="sm-sw is-away"/>镜头离开{hn}</span>}
      {mode === 'single' && g.nodes.some(n => n.ai) && <span><i className="sm-sw is-ai"/>剧本没写，AI 补的</span>}
      {mode === 'diff' && <><span><span className="sm-badge">3</span>改了因果或动机</span><span><span className="sm-dot"/>只改措辞</span>
        {delMarks.length > 0 && <span><span className="sm-badge is-ghost">删2</span>这里删了一拍</span>}</>}
      <span>点任意框看原文</span>
    </div>
    <div><div className="sm-board" ref={board}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={g.title || '泳道图'}>
        <defs><marker id={arrow} viewBox="0 0 10 10" refX={8} refY={5} markerWidth={6} markerHeight={6} orient="auto-start-reverse"><path d="M2 1L8 5L2 9" className="sm-arrowhead"/></marker></defs>
        {lanes.filter(l => l.hero).map(l => <rect key={'bg' + l.id} className="sm-lane-bg" x={l.x} y={4} width={l.w} height={H - 8} rx={12}/>)}
        {lanes.map(l => <text key={'h' + l.id} className={'sm-lane-name' + (l.hero ? ' is-hero' : '')} x={l.cx} y={26} textAnchor="middle" fontSize={l.hero ? 15 : 13} fontWeight={600}>{l.name}</text>)}
        {bands.map((b, i) => <g key={'band' + i} className="sm-band">
          <line x1={PADX} x2={W - PADX} y1={b.y} y2={b.y} strokeDasharray="4 4"/>
          <rect x={b.tx} y={b.y - 11} width={b.tw} height={22} rx={11}/>
          <text x={b.tx + b.tw / 2} y={b.y + 4.5} textAnchor="middle" fontSize={12}>{b.label}</text>
        </g>)}
        <g className="sm-edges" fill="none" strokeWidth={1.2}>
          {edges.map((e, i) => e.leader ? <path key={i} d={e.d} strokeDasharray="3 3" data-edge={e.from + '>' + e.to}/> : <path key={i} d={e.d} markerEnd={`url(#${arrow})`} data-edge={e.from + '>' + e.to} data-route={e.route}/>)}
        </g>
        {nodes.map(n => {
          const isHero = !!n.l.hero, k = n.kind || 'seen', big = isBigChange(mode, n), ai = !!n.ai;
          const fs = isHero ? 14 : 12.5, lh = fs + 3.5, y0 = n.y + n.h / 2 - (n.label.length - 1) * lh / 2 + fs * 0.36;
          const cls = ['sm-box', 'k-' + k, big ? 'is-big' : '', ai ? 'is-ai' : '', isHero ? 'is-hero' : ''].filter(Boolean).join(' ');
          return <g key={n.id} {...nodeProps(n.id, laneName(n.lane) + '：' + n.label.join(''))}>
            <rect className={cls} x={n.x} y={n.y} width={n.w} height={n.h} rx={R} strokeWidth={big ? 1.6 : isHero ? 1.2 : 1} strokeDasharray={ai ? '5 4' : undefined}/>
            {n.label.map((ln, i) => <text key={i} className={'sm-label k-' + k + (ai ? ' is-ai' : '')} x={n.x + n.w / 2} y={y0 + i * lh} textAnchor="middle" fontSize={fs} fontWeight={isHero ? 600 : 400}>{ln}</text>)}
            {big ? <Pill cx={n.x + n.w} cy={n.y} label={(n.change === 'new' ? '新' : '') + n.num}/>
              : mode === 'diff' && n.change === 'minor' ? <circle className="sm-minor" cx={n.x + n.w} cy={n.y} r={4.5} strokeWidth={1.5}/>
              : ai ? <Pill cx={n.x + n.w} cy={n.y} label={String(n.num)} cls="ai"/> : null}
          </g>;
        })}
        {delMarks.map(m => <g key={'del' + m.id} {...nodeProps(m.id, '删' + m.num + '：' + (all[m.id]?.label.join('') ?? ''))}><Pill cx={m.cx} cy={m.cy} label={'删' + m.num} cls="ghost"/></g>)}
      </svg>
      {pop && <div className="sm-pop" ref={popRef} role="dialog" aria-label="原文" style={{ left: pop.left, top: pop.top }}>{popup(pop.id)}</div>}
    </div></div>
    <div className="sm-notes">
      {mode === 'diff' ? <>
        {bigs.length > 0 && <><h2>改了因果或动机的 {bigs.length} 处<span>点图上的框看两版原文和为什么改</span></h2>
          {bigs.map(n => <div className="sm-note" key={n.id}><span className="sm-badge">{n.num}</span><div><b>{laneName(n.lane)}</b>　{n.what || n.label.join('')}</div></div>)}</>}
        {minors.length > 0 && <div className="sm-minor-list"><span className="sm-dot"/>只改措辞或时长的 {minors.length} 处：{minors.map(n => ([] as string[]).concat(n.label).join('')).join('、')}</div>}
      </> : ais.length > 0 && <><h2>剧本没写、AI 补的 {ais.length} 处<span>点框看依据的原文、为什么这样补、拿不准的地方</span></h2>
        {ais.map(n => <div className="sm-note" key={n.id}><span className="sm-badge is-ai">{n.num}</span><div><b>{laneName(n.lane)}</b>　{n.ai?.what || n.label.join('')}</div></div>)}</>}
    </div>
  </div>;
}
