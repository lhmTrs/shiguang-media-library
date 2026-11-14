// 合并同名人物（合同 v1 · B，草案 B0–B3 + 定稿替换条款）。形状来自 Codex 的后端合同；令牌只原样回传，不解析。
// 接口按 Codex 联调最终约定放在剧的路由下：/api/project-series/:series_id/character-merge*（合同草案写的是 scopes/series，以 ACK 为准）。
// 新建撞名检查仍是 /api/project-assets/scopes/:type/:id/names/check。
import { outcomeUnknown } from './scoped';

export type EpisodeLabel = { project_id: string; project_name: string; episode_no: number | null; season_id: string | null; season_no: number | null; season_label?: string | null };
export type MergeRefs = { shots: number; manifests: number; manifest_entries: number };
export type MergeMember = {
  asset_id: string; asset_revision: number; owner_type: 'series' | 'project'; owner_id: string; episode: EpisodeLabel | null;
  look_count: number; image_count: number; scored_dimensions: number; default_look_id: string | null;
  references?: Partial<MergeRefs>; base_info_excerpt?: string | null; performance_info_excerpt?: string | null;
  /** 组里有全剧共享人物时，只有它为 true：主体必须是它（定稿）。 */
  primary_locked?: boolean;
};
export type MergeGroup = { group_id: string; name: string; members: MergeMember[]; references: Partial<MergeRefs> & { shots?: number } };
export type MergeGroups = {
  series_id: string; alignment_status?: 'standalone' | 'pending' | 'aligned';
  summary: { group_count: number; referenced_shot_count: number; manifest_count?: number };
  items: MergeGroup[]; next_cursor: string | null;
  /** 打开该组时用的全剧上下文凭证（与 Codex 约定，见 B 前端凭证与接线）。 */
  context_token?: string;
};

export type LookChoice = { conflict_id: string; action: 'keep_both'; rename_to: string } | { conflict_id: string; action: 'merge_into'; target_look_id: string };
export type MergeChoices = { look_choices: LookChoice[] };
export type LookPlanItem = { source_asset_id: string; source_look_id: string; result_look_id: string; result_name: string; action: 'keep' | 'rename' | 'merge_into'; image_count: number };
export type LookConflict = { conflict_id: string; source_look_id: string; allowed_targets: string[]; suggested_name: string; default_choice: LookChoice; affected_shots: number };
export type ScoreEntry = { dimension_id: string; value: number | null; source: 'manual' | 'ai'; reason: string | null; updated_at: number };
export type ScorePlan = {
  series_base: { source_asset_id: string; entries: ScoreEntry[] };
  episode_overrides: { project_id: string; source_asset_id: string; entries: ScoreEntry[]; manual_count: number; ai_count: number; clear_count: number }[];
  existing_overrides_preserved?: number | unknown[];
  override_conflicts?: { project_id: string; dimension_id: string; kept_source_asset_id: string; previous_override_archived: boolean }[];
};
export type DefaultLookPlanItem = { project_id: string; source_asset_id: string; old_look_id: string | null; result_look_id: string | null; mode: 'set' | 'inherit' | 'explicit_empty'; image_overrides?: unknown[] };
export type ReferencePlan = MergeRefs & { by_episode: (MergeRefs & { project_id: string; look_resolutions?: unknown })[]; writes_storyboards: false };
export type TextPlan = { base_source_asset_id: string; other_sources: { source_asset_id: string; project_id: string | null; base_info: string | null; performance_info: string | null }[] };
export type MergeBlocker = { code: string; message?: string; error?: string };
export type MergePreview = {
  ready: boolean; preview_token: string | null; group_id: string; primary_asset_id: string; members: MergeMember[]; choices: MergeChoices;
  look_plan: { items: LookPlanItem[]; conflicts: LookConflict[] }; score_plan: ScorePlan; default_look_plan: DefaultLookPlanItem[];
  reference_plan: ReferencePlan; text_plan?: TextPlan; blockers: MergeBlocker[];
};
export type MergeReceipt = {
  request_id: string; merge_id: string; status: 'merged'; series_id: string; group_id: string; canonical_asset_id: string;
  alias_count: number; merged_look_count: number; references: Partial<MergeRefs> & { shots?: number }; history_id: string; can_undo: boolean;
  remaining_group_count: number; next_group_id: string | null;
};
export type UndoChange = { entity: string; entity_id: string; project_id?: string | null; kind: string; action: 'preserve' | 'restore_with_confirmation' | 'block' };
export type UndoPreview = { ready: boolean; undo_token: string | null; merge_id: string; status: 'clean' | 'review_required' | 'blocked' | 'undone'; changes: UndoChange[]; blockers: MergeBlocker[]; impact?: unknown };
export type UndoReceipt = { request_id: string; merge_id: string; status: 'undone'; restored_asset_ids: string[]; history_id: string };
/** 人物版本列表里的合并记录项（合同 B3「来源与版本」）。 */
export type MergeVersion = { kind: 'character_merge' | 'character_merge_undo'; merge_id: string; request_id?: string; at: number; can_undo?: boolean; summary?: string };
/** 新建撞名检查附带的同名人物信息（合同 B0）。 */
export type RelatedCharacters = { group_id: string | null; items: MergeMember[]; action: 'none' | 'merge' | 'promote'; promotion_project_id?: string };

