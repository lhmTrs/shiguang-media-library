/**
 * T-LOCAL-014B：本地手动云端音频下载服务。
 *
 * 串起已验收的 T14A 接收核心与 T14D/T13 兼容的固定 DTO 边界：
 *   catalog（懒加载列表，不逐条取详情）→ details（显式选择来源）→
 *   后台任务（独立于浏览器，双并发/有界排队）→ 接收核心（长度/SHA-256/上下文）
 *   → 受控安装（两级分类/不覆盖/原子发布）→ 现有 Library 扫描并确认可见索引。
 *
 * 所有云端数据都按不可信输入重新校验；浏览器不能提供 URL/hash/bytes/headers/路径。
 * 应用入口默认启用手动传输；显式 MEDIA_CLOUD_AUDIO_ENABLED=0 可关闭。
 * 直接构造服务仍默认关闭，调用者须明确传入 enabled。
 */
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { CloudAuthError } from "./cloud-auth.mjs";
import {
  CloudAudioReceiver,
  CloudAudioReceiverError,
  CLOUD_AUDIO_RECEIVER_MESSAGES,
} from "./cloud-audio-receiver.mjs";
import {
  CloudAudioInstallError,
  CloudAudioInstaller,
  CLOUD_AUDIO_INSTALL_MESSAGES,
  validateCategories,
  validateFileName,
  validateMimeType,
} from "./cloud-audio-install.mjs";
import { CloudAudioJobStore } from "./cloud-audio-store.mjs";
import { AUDIO_MIME_TYPES } from "./cloud-audio-receiver.mjs";
import { rootIdentity } from "./fs-identity.mjs";

export { CLOUD_AUDIO_FLAG } from "./cloud-audio-feature.mjs";
export const CLOUD_AUDIO_DISABLED = "CLOUD_AUDIO_DISABLED";
export const MAX_ACTIVE_TRANSFERS = 2;
export const MAX_PENDING_JOBS = 12;
const MAX_CATALOG_LIMIT = 100;
const MAX_OFFSET = 100_000;
const MAX_SHARE_PAGES = 5;
const SHARE_PAGE_SIZE = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MIME_SET = new Set(AUDIO_MIME_TYPES);
const MEDIA_KINDS = new Set(["MUSIC", "SFX"]);
const ROOT_KINDS = new Set(["music", "sfx", "mixed"]);
const REGISTRATION_TIMEOUT_MS = 120_000;
/** 临时目录硬上限：两个 256MB 活动传输之外留余量；超过就拒绝新任务，避免磁盘被崩溃残留耗尽。 */
const MAX_TEMP_BYTES = 600_000_000;
/** 无法判断大小/类型的残留按单文件最大音频长度保守计费，避免把未知文件当作 0。 */
const UNKNOWN_ENTRY_BYTES = 256_000_000;
const REGISTRATION_POLL_MS = 50;

export const CLOUD_AUDIO_MESSAGES = Object.freeze({
  [CLOUD_AUDIO_DISABLED]: "云端音频下载未启用",
  NOT_CONFIGURED: "云端连接尚未配置",
  NOT_LOGGED_IN: "需要登录云端账户",
  INVALID_REQUEST: "请求参数不合法",
  NOT_FOUND: "资源不存在",
  BUSY: "下载任务过多，请稍后再试",
  JOB_NOT_FOUND: "下载任务不存在",
  ROOT_NOT_FOUND: "下载目录不存在或已注销",
  ROOT_UNSAFE: "下载目录不安全或不可写",
  TEMP_UNSAFE: "本地下载临时目录不安全，请检查后重试",
  ROOT_KIND: "下载目录与素材类型不兼容，请改用音乐、音效或混合目录",
  KIND_CONFLICT: "同一文件已按另一种素材类型入库，未更改其类型",
  ROOT_CHANGED: "下载目录已变化，请重新选择",
  SHARE_UNAVAILABLE: "所选云端来源已不可用",
  AUDIO_CHANGED: "云端音频已变化，请重新选择",
  AUTH_CHANGED: "云端账户或设备状态已变化",
  CATEGORY_INVALID: "云端分类不合法",
  NAME_INVALID: "云端文件名不合法",
  MIME_INVALID: "云端音频类型不合法",
  CLOUD_UNAVAILABLE: "云端暂时不可用",
  DOWNLOAD_FAILED: "音频下载失败",
  INSTALL_FAILED: "音频安装失败",
  INDEX_FAILED: "音频已下载，但未能加入素材库",
  INDEX_BUSY: "素材库正在扫描，请稍后重试",
  INDEX_TIMEOUT: "加入素材库超时",
  STORAGE_FAILED: "本地任务记录保存失败",
  TEMP_LIMIT: "本地下载临时空间不足，请清理残留临时文件后重试",
  CANCELLED: "下载已取消",
  INTERRUPTED: "任务因应用重启中断，请手动重试",
  INTERNAL: "云端音频操作失败",
});

export class CloudAudioServiceError extends Error {
  constructor(code, status = 400) {
    const known = Object.hasOwn(CLOUD_AUDIO_MESSAGES, code)
      || Object.hasOwn(CLOUD_AUDIO_RECEIVER_MESSAGES, code)
      || Object.hasOwn(CLOUD_AUDIO_INSTALL_MESSAGES, code);
    const message = Object.hasOwn(CLOUD_AUDIO_MESSAGES, code)
      ? CLOUD_AUDIO_MESSAGES[code]
      : Object.hasOwn(CLOUD_AUDIO_RECEIVER_MESSAGES, code)
        ? CLOUD_AUDIO_RECEIVER_MESSAGES[code]
        : Object.hasOwn(CLOUD_AUDIO_INSTALL_MESSAGES, code)
          ? CLOUD_AUDIO_INSTALL_MESSAGES[code]
          : CLOUD_AUDIO_MESSAGES.INTERNAL;
    super(message);
    this.name = "CloudAudioServiceError";
    this.code = known ? code : "INTERNAL";
    this.status = status;
  }
}

const fail = (code, status = 400) => {
  throw new CloudAudioServiceError(code, status);
};

const isPlain = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const text = (value, max, { allowEmpty = false } = {}) => {
  if (typeof value !== "string" || value.length > max) return null;
  if (!allowEmpty && value.length === 0) return null;
  if (CONTROL_RE.test(value)) return null;
  return value;
};

const int = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max ? value : null;

const iso = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
};

function pickActive(request) {
  if (!isPlain(request)) fail("INVALID_REQUEST");
  for (const key of Object.keys(request)) {
    if (!["audioId", "shareId", "rootId"].includes(key)) fail("INVALID_REQUEST");
  }
  return request;
}

