// 第二期 P2a：资产按作用域读取（剧 / 季 / 集）。形状来自 Codex 的后端合同 v1（SERIES-P2a）。
// 令牌（context_token / write_token）是服务端发的，前端只原样回传，不解析。

export type ScopeType = 'series' | 'season' | 'episode';
export type OwnerType = 'project' | 'series';
export type AssetContext = {
  project: { id: string; name: string };
  series: { id: string; name: string } | null;
  season: { id: string; name: string } | null;
  membership_revision: number;
  context_token: string;
};
export type AssetOwner = { type: OwnerType; id: string; name: string };
export type AssetCapabilities = { edit_base: boolean; create_override: boolean; append: boolean; promote: boolean; archive: boolean };
export type FieldSource = { type: 'episode' | 'season' | 'series' | 'project'; id: string; revision: number };
export type EffectiveField<T> = { value: T; source: FieldSource; override: { value: T; revision: number } | null; parent: { value: T; source: FieldSource } | null; write_token: string };
export type Effective = {
  default_look?: EffectiveField<string | null>;
  default_images?: Record<string, EffectiveField<string | null>>;
  attribute_scores?: Record<string, EffectiveField<unknown>>;
  cover?: unknown;
};
/** 列表项与详情共用的外层；列表额外带 cover / look_count。 */
export type ScopedItem<A> = { asset: A; owner: AssetOwner; capabilities: AssetCapabilities; effective: Effective; context_token: string; cover?: unknown; look_count?: number };
export type ScopedList<A> = { scope: { type: ScopeType; id: string }; context_token: string; total: number; page: number; items: ScopedItem<A>[] };

export const scopePath = (type: ScopeType, id: string) => `/scopes/${type}/${encodeURIComponent(id)}`;

/** 后端还没有作用域接口（旧版本）：页面保持原有行为，不提示错误。
 *  旧后端对未知路径可能回网页本身（不是 JSON，没有 HTTP 错误状态），也按「没有接口」处理。只有明确的错误状态才算读取失败。 */
export function contextUnavailable(e: unknown) {
  const status = (e as { status?: number })?.status;
  return !status || status === 404 || status === 405 || status === 501;
}

/** 卡片标的来源：全剧共享 / 只在本集。 */
export const ownerLabel = (owner: AssetOwner | undefined) => !owner ? '' : owner.type === 'series' ? '全剧' : '只在本集';
