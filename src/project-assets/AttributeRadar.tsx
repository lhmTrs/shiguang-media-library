import React from 'react';
import { type AttrDimension, type AttrScore, scoreValue, signed, tierText } from './attributes';

/*
 * 人物属性雷达图。中心 = -100，虚线圈 = 0（中立），最外圈 = +100；
 * 负分往里缩，所以 0 圈画成虚线；未评画在 0 圈上，用虚线空心点单独标出。
 * 单人：轴名下写「档位 分数」；对比：轴名下写两端名，悬停顶点看「人物 · 档位 · 分数」。
 */

export type RadarSeries = { name: string; color: string; scores: Record<string, AttrScore> };

export function AttributeRadar({ dims, series, label, radius = 120 }: { dims: AttrDimension[]; series: RadarSeries[]; label: string; radius?: number }) {
  const n = dims.length;
  if (n < 3) return <p className="ca-muted">至少需要 3 个维度才能画属性图。</p>;
  const R = radius, padX = 118, padY = 46, cx = R + padX, cy = R + padY, W = 2 * (R + padX), H = 2 * (R + padY) + 4;
  const ang = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const pt = (i: number, v: number) => { const r = (R * (v + 100)) / 200; return [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))] as const; };
  const ring = (v: number) => dims.map((_, i) => pt(i, v).join(',')).join(' ');
  const single = series.length === 1;
  return <svg className="ca-radar" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
    {[100, 60, 20, -20, -60].map(v => <polygon key={v} points={ring(v)} className={v === 100 ? 'ca-radar-edge' : 'ca-radar-grid'}/>)}
    <polygon points={ring(0)} className="ca-radar-zero"/>
    {dims.map((d, i) => {
      const [x, y] = pt(i, 100), c = Math.cos(ang(i)), anchor = Math.abs(c) < 0.1 ? 'middle' : c > 0 ? 'start' : 'end';
      const lx = cx + (R + 10) * c, ly = cy + (R + 10) * Math.sin(ang(i)) + (Math.sin(ang(i)) < -0.9 ? -16 : Math.sin(ang(i)) > 0.9 ? 13 : -2);
      const v = single ? scoreValue(series[0].scores[d.id]) : null;
      const sub = single ? (v === null ? '未评' : tierText(d, v) + ' ' + signed(v)) : d.negative_label + ' ↔ ' + d.positive_label;
      return <g key={d.id}>
        <line x1={cx} y1={cy} x2={x} y2={y} className="ca-radar-edge"/>
        <text x={lx} y={ly} textAnchor={anchor} className="ca-radar-axis">{d.name}</text>
        <text x={lx} y={ly + 15} textAnchor={anchor} className={'ca-radar-sub' + (single && v === null ? ' is-unrated' : '')}>{sub}</text>
      </g>;
    })}
    {series.map(s => {
      const pts = dims.map((d, i) => pt(i, scoreValue(s.scores[d.id]) ?? 0));
      return <g key={s.name}>
        <polygon points={pts.map(p => p.join(',')).join(' ')} fill={s.color} fillOpacity={0.14} stroke={s.color} strokeWidth={2} strokeLinejoin="round"/>
        {dims.map((d, i) => {
          const v = scoreValue(s.scores[d.id]), [x, y] = pts[i];
          return v === null
            ? <circle key={d.id} cx={x} cy={y} r={4.5} className="ca-radar-unrated"><title>{s.name} · {d.name} · 未评</title></circle>
            : <circle key={d.id} cx={x} cy={y} r={4} fill={s.color} className="ca-radar-dot"><title>{s.name} · {d.name} · {tierText(d, v)} {signed(v)}</title></circle>;
        })}
      </g>;
    })}
  </svg>;
}

/** Legend for comparisons (identity is never colour-only: names sit next to the swatches). */
export function RadarLegend({ series }: { series: RadarSeries[] }) {
  return <div className="ca-radar-legend">{series.map(s => <span key={s.name}><i style={{ background: s.color }}/>{s.name}</span>)}<small>悬停顶点看分数</small></div>;
}
