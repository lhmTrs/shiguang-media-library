// 素材使用页：成片关联（合同 PROJECT-USAGE-RENDER v1）。只从同一集的项目视频里选成片；
// 写入走可查询回执，结果不明时只按原请求号核对，不换新编号重发。
import type { ProjectRequest } from "../ProjectManager";

export type RenderFolder = { id: string; parentId: string | null; name: string; relativePath: string; role: "final" | "reject" | null; locked: boolean; available: boolean };
export type Availability = null | "available" | "missing" | "removed" | "unavailable" | "untrusted";
export type Verification = { state: "unchecked" | "verified" | "needs_verification" | "content_changed"; match: string | null; metadataChanged: boolean };
export type RenderV2 = {
  schemaVersion: 2; projectId: string; timelineId: string;
  link: "project-video" | "legacy-path" | null; sourceId: string | null; name: string | null; folder: RenderFolder | null; path: string | null;
  offset: number; revision: number; updatedAt: number | null;
  sourceRevision: number | null; linkedSourceRevision: number | null; timelineRevision: string; linkedTimelineRevision: string | null;
  availability: Availability; verification: Verification;
  playback: { supported: boolean | null; canPlay: boolean; reasonCode: string | null; mediaUrl: string | null };
  sync: { state: "aligned" | "not_linked" | "timeline_changed" | "source_changed" | "duration_mismatch" | "legacy_unverified"; canSynchronize: boolean };
  video: { codec: string | null; width: number | null; height: number | null; durationMs: number | null; bytes: number | null } | null;
};
export type FolderRoles = { revision: number; rejectFolderId: string | null; rejectVideoCount: number; needsReview: boolean; finalFolderId: string | null; finalState: "not_created" | "ready" | "needs_review"; finalErrorCode: string | null };
export type SourceItem = {
  sourceId: string; projectId: string; name: string; fileName: string; sourceRevision: number; folder: RenderFolder | null;
  managed: boolean; inRejectArea: boolean; availability: Availability; verification: Verification;
  codec: string | null; width: number | null; height: number | null; durationMs: number | null; bytes: number | null;
  playback: { supported: boolean | null; reasonCode: string | null }; selectable: boolean; disabledReasons: { code: string; message: string }[]; previewUrl: string | null;
};
export type SourcesPage = { schemaVersion: 1; projectId: string; timelineId: string; timelineRevision: string; items: SourceItem[]; total: number; page: number; pages: number; pageSize: number; folders: RenderFolder[]; folderRoles: FolderRoles };
export type Receipt<R = unknown> = {
  schemaVersion: 1; requestId: string; projectId: string; timelineId: string | null;
  action: "render-link" | "render-unlink" | "final-folder-ensure" | "video-info-refresh";
  status: "checking" | "running" | "completed" | "failed" | "unknown"; statusUrl: string;
  result: R | null; error: { code: string; message: string; details?: Record<string, unknown> } | null;
};
export type EnsureResult = { outcome?: "created" | "adopted" | "existing"; folder?: RenderFolder; folderRoles?: FolderRoles; created: boolean | null; adopted: boolean | null; contentsMoved: false };
export type RequestError = Error & { code?: string; status?: number; accepted?: boolean; requestId?: string; details?: Record<string, unknown> & { statusUrl?: string } };

const base = (projectId: string, timelineId: string) => `/projects/${projectId}/timelines/${timelineId}/render`;
/** 回执里的 statusUrl 带 /api 前缀；ProjectRequest 约定不带。 */
export const stripApi = (url: string) => url.replace(/^\/api(?=\/)/, "");
export const newRequestId = () => crypto.randomUUID();

export const renderApi = {
  get: (request: ProjectRequest, projectId: string, timelineId: string) => request<RenderV2>(`${base(projectId, timelineId)}?schema=2`),
  sources: (request: ProjectRequest, projectId: string, timelineId: string, query: { q?: string; folderId?: string; page?: number; pageSize?: number }) =>
    request<SourcesPage>(`${base(projectId, timelineId)}/sources?` + new URLSearchParams({ q: query.q ?? "", folderId: query.folderId ?? "all", page: String(query.page ?? 1), pageSize: String(query.pageSize ?? 50) })),
  link: (request: ProjectRequest, projectId: string, timelineId: string, body: { requestId: string; sourceId: string; offset: number; expectedRevision: number; expectedSourceRevision: number; expectedTimelineRevision: string }) =>
    request<Receipt<{ render: RenderV2 }>>(base(projectId, timelineId), body, "POST"),
  unlink: (request: ProjectRequest, projectId: string, timelineId: string, body: { requestId: string; expectedRevision: number }) =>
    request<Receipt<{ render: RenderV2 }>>(base(projectId, timelineId), body, "DELETE"),
  ensureFinal: (request: ProjectRequest, projectId: string, body: { requestId: string; expectedRolesRevision: number }) =>
    request<Receipt<EnsureResult>>(`/project-videos/projects/${projectId}/folders/final/ensure`, body, "POST"),
  refreshInfo: (request: ProjectRequest, projectId: string, sourceId: string, body: { requestId: string; expectedRevision: number }) =>
    request<Receipt<{ source: SourceItem }>>(`/project-videos/projects/${projectId}/videos/${sourceId}/info/refresh`, body, "POST"),
  receipt: <R,>(request: ProjectRequest, statusUrl: string) => request<Receipt<R>>(stripApi(statusUrl)),
};

