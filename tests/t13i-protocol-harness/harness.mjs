/**
 * T13I-PROTOCOL-HARNESS-20261024：可调用注入式协议 harness。
 *
 * 唯一入口 runProtocolHarness(scenario, adapters)：
 *   1. 先过 fail-closed gate（真实执行/安装/预算改写一律在副作用前拒绝）；
 *   2. 只接受本仓库 fakes.mjs 构造的假 lease/executor/probe；
 *   3. 在全新临时目录写本次合成 snapshot；
 *   4. 按 probe → 未执行 install → lease → descriptor 身份 → execute →
 *      brief-v1 normalize → 退出/job/进程组/dispose 后置断言的顺序走完整路径；
 *   5. 无论成功失败都尝试 dispose、释放 lease、删除临时目录并记录单调计时。
 *
 * 本文件不 import audio-engine/audio-executor/audio-probe，不 spawn，不读真实素材，
 * 不访问网络。raw stderr/exit 当前产品 API 不暴露，harness 明确停在注入边界。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { PROTOCOL, normalizeAudioResult } from "../../server/audio-result.mjs";
import {
  HARNESS_CODES,
  PROTOCOL_LIMITS,
  computeExecutorDeadline,
  createMonotonicClock,
  evaluatePostconditions,
  harnessError,
  isHarnessCode,
  pickPostconditions,
  readOwnData,
  resourceUnknownFromPostconditions,
  validateDescriptor,
  validateProbeTool,
} from "./contracts.mjs";
import { isFakeAdapter } from "./fakes.mjs";

const EXPIRED = Symbol("t13i.harness.deadlineExpired");
const DEFAULT_SYNTHETIC = Buffer.from("synthetic-audio-bytes-for-t13i-protocol-harness", "utf8");
const SCENARIO_KEYS = new Set([
  "name",
  "mode",
  "kind",
  "syntheticBytes",
  "probeTool",
  "descriptor",
  "expectedDescriptor",
  "raw",
  "deadlineAfterMs",
  "outerDeadlineMs",
  "cleanupTimeoutMs",
  "probeTimeoutMs",
  "install",
  "realExecution",
  "observedDataDirBytes",
]);

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function roundMs(value) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function safeDetail(error) {
  if (error && typeof error.detail === "string" && /^[A-Za-z0-9_+]+$/.test(error.detail)) {
    return error.detail;
  }
  return null;
}

function mapCode(error, fallback = HARNESS_CODES.HARNESS_FAILED) {
  if (error && typeof error.code === "string" && isHarnessCode(error.code)) return error.code;
  return fallback;
}

function mapAdapterError(error, fallback) {
  if (error && typeof error.code === "string" && isHarnessCode(error.code)) return error;
  return harnessError(fallback, fallback === HARNESS_CODES.PROBE_FAILED ? "probe_adapter" : "executor_adapter");
}

/** 真实执行/安装/预算改写 gate：全部在任何 adapter 方法或文件写入之前。 */
export function assessGate(scenario) {
  if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "scenario_shape" });
  }
  if (scenario.mode !== "injected") {
    return Object.freeze({ code: HARNESS_CODES.UNAUTHORIZED_REAL_EXECUTION, detail: "mode_not_injected" });
  }
  if (
    scenario.realExecution === true ||
    scenario.realEngine === true ||
    scenario.engine !== undefined ||
    scenario.executorPath !== undefined
  ) {
    return Object.freeze({ code: HARNESS_CODES.UNAUTHORIZED_REAL_EXECUTION, detail: "real_execution_requested" });
  }
  for (const key of ["dataDirBudgetBytes", "jobOnlyBudgetBytes", "budgetOverride", "limits"]) {
    if (Object.prototype.hasOwnProperty.call(scenario, key)) {
      return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: `budget_override_${key}` });
    }
  }
  if (scenario.install !== undefined) {
    const install = scenario.install;
    if (install === null || typeof install !== "object" || Array.isArray(install)) {
      return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "install_shape" });
    }
    let requested;
    let execute;
    let installMode;
    try {
      requested = install.requested;
      execute = install.execute;
      installMode = install.mode;
    } catch {
      return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "install_shape" });
    }
    if (requested === true || execute === true || installMode === "real") {
      return Object.freeze({ code: HARNESS_CODES.INSTALL_NOT_AUTHORIZED, detail: "install_must_not_run" });
    }
  }
  return null;
}

