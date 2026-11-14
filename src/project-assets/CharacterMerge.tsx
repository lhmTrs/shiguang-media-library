// 合并同名人物（合同 v1 · B；设计稿 B0–B4）：全剧提示条、三步合并浮窗、完成提示、撤销浮窗。
// 规则：每次改选项都重新预览，以服务端回显和新凭证为准；屏幕上的选择没被核对成功就不能确认；
// 确认 / 撤销结果不明时保留原请求并锁定，只能按原请求号核对或原样重发（A 的 R2 教训）。
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Users, X } from 'lucide-react';
import { contextUnavailable, outcomeUnknown } from './scoped';
import {
  isRejected, lookupOnly, memberLabel, memberPlace, mergeApi, mergeErr, mergeErrorText, NOT_FOUND_NOTE, pendingStore, refShots, settledRejection, spansSeasons, subscribePending,
  type RejectedReceipt,
  type PendingMerge, type PendingUndo,
  type LookChoice, type MergeConfirmBody, type MergeGroup, type MergeGroups, type MergeMember, type MergePreview, type MergeReceipt,
  type UndoBody, type UndoPreview, type UndoReceipt,
} from './merge';
import './merge.css';

type Api = <T>(url: string, body?: unknown, method?: string) => Promise<T>;
const newId = () => crypto.randomUUID();