const terminal = (r: Receipt) => r.status === "completed" || r.status === "failed";

/** 原回执地址（与后端 action-journal 一致）；按 action 推导，不采用响应里给的地址。 */
export const renderStatusUrl = (projectId: string, timelineId: string, requestId: string) => `${base(projectId, timelineId)}/requests/${requestId}`;
export const operationStatusUrl = (projectId: string, requestId: string) => `/project-videos/projects/${projectId}/operations/${requestId}`;

/**
 * 一次写入的原意图：提交前就冻结项目、时间线、编号和查询地址。之后的错误体、轮询回执、核对结果都不能替换它；
 * 编号/项目/时间线/动作对不上的回执一律不算这条请求的结果。
 */
export type Intent = { action: Receipt["action"]; projectId: string; timelineId: string | null; requestId: string; statusUrl: string };
export function intentOf(action: Receipt["action"], projectId: string, timelineId: string | null): Intent {
  const requestId = newRequestId(), scoped = action === "render-link" || action === "render-unlink" ? timelineId : null;
  return { action, projectId, timelineId: scoped, requestId, statusUrl: scoped ? renderStatusUrl(projectId, scoped, requestId) : operationStatusUrl(projectId, requestId) };
}
/** 待核对按「这条时间线」或「这一集的这类操作」分开保存，一处的结果不会删掉另一处。 */
export const scopeOf = (i: Intent) => i.timelineId ? `timeline:${i.projectId}:${i.timelineId}` : `project:${i.projectId}:${i.action}`;
export const belongs = (r: Receipt, i: Intent) => r.requestId === i.requestId && r.projectId === i.projectId && (r.timelineId ?? null) === i.timelineId && r.action === i.action;
export const RECEIPT_MISMATCH = "查到的回执不属于原请求，已忽略；原请求仍待核对。";
export const NOT_FOUND_YET = "还查不到原请求的回执；这不代表它没有执行，请稍后再核对。";
export function unknownReceipt<R = unknown>(i: Intent, code: string, message: string): Receipt<R> {
  return { schemaVersion: 1, requestId: i.requestId, projectId: i.projectId, timelineId: i.timelineId, action: i.action, status: "unknown", statusUrl: i.statusUrl, result: null, error: { code, message } };
}
/** 收到的回执先核身份：不是原请求的，当作结果不明（不放行、不当完成）。查询地址固定成原地址。 */
const own = <R,>(r: Receipt<R>, i: Intent): Receipt<R> => belongs(r as Receipt, i) ? { ...r, statusUrl: i.statusUrl } : unknownReceipt<R>(i, "RECEIPT_MISMATCH", RECEIPT_MISMATCH);

/** 按原地址查一次原请求。查不到（404）、断网、5xx 都仍是结果不明；其它 4xx 原样抛出。 */
export async function checkOriginal<R = unknown>(request: ProjectRequest, i: Intent): Promise<Receipt<R>> {
  try { return own(await renderApi.receipt<R>(request, i.statusUrl), i); }
  catch (e) {
    const err = e as RequestError;
    if (err.code === "OPERATION_NOT_FOUND") return unknownReceipt<R>(i, "OPERATION_NOT_FOUND", NOT_FOUND_YET);
    if (!err.status || err.status >= 500) return unknownReceipt<R>(i, err.code || "OPERATION_UNSETTLED", err.status ? err.message : "没收到服务器的答复，不知道原请求是否已执行");
    throw e;
  }
}