function validateScenario(scenario) {
  let keys;
  try {
    keys = Object.keys(scenario);
  } catch {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "scenario_keys" });
  }
  for (const key of keys) {
    if (!SCENARIO_KEYS.has(key)) {
      return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: `unknown_${key}` });
    }
  }
  if (typeof scenario.name !== "string" || scenario.name.length === 0 || scenario.name.length > 80) {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "scenario_name" });
  }
  if (scenario.kind !== undefined && scenario.kind !== "music" && scenario.kind !== "sfx") {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "scenario_kind" });
  }
  const bytes = scenario.syntheticBytes;
  if (bytes !== undefined) {
    const size = Buffer.isBuffer(bytes) ? bytes.length : typeof bytes === "string" ? Buffer.byteLength(bytes) : -1;
    if (!(size > 0 && size <= 1024 * 1024)) {
      return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "synthetic_bytes" });
    }
  }
  if (!scenario.probeTool || typeof scenario.probeTool !== "object") {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "probe_tool" });
  }
  if (!scenario.descriptor || typeof scenario.descriptor !== "object") {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "descriptor" });
  }
  for (const key of ["deadlineAfterMs", "outerDeadlineMs", "cleanupTimeoutMs", "probeTimeoutMs", "observedDataDirBytes"]) {
    if (scenario[key] !== undefined && (!Number.isFinite(scenario[key]) || scenario[key] < 0)) {
      return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: `numeric_${key}` });
    }
  }
  if (scenario.deadlineAfterMs !== undefined && scenario.deadlineAfterMs <= 0) {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "deadline_positive" });
  }
  if (scenario.cleanupTimeoutMs !== undefined && (scenario.cleanupTimeoutMs <= 0 || scenario.cleanupTimeoutMs > 5000)) {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "cleanup_timeout_bound" });
  }
  if (scenario.outerDeadlineMs !== undefined && scenario.outerDeadlineMs <= 0) {
    return Object.freeze({ code: HARNESS_CODES.INVALID_REQUEST, detail: "outer_deadline_positive" });
  }
  return null;
}

function validateAdapters(adapters) {
  if (!adapters || typeof adapters !== "object" || Array.isArray(adapters)) {
    return Object.freeze({ code: HARNESS_CODES.ADAPTER_NOT_FAKE, detail: "adapters_shape" });
  }
  const { lease, executor, probe } = adapters;
  if (!isFakeAdapter(lease, "lease") || !isFakeAdapter(executor, "executor") || !isFakeAdapter(probe, "probe")) {
    return Object.freeze({ code: HARNESS_CODES.ADAPTER_NOT_FAKE, detail: "only_fakes_accepted" });
  }
  if (
    typeof lease.withRunLease !== "function" ||
    typeof lease.postcondition !== "function" ||
    typeof executor.execute !== "function" ||
    typeof executor.dispose !== "function" ||
    typeof executor.postcondition !== "function" ||
    typeof probe.probe !== "function" ||
    typeof probe.postcondition !== "function"
  ) {
    return Object.freeze({ code: HARNESS_CODES.ADAPTER_NOT_FAKE, detail: "adapter_methods" });
  }
  return null;
}

function baseBudget(scenario) {
  return Object.freeze({
    legacyDataDirBudgetBytes: PROTOCOL_LIMITS.legacyDataDirBudgetBytes,
    legacyDataDirBudgetApproved: PROTOCOL_LIMITS.legacyDataDirBudgetApproved,
    observedDataDirBytes: Number.isFinite(scenario?.observedDataDirBytes) ? scenario.observedDataDirBytes : 0,
    decision: "LEGACY_BUDGET_NOT_APPROVED",
    note: "No job-only or new upper limit accepted; real execution remains fail-closed.",
  });
}

