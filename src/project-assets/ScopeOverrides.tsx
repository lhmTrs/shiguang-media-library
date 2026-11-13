// 第二期 P2a 第 2 步：集视图里继承自全剧的资产，「本集设置」——默认造型、各造型默认图按「本集 → 本季 → 全剧」覆盖。
// 写入走 <scope>/assets/:id/overrides（set / inherit），令牌原样回传；返回更新后的详情，以服务端读回为准。
import React from 'react';
import { RotateCcw } from 'lucide-react';
import type { EffectiveField, FieldSource, ScopedItem } from './scoped';

type LookLike = { id: string; name: string; archived_at: number | null };
type BindingLike = { id: string; look_id: string | null; archived_at: number | null; last_known_name?: string | null };
type AssetLike = { id: string; kind: 'character' | 'scene' | 'prop'; looks: LookLike[]; images: BindingLike[] };

export const sourceLabel = (s?: FieldSource) => !s ? '' : s.type === 'episode' ? '本集' : s.type === 'season' ? '本季' : s.type === 'series' ? '全剧' : '本集自有';
/** 场景 / 道具的默认图没有造型，合同里 look_id 记为 null。 */
export const imageKey = (lookId: string | null) => lookId ?? 'null';

export type OverrideField = { key: 'default_look' | 'default_image'; look_id?: string | null };
export type OverrideRequest = (field: OverrideField, action: 'set' | 'inherit', value: string | null, writeToken: string) => void;

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

export function ScopeOverrides({ asset, meta, lookId, busy, thumb, onOverride }: {
  asset: AssetLike; meta: Omit<ScopedItem<AssetLike>, 'asset'>; lookId: string | null; busy: boolean;
  thumb: (b: BindingLike) => React.ReactNode; onOverride: OverrideRequest;
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
    {!canWrite && <p className="ca-muted">当前没有设置本集覆盖的权限。</p>}
  </section>;
}
