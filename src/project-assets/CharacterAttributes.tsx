import React, { useEffect, useRef, useState } from 'react';
import { Radar, Pencil, SlidersHorizontal } from 'lucide-react';
import type { PromptRequest } from '../PromptTemplateWorkspace';
import { useFeedbackToast } from '../global-feedback';
import { AttributeRadar } from './AttributeRadar';
import { type AssetAttributes, type AttrConfig, SINGLE_COLOR, attrApi, clampScore, errCode, readConsistent, scoreValue, signed, sourceSummary, tierText } from './attributes';

const when = (t: number) => new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

/** 详情栏「属性」：雷达图 + 编辑。属性是独立资源（不走资料保存），有自己的版本号。 */
export function CharacterAttributes({ assetId, projectId, name, request, active, readOnly, onOpenConfig, configVersion }: {
  assetId: string; projectId: string; name: string; request: PromptRequest; active: boolean; readOnly: boolean; onOpenConfig: () => void; configVersion: number;
}) {
  const [config, setConfig] = useState<AttrConfig | null>(null), [attrs, setAttrs] = useState<AssetAttributes | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading'), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<Record<string, number | null> | null>(null), [saving, setSaving] = useState(false);
  // Only dimensions the user actually touched are submitted; after a conflict the others follow the latest scores.
  const [edited, setEdited] = useState<Set<string>>(new Set());
  const ticket = useRef(0);
  useFeedbackToast(error, { source: '人物属性', active });

  async function load(keepDraft = false) {
    const t = ++ticket.current; setState(s => keepDraft ? s : 'loading');
    try {
      const [c, a] = await readConsistent(() => Promise.all([attrApi.config(request, projectId), attrApi.get(request, assetId)]));
      if (t !== ticket.current) return;
      if (a.asset_id !== assetId || a.project_id !== projectId || c.project_id !== projectId) throw Error('属性返回的人物或项目不一致，没有显示');
      setConfig(c); setAttrs(a); setState('ok');
      if (keepDraft) {
        const live = new Set(c.dimensions.map(d => d.id)), gone = (config?.dimensions ?? []).filter(d => edited.has(d.id) && !live.has(d.id)).map(d => '「' + d.name + '」');
        const keep = new Set([...edited].filter(id => live.has(id)));
        setEdited(keep);
        setDraft(d => d && Object.fromEntries(c.dimensions.map(dim => [dim.id, keep.has(dim.id) && dim.id in d ? d[dim.id] : scoreValue(a.scores[dim.id])])));
        if (gone.length) setNotice(gone.join('、') + '已在维度设置里被删除，那几项改动没法保存，已移出');
      }
    } catch (e) { if (t === ticket.current) { setState('error'); setError((e as Error).message || '属性读取失败'); } }
  }
  useEffect(() => { setDraft(null); setNotice(''); void load(); return () => { ticket.current++; }; }, [assetId, projectId, configVersion]);

  const dims = config?.dimensions ?? [];
  const startEdit = () => { if (!attrs) return; setNotice(''); setEdited(new Set()); setDraft(Object.fromEntries(dims.map(d => [d.id, scoreValue(attrs.scores[d.id])]))); };
  const setValue = (id: string, v: number | null) => { setEdited(e => new Set(e).add(id)); setDraft(d => d && { ...d, [id]: v }); };
  const changes = draft && attrs ? dims.filter(d => edited.has(d.id) && draft[d.id] !== scoreValue(attrs.scores[d.id]) && !(draft[d.id] === null && !attrs.scores[d.id])).map(d => ({ dimension_id: d.id, value: draft[d.id] })) : [];

  async function save() {
    if (!config || !attrs || !changes.length || saving) return;
    setSaving(true); setError('');
    try {
      const next = await attrApi.patch(request, assetId, { project_id: projectId, expected_config_revision: config.revision, expected_attribute_revision: attrs.attribute_revision, changes });
      if (next.asset_id !== assetId) throw Error('保存回执不属于当前人物，请重新打开后核对');
      setAttrs(next); setDraft(null); setEdited(new Set()); setNotice('属性已保存');
    } catch (e) {
      const code = errCode(e);
      if (code === 'ATTRIBUTE_STALE' || code === 'CONFIG_STALE') { setError(code === 'CONFIG_STALE' ? '属性维度刚被修改，已重新读取；你的改动还在，请核对后再保存' : '这个人物的属性刚在别处改过，已重新读取；你的改动还在，请核对后再保存'); void load(true); }
      else setError((e as Error).message || '保存失败，改动仍保留');
    } finally { setSaving(false); }
  }

  const src = sourceSummary(attrs, dims);
  return <section className="ca-attrs" aria-label="人物属性">
    <div className="ca-attrs-head">
      <h3><Radar size={18}/>人物属性</h3>
      {src && <span className="ca-attrs-source">{src.label}{src.at ? ' · ' + when(src.at) : ''}</span>}
      <span className="ca-grow"/>
      {!draft && <button type="button" disabled={state !== 'ok' || readOnly} title={readOnly ? '已归档的人物不能改属性' : undefined} onClick={startEdit}><Pencil size={14}/>编辑</button>}
      <button type="button" onClick={onOpenConfig}><SlidersHorizontal size={14}/>维度设置…</button>
    </div>
    {state === 'loading' && <p className="ca-muted">正在读取属性…</p>}
    {state === 'error' && <p className="ca-muted">属性没有读到。<button type="button" className="ca-link-button" onClick={() => void load()}>重新读取</button></p>}
    {state === 'ok' && attrs && <>
      <AttributeRadar dims={dims} series={[{ name, color: SINGLE_COLOR, scores: draft ? Object.fromEntries(dims.map(d => [d.id, { value: draft[d.id], source: 'manual' as const, reason: null, updated_at: 0 }])) : attrs.scores }]} label={name + '的属性雷达图'}/>
      <p className="ca-muted ca-attrs-legend">中心 -100 · 虚线圈 0 · 最外圈 +100{!src && !draft ? '。还没有分数：点「编辑」手动打分，或在「维度设置」里让 AI 按剧本打分' : ''}</p>
      {notice && <p className="ca-attrs-notice" role="status">{notice}</p>}
      {draft && <div className="ca-attrs-edit" role="group" aria-label="编辑属性">
        {dims.map(d => { const v = draft[d.id]; return <div key={d.id} className="ca-attrs-row">
          <strong>{d.name}</strong>
          <span className="ca-attrs-pole">{d.negative_label}</span>
          <input type="range" min={-100} max={100} step={1} value={v ?? 0} aria-label={d.name + '分数'} onChange={e => setValue(d.id, clampScore(Number(e.target.value)))}/>
          <span className="ca-attrs-pole">{d.positive_label}</span>
          <input type="number" min={-100} max={100} step={1} value={v ?? ''} placeholder="未评" aria-label={d.name + '数值'} onChange={e => setValue(d.id, e.target.value === '' ? null : clampScore(Number(e.target.value)))}/>
          <span className={'ca-attrs-tier' + (v === null ? ' is-unrated' : '')}>{v === null ? '未评' : tierText(d, v) + ' ' + signed(v)}</span>
          <button type="button" className="ca-link-button" disabled={v === null} onClick={() => setValue(d.id, null)}>清空</button>
        </div>; })}
        <div className="ca-attrs-actions"><small className="ca-muted">手动改过的分不会被 AI 重新打分覆盖；清空 = 未评</small><span className="ca-grow"/>
          <button type="button" disabled={saving} onClick={() => setDraft(null)}>取消</button>
          <button type="button" className="ca-primary" disabled={!changes.length || saving} onClick={() => void save()}>{saving ? '保存中…' : '保存属性'}</button></div>
      </div>}
    </>}
  </section>;
}
