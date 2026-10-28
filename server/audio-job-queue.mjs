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
import { performance } from "node:perf_hooks";
import { types as utilTypes } from "node:util";
import { AudioSnapshotError, assertSourceUnchanged, createSnapshot } from "./audio-snapshot.mjs";

const DEFAULT_MAX_WAITING = 8;
const DEFAULT_MAX_TERMINAL = 100;
const DEFAULT_TERMINAL_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WALL_DEADLINE_MS = 180_000;
const ACTIVE_STATES = new Set(["queued", "validating", "snapshotting", "running", "saving", "cancelling"]);
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
// T13G：保存/撤销回调只允许这些固定码；未知异常一律收敛为 COMMIT_FAILED/ABORT_FAILED，
// 绝不透传自定义 message/status。
const REPORTER_ERROR_CODES = new Set([
  "STORAGE_BUSY",
  "STORAGE_ERROR",
  "STORE_CLOSED",
  "INVALID_TOKEN",
  "TOKEN_CONSUMED",
  "IDENTITY_CHANGED",
  "ASSET_UNAVAILABLE",
  "RESULT_MISMATCH",
  "INVALID_RESULT",
  "RESULT_TOO_LARGE",
  "SCHEMA_CONFLICT",
  "COMMIT_FAILED",
  "ABORT_FAILED",
]);
const REPORTER_MESSAGES = Object.freeze({
  STORAGE_BUSY: "结果存储忙",
  STORAGE_ERROR: "结果存储失败",
  STORE_CLOSED: "结果存储已关闭",
  INVALID_TOKEN: "提交资格无效",
  TOKEN_CONSUMED: "提交资格已被消费",
  IDENTITY_CHANGED: "素材身份已变化",
  ASSET_UNAVAILABLE: "素材当前不可管理",
  RESULT_MISMATCH: "结果与提交资格不匹配",
  INVALID_RESULT: "分析结果无效",
  RESULT_TOO_LARGE: "分析结果超出限制",
  SCHEMA_CONFLICT: "结果存储结构冲突",
  COMMIT_FAILED: "分析结果保存失败",
  ABORT_FAILED: "分析结果撤销失败",
});

