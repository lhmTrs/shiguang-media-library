/**
 * T-LOCAL-013H：受限音频执行器（正式 server 内部模块，默认不接线）。
 *
 * 契约对齐未来 pipeline 的 `execute(snapshot, descriptor, { signal })`：
 *   - descriptor 必须来自 AudioEngine.withRunLease 的可信内部结果；
 *   - 只读取本次任务私有快照（snapshot.filePath），不读原文件；
 *   - 固定 binary + 固定 `[snapshot, '--json', '--brief']`，不接受 command/args/env/cwd/URL；
 *   - 不释放上游运行租约：调用方必须 await 到进程组结束与清理完成。
 *
 * 安全边界（不宣称恶意二进制沙箱）：
 *   - shell:false、stdin 关闭、最小 env、独立进程组、有界字节输出、wall deadline；
 *   - 私有 0700 cwd/HOME/TMP、0600 归属标记、只清理自己创建的 job 目录；
 *   - launcher 与 binary 均来自受信内部配置并对普通非链接文件做摘要校验；
 *   - launcher 设置 CPU/FSIZE/NOFILE 限制；RSS 未采样，env 净化不等于 OS 禁网。
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { within } from "./fs-identity.mjs";

const execFileAsync = promisify(execFile);
const KiB = 1024;

const MAX_WALL_MS = 180_000;
const PROBE_WALL_MS = 10_000;
const MAX_STDOUT_BYTES = 64 * KiB;
const MAX_STDERR_BYTES = 64 * KiB;
const MAX_TERM_GRACE_MS = 2_000;
/** 两次进程组确认沿用现行职责：第一次 1500ms，finally 第二次 1000ms。 */
const GROUP_CONFIRM_MS = 1_500;
const FINAL_CONFIRM_MS = 1_000;
const BUDGET_EXHAUSTED = Symbol("audioExecutorBudgetExhausted");
const EVIDENCE_SCHEMA_VERSION = 1;
const EVIDENCE_MAX_JSON_BYTES = 8 * KiB;
/** 仅测试子进程可用的注入位；生产路径不识别该 symbol。 */
const TEST_HOOKS = Symbol.for("dsh.audioExecutor.testHooks");
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_LAUNCHER_BYTES = 16 * 1024 * 1024;
const MAX_PROBE_TOOL_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * KiB;
const OWNER_FILE = ".owner.json";
const OWNER_MAX_BYTES = 4 * KiB;
const JOB_PREFIX = "job-";
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GENERATION_HEX = /^[0-9a-f]{32,64}$/;
const ENGINE_VERSION = /^[A-Za-z0-9._+-]{1,128}$/;
/** probe 工具版本行含空格/括号/版权字样；只允许有界可打印 ASCII。 */
const PROBE_VERSION_TEXT = /^[\x20-\x7e]{1,160}$/;

const LAUNCHER_CONFIG = Symbol("audioExecutorLauncherConfig");
/** 内部 probe 工具配置品牌；只有 audio-probe.mjs 的工厂可构造。 */
export const AUDIO_PROBE_TOOL_CONFIG = Symbol("audioProbeToolConfig");
/**
 * D9b 内部 seam：probe 绑定查询与证据入口只用 symbol 键，不新增普通公开方法，
 * HTTP/UI/queue/store 可见面不变。旧 probe/execute 契约逐字不变。
 */
export const AUDIO_PROBE_TOOL_BINDING = Symbol("audioProbeToolBinding");
export const AUDIO_PROBE_EVIDENCE = Symbol("audioProbeEvidence");

/**
 * 固定 ffprobe 参数。输入文件永远放最后；只允许本地 file 协议与白名单 demuxer，
 * 不接 URL/pipe/playlist，参数不接受调用方拼装。
 */
const PROBE_ARGS = Object.freeze([
  "-v",
  "error",
  "-hide_banner",
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "wav,flac,mp3,aac,mov,mp4,m4a,3gp,3g2,mj2,aiff,ogg",
  "-probesize",
  "5000000",
  "-analyzeduration",
  "5000000",
  "-show_entries",
  "format=format_name,duration:stream=index,codec_type,codec_name,duration,sample_rate,channels,duration_ts,time_base",
  "-of",
  "json",
]);

export const AUDIO_EXECUTOR_CODES = Object.freeze({
  INVALID_REQUEST: "INVALID_REQUEST",
  EXECUTION_BUSY: "EXECUTION_BUSY",
  EXECUTION_UNAVAILABLE: "EXECUTION_UNAVAILABLE",
  CANCELLED: "CANCELLED",
  TIMEOUT: "TIMEOUT",
  OUTPUT_LIMIT: "OUTPUT_LIMIT",
  RESOURCE_LIMIT: "RESOURCE_LIMIT",
  ENGINE_FAILED: "ENGINE_FAILED",
});

const MESSAGES = Object.freeze({
  INVALID_REQUEST: "音频执行请求无效",
  EXECUTION_BUSY: "音频执行器忙",
  EXECUTION_UNAVAILABLE: "音频执行器不可用",
  CANCELLED: "音频执行已取消",
  TIMEOUT: "音频执行超时",
  OUTPUT_LIMIT: "音频引擎输出超出限制",
  RESOURCE_LIMIT: "音频引擎触发资源限制",
  ENGINE_FAILED: "音频引擎执行失败",
});

export class AudioExecutorError extends Error {
  constructor(code) {
    super(MESSAGES[code] || MESSAGES.ENGINE_FAILED);
    this.name = "AudioExecutorError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new AudioExecutorError(code);
};

/** 子进程只拿这些变量；不继承密钥/代理/PYTHONPATH/DYLD/NODE_OPTIONS 等。 */
const BASE_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
  BLAS_NUM_THREADS: "1",
  OMP_NUM_THREADS: "1",
  MKL_NUM_THREADS: "1",
  OPENBLAS_NUM_THREADS: "1",
  VECLIB_MAXIMUM_THREADS: "1",
});

/**
 * 受信 launcher 配置工厂。对外 execute 不接受路径；只有服务内部（测试/后续接线）
 * 通过本工厂构造 launcher 配置，避免把浏览器输入直接变成可执行路径。
 */
export function createAudioExecutorLauncherConfig({ path: launcherPath, sha256 } = {}) {
  if (typeof launcherPath !== "string" || !path.isAbsolute(launcherPath)) fail("INVALID_REQUEST");
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) fail("INVALID_REQUEST");
  return Object.freeze({
    [LAUNCHER_CONFIG]: true,
    path: path.resolve(launcherPath),
    sha256,
  });
}

export class AudioExecutor {
  #dataDir;
  #launcher;
  #probeTool = null;
  #limits;
  #active = null;
  #disposed = false;
  #faulted = false;
  #disposePromise = null;
  #testHooks = null;

