/**
 * T-LOCAL-013I：可信、有界的本地音频 probe。
 *
 * 只使用服务内部固定的 ffprobe 路径/摘要与固定参数，复用 audio-executor 的
 * launcher、独立进程组、私有 cwd/HOME/TMP、有界 stdout/stderr 与进程回收；
 * 不接浏览器 URL/命令/argv，不按 PATH 搜索工具，不联网、不整文件 readFile。
 *
 * 本模块只解析有界 ffprobe JSON。头部参数探测不等于完整解码，也不证明媒体语义。
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  AUDIO_PROBE_TOOL_CONFIG,
  AUDIO_PROBE_TOOL_BINDING,
  AUDIO_PROBE_EVIDENCE,
} from "./audio-executor.mjs";

const MAX_PROBE_BYTES = 64 * 1024;
const MAX_PROBE_TOOL_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_TEXT = /^[A-Za-z0-9._+() -]{1,128}$/;
const DECIMAL_TEXT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** 严格入口预算：与 executor PROBE_WALL_MS 对齐，并为 scope 释放预留 500ms。 */
const GUARDED_SCOPE_WALL_MS = 10_000;
const GUARDED_RELEASE_RESERVE_MS = 500;
const GUARDED_MIN_BUDGET_MS = 100;
const PROBE_EVIDENCE_MAX_BYTES = 9 * 1024;
const GUARDED_OPTION_KEYS = new Set(["signal", "deadlineAtMs"]);
const FAILURE_STAGES = new Set([
  "entry",
  "lease",
  "prepare",
  "spawn",
  "run",
  "close",
  "group",
  "cleanup",
  "parse",
  "finalize",
]);
const UNKNOWN_RESOURCE_ORDER = ["lease", "spawn", "child", "stdio.stdout", "stdio.stderr", "group", "directory"];
const UNKNOWN_RESOURCE_KINDS = new Set(UNKNOWN_RESOURCE_ORDER);

const SUPPORTED_DEMUXERS = new Set([
  "wav",
  "flac",
  "mp3",
  "aac",
  "mov",
  "mp4",
  "m4a",
  "3gp",
  "3g2",
  "mj2",
  "aiff",
  "ogg",
]);

/** 允许的规范格式（与 pipeline 的 SUPPORTED_FORMATS 对齐）。 */
const SUPPORTED_FORMATS = new Set(["wav", "flac", "mp3", "aac", "m4a", "aiff", "ogg", "opus"]);

export const PROBE_CODES = Object.freeze({
  INVALID_REQUEST: "INVALID_REQUEST",
  PROBE_UNAVAILABLE: "PROBE_UNAVAILABLE",
  PROBE_REJECTED: "PROBE_REJECTED",
  /** 仅严格入口使用；旧 probe 的并发仍折叠为 PROBE_UNAVAILABLE。 */
  PROBE_BUSY: "PROBE_BUSY",
  TIMEOUT: "TIMEOUT",
  CANCELLED: "CANCELLED",
});

export class AudioProbeError extends Error {
  constructor(code) {
    super(
      code === "TIMEOUT"
        ? "音频探测超时"
        : code === "CANCELLED"
          ? "音频探测已取消"
          : code === "PROBE_REJECTED"
            ? "音频探测结果不符合约束"
            : code === "PROBE_BUSY"
              ? "音频探测忙"
              : "音频探测不可用",
    );
    this.name = "AudioProbeError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new AudioProbeError(code);
};

/**
 * 内部受信 ffprobe 配置。path 必须是调用方在配置边界已 realpath 的普通文件；
 * 这里只做形状固定，不 spawn，也不在任务里跟随 PATH/链接。
 */
export function createAudioProbeToolConfig({ path: toolPath, sha256, version } = {}) {
  if (typeof toolPath !== "string" || !path.isAbsolute(toolPath)) fail("INVALID_REQUEST");
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) fail("INVALID_REQUEST");
  if (typeof version !== "string" || !VERSION_TEXT.test(version)) fail("INVALID_REQUEST");
  return Object.freeze({
    [AUDIO_PROBE_TOOL_CONFIG]: true,
    path: path.resolve(toolPath),
    sha256,
    version,
  });
}

/**
 * 配置边界：解析真实工具路径并计算摘要。只做文件 IO，不运行工具。
 * 工具缺失/被替换/非普通文件在这里或每次 probe 的摘要复核时明确不可用。
 * 旧入口：`expectedSha256` 可选，不传时以本次现算摘要作为配置摘要（兼容保留）。
 */