export const AUDIO_JOB_STATES = Object.freeze([
  "queued",
  "validating",
  "snapshotting",
  "running",
  "saving",
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
  PROBE_REJECTED: "音频探测结果不符合约束",
  ENGINE_BUSY: "音频引擎忙",
  ENGINE_FAILED: "音频引擎执行失败",
  ENGINE_LEASE_FAILED: "音频引擎运行租约失败",
  INVALID_OUTPUT: "分析输出无效",
  IDENTITY_CHANGED: "素材身份已变化",
  ASSET_UNAVAILABLE: "素材当前不可管理",
  INVALID_TOKEN: "提交资格无效",
  TOKEN_CONSUMED: "提交资格已被消费",
  STORE_BUSY: "结果存储忙",
  STORAGE_ERROR: "结果存储失败",
  COMMIT_FAILED: "分析结果保存失败",
  ABORT_FAILED: "分析结果撤销失败",
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

/**
 * 只按原生品牌/自有描述符判断返回值形态，绝不读取或执行任意 then getter：
 *   "promise" 原生 Promise；"thenable" 普通或访问器 then；"sync" 同步值。
 * 原生 Promise 即使自有 then 被遮蔽也仍判定为 promise。
 */
function returnedKind(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return "sync";
  let genuine;
  try {
    genuine = utilTypes.isPromise(value);
  } catch {
    return "thenable";
  }
  if (genuine) return "promise";
  try {
    let cursor = value;
    for (let depth = 0; depth < 8 && cursor !== null; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, "then");
      if (descriptor !== undefined) {
        // 访问器 then 不执行 getter，按 thenable 拒绝；非函数数据 then 不是 thenable。
        return Object.hasOwn(descriptor, "value") && typeof descriptor.value !== "function"
          ? "sync"
          : "thenable";
      }
      cursor = Object.getPrototypeOf(cursor);
    }
  } catch {
    return "thenable";
  }
  return "sync";
}

const NOOP = () => {};

/**
 * 只消费真正的原生 Promise 拒绝：调用方已用 util.types.isPromise 完成品牌判定；
 * 这里用内置 Promise.prototype.then 挂拒绝处理器，不读取/调用对象自有 then，
 * 不 await，也不安装进程级 unhandledRejection 吞错。
 */
function consumeNativeRejection(value) {
  try {
    Promise.prototype.then.call(value, undefined, NOOP);
  } catch {
    /* 极端 Promise 子类/代理无法挂载时仍固定失败，不扩散异常 */
  }
}

function errorCodeOf(error) {
  try {
    const code = error?.code;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

function reporterError(error, fallback) {
  const code = errorCodeOf(error);
  const raw = code && REPORTER_ERROR_CODES.has(code) ? code : fallback;
  return new AudioQueueError(raw, REPORTER_MESSAGES[raw] || MESSAGES[fallback]);
}

const monoNow = () => performance.now();

function remaining(deadlineAtMs) {
  return deadlineAtMs - monoNow();
}

const CLEANUP_BUDGET_EXHAUSTED = Symbol("audioQueueCleanupBudgetExhausted");

/**
 * 只停止等待，不取消内核/注入组件中的清理；预算耗尽返回哨兵，迟到结果由调用方
 * 单独接管。即使预算已为 0 也先挂拒绝处理器，避免迟到拒绝变成未处理 rejection。
 */
function raceCleanup(promise, budgetMs) {
  const guarded = Promise.resolve(promise);
  if (!(budgetMs > 0)) {
    guarded.catch(NOOP);
    return Promise.resolve(CLEANUP_BUDGET_EXHAUSTED);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(CLEANUP_BUDGET_EXHAUSTED);
    }, budgetMs);
    if (typeof timer.unref === "function") timer.unref();
    guarded.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function withEvidence(target, source) {
  const evidence = source && typeof source === "object" ? source.evidence : null;
  if (evidence && typeof evidence === "object") target.evidence = evidence;
  return target;
}

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
  const fallback =
    phase === "validating" ? "RESOLVER_FAILED" : phase === "snapshotting" ? "SNAPSHOT_FAILED" : "EXECUTION_FAILED";
  if (error instanceof AudioQueueError) {
    // 只保留固定允许码并重建默认文案；不透传注入组件自定义的 message/status。
    return withEvidence(
      Object.hasOwn(MESSAGES, error.code) ? new AudioQueueError(error.code) : new AudioQueueError(fallback),
      error,
    );
  }
  if (error instanceof AudioSnapshotError) {
    return withEvidence(
      Object.hasOwn(MESSAGES, error.code)
        ? new AudioQueueError(error.code, MESSAGES[error.code])
        : new AudioQueueError(fallback),
      error,
    );
  }
  const code = errorCodeOf(error);
  if (phase === "running" && code && EXECUTOR_ERROR_CODES.has(code)) {
    return withEvidence(new AudioQueueError(code, MESSAGES[code]), error);
  }
  return withEvidence(new AudioQueueError(fallback), error);
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
 * @param {(snapshot:object,{signal:AbortSignal,jobId:string,assetId:string})=>Promise<any>|any} options.execute 注入执行器
 * @param {(product:any,info:{jobId:string,assetId:string})=>any} [options.commit] T13G 同步保存回调
 * @param {(product:any,reason:string)=>any} [options.abort] T13G 同步定向撤销回调
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
  #commit;
  #abort;
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
      commit = null,
      abort = null,
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
      (commit !== null && typeof commit !== "function") ||
      (abort !== null && typeof abort !== "function") ||
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
    this.#commit = commit;
    this.#abort = abort;
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
    // saving 是同步 commit 的线性化区间：外部事件无法插入，只记录取消请求；
    // commit 若已成功，终态仍以成功提交为准，不得把已保存任务说成 cancelled。
    if (job.state !== "saving") job.state = "cancelling";
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
      resultSaved: job.resultSaved === true,
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
    const deadlineAtMs = monoNow() + this.#wallDeadlineMs;
    job.startedAt = Date.now();
    // 从等待队列取出后立即脱离 queued，避免“已开始但取消仍按排队处理”的窗口。
    job.state = "validating";
    job.controller = new AbortController();
    const { signal } = job.controller;
    const timer = setTimeout(() => {
      if (isTerminal(job)) return;
      job.timedOut = true;
      if (job.state !== "saving") job.state = "cancelling";
      job.controller?.abort();
    }, this.#wallDeadlineMs);
    let outcome = null;
    let cleanupError = null;
    let leaseReleased = false;
    let committed = false;
    let aborted = false;
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
        deadlineAtMs,
        hooks: this.#hooks.snapshotHooks,
      });
      if (this.#hooks.afterSnapshot) await this.#hooks.afterSnapshot({ job: this.#summary(job), snapshot: job.snapshot });

      current = await this.#resolve(job.assetId);
      if (!sameResolved(current, job.baseline)) fail("SOURCE_CHANGED");
      job.baseline = current;
      if (signal.aborted) fail("CANCELLED");

      job.state = "running";
      job.product = await this.#execute(job.snapshot, {
        signal,
        jobId: job.id,
        assetId: job.assetId,
        deadlineAtMs,
      });
      job.executed = true;
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
        // 安全码优先不等于切断证据：snapshot 的 evidence 可能仍在被迟到 close
        // 更新，必须原样引用而不是重建空错误。
        cleanupError = withEvidence(new AudioQueueError("CLEANUP_FAILED"), error);
      }
      // T13G：execute 在 begin 之后、产物交付之前失败，且流水线定向撤销 token 也失败时，
      // 会抛出 ABORT_FAILED。此时 job.executed=false、没有 product 可交给 abort 回调，
      // 但未消费资格仍在；必须立即进入故障态、保留租约并阻止下一项，且取消/超时/dispose
      // 不得覆盖这一语义。
      const unknownEvidence =
        error?.evidence?.resourceUnknown === true || error?.evidence?.closeSettled === false;
      if (unknownEvidence) {
        // 执行/探测资源未证实回收：sticky 证据必须先于任何破坏性清理被记录。
        // 保留 queue 租约、executor 现场与快照，不启动下一项，也不自动解锁。
        job.resourceUnknown = true;
        this.#leaseBroken = true;
      }
      // createSnapshot 在返回对象前失败时同样可能已有未 settle 的共享副作用
      // （mkdir/marker/output-open/write）；错误 evidence 是唯一交接凭据，
      // 必须保留现场、故障 busy，且不得在迟到完成时自动解锁。
      if (
        error?.evidence?.creationPending === true ||
        error?.evidence?.creationPreserved === true
      ) {
        job.snapshotCreationUnknown = true;
        job.snapshotPreserved = true;
        job.resourceUnknown = true;
        this.#leaseBroken = true;
      }
      if (errorCodeOf(error) === "ABORT_FAILED") {
        this.#leaseBroken = true;
        outcome = withEvidence(new AudioQueueError("ABORT_FAILED"), error);
      } else if (job.timedOut) outcome = withEvidence(new AudioQueueError("TIMEOUT"), error);
      else if (job.cancelRequested || signal.aborted) {
        outcome = withEvidence(new AudioQueueError("CANCELLED"), error);
      } else if (job.state === "running" && EXECUTOR_ERROR_CODES.has(errorCodeOf(error))) {
        // 固定码重建时保留 evidence，避免跨映射丢掉 resourceUnknown/closeSettled。
        outcome = withEvidence(
          new AudioQueueError(errorCodeOf(error), MESSAGES[errorCodeOf(error)]),
          error,
        );
      } else outcome = mapPhaseError(error, job.state === "cancelling" ? "running" : job.state);
    }

    // 清理先于租约释放和终态公布；清理失败 fail-closed，保留租约与 busy。
    if (job.snapshot) {
      if (job.resourceUnknown) {
        // 资源/进程/close 未证实回收：不得删除 executor job 或 snapshot。
        // 只保留现场，终态仍取原固定错误，不把“保留 queue 锁”当作可删快照。
        job.snapshotPreserved = true;
      } else {
        try {
          // 绝对 deadline 不在过期时抹掉；队列与 snapshot 用同一剩余预算停止等待。
          // 预算耗尽只登记一次 pending/unknown，迟到完成不改终态、不自动解锁。
          const cleanupPromise = job.snapshot.cleanup({ deadlineAtMs });
          job.cleanupPending = true;
          const outcomeCleaned = await raceCleanup(cleanupPromise, remaining(deadlineAtMs));
          if (outcomeCleaned === CLEANUP_BUDGET_EXHAUSTED) {
            job.cleanupPending = true;
            job.cleanupSettledLate = false;
            cleanupPromise.then(
              () => {
                job.cleanupPending = false;
                job.cleanupSettledLate = true;
              },
              () => {
                job.cleanupPending = false;
                job.cleanupSettledLate = true;
                job.cleanupLateFailed = true;
              },
            );
            throw new AudioQueueError("CLEANUP_FAILED");
          }
          job.cleanupPending = false;
          job.cleanupSettledLate = true;
        } catch {
          cleanupError = new AudioQueueError("CLEANUP_FAILED");
        }
      }
    }
    if (cleanupError) {
      this.#leaseBroken = true;
      // 清理未 settle/失败优先于 TIMEOUT/CANCELLED 的展示码；但 ABORT_FAILED 是
      // 未消费资格/撤销失败，按原合同优先级不得被清理失败覆盖。
      if (outcome?.code !== "ABORT_FAILED") outcome = cleanupError;
    }

    // T13G：产出了内部结果但尚未成功保存时，取消/超时/源复查失败/清理失败
    // 都必须由队列调用 abort 定向撤销 token；成功 save 后绝不再 abort。
    if (
      job.executed &&
      !committed &&
      (outcome !== null ||
        cleanupError !== null ||
        job.cancelRequested ||
        job.timedOut ||
        signal.aborted)
    ) {
      try {
        this.#callAbort(job.product, outcome?.code || (cleanupError ? "CLEANUP_FAILED" : "CANCELLED"));
        aborted = true;
      } catch {
        this.#leaseBroken = true;
        outcome = new AudioQueueError("ABORT_FAILED");
      }
    }

    if (
      !committed &&
      outcome === null &&
      cleanupError === null &&
      !job.cancelRequested &&
      !job.timedOut &&
      !signal.aborted
    ) {
      job.state = "saving";
      if (this.#commit) {
        try {
          const returned = this.#callCommit(job.product, { jobId: job.id, assetId: job.assetId });
          committed = true;
          job.resultSaved = returned !== false;
        } catch (error) {
          outcome = reporterError(error, "COMMIT_FAILED");
          // save 抛错/异步伪成功后 token 仍未被消费；定向撤销，不能假成功。
          if (!aborted) {
            try {
              this.#callAbort(job.product, outcome.code);
              aborted = true;
            } catch {
              this.#leaseBroken = true;
              outcome = new AudioQueueError("ABORT_FAILED");
            }
          }
        }
      } else {
        // 无持久化模式：保留原 succeeded 语义，但不声称 resultSaved。
        committed = true;
        job.resultSaved = false;
      }
    }

    if (!cleanupError && !this.#leaseBroken) {
      try {
        await this.#releaseLease();
        leaseReleased = true;
      } catch {
        this.#leaseBroken = true;
        if (outcome === null) outcome = new AudioQueueError("LEASE_RELEASE_FAILED");
      }
    }

    clearTimeout(timer);
    job.product = undefined;
    job.executed = false;
    if (committed) {
      // commit 成功是不可逆线性化点：迟到 cancel/timeout/dispose 不能改判 cancelled，
      // 只有提交后的租约释放失败可以 failed 且 resultSaved 必须保持真实。
      if (outcome) this.#finish(job, "failed", outcome);
      else this.#finish(job, "succeeded", null);
    } else if (outcome && outcome.code === "CANCELLED") {
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

  #callCommit(product, info) {
    const returned = this.#commit(product, info);
    const kind = returnedKind(returned);
    if (kind === "promise") {
      consumeNativeRejection(returned);
      throw new AudioQueueError("COMMIT_FAILED");
    }
    if (kind === "thenable") {
      // 普通 thenable 既不调用其 then，也不当作成功；固定失败并走定向撤销。
      throw new AudioQueueError("COMMIT_FAILED");
    }
    return returned;
  }

  #callAbort(product, reason) {
    if (!this.#abort) return;
    const returned = this.#abort(product, reason);
    const kind = returnedKind(returned);
    if (kind === "promise") {
      consumeNativeRejection(returned);
      throw new AudioQueueError("ABORT_FAILED");
    }
    if (kind === "thenable") {
      throw new AudioQueueError("ABORT_FAILED");
    }
    return returned;
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
