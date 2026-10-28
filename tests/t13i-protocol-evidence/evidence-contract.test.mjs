/**
 * AUDIO-PROTOCOL-EVIDENCE-ADAPTER-20261025 / round1 合成合同用例。
 *
 * 只使用普通对象与冻结对象，不 import AudioExecutor，不 spawn、不联网、不读真实素材。
 * 覆盖 round4 冻结的 S01a/S01b、S02-S10、S08a-S08f、C01-C17、I01-I06。
 * Proxy 不在合同内（I07）：本文件不声称防住任意 JS/Proxy 沙箱。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EVIDENCE_CONTRACT_CODES as CODES,
  assertErrorEvidence,
  assertEvidenceV1,
  assertSuccessGate,
  summarizeEvidence,
} from "./evidence-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 不触发 getter 的深冻结：只沿 data descriptor 递归。 */
function freezeInert(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) continue;
    const child = descriptor.value;
    if (child && typeof child === "object" && !Object.isFrozen(child)) freezeInert(child);
  }
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function successEvidence() {
  return {
    schemaVersion: 1,
    operation: "execute",
    outcome: "success",
    code: null,
    primaryCode: null,
    resourceUnknown: false,
    unknownResources: [],
    identity: {
      version: "1.0.0-t13i",
      binarySha256: "a".repeat(64),
      binarySize: 123_456,
      generation: "b".repeat(32),
      snapshotSha256: "c".repeat(64),
      snapshotBytes: 987,
      descriptorValidated: true,
      snapshotValidated: true,
    },
    timing: {
      clock: "monotonic",
      sourceDeadline: "executor",
      wallBudgetMs: 5000,
      hardDeadlineOffsetMs: 5000,
      allowanceMs: 2501,
      spawnAtMs: 10,
      closeAtMs: 25,
      groupConfirmedAtMs: 30,
      cleanupFinishedAtMs: 40,
      totalMs: 41.5,
      budgetExhausted: false,
    },
    spawn: { state: "confirmed", reason: null, confirmedAtMs: 10 },
    child: {
      state: "exited",
      exitCode: 0,
      signal: null,
      closeSettled: true,
      pidObserved: true,
      streamError: false,
    },
    stdio: {
      stdout: {
        state: "settled",
        observedBytes: 186,
        final: true,
        retainedBytes: 186,
        limitBytes: 65_536,
        truncated: false,
        available: "buffer",
      },
      stderr: {
        state: "settled",
        observedBytes: 0,
        final: true,
        retainedBytes: 0,
        limitBytes: 65_536,
        truncated: false,
        available: "none",
      },
    },
    group: {
      state: "reclaimed",
      confirmedBy: "finally",
      observation: "kill0+pgrep",
      membersObserved: 0,
      finalConfirm: "empty",
      failureSource: null,
      escapedDescendants: "not-observable",
    },
    directory: {
      state: "removed",
      marker: "written",
      cleanupRan: true,
      removalAttempted: true,
      removalSettled: true,
      postcondition: "absent",
      pendingOps: [],
      reason: null,
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

function failureEvidence() {
  const evidence = successEvidence();
  evidence.outcome = "failure";
  evidence.code = "EXECUTION_UNAVAILABLE";
  evidence.primaryCode = null;
  evidence.resourceUnknown = true;
  evidence.unknownResources = ["directory"];
  evidence.child.state = "exited";
  evidence.directory = {
    state: "retained",
    marker: "written",
    cleanupRan: true,
    removalAttempted: true,
    removalSettled: true,
    postcondition: "present",
    pendingOps: [],
    reason: "CLEANUP_ERROR",
  };
  evidence.failure = {
    stage: "finalize",
    reason: "CLEANUP_ERROR",
    primaryCode: null,
    finalCode: "EXECUTION_UNAVAILABLE",
    overriddenBy: "cleanup",
  };
  evidence.instance.faultedAfter = true;
  evidence.handoff = {
    resourceUnknown: true,
    retainLeaseRequired: true,
    retryPolicy: "not-decided-by-executor",
  };
  return evidence;
}

function keptFailureEvidence() {
  const evidence = failureEvidence();
  evidence.resourceUnknown = false;
  evidence.unknownResources = [];
  evidence.directory = {
    state: "removed",
    marker: "written",
    cleanupRan: true,
    removalAttempted: true,
    removalSettled: true,
    postcondition: "absent",
    pendingOps: [],
    reason: null,
  };
  evidence.failure = {
    stage: "run",
    reason: "NONZERO_EXIT",
    primaryCode: "ENGINE_FAILED",
    finalCode: "ENGINE_FAILED",
    overriddenBy: null,
  };
  evidence.handoff = {
    resourceUnknown: false,
    retainLeaseRequired: false,
    retryPolicy: "not-decided-by-executor",
  };
  return evidence;
}

const sealedSuccess = () => freezeInert(successEvidence());
const sealedFailure = () => freezeInert(failureEvidence());
const sealedKeptFailure = () => freezeInert(keptFailureEvidence());

function errorWith(fields) {
  const error = new Error("synthetic");
  for (const [key, value] of Object.entries(fields)) error[key] = value;
  return error;
}

function expectCode(fn, code, detail) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code);
    if (detail !== undefined) assert.equal(error.detail, detail);
    return true;
  });
}

