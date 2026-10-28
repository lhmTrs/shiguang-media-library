import express from "express";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Library, run } from "./library.mjs";
import { publicRepairCode, mergeAlias } from "./asset-repair.mjs";
import { CloudUploadHost } from "./cloud-upload-host.mjs";
import { CloudUploadTaskRuntime, runFileStatusMaintenance } from "./cloud-upload-task-runtime.mjs";
import { createCloudUploadTaskEntry, TASK_ENTRY_BASE, taskMayReadRemote } from "./cloud-upload-task-entry.mjs";
import { fingerprint as taskFingerprint } from "./cloud-upload-protocol.mjs";
import { assetSeriesList, assetSeriesMembers, assetSeriesAdjacent } from "./asset-series.mjs";
import { MysqlStorage } from "./mysql.mjs";
import { CloudAuth, cloudAuthErrorHandler } from "./cloud-auth.mjs";
import { AudioEngine, isAudioEngineError } from "./audio-engine.mjs";
import { AudioAnalysis } from "./audio-analysis.mjs";
import { audioFeatureEnabled, rejectAudioFeature } from "./audio-feature.mjs";
import { CloudAudioUpload, CloudUploadError, manualAudioAdmission } from "./cloud-audio-upload.mjs";
import { CloudManagement, cloudManagementErrorHandler } from "./cloud-management.mjs";
import { cloudAudioFeatureEnabled } from "./cloud-audio-feature.mjs";
import {
  CloudAudioService,
  CloudAudioServiceError,
  CLOUD_AUDIO_DISABLED,
  CLOUD_AUDIO_MESSAGES,
} from "./cloud-audio-service.mjs";
import { loadReleaseConfig } from "./cloud-release-config.mjs";
import { DeviceEnrollment } from "./device-enrollment.mjs";
import { Tags } from "./tags.mjs";
import { MusicAnalysis } from "./music-analysis.mjs";
import { AssetFingerprints } from "./asset-fingerprints.mjs";
import { MissingFiles } from "./missing-files.mjs";
import { RootRemoval } from "./root-removal.mjs";
import { DuplicateAudio } from "./duplicate-audio.mjs";
import { Projects } from "./projects.mjs";
import { FolderBrowser } from "./folder-browser.mjs";
import { MetadataBatches, metadataCapabilities } from "./metadata-batches.mjs";
import { createManifestSync, reconcileRoot, relocateRoot, startWatcher } from "./reconcile.mjs";
import { dataDirectory } from "./runtime.mjs";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = dataDirectory(project);
const audioRuntimeConfigPath =
  process.env.SHIGUANG_AUDIO_RUNTIME_CONFIG || path.join(project, "config/audio-analysis-runtime.json");
const trashSource = path.join(project, "server/trash.swift");
const trashVersion = crypto
  .createHash("sha256")
  .update(await fs.readFile(trashSource))
  .digest("hex")
  .slice(0, 12);
const trashBin = path.join(dataDir, "trash-helper-" + trashVersion);
await fs.mkdir(dataDir, { recursive: true });
let nativeTrash;
if (process.platform === "darwin") {
  try {
    await fs.access(trashBin);
    nativeTrash = trashBin;
  } catch {
    try {
      await run(
        "swiftc",
        [path.join(project, "server/trash.swift"), "-o", trashBin],
        { timeout: 90000 },
      );
      nativeTrash = trashBin;
    } catch (e) {
      console.warn("废纸篓组件不可用，删除操作已禁用：", e.message);
    }
  }
}
const mysqlStorage = await new MysqlStorage(dataDir).init();
const lib = await new Library(dataDir, {
  trashBin: nativeTrash,
  database: mysqlStorage.database,
  directoryClassification: true,
}).init();
mysqlStorage.attach(lib);
// 目录监听句柄：启动对账之后才赋值，路由 /api/reconcile 会读它报告监听状态
let reconcileWatcher = null;
// 元数据（标签/备注/分类）改动后防抖刷新清单：让"GPT 直接读 .shiguang/manifest.json"看到最新值
const manifestSync = createManifestSync(lib, { log: (m) => console.log(m) });
lib.onMetadataChanged = (rootId) => manifestSync.touch(rootId);
const assetFingerprints = new AssetFingerprints(lib);
const categories = lib.directoryClassification;
const tags = new Tags(lib).init();
const projects = new Projects(lib).init();
const metadataBatches = new MetadataBatches(lib).init();
const folderBrowser = new FolderBrowser(lib);
const musicAnalysis = await new MusicAnalysis(lib).init();
// 云端认证适配：令牌/私钥只在本进程，浏览器只拿到脱敏状态（T-LOCAL-CLOUD-001）
const cloudAuth = await new CloudAuth(lib, { dataDir }).init();