function validateUuid(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) fail("INVALID_REQUEST");
  return value;
}

function validatePage(query = {}) {
  if (!isPlain(query)) fail("INVALID_REQUEST");
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CATALOG_LIMIT) fail("INVALID_REQUEST");
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) fail("INVALID_REQUEST");
  return { limit, offset };
}

function mapCatalogItem(raw) {
  if (!isPlain(raw)) fail("CLOUD_UNAVAILABLE", 502);
  const id = typeof raw.id === "string" && UUID_RE.test(raw.id) ? raw.id : null;
  const sha256 = typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256) ? raw.sha256 : null;
  const bytes = int(raw.bytes, 1, 256_000_000);
  const contentType = typeof raw.contentType === "string" && MIME_SET.has(raw.contentType.trim().toLowerCase())
    ? raw.contentType.trim().toLowerCase()
    : null;
  const createdAt = iso(raw.createdAt);
  const preferredShareId = typeof raw.preferredShareId === "string" && UUID_RE.test(raw.preferredShareId)
    ? raw.preferredShareId
    : null;
  const ownerAccountId = text(raw.ownerAccountId, 80);
  const fileName = text(raw.fileName, 180);
  const mediaKind = typeof raw.mediaKind === "string" && MEDIA_KINDS.has(raw.mediaKind) ? raw.mediaKind : null;
  const category = text(raw.category, 120, { allowEmpty: true });
  const subcategory = text(raw.subcategory, 120, { allowEmpty: true });
  const visibleShareCount = int(raw.visibleShareCount, 0, 100_000);
  if (!id || !sha256 || bytes === null || !contentType || !createdAt || !preferredShareId
    || !ownerAccountId || !fileName || !mediaKind || category === null || subcategory === null
    || visibleShareCount === null) {
    fail("CLOUD_UNAVAILABLE", 502);
  }
  return {
    id,
    sha256,
    bytes,
    contentType,
    createdAt,
    preferredShareId,
    ownerAccountId,
    fileName,
    mediaKind,
    category,
    subcategory,
    visibleShareCount,
  };
}

function mapShare(raw) {
  if (!isPlain(raw)) fail("CLOUD_UNAVAILABLE", 502);
  const id = typeof raw.id === "string" && UUID_RE.test(raw.id) ? raw.id : null;
  const ownerAccountId = text(raw.ownerAccountId, 80);
  const fileName = text(raw.fileName, 180);
  const mediaKind = typeof raw.mediaKind === "string" && MEDIA_KINDS.has(raw.mediaKind) ? raw.mediaKind : null;
  const category = text(raw.category, 120, { allowEmpty: true });
  const subcategory = text(raw.subcategory, 120, { allowEmpty: true });
  const createdAt = iso(raw.createdAt);
  const version = int(raw.version, 0, Number.MAX_SAFE_INTEGER);
  if (!id || !ownerAccountId || !fileName || !mediaKind || category === null
    || subcategory === null || !createdAt || version === null) {
    fail("CLOUD_UNAVAILABLE", 502);
  }
  return { id, ownerAccountId, fileName, mediaKind, category, subcategory, createdAt, version };
}