/** 202 checking/running 时按原地址查询，最多等 maxMs；不重发写请求。返回最后一次读到的（已核身份的）回执。 */
export async function settle<R>(request: ProjectRequest, i: Intent, first: Receipt<R>, alive: () => boolean, maxMs = 20000): Promise<Receipt<R>> {
  let receipt = own(first, i), wait = 400;
  const until = Date.now() + maxMs;
  while (!terminal(receipt as Receipt) && receipt.status !== "unknown" && Date.now() < until && alive()) {
    await new Promise(r => setTimeout(r, wait)); wait = Math.min(2000, wait * 1.6);
    if (!alive()) break;
    receipt = await checkOriginal<R>(request, i);
  }
  return receipt;
}

/**
 * 写请求抛错时区分两种情况：明确的业务拒绝（4xx，服务器说了没做，含已登记的 accepted 拒绝）可以改了再提交；
 * 传输丢失 / 5xx / 后端说「结果未核清」则不知道是否已执行——返回原意图的 unknown 回执，只能按原编号核对，不能开新写入。
 * 错误体里给的编号、地址一律不用。
 */
export function unsettledReceipt(error: RequestError, i: Intent): Receipt | null {
  const status = error.status ?? 0;
  if (status && status < 500 && !/UNSETTLED$/.test(error.code ?? "")) return null;
  return unknownReceipt(i, error.code || "OPERATION_UNSETTLED", status ? error.message : "没收到服务器的答复，不知道刚才的操作是否已执行");
}

/** 已登记的语义拒绝（accepted=true）仍是失败；只给原因，不当作成功。 */
export function rejectionMessage(error: RequestError) {
  return error.message || "操作失败";
}

const fmt2 = (n: number) => String(n).padStart(2, "0");
export const clock = (s: number | null | undefined) => {
  if (s == null || !Number.isFinite(s)) return "—";
  const neg = s < 0, v = Math.abs(s), m = Math.floor(v / 60), r = v - m * 60;
  return (neg ? "-" : "") + fmt2(m) + ":" + (r < 10 ? "0" : "") + r.toFixed(1);
};
export const bytesText = (n: number | null) => n == null ? "大小未知" : n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + " GB" : n >= 1 << 20 ? Math.round(n / (1 << 20)) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

/** 成片状态给用户看的一句话（不把编码不支持说成文件丢失）。 */
export function renderStatus(r: RenderV2 | null): { tone: "ok" | "warn" | "none"; text: string } {
  if (!r || !r.link) return { tone: "none", text: "还没关联成片" };
  if (r.link === "legacy-path") {
    if (r.availability === "missing") return { tone: "warn", text: "找不到成片（旧关联）" };
    return { tone: "warn", text: "旧版成片关联，建议改从项目视频里选" };
  }
  switch (r.availability) {
    case "missing": return { tone: "warn", text: "找不到成片" };
    case "removed": return { tone: "warn", text: "成片已从项目里移除" };
    case "untrusted": return { tone: "warn", text: "成片需要先升级为项目托管视频" };
    case "unavailable": return { tone: "warn", text: "成片暂时读不到" };
  }
  if (r.verification.state === "content_changed") return { tone: "warn", text: "成片内容已变化，需要重新确认" };
  if (r.verification.state === "needs_verification") return { tone: "warn", text: "成片文件状态待核验" };
  if (r.playback.supported === false) return { tone: "warn", text: "成片编码浏览器播放不了" };
  if (!r.playback.canPlay) return { tone: "warn", text: "成片暂不能播放" };
  if (!r.sync.canSynchronize) return { tone: "warn", text: r.sync.state === "timeline_changed" ? "时间线已重新导入，需要重新确认成片" : "成片与时间线需要重新确认" };
  return { tone: "ok", text: "成片可播放" };
}

const reasonText: Record<string, string> = {
  RENDER_SOURCE_MISSING: "成片视频文件已移动或丢失",
  RENDER_SOURCE_REMOVED: "成片已从项目视频里移除",
  RENDER_SOURCE_UNTRUSTED: "这个视频还不是本项目托管的视频",
  RENDER_SOURCE_REVIEW_REQUIRED: "成片文件状态有变化，需要先在项目视频里核验",
  RENDER_SOURCE_CHANGED: "成片内容已变化，需要重新确认",
  RENDER_LEGACY_PATH_MISSING: "旧关联的成片文件不在原位置了",
  RENDER_LEGACY_REVIEW_REQUIRED: "旧关联的成片文件被修改过，需要重新选择",
  RENDER_CODEC_UNSUPPORTED: "这个编码浏览器播放不了",
  RENDER_INFO_REQUIRED: "还不知道这个视频的编码，先刷新视频信息",
  RENDER_NOT_LINKED: "还没关联成片",
};
export const reasonOf = (code: string | null | undefined, fallback = "暂不能播放") => (code && reasonText[code]) || fallback;
