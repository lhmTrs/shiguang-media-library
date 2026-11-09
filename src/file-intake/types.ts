export type IntakeRequest = <T = unknown>(url: string, body?: unknown, method?: string, options?: {signal?: AbortSignal}) => Promise<T>;
export type IntakeCompletion = {id: string; updatedAt: number; projectName: string; status: 'completed' | 'partial'; completed: number; failed: number; retained: number};
export type IntakeStatus = {supported: boolean; installed: boolean; canTrash: boolean; activeCount: number; needsAttention: number; latestCompletion: IntakeCompletion | null};
export type IntakeFile = {id: string; name: string; bytes: number; path: string};
export type Handoff = {id: string; files: IntakeFile[]; projects: {id: string; name: string}[]; canTrash: boolean; batchId?: string};
export type IntakeFolder = {id: string; name: string; relativePath: string};
export type Candidate = {id: string; name: string; reason: string; adoptedShots: {id: string; number: number | string}[]; mediaUrl: string};
export type IntakeItem = {
  id: string; name: string; bytes: number; copiedBytes: number;
  status: 'queued' | 'copying' | 'duplicate' | 'ready' | 'source_retained' | 'failed' | 'cancelled' | 'unknown' | 'managed';
  error?: string; code?: string; videoId?: string; managedProjectId?: string; managedProjectName?: string;
  assetId?: string; adoptionStamp?: string; candidates?: Candidate[];
};
export type IntakeBatch = {
  id: string; projectId: string; projectName: string; folderId: string; folderName: string; mode: 'copy' | 'move';
  createdAt: number | string; updatedAt: number | string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'partial' | 'interrupted'; items: IntakeItem[];
};
export type ConfirmInput = {requestId: string; projectId: string; folderId: string; mode: 'copy' | 'move'; fileIds: string[]};
export type ResolveInput = {choice: 'import' | 'reuse' | 'overwrite' | 'cancel'; candidateId?: string; confirmUnbind?: true; adoptionStamp?: string; applyRemaining?: true};
export type IntakeView = (projectId: string, videoId?: string) => void | Promise<void>;
export const INTAKE_API = '/file-intake';
export const errorMessage = (error: unknown) => {
  const e = error as {message?: string; code?: string};
  return (e?.code ? e.code + ' · ' : '') + (e?.message || '请求未完成，请检查本机服务');
};
export function knownRefusal(error: unknown, requestId?: string) {
  const e = error as {status?: number; accepted?: boolean; requestId?: string};
  return e?.accepted === false && (!requestId || e.requestId === requestId)
    || [400, 401, 403, 413, 415, 422, 423, 429].includes(e?.status || 0);
}
export function bytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return '大小未知';
  const unit = Math.min(3, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return (value / 1024 ** unit).toFixed(unit > 1 ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB'][unit];
}
export const itemLabel: Record<IntakeItem['status'], string> = {
  queued: '等待处理', copying: '正在复制', duplicate: '等待重名处理', ready: '视频已收纳',
  source_retained: '已收纳，原文件未移除', failed: '收纳失败', cancelled: '已取消', unknown: '结果待核对', managed: '已经在素材库',
};
export const batchLabel: Record<IntakeBatch['status'], string> = {queued: '排队中', running: '处理中', waiting: '等待选择', completed: '处理完成', partial: '部分完成', interrupted: '已中断，待核对'};
export const encoded = (id: string) => encodeURIComponent(id);

export function sameTarget(batch: IntakeBatch, input: ConfirmInput) {
  const requested = new Set(input.fileIds), received = new Set(batch.items.map(item => item.id));
  return batch.id === input.requestId && batch.projectId === input.projectId && batch.folderId === input.folderId && batch.mode === input.mode
    && requested.size === input.fileIds.length && received.size === batch.items.length && requested.size === received.size
    && [...requested].every(id => received.has(id));
}
