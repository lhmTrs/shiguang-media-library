import { performance } from "node:perf_hooks";

/**
 * T13I-PROTOCOL-HARNESS-20261024：注入式协议 harness 的纯合同层。
 *
 * 本文件不读文件、不启动进程、不访问网络，只固化当前产品源码已经公开的
 * 协议边界：
 *   - server/audio-executor.mjs：30s 单入口 wall、180s 绝对上限、64MiB FSIZE、
 *     CPU 180s、NOFILE 256，入口 deadline 取 min(调用方 deadline, entry+wall)；
 *   - server/audio-engine.mjs：descriptor 的 version/binarySha256/generation/
 *     binarySize/binaryPath/platform/arch，运行前后均需匹配；
 *   - server/audio-probe.mjs：工具 path 必须为绝对路径，sha256 必须 64 位非零；
 *   - server/audio-result.mjs：brief-v1 raw→normalized、warnings、duration、
 *     provenance/identity。
 *
 * 这里不复制产品实现；normalize 直接调用产品导出。剩余字段合同在注入边界上
 * 做可执行检查，并明确“合成证据”与“真实 OS 证据”的区别。
 */

export const PROTOCOL_LIMITS = Object.freeze({
  /** audio-executor.mjs MAX_WALL_MS：单入口硬上限。 */
  absoluteWallMs: 180_000,
  /** audio-engine/current T13I 单任务 wall；不追加 term/confirm allowance。 */
  executorWallMs: 30_000,
  /** audio-probe.mjs PROBE_WALL_MS：probe 独立上限。 */
  probeWallMs: 10_000,
  /** launcher FSIZE=64MiB（audio-executor-launcher.c）。 */
  fsizeBytes: 64 * 1024 * 1024,
  /** launcher RLIMIT_CPU=180s。 */
  cpuSeconds: 180,
  /** launcher RLIMIT_NOFILE=256。 */
  nofile: 256,
  /** 每流 stdout/stderr 上限；合计 128KiB。 */
  stdoutBytes: 64 * 1024,
  stderrBytes: 64 * 1024,
  rawResultBytes: 64 * 1024,
  /** 旧“整个 dataDir”预算，保留事实但未获批准，不能改写成 job-only 或新上限。 */
  legacyDataDirBudgetBytes: 256 * 1024 * 1024,
  legacyDataDirBudgetApproved: false,
});

export const HARNESS_CODES = Object.freeze({
  OK: "OK",
  UNAUTHORIZED_REAL_EXECUTION: "UNAUTHORIZED_REAL_EXECUTION",
  INSTALL_NOT_AUTHORIZED: "INSTALL_NOT_AUTHORIZED",
  ADAPTER_NOT_FAKE: "ADAPTER_NOT_FAKE",
  INVALID_REQUEST: "INVALID_REQUEST",
  CLOCK_REGRESSION: "CLOCK_REGRESSION",
  PROBE_IDENTITY_MISMATCH: "PROBE_IDENTITY_MISMATCH",
  PROBE_FAILED: "PROBE_FAILED",
  PROBE_TIMEOUT: "PROBE_TIMEOUT",
  IDENTITY_MISMATCH: "IDENTITY_MISMATCH",
  TIMEOUT: "TIMEOUT",
  ENGINE_FAILED: "ENGINE_FAILED",
  OUTPUT_LIMIT: "OUTPUT_LIMIT",
  RESOURCE_LIMIT: "RESOURCE_LIMIT",
  CANCELLED: "CANCELLED",
  INVALID_OUTPUT: "INVALID_OUTPUT",
  POSTCONDITION_FAILED: "POSTCONDITION_FAILED",
  CLEANUP_FAILED: "CLEANUP_FAILED",
  CLEANUP_TIMEOUT: "CLEANUP_TIMEOUT",
  LEASE_RELEASE_FAILED: "LEASE_RELEASE_FAILED",
  HARNESS_FAILED: "HARNESS_FAILED",
});

const CODE_SET = new Set(Object.values(HARNESS_CODES));
const SHA256_HEX = /^[0-9a-f]{64}$/;
const GENERATION_HEX = /^[0-9a-f]{32,64}$/;
const VERSION_TEXT = /^[A-Za-z0-9._+-]{1,128}$/;
const PROBE_VERSION_TEXT = /^[\x20-\x7e]{1,160}$/;
const ZERO_SHA256 = "0".repeat(64);

/** 固定码错误；message 不含输入片段/路径/stderr。 */
export function harnessError(code, detail) {
  const safeCode = CODE_SET.has(code) ? code : HARNESS_CODES.HARNESS_FAILED;
  const error = new Error(`t13i protocol harness: ${safeCode}`);
  error.name = "T13iHarnessError";
  error.code = safeCode;
  if (typeof detail === "string" && detail.length > 0 && detail.length <= 200) {
    error.detail = detail;
  }
  return error;
}

