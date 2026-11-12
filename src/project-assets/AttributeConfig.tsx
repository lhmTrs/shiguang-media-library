import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Sparkles, X } from 'lucide-react';
import type { PromptRequest } from '../PromptTemplateWorkspace';
import { AgentShare } from '../AgentShare';
import { type AttrConfig, type AttrDimension, type DimensionDraft, type RemovalPreview, attrApi, defaultTiers, errCode } from './attributes';

type Row = DimensionDraft & { key: string; custom: boolean };
type Impact = RemovalPreview['affected'][number];
/** Step 1: scored dimensions whose wording changed — text only, or a new meaning? */
type Choose = { stage: 'choose'; changed: Impact[]; choice: Record<string, 'text' | 'meaning'> };
/** Step 2: the exact removal the user confirms; the token shown here is the token sent. */
type Final = { stage: 'final'; token: string; affected: Impact[]; set: string[]; preserve: string[]; meaning: string[] };
type Field = 'name' | 'negative_label' | 'positive_label' | 'neutral_label' | 'tier_labels' | 'criterion';
type Conflict = { key: string; id: string; name: string } & ({ kind: 'field'; field: Field; mine: Row; theirs: string; ours: string } | { kind: 'deleted'; mine: Row });
type Merge = { rows: Row[]; conflicts: Conflict[]; choice: Record<string, 'mine' | 'theirs'>; notes: string[]; next: AttrConfig };

const MIN = 3, MAX = 8;
const FIELDS: Field[] = ['name', 'negative_label', 'positive_label', 'neutral_label', 'tier_labels', 'criterion'];
const FIELD_LABEL: Record<Field, string> = { name: '名称', negative_label: '左端', positive_label: '右端', neutral_label: '中间名', tier_labels: '五档名称', criterion: '判断标准' };
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const toRow = (d: AttrDimension): Row => {
  const tiers = d.tier_labels?.length === 5 ? d.tier_labels : defaultTiers(d);
  return { key: d.id, id: d.id, name: d.name, negative_label: d.negative_label, positive_label: d.positive_label, neutral_label: d.neutral_label, criterion: d.criterion ?? '', tier_labels: tiers, custom: !same(tiers, defaultTiers(d)) };
};
const tiersOfRow = (r: Row) => r.custom && r.tier_labels?.length === 5 ? r.tier_labels : defaultTiers(r);
const outOf = (r: Row): DimensionDraft => ({ id: r.id, name: r.name.trim(), negative_label: r.negative_label.trim(), positive_label: r.positive_label.trim(), neutral_label: (r.custom ? tiersOfRow(r)[2] : r.neutral_label).trim() || '中立', tier_labels: tiersOfRow(r).map(t => t.trim()), criterion: r.criterion.trim() });
const fieldOf = (d: DimensionDraft | AttrDimension, f: Field) => f === 'tier_labels' ? (d.tier_labels?.length === 5 ? d.tier_labels : defaultTiers(d)).join(' / ') : String(d[f] ?? '');
const wording = (d: DimensionDraft | AttrDimension) => JSON.stringify(FIELDS.map(f => fieldOf(d, f)));
const setField = (row: Row, from: Row, f: Field): Row => f === 'tier_labels' ? { ...row, custom: from.custom, tier_labels: tiersOfRow(from) } : { ...row, [f]: from[f] };

/**
 * Three-way merge of my edits (relative to `base`) onto a newer config (`theirs`), field by field:
 * my untouched fields follow theirs; fields only I changed keep mine; fields both changed differently are conflicts.
 * Dimensions added elsewhere are kept; dimensions I removed stay removed; dimensions removed elsewhere are dropped
 * unless I edited them (then the user chooses to add them back as new, unscored dimensions).
 */
