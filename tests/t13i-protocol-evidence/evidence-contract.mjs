/**
 * AUDIO-PROTOCOL-EVIDENCE-ADAPTER-20261025 / round1
 *
 * 纯合同 helper。只做“受控合同校验”，不是恶意 Proxy 沙箱：不承诺防住
 * getPrototypeOf / getOwnPropertyDescriptors 的 Proxy trap，也不读 stack、
 * message、getter 或 toJSON。零 I/O、零子进程、零网络、零产品 import。
 *
 * 规范来源（冲突优先级）：spec > round4 > round3 > round2 > round1。
 * - error carrier：Error / plain 对象；仅 own data descriptor 的
 *   evidence / executionEvidence，accessor 固定拒绝且不调用 getter。
 * - record：plain/null 原型；只从 descriptor.value 取值。
 * - array：只用于 unknownResources / directory.pendingOps，有界 dense，
 *   逐 index 校验 own data descriptor，不套用 plain-record 原型检查。
 */

const EVIDENCE_MAX_JSON_BYTES = 8 * 1024;
const ARRAY_MAX_LENGTH = 32;

export const EVIDENCE_CONTRACT_CODES = Object.freeze({
  SHAPE: "EVIDENCE_SHAPE",
  ENUM: "EVIDENCE_ENUM",
  BOUNDS: "EVIDENCE_BOUNDS",
  LEAK: "EVIDENCE_LEAK",
  GATE: "EVIDENCE_GATE",
  ERROR_SHAPE: "EVIDENCE_ERROR_SHAPE",
});

function contractError(code, detail) {
  const error = new Error(code);
  error.name = "EvidenceContractError";
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

const shape = (detail) => contractError(EVIDENCE_CONTRACT_CODES.SHAPE, detail);
const enumFail = (detail) => contractError(EVIDENCE_CONTRACT_CODES.ENUM, detail);
const bounds = (detail) => contractError(EVIDENCE_CONTRACT_CODES.BOUNDS, detail);
const leak = (detail) => contractError(EVIDENCE_CONTRACT_CODES.LEAK, detail);
const gate = (detail) => contractError(EVIDENCE_CONTRACT_CODES.GATE, detail);
const errorShape = (detail) => contractError(EVIDENCE_CONTRACT_CODES.ERROR_SHAPE, detail);

const HASH64 = /^[0-9a-f]{64}$/;
const GENERATION = /^[0-9a-f]{32,64}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,128}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const LABEL = /^[a-z0-9-]{1,64}$/;
const OWNER_OP = /^(?:ensure-[a-z0-9-]{1,32}|mkdir-[a-z0-9-]{1,32}|owner-(?:open|write|close))$/;

const UNKNOWN_RESOURCES = Object.freeze([
  "spawn",
  "child",
  "stdio.stdout",
  "stdio.stderr",
  "group",
  "directory",
]);

export const EVIDENCE_FORBIDDEN_KEYS = Object.freeze([
  "filePath",
  "dir",
  "dataDir",
  "binaryPath",
  "path",
  "argv",
  "env",
  "token",
  "stdoutText",
  "stderrText",
  "raw",
  "rawStderr",
  "pid",
  "pgid",
  "secret",
]);

const FORBIDDEN = new Set(EVIDENCE_FORBIDDEN_KEYS);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isErrorCarrier(value) {
  if (value instanceof Error) return true;
  return isPlainObject(value);
}

/**
 * 只读 own string-key data descriptor。symbol / own toJSON / accessor 一律固定拒绝；
 * strict 模式下未知 key 也拒绝（v1）。返回 descriptors，值只从 descriptor.value 取。
 */
