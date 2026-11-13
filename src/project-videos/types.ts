export type ProjectVideoStatus = 'available' | 'unsupported' | 'missing' | 'changed' | 'untrusted' | 'unchecked';
export type AdoptedShot = { id: string; number: number | string };

export interface ProjectVideo {
  id: string;
  projectId: string;
  folderId: string | null;
  folderName?: string;
  name: string;
  fileName: string;
  notes: string;
  promptId: string | null;
  revision: number;
  durationMs: number;
  codec: string;
  supported: boolean;
  status: ProjectVideoStatus;
  managed: boolean;
  mediaUrl: string;
  thumbnailUrl?: string | null;
  thumbUrl?: string;
  adoptedShots: AdoptedShot[];
  path: string;
  bytes: number;
  /** 合同 C：可选，旧后台不返回。metadataChanged 表示已证明只有无关元数据变化、内容一致。 */
  verification?: VideoVerification;
  /** 废片收纳（#55）：视频位于收纳处子树内。由后台按 rejectFolderId 派生，旧后台不返回。 */
  inRejectArea?: boolean;
}

export type VideoVerification = {
  state: 'verified' | 'checking' | 'needs_verification' | 'content_changed';
  match: 'file' | 'media' | null;
  metadataChanged: boolean;
};

/** 合同 v1：列表顶层的桌面操作能力。每次执行时后台仍会重新检测，前端不把它当永久授权。 */
export type DesktopCapability = { available: boolean; code?: string; reason?: string };
export type ProjectVideoCapabilities = {
  version: number;
  maxSelection: number;
  clipboard: DesktopCapability;
  revealMany: DesktopCapability;
  mediaIdentity?: DesktopCapability & { version?: string };
};

export interface ReferencePrompt {
  id: string;
  title: string;
  text: string;
  createdAt: string | number;
}

export type PromptInput =
  | { mode: 'none' }
  | { mode: 'new'; title?: string; text: string }
  | { mode: 'existing'; id: string };

export type ReceiptStatus = 'waiting' | 'uploading' | 'duplicate' | 'ready' | 'failed' | 'running' | 'unknown' | 'cancelled';
export type DuplicateCandidate = { id: string; name: string; reason: string; mediaUrl: string; adoptedShots: AdoptedShot[] };
export interface Receipt {
  id: string;
  status: ReceiptStatus;
  videoId?: string;
  fileName?: string;
  finalName?: string;
  projectId?: string;
  folderId?: string;
  folderName?: string;
  adoptionStamp?: string;
  error?: string;
  candidates?: DuplicateCandidate[];
  results?: { sourceId: string; name: string; status: string; error?: string }[];
}

export interface ProjectVideoCollection {
  project: { id: string; name: string };
  videos: ProjectVideo[];
  prompts: ReferencePrompt[];
  adoptionStamp: string;
  folders: Folder[];
  currentFolderId: FolderView;
  breadcrumbs: Folder[];
  folderRevision: number;
  legacyUpgrade: {completed: boolean; count?: number};
  canTrash: boolean;
  readOnly?: boolean;
  capabilities?: ProjectVideoCapabilities;
  /** 废片收纳（#55）：rejectFolderId 是唯一权威来源；revision 用于设置/取消时的并发核对。旧后台不返回。 */
  folderRoles?: FolderRoles;
}

/** needsReview：角色指针或目录不可用，需要用户核对；前端不猜同名目录。 */
export type FolderRoles = { revision: number; rejectFolderId: string | null; rejectVideoCount: number; needsReview?: boolean };
export type RejectShot = AdoptedShot & { sourceIds?: string[] };
/** POST /folders/reject/preview 的回执（合同 v1）。 */
export type RejectRolePlan = {
  requestId: string; previewHash: string; ready: boolean; expectedRolesRevision: number; adoptionStamp?: string;
  roleChange: { beforeFolderId: string | null; afterFolderId: string | null; willCreate: boolean; name?: string };
  /** 目标目录（含子树）内当前的视频记录数。 */
  rejectVideoCount?: number;
  affectedShots: RejectShot[];
};
/** move-videos（unbindAdoptions:true）预览：在普通 OperationPlan 之上增加解除采用的明细。 */
export type RejectMovePlan = OperationPlan & {
  sourceUnbindShots?: RejectShot[]; overwriteTargetUnbindShots?: RejectShot[];
  willUnbindAdoptions?: boolean; rolesRevision?: number; adoptionStamp?: string;
};
/** 逐项结果（Codex 2310 回执）：ready 已移入；rolled-back 已回退；not-run 因前项失败或待核对没有执行。 */
export type BatchItemStatus = 'ready' | 'rolled-back' | 'failed' | 'unknown' | 'not-run';
export type BatchReceipt = Omit<OperationReceipt, 'status'> & {
  status: OperationReceipt['status'] | 'partial';
  /** 权威的解除采用并集（含被覆盖的同名目标）。 */
  unboundShotIds?: string[];
  /** 仅预览、执行尚未登记：status=unknown, phase=preview, errorCode=OPERATION_NOT_STARTED。 */
  phase?: 'preview' | 'execution'; errorCode?: string; canRecover?: boolean; folderRoles?: FolderRoles;
  items?: { sourceId: string; name?: string; status: BatchItemStatus; unboundShotIds?: string[]; error?: string }[];
}