function mergeConfigs(base: AttrConfig, mine: Row[], theirs: AttrConfig): Omit<Merge, 'choice' | 'next'> {
  const b = new Map(base.dimensions.map(d => [d.id, d])), t = new Map(theirs.dimensions.map(d => [d.id, d]));
  const mineById = new Map(mine.filter(r => r.id && b.has(r.id)).map(r => [r.id!, r]));
  const conflicts: Conflict[] = [], notes: string[] = [], rows = new Map<string, Row>();
  for (const [id, mr] of mineById) {
    const bd = b.get(id)!, td = t.get(id), md = outOf(mr), changed = FIELDS.filter(f => fieldOf(md, f) !== fieldOf(bd, f));
    if (!td) { if (changed.length) conflicts.push({ key: 'del-' + id, id, name: mr.name, kind: 'deleted', mine: mr }); else notes.push('「' + bd.name + '」已在别处删除'); continue; }
    let row = toRow(td);
    for (const f of changed) {
      if (fieldOf(td, f) !== fieldOf(bd, f) && fieldOf(td, f) !== fieldOf(md, f)) conflicts.push({ key: id + '-' + f, id, name: td.name, kind: 'field', field: f, mine: mr, ours: fieldOf(md, f), theirs: fieldOf(td, f) });
      else row = setField(row, mr, f);
    }
    rows.set(id, row);
  }
  const added = theirs.dimensions.filter(d => !b.has(d.id));
  for (const d of added) { rows.set(d.id, toRow(d)); notes.push('别处新增了「' + d.name + '」'); }
  const removedByMe = new Set(base.dimensions.filter(d => !mineById.has(d.id)).map(d => d.id));
  const baseOrder = base.dimensions.map(d => d.id).filter(id => !removedByMe.has(id)), myOrder = mine.filter(r => r.id && b.has(r.id)).map(r => r.id!);
  const order = same(baseOrder, myOrder) ? theirs.dimensions.map(d => d.id) : [...myOrder, ...added.map(d => d.id)];
  const out = order.filter(id => rows.has(id) && !removedByMe.has(id)).map(id => rows.get(id)!);
  return { rows: [...out, ...mine.filter(r => !r.id)], conflicts, notes };
}
function applyMerge(m: Merge): Row[] {
  let rows = m.rows;
  for (const c of m.conflicts) {
    if (c.kind === 'field' && m.choice[c.key] === 'mine') rows = rows.map(r => r.id === c.id ? setField(r, c.mine, c.field) : r);
    if (c.kind === 'deleted' && m.choice[c.key] === 'mine') rows = [...rows, { ...c.mine, id: null, key: crypto.randomUUID() }];
  }
  return rows;
}

/**
 * 项目「人物属性维度」配置。保存分步：
 * 1) 改了有分数维度的文字 → 逐个选「只改文字」（preserve_scored_axes）或「含义变了」（旧维度删掉、换新维度）；
 * 2) 用最终删除集合取一次影响并展示，用户确认的就是提交的那个凭证；影响变了重新展示、重新确认。
 * 配置被别处改过 → 保留草稿，按字段三方合并；同一字段两边都改、或我改过的维度被别处删了 → 逐项选择。
 */
