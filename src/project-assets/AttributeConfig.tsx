import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Sparkles, X } from 'lucide-react';
import type { PromptRequest } from '../PromptTemplateWorkspace';
import { AgentShare } from '../AgentShare';
import { type AttrConfig, type AttrDimension, type DimensionDraft, type RemovalPreview, attrApi, defaultTiers, errCode } from './attributes';

type Row = DimensionDraft & { key: string; custom: boolean };
type Impact = RemovalPreview['affected'][number];
/** What the user must confirm before saving: scored dimensions being removed, and scored dimensions whose wording changed. */
type Review = { removed: Impact[]; changed: Impact[]; choice: Record<string, 'text' | 'meaning'> };
const MIN = 3, MAX = 8;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const toRows = (c: AttrConfig): Row[] => c.dimensions.map(d => {
  const tiers = d.tier_labels?.length === 5 ? d.tier_labels : defaultTiers(d);
  return { key: d.id, id: d.id, name: d.name, negative_label: d.negative_label, positive_label: d.positive_label, neutral_label: d.neutral_label, criterion: d.criterion ?? '', tier_labels: tiers, custom: !same(tiers, defaultTiers(d)) };
});
const tiersOfRow = (r: Row) => r.custom && r.tier_labels?.length === 5 ? r.tier_labels : defaultTiers(r);
const outOf = (r: Row): DimensionDraft => ({ id: r.id, name: r.name.trim(), negative_label: r.negative_label.trim(), positive_label: r.positive_label.trim(), neutral_label: (r.custom ? tiersOfRow(r)[2] : r.neutral_label).trim() || '中立', tier_labels: tiersOfRow(r).map(t => t.trim()), criterion: r.criterion.trim() });
const wording = (d: DimensionDraft | AttrDimension) => JSON.stringify([d.name, d.negative_label, d.positive_label, d.neutral_label, d.tier_labels?.length === 5 ? d.tier_labels : defaultTiers(d), d.criterion ?? '']);

/**
 * 项目「人物属性维度」配置：改名、两端名、档名、顺序、增删。
 * - 删掉有分数的维度：先看影响再确认（removal-preview 凭证）。
 * - 改了有分数维度的文字：逐个确认「只改文字，含义和正负方向不变」（preserve_scored_axes），或当作新含义换新维度。
 * - 保存时配置已被别处改动：保留草稿，由用户选择用新配置，或在新版本上按维度编号核对后再保存。
 */