export async function resolveAudioProbeTool({ path: candidate, version, expectedSha256 } = {}) {
  const { real, digest } = await readToolFile(candidate);
  if (expectedSha256 !== undefined && digest !== expectedSha256) fail("PROBE_UNAVAILABLE");
  return createAudioProbeToolConfig({ path: real, sha256: digest, version });
}

/**
 * 严格配置边界：`expectedSha256` 必填，来自受信配置/清单；现算摘要只用于校验。
 * 返回的 `pinnedSha256` 是配置输入值，`identitySource:"configured"` 表明来源；
 * 不把本次现算摘要冒充发布方已信任身份，不搜索 PATH、不跟随链接、不下载。
 */
export async function resolvePinnedAudioProbeTool({ path: candidate, version, expectedSha256 } = {}) {
  if (typeof expectedSha256 !== "string" || !SHA256_HEX.test(expectedSha256)) fail("INVALID_REQUEST");
  const { real, digest } = await readToolFile(candidate);
  if (digest !== expectedSha256) fail("PROBE_UNAVAILABLE");
  if (typeof version !== "string" || !VERSION_TEXT.test(version)) fail("INVALID_REQUEST");
  return Object.freeze({
    [AUDIO_PROBE_TOOL_CONFIG]: true,
    path: real,
    sha256: digest,
    pinnedSha256: expectedSha256,
    version,
    identitySource: "configured",
  });
}

/** 只读检查：绝对路径 → realpath → 普通非链接文件 → 有界摘要。 */
async function readToolFile(candidate) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) fail("INVALID_REQUEST");
  let real;
  let stat;
  try {
    real = await fs.realpath(candidate);
    stat = await fs.lstat(real);
  } catch {
    fail("PROBE_UNAVAILABLE");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MAX_PROBE_TOOL_BYTES) {
    fail("PROBE_UNAVAILABLE");
  }
  let digest;
  try {
    digest = await hashFile(real, stat.size);
  } catch {
    fail("PROBE_UNAVAILABLE");
  }
  return { real, digest };
}

/**
 * 内部 probe 适配器：runner 必须是带 probe() 的 AudioExecutor，且构造时已绑定
 * 同一个 tool；本类不另造进程回收逻辑。
 */
export class AudioProbe {
  #runner;
  #tool;
  #withLifecycleScope;
  #guardedActive = false;

  constructor({ runner, tool, withLifecycleScope } = {}) {
    if (
      runner === null ||
      typeof runner !== "object" ||
      typeof runner.probe !== "function" ||
      tool === null ||
      typeof tool !== "object" ||
      tool[AUDIO_PROBE_TOOL_CONFIG] !== true
    ) {
      fail("INVALID_REQUEST");
    }
    if (withLifecycleScope !== undefined && withLifecycleScope !== null && typeof withLifecycleScope !== "function") {
      fail("INVALID_REQUEST");
    }
    this.#runner = runner;
    this.#tool = tool;
    this.#withLifecycleScope = typeof withLifecycleScope === "function" ? withLifecycleScope : null;
  }