export function AttributeConfig({ projectId, projectName, request, onClose, onSaved }: { projectId: string; projectName: string; request: PromptRequest; onClose: () => void; onSaved: (c: AttrConfig) => void }) {
  const [config, setConfig] = useState<AttrConfig | null>(null), [rows, setRows] = useState<Row[]>([]), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [review, setReview] = useState<Choose | Final | null>(null), [openTiers, setOpenTiers] = useState(''), [stale, setStale] = useState<AttrConfig | null>(null), [merge, setMerge] = useState<Merge | null>(null), [note, setNote] = useState('');
  const dialog = useRef<HTMLDivElement>(null);
  // Every draft edit bumps the generation; any response that started on an older generation is dropped.
  const generation = useRef(0);
  async function load() {
    try { const c = await attrApi.config(request, projectId); if (c.project_id !== projectId) throw Error('维度配置不属于当前项目'); setConfig(c); setRows(c.dimensions.map(toRow)); setReview(null); setStale(null); setMerge(null); setError(''); }
    catch (e) { setError((e as Error).message || '维度配置读取失败'); }
  }
  useEffect(() => { void load(); }, [projectId]);
  useEffect(() => { dialog.current?.querySelector<HTMLElement>('input, button')?.focus(); }, [!!config]);

  // Any edit invalidates a pending confirmation: the user confirms what is on screen, nothing older.
  const touch = (fn: (rs: Row[]) => Row[]) => { generation.current++; setRows(fn); setReview(null); };
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
  // Editing, confirming, choosing a merge and waiting for the server are separate states: the draft is read-only
  // while any of the others is on screen; 「返回修改」 leaves a confirmation and unlocks it.
  const locked = saving || !!stale || !!merge || !!review;
  const blocked = !config || config.project_id !== projectId || !!problem || saving || !!stale || !!merge || (review?.stage === 'choose' && review.changed.some(c => !review.choice[c.dimension_id]));

  async function put(meaning: string[], preserve: string[], token?: string) {
    if (!config || config.project_id !== projectId) throw Error('维度配置与当前项目不一致，没有保存');
    const dimensions = rows.map(r => ({ ...outOf(r), id: r.id && meaning.includes(r.id) ? null : r.id }));
    const next = await attrApi.saveConfig(request, projectId, { expected_revision: config.revision, dimensions, ...(token ? { removal_confirmation: { token } } : {}), ...(preserve.length ? { preserve_scored_axes: preserve } : {}) });
    if (next.project_id !== projectId) throw Error('保存回执不属于当前项目');
    onSaved(next); onClose();
  }
  /** Preview exactly the removal that will be sent; with scores at stake, show it and wait for the user's confirmation. */
  async function toFinal(set: string[], preserve: string[], meaning: string[], message = '', gen = generation.current) {
    if (!config || config.project_id !== projectId) throw Error('维度配置与当前项目不一致，没有保存');
    if (!set.length) { await put(meaning, preserve); return; }
    const pv = await attrApi.removalPreview(request, projectId, { expected_revision: config.revision, remove: set });
    if (gen !== generation.current) throw Object.assign(Error('草稿在等待期间改动了，请重新保存'), { code: 'DRAFT_CHANGED' });
    const affected = pv.affected.filter(a => a.scored_assets > 0);
    if (!affected.length) { await put(meaning, preserve); return; } // nothing scored: no token; the server refuses if scores appear meanwhile
    setReview({ stage: 'final', token: pv.token, affected, set, preserve, meaning }); setError(message);
  }
  async function save() {
    if (blocked || !config) return;
    setSaving(true); setError(''); const gen = generation.current;
    const removed = config.dimensions.map(d => d.id).filter(id => !rows.some(r => r.id === id));
    try {
      if (review?.stage === 'final') { await put(review.meaning, review.preserve, review.token); return; }
      if (review?.stage === 'choose') {
        const meaning = review.changed.filter(c => review.choice[c.dimension_id] === 'meaning').map(c => c.dimension_id);
        await toFinal([...removed, ...meaning], review.changed.filter(c => review.choice[c.dimension_id] === 'text').map(c => c.dimension_id), meaning, '', gen); return;
      }
      const changed = rows.filter(r => r.id && base.has(r.id) && wording(outOf(r)) !== wording(base.get(r.id)!)).map(r => r.id!);
      if (changed.length) {
        // Read-only probe: which of the reworded dimensions actually have scores.
        const probe = await attrApi.removalPreview(request, projectId, { expected_revision: config.revision, remove: changed });
        if (gen !== generation.current) throw Object.assign(Error('草稿在等待期间改动了，请重新保存'), { code: 'DRAFT_CHANGED' });
        const scored = probe.affected.filter(a => a.scored_assets > 0);
        if (scored.length) { setReview({ stage: 'choose', changed: scored, choice: {} }); return; }
      }
      await toFinal(removed, [], [], '', gen);
    } catch (e) {
      const code = errCode(e);
      if (code === 'CONFIG_STALE') { try { setStale(await attrApi.config(request, projectId)); } catch { /* keep the draft */ } setReview(null); setError('维度配置刚在别处被修改，你的改动还在。请选择下面的处理方式。'); }
      else if ((code === 'REMOVAL_PREVIEW_STALE' || code === 'DIMENSION_REMOVAL_CONFIRM') && review?.stage === 'final') {
        try { await toFinal(review.set, review.preserve, review.meaning, '删除影响刚变了（下面是最新人数），请重新确认'); } catch (e2) { setReview(null); setError((e2 as Error).message || '请再点一次保存'); }
      }
      else if (code === 'DRAFT_CHANGED') { setReview(null); setError((e as Error).message); }
      else if (['REMOVAL_PREVIEW_STALE', 'DIMENSION_REMOVAL_CONFIRM', 'AXIS_MEANING_CONFIRM'].includes(code)) { setReview(null); setError('分数情况刚变了，需要重新确认；请再点一次「保存配置」'); }
      else setError((e as Error).message || '保存失败，改动仍保留');
    } finally { setSaving(false); }
  }
  function startMerge(next: AttrConfig) {
    if (!config) return;
    const m = mergeConfigs(config, rows, next);
    if (!m.conflicts.length) { finishMerge({ ...m, choice: {}, next }); return; }
    setMerge({ ...m, choice: {}, next }); setStale(null);
  }
  function finishMerge(m: Merge) {
    generation.current++; setRows(applyMerge(m)); setConfig(m.next); setMerge(null); setStale(null); setReview(null); setError('');
    setNote(['已和最新配置合并：保留了你的改动和别处的修改', ...m.notes].join('；') + '。请核对后再保存');
  }

  const choose = (id: string, v: 'text' | 'meaning') => setReview(r => r && r.stage === 'choose' ? { ...r, choice: { ...r.choice, [id]: v } } : r);
  return <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose(); }} onKeyDown={e => { if (e.key === 'Escape' && !saving) { e.stopPropagation(); onClose(); } }}>
    <div className="ca-modal ca-attr-config" ref={dialog} role="dialog" aria-modal="true" aria-label="人物属性维度">
      <header><div><h2>人物属性维度 · {projectName}</h2><p className="ca-muted">每个维度 -100 ~ +100，0 居中；五档：-100～-60、-59～-20、-19～19、20～59、60～100。这是本项目的配置，可按剧本修改。</p></div>
        <button type="button" className="ca-icon-button" aria-label="关闭维度设置" disabled={saving} onClick={onClose}><X size={17}/></button></header>
      <div className="ca-modal-content">
        {error && <div className="ca-alert" role="alert">{error}</div>}
        {stale && <div className="ca-attr-confirm" role="group" aria-label="配置已更新">
          <b>别处已把配置更新到第 {stale.revision} 版（你打开时是第 {config?.revision} 版）。</b>
          <div className="ca-attr-confirm-actions"><button type="button" onClick={() => { setConfig(stale); setRows(stale.dimensions.map(toRow)); setStale(null); setReview(null); setError(''); setNote('已换成最新配置，你的改动已放弃'); }}>放弃我的改动，用新配置</button>
            <button type="button" className="ca-primary" onClick={() => startMerge(stale)}>保留我的改动，与新版本合并</button></div>
        </div>}
        {merge && <div className="ca-attr-confirm" role="group" aria-label="合并冲突">
          <b>这些地方你和别处都改了，选一个保留：</b>
          {merge.conflicts.map(c => <fieldset key={c.key} className="ca-attr-meaning"><legend>「{c.name}」{c.kind === 'field' ? '的' + FIELD_LABEL[c.field] : '已在别处删除，但你改过它'}</legend>
            {c.kind === 'field' ? <>
              <label><input type="radio" name={'c-' + c.key} checked={merge.choice[c.key] === 'mine'} onChange={() => setMerge({ ...merge, choice: { ...merge.choice, [c.key]: 'mine' } })}/>用我的：{c.ours || '（空）'}</label>
              <label><input type="radio" name={'c-' + c.key} checked={merge.choice[c.key] === 'theirs'} onChange={() => setMerge({ ...merge, choice: { ...merge.choice, [c.key]: 'theirs' } })}/>用别处的：{c.theirs || '（空）'}</label>
            </> : <>
              <label><input type="radio" name={'c-' + c.key} checked={merge.choice[c.key] === 'mine'} onChange={() => setMerge({ ...merge, choice: { ...merge.choice, [c.key]: 'mine' } })}/>加回来，作为新维度（没有分数）</label>
              <label><input type="radio" name={'c-' + c.key} checked={merge.choice[c.key] === 'theirs'} onChange={() => setMerge({ ...merge, choice: { ...merge.choice, [c.key]: 'theirs' } })}/>不要了</label>
            </>}
          </fieldset>)}
          <div className="ca-attr-confirm-actions"><button type="button" className="ca-primary" disabled={merge.conflicts.some(c => !merge.choice[c.key])} onClick={() => finishMerge(merge)}>按以上选择合并</button></div>
        </div>}
        {note && !stale && !merge && <p className="ca-attrs-notice" role="status">{note}</p>}
        {!config ? <p className="ca-muted">正在读取维度配置…</p> : <>
          <fieldset className="ca-attr-fieldset" disabled={locked} aria-describedby={locked ? 'ca-attr-locked' : undefined}>
          {locked && <p id="ca-attr-locked" className="ca-muted ca-attr-locked">{saving ? '正在保存，暂时不能修改' : review ? '确认中，暂时不能修改；要改请点下方「返回修改」' : '请先处理上面的配置冲突'}</p>}
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
          </fieldset>
          <div className="ca-attr-ai"><Sparkles size={16}/><div><b>让 AI 按剧本打分</b><p className="ca-muted">打开「分享给 Agent」，把说明交给你常用的 Agent：它会读剧本和这些维度并打分；你手动改过的分不会被覆盖。这里只准备说明，不会自动开始。</p></div><AgentShare projectId={projectId} projectName={projectName}/></div>
          {review?.stage === 'choose' && <div className="ca-attr-confirm" role="group" aria-label="保存前确认">
            <b>这些维度已经有分数，你改了它们的文字。旧分数还按原来的意思理解吗？</b>
            {review.changed.map(c => { const now = rows.find(r => r.id === c.dimension_id); return <fieldset key={c.dimension_id} className="ca-attr-meaning"><legend>「{c.name}」→「{now?.name}」（{now?.negative_label} ↔ {now?.positive_label}）· {c.scored_assets} 个人物有分数</legend>
              <label><input type="radio" name={'m-' + c.dimension_id} checked={review.choice[c.dimension_id] === 'text'} onChange={() => choose(c.dimension_id, 'text')}/>只改了文字，评分含义和正负方向不变（保留分数）</label>
              <label><input type="radio" name={'m-' + c.dimension_id} checked={review.choice[c.dimension_id] === 'meaning'} onChange={() => choose(c.dimension_id, 'meaning')}/>含义变了：删掉旧分数，当作新维度</label>
            </fieldset>; })}
          </div>}
          {review?.stage === 'final' && <div className="ca-attr-confirm" role="group" aria-label="保存前确认">
            <b>保存会删掉这些维度的分数，不能撤销：</b>
            <ul>{review.affected.map(a => <li key={a.dimension_id}>「{a.name}」：{a.scored_assets} 个人物有分数{a.archived_scored_assets ? `（其中 ${a.archived_scored_assets} 个已归档）` : ''}</li>)}</ul>
            {review.preserve.length > 0 && <small className="ca-muted">只改文字、保留分数：{review.preserve.map(id => '「' + (rows.find(r => r.id === id)?.name ?? '') + '」').join('、')}</small>}
          </div>}
        </>}
      </div>
      <footer>{problem && config && <small className="ca-attr-problem">{problem}</small>}
        <button type="button" disabled={saving} onClick={() => { if (review) { generation.current++; setReview(null); } else onClose(); }}>{review ? '返回修改' : '取消'}</button>
        <button type="button" className="ca-primary" disabled={blocked} onClick={() => void save()}>{saving ? '保存中…' : review?.stage === 'final' ? '确认删除并保存' : review?.stage === 'choose' ? '下一步' : '保存配置'}</button></footer>
    </div>
  </div>;
}