/** 宿主的原始请求（不带 /project-assets 前缀），路径相对 /api。 */
type Api = <T>(url: string, body?: unknown, method?: string) => Promise<T>;
export function mergeApi(api: Api, seriesId: string) {
  const base = '/project-series/' + encodeURIComponent(seriesId);
  return {
    groups: (cursor?: string | null) => api<MergeGroups>(base + '/character-merge-groups?' + new URLSearchParams({ limit: '50', ...(cursor ? { cursor } : {}) })),
    preview: (body: { group_id: string; primary_asset_id: string; context_token?: string; choices?: MergeChoices }) => api<MergePreview>(base + '/character-merges/preview', body, 'POST'),
    confirm: (body: MergeConfirmBody) => api<MergeReceipt>(base + '/character-merges/confirm', body, 'POST'),
    request: (id: string) => api<{ found: boolean; result?: MergeReceipt | UndoReceipt }>(base + '/character-merge-requests/' + encodeURIComponent(id)),
    undoPreview: (mergeId: string, contextToken?: string) => api<UndoPreview>(base + '/character-merges/' + encodeURIComponent(mergeId) + '/undo-preview', { context_token: contextToken }, 'POST'),
    undo: (mergeId: string, body: UndoBody) => api<UndoReceipt>(base + '/character-merges/' + encodeURIComponent(mergeId) + '/undo', body, 'POST'),
  };
}
export type MergeApi = ReturnType<typeof mergeApi>;
export type MergeConfirmBody = { request_id: string; preview_token: string; context_token?: string; choices: MergeChoices };
export type UndoBody = { request_id: string; context_token?: string; undo_token: string; accept_restore_changes: boolean };

export const lostOutcome = () => Object.assign(Error('网络中断，暂时确认不了这次有没有完成。原请求已保留：点「核对上次结果」只按原请求号查询，不会自己重新提交。'), { code: 'OUTCOME_UNKNOWN' });
/**
 * 已发出、结果不明的写请求：先按原请求号查回执；查到就用原结果，确定没有才用原编号、原内容重发。
 * 查询失败、或重发的回应又丢了，都仍是「结果不明」——调用方保留原请求并锁定，绝不换新编号（A 的 R2 教训）。
 */
/** 后端持久化的拒绝终态（收口标准）：GET 原编号查到 status:"rejected"，或 4xx 带 details.request_settled:true。 */
export type RejectedReceipt = { request_id: string; status: 'rejected'; code: string; message?: string; details?: unknown };
export const isRejected = (r: unknown, requestId: string): r is RejectedReceipt => (r as RejectedReceipt)?.status === 'rejected' && (r as RejectedReceipt).request_id === requestId;
export const settledRejection = (e: unknown) => (e as { details?: { request_settled?: boolean } })?.details?.request_settled === true;
export const NOT_FOUND_NOTE = (what: string) => '暂未查到这次' + what + '的结果，原请求仍可能完成。可以稍后再核对；也可以按原内容重新提交（同一请求号，服务端只会执行一次）。';
/** 只读核对已发出的原请求（组合验收复验 R3）：查到回执返回它，查无回执返回 null，绝不自动重发；查询本身失败仍算结果不明。 */
export async function lookupOnly<T>(lookup: () => Promise<{ found: boolean; result?: unknown }>): Promise<T | null> {
  try { const r = await lookup(); return r.found && r.result ? r.result as T : null; }
  catch (e) { if (outcomeUnknown(e)) throw lostOutcome(); throw e; }
}
export async function settleRequest<T>(lookup: () => Promise<{ found: boolean; result?: unknown }>, resend: () => Promise<T>): Promise<T> {
  let r: { found: boolean; result?: unknown };
  try { r = await lookup(); } catch (e) { if (outcomeUnknown(e)) throw lostOutcome(); throw e; }
  if (r.found && r.result) return r.result as T;
  try { return await resend(); } catch (e) { if (outcomeUnknown(e)) throw lostOutcome(); throw e; }
}