function ownDataDescriptors(record, { strict, allowed, label }) {
  if (!isPlainObject(record)) throw shape(label);
  const keys = Reflect.ownKeys(record);
  for (const key of keys) {
    if (typeof key === "symbol") throw shape(`${label}.symbol`);
  }
  if (Object.hasOwn(record, "toJSON")) throw shape(`${label}.toJSON`);
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const names = Object.keys(descriptors);
  for (const key of names) {
    const descriptor = descriptors[key];
    if (descriptor.get || descriptor.set) {
      // 只回显已批准字段名；未批准 key 一律固定 accessor sentinel，不回显输入名。
      throw shape(allowed?.has(key) ? `${label}.${key}` : `${label}.accessor`);
    }
    if (strict && !allowed.has(key)) {
      // 禁用键名来自固定批准清单，可回显；其余未知 key 只给固定 sentinel。
      throw shape(FORBIDDEN.has(key) ? key : `${label}.unknown-key`);
    }
  }
  return { names, descriptors };
}

function checkString(value, label) {
  if (typeof value !== "string") throw shape(label);
  if (value.length > 1 && value.startsWith("/")) throw leak(label);
  if (value.includes("SECRET_")) throw leak(label);
  return value;
}

function checkStringPattern(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) throw shape(label);
  return value;
}

function checkNullableString(value, label) {
  if (value === null) return null;
  return checkString(value, label);
}

function checkBool(value, label) {
  if (typeof value !== "boolean") throw shape(label);
  return value;
}

function checkInt(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw shape(label);
  return value;
}

function checkNumber(value, label, { min = 0 } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw shape(label);
  return value;
}

function checkNullableInt(value, label, options) {
  if (value === null) return null;
  return checkInt(value, label, options);
}

function checkNullableNumber(value, label, options) {
  if (value === null) return null;
  return checkNumber(value, label, options);
}

function checkEnum(value, values, label) {
  if (!values.includes(value)) throw enumFail(label);
  return value;
}

function checkCode(value, label) {
  if (value === null) return null;
  if (typeof value !== "string" || !CODE.test(value)) throw shape(label);
  return value;
}

/** 递归 record 的通用入口：v1 要求 frozen、精确键集合、无未知键。 */
function v1Record(record, spec, label) {
  const allowed = new Set(Object.keys(spec));
  const { names, descriptors } = ownDataDescriptors(record, {
    strict: true,
    allowed,
    label,
  });
  if (!Object.isFrozen(record)) throw shape(`${label}.frozen`);
  if (names.length !== allowed.size) {
    for (const key of allowed) {
      if (!descriptors[key]) throw shape(`${label}.${key}`);
    }
    throw shape(`${label}.keys`);
  }
  const values = Object.create(null);
  for (const [key, validate] of Object.entries(spec)) {
    const descriptor = descriptors[key];
    values[key] = validate(descriptor.value, `${label}.${key}`);
  }
  return values;
}

/**
 * schema 声明数组：有界、dense、无 extra string/symbol、无 accessor、无 own toJSON。
 * 不检查 Array.prototype 以外的原型之外的 record 原型；数组自身必须是 Array.prototype。
 */
function v1Array(array, elementCheck, label) {
  if (!Array.isArray(array)) throw shape(label);
  if (Object.getPrototypeOf(array) !== Array.prototype) throw shape(`${label}.prototype`);
  if (!Object.isFrozen(array)) throw shape(`${label}.frozen`);
  const length = array.length;
  checkInt(length, `${label}.length`, { min: 0, max: ARRAY_MAX_LENGTH });
  const keys = Reflect.ownKeys(array);
  const expected = new Set(["length"]);
  for (let index = 0; index < length; index += 1) expected.add(String(index));
  for (const key of keys) {
    if (typeof key === "symbol") throw shape(`${label}.symbol`);
    // 额外数组 key 也是输入名；固定 sentinel，不回显 key。
    if (!expected.has(key)) throw shape(`${label}.extra-key`);
  }
  if (Object.hasOwn(array, "toJSON")) throw shape(`${label}.toJSON`);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
    if (!descriptor) throw shape(`${label}.sparse`);
    if (descriptor.get || descriptor.set) throw shape(`${label}.accessor`);
    elementCheck(descriptor.value, `${label}[${index}]`);
  }
  return array;
}