  /**
   * @param {object} options
   * @param {string} options.dataDir 应用数据目录（必须为真实目录，不允许符号链接）
   * @param {object|null} [options.launcher] createAudioExecutorLauncherConfig 的产物
   * @param {object|null} [options.probeTool] 内部 ffprobe 工具配置工厂产物
   * @param {object} [options.limits] 只能低于默认上限；测试可降低，不能提高
   */
  constructor(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) fail("INVALID_REQUEST");
    for (const key of Object.keys(options)) {
      if (!["dataDir", "launcher", "probeTool", "limits"].includes(key)) fail("INVALID_REQUEST");
    }
    if (typeof options.dataDir !== "string" || !path.isAbsolute(options.dataDir)) {
      fail("INVALID_REQUEST");
    }
    this.#dataDir = path.resolve(options.dataDir);
    if (options.launcher !== undefined && options.launcher !== null) {
      const launcher = options.launcher;
      if (
        typeof launcher !== "object" ||
        launcher[LAUNCHER_CONFIG] !== true ||
        typeof launcher.path !== "string" ||
        !path.isAbsolute(launcher.path) ||
        typeof launcher.sha256 !== "string" ||
        !SHA256_HEX.test(launcher.sha256)
      ) {
        fail("INVALID_REQUEST");
      }
      this.#launcher = Object.freeze({ path: launcher.path, sha256: launcher.sha256 });
    } else {
      this.#launcher = null;
    }
    if (options.probeTool !== undefined && options.probeTool !== null) {
      const tool = options.probeTool;
      if (
        typeof tool !== "object" ||
        tool[AUDIO_PROBE_TOOL_CONFIG] !== true ||
        typeof tool.path !== "string" ||
        !path.isAbsolute(tool.path) ||
        typeof tool.sha256 !== "string" ||
        !SHA256_HEX.test(tool.sha256) ||
        typeof tool.version !== "string" ||
        !PROBE_VERSION_TEXT.test(tool.version)
      ) {
        fail("INVALID_REQUEST");
      }
      // 可选 pin：只有严格配置工厂会带 pinnedSha256；旧配置工厂不传，保持原行为。
      if (tool.pinnedSha256 !== undefined && (typeof tool.pinnedSha256 !== "string" || !SHA256_HEX.test(tool.pinnedSha256))) {
        fail("INVALID_REQUEST");
      }
      if (tool.identitySource !== undefined && tool.identitySource !== "configured") fail("INVALID_REQUEST");
      const pinnedSha256 = typeof tool.pinnedSha256 === "string" ? tool.pinnedSha256 : null;
      this.#probeTool = Object.freeze({
        path: tool.path,
        sha256: tool.sha256,
        pinnedSha256,
        identitySource: pinnedSha256 ? "configured" : null,
        version: tool.version,
      });
    }
    this.#limits = resolveLimits(options.limits);
    // 只在 Node test runner 子进程里接受符号键注入；不进入构造器字符串键白名单。
    if (process.env.NODE_TEST_CONTEXT) {
      const hooks = options[TEST_HOOKS];
      if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) this.#testHooks = hooks;
    }
  }

  get busy() {
    return this.#active !== null;
  }

  /**
   * 执行一次引擎。成功返回有界 Buffer（供 normalizeAudioResult 解析）；
   * 失败只抛固定 code，不含 stderr、路径或输入原文。
   *
   * D5（2026-10-25 用户批准收紧）：旧入口也走与 executeWithEvidence 相同的成功门。
   * 资源事实 unknown（child/stdio/group/directory）时不再返回 Buffer——调用方拿不到
   * 可能不完整的结果；错误码与证据保持固定码，不新增公开字段语义。代价是每次调用
   * 多分配一份内部证据对象（不持久化、不外露，除非调用方读 error.evidence）。
   */
  execute(snapshot, descriptor, options = {}) {
    // gate 模式在 #start 内已把成功门结果还原为 Buffer，这里不再二次解包。
    return this.#start("execute", snapshot, descriptor, options, "gate");
  }

  /**
   * 证据模式：保留旧 execute 的 Buffer 成功契约，额外返回本次调用真实观测到的
   * 资源/时序快照。v1 只接受 signal/deadlineAtMs，没有 capture/raw stderr。
   * 成功门更严格：只 unknown 的路径（旧 execute 可能仍返回 Buffer）固定拒绝。
   */
  executeWithEvidence(snapshot, descriptor, options = {}) {
    return this.#start("execute", snapshot, descriptor, options, "evidence");
  }

  /**
   * 内部有界 ffprobe。接口与 execute 相同（只收快照与 signal，不收 argv/URL），
   * 固定参数与工具摘要由本模块持有；默认 wall 上限 10 秒且不能借 limits 提高。
   */
  probe(snapshot, options = {}) {
    if (!this.#probeTool) return Promise.reject(new AudioExecutorError("EXECUTION_UNAVAILABLE"));
    // D5b（2026-10-25 用户选择继续收紧）：旧 probe 也走成功门。子进程 close 未证实、
    // 进程组或 job 目录 unknown 时不再返回 stdout——调用方不该拿到"资源未证实"的结果。
    // 失败码仍折叠到既有固定码，错误 evidence 形状不变（不新增 executionEvidence）。
    return this.#start("probe", snapshot, null, options, "gate");
  }

  /**
   * 内部 probe 证据入口（audio-probe.mjs 的严格入口专用）：
   * 返回 { raw, evidence }，成功门与 executeWithEvidence 相同；普通公开方法不变。
   */
  [AUDIO_PROBE_EVIDENCE](snapshot, options = {}) {
    if (!this.#probeTool) return Promise.reject(new AudioExecutorError("EXECUTION_UNAVAILABLE"));
    return this.#start("probe", snapshot, null, options, "evidence");
  }

  /** 内部绑定查询：只回固定字段，不 spawn、不返回证据；未绑定 probe 工具时为 null。 */
  [AUDIO_PROBE_TOOL_BINDING]() {
    const tool = this.#probeTool;
    if (!tool) return null;
    return Object.freeze({
      path: tool.path,
      sha256: tool.sha256,
      pinnedSha256: tool.pinnedSha256,
      identitySource: tool.identitySource,
      version: tool.version,
    });
  }

  #start(operation, snapshot, descriptor, options, mode = "none") {
    if (this.#disposed || this.#faulted) {
      return Promise.reject(new AudioExecutorError("EXECUTION_UNAVAILABLE"));
    }
    if (this.#active) return Promise.reject(new AudioExecutorError("EXECUTION_BUSY"));
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      return Promise.reject(new AudioExecutorError("INVALID_REQUEST"));
    }
    for (const key of Object.keys(options)) {
      if (key !== "signal" && key !== "deadlineAtMs") return Promise.reject(new AudioExecutorError("INVALID_REQUEST"));
    }
    const { signal, deadlineAtMs } = options;
    if (deadlineAtMs !== undefined && (typeof deadlineAtMs !== "number" || !Number.isFinite(deadlineAtMs))) {
      return Promise.reject(new AudioExecutorError("INVALID_REQUEST"));
    }
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    ) {
      return Promise.reject(new AudioExecutorError("INVALID_REQUEST"));
    }
    if (signal?.aborted) return Promise.reject(new AudioExecutorError("CANCELLED"));
    const stateBefore = this.#disposed ? "disposed" : this.#faulted ? "faulted" : "ready";

    // 同步段里先占住单实例槽位，后续第二项在入口即固定 BUSY（probe/execute 共用）。
    const controller = new AbortController();
    let markDone;
    const done = new Promise((resolve) => {
      markDone = resolve;
    });
    const entry = { controller, done };
    this.#active = entry;
    const onExternalAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onExternalAbort, { once: true });
    // mode: "none"（旧 probe，不收集）| "gate"（旧 execute，收集但只加成功门）|
    //       "evidence"（executeWithEvidence / probe 证据入口）。
    const collect = mode !== "none";
    const runState = {
      evidence: collect ? null : undefined,
      legacyEvidence: null,
      stateBefore,
    };
    return this.#run(operation, snapshot, descriptor, controller.signal, deadlineAtMs, runState)
      .then(
        (settled) => {
          if (mode === "none") return settled.raw;
          if (mode === "evidence") return this.#finishEvidenceSuccess(settled.raw, runState.evidence);
          return this.#finishGateSuccess(settled.raw, runState.evidence);
        },
        (error) => {
          // 统一错误边界：未知系统异常（ENOTDIR/EACCES/ENOSPC 等）只折叠为固定码，
          // 不透传 path/syscall/message；已有 AudioExecutorError（取消/超时/超量/
          // 资源/清理或进程组故障）原样保留，finally 中 cleanup/group 失败仍优先。
          const normalized = error instanceof AudioExecutorError ? error : new AudioExecutorError("EXECUTION_UNAVAILABLE");
          // gate 模式不改写旧 error.evidence：失败路径与收紧前逐字一致。
          if (mode === "evidence" && runState.evidence) this.#finishEvidenceFailure(normalized, runState);
          throw normalized;
        },
      )
      .finally(() => {
        if (signal) signal.removeEventListener("abort", onExternalAbort);
        if (this.#active === entry) this.#active = null;
        markDone();
      });
  }

  /**
   * D5：旧 execute 的成功门。资源事实不完整即拒绝返回 Buffer，并让实例 fail-closed；
   * 错误只带固定最小 evidence（不加 executionEvidence），旧失败路径的形状不变。
   */
  #finishGateSuccess(raw, ev) {
    fillAggregate(ev);
    ev.outcome = "success";
    ev.instance.faultedAfter = this.#faulted;
    if (!evidenceGateOk(ev)) {
      this.#faulted = true;
      const error = new AudioExecutorError("EXECUTION_UNAVAILABLE");
      error.evidence = { reason: "RESOURCE_UNKNOWN", resourceUnknown: true };
      throw error;
    }
    return raw;
  }

  #finishEvidenceSuccess(raw, ev) {
    fillAggregate(ev);
    ev.outcome = "success";
    ev.code = null;
    ev.primaryCode = null;
    ev.failure = null;
    ev.instance.faultedAfter = this.#faulted;
    setHandoff(ev);
    if (!evidenceGateOk(ev)) {
      // 路径 C（旧 execute 可能仍成功）：仅 unknown 的证据模式必须 fail-closed。
      this.#faulted = true;
      ev.outcome = "failure";
      ev.code = "EXECUTION_UNAVAILABLE";
      ev.primaryCode = null;
      ev.resourceUnknown = true;
      for (const item of ["child", "stdio.stdout", "group", "directory"]) {
        if (!ev.unknownResources.includes(item)) {
          if (item === "child" && ev.child.closeSettled) continue;
          if (item === "stdio.stdout" && ev.stdio.stdout.final) continue;
          if (item === "group" && ev.group.state === "reclaimed") continue;
          if (item === "directory" && ev.directory.state === "removed") continue;
          ev.unknownResources.push(item);
        }
      }
      ev.failure = {
        stage: "finalize",
        reason: "RESOURCE_UNKNOWN",
        primaryCode: null,
        finalCode: "EXECUTION_UNAVAILABLE",
        overriddenBy: "gate",
      };
      ev.instance.faultedAfter = true;
      setHandoff(ev);
      clearFailureRaw(ev);
      sealEvidence(ev);
      const error = new AudioExecutorError("EXECUTION_UNAVAILABLE");
      error.evidence = mergeLegacyEvidence(null, ev);
      error.executionEvidence = ev;
      throw error;
    }
    sealEvidence(ev);
    return { raw, evidence: ev };
  }

  #finishEvidenceFailure(error, runState) {
    const ev = runState.evidence;
    fillAggregate(ev);
    ev.outcome = "failure";
    ev.code = error.code;
    if (!ev.failure) {
      ev.failure = {
        stage: "finalize",
        reason: null,
        primaryCode: null,
        finalCode: error.code,
        overriddenBy: null,
      };
    }
    ev.failure.finalCode = error.code;
    ev.primaryCode = ev.failure.primaryCode ?? null;
    ev.instance.faultedAfter = this.#faulted;
    setHandoff(ev);
    clearFailureRaw(ev);
    sealEvidence(ev);
    error.evidence = mergeLegacyEvidence(runState.legacyEvidence, ev);
    error.executionEvidence = ev;
  }

  /**
   * 幂等关闭：只请求取消，等待当前任务真正完成进程组回收与目录清理。
   * 关闭后不接受新任务。
   */
  dispose() {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposed = true;
    const active = this.#active;
    if (!active) {
      this.#disposePromise = Promise.resolve();
      return this.#disposePromise;
    }
    active.controller.abort();
    this.#disposePromise = active.done.then(() => undefined);
    return this.#disposePromise;
  }

  async #run(operation, snapshot, descriptor, controllerSignal, deadlineAtMs, runState = null) {
    const limits = this.#limits;
    const probe = operation === "probe";
    const entryAt = monoNow();
    const wallMs = probe ? Math.min(limits.wallMs, PROBE_WALL_MS) : limits.wallMs;
    const hardDeadline = Number.isFinite(deadlineAtMs)
      ? Math.min(deadlineAtMs, entryAt + wallMs)
      : entryAt + wallMs;
    const allowance = limits.termGraceMs + GROUP_CONFIRM_MS + FINAL_CONFIRM_MS;
    const ev =
      runState && runState.evidence === null
        ? createEvidenceDraft({ entryAt, wallMs, hardDeadline, allowance, limits, operation })
        : null;
    if (ev) {
      runState.evidence = ev;
      ev.instance.stateBefore = runState.stateBefore;
    }
    const meta = {
      phase: "entry",
      spawnReason: null,
      spawnDeadline: false,
      closeDeadline: false,
    };
    const job = {
      dir: null,
      token: crypto.randomBytes(16).toString("hex"),
      markerWritten: false,
      markerAttempted: false,
      state: "not-started",
      ops: new Set(),
    };
    const dirState = { presentObserved: false, absentObserved: false };
    let child = null;
    let pid = null;
    let spawnRecord = null;
    let termination = null;
    let wallTimer = null;
    let killTimer = null;
    let onAbort = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = [];
    let stdoutStreamError = false;
    let stderrStreamError = false;
    let spawnedStdio = false;
    let resultRaw = null;
    let unknown = false;
    const lateTakeovers = new Set();

    const beginOp = (kind) => {
      const op = { kind, settled: false, late: false, outcome: null };
      job.ops.add(op);
      return op;
    };
    const settleOp = (op, outcome) => {
      if (!op || op.settled) return;
      op.settled = true;
      op.outcome = outcome;
      if (!op.late) job.ops.delete(op);
    };
    const pendingShared = () => {
      for (const op of job.ops) if (!op.settled) return true;
      return false;
    };

    const offset = (at) => roundMs(at - entryAt);
    const notePhase = (phase) => {
      meta.phase = phase;
    };
    let groupCall = 0;
    const observeGroup = async (targetPid, timeoutMs) => {
      groupCall += 1;
      const hook = this.#testHooks?.observeGroup;
      if (typeof hook === "function") {
        const observed = await hook(targetPid, timeoutMs, groupCall);
        if (observed !== undefined) return observed;
      }
      return waitForGroupGone(targetPid, timeoutMs);
    };
    const removeJobNow = () => {
      const hook = this.#testHooks?.removeJob;
      if (typeof hook === "function") return hook(job);
      return removeOwnedJob(this.#dataDir, job, dirState);
    };
    // 只写被观测到的逐资源事实；reliable=false 不得冒充 reclaimed。
    const applyGroupObservation = (observed, source) => {
      if (!ev) return;
      const pids = Array.isArray(observed?.pids) ? observed.pids : [];
      const reliable = observed?.reliable !== false;
      const previous = ev.group.state;
      const previousBy = ev.group.confirmedBy;
      // 主路径已判 GROUP_UNKNOWN（且已 throw）时，finally 的“事后空组”不能回写成
      // reclaimed；旧调用仍保留原 GROUP_UNKNOWN 失败，证据也不得自相矛盾。
      if (source === "finally" && ev.group.failureSource === "main-leftover") return;
      ev.group.observation = observed?.observation === "kill0" ? "kill0" : "kill0+pgrep";
      ev.group.membersObserved = pids.length;
      ev.timing.groupConfirmedAtMs = offset(monoNow());
      if (!reliable) {
        ev.group.state = "unknown";
        ev.group.confirmedBy = "none";
        ev.group.finalConfirm = "error";
        ev.group.failureSource = source === "main" ? null : "finally-error";
        return;
      }
      if (pids.length === 0) {
        ev.group.state = "reclaimed";
        ev.group.confirmedBy = previous === "reclaimed" ? previousBy : source;
        ev.group.finalConfirm = "empty";
        ev.group.failureSource = null;
        return;
      }
      ev.group.state = "unknown";
      ev.group.confirmedBy = "none";
      ev.group.finalConfirm = "timeout";
      ev.group.failureSource = `${source}-leftover`;
    };

    const sendSignal = (targetPid, signal) => {
      if (!Number.isSafeInteger(targetPid) || targetPid <= 0) return false;
      return killGroup(targetPid, signal);
    };

    const armKillTimer = (targetPid) => {
      if (killTimer) return;
      const delayMs = Math.max(0, Math.min(limits.termGraceMs, remaining(hardDeadline)));
      killTimer = setTimeout(() => {
        if (groupAlive(targetPid)) sendSignal(targetPid, "SIGKILL");
      }, delayMs);
      if (typeof killTimer.unref === "function") killTimer.unref();
    };

    const terminateConfirmed = (record) => {
      if (!record || record.state !== "confirmed" || !Number.isSafeInteger(record.pid)) return;
      if (!record.termSent) {
        record.termSent = true;
        sendSignal(record.pid, "SIGTERM");
      }
      if (!record.killSent) armKillTimer(record.pid);
    };

    // L1：deadline 先赢后才确认的 spawn 不再 TERM/等 grace，确认后立即一次 SIGKILL；
    // 只保留最小接管引用，close settle 后移除，不延长原调用、不重复信号/计时器。
    const lateTakeover = (record) => {
      if (!record) return;
      if (record.state !== "confirmed" || !Number.isSafeInteger(record.pid)) {
        record.lateSpawnObserved = true;
        return;
      }
      record.late = true;
      if (!record.killSent) {
        record.killSent = true;
        sendSignal(record.pid, "SIGKILL");
      }
      lateTakeovers.add(record);
    };

    // PREPARE 的 read/stat/open 超时若留下未 settle 的 fd，整实例按 unknown 故障；
    // 只读迟到 fd 仍由 hashPlainFile 负责 close，close 失败不改变这一保守判断。
    const prepareGuard = async (promise) => {
      try {
        return await promise;
      } catch (error) {
        if (error?.evidence?.resourceUnknown === true) unknown = true;
        throw error;
      }
    };
    const prepareHash = (file, options) =>
      prepareGuard(
        hashPlainFile(file, {
          ...options,
          onLateCloseFailure: () => {
            // 即使本次调用已返回，迟到 close 失败也不能被当作已回收；
            // 实例进入故障门，后续 probe/execute 固定拒绝。
            job.closeFailed = true;
            this.#faulted = true;
          },
        }),
      );
    const prepareSnapshot = (snapshot, dataReal) =>
      prepareGuard(validateSnapshot(snapshot, dataReal, hardDeadline));

    const requestTermination = (reason) => {
      if (termination) return;
      termination = reason;
      if (!spawnRecord) return;
      if (spawnRecord.state === "confirmed") terminateConfirmed(spawnRecord);
      else if (spawnRecord.abortIntent) lateTakeover(spawnRecord);
    };

    try {
      notePhase("prepare");
      if (controllerSignal.aborted) requestTermination("cancelled");
      onAbort = () => requestTermination("cancelled");
      controllerSignal.addEventListener("abort", onAbort, { once: true });

      const dataReal = await plainDirectory(this.#dataDir);
      if (controllerSignal.aborted) fail("CANCELLED");
      if (!SUPPORTED_PLATFORMS.has(process.platform)) fail("EXECUTION_UNAVAILABLE");
      if (!this.#launcher) fail("EXECUTION_UNAVAILABLE");

      await prepareHash(this.#launcher.path, {
        expectedSha256: this.#launcher.sha256,
        maxBytes: MAX_LAUNCHER_BYTES,
        signal: controllerSignal,
        failure: "EXECUTION_UNAVAILABLE",
        deadlineAtMs: hardDeadline,
      });
      let targetPath;
      let targetArgs;
      if (probe) {
        if (!this.#probeTool) fail("EXECUTION_UNAVAILABLE");
        const snapshotFile = await prepareSnapshot(snapshot, dataReal);
        // 严格入口把期望摘要钉在配置里；未 pin 时回退原行为（本次配置摘要）。
        const expectedToolSha = this.#probeTool.pinnedSha256 ?? this.#probeTool.sha256;
        await prepareHash(this.#probeTool.path, {
          expectedSha256: expectedToolSha,
          maxBytes: MAX_PROBE_TOOL_BYTES,
          signal: controllerSignal,
          failure: "EXECUTION_UNAVAILABLE",
          deadlineAtMs: hardDeadline,
        });
        if (ev) {
          // 摘要复验通过后才写身份；不出现路径/PID/argv/env/stderr。
          ev.identity = {
            kind: "probe-tool",
            version: this.#probeTool.version,
            toolSha256: expectedToolSha,
            toolPinSource: this.#probeTool.pinnedSha256 ? "configured" : "computed",
            matched: true,
            snapshotSha256: snapshot.sha256,
            snapshotBytes: snapshot.bytes,
            snapshotDigestSource: "declared",
          };
        }
        targetPath = this.#probeTool.path;
        targetArgs = [...PROBE_ARGS, snapshotFile];
      } else {
        const trusted = await validateDescriptor(descriptor);
        const snapshotFile = await prepareSnapshot(snapshot, dataReal);
        await prepareHash(trusted.binaryPath, {
          expectedSha256: trusted.binarySha256,
          expectedSize: trusted.binarySize,
          maxBytes: MAX_BINARY_BYTES,
          signal: controllerSignal,
          failure: "EXECUTION_UNAVAILABLE",
          deadlineAtMs: hardDeadline,
        });
        targetPath = trusted.binaryPath;
        targetArgs = [snapshotFile, "--json", "--brief"];
        if (ev) {
          ev.identity = {
            version: trusted.version,
            binarySha256: trusted.binarySha256,
            binarySize: trusted.binarySize,
            generation: trusted.generation,
            snapshotSha256: snapshot.sha256,
            snapshotBytes: snapshot.bytes,
            descriptorValidated: true,
            snapshotValidated: true,
          };
        }
      }
      if (controllerSignal.aborted) fail("CANCELLED");

      await this.#prepareJob(job, { hardDeadline, beginOp, settleOp });
      notePhase("job");
      if (controllerSignal.aborted) fail("CANCELLED");

      // 预算门：全部预算只取入口原值；剩余不足以覆盖既有终止/两次组确认时不 spawn。
      notePhase("spawn");
      if (remaining(hardDeadline) <= allowance) {
        meta.spawnReason = "NO_SPAWN_BUDGET";
        const error = new AudioExecutorError("TIMEOUT");
        error.evidence = { reason: "NO_SPAWN_BUDGET", resourceUnknown: false, spawn: "not-created" };
        throw error;
      }

      const env = {
        ...BASE_ENV,
        HOME: path.join(job.dir, "home"),
        TMPDIR: path.join(job.dir, "tmp"),
        TMP: path.join(job.dir, "tmp"),
        TEMP: path.join(job.dir, "tmp"),
      };

      try {
        child = spawn(
          this.#launcher.path,
          [targetPath, ...targetArgs],
          {
            cwd: path.join(job.dir, "work"),
            env,
            shell: false,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      } catch {
        fail("ENGINE_FAILED");
      }
      pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
      spawnedStdio = true;

      // 同一同步段先挂 error/close，再挂 spawn；只写 record，不依赖已结束的 await。
      let resolveDone;
      let resolveClose;
      const closePromise = new Promise((resolve) => {
        resolveClose = resolve;
      });
      const record = {
        state: "pending",
        pid: null,
        confirmedAt: null,
        error: null,
        close: null,
        closeSettled: false,
        abortIntent: null,
        termSent: false,
        killSent: false,
        late: false,
        lateSpawnObserved: false,
        done: new Promise((resolve) => {
          resolveDone = resolve;
        }),
      };
      spawnRecord = record;
      const settleSpawn = (kind, value) => {
        if (record.state !== "pending") return;
        record.state = kind === "spawn" ? "confirmed" : "failed";
        resolveDone(value);
      };
      child.once("error", (error) => {
        record.error = error;
        settleSpawn("error", { kind: "error", error });
      });
      child.once("close", (code, exitSignal) => {
        record.close = { code, exitSignal };
        record.closedAt = monoNow();
        record.closeSettled = true;
        resolveClose(record.close);
        settleSpawn("close-before-spawn", { kind: "close-before-spawn", code, exitSignal });
        if (record.late) lateTakeovers.delete(record);
      });
      child.once("spawn", () => {
        record.confirmedAt = monoNow();
        record.pid = child.pid;
        settleSpawn("spawn", { kind: "spawn" });
        if (record.abortIntent) lateTakeover(record);
      });
      child.stdout?.on("error", () => {
        stdoutStreamError = true;
      });
      child.stderr?.on("error", () => {
        stderrStreamError = true;
      });

      // 仅测试注入：不改变生产路径；用于确定性构造 spawn/close 预算边界。
      if (typeof this.#testHooks?.afterSpawn === "function") await this.#testHooks.afterSpawn();

      const spawnWait = await raceBudget(record.done, remaining(hardDeadline));
      if (spawnWait === BUDGET_EXHAUSTED) {
        meta.spawnDeadline = true;
        record.abortIntent = { reason: "hard-deadline", at: monoNow() };
        record.late = true;
        unknown = true;
        const error = new AudioExecutorError("TIMEOUT");
        error.evidence = { reason: "SPAWN_DEADLINE", resourceUnknown: true, spawn: "unknown" };
        throw error;
      }
      if (spawnWait.kind !== "spawn") {
        meta.spawnReason = spawnWait.kind === "error" ? "SPAWN_ERROR" : "CLOSE_BEFORE_SPAWN";
        await raceBudget(closePromise, Math.max(0, remaining(hardDeadline)));
        fail("ENGINE_FAILED");
      }
      pid = record.pid;
      if (typeof this.#testHooks?.afterSpawnConfirmed === "function") {
        await this.#testHooks.afterSpawnConfirmed();
      }
      notePhase("run");
      // runStop 为既有终止/两次确认预留 allowance，不把 allowance 加进总预算。
      const runStop = Math.min(record.confirmedAt + wallMs, hardDeadline - allowance);
      wallTimer = setTimeout(() => requestTermination("timeout"), Math.max(0, runStop - monoNow()));
      if (typeof wallTimer.unref === "function") wallTimer.unref();

      child.stdout?.on("data", (chunk) => {
        const previous = stdoutBytes;
        stdoutBytes += chunk.length;
        if (previous < limits.stdoutBytes) {
          stdoutChunks = appendBounded(stdoutChunks, chunk, limits.stdoutBytes);
        }
        if (stdoutBytes > limits.stdoutBytes) requestTermination("stdout-limit");
      });
      child.stderr?.on("data", (chunk) => {
        stderrBytes += chunk.length;
        if (stderrBytes > limits.stderrBytes) requestTermination("stderr-limit");
      });

      const closed = await raceBudget(closePromise, Math.max(0, remaining(hardDeadline)));
      if (wallTimer) {
        clearTimeout(wallTimer);
        wallTimer = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (closed === BUDGET_EXHAUSTED) {
        meta.closeDeadline = true;
        unknown = true;
        if (!termination) requestTermination("timeout");
        if (!record.killSent) {
          record.killSent = true;
          sendSignal(record.pid, "SIGKILL");
        }
        const error = new AudioExecutorError(termination === "cancelled" ? "CANCELLED" : "TIMEOUT");
        error.evidence = { reason: "CLOSE_DEADLINE", resourceUnknown: true, closeSettled: false };
        throw error;
      }
      notePhase("group");

      // 不以 stdio close 证明进程组结束：父进程退出后仍可能有同组孙进程。
      if (record.pid) {
        if (groupAlive(record.pid)) sendSignal(record.pid, "SIGKILL");
        const observed = await observeGroup(
          record.pid,
          Math.max(0, Math.min(GROUP_CONFIRM_MS, remaining(hardDeadline))),
        );
        applyGroupObservation(observed, "main");
        if (observed.pids.length > 0) {
          unknown = true;
          this.#faulted = true;
          const error = new AudioExecutorError("EXECUTION_UNAVAILABLE");
          error.evidence = { reason: "GROUP_UNKNOWN", resourceUnknown: true, closeSettled: true };
          throw error;
        }
      }

      if (termination === "cancelled") fail("CANCELLED");
      if (termination === "timeout") fail("TIMEOUT");
      if (termination === "stdout-limit" || termination === "stderr-limit") fail("OUTPUT_LIMIT");
      if (record.error) fail("ENGINE_FAILED");
      if (closed.exitSignal === "SIGXCPU" || closed.exitSignal === "SIGXFSZ") fail("RESOURCE_LIMIT");
      if (closed.code !== 0) fail("ENGINE_FAILED");
      resultRaw = Buffer.concat(stdoutChunks);
      return { raw: resultRaw };
    } catch (error) {
      if (ev) captureEvidenceFailure(ev, meta, error, termination);
      if (error?.evidence) runState.legacyEvidence = error.evidence;
      throw error;
    } finally {
      if (onAbort) controllerSignal.removeEventListener("abort", onAbort);
      if (wallTimer) clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
      if (child && !child.stdout?.destroyed) child.stdout?.destroy();
      if (child && !child.stderr?.destroyed) child.stderr?.destroy();

      let groupFailure = false;
      // PREPARE/owner 阶段迟到 fd close 失败已记入 job.closeFailed；这是独立
      // unknown 证据，必须进入故障门，不能因为 close 的 catch 吞掉就当作已回收。
      if (job.closeFailed) unknown = true;
      if (spawnRecord && spawnRecord.state === "confirmed" && Number.isSafeInteger(spawnRecord.pid)) {
        try {
          if (groupAlive(spawnRecord.pid)) sendSignal(spawnRecord.pid, "SIGKILL");
          const observed = await observeGroup(
            spawnRecord.pid,
            Math.max(0, Math.min(FINAL_CONFIRM_MS, remaining(hardDeadline))),
          );
          applyGroupObservation(observed, "finally");
          if (observed.pids.length > 0) groupFailure = true;
        } catch {
          groupFailure = true;
          if (ev) {
            ev.group.state = "unknown";
            ev.group.confirmedBy = "none";
            ev.group.finalConfirm = "error";
            ev.group.failureSource = "finally-error";
            ev.timing.groupConfirmedAtMs = offset(monoNow());
          }
        }
      } else if (spawnRecord && spawnRecord.abortIntent) {
        // 迟到 spawn 未确认：目录/进程归属仍未知，保留现场并让实例故障。
        unknown = true;
      }

      let cleanupFailure = false;
      if (ev) {
        ev.directory.marker = job.markerWritten ? "written" : job.markerAttempted ? "unknown" : "not-written";
      }
      if (!job.dir) {
        if (ev) {
          ev.directory.state = "not-created";
          ev.directory.reason = "NOT_APPLICABLE";
        }
      } else if (unknown) {
        if (ev) {
          ev.directory.state = "unknown";
          ev.directory.cleanupRan = false;
          ev.directory.postcondition = "not-checked";
          ev.directory.reason = "CLEANUP_SKIPPED_UNKNOWN";
        }
      } else if (pendingShared()) {
        if (ev) {
          ev.directory.state = "unknown";
          ev.directory.cleanupRan = false;
          ev.directory.postcondition = "not-checked";
          ev.directory.reason = "PENDING_SHARED";
        }
      } else {
        if (ev) ev.directory.cleanupRan = true;
        try {
          const budget = remaining(hardDeadline);
          if (budget <= 0) {
            // 只发起一次 rm，不等待；不得把“发起过”说成“已清理”。
            unknown = true;
            if (ev) {
              ev.directory.removalAttempted = true;
              ev.directory.removalSettled = false;
              ev.directory.state = "unknown";
              ev.directory.postcondition = "unknown";
              ev.directory.reason = "CLEANUP_DEADLINE";
              ev.timing.budgetExhausted = true;
            }
            Promise.resolve(removeJobNow()).catch(() => {});
          } else {
            const outcome = await raceBudget(
              removeJobNow(),
              budget,
            );
            if (outcome === BUDGET_EXHAUSTED) {
              unknown = true;
              if (ev) {
                ev.directory.removalAttempted = true;
                ev.directory.removalSettled = false;
                ev.directory.state = "unknown";
                ev.directory.postcondition = "unknown";
                ev.directory.reason = "CLEANUP_DEADLINE";
                ev.timing.budgetExhausted = true;
              }
            } else if (ev) {
              ev.directory.removalAttempted = true;
              ev.directory.removalSettled = true;
              if (dirState.absentObserved) {
                ev.directory.state = "removed";
                ev.directory.postcondition = "absent";
                ev.directory.reason = null;
              } else {
                ev.directory.state = "unknown";
                ev.directory.postcondition = "unknown";
                ev.directory.reason = "CLEANUP_DEADLINE";
              }
            }
          }
        } catch {
          cleanupFailure = true;
          if (ev) {
            ev.directory.removalAttempted = true;
            ev.directory.removalSettled = true;
            ev.directory.state = dirState.presentObserved ? "retained" : "unknown";
            ev.directory.postcondition = dirState.presentObserved ? "present" : "unknown";
            ev.directory.reason = "CLEANUP_ERROR";
          }
        }
      }
      if (ev) {
        ev.directory.pendingOps = [...job.ops].filter((op) => !op.settled).map((op) => op.kind);
        ev.timing.cleanupFinishedAtMs = offset(monoNow());
        snapshotEvidence(ev, {
          meta,
          spawnRecord,
          spawnedStdio,
          stdoutBytes,
          stderrBytes,
          stdoutStreamError,
          stderrStreamError,
          resultRaw,
          limitStdout: limits.stdoutBytes,
          limitStderr: limits.stderrBytes,
          entryAt,
        });
        ev.timing.totalMs = offset(monoNow());
      }

      if (groupFailure || cleanupFailure || unknown) this.#faulted = true;
      if (groupFailure || cleanupFailure) {
        if (ev) {
          const reason = groupFailure ? "GROUP_UNKNOWN" : "CLEANUP_ERROR";
          const same =
            ev.failure &&
            ev.failure.primaryCode === "EXECUTION_UNAVAILABLE" &&
            ev.failure.reason === reason;
          if (same) {
            ev.failure.finalCode = "EXECUTION_UNAVAILABLE";
            ev.failure.stage = "finalize";
            ev.failure.overriddenBy = null;
          } else {
            ev.failure = {
              stage: "finalize",
              reason,
              primaryCode: ev.failure?.primaryCode ?? null,
              finalCode: "EXECUTION_UNAVAILABLE",
              overriddenBy: groupFailure ? "group" : "cleanup",
            };
          }
          ev.outcome = "failure";
          ev.code = "EXECUTION_UNAVAILABLE";
        }
        throw new AudioExecutorError("EXECUTION_UNAVAILABLE");
      }
    }
  }

  async #prepareJob(job, { hardDeadline, beginOp, settleOp }) {
    // 逐级验证 dataDir/audio-executor/jobs：任何一级是符号链接或普通文件都先拒绝，
    // 缺失目录用非递归 mkdir 逐级创建，绝不让 recursive mkdir 穿过未验证祖先。
    // 每个可能创建/修改共享路径的调用都在发起前登记 pending；超时后仍留在账本。
    const dataDir = await plainDirectory(this.#dataDir);
    const ensure = async (baseDir, name) => {
      const target = path.join(baseDir, name);
      let stat = await lstatOrNull(target);
      if (!stat) {
        const op = beginOp(`ensure-${name}`);
        const promise = fs.mkdir(target, { mode: 0o700 });
        const outcome = await raceBudget(promise, remaining(hardDeadline));
        if (outcome === BUDGET_EXHAUSTED) {
          op.late = true;
          job.state = "unknown";
          promise.then(
            async () => {
              const created = await lstatOrNull(target);
              settleOp(op, {
                ok: true,
                dirId: created && created.isDirectory() ? { dev: created.dev, ino: created.ino } : null,
              });
            },
            () => {},
          );
          fail("TIMEOUT");
        }
        settleOp(op, { ok: true });
        stat = await lstatOrNull(target);
      }
      return validatePrivateDirectory(target, stat);
    };
    const audioRoot = await ensure(dataDir, "audio-executor");
    const jobsRoot = await ensure(audioRoot.path, "jobs");
    job.jobsRootId = jobsRoot.id;

    job.dir = path.join(jobsRoot.path, `${JOB_PREFIX}${process.pid}-${job.token}`);
    const mkdirOp = beginOp("mkdir-job");
    const mkdirPromise = fs.mkdir(job.dir, { mode: 0o700 });
    const mkdirOutcome = await raceBudget(mkdirPromise, remaining(hardDeadline));
    if (mkdirOutcome === BUDGET_EXHAUSTED) {
      mkdirOp.late = true;
      job.state = "unknown";
      mkdirPromise.then(
        async () => {
          const created = await lstatOrNull(job.dir);
          if (created && !created.isSymbolicLink() && created.isDirectory()) {
            job.dirId = { dev: created.dev, ino: created.ino };
          }
          settleOp(mkdirOp, { ok: true });
        },
        () => {},
      );
      fail("TIMEOUT");
    }
    settleOp(mkdirOp, { ok: true });

    let handle = null;
    try {
      const created = await fs.lstat(job.dir);
      if (created.isSymbolicLink() || !created.isDirectory()) fail("EXECUTION_UNAVAILABLE");
      job.dirId = { dev: created.dev, ino: created.ino };
      await fs.chmod(job.dir, 0o700);
      const ownerPath = path.join(job.dir, OWNER_FILE);

      job.markerAttempted = true;
      const openOp = beginOp("owner-open");
      const openPromise = fs.open(ownerPath, "wx", 0o600);
      const opened = await raceBudget(openPromise, remaining(hardDeadline));
      if (opened === BUDGET_EXHAUSTED) {
        openOp.late = true;
        job.state = "unknown";
        // 已发起的 open 迟到返回后必须 close；close 失败保留独立 closeFailed 证据。
        openPromise.then(
          (lateHandle) => {
            settleOp(openOp, { ok: true, lateFd: true });
            lateHandle.close().catch(() => {
              job.closeFailed = true;
            });
          },
          () => {},
        );
        fail("TIMEOUT");
      }
      handle = opened;
      settleOp(openOp, { ok: true });

      const writeOp = beginOp("owner-write");
      const writePromise = handle.writeFile(
        JSON.stringify({ token: job.token, pid: process.pid, createdAt: new Date().toISOString() }),
        { encoding: "utf8" },
      );
      const written = await raceBudget(writePromise, remaining(hardDeadline));
      if (written === BUDGET_EXHAUSTED) {
        writeOp.late = true;
        job.state = "unknown";
        Promise.resolve(handle.close()).catch(() => {
          job.closeFailed = true;
        });
        handle = null;
        fail("TIMEOUT");
      }
      settleOp(writeOp, { ok: true });

      const closeOp = beginOp("owner-close");
      const closePromise = handle.close();
      const closed = await raceBudget(closePromise, remaining(hardDeadline));
      if (closed === BUDGET_EXHAUSTED) {
        closeOp.late = true;
        job.state = "unknown";
        closePromise.catch(() => {
          job.closeFailed = true;
        });
        handle = null;
        fail("TIMEOUT");
      }
      handle = null;
      settleOp(closeOp, { ok: true });
      job.markerWritten = true;
      await fs.chmod(ownerPath, 0o600);

      for (const name of ["work", "home", "tmp"]) {
        const dir = path.join(job.dir, name);
        const op = beginOp(`mkdir-${name}`);
        const promise = fs.mkdir(dir, { mode: 0o700 });
        const outcome = await raceBudget(promise, remaining(hardDeadline));
        if (outcome === BUDGET_EXHAUSTED) {
          op.late = true;
          job.state = "unknown";
          promise.then(
            async () => {
              await fs.chmod(dir, 0o700).catch(() => {});
              settleOp(op, { ok: true });
            },
            () => {},
          );
          fail("TIMEOUT");
        }
        settleOp(op, { ok: true });
        await fs.chmod(dir, 0o700);
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error instanceof AudioExecutorError) throw error;
      fail("EXECUTION_UNAVAILABLE");
    }
  }
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

/** v1 证据草稿：全部字段是 JSON-safe 原始值；路径/token/raw 永不进入。 */
function createEvidenceDraft({ entryAt, wallMs, hardDeadline, allowance, limits, operation = "execute" }) {
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    operation: operation === "probe" ? "probe" : "execute",
    outcome: null,
    code: null,
    primaryCode: null,
    resourceUnknown: false,
    unknownResources: [],
    identity: null,
    timing: {
      clock: "monotonic",
      sourceDeadline: hardDeadline < entryAt + wallMs ? "caller" : "executor",
      wallBudgetMs: wallMs,
      hardDeadlineOffsetMs: roundMs(hardDeadline - entryAt),
      allowanceMs: allowance,
      spawnAtMs: null,
      closeAtMs: null,
      groupConfirmedAtMs: null,
      cleanupFinishedAtMs: null,
      totalMs: 0,
      budgetExhausted: false,
    },
    spawn: { state: "not-started", reason: null, confirmedAtMs: null },
    child: {
      state: "not-created",
      exitCode: null,
      signal: null,
      closeSettled: false,
      pidObserved: false,
      streamError: false,
    },
    stdio: {
      stdout: {
        state: "not-started",
        observedBytes: 0,
        final: true,
        retainedBytes: 0,
        limitBytes: limits.stdoutBytes,
        truncated: false,
        available: "none",
      },
      stderr: {
        state: "not-started",
        observedBytes: 0,
        final: true,
        retainedBytes: 0,
        limitBytes: limits.stderrBytes,
        truncated: false,
        available: "none",
      },
    },
    group: {
      state: "not-created",
      confirmedBy: "none",
      observation: "none",
      membersObserved: null,
      finalConfirm: "not-run",
      failureSource: null,
      escapedDescendants: "not-observable",
    },
    directory: {
      state: "not-created",
      marker: "not-written",
      cleanupRan: false,
      removalAttempted: false,
      removalSettled: false,
      postcondition: "not-checked",
      pendingOps: [],
      reason: "NOT_APPLICABLE",
    },
    failure: null,
    instance: { stateBefore: "ready", faultedAfter: false },
    handoff: {
      resourceUnknown: false,
      retainLeaseRequired: false,
      retryPolicy: "not-decided-by-executor",
    },
  };
}

function mapEvidenceStage(phase) {
  if (phase === "prepare" || phase === "job" || phase === "spawn" || phase === "run" || phase === "close" || phase === "group" || phase === "cleanup") {
    return phase;
  }
  return "finalize";
}

function deriveEvidenceReason(code, meta, termination) {
  if (code === "CANCELLED") return "CALLER_ABORTED";
  if (code === "TIMEOUT") return "WALL_DEADLINE";
  if (code === "OUTPUT_LIMIT") {
    if (termination === "stderr-limit") return "STDERR_LIMIT";
    if (termination === "stdout-limit") return "STDOUT_LIMIT";
    return null;
  }
  if (code === "RESOURCE_LIMIT") return "RESOURCE_SIGNAL";
  if (code === "ENGINE_FAILED") return meta.spawnReason || "NONZERO_EXIT";
  return null;
}

function captureEvidenceFailure(ev, meta, error, termination) {
  const code = error?.code || "EXECUTION_UNAVAILABLE";
  const legacyReason = typeof error?.evidence?.reason === "string" ? error.evidence.reason : null;
  const reason = legacyReason || deriveEvidenceReason(code, meta, termination);
  ev.outcome = "failure";
  ev.code = code;
  ev.primaryCode = code;
  ev.failure = {
    stage: mapEvidenceStage(meta.phase),
    reason,
    primaryCode: code,
    finalCode: code,
    overriddenBy: null,
  };
  if (reason === "NO_SPAWN_BUDGET") meta.spawnReason = "NO_SPAWN_BUDGET";
  if (reason === "SPAWN_DEADLINE") {
    meta.spawnDeadline = true;
    meta.spawnReason = "SPAWN_DEADLINE";
  }
  if (reason === "CLOSE_DEADLINE") meta.closeDeadline = true;
  if (typeof reason === "string" && reason.endsWith("_DEADLINE")) ev.timing.budgetExhausted = true;
}

function snapshotEvidence(
  ev,
  {
    meta,
    spawnRecord,
    spawnedStdio,
    stdoutBytes,
    stderrBytes,
    stdoutStreamError,
    stderrStreamError,
    resultRaw,
    limitStdout,
    limitStderr,
    entryAt,
  },
) {
  const record = spawnRecord;
  const closeSettled = record?.closeSettled === true;
  // close/spawn deadline 一旦判失败，之后的迟到 close 只能更新实例故障门，
  // 不得回写成“已 close/已 settled”。冻结时保留判失败那一刻的事实。
  const forceUnsettled = meta.closeDeadline || meta.spawnDeadline;

  let spawnState = "not-started";
  if (meta.spawnDeadline || (record?.abortIntent && record.confirmedAt == null)) spawnState = "unknown";
  else if (record?.confirmedAt != null) spawnState = "confirmed";
  else if (record?.state === "failed") spawnState = "failed";
  else if (record?.lateSpawnObserved) spawnState = "unknown";
  ev.spawn.state = spawnState;
  ev.spawn.reason = meta.spawnReason;
  ev.spawn.confirmedAtMs =
    record?.confirmedAt != null ? roundMs(record.confirmedAt - entryAt) : null;

  let childState = "not-created";
  if (closeSettled) childState = record.close?.exitSignal ? "signaled" : "exited";
  else if (record?.state === "failed") childState = "not-created";
  else if (record?.confirmedAt != null || spawnedStdio) childState = "unknown";
  ev.child.state = forceUnsettled && spawnedStdio ? "unknown" : childState;
  ev.child.exitCode = closeSettled && !forceUnsettled ? record.close?.code ?? null : null;
  ev.child.signal = closeSettled && !forceUnsettled ? record.close?.exitSignal ?? null : null;
  ev.child.closeSettled = closeSettled && !forceUnsettled;
  ev.child.pidObserved = Number.isSafeInteger(record?.pid) && record.pid > 0;
  ev.child.streamError = Boolean(stdoutStreamError || stderrStreamError);

  const final = forceUnsettled ? false : !spawnedStdio ? true : closeSettled;
  const stream = (observedBytes, limitBytes, streamError, retainedBytes, available) => ({
    state: !spawnedStdio ? "not-started" : streamError ? "stream-error" : final ? "settled" : "open",
    observedBytes,
    final,
    retainedBytes,
    limitBytes,
    truncated: observedBytes > limitBytes,
    available,
  });
  ev.stdio.stdout = stream(
    stdoutBytes,
    limitStdout,
    stdoutStreamError,
    resultRaw ? resultRaw.length : 0,
    resultRaw ? "buffer" : "none",
  );
  ev.stdio.stderr = stream(stderrBytes, limitStderr, stderrStreamError, 0, "none");

  ev.timing.spawnAtMs = record?.confirmedAt != null ? roundMs(record.confirmedAt - entryAt) : null;
  ev.timing.closeAtMs = record?.closedAt != null ? roundMs(record.closedAt - entryAt) : null;
  if (meta.spawnDeadline || meta.closeDeadline) ev.timing.budgetExhausted = true;
}

function fillAggregate(ev) {
  const unknownResources = [];
  if (ev.spawn.state === "unknown") unknownResources.push("spawn");
  if (ev.spawn.state === "confirmed" && ev.child.closeSettled === false) unknownResources.push("child");
  if (ev.stdio.stdout.state !== "not-started" && ev.stdio.stdout.final === false) {
    unknownResources.push("stdio.stdout");
  }
  if (ev.stdio.stderr.state !== "not-started" && ev.stdio.stderr.final === false) {
    unknownResources.push("stdio.stderr");
  }
  if (ev.group.state === "unknown") unknownResources.push("group");
  if (ev.directory.state === "unknown" || ev.directory.state === "retained") {
    unknownResources.push("directory");
  }
  ev.unknownResources = unknownResources;
  ev.resourceUnknown = unknownResources.length > 0;
}

function evidenceGateOk(ev) {
  return (
    ev.resourceUnknown === false &&
    ev.child.closeSettled === true &&
    ev.stdio.stdout.final === true &&
    ev.group.state === "reclaimed" &&
    ev.directory.state === "removed"
  );
}

function setHandoff(ev) {
  ev.handoff = {
    resourceUnknown: ev.resourceUnknown === true,
    retainLeaseRequired: ev.resourceUnknown === true,
    retryPolicy: "not-decided-by-executor",
  };
}

/**
 * 失败发布前清除“可供调用方取回 raw”的声明。
 * resultRaw 在 finally 前可能已有值；finally 组失败或新方法成功门拒绝后，
 * 调用方拿不到 raw，因此 available/retainedBytes 必须回到 none/0。
 * observedBytes/final 保持快照时的真实观测前缀与终结状态。
 */
function clearFailureRaw(ev) {
  ev.stdio.stdout.available = "none";
  ev.stdio.stdout.retainedBytes = 0;
}

function mergeLegacyEvidence(legacy, ev) {
  const merged = {};
  const has = (key) => legacy && Object.prototype.hasOwnProperty.call(legacy, key);
  if (legacy && typeof legacy === "object") {
    for (const [key, value] of Object.entries(legacy)) merged[key] = value;
  }
  merged.reason = has("reason") ? legacy.reason : ev.failure?.reason ?? null;
  merged.spawn = has("spawn") ? legacy.spawn : mapLegacySpawn(ev.spawn.state);
  if (ev.child.state !== "not-created") {
    const values = [has("closeSettled") ? legacy.closeSettled : undefined, ev.child.closeSettled].filter(
      (value) => typeof value === "boolean",
    );
    if (values.includes(false)) merged.closeSettled = false;
    else if (values.includes(true)) merged.closeSettled = true;
  } else if (has("closeSettled")) {
    merged.closeSettled = legacy.closeSettled;
  }
  merged.resourceUnknown = (has("resourceUnknown") && legacy.resourceUnknown === true) || ev.resourceUnknown === true;
  return merged;
}

function mapLegacySpawn(state) {
  if (state === "confirmed") return "confirmed";
  if (state === "failed") return "failed";
  if (state === "unknown") return "unknown";
  return "not-created";
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

/** 冻结前校验 JSON-safe 与 8 KiB 上限；超限是内部错误，不截断字段。 */
function sealEvidence(ev) {
  let json;
  try {
    json = JSON.stringify(ev);
  } catch {
    throw new AudioExecutorError("EXECUTION_UNAVAILABLE");
  }
  if (typeof json !== "string" || Buffer.byteLength(json) > EVIDENCE_MAX_JSON_BYTES) {
    throw new AudioExecutorError("EXECUTION_UNAVAILABLE");
  }
  return deepFreeze(ev);
}

function resolveLimits(raw) {
  const limits = {
    wallMs: MAX_WALL_MS,
    stdoutBytes: MAX_STDOUT_BYTES,
    stderrBytes: MAX_STDERR_BYTES,
    termGraceMs: 150,
  };
  if (raw === undefined) return Object.freeze(limits);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_REQUEST");
  for (const key of Object.keys(raw)) {
    if (!(key in limits)) fail("INVALID_REQUEST");
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_REQUEST");
    if (key === "wallMs" && value > MAX_WALL_MS) fail("INVALID_REQUEST");
    if (key === "stdoutBytes" && value > MAX_STDOUT_BYTES) fail("INVALID_REQUEST");
    if (key === "stderrBytes" && value > MAX_STDERR_BYTES) fail("INVALID_REQUEST");
    if (key === "termGraceMs" && value > MAX_TERM_GRACE_MS) fail("INVALID_REQUEST");
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function validateDescriptor(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_REQUEST");
  const { version, platform, arch, binaryPath, binarySha256, binarySize, generation } = raw;
  if (typeof version !== "string" || !ENGINE_VERSION.test(version)) fail("INVALID_REQUEST");
  if (platform !== process.platform || arch !== process.arch) fail("EXECUTION_UNAVAILABLE");
  if (typeof binaryPath !== "string" || !path.isAbsolute(binaryPath)) fail("EXECUTION_UNAVAILABLE");
  if (typeof binarySha256 !== "string" || !SHA256_HEX.test(binarySha256)) fail("INVALID_REQUEST");
  if (!Number.isSafeInteger(binarySize) || binarySize <= 0 || binarySize > MAX_BINARY_BYTES) {
    fail("INVALID_REQUEST");
  }
  if (typeof generation !== "string" || !GENERATION_HEX.test(generation)) fail("INVALID_REQUEST");
  return Object.freeze({
    version,
    platform,
    arch,
    binaryPath: path.resolve(binaryPath),
    binarySha256,
    binarySize,
    generation,
  });
}

async function validateSnapshot(raw, dataReal, deadlineAtMs) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("INVALID_REQUEST");
  if (typeof raw.filePath !== "string" || !path.isAbsolute(raw.filePath)) fail("INVALID_REQUEST");
  if (!Number.isSafeInteger(raw.bytes) || raw.bytes < 0) fail("INVALID_REQUEST");
  if (typeof raw.sha256 !== "string" || !SHA256_HEX.test(raw.sha256)) fail("INVALID_REQUEST");
  if (raw.dir !== undefined && (typeof raw.dir !== "string" || !path.isAbsolute(raw.dir))) {
    fail("INVALID_REQUEST");
  }
  const filePath = path.resolve(raw.filePath);
  // 只读校验同样使用入口绝对 deadline；超时停止等待，不产生需要接管的副作用。
  const statOut = await raceDeadline(plainFile(filePath), deadlineAtMs);
  if (statOut.timedOut) throw prepareDeadlineError("PREPARE_SNAPSHOT_DEADLINE", { unknown: false });
  const stat = statOut.value;
  if (stat.size !== raw.bytes) fail("INVALID_REQUEST");
  if ((stat.mode & 0o077) !== 0) fail("INVALID_REQUEST");
  const realOut = await raceDeadline(fs.realpath(filePath), deadlineAtMs);
  if (realOut.timedOut) throw prepareDeadlineError("PREPARE_SNAPSHOT_DEADLINE", { unknown: false });
  const real = realOut.value;
  if (real !== filePath) fail("INVALID_REQUEST");
  if (!within(dataReal, real) || real === dataReal) fail("INVALID_REQUEST");
  const parent = path.dirname(real);
  if (parent === dataReal) fail("INVALID_REQUEST");
  const parentOut = await raceDeadline(fs.lstat(parent).catch(() => null), deadlineAtMs);
  if (parentOut.timedOut) throw prepareDeadlineError("PREPARE_SNAPSHOT_DEADLINE", { unknown: false });
  const parentStat = parentOut.value;
  if (!parentStat || parentStat.isSymbolicLink() || !parentStat.isDirectory()) fail("INVALID_REQUEST");
  if ((parentStat.mode & 0o077) !== 0) fail("INVALID_REQUEST");
  if (raw.dir !== undefined) {
    const dirOut = await raceDeadline(fs.realpath(raw.dir).catch(() => null), deadlineAtMs);
    if (dirOut.timedOut) throw prepareDeadlineError("PREPARE_SNAPSHOT_DEADLINE", { unknown: false });
    if (dirOut.value !== parent) fail("INVALID_REQUEST");
  }
  return real;
}

function appendBounded(chunks, chunk, limit) {
  let used = 0;
  for (const item of chunks) used += item.length;
  if (used >= limit) return chunks;
  const remaining = limit - used;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return chunks;
}

/** PREPARE 超时：read-only fd 可能迟到，close 未证实前按 unknown fail-closed。 */
function prepareDeadlineError(reason, { unknown = true } = {}) {
  const error = new AudioExecutorError("TIMEOUT");
  error.evidence = {
    reason,
    resourceUnknown: unknown,
    closeSettled: unknown ? false : true,
  };
  return error;
}

/** 把单个可能阻塞的 PREPARE await 收敛到同一绝对 deadline；只停止等待，不取消内核调用。 */
async function raceDeadline(promise, deadlineAtMs) {
  if (deadlineAtMs === undefined) return { timedOut: false, value: await promise };
  const outcome = await raceBudget(promise, remaining(deadlineAtMs));
  if (outcome === BUDGET_EXHAUSTED) return { timedOut: true };
  return { timedOut: false, value: outcome };
}

async function hashPlainFile(
  file,
  { expectedSha256, expectedSize, maxBytes, signal, failure, deadlineAtMs, onLateCloseFailure },
) {
  let handle = null;
  let pendingError = null;
  const noteCloseFailure = (target, label) => {
    if (target?.evidence && typeof target.evidence === "object") {
      target.evidence.closeFailed = true;
      target.evidence.resourceUnknown = true;
      target.evidence.closeSettled = false;
      const failures = Array.isArray(target.evidence.lateCloseFailures)
        ? target.evidence.lateCloseFailures
        : [];
      failures.push(label);
      target.evidence.lateCloseFailures = failures;
    }
    if (typeof onLateCloseFailure === "function") {
      try {
        onLateCloseFailure(label);
      } catch {
        /* 证据回调自身失败不覆盖原错误 */
      }
    }
  };
  const recordClose = (label) => {
    if (pendingError) {
      noteCloseFailure(pendingError, label);
      return;
    }
    // 成功路径上 close 未证实回收：不能把未关闭的 fd 当作成功。
    pendingError = new AudioExecutorError("EXECUTION_UNAVAILABLE");
    pendingError.evidence = {
      reason: label,
      resourceUnknown: true,
      closeSettled: false,
      closeFailed: true,
      lateCloseFailures: [label],
    };
  };
  // 已发起的 open/read 迟到返回后由本函数负责 close；close 失败保留独立证据，
  // 不再用空 catch 冒充“已保存 closeFailed”。
  const closeAfter = (promise, target, error, label) => {
    const close = () =>
      Promise.resolve()
        .then(() => target.close())
        .catch(() => noteCloseFailure(error, label));
    promise.then(close, close);
  };

  try {
    const statOut = await raceDeadline(plainFile(file), deadlineAtMs);
    if (statOut.timedOut) throw prepareDeadlineError("PREPARE_HASH_STAT_DEADLINE", { unknown: false });
    const stat = statOut.value;

    const openPromise = fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
    );
    const openOut = await raceDeadline(openPromise, deadlineAtMs);
    if (openOut.timedOut) {
      const error = prepareDeadlineError("PREPARE_HASH_OPEN_DEADLINE");
      openPromise.then(
        (lateHandle) => {
          Promise.resolve()
            .then(() => lateHandle.close())
            .catch(() => noteCloseFailure(error, "PREPARE_HASH_OPEN_LATE_CLOSE"));
        },
        () => {},
      );
      throw error;
    }
    handle = openOut.value;

    const openedOut = await raceDeadline(handle.stat(), deadlineAtMs);
    if (openedOut.timedOut) {
      const error = prepareDeadlineError("PREPARE_HASH_STAT_DEADLINE");
      const lateHandle = handle;
      handle = null;
      Promise.resolve()
        .then(() => lateHandle.close())
        .catch(() => noteCloseFailure(error, "PREPARE_HASH_STAT_LATE_CLOSE"));
      throw error;
    }
    const opened = openedOut.value;
    if (!opened.isFile()) fail(failure);
    if (opened.size > maxBytes) fail(failure);
    if (expectedSize !== undefined && opened.size !== expectedSize) fail(failure);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail(failure);

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      if (signal?.aborted) fail("CANCELLED");
      const readPromise = handle.read(buffer, 0, buffer.length, null);
      const readOut = await raceDeadline(readPromise, deadlineAtMs);
      if (readOut.timedOut) {
        // 读已发起：等这次 read 返回后再 close 同一个 fd；close 失败保留独立证据。
        const error = prepareDeadlineError("PREPARE_HASH_READ_DEADLINE");
        const lateHandle = handle;
        handle = null;
        closeAfter(readPromise, lateHandle, error, "PREPARE_HASH_READ_LATE_CLOSE");
        throw error;
      }
      const { bytesRead } = readOut.value;
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail(failure);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const afterOut = await raceDeadline(handle.stat(), deadlineAtMs);
    if (afterOut.timedOut) throw prepareDeadlineError("PREPARE_HASH_STAT_DEADLINE");
    const after = afterOut.value;
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== total) fail(failure);
    const currentOut = await raceDeadline(
      fs.lstat(file).catch(() => null),
      deadlineAtMs,
    );
    if (currentOut.timedOut) throw prepareDeadlineError("PREPARE_HASH_STAT_DEADLINE");
    const current = currentOut.value;
    if (!current || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
      fail(failure);
    }
    if (hash.digest("hex") !== expectedSha256) fail(failure);
  } catch (error) {
    pendingError = error instanceof AudioExecutorError ? error : new AudioExecutorError(failure);
  } finally {
    if (handle) {
      const ownedHandle = handle;
      handle = null;
      const closePromise = Promise.resolve()
        .then(() => ownedHandle.close())
        .then(
          () => null,
          (error) => error,
        );
      if (deadlineAtMs === undefined) {
        const closeError = await closePromise;
        if (closeError) recordClose("PREPARE_HASH_CLOSE_FAILED");
      } else {
        const closed = await raceBudget(closePromise, remaining(deadlineAtMs));
        if (closed === BUDGET_EXHAUSTED) {
          // 只停止等待；迟到 close 失败仍记到本次错误的 evidence，不改变已公布终态。
          closePromise.then((lateError) => {
            if (lateError) recordClose("PREPARE_HASH_CLOSE_DEADLINE");
          });
        } else if (closed) {
          recordClose("PREPARE_HASH_CLOSE_FAILED");
        }
      }
    }
  }
  if (pendingError) throw pendingError;
}

/** 逐级 lstat，拒绝任何符号链接祖先；返回最终 stat。 */
async function plainFile(file) {
  const stat = await plainPath(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("INVALID_REQUEST");
  return stat;
}

async function plainDirectory(dir) {
  const stat = await plainPath(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("EXECUTION_UNAVAILABLE");
  const real = await fs.realpath(dir).catch(() => null);
  if (!real || real !== dir) fail("EXECUTION_UNAVAILABLE");
  return real;
}

/** 逐级创建缺失目录；已存在或刚创建的目录都必须是非链接私有目录。 */
async function ensurePrivateDirectory(baseDir, name) {
  const target = path.join(baseDir, name);
  let stat = await lstatOrNull(target);
  if (!stat) {
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (error) {
      // 并发创建/已被放置链接时统一落到下面的 lstat 复核，不递归创建。
      if (error?.code !== "EEXIST") fail("EXECUTION_UNAVAILABLE");
    }
    stat = await lstatOrNull(target);
  }
  return validatePrivateDirectory(target, stat);
}

/** 清理前只验证、不创建；祖先被换成符号链接/文件时 fail-closed。 */
async function verifyPrivateDirectory(baseDir, name) {
  const target = path.join(baseDir, name);
  return validatePrivateDirectory(target, await lstatOrNull(target));
}

async function validatePrivateDirectory(target, stat) {
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    fail("EXECUTION_UNAVAILABLE");
  }
  const real = await fs.realpath(target).catch(() => null);
  if (!real || real !== target) fail("EXECUTION_UNAVAILABLE");
  // realpath 与 lstat 之间也不允许被换掉。
  const current = await fs.lstat(target).catch(() => null);
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    current.dev !== stat.dev ||
    current.ino !== stat.ino
  ) {
    fail("EXECUTION_UNAVAILABLE");
  }
  return { path: target, id: { dev: current.dev, ino: current.ino } };
}

async function plainPath(target) {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  let stat = null;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    stat = await fs.lstat(current).catch(() => null);
    if (!stat) fail("EXECUTION_UNAVAILABLE");
    if (stat.isSymbolicLink()) fail("EXECUTION_UNAVAILABLE");
    const last = index === parts.length - 1;
    if (!last && !stat.isDirectory()) fail("EXECUTION_UNAVAILABLE");
  }
  if (!stat) fail("EXECUTION_UNAVAILABLE");
  return stat;
}

async function removeOwnedJob(dataDir, job, dirState = null) {
  const dir = job.dir;
  if (typeof dir !== "string" || !path.isAbsolute(dir)) fail("EXECUTION_UNAVAILABLE");

  // 不在未经验证的 audio-executor/jobs 祖先下 lstat/rm；若运行期间被替换成
  // 符号链接或普通文件，这里直接失败并让实例进入故障态，外部目标保持不变。
  const dataReal = await plainDirectory(dataDir);
  const audioRoot = await verifyPrivateDirectory(dataReal, "audio-executor");
  const jobsRoot = await verifyPrivateDirectory(audioRoot.path, "jobs");
  if (
    job.jobsRootId &&
    (jobsRoot.id.dev !== job.jobsRootId.dev || jobsRoot.id.ino !== job.jobsRootId.ino)
  ) {
    fail("EXECUTION_UNAVAILABLE");
  }
  if (!within(jobsRoot.path, dir) || dir === jobsRoot.path) fail("EXECUTION_UNAVAILABLE");

  const stat = await fs.lstat(dir).catch(() => null);
  if (!stat) {
    if (dirState) dirState.absentObserved = true;
    return;
  }
  if (dirState) dirState.presentObserved = true;
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("EXECUTION_UNAVAILABLE");
  if (job.dirId && (stat.dev !== job.dirId.dev || stat.ino !== job.dirId.ino)) {
    fail("EXECUTION_UNAVAILABLE");
  }

  if (!job.markerWritten) {
    // 只可能是本任务刚建的空目录（marker 尚未成功写入）；出现未知条目就保留现场。
    try {
      await fs.unlink(path.join(dir, OWNER_FILE));
    } catch (error) {
      if (error?.code !== "ENOENT") fail("EXECUTION_UNAVAILABLE");
    }
    const entries = await fs.readdir(dir).catch(() => null);
    if (!entries || entries.length > 0) fail("EXECUTION_UNAVAILABLE");
    await fs.rmdir(dir).catch(() => fail("EXECUTION_UNAVAILABLE"));
  } else {
    const ownerPath = path.join(dir, OWNER_FILE);
    const ownerStat = await fs.lstat(ownerPath).catch(() => null);
    if (!ownerStat || ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.size > OWNER_MAX_BYTES) {
      fail("EXECUTION_UNAVAILABLE");
    }
    const text = await fs.readFile(ownerPath, "utf8").catch(() => null);
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.token !== job.token) fail("EXECUTION_UNAVAILABLE");
    // 破坏性调用前再验一次祖先，尽量收窄路径替换窗口。
    await verifyPrivateDirectory(audioRoot.path, "jobs");
    await fs.rm(dir, { recursive: true, force: false }).catch(() => fail("EXECUTION_UNAVAILABLE"));
  }

  const remains = await lstatOrNull(dir);
  if (remains) {
    if (dirState) dirState.presentObserved = true;
    fail("EXECUTION_UNAVAILABLE");
  }
  if (dirState) dirState.absentObserved = true;
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

function killGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** 同一 mono 时钟域：预算/剩余/等待窗只用 performance.now()，Date.now 仅展示。 */
function monoNow() {
  return performance.now();
}

function remaining(deadlineAtMs) {
  return deadlineAtMs - monoNow();
}

/** 只停止等待，不取消内核中的 fs 调用；预算耗尽返回哨兵，迟到结果仍由原 promise 处理。 */
function raceBudget(promise, budgetMs) {
  const guarded = Promise.resolve(promise);
  if (!(budgetMs > 0)) {
    // 预算已耗尽：仍先挂拒绝处理器，避免迟到拒绝逃逸为未处理 rejection。
    guarded.catch(() => {});
    return Promise.resolve(BUDGET_EXHAUSTED);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(BUDGET_EXHAUSTED);
    }, budgetMs);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
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

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function listProcessGroup(pgid) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-g", String(pgid)], {
      timeout: 1000,
      maxBuffer: 64 * KiB,
    });
    return {
      pids: String(stdout)
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
      reliable: true,
      observation: "kill0+pgrep",
    };
  } catch (error) {
    if (error?.code === 1) return { pids: [], reliable: true, observation: "kill0+pgrep" };
    // pgrep 非“无匹配”错误：kill0 只能说明组是否仍存在，不能证明空组。
    return {
      pids: groupAlive(pgid) ? [-1] : [],
      reliable: false,
      observation: "kill0",
    };
  }
}

async function waitForGroupGone(pgid, timeoutMs) {
  const deadline = monoNow() + timeoutMs;
  let observed = await listProcessGroup(pgid);
  while (observed.pids.length > 0 && monoNow() < deadline) {
    killGroup(pgid, "SIGKILL");
    await delay(25);
    observed = await listProcessGroup(pgid);
  }
  return observed;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
