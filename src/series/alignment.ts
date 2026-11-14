// 人物属性维度剧内统一（合同 v1 · A2 / A3）：对齐预览的类型、接口与给人看的文字。
// 合同见 ai_work_place archive 20261113-234408（草案 A1–A4）与 20261113-235448（定稿）。
import type { AttrDimension } from "../project-assets/attributes";
import { newRequestId } from "./model";

type Request = <T = any>(path: string, body?: unknown, method?: string) => Promise<T>;

export type AlignmentChoice =
  | { item_id: string; action: "retain_legacy" }
  | { item_id: string; action: "map_existing"; target_dimension_id: string }
  | { item_id: string; action: "add_to_series" };
export type AlignmentImpact = { project_count: number; people: number; archived_people: number; scored_cells: number; manual_clear_cells: number };
export type AlignmentReason = "missing_in_series" | "different_meaning" | "direction_conflict" | "ambiguous" | "target_conflict" | "unknown_score_key";
export type AlignmentDecision = {
  item_id: string; source_dimension_id: string; source_dimension: AttrDimension | null; reason: AlignmentReason;
  allowed_actions: AlignmentChoice["action"][]; eligible_targets: AttrDimension[]; suggested_choice: AlignmentChoice; impact: AlignmentImpact;
};
export type AlignmentEpisode = {
  project_id: string; project_name: string; membership_revision: number; comparison: "identical" | "auto_map" | "needs_review";
  automatic: { source_dimension_id: string; target_dimension_id: string; mode: "unchanged" | "remap"; impact: AlignmentImpact }[];
  decisions: AlignmentDecision[]; target_only_dimensions: AttrDimension[];
};
export type AlignmentPreview = {
  series_id: string | null; alignment_revision: number; ready: boolean; preview_token: string | null;
  episodes: AlignmentEpisode[]; choices: AlignmentChoice[];
  series_changes: { added: { item_ids: string[]; dimension: AttrDimension; impact: AlignmentImpact }[]; dimension_count_before: number; dimension_count_after: number; min: number; max: number };
  total_impact: AlignmentImpact; blockers: { code: string; project_id?: string; item_id?: string }[];
};
export type AlignmentStatus = { series_id: string; status: "pending" | "aligned"; alignment_revision: number; episode_count: number };
export type AlignmentReceipt = { request_id: string; kind: "attribute_alignment"; series_id: string; alignment_status: "aligned"; alignment_revision: number; config_revision: number; history_id: string; episodes_updated: number; scores_remapped: number; scores_retained_in_history: number; can_undo: false };

export function alignmentApi(request: Request) {
  const base = (id: string) => `/project-series/${encodeURIComponent(id)}/attribute-alignment`;
  return {
    status: (seriesId: string) => request<AlignmentStatus>(base(seriesId)),
    preview: (seriesId: string, expectedRevision: number, choices?: AlignmentChoice[]) =>
      request<AlignmentPreview>(base(seriesId) + "/preview", { expected_alignment_revision: expectedRevision, ...(choices ? { choices } : {}) }, "POST"),
    confirm: (seriesId: string, body: { request_id: string; preview_token: string; choices: AlignmentChoice[] }) =>
      request<AlignmentReceipt>(base(seriesId) + "/confirm", body, "POST"),
    requestStatus: (requestId: string) => request<{ found: boolean; result?: AlignmentReceipt }>(`/project-series/requests/${encodeURIComponent(requestId)}`),
    newRequestId,
  };
}

export const reasonText: Record<AlignmentReason, string> = {
  missing_in_series: "全剧没有这个维度",
  different_meaning: "名字一样，但含义不同",
  direction_conflict: "两端方向和全剧相反",
  ambiguous: "可能对应好几个全剧维度，无法自动判断",
  target_conflict: "和另一个维度争同一个全剧维度",
  unknown_score_key: "旧分数对不上任何已知维度",
};
export const dimLabel = (d: AttrDimension | null | undefined) => !d ? "未知维度" : `「${d.name}」（${d.negative_label} ↔ ${d.positive_label}）`;
export const impactText = (i: AlignmentImpact) =>
  `${i.people} 个人物有分数${i.archived_people ? `（其中 ${i.archived_people} 个已归档）` : ""}${i.manual_clear_cells ? `，${i.manual_clear_cells} 格是手动清空` : ""}`;
export const alignmentErrorText: Record<string, string> = {
  ATTRIBUTE_ALIGNMENT_STALE: "剧里的维度或分数刚被改过，已重新读取，请再核对一次",
  ATTRIBUTE_ALIGNMENT_REQUIRED: "目标剧的维度还没统一：请先到这部剧的全剧视图完成「统一维度」",
  ATTRIBUTE_PREVIEW_REQUIRED: "这次移动会改变人物属性维度，需要先核对维度对应",
  REQUEST_ID_CONFLICT: "请求编号已被另一份内容用过，请重新提交",
  STORYBOARD_GENERATION_LOCKED: "有一集正在生成分镜，暂时不能统一，请稍后再试",
};
/** 把 choices 合成到当前预览的默认值上：每个待决定项一条。 */
export function mergeChoices(preview: AlignmentPreview, changed: Record<string, AlignmentChoice>): AlignmentChoice[] {
  const byId = new Map(preview.choices.map(c => [c.item_id, c]));
  for (const ep of preview.episodes) for (const d of ep.decisions) if (!byId.has(d.item_id)) byId.set(d.item_id, d.suggested_choice);
  for (const [id, c] of Object.entries(changed)) byId.set(id, c);
  return [...byId.values()];
}