function syncUnknownResources(ev) {
  const derived = [];
  if (ev.spawn.state === "unknown") derived.push("spawn");
  if (ev.spawn.state === "confirmed" && ev.child.closeSettled === false) derived.push("child");
  if (ev.stdio.stdout.state !== "not-started" && ev.stdio.stdout.final === false) {
    derived.push("stdio.stdout");
  }
  if (ev.stdio.stderr.state !== "not-started" && ev.stdio.stderr.final === false) {
    derived.push("stdio.stderr");
  }
  if (ev.group.state === "unknown") derived.push("group");
  if (ev.directory.state === "unknown" || ev.directory.state === "retained") {
    derived.push("directory");
  }
  const actual = ev.unknownResources;
  if (derived.length !== actual.length) throw shape("unknownResources");
  for (let index = 0; index < derived.length; index += 1) {
    if (derived[index] !== actual[index]) throw shape("unknownResources");
  }
  if (ev.resourceUnknown !== (derived.length > 0)) throw shape("resourceUnknown");
}

const IDENTITY = {
  version: (value, label) => checkStringPattern(value, VERSION, label),
  binarySha256: (value, label) => checkStringPattern(value, HASH64, label),
  binarySize: (value, label) => checkInt(value, label, { min: 1 }),
  generation: (value, label) => checkStringPattern(value, GENERATION, label),
  snapshotSha256: (value, label) => checkStringPattern(value, HASH64, label),
  snapshotBytes: (value, label) => checkInt(value, label, { min: 1 }),
  descriptorValidated: (value, label) => {
    if (value !== true) throw shape(label);
    return value;
  },
  snapshotValidated: (value, label) => {
    if (value !== true) throw shape(label);
    return value;
  },
};

const TIMING = {
  clock: (value, label) => checkEnum(value, ["monotonic"], label),
  sourceDeadline: (value, label) => checkEnum(value, ["caller", "executor"], label),
  wallBudgetMs: (value, label) => checkInt(value, label, { min: 1, max: 180_000 }),
  hardDeadlineOffsetMs: (value, label) => checkNumber(value, label),
  allowanceMs: (value, label) => checkInt(value, label, { min: 0 }),
  spawnAtMs: (value, label) => checkNullableNumber(value, label),
  closeAtMs: (value, label) => checkNullableNumber(value, label),
  groupConfirmedAtMs: (value, label) => checkNullableNumber(value, label),
  cleanupFinishedAtMs: (value, label) => checkNullableNumber(value, label),
  totalMs: (value, label) => checkNumber(value, label),
  budgetExhausted: (value, label) => checkBool(value, label),
};

const SPAWN = {
  state: (value, label) => checkEnum(value, ["not-started", "confirmed", "failed", "unknown"], label),
  reason: (value, label) => checkNullableString(value, label),
  confirmedAtMs: (value, label) => checkNullableNumber(value, label),
};

const CHILD = {
  state: (value, label) => checkEnum(value, ["not-created", "exited", "signaled", "unknown"], label),
  exitCode: (value, label) => checkNullableInt(value, label, { min: -2_147_483_648 }),
  signal: (value, label) => checkNullableString(value, label),
  closeSettled: (value, label) => checkBool(value, label),
  pidObserved: (value, label) => checkBool(value, label),
  streamError: (value, label) => checkBool(value, label),
};

function streamSpec() {
  return {
    state: (value, label) =>
      checkEnum(value, ["not-started", "open", "settled", "stream-error"], label),
    observedBytes: (value, label) => checkInt(value, label, { max: 64 * 1024 * 1024 }),
    final: (value, label) => checkBool(value, label),
    retainedBytes: (value, label) => checkInt(value, label, { max: 64 * 1024 * 1024 }),
    limitBytes: (value, label) => checkInt(value, label, { min: 1, max: 64 * 1024 * 1024 }),
    truncated: (value, label) => checkBool(value, label),
    available: (value, label) => checkEnum(value, ["none", "buffer"], label),
  };
}

