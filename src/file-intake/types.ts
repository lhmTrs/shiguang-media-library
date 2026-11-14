export type IntakeRequest = {<T = unknown>(url: string, body?: unknown, method?: string, options?: {signal?: AbortSignal}): Promise<T>; readonly libraryId?: string};
export type IntakeCompletion = {id: string; updatedAt: number; projectName: string; status: 'completed' | 'partial'; completed: number; failed: number; retained: number};
/** 访达入口安装任务（POST/GET /install/job，status.installJob）。时间为毫秒；previousKept 只在失败且核对过时为布尔值。 */
export type InstallStage = 'checking' | 'preparing-window' | 'writing' | 'done' | 'failed';
export type InstallJob = {id: string; stage: InstallStage; window: 'compiling' | 'skipped' | null; startedAt: number; finishedAt: number | null; message: string | null; error: {code: string; message: string} | null; previousKept: boolean | null};
export type IntakeStatus = {supported: boolean; installed: boolean; upgradeNeeded?: boolean; canTrash: boolean; activeCount: number; needsAttention: number; latestCompletion: IntakeCompletion | null; installJob?: InstallJob | null};
export type MediaKind = 'photo' | 'video' | 'music' | 'sfx';
export type ImageProposal = {projectId:string;characterId:string|null;characterRevision:number|null;lookId:string|null;lookRevision:number|null;newCharacter:boolean;newLook:boolean;characterName:string;lookName:string};
export type AssetKind = 'character' | 'scene' | 'prop';
export type IntakeDestination = {kind:MediaKind;scope:'library'|'project';projectId?:string;folderId?:string;directory?:string;fileName?:string;characterName?:string;lookName?:string;imageProposal?:ImageProposal;assetKind?:'scene'|'prop';assetId?:string;assetRevision?:number;
  /** 项目视频：点「收纳」时才在 folderId（父目录，'root' 为项目根目录）下新建这一层文件夹。 */
  newFolder?:{name:string}};
export type IntakeFile = {mediaKind?:'photo'|'video'|'audio';id: string; name: string; bytes: number; path: string; durationSec?: number | null};
export type NameMode = 'keep' | 'standard';
export type RoutingPreferences = {lastProjectId: {photo: string | null; video: string | null}; lastVideoFolderByProject: Record<string, string>; lastLibraryDirectory: Partial<Record<MediaKind, string>>; lastAudioKind: 'music' | 'sfx' | null; mode: 'copy' | 'move'; standardNames: boolean; revealWhenDone?: boolean};
export type RoutingLook = {id: string; name: string; revision: number};
export type RoutingAsset = {id: string; kind: AssetKind; name: string; revision: number; defaultLookId: string | null; looks: RoutingLook[]};
/** 剧集位置，只用于显示去处；未归剧的项目没有这一项。 */
export type RoutingSeries = {id: string; name: string; seasonNo: number | null; seasonLabel: string | null; episodeNo: number};
export type RoutingProject = {id: string; name: string; videoFolders: IntakeFolder[]; assets: RoutingAsset[]; series?: RoutingSeries};
export type RoutingOptions = {projects: RoutingProject[]; photoCategories: IntakeFolder[]};
export type NamePartRole = 'series' | 'season' | 'episode' | 'project' | 'folder' | 'number' | 'ext';
export type NamePart = {role: NamePartRole; text: string};
export type NamePreviewItem = {fileId: string; proposedFileName: string | null; proposedNumber: number | null; nameParts?: NamePart[]; error?: {code: string; message: string}};
export type Handoff = {id: string; files: IntakeFile[]; projects: {id: string; name: string}[]; canTrash: boolean; batchId?: string; preparation?: 'checking' | 'ready' | 'failed'; preparationError?: string; preferences?:Partial<Record<MediaKind,IntakeDestination>>; routingPreferences?: RoutingPreferences; themeId?: string | null};
export type IntakeFolder = {id: string; name: string; relativePath: string};
export type Candidate = {id: string; name: string; reason: string; adoptedShots: {id: string; number: number | string}[]; mediaUrl: string; canOverwrite?:boolean};
export type IntakeItem = {
  id: string; name: string; bytes: number; copiedBytes: number;
  status: 'queued' | 'copying' | 'duplicate' | 'ready' | 'source_retained' | 'failed' | 'cancelled' | 'unknown' | 'managed';
  destination?:IntakeDestination;destinationLabel?:string;mediaKind?:string;creativeAssetId?:string;lookId?:string|null;bindingId?:string;error?: string; code?: string; videoId?: string; managedProjectId?: string; managedProjectName?: string;
  assetId?: string; adoptionStamp?: string; candidates?: Candidate[]; plannedFileName?: string; resultFileName?: string; nameMode?: NameMode;
  resolvedFolder?: {id: string; name: string; relativePath: string}; reveal?: {status: 'dispatched' | 'failed' | 'unknown'; at?: number; error?: {code: string; message: string}};
};
export type IntakeBatch = {
  version?:2;id: string; projectId: string; projectName: string; folderId: string; folderName: string; mode: 'copy' | 'move';
  createdAt: number | string; updatedAt: number | string;
  canAcknowledge?: boolean; acknowledged?: boolean; acknowledgedAt?: number; resultKey?: string;
  status: 'queued' | 'running' | 'waiting' | 'completed' | 'partial' | 'interrupted'; items: IntakeItem[]; revealWhenDone?: boolean;
};
export type LegacyConfirmInput = {version?:undefined;requestId: string; projectId: string; folderId: string; mode: 'copy' | 'move'; fileIds: string[]};
export type UnifiedConfirmInput = {version:2;requestId:string;mode:'copy'|'move';fileIds:string[];targets:{fileId:string;destination:IntakeDestination;nameMode?:NameMode}[];standardNames?:boolean;revealWhenDone?:boolean};
export type ConfirmInput = LegacyConfirmInput | UnifiedConfirmInput;
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
  queued: '等待处理', copying: '正在复制', duplicate: '等待重名处理', ready: '已收纳',
  source_retained: '已收纳，原文件未移除', failed: '收纳失败', cancelled: '已取消', unknown: '结果待核对', managed: '已经在素材库',
};
export const batchLabel: Record<IntakeBatch['status'], string> = {queued: '排队中', running: '处理中', waiting: '等待选择', completed: '处理完成', partial: '部分完成', interrupted: '已中断，待核对'};
export const encoded = (id: string) => encodeURIComponent(id);

export function sameTarget(batch: IntakeBatch, input: ConfirmInput) {
  const requested = new Set(input.fileIds), received = new Set(batch.items.map(item => item.id));
  return batch.id === input.requestId && (input.version===2 ? batch.version===2 && input.targets.every(t=>{const item=batch.items.find(i=>i.id===t.fileId);return destinationKey(t.destination)===destinationKey(item?.destination)&&(t.nameMode||'keep')===(item?.nameMode||'keep');}) : batch.version!==2 && batch.projectId === input.projectId && batch.folderId === input.folderId) && batch.mode === input.mode && (input.version !== 2 || !!input.revealWhenDone === !!batch.revealWhenDone)
    && requested.size === input.fileIds.length && received.size === batch.items.length && requested.size === received.size
    && [...requested].every(id => received.has(id));
}

export const destinationKey=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
export const kindLabel:Record<MediaKind,string>={photo:'摄影照片',video:'视频素材',music:'音乐',sfx:'音效'};