test("S01a：合法成功 evidence 通过 v1 形状与成功门", () => {
  const evidence = sealedSuccess();
  assert.equal(assertEvidenceV1(evidence, { outcome: "success" }), true);
  assert.equal(assertSuccessGate(evidence), true);
});

test("S01b：合法 retained / 非空 schema 数组通过 array 类型分支（不走成功门）", () => {
  const rebuilt = clone(failureEvidence());
  rebuilt.directory.pendingOps = ["owner-close", "mkdir-work"];
  rebuilt.unknownResources = ["directory"];
  const sealed = freezeInert(rebuilt);
  assert.equal(assertEvidenceV1(sealed, { outcome: "failure" }), true);
  expectCode(() => assertSuccessGate(sealed), CODES.SHAPE, "outcome");
});

test("S02：成功 evidence 但 directory.state=unknown 被成功门拒绝", () => {
  const evidence = clone(successEvidence());
  evidence.directory.state = "unknown";
  evidence.directory.postcondition = "unknown";
  evidence.directory.reason = "CLEANUP_DEADLINE";
  evidence.unknownResources = ["directory"];
  evidence.resourceUnknown = true;
  evidence.handoff = {
    resourceUnknown: true,
    retainLeaseRequired: true,
    retryPolicy: "not-decided-by-executor",
  };
  const sealed = freezeInert(evidence);
  assert.equal(assertEvidenceV1(sealed, { outcome: "success" }), true);
  expectCode(() => assertSuccessGate(sealed), CODES.GATE, "resourceUnknown");
});

test("S03：closeSettled=false / group=unknown / stdout.final=false 分别被成功门拒绝", () => {
  const child = clone(successEvidence());
  child.spawn.state = "confirmed";
  child.child.state = "unknown";
  child.child.closeSettled = false;
  child.unknownResources = ["child"];
  child.resourceUnknown = true;
  child.handoff = {
    resourceUnknown: true,
    retainLeaseRequired: true,
    retryPolicy: "not-decided-by-executor",
  };
  const childSealed = freezeInert(child);
  assert.equal(assertEvidenceV1(childSealed, { outcome: "success" }), true);
  expectCode(() => assertSuccessGate(childSealed), CODES.GATE, "resourceUnknown");

  const group = clone(successEvidence());
  group.group.state = "unknown";
  group.unknownResources = ["group"];
  group.resourceUnknown = true;
  group.handoff = {
    resourceUnknown: true,
    retainLeaseRequired: true,
    retryPolicy: "not-decided-by-executor",
  };
  const groupSealed = freezeInert(group);
  assert.equal(assertEvidenceV1(groupSealed, { outcome: "success" }), true);
  expectCode(() => assertSuccessGate(groupSealed), CODES.GATE, "resourceUnknown");

  const stdout = clone(successEvidence());
  stdout.stdio.stdout.state = "open";
  stdout.stdio.stdout.final = false;
  stdout.unknownResources = ["stdio.stdout"];
  stdout.resourceUnknown = true;
  stdout.handoff = {
    resourceUnknown: true,
    retainLeaseRequired: true,
    retryPolicy: "not-decided-by-executor",
  };
  const stdoutSealed = freezeInert(stdout);
  assert.equal(assertEvidenceV1(stdoutSealed, { outcome: "success" }), true);
  expectCode(() => assertSuccessGate(stdoutSealed), CODES.GATE, "resourceUnknown");
});