const GROUP = {
  state: (value, label) => checkEnum(value, ["not-created", "reclaimed", "unknown"], label),
  confirmedBy: (value, label) => checkEnum(value, ["none", "main", "finally"], label),
  observation: (value, label) => checkEnum(value, ["none", "kill0", "kill0+pgrep"], label),
  membersObserved: (value, label) => checkNullableInt(value, label, { max: 1_024 }),
  finalConfirm: (value, label) => checkEnum(value, ["not-run", "empty", "timeout", "error"], label),
  failureSource: (value, label) => checkNullableString(value, label),
  escapedDescendants: (value, label) => {
    if (value !== "not-observable") throw shape(label);
    return value;
  },
};

const DIRECTORY = {
  state: (value, label) =>
    checkEnum(value, ["not-created", "removed", "retained", "unknown"], label),
  marker: (value, label) => checkEnum(value, ["not-written", "written", "unknown"], label),
  cleanupRan: (value, label) => checkBool(value, label),
  removalAttempted: (value, label) => checkBool(value, label),
  removalSettled: (value, label) => checkBool(value, label),
  postcondition: (value, label) =>
    checkEnum(value, ["not-checked", "absent", "present", "unknown"], label),
  pendingOps: (value, label) =>
    v1Array(value, (element, elementLabel) => checkStringPattern(element, OWNER_OP, elementLabel), label),
  reason: (value, label) => checkNullableString(value, label),
};

const FAILURE = {
  stage: (value, label) =>
    checkEnum(value, ["prepare", "job", "spawn", "run", "close", "group", "cleanup", "finalize"], label),
  reason: (value, label) => checkNullableString(value, label),
  primaryCode: (value, label) => checkCode(value, label),
  finalCode: (value, label) => checkCode(value, label),
  overriddenBy: (value, label) => checkEnum(value, [null, "gate", "group", "cleanup"], label),
};

const INSTANCE = {
  stateBefore: (value, label) => checkEnum(value, ["ready", "faulted", "disposed"], label),
  faultedAfter: (value, label) => checkBool(value, label),
};

const HANDOFF = {
  resourceUnknown: (value, label) => checkBool(value, label),
  retainLeaseRequired: (value, label) => checkBool(value, label),
  retryPolicy: (value, label) => {
    if (value !== "not-decided-by-executor") throw shape(label);
    return value;
  },
};

function validateNested(descriptor, spec, label) {
  return v1Record(descriptor.value, spec, label);
}

const TOP = {
  schemaVersion: (value, label) => {
    if (value !== 1) throw shape(label);
    return value;
  },
  operation: (value, label) => checkEnum(value, ["execute"], label),
  outcome: (value, label) => checkEnum(value, ["success", "failure"], label),
  code: (value, label) => checkCode(value, label),
  primaryCode: (value, label) => checkCode(value, label),
  resourceUnknown: (value, label) => checkBool(value, label),
  unknownResources: (value, label) =>
    v1Array(value, (element, elementLabel) => checkEnum(element, UNKNOWN_RESOURCES, elementLabel), label),
  identity: (value, label) => {
    if (value === null) return null;
    return v1Record(value, IDENTITY, label);
  },
  timing: (value, label) => v1Record(value, TIMING, label),
  spawn: (value, label) => v1Record(value, SPAWN, label),
  child: (value, label) => v1Record(value, CHILD, label),
  stdio: (value, label) => {
    const allowed = new Set(["stdout", "stderr"]);
    const { names, descriptors } = ownDataDescriptors(value, { strict: true, allowed, label });
    if (!Object.isFrozen(value)) throw shape(`${label}.frozen`);
    if (names.length !== 2) {
      for (const key of allowed) if (!descriptors[key]) throw shape(`${label}.${key}`);
    }
    return {
      stdout: validateNested(descriptors.stdout, streamSpec(), `${label}.stdout`),
      stderr: validateNested(descriptors.stderr, streamSpec(), `${label}.stderr`),
    };
  },
  group: (value, label) => v1Record(value, GROUP, label),
  directory: (value, label) => v1Record(value, DIRECTORY, label),
  failure: (value, label) => {
    if (value === null) return null;
    return v1Record(value, FAILURE, label);
  },
  instance: (value, label) => v1Record(value, INSTANCE, label),
  handoff: (value, label) => v1Record(value, HANDOFF, label),
};

