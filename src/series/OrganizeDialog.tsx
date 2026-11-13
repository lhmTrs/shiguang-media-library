import { useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Modal } from './Modal';
import { suggestGroups } from './organize';
import { errorText, newRequestId, seasonName, type AttributeGroupChoice, type AttributePlan, type GroupedProject, type OrganizeConflict, type OrganizeReceipt, type OrganizeRequest, type Series, type seriesApi } from './model';
import { AttributePlanEditor, needsAttributeReview } from './AttributePlanEditor';

// 「整理旧项目」（原型 ④）：按名字规律建议归组，用户核对剧名、放入位置、集号后一次提交。
// 提交是一次 POST /project-series/organize：服务端在一个事务里建剧、核对、落全部归属，任一失败整批回退。
// 回应不明时按原请求编号查询；查不到就用原编号、原内容重发，不会重复写入。
type Api = ReturnType<typeof seriesApi>;
type Row = { project: GroupedProject; no: string; checked: boolean; uncertain: boolean; conflict?: string };
type Group = { key: string; name: string; existing: Series | null; container: string; rows: Row[]; conflict?: string };
type Status = { tone: 'error' | 'unknown'; text: string } | null;

export function OrganizeDialog({ ungrouped, series, api, close, done }: { ungrouped: GroupedProject[]; series: Series[]; api: Api; close: () => void; done: (summary: string) => void }) {
  const initial = useMemo(() => suggestGroups(ungrouped, series).map<Group>(g => ({ key: g.key, name: g.name, existing: g.existing, container: 'root', rows: g.rows.map(r => ({ project: r.project, no: String(r.episode_no), checked: r.checked, uncertain: r.uncertain })) })), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [groups, setGroups] = useState<Group[]>(initial), [busy, setBusy] = useState(false), [status, setStatus] = useState<Status>(null);
  /** 已发出、结果不明的请求：固定编号和内容，只能原样查询或重发。 */
  const pending = useRef<OrganizeRequest | null>(null), [unknown, setUnknown] = useState(false);
  // 提交中、或已发出但结果不明时一律锁定：重发必须是原编号、原内容，界面也要一直显示原内容。
  const locked = busy || unknown;
  const editGroup = (i: number, change: Partial<Group>) => !locked && setGroups(gs => gs.map((g, j) => j === i ? { ...g, ...change, conflict: undefined } : g));
  const editRow = (i: number, r: number, change: Partial<Row>) => !locked && setGroups(gs => gs.map((g, j) => j === i ? { ...g, conflict: undefined, rows: g.rows.map((row, k) => k === r ? { ...row, ...change, conflict: undefined } : row) } : g));

  // —— 校验：剧名不能空、不能和已有剧或别的新剧重名；同组勾选的集号必须是不重复的正整数 ——
  const existingNames = new Set(series.map(s => s.name.trim().toLowerCase()));
  const problems = groups.map(g => {
    const rows = g.rows.filter(r => r.checked); if (!rows.length) return { group: '', rows: new Map<number, string>() };
    const nums = rows.map(r => Number(r.no)), rowProblems = new Map<number, string>();
    g.rows.forEach((r, k) => { if (!r.checked) return; const n = Number(r.no); if (!Number.isInteger(n) || n < 1) rowProblems.set(k, '集号要是正整数'); else if (nums.filter(x => x === n).length > 1) rowProblems.set(k, '和本组另一项重号'); });
    let group = '';
    if (!g.existing) {
      const name = g.name.trim().toLowerCase();
      if (!name) group = '请填剧名';
      else if (existingNames.has(name)) group = '已有同名的剧';
      else if (groups.some(o => o !== g && !o.existing && o.rows.some(r => r.checked) && o.name.trim().toLowerCase() === name)) group = '和另一组新剧重名';
    }
    return { group, rows: rowProblems };
  });
  const active = groups.filter(g => g.rows.some(r => r.checked));
  const invalid = problems.some(p => p.group || p.rows.size > 0) || !active.length;
  const newCount = active.filter(g => !g.existing).length, rowCount = active.reduce((n, g) => n + g.rows.filter(r => r.checked).length, 0);

  const build = (): OrganizeRequest => ({ request_id: newRequestId(), groups: active.map(g => {
    const softwares = [...new Set(g.rows.filter(r => r.checked).map(r => r.project.software))];
    return { group_id: g.key, target: g.existing ? { series_id: g.existing.id, season_id: g.container === 'root' ? null : g.container } : { new_series: { name: g.name.trim(), ...(softwares.length === 1 && softwares[0] ? { software: softwares[0] } : {}) } },
      items: g.rows.filter(r => r.checked).map(r => ({ project_id: r.project.id, expected_revision: r.project.membership_revision ?? 0, episode_no: Number(r.no) })) };
  }) });
  const succeed = (r: OrganizeReceipt) => { pending.current = null; setUnknown(false); done(`已${r.created_series.length ? `新建 ${r.created_series.length} 部剧、` : ''}归组 ${r.changes.length} 个项目`); };
  const markConflicts = (conflicts: OrganizeConflict[]) => setGroups(gs => gs.map(g => {
    const mine = conflicts.filter(c => c.group_id === g.key); if (!mine.length) return g;
    const text = (c: OrganizeConflict, n?: string) => c.code === 'EPISODE_NUMBER_CONFLICT' ? `第 ${c.episode_no ?? n} 集已被占用` : errorText({ code: c.code });
    return { ...g, conflict: mine.filter(c => !c.project_id).map(c => text(c)).join('；') || undefined, rows: g.rows.map(r => { const c = mine.filter(x => x.project_id === r.project.id); return c.length ? { ...r, conflict: c.map(x => text(x, r.no)).join('；') } : r; }) };
  }));

  async function recheck(req: OrganizeRequest) {
    try {
      const s = await api.requestStatus(req.request_id);
      if (s.found) { succeed(s.result as OrganizeReceipt); return; }
      setStatus({ tone: 'unknown', text: '尚未查到成功回执，结果待核对。可以稍后点「重新核对」，或用原请求重新提交（同一编号不会重复写入）。' });
    } catch { setStatus({ tone: 'unknown', text: '结果待核对：暂时查不到这次归组有没有完成。请稍后点「重新核对」，不要重复整理。' }); }
  }
  // 维度剧内统一（合同 v1 · A3）：新提交先预览维度计划；有要你决定的项（新剧基准、维度对应）就先核对，再带凭证提交。
  const [attr, setAttr] = useState<{ plan: AttributePlan; ready: boolean } | null>(null);
  async function submit() {
    if (pending.current) { await send(pending.current); return; }
    let plan = attr?.plan;
    if (!attr) {
      setBusy(true); setStatus(null);
      try {
        const pv = await api.previewOrganize(build().groups);
        if (pv.conflicts?.length) { markConflicts(pv.conflicts); setStatus({ tone: 'error', text: '有冲突，整批都没有写入。改好标红的项后再提交。' }); return; }
        if (pv.attribute_plan && needsAttributeReview(pv.attribute_plan, pv.ready)) { setAttr({ plan: pv.attribute_plan, ready: pv.ready }); return; }
        plan = pv.attribute_plan;
      } catch (e) {
        const st = (e as { status?: number }).status;
        // 旧后端没有整理预览（404 / 405，或把未知路径交给网页本身、没有状态码）：照原流程提交；
        // 新后端在需要核对维度时会以 ATTRIBUTE_PREVIEW_REQUIRED 拒绝，不会因为跳过预览而写错
        if (st && st !== 404 && st !== 405) { setStatus({ tone: 'error', text: errorText(e) + '（整批都没有写入）' }); return; }
      } finally { setBusy(false); }
    }
    await send({ ...build(), ...(plan ? { attribute_preview_token: plan.preview_token, attribute_choices: plan.choices } : {}) });
  }
  // 改选后重新预览：以服务端回显和新凭证为准。回来的是冲突、或已没有维度计划时，旧凭证作废，回到归组表显示真实冲突。
  // 失败时界面仍显示上一次成功核对的选择（选择框受回显控制），确认用的也是那一次的凭证，两者一致。
  const rePreviewAttr = (choices: AttributeGroupChoice[]) => { if (locked) return; setBusy(true); setStatus(null);
    void api.previewOrganize(build().groups, choices).then(pv => {
      if (pv.conflicts?.length) { setAttr(null); markConflicts(pv.conflicts); setStatus({ tone: 'error', text: '有冲突，整批都没有写入。改好标红的项后再提交。' }); return; }
      if (!pv.attribute_plan) { setAttr(null); setStatus({ tone: 'error', text: '情况刚变了，这次归组不再涉及维度对应。请核对后再点一次归组。' }); return; }
      setAttr({ plan: pv.attribute_plan, ready: pv.ready });
    }).catch(e => setStatus({ tone: 'error', text: errorText(e) + '（选择没有改动，仍按上一次核对的执行）' })).finally(() => setBusy(false)); };
  async function send(req: OrganizeRequest & { attribute_preview_token?: string; attribute_choices?: AttributeGroupChoice[] }) {
    pending.current = req;
    setBusy(true); setStatus(null);
    try { succeed(await api.organize(req)); }
    catch (e) {
      const err = e as { status?: number; code?: string; details?: { conflicts?: OrganizeConflict[] } };
      if (err.status && err.status < 500) {
        // 被拒绝：这次的维度凭证一律作废，下一次归组重新预览，不会再带旧凭证
        pending.current = null; setUnknown(false); setAttr(null);
        if (err.code === 'SERIES_ORGANIZE_CONFLICT' && err.details?.conflicts?.length) { markConflicts(err.details.conflicts); setStatus({ tone: 'error', text: '有冲突，整批都没有写入。改好标红的项后再提交。' }); }
        else if (['ATTRIBUTE_ALIGNMENT_STALE', 'ATTRIBUTE_PREVIEW_REQUIRED', 'ATTRIBUTE_CONTEXT_STALE'].includes(err.code ?? '')) setStatus({ tone: 'error', text: '维度或分数刚有变化，整批都没有写入。请再点一次归组，按最新情况重新核对。' });
        else setStatus({ tone: 'error', text: errorText(e) + '（整批都没有写入）' });
      } else { setUnknown(true); await recheck(req); }
    } finally { setBusy(false); }
  }

  return <Modal label="整理旧项目" close={close} busy={busy}>
    <form className="pf-organize" onSubmit={e => { e.preventDefault(); if ((unknown || !invalid) && !busy) void submit(); }}>
      <div className="modal-body">
        {attr ? <>
          <p className="muted pf-hint">{unknown ? '上次归组的结果还没核对到。下面是那次提交的维度选择，已锁定；只能核对或用原请求重新提交。' : '归组后，这些集改用所在剧的人物属性维度。核对下面的维度对应后再归组：'}</p>
          <AttributePlanEditor plan={attr.plan} busy={locked} nameOf={id => ungrouped.find(p => p.id === id)?.name ?? '某一集'} groupLabel={id => { const g = groups.find(x => x.key === id); return g?.existing?.name ?? (g?.name.trim() || '新剧'); }} onChoices={rePreviewAttr}/>
        </> : !groups.length ? <p className="muted pf-hint">没找到能归到同一部剧的项目。项目名结尾带集号（如「某剧_12」「某剧3」）才会被建议；也可以在项目卡片上右键「放进剧…」。</p> : <>
          <p className="muted pf-hint">按项目名找到 {groups.length} 组。核对剧名和集号后一次归组；项目名、素材、分镜、视频都不变。</p>
          {groups.map((g, i) => <fieldset key={g.key} className="pf-og" disabled={locked}>
            <legend className="pf-og-head">
              {g.existing ? <b>{g.existing.name}</b> : <input aria-label={`${g.name || '新剧'}的剧名`} value={g.name} maxLength={120} disabled={locked} onChange={e => editGroup(i, { name: e.target.value })}/>}
              <span className="pf-tag">{g.existing ? '已有剧' : '新建剧'}</span>
              {g.existing && g.existing.seasons.length > 0 && <label className="pf-og-target">放入<select aria-label={`${g.existing.name}的放入位置`} value={g.container} disabled={locked} onChange={e => editGroup(i, { container: e.target.value })}><option value="root">剧里（不进季）</option>{[...g.existing.seasons].sort((a, z) => a.season_no - z.season_no).map(s => <option key={s.id} value={s.id}>{seasonName(s)}</option>)}</select></label>}
              {(g.conflict || problems[i].group) && <small className="pf-conflict">{g.conflict || problems[i].group}</small>}
            </legend>
            <table><tbody>{g.rows.map((r, k) => { const issue = r.conflict ?? problems[i].rows.get(k); return <tr key={r.project.id} data-conflict={issue ? 'yes' : undefined}>
              <td><input type="checkbox" aria-label={`归入 ${r.project.name}`} checked={r.checked} onChange={e => editRow(i, k, { checked: e.target.checked })}/></td>
              <td>{r.project.name}{r.uncertain && <small className="pf-warn">编号不确定，请核对</small>}{issue && <small className="pf-conflict">{issue}</small>}</td>
              <td className="pf-og-no">第 <input aria-label={`${r.project.name}的集号`} type="number" min={1} step={1} value={r.no} disabled={!r.checked} onChange={e => editRow(i, k, { no: e.target.value })}/> 集</td>
            </tr>; })}</tbody></table>
          </fieldset>)}
          <p className="muted pf-hint">其余未分组的项目保持原样，以后可以右键「放进剧…」。</p>
        </>}
        {status && <p className={status.tone === 'error' ? 'database-error' : 'pf-unknown'} role="alert">{status.text}</p>}
      </div>
      <div className="modal-footer">
        {groups.length > 0 && <span className="pf-og-summary">{newCount ? `将新建 ${newCount} 部剧，` : ''}归组 {rowCount} 个项目</span>}
        {attr && !unknown && <button type="button" className="plain" disabled={busy} onClick={() => setAttr(null)}>返回修改</button>}
        <button type="button" className="plain" disabled={busy} onClick={close}>{groups.length ? '取消' : '关闭'}</button>
        {unknown && <button type="button" className="plain" disabled={busy} onClick={() => { const req = pending.current; if (req) { setBusy(true); void recheck(req).finally(() => setBusy(false)); } }}>重新核对</button>}
        {groups.length > 0 && <button className="primary" type="submit" disabled={busy || (!unknown && (invalid || !!attr && !attr.ready))}><Check size={15}/>{busy ? '归组中…' : unknown ? '用原请求重新提交' : `归组 ${rowCount} 个项目`}</button>}
      </div>
    </form>
  </Modal>;
}