  get tool() {
    return Object.freeze({ path: this.#tool.path, sha256: this.#tool.sha256, version: this.#tool.version });
  }

  /**
   * @param {{filePath:string,bytes:number,sha256:string,dir?:string}} snapshot T13B 快照
   * @param {{signal?:AbortSignal}} [options]
   * @returns {Promise<{durationSec:number,channels:number,sampleRate:number,
   *   totalSamples:number,format:string}>}
   */
  async probe(snapshot, options = {}) {
    if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      fail("INVALID_REQUEST");
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      fail("INVALID_REQUEST");
    }
    const { signal } = options;
    let raw;
    try {
      raw = await this.#runner.probe(snapshot, signal === undefined ? {} : { signal });
    } catch (error) {
      if (signal?.aborted) fail("CANCELLED");
      const code = error?.code;
      if (code === "CANCELLED") fail("CANCELLED");
      if (code === "TIMEOUT") fail("TIMEOUT");
      fail("PROBE_UNAVAILABLE");
    }
    return parseProbeOutput(raw);
  }

  /**
   * 严格入口（D9b）：在 engine 的 lifecycle scope（同一把 `.audio-install.lock`）内
   * 用钉住的期望摘要复验工具身份，跑一次有界 probe；结果与证据分开返回。
   *
   * 成功门 = executor 成功门 + parse accepted + lease released + resourceUnknown=false。
   * 任一 unknown（child/stdio/group/directory/lease）→ retain 锁 + 抛错，不返回结果、
   * 不提前放锁、不声称已回收。
   *
   * @param {object} snapshot T13B 快照（executor 只读校验，不重算内容摘要）
   * @param {{signal?:AbortSignal, deadlineAtMs:number}} options deadlineAtMs 必填（单调时钟）
   * @returns {Promise<{probe:object, evidence:object}>}
   */
  async probeGuarded(snapshot, options = {}) {
    const startedAt = performance.now();
    const ev = createProbeEvidence();
    const st = {
      startedAt,
      ownsActive: false,
      acquired: false,
      retained: false,
      unknown: false,
      pendingAtExit: [],
      parsed: null,
      executorEvidence: null,
      failure: null,
    };
    const publishFailure = (code, stage, reason, primaryCode = null, overriddenBy = null) => {
      const evidence = fillProbeEvidence(ev, st, { outcome: "failure", code, stage, reason, primaryCode, overriddenBy });
      throw guardedError(evidence);
    };

    try {
      // [0] 入口预检：不取锁、不建 job。接线/选项错误同样带固定证据。
      let guarded = null;
      try {
        guarded = readGuardedOptions(options);
        if (!isPlainObject(snapshot)) fail("INVALID_REQUEST");
        this.#assertGuardedWiring();
      } catch (error) {
        publishFailure(typeof error?.code === "string" ? error.code : "INVALID_REQUEST", "entry", "INVALID_ENTRY");
      }
      const { signal, deadlineAtMs } = guarded;
      if (this.#guardedActive) {
        ev.lease.reason = "PROBE_REENTRANT";
        publishFailure("PROBE_BUSY", "entry", "PROBE_REENTRANT");
      }
      const now = performance.now();
      const scopeDeadline = Math.min(deadlineAtMs, now + GUARDED_SCOPE_WALL_MS);
      const probeDeadline = scopeDeadline - GUARDED_RELEASE_RESERVE_MS;
      ev.budget.scopeDeadlineOffsetMs = roundMs(scopeDeadline - startedAt);
      ev.budget.probeDeadlineOffsetMs = roundMs(probeDeadline - startedAt);
      if (probeDeadline - now < GUARDED_MIN_BUDGET_MS) {
        publishFailure("TIMEOUT", "entry", "INSUFFICIENT_BUDGET");
      }
      if (signal?.aborted) publishFailure("CANCELLED", "entry", "CALLER_ABORTED");

      this.#guardedActive = true;
      st.ownsActive = true;
      let scopeError = null;
      const withScope = this.#withLifecycleScope;
      try {
        // [1] 同一把安装锁；[3] executor probe 证据入口；[4] 同步有界解析；[5] 结算。
        await withScope(
          async (guard) => {
            st.acquired = true;
            guard.track("probe-run");
            let out = null;
            try {
              out = await this.#runner[AUDIO_PROBE_EVIDENCE](snapshot, {
                signal,
                deadlineAtMs: probeDeadline,
              });
            } catch (error) {
              if (isPlainObject(error?.executionEvidence)) st.executorEvidence = error.executionEvidence;
              st.failure = executorFailure(error, st.executorEvidence);
              if (error?.evidence?.resourceUnknown === true || error?.evidence?.closeSettled === false) {
                st.unknown = true;
              }
            }
            if (out !== null && typeof out === "object") {
              if (isPlainObject(out.evidence)) st.executorEvidence = out.evidence;
              try {
                st.parsed = parseProbeOutput(out.raw);
                ev.parse.state = "accepted";
              } catch {
                ev.parse.state = "rejected";
                ev.parse.code = "PROBE_REJECTED";
                st.failure = {
                  code: "PROBE_REJECTED",
                  stage: "parse",
                  reason: "OUTPUT_REJECTED",
                  primaryCode: null,
                  overriddenBy: "parse",
                };
              }
            }
            projectExecutorEvidence(ev, st.executorEvidence, this.#tool);
            if (executorResourcesUnknown(st.executorEvidence)) st.unknown = true;
            // F1：runner 声称成功时，adapter 自己复核成功门，不盲信 runner 的结论。
            if (out !== null && typeof out === "object" && st.failure === null) {
              const resourceFacts = probeResourceFactsOk(ev);
              if (!resourceFacts) st.unknown = true;
              if (!resourceFacts || !probeIdentityOk(ev)) {
                st.failure = {
                  code: "PROBE_UNAVAILABLE",
                  stage: "finalize",
                  reason: "SUCCESS_GATE_INCOMPLETE",
                  primaryCode: codeValue(st.executorEvidence?.code),
                  overriddenBy: resourceFacts ? null : "cleanup",
                };
              }
            }
            if (st.unknown) {
              guard.retain("probe-resource-unknown");
              st.retained = true;
            } else {
              guard.settle("probe-run");
            }
            // 未结算的自身登记同样不能被当作已回收。
            if (guard.pending.size > 0) {
              guard.retain("probe-resource-unknown");
              st.retained = true;
              st.unknown = true;
            }
            st.pendingAtExit = guard.pending.has("probe-run") ? ["probe-run"] : [];
            return null;
          },
          { scope: "probe", signal, deadlineAtMs: scopeDeadline },
        );
      } catch (error) {
        scopeError = error;
      }

      // [7] scope 结算之后才分类并发布证据。
      let leaseState = "not-acquired";
      let leaseReason = null;
      let releaseUnknown = false;
      if (scopeError) {
        const engine = readEngineScopeFailure(scopeError);
        leaseReason = engine.reason ?? (engine.code === "ENGINE_LOCK_FAILED" ? "RELEASE_FAILED" : null);
        if (st.acquired) {
          // 已取到锁却 reject：只有 LOCK_FAILED 才是释放失败（锁保留）；
          // 其它错误来自 callback 自身，engine 的 finally 已成功释放。
          if (engine.code === "ENGINE_LOCK_FAILED") {
            leaseState = "held";
            releaseUnknown = true;
          } else {
            leaseState = "released";
          }
        } else if (engine.acquireUnknown) {
          leaseState = "unknown";
          releaseUnknown = true;
        }
      } else if (st.retained) {
        leaseState = "held";
        leaseReason = "PROBE_RESOURCE_UNKNOWN";
      } else if (st.acquired) {
        leaseState = "released";
      }

      ev.lease.state = leaseState;
      ev.lease.reason = leaseReason;
      ev.lease.retainRequested = st.retained;
      ev.lease.pendingAtExit = st.pendingAtExit;
      // 只有真正释放成功才记释放时刻；held/unknown 不冒充已释放。
      ev.budget.releaseAtMs = leaseState === "released" ? roundMs(performance.now() - startedAt) : null;

      const unknown = st.unknown === true || releaseUnknown || leaseState === "held" || leaseState === "unknown";
      const primaryCode = codeValue(st.executorEvidence?.code) ?? st.failure?.primaryCode ?? null;

      if (scopeError) {
        if (!st.acquired) {
          const engine = readEngineScopeFailure(scopeError);
          const code =
            engine.code === "ENGINE_BUSY"
              ? "PROBE_BUSY"
              : engine.code === "ENGINE_CANCELLED"
                ? "CANCELLED"
                : "PROBE_UNAVAILABLE";
          publishFailure(code, "lease", engine.reason, primaryCode);
        }
        publishFailure(
          "PROBE_UNAVAILABLE",
          releaseUnknown ? "lease" : "finalize",
          leaseReason ?? "PROBE_INTERNAL_FAILURE",
          primaryCode,
          releaseUnknown ? "lease" : null,
        );
      }
      if (unknown) {
        publishFailure(
          "PROBE_UNAVAILABLE",
          st.failure?.stage ?? "cleanup",
          st.failure?.reason ?? "RESOURCE_UNKNOWN",
          primaryCode,
          st.failure?.overriddenBy ?? "cleanup",
        );
      }
      if (st.failure) {
        publishFailure(
          st.failure.code,
          st.failure.stage,
          st.failure.reason,
          st.failure.primaryCode,
          st.failure.overriddenBy,
        );
      }
      if (signal?.aborted) publishFailure("CANCELLED", "finalize", "CALLER_ABORTED", primaryCode);
      if (!st.parsed) publishFailure("PROBE_UNAVAILABLE", "finalize", "NO_RESULT", primaryCode);

      const evidence = fillProbeEvidence(ev, st, {
        outcome: "success",
        code: null,
        stage: null,
        reason: null,
        primaryCode: null,
      });
      if (evidence.outcome !== "success" || evidence.resourceUnknown || evidence.lease.state !== "released") throw guardedError(evidence);
      return { probe: st.parsed, evidence };
    } finally {
      if (st.ownsActive) this.#guardedActive = false;
    }
  }

