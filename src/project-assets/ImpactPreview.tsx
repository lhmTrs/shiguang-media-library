// 第二期 P2a 第 4 步：归档与提升的影响预览（合同 v1：archive-impact / promotion preview → confirm）。
// 预览列出受影响的季、集与字段前后值，单列明确引用的镜头；有阻断项时不能确认。确认以服务端读回为准。
import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

export type ImpactField = { key: string; look_id?: string | null; dimension_id?: string; before: unknown; after: unknown; invalidates_override?: boolean };
export type ImpactScope = { id: string; name: string; fields: ImpactField[] };
export type ImpactBlocker = { code: string; candidates?: { id: string; name: string }[]; conflicts?: { id: string; name: string; scope_name?: string; project_name?: string }[]; dimensions?: (string | { id: string; name?: string })[]; manifests?: unknown[]; reason?: string };
export type Impact = { seasons?: ImpactScope[]; episodes?: ImpactScope[]; explicit_shots?: { episode_id: string; episode_name: string; number: number | string; scene_id?: string }[]; blockers?: ImpactBlocker[] };
export type ImpactPreviewData = { preview_token: string; impact: Impact };

const fieldName = (f: ImpactField, nameOf: (id: string) => string) =>
  f.key === 'default_look' ? '默认造型' : f.key.startsWith('default_image') ? (f.look_id ? '「' + nameOf(f.look_id) + '」默认图' : '默认图') :
  f.key === 'attribute_score' ? '评分「' + (f.dimension_id ? nameOf(f.dimension_id) : '') + '」' : f.key === 'cover' ? '封面' : f.key === 'visible' ? '在这里可见' : f.key === 'owner' ? '归属' : f.key;
function valueText(v: unknown, nameOf: (id: string) => string): string {
  if (v === null || v === undefined) return '无';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'string') return nameOf(v);
  if (typeof v === 'object' && v && 'value' in v) { const n = (v as { value: number | null }).value; return n === null ? '未评' : (n > 0 ? '+' : '') + n; }
  if (typeof v === 'object' && v && 'type' in v) return (v as { type: string }).type === 'series' ? '全剧' : '本集';
  return String(v);
}
function blockerText(b: ImpactBlocker) {
  if (b.code === 'ASSET_REPLACEMENT_REQUIRED') return '这是全剧默认项：先选一个替代，再重新预览。';
  if (b.code === 'ASSET_IN_USE') return '还有分镜明确引用它（下方「明确引用的镜头」）或素材清单在用：先在分镜里处理这些引用。';
  if (b.code === 'ASSET_NAME_CONFLICT') return '和其他集里的同名资产冲突：' + (b.conflicts ?? []).map(c => '「' + (c.scope_name || c.project_name ? (c.scope_name || c.project_name) + ' · ' : '') + c.name + '」').join('、') + '。先改名或处理后再试。';
  if (b.code === 'ASSET_PROMOTION_ATTRIBUTES_CONFLICT') return b.reason === 'EXISTING_DESTINATION_STATE' ? '全剧这边已有这个资产的评分状态，不能直接提升。' : '评分维度和全剧的不一致，不能无损带过去：' + (b.dimensions ?? []).map(d => typeof d === 'string' ? d : d.name ?? d.id).join('、') + '。';
  return b.code;
}

export function ImpactPreview({ title, intro, data, nameOf, busy, replacement, onReplacement, onConfirm, onClose, confirmLabel }: {
  title: string; intro: React.ReactNode; data: ImpactPreviewData; nameOf: (id: string) => string; busy: boolean;
  replacement: string | null; onReplacement: (id: string) => void; onConfirm: () => void; onClose: () => void; confirmLabel: string;
}) {
  const { impact } = data, blockers = impact.blockers ?? [], shots = impact.explicit_shots ?? [];
  const scopes = [...(impact.seasons ?? []).map(s => ({ ...s, label: '季' })), ...(impact.episodes ?? []).map(s => ({ ...s, label: '集' }))].filter(s => s.fields.length);
  const replaceBlocker = blockers.find(b => b.code === 'ASSET_REPLACEMENT_REQUIRED');
  return <div className="ca-modal-backdrop" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); }}>
    <div className="ca-modal ca-impact" role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button aria-label="关闭" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      <div className="ca-modal-scroll"><div className="ca-impact-body">
        <p>{intro}</p>
        {!!blockers.length && <ul className="ca-impact-blockers" role="alert">{blockers.map((b, i) => <li key={i}><AlertTriangle size={14} aria-hidden="true"/>{blockerText(b)}</li>)}</ul>}
        {replaceBlocker && <label className="ca-field"><span>替代项</span><select aria-label="选择替代项" value={replacement ?? ''} disabled={busy} onChange={e => e.target.value && onReplacement(e.target.value)}><option value="" disabled>请选择</option>{(replaceBlocker.candidates ?? []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
        <section aria-label="受影响的季和集"><h3>受影响的季和集</h3>{scopes.length ? <ul className="ca-impact-scopes">{scopes.map(s => <li key={s.label + s.id}><b>{s.name}</b><ul>{s.fields.map((f, i) => <li key={i}>{fieldName(f, nameOf)}：{valueText(f.before, nameOf)} → {valueText(f.after, nameOf)}{f.invalidates_override ? '（本层的单独设置会失效）' : ''}</li>)}</ul></li>)}</ul> : <p className="ca-muted">没有季或集的显示会变化。</p>}</section>
        <section aria-label="明确引用的镜头"><h3>明确引用的镜头</h3>{shots.length ? <ul>{shots.map((s, i) => <li key={i}>{s.episode_name} · 镜 {s.number}</li>)}</ul> : <p className="ca-muted">没有镜头明确引用它。</p>}</section>
      </div></div>
      <footer><button disabled={busy} onClick={onClose}>取消</button><button className="ca-primary ca-danger-confirm" disabled={busy || !!blockers.length} onClick={onConfirm}>{confirmLabel}</button></footer>
    </div>
  </div>;
}