test("S04：顶层/嵌套缺字段与非法枚举固定拒绝，detail 只给字段名", () => {
  const missingTop = clone(successEvidence());
  delete missingTop.timing;
  expectCode(() => assertEvidenceV1(freezeInert(missingTop), { outcome: "success" }), CODES.SHAPE, "evidence.timing");

  const missingNested = clone(successEvidence());
  delete missingNested.child.closeSettled;
  expectCode(
    () => assertEvidenceV1(freezeInert(missingNested), { outcome: "success" }),
    CODES.SHAPE,
    "evidence.child.closeSettled",
  );

  const badEnum = clone(successEvidence());
  badEnum.group.state = "gone";
  let thrown = null;
  try {
    assertEvidenceV1(freezeInert(badEnum), { outcome: "success" });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown.code, CODES.ENUM);
  assert.equal(thrown.detail, "evidence.group.state");
  assert.equal(thrown.message.includes("gone"), false, "错误不得回显枚举值");
});

test("S05：夹带路径/token/raw/pid 等禁用键或泄漏字符串固定拒绝且不回显值", () => {
  const forbiddenTop = clone(successEvidence());
  forbiddenTop.filePath = "/private/value-should-not-leak";
  let thrown = null;
  try {
    assertEvidenceV1(freezeInert(forbiddenTop), { outcome: "success" });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown.code, CODES.SHAPE);
  assert.equal(thrown.detail, "filePath");
  assert.equal(thrown.message.includes("value-should-not-leak"), false);

  const forbiddenNested = clone(successEvidence());
  forbiddenNested.child.pid = 4242;
  expectCode(
    () => assertEvidenceV1(freezeInert(forbiddenNested), { outcome: "success" }),
    CODES.SHAPE,
    "pid",
  );

  const rawKey = clone(successEvidence());
  rawKey.raw = "secret bytes";
  expectCode(() => assertEvidenceV1(freezeInert(rawKey), { outcome: "success" }), CODES.SHAPE, "raw");

  const pathLeak = clone(successEvidence());
  pathLeak.group.failureSource = "/tmp/absolute/path";
  expectCode(
    () => assertEvidenceV1(freezeInert(pathLeak), { outcome: "success" }),
    CODES.LEAK,
    "evidence.group.failureSource",
  );

  const secretLeak = clone(successEvidence());
  secretLeak.group.failureSource = "prefix_SECRET_TOKEN";
  expectCode(
    () => assertEvidenceV1(freezeInert(secretLeak), { outcome: "success" }),
    CODES.LEAK,
    "evidence.group.failureSource",
  );
});

test("S06：JSON 超过 8 KiB 固定拒绝，不截断", () => {
  const evidence = clone(failureEvidence());
  evidence.failure.reason = "A".repeat(9000);
  let thrown = null;
  try {
    assertEvidenceV1(freezeInert(evidence), { outcome: "failure" });
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown.code, CODES.BOUNDS);
  assert.equal(thrown.detail, "evidence");
});

test("S07：error.evidence resourceUnknown=true/closeSettled=false 接受并原样保留", () => {
  const legacy = { resourceUnknown: true, closeSettled: false, reason: "SYNTHETIC_UNKNOWN" };
  const error = errorWith({ evidence: legacy });
  const before = JSON.stringify(legacy);
  const summary = assertErrorEvidence(error);
  assert.equal(summary.hasExecutionEvidence, false);
  assert.equal(summary.legacyResourceUnknown, true);
  assert.equal(error.evidence, legacy, "helper 不得替换原对象");
  assert.equal(JSON.stringify(legacy), before, "helper 不得改写原对象");
  assert.equal(Object.hasOwn(error, "executionEvidence"), false);
});