function refusalResult(scenario, gate) {
  return Object.freeze({
    ok: false,
    code: gate.code,
    detail: gate.detail ?? null,
    scenario: typeof scenario?.name === "string" ? scenario.name : null,
    mode: typeof scenario?.mode === "string" ? scenario.mode : null,
    gate: Object.freeze({
      mode: "injected",
      realExecution: "refused_before_side_effects",
      install: "not_executed",
      envBackdoor: false,
    }),
    limits: PROTOCOL_LIMITS,
    budget: baseBudget(scenario),
    sideEffects: Object.freeze({
      tempDirCreated: false,
      fileWrites: 0,
      adapterMethodsCalled: 0,
      engineCalls: 0,
      networkCalls: 0,
    }),
    rawEvidence: Object.freeze({
      available: false,
      reason: "CURRENT_API_EXPOSES_NO_RAW_STDERR_OR_EXIT_STATUS",
      rawStderr: "not_requested",
      exitCode: "not_read",
    }),
    timing: null,
    identity: null,
    output: null,
    postconditions: null,
    cleanup: null,
    adapterCalls: null,
  });
}

async function settleWithin(workFactory, deadlineAtMs, clock, onExpire) {
  const remaining = deadlineAtMs - clock.now();
  if (!(remaining > 0)) {
    if (onExpire) await onExpire();
    return Object.freeze({ expired: true });
  }
  let timer = null;
  const expiration = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), Math.max(1, remaining));
  });
  const work = Promise.resolve()
    .then(workFactory)
    .then((value) => ({ value }), (error) => ({ error }));
  const outcome = await Promise.race([work, expiration]);
  if (timer !== null) clearTimeout(timer);
  if (outcome === EXPIRED) {
    if (onExpire) await onExpire();
    return Object.freeze({ expired: true });
  }
  return outcome;
}

function validateProbeResult(raw) {
  const p = readOwnData(raw, ["durationSec", "channels", "sampleRate", "totalSamples", "format"]);
  if (!p) throw harnessError(HARNESS_CODES.PROBE_FAILED, "probe_shape");
  if (!Number.isFinite(p.durationSec) || p.durationSec < 0 || p.durationSec > 600) {
    throw harnessError(HARNESS_CODES.PROBE_FAILED, "probe_duration");
  }
  if (!Number.isSafeInteger(p.channels) || p.channels <= 0) {
    throw harnessError(HARNESS_CODES.PROBE_FAILED, "probe_channels");
  }
  if (!Number.isSafeInteger(p.sampleRate) || p.sampleRate <= 0) {
    throw harnessError(HARNESS_CODES.PROBE_FAILED, "probe_sample_rate");
  }
  if (!Number.isSafeInteger(p.totalSamples) || p.totalSamples < 0) {
    throw harnessError(HARNESS_CODES.PROBE_FAILED, "probe_total_samples");
  }
  if (typeof p.format !== "string" || p.format.length === 0) {
    throw harnessError(HARNESS_CODES.PROBE_FAILED, "probe_format");
  }
  return Object.freeze({
    durationSec: p.durationSec,
    channels: p.channels,
    sampleRate: p.sampleRate,
    totalSamples: p.totalSamples,
    format: p.format,
  });
}

function buildContext(scenario, snapshot, probe, descriptor) {
  return Object.freeze({
    kind: scenario.kind ?? "music",
    sourceSha256: snapshot.sha256,
    sourceSize: snapshot.bytes,
    durationSec: probe.durationSec,
    engineVersion: descriptor.version,
    engineBinarySha256: descriptor.binarySha256,
    engineGeneration: descriptor.generation,
    parameters: Object.freeze({ brief: true }),
  });
}

function safeOutput(normalized) {
  if (!normalized || normalized.ok !== true) return null;
  return Object.freeze({
    ok: true,
    schemaVersion: normalized.schemaVersion,
    protocol: normalized.protocol,
    warnings: Object.freeze([...normalized.warnings]),
    durationSec: normalized.provenance.durationSec,
    provenance: normalized.provenance,
    fingerprint: normalized.fingerprint,
  });
}

/**
 * 运行一个注入式场景。预期失败也返回结构化结果，不向调用方抛原始 message。
 *
 * @param {object} scenario
 * @param {{lease:object,executor:object,probe:object}} adapters
 * @param {{clock?:{now:Function}}} [options]
 */
