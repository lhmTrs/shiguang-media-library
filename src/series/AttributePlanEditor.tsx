// 归组 / 挪集 / 批量整理的维度计划（合同 v1 · A3）：每组的新剧基准选择 + 维度对应。
// 只产出完整的 attribute_choices，由调用方重新预览，以服务端回显和新凭证为准。
import React from "react";
import { AlignmentDecisions } from "./AlignmentDecisions";
import { mergeChoices, type AlignmentChoice } from "./alignment";
import type { AttributeGroupChoice, AttributePlan } from "./model";

/** 有要你决定的维度、要新增全剧维度、要选新剧的维度基准，或预览本身没就绪时，才需要让用户核对。 */
export function needsAttributeReview(plan: AttributePlan, ready: boolean) {
  return !ready || plan.groups.some(g => (g.baseline_options?.length ?? 0) > 1 || !!g.alignment && (!g.alignment.ready || g.alignment.series_changes.added.length > 0 || g.alignment.episodes.some(ep => ep.decisions.length > 0)));
}

export function AttributePlanEditor({ plan, busy, nameOf, groupLabel, onChoices }: {
  plan: AttributePlan; busy: boolean; nameOf: (projectId: string) => string; groupLabel?: (groupId: string) => string;
  onChoices: (choices: AttributeGroupChoice[]) => void;
}) {
  const choiceFor = (groupId: string): AttributeGroupChoice => plan.choices.find(c => c.group_id === groupId) ?? { group_id: groupId, decisions: [] };
  const update = (groupId: string, patch: Partial<AttributeGroupChoice>) =>
    onChoices(plan.groups.map(g => g.group_id === groupId ? { ...choiceFor(g.group_id), ...patch } : choiceFor(g.group_id)));
  const choose = (groupId: string, c: AlignmentChoice) => {
    const g = plan.groups.find(x => x.group_id === groupId); if (!g?.alignment) return;
    const current = Object.fromEntries(choiceFor(groupId).decisions.map(d => [d.item_id, d] as const));
    update(groupId, { decisions: mergeChoices(g.alignment, { ...current, [c.item_id]: c }) });
  };
  const shown = plan.groups.filter(g => (g.baseline_options?.length ?? 0) > 1 || g.alignment);
  return <div className="pf-attr-map">
    {shown.map(g => <div key={g.group_id} className="pf-attr-group">
      {shown.length > 1 && groupLabel && <b>{groupLabel(g.group_id)}</b>}
      {(g.baseline_options?.length ?? 0) > 1 && <label className="field">新剧的人物属性维度从哪来
        <select aria-label="新剧的维度基准" value={JSON.stringify(choiceFor(g.group_id).baseline ?? g.baseline ?? g.baseline_options![0])} disabled={busy}
          onChange={e => update(g.group_id, { baseline: JSON.parse(e.target.value) })}>
          {g.baseline_options!.map(b => <option key={JSON.stringify(b)} value={JSON.stringify(b)}>{b.kind === 'default' ? '系统默认维度' : `复制「${nameOf(b.project_id)}」的维度`}</option>)}
        </select></label>}
      {g.alignment && <AlignmentDecisions preview={g.alignment} choices={choiceFor(g.group_id).decisions} disabled={busy} onChoose={c => choose(g.group_id, c)}/>}
    </div>)}
    {!plan.can_undo && <p className="muted">这次会改变人物属性维度，完成后不能一键撤销；需要时可以再挪回来（同样会先核对）。</p>}
  </div>;
}
