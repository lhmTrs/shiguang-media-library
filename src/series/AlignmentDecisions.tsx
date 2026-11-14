// 维度对应的展示与选择（合同 v1 · A2 / A3 共用）：自动对应一组，需要你决定一组；默认「保留为旧评分」。
// 选项只改本地选择，由调用方带着完整 choices 重新预览，以服务端回显为准。
import React from "react";
import type { AlignmentChoice, AlignmentPreview } from "./alignment";
import { dimLabel, impactText, reasonText } from "./alignment";
import "./alignment.css";

export function AlignmentDecisions({ preview, choices, disabled, onChoose }: {
  preview: AlignmentPreview; choices: AlignmentChoice[]; disabled: boolean; onChoose: (choice: AlignmentChoice) => void;
}) {
  const choiceOf = (id: string) => choices.find(c => c.item_id === id);
  const decisions = preview.episodes.flatMap(ep => ep.decisions.map(d => ({ ep, d })));
  const automatic = preview.episodes.reduce((n, ep) => n + ep.automatic.length, 0);
  const allIdentical = preview.episodes.length > 0 && preview.episodes.every(ep => ep.comparison === "identical");
  const added = preview.series_changes.added;
  const over = preview.series_changes.dimension_count_after > preview.series_changes.max;
  return <div className="aa-decisions">
    {allIdentical ? <section className="aa-ok" aria-label="维度一致">
      <b>{preview.episodes.length} 集的维度和全剧完全一致，不需要对应</b>
      <ul>{preview.episodes.map(ep => <li key={ep.project_id}><span>{ep.project_name}</span><span className="aa-ok-tag">一致</span></li>)}</ul>
    </section> : <>
      {automatic > 0 && <section className="aa-ok" aria-label="自动对应">
        <b>自动对应 · {automatic} 个（名称、两端、方向、五档和依据都一致）</b>
        <ul>{preview.episodes.filter(ep => ep.automatic.length).map(ep => <li key={ep.project_id}><span>{ep.project_name}</span><span>{ep.automatic.length} 个维度，分数原样搬过去</span></li>)}</ul>
      </section>}
      {decisions.length > 0 && <section className="aa-todo" aria-label="需要你决定">
        <b>需要你决定 · {decisions.length} 个</b>
        {decisions.map(({ ep, d }) => {
          const c = choiceOf(d.item_id) ?? d.suggested_choice;
          return <fieldset key={d.item_id} className="aa-item" disabled={disabled}>
            <legend>{ep.project_name} · {dimLabel(d.source_dimension)}</legend>
            <p className="aa-reason">{reasonText[d.reason]} · {impactText(d.impact)}</p>
            <div className="aa-actions">
              {d.allowed_actions.includes("retain_legacy") && <label><input type="radio" name={d.item_id} checked={c.action === "retain_legacy"} onChange={() => onChoose({ item_id: d.item_id, action: "retain_legacy" })}/>保留为旧评分（不搬过去，存档可查）</label>}
              {d.allowed_actions.includes("add_to_series") && <label><input type="radio" name={d.item_id} checked={c.action === "add_to_series"} onChange={() => onChoose({ item_id: d.item_id, action: "add_to_series" })}/>加到全剧</label>}
              {d.allowed_actions.includes("map_existing") && d.eligible_targets.length > 0 && <span className="aa-map">
                <label><input type="radio" name={d.item_id} checked={c.action === "map_existing"} onChange={() => onChoose({ item_id: d.item_id, action: "map_existing", target_dimension_id: d.eligible_targets[0].id })}/>含义一样，对应到</label>
                <select aria-label={`${d.source_dimension?.name ?? "这个维度"}对应到全剧维度`} value={c.action === "map_existing" ? c.target_dimension_id : ""} onChange={e => e.target.value && onChoose({ item_id: d.item_id, action: "map_existing", target_dimension_id: e.target.value })}>
                  <option value="">选择全剧维度</option>{d.eligible_targets.map(t => <option key={t.id} value={t.id}>{dimLabel(t)}</option>)}</select>
              </span>}
            </div>
            {d.allowed_actions.includes("map_existing") && <small className="aa-hint">只有含义和方向确实一样才对应；含义变了请保留旧评分，按全剧维度重新打分。</small>}
          </fieldset>;
        })}
      </section>}
    </>}
    {added.length > 0 && <section className={over ? "aa-todo" : "aa-ok"} aria-label="全剧维度变化">
      <b>全剧会新增 {added.length} 个维度（{preview.series_changes.dimension_count_before} → {preview.series_changes.dimension_count_after} 个）</b>
      <ul>{added.map(a => <li key={a.dimension.id ?? a.dimension.name}><span>{dimLabel(a.dimension)}</span><span>全剧 {a.impact.people} 个人物会多这一项，其他人物显示「未评」</span></li>)}</ul>
      {over && <p className="aa-reason">全剧最多 {preview.series_changes.max} 个维度，请少加几个。</p>}
    </section>}
    {preview.blockers.length > 0 && !over && <p className="aa-reason" role="alert">还有 {preview.blockers.length} 项不能确认，请按上面的提示调整后再试。</p>}
  </div>;
}
