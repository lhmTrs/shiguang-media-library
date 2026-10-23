/**
 * T-LOCAL-013B：本地音频分析任务队列（内存态、单 worker）。
 *
 * 边界：
 *   - 只接受内部可信 resolveAsset(assetId) 与 execute(snapshot, {signal})，不接触 HTTP 输入；
 *   - 队列、终态保留和取消都在内存，不建表、不联网、不启动常驻轮询；
 *   - 同 dataDir 使用本模块独立的排他目录租约（与 T12 安装锁无关），已存在一律 fail-closed，
 *     不按 pid/时间自动回收；构造与 get 不写锁；
 *   - 不接入 index、旧 audio-analysis、schema、前端，也不在默认启动路径实例化。
 *
 * 任务状态：queued → validating → snapshotting → running → succeeded；
 * 失败为 failed；取消运行中的任务先进入 cancelling，执行 settle + 快照清理后为 cancelled。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { AudioSnapshotError, assertSourceUnchanged, createSnapshot } from "./audio-snapshot.mjs";

const DEFAULT_MAX_WAITING = 8;
const DEFAULT_MAX_TERMINAL = 100;
const DEFAULT_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WALL_DEADLINE_MS = 180_000;
const ACTIVE_STATES = new Set(["queued", "validating", "snapshotting", "running", "cancelling"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);
const RESOLVER_ERROR_CODES = new Set(["ASSET_NOT_FOUND", "ASSET_BUSY"]);
const EXECUTOR_ERROR_CODES = new Set([
  "TIMEOUT",
  "OUTPUT_LIMIT",
  "INVALID_OUTPUT",
  "ENGINE_FAILED",
  "RESOURCE_LIMIT",
  "CANCELLED",
]);

export const AUDIO_JOB_STATES = Object.freeze([
  "queued",
  "validating",
  "snapshotting",
  "running",
  "succeeded",
  "failed",
  "cancelling",
  "cancelled",
]);

const MESSAGES = Object.freeze({
  INVALID_REQUEST: "请求参数无效",
  QUEUE_DISPOSED: "队列已关闭",
  JOB_NOT_FOUND: "任务不存在",
  ASSET_NOT_FOUND: "素材不存在",
  ASSET_BUSY: "素材正被其它操作占用",
  UNSUPPORTED_ASSET: "素材类型不支持音频分析",
  SOURCE_OFFLINE: "素材已离线",
  SOURCE_TRASHED: "素材在废纸篓",
  SOURCE_RETIRED: "素材已注销",
  ROOT_RETIRED: "素材根已注销",
  SOURCE_MISSING: "源文件不存在",
  SOURCE_NOT_REGULAR: "源不是普通文件",
  SOURCE_OUTSIDE_ROOT: "源超出登记根",
  SOURCE_UNREADABLE: "源文件不可读",
  SOURCE_CHANGED: "源文件已变化",
  INPUT_LIMIT_EXCEEDED: "源文件超出大小限制",
  AUDIO_QUEUE_FULL: "分析队列已满",
  AUDIO_ENGINE_BUSY: "另一个分析队列正在使用该数据目录",
  AUDIO_LEASE_FAILED: "分析队列租约获取失败",
  LEASE_RELEASE_FAILED: "分析队列租约释放失败",
  CLEANUP_FAILED: "任务清理失败",
  RESOLVER_FAILED: "素材校验失败",
  SNAPSHOT_FAILED: "快照失败",
  EXECUTION_FAILED: "分析执行失败",
  TIMEOUT: "分析超时",
  CANCELLED: "任务已取消",
});

export class AudioQueueError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || "队列操作失败");
    this.name = "AudioQueueError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new AudioQueueError(code);
};

const isActive = (job) => ACTIVE_STATES.has(job.state);
const isTerminal = (job) => TERMINAL_STATES.has(job.state);

function validToken(value) {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 200) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function validateResolved(assetId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("ASSET_NOT_FOUND");
  // 只读取一次并复制到本模块自有的基本类型快照；绝不把 resolver 返回的可变对象
  // 当作已接受基线（否则外部原位改 generation 会同时改掉基线）。
  const resolved = {
    assetId: value.assetId,
    kind: value.kind,
    sourcePath: value.sourcePath,
    rootPath: value.rootPath,
    rootId: value.rootId,
    online: value.online,
    trashed: value.trashed,
    retired: value.retired,
    rootRetired: value.rootRetired,
    busy: value.busy,
    assetGeneration: value.assetGeneration,
    libraryGeneration: value.libraryGeneration,
    sourceGeneration: value.sourceGeneration,
  };
  if (resolved.assetId !== assetId) fail("SOURCE_CHANGED");
  if (resolved.kind !== "music" && resolved.kind !== "sfx") fail("UNSUPPORTED_ASSET");
  for (const key of ["sourcePath", "rootPath", "rootId"]) {
    if (typeof resolved[key] !== "string" || !resolved[key]) fail("SOURCE_CHANGED");
  }
  if (!path.isAbsolute(resolved.sourcePath) || !path.isAbsolute(resolved.rootPath)) {
    fail("SOURCE_CHANGED");
  }
  for (const key of ["online", "trashed", "retired", "rootRetired", "busy"]) {
    if (typeof resolved[key] !== "boolean") fail("SOURCE_CHANGED");
  }
  for (const key of ["assetGeneration", "libraryGeneration", "sourceGeneration"]) {
    if (!validToken(resolved[key])) fail("SOURCE_CHANGED");
  }
  if (!resolved.online) fail("SOURCE_OFFLINE");
  if (resolved.trashed) fail("SOURCE_TRASHED");
  if (resolved.retired) fail("SOURCE_RETIRED");
  if (resolved.rootRetired) fail("ROOT_RETIRED");
  if (resolved.busy) fail("ASSET_BUSY");
  return Object.freeze(resolved);
}

function sameResolved(a, b) {
  for (const key of [
    "assetId",
    "kind",
    "sourcePath",
    "rootPath",
    "rootId",
    "assetGeneration",
    "libraryGeneration",
    "sourceGeneration",
    "online",
    "trashed",
    "retired",
    "rootRetired",
    "busy",
  ]) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

function mapPhaseError(error, phase) {
  if (error instanceof AudioQueueError) return error;
  if (error instanceof AudioSnapshotError) return new AudioQueueError(error.code, MESSAGES[error.code]);
  if (phase === "validating") return new AudioQueueError("RESOLVER_FAILED");
  if (phase === "snapshotting") return new AudioQueueError("SNAPSHOT_FAILED");
  return new AudioQueueError("EXECUTION_FAILED");
}

async function readSmallJson(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    if (raw.length > 4096) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {string} options.dataDir 应用数据目录（租约和任务目录都在其 audio-jobs/ 下）
 * @param {(assetId:string)=>Promise<object>|object} options.resolveAsset 可信内部解析器
 * @param {(snapshot:object,{signal:AbortSignal})=>Promise<any>|any} options.execute 注入执行器
 * @param {number} [options.maxWaiting=8]
 * @param {number} [options.maxTerminal=100]
 * @param {number} [options.terminalTtlMs]
 * @param {number} [options.wallDeadlineMs=180000]
 * @param {number} [options.maxSnapshotBytes]
 * @param {object} [options.hooks] 测试注入：afterSnapshot / afterExecute / snapshotHooks
 */