test("S08a/S08b/S08c：EE=true 缺 L / L 非 plain / L=false 三种拒绝", () => {
  const ee = sealedFailure();
  const missing = errorWith({ executionEvidence: ee });
  expectCode(() => assertErrorEvidence(missing), CODES.ERROR_SHAPE, "evidence.missing");

  const nonPlain = errorWith({ executionEvidence: ee, evidence: new Date() });
  expectCode(() => assertErrorEvidence(nonPlain), CODES.SHAPE, "evidence");

  const falseLegacy = errorWith({
    executionEvidence: ee,
    evidence: { resourceUnknown: false, closeSettled: true },
  });
  expectCode(() => assertErrorEvidence(falseLegacy), CODES.ERROR_SHAPE, "evidence.resourceUnknown");
});

test("S08d/S08e：EE=false 缺 L 接受；入口无 EE/legacy 也接受", () => {
  const eeFalse = sealedKeptFailure();
  const noLegacy = errorWith({ executionEvidence: eeFalse });
  const summary = assertErrorEvidence(noLegacy);
  assert.equal(summary.executionResourceUnknown, false);
  assert.equal(summary.legacyResourceUnknown, null);

  const entryReject = new Error("entry reject");
  const empty = assertErrorEvidence(entryReject);
  assert.equal(empty.hasEvidence, false);
  assert.equal(empty.hasExecutionEvidence, false);
});

test("S08f：EE=false + L=true 按 OR 保留不反转，且不改原 error", () => {
  const eeFalse = sealedKeptFailure();
  const legacy = { resourceUnknown: true, closeSettled: true };
  const error = errorWith({ executionEvidence: eeFalse, evidence: legacy });
  const summary = assertErrorEvidence(error);
  assert.equal(summary.legacyResourceUnknown, true);
  assert.equal(error.evidence.resourceUnknown, true, "legacy true 不得被 EE=false 反转");
  assert.equal(summary.executionResourceUnknown, false);
});

test("S09：白名单摘要只含固定字段，冻结且不引用原对象", () => {
  const evidence = sealedSuccess();
  const summary = summarizeEvidence(evidence);
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.child), true);
  assert.notEqual(summary, evidence);
  assert.notEqual(summary.child, evidence.child);
  assert.deepEqual(summary, {
    schemaVersion: 1,
    outcome: "success",
    code: null,
    resourceUnknown: false,
    unknownResources: [],
    child: { state: "exited", exitCode: 0, signal: null, closeSettled: true },
    stdio: {
      stdout: { observedBytes: 186, retainedBytes: 186, final: true, truncated: false },
      stderr: { observedBytes: 0, retainedBytes: 0, final: true, truncated: false },
    },
    group: {
      state: "reclaimed",
      observation: "kill0+pgrep",
      membersObserved: 0,
      finalConfirm: "empty",
    },
    directory: {
      state: "removed",
      postcondition: "absent",
      cleanupRan: true,
      removalSettled: true,
      reason: null,
    },
    failure: null,
    timing: { totalMs: 41.5, spawnAtMs: 10, closeAtMs: 25, cleanupFinishedAtMs: 40 },
  });
  const json = JSON.stringify(summary);
  assert.equal(json.includes("a".repeat(64)), false);
  assert.equal(json.includes("binarySha256"), false);
  assert.equal(json.includes("/"), false);
});

test("S10：helper 无子进程/网络 import，且不依赖真实引擎开关", async () => {
  assert.notEqual(process.env.SHIGUANG_T13I_REAL_ENGINE, "1");
  const source = await fs.readFile(path.join(HERE, "evidence-contract.mjs"), "utf8");
  for (const token of ["node:child_process", "node:net", "node:http", "node:https", "fetch("]) {
    assert.equal(source.includes(token), false, `helper 不得依赖 ${token}`);
  }
});

test("C01-C03：EE=true 时缺 L / 非 plain / L 为数组均拒绝", () => {
  const ee = sealedFailure();
  expectCode(() => assertErrorEvidence(errorWith({ executionEvidence: ee })), CODES.ERROR_SHAPE, "evidence.missing");
  expectCode(
    () => assertErrorEvidence(errorWith({ executionEvidence: ee, evidence: new Date() })),
    CODES.SHAPE,
    "evidence",
  );
  expectCode(
    () => assertErrorEvidence(errorWith({ executionEvidence: ee, evidence: [] })),
    CODES.SHAPE,
    "evidence",
  );
});

