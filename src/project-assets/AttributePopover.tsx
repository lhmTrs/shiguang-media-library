import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { PromptRequest } from '../PromptTemplateWorkspace';
import { AttributeRadar, RadarLegend, type RadarSeries } from './AttributeRadar';
import { type AttrConfig, SERIES_COLORS, SINGLE_COLOR, attrApi, sourceSummary } from './attributes';

/** 右键「查看属性图」（1 人）/ 多选「对比属性图」（2–3 人）的小窗内容。只读，不改数据。 */
export function AttributePopover({ projectId, people, request, onEdit, onClose }: {
  projectId: string; people: { id: string; name: string }[]; request: PromptRequest; onEdit?: (id: string) => void; onClose: () => void;
}) {
  const [config, setConfig] = useState<AttrConfig | null>(null), [series, setSeries] = useState<RadarSeries[] | null>(null), [error, setError] = useState('');
  const [source, setSource] = useState<ReturnType<typeof sourceSummary>>(null);
  const single = people.length === 1, key = people.map(p => p.id).join(',');
  useEffect(() => {
    let live = true; setConfig(null); setSeries(null); setError('');
    (async () => {
      const c = await attrApi.config(request, projectId);
      if (single) {
        const a = await attrApi.get(request, people[0].id);
        if (a.asset_id !== people[0].id || a.project_id !== projectId) throw Error('属性返回的人物不一致');
        if (live) { setConfig(c); setSource(sourceSummary(a, c.dimensions)); setSeries([{ name: people[0].name, color: SINGLE_COLOR, scores: a.scores }]); }
      } else {
        const r = await attrApi.compare(request, projectId, people.map(p => p.id));
        const byId = new Map(r.items.map(i => [i.asset_id, i]));
        if (people.some(p => !byId.has(p.id))) throw Error('有人物的属性没有读到（已归档或不在本项目），没有画对比图');
        if (live) { setConfig(c); setSeries(people.map((p, i) => ({ name: p.name, color: SERIES_COLORS[i], scores: byId.get(p.id)!.scores }))); }
      }
    })().catch(e => { if (live) setError((e as Error).message || '属性读取失败'); });
    return () => { live = false; };
  }, [projectId, key]);
  const unscored = single && series && config && !source;
  return <>
    <header><strong>{single ? people[0].name + ' · 属性' : `属性对比 · ${people.length} 人`}</strong>
      {source && <span className="ca-attrs-source">{source.label}</span>}<span className="ca-grow"/>
      {single && onEdit && <button type="button" className="ca-link-button" onClick={() => onEdit(people[0].id)}>在详情中编辑 →</button>}
      <button type="button" className="ca-icon-button" aria-label="关闭属性图" onClick={onClose}><X size={15}/></button></header>
    <div className="ca-attr-pop-body">
      {error ? <p className="ca-muted" role="alert">{error}</p>
        : !series || !config ? <p className="ca-muted">正在读取属性…</p>
        : <>
          {!single && <RadarLegend series={series}/>}
          <AttributeRadar dims={config.dimensions} series={series} label={single ? people[0].name + '的属性雷达图' : people.map(p => p.name).join('、') + '的属性对比图'} radius={single ? 112 : 118}/>
          <p className="ca-muted ca-attrs-legend">{unscored ? '还没有属性分数。' : ''}中心 -100 · 虚线圈 0（中立）· 最外圈 +100</p>
        </>}
    </div>
  </>;
}
