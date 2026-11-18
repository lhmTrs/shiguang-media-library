// STORYBOARD-CHANGE-LOG v1 前端接口（后端冻结合同：contracts/20261116-210018-STORYBOARD-CHANGE-LOG-v1/BACKEND-FROZEN-v1.md）
import type { StoryboardTransport } from './transport';

export type ReasonCategory = 'shot_feel' | 'miscommunication' | 'prompt_wrong';
export const CATEGORY_LABEL: Record<ReasonCategory, string> = {shot_feel: '追求镜头感', miscommunication: '沟通失误', prompt_wrong: '提示词不对'};
export const AUTHOR_LABEL: Record<string, string> = {user: '你', agent: 'Codex', import: '导入', generation: 'Codex 生成', restore: '恢复', baseline: '启用前版本'};
export type VersionMeta = {version: number; created_at: number | string; author_kind: string; reason_category: ReasonCategory | null; reason_text: string; reason_missing?: boolean; summary_only: boolean; changed_shot_count: number; restored_from: number | null; full_available: boolean; baseline?: boolean; byte_size?: number; content_shot_count?: number};
export type VersionList = {document_id: string; current_revision: number; total: number; storage: {bytes: number; record_bytes: number; kept_full: number; limit: number; physical_bytes: null}; items: VersionMeta[]};
export type SegmentEvent = {type: 'add' | 'remove' | 'move_start' | 'overwrite' | 'mode'; segment_id?: string; name?: string; before?: Any; after?: Any; previous_name?: string; merged_into?: {id?: string; name?: string} | null};
type Any = any; // 段事件的改前改后结构见 STORYBOARD-SEGMENTS 合同
export type Change = {target_kind: 'shot' | 'scene' | 'document' | 'segment'; segment_event?: SegmentEvent; target_id: string; shot_id: string | null; shot_number_at_time: number | null; field: string; before: unknown; after: unknown; deleted: boolean};
export type Diff = {document_id: string; from_version: number; to_version: number | 'current'; summary_only: boolean; changes: Change[]};
export type ChangeEvent = {version: number; created_at: number | string; author_kind: string; reason_category: ReasonCategory | null; reason_text: string; summary_only: boolean; fields: string[]};
export type PendingItem = {target_kind: 'shot' | 'scene' | 'document' | 'segment'; target_id: string; shot_id: string | null; shot_number: number | null; current_number: number | null; deleted: boolean; versions: number[]; fields: string[]; author_kind: string; reason_category: ReasonCategory | null; reason_text: string; before: unknown; after: unknown; summary_only: boolean; events: ChangeEvent[]};
export type PendingVersion = Omit<ChangeEvent, 'fields'> & {is_current: boolean; item_count: number; items: PendingItem[]};
export type PendingList = {document_id: string; current_revision: number; pending_count: number; pending_document_count: number; items: PendingItem[]; pending_versions: PendingVersion[]};
export type NoiseChange = {target_kind: PendingItem['target_kind']; target_id: string; shot_id: string | null; shot_number: number | null; field: string; before?: unknown; after?: unknown};
export type VersionChanges = VersionMeta & {document_id: string; current_revision: number; detail: 'full' | 'rebuilt' | 'summary'; items: PendingItem[]; noise: NoiseChange[]};
export type PendingTarget = {shot_ids: string[]} | {target_ids: string[]} | {all: true};
export const PENDING_REVISION_CHANGED = 'PENDING_REVISION_CHANGED';
export class HistoryError extends Error { constructor(message: string, readonly code: string, readonly status: number, readonly data: unknown) { super(message); } }

export function historyApi(transport: StoryboardTransport, projectId: string, token: () => string) {
  const base = '/api/projects/' + encodeURIComponent(projectId);
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const write = init.method && init.method !== 'GET';
    const res = await transport.request(base + path, write ? {...init, headers: {'Content-Type': 'application/json', 'X-Local-Token': token()}} : init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new HistoryError(data.message || data.error || (res.status === 503 ? '改动记录还没有启用（数据库需要先迁移）' : '读取失败'), data.code || '', res.status, data);
    return data as T;
  };
  return {
    versions: (offset = 0, limit = 20) => call<VersionList>(`/versions?offset=${offset}&limit=${limit}`),
    version: (v: number) => call<VersionMeta & {document_id: string; project: unknown}>(`/versions/${v}`),
    diff: (v: number, against: number | 'current' = 'current') => call<Diff>(`/versions/${v}/diff?against=${against}`),
    versionChanges: (v: number) => call<VersionChanges>(`/versions/${v}/changes`),
    pending: () => call<PendingList>('/pending'),
    clearPending: (throughVersion: number, target: PendingTarget, scope: {version?: number; expected_revision?: number} = {}) => call<{cleared_events: number; skipped_shot_ids: string[]; current_revision: number; pending_count: number; pending_document_count: number}>('/pending/clear', {method: 'POST', body: JSON.stringify({through_version: throughVersion, ...target, ...scope})}),
    setCategory: (v: number, category: ReasonCategory, expected: ReasonCategory | null) => call<unknown>(`/versions/${v}/category`, {method: 'PATCH', body: JSON.stringify({reason_category: category, expected_reason_category: expected})}),
    restore: (v: number, expectedRevision: number) => call<{revision?: number; version?: number}>(`/versions/${v}/restore`, {method: 'POST', body: JSON.stringify({expected_revision: expectedRevision, request_id: crypto.randomUUID()})}),
  };
}
export type HistoryApi = ReturnType<typeof historyApi>;
export const MIGRATION_REQUIRED = 'STORYBOARD_HISTORY_MIGRATION_REQUIRED';
export const when = (v: number | string) => { const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v); const today = new Date(); const t = d.toLocaleTimeString('zh-CN', {hour12: false, hour: '2-digit', minute: '2-digit'}); return d.toDateString() === today.toDateString() ? `今天 ${t}` : `${d.getMonth() + 1}月${d.getDate()}日 ${t}`; };
export const kb = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
export const show = (v: unknown) => v === null || v === undefined || v === '' ? '（空）' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v);
