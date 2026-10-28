/**
 * 本地音频分析适配器：把正式 HTTP 入口接到已验收的受控分析链。
 *
 *   AudioAnalysis.analyze
 *     -> AudioAnalysisPipeline.submit -> AudioJobQueue
 *     -> snapshot -> pipeline probe scope -> engine.withRunLease
 *     -> AudioExecutor.execute -> normalizeAudioResult
 *     -> AudioResultStore.begin/save
 *
 * 旧 `asset_audio` 只作为只读历史回退；新结果只写 `audio_result_records`。
 * 本模块不执行子进程、不联网、不接触浏览器路径/argv；工具与 launcher 只能来自
 * 受信运行配置或测试注入的严格工厂产物。
 */
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AudioAnalysisPipeline } from "./audio-analysis-pipeline.mjs";
import { AudioResultStore } from "./audio-result-store.mjs";
import { AudioExecutor, createAudioExecutorLauncherConfig } from "./audio-executor.mjs";
import { AudioProbe, resolvePinnedAudioProbeTool } from "./audio-probe.mjs";
import { createAudioResultFingerprint } from "./audio-result.mjs";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CONFIG_MAX_BYTES = 16 * 1024;
const LAUNCHER_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_HTTP_WAIT_MS = 190_000;
const DEFAULT_CANCEL_SETTLE_MS = 2_000;
const DEFAULT_CACHE_IDENTITY_TIMEOUT_MS = 15_000;
const DEFAULT_WALL_DEADLINE_MS = 180_000;

const ERROR_INFO = Object.freeze({
  NOT_FOUND: [404, "素材不存在"],
  ASSET_NOT_FOUND: [404, "素材不存在"],
  ENGINE_NOT_INSTALLED: [409, "音频分析引擎未安装"],
  ASSET_BUSY: [409, "素材正被其它操作占用"],
  ENGINE_BUSY: [409, "音频引擎忙"],
  AUDIO_ENGINE_BUSY: [409, "音频引擎忙"],
  SOURCE_CHANGED: [409, "源文件已变化"],
  IDENTITY_CHANGED: [409, "素材身份已变化"],
  UNSUPPORTED_ASSET: [409, "素材类型不支持音频分析"],
  SOURCE_OFFLINE: [409, "素材当前不可分析"],
  SOURCE_TRASHED: [409, "素材当前不可分析"],
  SOURCE_RETIRED: [409, "素材当前不可分析"],
  ROOT_RETIRED: [409, "素材当前不可分析"],
  AUDIO_QUEUE_FULL: [429, "分析队列已满"],
  AUDIO_RUNTIME_UNAVAILABLE: [503, "音频分析运行配置不可用"],
  PROBE_UNAVAILABLE: [503, "音频探测工具不可用"],
  EXECUTION_UNAVAILABLE: [503, "音频执行器不可用"],
  ENGINE_LEASE_FAILED: [503, "音频引擎运行租约失败"],
  STORE_BUSY: [503, "结果存储忙"],
  STORAGE_ERROR: [503, "结果存储失败"],
  SCHEMA_CONFLICT: [503, "结果存储结构冲突"],
  SCHEMA_INIT_FAILED: [503, "结果存储初始化失败"],
  UNSUPPORTED_SCHEMA_VERSION: [503, "结果存储结构版本不支持"],
  PIPELINE_NOT_INITIALIZED: [503, "音频分析流水线尚未初始化"],
  PIPELINE_DISPOSED: [503, "音频分析流水线已关闭"],
  QUEUE_DISPOSED: [503, "音频分析队列已关闭"],
  TIMEOUT: [400, "分析超时"],
  INVALID_REQUEST: [400, "请求参数无效"],
  INVALID_CONTEXT: [400, "音频分析上下文无效"],
  OUTPUT_LIMIT: [400, "分析输出超出限制"],
  INVALID_OUTPUT: [400, "分析输出无效"],
  ENGINE_FAILED: [400, "音频引擎执行失败"],
  RESOURCE_LIMIT: [400, "分析资源超出限制"],
  CANCELLED: [400, "分析已取消"],
  COMMIT_FAILED: [400, "分析结果保存失败"],
  ABORT_FAILED: [400, "分析结果撤销失败"],
  LEASE_RELEASE_FAILED: [400, "分析队列租约释放失败"],
  PROBE_REJECTED: [400, "音频探测结果不符合约束"],
  CLEANUP_FAILED: [400, "分析临时文件清理失败"],
  SNAPSHOT_FAILED: [400, "音频快照失败"],
  EXECUTION_FAILED: [400, "音频执行失败"],
  ANALYZE_FAILED: [400, "音频分析失败"],
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));