export function AttributeConfig({ projectId, projectName, request, onClose, onSaved }: { projectId: string; projectName: string; request: PromptRequest; onClose: () => void; onSaved: (c: AttrConfig) => void }) {
  const [config, setConfig] = useState<AttrConfig | null>(null), [rows, setRows] = useState<Row[]>([]), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [review, setReview] = useState<Review | null>(null), [openTiers, setOpenTiers] = useState(''), [stale, setStale] = useState<AttrConfig | null>(null), [note, setNote] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  async function load() {
    try { const c = await attrApi.config(request, projectId); if (c.project_id !== projectId) throw Error('维度配置不属于当前项目'); setConfig(c); setRows(toRows(c)); setReview(null); setStale(null); setError(''); }
    catch (e) { setError((e as Error).message || '维度配置读取失败'); }
  }
  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('input, button')?.focus(); }, [!!config]);

  // Any edit invalidates a pending confirmation: the user confirms what is on screen, nothing older.
  const touch = (fn: (rs: Row[]) => Row[]) => { setRows(fn); setReview(null); };
  const edit = (key: string, patch: Partial<Row>) => touch(rs => rs.map(r => r.key === key ? { ...r, ...patch } : r));
  const move = (i: number, d: -1 | 1) => touch(rs => { const next = [...rs]; [next[i], next[i + d]] = [next[i + d], next[i]]; return next; });
  const base = new Map((config?.dimensions ?? []).map(d => [d.id, d]));
  const swapped = rows.find(r => { const b = r.id && base.get(r.id); return b && r.negative_label.trim() === b.positive_label && r.positive_label.trim() === b.negative_label; });
  const problem = rows.length < MIN ? `至少 ${MIN} 个维度` : rows.length > MAX ? `最多 ${MAX} 个维度`
    : rows.some(r => !r.name.trim() || r.name.trim().length > 20) ? '维度名称要 1–20 个字'
    : new Set(rows.map(r => r.name.trim())).size !== rows.length ? '维度名称不能重复'
    : rows.some(r => !r.negative_label.trim() || !r.positive_label.trim()) ? '每个维度都要写两端名称'
    : rows.some(r => r.custom && tiersOfRow(r).some(t => !t.trim())) ? '自定义的五档名称不能留空'
    : swapped ? `「${swapped.name}」对调了两端，旧分数会被读反；请删掉它再新增一个维度` : '';
  const removedIds = () => (config?.dimensions ?? []).map(d => d.id).filter(id => !rows.some(r => r.id === id));
  const changedIds = () => rows.filter(r => r.id && base.has(r.id) && wording(outOf(r)) !== wording(base.get(r.id)!)).map(r => r.id!);
  const reviewReady = !review || review.changed.every(c => review.choice[c.dimension_id]);

  async function put(dimensions: DimensionDraft[], removed: string[], preserve: string[]) {
    if (!config) return;
    const token = removed.length ? (await attrApi.removalPreview(request, projectId, { expected_revision: config.revision, remove: removed })).token : undefined;
    const next = await attrApi.saveConfig(request, projectId, { expected_revision: config.revision, dimensions, ...(token ? { removal_confirmation: { token } } : {}), ...(preserve.length ? { preserve_scored_axes: preserve } : {}) });
    if (next.project_id !== projectId) throw Error('保存回执不属于当前项目');
    onSaved(next); onClose();
  }
  async function save() {
    if (!config || problem || saving || stale || !reviewReady) return;
    setSaving(true); setError('');
    try {
      const removed = removedIds(), changed = changedIds();
      if (!review && (removed.length || changed.length)) {
        // Read-only impact probe: which of these dimensions actually have scores.
        const probe = await attrApi.removalPreview(request, projectId, { expected_revision: config.revision, remove: [...removed, ...changed] });
        const scored = probe.affected.filter(a => a.scored_assets > 0);
        const next: Review = { removed: scored.filter(a => removed.includes(a.dimension_id)), changed: scored.filter(a => changed.includes(a.dimension_id)), choice: {} };
        if (next.removed.length || next.changed.length) { setReview(next); return; }
      }
      const meaning = review ? review.changed.filter(c => review.choice[c.dimension_id] === 'meaning').map(c => c.dimension_id) : [];
      const preserve = review ? review.changed.filter(c => review.choice[c.dimension_id] === 'text').map(c => c.dimension_id) : [];
      const dimensions = rows.map(r => ({ ...outOf(r), id: r.id && meaning.includes(r.id) ? null : r.id }));
      await put(dimensions, [...removed, ...meaning], preserve);
    } catch (e) {
      const code = errCode(e);
      if (code === 'CONFIG_STALE') { try { setStale(await attrApi.config(request, projectId)); } catch { /* keep the draft; the banner still explains */ } setReview(null); setError('维度配置刚在别处被修改，你的改动还在。请选择下面的处理方式后再保存。'); }
      else if (['REMOVAL_PREVIEW_STALE', 'DIMENSION_REMOVAL_CONFIRM', 'AXIS_MEANING_CONFIRM'].includes(code)) { setReview(null); setError('分数情况刚变了，需要重新确认；请再点一次「保存配置」'); }
      else setError((e as Error).message || '保存失败，改动仍保留');
    } finally { setSaving(false); }
  }
  /** Keep my edits on top of the newer config: same stable ids stay; ids that no longer exist become new dimensions. */
  function rebaseOnto(next: AttrConfig) {
    const live = new Set(next.dimensions.map(d => d.id)), gone = rows.filter(r => r.id && !live.has(r.id));
    setRows(rs => rs.map(r => r.id && !live.has(r.id) ? { ...r, id: null } : r)); setConfig(next); setStale(null); setReview(null); setError('');
    setNote(gone.length ? gone.map(r => '「' + r.name + '」').join('、') + '在新配置里已被删除，保存时会作为新维度加入（没有分数）' : '已基于最新配置保留你的改动；请核对后再保存');
  }

  const choose = (id: string, v: 'text' | 'meaning') => setReview(r => r && { ...r, choice: { ...r.choice, [id]: v } });
  return <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose(); }} onKeyDown={e => { if (e.key === 'Escape' && !saving) { e.stopPropagation(); onClose(); } }}>
    <div className="ca-modal ca-attr-config" ref={dialog} role="dialog" aria-modal="true" aria-label="人物属性维度">
      <header><div><h2>人物属性维度 · {projectName}</h2><p className="ca-muted">每个维度 -100 ~ +100，0 居中；五档：-100～-60、-59～-20、-19～19、20～59、60～100。这是本项目的配置，可按剧本修改。</p></div>
        <button type="button" className="ca-icon-button" aria-label="关闭维度设置" disabled={saving} onClick={onClose}><X size={17}/></button></header>
      <div className="ca-modal-content">
        {error && <div className="ca-alert" role="alert">{error}</div>}
        {stale && <div className="ca-attr-confirm" role="group" aria-label="配置已更新">
          <b>别处已把配置更新到第 {stale.revision} 版（你打开时是第 {config?.revision} 版）。</b>
          <div className="ca-attr-confirm-actions"><button type="button" onClick={() => { setConfig(stale); setRows(toRows(stale)); setStale(null); setReview(null); setError(''); setNote('已换成最新配置，你的改动已放弃'); }}>放弃我的改动，用新配置</button>
            <button type="button" className="ca-primary" onClick={() => rebaseOnto(stale)}>保留我的改动，基于新版本核对</button></div>
        </div>}
        {note && !stale && <p className="ca-attrs-notice" role="status">{note}</p>}
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
                <button type="button" className="ca-icon-button" aria-label={'删除' + (r.name || '维度')} disabled={rows.length <= MIN} onClick={() => touch(rs => rs.filter(x => x.key !== r.key))}><X size={14}/></button>
              </div>
              {openTiers === r.key && <div className="ca-attr-tier-edit">
                {tiersOfRow(r).map((t, j) => <input key={j} aria-label={`${r.name || '维度'}第 ${j + 1} 档名称`} maxLength={12} value={t} onChange={e => { const next = [...tiersOfRow(r)]; next[j] = e.target.value; edit(r.key, { custom: true, tier_labels: next }); }}/>)}
                <button type="button" className="ca-link-button" disabled={!r.custom} onClick={() => edit(r.key, { custom: false, tier_labels: undefined })}>按两端名自动生成</button>
                <input className="ca-attr-criterion" aria-label={(r.name || '维度') + '判断标准'} maxLength={120} placeholder="判断标准（可选，给 AI 打分参考）" value={r.criterion} onChange={e => edit(r.key, { criterion: e.target.value })}/>
              </div>}
            </div>)}
          </div>
          <div className="ca-attr-config-tools">
            <button type="button" disabled={rows.length >= MAX} onClick={() => touch(rs => [...rs, { key: crypto.randomUUID(), id: null, name: '', negative_label: '', positive_label: '', neutral_label: '中立', criterion: '', custom: false }])}><Plus size={14}/>新增维度</button>
            <small className="ca-muted">改顺序不影响分数；改了有分数维度的文字，保存时会请你确认含义是否变了。</small>
          </div>
          <div className="ca-attr-ai"><Sparkles size={16}/><div><b>让 AI 按剧本打分</b><p className="ca-muted">打开「分享给 Agent」，把说明交给你常用的 Agent：它会读剧本和这些维度并打分；你手动改过的分不会被覆盖。这里只准备说明，不会自动开始。</p></div><AgentShare projectId={projectId} projectName={projectName}/></div>
          {review && <div className="ca-attr-confirm" role="group" aria-label="保存前确认">
            {review.removed.length > 0 && <><b>删除这些维度会一并删掉已有分数，不能撤销：</b>
              <ul>{review.removed.map(a => <li key={a.dimension_id}>「{a.name}」：{a.scored_assets} 个人物有分数{a.archived_scored_assets ? `（其中 ${a.archived_scored_assets} 个已归档）` : ''}</li>)}</ul></>}
            {review.changed.length > 0 && <><b>这些维度已经有分数，你改了它们的文字。旧分数还按原来的意思理解吗？</b>
              {review.changed.map(c => { const now = rows.find(r => r.id === c.dimension_id); return <fieldset key={c.dimension_id} className="ca-attr-meaning"><legend>「{c.name}」→「{now?.name}」（{now?.negative_label} ↔ {now?.positive_label}）· {c.scored_assets} 个人物有分数</legend>
                <label><input type="radio" name={'m-' + c.dimension_id} checked={review.choice[c.dimension_id] === 'text'} onChange={() => choose(c.dimension_id, 'text')}/>只改了文字，评分含义和正负方向不变（保留分数）</label>
                <label><input type="radio" name={'m-' + c.dimension_id} checked={review.choice[c.dimension_id] === 'meaning'} onChange={() => choose(c.dimension_id, 'meaning')}/>含义变了：删掉旧分数，当作新维度</label>
              </fieldset>; })}</>}
          </div>}
        </>}
      </div>
      <footer>{problem && config && <small className="ca-attr-problem">{problem}</small>}
        <button type="button" disabled={saving} onClick={() => review ? setReview(null) : onClose()}>{review ? '返回修改' : '取消'}</button>
        <button type="button" className="ca-primary" disabled={!config || !!problem || saving || !!stale || !reviewReady} onClick={() => void save()}>{saving ? '保存中…' : review ? '确认并保存' : '保存配置'}</button></footer>
    </div>
  </div>;
}
