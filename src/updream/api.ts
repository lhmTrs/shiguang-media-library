import type {ApiDiagnostics, ApiList, ApiReadResult, ApiTask, UpdreamDiagnostics, UpdreamRequest, UpdreamStage, UpdreamStatus, UpdreamTask, UpdreamTaskList} from './types';

export const UPDREAM_API = '/updream-progress';
/** 打开 Updream 面板（例如从生成视频页的轻入口）。宿主不需要额外接线。 */
export const UPDREAM_OPEN_EVENT = 'shiguang-updream-open';
export const openUpdreamTasks = (view: 'recent' | 'history' = 'history') => window.dispatchEvent(new CustomEvent(UPDREAM_OPEN_EVENT, {detail: {view}}));

const PHASE: Record<string, [UpdreamStage, UpdreamStatus]> = {
  generating: ['generate', 'running'], downloading: ['download', 'running'], validating: ['verify', 'running'],
  waiting_import: ['await-import', 'running'], importing: ['import', 'running'], imported: ['imported', 'done'],
  failed: ['unknown', 'failed'], cancelled: ['unknown', 'cancelled'], needs_review: ['unknown', 'review'],
};
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null;
const str = (v: unknown) => typeof v === 'string' && v ? v : null;

/** 接口任务 → 组件模型。未知 phase 一律「待核对」，不猜成失败或完成；只有 delivery.canView 才给查看视频。 */
export function toTask(t: ApiTask): UpdreamTask {
  const [stage, status] = PHASE[t.phase] ?? ['unknown', 'review'];
  const percent = num(t.progress?.percent);
  return {
    taskId: String(t.id), version: String(t.eventVersion), name: str(t.name) ?? '未命名任务',
    stage, status, active: !!t.active && status === 'running',
    attention: t.attention && (t.attention.code || t.attention.message) ? {code: str(t.attention.code) ?? undefined, message: str(t.attention.message) ?? undefined} : null,
    progress: percent !== null && percent >= 0 && percent <= 100 ? percent : null,
    createdAt: num(t.createdAt), upstreamUpdatedAt: num(t.upstreamUpdatedAt), localRecordUpdatedAt: num(t.localRecordUpdatedAt),
    target: {projectId: str(t.target?.projectId), projectName: str(t.target?.projectName), folderId: str(t.target?.folderId), folderLabel: str(t.target?.folderLabel),
      identity: (['unconfirmed', 'recorded', 'current', 'other_library'] as const).find(v => v === t.target?.identity) ?? 'unknown'},
    delivery: t.delivery && str(t.delivery.projectId) && str(t.delivery.videoId) ? {projectId: t.delivery.projectId, folderId: t.delivery.folderId, videoId: t.delivery.videoId, canView: t.delivery.canView === true} : null,
    notification: str(t.notification?.state) ?? 'unknown',
    unread: !!t.unread,
    lastCompleted: t.lastCompletedPhase && PHASE[t.lastCompletedPhase] && PHASE[t.lastCompletedPhase][0] !== 'unknown' ? PHASE[t.lastCompletedPhase][0] : null,
    stale: t.stale ? {since: num(t.stale.since), reason: str(t.stale.reason)} : null,
  };
}
const count = (v: unknown) => { const n = num(v); return n !== null && n >= 0 ? Math.floor(n) : null; };
const counts = (v: unknown): Record<string, number> => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v as Record<string, unknown>).flatMap(([k, n]) => { const c = count(n); return c ? [[k, c]] : []; })) : {};
const time = (v: unknown) => num(v) ?? (typeof v === 'string' && v ? (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null) : null);
/** 诊断：只收认得出的字段；格式不对就当没有，不影响任务列表。 */
export function toDiagnostics(d: ApiDiagnostics | undefined | null): UpdreamDiagnostics | null {
  if (!d || typeof d !== 'object') return null;
  const items = Array.isArray(d.items) ? d.items.filter(i => i && str(i.id)).map(i => ({id: String(i.id), reason: str(i.reason) ?? 'unknown', legacyStatus: str(i.legacyStatus), registeredAt: time(i.registeredAt), name: str(i.name)})) : [];
  return {count: count(d.count) ?? items.length, byReason: counts(d.byReason), legacyStatus: counts(d.legacyStatus), items, truncated: !!d.truncated};
}
export function toList(d: ApiList): UpdreamTaskList {
  return {
    readAt: num(d.readAt) ?? Date.now(),
    queue: {state: str(d.queue?.state) ?? 'unavailable', reason: str(d.queue?.reason), truncated: !!d.queue?.truncated, invalidCount: num(d.queue?.invalidCount) ?? 0, warning: typeof d.queue?.warning === 'boolean' ? d.queue.warning : null},
    preferences: str(d.preferences?.state) ?? 'unavailable',
    summary: {active: num(d.summary?.activeCount) ?? 0, unread: num(d.summary?.unreadCount) ?? 0, attention: num(d.summary?.attentionCount) ?? 0, showEntry: !!d.summary?.showEntry,
      attentionUnread: count(d.summary?.attentionUnreadCount), doneUnread: count(d.summary?.doneUnreadCount), diagnostic: count(d.summary?.diagnosticCount)},
    total: num(d.total) ?? 0, offset: num(d.offset) ?? 0, limit: num(d.limit) ?? 0,
    tasks: Array.isArray(d.tasks) ? d.tasks.map(toTask) : [],
    diagnostics: toDiagnostics(d.diagnostics),
  };
}

export async function readUpdreamTasks(request: UpdreamRequest, scope: 'all' | 'history', offset = 0, signal?: AbortSignal, limit = 50) {
  const query = new URLSearchParams({scope, offset: String(offset), limit: String(limit)});
  return toList(await request<ApiList>(`${UPDREAM_API}?${query}`, undefined, 'GET', {signal}));
}

/** 最近视图要把全部本机登记任务读全（后端最多枚举 200 条），否则较早的进行中任务会落在第二页、分类和计数对不上。
 *  有界：每页 100 条，最多 MAX_PAGES 页；超过时 complete=false，页面会说明列表不全。 */
const MAX_PAGES = 4;
export async function readAllUpdreamTasks(request: UpdreamRequest): Promise<UpdreamTaskList & {complete: boolean}> {
  const first = await readUpdreamTasks(request, 'all', 0, undefined, 100);
  let tasks = first.tasks, pages = 1;
  while (tasks.length < first.total && pages < MAX_PAGES) {
    const next = await readUpdreamTasks(request, 'all', tasks.length, undefined, 100);
    if (!next.tasks.length) break;
    tasks = [...tasks, ...next.tasks.filter(t => !tasks.some(o => o.taskId === t.taskId))]; pages++;
  }
  return {...first, tasks, complete: tasks.length >= first.total};
}

/** 只记本机展示偏好；version 是 eventVersion 原值，后台已经有新版本时服务端会跳过，下次照样提醒。 */
export function markUpdreamRead(request: UpdreamRequest, items: {taskId: string; version: string}[]) {
  return request<ApiReadResult>(`${UPDREAM_API}/read`, {items: items.map(i => ({id: i.taskId, version: i.version}))}, 'POST');
}