export const mergeErrorText: Record<string, string> = {
  ATTRIBUTE_ALIGNMENT_REQUIRED: '这部剧的人物属性维度还没统一：请先在全剧视图点「查看并统一」，再合并同名人物',
  CHARACTER_MERGE_STALE: '这几个人物刚在别处改过（或归属变了），已按最新情况重新核对，请再看一遍再确认',
  CHARACTER_MERGE_CHOICE_INVALID: '同名造型的选择已经不适用，已恢复成默认处理，请再核对一遍',
  CHARACTER_MERGE_PRIMARY_REQUIRED: '这一组里有全剧共享的人物，只能以它为主体',
  CHARACTER_MERGE_UNDO_STALE: '合并后的资料刚又变了，已重新核对撤销会恢复的内容，请再确认',
  CHARACTER_MERGE_UNDO_BLOCKED: '现在有新的引用或依赖，暂时不能完整撤销，详见下方列出的原因',
  REQUEST_ID_CONFLICT: '这个请求编号已用于别的内容，没有执行。请关掉窗口重新打开再试',
  ASSET_MERGED: '这个人物已经合并到另一个人物里了，请打开合并后的那一个',
  STORYBOARD_GENERATION_LOCKED: '这部剧正在生成分镜，暂时不能合并或撤销，等生成结束再试',
  // 撤销预览的阻断原因（后端返工 527fe74）
  CHARACTER_MERGE_NAME_CONFLICT: '撤销后会出现同名人物（全剧和某一集各有一个同名的）：先把其中一个改名，再回来撤销',
  CHARACTER_MERGE_DEPENDENCY: '合并之后又有别的合并依赖它，暂时不能单独撤销这一次',
  CHARACTER_MERGE_SCOPE_CHANGED: '这部剧的成员或人物属性维度在合并后变了，暂时不能完整撤销',
};
export const mergeErr = (e: unknown, fallback: string) => {
  const err = e as { code?: string; status?: number; message?: string };
  if (err?.status === 423 && !mergeErrorText[err.code ?? '']) return mergeErrorText.STORYBOARD_GENERATION_LOCKED;
  // 没有状态码：网络断开或连不上本机服务。浏览器原话（如 Failed to fetch）对用户没意义
  if (!err?.status && !err?.code) return '网络中断，没有连上本机服务';
  return (err?.code && mergeErrorText[err.code]) || err?.message || fallback;
};

/** 「第 3 集」或（各成员跨季时）「第 2 季第 3 集」；全剧共享人物叫「全剧」。 */
export function memberPlace(m: Pick<MergeMember, 'owner_type' | 'episode'>, withSeason = false) {
  if (m.owner_type === 'series' || !m.episode) return '全剧';
  const ep = m.episode, n = ep.episode_no != null ? `第 ${ep.episode_no} 集` : ep.project_name;
  return withSeason && ep.season_no != null ? `第 ${ep.season_no} 季${n}` : n;
}
export const spansSeasons = (members: MergeMember[]) => new Set(members.filter(m => m.episode).map(m => m.episode!.season_id ?? '')).size > 1;
export const memberLabel = (m: MergeMember, name: string, withSeason = false) => memberPlace(m, withSeason) + '的「' + name + '」';
/** 一组成员的位置：跨季时都带季号；只有一份（提升指引）时有季号就带上，免得多季时指不准是哪一季。 */
export const memberPlaces = (members: MergeMember[]) => { const withSeason = members.length === 1 || spansSeasons(members); return members.map(m => memberPlace(m, withSeason)); };
export const refShots = (r?: Partial<MergeRefs> | null) => r?.shots ?? 0;
/** 卡片提示：对某个人物，列出同组其他几份所在的位置。 */
export function siblingHint(group: MergeGroup, assetId: string) {
  const others = group.members.filter(m => m.asset_id !== assetId), seasons = spansSeasons(group.members);
  if (!others.length) return '';
  const places = others.map(m => memberPlace(m, seasons));
  return (places.length > 2 ? places.slice(0, 2).join('、') + ' 等 ' + places.length + ' 处' : places.join('、')) + '也有一个「' + group.name + '」';
}