// 音频分析：默认关闭，只有运维显式设置 SHIGUANG_AUDIO_ANALYSIS=1 才按需创建实例。
// 默认启动不建表、不联网、不下载、不 spawn；HTTP 不能改这个开关。
const audioEnabled = audioFeatureEnabled();
let audioEngine = null;
let audioAnalysis = null;
function audioFeature() {
  if (!audioEnabled) return null;
  if (!audioAnalysis) {
    audioEngine = new AudioEngine(dataDir);
    audioAnalysis = new AudioAnalysis(lib, audioEngine, {
      dataDir,
      runtimeConfigPath: audioRuntimeConfigPath,
    });
  }
  return { engine: audioEngine, analysis: audioAnalysis };
}
function rejectAudioAnalysis(res, error) {
  // 适配器只交固定 {code,message,status}；未知异常不拼接原始 message。
  const known = Number.isInteger(error?.status) && [400, 404, 409, 429, 503].includes(error.status);
  const status = known ? error.status : 400;
  const code = typeof error?.code === "string" ? error.code : "ANALYZE_FAILED";
  const message = known && typeof error?.message === "string" ? error.message : "音频分析失败";
  return res.status(status).json({ error: message, code });
}
// 内置发行配置只含公共地址/CA；原始仓库默认未启用，未就绪时普通用户只看到提示。
const releaseConfig = await loadReleaseConfig(
  process.env.SHIGUANG_CLOUD_RELEASE_CONFIG || path.join(project, "config/cloud-release.json"),
);
const deviceEnrollment = await new DeviceEnrollment(lib, { dataDir, cloudAuth, release: releaseConfig }).init();
// T-LOCAL-008：管理接口固定白名单适配；浏览器不能直接决定云端 URL/方法/头。
const cloudManagement = new CloudManagement(lib, { cloudAuth });
// Cloud transfers are available by default, but remain manual and authenticated.
const cloudTransfersEnabled = cloudAudioFeatureEnabled();
const cloudAudio = await new CloudAudioService(lib, {
  dataDir,
  cloudAuth,
  enabled: cloudTransfersEnabled,
}).init();
const cloudUpload = await new CloudAudioUpload(lib, { dataDir, cloudAuth, enabled: cloudTransfersEnabled }).init();
const cloudTransferAdmission = manualAudioAdmission(() => cloudAudio.status());
const missingFiles = new MissingFiles(lib, () => mysqlStorage.migrating || musicAnalysis.active || musicAnalysis.testing || duplicateAudio.marking || lib.locks.size > 0 || cacheJobs.size > 0 || [...lib.jobs.values()].some(j => j.type !== "cleanup" && j.status === "running"));
const duplicateAudio = new DuplicateAudio(lib, () => mysqlStorage.migrating || musicAnalysis.active || musicAnalysis.testing || lib.locks.size > 0 || [...lib.jobs.values()].some(j => j.type !== "duplicates" && j.status === "running"));
const rootRemoval = new RootRemoval(lib, () => mysqlStorage.migrating || musicAnalysis.active || musicAnalysis.testing || duplicateAudio.marking || missingFiles.active || cacheJobs.size > 0);
const uploadHost = await new CloudUploadHost(lib, { upload: cloudUpload, sourceId: mysqlStorage.sourceId, readMaintenance: async () => {
  const status = await cloudAudio.status();
  const known = Number.isSafeInteger(status.active) && Number.isSafeInteger(status.queued) && status.active >= 0 && status.queued >= 0 && Number.isSafeInteger(status.staleTempFiles) && status.staleTempFiles >= 0 && typeof status.receiverFaulted === "boolean" && typeof status.staleTempUnreadable === "boolean";
  return { known, allowed: known && !status.active && !status.queued && !status.receiverFaulted && !status.staleTempUnreadable && !status.staleTempFiles && !mysqlStorage.migrating && !rootRemoval.active && !duplicateAudio.marking && !missingFiles.active && !musicAnalysis.active && !musicAnalysis.testing && !cacheJobs.size };
} }).init();
// One task owner per actual application attachment. No registration, scan,
// recovery or scheduling occurs while constructing or opening this entry.
let taskEntry = null;
let taskRuntime = null;
let taskClosing = false;
let applicationClosing = false;
let identityChanging = false;
const lifecycleReads = new Set();
let viteServer = null;
let taskPermission = null;
let taskDiskObservation = null;
const taskError = (code, status = 503) => Object.assign(Error(code), { code, status });
const taskIdentity = () => {
  const state = cloudAuth.getState();
  if (!state.configured || state.state !== "logged-in" || !state.accountId || !state.deviceId || !Number.isSafeInteger(cloudAuth.epoch)) throw taskError("NOT_LOGGED_IN", 401);
  const origin = cloudAuth.config?.origin;
  if (typeof origin !== "string") throw taskError("SERVICE_IDENTITY_UNKNOWN");
  return { cloudServiceKey: crypto.createHash("sha256").update(new URL(origin).origin).digest("hex"), accountId: state.accountId, deviceId: state.deviceId, librarySourceId: uploadHost.sourceId, epoch: cloudAuth.epoch };
};
const taskIdentityKey = () => JSON.stringify(taskIdentity());
const taskActivity = () => {
  const current = cloudAudio.currentActivity();
  const flags = [mysqlStorage.migrating, rootRemoval.active, duplicateAudio.marking, musicAnalysis.active, musicAnalysis.testing];
  const missingKnown = missingFiles.active === null || missingFiles.active instanceof Promise;
  const known = missingKnown && current?.known === true && flags.every(v => typeof v === "boolean" || Number.isSafeInteger(v) && v >= 0) && cacheJobs instanceof Map && cloudUpload.lib === lib && cloudUpload.auth === cloudAuth && uploadHost.lib === lib && uploadHost.upload === cloudUpload && uploadHost.db === lib.db;
  return { known, allowed: known && missingFiles.active === null && current.allowed === true && !flags.some(Boolean) && cacheJobs.size === 0 && !taskClosing };
};
async function taskVerifyPermission() {
  taskPermission = null;
  const key = taskIdentityKey(), me = await cloudAuth.me();
  if (taskIdentityKey() !== key) throw taskError("AUTH_CHANGED", 409);
  const state = cloudAuth.getState();
  // The original upload actor contract requires a current authenticated session.
  // Target/group grants and protocol readiness remain checked by the original
  // remote operations; this is not a fabricated global upload permission.
  const allowed = me?.accountId === state.accountId && me?.deviceId === state.deviceId && me?.sessionId === state.sessionId;
  if (allowed) taskPermission = { key, observed: performance.now() };
  return { known: true, allowed };
}
async function taskReadPermission() {
  if (taskMayReadRemote()) return taskVerifyPermission();
  const current = taskPermission && taskPermission.key === taskIdentityKey() && performance.now() - taskPermission.observed <= 10000;
  return { known: !!current, allowed: !!current };
}
async function taskReadMaintenance() {
  if (!taskMayReadRemote()) {
    const current = taskActivity(), stored = taskDiskObservation;
    const known = current.known && stored?.key === taskIdentityKey() && performance.now() - stored.observed <= 10000;
    return { known, allowed: known && current.allowed && stored.allowed === true };
  }

  const key = taskIdentityKey(), value = await cloudAudio.status();
  if (taskIdentityKey() !== key) throw taskError("AUTH_CHANGED", 409);
  const fresh = taskActivity();
  const known = fresh.known && [value.active, value.queued, value.staleTempFiles].every(n => Number.isSafeInteger(n) && n >= 0) && typeof value.receiverFaulted === "boolean" && typeof value.staleTempUnreadable === "boolean";
  const allowed = known && fresh.allowed && value.active === 0 && value.queued === 0 && value.staleTempFiles === 0 && !value.receiverFaulted && !value.staleTempUnreadable;
  taskDiskObservation = known ? { key, observed: performance.now(), allowed } : null;
  return { known, allowed };
}
function taskLocalGuard(req, { write }) {
  const cookie = req.headers.cookie?.match(/(?:^|; )media_session=([^;]+)/)?.[1];
  const value = cookie && sessions.get(cookie);
  return { allowed: !!value && req.headers.host === `127.0.0.1:${port}` && (!req.headers.origin || req.headers.origin === `http://127.0.0.1:${port}`) && !["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]) && (!write || req.headers["x-local-token"] === value), sessionId: cookie || null };
}
function taskLocalRoots() {
  const rows = lib.db.prepare("SELECT id,substr(name,1,181) name,kind FROM roots WHERE COALESCE(retired,0)=0 AND kind IN ('music','sfx','mixed') ORDER BY id LIMIT 33").all();
  const rootsOverflow = rows.length > 32, rootMetadataUnknown = rows.some(row => typeof row.name !== "string" || row.name.length > 180);
  return { rootsOverflow, rootMetadataUnknown, roots: rootsOverflow || rootMetadataUnknown ? [] : rows.map(row => ({ rootId: row.id, name: row.name || "素材目录", kind: row.kind })) };
}
function ensureTaskEntry() {
  if (taskClosing || identityChanging || applicationClosing) throw taskError("ENTRY_CLOSED");
  if (taskEntry) return taskEntry;
  taskIdentity();
  taskRuntime = new CloudUploadTaskRuntime({ lib, upload: cloudUpload, cloudAuth, host: uploadHost, manualAudioAdmission: cloudTransferAdmission, currentIdentity: taskIdentity,
    guardLocalRequest: taskLocalGuard, readPermission: taskReadPermission, readMaintenance: taskReadMaintenance, readActivity: async () => taskActivity(),
    assertHostRegistrationCurrent: () => {
      const fresh = taskActivity();
      return fresh.known === true && fresh.allowed === true && taskPermission !== null && taskPermission.key === taskIdentityKey() && performance.now() - taskPermission.observed <= 10000 && !taskClosing;
    }
  });
  taskEntry = createCloudUploadTaskEntry({ runtime: taskRuntime, host: uploadHost, currentIdentity: taskIdentity, guardLocalRequest: taskLocalGuard,
    verifySession: async () => { const permission = await taskVerifyPermission(), maintenance = await taskReadMaintenance(); return { known: permission.known && maintenance.known, allowed: permission.allowed && maintenance.allowed }; },
    readGroups: async () => {
      const key = taskIdentityKey(), profile = await cloudManagement.profile();
      const state = cloudAuth.getState(), groups = profile?.capabilities?.groups;
      if (taskIdentityKey() !== key || profile?.me?.accountId !== state.accountId || profile?.me?.deviceId !== state.deviceId || profile?.me?.sessionId !== state.sessionId) throw taskError("AUTH_CHANGED", 409);
      if (!Array.isArray(groups) || groups.length > 100 || groups.some(group => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(group.groupId) || typeof group.name !== "string" || group.name.length > 180 || /[\u0000-\u001f\u007f]/.test(group.name)) || new Set(groups.map(group => group.groupId)).size !== groups.length) throw taskError("GROUP_SCOPE_UNKNOWN");
      return { groups: groups.filter(group => group.state === "ACTIVE").map(group => ({ groupId: group.groupId, name: group.name || "已登记小组" })) };
    },
    readLocalStatus: () => ({ identityKey: taskFingerprint(taskIdentity()), proofAdmission: (() => {
      try { const rows = lib.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cloud_upload_scan_%' LIMIT 16").all();
        if (!rows.length) return { known: true, mode: "REGISTER", expectedVersion: 0 };
        const value = taskRuntime.proof.schema({ functionRequired: false });
        if (value.proofs.some(proof => proof.lease_id)) return { known: false, code: "SCAN_PROOF_OWNER_UNKNOWN" };
        return { known: true, mode: "OPEN_SESSION", expectedVersion: value.reg.version };
      } catch { return { known: false }; }
    })(), ...taskLocalRoots(), engine: lib.db.kind === "mysql" ? "mysql" : "sqlite", registrationAssetIds: lib.db.prepare("SELECT id FROM assets WHERE trashed=0 AND online=1 AND kind IN ('music','sfx') AND " + lib.activeAssetScope() + " LIMIT 1").all().map(r => r.id) })
  });
  return taskEntry;
}
async function drainTaskEntry({ ownHostActive = 0 } = {}) {
  taskClosing = true; taskPermission = null; taskDiskObservation = null;
  if (taskEntry) {
    const exit = await taskEntry.dispose({ timeoutMs: 10000 });
    if (exit.closed !== true) throw taskError("TASK_OWNER_UNSETTLED", 423);
  }
  const deadline = Date.now() + 10000;
  let chainsSettled = false;
  if (!(cloudAuth.controlChain instanceof Promise) || !(cloudAuth.persistChain instanceof Promise)) throw taskError("TASK_OWNER_UNSETTLED", 423);
  const controlPromise = cloudAuth.controlChain, persistPromise = cloudAuth.persistChain;
  Promise.allSettled([controlPromise, persistPromise]).then(() => { chainsSettled = true; });
  const idle = () => {
    const receiver = cloudAudio.currentActivity();
    return receiver.known === true && receiver.allowed === true && chainsSettled && cloudAuth.controlChain === controlPromise && cloudAuth.persistChain === persistPromise && cloudAuth.activeRequests instanceof Set && cloudAuth.activeRequests.size === 0 && cloudAuth.inflightRefresh === null &&
      uploadHost.active === ownHostActive && uploadHost.db === lib.db && cloudUpload.lib === lib && cloudUpload.auth === cloudAuth &&
      cloudUpload.busy === false && cloudUpload.controllers.size === 0 && cloudUpload.operations.size === 0 && cloudUpload.settledTasks.size === 0 && cloudUpload.inspections.size === 0 &&
      lib.workers === 0 && lib.metadataPending.size === 0 && lib.metadataQueue.length === 0 && lib.repairIndexReaders === 0 && lib.jobs.size <= 5000 &&
      ![...lib.jobs.values()].some(job => !['done','failed','partial','cancelled','interrupted'].includes(job.status)) &&
      !mysqlStorage.migrating && !rootRemoval.active && !duplicateAudio.marking && missingFiles.active === null && !musicAnalysis.active && !musicAnalysis.testing && cacheJobs.size === 0;
  };
  while (!idle() || lifecycleReads.size) {
    if (Date.now() >= deadline) throw taskError("TASK_OWNER_UNSETTLED", 423);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const actual = Promise.resolve().then(() => cloudAudio.status()); lifecycleReads.add(actual);
  actual.then(() => lifecycleReads.delete(actual), () => lifecycleReads.delete(actual));
  let timer;
  const disk = await Promise.race([actual, new Promise(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); })]).finally(() => clearTimeout(timer));
  if (!disk || !idle() || ![disk.active,disk.queued,disk.staleTempFiles].every(value => Number.isSafeInteger(value) && value === 0) || disk.receiverFaulted !== false || disk.staleTempUnreadable !== false) throw taskError("TASK_OWNER_UNSETTLED", 423);
  taskEntry = null; taskRuntime = null;
}

for (const a of lib.db
  .prepare(
    "SELECT id FROM assets WHERE (probe='pending' OR capture_status='pending') AND online=1 AND trashed=0 AND " + lib.activeAssetScope(),
  )
  .all())
  lib.enqueue(a.id);
const app = express();
app.disable("x-powered-by");
app.use("/api/projects/:id/timeline-import/preview", express.json({ limit: "10mb" }));
app.use("/api/projects/:id/timeline-import/confirm", express.json({ limit: "1mb" }));
app.use("/api/projects/timeline-import/preview", express.json({ limit: "10mb" }));
app.use("/api/projects/timeline-import/confirm", express.json({ limit: "1mb" }));
const ordinaryJson = express.json({ limit: "256kb" });
app.use((req, res, next) => {
  const pathname = req.url.split("?")[0];
  return pathname === TASK_ENTRY_BASE || pathname.startsWith(TASK_ENTRY_BASE + "/") ? next() : ordinaryJson(req, res, next);
});
const sessions = new Map();
let port;
const asyncRoute = (fn) => (req, res, next) => {
  const route = req.route?.path || req.originalUrl.split("?")[0];
  const registration = route === "/api/cloud-upload-host/register";
  const fileStatusMaintenance = req.method === "POST" && route === "/api/maintenance/files";
  const maintenance = req.method !== "GET" && (route === "/api/mysql" || route === "/api/roots/:id/relocate" || req.method === "DELETE" && route === "/api/roots/:id" || ["/api/maintenance/files/cleanup", "/api/duplicate-audio/cleanup", "/api/asset-metadata-registration/confirm", "/api/asset-metadata-registration/commands/:id/finalize", "/api/asset-metadata-registration/commands/:id/abort"].includes(route));
  const changesAttachment = req.method !== "GET" && (route === "/api/mysql" || ["/api/cloud-auth/config", "/api/cloud-auth/enroll", "/api/cloud-auth/recover-device", "/api/cloud-auth/activate", "/api/cloud-auth/login", "/api/cloud-auth/logout"].includes(route));
  const invoke = async () => {
    if (!changesAttachment) return fn(req, res, next);
    if (identityChanging) throw taskError("TASK_OWNER_UNSETTLED", 423);
    identityChanging = true; let drained = false;
    try { await drainTaskEntry({ ownHostActive: 1 }); drained = true; return await fn(req, res, next); }
    finally { identityChanging = false; if (drained) taskClosing = false; }
  };
  // File-status checks write assets too. Use the same HOST/manual gate for the
  // passive task-owner decision and every write, including forced UI checks.
  const fileWork = async () => {
    let invoked = false;
    const result = await runFileStatusMaintenance({ lib, upload: cloudUpload, host: uploadHost,
      manualAudioAdmission: cloudTransferAdmission, readRuntime: () => taskRuntime }, () => { invoked = true; return invoke(); });
    if (!invoked) res.json(result);
  };
  return (fileStatusMaintenance ? fileWork() : registration ? Promise.resolve().then(invoke) : uploadHost.track(invoke, { maintenance })).catch(e => {
    if (["HOST_BUSY", "TASK_OWNER_UNSETTLED"].includes(e.code)) return res.status(423).json({ error: e.code, code: e.code });
    next(e);
  });
};
app.use((req, res, next) => {
  if (applicationClosing) return res.status(503).json({ error: "APPLICATION_CLOSING", code: "APPLICATION_CLOSING" });
  const expected = `127.0.0.1:${port}`;
  if (req.headers.host !== expected)
    return res.status(403).json({ error: "仅允许本机地址访问" });
  if (req.headers.origin && req.headers.origin !== `http://${expected}`)
    return res.status(403).json({ error: "拒绝跨站访问" });
  if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]))
    return res.status(403).json({ error: "拒绝跨站访问" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
app.get("/api/session", (req, res) => {
  const cookie = req.headers.cookie?.match(
    /(?:^|; )media_session=([^;]+)/,
  )?.[1];
  let token = cookie && sessions.get(cookie);
  let session = cookie;
  if (!token) {
    session = crypto.randomBytes(32).toString("hex");
    token = crypto.randomBytes(32).toString("hex");
    sessions.set(session, token);
    res.cookie("media_session", session, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    token,
    trashAvailable: !!nativeTrash,
    folderPickerAvailable: process.platform === "darwin" && process.env.MEDIA_CONTAINER !== "1",
    instanceId: mysqlStorage.sourceId,
    app: "shiguang-local-media",
  });
});
app.use("/api", (req, res, next) => {
  const cookie = req.headers.cookie?.match(
    /(?:^|; )media_session=([^;]+)/,
  )?.[1];
  const token = cookie && sessions.get(cookie);
  if (!token)
    return res.status(401).json({ error: "本机会话失效，请刷新页面" });
  if (req.method !== "GET" && req.headers["x-local-token"] !== token)
    return res.status(403).json({ error: "本机会话校验失败" });
  if (identityChanging && !(req.method === "GET" && req.path === "/cloud-auth/status")) return res.status(423).json({ error: "IDENTITY_CHANGING", code: "IDENTITY_CHANGING" });
  // The same gate includes synchronous API handlers while registration/maintenance
  // owns an awaited operation; response closure never releases that ownership.
  if (uploadHost.exclusive) return res.status(423).json({ error: "HOST_BUSY", code: "HOST_BUSY" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.get("/api/stats", (req, res) => res.json(lib.stats()));
app.use("/api", (req, res, next) => {
  if (rootRemoval.active && req.method !== "GET") return res.status(423).json({ error: "正在备份并移除目录管理记录，请稍后修改素材" });
  if (req.method !== "GET" && [...lib.jobs.values()].some(j => j.type === "duplicate-cleanup" && j.status === "running")) return res.status(423).json({ error: "正在校验或清理重复音频，请稍后修改素材" });
  next();
});
app.use("/api", (req, res, next) => {
  if (
    mysqlStorage.migrating &&
    !req.path.startsWith("/mysql") &&
    req.method !== "GET"
  )
    return res.status(423).json({ error: "数据库迁移中，请稍后再操作" });
  next();
});
app.use(TASK_ENTRY_BASE, (req, res, next) => {
  try { ensureTaskEntry().router(req, res, next); }
  catch (error) { res.status(error.status || 503).json({ error: { code: /^[A-Z_]{1,64}$/.test(error.code || "") ? error.code : "ENTRY_UNKNOWN" } }); }
});
app.get("/api/mysql", (req, res) => res.json(mysqlStorage.publicState()));
const withEnrollment = state => ({ ...state, enrollment: deviceEnrollment.getStatus() });
app.get("/api/cloud-auth/status", (req, res) => res.json(withEnrollment(cloudAuth.getState())));
app.post("/api/cloud-auth/config", asyncRoute(async (req, res) => {
  deviceEnrollment.cancel();
  res.json(withEnrollment(await cloudAuth.configure(req.body)));
}));
app.post("/api/cloud-auth/enroll", asyncRoute(async (req, res) => res.json(await deviceEnrollment.enroll(req.body))));
app.post("/api/cloud-auth/recover-device", asyncRoute(async (req, res) => res.json(await deviceEnrollment.recover(req.body))));
app.post("/api/cloud-auth/activate", asyncRoute(async (req, res) => {
  deviceEnrollment.cancel();
  res.json(withEnrollment(await cloudAuth.activate(req.body)));
}));
app.post("/api/cloud-auth/login", asyncRoute(async (req, res) => {
  deviceEnrollment.cancel();
  res.json(withEnrollment(await cloudAuth.login(req.body)));
}));
app.post("/api/cloud-auth/logout", asyncRoute(async (req, res) => {
  deviceEnrollment.cancel();
  const result = await cloudAuth.logout();
  res.json({ ...result, state: withEnrollment(result.state) });
}));

// 音频分析引擎：默认关闭（503 AUDIO_FEATURE_DISABLED），启用后按需下载/卸载；分析结果存本地 asset_audio
app.get("/api/audio-engine/status", (req, res) => {
  const audio = audioFeature();
  if (!audio) return rejectAudioFeature(res);
  res.json(audio.engine.status());
});
function rejectAudioEngine(res, error) {
  const code = isAudioEngineError(error) ? error.code : "ENGINE_INSTALL_FAILED";
  const message = isAudioEngineError(error) ? error.message : "安装失败";
  const status = isAudioEngineError(error) ? error.status : 400;
  return res.status(status).json({ error: message, code });
}
app.post("/api/audio-engine/install", asyncRoute(async (req, res) => {
  const audio = audioFeature();
  if (!audio) return rejectAudioFeature(res);
  try {
    res.json(audio.engine.install({ confirm: req.body?.confirm === true }));
  } catch (error) {
    return rejectAudioEngine(res, error);
  }
}));
app.post("/api/audio-engine/cancel", asyncRoute(async (req, res) => {
  const audio = audioFeature();
  if (!audio) return rejectAudioFeature(res);
  try {
    res.json(await audio.engine.cancel());
  } catch (error) {
    return rejectAudioEngine(res, error);
  }
}));
app.delete("/api/audio-engine", asyncRoute(async (req, res) => {
  const audio = audioFeature();
  if (!audio) return rejectAudioFeature(res);
  try {
    res.json(await audio.engine.uninstall());
  } catch (error) {
    return rejectAudioEngine(res, error);
  }
}));
app.get("/api/assets/:id/audio", asyncRoute(async (req, res) => {
  const audio = audioFeature();
  if (!audio) return rejectAudioFeature(res);
  try {
    res.json(await audio.analysis.get(req.params.id));
  } catch (error) {
    return rejectAudioAnalysis(res, error);
  }
}));
app.post("/api/assets/:id/analyze-audio", asyncRoute(async (req, res) => {
  const audio = audioFeature();
  if (!audio) return rejectAudioFeature(res);
  try {
    res.json(await audio.analysis.analyze(req.params.id, { force: req.body?.force === true }));
  } catch (error) {
    return rejectAudioAnalysis(res, error);
  }
}));
// T-LOCAL-008：账户/小组/授权的本地固定路由。浏览器只给业务参数，方法/云端路径/头均由 Node 固定。
app.get("/api/cloud-management/profile", asyncRoute(async (req, res) => res.json(await cloudManagement.profile())));
app.delete("/api/cloud-management/devices/:id", asyncRoute(async (req, res) => res.json(await cloudManagement.revokeDevice(req.params.id))));
app.post("/api/cloud-management/password", asyncRoute(async (req, res) => res.json(await cloudManagement.changePassword(req.body))));
app.post("/api/cloud-management/reset-password", asyncRoute(async (req, res) => {
  const result = await cloudManagement.resetPassword(req.body);
  res.json({ ...result, state: withEnrollment(result.state) });
}));
app.get("/api/cloud-management/groups", asyncRoute(async (req, res) => res.json(await cloudManagement.groups(req.query))));
app.get("/api/cloud-management/groups/:id/members", asyncRoute(async (req, res) => res.json(await cloudManagement.members(req.params.id, req.query))));
app.get("/api/cloud-management/groups/:id", asyncRoute(async (req, res) => res.json(await cloudManagement.group(req.params.id))));
app.post("/api/cloud-management/groups", asyncRoute(async (req, res) => res.json(await cloudManagement.createGroup(req.body))));
app.put("/api/cloud-management/groups/:id", asyncRoute(async (req, res) => res.json(await cloudManagement.renameGroup(req.params.id, req.body))));
app.post("/api/cloud-management/groups/:id/members", asyncRoute(async (req, res) => res.json(await cloudManagement.addMember(req.params.id, req.body))));
app.delete("/api/cloud-management/groups/:id/members/:accountId", asyncRoute(async (req, res) => res.json(await cloudManagement.removeMember(req.params.id, req.params.accountId, req.body))));
app.post("/api/cloud-management/groups/:id/leave", asyncRoute(async (req, res) => res.json(await cloudManagement.leaveGroup(req.params.id, req.body))));
app.post("/api/cloud-management/groups/:id/leader-transfers", asyncRoute(async (req, res) => res.json(await cloudManagement.transferLeader(req.params.id, req.body))));
app.post("/api/cloud-management/groups/:id/state", asyncRoute(async (req, res) => res.json(await cloudManagement.setGroupState(req.params.id, req.body))));
app.get("/api/cloud-management/accounts", asyncRoute(async (req, res) => res.json(await cloudManagement.accounts(req.query))));
app.get("/api/cloud-management/accounts/:id/devices", asyncRoute(async (req, res) => res.json(await cloudManagement.accountDevices(req.params.id, req.query))));
app.post("/api/cloud-management/accounts/:id/devices/:deviceId/revoke", asyncRoute(async (req, res) => res.json(await cloudManagement.revokeAccountDevice(req.params.id, req.params.deviceId, req.body))));
app.get("/api/cloud-management/accounts/:id/role-assignments", asyncRoute(async (req, res) => res.json(await cloudManagement.roleAssignments(req.params.id, req.query))));
app.get("/api/cloud-management/accounts/:id", asyncRoute(async (req, res) => res.json(await cloudManagement.account(req.params.id))));
app.post("/api/cloud-management/accounts", asyncRoute(async (req, res) => res.json(await cloudManagement.createAccount(req.body))));
app.post("/api/cloud-management/accounts/:id/opening-codes", asyncRoute(async (req, res) => res.json(await cloudManagement.issueOpeningCode(req.params.id))));
app.delete("/api/cloud-management/opening-codes/:id", asyncRoute(async (req, res) => res.json(await cloudManagement.revokeOpeningCode(req.params.id))));
app.post("/api/cloud-management/accounts/:id/state", asyncRoute(async (req, res) => res.json(await cloudManagement.setAccountState(req.params.id, req.body))));
app.post("/api/cloud-management/accounts/:id/password-reset", asyncRoute(async (req, res) => res.json(await cloudManagement.resetAccountPassword(req.params.id, req.body))));
app.get("/api/cloud-management/candidates", asyncRoute(async (req, res) => res.json(await cloudManagement.candidates(req.query))));
app.get("/api/cloud-management/upload-approval-settings", asyncRoute(async (req, res) => res.json(await cloudManagement.uploadApprovalSettings())));
app.put("/api/cloud-management/upload-approval-settings", asyncRoute(async (req, res) => res.json(await cloudManagement.updateUploadApprovalSettings(req.body))));
app.get("/api/cloud-management/permissions", asyncRoute(async (req, res) => res.json(await cloudManagement.permissions())));
app.get("/api/cloud-management/roles", asyncRoute(async (req, res) => res.json(await cloudManagement.roles(req.query))));
app.get("/api/cloud-management/roles/:id/impact", asyncRoute(async (req, res) => res.json(await cloudManagement.roleImpact(req.params.id, req.query))));
app.post("/api/cloud-management/roles", asyncRoute(async (req, res) => res.json(await cloudManagement.createRole(req.body))));
app.put("/api/cloud-management/roles/:id/permissions", asyncRoute(async (req, res) => res.json(await cloudManagement.updateRolePermissions(req.params.id, req.body))));
app.get("/api/cloud-management/audit-events", asyncRoute(async (req, res) => res.json(await cloudManagement.auditEvents(req.query))));
app.post("/api/cloud-management/role-assignments", asyncRoute(async (req, res) => res.json(await cloudManagement.assignRole(req.body))));
app.delete("/api/cloud-management/role-assignments/:id", asyncRoute(async (req, res) => res.json(await cloudManagement.revokeRole(req.params.id))));
app.use("/api/cloud-management", cloudManagementErrorHandler);
// 只回脱敏错误码与提示：不回云端原始 message，不记录令牌/请求体/本机路径；
// 末端兜住所有异常（不只是 CloudAuthError），避免原生文件/TLS 错误落进通用 error.message 处理器。

// ── 云端音频手动传输（固定白名单；账户权限校验） ─────────────
function cloudAudioErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const known = error instanceof CloudAudioServiceError || error instanceof CloudUploadError;
  const code = known ? error.code : "INTERNAL";
  const status = known && [400, 401, 403, 404, 409, 413, 423, 429, 500, 502, 503, 504].includes(error.status)
    ? error.status
    : 500;
  if (!known) console.error("[cloud-audio] INTERNAL");
  else if (status >= 500) console.error(`[cloud-audio] ${code}`);
  res.status(status).json({
    error: error instanceof CloudUploadError ? error.message : CLOUD_AUDIO_MESSAGES[code] || CLOUD_AUDIO_MESSAGES.INTERNAL,
    code,
  });
}
app.get("/api/cloud-audio/status", asyncRoute(async (req, res) => res.json(await cloudAudio.status())));
app.get("/api/cloud-audio/roots", asyncRoute(async (req, res) => res.json(cloudAudio.roots())));
app.post("/api/cloud-audio/roots", asyncRoute(async (req, res) => res.json(await cloudAudio.registerRoot(req.body))));
app.get("/api/cloud-audio/catalog", asyncRoute(async (req, res) => res.json(await cloudAudio.catalog(req.query))));
app.get("/api/cloud-audio/search", asyncRoute(async (req, res) => res.json(await cloudAudio.search(req.query))));
app.get("/api/cloud-audio/upload-assets", asyncRoute(async (req, res) => {
  cloudUpload.guard();
  const q = req.query.q ?? "";
  const page = Number(req.query.page ?? 1);
  if (typeof q !== "string" || q.length > 128 || !Number.isSafeInteger(page) || page < 1 || page > 2000) throw new CloudUploadError("INVALID_REQUEST",400);
  const match = `%${q.replaceAll("!","!!").replaceAll("%","!%").replaceAll("_","!_")}%`;
  const where = `kind IN ('music','sfx') AND trashed=0 AND online=1 AND ${lib.nonMissingAssetScope()} AND name LIKE ? ESCAPE '!'`;
  const total = lib.db.prepare(`SELECT COUNT(*) n FROM assets WHERE ${where}`).get(match).n;
  const items = lib.db.prepare(`SELECT id,name,kind,category,sub FROM assets WHERE ${where} ORDER BY name,id LIMIT 50 OFFSET ?`).all(match,(page-1)*50);
  res.json({items,total,page,hasMore:page*50<total});
}));
app.get("/api/cloud-audio/uploads", asyncRoute(async (req, res) => res.json(cloudUpload.list())));
app.post("/api/cloud-audio/uploads", asyncRoute(async (req, res) => res.json(await cloudUpload.prepare(req.body))));
for (const action of ["request","refresh","reconcile","upload","cancel","forget"]) {
  app.post(`/api/cloud-audio/uploads/:id/${action}`, asyncRoute(async (req, res) => res.json(await (action === "upload" ? cloudTransferAdmission.upload(() => cloudUpload.action(req.params.id,action)) : cloudUpload.action(req.params.id,action)))));
}
app.get("/api/cloud-audio/audio/:id", asyncRoute(async (req, res) => res.json(await cloudAudio.details(req.params.id, req.query))));
app.post("/api/cloud-audio/shares/:id/withdraw", asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new CloudAudioServiceError("INVALID_REQUEST", 400);
  for (const key of Object.keys(body)) if (key !== "expectedVersion") throw new CloudAudioServiceError("INVALID_REQUEST", 400);
  res.json(await cloudAudio.withdrawShare(req.params.id, body.expectedVersion));
}));
app.get("/api/cloud-audio/jobs", asyncRoute(async (req, res) => res.json(cloudAudio.listJobs())));
app.get("/api/cloud-audio/jobs/:id", asyncRoute(async (req, res) => res.json(cloudAudio.getJob(req.params.id))));
app.post("/api/cloud-audio/jobs", asyncRoute(async (req, res) => res.json(await cloudTransferAdmission.download(() => cloudAudio.startDownload(req.body)))));
app.post("/api/cloud-audio/jobs/:id/cancel", asyncRoute(async (req, res) => res.json(await cloudAudio.cancel(req.params.id))));
app.post("/api/cloud-audio/jobs/:id/retry", asyncRoute(async (req, res) => res.json(await cloudTransferAdmission.download(() => cloudAudio.retry(req.params.id)))));
app.use("/api/cloud-audio", cloudAudioErrorHandler);
app.use("/api/cloud-auth", cloudAuthErrorHandler);
app.post(
  "/api/mysql/test",
  asyncRoute(async (req, res) => res.json(await mysqlStorage.test(req.body))),
);
app.post(
  "/api/mysql/config",
  asyncRoute(async (req, res) =>
    res.json(await mysqlStorage.activate(req.body)),
  ),
);
app.get("/api/roots", (req, res) => res.json(lib.roots()));
app.post("/api/roots/management-order", (req, res) => res.json(lib.setRootManagementOrder(req.body.ids)));
app.get("/api/folder-browser", asyncRoute(async (req, res) => res.json(await folderBrowser.branch(req.query))));
app.post("/api/folder-browser", asyncRoute(async (req, res) => {
  if (process.env.MEDIA_READONLY_FILES === "1") return res.status(403).json({ error: "当前为原文件只读模式，不允许新建文件夹" });
  res.json(await folderBrowser.create(req.body));
}));
app.post("/api/roots", asyncRoute(async (req, res) => {
  if (typeof req.body.path !== "string" || !path.isAbsolute(req.body.path)) throw Error("请输入服务器上的绝对文件夹路径");
  const root = await lib.addRoot(req.body.path, req.body.kind);
  void reconcileWatcher?.refresh(); // 立刻开始监听这个新目录，否则外部改动要等下一轮兜底刷新
  res.json({ root, job: lib.scan(root.id) });
}));
// 含已注销的根：只给「素材目录管理」界面用（/api/roots 仍只返回在管的根）
app.get("/api/roots/all", (req, res) => res.json(lib.allRoots()));
app.patch("/api/roots/:id", asyncRoute(async (req, res) => {
  const result = lib.updateRoot(req.params.id, req.body);
  if (Object.hasOwn(req.body, "kind")) void reconcileWatcher?.refresh();
  res.json(result);
}));
// 迁移根路径：保持同一个 root_id，让对账把素材按身份重新认领（标签/项目关联全保留）
app.post("/api/roots/:id/relocate", asyncRoute(async (req, res) => {
  const result = await relocateRoot(lib, req.params.id, req.body.path, { confirm: req.body.confirm === true });
  if (result.needsConfirm) return res.json(result); // 交给界面二次确认
  void reconcileWatcher?.refresh();
  res.json(result);
}));
// 仅注销：保留记录与全部属性，可恢复
app.post("/api/roots/:id/retire", asyncRoute(async (req, res) => {
  const root = lib.retireRoot(req.params.id);
  void reconcileWatcher?.refresh();
  res.json({ root });
}));
app.post("/api/roots/:id/restore", asyncRoute(async (req, res) => {
  const root = lib.restoreRoot(req.params.id);
  void reconcileWatcher?.refresh();
  res.json({ root, job: lib.scan(root.id) });
}));
app.post("/api/roots/:id/removal-preview", (req, res) => res.json(rootRemoval.preview(req.params.id, req.headers.cookie)));
// Explicitly confirmed metadata removal; original files are never deleted.
app.delete("/api/roots/:id", asyncRoute(async (req, res) => {
  const result = await rootRemoval.execute(req.params.id, req.body.confirmation, req.headers.cookie);
  void reconcileWatcher?.refresh();
  res.json(result);
}));
// 对账：把外部（访达/脚本/GPT）整理过的文件重新认领回原素材 id，而不是当成新素材
app.get("/api/reconcile", (req, res) =>
  res.json({
    roots: lib.roots().map((r) => ({
      id: r.id, name: r.name, path: r.path, online: r.online,
      revision: r.revision ?? 0, reconciledMs: r.reconciled_ms ?? null,
    })),
    watching: reconcileWatcher ? reconcileWatcher.activeRoots : 0,
  }),
);
app.post("/api/reconcile", asyncRoute(async (req, res) => {
  const all = lib.roots();
  const wanted = typeof req.body.rootId === "string" && req.body.rootId ? all.filter((r) => r.id === req.body.rootId) : all;
  if (!wanted.length) throw Error("还没有登记任何素材目录");
  const withHash = req.body.hash === true; // 是否顺便渐进补齐 sha256（默认不读全文件，快）
  const reports = [];
  for (const root of wanted)
    reports.push(
      await reconcileRoot(lib, root, {
        importMetadata: req.body.importMetadata === true, // 把清单里的标签/备注并入数据库
        hashBudgetFiles: withHash ? undefined : 0,
        hashBudgetBytes: withHash ? undefined : 0,
        tagFiles: process.env.MEDIA_READONLY_FILES !== "1",
      }),
    );
  res.json({ reports });
}));
// Explicit bounded jobs only. Existing origin/session/token middleware applies.
const repairRoute = fn => asyncRoute(async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(e.status || 409).json({ error: publicRepairCode(e), code: publicRepairCode(e) }); }
});
app.get("/api/cloud-upload-host/readiness", repairRoute(() => uploadHost.readiness()));
app.post("/api/cloud-upload-host/register", repairRoute(req => uploadHost.register(req.body)));
app.post("/api/asset-repairs/history", repairRoute(req => uploadHost.repairCall("history", [req.body])));
app.post("/api/asset-repairs/resolve", repairRoute(req => uploadHost.repairCall("resolve", [req.body])));
app.post("/api/asset-repairs/preview", repairRoute(req => uploadHost.repairCall("preview", [req.body, req.headers.cookie])));
app.post("/api/asset-repairs/confirm", repairRoute(req => uploadHost.repairCall("confirm", [req.body, req.headers.cookie])));
app.get("/api/asset-repairs/:id", repairRoute(req => uploadHost.repairCall("get", [req.params.id])));
app.post("/api/asset-repairs/:id/recover", repairRoute(req => uploadHost.repairCall("recover", [req.params.id, req.body, req.headers.cookie])));
// Two-ID merge is a separate explicit workflow; no startup registration/merge.
const mergeRoute = fn => asyncRoute(async (req, res) => {
  try { res.json(await fn(req)); }
  catch (e) { res.status(e.status || 409).json({ error: publicRepairCode(e), code: publicRepairCode(e), ...(e.code === "MERGE_UNSUPPORTED_REFERENCE" ? { relation: e.relation } : {}), ...(e.code === "MERGE_UNSUPPORTED_MANUAL_FIELD" ? { field: e.field } : {}) }); }
});
app.get("/api/asset-merges/readiness", mergeRoute(async () => { const upload = await uploadHost.readiness(), fields = lib.metadataVersions.readiness(); return { ready: upload.ready && fields.ready, uploadCode: upload.code, fieldsCode: fields.code }; }));
app.get("/api/asset-merges/aliases/:id", mergeRoute(req => { if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(req.params.id)) throw Object.assign(Error("INVALID_SELECTION"), { code: "INVALID_SELECTION", status: 400 }); return { mapping: mergeAlias(lib, req.params.id) }; }));
app.post("/api/asset-merges/preview", mergeRoute(req => uploadHost.mergeCall("preview", [req.body, req.headers.cookie])));
app.post("/api/asset-merges/confirm", mergeRoute(req => uploadHost.mergeCall("confirm", [req.body, req.headers.cookie])));
app.get("/api/asset-merges/:id", mergeRoute(req => uploadHost.mergeCall("get", [req.params.id])));
app.post("/api/asset-merges/:id/recover", mergeRoute(req => uploadHost.mergeCall("recover", [req.params.id, req.body, req.headers.cookie])));
// Explicit field evidence registration. All routes keep the current local
// session/token/origin policy; mutations own the real maintenance track.
const fieldRegistrationRoute = fn => asyncRoute(async (req, res) => { try { res.json(await fn(req)); } catch (e) { const code = /^[A-Z_]{1,64}$/.test(e.code || "") ? e.code : "METADATA_REGISTRATION_UNKNOWN"; res.status(e.status || 409).json({error:code,code}); } });
app.get("/api/asset-metadata-registration/readiness", fieldRegistrationRoute(() => uploadHost.fieldRegistration.readiness()));
app.post("/api/asset-metadata-registration/preview", fieldRegistrationRoute(req => uploadHost.fieldRegistration.preview(req.body, req.headers.cookie)));
app.post("/api/asset-metadata-registration/confirm", fieldRegistrationRoute(req => uploadHost.fieldRegistration.confirm(req.body, req.headers.cookie)));
app.get("/api/asset-metadata-registration/commands/:id", fieldRegistrationRoute(req => uploadHost.fieldRegistration.result(req.params.id)));
app.post("/api/asset-metadata-registration/commands/:id/finalize", fieldRegistrationRoute(req => uploadHost.fieldRegistration.finish(req.params.id, req.body)));
app.post("/api/asset-metadata-registration/commands/:id/abort", fieldRegistrationRoute(req => uploadHost.fieldRegistration.finish(req.params.id, req.body, true)));
app.post("/api/asset-fingerprints", (req, res) => res.status(202).json(assetFingerprints.start(req.body)));
app.get("/api/asset-fingerprints/:id", (req, res) => res.json(assetFingerprints.get(req.params.id)));
app.post("/api/asset-fingerprints/:id/cancel", (req, res) => res.json(assetFingerprints.cancel(req.params.id)));
app.get("/api/projects", asyncRoute(async (req, res) => res.json(projects.list())));
app.get("/api/projects/usage-counts", (req,res) => res.json(lib.db.prepare("SELECT asset_id,COUNT(*) n FROM project_assets WHERE status='used' GROUP BY asset_id").all()));
app.post("/api/projects/timeline-import/preview", (req,res) => res.json(projects.imports.preview(null,req.body,req.headers.cookie)));
app.post("/api/projects/timeline-import/confirm", (req,res) => res.json(projects.imports.apply(null,req.body,req.headers.cookie)));
app.get("/api/projects/:id/timelines", (req,res) => res.json(projects.imports.list(req.params.id)));
app.get("/api/projects/:id/timeline-overview", (req,res) => res.json(projects.imports.overview(req.params.id)));
app.get("/api/projects/:id/timelines/:timelineId/render", (req,res) => res.json(projects.renders.get(req.params.id,req.params.timelineId)));
app.post("/api/projects/:id/timelines/:timelineId/render", asyncRoute(async (req,res) => res.json(await projects.renders.save(req.params.id,req.params.timelineId,req.body))));
app.delete("/api/projects/:id/timelines/:timelineId/render", (req,res) => res.json(projects.renders.remove(req.params.id,req.params.timelineId)));
app.post("/api/projects/:id/timelines/:timelineId/render/choose", asyncRoute(async (req,res) => {
  projects.renders.validate(req.params.id,req.params.timelineId);
  if (process.platform !== "darwin") throw Error("系统文件选择器仅支持 Mac，请输入本地绝对路径");
  const {stdout} = await run("osascript",["-e",'POSIX path of (choose file with prompt "选择本时间线导出的成片" of type {"public.movie"})'],{timeout:120000});
  res.json(await projects.renders.save(req.params.id,req.params.timelineId,{path:stdout.trim(),offset:req.body.offset}));
}));
app.get("/api/projects/:id/timelines/:timelineId/render/media", asyncRoute(async (req,res) => {
  const {handle,path:file} = await projects.renders.open(req.params.id,req.params.timelineId);
  return sendMedia(req,res,file,handle);
}));
app.post("/api/projects/:id/timeline-import/preview", (req,res) => res.json(projects.imports.preview(req.params.id,req.body,req.headers.cookie)));
app.post("/api/projects/:id/timeline-import/confirm", (req,res) => res.json(projects.imports.apply(req.params.id,req.body,req.headers.cookie)));
app.post("/api/projects/:id/timeline-import/:batchId/undo", (req,res) => res.json(projects.imports.undo(req.params.id,req.params.batchId)));
app.post("/api/projects", asyncRoute(async (req, res) => res.json(projects.save(null, req.body))));
app.patch("/api/projects/:id", asyncRoute(async (req, res) => res.json(projects.save(req.params.id, req.body))));
app.delete("/api/projects/:id", asyncRoute(async (req, res) => res.json(projects.remove(req.params.id))));
app.get("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.items(req.params.id, req.query))));
app.get("/api/projects/:id/members", asyncRoute(async (req, res) => res.json(projects.members(req.params.id))));
app.post("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.add(req.params.id, req.body))));
app.patch("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.change(req.params.id, req.body))));
app.delete("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.removeItems(req.params.id, req.body))));
app.get("/api/assets/:id/projects", asyncRoute(async (req, res) => res.json(projects.history(req.params.id))));
app.get("/api/duplicate-audio", asyncRoute(async (req, res) => res.json(duplicateAudio.state(req.query.scope || "sfx"))));
app.post("/api/duplicate-audio/start", asyncRoute(async (req, res) => res.json(duplicateAudio.start(req.body))));
app.post("/api/duplicate-audio/cancel", (req, res) => res.json(duplicateAudio.cancel()));
app.post("/api/duplicate-audio/mark", asyncRoute(async (req, res) => res.json(await duplicateAudio.mark(req.body))));
const duplicateCleanupConfirmations = new Map();
app.post("/api/duplicate-audio/cleanup/preview", asyncRoute(async (req, res) => {
  for (const [key, record] of duplicateCleanupConfirmations) if (Date.now() - record.createdAt > 600000) duplicateCleanupConfirmations.delete(key);
  const { plan, preview } = await duplicateAudio.cleanup.preview(req.body);
  const confirmation = crypto.randomBytes(24).toString("hex");
  duplicateCleanupConfirmations.set(confirmation, { plan, createdAt: Date.now(), session: req.headers.cookie });
  res.json({ ...preview, confirmation });
}));
app.post("/api/duplicate-audio/cleanup", asyncRoute(async (req, res) => {
  const record = duplicateCleanupConfirmations.get(req.body.confirmation);
  if (!record || record.session !== req.headers.cookie || Date.now() - record.createdAt > 600000) throw Error("清理确认已失效，请重新预览");
  duplicateCleanupConfirmations.delete(req.body.confirmation);
  res.json(await duplicateAudio.cleanup.execute(record.plan, req.body.acknowledgeOrder));
}));
app.post("/api/maintenance/files", asyncRoute(async (req, res) => {
  res.json(await missingFiles.check({ force: req.body.force === true, dryRun: req.body.dryRun === true }));
}));
const cleanupConfirmations = new Map();
app.post("/api/maintenance/files/cleanup/preview", asyncRoute(async (req, res) => {
  for (const [id, item] of cleanupConfirmations) if (Date.now() - item.createdMs > 600000) cleanupConfirmations.delete(id);
  const items = await missingFiles.checkedCleanupPreview(req.body.ids);
  const confirmation = crypto.randomBytes(24).toString("hex");
  cleanupConfirmations.set(confirmation, { items, session: req.headers.cookie, createdMs: Date.now() });
  res.json({ confirmation, items });
}));
app.post("/api/maintenance/files/cleanup", asyncRoute(async (req, res) => {
  const saved = cleanupConfirmations.get(req.body.confirmation);
  if (!saved || saved.session !== req.headers.cookie || Date.now() - saved.createdMs > 600000) throw Error("清理确认已失效，请重新核对");
  cleanupConfirmations.delete(req.body.confirmation);
  res.json(await missingFiles.clean(saved.items));
}));
app.get("/api/openai", (req, res) => res.json(musicAnalysis.state()));
app.post(
  "/api/openai/test",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.testConnection()),
  ),
);
app.get("/api/openai/logs", (req, res) =>
  res.json({ items: musicAnalysis.diagnostics.list(1000) }),
);
app.get("/api/assets/:id/analysis-failure", (req, res) => {
  lib.asset(req.params.id);
  res.json({
    diagnostic: musicAnalysis.diagnostics.lastFailure(req.params.id),
  });
});
app.delete("/api/openai/logs", (req, res) =>
  res.json(musicAnalysis.diagnostics.clear()),
);
app.post(
  "/api/openai/config",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.configure(req.body)),
  ),
);
app.delete(
  "/api/openai/config",
  asyncRoute(async (req, res) => res.json(await musicAnalysis.removeKey())),
);
app.get(
  "/api/assets/:id/analysis",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.readCache(req.params.id, req.query)),
  ),
);
app.post(
  "/api/assets/:id/analysis",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.analyze(req.params.id, req.body)),
  ),
);
app.get("/api/tags", (req, res) => res.json(tags.list(req.query)));
app.get("/api/tags/revision", (_req, res) => { res.set("Cache-Control", "no-store"); res.json({ revision: tags.revision() }); });
app.get("/api/tags/facets", (req, res) => { res.set("Cache-Control", "no-store"); res.json(tags.facets(req.query)); });
app.get("/api/automation", (req, res) => res.json(metadataCapabilities));
const metadataConfirmations = new Map();
app.post("/api/metadata/batches/preview", asyncRoute(async (req, res) => {
  for (const [key, record] of metadataConfirmations) if (Date.now() - record.createdAt > 600000) metadataConfirmations.delete(key);
  if (metadataConfirmations.size >= 5) throw Error("待确认批次过多，请先提交已有预览或等待其过期");
  const { plan, preview } = metadataBatches.preview(req.body);
  const confirmation = crypto.randomBytes(24).toString("hex"), createdAt = Date.now();
  metadataConfirmations.set(confirmation, { plan, createdAt, session: req.headers.cookie });
  res.json({ ...preview, confirmation, expiresAt: createdAt + 600000 });
}));
app.post("/api/metadata/batches", asyncRoute(async (req, res) => {
  const record = metadataConfirmations.get(req.body.confirmation);
  if (!record || record.session !== req.headers.cookie || Date.now() - record.createdAt > 600000) throw Error("批量标注确认已失效，请重新预览");
  metadataConfirmations.delete(req.body.confirmation);
  res.json(await metadataBatches.apply(record.plan));
}));
app.get("/api/metadata/batches", (req, res) => res.json(metadataBatches.list()));
app.get("/api/metadata/batches/:id", (req, res) => res.json(metadataBatches.read(req.params.id)));
app.post("/api/metadata/batches/:id/undo", asyncRoute(async (req, res) => res.json(await metadataBatches.undo(req.params.id))));
app.post(
  "/api/tags",
  asyncRoute(async (req, res) => res.json(tags.create(req.body))),
);
app.patch(
  "/api/tags/:id",
  asyncRoute(async (req, res) =>
    res.json(tags.rename(req.params.id, req.body)),
  ),
);
app.delete(
  "/api/tags/:id",
  asyncRoute(async (req, res) => res.json(tags.remove(req.params.id))),
);
app.post(
  "/api/tags/apply",
  asyncRoute(async (req, res) => res.json(tags.apply(req.body))),
);
app.get("/api/music-categories", (req, res) =>
  res.json(categories.list({ kind: "music" })),
);
app.use(["/api/categories", "/api/music-categories", "/api/subcategories"], (req, res, next) => {
  if (req.method !== "GET") return res.status(410).json({ error: "旧分类编辑已停用；分类由真实目录决定，请新建文件夹或移动素材" });
  next();
});
app.get("/api/categories", (req, res) => res.json(categories.list(req.query)));
app.get("/api/subcategories", asyncRoute(async (req, res) => res.json(categories.subcategories(req.query.categoryId))));
app.get("/api/assets/:id/categories", (req, res) => res.json(categories.members(req.params.id)));
app.get("/api/assets/:id/music-categories", (req, res, next) => {
  try {
    res.json(categories.members(req.params.id));
  } catch (e) {
    next(e);
  }
});
app.get("/api/jobs", (req, res) =>
  res.json({
    jobs: [...lib.jobs.values()].reverse().slice(0, 30),
    metadata: {
      queued: lib.metadataQueue.length,
      active: lib.workers,
      pending: lib.db
        .prepare(
          "SELECT COUNT(*) n FROM assets WHERE (probe='pending' OR capture_status='pending') AND online=1 AND trashed=0 AND " + lib.activeAssetScope(),
        )
        .get().n,
    },
  }),
);
app.get("/api/asset-series", (req, res) => res.json(assetSeriesList(lib, req.query)));
app.get("/api/asset-series/members", (req, res) => res.json(assetSeriesMembers(lib, req.query)));
app.get("/api/asset-series/adjacent", (req, res) => res.json(assetSeriesAdjacent(lib, req.query)));
app.get("/api/assets", (req, res) => res.json(lib.list(req.query)));
app.get("/api/assets/:id", (req, res, next) => {
  try {
    res.json(lib.asset(req.params.id));
  } catch (e) {
    next(e);
  }
});
app.patch(
  "/api/assets/:id",
  asyncRoute(async (req, res) => res.json(lib.patch(req.params.id, req.body))),
);
app.post(
  "/api/batch",
  asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body.ids) || req.body.ids.length > 200)
      throw Error("每批最多200项");
    const results = req.body.ids.map((id) => {
      try {
        return { id, ok: true, asset: lib.patch(id, req.body.patch || {}) };
      } catch (e) {
        return { id, ok: false, error: e.message };
      }
    });
    res.json(results);
  }),
);
app.post(
  "/api/folders/choose",
  asyncRoute(async (req, res) => {
    if (process.platform !== "darwin")
      throw Error("系统文件夹选择器仅支持 Mac");
    const { stdout } = await run(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "选择素材文件夹")'],
      { timeout: 120000 },
    );
    const root = await lib.addRoot(stdout.trim(), req.body.kind);
    void reconcileWatcher?.refresh();
    res.json({ root, job: lib.scan(root.id) });
  }),
);
app.post(
  "/api/roots/:id/scan",
  asyncRoute(async (req, res) => res.json(lib.scan(req.params.id))),
);
app.post(
  "/api/assets/:id/reveal",
  asyncRoute(async (req, res) => {
    res.json({ ok: true, asset: await lib.reveal(req.params.id) });
  }),
);
const confirmations = new Map();
app.use("/api/operations", (req, res, next) => {
  if (process.env.MEDIA_READONLY_FILES === "1" && req.method !== "GET") return res.status(403).json({ error: "当前为原文件只读模式，不允许移动、改名、删除或恢复原文件" });
  next();
});
app.post(
  "/api/operations/preview",
  asyncRoute(async (req, res) => {
    for (const [key, value] of confirmations)
      if (Date.now() - value.createdAt > 600000) confirmations.delete(key);
    const items = await lib.plan(req.body);
    const confirmation = crypto.randomBytes(24).toString("hex");
    confirmations.set(confirmation, {
      input: req.body,
      items,
      createdAt: Date.now(),
      session: req.headers.cookie,
    });
    res.json({ items, confirmation });
  }),
);
app.post(
  "/api/operations",
  asyncRoute(async (req, res) => {
    const record = confirmations.get(req.body.confirmation);
    if (
      !record ||
      record.session !== req.headers.cookie ||
      Date.now() - record.createdAt > 600000
    )
      throw Error("操作确认已失效，请重新检查目标路径");
    confirmations.delete(req.body.confirmation);
    const results = await lib.execute(record.input, record.items);
    if (record.input.action === "trash") {
      try {
        const sync = await duplicateAudio.reconcileTrash(results.filter(r => r.ok).map(r => r.id));
        for (const result of results) if (result.ok) result.duplicateTagsRemoved = sync.removed;
      } catch (e) {
        for (const result of results) if (result.ok) result.warning = "文件已移入废纸篓，但重复标签同步失败：" + e.message;
      }
    }
    res.json(results);
  }),
);
app.get("/api/operations", (req, res) =>
  res.json(
    lib.db
      .prepare("SELECT * FROM operations ORDER BY rowid DESC LIMIT 200")
      .all(),
  ),
);
app.post(
  "/api/operations/:id/undo",
  asyncRoute(async (req, res) => res.json(await lib.undo(req.params.id))),
);
app.get("/api/export", (req, res) => {
  const selected = String(req.query.ids || "")
    .split(",")
    .filter(Boolean);
  const rows = selected.length
    ? selected.slice(0, 200).map((id) => lib.asset(id)).filter(a => !a.trashed && lib.roots().some(r => r.id === a.root_id))
    : lib.db
        .prepare("SELECT * FROM assets WHERE trashed=0 AND " + lib.activeAssetScope() + " AND " + lib.nonMissingAssetScope() + " ORDER BY name")
        .all()
        .map((a) => ({ ...a, tags: JSON.parse(a.tags) }));
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const csv = [
    [
      "文件名",
      "类型",
      "分类",
      "子类",
      "标签",
      "备注",
      "时长（秒）",
      "大小（字节）",
      "创建时间（北京时间）",
      "拍摄时间（北京时间）",
      "拍摄时间来源",
      "路径",
      "确认状态",
    ],
    ...rows.map((a) => [
      a.name,
      a.kind,
      a.category,
      a.sub,
      a.tags.join("、"),
      a.note,
      a.duration,
      a.size,
      a.created_ms === null
        ? ""
        : new Date(a.created_ms).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            hour12: false,
          }),
      a.captured_ms === null
        ? ""
        : new Date(a.captured_ms).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            hour12: false,
          }),
      a.capture_source,
      a.path,
      a.review ? "待确认" : "已归类",
    ]),
  ]
    .map((r) => r.map(cell).join(","))
    .join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename*=UTF-8''%E7%B4%A0%E6%9D%90%E6%B8%85%E5%8D%95.csv",
  );
  res.send("\uFEFF" + csv);
});
const cacheJobs = new Map();
let previewTail = Promise.resolve();
let clearing = false;
const cacheKey = (a, suffix) =>
  path.join(
    lib.cache,
    crypto
      .createHash("sha256")
      .update(`${a.id}:${a.size}:${a.mtime}:${suffix}`)
      .digest("hex") +
      "." +
      suffix,
  );
