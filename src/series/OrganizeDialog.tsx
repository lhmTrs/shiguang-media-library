import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Modal } from './Modal';
import { suggestGroups } from './organize';
import { errorText, seasonName, type GroupedProject, type MoveConflict, type MoveTarget, type Series, type seriesApi } from './model';

// 「整理旧项目」（原型 ④）：按名字规律建议归组，用户核对剧名、放入位置、集号后一次提交。
// 提交顺序：先对所有「放进已有剧」的组做移动预检，任何撞号都一项不写；全部通过后再逐组建剧、移动。
type Api = ReturnType<typeof seriesApi>;
type Row = { project: GroupedProject; no: string; checked: boolean; uncertain: boolean; conflict?: string };
/** created：这一组的新剧已经建好（部分失败后重试时不再重复建剧）。 */
type Group = { key: string; name: string; existing: Series | null; created?: string; container: string; rows: Row[] };

export function OrganizeDialog({ ungrouped, series, api, close, changed, done }: { ungrouped: GroupedProject[]; series: Series[]; api: Api; close: () => void; changed: () => void; done: (summary: string) => void }) {
  const initial = useMemo(() => suggestGroups(ungrouped, series).map<Group>(g => ({ key: g.key, name: g.name, existing: g.existing, container: 'root', rows: g.rows.map(r => ({ project: r.project, no: String(r.episode_no), checked: r.checked, uncertain: r.uncertain })) })), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [groups, setGroups] = useState<Group[]>(initial), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const editGroup = (i: number, change: Partial<Group>) => setGroups(gs => gs.map((g, j) => j === i ? { ...g, ...change } : g));
  const editRow = (i: number, r: number, change: Partial<Row>) => setGroups(gs => gs.map((g, j) => j === i ? { ...g, rows: g.rows.map((row, k) => k === r ? { ...row, ...change, conflict: change.no !== undefined ? undefined : row.conflict } : row) } : g));

  // —— 校验：剧名不能空、不能和已有剧或别的新剧重名；同组勾选的集号必须是不重复的正整数 ——
  const existingNames = new Set(series.map(s => s.name.trim().toLowerCase()));
  const problems = groups.map(g => {
    const rows = g.rows.filter(r => r.checked); if (!rows.length) return { group: '', rows: new Map<number, string>() };
    const nums = rows.map(r => Number(r.no)), rowProblems = new Map<number, string>();
    g.rows.forEach((r, k) => { if (!r.checked) return; const n = Number(r.no); if (!Number.isInteger(n) || n < 1) rowProblems.set(k, '集号要是正整数'); else if (nums.filter(x => x === n).length > 1) rowProblems.set(k, '和本组另一项重号'); });
    let group = '';
    if (!g.existing && !g.created) {
      const name = g.name.trim().toLowerCase();
      if (!name) group = '请填剧名';
      else if (existingNames.has(name)) group = '已有同名的剧';
      else if (groups.some(o => o !== g && !o.existing && o.rows.some(r => r.checked) && o.name.trim().toLowerCase() === name)) group = '和另一组新剧重名';
    }
    return { group, rows: rowProblems };
  });
  const active = groups.filter(g => g.rows.some(r => r.checked));
  const invalid = problems.some(p => p.group || p.rows.size > 0) || !active.length;
  const newCount = active.filter(g => !g.existing && !g.created).length, rowCount = active.reduce((n, g) => n + g.rows.filter(r => r.checked).length, 0);

  const targetOf = (g: Group, seriesId: string): MoveTarget => ({ series_id: seriesId, season_id: g.container === 'root' ? null : g.container });
  const itemsOf = (g: Group) => g.rows.filter(r => r.checked).map(r => ({ project_id: r.project.id, expected_revision: r.project.membership_revision ?? 0, episode_no: Number(r.no) }));

  async function submit() {
    setBusy(true); setError('');
    try {
      // 1) 预检：放进已有剧的组。任何冲突都在这里拦下，什么都不写。
      let blocked = false;
      for (const [i, g] of groups.entries()) {
        if (!g.existing || !g.rows.some(r => r.checked)) continue;
        const preview = await api.previewMove(targetOf(g, g.existing.id), itemsOf(g));
        if (!preview.ready || preview.conflicts.length) { blocked = true; markConflicts(i, preview.conflicts); }
      }
      if (blocked) { setError('有集号冲突，还没有写入任何内容。改号后再提交。'); return; }
      // 2) 逐组提交：新剧先建剧，再把勾选的项目带号移进去。
      let finished = 0;
      for (const [i, g] of groups.entries()) {
        if (!g.rows.some(r => r.checked)) continue;
        try {
          let seriesId = g.existing?.id ?? g.created;
          if (!seriesId) { const softwares = [...new Set(g.rows.filter(r => r.checked).map(r => r.project.software))]; seriesId = (await api.createSeries(g.name.trim(), softwares.length === 1 ? softwares[0] : '')).id; editGroup(i, { created: seriesId }); }
          await api.move(targetOf(g, seriesId), itemsOf(g));
          finished++; editGroup(i, { rows: g.rows.map(r => r.checked ? { ...r, checked: false } : r) });
        } catch (e) {
          const conflicts = (e as { details?: { conflicts?: MoveConflict[] } }).details?.conflicts;
          if (conflicts?.length) markConflicts(i, conflicts);
          setError(`${finished ? `前 ${finished} 组已完成；` : ''}「${g.name}」没有完成：${errorText(e)}`);
          changed();
          return;
        }
      }
      done(`已${newCount ? `新建 ${newCount} 部剧、` : ''}归组 ${rowCount} 个项目`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const markConflicts = (i: number, conflicts: MoveConflict[]) => setGroups(gs => gs.map((g, j) => j !== i ? g : { ...g, rows: g.rows.map(r => { const c = conflicts.filter(x => x.project_id === r.project.id); return c.length ? { ...r, conflict: c.map(x => x.code === 'EPISODE_NUMBER_CONFLICT' ? `第 ${x.episode_no ?? r.no} 集已被占用` : errorText({ code: x.code })).join('；') } : r; }) }));

  return <Modal label="整理旧项目" close={close} busy={busy}>
    <form className="pf-organize" onSubmit={e => { e.preventDefault(); if (!invalid && !busy) void submit(); }}>
      <div className="modal-body">
        {!groups.length ? <p className="muted pf-hint">没找到能归到同一部剧的项目。项目名结尾带集号（如「某剧_12」「某剧3」）才会被建议；也可以在项目卡片上右键「放进剧…」。</p> : <>
          <p className="muted pf-hint">按项目名找到 {groups.length} 组。核对剧名和集号后一次归组；项目名、素材、分镜、视频都不变。</p>
          {groups.map((g, i) => <fieldset key={g.key} className="pf-og" disabled={busy}>
            <legend className="pf-og-head">
              {g.existing || g.created ? <b>{g.existing?.name ?? g.name}</b> : <input aria-label={`${g.name || '新剧'}的剧名`} value={g.name} maxLength={120} onChange={e => editGroup(i, { name: e.target.value })}/>}
              <span className="pf-tag">{g.existing ? '已有剧' : g.created ? '已建好' : '新建剧'}</span>
              {g.existing && g.existing.seasons.length > 0 && <label className="pf-og-target">放入<select aria-label={`${g.existing.name}的放入位置`} value={g.container} onChange={e => editGroup(i, { container: e.target.value })}><option value="root">剧里（不进季）</option>{[...g.existing.seasons].sort((a, z) => a.season_no - z.season_no).map(s => <option key={s.id} value={s.id}>{seasonName(s)}</option>)}</select></label>}
              {problems[i].group && <small className="pf-conflict">{problems[i].group}</small>}
            </legend>
            <table><tbody>{g.rows.map((r, k) => { const issue = r.conflict ?? problems[i].rows.get(k); return <tr key={r.project.id} data-conflict={issue ? 'yes' : undefined}>
              <td><input type="checkbox" aria-label={`归入 ${r.project.name}`} checked={r.checked} onChange={e => editRow(i, k, { checked: e.target.checked })}/></td>
              <td>{r.project.name}{r.uncertain && <small className="pf-warn">编号不确定，请核对</small>}{issue && <small className="pf-conflict">{issue}</small>}</td>
              <td className="pf-og-no">第 <input aria-label={`${r.project.name}的集号`} type="number" min={1} step={1} value={r.no} disabled={!r.checked} onChange={e => editRow(i, k, { no: e.target.value })}/> 集</td>
            </tr>; })}</tbody></table>
          </fieldset>)}
          <p className="muted pf-hint">其余未分组的项目保持原样，以后可以右键「放进剧…」。</p>
        </>}
        {error && <p className="database-error" role="alert">{error}</p>}
      </div>
      <div className="modal-footer">
        {groups.length > 0 && <span className="pf-og-summary">{newCount ? `将新建 ${newCount} 部剧，` : ''}归组 {rowCount} 个项目</span>}
        <button type="button" className="plain" disabled={busy} onClick={close}>{groups.length ? '取消' : '关闭'}</button>
        {groups.length > 0 && <button className="primary" type="submit" disabled={busy || invalid}><Check size={15}/>{busy ? '归组中…' : `归组 ${rowCount} 个项目`}</button>}
      </div>
    </form>
  </Modal>;
}