/** saved_at_ms 只接受无损、安全、非负整数；字符串必须是严格十进制整数。 */
function readSavedAtMs(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    if (String(parsed) !== value) return null;
    return parsed;
  }
  return null;
}

function sha256Parts(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function readPlainObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const own = Object.keys(value);
  if (own.length !== keys.length) return null;
  const out = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    out[key] = descriptor.value;
  }
  return out;
}

export class AudioAnalysis {
  #initPromise = null;
  #storeInitPromise = null;
  #store = null;
  #storeReady = false;
  #storeError = null;
  #runtimeError = null;
  #pipelineError = null;
  #pipeline = null;
  #executor = null;
  #probe = null;
  #probeTool = null;
  #launcher = null;
  #pipelineOverride = null;
  #probeInfo = null;
  #probeResourceUnknown = false;
  #probeCloseSettled = null;
  #runState = null;
  #contextOverride = null;
  #activeAssets = new Map();
  #initHealthy = false;
  #runtimeKickStarted = false;
  #disposed = false;

  constructor(lib, engine, options = {}) {
    if (lib === null || typeof lib !== "object" || engine === null || typeof engine !== "object") {
      throw this.#fixed("INVALID_REQUEST");
    }
    const values = readPlainObject(options, Object.keys(options));
    if (!values) throw this.#fixed("INVALID_REQUEST");
    this.lib = lib;
    this.engine = engine;
    this.dataDir = options.dataDir;
    this.runtimeConfigPath = options.runtimeConfigPath;
    this.probeTool = options.probeTool;
    this.launcher = options.launcher;
    this.limits = options.limits;
    // 仅 node:test 子进程允许注入队列替身，用于验证适配器自身的 saving/JOB_NOT_FOUND
    // 固定收尾分支；生产/普通运行忽略该字段，仍必须走真实 pipeline。
    this.#pipelineOverride =
      process.env.NODE_TEST_CONTEXT && options.pipeline && typeof options.pipeline === "object"
        ? options.pipeline
        : null;
    // 可选时间预算只允许“降低”，不得超过已批准默认值。
    const readBudget = (name, fallback, { allowZero = false } = {}) => {
      const value = options[name];
      if (value === undefined) return fallback;
      const minimum = allowZero ? 0 : 1;
      if (!Number.isSafeInteger(value) || value < minimum || value > fallback) {
        throw this.#fixed("INVALID_REQUEST");
      }
      return value;
    };
    this.httpWaitMs = readBudget("httpWaitMs", DEFAULT_HTTP_WAIT_MS);
    this.cancelSettleMs = readBudget("cancelSettleMs", DEFAULT_CANCEL_SETTLE_MS, { allowZero: true });
    this.cacheIdentityTimeoutMs = readBudget(
      "cacheIdentityTimeoutMs",
      DEFAULT_CACHE_IDENTITY_TIMEOUT_MS,
    );
    const wall = readBudget("wallDeadlineMs", DEFAULT_WALL_DEADLINE_MS);
    this.wallDeadlineMs = wall;
    if (typeof this.dataDir !== "string" || !path.isAbsolute(this.dataDir)) {
      throw this.#fixed("INVALID_REQUEST");
    }
  }