export class AudioJobQueue {
  #dataDir;
  #resolveAsset;
  #execute;
  #maxWaiting;
  #maxTerminal;
  #terminalTtlMs;
  #wallDeadlineMs;
  #maxSnapshotBytes;
  #hooks;
  #jobs = new Map();
  #waiting = [];
  #activeJob = null;
  #worker = null;
  #lease = null;
  #leaseBroken = false;
  #disposed = false;
  #disposePromise = null;
  #submitChain = Promise.resolve();

  constructor(options = {}) {
    const {
      dataDir,
      resolveAsset,
      execute,
      maxWaiting = DEFAULT_MAX_WAITING,
      maxTerminal = DEFAULT_MAX_TERMINAL,
      terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
      wallDeadlineMs = DEFAULT_WALL_DEADLINE_MS,
      maxSnapshotBytes,
      hooks = {},
    } = options;
    if (
      typeof dataDir !== "string" ||
      !dataDir ||
      typeof resolveAsset !== "function" ||
      typeof execute !== "function" ||
      !Number.isSafeInteger(maxWaiting) ||
      maxWaiting < 1 ||
      !Number.isSafeInteger(maxTerminal) ||
      maxTerminal < 1 ||
      !Number.isSafeInteger(terminalTtlMs) ||
      terminalTtlMs < 0 ||
      !Number.isSafeInteger(wallDeadlineMs) ||
      wallDeadlineMs < 1 ||
      (maxSnapshotBytes !== undefined && (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 0))
    ) {
      throw new AudioQueueError("INVALID_REQUEST");
    }
    this.#dataDir = path.resolve(dataDir);
    this.#resolveAsset = resolveAsset;
    this.#execute = execute;
    this.#maxWaiting = maxWaiting;
    this.#maxTerminal = maxTerminal;
    this.#terminalTtlMs = terminalTtlMs;
    this.#wallDeadlineMs = wallDeadlineMs;
    this.#maxSnapshotBytes = maxSnapshotBytes;
    this.#hooks = hooks && typeof hooks === "object" ? hooks : {};
  }