function byteSize(value) {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw shape("json");
  return Buffer.byteLength(json, "utf8");
}

/**
 * v1 evidence 严格校验。成功/失败都走同一形状；成功门另由 assertSuccessGate 判。
 */
export function assertEvidenceV1(evidence, { outcome } = {}) {
  if (!isPlainObject(evidence)) throw shape("evidence");
  const values = v1Record(evidence, TOP, "evidence");
  if (outcome !== undefined && values.outcome !== outcome) throw shape("outcome");
  if (values.outcome === "success") {
    if (values.code !== null) throw shape("code");
    if (values.failure !== null) throw shape("failure");
  } else {
    if (values.code === null) throw shape("code");
    if (values.failure === null) throw shape("failure");
  }
  syncUnknownResources(values);
  if (values.handoff.resourceUnknown !== values.resourceUnknown) throw shape("handoff.resourceUnknown");
  if (values.handoff.retainLeaseRequired !== values.resourceUnknown) {
    throw shape("handoff.retainLeaseRequired");
  }
  // 已先拒绝 own toJSON；嵌套数组只含原始字符串，不触发 toJSON。
  if (byteSize(evidence) > EVIDENCE_MAX_JSON_BYTES) throw bounds("evidence");
  return true;
}

/** 成功门：只这五项，任一 unknown 都不得算成功。 */
export function assertSuccessGate(evidence) {
  assertEvidenceV1(evidence, { outcome: "success" });
  if (evidence.resourceUnknown !== false) throw gate("resourceUnknown");
  if (evidence.child.closeSettled !== true) throw gate("child.closeSettled");
  if (evidence.stdio.stdout.final !== true) throw gate("stdio.stdout.final");
  if (evidence.group.state !== "reclaimed") throw gate("group.state");
  if (evidence.directory.state !== "removed") throw gate("directory.state");
  return true;
}

function validateLegacyEvidence(legacy) {
  if (!isPlainObject(legacy)) throw shape("evidence");
  const { names, descriptors } = ownDataDescriptors(legacy, {
    strict: false,
    allowed: new Set(["resourceUnknown", "closeSettled", "spawn", "reason"]),
    label: "evidence",
  });
  if (names.length === 0) return Object.freeze({});
  for (const key of ["resourceUnknown", "closeSettled"]) {
    if (descriptors[key]) checkBool(descriptors[key].value, `evidence.${key}`);
  }
  for (const key of ["spawn", "reason"]) {
    if (descriptors[key]) checkNullableString(descriptors[key].value, `evidence.${key}`);
  }
  return Object.freeze({
    resourceUnknown: descriptors.resourceUnknown ? descriptors.resourceUnknown.value : undefined,
    closeSettled: descriptors.closeSettled ? descriptors.closeSettled.value : undefined,
  });
}

/**
 * error carrier 合同：
 * - Error / plain 对象为 carrier；只取 evidence、executionEvidence 的 own descriptor；
 * - accessor 固定 EVIDENCE_ERROR_SHAPE，getter 调用 0 次；不读 stack/message/toJSON；
 * - EE.resourceUnknown=true 时必须同时有完整 legacy evidence.resourceUnknown=true；
 * - EE=false/缺失时不凭空要求 L；L 存在仍按 inert shape 校验；
 * - 入口拒绝/旧 execute 可以两者都缺失；不改写原 error。
 */