  /** 幂等初始化；运行配置/shape 失败只算“可重试未就绪”，不会永久缓存为成功。 */
  async init() {
    if (this.#initHealthy) return;
    if (this.#initPromise) return this.#initPromise;
    const promise = this.#init();
    this.#initPromise = promise;
    try {
      await promise;
    } finally {
      // 健康就绪后保留已决议 promise；未就绪则清空，下一次显式调用可重试。
      if (!this.#initHealthy && this.#initPromise === promise) this.#initPromise = null;
    }
  }

  /**
   * 幂等 store 就绪：只建/校验结果存储。GET 历史只需要这一条路径，
   * 不等待 runtime JSON、probe/launcher hash 等运行 I/O。
   */
  async #ensureStore() {
    if (this.#storeReady) return;
    if (this.#storeInitPromise) return this.#storeInitPromise;
    const promise = (async () => {
      try {
        if (!this.#store) {
          this.#store = new AudioResultStore({
            db: this.lib.db,
            resolveCurrent: (assetId) => this.#resolveCurrent(assetId),
          });
        }
        this.#store.initSchema();
        this.#storeReady = true;
        this.#storeError = null;
      } catch (error) {
        this.#storeReady = false;
        this.#storeError = this.#mapError(error);
      }
    })();
    this.#storeInitPromise = promise;
    try {
      await promise;
    } finally {
      if (!this.#storeReady && this.#storeInitPromise === promise) this.#storeInitPromise = null;
    }
  }

  async #init() {
    this.#runtimeError = null;
    this.#pipelineError = null;
    // 先建 store：GET 即使运行配置不可用也仍可读新记录/旧行；已就绪不重建。
    await this.#ensureStore();

    try {
      await this.#loadTools();
    } catch {
      this.#runtimeError = this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }

    this.#initHealthy = false;
    if (this.#storeReady && this.#runtimeError === null) {
      if (this.#pipeline) {
        this.#initHealthy = true;
        return;
      }
      if (this.#pipelineOverride) {
        this.#pipeline = this.#pipelineOverride;
        this.#initHealthy = true;
        return;
      }
      try {
        const executorOptions = {
          dataDir: this.dataDir,
          launcher: this.#launcher,
          probeTool: this.#probeTool,
        };
        if (this.limits !== undefined) executorOptions.limits = this.limits;
        this.#executor = new AudioExecutor(executorOptions);
        this.#probe = new AudioProbe({ runner: this.#probeRunner(), tool: this.#probeTool });
        const options = {
          dataDir: this.dataDir,
          resolveAsset: (assetId) => this.#resolveAsset(assetId),
          store: this.#store,
          resolveCurrent: (assetId) => this.#resolveCurrent(assetId),
          probe: (snapshot, probeOptions) => this.#probeSnapshot(snapshot, probeOptions),
          withRunLease: (callback, leaseOptions) => this.#withRunLease(callback, leaseOptions),
          execute: (snapshot, descriptor, executeOptions) =>
            this.#executor.execute(snapshot, descriptor, executeOptions),
          wallDeadlineMs: this.wallDeadlineMs,
        };
        if (typeof this.engine.withLifecycleScope === "function") {
          options.withLifecycleScope = this.engine.withLifecycleScope.bind(this.engine);
        }
        this.#pipeline = new AudioAnalysisPipeline(options);
        this.#pipeline.init();
        this.#initHealthy = true;
      } catch (error) {
        this.#pipeline = null;
        this.#pipelineError = this.#mapError(error);
      }
    }
  }

  async #loadTools() {
    let configured = null;
    if (!this.probeTool || !this.launcher) configured = await this.#readRuntimeConfig();
    this.#probeTool = this.probeTool || configured?.probeTool || null;
    this.#launcher = this.launcher || configured?.launcher || null;
    if (!this.#probeTool || !this.#launcher) throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
  }

  async #readRuntimeConfig() {
    if (typeof this.runtimeConfigPath !== "string" || !path.isAbsolute(this.runtimeConfigPath)) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    let stat;
    try {
      stat = await fs.lstat(this.runtimeConfigPath);
    } catch {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > CONFIG_MAX_BYTES) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    let text;
    try {
      text = await fs.readFile(this.runtimeConfigPath, "utf8");
    } catch {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (Buffer.byteLength(text, "utf8") > CONFIG_MAX_BYTES) throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    const top = readPlainObject(raw, ["probe", "launcher"]);
    if (!top) throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    const probe = readPlainObject(top.probe, ["path", "sha256", "version"]);
    const launcher = readPlainObject(top.launcher, ["path", "sha256"]);
    if (!probe || !launcher) throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    if (typeof probe.path !== "string" || !path.isAbsolute(probe.path)) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (typeof probe.sha256 !== "string" || !SHA256_HEX.test(probe.sha256)) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (typeof probe.version !== "string" || probe.version.length === 0 || probe.version.length > 128) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (typeof launcher.path !== "string" || !path.isAbsolute(launcher.path)) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (typeof launcher.sha256 !== "string" || !SHA256_HEX.test(launcher.sha256)) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    let probeStat;
    try {
      probeStat = await fs.lstat(probe.path);
    } catch {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (probeStat.isSymbolicLink() || !probeStat.isFile() || probeStat.size <= 0) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    let probeTool;
    try {
      probeTool = await resolvePinnedAudioProbeTool({
        path: probe.path,
        version: probe.version,
        expectedSha256: probe.sha256,
      });
    } catch {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    await this.#verifyLauncher(launcher.path, launcher.sha256);
    return {
      probeTool,
      launcher: createAudioExecutorLauncherConfig({ path: launcher.path, sha256: launcher.sha256 }),
    };
  }

  async #verifyLauncher(launcherPath, expectedSha256) {
    let real;
    let stat;
    try {
      const original = await fs.lstat(launcherPath);
      if (original.isSymbolicLink()) throw new Error("symlink");
      real = await fs.realpath(launcherPath);
      stat = await fs.lstat(real);
    } catch {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > LAUNCHER_MAX_BYTES) {
      throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
    }
    const digest = await new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = createReadStream(real);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", reject);
    }).catch(() => null);
    if (digest !== expectedSha256) throw this.#fixed("AUDIO_RUNTIME_UNAVAILABLE");
  }

  /** 旧结果只读回退；从不创建 asset_audio。 */
  #legacy(assetId) {
    try {
      return this.lib.db.prepare("SELECT * FROM asset_audio WHERE asset_id=?").get(assetId) || null;
    } catch {
      return null;
    }
  }

  #assetRow(assetId) {
    try {
      return (
        this.lib.db
          .prepare(
            `SELECT a.*, r.path AS root_path, r.online AS root_online,
                    r.revision AS root_revision, r.retired AS root_retired
               FROM assets a JOIN roots r ON r.id = a.root_id
              WHERE a.id = ?`,
          )
          .get(assetId) || null
      );
    } catch {
      return null;
    }
  }