  /** 严格入口接线检查：未 pin 配置、绑定不符、缺 scope/证据入口都在取锁前失败。 */
  #assertGuardedWiring() {
    const tool = this.#tool;
    if (
      tool.identitySource !== "configured" ||
      typeof tool.pinnedSha256 !== "string" ||
      !SHA256_HEX.test(tool.pinnedSha256) ||
      tool.pinnedSha256 !== tool.sha256
    ) {
      fail("PROBE_UNAVAILABLE");
    }
    if (typeof this.#withLifecycleScope !== "function") fail("INVALID_REQUEST");
    const runner = this.#runner;
    if (
      typeof runner[AUDIO_PROBE_EVIDENCE] !== "function" ||
      typeof runner[AUDIO_PROBE_TOOL_BINDING] !== "function"
    ) {
      fail("INVALID_REQUEST");
    }
    const binding = runner[AUDIO_PROBE_TOOL_BINDING]();
    if (
      !isPlainObject(binding) ||
      binding.path !== tool.path ||
      binding.sha256 !== tool.sha256 ||
      binding.pinnedSha256 !== tool.pinnedSha256 ||
      binding.identitySource !== tool.identitySource ||
      binding.version !== tool.version
    ) {
      fail("INVALID_REQUEST");
    }
  }
}

