// 第二期 P2a 第 2 步：集视图里继承自全剧的资产，「本集设置」——默认造型、各造型默认图按「本集 → 本季 → 全剧」覆盖。
// 写入走 <scope>/assets/:id/overrides（set / inherit），令牌原样回传；返回更新后的详情，以服务端读回为准。
import React, { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { EffectiveField, FieldSource, ScopedItem } from './scoped';

type LookLike = { id: string; name: string; archived_at: number | null };
type BindingLike = { id: string; look_id: string | null; archived_at: number | null; last_known_name?: string | null };
type AssetLike = { id: string; kind: 'character' | 'scene' | 'prop'; looks: LookLike[]; images: BindingLike[] };

export const sourceLabel = (s?: FieldSource) => !s ? '' : s.type === 'episode' ? '本集' : s.type === 'season' ? '本季' : s.type === 'series' ? '全剧' : '本集自有';
/** 场景 / 道具的默认图没有造型，合同里 look_id 记为 null。 */
export const imageKey = (lookId: string | null) => lookId ?? 'null';

export type OverrideField = { key: 'default_look' | 'default_image' | 'attribute_score'; look_id?: string | null; dimension_id?: string };
export type OverrideRequest = (field: OverrideField, action: 'set' | 'inherit', value: unknown, writeToken: string) => void;
/** 评分维度（与 attributes.ts 的 AttrDimension 同形，这里只用到名称和两端说明）。 */
export type ScoreDimension = { id: string; name: string; negative_label: string; positive_label: string };
type ScoreValue = { value: number | null } | null;
/** 集里追加造型的预览回执（合同 v1：append/preview）。 */
export type AppendPreview = { preview_token: string; sets_series_default: boolean; impact?: { episodes?: { id: string; name: string }[] } };
export type AppendHandlers = { preview: (name: string) => Promise<AppendPreview>; confirm: (token: string, allowSeriesDefault: boolean) => Promise<void> };

/** 在本集新增造型：先预览，确认后写到全剧（服务端记录来源集）；成为全剧默认时需明确勾选。 */
function AppendLook({ busy, handlers, seriesName }: { busy: boolean; handlers: AppendHandlers; seriesName: string }) {
  const [name, setName] = useState(''), [preview, setPreview] = useState<AppendPreview | null>(null), [allow, setAllow] = useState(false), [working, setWorking] = useState(false);
  const off = busy || working;
  const run = async (fn: () => Promise<void>) => { setWorking(true); try { await fn(); } finally { setWorking(false); } };
  if (!preview) return <div className="ca-override-row ca-append" role="group" aria-label="在本集新增造型">
    <span className="ca-override-label">新增造型</span>
    <input value={name} maxLength={120} placeholder="造型名称，如：夜行服" aria-label="新造型名称" disabled={off} onChange={e => setName(e.target.value)}/>
    <button type="button" disabled={off || !name.trim()} onClick={() => void run(async () => { const p = await handlers.preview(name.trim()); setPreview(p); setAllow(false); })}>预览</button>
  </div>;
  return <div className="ca-append-confirm" role="group" aria-label="确认新增造型">
    <p>新造型「{name.trim()}」会加到{seriesName ? '「' + seriesName + '」' : ''}全剧的这个人物上，记下来源是本集；其他集也能看到它，但不会改它们的默认造型。</p>
    {preview.sets_series_default && <label className="ca-append-default"><input type="checkbox" checked={allow} disabled={off} onChange={e => setAllow(e.target.checked)}/>这是这个人物的第一个造型，会成为<b>全剧默认造型</b>。我已了解</label>}
    <span className="ca-append-actions"><button type="button" disabled={off} onClick={() => setPreview(null)}>返回修改</button><button type="button" className="ca-primary" disabled={off || preview.sets_series_default && !allow} onClick={() => void run(async () => { await handlers.confirm(preview.preview_token, preview.sets_series_default && allow); setPreview(null); setName(''); })}>确认新增</button></span>
  </div>;
}

/** 把实际生效的默认值叠到只读详情上，让下面的造型和图片按「本集看到的样子」显示（只读，不会保存）。 */
export function withEffective<A extends AssetLike & { default_look_id: string | null; default_image_id?: string | null; looks: (LookLike & { default_image_id: string | null })[] }>(a: A, meta?: Omit<ScopedItem<A>, 'asset'>): A {
  const e = meta?.effective; if (!e) return a;
  const next = structuredClone(a);
  if (e.default_look && next.kind === 'character') next.default_look_id = e.default_look.value;
  for (const l of next.looks) { const f = e.default_images?.[imageKey(l.id)]; if (f) l.default_image_id = f.value; }
  if (next.kind !== 'character') { const f = e.default_images?.[imageKey(null)]; if (f) next.default_image_id = f.value; }
  return next;
}

function SourceTag({ field }: { field?: EffectiveField<unknown> }) {
  if (!field) return null;
  return <span className={'ca-src-tag is-' + field.source.type} title={field.override ? '本集单独设置了这一项' : '没有单独设置，沿用上层'}>{sourceLabel(field.source)}</span>;
}

/** 一个维度的本集评分：显示实际值与来源，可本集改分或恢复全剧。只有集、全剧两层（用户决定不做季层）。 */
function ScoreRow({ dim, field, busy, canWrite, onOverride }: { dim: ScoreDimension; field: EffectiveField<unknown>; busy: boolean; canWrite: boolean; onOverride: OverrideRequest }) {
  const current = (field.value as ScoreValue)?.value ?? null;
  const [input, setInput] = useState(current === null ? '' : String(current));
  const parsed = input.trim() === '' ? null : Math.max(-100, Math.min(100, Math.round(Number(input))));
  const valid = input.trim() === '' || Number.isFinite(Number(input));
  return <div className="ca-override-row ca-score-row" role="group" aria-label={'评分「' + dim.name + '」'}>
    <span className="ca-override-label">{dim.name} <SourceTag field={field}/></span>
    <span className="ca-score-now">{current === null ? '未评' : (current > 0 ? '+' : '') + current}<small>{dim.negative_label} ↔ {dim.positive_label}</small></span>
    <input type="number" min={-100} max={100} step={1} value={input} placeholder="未评" aria-label={dim.name + '本集分数'} disabled={busy || !canWrite} onChange={e => setInput(e.target.value)}/>
    <button type="button" disabled={busy || !canWrite || !valid || parsed === current} onClick={() => onOverride({ key: 'attribute_score', dimension_id: dim.id }, 'set', { value: parsed }, field.write_token)}>本集改分</button>
    {field.override && <button type="button" className="ca-override-reset" disabled={busy || !canWrite} onClick={() => onOverride({ key: 'attribute_score', dimension_id: dim.id }, 'inherit', null, field.write_token)}><RotateCcw size={13}/>恢复全剧</button>}
  </div>;
}

export function ScopeOverrides({ asset, meta, lookId, busy, thumb, onOverride, dims, dimsNote, append, seriesName }: {
  asset: AssetLike; meta: Omit<ScopedItem<AssetLike>, 'asset'>; lookId: string | null; busy: boolean;
  thumb: (b: BindingLike) => React.ReactNode; onOverride: OverrideRequest; dims?: ScoreDimension[]; dimsNote?: string; append?: AppendHandlers; seriesName?: string;
}) {
  const e = meta.effective, canWrite = meta.capabilities.create_override;
  const looks = asset.looks.filter(l => !l.archived_at);
  const lookField = asset.kind === 'character' ? e.default_look : undefined;
  const imgLook = asset.kind === 'character' ? lookId : null;
  const imgField = e.default_images?.[imageKey(imgLook)];
  const images = asset.images.filter(b => !b.archived_at && (asset.kind !== 'character' || b.look_id === imgLook));
  const look = looks.find(l => l.id === imgLook);
  return <section className="ca-scope-overrides" aria-label="本集设置">
    <h3>本集设置 <small>只影响这一集；没有单独设置的项沿用本季或全剧</small></h3>
    {lookField && <div className="ca-override-row" role="group" aria-label="默认造型">
      <span className="ca-override-label">默认造型 <SourceTag field={lookField}/></span>
      <span className="ca-override-choices">{looks.map(l => <button type="button" key={l.id} aria-pressed={lookField.value === l.id} disabled={busy || !canWrite || lookField.value === l.id} onClick={() => onOverride({ key: 'default_look' }, 'set', l.id, lookField.write_token)}>{l.name}</button>)}</span>
      {lookField.override && <button type="button" className="ca-override-reset" disabled={busy || !canWrite} onClick={() => onOverride({ key: 'default_look' }, 'inherit', null, lookField.write_token)}><RotateCcw size={13}/>恢复上层{lookField.parent ? '（' + sourceLabel(lookField.parent.source) + '）' : ''}</button>}
    </div>}
    {imgField && <div className="ca-override-row" role="group" aria-label={asset.kind === 'character' ? '造型「' + (look?.name ?? '') + '」的默认图' : '默认图'}>
      <span className="ca-override-label">{asset.kind === 'character' ? <>「{look?.name ?? '当前造型'}」默认图</> : '默认图'} <SourceTag field={imgField}/></span>
      <span className="ca-override-thumbs">{images.length ? images.map(b => <button type="button" key={b.id} aria-label={'设为本集默认图：' + (b.last_known_name || '参考图片')} aria-pressed={imgField.value === b.id} disabled={busy || !canWrite || imgField.value === b.id} onClick={() => onOverride({ key: 'default_image', look_id: imgLook }, 'set', b.id, imgField.write_token)}>{thumb(b)}</button>) : <small>这个造型还没有图片</small>}</span>
      {imgField.override && <button type="button" className="ca-override-reset" disabled={busy || !canWrite} onClick={() => onOverride({ key: 'default_image', look_id: imgLook }, 'inherit', null, imgField.write_token)}><RotateCcw size={13}/>恢复上层{imgField.parent ? '（' + sourceLabel(imgField.parent.source) + '）' : ''}</button>}
    </div>}
    {asset.kind === 'character' && !!dims?.length && <div className="ca-score-overrides" role="group" aria-label="属性评分">
      <span className="ca-override-label">属性评分 <small className="ca-muted">只分本集和全剧两层</small></span>
      {dims.map(d => { const f = e.attribute_scores?.[d.id]; return f ? <ScoreRow key={d.id + ':' + JSON.stringify(f.value) + ':' + (f.override?.revision ?? 0)} dim={d} field={f} busy={busy} canWrite={canWrite} onOverride={onOverride}/> : null; })}
    </div>}
    {asset.kind === 'character' && append && meta.capabilities.append && <AppendLook busy={busy} handlers={append} seriesName={seriesName ?? ''}/>}
    {!!dimsNote && <p className="ca-muted" role="status">{dimsNote}</p>}
    {!canWrite && <p className="ca-muted">当前没有设置本集覆盖的权限。</p>}
  </section>;
}
