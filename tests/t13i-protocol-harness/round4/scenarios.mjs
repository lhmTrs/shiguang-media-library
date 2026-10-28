/**
 * T13I-PROTOCOL-HARNESS-20261024：canonical 合成场景。
 *
 * 每个场景都是全新假 adapter + 全新临时数据；不读真实素材、不运行 engine、
 * 不安装/解包/下载、不联网。expectedCode 用于 CLI 自检，测试文件另做细断言。
 */
import crypto from "node:crypto";
import { HARNESS_CODES } from "./contracts.mjs";
import { createFakeExecutor, createFakeLease, createFakeProbe, createPoisonAdapters } from "./fakes.mjs";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const ENGINE_BINARY_SHA = sha256("synthetic-audio-engine-binary");
const ENGINE_GENERATION = sha256("synthetic-audio-engine-generation").slice(0, 32);
const TOOL_SHA = sha256("synthetic-ffprobe-tool");

export const NORMAL_RAW = JSON.stringify({
  bpm: 120,
  key: { best: "C major", r: 0.91 },
  loud: { peak: -1.5, rms: -14.2 },
  energy: { min: -31, max: -9, std: 4.5 },
  fit: { beat: 0.8, tonal: 0.7, chord: 0.6 },
  seg: [0.5, 1.25],
  futureUnsupportedField: "ignored-by-brief-v1",
});

export function makeDescriptor(overrides = {}) {
  return Object.freeze({
    version: "1.0.0",
    binarySha256: ENGINE_BINARY_SHA,
    binarySize: 123_456,
    generation: ENGINE_GENERATION,
    binaryPath: "/tmp/t13i-synthetic-engine/audio-analyze",
    platform: process.platform,
    arch: process.arch,
    ...overrides,
  });
}

export function makeProbeTool(overrides = {}) {
  return Object.freeze({
    path: "/tmp/t13i-synthetic-tools/ffprobe",
    sha256: TOOL_SHA,
    version: "ffprobe version synthetic",
    expectedSha256: TOOL_SHA,
    ...overrides,
  });
}

function baseScenario(name, descriptor = makeDescriptor()) {
  return {
    name,
    mode: "injected",
    kind: "music",
    syntheticBytes: Buffer.from("RIFF-synthetic-wav-bytes-for-protocol-harness", "utf8"),
    probeTool: makeProbeTool(),
    descriptor,
    expectedDescriptor: descriptor,
    raw: NORMAL_RAW,
    deadlineAfterMs: 30_000,
    outerDeadlineMs: 35_000,
    cleanupTimeoutMs: 1_000,
  };
}

function normalAdapters(descriptor = makeDescriptor(), executorOptions = {}) {
  return Object.freeze({
    lease: createFakeLease({ descriptor }),
    executor: createFakeExecutor({ raw: NORMAL_RAW, ...executorOptions }),
    probe: createFakeProbe(),
  });
}

/**
 * @returns {{name:string, expectedCode:string, expectedDetail?:string|null,
 *   scenario:object, adapters:object, poisonCalls?:object}}
 */