export function assertErrorEvidence(error) {
  if (!isErrorCarrier(error)) throw errorShape("carrier");
  const evidenceDescriptor = Object.getOwnPropertyDescriptor(error, "evidence");
  const executionDescriptor = Object.getOwnPropertyDescriptor(error, "executionEvidence");
  if (evidenceDescriptor && (evidenceDescriptor.get || evidenceDescriptor.set)) {
    throw errorShape("evidence");
  }
  if (executionDescriptor && (executionDescriptor.get || executionDescriptor.set)) {
    throw errorShape("executionEvidence");
  }
  const legacy = evidenceDescriptor ? evidenceDescriptor.value : undefined;
  const execution = executionDescriptor ? executionDescriptor.value : undefined;
  const hasLegacy = evidenceDescriptor !== undefined;
  const hasExecution = executionDescriptor !== undefined;
  let legacySummary = null;
  if (hasLegacy) legacySummary = validateLegacyEvidence(legacy);
  if (hasExecution) {
    assertEvidenceV1(execution);
    if (execution.resourceUnknown === true) {
      if (!hasLegacy) throw errorShape("evidence.missing");
      if (!isPlainObject(legacy) || legacy.resourceUnknown !== true) {
        throw errorShape("evidence.resourceUnknown");
      }
    }
  }
  return Object.freeze({
    hasEvidence: hasLegacy,
    hasExecutionEvidence: hasExecution,
    executionResourceUnknown: hasExecution ? execution.resourceUnknown : null,
    legacyResourceUnknown: legacySummary?.resourceUnknown ?? null,
    legacyCloseSettled: legacySummary?.closeSettled ?? null,
  });
}

/** 白名单摘要：独立冻结对象，不引用原 evidence，不含路径/PID/raw/token。 */
export function summarizeEvidence(evidence) {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    throw shape("evidence");
  }
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const summary = {
    schemaVersion: evidence.schemaVersion,
    outcome: evidence.outcome,
    code: evidence.code,
    resourceUnknown: evidence.resourceUnknown,
    unknownResources: clone(evidence.unknownResources),
    child: {
      state: evidence.child.state,
      exitCode: evidence.child.exitCode,
      signal: evidence.child.signal,
      closeSettled: evidence.child.closeSettled,
    },
    stdio: {
      stdout: {
        observedBytes: evidence.stdio.stdout.observedBytes,
        retainedBytes: evidence.stdio.stdout.retainedBytes,
        final: evidence.stdio.stdout.final,
        truncated: evidence.stdio.stdout.truncated,
      },
      stderr: {
        observedBytes: evidence.stdio.stderr.observedBytes,
        retainedBytes: evidence.stdio.stderr.retainedBytes,
        final: evidence.stdio.stderr.final,
        truncated: evidence.stdio.stderr.truncated,
      },
    },
    group: {
      state: evidence.group.state,
      observation: evidence.group.observation,
      membersObserved: evidence.group.membersObserved,
      finalConfirm: evidence.group.finalConfirm,
    },
    directory: {
      state: evidence.directory.state,
      postcondition: evidence.directory.postcondition,
      cleanupRan: evidence.directory.cleanupRan,
      removalSettled: evidence.directory.removalSettled,
      reason: evidence.directory.reason,
    },
    failure: evidence.failure
      ? { reason: evidence.failure.reason, overriddenBy: evidence.failure.overriddenBy }
      : null,
    timing: {
      totalMs: evidence.timing.totalMs,
      spawnAtMs: evidence.timing.spawnAtMs,
      closeAtMs: evidence.timing.closeAtMs,
      cleanupFinishedAtMs: evidence.timing.cleanupFinishedAtMs,
    },
  };
  const freeze = (value) => {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
    return value;
  };
  return freeze(summary);
}