/**
 * 纯解析入口：有界 UTF-8 JSON → 规范 probe。进程失败与解析失败分开。
 * 只接受单一音频流；视频/多轨/未知时长/非法参数/非白名单 demuxer 全部拒绝。
 */
export function parseProbeOutput(raw) {
  let text;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_PROBE_BYTES) fail("PROBE_REJECTED");
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.length > MAX_PROBE_BYTES) fail("PROBE_REJECTED");
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      fail("PROBE_REJECTED");
    }
  } else {
    fail("PROBE_REJECTED");
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    fail("PROBE_REJECTED");
  }
  if (!isPlainObject(value)) fail("PROBE_REJECTED");

  const format = value.format;
  const streams = value.streams;
  if (!isPlainObject(format) || !Array.isArray(streams)) fail("PROBE_REJECTED");
  if (streams.length !== 1 || !isPlainObject(streams[0])) fail("PROBE_REJECTED");
  const stream = streams[0];
  if (stream.codec_type !== "audio") fail("PROBE_REJECTED");

  const demuxers = readFormatNames(format.format_name);
  if (!demuxers || demuxers.some((name) => !SUPPORTED_DEMUXERS.has(name))) fail("PROBE_REJECTED");

  const codec = typeof stream.codec_name === "string" ? stream.codec_name : null;
  const normalizedFormat = mapFormat(demuxers, codec);
  if (!normalizedFormat || !SUPPORTED_FORMATS.has(normalizedFormat)) fail("PROBE_REJECTED");

  const durationSec = readPositiveNumber(format.duration, 600);
  if (durationSec === null) fail("PROBE_REJECTED");
  const channels = readPositiveInteger(stream.channels, 2);
  if (channels === null) fail("PROBE_REJECTED");
  const sampleRate = readPositiveInteger(stream.sample_rate, 48_000);
  if (sampleRate === null) fail("PROBE_REJECTED");
  const totalSamples = Math.round(durationSec * sampleRate);
  if (!Number.isSafeInteger(totalSamples) || totalSamples <= 0 || totalSamples > 60_000_000) {
    fail("PROBE_REJECTED");
  }

  return Object.freeze({
    durationSec,
    channels,
    sampleRate,
    totalSamples,
    format: normalizedFormat,
  });
}

function readFormatNames(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) return null;
  const names = raw.split(",").map((name) => name.trim());
  if (names.length === 0 || names.some((name) => !/^[a-z0-9_]+$/.test(name))) return null;
  return names;
}

function mapFormat(demuxers, codec) {
  const set = new Set(demuxers);
  if (set.has("wav")) return "wav";
  if (set.has("flac")) return "flac";
  if (set.has("mp3")) return "mp3";
  if (set.has("aiff")) return "aiff";
  if (set.has("aac")) return codec === "aac" ? "aac" : null;
  if (set.has("ogg")) {
    if (codec === "opus") return "opus";
    if (codec === "vorbis") return "ogg";
    return null;
  }
  if (set.has("mov") || set.has("mp4") || set.has("m4a") || set.has("3gp") || set.has("3g2") || set.has("mj2")) {
    return codec === "aac" ? "m4a" : null;
  }
  return null;
}

function readPositiveNumber(raw, max) {
  // ffprobe 对不同字段可能给字符串或数字；只接受十进制、拒绝 "N/A"/指数/负零。
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw);
  if (!DECIMAL_TEXT.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > max) return null;
  return value;
}

function readPositiveInteger(raw, max) {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw);
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) return null;
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

async function hashFile(file, expectedSize) {
  const handle = await fs.open(file, "r");
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expectedSize) fail("PROBE_UNAVAILABLE");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expectedSize) fail("PROBE_UNAVAILABLE");
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

/* ------------------------------------------------------------------ *
 * 严格入口（D9b）内部辅助：选项、证据草稿、投影、unknown 判定、封套。
 * 只写固定枚举/计数/时间偏移/布尔；不写路径、PID、argv、env、token、正文。
 * ------------------------------------------------------------------ */