/**
 * 结果不明的合并 / 撤销原请求：存在浮窗之外（组合验收 R1）。关浮窗、切项目再回来都还在，
 * 再打开时继续按原剧、原编号、原内容核对；未落定前不发起新的合并。
 * 写入 localStorage，同一浏览器的各标签页共享（收口标准：待核对期间这部剧只读，多开标签页也一样），
 * 其他标签页改动经 storage 事件同步；存储不可用时只用内存（仅保证当前标签页）。
 */
/** libraryId = 本机服务的资料库实例身份（/api/session 的 instanceId）：同源换库时互不套用（收口验收 R3）。 */
export type PendingMerge = { libraryId: string; seriesId: string; group: MergeGroup; body: MergeConfirmBody };
export type PendingUndo = { libraryId: string; seriesId: string; mergeId: string; name: string; body: UndoBody };
const PENDING_KEY = 'shiguang.characterMerge.pending.v3';
let libraryIdPromise: Promise<string> | null = null;
/** 读当前资料库身份（只读，不换发会话）；失败时下次再读。 */
export function readLibraryId(): Promise<string> {
  libraryIdPromise ??= fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' }).then(r => r.json()).then(j => { if (typeof j?.instanceId !== 'string' || !j.instanceId) throw Error('资料库身份未知'); return j.instanceId as string; });
  return libraryIdPromise.catch(e => { libraryIdPromise = null; throw e; });
}
const readPending = (): { merges: PendingMerge[]; undos: PendingUndo[] } => {
  try { const v = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); if (v && Array.isArray(v.merges) && Array.isArray(v.undos)) return v; } catch { /* 无存储时只用内存 */ }
  return { merges: [], undos: [] };
};
let pendingMem = readPending();
const pendingListeners = new Set<() => void>();
/** 待核对记录变了就通知（页面上的「上次操作还没核对」提示条据此显示或消失）。 */
export const subscribePending = (fn: () => void) => { pendingListeners.add(fn); return () => { pendingListeners.delete(fn); }; };
const savePending = () => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(pendingMem)); } catch { /* 无存储时只用内存 */ } pendingListeners.forEach(fn => fn()); };
// 其他标签页登记或解除了待核对：读回最新状态并通知页面
try { window.addEventListener('storage', e => { if (e.key === PENDING_KEY) { pendingMem = readPending(); pendingListeners.forEach(fn => fn()); } }); } catch { /* 非浏览器环境 */ }
/** 所有查找都按（资料库身份, 剧）：换到另一个资料库时不套用，旧库的记录保留，回去后照常核对。 */
export const pendingStore = {
  merge: (lib: string, seriesId: string) => lib ? pendingMem.merges.find(p => p.libraryId === lib && p.seriesId === seriesId) ?? null : null,
  setMerge(lib: string, seriesId: string, p: PendingMerge | null) { pendingMem.merges = pendingMem.merges.filter(x => !(x.libraryId === lib && x.seriesId === seriesId)); if (p) pendingMem.merges.push(p); savePending(); },
  undo: (lib: string, seriesId: string, mergeId: string) => lib ? pendingMem.undos.find(p => p.libraryId === lib && p.seriesId === seriesId && p.mergeId === mergeId) ?? null : null,
  undosOf: (lib: string, seriesId: string) => lib ? pendingMem.undos.filter(p => p.libraryId === lib && p.seriesId === seriesId) : [],
  setUndo(lib: string, seriesId: string, mergeId: string, p: PendingUndo | null) { pendingMem.undos = pendingMem.undos.filter(x => !(x.libraryId === lib && x.seriesId === seriesId && x.mergeId === mergeId)); if (p) pendingMem.undos.push(p); savePending(); },
};
