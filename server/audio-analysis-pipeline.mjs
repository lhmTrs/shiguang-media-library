/**
 * T-LOCAL-013G：合成音频分析流水线（内部可信依赖注入）。
 *
 * 把已通过的快照（T13B）、结果规范化（T13D）、结果存储提交令牌（T13E/F）
 * 与任务队列（T13B/T13G）串成一条可测链路：
 *
 *   queue 流式快照 digest/bytes → 有界合成 probe → 引擎运行租约/可信 descriptor
 *   → T13D context → store.begin 资格 → 合成 execute → T13D 规范化
 *   → 运行租约释放 → 队列最终源/管理身份复查 → 快照清理
 *   → 同步 store.save → 队列租约释放/终态
 *
 * 边界：
 *   - probe/execute 本轮是有界合成替身，不代表真实媒体 probe、真实发行引擎协议
 *     或正式兼容；不运行真实音频、不接 Library/迁移/执行链/HTTP/前端。
 *   - 不接受浏览器命令/路径/URL；所有输入来自注入函数与内部队列。
 *   - 对外摘要只含阶段/固定错误/resultSaved，不暴露 raw、token、源路径或私有元数据。
 *   - 构造不写库；必须显式 init()。dispose 后不接受新任务，也不自动恢复队列。
 */
import { types as utilTypes } from "node:util";
import { performance } from "node:perf_hooks";
import { AudioJobQueue, AudioQueueError } from "./audio-job-queue.mjs";
import { normalizeAudioResult } from "./audio-result.mjs";

const MESSAGES = Object.freeze({
  INVALID_REQUEST: "请求参数无效",
  PIPELINE_NOT_INITIALIZED: "分析流水线尚未初始化",
  PIPELINE_DISPOSED: "分析流水线已关闭",
  JOB_NOT_FOUND: "任务不存在",
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
  RESOLVER_FAILED: "素材身份解析失败",
  ABORT_FAILED: "提交资格撤销失败",
  CANCELLED: "任务已取消",
  TIMEOUT: "分析超时",
});

