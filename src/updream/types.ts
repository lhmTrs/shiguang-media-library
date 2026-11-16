// UPDREAM-PROGRESS-V1：前端看到的本机 Updream 跟进任务（只读展示）。
// 字段以后端合同为准；这里是前端提出的形状，合同冻结后按实际字段对齐。
export const UPDREAM_STAGES = ['generate', 'download', 'verify', 'await-import', 'import', 'imported'] as const;
export type UpdreamStage = typeof UPDREAM_STAGES[number] | 'unknown';
export type UpdreamStageState = 'running' | 'done' | 'failed' | 'unknown';
export type UpdreamTarget = {projectId?: string; projectName?: string; folderId?: string; folderLabel?: string; state: 'verified' | 'unverified' | 'unknown'};
export type UpdreamVideo = {projectId: string; videoId: string; name: string};
export type UpdreamNotification = {state: 'sent' | 'failed' | 'pending' | 'none' | 'unknown'; at?: number | null};
export type UpdreamTask = {
  taskId: string;
  version: string;
  name: string;
  createdAt?: number | null;
  target: UpdreamTarget;
  stage: UpdreamStage;
  stageState: UpdreamStageState;
  lastCompletedStage?: UpdreamStage | null;
  upstreamUpdatedAt?: number | null;
  stale?: {since?: number | null; reason?: string} | null;
  error?: {code?: string; message?: string} | null;
  result?: {videos: UpdreamVideo[]} | null;
  notification?: UpdreamNotification | null;
  unread?: boolean;
  alsoInFileTasks?: {jobId: string} | null;
};
export type UpdreamSource = {state: 'ok' | 'none' | 'unreadable' | 'partial'; message?: string};
export type UpdreamCounts = {active: number; attention: number; unread: number};
export type UpdreamTaskList = {observedAt: number; source: UpdreamSource; counts: UpdreamCounts; tasks: UpdreamTask[]; nextCursor?: string | null};
export type UpdreamView = (projectId: string, videoId?: string) => void | Promise<void>;
export type UpdreamRequest = {<T = unknown>(url: string, body?: unknown, method?: string, options?: {signal?: AbortSignal}): Promise<T>};

export const STAGE_LABEL: Record<UpdreamStage, string> = {generate: '生成', download: '下载', verify: '校验', 'await-import': '等待入库', import: '导入', imported: '已入库', unknown: '待核对'};

/** 进行中 = 还没到终点、也没失败，且阶段已知。阶段未知的单独算「待核对」，不当成进行中、失败或完成。 */
export const isActive = (t: UpdreamTask) => t.stage !== 'unknown' && t.stage !== 'imported' && t.stageState !== 'failed' && t.stageState !== 'unknown';
export const isFailed = (t: UpdreamTask) => t.stageState === 'failed';
export const isImported = (t: UpdreamTask) => t.stage === 'imported' && t.stageState === 'done' && !!t.result?.videos?.length;
export const isUncertain = (t: UpdreamTask) => !isActive(t) && !isFailed(t) && !isImported(t);