export async function runProtocolHarness(scenario, adapters, options = {}) {
  const gate = assessGate(scenario);
  if (gate) return refusalResult(scenario, gate);
  const scenarioProblem = validateScenario(scenario);
  if (scenarioProblem) return refusalResult(scenario, scenarioProblem);
  const adapterProblem = validateAdapters(adapters);
  if (adapterProblem) return refusalResult(scenario, adapterProblem);

  const clock = options.clock ?? createMonotonicClock();
  const entryAt = clock.now();
  const controller = new AbortController();
  const timing = {
    entryAt,
    installMs: 0,
    probeMs: 0,
    leaseAcquireMs: 0,
    leaseHoldMs: 0,
    executeMs: 0,
    normalizeMs: 0,
    disposeMs: 0,
    cleanupMs: 0,
    totalMs: 0,
  };
  const result = {
    ok: false,
    code: null,
    detail: null,
    scenario: scenario.name,
    mode: "injected",
    gate: Object.freeze({
      mode: "injected",
      realExecution: "refused_by_design",
      install: "not_executed",
      envBackdoor: false,
    }),
    limits: PROTOCOL_LIMITS,
    budget: baseBudget(scenario),
    sideEffects: {
      tempDirCreated: false,
      fileWrites: 0,
      adapterMethodsCalled: 0,
      engineCalls: 0,
      networkCalls: 0,
    },
    timing: null,
    identity: null,
    output: null,
    postconditions: null,
    cleanup: null,
    adapterCalls: null,
    rawEvidence: Object.freeze({
      available: false,
      reason: "CURRENT_API_EXPOSES_NO_RAW_STDERR_OR_EXIT_STATUS",
      rawStderr: "not_requested",
      exitCode: "adapter_postcondition_only",
    }),
  };

  let root = null;
  let descriptor = null;
  let probe = null;
  let normalized = null;
  let post = null;
  let raw = null;
  let code = null;
  let detail = null;
  let executeBudgetMs = null;
  let executeCalls = 0;
  let installCallsBefore = 0;
  let installCallsAfter = 0;
  let disposePromise = null;
  let cleanupSecondaryCode = null;
  const cleanupTimeoutMs = Math.min(scenario.cleanupTimeoutMs ?? 2000, 5000);

  const beginDispose = () => {
    if (!disposePromise) {
      disposePromise = Promise.resolve().then(() => adapters.executor.dispose());
    }
    return disposePromise;
  };

  const boundedDispose = async () => {
    const start = clock.now();
    const outcome = await settleWithin(() => beginDispose(), start + cleanupTimeoutMs, clock, null);
    timing.disposeMs = Math.max(timing.disposeMs, roundMs(clock.now() - start));
    if (outcome.expired) throw harnessError(HARNESS_CODES.CLEANUP_TIMEOUT, "dispose_deadline");
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };

  try {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-protocol-harness-")));
    result.sideEffects.tempDirCreated = true;
    const bytes = Buffer.isBuffer(scenario.syntheticBytes)
      ? Buffer.from(scenario.syntheticBytes)
      : scenario.syntheticBytes === undefined
        ? Buffer.from(DEFAULT_SYNTHETIC)
        : Buffer.from(scenario.syntheticBytes, "utf8");
    const snapshotFile = path.join(root, "source.bin");
    await fs.writeFile(snapshotFile, bytes, { mode: 0o600 });
    await fs.chmod(snapshotFile, 0o600);
    result.sideEffects.fileWrites += 1;
    const snapshot = Object.freeze({
      filePath: snapshotFile,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    result.source = Object.freeze({ bytes: snapshot.bytes, sha256: snapshot.sha256 });

    const tool = validateProbeTool(scenario.probeTool);
    result.identity = {
      probeTool: Object.freeze({ sha256: tool.sha256, version: tool.version }),
      descriptor: null,
    };

    const outerDeadline = entryAt + Math.min(scenario.outerDeadlineMs ?? 5000, PROTOCOL_LIMITS.absoluteWallMs);

    const probeStart = clock.now();
    const probeDeadline = Math.min(
      probeStart + Math.min(scenario.probeTimeoutMs ?? PROTOCOL_LIMITS.probeWallMs, PROTOCOL_LIMITS.probeWallMs),
      outerDeadline,
    );
    const probeOutcome = await settleWithin(
      () => adapters.probe.probe(snapshot, { signal: controller.signal }),
      probeDeadline,
      clock,
      () => controller.abort(),
    );
    timing.probeMs = roundMs(clock.now() - probeStart);
    if (probeOutcome.expired) throw harnessError(HARNESS_CODES.PROBE_TIMEOUT, "probe_deadline");
    if (probeOutcome.error) throw mapAdapterError(probeOutcome.error, HARNESS_CODES.PROBE_FAILED);
    probe = validateProbeResult(probeOutcome.value);

    const installBefore = adapters.lease.postcondition();
    installCallsBefore = Number.isSafeInteger(installBefore?.installCalls) ? installBefore.installCalls : 0;

    const leaseStart = clock.now();
    let callbackEnteredAt = null;
    const leaseOutcome = await settleWithin(
      () =>
        adapters.lease.withRunLease(
          async (rawDescriptor, leaseSignal) => {
            callbackEnteredAt = clock.now();
            timing.leaseAcquireMs = roundMs(callbackEnteredAt - leaseStart);

            descriptor = validateDescriptor(rawDescriptor, scenario.expectedDescriptor);
            result.identity.descriptor = descriptor;

            const execEntryAt = clock.now();
            const requestedDeadline = Math.min(
              outerDeadline,
              execEntryAt +
                Math.min(
                  scenario.deadlineAfterMs ?? PROTOCOL_LIMITS.executorWallMs,
                  PROTOCOL_LIMITS.executorWallMs,
                ),
            );
            const execDeadline = computeExecutorDeadline(execEntryAt, requestedDeadline);
            executeBudgetMs = roundMs(execDeadline - execEntryAt);

            executeCalls += 1;
            const execStart = clock.now();
            const execOutcome = await settleWithin(
              () =>
                adapters.executor.execute(snapshot, descriptor, {
                  signal: leaseSignal ?? controller.signal,
                  deadlineAtMs: execDeadline,
                }),
              execDeadline,
              clock,
              async () => {
                controller.abort();
                await boundedDispose().catch(() => {});
              },
            );
            timing.executeMs = roundMs(clock.now() - execStart);
            if (execOutcome.expired) throw harnessError(HARNESS_CODES.TIMEOUT, "executor_deadline");
            if (execOutcome.error) throw mapAdapterError(execOutcome.error, HARNESS_CODES.ENGINE_FAILED);
            raw = execOutcome.value;
            if (!(typeof raw === "string" || Buffer.isBuffer(raw))) {
              throw harnessError(HARNESS_CODES.INVALID_OUTPUT, "raw_type");
            }

            const context = buildContext(scenario, snapshot, probe, descriptor);
            const normalizeStart = clock.now();
            const candidate = normalizeAudioResult(raw, context);
            timing.normalizeMs = roundMs(clock.now() - normalizeStart);
            if (!candidate.ok) throw harnessError(HARNESS_CODES.INVALID_OUTPUT, candidate.code);
            normalized = candidate;

            post = pickPostconditions(adapters.executor.postcondition());
            return Object.freeze({ ok: true });
          },
          { signal: controller.signal, deadlineAtMs: outerDeadline },
        ),
      outerDeadline,
      clock,
      () => controller.abort(),
    );
    timing.leaseHoldMs = roundMs(clock.now() - leaseStart);
    if (leaseOutcome.expired) throw harnessError(HARNESS_CODES.TIMEOUT, "lease_deadline");
    if (leaseOutcome.error) throw leaseOutcome.error;
  } catch (error) {
    code = mapCode(error);
    detail = safeDetail(error);
  } finally {
    try {
      await boundedDispose();
    } catch (error) {
      const cleanupCode = mapCode(error, HARNESS_CODES.CLEANUP_FAILED);
      if (code === null) {
        code = cleanupCode;
        detail = safeDetail(error);
      } else {
        cleanupSecondaryCode = cleanupCode;
      }
    }

    try {
      post = pickPostconditions(adapters.executor.postcondition());
    } catch {
      post = null;
    }

    let leasePost = null;
    let probePost = null;
    try {
      leasePost = adapters.lease.postcondition();
    } catch {
      leasePost = null;
    }
    try {
      probePost = adapters.probe.postcondition();
    } catch {
      probePost = null;
    }
    installCallsAfter = Number.isSafeInteger(leasePost?.installCalls) ? leasePost.installCalls : installCallsBefore;
    result.install = Object.freeze({
      executed: false,
      state: "not_executed",
      reason: "NOT_AUTHORIZED_IN_THIS_TICKET",
      callsBefore: installCallsBefore,
      callsAfter: installCallsAfter,
    });

    let tempDirRemoved = false;
    const cleanupStart = clock.now();
    if (root !== null) {
      try {
        await fs.rm(root, { recursive: true, force: true });
        tempDirRemoved = (await fs.lstat(root).catch(() => null)) === null;
      } catch {
        tempDirRemoved = false;
      }
    }
    timing.cleanupMs = roundMs(clock.now() - cleanupStart);

    const leaseReleased =
      leasePost !== null &&
      leasePost.active === false &&
      Number.isSafeInteger(leasePost.releaseCalls) &&
      Number.isSafeInteger(leasePost.acquireCalls) &&
      (leasePost.releaseCalls > 0 || (leasePost.acquireCalls === 0 && leasePost.releaseCalls === 0));
    const disposeCalls = post?.dispose?.calls ?? 0;
    const cleanupOk =
      tempDirRemoved && leaseReleased && installCallsAfter === installCallsBefore && installCallsAfter === 0;

    result.cleanup = Object.freeze({
      ok: cleanupOk,
      tempDirRemoved,
      disposeCalls,
      leaseReleased,
      leaseReleaseCalls: leasePost?.releaseCalls ?? null,
      installCallsBefore,
      installCallsAfter,
      cleanupBudgetMs: cleanupTimeoutMs,
      secondaryCode: cleanupSecondaryCode,
    });
    result.lease = leasePost
      ? Object.freeze({
          active: leasePost.active === true,
          acquireCalls: leasePost.acquireCalls,
          releaseCalls: leasePost.releaseCalls,
          installCalls: leasePost.installCalls,
          lastDeadlineAtMs: leasePost.lastDeadlineAtMs,
        })
      : null;
    result.probe = probePost
      ? Object.freeze({ calls: probePost.calls, snapshotBytes: probePost.lastSnapshot?.bytes ?? null })
      : null;
    result.adapterCalls = Object.freeze({
      leaseAcquire: leasePost?.acquireCalls ?? 0,
      leaseRelease: leasePost?.releaseCalls ?? 0,
      executorExecute: executeCalls,
      executorDispose: disposeCalls,
      probe: probePost?.calls ?? 0,
      install: installCallsAfter,
    });

    if (post) {
      const check = evaluatePostconditions(post, { success: code === null });
      result.postconditions = Object.freeze({
        source: "injected-adapter",
        ...post,
        check,
      });
      if (code === null && !check.ok) {
        code = HARNESS_CODES.POSTCONDITION_FAILED;
        detail = check.failures.join("+");
      }
    } else if (code === null) {
      code = HARNESS_CODES.POSTCONDITION_FAILED;
      detail = "postcondition_missing";
    }

    if (code === null && !cleanupOk) {
      code = HARNESS_CODES.CLEANUP_FAILED;
      detail = "cleanup_incomplete";
    }

    result.timing = Object.freeze({
      clock: options.clock ? "injected-monotonic" : "performance.now",
      monotonic: true,
      allowanceAddedMs: 0,
      executorWallLimitMs: PROTOCOL_LIMITS.executorWallMs,
      absoluteWallLimitMs: PROTOCOL_LIMITS.absoluteWallMs,
      probeWallLimitMs: PROTOCOL_LIMITS.probeWallMs,
      effectiveExecuteBudgetMs: executeBudgetMs,
      installMs: 0,
      probeMs: timing.probeMs,
      leaseAcquireMs: timing.leaseAcquireMs,
      leaseHoldMs: timing.leaseHoldMs,
      executeMs: timing.executeMs,
      normalizeMs: timing.normalizeMs,
      disposeMs: timing.disposeMs,
      cleanupMs: timing.cleanupMs,
      totalMs: roundMs(clock.now() - entryAt),
    });

    result.output = safeOutput(normalized);
    result.protocol = PROTOCOL;
    result.resourceUnknown = resourceUnknownFromPostconditions(post);
    result.ok = code === null;
    result.code = code ?? HARNESS_CODES.OK;
    result.detail = detail;
    result.sideEffects.adapterMethodsCalled =
      (leasePost?.acquireCalls ?? 0) +
      (leasePost?.releaseCalls ?? 0) +
      executeCalls +
      (probePost?.calls ?? 0) +
      disposeCalls;
  }

  return Object.freeze(result);
}