function mapAudio(raw) {
  if (!isPlain(raw)) fail("CLOUD_UNAVAILABLE", 502);
  const id = typeof raw.id === "string" && UUID_RE.test(raw.id) ? raw.id : null;
  const sha256 = typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256) ? raw.sha256 : null;
  const bytes = int(raw.bytes, 1, 256_000_000);
  const contentType = typeof raw.contentType === "string" && MIME_SET.has(raw.contentType.trim().toLowerCase())
    ? raw.contentType.trim().toLowerCase()
    : null;
  const createdAt = iso(raw.createdAt);
  if (!id || !sha256 || bytes === null || !contentType || !createdAt) fail("CLOUD_UNAVAILABLE", 502);
  return { id, sha256, bytes, contentType, createdAt };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CloudAudioService {
  #lib;
  #dataDir;
  #auth;
  #enabled;
  #installer;
  #store = null;
  #receiver = null;
  #receiverFaulted = false;
  #workDir = null;
  #active = new Map();
  #activeByAudio = new Map();
  #progress = new Map();
  #rootLocks = new Map();
  #startLocks = new Map();
  /** 已准入但尚未写入磁盘的字节；与 #tempUsage 的现存字节相加后再判断上限。 */
  #tempReservations = new Map();
  #tempReservedBytes = 0;
  #capacityChain = Promise.resolve();
  #disposed = false;
  #initialized = false;

  constructor(lib, { dataDir, cloudAuth, enabled = false } = {}) {
    this.#lib = lib;
    this.#dataDir = dataDir || lib.dataDir;
    this.#auth = cloudAuth;
    this.#enabled = enabled === true;
    this.#installer = new CloudAudioInstaller({ dataDir: this.#dataDir });
  }

  get enabled() {
    return this.#enabled;
  }

  async init() {
    if (this.#initialized) return this;
    if (!this.#enabled) {
      this.#initialized = true;
      return this;
    }
    try {
      // 先验证 dataDir/workDir 的真实目录身份，再建目录、chmod、遍历或清理；
      // 任何一步发现符号链接都固定失败，绝不触碰链接目标。
      await this.#assertDataDirectory();
      this.#store = await new CloudAudioJobStore(this.#dataDir).init();
      this.#workDir = await this.#prepareWorkDir();
      this.#receiver = new CloudAudioReceiver({
        workDir: this.#workDir,
        maxActiveTransfers: MAX_ACTIVE_TRANSFERS,
        onProgress: (bytes, audioId) => this.#onProgress(bytes, audioId),
        resolveContext: () => this.#contextToken(),
        openStream: (audioId, signal) => {
          const entry = this.#activeByAudio.get(audioId);
          if (!entry) return Promise.reject(new Error("no active job"));
          return this.#auth.openAudioContentStream(audioId, { epoch: entry.epoch, signal });
        },
      });
    } catch (error) {
      if (this.#store) {
        await this.#store.close().catch(() => {});
        this.#store = null;
      }
      this.#workDir = null;
      this.#initialized = false;
      throw error;
    }
    this.#initialized = true;
    this.#schedule();
    return this;
  }

  /** dataDir 必须存在且解析到真实目录；符号链接由 realpath 归一化后再校验。 */
  async #assertDataDirectory() {
    let real;
    try {
      real = await fs.realpath(path.resolve(this.#dataDir));
    } catch {
      fail("TEMP_UNSAFE", 503);
    }
    let stat;
    try {
      stat = await fs.lstat(real);
    } catch {
      fail("TEMP_UNSAFE", 503);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("TEMP_UNSAFE", 503);
    return real;
  }

  /**
   * 创建/确认专用临时目录：
   *   - 只允许在真实 dataDir 下创建一层，不用 mkdir({recursive:true})，避免跟随既有链接；
   *   - 已存在时先 lstat/realpath 校验，再以 O_NOFOLLOW 打开目录句柄；
   *   - chmod 只作用于已打开的目录 inode，不通过可能被替换的路径跟随链接；
   *   - 不自动删除任何已有文件（未知残留保留，由 status 计量并触发容量门禁）。
   */
  async #prepareWorkDir() {
    const dataReal = await this.#assertDataDirectory();
    const workDir = path.join(dataReal, "cloud-audio-tmp");
    let stat = null;
    try {
      stat = await fs.lstat(workDir);
    } catch (error) {
      if (error?.code !== "ENOENT") fail("TEMP_UNSAFE", 503);
    }
    if (stat === null) {
      try {
        await fs.mkdir(workDir, { mode: 0o700 });
      } catch {
        fail("TEMP_UNSAFE", 503);
      }
    }
    let handle = null;
    try {
      // O_DIRECTORY|O_NOFOLLOW：最终组件是链接时直接 ELOOP，不会打开链接目标。
      handle = await fs.open(
        workDir,
        fsSync.constants.O_RDONLY
          | (fsSync.constants.O_DIRECTORY ?? 0)
          | (fsSync.constants.O_NOFOLLOW ?? 0),
      );
      const opened = await handle.stat();
      if (!opened.isDirectory()) fail("TEMP_UNSAFE", 503);
      if (typeof process.geteuid === "function" && opened.uid !== process.geteuid()) {
        fail("TEMP_UNSAFE", 503);
      }
      // chmod 之前先确认路径仍解析到同一个真实目录，避免对链接目标改权限。
      let real;
      try {
        real = await fs.realpath(workDir);
      } catch {
        fail("TEMP_UNSAFE", 503);
      }
      if (real !== workDir) fail("TEMP_UNSAFE", 503);
      const before = await fs.lstat(workDir);
      if (!before.isDirectory() || before.isSymbolicLink()
        || before.dev !== opened.dev || before.ino !== opened.ino) {
        fail("TEMP_UNSAFE", 503);
      }
      await handle.chmod(0o700);
      const after = await handle.stat();
      const pathAfter = await fs.lstat(workDir);
      if (!after.isDirectory() || (after.mode & 0o777) !== 0o700
        || after.dev !== opened.dev || after.ino !== opened.ino
        || !pathAfter.isDirectory() || pathAfter.isSymbolicLink()
        || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
        fail("TEMP_UNSAFE", 503);
      }
      return workDir;
    } catch (error) {
      if (error instanceof CloudAudioServiceError) throw error;
      fail("TEMP_UNSAFE", 503);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /**
   * 临时目录占用：不按文件名猜测归属，所有现存条目都计为未知/活动残留。
   * 普通文件按实际字节；目录/符号链接/读取失败按最大单文件长度保守计费。
   */
  async #tempUsage() {
    if (!this.#workDir) return { files: 0, bytes: 0, unreadable: false };
    let entries;
    try {
      entries = await fs.readdir(this.#workDir, { withFileTypes: true });
    } catch {
      // 无法枚举时不能当作 0：保守按满额占用，阻止新下载并让操作者处理。
      return { files: 1, bytes: MAX_TEMP_BYTES, unreadable: true };
    }
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      files += 1;
      try {
        const stat = await fs.lstat(path.join(this.#workDir, entry.name));
        if (stat.isFile() && !stat.isSymbolicLink()) {
          bytes += stat.size;
        } else {
          bytes += UNKNOWN_ENTRY_BYTES;
        }
      } catch {
        bytes += UNKNOWN_ENTRY_BYTES;
      }
    }
    return { files, bytes, unreadable: false };
  }

  async #assertTempCapacity() {
    const usage = await this.#tempUsage();
    if (usage.bytes >= MAX_TEMP_BYTES) fail("TEMP_LIMIT", 503);
    return usage;
  }

  /** 容量检查与预留必须串行：readdir 是异步的，单纯检查会让并发任务看到同一份空余额。 */
  #withCapacityLock(task) {
    const run = this.#capacityChain.then(task, task);
    this.#capacityChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * 权威字节数已知后，在容量锁内把“现存残留 + 已有预留 + 本次字节”一起结算。
   * 不足时固定 TEMP_LIMIT，不排队等待；成功才写入预留，调用方必须保证同一 key 只预留一次。
   */
  #reserveTemp(key, bytes) {
    return this.#withCapacityLock(async () => {
      const usage = await this.#tempUsage();
      if (usage.bytes + this.#tempReservedBytes + bytes > MAX_TEMP_BYTES) fail("TEMP_LIMIT", 503);
      this.#tempReservations.set(key, bytes);
      this.#tempReservedBytes += bytes;
      return usage;
    });
  }

  /** 释放是定向且幂等的；释放后现存字节仍由下一次 #tempUsage 保守计量。 */
  #releaseTemp(key) {
    const bytes = this.#tempReservations.get(key);
    if (bytes === undefined) return false;
    this.#tempReservations.delete(key);
    this.#tempReservedBytes -= bytes;
    return true;
  }

  #moveTempReservation(from, to) {
    const bytes = this.#tempReservations.get(from);
    if (bytes === undefined) return;
    this.#tempReservations.delete(from);
    this.#tempReservations.set(to, bytes);
  }

  /**
   * 执行前复核：执行期间可能有新的未知残留落盘。预留本身已计入总账，
   * 这里只再扫描一次现存字节，不再重复加本次预留；任何不足固定 TEMP_LIMIT。
   * 已取消的任务即使预留已被取消路径释放，也返回固定 CANCELLED 而不是容量错误。
   */
  #reassertTemp(key) {
    return this.#withCapacityLock(async () => {
      const job = this.#store?.get(key);
      if (job?.cancelRequested) fail("CANCELLED", 409);
      if (!this.#tempReservations.has(key)) fail("TEMP_LIMIT", 503);
      const usage = await this.#tempUsage();
      if (usage.bytes + this.#tempReservedBytes > MAX_TEMP_BYTES) fail("TEMP_LIMIT", 503);
      return usage;
    });
  }

  #contextToken() {
    const state = this.#auth.getState();
    return `${this.#auth.epoch}:${state.accountId || ""}:${state.deviceId || ""}:${state.originHost || ""}`;
  }

  #currentIdentity() {
    const state = this.#auth.getState();
    if (!state.configured) fail("NOT_CONFIGURED", 503);
    if (state.state !== "logged-in" || !state.accountId || !state.deviceId || !state.originHost) {
      fail("NOT_LOGGED_IN", 401);
    }
    return {
      epoch: this.#auth.epoch,
      accountId: state.accountId,
      deviceId: state.deviceId,
      originHost: state.originHost,
    };
  }

  /** 任务属于一个“云身份命名空间”：账户 + 设备 + 云端 origin；epoch 不参与，
   * 同一身份重新登录后历史仍可读，但换账户/设备/服务器绝不能看到。 */
  #sameOwner(job, identity) {
    return !!job && job.accountId === identity.accountId
      && job.deviceId === identity.deviceId
      && job.originHost === identity.originHost;
  }

  #ownedJob(id, identity = null) {
    const who = identity || this.#currentIdentity();
    const job = this.#store?.get(id);
    // 不存在与不属于当前身份必须不可区分。
    if (!this.#sameOwner(job, who)) fail("JOB_NOT_FOUND", 404);
    return job;
  }

  #jobContextUnchanged(job, identity = null) {
    const now = identity || this.#currentIdentity();
    if (now.epoch !== job.epoch || now.accountId !== job.accountId || now.deviceId !== job.deviceId) {
      fail("AUTH_CHANGED", 409);
    }
  }

  #assertEnabled() {
    if (!this.#enabled) fail(CLOUD_AUDIO_DISABLED, 503);
    if (!this.#receiver) fail(CLOUD_AUDIO_DISABLED, 503);
  }

  #assertUsable() {
    this.#assertEnabled();
    if (this.#receiverFaulted || this.#receiver?.stats().faulted) fail("INTERNAL", 503);
  }

  async status() {
    if (!this.#enabled) {
      return {
        enabled: false,
        configured: false,
        loggedIn: false,
        active: 0,
        queued: 0,
        maxActive: MAX_ACTIVE_TRANSFERS,
        maxPending: MAX_PENDING_JOBS,
        interrupted: 0,
        receiverFaulted: false,
        staleTempFiles: 0,
        staleTempBytes: 0,
        staleTempUnreadable: false,
      };
    }
    const state = this.#auth.getState();
    const tempUsage = await this.#tempUsage();
    let identity = null;
    if (state.state === "logged-in" && state.accountId && state.deviceId && state.originHost) {
      identity = { accountId: state.accountId, deviceId: state.deviceId, originHost: state.originHost };
    }
    const visible = identity && this.#store
      ? this.#store.list().filter((job) => this.#sameOwner(job, identity))
      : [];
    const receiver = this.#receiver?.stats();
    return {
      enabled: true,
      configured: !!state.configured,
      loggedIn: state.state === "logged-in",
      active: visible.filter((job) => ["queued", "downloading", "installing"].includes(job.state)).length,
      queued: visible.filter((job) => job.state === "queued").length,
      maxActive: MAX_ACTIVE_TRANSFERS,
      maxPending: MAX_PENDING_JOBS,
      interrupted: visible.filter((job) => job.state === "interrupted").length,
      receiverFaulted: !!(receiver?.faulted || this.#receiverFaulted),
      staleTempFiles: tempUsage.files,
      staleTempBytes: tempUsage.bytes,
      staleTempUnreadable: tempUsage.unreadable,
    };
  }

  roots() {
    this.#assertEnabled();
    return this.#lib
      .roots()
      .filter((root) => ROOT_KINDS.has(root.kind))
      .map((root) => ({ id: root.id, name: root.name, kind: root.kind }));
  }

  async registerRoot(input) {
    this.#assertEnabled();
    this.#currentIdentity();
    if (!isPlain(input)) fail("INVALID_REQUEST");
    for (const key of Object.keys(input)) if (!["path", "kind"].includes(key)) fail("INVALID_REQUEST");
    // 新下载根默认用混合类型：一个目录即可同时接收音乐和音效，具体类型按来源登记。
    const kind = input.kind === undefined ? "mixed" : input.kind;
    if (!["music", "sfx", "mixed"].includes(kind)) fail("INVALID_REQUEST");
    let inspected;
    try {
      inspected = await this.#installer.inspectRoot(input.path);
    } catch (error) {
      if (error instanceof CloudAudioInstallError) {
        fail(error.code === "ROOT_UNSAFE" ? "ROOT_UNSAFE" : "ROOT_NOT_FOUND", 400);
      }
      fail("ROOT_UNSAFE");
    }
    let root;
    try {
      root = await this.#lib.addRoot(inspected.path, kind);
    } catch {
      fail("ROOT_UNSAFE", 400);
    }
    if (!ROOT_KINDS.has(root.kind) || root.retired) fail("ROOT_KIND", 409);
    return { id: root.id, name: root.name, kind: root.kind };
  }

  async #rootSnapshot(rootId) {
    let root;
    try {
      root = this.#lib.rootById(rootId);
    } catch {
      fail("ROOT_NOT_FOUND", 404);
    }
    if (root.retired) fail("ROOT_NOT_FOUND", 404);
    if (!ROOT_KINDS.has(root.kind)) fail("ROOT_KIND", 409);
    let inspected;
    try {
      inspected = await this.#installer.inspectRoot(root.path);
    } catch {
      fail("ROOT_UNSAFE", 409);
    }
    let identity;
    try {
      identity = await rootIdentity(root);
    } catch {
      fail("ROOT_CHANGED", 409);
    }
    const generation = crypto
      .createHash("sha256")
      .update(`v1|${root.id}|${root.path}|${identity}|${inspected.dev}:${inspected.ino}`)
      .digest("hex");
    return {
      root,
      rootIdentity: { dev: inspected.dev, ino: inspected.ino },
      generation,
    };
  }

  async #assertRootSnapshot(job) {
    const current = await this.#rootSnapshot(job.rootId);
    if (current.root.path !== job.rootPath || current.generation !== job.rootGeneration) {
      fail("ROOT_CHANGED", 409);
    }
    return current;
  }

  async #proxy(method, pathname, epoch) {
    try {
      return await this.#auth.proxy(method, pathname, { epoch });
    } catch (error) {
      if (error instanceof CloudAuthError) {
        if (error.status === 401 || error.code === "UNAUTHORIZED" || error.code === "NOT_LOGGED_IN") {
          // 只清掉发起这次请求的旧会话；新登录已推进 epoch 时 forgetSession 会放弃。
          void this.#auth.forgetSession(error.toPublic(), { epoch }).catch(() => {});
          fail("NOT_LOGGED_IN", 401);
        }
        if (error.code === "STALE") fail("AUTH_CHANGED", 409);
        if (error.status === 404 || error.status === 403) fail("NOT_FOUND", 404);
        fail("CLOUD_UNAVAILABLE", 502);
      }
      fail("CLOUD_UNAVAILABLE", 502);
    }
  }

  async catalog(query = {}) {
    this.#assertUsable();
    const { epoch } = this.#currentIdentity();
    const { limit, offset } = validatePage(query);
    const data = await this.#proxy(
      "GET",
      `/media/audio/catalog?limit=${limit}&offset=${offset}`,
      epoch,
    );
    if (!isPlain(data) || !Array.isArray(data.items) || typeof data.hasMore !== "boolean") {
      fail("CLOUD_UNAVAILABLE", 502);
    }
    if (data.items.length > limit) fail("CLOUD_UNAVAILABLE", 502);
    return {
      items: data.items.map(mapCatalogItem),
      hasMore: data.hasMore,
      limit,
      offset,
    };
  }

  async search(query = {}) {
    this.#assertUsable();
    const { epoch } = this.#currentIdentity();
    if (!isPlain(query) || Object.keys(query).some(key => !["q","groupId","limit","offset"].includes(key))) fail("INVALID_REQUEST");
    const { limit, offset } = validatePage(query);
    const q = query.q ?? "", groupId = query.groupId ?? "";
    if (typeof q !== "string" || q.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(q)
      || typeof groupId !== "string" || (groupId && !UUID_RE.test(groupId))) fail("INVALID_REQUEST");
    const params = new URLSearchParams({ q, limit: String(limit), offset: String(offset) });
    if (groupId) params.set("groupId", groupId);
    const data = await this.#proxy("GET", `/media/audio/catalog/search?${params}`, epoch);
    if (!isPlain(data) || !Array.isArray(data.items) || data.items.length > limit
      || typeof data.hasMore !== "boolean" || !Number.isSafeInteger(data.total) || data.total < 0) fail("CLOUD_UNAVAILABLE", 502);
    return { items: data.items.map(mapCatalogItem), total: data.total, hasMore: data.hasMore, limit, offset };
  }

  async details(audioId, query = {}) {
    this.#assertUsable();
    validateUuid(audioId);
    const { epoch } = this.#currentIdentity();
    const { limit, offset } = validatePage(query);
    const data = await this.#proxy(
      "GET",
      `/media/audio/${audioId}?limit=${limit}&offset=${offset}`,
      epoch,
    );
    if (!isPlain(data)) fail("CLOUD_UNAVAILABLE", 502);
    const audio = mapAudio(data.audio);
    if (audio.id !== audioId) fail("CLOUD_UNAVAILABLE", 502);
    if (!Array.isArray(data.shares) || data.shares.length > limit) fail("CLOUD_UNAVAILABLE", 502);
    const shares = data.shares.map(mapShare);
    return { audio, shares, hasMore: shares.length === limit, limit, offset };
  }

  /** 在显式选择/下载前重新读取详情，分页查找所选 share；不缓存、不逐行预取。 */
  async #findShare(audioId, shareId, epoch) {
    let offset = 0;
    let audio = null;
    const seen = new Set();
    for (let page = 0; page < MAX_SHARE_PAGES; page += 1) {
      const data = await this.#proxy(
        "GET",
        `/media/audio/${audioId}?limit=${SHARE_PAGE_SIZE}&offset=${offset}`,
        epoch,
      );
      if (!isPlain(data)) fail("CLOUD_UNAVAILABLE", 502);
      const current = mapAudio(data.audio);
      if (current.id !== audioId) fail("CLOUD_UNAVAILABLE", 502);
      if (audio && (audio.sha256 !== current.sha256 || audio.bytes !== current.bytes
        || audio.contentType !== current.contentType)) {
        fail("AUDIO_CHANGED", 409);
      }
      audio = current;
      if (!Array.isArray(data.shares) || data.shares.length > SHARE_PAGE_SIZE) fail("CLOUD_UNAVAILABLE", 502);
      for (const raw of data.shares) {
        const share = mapShare(raw);
        if (seen.has(share.id)) continue;
        seen.add(share.id);
        if (share.id === shareId) return { audio, share };
      }
      if (data.shares.length < SHARE_PAGE_SIZE) break;
      offset += SHARE_PAGE_SIZE;
    }
    fail("SHARE_UNAVAILABLE", 409);
  }

  /**
   * 云端 mediaKind 是权威类型；根类型只决定目录能否接收它。
   * mixed 根允许一个目录同时放音乐与音效，具体类型在登记后按本次来源设置。
   */
  #assertRootKind(root, mediaKind) {
    const target = mediaKind === "MUSIC" ? "music" : mediaKind === "SFX" ? "sfx" : null;
    if (!target) fail("AUDIO_CHANGED", 409);
    if (root.kind !== "mixed" && root.kind !== target) fail("ROOT_KIND", 409);
    return target;
  }

  #jobDto(job) {
    if (!job) return null;
    const error = job.errorCode
      ? CLOUD_AUDIO_MESSAGES[job.errorCode]
        || (CLOUD_AUDIO_RECEIVER_MESSAGES[job.errorCode] ?? null)
        || (CLOUD_AUDIO_INSTALL_MESSAGES[job.errorCode] ?? null)
        || CLOUD_AUDIO_MESSAGES.DOWNLOAD_FAILED
      : "";
    return {
      id: job.id,
      audioId: job.audioId,
      shareId: job.shareId,
      rootId: job.rootId,
      rootName: job.rootName,
      category: job.category,
      subcategory: job.subcategory,
      fileName: job.fileName,
      mediaKind: job.mediaKind,
      bytes: job.bytes,
      sha256: job.sha256,
      mimeType: job.mimeType,
      state: job.state,
      errorCode: job.errorCode,
      error,
      assetId: job.assetId,
      createdFile: job.createdFile,
      cancelRequested: job.cancelRequested,
      cleanupWarning: job.cleanupWarning,
      receivedBytes: this.#progress.get(job.id) ?? job.receivedBytes,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
    };
  }

  listJobs() {
    this.#assertEnabled();
    const identity = this.#currentIdentity();
    return this.#store
      ? this.#store.list().filter((job) => this.#sameOwner(job, identity)).slice(0, 50).map((job) => this.#jobDto(job))
      : [];
  }

  getJob(id) {
    this.#assertEnabled();
    validateUuid(id);
    return this.#jobDto(this.#ownedJob(id));
  }

  async startDownload(request) {
    this.#assertUsable();
    const body = pickActive(request);
    const audioId = validateUuid(body.audioId);
    const identity = this.#currentIdentity();
    await this.#assertTempCapacity();
    // 同一账户/音频的并发点击串行化：第一个创建任务，后续请求在锁内看到活动任务
    // 后返回同一个 job，而不是各自通过“查重”再各建一份。
    const key = `${identity.accountId}:${audioId}`;
    const previous = this.#startLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    this.#startLocks.set(key, gate);
    await previous.catch(() => undefined);
    try {
      return await this.#startDownloadInner(body, identity);
    } finally {
      release();
      if (this.#startLocks.get(key) === gate) this.#startLocks.delete(key);
    }
  }

  async #startDownloadInner(body, identity) {
    const audioId = body.audioId;
    const shareId = validateUuid(body.shareId);
    const rootId = text(body.rootId, 80);
    if (!rootId) fail("INVALID_REQUEST");
    const snapshot = await this.#rootSnapshot(rootId);

    // 同一音频已有活动任务：返回它，避免重复点击产生多份并发下载。
    for (const entry of this.#active.values()) {
      const existing = this.#store.get(entry.jobId);
      // 只有仍在活动状态的任务才去重；刚完成但 finally 尚未清理的条目不能
      // 让新的显式下载误拿到旧任务。外来身份的活动音频也不能泄露任务内容，
      // 只返回固定的 BUSY。
      if (existing && existing.audioId === audioId
        && ["queued", "downloading", "installing"].includes(existing.state)) {
        if (this.#sameOwner(existing, identity)) return this.#jobDto(existing);
        fail("BUSY", 429);
      }
    }
    const duplicate = this.#store.findActive({
      audioId,
      shareId,
      rootId,
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      originHost: identity.originHost,
    });
    if (duplicate) return this.#jobDto(duplicate);
    const queued = this.#store.list().filter((job) => job.state === "queued").length;
    if (this.#store.countActive() >= MAX_PENDING_JOBS || queued >= MAX_PENDING_JOBS) fail("BUSY", 429);

    const { audio, share } = await this.#findShare(audioId, shareId, identity.epoch);
    this.#assertRootKind(snapshot.root, share.mediaKind);
    let categories;
    let file;
    let mimeType;
    try {
      categories = validateCategories(share.category, share.subcategory);
      file = validateFileName(share.fileName);
      mimeType = validateMimeType(audio.contentType);
    } catch (error) {
      if (error instanceof CloudAudioInstallError) {
        if (error.code === "INVALID_CATEGORY") fail("CATEGORY_INVALID", 400);
        if (error.code === "INVALID_NAME") fail("NAME_INVALID", 400);
        if (error.code === "INVALID_MIME") fail("MIME_INVALID", 400);
      }
      fail("INVALID_REQUEST");
    }
    const job = await this.#createReservedJob({
      audioId: audio.id,
      shareId: share.id,
      accountId: identity.accountId,
      deviceId: identity.deviceId,
      originHost: identity.originHost,
      epoch: identity.epoch,
      rootId: snapshot.root.id,
      rootName: snapshot.root.name,
      rootPath: snapshot.root.path,
      rootGeneration: snapshot.generation,
      category: categories.category,
      subcategory: categories.subcategory,
      fileName: file.name,
      mediaKind: share.mediaKind,
      bytes: audio.bytes,
      sha256: audio.sha256,
      mimeType,
    });
    this.#schedule();
    return this.#jobDto(job);
  }

  /** 先预留再落盘：预留失败不得留下 queued 任务，落盘失败必须回滚预留。 */
  async #createReservedJob(record) {
    const key = `admission:${crypto.randomUUID()}`;
    await this.#reserveTemp(key, record.bytes);
    let job;
    try {
      job = await this.#store.create(record);
    } catch (error) {
      this.#releaseTemp(key);
      throw error;
    }
    this.#moveTempReservation(key, job.id);
    return job;
  }

  async retry(id) {
    this.#assertEnabled();
    validateUuid(id);
    const job = this.#ownedJob(id);
    if (!["failed", "interrupted", "cancelled"].includes(job.state)) fail("INVALID_REQUEST", 409);
    // 重试仍是原任务意图：下载根代际变了就不静默换目录。
    const snapshot = await this.#rootSnapshot(job.rootId);
    if (snapshot.generation !== job.rootGeneration || snapshot.root.path !== job.rootPath) fail("ROOT_CHANGED", 409);
    return this.startDownload({ audioId: job.audioId, shareId: job.shareId, rootId: job.rootId });
  }

  async cancel(id) {
    this.#assertEnabled();
    validateUuid(id);
    const job = this.#ownedJob(id);
    if (!["queued", "downloading", "installing"].includes(job.state)) return this.#jobDto(job);
    const entry = this.#active.get(id);
    if (entry) {
      // 任务已经进入执行器：即使磁盘上的状态还是 queued，也必须走 abort，
      // 不能直接把状态写成 cancelled（执行器随后会用 completed 覆盖）。
      try {
        entry.controller.abort();
      } catch {
        /* 已结束 */
      }
      const next = await this.#store.update(id, { cancelRequested: true });
      // 已进入执行器：abort 后不会再有新字节；现存部分文件仍由下一次
      // #tempUsage 扫描计量，因此这里可以立即归还本次预留。
      this.#releaseTemp(id);
      return this.#jobDto(next);
    }
    if (job.state === "queued") {
      const next = await this.#store.update(id, {
        state: "cancelled",
        errorCode: "CANCELLED",
        cancelRequested: true,
        completedAt: Date.now(),
      });
      // 尚未进入执行器：不会再有字节写入，直接定向释放；若执行器随后抢到任务，
      // #reassertTemp 会看到 cancelRequested 并固定返回 CANCELLED。
      this.#releaseTemp(id);
      return this.#jobDto(next);
    }
    const next = await this.#store.update(id, { cancelRequested: true });
    return this.#jobDto(next);
  }

  #schedule() {
    if (!this.#enabled || this.#disposed || !this.#store) return;
    if (this.#active.size >= MAX_ACTIVE_TRANSFERS) return;
    const queued = this.#store
      .list()
      .filter((job) => job.state === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of queued) {
      if (this.#active.size >= MAX_ACTIVE_TRANSFERS) break;
      if (this.#activeByAudio.has(job.audioId)) continue;
      void this.#run(job.id);
    }
  }

  #onProgress(bytes, audioId) {
    const entry = this.#activeByAudio.get(audioId);
    if (entry && entry.receiving) this.#progress.set(entry.jobId, bytes);
  }

  async #run(id) {
    const job = this.#store.get(id);
    if (!job || job.state !== "queued") return;
    if (this.#active.size >= MAX_ACTIVE_TRANSFERS || this.#activeByAudio.has(job.audioId)) return;
    const controller = new AbortController();
    const entry = {
      jobId: id,
      audioId: job.audioId,
      epoch: job.epoch,
      controller,
      receiving: false,
      published: false,
    };
    this.#active.set(id, entry);
    this.#activeByAudio.set(job.audioId, entry);
    this.#progress.set(id, 0);
    let published = false;
    let artifact = null;
    let artifactHandled = false;
    let failure = null;
    try {
      this.#assertUsable();
      this.#jobContextUnchanged(job);
      await this.#store.update(id, { state: "downloading", startedAt: Date.now() });
      const { audio, share } = await this.#findShare(job.audioId, job.shareId, job.epoch);
      if (audio.sha256 !== job.sha256 || audio.bytes !== job.bytes || audio.contentType !== job.mimeType) {
        fail("AUDIO_CHANGED", 409);
      }
      if (share.fileName !== job.fileName || share.category !== job.category
        || share.subcategory !== job.subcategory || share.mediaKind !== job.mediaKind) {
        fail("AUDIO_CHANGED", 409);
      }
      this.#jobContextUnchanged(job);
      // 详情已重新校验、字节流尚未打开：此时再按现存残留与全部预留复核一次。
      await this.#reassertTemp(id);
      entry.receiving = true;
      artifact = await this.#receiver.receive(
        { audioId: job.audioId, bytes: job.bytes, sha256: job.sha256, mimeType: job.mimeType },
        { signal: controller.signal },
      );
      entry.receiving = false;
      this.#progress.set(id, job.bytes);
      this.#jobContextUnchanged(job);
      await this.#store.update(id, { state: "installing", receivedBytes: job.bytes });
      const current = await this.#assertRootSnapshot(job);
      this.#assertRootKind(current.root, job.mediaKind);
      let installed = null;
      try {
        installed = await this.#receiver.consume(artifact.artifactId, (snapshot) =>
          this.#installer.publish({
            artifactPath: snapshot.path,
            artifactIdentity: snapshot.identity,
            expectedBytes: job.bytes,
            expectedSha256: job.sha256,
            mimeType: job.mimeType,
            fileName: job.fileName,
            category: job.category,
            subcategory: job.subcategory,
            rootPath: current.root.path,
            rootIdentity: current.rootIdentity,
            signal: controller.signal,
            assertContext: () => {
              this.#jobContextUnchanged(job);
            },
            // 只读、同步的索引快照：安装器在最终候选路径 link 之前调用。
            // 不能把任意路径回调暴露给 HTTP；这里只查本地 assets 表。
            snapshotPreexisting: (candidate) => this.#preexistingAssetAt(candidate),
          }),
        );
      } finally {
        // consume 无论成功/失败都已尝试释放产物；若其自身清理失败，receiver
        // 会进入故障态并抛 CLEANUP_FAILED，这里不再重复清理。
        artifactHandled = true;
      }
      if (!installed) fail("DOWNLOAD_FAILED", 502);
      // consume 成功后临时产物已删除；在写 completed 之前归还预留，避免调用方
      // 看到 completed 后立即发起下一次下载却仍被上一任务的预留挡住。
      this.#releaseTemp(id);
      published = true;
      entry.published = true;
      // 发布是不可逆线性化点：从这里开始即使收到取消也不再谎称 cancelled，
      // 继续完成可见索引，否则会留下“文件已存在但任务说已取消”的歧义。
      const asset = await this.#register(job, installed.path, installed.created === true, installed.prePublication);
      try {
        await this.#store.complete(
          id,
          { assetId: asset.id, createdFile: installed.created, receivedBytes: job.bytes },
          {
            audioId: job.audioId,
            shareId: job.shareId,
            sha256: job.sha256,
            bytes: job.bytes,
            mediaKind: job.mediaKind,
            category: job.category,
            subcategory: job.subcategory,
          },
        );
      } catch {
        fail("STORAGE_FAILED", 500);
      }
    } catch (error) {
      failure = error;
    } finally {
      let cleanupFailed = false;
      // 接收成功到 consume 之间的任何失败都必须释放已持产物；只释放本次
      // artifactId，绝不按目录前缀清理。
      if (artifact !== null && !artifactHandled) {
        try {
          await this.#receiver.release(artifact.artifactId);
        } catch {
          this.#receiverFaulted = true;
          cleanupFailed = true;
          failure = new CloudAudioServiceError("CLEANUP_FAILED", 500);
        }
      }
      if (!cleanupFailed && this.#receiver?.stats().faulted) cleanupFailed = true;
      // 取消/失败/消费完成后定向释放本次预留；清理失败时保守保留计量并让接收器
      // 故障封锁，避免把可能仍占磁盘的字节当成可用空间。
      if (!cleanupFailed) this.#releaseTemp(id);
      if (failure !== null) {
        const mapped = this.#mapError(failure, published);
        try {
          if (mapped.code === "CANCELLED") {
            await this.#store.update(id, {
              state: "cancelled",
              errorCode: "CANCELLED",
              receivedBytes: this.#progress.get(id) || 0,
              completedAt: Date.now(),
            });
          } else {
            await this.#store.update(id, {
              state: "failed",
              errorCode: mapped.code,
              receivedBytes: this.#progress.get(id) || 0,
              completedAt: Date.now(),
            });
          }
        } catch {
          /* 存储失败不能在任务线程再次抛出；状态保留在上一次成功写入 */
        }
      }
      entry.receiving = false;
      this.#active.delete(id);
      this.#activeByAudio.delete(entry.audioId);
      this.#progress.delete(id);
      this.#schedule();
    }
  }

  #mapError(error, published) {
    if (error instanceof CloudAudioServiceError) return error;
    if (error instanceof CloudAudioReceiverError) {
      if (error.code === "ABORTED" && !published) return new CloudAudioServiceError("CANCELLED", 409);
      return new CloudAudioServiceError(error.code === "ABORTED" ? "DOWNLOAD_FAILED" : error.code, 502);
    }
    if (error instanceof CloudAudioInstallError) {
      if (error.code === "CANCELLED" && !published) return new CloudAudioServiceError("CANCELLED", 409);
      if (["CANCELLED"].includes(error.code)) return new CloudAudioServiceError("DOWNLOAD_FAILED", 502);
      if (["ROOT_CHANGED", "TARGET_CHANGED"].includes(error.code)) return new CloudAudioServiceError("ROOT_CHANGED", 409);
      if (["INVALID_NAME", "INVALID_CATEGORY", "INVALID_MIME"].includes(error.code)) {
        return new CloudAudioServiceError(
          error.code === "INVALID_NAME" ? "NAME_INVALID" : error.code === "INVALID_CATEGORY" ? "CATEGORY_INVALID" : "MIME_INVALID",
          400,
        );
      }
      return new CloudAudioServiceError(error.code, 500);
    }
    if (error instanceof CloudAuthError) {
      if (error.status === 401 || error.code === "NOT_LOGGED_IN") return new CloudAudioServiceError("NOT_LOGGED_IN", 401);
      if (error.code === "STALE") return new CloudAudioServiceError("AUTH_CHANGED", 409);
      return new CloudAudioServiceError("CLOUD_UNAVAILABLE", 502);
    }
    return new CloudAudioServiceError("INTERNAL", 500);
  }

  #withRootLock(rootId, task) {
    const previous = this.#rootLocks.get(rootId) || Promise.resolve();
    const run = previous.then(task, task);
    this.#rootLocks.set(
      rootId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * 发布前的只读索引快照。必须保持同步：调用方在 no-replace link 之前使用它，
   * 一旦引入 await，后台/手动扫描就可能在本任务发布后插入索引行。
   * 只按最终候选路径查询，不能拿原始文件名代替（同名冲突会换候选）。
   */
  #preexistingAssetAt(candidatePath) {
    return this.#lib.db
      .prepare("SELECT id FROM assets WHERE path=?")
      .get(candidatePath) ?? null;
  }

  async #register(job, finalPath, created, prePublication = null) {
    return this.#withRootLock(job.rootId, async () => {
      this.#jobContextUnchanged(job);
      const rootSnapshot = await this.#assertRootSnapshot(job);
      const targetKind = this.#assertRootKind(rootSnapshot.root, job.mediaKind);
      let publishedIdentity;
      try {
        publishedIdentity = await this.#installer.verifyPublished(finalPath, job.bytes, job.sha256);
      } catch {
        fail("INDEX_FAILED", 500);
      }
      // created=true 时只信安装器在真正 link 之前、实际候选路径上同步取得的快照；
      // 发布后再查会把后台扫描刚建的行误当既有资产。created=false（复用已有文件）
      // 仍按发布后查询判断，但无论哪种情况都不会按云端类型改既有个人资产。
      let preexisting;
      if (created) {
        if (prePublication === undefined) fail("INDEX_FAILED", 500);
        preexisting = prePublication;
      } else {
        preexisting = this.#lib.db
          .prepare("SELECT id FROM assets WHERE path=? OR (root_id=? AND dev=? AND ino=?)")
          .get(finalPath, job.rootId, publishedIdentity.dev, publishedIdentity.ino);
      }
      let scan;
      try {
        scan = this.#lib.scan(job.rootId);
      } catch {
        fail("INDEX_BUSY", 423);
      }
      const deadline = Date.now() + REGISTRATION_TIMEOUT_MS;
      while (["running"].includes(scan.status)) {
        if (Date.now() > deadline) fail("INDEX_TIMEOUT", 504);
        await delay(REGISTRATION_POLL_MS);
      }
      if (scan.status === "failed") fail("INDEX_FAILED", 500);
      let asset = this.#lib.db
        .prepare("SELECT id,root_id,path,size,online,trashed,kind,dev,ino FROM assets WHERE path=?")
        .get(finalPath);
      if (!asset) {
        // 大小写不敏感/Unicode 归一化文件系统上，扫描器记录的路径大小写可能与
        // 发布请求不同；用刚发布的 dev:ino 兜底确认同一条素材，而不是误报失败。
        asset = this.#lib.db
          .prepare("SELECT id,root_id,path,size,online,trashed,kind,dev,ino FROM assets WHERE root_id=? AND dev=? AND ino=?")
          .get(job.rootId, publishedIdentity.dev, publishedIdentity.ino);
      }
      if (!asset || asset.root_id !== job.rootId || asset.size !== job.bytes
        || asset.online !== 1 || asset.trashed !== 0) {
        fail("INDEX_FAILED", 500);
      }
      let finalStat;
      try {
        finalStat = await fs.lstat(finalPath);
      } catch {
        fail("INDEX_FAILED", 500);
      }
      if (!finalStat.isFile() || finalStat.isSymbolicLink()
        || finalStat.dev !== publishedIdentity.dev || finalStat.ino !== publishedIdentity.ino
        || finalStat.size !== job.bytes) {
        fail("INDEX_FAILED", 500);
      }
      // 新文件由本任务创建：用现有 Library.patch 只设置本条素材的 kind，
      // 扫描已保留分类/子分类/标签/备注，不触碰全局规则或 schema。
      // 仅当发布前快照确认该候选路径没有索引行、且扫描行确为本任务刚发布的
      // dev:ino 时，才视为“本任务新文件”；后台先扫到它不影响这个事实。
      if (created && !preexisting) {
        if (asset.dev !== publishedIdentity.dev || asset.ino !== publishedIdentity.ino) {
          fail("INDEX_FAILED", 500);
        }
        if (asset.kind !== targetKind) {
          try {
            this.#lib.patch(asset.id, { kind: targetKind });
          } catch {
            fail("INDEX_FAILED", 500);
          }
        }
        // 无论是否需要 patch，都在完成前回读最终 kind，避免返回假成功。
        asset = this.#lib.db
          .prepare("SELECT id,root_id,path,size,online,trashed,kind FROM assets WHERE id=?")
          .get(asset.id);
        if (!asset || asset.kind !== targetKind) fail("INDEX_FAILED", 500);
      } else if (asset.kind !== targetKind) {
        // 复用既有文件/资产，或发布前已有同路径/离线个人资产记录时，绝不静默改
        // 个人类型；返回固定冲突码，原文件/原资产不变。
        fail("KIND_CONFLICT", 409);
      }
      this.#jobContextUnchanged(job);
      const after = await this.#assertRootSnapshot(job);
      if (after.generation !== rootSnapshot.generation) fail("ROOT_CHANGED", 409);
      this.#assertRootKind(after.root, job.mediaKind);
      return asset;
    });
  }

  async dispose() {
    this.#disposed = true;
    for (const entry of this.#active.values()) {
      try {
        entry.controller.abort();
      } catch {
        /* 已结束 */
      }
    }
    if (this.#receiver) {
      try {
        await this.#receiver.dispose();
      } catch {
        this.#receiverFaulted = true;
      }
    }
    this.#tempReservations.clear();
    this.#tempReservedBytes = 0;
    if (this.#store) await this.#store.close();
  }
}
