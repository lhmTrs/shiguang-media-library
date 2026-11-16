// UPDREAM-PROGRESS-V1：本机 Updream 跟进任务（只读展示）。
// 后端合同：to_claude/20261116-140133-UPDREAM-PROGRESS-V1-后端ACK与API合同.md（schemaVersion 1）。
// Api* 是接口原样字段；UpdreamTask 是组件内部用的模型，由 api.ts 一次映射。

// ---- 接口原样 ----
export type ApiPhase = 'generating' | 'downloading' | 'validating' | 'waiting_import' | 'importing' | 'imported' | 'needs_review' | 'failed' | 'cancelled';
export type ApiIdentity = 'unconfirmed' | 'recorded' | 'current' | 'other_library';
export type ApiTask = {
  id: string; name: string; eventVersion: string; phase: ApiPhase | string; active: boolean;
  attention: null | {code?: string; message?: string}; unread: boolean;
  createdAt: number | null; upstreamUpdatedAt: number | null; localRecordUpdatedAt: number | null;
  progress: null | {percent: number};
  target: {projectId: string | null; projectName: string | null; folderLabel: string | null; folderId: string | null; identity: ApiIdentity | string};
  delivery: null | {verification: string; projectId: string; folderId: string; videoId: string; canView: boolean};
  notification: {state: string}; recordUrl?: string;
  /** 兼容只读字段：只来自原持久证据的最后完成阶段；本机记录两分钟没变化（不是平台失败）。 */
  lastCompletedPhase?: ApiPhase | string | null;
  stale?: null | {since?: number | null; reason?: string | null};
};
export type ApiList = {
  schemaVersion: number; readAt: number;
  queue: {state: 'ready' | 'absent' | 'degraded' | 'unavailable' | string; reason: string | null; truncated: boolean; invalidCount: number};
  preferences: {state: 'ready' | 'unavailable' | string};
  summary: {activeCount: number; unreadCount: number; attentionCount: number; showEntry: boolean};
  total: number; offset: number; limit: number; tasks: ApiTask[];
};
export type ApiReadResult = {schemaVersion: number; readAt: number; marked: string[]; skipped: string[]};

// ---- 组件内部模型 ----
export const UPDREAM_STAGES = ['generate', 'download', 'verify', 'await-import', 'import', 'imported'] as const;
export type UpdreamStage = typeof UPDREAM_STAGES[number] | 'unknown';
/** running 进行中；done 已入库；failed 失败；review 待核对（记录不完整/不确定，不当成失败或完成）；cancelled 已取消（不是在本页面取消的）。 */
export type UpdreamStatus = 'running' | 'done' | 'failed' | 'review' | 'cancelled';
export type UpdreamTarget = {projectId: string | null; projectName: string | null; folderId: string | null; folderLabel: string | null; identity: ApiIdentity | 'unknown'};
export type UpdreamTask = {
  taskId: string; version: string; name: string;
  stage: UpdreamStage; status: UpdreamStatus; active: boolean;
  attention: {code?: string; message?: string} | null;
  progress: number | null;
  createdAt: number | null; upstreamUpdatedAt: number | null; localRecordUpdatedAt: number | null;
  target: UpdreamTarget;
  delivery: {projectId: string; folderId: string; videoId: string; canView: boolean} | null;
  notification: string;
  unread: boolean;
  lastCompleted: UpdreamStage | null;
  stale: {since: number | null; reason: string | null} | null;
};
export type UpdreamSummary = {active: number; unread: number; attention: number; showEntry: boolean};
export type UpdreamTaskList = {
  readAt: number;
  queue: {state: string; reason: string | null; truncated: boolean; invalidCount: number};
  preferences: string;
  summary: UpdreamSummary;
  total: number; offset: number; limit: number;
  tasks: UpdreamTask[];
};
export type UpdreamView = (projectId: string, videoId?: string) => void | Promise<void>;
export type UpdreamRequest = {<T = unknown>(url: string, body?: unknown, method?: string, options?: {signal?: AbortSignal}): Promise<T>};

export const STAGE_LABEL: Record<UpdreamStage, string> = {generate: '生成', download: '下载', verify: '校验', 'await-import': '等待入库', import: '导入', imported: '已入库', unknown: '待核对'};
/** 需要人看一眼的：失败、待核对，或后端标了 attention 的。 */
export const needsAttention = (t: UpdreamTask) => t.status === 'failed' || t.status === 'review' || !!t.attention;
export const isFinished = (t: UpdreamTask) => !t.active && (t.status === 'done' || t.status === 'cancelled') && !t.attention;
