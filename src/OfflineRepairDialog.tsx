import { AssetMergeDialog, readMergePairs } from "./AssetMergeDialog";
import { useEffect, useRef, useState } from "react";
import { Fingerprint, Search, Square, X } from "lucide-react";

export type OfflineRepairRoot = { id: string; name: string; online?: number; retired?: number };
export type OfflineRepairAsset = { id: string; name: string; online?: number; file_status?: string };
type Mode = "preview" | "fingerprint";
type Status = "queued" | "running" | "cancelling" | "done" | "cancelled" | "failed";
type Candidate = { sourceAssetId: string; targetRootId: string; targetRelativePath: string; targetAssetId: string | null; contentMatch: true; ambiguous: boolean; physicalIdentityProven: false; uniqueness: "not_asserted" };
type Task = { id: string; taskId: string; mode: Mode; status: Status; checked: number; saved: number; bytesRead: number; remainingSelected: number | null; selectionTruncated: boolean; resultTruncated: boolean; searchComplete: boolean; items: { assetId: string; state: string; code?: string }[]; issues: { assetId: string | null; code: string }[]; candidates: Candidate[] };
type SavedTask = { nonce: string; taskId: string | null; mode: Mode; assetIds: string[]; rootIds: string[] };
type Request = <T = unknown>(url: string, body?: unknown, method?: string) => Promise<T>;
type Readiness = { ready: boolean; phase: string; version: number; code: string; canRegister?: boolean };
type RestorePreview = { previewId: string; assetId: string; targetRootId: string; targetRelativePath: string; expiresAt: number; confirmationRequired: true; contentMatch: true; physicalIdentityProven: false };
type RestoreOperation = { operationId: string; assetId: string; phase: "PREPARED" | "DB_COMMITTED" | "MIRROR_PENDING" | "COMPLETE" | "ABORTED"; version: number; complete: boolean; needsRecovery: boolean; inFlight: boolean; targetRootId: string; targetRelativePath: string; error?: string };
type RestoreIntent = { nonce: string; assetId: string; previewId: string; commandId: string; operationId: string | null };
type HistoryCursor = { createdMs: number; operationId: string };
const RESTORE_PHASES = { PREPARED: "路径变更尚未提交", DB_COMMITTED: "索引已更新，镜像待核对", MIRROR_PENDING: "索引已更新，镜像待恢复", COMPLETE: "已重新关联", ABORTED: "未提交操作已中止" };
function relative(value: unknown): value is string { return typeof value === "string" && !!value && value.length <= 4096 && !/^[\\/]|^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).some(v => !v || v === "." || v === ".."); }
function restoredIntent(key: string, ids: string[]): RestoreIntent | null { try { const raw = sessionStorage.getItem(key); if (!raw || raw.length > 2048) return null; const v = JSON.parse(raw); return UUID.test(v.nonce) && ids.includes(v.assetId) && UUID.test(v.previewId) && UUID.test(v.commandId) && (v.operationId === null || UUID.test(v.operationId)) ? v : null; } catch { return null; } }
function saveRestore(key: string, value: RestoreIntent) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch {} }
function checkedOperation(value: unknown, ids: string[]): RestoreOperation {
  const v = value as RestoreOperation;
  if (!v || (v as RestoreOperation & {mode?: string}).mode !== undefined || !UUID.test(v.operationId) || !ids.includes(v.assetId) || !Object.hasOwn(RESTORE_PHASES, v.phase) || !Number.isSafeInteger(v.version) || v.version < 0 || typeof v.complete !== "boolean" || v.complete !== (v.phase === "COMPLETE") || typeof v.needsRecovery !== "boolean" || v.needsRecovery !== ["PREPARED", "DB_COMMITTED", "MIRROR_PENDING"].includes(v.phase) || typeof v.inFlight !== "boolean" || v.complete && v.inFlight || !UUID.test(v.targetRootId) || !relative(v.targetRelativePath)) throw Error("INVALID_RESTORE_RESPONSE");
  return v;
}
function checkedReadiness(value: unknown): Readiness { const v = value as Readiness; if (!v || typeof v.ready !== "boolean" || !["READY", "NOT_REGISTERED", "REGISTERING", "INIT_PENDING", "UNKNOWN"].includes(v.phase) || !Number.isSafeInteger(v.version) || v.version < 0 || typeof v.code !== "string" || !/^[A-Z_]{1,64}$/.test(v.code)) throw Error("INVALID_RESTORE_RESPONSE"); return v; }
function restoreProblem(e: unknown) {
  const code = (e as { code?: string }).code;
  const messages: Record<string, string> = { UPLOAD_STATE_UNKNOWN: "上传安全状态尚未确认，请先核对恢复环境；没有执行恢复。", STORE_NOT_REGISTERED: "本库上传存储尚未登记，请先核对并明确登记。", HOST_BUSY: "现有工作尚未结束，请结束后再核对。", MAINTENANCE_BUSY: "正在维护或传输，暂不能登记或恢复。", REGISTRATION_UNKNOWN: "登记证据不可确认，已保持拒绝；不会覆盖原现场。", MYSQL_REGISTRATION_NOT_VALIDATED: "本版本尚未验证此数据库的登记，已保持拒绝。", UPLOAD_RESOURCE_UNKNOWN: "私有上传目录仍有未核清的资源，未执行登记。", REGISTRATION_INIT_PENDING: "登记尚未全部完成，已保留待核现场；不会自动重建。", STORE_SCHEMA_PARTIAL: "上传表不完整，已拒绝登记；不会清空或重建。", STORE_SCHEMA_MISMATCH: "上传表定义不符，已拒绝登记。", STORE_BINDING_CHANGED: "当前库绑定已变化，请先核对。", BLOCKED_UPLOAD_REFERENCE: "仍有未核清的上传记录或资源，本次未放行。", NEEDS_MERGE: "目标已有素材记录，需要另行确认合并；未覆盖。", PREVIEW_EXPIRED: "核对已过期或会话已变化，请重新核对所选位置。", REPAIR_LIMIT: "恢复日志达到容量上限，未创建新恢复。", REPAIR_PENDING: "有尚未核清的恢复标记，请先核对原操作。", REPAIR_VERSION_CHANGED: "操作状态已变化，请重新查询后再决定。" };
  return code && messages[code] || "结果尚未确认，请查询原操作。不会自动重试或换一个命令重新提交。";
}
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const ACTIVE = new Set<Status>(["queued", "running", "cancelling"]);
const STATES: Record<Status, string> = { queued: "等待开始", running: "正在检查", cancelling: "等待任务实际停止", done: "任务结束", cancelled: "任务已取消", failed: "任务失败" };
const reasons: Record<string, string> = {
  NO_TRUSTED_FINGERPRINT: "没有可信的移动前指纹，无法据此定位；不能为已经搬走的文件补造历史证据。",
  ORIGINAL_PRESENT: "原路径仍有文件，不能认定为已移动；可能是复制。",
  ROOT_UNAVAILABLE: "登记目录已离线或退管，请核对目录后再试。",
  ROOT_CHANGED: "目录状态变化，本次结果未确认。",
  FILE_CHANGED: "读取期间文件发生变化，本次结果未确认。",
  TARGET_CHANGED: "候选文件发生变化，需要重新核对。",
  SOURCE_CHANGED: "旧记录或原路径发生变化，本次结果未确认。",
  BINDING_CHANGED: "记录或目录状态发生变化，已跳过。",
  BYTE_BUDGET: "读取字节预算已耗尽，范围未完整覆盖。",
  FILE_BUDGET: "单次文件数量预算已耗尽，范围未完整覆盖。",
  ENTRY_BUDGET: "目录搜索预算已耗尽，范围未完整覆盖。",
  TIME_BUDGET: "本次时间预算已到，范围未完整覆盖。",
  FILE_LINK: "链接文件已跳过，范围未完整覆盖。",
  MANIFEST_WRITE_FAILED: "清单保存未完成，没有确认保存该条指纹。",
  MANIFEST_COMMIT_FAILED: "指纹保存未能全部确认，请重新核对。",
  DB_WRITE_FAILED: "索引保存失败，没有确认保存该条指纹。",
};
function label(value: string | undefined, fallback: string) {
  if (!value || /(?:^\/|\/(?:Users|home|private|var|Volumes)\/|[A-Za-z]:[\\/]|file:\/\/)/.test(value)) return fallback;
  return value.length > 180 ? value.slice(0, 177) + "…" : value;
}
function readSaved(key: string, ids: string[]): SavedTask | null {
  try {
    const raw = sessionStorage.getItem(key); if (!raw || raw.length > 12000) return null;
    const s = JSON.parse(raw) as SavedTask;
    if (!UUID.test(s.nonce) || s.taskId !== null && !UUID.test(s.taskId) || !["preview", "fingerprint"].includes(s.mode) || !Array.isArray(s.assetIds) || !s.assetIds.length || s.assetIds.length > 50 || s.assetIds.some(id => !ids.includes(id)) || !Array.isArray(s.rootIds) || s.rootIds.length > 16 || s.rootIds.some(id => !UUID.test(id))) return null;
    return s;
  } catch { return null; }
}
function save(key: string, value: SavedTask | null) { try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* UI still works without browser storage. */ } }
async function queryTask(taskId: string, signal: AbortSignal): Promise<unknown> {
  if (!UUID.test(taskId)) throw Error("INVALID_TASK");
  const response = await fetch(`/api/asset-fingerprints/${taskId}`, { signal, credentials: "same-origin" });
  const value = await response.json();
  if (!response.ok) throw Object.assign(Error("TASK_QUERY_FAILED"), { status: response.status, code: value?.code || value?.error });
  return value;
}
function checkedTask(value: unknown, scope: SavedTask): Task {
  const t = value as Task;
  if (!t || !UUID.test(t.id) || t.taskId !== t.id || scope.taskId !== null && t.id !== scope.taskId || t.mode !== scope.mode || !Object.hasOwn(STATES, t.status) || !Number.isSafeInteger(t.checked) || t.checked < 0 || t.checked > 50 || !Number.isSafeInteger(t.saved) || t.saved < 0 || t.saved > 50 || !Number.isSafeInteger(t.bytesRead) || t.bytesRead < 0 || t.bytesRead > 134217728 || t.remainingSelected !== null && (!Number.isSafeInteger(t.remainingSelected) || t.remainingSelected < 0 || t.remainingSelected > 50) || typeof t.searchComplete !== "boolean" || typeof t.selectionTruncated !== "boolean" || typeof t.resultTruncated !== "boolean" || !Array.isArray(t.items) || t.items.length > 50 || !Array.isArray(t.issues) || t.issues.length > 101 || !Array.isArray(t.candidates) || t.candidates.length > 200) throw Error("INVALID_TASK_RESPONSE");
  for (const item of t.items) if (!scope.assetIds.includes(item.assetId) || typeof item.state !== "string") throw Error("INVALID_TASK_RESPONSE");
  for (const issue of t.issues) if (issue.assetId !== null && !scope.assetIds.includes(issue.assetId) || typeof issue.code !== "string") throw Error("INVALID_TASK_RESPONSE");
  for (const c of t.candidates) if (!scope.assetIds.includes(c.sourceAssetId) || !scope.rootIds.includes(c.targetRootId) || typeof c.targetRelativePath !== "string" || !c.targetRelativePath || c.targetRelativePath.length > 4096 || /^[\\/]|^[A-Za-z]:/.test(c.targetRelativePath) || c.targetRelativePath.split(/[\\/]/).some(s => s === ".." || s === ".") || c.targetAssetId !== null && !UUID.test(c.targetAssetId) || c.contentMatch !== true || typeof c.ambiguous !== "boolean" || c.physicalIdentityProven !== false || c.uniqueness !== "not_asserted") throw Error("INVALID_TASK_RESPONSE");
  return t;
}
function problem(error: unknown, action: "start" | "cancel" | "query") {
  const e = error as { code?: string; status?: number; message?: string };
  if (e.code === "TASK_NOT_FOUND" || e.message === "TASK_NOT_FOUND" || e.status === 404) return "原任务已不存在，服务可能已重启；没有自动重新开始。";
  if (e.status === 401 || e.status === 403) return "本机会话或查询权限已失效，请刷新页面后核对任务。";
  if (e.code === "BUSY" || e.message === "BUSY") return "另一个素材任务正在执行，请结束后再尝试。";
  return action === "start" ? "启动结果未确认，不会自动重试。请先查看任务，避免重复开始。" : action === "cancel" ? "取消请求未确认；不能据此认定任务已停止，请查询实际状态。" : "查询失败，已停止自动查询。未取消或重新启动任务，请手动重新查询。";
}