/** 一部剧的同名人物候选组（读全部页）。后端还没有这个接口时安静地当作没有，不报错。 */
export function useMergeGroups(api: Api, seriesId: string | null, enabled: boolean, version: string | number) {
  const [data, setData] = useState<MergeGroups | null>(null);
  const seq = useRef(0);
  async function load(): Promise<MergeGroups | null> {
    const s = ++seq.current;
    if (!seriesId || !enabled) { setData(null); return null; }
    try {
      const m = mergeApi(api, seriesId);
      let page = await m.groups(); const first = page, items = [...page.items];
      for (let i = 0; page.next_cursor && i < 20; i++) { page = await m.groups(page.next_cursor); items.push(...page.items); }
      const all = { ...first, items, next_cursor: null };
      if (s === seq.current) setData(all);
      return all;
    } catch (e) {
      if (s === seq.current) setData(null);
      if (!contextUnavailable(e)) throw e;
      return null;
    }
  }
  useEffect(() => { void load().catch(() => {}); return () => { seq.current++; }; }, [seriesId, enabled, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const byAsset = useMemo(() => { const map = new Map<string, MergeGroup>(); for (const g of data?.items ?? []) for (const m of g.members) map.set(m.asset_id, g); return map; }, [data]);
  return { data, byAsset, reload: load };
}

/** 当前剧结果不明的合并 / 撤销（组合验收 R1 复验）：不依赖候选组或「能否撤销」，只看待核对记录本身。 */
export function usePendingMerge(libraryId: string, seriesId: string | null): { merge: PendingMerge | null; undo: PendingUndo | null } {
  const [, bump] = useState(0);
  useEffect(() => subscribePending(() => bump(n => n + 1)), []);
  return libraryId && seriesId ? { merge: pendingStore.merge(libraryId, seriesId), undo: pendingStore.undosOf(libraryId, seriesId)[0] ?? null } : { merge: null, undo: null };
}
/** 人物页独立提示：上次合并 / 撤销的结果还没核对到。合并已经让候选组变成 0、或撤销后不再「可撤销」时，入口都还在。 */
export function MergePendingBar({ merge, undo, onCheck }: { merge: PendingMerge | null; undo: PendingUndo | null; onCheck: () => void }) {
  if (!merge && !undo) return null;
  const what = merge ? '合并「' + merge.group.name + '」' : '撤销合并「' + undo!.name + '」';
  return <div className="cm-pending" role="alert"><span>上次{what}的结果还没核对到。核对前不能发起新的合并或撤销；核对会按原请求号查询，不会重复执行。</span>
    <button type="button" className="ca-primary" onClick={onCheck}>核对上次结果</button></div>;
}

/** ① 全剧视图顶部提示（有同名才出现）。 */
export function MergeBanner({ groups, seriesName, onStart }: { groups: MergeGroups | null; seriesName: string; onStart: (g: MergeGroup) => void }) {
  const [hidden, setHidden] = useState(false);
  if (!groups || hidden || !groups.summary.group_count || !groups.items.length) return null;
  const pending = groups.alignment_status === 'pending';
  return <div className="cm-banner" role="note"><Users size={16} aria-hidden="true"/>
    <span>「{seriesName}」里有 <b>{groups.summary.group_count} 个人物</b>在不同集各建了一份，共被 {groups.summary.referenced_shot_count} 个镜头引用。合并后各集共用一个，分镜不用改。{pending && <small>先统一人物属性维度，才能合并。</small>}</span>
    <button type="button" className="ca-primary" disabled={pending} onClick={() => onStart(groups.items[0])}>逐个合并</button>
    <button type="button" onClick={() => setHidden(true)}>暂不</button>
  </div>;
}

/** 合并完成：页面顶部提示，带撤销和下一个。 */
/** lookCount：合并后的造型数，取自最后一次核对（回执的 merged_look_count 是被合成掉的造型数，不是总数）。 */
export function MergeDoneBar({ receipt, name, lookCount, onUndo, onNext, onClose }: { receipt: MergeReceipt; name: string; lookCount?: number; onUndo: () => void; onNext: () => void; onClose: () => void }) {
  const shots = refShots(receipt.references);
  return <div className="cm-done" role="status"><Check size={16} aria-hidden="true"/>
    <span>已合并「{name}」：现在是全剧共享人物{lookCount != null ? `，${lookCount} 个造型` : ''}{shots ? `，${shots} 个镜头都指向它` : ''}。</span>
    {receipt.can_undo && <button type="button" onClick={onUndo}>撤销</button>}
    {receipt.remaining_group_count > 0 && <button type="button" className="ca-primary" onClick={onNext}>下一个（还剩 {receipt.remaining_group_count} 个）</button>}
    <button type="button" className="ca-icon-button" aria-label="关闭合并提示" onClick={onClose}><X size={14}/></button>
  </div>;
}

type Step = 'pick' | 'impact' | 'issues';
/** 合并浮窗：选主体 → 合并后的样子 → 同名造型（有冲突才出现）→ 确认。 */
export function MergeDialog({ api, libraryId, seriesId, group: initialGroup, contextToken: initialToken, initialPrimary, reloadGroups, guard, onClose, onMerged }: {
  api: Api; libraryId: string; seriesId: string; group: MergeGroup; contextToken?: string; initialPrimary?: string;
  /** 重新提交前的草稿保护：返回非空文字就不提交，并显示它。 */
  guard?: () => string;
  /** 依赖变了：重新读组（拿到新的成员和凭证）。 */
  reloadGroups: () => Promise<MergeGroups | null>;
  onClose: () => void; onMerged: (r: MergeReceipt, group: MergeGroup, lookCount?: number) => void;
}) {
  const m = useMemo(() => mergeApi(api, seriesId), [api, seriesId]);
  // 组合验收 R1：上次结果不明的原请求存在浮窗之外，再打开同组时恢复并锁定，继续按原编号核对
  const stored = useMemo(() => { const p = pendingStore.merge(libraryId, seriesId); return p && p.group.group_id === initialGroup.group_id ? p : null; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [group, setGroup] = useState(stored?.group ?? initialGroup), [token, setToken] = useState(initialToken);
  const locked = group.members.find(x => x.primary_locked);
  const [primary, setPrimary] = useState(locked?.asset_id ?? (group.members.some(x => x.asset_id === initialPrimary) ? initialPrimary! : group.members[0]?.asset_id));
  const [step, setStep] = useState<Step>(stored ? 'impact' : 'pick'), [preview, setPreview] = useState<MergePreview | null>(null);
  /** 还没被服务端核对的造型改选：屏幕上显示它，但不能拿去确认。 */
  const [edits, setEdits] = useState<Record<string, LookChoice>>({});
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [note, setNote] = useState('');
  const pendingRef = useRef<MergeConfirmBody | null>(stored?.body ?? null), [pending, setPendingState] = useState<MergeConfirmBody | null>(stored?.body ?? null);
  const setPending = (p: MergeConfirmBody | null) => { pendingRef.current = p; setPendingState(p); pendingStore.setMerge(libraryId, seriesId, p ? { libraryId, seriesId, group, body: p } : null); };
  const alive = useRef(true); useEffect(() => () => { alive.current = false; }, []);
  const seasons = spansSeasons(group.members);
  const member = (id: string) => group.members.find(x => x.asset_id === id);
  const label = (id: string) => { const x = member(id); return x ? memberLabel(x, group.name, seasons) : '另一份「' + group.name + '」'; };
  const placeOf = (projectId: string | null | undefined) => { const x = group.members.find(y => y.episode?.project_id === projectId); return x ? memberPlace(x, seasons) : '某一集'; };
  const unchecked = !pending && Object.keys(edits).length > 0;
  const shown = pending ? pending.choices.look_choices : preview ? preview.choices.look_choices.map(c => edits[c.conflict_id] ?? c) : [];
  const choiceOf = (id: string) => shown.find(c => c.conflict_id === id);
  const lookName = (lookId: string | null) => { const it = preview?.look_plan.items.find(i => i.result_look_id === lookId || i.source_look_id === lookId); return it?.result_name ?? '（已删除的造型）'; };

  async function loadPreview(choices?: LookChoice[], message = '', checkingChange = false, primaryId = primary, tok = token, g = group): Promise<boolean> {
    setBusy('正在核对合并后的样子…'); setError('');
    try {
      const p = await m.preview({ group_id: g.group_id, primary_asset_id: primaryId, context_token: tok, ...(choices ? { choices: { look_choices: choices } } : {}) });
      if (!alive.current) return false;
      setPreview(p); setEdits({}); setNote(message); return true;
    } catch (e: any) {
      if (!alive.current) return false;
      if (e?.code === 'CHARACTER_MERGE_PRIMARY_REQUIRED') { const want = e.details?.primary_asset_id; if (want) setPrimary(want); setStep('pick'); setPreview(null); setError(mergeErrorText.CHARACTER_MERGE_PRIMARY_REQUIRED); return false; }
      if (e?.code === 'CHARACTER_MERGE_CHOICE_INVALID' && choices) return loadPreview(undefined, mergeErrorText.CHARACTER_MERGE_CHOICE_INVALID, false, primaryId, tok, g);
      setError(mergeErr(e, '核对失败') + (checkingChange ? '。你的改动还没核对成功，不能确认；请点「重新核对」' : '，请稍后再试'));
      return false;
    } finally { if (alive.current) setBusy(''); }
  }
  async function toImpact() { if (await loadPreview()) setStep('impact'); }
  /** 依赖变了：重新读组和凭证，按屏幕上的选择重新预览；组已不存在就说明并停下。 */
  async function refresh(message: string) {
    const fresh = await reloadGroups().catch(() => null);
    const g = fresh?.items.find(x => x.group_id === group.group_id);
    if (!g) { setPreview(null); setError('这一组同名人物已经变了（可能已合并、改名或归档），没有执行。请关掉窗口重新打开。'); return; }
    setGroup(g); setToken(fresh?.context_token ?? token);
    const p = g.members.find(x => x.primary_locked)?.asset_id ?? (g.members.some(x => x.asset_id === primary) ? primary : g.members[0].asset_id);
    setPrimary(p);
    await loadPreview(preview?.choices.look_choices, message, false, p, fresh?.context_token ?? token, g);
  }
  function edit(c: LookChoice, check: boolean) {
    if (pendingRef.current || !preview) return;
    const next = { ...edits, [c.conflict_id]: c }; setEdits(next);
    if (check) void loadPreview(preview.choices.look_choices.map(x => next[x.conflict_id] ?? x), '', true);
  }
  const recheck = () => preview && void loadPreview(preview.choices.look_choices.map(x => edits[x.conflict_id] ?? x), '', true);

  /** 待核对的原请求暂未查到回执（收口标准）：原请求仍可能完成。只给「稍后再核对」和「按原内容重新提交」。 */
  const [notFound, setNotFound] = useState(false);
  const lookCount = () => preview ? new Set(preview.look_plan.items.map(i => i.result_look_id)).size : undefined;
  /** 服务端确认的拒绝（首次发出的直接业务响应、或已落定的拒绝回执）：解除待核对，按原因处理；要改选择就重新预览，下次用新编号。 */
  async function onRejected(e: { code?: string; message?: string }) {
    setPending(null); setNotFound(false);
    if (e?.code === 'CHARACTER_MERGE_STALE' || e?.code === 'ASSET_SCOPE_CHANGED') { await refresh(mergeErrorText.CHARACTER_MERGE_STALE); return; }
    if (e?.code === 'CHARACTER_MERGE_CHOICE_INVALID') { await loadPreview(undefined, mergeErrorText.CHARACTER_MERGE_CHOICE_INVALID); return; }
    setError(mergeErr(e, '合并没有执行'));
  }
  /** 只按原编号查一次，不重发：成功 → 完成；已落定的拒绝 → 解除；暂未查到 → 保留待核对。查询本身失败由调用方显示「结果不明」。 */
  async function checkOnce(body: MergeConfirmBody) {
    const r = await lookupOnly<MergeReceipt | RejectedReceipt>(() => m.request(body.request_id));
    if (!r) { setNotFound(true); setNote(NOT_FOUND_NOTE('合并')); return; }
    if (isRejected(r, body.request_id)) { await onRejected(r); return; }
    setPending(null); setNotFound(false); onMerged(r as MergeReceipt, group, lookCount());
  }
  async function confirm() {
    const held = pendingRef.current;
    if (busy || (!held && (!preview?.ready || !preview.preview_token || unchecked || preview.blockers.length))) return;
    // 核对：只读，只查原编号
    if (held && !notFound) {
      setBusy('正在核对上次结果…'); setError(''); setNote('');
      try { await checkOnce(held); } catch (e: any) { setError(e?.code === 'OUTCOME_UNKNOWN' ? e.message : mergeErr(e, '核对失败，请稍后再试')); }
      finally { if (alive.current) setBusy(''); }
      return;
    }
    // 按原内容重新提交：用户明确发起，先过草稿和在途写入保护
    if (held && notFound) { const why = guard?.(); if (why) { setError(why); return; } }
    const resend = !!held;
    const body = held ?? { request_id: newId(), preview_token: preview!.preview_token!, context_token: token, choices: preview!.choices };
    setPending(body); setBusy('正在合并…'); setError(''); setNote('');
    try { const r = await m.confirm(body); setPending(null); setNotFound(false); onMerged(r, group, lookCount()); }
    catch (e: any) {
      if (outcomeUnknown(e)) { // 回应丢了：只查一次，不自动再发
        try { await checkOnce(body); } catch (e2: any) { setError(e2?.code === 'OUTCOME_UNKNOWN' ? e2.message : mergeErr(e2, '核对失败，请稍后再试')); }
        return;
      }
      // 重新提交时可能还有在途的原请求：只有服务端已落定的拒绝才解除待核对
      if (resend && !settledRejection(e)) { setNotFound(true); setError(mergeErr(e, '这次没有执行') + '。原请求仍可能完成，待核对记录保留：可以稍后再核对，或稍后再按原内容提交'); return; }
      await onRejected(e);
    } finally { if (alive.current) setBusy(''); }
  }

  const close = () => { if (busy) return; onClose(); };
  const conflicts = preview?.look_plan.conflicts ?? [];
  const canConfirm = !busy && (!!pending || (!!preview?.ready && !!preview.preview_token && !unchecked && !preview.blockers.length));
  const primaryMember = member(primary);
  const sub = step === 'pick' ? '第 1 步 · 选一份作为主体' : step === 'impact' ? '第 2 步 · 主体：' + label(primary) : '第 3 步 · 同名造型（有冲突才出现这一步）';
  const title = step === 'issues' ? `合并「${group.name}」· 需要处理 ${conflicts.length} 项` : step === 'impact' ? `合并「${group.name}」· 合并后的样子` : `合并「${group.name}」`;

  return <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
    <div className="ca-modal cm-dialog" role="dialog" aria-modal="true" aria-label={'合并「' + group.name + '」'}>
      <header><div><h2>{title}</h2><p className="ca-muted">{sub}</p></div><button type="button" className="ca-icon-button" aria-label="关闭" disabled={!!busy} onClick={close}><X size={17}/></button></header>
      <div className="ca-modal-content cm-body">
        {error && <div className="ca-alert" role="alert">{error}</div>}
        {note && !error && <p className="cm-note" role="status">{note}</p>}
        {pending && !busy && !notFound && <p className="cm-note" role="status">上次「确认合并」的结果还没核对到。下面是那次提交的选择，已锁定；点「核对上次结果」只按原请求号查询，不会自己重新提交。</p>}
        {busy && !preview && <p className="ca-muted" role="status">{busy}</p>}

        {step === 'pick' && <>
          <p className="cm-lead">主体的名字、资料文字和评分会成为全剧的；其他几份的造型和图片会并进来。</p>
          <div className="cm-members" role="radiogroup" aria-label="选主体">{group.members.map(x => {
            const off = !!locked && x.asset_id !== locked.asset_id;
            return <label key={x.asset_id} className={'cm-member' + (primary === x.asset_id ? ' is-on' : '') + (off ? ' is-off' : '')}>
              <input type="radio" name="cm-primary" checked={primary === x.asset_id} disabled={off || !!busy} onChange={() => { setPrimary(x.asset_id); setPreview(null); }}/>
              <span className="cm-member-body"><span className="cm-member-head"><b>{memberLabel(x, group.name, seasons)}</b>{primary === x.asset_id && <span className="cm-tag">主体</span>}{x.primary_locked && <span className="cm-tag">全剧共享</span>}</span>
                <span>{x.look_count} 个造型 · {x.image_count} 张图 · {x.scored_dimensions} 个维度有分 · 被 {refShots(x.references)} 个镜头引用</span>
                {(x.base_info_excerpt || x.performance_info_excerpt) && <small>资料：「{(x.base_info_excerpt || x.performance_info_excerpt)!.slice(0, 40)}…」</small>}</span>
            </label>; })}</div>
          {locked && <p className="ca-muted">这一组里有全剧共享的「{group.name}」，主体只能是它；其他几份并进来，分数保留为各自那一集的本集覆盖。</p>}
          <p className="ca-muted">只合并同一部剧里的同名人物，已归档的不在这里。点下一步只是看合并后的样子，不会改动任何东西。</p>
        </>}

        {step !== 'pick' && preview && <>
          {preview.blockers.length > 0 && <div className="ca-alert" role="alert"><b>暂时不能合并：</b>{preview.blockers.map((b, i) => <div key={i}>{mergeErrorText[b.code] ?? b.message ?? b.error ?? b.code}</div>)}</div>}
          {step === 'impact' && <MergeImpact preview={preview} group={group} label={label} placeOf={placeOf} lookName={lookName} primary={primaryMember}/>}
          {step === 'issues' && <div className="cm-issues">{conflicts.map(c => {
            const src = preview.look_plan.items.find(i => i.source_look_id === c.source_look_id), ch = choiceOf(c.conflict_id) ?? c.default_choice;
            const keep = ch.action === 'keep_both', target = ch.action === 'merge_into' ? ch.target_look_id : c.allowed_targets[0];
            return <fieldset key={c.conflict_id} className="cm-conflict" disabled={!!pending || !!busy}>
              <legend>同名造型：「{src?.result_name ?? lookName(c.source_look_id)}」（{src ? label(src.source_asset_id) : '另一份'} · {src?.image_count ?? 0} 张图）</legend>
              <label><input type="radio" name={'cm-' + c.conflict_id} checked={keep} onChange={() => edit({ conflict_id: c.conflict_id, action: 'keep_both', rename_to: c.suggested_name }, true)}/>都保留，这一个改名为
                <input aria-label="新造型名称" value={keep ? (ch as { rename_to: string }).rename_to : c.suggested_name} disabled={!keep} maxLength={40}
                  onChange={e => edit({ conflict_id: c.conflict_id, action: 'keep_both', rename_to: e.target.value }, false)}
                  onBlur={() => { if (edits[c.conflict_id]) recheck(); }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); recheck(); } }}/></label>
              <label><input type="radio" name={'cm-' + c.conflict_id} checked={!keep} disabled={!c.allowed_targets.length} onChange={() => edit({ conflict_id: c.conflict_id, action: 'merge_into', target_look_id: c.allowed_targets[0] }, true)}/>合成一个：图片并进
                {c.allowed_targets.length > 1 ? <select aria-label="并进哪个造型" value={target} disabled={keep} onChange={e => edit({ conflict_id: c.conflict_id, action: 'merge_into', target_look_id: e.target.value }, true)}>{c.allowed_targets.map(t => <option key={t} value={t}>{lookName(t)}</option>)}</select> : <b>「{lookName(target)}」</b>}</label>
              {c.affected_shots > 0 && <p className="ca-muted">分镜里指定了这个造型的 {c.affected_shots} 个镜头：都保留时仍指向改名后的造型；合成时改指「{lookName(target)}」。原分镜不改写。</p>}
            </fieldset>; })}
            <p className="ca-muted">维度已在剧内统一，评分维度一定对得上，这里不会出现维度冲突。</p></div>}
        </>}
      </div>
      <footer>
        {step === 'pick' && <><button type="button" disabled={!!busy} onClick={close}>取消</button>
          <button type="button" className="ca-primary" disabled={!!busy || !primary} onClick={() => void toImpact()}>看合并后的样子</button></>}
        {step !== 'pick' && <>
          {!pending && <button type="button" disabled={!!busy} onClick={() => { setError(''); setNote(''); setStep(step === 'issues' ? 'impact' : 'pick'); }}>上一步</button>}
          {unchecked && <button type="button" disabled={!!busy} onClick={recheck}>重新核对</button>}
          {step === 'impact' && conflicts.length > 0 && !pending
            ? <button type="button" className="ca-primary" disabled={!!busy || !preview} onClick={() => setStep('issues')}>处理 {conflicts.length} 个同名造型</button>
            : <>{pending && notFound && <button type="button" disabled={!!busy} onClick={onClose}>稍后再核对</button>}
              <button type="button" className="ca-primary" disabled={!canConfirm} onClick={() => void confirm()}>{busy ? busy : pending ? (notFound ? '按原内容重新提交' : '核对上次结果') : '确认合并'}</button></>}
        </>}
      </footer>
    </div>
  </div>;
}

/** 第 2 步：合并后的样子（造型、评分、各集默认造型、分镜引用、资料文字）。 */
function MergeImpact({ preview, group, label, placeOf, lookName, primary }: {
  preview: MergePreview; group: MergeGroup; label: (id: string) => string; placeOf: (p: string | null | undefined) => string;
  lookName: (id: string | null) => string; primary?: MergeMember;
}) {
  const [copied, setCopied] = useState('');
  const items = preview.look_plan.items, conflicts = preview.look_plan.conflicts;
  const bySource = group.members.map(x => ({ x, looks: items.filter(i => i.source_asset_id === x.asset_id && i.action !== 'merge_into') })).filter(r => r.looks.length);
  const resultCount = new Set(items.map(i => i.result_look_id)).size;
  const sp = preview.score_plan, base = sp.series_base.entries.filter(e => e.value !== null).length;
  const preserved = Array.isArray(sp.existing_overrides_preserved) ? sp.existing_overrides_preserved.length : sp.existing_overrides_preserved ?? 0;
  const conflictsByEp = new Map<string, number>(); for (const c of sp.override_conflicts ?? []) conflictsByEp.set(c.project_id, (conflictsByEp.get(c.project_id) ?? 0) + 1);
  const ref = preview.reference_plan, others = preview.text_plan?.other_sources ?? [];
  const copy = async (key: string, text: string) => { try { await navigator.clipboard.writeText(text); setCopied(key); } catch { setCopied('fail:' + key); } };
  return <div className="cm-impact">
    <section><b>造型 · 合并后 {resultCount} 个</b>
      {bySource.map(r => <p key={r.x.asset_id}>{r.looks.map(l => l.result_name).join('、')}<span className="ca-muted">（{r.x.asset_id === primary?.asset_id ? '主体原有' : memberPlace(r.x)}）</span></p>)}
      {conflicts.length > 0 && <p className="cm-warn">{conflicts.length} 个同名造型，下一步处理（默认都保留，后来的那个加集名）</p>}</section>
    <section><b>评分</b>
      <p>{primary?.owner_type === 'series' ? `全剧分数：沿用全剧「${group.name}」原来的分数。` : base ? `全剧分数：完整复制主体（${label(sp.series_base.source_asset_id)}）的 ${base} 项分数；主体没评的维度保持未评。` : `主体（${label(sp.series_base.source_asset_id)}）还没有评分，全剧分数先空着，合并后可以在全剧里打分。`}</p>
      {sp.episode_overrides.map(o => <p key={o.project_id + o.source_asset_id}>{placeOf(o.project_id)}：原来的 {o.entries.length} 项分数保留为「本集覆盖」{o.ai_count ? `（其中 ${o.ai_count} 项是 AI 打的，保留来源和依据）` : ''}，打开{placeOf(o.project_id)}看到的和现在一样。{conflictsByEp.get(o.project_id) ? <span className="cm-warn"> 有 {conflictsByEp.get(o.project_id)} 格和原有的全剧覆盖冲突：按本集人物原分，旧覆盖留在合并记录里。</span> : null}</p>)}
      {preserved > 0 && <p className="ca-muted">原有的 {preserved} 项集级覆盖不受影响。</p>}</section>
    {preview.default_look_plan.length > 0 && <section><b>各集默认造型 · 保持原样</b>
      <ul className="cm-rows">{preview.default_look_plan.map(d => <li key={d.project_id + d.source_asset_id}><span>{placeOf(d.project_id)}</span><span>{d.mode === 'explicit_empty' ? '本集明确不设默认' : d.mode === 'inherit' ? '跟随全剧默认（' + lookName(d.result_look_id) + '）' : lookName(d.result_look_id) + (d.source_asset_id === primary?.asset_id ? '（全剧默认）' : '（设为本集默认造型）')}</span></li>)}</ul></section>}
    <section><b>{ref.shots ? `分镜引用 · ${ref.shots} 个镜头，不改动` : '分镜引用 · 目前没有镜头引用'}</b>
      <p>其他几份改为指向合并后的人物；{ref.shots ? `这 ${ref.shots} 个镜头` : '分镜'}里原来的指向保留，读出来就是合并后的「{group.name}」。{ref.manifests ? `素材清单 ${ref.manifests} 份同样不改写。` : ''}</p></section>
    <section><b>资料文字 · 用主体的</b>
      {!others.length && <p className="ca-muted">其他几份没有资料文字。</p>}
      {others.map(o => { const text = [o.base_info, o.performance_info].filter(Boolean).join('\n\n'); const key = o.source_asset_id; return <div key={key} className="cm-text">
        <p>{label(o.source_asset_id)}的资料：{text ? '「' + text.slice(0, 60) + (text.length > 60 ? '…' : '') + '」' : '（空）'}</p>
        {text && <button type="button" className="ca-link-button" onClick={() => void copy(key, text)}><Copy size={13}/>{copied === key ? '已复制' : '复制原文'}</button>}
        {copied === 'fail:' + key && <small className="cm-warn">复制没成功，可以选中上面的文字手动复制。</small>}
      </div>; })}
      {others.length > 0 && <p className="ca-muted">合并后这些文字不会丢：随合并记录保留，撤销时恢复。需要的话复制到主体资料里再保存。</p>}</section>
    <p className="ca-muted">合并后成为全剧共享人物，各集都能看到。可以撤销，撤销后恢复成合并前的 {group.members.length} 份。</p>
  </div>;
}

const ENTITY: Record<string, string> = { asset: '人物资料', look: '造型', image: '图片', score: '分数', override: '本集覆盖', default: '默认设置', reference: '分镜引用', manifest: '素材清单', mapping: '合并映射' };
/** 撤销合并：先看撤销会恢复什么；合并后又改过的，列出来确认后才撤销；有阻断就不能撤销。 */
export function UndoMergeDialog({ api, libraryId, seriesId, mergeId, name, contextToken, reloadToken, guard, onClose, onUndone }: {
  api: Api; libraryId: string; seriesId: string; mergeId: string; name: string; contextToken?: string;
  /** 重新提交前的草稿保护：返回非空文字就不提交，并显示它。 */
  guard?: () => string;
  /** 凭证过期时重读这部剧的上下文凭证（分组列表顶层的 context_token）。 */
  reloadToken: () => Promise<string | undefined>;
  onClose: () => void; onUndone: (r: UndoReceipt) => void;
}) {
  const m = useMemo(() => mergeApi(api, seriesId), [api, seriesId]);
  const stored = useMemo(() => pendingStore.undo(libraryId, seriesId, mergeId), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [pv, setPv] = useState<UndoPreview | null>(null), [accept, setAccept] = useState(false), [token, setToken] = useState(contextToken);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [note, setNote] = useState('');
  const pendingRef = useRef<UndoBody | null>(stored?.body ?? null), [pending, setPendingState] = useState<UndoBody | null>(stored?.body ?? null);
  const setPending = (p: UndoBody | null) => { pendingRef.current = p; setPendingState(p); pendingStore.setUndo(libraryId, seriesId, mergeId, p ? { libraryId, seriesId, mergeId, name, body: p } : null); };
  const stale = (code?: string) => code === 'CHARACTER_MERGE_UNDO_STALE' || code === 'ASSET_SCOPE_CHANGED' || code === 'CHARACTER_MERGE_STALE';
  /** 核对撤销会恢复什么。凭证过期（组合验收 R2）：先重读这部剧的凭证再预览；重读或预览失败就清掉旧预览，只给「重新核对」。 */
  async function load(message = '', tok = token, retried = false): Promise<void> {
    setBusy('正在核对撤销会恢复什么…'); setError(''); setAccept(false);
    try { setPv(await m.undoPreview(mergeId, tok)); setNote(message); }
    catch (e: any) {
      if (stale(e?.code) && !retried) {
        const fresh = await reloadToken().catch(() => undefined);
        if (fresh) { setToken(fresh); setBusy(''); return load(message || mergeErrorText.CHARACTER_MERGE_UNDO_STALE, fresh, true); }
      }
      setPv(null); setNote(''); setError(mergeErr(e, '核对失败') + '。没有撤销；请点「重新核对」');
    } finally { setBusy(''); }
  }
  useEffect(() => { if (!pendingRef.current) void load(); }, [mergeId]); // eslint-disable-line react-hooks/exhaustive-deps
  const review = (pv?.changes ?? []).filter(c => c.action === 'restore_with_confirmation'), blocks = (pv?.changes ?? []).filter(c => c.action === 'block');
  const needAccept = pv?.status === 'review_required';
  const ok = !busy && (!!pending || (!!pv?.ready && !!pv.undo_token && pv.status !== 'blocked' && pv.status !== 'undone' && (!needAccept || accept)));
  const [notFound, setNotFound] = useState(false);
  /** 服务端确认的拒绝：解除待核对。过期或新阻断时旧预览作废，重读凭证后重新核对，由用户再确认（下次用新编号）。 */
  async function onRejected(e: { code?: string; message?: string }) {
    setPending(null); setNotFound(false);
    if (stale(e?.code) || e?.code === 'CHARACTER_MERGE_UNDO_BLOCKED') {
      setPv(null);
      const fresh = stale(e?.code) ? await reloadToken().catch(() => undefined) : token;
      if (!fresh) { setError('撤销用的凭证过期了，重新读取也没成功，没有撤销；请点「重新核对」'); return; }
      setToken(fresh); await load(mergeErrorText[e.code!] ?? mergeErrorText.CHARACTER_MERGE_UNDO_STALE, fresh, true); return;
    }
    setError(mergeErr(e, '撤销没有执行'));
  }
  async function checkOnce(body: UndoBody) {
    const r = await lookupOnly<UndoReceipt | RejectedReceipt>(() => m.request(body.request_id));
    if (!r) { setNotFound(true); setNote(NOT_FOUND_NOTE('撤销')); return; }
    if (isRejected(r, body.request_id)) { await onRejected(r); return; }
    setPending(null); setNotFound(false); onUndone(r as UndoReceipt);
  }
  async function undo() {
    const held = pendingRef.current;
    if (!ok) return;
    if (held && !notFound) {
      setBusy('正在核对上次结果…'); setError(''); setNote('');
      try { await checkOnce(held); } catch (e: any) { setError(e?.code === 'OUTCOME_UNKNOWN' ? e.message : mergeErr(e, '核对失败，请稍后再试')); }
      finally { setBusy(''); }
      return;
    }
    if (held && notFound) { const why = guard?.(); if (why) { setError(why); return; } }
    const resend = !!held;
    const body = held ?? { request_id: newId(), context_token: token, undo_token: pv!.undo_token!, accept_restore_changes: needAccept && accept };
    setPending(body); setBusy('正在撤销…'); setError('');
    try { const r = await m.undo(mergeId, body); setPending(null); setNotFound(false); onUndone(r); }
    catch (e: any) {
      if (outcomeUnknown(e)) { try { await checkOnce(body); } catch (e2: any) { setError(e2?.code === 'OUTCOME_UNKNOWN' ? e2.message : mergeErr(e2, '核对失败，请稍后再试')); } return; }
      if (resend && !settledRejection(e)) { setNotFound(true); setError(mergeErr(e, '这次没有执行') + '。原请求仍可能完成，待核对记录保留：可以稍后再核对，或稍后再按原内容提交'); return; }
      await onRejected(e);
    } finally { setBusy(''); }
  }
  const close = () => { if (!busy) onClose(); };
  return <div className="ca-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
    <div className="ca-modal cm-dialog" role="dialog" aria-modal="true" aria-label={'撤销合并「' + name + '」'}>
      <header><div><h2>撤销合并「{name}」</h2><p className="ca-muted">恢复成合并前的几份</p></div><button type="button" className="ca-icon-button" aria-label="关闭" disabled={!!busy} onClick={close}><X size={17}/></button></header>
      <div className="ca-modal-content cm-body">
        {error && <div className="ca-alert" role="alert">{error}</div>}
        {note && !error && <p className="cm-note" role="status">{note}</p>}
        {pending && !busy && !notFound && <p className="cm-note" role="status">上次「撤销」的结果还没核对到，已锁定；点「核对上次结果」只按原请求号查询，不会自己重新提交。</p>}
        {!pv && busy && <p className="ca-muted" role="status">{busy}</p>}
        {pv?.status === 'undone' && <p>这次合并已经撤销过了。</p>}
        {pv && pv.status !== 'undone' && <>
          <p>撤销后，合并前的几份各自恢复：资料文字、造型和图片的归属、分数、各集默认设置都回到合并前；分镜里原来的指向不受影响，会自动指回原来那一份。</p>
          {review.length > 0 && <section className="cm-review"><b>合并后又改过这些（撤销会把它们恢复成合并前的样子）：</b>
            <ul>{review.map(c => <li key={c.entity + c.entity_id + c.kind}>{ENTITY[c.entity] ?? c.entity} · {c.kind}{c.project_id ? '（' + c.project_id.slice(0, 8) + '…）' : ''}</li>)}</ul>
            <label><input type="checkbox" checked={accept} disabled={!!pending || !!busy} onChange={e => setAccept(e.target.checked)}/>我已核对，撤销时恢复这些内容（撤销前的状态会存成一个可查的版本）</label></section>}
          {pv.status === 'blocked' && <div className="ca-alert" role="alert"><b>暂时不能撤销：</b>
            {pv.blockers.map((b, i) => <div key={'b' + i}>{mergeErrorText[b.code] ?? b.message ?? b.error ?? b.code}</div>)}
            {blocks.map(c => <div key={c.entity + c.entity_id}>{ENTITY[c.entity] ?? c.entity} · {c.kind}</div>)}
            <div>先处理这些引用或依赖，再回来撤销。</div></div>}
        </>}
      </div>
      <footer><button type="button" disabled={!!busy} onClick={close}>{pv?.status === 'blocked' || pv?.status === 'undone' ? '关闭' : '取消'}</button>
        {!pv && !pending && !busy && <button type="button" onClick={() => void load()}>重新核对</button>}
        {pending && notFound && <button type="button" disabled={!!busy} onClick={onClose}>稍后再核对</button>}
        {(pv || pending) && pv?.status !== 'blocked' && pv?.status !== 'undone' && <button type="button" className="ca-primary" disabled={!ok} onClick={() => void undo()}>{busy ? busy : pending ? (notFound ? '按原内容重新提交' : '核对上次结果') : '撤销合并'}</button>}</footer>
    </div>
  </div>;
}
