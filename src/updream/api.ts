import type {UpdreamCounts, UpdreamRequest, UpdreamTaskList} from './types';

export const UPDREAM_API = '/updream/tasks';
/** 打开 Updream 面板（例如从生成视频页的轻入口）。宿主不需要额外接线。 */
export const UPDREAM_OPEN_EVENT = 'shiguang-updream-open';
export const openUpdreamTasks = (view: 'recent' | 'history' = 'history') => window.dispatchEvent(new CustomEvent(UPDREAM_OPEN_EVENT, {detail: {view}}));

export function readUpdreamTasks(request: UpdreamRequest, view: 'recent' | 'history', cursor?: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({view});
  if (cursor) query.set('cursor', cursor);
  return request<UpdreamTaskList>(`${UPDREAM_API}?${query}`, undefined, 'GET', {signal});
}

/** 只记本机展示偏好；带 version，后台已经有新版本时服务端应忽略，下次照样提醒。 */
export function markUpdreamRead(request: UpdreamRequest, items: {taskId: string; version: string}[]) {
  return request<{counts: UpdreamCounts}>(`${UPDREAM_API}/read`, {items}, 'POST');
}
