export type ProjectVideoStatus = 'available' | 'unsupported' | 'missing' | 'changed' | 'untrusted';
export type AdoptedShot = { id: string; number: number | string };

export interface ProjectVideo {
  id: string;
  projectId: string;
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

export type ReceiptStatus = 'waiting' | 'uploading' | 'duplicate' | 'ready' | 'failed' | 'running';
export type DuplicateCandidate = { id: string; name: string; reason: string; mediaUrl: string };
export interface Receipt {
  id: string;
  status: ReceiptStatus;
  videoId?: string;
  fileName?: string;
  error?: string;
  candidates?: DuplicateCandidate[];
  results?: { sourceId: string; name: string; status: string; error?: string }[];
}

export interface ProjectVideoCollection {
  project: { id: string; name: string };
  videos: ProjectVideo[];
  prompts: ReferencePrompt[];
  adoptionStamp: string;
}

export interface UpgradePreview {
  previewHash: string;
  items: { id: string; name: string; path: string; bytes: number; adoptedShots: AdoptedShot[]; status: string }[];
  bytes: number;
  freeBytes: number | null;
}

export type ImportRequest = {
  requestId: string;
  fileName: string;
  bytes: number;
  title?: string;
  notes?: string;
  prompt: PromptInput;
};
export type UpdateVideoRequest = { expectedRevision: number; title: string; notes: string; prompt: PromptInput };
export type RemoveVideoRequest = { expectedRevision: number; adoptionStamp: string; confirmUnbind: true };
export type RelinkVideoRequest = { requestId:string; expectedRevision: number; path: string };
export type ResolveImportRequest = { choice: 'reuse' | 'import'; candidateId?: string };
export type ProjectVideoRequest = <T = any>(url: string, body?: unknown, method?: string) => Promise<T>;

export interface ProjectVideoWorkspaceProps {
  active: boolean;
  projectId: string;
  projects: { id: string; name: string; project_kind?: string }[];
  /** Receives /project-videos/projects/:projectId followed by the contract suffix. */
  request: ProjectVideoRequest;
  onProject: (id: string) => void;
  onStoryboard: () => void;
  /** Lets the host also lock its global project selector/navigation during a write. */
  onBusyChange?: (busy: boolean) => void;
}
