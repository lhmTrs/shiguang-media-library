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

/** 写请求结果不明：网络断开、响应读不出、网关超时。业务错误（4xx / 409 等）都有明确状态，不在此列。 */
export const outcomeUnknown = (e: unknown) => { const s = (e as { status?: number })?.status; return !s || s === 502 || s === 503 || s === 504; };
type Api = <T>(url: string, body?: unknown, method?: string) => Promise<T>;
/**
 * 作用域写入（合同 v1 的 request_id 幂等）：响应丢了不换新编号盲目重试。
 * 先按原 request_id 查 /scoped-requests/:id：查到就用服务端回执；明确没有记录时，用同一个编号、同一份内容重发一次
 * （服务端按编号去重，已提交过就直接回原回执）；还是确认不了，就报「结果未知」让用户刷新核对，不再自动重发。
 */
export async function scopedWrite<T>(api: Api, url: string, body: { request_id: string } & Record<string, unknown>, method?: string, receiptBase = ''): Promise<T> {
  try { return await api<T>(url, body, method); }
  catch (e) { if (!outcomeUnknown(e)) throw e; }
  const unknown = () => Object.assign(new Error('网络中断，暂时确认不了这次操作有没有保存。请稍后点「刷新列表」核对结果，确认没有生效再重做。'), { code: 'REQUEST_OUTCOME_UNKNOWN' });
  let receipt: { found: boolean; result?: T };
  try { receipt = await api<{ found: boolean; result?: T }>(receiptBase + '/scoped-requests/' + encodeURIComponent(body.request_id)); }
  catch (e) { if (outcomeUnknown(e)) throw unknown(); throw e; }
  if (receipt.found) return receipt.result as T;
  try { return await api<T>(url, body, method); }
  catch (e) { if (outcomeUnknown(e)) throw unknown(); throw e; }
}