export function createCase(name) {
  switch (name) {
    case "normal": {
      const descriptor = makeDescriptor();
      return {
        name,
        expectedCode: HARNESS_CODES.OK,
        expectedDetail: null,
        scenario: baseScenario(name, descriptor),
        adapters: normalAdapters(descriptor),
      };
    }
    case "wrong_identity": {
      const invalid = makeDescriptor({ binarySha256: "0".repeat(64) });
      return {
        name,
        expectedCode: HARNESS_CODES.IDENTITY_MISMATCH,
        expectedDetail: "binary_sha256_nonzero",
        scenario: baseScenario(name, invalid),
        adapters: normalAdapters(invalid),
      };
    }
    case "expected_identity_mismatch": {
      const descriptor = makeDescriptor();
      const scenario = baseScenario(name, descriptor);
      scenario.expectedDescriptor = makeDescriptor({ version: "9.9.9" });
      return {
        name,
        expectedCode: HARNESS_CODES.IDENTITY_MISMATCH,
        expectedDetail: "expected_version",
        scenario,
        adapters: normalAdapters(descriptor),
      };
    }
    case "timeout": {
      const descriptor = makeDescriptor();
      const scenario = baseScenario(name, descriptor);
      scenario.deadlineAfterMs = 80;
      scenario.outerDeadlineMs = 1_500;
      scenario.cleanupTimeoutMs = 800;
      return {
        name,
        expectedCode: HARNESS_CODES.TIMEOUT,
        expectedDetail: "executor_deadline",
        scenario,
        adapters: normalAdapters(descriptor, { hang: true }),
      };
    }
    case "cleanup_failure": {
      const descriptor = makeDescriptor();
      return {
        name,
        expectedCode: HARNESS_CODES.CLEANUP_FAILED,
        expectedDetail: "injected_cleanup_failure",
        scenario: baseScenario(name, descriptor),
        adapters: normalAdapters(descriptor, { cleanupFailure: true }),
      };
    }
    case "postcondition_failure": {
      const descriptor = makeDescriptor();
      return {
        name,
        expectedCode: HARNESS_CODES.POSTCONDITION_FAILED,
        expectedDetail: "process_group_not_gone",
        scenario: baseScenario(name, descriptor),
        adapters: normalAdapters(descriptor, { successGroupGone: false }),
      };
    }
    case "noncompliant_output": {
      const descriptor = makeDescriptor();
      return {
        name,
        expectedCode: HARNESS_CODES.INVALID_OUTPUT,
        expectedDetail: "INVALID_BPM",
        scenario: baseScenario(name, descriptor),
        adapters: normalAdapters(descriptor, { raw: '{"bpm":"not-a-number"}' }),
      };
    }
    case "probe_identity_mismatch": {
      const descriptor = makeDescriptor();
      const scenario = baseScenario(name, descriptor);
      scenario.probeTool = makeProbeTool({ expectedSha256: "f".repeat(64) });
      return {
        name,
        expectedCode: HARNESS_CODES.PROBE_IDENTITY_MISMATCH,
        expectedDetail: "expected_sha256_mismatch",
        scenario,
        adapters: normalAdapters(descriptor),
      };
    }
    case "raw_error_redaction": {
      const descriptor = makeDescriptor();
      return {
        name,
        expectedCode: HARNESS_CODES.ENGINE_FAILED,
        expectedDetail: "injected_executor_failure",
        scenario: baseScenario(name, descriptor),
        adapters: normalAdapters(descriptor, { throwCode: HARNESS_CODES.ENGINE_FAILED }),
      };
    }
    case "budget_override_refusal": {
      const descriptor = makeDescriptor();
      const scenario = baseScenario(name, descriptor);
      scenario.dataDirBudgetBytes = 1;
      const poison = createPoisonAdapters();
      return {
        name,
        expectedCode: HARNESS_CODES.INVALID_REQUEST,
        expectedDetail: "budget_override_dataDirBudgetBytes",
        scenario,
        adapters: poison.adapters,
        poisonCalls: poison.calls,
      };
    }
    case "real_execution_refusal": {
      const descriptor = makeDescriptor();
      const scenario = baseScenario(name, descriptor);
      scenario.mode = "real";
      const poison = createPoisonAdapters();
      return {
        name,
        expectedCode: HARNESS_CODES.UNAUTHORIZED_REAL_EXECUTION,
        expectedDetail: "mode_not_injected",
        scenario,
        adapters: poison.adapters,
        poisonCalls: poison.calls,
      };
    }
    case "install_refusal": {
      const descriptor = makeDescriptor();
      const scenario = baseScenario(name, descriptor);
      scenario.install = { requested: true };
      const poison = createPoisonAdapters();
      return {
        name,
        expectedCode: HARNESS_CODES.INSTALL_NOT_AUTHORIZED,
        expectedDetail: "install_must_not_run",
        scenario,
        adapters: poison.adapters,
        poisonCalls: poison.calls,
      };
    }
    default:
      throw new Error(`unknown canonical case: ${name}`);
  }
}

export const CASE_NAMES = Object.freeze([
  "normal",
  "wrong_identity",
  "expected_identity_mismatch",
  "timeout",
  "cleanup_failure",
  "postcondition_failure",
  "noncompliant_output",
  "probe_identity_mismatch",
  "raw_error_redaction",
  "budget_override_refusal",
  "real_execution_refusal",
  "install_refusal",
]);

export function createCanonicalCases() {
  return CASE_NAMES.map((name) => createCase(name));
}
