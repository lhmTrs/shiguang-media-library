// 与 server/project-music 的响应一一对应。只描述页面用到的字段。
export type Author = {kind: 'user'; at: number} | {kind: 'agent'; session: string; at: number};
export type SongStatus = 'active' | 'final' | 'abandoned';
export type Prompt = {tool: string; style: string; lyrics: string; params: string; sunoLink: string; sunoTier: '' | 'free' | 'pro' | 'premier' | 'unknown' | 'na'};
export type PromptDraft = {style: string; lyrics: string; params: string};
export type ListeningEntry = {id: string; text: string; kind: 'user' | 'transcript'; saidAt?: string; author: Author};
export type IssueItem = {text: string; source: 'user_words' | 'objective_check'; causeGuess: string};
export type CheckItem = {item: 'lyrics' | 'tempo' | 'duration' | 'loudness' | 'other'; versionId: string | null; result: string; method: string};

export type Version = {
  id: string; songId: string; roundId: string; roundNo: number; revision: number;
  label: string; originalName: string; downloadName: string; format: string; bytes: number; sha256: string;
  durationMs: number | null; peaks: number[] | null; loudnessDb: number | null;
  status: 'candidate' | 'rejected'; isBest: boolean; isFinal: boolean; note: string;
  uploadedBy: Author; rejectedAt: number | null; createdAt: number; mediaUrl: string; downloadUrl: string;
};

export type Round = {
  id: string; songId: string; roundNo: number; revision: number;
  prompt: Prompt; promptConfirmed: Author | null; promptDraftedBy: Author | null;
  changes: {text: string; count: number | null; author: Author} | null;
  listening: ListeningEntry[];
  issues: {items: IssueItem[]; author: Author} | null;
  checks: {items: CheckItem[]; author: Author} | null;
  nextDirection: {text: string; promptDraft: PromptDraft | null; author: Author} | null;
  /** 你自己写的问题整理和下一轮方向：一段文字，和 AI 写的分开存放和显示。 */
  userIssues: {text: string; author: Author} | null;
  userDirection: {text: string; author: Author} | null;
  comparisonNote: unknown;
  promptDiffFromPrevious: string[] | null; complete: boolean; missing: ('issues' | 'nextDirection')[];
  createdBy: Author; createdAt: number; updatedAt: number; versions: Version[];
};

export type Finalization = {
  requestId: string; versionId: string; directory: string; fileName: string;
  status: 'running' | 'duplicate' | 'ready' | 'failed' | 'cancelled'; error: string | null; assetId: string | null;
  candidates: {id: string; name: string; reason: string; mediaUrl: string}[];
} | null;

export type Song = {
  id: string; projectId: string; revision: number; title: string; notes: string; status: SongStatus;
  bestVersionId: string | null; finalVersionId: string | null;
  final: {assetId: string; versionId: string; directory: string; fileName: string; at: number} | null;
  finalHistory: unknown[]; finalization: Finalization; createdBy: Author; createdAt: number; updatedAt: number;
  rounds: Round[];
};

export type MusicCollection = {projectId: string; projectName: string; songs: Song[]};

export type ImportReceipt = {
  id: string; status: 'waiting' | 'uploading' | 'duplicate' | 'ready' | 'failed' | 'cancelled';
  fileName: string; bytes: number; label: string | null; versionId: string | null; error: string | null;
  duplicates: {versionId: string; songTitle: string; roundNo: number | null; label: string; status: string}[];
};

export type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;

export type ProjectMusicWorkspaceProps = {
  active: boolean;
  projectId: string;
  projects: {id: string; name: string}[];
  request: Request;
};

export const TIER_LABEL: Record<Prompt['sunoTier'], string> = {'': '未填', free: '免费版', pro: 'Pro', premier: 'Premier', unknown: '不确定', na: '不适用（非 Suno）'};
export const CHECK_LABEL: Record<CheckItem['item'], string> = {lyrics: '歌词逐句', tempo: '速度', duration: '时长', loudness: '响度', other: '其他'};
export const STATUS_LABEL: Record<SongStatus, string> = {active: '进行中', final: '定稿', abandoned: '放弃'};
export const PROMPT_FIELD_LABEL: Record<string, string> = {tool: '生成工具', style: '风格', lyrics: '歌词', params: '其他参数'};