export function OfflineRepairDialog({ ids, assets = [], roots, request, close, restored, merged, beforeMerge, getTask = queryTask, pollMs = 750 }: {
  ids: string[]; assets?: OfflineRepairAsset[]; roots: OfflineRepairRoot[]; request: Request; close: () => void;
  restored?: (assetId: string) => void;
  merged?: (canonicalId: string, donorId: string) => void;
  beforeMerge?: (canonicalId: string, donorId: string) => boolean;
  getTask?: (taskId: string, signal: AbortSignal) => Promise<unknown>; pollMs?: number;
}) {
  const [mergeHistory, setMergeHistory] = useState<{canonical: string; donor: string; operationId: string}[]>([]);
  const [mergePairs, setMergePairs] = useState<{canonical: string; donor: string}[]>([]), [mergeStorageError, setMergeStorageError] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<{ canonical: string; donor: string; operationId?: string } | null>(null);
  const uniqueIds = [...new Set(ids)], selectionKey = uniqueIds.slice().sort().join(","), storageKey = "offline-repair-task:" + selectionKey;
  const [selected, setSelected] = useState(uniqueIds), [targetRoots, setTargetRoots] = useState<string[]>([]);
  const [task, setTask] = useState<Task | null>(null), [scope, setScope] = useState<SavedTask | null>(null);
  const [resume, setResume] = useState<SavedTask | null>(() => readSaved(storageKey, uniqueIds));
  const [sending, setSending] = useState<"start" | "cancel" | "query" | null>(null), [error, setError] = useState("");
  const [paused, setPaused] = useState(false), [confirmFingerprint, setConfirmFingerprint] = useState(false);
  const restoreKey = "offline-restore-intent:" + selectionKey;
  const [readiness, setReadiness] = useState<Readiness | null>(null), [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreIntent, setRestoreIntent] = useState<RestoreIntent | null>(() => restoredIntent(restoreKey, uniqueIds));
  const [restoreOperation, setRestoreOperation] = useState<RestoreOperation | null>(null), [restoreBusy, setRestoreBusy] = useState<string | null>(null), [restoreError, setRestoreError] = useState("");
  const [operationHistory, setOperationHistory] = useState<RestoreOperation[]>([]), [historyCursor, setHistoryCursor] = useState<HistoryCursor | null>(null), [repairPaused, setRepairPaused] = useState(false);
  const restoreGeneration = useRef(0), restoreQuery = useRef<AbortController | null>(null), restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null), notifiedRestore = useRef(new Set<string>());
  const registrationCommand = useRef<{clientCommandId: string; expectedVersion: number; assetIds: string[]} | null>(null);
  const panel = useRef<HTMLDivElement>(null), mounted = useRef(false), generation = useRef(0), busy = useRef(false);
  const current = useRef<SavedTask | null>(null), query = useRef<AbortController | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interval = Number.isFinite(pollMs) ? Math.max(100, Math.min(5000, pollMs)) : 750;
  const active = !!task && ACTIVE.has(task.status), invalid = !selected.length || selected.length > 50 || uniqueIds.some(id => !UUID.test(id));
  const onlineIds = selected.filter(id => assets.some(a => a.id === id && a.online === 1 && !["missing", "offline", "unavailable"].includes(a.file_status || "unknown")));
  const unknownPrevious = !!resume && !task;
  const unresolvedRestore = !!restoreIntent && (!restoreIntent.operationId || restoreOperation?.operationId !== restoreIntent.operationId || restoreOperation.needsRecovery || restoreOperation.inFlight);
  const stopQuery = () => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null; query.current?.abort(); query.current = null; };
  const stopRestoreQuery = () => { restoreQuery.current?.abort(); restoreQuery.current = null; if (restoreTimer.current !== null) clearTimeout(restoreTimer.current); restoreTimer.current = null; };
  const restoreLive = (serial: number) => mounted.current && restoreGeneration.current === serial;
  function acceptOperation(value: unknown, serial: number, notify = false) {
    const op = checkedOperation(value, uniqueIds); if (!restoreLive(serial)) return;
    setRestoreOperation(op);
    if (notify && op.complete && !notifiedRestore.current.has(op.operationId)) { notifiedRestore.current.add(op.operationId); restored?.(op.assetId); }
  }
  async function repairGet(route: string) {
    const controller = new AbortController(); restoreQuery.current = controller;
    const response = await fetch("/api" + route, { signal: controller.signal, credentials: "same-origin" }), value = await response.json();
    if (!response.ok) throw Object.assign(Error("RESTORE_QUERY_FAILED"), { code: value.code || value.error, status: response.status });
    return value as unknown;
  }
  async function restoreAction(kind: string, work: (serial: number) => Promise<void>) {
    if (busy.current || active) return;
    busy.current = true; stopRestoreQuery(); const serial = ++restoreGeneration.current; setRestoreBusy(kind); setRestoreError(""); setRepairPaused(false);
    try { await work(serial); } catch (e) { if (restoreLive(serial)) { setRestoreError(restoreProblem(e)); setRepairPaused(true); } }
    finally { if (restoreLive(serial)) { busy.current = false; setRestoreBusy(null); } }
  }
  function readEnvironment() { void restoreAction("readiness", async serial => { const v = checkedReadiness(await repairGet("/cloud-upload-host/readiness")); if (restoreLive(serial)) setReadiness(v); }); }
  function registerEnvironment() { if (!readiness || invalid) return; void restoreAction("register", async serial => {
    const existing = registrationCommand.current;
    if (!existing || existing.expectedVersion !== readiness.version || JSON.stringify(existing.assetIds) !== JSON.stringify(selected)) registrationCommand.current = { clientCommandId: crypto.randomUUID(), expectedVersion: readiness.version, assetIds: [...selected] };
    const value = checkedReadiness(await request("/cloud-upload-host/register", registrationCommand.current)); if (restoreLive(serial)) setReadiness(value);
  }); }
  function chooseRestore(candidate: Candidate) { if (candidate.targetAssetId || unresolvedRestore) return; void restoreAction("preview", async serial => {
    const v = await request<RestorePreview>("/asset-repairs/preview", { assetId: candidate.sourceAssetId, targetRootId: candidate.targetRootId, targetRelativePath: candidate.targetRelativePath });
    if (!v || !UUID.test(v.previewId) || v.assetId !== candidate.sourceAssetId || v.targetRootId !== candidate.targetRootId || v.targetRelativePath !== candidate.targetRelativePath || !relative(v.targetRelativePath) || !Number.isSafeInteger(v.expiresAt) || v.confirmationRequired !== true || v.contentMatch !== true || v.physicalIdentityProven !== false) throw Error("INVALID_RESTORE_RESPONSE");
    if (restoreLive(serial)) setRestorePreview(v);
  }); }
  function confirmRestore() { const p = restorePreview; if (!p || unresolvedRestore) return; void restoreAction("confirm", async serial => {
    const intent: RestoreIntent = { nonce: crypto.randomUUID(), assetId: p.assetId, previewId: p.previewId, commandId: crypto.randomUUID(), operationId: null };
    saveRestore(restoreKey, intent); setRestoreIntent(intent); setRestorePreview(null); setRestoreOperation(null);
    const op = checkedOperation(await request("/asset-repairs/confirm", { previewId: intent.previewId, commandId: intent.commandId }), uniqueIds);
    if (op.assetId !== intent.assetId || op.targetRootId !== p.targetRootId || op.targetRelativePath !== p.targetRelativePath) throw Error("INVALID_RESTORE_RESPONSE");
    const registered = { ...intent, operationId: op.operationId };
    if (restoredIntent(restoreKey, uniqueIds)?.nonce === intent.nonce) saveRestore(restoreKey, registered);
    if (restoreLive(serial)) { setRestoreIntent(registered); acceptOperation(op, serial, true); }
  }); }
  function queryRestore(id = restoreOperation?.operationId || restoreIntent?.operationId) { void restoreAction("query", async serial => {
    if (id) { const op = checkedOperation(await repairGet(`/asset-repairs/${id}`), uniqueIds); if (op.operationId !== id) throw Error("INVALID_RESTORE_RESPONSE"); acceptOperation(op, serial, restoreIntent?.operationId === id); return; }
    if (!restoreIntent) return;
    const result = await request<{found: boolean; operation?: unknown}>("/asset-repairs/resolve", { assetId: restoreIntent.assetId, previewId: restoreIntent.previewId, commandId: restoreIntent.commandId });
    if (result.found === true) {
      const op = checkedOperation(result.operation, uniqueIds); if (op.assetId !== restoreIntent.assetId) throw Error("INVALID_RESTORE_RESPONSE");
      if (restoreLive(serial)) { const registered = { ...restoreIntent, operationId: op.operationId }; if (restoredIntent(restoreKey, uniqueIds)?.nonce === registered.nonce) saveRestore(restoreKey, registered); setRestoreIntent(registered); acceptOperation(op, serial, true); }
    }
    else if (result.found === false && restoreLive(serial)) setRestoreError("未找到原操作，结果仍未确认；请核对恢复记录，不会自动创建新命令。");
    else throw Error("INVALID_RESTORE_RESPONSE");
  }); }
  function recoverRestore() { const op = restoreOperation; if (!op || op.inFlight) return; void restoreAction("recover", async serial => { const value = checkedOperation(await request(`/asset-repairs/${op.operationId}/recover`, { expectedVersion: op.version }), uniqueIds); if (value.operationId !== op.operationId || value.assetId !== op.assetId) throw Error("INVALID_RESTORE_RESPONSE"); acceptOperation(value, serial, true); }); }
  function readHistory(more = false) { void restoreAction("history", async serial => {
    const result = await request<{items: unknown[]; nextCursor: HistoryCursor | null; complete: boolean}>("/asset-repairs/history", { assetIds: uniqueIds, limit: 20, ...(more && historyCursor ? { after: historyCursor } : {}) });
    if (!result || !Array.isArray(result.items) || result.items.length > 20 || typeof result.complete !== "boolean" || result.complete !== (result.nextCursor === null)) throw Error("INVALID_RESTORE_RESPONSE");
    if (result.nextCursor !== null && (!result.nextCursor || !Number.isSafeInteger(result.nextCursor.createdMs) || result.nextCursor.createdMs < 0 || !UUID.test(result.nextCursor.operationId))) throw Error("INVALID_RESTORE_RESPONSE");
    const merges = result.items.filter(item => (item as {mode?: string} | null)?.mode === "merge").map(item => { const v = item as RestoreOperation & {aliasAssetId: string}; if (!uniqueIds.includes(v.assetId) || !UUID.test(v.operationId) || !UUID.test(v.aliasAssetId) || v.aliasAssetId === v.assetId) throw Error("INVALID_RESTORE_RESPONSE"); return {canonical: v.assetId, donor: v.aliasAssetId, operationId: v.operationId}; });
    if (restoreLive(serial)) setMergeHistory(previous => more ? [...previous, ...merges].slice(-100) : merges);
    const items = result.items.filter(item => (item as {mode?: string} | null)?.mode !== "merge").map(item => checkedOperation(item, uniqueIds)); if (restoreLive(serial)) { setOperationHistory(previous => more ? [...previous, ...items].slice(-100) : items); setHistoryCursor(result.nextCursor); }
  }); }
  function apply(value: unknown, expected: SavedTask, serial: number) {
    if (!mounted.current || generation.current !== serial || current.current?.nonce !== expected.nonce) return;
    const next = checkedTask(value, expected);
    setTask(previous => previous?.id === next.id && !ACTIVE.has(previous.status) && ACTIVE.has(next.status) ? previous : previous?.id === next.id && previous.status === "cancelling" && ["queued", "running"].includes(next.status) ? { ...next, status: "cancelling" } : next);
  }
  function dismiss() { generation.current++; restoreGeneration.current++; mounted.current = false; stopQuery(); stopRestoreQuery(); close(); }
  useEffect(() => {
    setMergeTarget(null); setMergeHistory([]);
    try { setMergePairs(uniqueIds.flatMap(canonical => readMergePairs(canonical).map(donor => ({canonical, donor})))); setMergeStorageError(false); } catch { setMergeStorageError(true); }
    mounted.current = true; generation.current++; current.current = null; busy.current = false;
    setSelected([...new Set(ids)]); setTargetRoots([]); setTask(null); setScope(null); setResume(readSaved(storageKey, uniqueIds)); setSending(null); setError(""); setPaused(false); setConfirmFingerprint(false);
    restoreGeneration.current++; setReadiness(null); setRestorePreview(null); setRestoreIntent(restoredIntent(restoreKey, uniqueIds)); setRestoreOperation(null); setRestoreBusy(null); setRestoreError(""); setOperationHistory([]); setHistoryCursor(null); setRepairPaused(false);
    const previous = document.activeElement as HTMLElement | null; panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { mounted.current = false; generation.current++; restoreGeneration.current++; stopQuery(); stopRestoreQuery(); if (previous?.isConnected) previous.focus(); };
  }, [selectionKey]);
  useEffect(() => {
    function key(e: KeyboardEvent) {
      if (mergeTarget) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); dismiss(); }
      if (e.key === "Tab") {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary") || [])].filter(n => n.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener("keydown", key, true); return () => document.removeEventListener("keydown", key, true);
  });
  useEffect(() => {
    if (!task || !ACTIVE.has(task.status) || paused || !scope?.taskId) return;
    const expected = scope, serial = generation.current, controller = new AbortController(); query.current = controller;
    timer.current = setTimeout(async () => {
      timer.current = null;
      try { apply(await getTask(expected.taskId!, controller.signal), expected, serial); }
      catch (e) { if (!controller.signal.aborted && mounted.current && generation.current === serial && current.current?.nonce === expected.nonce) { setError(problem(e, "query")); setPaused(true); } }
    }, interval);
    return () => { controller.abort(); if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  }, [task, scope, paused, getTask, interval]);
  useEffect(() => {
    if (!restoreOperation?.inFlight || restoreBusy || repairPaused) return;
    const id = restoreOperation.operationId, serial = restoreGeneration.current;
    restoreTimer.current = setTimeout(async () => { try { const op = checkedOperation(await repairGet(`/asset-repairs/${id}`), uniqueIds); if (op.operationId !== id) throw Error("INVALID_RESTORE_RESPONSE"); acceptOperation(op, serial, restoreIntent?.operationId === id); } catch (e) { if (restoreLive(serial)) { setRestoreError(restoreProblem(e)); setRepairPaused(true); } } }, interval);
    return stopRestoreQuery;
  }, [restoreOperation, restoreBusy, repairPaused, interval]);
  async function start(mode: Mode) {
    if (busy.current || active || invalid || unknownPrevious || mode === "preview" && !targetRoots.length || mode === "fingerprint" && (!confirmFingerprint || !onlineIds.length)) return;
    busy.current = true; stopQuery(); const serial = ++generation.current;
    const expected: SavedTask = { nonce: crypto.randomUUID(), taskId: null, mode, assetIds: mode === "fingerprint" ? [...onlineIds] : [...selected], rootIds: mode === "preview" ? [...targetRoots] : [] };
    current.current = expected; setScope(expected); setTask(null); setError(""); setPaused(false); setSending("start"); setResume(expected); save(storageKey, expected);
    try {
      const value = checkedTask(await request("/asset-fingerprints", { mode, assetIds: expected.assetIds, ...(mode === "preview" ? { rootIds: expected.rootIds } : {}) }), expected);
      const registered = { ...expected, taskId: value.id };
      if (readSaved(storageKey, uniqueIds)?.nonce === expected.nonce) save(storageKey, registered);
      if (!mounted.current || generation.current !== serial) return;
      current.current = registered; setScope(registered); setResume(registered); apply(value, registered, serial);
    } catch (e) {
      if (!mounted.current || generation.current !== serial) return;
      setError(problem(e, "start"));
      const status = (e as { status?: number }).status;
      if (status && status >= 400 && status < 500) { save(storageKey, null); setResume(null); current.current = null; setScope(null); }
    } finally { if (mounted.current && generation.current === serial) { busy.current = false; setSending(null); } }
  }
  async function readAgain(record = scope || resume) {
    if (!record?.taskId || busy.current) return;
    busy.current = true; stopQuery(); const serial = ++generation.current; const controller = new AbortController(); query.current = controller;
    current.current = record; setScope(record); setError(""); setSending("query"); setPaused(true);
    try { apply(await getTask(record.taskId, controller.signal), record, serial); if (mounted.current && generation.current === serial) setPaused(false); }
    catch (e) {
      if (!controller.signal.aborted && mounted.current && generation.current === serial) {
        setError(problem(e, "query")); setPaused(true);
        const problemCode = e as { code?: string; status?: number; message?: string };
        if (problemCode.code === "TASK_NOT_FOUND" || problemCode.message === "TASK_NOT_FOUND" || problemCode.status === 404) { save(storageKey, null); setResume(null); setScope(null); setTask(null); current.current = null; }
      }
    } finally { if (mounted.current && generation.current === serial) { busy.current = false; setSending(null); } }
  }
  async function cancel() {
    const expected = current.current; if (!expected?.taskId || busy.current || !active || task?.status === "cancelling") return;
    busy.current = true; setSending("cancel"); setError(""); const serial = generation.current;
    try { apply(await request(`/asset-fingerprints/${expected.taskId}/cancel`, {}, "POST"), expected, serial); }
    catch (e) { if (mounted.current && generation.current === serial) setError(problem(e, "cancel")); }
    finally { if (mounted.current && generation.current === serial) { busy.current = false; setSending(null); } }
  }
  const assetName = (id: string) => label(assets.find(a => a.id === id)?.name, "素材 " + id.slice(0, 8));
  const rootName = (id: string) => label(roots.find(r => r.id === id)?.name, "目录 " + id.slice(0, 8));
  const disabled = active || !!sending || !!restoreBusy || !!restoreOperation?.inFlight;
  if (mergeTarget) return <AssetMergeDialog key={mergeTarget.canonical + ":" + mergeTarget.donor} canonicalAssetId={mergeTarget.canonical} donorAssetId={mergeTarget.donor} initialOperationId={mergeTarget.operationId} assets={assets} roots={roots} request={request} close={() => setMergeTarget(null)} completed={merged} beforeConfirm={beforeMerge}/>;
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) dismiss(); }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-label="尝试修复离线素材" className="modal" style={{ width: "min(760px, calc(100vw - 24px))", maxHeight: "calc(100dvh - 24px)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div className="modal-head"><h2>尝试修复离线素材</h2><button className="icon-button" title="关闭；不会取消已启动任务" aria-label="关闭尝试修复" onClick={dismiss}><X size={17}/></button></div>
      <div className="modal-body" style={{ overflowY: "auto", minHeight: 0, overflowWrap: "anywhere" }}>
        <p>先查找内容一致的候选。选择位置并明确确认前，不会执行恢复；不会移动文件。</p>
        {mergeStorageError && <p role="alert">本机合并确认记录无法读取，请保留现场；没有自动重建或提交。</p>}
        {mergePairs.length > 0 && <section aria-label="上次合并记录"><p>有已保存的合并确认记录；无需重新扫描，先查询原结果。</p>{mergePairs.map(pair => <button key={pair.canonical+pair.donor} disabled={disabled} onClick={() => setMergeTarget(pair)} aria-label={"核对上次合并："+pair.donor}>核对上次合并：{assetName(pair.canonical)} / {pair.donor.slice(0,8)}</button>)}</section>}
        <fieldset disabled={disabled} style={{ minWidth: 0 }}><legend>旧素材：已选 {selected.length} 条（最多 50 条）</legend>
          <div style={{ maxHeight: 160, overflowY: "auto" }}>{uniqueIds.map(id => <label key={id} style={{ display: "flex", alignItems: "baseline", gap: 8 }}><input type="checkbox" style={{ width: "auto", flexShrink: 0 }} aria-label={"选择旧素材：" + assetName(id)} checked={selected.includes(id)} onChange={e => { setSelected(before => e.target.checked ? [...before, id] : before.filter(v => v !== id)); setConfirmFingerprint(false); }}/><span>{assetName(id)}</span></label>)}</div>
        </fieldset>
        {invalid && <p role="alert">请选择 1–50 条有效旧记录；不会自动截取前 50 条。</p>}
        <fieldset disabled={disabled} style={{ minWidth: 0, marginTop: 12 }}><legend>选择目标登记目录（最多 16 个）</legend>
          {!roots.some(r => !r.retired) && <p>没有可选登记目录，请先核对目录管理。</p>}
          {roots.filter(r => !r.retired).map(r => <label key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 8 }}><input type="checkbox" style={{ width: "auto", flexShrink: 0 }} aria-label={"搜索目录：" + rootName(r.id)} disabled={r.online === 0 || !targetRoots.includes(r.id) && targetRoots.length >= 16} checked={targetRoots.includes(r.id)} onChange={e => setTargetRoots(before => e.target.checked ? [...before, r.id] : before.filter(id => id !== r.id))}/><span>{rootName(r.id)}{r.online === 0 ? "（离线）" : ""}</span></label>)}
        </fieldset>
        {!task && resume && <div className="missing-cleanup-item"><p>{resume.taskId ? "有上次任务记录。先查询其状态，避免重复启动；打开弹窗不会自动扫描。" : "上次启动结果未确认，请先查看任务；不会自动重新开始。"}</p>
          {resume.taskId ? <button disabled={!!sending} onClick={() => void readAgain(resume)}>查询上次任务</button> : <button disabled={!!sending} onClick={() => { const latest = readSaved(storageKey, uniqueIds); if (latest?.taskId) setResume(latest); else { save(storageKey, null); setResume(null); setError("请先确认先前任务已结束，再明确开始新任务。"); } }}>核对后刷新任务记录</button>}
        </div>}
        {task && <section aria-label="指纹任务进度" style={{ marginTop: 14 }}>
          <p role="status">{STATES[task.status]}{paused ? " · 查询已暂停，以下为上次返回状态" : ""} · 已检查 {task.checked} 个文件 · 实际读取 {(task.bytesRead / 1048576).toFixed(2)} MiB</p>
          <p>本批剩余：{task.remainingSelected === null ? "尚未统计" : `${task.remainingSelected} 条（不是全范围总量）`}{task.mode === "fingerprint" ? `；确认保存指纹 ${task.saved} 条` : ""}</p>
          {ACTIVE.has(task.status) && !paused && <progress aria-label="任务进行中" style={{ width: "100%" }}/>}
          {!ACTIVE.has(task.status) && (!task.searchComplete || task.selectionTruncated || task.resultTruncated) && <p className="database-error">本次范围未完整覆盖，候选可能不全，不能据此判断唯一；继续检查需要再次明确选择。</p>}
          <p>SHA 相同只证明内容一致，不证明是同一物理文件。此处为候选检查快照，恢复结果以下方操作状态为准。</p>
          {(scope?.assetIds || []).map(id => {
            const matches = task.candidates.filter(c => c.sourceAssetId === id), item = task.items.find(i => i.assetId === id), issue = task.issues.find(i => i.assetId === id);
            const text = issue ? reasons[issue.code] || "本次未能核实该记录，请检查文件和目录状态。" : item?.state === "saved" ? "内容指纹已确认保存；尚未执行修复。" : item?.state === "no_trusted_fingerprint" ? reasons.NO_TRUSTED_FINGERPRINT : item?.state === "original_present" ? reasons.ORIGINAL_PRESENT : matches.length ? `发现 ${matches.length} 个内容一致候选${matches.length > 1 || matches.some(c => c.ambiguous) ? "，存在歧义，需核对全部候选" : "，仍需人工核对"}` : ACTIVE.has(task.status) ? "任务尚未结束。" : task.searchComplete ? "本次所选范围未找到内容一致候选。" : "本次未完成覆盖，不能据此排除候选。";
            return <div className="missing-cleanup-item" key={id}><strong>{assetName(id)}</strong><p>{text}</p>{matches.map((c, i) => <div key={`${c.targetRootId}:${c.targetRelativePath}:${i}`} style={{ borderLeft: "2px solid currentColor", paddingLeft: 10, marginTop: 8 }}><span>{rootName(c.targetRootId)} / {c.targetRelativePath}</span><p>{c.targetAssetId ? "已有素材记录，待确认合并；尚未执行。" : "内容一致候选，尚未重新关联。"}{c.ambiguous ? " 存在多个来源或目标。" : ""}</p>{c.targetAssetId && <button disabled={disabled || unresolvedRestore} onClick={() => setMergeTarget({ canonical: c.sourceAssetId, donor: c.targetAssetId! })} aria-label={"合并记录：" + c.targetRelativePath}>合并记录</button>}{!c.targetAssetId && <button disabled={disabled || unresolvedRestore} onClick={() => chooseRestore(c)} aria-label={"核对恢复位置：" + c.targetRelativePath}>核对这个位置</button>}</div>)}</div>;
          })}
          {task.issues.filter(i => i.assetId === null).map((i, index) => <p key={index}>{reasons[i.code] || "部分文件或目录未能核实，本次结果不完整。"}</p>)}
          {paused && <button disabled={!!sending} onClick={() => void readAgain()}>重新查询任务</button>}
        </section>}
        <section aria-label="恢复环境与操作" style={{ marginTop: 16 }}>
          <h3>恢复确认</h3><p>原 ID 和人工元数据保留；已有另一条记录的目标需要后续合并，本处不会覆盖。</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><button disabled={disabled} onClick={readEnvironment}>核对恢复环境</button><button disabled={disabled || invalid} onClick={() => readHistory()}>核对恢复记录</button></div>
          {readiness && <div><p>{readiness.ready ? "已登记实际上传存储；每次恢复仍会重新核验。" : readiness.phase === "NOT_REGISTERED" ? "本库上传存储尚未登记，核验实际账本和资源后才能恢复。" : readiness.phase === "REGISTERING" ? "登记处理中，请稍后明确核对。" : readiness.phase === "INIT_PENDING" ? "登记未全部完成，已保留待核现场；不会自动重建。" : restoreProblem({code:readiness.code})}</p>{readiness.phase === "NOT_REGISTERED" && readiness.canRegister && <button disabled={disabled || invalid} onClick={registerEnvironment}>核验并登记本库上传存储</button>}</div>}
          {restoreIntent && !restoreOperation && <p>有上次确认记录，结果须向服务核对。<button disabled={disabled} onClick={() => queryRestore()}>核对上次确认结果</button></p>}
          {restorePreview && <section aria-label="所选位置确认" className="missing-cleanup-item"><p>核对位置：{rootName(restorePreview.targetRootId)} / {restorePreview.targetRelativePath}</p><p>将原 ID 重新关联到所选内容一致文件，保留原标签、备注、收藏和确认；不会移动文件，也不会合并其它记录。</p><button className="primary" disabled={disabled || unresolvedRestore || Date.now() >= restorePreview.expiresAt} onClick={confirmRestore}>确认恢复原 ID</button></section>}
          {restoreOperation && <section aria-label="实际恢复状态" className="missing-cleanup-item"><p role="status">{RESTORE_PHASES[restoreOperation.phase]}{restoreOperation.inFlight ? " · 操作仍在处理中" : ""}</p><p>{assetName(restoreOperation.assetId)} → {rootName(restoreOperation.targetRootId)} / {restoreOperation.targetRelativePath}</p><button disabled={!!restoreBusy} onClick={() => queryRestore()}>查询当前恢复状态</button>{restoreOperation.needsRecovery && <button disabled={disabled} onClick={recoverRestore}>{restoreOperation.phase === "PREPARED" ? "核对并中止未提交操作" : "补齐恢复镜像"}</button>}</section>}
          {mergeHistory.map(item => <p key={item.operationId}>这是合并记录，需在合并界面核对。<button disabled={disabled} aria-label={"查看合并记录："+item.operationId} onClick={() => setMergeTarget(item)}>查看合并记录</button></p>)}
          {operationHistory.map(op => <div key={op.operationId} className="missing-cleanup-item"><span>{assetName(op.assetId)}：{RESTORE_PHASES[op.phase]}</span><button disabled={disabled} onClick={() => queryRestore(op.operationId)} aria-label={"查看恢复操作：" + op.operationId}>查看操作状态</button></div>)}
          {historyCursor && <button disabled={disabled} onClick={() => readHistory(true)}>更多恢复记录</button>}
          {restoreBusy && <p role="status">{restoreBusy === "register" ? "正在核验并登记实际存储…" : restoreBusy === "confirm" ? "正在确认恢复，关闭不会撤销请求…" : "正在核对恢复状态…"}</p>}
          {restoreError && <p role="alert" className="database-error">{restoreError}</p>}
        </section>
        <details style={{ marginTop: 12 }}><summary>需要预先建立文件指纹？</summary><p>只可为所选显示在线的素材建立指纹，任务会再次核对实际文件。不能对已经搬走的旧文件补造历史指纹。</p><label style={{ display: "flex", alignItems: "baseline", gap: 8 }}><input type="checkbox" style={{ width: "auto" }} checked={confirmFingerprint} disabled={disabled || !onlineIds.length} onChange={e => setConfirmFingerprint(e.target.checked)}/><span>确认仅为所选 {onlineIds.length} 条显示在线的素材建立内容指纹</span></label><button disabled={disabled || invalid || unknownPrevious || !onlineIds.length || !confirmFingerprint} onClick={() => void start("fingerprint")}><Fingerprint size={15}/>建立所选在线素材指纹</button>{!onlineIds.length && <p>所选记录未显示在线，不能追补移动前指纹。</p>}</details>
        {error && <p role="alert" className="database-error">{error}</p>}
      </div>
      <div className="modal-footer" style={{ flexWrap: "wrap", gap: 8 }}><small style={{ marginRight: "auto" }}>关闭仅停止弹窗查询，不会取消已启动任务。</small><button onClick={dismiss}>关闭</button>{active && <button disabled={!!sending || task?.status === "cancelling"} onClick={() => void cancel()}><Square size={15}/>{sending === "cancel" ? "请求停止中…" : "请求停止任务"}</button>}<button className="primary" disabled={disabled || invalid || unknownPrevious || !targetRoots.length} onClick={() => void start("preview")}><Search size={15}/>{sending === "start" ? "正在提交…" : "尝试修复"}</button></div>
    </div>
  </div>;
}