export function isHarnessCode(code) {
  return CODE_SET.has(code);
}

/** 只读自有 data descriptor，拒绝访问器与 Proxy 反射异常。 */
export function readOwnData(value, fields) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    const out = Object.create(null);
    for (const key of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return null;
      out[key] = descriptor.value;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * descriptor 身份合同。返回只含 allowlist 字段的冻结快照，不保留 binaryPath。
 * expected 只比较其自身提供的纯数据字段。
 */
export function validateDescriptor(raw, expected) {
  const d = readOwnData(raw, [
    "version",
    "binarySha256",
    "binarySize",
    "generation",
    "binaryPath",
    "platform",
    "arch",
  ]);
  if (!d) throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "descriptor_shape");
  if (typeof d.version !== "string" || !VERSION_TEXT.test(d.version)) {
    throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "version");
  }
  if (typeof d.binarySha256 !== "string" || !SHA256_HEX.test(d.binarySha256) || d.binarySha256 === ZERO_SHA256) {
    throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "binary_sha256_nonzero");
  }
  if (!Number.isSafeInteger(d.binarySize) || d.binarySize <= 0) {
    throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "binary_size");
  }
  if (typeof d.generation !== "string" || !GENERATION_HEX.test(d.generation) || /^0+$/.test(d.generation)) {
    throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "generation_nonzero");
  }
  if (typeof d.binaryPath !== "string" || !d.binaryPath.startsWith("/")) {
    throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "binary_path_absolute");
  }
  if (typeof d.platform !== "string" || d.platform.length === 0) {
    throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "platform");
  }
  if (typeof d.arch !== "string" || d.arch.length === 0) {
    throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "arch");
  }

  if (expected !== undefined) {
    const e = readOwnData(expected, [
      "version",
      "binarySha256",
      "binarySize",
      "generation",
      "binaryPath",
      "platform",
      "arch",
    ]);
    if (!e) throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, "expected_shape");
    for (const key of Object.keys(e)) {
      if (d[key] !== e[key]) throw harnessError(HARNESS_CODES.IDENTITY_MISMATCH, `expected_${key}`);
    }
  }

  return Object.freeze({
    version: d.version,
    binarySha256: d.binarySha256,
    binarySize: d.binarySize,
    generation: d.generation,
    platform: d.platform,
    arch: d.arch,
    binaryPathPresent: true,
  });
}

/** ffprobe 工具身份合同：绝对路径、64 位非零摘要、expectedSha256 必须匹配。 */
export function validateProbeTool(raw) {
  const t = readOwnData(raw, ["path", "sha256", "version", "expectedSha256"]);
  if (!t) throw harnessError(HARNESS_CODES.PROBE_IDENTITY_MISMATCH, "tool_shape");
  if (typeof t.path !== "string" || !t.path.startsWith("/")) {
    throw harnessError(HARNESS_CODES.PROBE_IDENTITY_MISMATCH, "tool_path_absolute");
  }
  if (typeof t.sha256 !== "string" || !SHA256_HEX.test(t.sha256) || t.sha256 === ZERO_SHA256) {
    throw harnessError(HARNESS_CODES.PROBE_IDENTITY_MISMATCH, "tool_sha256_nonzero");
  }
  if (typeof t.version !== "string" || !PROBE_VERSION_TEXT.test(t.version)) {
    throw harnessError(HARNESS_CODES.PROBE_IDENTITY_MISMATCH, "tool_version");
  }
  if (
    typeof t.expectedSha256 !== "string" ||
    !SHA256_HEX.test(t.expectedSha256) ||
    t.expectedSha256 === ZERO_SHA256
  ) {
    throw harnessError(HARNESS_CODES.PROBE_IDENTITY_MISMATCH, "expected_sha256_shape");
  }
  if (t.sha256 !== t.expectedSha256) {
    throw harnessError(HARNESS_CODES.PROBE_IDENTITY_MISMATCH, "expected_sha256_mismatch");
  }
  return Object.freeze({ sha256: t.sha256, version: t.version });
}

/**
 * 入口 deadline：min(调用方 deadline, entry+30s)，不追加 term grace / 组确认 /
 * 清理 allowance，也不声称 OS 硬实时。requested 缺省时直接用 30s。
 */
