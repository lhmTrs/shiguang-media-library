import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Sparkles, X } from 'lucide-react';
import type { PromptRequest } from '../PromptTemplateWorkspace';
import { AgentShare } from '../AgentShare';
import { type AttrConfig, type DimensionDraft, type RemovalPreview, attrApi, defaultTiers, errCode } from './attributes';

type Row = DimensionDraft & { key: string; custom: boolean };
const MIN = 3, MAX = 8;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const toRows = (c: AttrConfig): Row[] => c.dimensions.map(d => {
  const tiers = d.tier_labels?.length === 5 ? d.tier_labels : defaultTiers(d);
  return { key: d.id, id: d.id, name: d.name, negative_label: d.negative_label, positive_label: d.positive_label, neutral_label: d.neutral_label, criterion: d.criterion ?? '', tier_labels: tiers, custom: !same(tiers, defaultTiers(d)) };
});
const tiersOfRow = (r: Row) => r.custom && r.tier_labels?.length === 5 ? r.tier_labels : defaultTiers(r);

/** 项目「人物属性维度」配置：改名、两端名、档名、顺序、增删；删掉已有分数的维度要先看影响并确认。 */
export function AttributeConfig({ projectId, projectName, request, onClose, onSaved }: { projectId: string; projectName: string; request: PromptRequest; onClose: () => void; onSaved: (c: AttrConfig) => void }) {
  const [config, setConfig] = useState<AttrConfig | null>(null), [rows, setRows] = useState<Row[]>([]), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<RemovalPreview | null>(null), [openTiers, setOpenTiers] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  async function load(message = '') {
    try { const c = await attrApi.config(request, projectId); if (c.project_id !== projectId) throw Error('维度配置不属于当前项目'); setConfig(c); setRows(toRows(c)); setConfirm(null); setError(message); }
    catch (e) { setError((e as Error).message || '维度配置读取失败'); }
  }
  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('input, button')?.focus(); }, [!!config]);

  const edit = (key: string, patch: Partial<Row>) => setRows(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r));
  const move = (i: number, d: -1 | 1) => setRows(rs => { const next = [...rs]; [next[i], next[i + d]] = [next[i + d], next[i]]; return next; });
  const problem = rows.length < MIN ? `至少 ${MIN} 个维度` : rows.length > MAX ? `最多 ${MAX} 个维度`
    : rows.some(r => !r.name.trim() || r.name.trim().length > 20) ? '维度名称要 1–20 个字'
    : new Set(rows.map(r => r.name.trim())).size !== rows.length ? '维度名称不能重复'
    : rows.some(r => !r.negative_label.trim() || !r.positive_label.trim()) ? '每个维度都要写两端名称'
    : rows.some(r => r.custom && tiersOfRow(r).some(t => !t.trim())) ? '自定义的五档名称不能留空' : '';
  const payload = () => rows.map(r => ({ id: r.id, name: r.name.trim(), negative_label: r.negative_label.trim(), positive_label: r.positive_label.trim(), neutral_label: (r.custom ? tiersOfRow(r)[2] : r.neutral_label).trim() || '中立', tier_labels: tiersOfRow(r).map(t => t.trim()), criterion: r.criterion.trim() }));

  async function put(token?: string) {
    if (!config) return;
    const next = await attrApi.saveConfig(request, projectId, { expected_revision: config.revision, dimensions: payload(), ...(token ? { removal_confirmation: { token } } : {}) });
    if (next.project_id !== projectId) throw Error('保存回执不属于当前项目');
    onSaved(next); onClose();
  }
  async function save() {
    if (!config || problem || saving) return;
    setSaving(true); setError('');
    try {
      const removed = config.dimensions.map(d => d.id).filter(id => !rows.some(r => r.id === id));
      if (removed.length && !confirm) {
        const preview = await attrApi.removalPreview(request, projectId, { expected_revision: config.revision, remove: removed });
        if (preview.affected.some(a => a.scored_assets > 0)) { setConfirm(preview); return; }
        await put(preview.token); return;
      }
      await put(confirm?.token);
    } catch (e) {
      const code = errCode(e);
      if (code === 'CONFIG_STALE') await load('维度刚在别处改过，已重新读取；请重新修改后保存');
      else if (code === 'REMOVAL_PREVIEW_STALE' || code === 'DIMENSION_REMOVAL_CONFIRM') { setConfirm(null); setError('删除的影响范围刚变了，请再点一次「保存配置」重新确认'); }
      else setError((e as Error).message || '保存失败，改动仍保留');
    } finally { setSaving(false); }
  }

  return <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose(); }} onKeyDown={e => { if (e.key === 'Escape' && !saving) { e.stopPropagation(); onClose(); } }}>
    <div className="ca-modal ca-attr-config" ref={dialog} role="dialog" aria-modal="true" aria-label="人物属性维度">
      <header><div><h2>人物属性维度 · {projectName}</h2><p className="ca-muted">每个维度 -100 ~ +100，0 居中；五档：-100～-60、-59～-20、-19～19、20～59、60～100。这是本项目的配置，可按剧本修改。</p></div>
        <button type="button" className="ca-icon-button" aria-label="关闭维度设置" disabled={saving} onClick={onClose}><X size={17}/></button></header>
      <div className="ca-modal-content">
        {error && <div className="ca-alert" role="alert">{error}</div>}
        {!config ? <p className="ca-muted">正在读取维度配置…</p> : <>
          <div className="ca-attr-table" role="list" aria-label="维度列表">
            <div className="ca-attr-cols" aria-hidden="true"><span/><span>维度</span><span>左端（负）</span><span>右端（正）</span><span>五档名称</span><span/></div>
            {rows.map((r, i) => <div key={r.key} role="listitem" className="ca-attr-dim">
              <div className="ca-attr-cols">
                <span className="ca-attr-order"><button type="button" aria-label={'上移' + r.name} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={13}/></button><button type="button" aria-label={'下移' + r.name} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={13}/></button></span>
                <input aria-label={`第 ${i + 1} 个维度名称`} maxLength={20} value={r.name} onChange={e => edit(r.key, { name: e.target.value })}/>
                <input aria-label={(r.name || '维度') + '左端名称'} maxLength={12} value={r.negative_label} onChange={e => edit(r.key, { negative_label: e.target.value })}/>
                <input aria-label={(r.name || '维度') + '右端名称'} maxLength={12} value={r.positive_label} onChange={e => edit(r.key, { positive_label: e.target.value })}/>
                <button type="button" className="ca-attr-tiers" aria-expanded={openTiers === r.key} title="点开可逐档改名" onClick={() => setOpenTiers(k => k === r.key ? '' : r.key)}>{tiersOfRow(r).map((t, j) => <span key={j}>{t || '—'}</span>)}</button>
                <button type="button" className="ca-icon-button" aria-label={'删除' + (r.name || '维度')} disabled={rows.length <= MIN} onClick={() => setRows(rs => rs.filter(x => x.key !== r.key))}><X size={14}/></button>
              </div>
              {openTiers === r.key && <div className="ca-attr-tier-edit">
                {tiersOfRow(r).map((t, j) => <input key={j} aria-label={`${r.name || '维度'}第 ${j + 1} 档名称`} maxLength={12} value={t} onChange={e => { const next = [...tiersOfRow(r)]; next[j] = e.target.value; edit(r.key, { custom: true, tier_labels: next }); }}/>)}
                <button type="button" className="ca-link-button" disabled={!r.custom} onClick={() => edit(r.key, { custom: false, tier_labels: undefined })}>按两端名自动生成</button>
                <input className="ca-attr-criterion" aria-label={(r.name || '维度') + '判断标准'} maxLength={120} placeholder="判断标准（可选，给 AI 打分参考）" value={r.criterion} onChange={e => edit(r.key, { criterion: e.target.value })}/>
              </div>}
            </div>)}
          </div>
          <div className="ca-attr-config-tools">
            <button type="button" disabled={rows.length >= MAX} onClick={() => setRows(rs => [...rs, { key: crypto.randomUUID(), id: null, name: '', negative_label: '', positive_label: '', neutral_label: '中立', criterion: '', custom: false }])}><Plus size={14}/>新增维度</button>
            <small className="ca-muted">改名、改顺序不影响分数；改了含义或对调两端，请删掉旧维度再新增，避免旧分数被读错。</small>
          </div>
          <div className="ca-attr-ai"><Sparkles size={16}/><div><b>让 AI 按剧本打分</b><p className="ca-muted">打开「分享给 Agent」，把说明交给你常用的 Agent：它会读剧本和这些维度，为本项目定最合适的维度并打分；你手动改过的分不会被覆盖。这里只准备说明，不会自动开始。</p></div><AgentShare projectId={projectId} projectName={projectName}/></div>
          {confirm && <div className="ca-attr-confirm" role="alert">
            <b>删除这些维度会一并删掉已有分数，不能撤销：</b>
            <ul>{confirm.affected.filter(a => a.scored_assets > 0).map(a => <li key={a.dimension_id}>「{a.name}」：{a.scored_assets} 个人物有分数{a.archived_scored_assets ? `（其中 ${a.archived_scored_assets} 个已归档）` : ''}</li>)}</ul>
            <span>确认后再点「删除并保存」。</span>
          </div>}
        </>}
      </div>
      <footer>{problem && config && <small className="ca-attr-problem">{problem}</small>}
        <button type="button" disabled={saving} onClick={() => confirm ? setConfirm(null) : onClose()}>{confirm ? '先不删' : '取消'}</button>
        <button type="button" className="ca-primary" disabled={!config || !!problem || saving} onClick={() => void save()}>{saving ? '保存中…' : confirm ? '删除并保存' : '保存配置'}</button></footer>
    </div>
  </div>;
}
