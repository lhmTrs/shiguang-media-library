// 「待处理」接口的类型，和 server/notices/store.mjs 的 dto() 对应。
export type NoticeKind = 'decision' | 'info';
export type NoticeStatus = 'open' | 'later' | 'redo_decided' | 'running' | 'done' | 'failed' | 'skipped' | 'read' | 'resolved';
export type NoticeGroup = 'decision' | 'info' | 'later' | 'ended';
export type NoticeAction = 'redo' | 'skip' | 'later' | 'read';
export type NoticeLink = {label: string; view: string; projectId: string | null};

export type Notice = {
  id: string; source: string; sourceLabel: string; key: string; attempt: number;
  kind: NoticeKind; status: NoticeStatus; statusLabel: string; group: NoticeGroup; awaitingUser: boolean;
  typeLabel: string; title: string; context: string | null; costNote: string | null;
  owner: {session: string | null; id: string | null; gone: boolean} | null; unassigned: boolean; links: NoticeLink[];
  occurredAt: number; postedBy: string | null;
  decision: {action: NoticeAction; at: number; by: 'user'; origin?: NoticeOrigin} | null;
  result: {state: 'running' | 'done' | 'failed'; at: number; by: string | null; note: string | null} | null;
  resolution: {at: number; note: string} | null;
  previousId: string | null; nextId: string | null;
  /** 每一步的记录；用户做决定的那一条带 origin（请求来历，只记录不判断）。 */
  history: {at: number; event: string; by: string; note?: string; origin?: NoticeOrigin}[];
  revision: number; createdAt: number; updatedAt: number;
};
export type NoticeOrigin = {userAgent: string | null; fetchSite: string | null; fetchMode: string | null; fetchDest: string | null};
export type NoticeSummary = {pending: number; info: number; later: number; inflight: number; ended: number};
export type NoticeList = {schemaVersion: number; readAt: number; summary: NoticeSummary; notices: Notice[]; endedTotal: number};

export type NoticesRequest = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
/** 卡片上的「看这镜」「看这首歌」：宿主负责选中项目再切到对应页面。返回 false 表示没能打开。 */
export type NoticesOpenLink = (link: NoticeLink) => boolean | void;
