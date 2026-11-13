// 第二期 P2a 第 5 步：本季设定——这一季对共享资产覆盖了什么，一页看全（设计稿 F）。
// 读 <season>/overrides（本季直接覆盖）与 <season>/assets（候选，按季解析的 effective）；设置 / 恢复走季层 overrides PATCH。
// 评分在季层只读（用户决定评分只有集、全剧两层），这里不显示评分入口。
import React, { useEffect, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type { EffectiveField, FieldSource, ScopedItem, ScopedList } from './scoped';
import { imageKey, sourceLabel } from './ScopeOverrides';

type Kind = 'character' | 'scene' | 'prop';
type Look = { id: string; name: string; archived_at: number | null };
type Img = { id: string; look_id: string | null; archived_at: number | null; last_known_name?: string | null };
type A = { id: string; name: string; kind: Kind; looks: Look[]; images: Img[] };
type OverrideRow = { asset: { id: string; name: string; kind: Kind }; field: { key: 'default_look' | 'default_image'; look_id?: string | null }; value: string | null; source: FieldSource; override: { value: string | null; revision: number } | null; parent: { value: string | null; source: FieldSource } | null; write_token: string };
type Api = <T>(url: string, body?: unknown, method?: string) => Promise<T>;
const kinds: [Kind, string][] = [['character', '人物'], ['scene', '场景'], ['prop', '道具']];

export function SeasonSettings({ api, base, seasonName, seriesName, onClose, onChanged }: { api: Api; base: string; seasonName: string; seriesName: string; onClose: () => void; onChanged: () => void }) {
  const [kind, setKind] = useState<Kind>('character'), [rows, setRows] = useState<OverrideRow[] | null>(null), [assets, setAssets] = useState<ScopedItem<A>[]>([]);
  const [token, setToken] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [pick, setPick] = useState<{ assetId: string; field: string; value: string }>({ assetId: '', field: '', value: '' });
  const nameOf = (assetId: string, id: string | null) => { if (!id) return '无'; const a = assets.find(x => x.asset.id === assetId)?.asset; return a?.looks.find(l => l.id === id)?.name ?? a?.images.find(b => b.id === id)?.last_known_name ?? id; };
  const lookName = (assetId: string, lookId?: string | null) => assets.find(x => x.asset.id === assetId)?.asset.looks.find(l => l.id === lookId)?.name ?? '';
  async function load() {
    setError('');
    try {
      const [o, a] = await Promise.all([api<{ context_token: string; items: OverrideRow[] }>(base + '/overrides?' + new URLSearchParams({ kind })), api<ScopedList<A>>(base + '/assets?' + new URLSearchParams({ kind, archived: 'false', page: '1' }))]);
      setRows(o.items); setAssets(a.items); setToken(o.context_token || a.context_token);
    } catch (e) { setError((e as Error).message || '本季设定读取失败'); setRows([]); }
  }
  useEffect(() => { setRows(null); setPick({ assetId: '', field: '', value: '' }); void load(); }, [kind, base]);
  async function write(assetId: string, field: { key: string; look_id?: string | null }, action: 'set' | 'inherit', writeToken: string, value?: string) {
    setBusy(action === 'set' ? '正在保存本季设置…' : '正在恢复全剧…'); setError('');
    try {
      await api(base + '/assets/' + assetId + '/overrides', { request_id: crypto.randomUUID(), context_token: token, write_token: writeToken, field, action, ...(action === 'set' ? { value } : {}) }, 'PATCH');
      await load(); onChanged(); setPick({ assetId: '', field: '', value: '' });
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === 'ASSET_SCOPE_CHANGED' || code === 'ASSET_STALE' ? '这一季的归组或资料刚变了，已重新读取，请核对后再设置' : (e as Error).message || '保存失败');
      if (code === 'ASSET_SCOPE_CHANGED' || code === 'ASSET_STALE') void load();
    } finally { setBusy(''); }
  }
  // 新增覆盖：从本季候选（按季解析）里挑资产和字段
  const cand = assets.find(x => x.asset.id === pick.assetId);
  const fieldsOf = (x: ScopedItem<A>): { id: string; label: string; f: EffectiveField<string | null>; key: { key: 'default_look' | 'default_image'; look_id?: string | null } }[] => {
    const e = x.effective, out: ReturnType<typeof fieldsOf> = [];
    if (x.asset.kind === 'character' && e.default_look) out.push({ id: 'default_look', label: '默认造型', f: e.default_look, key: { key: 'default_look' } });
    for (const l of x.asset.kind === 'character' ? x.asset.looks.filter(l => !l.archived_at) : [null]) {
      const f = e.default_images?.[imageKey(l?.id ?? null)]; if (f) out.push({ id: 'img:' + (l?.id ?? 'null'), label: l ? '「' + l.name + '」默认图' : '默认图', f, key: { key: 'default_image', look_id: l?.id ?? null } });
    }
    return out;
  };
  const fields = cand ? fieldsOf(cand) : [], field = fields.find(f => f.id === pick.field);
  const choices = !cand || !field ? [] : field.key.key === 'default_look' ? cand.asset.looks.filter(l => !l.archived_at).map(l => ({ id: l.id, name: l.name })) : cand.asset.images.filter(b => !b.archived_at && (cand.asset.kind !== 'character' || b.look_id === field.key.look_id)).map(b => ({ id: b.id, name: b.last_known_name || '参考图片' }));
  return <div className="ca-modal-backdrop" onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose(); }}>
    <div className="ca-modal ca-season" role="dialog" aria-modal="true" aria-label={seasonName + ' · 本季设定'}>
      <header><h2>{seasonName} · 本季设定</h2><button aria-label="关闭" disabled={!!busy} onClick={onClose}><X size={18}/></button></header>
      <div className="ca-modal-scroll"><div className="ca-season-body">
        <p className="ca-muted">这一季对「{seriesName}」全剧资产的单独设置。只影响这一季里没有自己单独设置的集；评分不分季，在集里或全剧设置。</p>
        <div className="ca-tabs" role="tablist" aria-label="资产类别">{kinds.map(([k, l]) => <button key={k} role="tab" aria-selected={kind === k} disabled={!!busy} onClick={() => setKind(k)}>{l}</button>)}</div>
        {error && <p className="ca-alert" role="alert">{error}</p>}
        <section aria-label="本季已有的设置">
          <h3>本季已有的设置{rows ? ' · ' + rows.length : ''}</h3>
          {rows === null ? <p className="ca-muted" role="status">正在读取…</p> : !rows.length ? <p className="ca-muted">这一季还没有单独设置，都沿用全剧。</p> :
            <table className="ca-season-table"><thead><tr><th>资产</th><th>项目</th><th>本季</th><th>全剧</th><th/></tr></thead><tbody>{rows.map(r => {
              const label = r.field.key === 'default_look' ? '默认造型' : r.field.look_id ? '「' + lookName(r.asset.id, r.field.look_id) + '」默认图' : '默认图';
              return <tr key={r.asset.id + r.field.key + (r.field.look_id ?? '')}><td>{r.asset.name}</td><td>{label}</td><td><b>{nameOf(r.asset.id, r.value)}</b></td><td>{r.parent ? nameOf(r.asset.id, r.parent.value) + (r.parent.source.type !== 'series' ? '（' + sourceLabel(r.parent.source) + '）' : '') : '无'}</td>
                <td><button type="button" disabled={!!busy} aria-label={'恢复全剧：' + r.asset.name + ' ' + label} onClick={() => void write(r.asset.id, r.field, 'inherit', r.write_token)}><RotateCcw size={13}/>恢复全剧</button></td></tr>;
            })}</tbody></table>}
        </section>
        <section aria-label="新增本季设置" className="ca-season-add">
          <h3>新增本季设置</h3>
          <div className="ca-season-pick">
            <select aria-label="选择资产" value={pick.assetId} disabled={!!busy} onChange={e => setPick({ assetId: e.target.value, field: '', value: '' })}><option value="">选择{kinds.find(k => k[0] === kind)?.[1]}</option>{assets.map(x => <option key={x.asset.id} value={x.asset.id}>{x.asset.name}</option>)}</select>
            <select aria-label="选择设置项" value={pick.field} disabled={!!busy || !cand} onChange={e => setPick({ ...pick, field: e.target.value, value: '' })}><option value="">设置项</option>{fields.map(f => <option key={f.id} value={f.id}>{f.label}（现在：{nameOf(pick.assetId, f.f.value)} · {sourceLabel(f.f.source)}）</option>)}</select>
            <select aria-label="选择本季的值" value={pick.value} disabled={!!busy || !field} onChange={e => setPick({ ...pick, value: e.target.value })}><option value="">本季用…</option>{choices.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <button type="button" className="ca-primary" disabled={!!busy || !field || !pick.value || pick.value === field.f.value} onClick={() => field && void write(pick.assetId, field.key, 'set', field.f.write_token, pick.value)}>设为本季</button>
          </div>
        </section>
        {busy && <p className="ca-muted" role="status">{busy}</p>}
      </div></div>
    </div>
  </div>;
}