function readGuardedOptions(options) {
  if (!isPlainObject(options)) fail("INVALID_REQUEST");
  for (const key of Object.keys(options)) {
    if (!GUARDED_OPTION_KEYS.has(key)) fail("INVALID_REQUEST");
  }
  const { signal, deadlineAtMs } = options;
  if (typeof deadlineAtMs !== "number" || !Number.isFinite(deadlineAtMs)) fail("INVALID_REQUEST");
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  ) {
    fail("INVALID_REQUEST");
  }
  return { signal, deadlineAtMs };
}

/** 证据草稿：形状固定、全部 JSON-safe；未知阶段用 null 表示“还没有事实”。 */
function createProbeEvidence() {
  const stream = () => ({
    state: "not-started",
    observedBytes: 0,
    final: false,
    retainedBytes: 0,
    limitBytes: null,
    truncated: false,
    available: "none",
  });
  return {
    schemaVersion: 1,
    operation: "probe",
    outcome: null,
    code: null,
    primaryCode: null,
    resourceUnknown: false,
    unknownResources: [],
    identity: null,
    timing: null,
    budget: {
      wallMs: GUARDED_SCOPE_WALL_MS,
      scopeDeadlineOffsetMs: null,
      probeDeadlineOffsetMs: null,
      releaseReserveMs: GUARDED_RELEASE_RESERVE_MS,
      releaseAtMs: null,
      adapterTotalMs: 0,
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
    stdio: { stdout: stream(), stderr: stream() },
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
    instance: { stateBefore: null, faultedAfter: null },
    handoff: { resourceUnknown: false, retainLeaseRequired: false, retryPolicy: "not-decided-by-probe" },
    parse: { state: "not-reached", code: null },
    lease: {
      scope: "probe",
      ownership: "probe-adapter",
      state: "not-acquired",
      reason: null,
      retainRequested: false,
      pendingAtExit: [],
    },
  };
}

// Concrete wire values, never arbitrary runner strings or whole nested objects.
const EVIDENCE_REASONS = new Set([
  "RESOURCE_UNKNOWN", "CALLER_ABORTED", "WALL_DEADLINE", "STDERR_LIMIT", "STDOUT_LIMIT",
  "RESOURCE_SIGNAL", "NONZERO_EXIT", "NO_SPAWN_BUDGET", "SPAWN_DEADLINE", "CLOSE_DEADLINE",
  "SPAWN_ERROR", "CLOSE_BEFORE_SPAWN", "GROUP_UNKNOWN", "CLEANUP_ERROR", "CLEANUP_DEADLINE",
  "NOT_APPLICABLE", "PENDING_SHARED", "PROBE_REENTRANT", "RELEASE_FAILED", "PROBE_RESOURCE_UNKNOWN",
  "INVALID_ENTRY", "INSUFFICIENT_BUDGET", "OUTPUT_REJECTED", "SUCCESS_GATE_INCOMPLETE",
  "PROBE_INTERNAL_FAILURE", "NO_RESULT", "EVIDENCE_INVALID", "LOCK_BUSY", "LOCK_UNKNOWN",
  "ACQUIRE_FAILED", "ACQUIRE_DEADLINE", "RELEASE_DEADLINE", "SCOPE_PENDING",
]);
const EVIDENCE_CODES = new Set([
  ...Object.values(PROBE_CODES), "EXECUTION_BUSY", "EXECUTION_UNAVAILABLE", "OUTPUT_LIMIT", "RESOURCE_LIMIT",
  "ENGINE_FAILED", "ENGINE_BUSY", "ENGINE_CANCELLED", "ENGINE_LOCK_FAILED",
]);
const enumValue = (...values) => value => values.includes(value) ? value : null;
const countValue = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const offsetValue = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const boolValue = value => typeof value === "boolean" ? value : null;
const digestValue = value => typeof value === "string" && SHA256_HEX.test(value) ? value : null;
const codeValue = value => EVIDENCE_CODES.has(value) ? value : null;
const pendingValue = value => Array.isArray(value) && value.length <= 16
  ? [...new Set(value.filter(v=>["ensure-audio-executor", "ensure-jobs", "mkdir-job", "owner-open", "owner-write", "owner-close", "mkdir-work", "mkdir-home", "mkdir-tmp"].includes(v)))] : [];
function fields(source, shape) {
  if (!isPlainObject(source)) return null;
  return Object.fromEntries(Object.entries(shape).map(([key,project])=>[key,project(source[key])]));
}
/** Field-by-field projection: no runner subtree is cloned into public evidence. */
function projectExecutorEvidence(ev, source, tool) {
  if (!isPlainObject(source) || source.operation !== "probe") return;
  const stream = value => fields(value, {state:enumValue("not-started","stream-error","settled","open"),observedBytes:countValue,final:boolValue,retainedBytes:countValue,limitBytes:countValue,truncated:boolValue,available:enumValue("buffer","none")});
  const shapes = {
    timing:{clock:enumValue("monotonic"),sourceDeadline:enumValue("caller","executor"),wallBudgetMs:offsetValue,hardDeadlineOffsetMs:offsetValue,allowanceMs:offsetValue,spawnAtMs:offsetValue,closeAtMs:offsetValue,groupConfirmedAtMs:offsetValue,cleanupFinishedAtMs:offsetValue,totalMs:offsetValue,budgetExhausted:boolValue},
    spawn:{state:enumValue("not-started","unknown","confirmed","failed"),reason:fixedEnum,confirmedAtMs:offsetValue},
    child:{state:enumValue("not-created","unknown","exited","signaled"),exitCode:value=>Number.isSafeInteger(value)&&value>=-2147483648&&value<=2147483647?value:null,signal:enumValue("SIGABRT","SIGALRM","SIGBUS","SIGFPE","SIGHUP","SIGILL","SIGINT","SIGKILL","SIGPIPE","SIGQUIT","SIGSEGV","SIGTERM","SIGTRAP","SIGUSR1","SIGUSR2","SIGXCPU","SIGXFSZ"),closeSettled:boolValue,pidObserved:boolValue,streamError:boolValue},
    stdio:{stdout:value=>stream(value)||ev.stdio.stdout,stderr:value=>stream(value)||ev.stdio.stderr},
    group:{state:enumValue("not-created","unknown","reclaimed"),confirmedBy:enumValue("none","main","finally"),observation:enumValue("none","kill0","kill0+pgrep"),membersObserved:countValue,finalConfirm:enumValue("not-run","error","empty","timeout"),failureSource:enumValue("main-leftover","finally-leftover","finally-error"),escapedDescendants:enumValue("not-observable")},
    directory:{state:enumValue("not-created","created","removed","retained","unknown"),marker:enumValue("not-written","written","unknown"),cleanupRan:boolValue,removalAttempted:boolValue,removalSettled:boolValue,postcondition:enumValue("not-checked","absent","present","unknown"),pendingOps:pendingValue,reason:fixedEnum},
    instance:{stateBefore:enumValue("ready","busy","faulted"),faultedAfter:boolValue},
  };
  for (const [key,shape] of Object.entries(shapes)) {
    const value=fields(source[key],shape);if(value) ev[key]=value;
  }
  if (isPlainObject(source.identity) && source.identity.kind === "probe-tool" && source.identity.toolPinSource === "configured") {
    ev.identity=fields(source.identity,{kind:enumValue("probe-tool"),toolPinSource:enumValue("configured"),matched:boolValue,toolSha256:digestValue,snapshotSha256:digestValue,snapshotBytes:countValue,snapshotDigestSource:enumValue("declared")});
    ev.identity.version=typeof tool.version === "string" && VERSION_TEXT.test(tool.version) ? tool.version : null;
  }
  if (Array.isArray(source.unknownResources) && source.unknownResources.length <= 32) ev.unknownResources=UNKNOWN_RESOURCE_ORDER.filter(v=>source.unknownResources.includes(v));
  ev.primaryCode=codeValue(source.code);
}

/** unknown 只认显式证据：不按错误文案、ENOENT 或进程存活推测。 */
function executorResourcesUnknown(source) {
  if (!isPlainObject(source)) return false;
  if (source.resourceUnknown === true) return true;
  if (source.spawn?.state === "confirmed" && source.child?.closeSettled === false) return true;
  if (source.group?.state === "unknown") return true;
  if (source.directory?.state === "retained" || source.directory?.state === "unknown") return true;
  return false;
}

function executorFailure(error, source) {
  const raw = codeValue(error?.code);
  const code =
    raw === "CANCELLED"
      ? "CANCELLED"
      : raw === "TIMEOUT"
        ? "TIMEOUT"
        : raw === "EXECUTION_BUSY"
          ? "PROBE_BUSY"
          : "PROBE_UNAVAILABLE";
  const stageRaw = source?.failure?.stage;
  const stage = FAILURE_STAGES.has(stageRaw) ? stageRaw : "run";
  // F2：reason 只允许固定枚举样式；不把任意字符串（可能是路径）写进证据。
  const reason = fixedEnum(source?.failure?.reason) ?? fixedEnum(error?.evidence?.reason);
  return { code, stage, reason, primaryCode: raw, overriddenBy: null };
}

/** engine 错误只读固定字段；ownerToken/pending 原文一律不复制。 */
function readEngineScopeFailure(error) {
  const code = codeValue(error?.code);
  const source = isPlainObject(error?.evidence) ? error.evidence : null;
  const reason = fixedEnum(source?.reason);
  return {
    code,
    reason,
    releasePending: source?.scopeRelease === "pending",
    acquireUnknown: source?.scopeAcquire === "unknown",
  };
}

/** 固定原因集合；形似枚举的未知字串同样不得进入证据。 */
function fixedEnum(value) {
  return EVIDENCE_REASONS.has(value) ? value : null;
}

/** executor 成功门里的资源事实（adapter 自复核，不依赖 runner 自报 outcome）。 */
function probeResourceFactsOk(ev) {
  return (
    ev.spawn.state === "confirmed" &&
    ev.child.closeSettled === true &&
    ev.stdio.stdout.final === true &&
    ev.group.state === "reclaimed" &&
    ev.directory.state === "removed"
  );
}

/** 严格入口的成功还要求工具身份确实来自 pinned 配置且已匹配。 */
function probeIdentityOk(ev) {
  return (
    ev.identity !== null &&
    ev.identity.toolPinSource === "configured" &&
    ev.identity.matched === true &&
    typeof ev.identity.toolSha256 === "string"
  );
}

function collectUnknownResources(ev) {
  const found = new Set(Array.isArray(ev.unknownResources) ? ev.unknownResources : []);
  if (ev.lease.state === "held" || ev.lease.state === "unknown") found.add("lease");
  return UNKNOWN_RESOURCE_ORDER.filter((item) => found.has(item));
}

/** 收口：写最终结论、算 unknown、封套（≤9KiB，超限退回固定最小证据）。 */
function fillProbeEvidence(ev, st, { outcome, code, stage, reason, primaryCode, overriddenBy }) {
  ev.outcome = outcome;
  ev.code = codeValue(code);
  ev.primaryCode = codeValue(primaryCode);
  ev.unknownResources = collectUnknownResources(ev);
  ev.resourceUnknown = ev.unknownResources.length > 0 || st.unknown === true;
  if (outcome === "success") {
    ev.failure = null;
  } else {
    ev.failure = {
      stage: FAILURE_STAGES.has(stage) ? stage : "finalize",
      reason: fixedEnum(reason),
      primaryCode: codeValue(primaryCode),
      finalCode: codeValue(code),
      overriddenBy: ["parse","cleanup","lease"].includes(overriddenBy) ? overriddenBy : null,
    };
  }
  ev.handoff = {
    resourceUnknown: ev.resourceUnknown,
    retainLeaseRequired: ["held", "unknown"].includes(ev.lease.state),
    retryPolicy: "not-decided-by-probe",
  };
  ev.budget.adapterTotalMs = roundMs(performance.now() - st.startedAt);
  return sealProbeEvidence(ev);
}

function guardedError(evidence) {
  const error = new AudioProbeError(evidence.code || "PROBE_UNAVAILABLE");
  error.probeEvidence = evidence;
  if (evidence.resourceUnknown === true) {
    error.evidence = Object.freeze({
      resourceUnknown: true,
      reason: typeof evidence.lease.reason === "string" ? evidence.lease.reason : "RESOURCE_UNKNOWN",
    });
  }
  return error;
}

/** 封套：JSON-safe + ≤9KiB；超限时退回固定最小证据，绝不截断字段或回退原对象。 */
function sealProbeEvidence(ev) {
  let json = null;
  try {
    json = JSON.stringify(ev);
  } catch {
    json = null;
  }
  if (json === null || Buffer.byteLength(json, "utf8") > PROBE_EVIDENCE_MAX_BYTES) {
    return deepFreeze(minimalProbeEvidence(ev));
  }
  return deepFreeze(ev);
}

/**
 * 无效或超限时的固定最小封套：只保留结论、失败、租约与预算事实，
 * 强制失败，但保留实际资源及租约结算事实，不凭证据无效编造资源 unknown。
 * 不重建 20 字段形状，避免与主草稿悄悄漂移。
 */
function minimalProbeEvidence(ev) {
  return {
    schemaVersion: 1, operation: "probe", outcome: "failure", code: "PROBE_UNAVAILABLE",
    primaryCode: codeValue(ev.primaryCode), resourceUnknown: ev.resourceUnknown,
    unknownResources: collectUnknownResources(ev),
    failure: {stage:"finalize",reason:"EVIDENCE_INVALID",primaryCode:codeValue(ev.primaryCode),finalCode:"PROBE_UNAVAILABLE",overriddenBy:null},
    handoff: {resourceUnknown:ev.resourceUnknown,retainLeaseRequired:["held","unknown"].includes(ev.lease.state),retryPolicy:"not-decided-by-probe"},
    parse: ev.parse, lease: ev.lease, budget: ev.budget,
  };
}

function roundMs(value) {
  return Math.round(value * 1000) / 1000;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}