test("C04-C07：EE=false/缺失/true 的 L 规则与 OR 保留", () => {
  const eeTrue = sealedFailure();
  const eeFalse = sealedKeptFailure();
  assert.equal(assertErrorEvidence(errorWith({ executionEvidence: eeFalse })).legacyResourceUnknown, null);
  assert.equal(assertErrorEvidence(new Error("no evidence")).hasEvidence, false);
  const bothTrue = errorWith({
    executionEvidence: eeTrue,
    evidence: { resourceUnknown: true, closeSettled: false, reason: "CLEANUP_ERROR" },
  });
  assert.equal(assertErrorEvidence(bothTrue).legacyResourceUnknown, true);
  const orCase = errorWith({
    executionEvidence: eeFalse,
    evidence: { resourceUnknown: true, closeSettled: true },
  });
  assert.equal(assertErrorEvidence(orCase).legacyResourceUnknown, true);
  assert.equal(orCase.evidence.resourceUnknown, true);
});

test("C08-C11：L=false / 非 boolean / accessor / own toJSON 拒绝", () => {
  const ee = sealedFailure();
  expectCode(
    () =>
      assertErrorEvidence(
        errorWith({ executionEvidence: ee, evidence: { resourceUnknown: false, closeSettled: true } }),
      ),
    CODES.ERROR_SHAPE,
    "evidence.resourceUnknown",
  );
  expectCode(
    () =>
      assertErrorEvidence(
        errorWith({ executionEvidence: ee, evidence: { resourceUnknown: 1, closeSettled: true } }),
      ),
    CODES.SHAPE,
    "evidence.resourceUnknown",
  );

  let getterCalls = 0;
  const accessorLegacy = {};
  Object.defineProperty(accessorLegacy, "resourceUnknown", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return true;
    },
  });
  expectCode(
    () => assertErrorEvidence(errorWith({ executionEvidence: ee, evidence: accessorLegacy })),
    CODES.SHAPE,
    "evidence.resourceUnknown",
  );
  assert.equal(getterCalls, 0);

  const toJSONLegacy = { resourceUnknown: true, toJSON: () => ({ resourceUnknown: true }) };
  expectCode(
    () => assertErrorEvidence(errorWith({ executionEvidence: ee, evidence: toJSONLegacy })),
    CODES.SHAPE,
    "evidence.toJSON",
  );
});

test("C12-C14：入口/旧路径 L=[]、EE=[]、legacy 额外历史字段", () => {
  expectCode(
    () => assertErrorEvidence(errorWith({ evidence: [] })),
    CODES.SHAPE,
    "evidence",
  );
  expectCode(
    () => assertErrorEvidence(errorWith({ evidence: { resourceUnknown: true }, executionEvidence: [] })),
    CODES.SHAPE,
    "evidence",
  );
  const extra = errorWith({
    evidence: {
      resourceUnknown: true,
      closeSettled: false,
      reason: "CLEANUP_ERROR",
      legacyDetail: "historical-field",
      legacyCount: 3,
    },
  });
  const summary = assertErrorEvidence(extra);
  assert.equal(summary.legacyResourceUnknown, true);
  assert.equal(extra.evidence.legacyDetail, "historical-field", "legacy 额外字段不得被改写");
});