const SUPPORTED_FORMATS = new Set(["wav", "flac", "mp3", "aac", "m4a", "aiff", "aif", "ogg", "opus"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GENERATION_HEX = /^[0-9a-f]{32,64}$/;
const ENGINE_VERSION = /^[A-Za-z0-9._+-]{1,128}$/;
const EXECUTOR_CODES = new Set([
  "TIMEOUT",
  "OUTPUT_LIMIT",
  "INVALID_OUTPUT",
  "ENGINE_FAILED",
  "RESOURCE_LIMIT",
  "CANCELLED",
]);

const OPTION_KEYS = new Set([
  "dataDir",
  "resolveAsset",
  "store",
  "resolveCurrent",
  "probe",
  "withRunLease",
  "withLifecycleScope",
  "execute",
  "maxWaiting",
  "maxTerminal",
  "terminalTtlMs",
  "wallDeadlineMs",
  "maxSnapshotBytes",
  "hooks",
]);

const PIPELINE_FAULT = Symbol("pipelineFault");

const monoNow = () => performance.now();

function isResourceUnknown(error) {
  try {
    return error?.evidence?.resourceUnknown === true || error?.evidence?.closeSettled === false;
  } catch {
    return false;
  }
}

function copyEvidence(target, source) {
  try {
    const evidence = source?.evidence;
    if (evidence && typeof evidence === "object") target.evidence = evidence;
  } catch {
    /* 证据只做内部附加，读取失败不改变固定码 */
  }
  return target;
}

/** 把 scope acquire/release unknown 统一标记为 resourceUnknown，供 queue 保留租约。 */
function markScopeUnknown(target, source) {
  try {
    const evidence = source?.evidence;
    if (!evidence || typeof evidence !== "object") return target;
    const unknown =
      evidence.resourceUnknown === true ||
      evidence.scopeAcquire === "unknown" ||
      evidence.scopeRelease === "pending" ||
      evidence.faulted === true;
    if (unknown) target.evidence = { ...evidence, resourceUnknown: true };
  } catch {
    /* 证据只做内部附加 */
  }
  return target;
}

function pipelineError(code) {
  const error = new AudioQueueError(code, MESSAGES[code] || MESSAGES.ENGINE_FAILED);
  // 标记本流水线在注入边界之后重建的固定错误；外层租约/取消映射必须原样保留，
  // 避免二次映射改码。注入组件无法拿到该私有 symbol。
  Object.defineProperty(error, PIPELINE_FAULT, { value: true });
  return error;
}

function isPipelineFault(error) {
  try {
    return error !== null && typeof error === "object" && error[PIPELINE_FAULT] === true;
  } catch {
    return false;
  }
}

/**
 * 只按原生品牌/自有描述符判断返回值形态，绝不读取或执行任意 then getter：
 *   "promise" 原生 Promise；"thenable" 普通或访问器 then；"sync" 同步值。
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

/** 用内置 Promise.prototype.then 消费原生拒绝，不调用对象自有 then。 */
function consumeNativeRejection(value) {
  try {
    Promise.prototype.then.call(value, undefined, NOOP);
  } catch {
    /* 极端子类/代理无法挂载时仍固定失败，不扩散异常 */
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

/** 注入组件边界：只允许固定码 + 本地默认文案，不透传原始 message/status。 */
function mapAllowedError(error, allowed, fallback) {
  const code = errorCodeOf(error);
  return pipelineError(code && allowed.has(code) ? code : fallback);
}

function readData(object, keys, { exact = true } = {}) {
  if (object === null || typeof object !== "object" || Array.isArray(object)) return null;
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Reflect.ownKeys(object);
  if (exact && own.length !== keys.length) return null;
  const allowed = new Set(keys);
  for (const key of own) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    // 任何访问器/非法描述符一律拒绝，且不执行 getter；extra 只允许纯数据字段。
    if (!descriptor || !("value" in descriptor)) return null;
    if (!exact && !allowed.has(key) && typeof key !== "string") return null;
  }
  const out = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) return null;
    out[key] = descriptor.value;
  }
  return out;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw pipelineError("CANCELLED");
}

function validateProbe(raw) {
  const probe = readData(
    raw,
    ["durationSec", "channels", "sampleRate", "totalSamples", "format"],
    { exact: false },
  );
  if (!probe) throw pipelineError("PROBE_REJECTED");
  const { durationSec, channels, sampleRate, totalSamples, format } = probe;
  if (typeof durationSec !== "number" || !Number.isFinite(durationSec) || durationSec < 0 || durationSec > 600) {
    throw pipelineError("PROBE_REJECTED");
  }
  if (!Number.isSafeInteger(channels) || channels < 1 || channels > 2) {
    throw pipelineError("PROBE_REJECTED");
  }
  if (typeof sampleRate !== "number" || !Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 48_000) {
    throw pipelineError("PROBE_REJECTED");
  }
  if (!Number.isSafeInteger(totalSamples) || totalSamples < 0 || totalSamples > 60_000_000) {
    throw pipelineError("PROBE_REJECTED");
  }
  if (typeof format !== "string" || !SUPPORTED_FORMATS.has(format)) {
    throw pipelineError("PROBE_REJECTED");
  }
  return Object.freeze({ durationSec, channels, sampleRate, totalSamples, format });
}

function validateDescriptor(raw) {
  const descriptor = readData(raw, ["version", "binarySha256", "generation"], { exact: false });
  if (!descriptor) throw pipelineError("ENGINE_FAILED");
  const { version, binarySha256, generation } = descriptor;
  if (typeof version !== "string" || !ENGINE_VERSION.test(version)) {
    throw pipelineError("ENGINE_FAILED");
  }
  if (typeof binarySha256 !== "string" || !SHA256_HEX.test(binarySha256)) {
    throw pipelineError("ENGINE_FAILED");
  }
  if (typeof generation !== "string" || !GENERATION_HEX.test(generation)) {
    throw pipelineError("ENGINE_FAILED");
  }
  // 可信执行器还需要 engine 交付的 binaryPath/size/platform/arch 等字段。这里只
  // 做“纯数据快照”后原样转交，执行器会再次完整校验；context 仍只取上列三项。
  const full = snapshotDescriptorData(raw);
  if (!full) throw pipelineError("ENGINE_FAILED");
  return Object.freeze({
    trusted: Object.freeze({ version, binarySha256, generation }),
    full,
  });
}

/** 只复制自有字符串键的原始数据字段；拒绝访问器/符号键/对象值，避免转交可变引用。 */
function snapshotDescriptorData(raw) {
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return null;
  // null prototype：即使上游带 "__proto__"/"constructor" 数据键也不会改写原型。
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== "string") return null;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) return null;
    const value = descriptor.value;
    if (value !== null && typeof value === "object") return null;
    out[key] = value;
  }
  return Object.freeze(out);
}