export function computeExecutorDeadline(entryAt, requestedDeadlineAtMs) {
  if (!Number.isFinite(entryAt)) throw harnessError(HARNESS_CODES.INVALID_REQUEST, "entry_clock");
  const cap = entryAt + PROTOCOL_LIMITS.executorWallMs;
  if (requestedDeadlineAtMs === undefined) return cap;
  if (!Number.isFinite(requestedDeadlineAtMs)) {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, "deadline_clock");
  }
  return Math.min(requestedDeadlineAtMs, cap);
}

function pickNumbers(value, fields) {
  const out = Object.create(null);
  for (const key of fields) {
    const v = value[key];
    out[key] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}

/** 只取 postcondition allowlist 字段；额外字段（可能含 raw stderr/路径）一律丢弃。 */
export function pickPostconditions(raw) {
  const p = readOwnData(raw, ["exit", "job", "processGroup", "stdio", "dispose"]);
  if (!p) return null;
  const exit = readOwnData(p.exit, ["confirmed", "code", "signal"]);
  const job = readOwnData(p.job, ["state", "dirRemoved", "ownerRemoved"]);
  const group = readOwnData(p.processGroup, ["own", "groupGone", "unknownDescendants"]);
  const stdio = readOwnData(p.stdio, ["closed", "stdoutBytes", "stderrBytes"]);
  const dispose = readOwnData(p.dispose, ["called", "calls", "pending"]);
  if (!exit || !job || !group || !stdio || !dispose) return null;
  return Object.freeze({
    exit: Object.freeze({
      confirmed: exit.confirmed === true,
      code: Number.isSafeInteger(exit.code) ? exit.code : null,
      signal: typeof exit.signal === "string" ? exit.signal : null,
    }),
    job: Object.freeze({
      state: typeof job.state === "string" ? job.state : "unknown",
      dirRemoved: job.dirRemoved === true,
      ownerRemoved: job.ownerRemoved === true,
    }),
    processGroup: Object.freeze({
      own: group.own === true,
      groupGone: group.groupGone === true,
      unknownDescendants: group.unknownDescendants === "not_scanned" ? "not_scanned" : "declared_none",
    }),
    stdio: Object.freeze({
      closed: stdio.closed === true,
      ...pickNumbers(stdio, ["stdoutBytes", "stderrBytes"]),
    }),
    dispose: Object.freeze({
      called: dispose.called === true,
      calls: Number.isSafeInteger(dispose.calls) && dispose.calls >= 0 ? dispose.calls : 0,
      pending: dispose.pending === true,
    }),
  });
}

/**
 * 可执行后置断言：
 *   - 任何路径都必须 dispose called、job/owner 清理、stdio closed、dispose 不 pending；
 *   - 成功路径还必须 exit 已确认、自有进程组已消失；
 *   - failure 不伪造 groupGone，未确认时由上层标 resourceUnknown。
 */
export function evaluatePostconditions(post, { success } = {}) {
  const failures = [];
  if (!post) {
    return Object.freeze({ ok: false, failures: Object.freeze(["postcondition_missing"]) });
  }
  if (!post.dispose.called) failures.push("dispose_not_called");
  if (post.dispose.pending) failures.push("dispose_pending");
  if (!post.job.dirRemoved) failures.push("job_dir_not_removed");
  if (!post.job.ownerRemoved) failures.push("job_owner_not_removed");
  if (!post.stdio.closed) failures.push("stdio_not_closed");
  if (!(post.stdio.stdoutBytes <= PROTOCOL_LIMITS.stdoutBytes)) failures.push("stdout_over_budget");
  if (!(post.stdio.stderrBytes <= PROTOCOL_LIMITS.stderrBytes)) failures.push("stderr_over_budget");
  if (success) {
    if (!post.exit.confirmed) failures.push("exit_not_confirmed");
    if (!post.processGroup.own) failures.push("process_group_not_owned");
    if (!post.processGroup.groupGone) failures.push("process_group_not_gone");
  }
  return Object.freeze({
    scope: success ? "success" : "failure",
    ok: failures.length === 0,
    failures: Object.freeze(failures),
  });
}

export function resourceUnknownFromPostconditions(post) {
  if (!post) return true;
  return post.exit.confirmed !== true || post.processGroup.groupGone !== true || post.dispose.pending === true;
}

/** 单调时钟；回归直接固定失败，避免负时长被当成预算剩余。 */
export function createMonotonicClock(now = () => performance.now()) {
  let last = Number.NEGATIVE_INFINITY;
  return Object.freeze({
    now() {
      const value = now();
      if (!Number.isFinite(value)) throw harnessError(HARNESS_CODES.INVALID_REQUEST, "clock_nonfinite");
      if (value < last) throw harnessError(HARNESS_CODES.CLOCK_REGRESSION, "clock_regression");
      last = value;
      return value;
    },
  });
}
