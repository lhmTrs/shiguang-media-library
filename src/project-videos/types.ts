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
}

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
}

export interface UpgradePreview {
  previewHash: string;
  items: { id: string; name: string; path: string; bytes: number; adoptedShots: AdoptedShot[]; status: string }[];
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

export type FolderView = 'all' | 'root' | string;
export type Folder = {id: string; parentId: string; name: string; path: string; available: boolean};
export type ConflictChoice = 'rename' | 'overwrite';
export type FolderOperation = {
  kind: 'move-video' | 'rename-folder' | 'move-folder' | 'delete-folder';
  sourceId?: string; folderId?: string; destinationFolderId?: string; name?: string;
  mode?: 'trash' | 'contents-to-root';
};
export type OperationPlan = {
  requestId: string; previewHash: string; description: string;
  conflicts: {key: string; name: string; sourceName: string; targetName: string; targetVideoId?: string; adoptedShots: AdoptedShot[]; choice?: ConflictChoice}[];
  affectedShots: AdoptedShot[]; files: number; folders: number; ready: boolean;
};
export type OperationReceipt = {requestId: string; status: 'running' | 'ready' | 'failed' | 'unknown'; description: string; error?: string; folderId?: string};