function buildContext(identity, snapshot, probe, descriptor) {
  return Object.freeze({
    kind: identity.kind,
    sourceSha256: snapshot.sha256,
    sourceSize: snapshot.bytes,
    durationSec: probe.durationSec,
    engineVersion: descriptor.version,
    engineBinarySha256: descriptor.binarySha256,
    engineGeneration: descriptor.generation,
    parameters: Object.freeze({ brief: true }),
  });
}

const PROBE_ERROR_CODES = new Set(["CANCELLED", "TIMEOUT", "ENGINE_BUSY"]);
const LEASE_ERROR_CODES = new Set(["CANCELLED", "TIMEOUT", "ENGINE_BUSY", "ABORT_FAILED"]);
const STORE_FAULT_CODES = new Set([
  "IDENTITY_CHANGED",
  "ASSET_UNAVAILABLE",
  "RESOLVER_FAILED",
  "INVALID_TOKEN",
  "TOKEN_CONSUMED",
]);

function mapProbeError(error, signal) {
  if (signal?.aborted) return pipelineError("CANCELLED");
  return markScopeUnknown(copyEvidence(mapAllowedError(error, PROBE_ERROR_CODES, "PROBE_REJECTED"), error), error);
}

function mapLeaseError(error, signal) {
  // 已经在注入边界重建过的固定错误（含 ABORT_FAILED）不得被二次映射覆盖。
  if (isPipelineFault(error)) return error;
  // ABORT_FAILED 表示 begin 后的定向撤销失败；即使同时取消/超时也不能被覆盖。
  if (errorCodeOf(error) === "ABORT_FAILED") return pipelineError("ABORT_FAILED");
  if (signal?.aborted) return pipelineError("CANCELLED");
  const code = errorCodeOf(error);
  if (code === "CANCELLED" || code === "TIMEOUT" || code === "ENGINE_BUSY") {
    return pipelineError(code);
  }
  if (code === "BUSY" || code === "AUDIO_ENGINE_BUSY") return pipelineError("ENGINE_BUSY");
  return markScopeUnknown(copyEvidence(pipelineError("ENGINE_LEASE_FAILED"), error), error);
}

function mapExecutionError(error, signal) {
  if (signal?.aborted) return pipelineError("CANCELLED");
  const code = errorCodeOf(error);
  return copyEvidence(pipelineError(code && EXECUTOR_CODES.has(code) ? code : "ENGINE_FAILED"), error);
}

function mapStoreError(error) {
  const code = errorCodeOf(error);
  if (code === "STORAGE_BUSY" || code === "STORE_BUSY") return pipelineError("STORE_BUSY");
  if (STORE_FAULT_CODES.has(code)) return pipelineError(code);
  return pipelineError("STORAGE_ERROR");
}

/**
 * 合成分析流水线。
 *
 * @param {object} options
 * @param {string} options.dataDir 应用数据目录
 * @param {(assetId:string)=>Promise<object>|object} options.resolveAsset 队列身份
 * @param {object} options.store AudioResultStore 同步实例
 * @param {(assetId:string)=>object|null} options.resolveCurrent 存储身份（含 context）
 * @param {(snapshot:object,{signal:AbortSignal})=>Promise<object>|object} options.probe 受约束合成 probe
 * @param {(callback:Function,{signal:AbortSignal})=>Promise<any>} options.withRunLease 引擎运行租约
 * @param {(snapshot:object,descriptor:object,{signal:AbortSignal})=>Promise<string|Buffer>|string|Buffer} options.execute 合成执行器
 */