export interface UpgradePreview {
  previewHash: string;
  items: { id: string; name: string; path: string; bytes: number; adoptedShots: AdoptedShot[]; status: string; requiresRelink?: boolean }[];
  bytes: number;
  freeBytes: number | null;
}

export type ImportRequest = {
  requestId: string;
  folderId: string;
  fileName: string;
  bytes: number;
  title?: string;
  notes?: string;
  prompt: PromptInput;
};
export type UpdateVideoRequest = { expectedRevision: number; title: string; notes: string; prompt: PromptInput };
export type RemoveVideoRequest = { expectedRevision: number; adoptionStamp: string; confirmUnbind: true };
export type RelinkVideoRequest = { requestId:string; expectedRevision: number; path: string };
export type ResolveImportRequest = { choice: 'overwrite' | 'rename' | 'cancel'; candidateId?: string; adoptionStamp?: string; confirmUnbind?: boolean };
export type ProjectVideoRequest = <T = any>(url: string, body?: unknown, method?: string) => Promise<T>;

export interface ProjectVideoWorkspaceProps {
  active: boolean;
  projectId: string;
  projects: { id: string; name: string; project_kind?: string }[];
  /** Receives /project-videos/projects/:projectId followed by the contract suffix. */
  request: ProjectVideoRequest;
  onProject: (id: string) => void;
  onStoryboard: () => void;
  /** Compatibility callback; background tasks do not lock host navigation. */
  onBusyChange?: (busy: boolean) => void;
  /** Explicit navigation from a completed file task, without replacing drafts. */
  focusVideo?: {projectId: string; videoId: string; request: number};
}

export type FolderView = 'all' | 'root' | 'reject' | string;
export type Folder = {id: string; parentId: string; name: string; path: string; available: boolean; role?: 'reject' | null};
export type ConflictChoice = 'rename' | 'overwrite';
export type FolderOperation = {
  kind: 'move-video' | 'move-videos' | 'rename-folder' | 'move-folder' | 'delete-folder';
  sourceId?: string; folderId?: string; destinationFolderId?: string; name?: string;
  mode?: 'trash' | 'contents-to-root';
  /** move-videos：选中的视频（含当前所在目录，用于排除已在目标目录的项）与预先排除的项。 */
  items?: {id: string; name: string; folderId: string | null}[];
  skipped?: {name: string; reason: string}[];
};
export type OperationPlan = {
  requestId: string; previewHash: string; description: string;
  conflicts: {key: string; name: string; sourceName: string; targetName: string; targetVideoId?: string; adoptedShots: AdoptedShot[]; choice?: ConflictChoice}[];
  affectedShots: AdoptedShot[]; files: number; folders: number; ready: boolean;
};
export type OperationReceipt = {requestId: string; status: 'running' | 'ready' | 'failed' | 'unknown'; description: string; error?: string; folderId?: string;
  /** move-videos：逐项结果；执行中各项都是 not-run（后端不给逐项进度）。 */
  items?: { sourceId: string; name?: string; status: BatchItemStatus; unboundShotIds?: string[]; error?: string }[];
  /** 只有预览、执行没有登记：status=unknown, phase=preview, errorCode=OPERATION_NOT_STARTED。 */
  phase?: 'preview' | 'execution'; errorCode?: string;
  /** 服务端判断能否回滚（只有它说能才给回滚入口）。 */
  canRecover?: boolean};
