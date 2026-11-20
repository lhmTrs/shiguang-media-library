// 与 server/project-music 的响应一一对应。只描述页面用到的字段。
export type Author = {kind: 'user'; at: number; via?: 'finder'} | {kind: 'agent'; session: string; at: number};
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
  lyricTimes: {lines: {text: string; startMs: number}[]; method: string; author: Author} | null;
  /** PR3：每个版本都在音乐库里（根目录「AI生成」）。 */
  library: VersionLibrary;
  /** 这个版本在音乐库里的标签和来源：system 系统写的、prompt 按提示词、measured 测量、status 未选用。 */
  tags: {tag: string; source: 'system' | 'prompt' | 'measured' | 'status'; method?: string}[];
  measured: {bpm: number | null; durationMs: number | null; vocals: 'vocal' | 'instrumental' | null; language: string | null; method: string; author: Author} | null;
  /** 最近一次 AI 按你的原话改的状态（没改回的）。 */
  decidedBy: {id: string; action: DecisionAction; userWords: string; saidAt: string; author: Author} | null;
};

export type VersionLibrary =
  | {inLibrary: false; assetId: null; migrating: boolean; migrationError: string | null}
  | {inLibrary: boolean; assetId: string; reused: boolean; name: string | null; category: string; sub: string; missing: boolean; offline: boolean; moved: boolean; unusedTagged: boolean; tagSync: 'pending' | 'done' | 'failed'; tagError: string | null};

export type DecisionAction = 'reject' | 'restore' | 'best' | 'final';
export const DECISION_LABEL: Record<DecisionAction, string> = {reject: '淘汰', restore: '恢复为候选', best: '设为当前最好', final: '定稿'};
export type Decision = {id: string; action: DecisionAction; versionId: string; userWords: string; saidAt: string; author: Author; at: number; undone: {at: number} | null; canUndo: boolean};

export type Side = 'left' | 'right' | 'same';
export type Comparison = {
  id: string; roundId: string; blind: boolean; summary: string; winner: Side | null; author: Author; createdAt: number;
  left: {versionId: string; roundNo: number | null; label: string}; right: {versionId: string; roundNo: number | null; label: string};
  markers: {label: string; ms: number}[]; segments: {label: string; winner: Side; note: string}[]; loudness: {matched: boolean; gainDb: number} | null;
};

export type Round = {
  id: string; songId: string; roundNo: number; revision: number;
  prompt: Prompt; promptConfirmed: Author | null; promptDraftedBy: Author | null;
  /** AI 开新一轮时带的 Suno 链接：页面标「AI 填」；你改过就为 null。 */
  sunoLinkBy: Author | null;
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
  /** 从访达收纳开了下一轮时，这一轮的记录还没写完：等 AI 补写（补完就为 null）。 */
  pendingAgentNotes: {at: number; missing: string[]; reason: string} | null;
  createdBy: Author; createdAt: number; updatedAt: number; versions: Version[]; comparisons: Comparison[];
};

/** PR3 之后定稿不再走这里；只剩旧流程留下的记录（显示为已停用）。 */
export type Finalization = {requestId: string; versionId: string; status: 'ready' | 'failed'; error: string | null; assetId: string | null} | null;

export type Song = {
  id: string; projectId: string; revision: number; title: string; notes: string; status: SongStatus;
  bestVersionId: string | null; finalVersionId: string | null;
  final: {assetId: string; versionId: string; at: number; directory?: string; fileName?: string} | null;
  finalHistory: unknown[]; finalization: Finalization; decisions: Decision[]; createdBy: Author; createdAt: number; updatedAt: number;
  rounds: Round[];
};

export type MusicCollection = {
  projectId: string; projectName: string; libraryRootName: string; songs: Song[]; pendingNotes?: number;
  /** 旧位置（PR1、PR2）的歌：还在搬的、没搬成的、搬好了但旧副本还在的。 */
  legacy: {waiting: number; failed: {versionId: string; error: string}[]; copies: number; running: boolean};
};

export type ImportReceipt = {
  id: string; status: 'waiting' | 'uploading' | 'duplicate' | 'ready' | 'failed' | 'cancelled';
  fileName: string; bytes: number; label: string | null; versionId: string | null; error: string | null;
  duplicates: {versionId: string; songTitle: string; roundNo: number | null; label: string; status: string}[];
  /** 音乐库里已有同内容的记录：复用它，不另存一份。 */
  reused: {assetId: string; name: string} | null;
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