export class AudioAnalysisPipeline {
  #queue;
  #store;
  #resolveAsset;
  #resolveCurrent;
  #probe;
  #withRunLease;
  #withLifecycleScope;
  #execute;
  #identities = new Map();
  #initialized = false;
  #disposed = false;
  #disposePromise = null;

  constructor(options) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw pipelineError("INVALID_REQUEST");
    }
    for (const key of Object.keys(options)) {
      if (!OPTION_KEYS.has(key)) throw pipelineError("INVALID_REQUEST");
    }
    const {
      dataDir,
      resolveAsset,
      store,
      resolveCurrent,
      probe,
      withRunLease,
      withLifecycleScope,
      execute,
      maxWaiting,
      maxTerminal,
      terminalTtlMs,
      wallDeadlineMs,
      maxSnapshotBytes,
      hooks,
    } = options;
    if (
      typeof dataDir !== "string" ||
      !dataDir ||
      typeof resolveAsset !== "function" ||
      typeof resolveCurrent !== "function" ||
      typeof probe !== "function" ||
      typeof withRunLease !== "function" ||
      (withLifecycleScope !== undefined && typeof withLifecycleScope !== "function") ||
      typeof execute !== "function" ||
      store === null ||
      typeof store !== "object" ||
      typeof store.initSchema !== "function" ||
      typeof store.begin !== "function" ||
      typeof store.save !== "function" ||
      typeof store.get !== "function" ||
      typeof store.invalidateToken !== "function"
    ) {
      throw pipelineError("INVALID_REQUEST");
    }
    this.#store = store;
    this.#resolveAsset = resolveAsset;
    this.#resolveCurrent = resolveCurrent;
    this.#probe = probe;
    this.#withRunLease = withRunLease;
    this.#withLifecycleScope = withLifecycleScope || null;
    this.#execute = execute;
    this.#queue = new AudioJobQueue({
      dataDir,
      resolveAsset: (assetId) => this.#resolveQueueAsset(assetId),
      execute: (snapshot, context) => this.#run(snapshot, context),
      commit: (product) => this.#commit(product),
      abort: (product, reason) => this.#abort(product, reason),
      ...(maxWaiting === undefined ? {} : { maxWaiting }),
      ...(maxTerminal === undefined ? {} : { maxTerminal }),
      ...(terminalTtlMs === undefined ? {} : { terminalTtlMs }),
      ...(wallDeadlineMs === undefined ? {} : { wallDeadlineMs }),
      ...(maxSnapshotBytes === undefined ? {} : { maxSnapshotBytes }),
      hooks: hooks && typeof hooks === "object" ? hooks : {},
    });
  }

  /** 显式初始化存储 schema；未 init 的 submit/getResult 固定拒绝。 */
  init() {
    if (this.#disposed) throw pipelineError("PIPELINE_DISPOSED");
    let outcome;
    try {
      outcome = this.#store.initSchema();
    } catch (error) {
      throw mapStoreError(error);
    }
    // 同步契约：返回 Promise/thenable 不算初始化成功；原生拒绝安全消费，不 await。
    const kind = returnedKind(outcome);
    if (kind === "promise") consumeNativeRejection(outcome);
    if (kind !== "sync") throw pipelineError("STORAGE_ERROR");
    let details;
    try {
      details = readData(outcome, ["schemaVersion", "created"], { exact: false });
    } catch {
      details = null;
    }
    if (!details) throw pipelineError("STORAGE_ERROR");
    this.#initialized = true;
    return Object.freeze({ ok: true, schemaVersion: details.schemaVersion, created: details.created });
  }

  async submit(assetId, options = {}) {
    if (this.#disposed) throw pipelineError("PIPELINE_DISPOSED");
    if (!this.#initialized) throw pipelineError("PIPELINE_NOT_INITIALIZED");
    try {
      return await this.#queue.submit(assetId, options);
    } catch (error) {
      if (error instanceof AudioQueueError) throw error;
      throw pipelineError("INVALID_REQUEST");
    }
  }

  async get(jobId) {
    return this.#queue.get(jobId);
  }

  async cancel(jobId) {
    return this.#queue.cancel(jobId);
  }

  /** 取消并等待执行 settle/快照清理；之后不接受新任务，不自动恢复。 */
  async dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    this.#disposePromise = this.#queue.dispose();
    return this.#disposePromise;
  }

  /**
   * 只读结果：用当前可信身份 context 查询 store，返回 missing/ready/stale。
   * 不返回路径、token 或队列内部产物。
   */
  getResult(assetId) {
    // dispose 只阻止新任务；已保存结果仍可只读查询（不重开队列）。
    if (!this.#initialized) throw pipelineError("PIPELINE_NOT_INITIALIZED");
    let current;
    try {
      current = this.#resolveCurrent(assetId);
    } catch {
      throw pipelineError("RESOLVER_FAILED");
    }
    const currentKind = returnedKind(current);
    if (currentKind === "promise") consumeNativeRejection(current);
    if (currentKind !== "sync") throw pipelineError("RESOLVER_FAILED");
    if (current === null || current === undefined) {
      return Object.freeze({ ok: true, status: "missing" });
    }
    let identity;
    try {
      identity = readData(current, [
        "assetId",
        "rootId",
        "kind",
        "online",
        "trashed",
        "retired",
        "rootRetired",
        "busy",
        "libraryGeneration",
        "assetGeneration",
        "sourceGeneration",
        "context",
      ]);
    } catch {
      identity = null;
    }
    if (!identity) throw pipelineError("RESOLVER_FAILED");
    let record;
    try {
      record = this.#store.get(assetId, identity.context);
    } catch (error) {
      throw mapStoreError(error);
    }
    const recordKind = returnedKind(record);
    if (recordKind === "promise") consumeNativeRejection(record);
    if (recordKind !== "sync") throw pipelineError("STORAGE_ERROR");
    return record;
  }

  /* ---------------------------------------------------------------- */
  /* internals                                                        */
  /* ---------------------------------------------------------------- */

  async #resolveQueueAsset(assetId) {
    let value;
    try {
      value = await this.#resolveAsset(assetId);
    } catch {
      throw pipelineError("RESOLVER_FAILED");
    }
    if (value === null || value === undefined) {
      this.#identities.delete(assetId);
      return value;
    }
    let queueIdentity;
    try {
      queueIdentity = readData(value, [
        "assetId",
        "kind",
        "sourcePath",
        "rootPath",
        "rootId",
        "online",
        "trashed",
        "retired",
        "rootRetired",
        "busy",
        "assetGeneration",
        "libraryGeneration",
        "sourceGeneration",
      ]);
    } catch {
      queueIdentity = null;
    }
    if (!queueIdentity || queueIdentity.assetId !== assetId) {
      this.#identities.delete(assetId);
      throw pipelineError("RESOLVER_FAILED");
    }

    let current;
    try {
      current = this.#resolveCurrent(assetId);
    } catch {
      throw pipelineError("RESOLVER_FAILED");
    }
    const currentKind = returnedKind(current);
    if (currentKind === "promise") consumeNativeRejection(current);
    if (currentKind !== "sync") throw pipelineError("RESOLVER_FAILED");
    if (current === null || current === undefined) {
      this.#identities.delete(assetId);
      throw pipelineError("ASSET_UNAVAILABLE");
    }
    let storeIdentity;
    try {
      storeIdentity = readData(current, [
        "assetId",
        "rootId",
        "kind",
        "online",
        "trashed",
        "retired",
        "rootRetired",
        "busy",
        "libraryGeneration",
        "assetGeneration",
        "sourceGeneration",
        "context",
      ]);
    } catch {
      storeIdentity = null;
    }
    if (!storeIdentity) throw pipelineError("RESOLVER_FAILED");
    // 两种身份必须指向同一对象/同一 generation，不能凭空生成新 generation
    // 绕过队列已有比较。
    for (const key of [
      "assetId",
      "rootId",
      "kind",
      "libraryGeneration",
      "assetGeneration",
      "sourceGeneration",
      "online",
      "trashed",
      "retired",
      "rootRetired",
      "busy",
    ]) {
      if (storeIdentity[key] !== queueIdentity[key]) throw pipelineError("IDENTITY_CHANGED");
    }
    this.#identities.set(
      assetId,
      Object.freeze({
        assetId: storeIdentity.assetId,
        rootId: storeIdentity.rootId,
        kind: storeIdentity.kind,
        online: storeIdentity.online,
        trashed: storeIdentity.trashed,
        retired: storeIdentity.retired,
        rootRetired: storeIdentity.rootRetired,
        busy: storeIdentity.busy,
        libraryGeneration: storeIdentity.libraryGeneration,
        assetGeneration: storeIdentity.assetGeneration,
        sourceGeneration: storeIdentity.sourceGeneration,
      }),
    );
    return value;
  }

  async #run(snapshot, context = {}) {
    if (!snapshot || typeof snapshot !== "object" || typeof context.jobId !== "string") {
      throw pipelineError("INVALID_REQUEST");
    }
    const { signal, jobId, assetId } = context;
    const deadlineAtMs =
      typeof context.deadlineAtMs === "number" && Number.isFinite(context.deadlineAtMs)
        ? context.deadlineAtMs
        : undefined;
    const identity = this.#identities.get(assetId);
    if (!identity) throw pipelineError("IDENTITY_CHANGED");
    throwIfAborted(signal);

    let probe;
    try {
      const invokeProbe = () => this.#probe(snapshot, { signal });
      // D9b：只护 pipeline 原 probe 位置；AudioProbe 直接调用不在此列。
      if (this.#withLifecycleScope && deadlineAtMs !== undefined) {
        const probeDeadlineAtMs = Math.min(deadlineAtMs, monoNow() + 10_000);
        probe = await this.#withLifecycleScope(
          async (guard) => {
            try {
              return await invokeProbe();
            } catch (error) {
              if (isResourceUnknown(error)) guard.retain("probe-unknown");
              throw error;
            }
          },
          { scope: "probe", signal, deadlineAtMs: probeDeadlineAtMs },
        );
      } else {
        probe = await invokeProbe();
      }
    } catch (error) {
      throw mapProbeError(error, signal);
    }
    const boundedProbe = validateProbe(probe);
    throwIfAborted(signal);

    let product = null;
    let revoked = false;
    // T13I：engine 的 callback 错误白名单只有 RUN_FAILED/CANCELLED，直接抛会吞掉
    // execute 的 TIMEOUT/OUTPUT_LIMIT/RESOURCE_LIMIT。这里把“已在注入边界规范化的
    // 内部失败”暂存，callback 成功返回让 engine 完成释放；只有 lease 成功释放后
    // 才把原内部错误抛给队列。engine 自身获取/释放/完整性失败仍优先。
    let deferredFailure = null;
    const defer = (error) => {
      deferredFailure = error;
      return { deferred: true };
    };
    try {
      await this.#withRunLease(
        async (descriptor, leaseSignal) => {
          const inner = leaseSignal && typeof leaseSignal.aborted === "boolean" ? leaseSignal : signal;
          let token = null;
          try {
            throwIfAborted(inner);
            const validated = validateDescriptor(descriptor);
            const trusted = validated.trusted;
            const resultContext = buildContext(identity, snapshot, boundedProbe, trusted);
            throwIfAborted(inner);

            let begun;
            try {
              begun = this.#store.begin(assetId, jobId, {
                ...identity,
                context: resultContext,
              });
            } catch (error) {
              throw mapStoreError(error);
            }
            // begin 是同步契约：返回 Promise/thenable 或缺少 token 都固定失败，
            // 原生拒绝安全消费，但不把异步结果当作已申请资格。
            const begunKind = returnedKind(begun);
            if (begunKind === "promise") consumeNativeRejection(begun);
            let begunData;
            try {
              begunData = begunKind === "sync" ? readData(begun, ["token"], { exact: false }) : null;
            } catch {
              begunData = null;
            }
            if (!begunData || typeof begunData.token !== "string" || !begunData.token) {
              throw pipelineError("STORAGE_ERROR");
            }
            token = begunData.token;

            const startedAt = Date.now();
            throwIfAborted(inner);
            const raw = await this.#execute(snapshot, validated.full, {
              signal: inner,
              ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
            });
            throwIfAborted(inner);
            const normalized = normalizeAudioResult(raw, resultContext);
            if (!normalized.ok) throw pipelineError("INVALID_OUTPUT");
            product = Object.freeze({
              token,
              normalized,
              timing: Object.freeze({
                analyzedMs: Math.max(0, Date.now() - startedAt),
                analyzedAtMs: Date.now(),
              }),
              assetId,
              jobId,
            });
            return product;
          } catch (error) {
            if (token !== null && !revoked) {
              try {
                this.#invalidateToken(token);
                revoked = true;
              } catch {
                // store 定向撤销失败按 G 保持故障优先，不能被执行错误/取消覆盖。
                return defer(pipelineError("ABORT_FAILED"));
              }
            }
            const mapped = isPipelineFault(error) ? error : mapExecutionError(error, inner);
            if (isResourceUnknown(error) || isResourceUnknown(mapped)) {
              // 资源未证实回收：让 engine 的 callback 边界看到 unknown 证据并 retain 锁，
              // 不能先返回“成功”把锁放掉。最终仍把原始执行错误交给队列。
              deferredFailure = copyEvidence(mapped, error);
              const retainSignal = pipelineError("ENGINE_FAILED");
              retainSignal.evidence = { resourceUnknown: true, ...(error?.evidence || {}) };
              throw retainSignal;
            }
            return defer(mapped);
          }
        },
        deadlineAtMs === undefined ? { signal } : { signal, deadlineAtMs },
      );
    } catch (error) {
      // 运行租约可能在 callback 返回后才因取消/释放失败而拒绝；此时产物尚未交给
      // 队列，必须由流水线自己定向撤销，不能留下悬空 token。
      if (product && !revoked) {
        try {
          this.#invalidateToken(product.token);
          revoked = true;
        } catch {
          throw pipelineError("ABORT_FAILED");
        }
      }
      const mapped = mapLeaseError(error, signal);
      // ABORT_FAILED 是未消费资格故障；取消/超时不得覆盖。engine 锁/完整性失败
      // 仍按 engine 优先，不能因 callback 内部错误而吞掉。
      if (deferredFailure?.code === "ABORT_FAILED" && (mapped.code === "CANCELLED" || mapped.code === "TIMEOUT")) {
        throw deferredFailure;
      }
      // 执行资源 unknown 已通过 retain 保留 engine 锁；错误码仍取原始执行失败，
      // 但证据/租约保留语义由 queue 按 resourceUnknown 处理。
      if (deferredFailure && isResourceUnknown(deferredFailure)) throw deferredFailure;
      throw mapped;
    }
    if (deferredFailure) throw deferredFailure;
    if (!product) throw pipelineError("ENGINE_FAILED");
    return product;
  }

  #commit(product) {
    if (!product || typeof product !== "object" || typeof product.token !== "string") {
      throw pipelineError("INVALID_OUTPUT");
    }
    let returned;
    try {
      returned = this.#store.save(product.token, product.normalized, product.timing);
    } catch (error) {
      throw mapStoreError(error);
    }
    // 同步 save 契约：原生拒绝 Promise 安全消费；普通 thenable 不调用 then，
    // 两类都不算成功保存。
    const kind = returnedKind(returned);
    if (kind === "promise") consumeNativeRejection(returned);
    if (kind !== "sync") throw pipelineError("STORAGE_ERROR");
    return returned;
  }

  #invalidateToken(token) {
    let returned;
    try {
      returned = this.#store.invalidateToken(token);
    } catch {
      throw pipelineError("ABORT_FAILED");
    }
    const kind = returnedKind(returned);
    if (kind === "promise") consumeNativeRejection(returned);
    // 定向撤销必须是同步完成；Promise/thenable 都按撤销失败处理。
    if (kind !== "sync") throw pipelineError("ABORT_FAILED");
  }

  #abort(product) {
    if (!product || typeof product !== "object" || typeof product.token !== "string") return;
    this.#invalidateToken(product.token);
  }
}