  #generations(row) {
    const libraryGeneration = sha256Parts(
      "library",
      row.root_id,
      row.root_revision ?? 0,
      !!row.root_online,
      !!row.root_retired,
    );
    const assetGeneration = sha256Parts(
      "asset",
      row.id,
      row.root_id,
      row.path,
      row.size,
      row.mtime,
      row.sha256 ?? "",
      row.kind,
    );
    const sourceGeneration = sha256Parts(
      "source",
      row.path,
      row.dev ?? "",
      row.ino ?? "",
      row.size,
      row.mtime,
      row.sha256 ?? "",
    );
    return { libraryGeneration, assetGeneration, sourceGeneration };
  }

  #placeholderContext(row) {
    const sourceSize = Number(row.size);
    return {
      kind: row.kind,
      sourceSha256: typeof row.sha256 === "string" && SHA256_HEX.test(row.sha256)
        ? row.sha256
        : "0".repeat(64),
      sourceSize: Number.isSafeInteger(sourceSize) && sourceSize >= 0 && sourceSize <= 256 * 1024 * 1024
        ? sourceSize
        : 0,
      durationSec: 0,
      engineVersion: "0.0.0",
      engineBinarySha256: "0".repeat(64),
      engineGeneration: "0".repeat(32),
      parameters: { brief: true },
    };
  }

  #identity(row) {
    if (!row) return null;
    const online = !!row.online && !!row.root_online;
    return {
      assetId: row.id,
      rootId: row.root_id,
      kind: row.kind,
      online,
      trashed: !!row.trashed,
      retired: false,
      rootRetired: !!row.root_retired,
      busy: this.lib.locks instanceof Set ? this.lib.locks.has(row.id) : false,
      ...this.#generations(row),
      context: this.#placeholderContext(row),
    };
  }

  #resolveAsset(assetId) {
    const row = this.#assetRow(assetId);
    if (!row) return null;
    return {
      assetId: row.id,
      kind: row.kind,
      sourcePath: row.path,
      rootPath: row.root_path,
      rootId: row.root_id,
      online: !!row.online && !!row.root_online,
      trashed: !!row.trashed,
      retired: false,
      rootRetired: !!row.root_retired,
      busy: this.lib.locks instanceof Set ? this.lib.locks.has(row.id) : false,
      ...this.#generations(row),
    };
  }

  /** store/queue 的同步身份解析；运行上下文必须与 pipeline.buildContext 逐字段一致。 */
  #resolveCurrent(assetId) {
    const row = this.#assetRow(assetId);
    if (!row) return null;
    const identity = this.#identity(row);
    if (!identity) return null;
    if (this.#contextOverride && this.#contextOverride.assetId === assetId) {
      return { ...identity, context: this.#contextOverride.context };
    }
    if (this.#runState && this.#runState.assetId === assetId && this.#probeInfo &&
        this.#probeInfo.assetId === assetId) {
      const descriptor = this.#runState.descriptor;
      const probe = this.#probeInfo;
      return {
        ...identity,
        context: {
          kind: probe.kind,
          sourceSha256: probe.sha256,
          sourceSize: probe.bytes,
          durationSec: probe.durationSec,
          engineVersion: descriptor.version,
          engineBinarySha256: descriptor.binarySha256,
          engineGeneration: descriptor.generation,
          parameters: { brief: true },
        },
      };
    }
    return identity;
  }

  #withContextOverride(assetId, context, callback) {
    const previous = this.#contextOverride;
    this.#contextOverride = { assetId, context };
    try {
      return callback();
    } finally {
      this.#contextOverride = previous;
    }
  }

  #readCanonicalContext(raw) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!Array.isArray(value) || value.length !== 12) return null;
    if (value[0] !== "shiguang.audio-result-store.context" || value[1] !== 1 || value[2] !== "brief-v1") {
      return null;
    }
    if (value[10] !== "brief" || value[11] !== true) return null;
    const context = {
      kind: value[3],
      sourceSha256: value[4],
      sourceSize: value[5],
      durationSec: value[6],
      engineVersion: value[7],
      engineBinarySha256: value[8],
      engineGeneration: value[9],
      parameters: { brief: true },
    };
    const fingerprint = createAudioResultFingerprint(context);
    if (!fingerprint.ok) return null;
    return {
      context: fingerprint.provenance,
      fingerprint: fingerprint.fingerprint,
      durationSec: fingerprint.provenance.durationSec,
    };
  }

  #readCandidate(assetId) {
    let row;
    try {
      row = this.lib.db
        .prepare("SELECT context_json, fingerprint, invalidated_at_ms FROM audio_result_records WHERE asset_id=?")
        .get(assetId);
    } catch {
      return null;
    }
    if (!row) return null;
    const parsed = this.#readCanonicalContext(row.context_json);
    if (!parsed || parsed.fingerprint !== row.fingerprint) return null;
    return { ...parsed, invalidatedAtMs: row.invalidated_at_ms ?? null };
  }

  #project(assetId, stored) {
    const payload = stored?.result;
    if (!payload || typeof payload !== "object" || !payload.value || !payload.provenance) return null;
    const value = payload.value;
    const provenance = payload.provenance;
    const analyzedAtMs = Number(stored.analyzedAtMs);
    return {
      asset_id: assetId,
      sha256: provenance.sourceSha256 ?? null,
      bpm: value.bpm ?? null,
      key_root: value.key?.tonic ?? null,
      key_mode: value.key?.mode ?? null,
      loudness_rms: value.loud?.rmsDbfs ?? null,
      loudness_peak: value.loud?.peakDbfs ?? null,
      energy_min: value.energy?.minDbfs ?? null,
      energy_max: value.energy?.maxDbfs ?? null,
      duration: provenance.durationSec ?? null,
      structure_json: null,
      engine_version: provenance.engineVersion ?? null,
      analyzed_ms: Number.isSafeInteger(Number(stored.analyzedMs)) ? Number(stored.analyzedMs) : null,
      analyzed_at: Number.isFinite(analyzedAtMs) ? new Date(analyzedAtMs).toISOString() : null,
    };
  }

  #stored(assetId) {
    if (!this.#storeReady) return null;
    const candidate = this.#readCandidate(assetId);
    if (!candidate) return null;
    let stored;
    try {
      stored = this.#withContextOverride(assetId, candidate.context, () =>
        this.#store.get(assetId, candidate.context),
      );
    } catch {
      return null;
    }
    if (!stored || typeof stored !== "object") return null;
    if (stored.status === "missing") return null;
    if (stored.result === null || stored.result === undefined) return null;
    return stored;
  }

  /** GET：新记录经 store.get 校验后投影；损坏/schema 失败回退旧 asset_audio。 */
  async get(assetId) {
    if (typeof assetId !== "string" || !assetId) return null;
    // 历史读取只等待 store；运行工具未就绪/正在恢复不阻塞旧行投影。
    await this.#ensureStore();
    // 后台只推进一次共享运行配置初始化，但不把历史 GET 挂在这条 I/O 上，
    // 也不在 GET 上反复重试（显式 POST 仍按既有可重试初始化恢复）。
    if (!this.#initHealthy && !this.#disposed && !this.#runtimeKickStarted) {
      this.#runtimeKickStarted = true;
      this.init().catch(() => {});
    }
    const row = this.#assetRow(assetId);
    if (!row) return null;
    const identity = this.#identity(row);
    if (!identity || !identity.online || identity.trashed || identity.retired || identity.rootRetired) {
      return null;
    }
    if (!this.#storeReady) return this.#legacy(assetId);
    const candidate = this.#readCandidate(assetId);
    if (!candidate) return this.#legacy(assetId);
    let got;
    try {
      got = this.#withContextOverride(assetId, candidate.context, () =>
        this.#store.get(assetId, candidate.context),
      );
    } catch {
      return this.#legacy(assetId);
    }
    if (got?.status === "missing") return null;
    if ((got?.status === "ready" || got?.status === "stale") && got.result) {
      return this.#project(assetId, got);
    }
    return this.#legacy(assetId);
  }

  /** 缓存命中需要一次有界 run lease 证明当前安装身份，并在同一 lease 内 store.get。 */
  async #tryCache(row, httpDeadlineAtMs) {
    if (typeof row.sha256 !== "string" || !SHA256_HEX.test(row.sha256)) return null;
    let stat;
    try {
      stat = await this.#waitWithin(fs.stat(row.path), httpDeadlineAtMs);
    } catch (error) {
      if (error?.code === "TIMEOUT") throw error;
      return null;
    }
    if (performance.now() >= httpDeadlineAtMs) throw this.#fixed("TIMEOUT");
    if (!stat.isFile()) return null;
    if (String(stat.dev) !== String(row.dev) || String(stat.ino) !== String(row.ino)) return null;
    if (Number(stat.size) !== Number(row.size)) return null;
    const mtime = Number(row.mtime);
    if (!Number.isFinite(mtime) || Math.abs(mtime - stat.mtimeMs) > 1) return null;

    const candidate = this.#readCandidate(row.id);
    if (!candidate || candidate.invalidatedAtMs !== null) return null;
    const duration = Number(row.duration);
    if (Number.isFinite(duration) && duration > 0 && Math.abs(duration - candidate.durationSec) > 0.05) {
      return null;
    }

    const remaining = httpDeadlineAtMs - performance.now();
    if (remaining <= 0) throw this.#fixed("TIMEOUT");
    const budget = Math.max(1, Math.min(this.cacheIdentityTimeoutMs, remaining));
    let hit = null;
    try {
      await this.engine.withRunLease(
        async (descriptor) => {
          const context = {
            kind: row.kind,
            sourceSha256: row.sha256,
            sourceSize: Number(row.size),
            durationSec: candidate.durationSec,
            engineVersion: descriptor.version,
            engineBinarySha256: descriptor.binarySha256,
            engineGeneration: descriptor.generation,
            parameters: { brief: true },
          };
          let got = null;
          try {
            got = this.#withContextOverride(row.id, context, () => this.#store.get(row.id, context));
          } catch {
            got = null;
          }
          if (got?.status === "ready" && got.result) hit = this.#project(row.id, got);
          return null;
        },
        { deadlineAtMs: performance.now() + budget },
      );
    } catch {
      return null;
    }
    return hit ? { cached: true, ...hit } : null;
  }

  /** 有界等待：到期返回固定 TIMEOUT，但不取消共享初始化等底层工作。 */
  async #waitWithin(promise, deadlineAtMs) {
    const remaining = deadlineAtMs - performance.now();
    if (remaining <= 0) throw this.#fixed("TIMEOUT");
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(this.#fixed("TIMEOUT")), remaining);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * 受信 runner 边界：只在本适配器内捕获 executor 的固定 unknown/close 事实，
   * 不改 AudioProbe 契约，也不向 pipeline 透传 stderr/path/raw。
   */
  #probeRunner() {
    return {
      probe: async (snapshot, options = {}) => {
        this.#probeResourceUnknown = false;
        this.#probeCloseSettled = null;
        try {
          return await this.#executor.probe(snapshot, options);
        } catch (error) {
          const evidence = error?.evidence;
          if (evidence?.resourceUnknown === true) this.#probeResourceUnknown = true;
          // 目录/分组未知不等于子进程 close 未知；分开保留已经观测到的事实，
          // 没有 close 观测就保持 null（上层省略该字段）。
          if (evidence?.closeSettled === false) this.#probeCloseSettled = false;
          else if (evidence?.closeSettled === true && this.#probeCloseSettled !== false) {
            this.#probeCloseSettled = true;
          }
          throw error;
        }
      },
    };
  }

  async #probeSnapshot(snapshot, { signal } = {}) {
    this.#probeInfo = null;
    this.#runState = null;
    this.#probeResourceUnknown = false;
    this.#probeCloseSettled = null;
    let probe;
    try {
      probe = await this.#probe.probe(snapshot, { signal });
    } catch (error) {
      if (this.#probeResourceUnknown || this.#probeCloseSettled === false) {
        const code =
          error?.code === "TIMEOUT" || error?.code === "CANCELLED" || error?.code === "PROBE_REJECTED"
            ? error.code
            : "PROBE_REJECTED";
        const fixed = this.#fixed(code);
        // 与 pipeline 的 isResourceUnknown 同一 predicate：close=false 独立成立，
        // 但只桥接实际观测到的布尔，不把未知 close 补成 false、不伪造 unknown。
        const evidence = {};
        if (this.#probeResourceUnknown) evidence.resourceUnknown = true;
        if (this.#probeCloseSettled !== null) evidence.closeSettled = this.#probeCloseSettled;
        fixed.evidence = evidence;
        throw fixed;
      }
      throw error;
    }
    try {
      const row = this.lib.db
        .prepare("SELECT id, kind FROM assets WHERE path=?")
        .get(snapshot.sourcePath);
      if (row) {
        this.#probeInfo = {
          assetId: row.id,
          kind: row.kind,
          sha256: snapshot.sha256,
          bytes: snapshot.bytes,
          durationSec: probe.durationSec,
        };
      }
    } catch {
      this.#probeInfo = null;
    }
    return probe;
  }

  async #withRunLease(callback, options) {
    return this.engine.withRunLease(async (descriptor, signal) => {
      if (this.#probeInfo) {
        this.#runState = {
          assetId: this.#probeInfo.assetId,
          descriptor: {
            version: descriptor.version,
            binarySha256: descriptor.binarySha256,
            generation: descriptor.generation,
          },
        };
      }
      return callback(descriptor, signal);
    }, options);
  }

  async #recordJobId(assetId) {
    try {
      const row = this.lib.db
        .prepare("SELECT job_id FROM audio_result_records WHERE asset_id=?")
        .get(assetId);
      return row?.job_id ?? null;
    } catch {
      return null;
    }
  }

  async #savedResult(assetId, jobId) {
    const stored = this.#stored(assetId);
    if (!stored) throw this.#fixed("STORAGE_ERROR");
    const recordJobId = await this.#recordJobId(assetId);
    if (recordJobId !== jobId) throw this.#fixed("STORAGE_ERROR");
    const projected = this.#project(assetId, stored);
    if (!projected) throw this.#fixed("STORAGE_ERROR");
    return { cached: false, ...projected };
  }

  #summaryError(summary) {
    const code = typeof summary?.error?.code === "string" ? summary.error.code : "ANALYZE_FAILED";
    return this.#fixed(code);
  }

  #closingError() {
    const error = new Error("结果已保存，任务收尾未确认");
    error.code = "STORAGE_ERROR";
    error.status = 503;
    return error;
  }

  async #jobNotFound(jobId, assetId) {
    this.#activeAssets.delete(assetId);
    let row;
    try {
      row = this.lib.db
        .prepare("SELECT job_id, saved_at_ms FROM audio_result_records WHERE asset_id=?")
        .get(assetId);
    } catch {
      throw this.#fixed("TIMEOUT");
    }
    if (!row || row.job_id !== jobId) throw this.#fixed("TIMEOUT");
    const savedAtMs = readSavedAtMs(row.saved_at_ms);
    if (savedAtMs === null) throw this.#fixed("TIMEOUT");
    throw this.#closingError();
  }

  async #waitForJob(jobId, assetId, httpDeadlineAtMs) {
    let summary = null;
    for (;;) {
      try {
        summary = await this.#pipeline.get(jobId);
      } catch (error) {
        if (error?.code === "JOB_NOT_FOUND") return this.#jobNotFound(jobId, assetId);
        throw this.#mapError(error);
      }
      if (summary.state === "succeeded") {
        this.#activeAssets.delete(assetId);
        return this.#savedResult(assetId, jobId);
      }
      if (summary.state === "failed") {
        this.#activeAssets.delete(assetId);
        throw this.#summaryError(summary);
      }
      if (summary.state === "cancelled") {
        this.#activeAssets.delete(assetId);
        throw this.#fixed("TIMEOUT");
      }
      const now = performance.now();
      if (now >= httpDeadlineAtMs) break;
      await delay(Math.min(25, httpDeadlineAtMs - now));
    }

    let cancelled;
    try {
      cancelled = await this.#pipeline.cancel(jobId);
    } catch (error) {
      if (error?.code === "JOB_NOT_FOUND") return this.#jobNotFound(jobId, assetId);
      throw this.#mapError(error);
    }

    const settleDeadline = performance.now() + this.cancelSettleMs;
    for (;;) {
      summary = cancelled;
      if (summary.state === "succeeded") {
        this.#activeAssets.delete(assetId);
        return this.#savedResult(assetId, jobId);
      }
      if (summary.state === "failed") {
        this.#activeAssets.delete(assetId);
        throw this.#summaryError(summary);
      }
      if (summary.state === "cancelled") {
        this.#activeAssets.delete(assetId);
        throw this.#fixed("TIMEOUT");
      }
      if (performance.now() >= settleDeadline) break;
      await delay(Math.min(25, Math.max(1, settleDeadline - performance.now())));
      try {
        cancelled = await this.#pipeline.get(jobId);
      } catch (error) {
        if (error?.code === "JOB_NOT_FOUND") return this.#jobNotFound(jobId, assetId);
        throw this.#mapError(error);
      }
    }
    if (summary.state === "saving" && summary.resultSaved === true) throw this.#closingError();
    throw this.#fixed("TIMEOUT");
  }

  /**
   * 超时后的 submit Promise 仍保留一次性所有权观察：迟到接受的非终态 job
   * 走既有 cancel + 有界结算；迟到拒绝被消费。不重试提交、不新建第二队列/回收器。
   */
  #settleLateSubmission(observed) {
    observed
      .then((outcome) => {
        if (!outcome.ok) return;
        const summary = outcome.summary;
        if (!summary || typeof summary !== "object") return;
        if (
          summary.state === "succeeded" ||
          summary.state === "failed" ||
          summary.state === "cancelled"
        ) {
          return;
        }
        if (typeof summary.id !== "string" || !summary.id) return;
        return this.#cancelLateJob(summary.id);
      })
      .catch(() => {});
  }

  async #cancelLateJob(jobId) {
    let summary;
    try {
      summary = await this.#pipeline.cancel(jobId);
    } catch {
      return;
    }
    const settleDeadline = performance.now() + this.cancelSettleMs;
    for (;;) {
      if (
        !summary ||
        summary.state === "cancelled" ||
        summary.state === "failed" ||
        summary.state === "succeeded"
      ) {
        return;
      }
      if (performance.now() >= settleDeadline) return;
      await delay(Math.min(25, Math.max(1, settleDeadline - performance.now())));
      try {
        summary = await this.#pipeline.get(jobId);
      } catch {
        return;
      }
    }
  }

  #submitWithin(assetId, force, deadlineAtMs) {
    const observed = Promise.resolve()
      .then(() => this.#pipeline.submit(assetId, { force: force === true }))
      .then(
        (summary) => ({ ok: true, summary }),
        (error) => ({ ok: false, error }),
      );
    const remaining = deadlineAtMs - performance.now();
    if (remaining <= 0) {
      this.#settleLateSubmission(observed);
      return Promise.reject(this.#fixed("TIMEOUT"));
    }
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(this.#fixed("TIMEOUT"));
        this.#settleLateSubmission(observed);
      }, remaining);
      observed.then((outcome) => {
        if (expired) return;
        clearTimeout(timer);
        if (outcome.ok) resolve(outcome.summary);
        else reject(outcome.error);
      });
    });
  }

  /** 提交并等待终态；缓存命中不建 snapshot/queue/子进程。 */
  async analyze(assetId, { force = false } = {}) {
    // 190s 从 analyze 入口起算，包含初始化、前置检查、缓存、submit 与排队。
    const httpDeadlineAtMs = performance.now() + this.httpWaitMs;
    if (typeof assetId !== "string" || !assetId) throw this.#fixed("NOT_FOUND");
    try {
      await this.#waitWithin(this.init(), httpDeadlineAtMs);
    } catch (error) {
      throw this.#mapError(error);
    }
    if (performance.now() >= httpDeadlineAtMs) throw this.#fixed("TIMEOUT");
    if (this.#disposed) throw this.#fixed("PIPELINE_DISPOSED");
    const row = this.#assetRow(assetId);
    if (!row) throw this.#fixed("NOT_FOUND");

    let binaryPath = null;
    try {
      binaryPath = this.engine.binaryPath;
    } catch {
      binaryPath = null;
    }
    if (!binaryPath) throw this.#fixed("ENGINE_NOT_INSTALLED");
    if (this.#runtimeError) throw this.#runtimeError;
    if (this.#pipelineError) throw this.#pipelineError;
    if (!this.#storeReady) throw this.#storeError || this.#fixed("STORAGE_ERROR");
    if (!this.#pipeline) throw this.#pipelineError || this.#fixed("STORAGE_ERROR");

    // 同 asset 已有活跃 job 时不走缓存，交给 queue 合并，避免用旧结果抢先返回。
    if (force !== true && !this.#activeAssets.has(assetId)) {
      const cached = await this.#tryCache(row, httpDeadlineAtMs);
      if (cached) return cached;
    }
    if (performance.now() >= httpDeadlineAtMs) throw this.#fixed("TIMEOUT");

    let summary;
    try {
      summary = await this.#submitWithin(assetId, force, httpDeadlineAtMs);
    } catch (error) {
      throw this.#mapError(error);
    }
    if (summary.state === "succeeded") {
      this.#activeAssets.delete(assetId);
      return this.#savedResult(assetId, summary.id);
    }
    if (summary.state === "failed") {
      this.#activeAssets.delete(assetId);
      throw this.#summaryError(summary);
    }
    if (summary.state === "cancelled") {
      this.#activeAssets.delete(assetId);
      throw this.#fixed("TIMEOUT");
    }
    this.#activeAssets.set(assetId, summary.id);
    return this.#waitForJob(summary.id, assetId, httpDeadlineAtMs);
  }

  async dispose() {
    this.#disposed = true;
    if (this.#pipeline) await this.#pipeline.dispose();
  }

  #fixed(code, messageOverride) {
    const known = Object.hasOwn(ERROR_INFO, code);
    const info = known ? ERROR_INFO[code] : ERROR_INFO.ANALYZE_FAILED;
    const error = new Error(messageOverride || info[1]);
    error.code = known ? code : "ANALYZE_FAILED";
    error.status = info[0];
    return error;
  }

  #mapError(error) {
    const code = typeof error?.code === "string" ? error.code : "";
    if (Object.hasOwn(ERROR_INFO, code)) return this.#fixed(code);
    return this.#fixed("ANALYZE_FAILED");
  }
}

export function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}