test("C15-C17：error carrier 的 evidence / executionEvidence accessor 一律拒绝且 getter=0", () => {
  const ee = sealedFailure();
  let evidenceGets = 0;
  const onlyEvidence = new Error("accessor");
  Object.defineProperty(onlyEvidence, "evidence", {
    enumerable: true,
    configurable: true,
    get() {
      evidenceGets += 1;
      return { resourceUnknown: true };
    },
  });
  Object.defineProperty(onlyEvidence, "executionEvidence", {
    enumerable: true,
    configurable: true,
    value: ee,
    writable: true,
  });
  expectCode(() => assertErrorEvidence(onlyEvidence), CODES.ERROR_SHAPE, "evidence");
  assert.equal(evidenceGets, 0);

  let executionGets = 0;
  const onlyExecution = new Error("accessor");
  Object.defineProperty(onlyExecution, "evidence", {
    enumerable: true,
    configurable: true,
    value: { resourceUnknown: true },
    writable: true,
  });
  Object.defineProperty(onlyExecution, "executionEvidence", {
    enumerable: true,
    configurable: true,
    get() {
      executionGets += 1;
      return ee;
    },
  });
  expectCode(() => assertErrorEvidence(onlyExecution), CODES.ERROR_SHAPE, "executionEvidence");
  assert.equal(executionGets, 0);

  let bothGets = 0;
  const both = new Error("accessor");
  for (const key of ["evidence", "executionEvidence"]) {
    Object.defineProperty(both, key, {
      enumerable: true,
      configurable: true,
      get() {
        bothGets += 1;
        return key === "evidence" ? { resourceUnknown: true } : ee;
      },
    });
  }
  expectCode(() => assertErrorEvidence(both), CODES.ERROR_SHAPE, "evidence");
  assert.equal(bothGets, 0, "任一 accessor 都不得先读值再判类型");
});

test("I01-I06：inert shape 的 accessor/symbol/extra/toJSON 固定拒绝", () => {
  // I01：EE 内嵌套 record 的 accessor。
  let nestedGets = 0;
  const nested = clone(failureEvidence());
  Object.defineProperty(nested.timing, "totalMs", {
    enumerable: true,
    configurable: true,
    get() {
      nestedGets += 1;
      return 1;
    },
  });
  expectCode(
    () => assertEvidenceV1(freezeInert(nested), { outcome: "failure" }),
    CODES.SHAPE,
    "evidence.timing.totalMs",
  );
  assert.equal(nestedGets, 0);

  // I02：schema array index accessor。
  let indexGets = 0;
  const indexed = clone(successEvidence());
  Object.defineProperty(indexed.unknownResources, "0", {
    enumerable: true,
    configurable: true,
    get() {
      indexGets += 1;
      return "spawn";
    },
  });
  expectCode(
    () => assertEvidenceV1(freezeInert(indexed), { outcome: "success" }),
    CODES.SHAPE,
    "evidence.unknownResources.accessor",
  );
  assert.equal(indexGets, 0);

  // I03：array 额外字符串 key；record 未知 key 都只给固定 sentinel，不回显输入名。
  const extraKey = clone(successEvidence());
  extraKey.unknownResources.extra = "x";
  expectCode(
    () => assertEvidenceV1(freezeInert(extraKey), { outcome: "success" }),
    CODES.SHAPE,
    "evidence.unknownResources.extra-key",
  );
  const unknownRecordKey = clone(successEvidence());
  unknownRecordKey.SECRET_unknown_property_name = true;
  let unknownThrown = null;
  try {
    assertEvidenceV1(freezeInert(unknownRecordKey), { outcome: "success" });
  } catch (error) {
    unknownThrown = error;
  }
  assert.equal(unknownThrown.code, CODES.SHAPE);
  assert.equal(unknownThrown.detail, "evidence.unknown-key");
  assert.equal(JSON.stringify({ code: unknownThrown.code, detail: unknownThrown.detail }).includes("SECRET_"), false);

  // I04：record symbol key。
  const symbolic = clone(successEvidence());
  symbolic[Symbol("hidden")] = true;
  expectCode(() => assertEvidenceV1(freezeInert(symbolic), { outcome: "success" }), CODES.SHAPE, "evidence.symbol");

  // I05：record 位置放 array。
  expectCode(
    () => assertEvidenceV1(freezeInert([]), { outcome: "success" }),
    CODES.SHAPE,
    "evidence",
  );

  // I06：record own toJSON。
  const withToJSON = clone(successEvidence());
  withToJSON.timing.toJSON = () => ({});
  expectCode(
    () => assertEvidenceV1(freezeInert(withToJSON), { outcome: "success" }),
    CODES.SHAPE,
    "evidence.timing.toJSON",
  );
});