async function cached(a, suffix, generate) {
  const dest = cacheKey(a, suffix);
  try {
    await fs.access(dest);
    return dest;
  } catch {}
  if (clearing) throw Error("缓存正在清理，请稍后重试");
  if (!cacheJobs.has(dest)) {
    const task = previewTail.then(async () => {
      const temp = dest + ".tmp." + suffix;
      try {
        await generate(temp);
        await fs.rename(temp, dest);
        return dest;
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    });
    previewTail = task.catch(() => {});
    cacheJobs.set(dest, task);
    task.finally(() => cacheJobs.delete(dest)).catch(() => {});
  }
  return cacheJobs.get(dest);
}
async function sendMedia(req, res, p, handle = null) {
  const s = handle ? await handle.stat() : await fs.stat(p);
  if (handle) res.on("close", () => { void handle.close().catch(() => {}); });
  const ext = path.extname(p).slice(1).toLowerCase();
  const types = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/mp4",
    webm: "video/webm",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (m && !m[1] && m[2]) {
      start = Math.max(0, s.size - Number(m[2]));
      end = s.size - 1;
    } else {
      start = m && Number(m[1]);
      end = m?.[2] ? Number(m[2]) : s.size - 1;
    }
    if (
      !m ||
      (!m[1] && !m[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= s.size ||
      end < start
    ) {
      res.status(416).set("Content-Range", `bytes */${s.size}`).end();
      return;
    }
    end = Math.min(end, s.size - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${s.size}`);
    res.setHeader("Content-Length", end - start + 1);
    const stream = createReadStream(p, { start, end, ...(handle ? {fd:handle.fd,autoClose:false} : {}) });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } else {
    res.setHeader("Content-Length", s.size);
    const stream = createReadStream(p, handle ? {fd:handle.fd,autoClose:false} : undefined);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }
}
app.get(
  "/api/media/:id/:mode",
  asyncRoute(async (req, res) => {
    const { a, p } = await lib.source(req.params.id);
    const mode = req.params.mode;
    if (mode === "original") return sendMedia(req, res, p);
    if (mode === "wave") {
      const output = await cached(a, "png", (dest) =>
        run(
          "ffmpeg",
          [
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            p,
            "-filter_complex",
            "aformat=channel_layouts=mono,showwavespic=s=640x72:colors=0x557b6b",
            "-frames:v",
            "1",
            "-y",
            dest,
          ],
          { timeout: 60000, maxBuffer: 1e6 },
        ),
      );
      return sendMedia(req, res, output);
    }
    if (mode === "thumb") {
      const output = await cached(a, "jpg", async (dest) => {
        if (process.platform === "darwin" &&
          [
            "heic",
            "heif",
            "arw",
            "cr2",
            "cr3",
            "nef",
            "dng",
            "raf",
            "orf",
            "rw2",
            "tif",
            "tiff",
          ].includes(a.ext)
        )
          await run(
            "sips",
            [
              "-s",
              "format",
              "jpeg",
              "--resampleHeightWidthMax",
              "1200",
              p,
              "--out",
              dest,
            ],
            { timeout: 30000, maxBuffer: 1e6 },
          );
        else
          await run(
            "ffmpeg",
            [
              "-v",
              "error",
              "-threads",
              "1",
              "-i",
              p,
              "-frames:v",
              "1",
              "-vf",
              "scale=800:800:force_original_aspect_ratio=decrease",
              "-y",
              dest,
            ],
            { timeout: 30000, maxBuffer: 1e6 },
          );
      });
      return sendMedia(req, res, output);
    }
    if (mode === "proxy") {
      if (a.kind === "photo") throw Error("照片请使用缩略图预览");
      const audioOnly =
        ["sfx", "music"].includes(a.kind) &&
        !["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm"].includes(
          a.ext,
        );
      const output = await cached(a, audioOnly ? "m4a" : "mp4", (dest) =>
        run(
          "ffmpeg",
          [
            "-v",
            "error",
            "-threads",
            "2",
            "-i",
            p,
            ...(audioOnly
              ? ["-vn", "-c:a", "aac", "-b:a", "160k"]
              : [
                  "-map",
                  "0:v:0",
                  "-map",
                  "0:a?",
                  "-vf",
                  "scale=1280:720:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
                  "-c:v",
                  "libx264",
                  "-preset",
                  "veryfast",
                  "-crf",
                  "25",
                  "-pix_fmt",
                  "yuv420p",
                  "-c:a",
                  "aac",
                ]),
            "-movflags",
            "+faststart",
            "-y",
            dest,
          ],
          { timeout: 600000, maxBuffer: 1e6 },
        ),
      );
      return sendMedia(req, res, output);
    }
    throw Error("预览类型不存在");
  }),
);
app.get(
  "/api/cache",
  asyncRoute(async (req, res) => {
    let bytes = 0,
      files = 0;
    for (const n of await fs.readdir(lib.cache)) {
      const s = await fs.stat(path.join(lib.cache, n));
      bytes += s.size;
      files++;
    }
    res.json({ bytes, files, active: cacheJobs.size });
  }),
);
app.post(
  "/api/cache/clear",
  asyncRoute(async (req, res) => {
    if (cacheJobs.size || clearing) throw Error("预览生成中，请完成后再清理");
    clearing = true;
    try {
      for (const n of await fs.readdir(lib.cache))
        await fs.unlink(path.join(lib.cache, n));
      res.json({ ok: true });
    } finally {
      clearing = false;
    }
  }),
);

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(project, "dist")));
  app.get("*", (req, res) =>
    res.sendFile(path.join(project, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: project,
    cacheDir: path.join(dataDir, "vite-entry-cache"),
    esbuild: { jsx: "automatic" },
    optimizeDeps: { include: ["react", "react-dom/client", "react-dom", "react/jsx-dev-runtime", "lucide-react"] },
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  viteServer = vite;
  app.use(vite.middlewares);
}
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (["ASSET_IS_ALIAS", "MERGE_HISTORY_RETAINED"].includes(error.code)) return res.status(409).json({ error: error.message, code: error.code, ...(error.code === "ASSET_IS_ALIAS" ? { canonicalAssetId: error.canonicalAssetId } : {}) });
  console.error(error.message);
  res
    .status(400)
    .json({
      error: String(error.stderr || error.message).slice(0, 500),
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    });
});
const startPort = Number(process.env.PORT) || 4317;
async function listen(n) {
  port = n;
  return new Promise((resolve, reject) => {
    const server = app.listen(n, process.env.MEDIA_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}
let server;
for (let p = startPort; p < startPort + 30; p++) {
  try {
    server = await listen(p);
    break;
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
  }
}
if (!server) throw Error("没有可用端口");
let shutdownWork = null;
async function shutdownApplication() {
  if (shutdownWork) return shutdownWork;
  applicationClosing = true;
  shutdownWork = (async () => {
    reconcileWatcher?.stop(); manifestSync.stop();
    await drainTaskEntry();
    manifestSync.stop();
    await viteServer?.close();
    const stopped = new Promise(resolve => server.close(() => resolve(true)));
    server.closeIdleConnections?.();
    let timer;
    const stoppedKnown = await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(() => resolve(false), 10000); })]);
    clearTimeout(timer);
    if (!stoppedKnown) throw taskError("SERVER_WORK_UNSETTLED");
    const end = Date.now() + 10000;
    while (uploadHost.active || lib.workers || lib.metadataPending.size || lib.metadataQueue.length || lib.repairIndexReaders) {
      if (Date.now() >= end) throw taskError("APPLICATION_WORK_UNSETTLED");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const activity = cloudAudio.currentActivity();
    if (activity.known !== true || activity.allowed !== true || cacheJobs.size) throw taskError("RECEIVER_WORK_UNSETTLED");
    const uploaded = await cloudUpload.dispose({ timeoutMs: 10000 });
    if (uploaded.closed !== true) throw taskError("UPLOAD_WORK_UNSETTLED");
    await cloudAudio.dispose();
    const hostExit = await uploadHost.dispose();
    if (hostExit.closed !== true) throw taskError("HOST_WORK_UNSETTLED");
    cloudAuth.dispose(); lib.db.close();
    console.log("APPLICATION_CLOSED_KNOWN");
    if (process.connected) process.disconnect();
  })().catch(error => { console.error(/^[A-Z_]{1,64}$/.test(error.code || "") ? error.code : "APPLICATION_CLOSE_UNKNOWN"); shutdownWork = null; });
  return shutdownWork;
}
process.on("SIGTERM", () => { void shutdownApplication(); });
process.on("SIGINT", () => { void shutdownApplication(); });
console.log(`拾光素材库 http://127.0.0.1:${port}`);
await fs.writeFile(
  path.join(dataDir, "server.json"),
  JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}`, instanceId: mysqlStorage.sourceId }),
);
// 启动对账 + 目录监听：用户在访达/终端（或 GPT）直接整理过文件时，把文件重新认领回原素材，
// 而不是让标签、备注、项目关联随路径一起丢。默认不读全文件（不算 sha256），因此很快。
// MEDIA_SKIP_RECONCILE=1 关闭对账，MEDIA_NO_WATCH=1 只对账不监听，MEDIA_RECONCILE_HASH=1 顺便补哈希。
if (process.env.MEDIA_SKIP_RECONCILE !== "1") {
  void (async () => {
    for (const root of lib.roots()) {
      try {
        const report = await reconcileRoot(lib, root, {
          tagFiles: process.env.MEDIA_READONLY_FILES !== "1",
          hashBudgetFiles: process.env.MEDIA_RECONCILE_HASH === "1" ? undefined : 0,
          hashBudgetBytes: process.env.MEDIA_RECONCILE_HASH === "1" ? undefined : 0,
        });
        const adopted = report.adoptedByXattr + report.adoptedByHash;
        if (report.moved || report.renamed || adopted || report.added || report.missing || report.conflicts.length)
          console.log(
            `[reconcile] ${root.name || root.path}：移动 ${report.moved} / 改名 ${report.renamed} / 认领 ${adopted} / 新增 ${report.added} / 失联 ${report.missing} / 冲突 ${report.conflicts.length} / 跳过写库 ${report.skipped} / 打标 ${report.tagged}（${report.elapsedMs}ms）`,
          );
        for (const c of report.conflicts.slice(0, 3))
          console.warn(`[reconcile] 冲突：${c.path || c.entryId || ""} —— ${String(c.error).slice(0, 120)}`);
      } catch (e) {
        console.warn(`[reconcile] ${root.path} 启动对账失败：${e.message}`);
      }
    }
  })();
  if (process.env.MEDIA_NO_WATCH !== "1") {
    try {
      reconcileWatcher = startWatcher(lib, { log: (m) => console.log(m) });
      console.log(`[reconcile] 已监听 ${reconcileWatcher.activeRoots} 个素材目录：外部改名/移动会在 1~2 秒内自动接上`);
    } catch (e) {
      console.warn("[reconcile] 无法启动目录监听：" + e.message);
    }
  }
}
if (!process.env.MEDIA_SKIP_IMPORT && !lib.directoryClassification) {
  const workspace = path.dirname(project);
  let classification = new Map();
  try {
    const data = JSON.parse(
      await fs.readFile(
        path.join(workspace, "音效_按用途分类", "分类记录.json"),
        "utf8",
      ),
    );
    classification = new Map(data.files.map((f) => [f.path, f]));
  } catch {}
  for (const [relative, kind] of [
    ["音效/音效", "sfx"],
    ["音效/音乐", "music"],
  ]) {
    const p = path.join(workspace, relative);
    try {
      await fs.access(p);
      const root = await lib.addRoot(p, kind);
      if (
        !lib.db
          .prepare("SELECT id FROM assets WHERE root_id=? LIMIT 1")
          .get(root.id)
      )
        lib.scan(root.id, classification);
    } catch (e) {
      console.warn("初始导入：" + e.message);
    }
  }
}