  /** 只读 busy：有排队/运行任务或持有租约。供未来换库互斥判断，不写锁。 */
  get busy() {
    return this.#activeJob !== null || this.#waiting.length > 0 || this.#lease !== null || this.#leaseBroken;
  }

  async submit(assetId, options = {}) {
    if (this.#disposed) fail("QUEUE_DISPOSED");
    if (typeof assetId !== "string" || !assetId || assetId.length > 200) fail("INVALID_REQUEST");
    if (options === null || typeof options !== "object" || Array.isArray(options)) fail("INVALID_REQUEST");
    const keys = Object.keys(options);
    if (keys.some((key) => key !== "force")) fail("INVALID_REQUEST");
    if ("force" in options && typeof options.force !== "boolean") fail("INVALID_REQUEST");
    const force = options.force === true;

    return this.#serialize(async () => {
      this.#pruneTerminal();
      for (const job of this.#jobs.values()) {
        if (job.assetId === assetId && isActive(job)) return this.#summary(job);
      }
      const resolved = validateResolved(assetId, await this.#resolve(assetId));
      if (this.#disposed) fail("QUEUE_DISPOSED");
      if (this.#waiting.length - (this.#activeJob ? 0 : 1) >= this.#maxWaiting) {
        fail("AUDIO_QUEUE_FULL");
      }
      const job = {
        id: crypto.randomUUID(),
        assetId,
        force,
        state: "queued",
        error: null,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        controller: null,
        baseline: resolved,
        snapshot: null,
        cancelRequested: false,
        timedOut: false,
      };
      this.#jobs.set(job.id, job);
      this.#waiting.push(job);
      this.#kick();
      return this.#summary(job);
    });
  }

  async get(jobId) {
    this.#pruneTerminal();
    if (typeof jobId !== "string" || !jobId) fail("JOB_NOT_FOUND");
    const job = this.#jobs.get(jobId);
    if (!job) fail("JOB_NOT_FOUND");
    return this.#summary(job);
  }

  async cancel(jobId) {
    this.#pruneTerminal();
    if (typeof jobId !== "string" || !jobId) fail("JOB_NOT_FOUND");
    const job = this.#jobs.get(jobId);
    if (!job) fail("JOB_NOT_FOUND");
    if (isTerminal(job)) return this.#summary(job);
    if (job.state === "queued") {
      const index = this.#waiting.indexOf(job);
      if (index >= 0) this.#waiting.splice(index, 1);
      this.#finish(job, "cancelled", null);
      return this.#summary(job);
    }
    job.cancelRequested = true;
    job.state = "cancelling";
    job.controller?.abort();
    return this.#summary(job);
  }

  /** 取消排队与活跃任务，await execute settle/快照清理；不自动恢复队列。 */
  async dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = (async () => {
      for (const job of [...this.#waiting]) {
        if (job.state === "queued") this.#finish(job, "cancelled", null);
      }
      this.#waiting = [];
      if (this.#activeJob) {
        this.#activeJob.cancelRequested = true;
        if (!isTerminal(this.#activeJob)) this.#activeJob.state = "cancelling";
        this.#activeJob.controller?.abort();
      }
      await this.#worker?.catch(() => {});
    })();
    return this.#disposePromise;
  }

  #serialize(fn) {
    const run = this.#submitChain.then(fn, fn);
    this.#submitChain = run.catch(() => {});
    return run;
  }

  #summary(job) {
    return {
      id: job.id,
      assetId: job.assetId,
      state: job.state,
      queuePosition: job.state === "queued" ? this.#waiting.indexOf(job) + 1 : null,
      error: job.error ? { code: job.error.code, message: job.error.message } : null,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  async #resolve(assetId) {
    let value;
    try {
      value = await this.#resolveAsset(assetId);
    } catch (error) {
      if (error && RESOLVER_ERROR_CODES.has(error.code)) {
        throw new AudioQueueError(error.code, MESSAGES[error.code]);
      }
      throw new AudioQueueError("RESOLVER_FAILED");
    }
    return validateResolved(assetId, value);
  }

  #kick() {
    if (this.#worker || this.#disposed || this.#leaseBroken) return;
    this.#worker = this.#drain()
      .catch(() => {})
      .finally(() => {
        this.#worker = null;
        if (!this.#disposed && !this.#leaseBroken && this.#waiting.length > 0) this.#kick();
      });
  }

  async #drain() {
    while (!this.#disposed && this.#waiting.length > 0 && !this.#leaseBroken) {
      const job = this.#waiting.shift();
      if (!job || job.state !== "queued") continue;
      await this.#runJob(job);
    }
  }

  async #runJob(job) {
    this.#activeJob = job;
    job.startedAt = Date.now();
    // 从等待队列取出后立即脱离 queued，避免“已开始但取消仍按排队处理”的窗口。
    job.state = "validating";
    job.controller = new AbortController();
    const { signal } = job.controller;
    const timer = setTimeout(() => {
      if (isTerminal(job)) return;
      job.timedOut = true;
      job.state = "cancelling";
      job.controller?.abort();
    }, this.#wallDeadlineMs);
    let outcome = null;
    let cleanupError = null;
    let leaseReleased = false;
    try {
      await this.#acquireLease();
      if (signal.aborted) fail("CANCELLED");
      let current = await this.#resolve(job.assetId);
      if (!sameResolved(current, job.baseline)) fail("SOURCE_CHANGED");
      job.baseline = current;
      if (signal.aborted) fail("CANCELLED");

      job.state = "snapshotting";
      job.snapshot = await createSnapshot({
        dataDir: this.#dataDir,
        rootPath: current.rootPath,
        sourcePath: current.sourcePath,
        maxBytes: this.#maxSnapshotBytes,
        signal,
        jobId: job.id,
        hooks: this.#hooks.snapshotHooks,
      });
      if (this.#hooks.afterSnapshot) await this.#hooks.afterSnapshot({ job: this.#summary(job), snapshot: job.snapshot });

      current = await this.#resolve(job.assetId);
      if (!sameResolved(current, job.baseline)) fail("SOURCE_CHANGED");
      job.baseline = current;
      if (signal.aborted) fail("CANCELLED");

      job.state = "running";
      await this.#execute(job.snapshot, { signal });
      if (this.#hooks.afterExecute) await this.#hooks.afterExecute({ job: this.#summary(job), snapshot: job.snapshot });

      if (job.cancelRequested || signal.aborted) {
        outcome = job.timedOut
          ? new AudioQueueError("TIMEOUT")
          : new AudioQueueError("CANCELLED");
      } else {
        current = await this.#resolve(job.assetId);
        if (!sameResolved(current, job.baseline)) fail("SOURCE_CHANGED");
        await assertSourceUnchanged(job.snapshot);
        if (job.cancelRequested || signal.aborted) {
          outcome = job.timedOut ? new AudioQueueError("TIMEOUT") : new AudioQueueError("CANCELLED");
        }
      }
    } catch (error) {
      // createSnapshot 在返回前就清理失败时不会给 queue snapshot 对象；这一错误同样
      // 表示本次任务目录未清理干净，必须进入不可释放租约的故障态，且优先于取消/超时。
      if (
        (error instanceof AudioSnapshotError || error instanceof AudioQueueError) &&
        error.code === "CLEANUP_FAILED"
      ) {
        cleanupError = new AudioQueueError("CLEANUP_FAILED");
      }
      if (job.timedOut) outcome = new AudioQueueError("TIMEOUT");
      else if (job.cancelRequested || signal.aborted) outcome = new AudioQueueError("CANCELLED");
      else if (job.state === "running" && EXECUTOR_ERROR_CODES.has(error?.code)) {
        outcome = new AudioQueueError(error.code, MESSAGES[error.code]);
      } else outcome = mapPhaseError(error, job.state === "cancelling" ? "running" : job.state);
    }

    // 清理先于租约释放和终态公布；清理失败 fail-closed，保留租约与 busy。
    if (job.snapshot) {
      try {
        await job.snapshot.cleanup();
      } catch {
        cleanupError = new AudioQueueError("CLEANUP_FAILED");
      }
    }
    if (cleanupError) {
      this.#leaseBroken = true;
      outcome = cleanupError;
    } else {
      try {
        await this.#releaseLease();
        leaseReleased = true;
      } catch {
        this.#leaseBroken = true;
        outcome = new AudioQueueError("LEASE_RELEASE_FAILED");
      }
    }

    clearTimeout(timer);
    if (outcome && outcome.code === "CANCELLED") {
      this.#finish(job, "cancelled", null);
    } else if (outcome) {
      this.#finish(job, "failed", outcome);
    } else if (job.timedOut) {
      this.#finish(job, "failed", new AudioQueueError("TIMEOUT"));
    } else if (job.cancelRequested || signal.aborted) {
      this.#finish(job, "cancelled", null);
    } else {
      this.#finish(job, "succeeded", null);
    }
    this.#activeJob = null;
    job.controller = null;
    this.#pruneTerminal();
    if (!leaseReleased && !this.#leaseBroken) this.#lease = null;
  }

  #finish(job, state, error) {
    job.state = state;
    job.error = error ? { code: error.code, message: error.message } : null;
    job.finishedAt = Date.now();
    job.controller = null;
  }

  #pruneTerminal() {
    const now = Date.now();
    const terminal = [...this.#jobs.values()].filter(isTerminal);
    const expired = new Set(
      terminal.filter((job) => job.finishedAt !== null && now - job.finishedAt > this.#terminalTtlMs),
    );
    const alive = terminal
      .filter((job) => !expired.has(job))
      .sort((a, b) => b.finishedAt - a.finishedAt);
    for (const job of alive.slice(this.#maxTerminal)) expired.add(job);
    for (const job of expired) this.#jobs.delete(job.id);
  }

  async #acquireLease() {
    const base = path.join(this.#dataDir, "audio-jobs");
    const lockRoot = path.join(base, ".queue-lease");
    const token = crypto.randomBytes(16).toString("hex");
    try {
      await fs.mkdir(base, { recursive: true, mode: 0o700 });
      await fs.chmod(base, 0o700).catch(() => {});
      await fs.mkdir(lockRoot, { mode: 0o700 });
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code)) {
        // 已存在锁（含无 owner/身份不可验证/旧进程已死）一律 BUSY；不自动回收。
        throw new AudioQueueError("AUDIO_ENGINE_BUSY");
      }
      throw new AudioQueueError("AUDIO_LEASE_FAILED");
    }
    const owner = {
      pid: process.pid,
      token,
      purpose: "audio-job-queue",
      startedAt: new Date().toISOString(),
    };
    try {
      await fs.writeFile(path.join(lockRoot, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      // 只回收本进程刚 mkdir、仍无 owner 的空锁；其它情况保留。
      const marker = await exists(path.join(lockRoot, "owner.json"));
      if (!marker) await fs.rmdir(lockRoot).catch(() => {});
      throw new AudioQueueError("AUDIO_LEASE_FAILED");
    }
    this.#lease = { token };
  }

  async #releaseLease() {
    if (!this.#lease) return;
    const base = path.join(this.#dataDir, "audio-jobs");
    const lockRoot = path.join(base, ".queue-lease");
    const owner = await readSmallJson(path.join(lockRoot, "owner.json"));
    if (!owner || owner.token !== this.#lease.token || owner.purpose !== "audio-job-queue") {
      throw new AudioQueueError("LEASE_RELEASE_FAILED");
    }
    try {
      await fs.rm(lockRoot, { recursive: true, force: true });
    } catch {
      throw new AudioQueueError("LEASE_RELEASE_FAILED");
    }
    if (await exists(lockRoot)) throw new AudioQueueError("LEASE_RELEASE_FAILED");
    this.#lease = null;
  }
}
