/**
 * T13I-PROTOCOL-HARNESS-20261024 round3：注入式 protocol harness 自测。
 *
 * 只跑合成 fake adapter + 临时目录；不启动引擎/真实 clang/ffprobe，不读真实素材，
 * 不联网，不安装/解包/下载，不改产品模块。测试入口与 CLI 共用同一个
 * runProtocolHarness。
 *
 * round3 只针对 retained-options P2：构造后 mutation/accessor 不得影响行为，
 * 嵌套 descriptor/probe/override 记录按 own data 捕获或惰性保留；其余 round1/2
 * 已接受合同只做回归，不重开。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import {
  PROTOCOL_LIMITS,
  computeExecutorDeadline,
  createMonotonicClock,
  evaluatePostconditions,
  HARNESS_CODES,
  pickPostconditions,
} from "./contracts.mjs";
import { runProtocolHarness } from "./harness.mjs";
import { createCase, makeDescriptor, NORMAL_RAW } from "./scenarios.mjs";
import { createFakeExecutor, createFakeLease, createFakeProbe, isFakeAdapter } from "./fakes.mjs";

async function run(name) {
  const entry = createCase(name);
  const result = await runProtocolHarness(entry.scenario, entry.adapters);
  return { entry, result };
}

async function runWithExecutor(name, executor) {
  const entry = createCase(name);
  const adapters = Object.freeze({
    lease: entry.adapters.lease,
    executor,
    probe: entry.adapters.probe,
  });
  const result = await runProtocolHarness(entry.scenario, adapters);
  return { entry, result };
}

function assertNoSecrets(result) {
  const text = JSON.stringify(result);
  assert.equal(text.includes("SECRET_RAW"), false, "raw stderr/message must not escape adapter");
  assert.equal(text.includes("POISON_ADAPTER"), false, "poison adapter text must not escape gate");
  assert.equal(text.includes(os.tmpdir()), false, "temporary absolute path must not be reported");
}

test("合同常量与 deadline：30s 封顶、不追加 allowance、64MiB/256MiB 事实固定", () => {
  assert.equal(PROTOCOL_LIMITS.executorWallMs, 30_000);
  assert.equal(PROTOCOL_LIMITS.absoluteWallMs, 180_000);
  assert.equal(PROTOCOL_LIMITS.fsizeBytes, 64 * 1024 * 1024);
  assert.equal(PROTOCOL_LIMITS.nofile, 256);
  assert.equal(PROTOCOL_LIMITS.cpuSeconds, 180);
  assert.equal(PROTOCOL_LIMITS.legacyDataDirBudgetBytes, 256 * 1024 * 1024);
  assert.equal(PROTOCOL_LIMITS.legacyDataDirBudgetApproved, false);

  assert.equal(computeExecutorDeadline(1_000, 50_000), 31_000);
  assert.equal(computeExecutorDeadline(1_000, 30_500), 30_500);
  assert.equal(computeExecutorDeadline(1_000, 2_000), 2_000);
  assert.equal(computeExecutorDeadline(1_000), 31_000);

  let tick = 5;
  const clock = createMonotonicClock(() => tick);
  assert.equal(clock.now(), 5);
  tick = 4;
  assert.throws(() => clock.now(), (error) => error.code === HARNESS_CODES.CLOCK_REGRESSION);
});

test("正常链：完整入口经 probe→未执行 install→lease→execute→brief-v1 normalize→dispose", async () => {
  const { entry, result } = await run("normal");
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 500));
  assert.equal(result.code, HARNESS_CODES.OK);
  assert.equal(result.output.protocol, "brief-v1");
  assert.equal(result.output.durationSec, 2);
  assert.deepEqual(result.output.warnings, ["UNKNOWN_FIELDS_IGNORED"]);
  assert.equal(result.identity.descriptor.binarySha256, entry.scenario.descriptor.binarySha256);
  assert.equal(result.identity.descriptor.binaryPathPresent, true);
  assert.equal("binaryPath" in result.identity.descriptor, false);
  assert.equal(result.identity.probeTool.sha256, entry.scenario.probeTool.sha256);

  assert.equal(result.gate.install, "not_executed");
  assert.deepEqual(result.install, {
    executed: false,
    state: "not_executed",
    reason: "NOT_AUTHORIZED_IN_THIS_TICKET",
    callsBefore: 0,
    callsAfter: 0,
  });
  assert.equal(result.timing.installMs, 0);
  assert.equal(result.timing.allowanceAddedMs, 0);
  assert.equal(result.timing.executorWallLimitMs, 30_000);
  assert.equal(result.timing.effectiveExecuteBudgetMs, 30_000);
  assert.ok(result.timing.totalMs >= 0);
  assert.ok(result.timing.probeMs >= 0);
  assert.ok(result.timing.leaseAcquireMs >= 0);
  assert.ok(result.timing.executeMs >= 0);
  assert.ok(result.timing.cleanupMs >= 0);
  assert.equal(result.budget.legacyDataDirBudgetBytes, 256 * 1024 * 1024);
  assert.equal(result.budget.legacyDataDirBudgetApproved, false);
  assert.equal(result.budget.decision, "LEGACY_BUDGET_NOT_APPROVED");

  assert.equal(result.postconditions.check.scope, "success");
  assert.equal(result.postconditions.check.ok, true);
  assert.equal(result.postconditions.exit.confirmed, true);
  assert.equal(result.postconditions.exit.code, 0);
  assert.equal(result.postconditions.exit.signal, null);
  assert.equal(result.postconditions.processGroup.own, true);
  assert.equal(result.postconditions.processGroup.groupGone, true);
  assert.equal(result.postconditions.dispose.called, true);
  assert.equal(result.cleanup.ok, true);
  assert.equal(result.cleanup.tempDirRemoved, true);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(result.rawEvidence.available, false);
  assert.equal(result.rawEvidence.rawStderr, "not_requested");

  assert.equal(entry.adapters.executor.calls.execute, 1);
  assert.equal(entry.adapters.executor.calls.dispose, 1);
  assert.equal(entry.adapters.probe.calls, 1);
  assert.equal(result.adapterCalls.executorExecute, 1);
  assertNoSecrets(result);
});

test("错误身份：descriptor 零摘要/expected 不匹配均在 execute 前拒绝，仍 dispose/释放/清理", async () => {
  for (const name of ["wrong_identity", "expected_identity_mismatch"]) {
    const { entry, result } = await run(name);
    assert.equal(result.code, HARNESS_CODES.IDENTITY_MISMATCH, name);
    assert.equal(result.ok, false);
    assert.equal(entry.adapters.executor.calls.execute, 0, `${name}: executor must not run`);
    assert.equal(result.adapterCalls.executorExecute, 0, `${name}: result must record no execute`);
    assert.equal(entry.adapters.executor.calls.dispose, 1, `${name}: dispose must still run`);
    assert.equal(entry.adapters.lease.calls.acquire, 1);
    assert.equal(entry.adapters.lease.calls.release, 1);
    assert.equal(result.cleanup.tempDirRemoved, true);
    assert.equal(result.cleanup.leaseReleased, true);
    assert.equal(result.cleanup.ok, true);
    assert.equal(result.output, null);
  }
});

test("超时：harness 在 80ms 合成预算内收敛，dispose/lease/临时目录有证据且不伪称进程组已回收", async () => {
  const { entry, result } = await run("timeout");
  assert.equal(result.code, HARNESS_CODES.TIMEOUT);
  assert.equal(result.detail, "executor_deadline");
  assert.equal(result.resourceUnknown, true);
  assert.equal(result.postconditions.check.scope, "failure");
  assert.equal(result.postconditions.exit.confirmed, false);
  assert.equal(result.postconditions.processGroup.groupGone, false);
  assert.equal(result.postconditions.processGroup.unknownDescendants, "not_scanned");
  assert.equal(entry.adapters.executor.calls.dispose, 1);
  assert.equal(entry.adapters.lease.calls.release, 1);
  assert.equal(result.cleanup.tempDirRemoved, true);
  assert.equal(result.cleanup.leaseReleased, true);
  assert.equal(result.cleanup.ok, true);
});

test("清理失败：dispose 固定 CLEANUP_FAILED、post.pending=true、lease 仍释放、临时目录仍删除", async () => {
  const { entry, result } = await run("cleanup_failure");
  assert.equal(result.code, HARNESS_CODES.CLEANUP_FAILED);
  assert.equal(result.postconditions.dispose.called, true);
  assert.equal(result.postconditions.dispose.pending, true);
  assert.equal(result.postconditions.check.ok, false);
  assert.equal(result.resourceUnknown, true);
  assert.equal(entry.adapters.executor.calls.dispose, 1);
  assert.equal(entry.adapters.lease.calls.release, 1);
  assert.equal(result.cleanup.tempDirRemoved, true);
  assert.equal(result.cleanup.leaseReleased, true);
  assertNoSecrets(result);
});

test("成功后置断言：假 adapter 自报 groupGone=false 时入口拒绝 OK，固定 POSTCONDITION_FAILED", async () => {
  const { entry, result } = await run("postcondition_failure");
  assert.equal(result.ok, false);
  assert.equal(result.code, HARNESS_CODES.POSTCONDITION_FAILED);
  assert.equal(result.detail, "process_group_not_gone");
  assert.equal(result.postconditions.check.ok, false);
  assert.equal(result.postconditions.processGroup.groupGone, false);
  assert.equal(entry.adapters.executor.calls.dispose, 1);
  assert.equal(result.cleanup.tempDirRemoved, true);
});

test("不合规输出：产品 normalize 返回 INVALID_BPM，经完整入口映射为 INVALID_OUTPUT，不回显 raw", async () => {
  const { entry, result } = await run("noncompliant_output");
  assert.equal(result.code, HARNESS_CODES.INVALID_OUTPUT);
  assert.equal(result.detail, "INVALID_BPM");
  assert.equal(result.output, null);
  assert.equal(entry.adapters.executor.calls.execute, 1);
  assert.equal(entry.adapters.executor.calls.dispose, 1);
  assert.equal(result.cleanup.tempDirRemoved, true);
  assertNoSecrets(result);
});

test("ffprobe expectedSha256 不匹配：probe/executor 均不调用，仍清理", async () => {
  const { entry, result } = await run("probe_identity_mismatch");
  assert.equal(result.code, HARNESS_CODES.PROBE_IDENTITY_MISMATCH);
  assert.equal(result.detail, "expected_sha256_mismatch");
  assert.equal(entry.adapters.probe.calls, 0);
  assert.equal(entry.adapters.executor.calls.execute, 0);
  assert.equal(entry.adapters.executor.calls.dispose, 1);
  assert.equal(result.cleanup.tempDirRemoved, true);
  assert.equal(result.cleanup.ok, true);
});

test("raw stderr/exit 缺口：adapter 携带 SECRET 也不进入结果，明确标 available=false", async () => {
  const { result } = await run("raw_error_redaction");
  assert.equal(result.code, HARNESS_CODES.ENGINE_FAILED);
  assert.equal(result.rawEvidence.available, false);
  assert.equal(result.rawEvidence.exitCode, "adapter_postcondition_only");
  assert.equal(result.output, null);
  assertNoSecrets(result);
});

test("真实执行 gate：mode=real 在 adapter/文件系统副作用前拒绝，环境变量无后门", async () => {
  const previous = process.env.SHIGUANG_T13I_REAL_ENGINE;
  process.env.SHIGUANG_T13I_REAL_ENGINE = "1";
  try {
    const { entry, result } = await run("real_execution_refusal");
    assert.equal(result.code, HARNESS_CODES.UNAUTHORIZED_REAL_EXECUTION);
    assert.equal(result.sideEffects.tempDirCreated, false);
    assert.equal(result.sideEffects.adapterMethodsCalled, 0);
    assert.deepEqual(entry.poisonCalls, { lease: 0, install: 0, execute: 0, dispose: 0, probe: 0 });
  } finally {
    if (previous === undefined) delete process.env.SHIGUANG_T13I_REAL_ENGINE;
    else process.env.SHIGUANG_T13I_REAL_ENGINE = previous;
  }
});

test("安装 gate：install.requested=true 在副作用前 INSTALL_NOT_AUTHORIZED", async () => {
  const { entry, result } = await run("install_refusal");
  assert.equal(result.code, HARNESS_CODES.INSTALL_NOT_AUTHORIZED);
  assert.equal(result.sideEffects.tempDirCreated, false);
  assert.deepEqual(entry.poisonCalls, { lease: 0, install: 0, execute: 0, dispose: 0, probe: 0 });
});

test("预算改写 gate：dataDirBudgetBytes 覆盖被拒，不引入 job-only/新上限", async () => {
  const { entry, result } = await run("budget_override_refusal");
  assert.equal(result.code, HARNESS_CODES.INVALID_REQUEST);
  assert.equal(result.sideEffects.tempDirCreated, false);
  assert.equal(result.budget.legacyDataDirBudgetApproved, false);
  assert.deepEqual(entry.poisonCalls, { lease: 0, install: 0, execute: 0, dispose: 0, probe: 0 });
});

test("只接受私有 membership fake；真实 adapter 形状在文件写入前拒绝", async () => {
  const entry = createCase("normal");
  const unbranded = {
    lease: { withRunLease: async () => null, postcondition: () => ({}) },
    executor: { execute: async () => "{}", dispose: async () => {}, postcondition: () => ({}) },
    probe: { probe: async () => ({}), postcondition: () => ({}) },
  };
  const result = await runProtocolHarness(entry.scenario, unbranded);
  assert.equal(result.code, HARNESS_CODES.ADAPTER_NOT_FAKE);
  assert.equal(result.sideEffects.tempDirCreated, false);
});

test("P2-1 复核反例：冻结 execute 后替换回调不被接收/调用，原能力仍完成 normal", async () => {
  const entry = createCase("normal");
  const original = entry.adapters.executor.execute;
  let replacedCalls = 0;
  let replacementRejected = false;
  try {
    entry.adapters.executor.execute = async function replaced(...args) {
      replacedCalls += 1;
      return original.apply(this, args);
    };
  } catch {
    replacementRejected = true;
  }
  assert.equal(replacementRejected, true, "frozen fake must reject method replacement");
  assert.equal(Object.isFrozen(entry.adapters.executor), true);
  const descriptor = Object.getOwnPropertyDescriptor(entry.adapters.executor, "execute");
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);

  const result = await runProtocolHarness(entry.scenario, entry.adapters);
  assert.equal(replacedCalls, 0, "brand must not admit replaced callbacks");
  assert.equal(result.code, HARNESS_CODES.OK);
  assert.equal(result.adapterCalls.executorExecute, 1);
});

test("P2-1 身份伪造：复制 symbol/原型/方法仍不在私有 membership，任意回调不执行", async () => {
  const genuine = createFakeExecutor({ raw: NORMAL_RAW });
  let forgedCalls = 0;
  const forged = {
    execute: async () => {
      forgedCalls += 1;
      return NORMAL_RAW;
    },
    dispose: async () => {
      forgedCalls += 1;
    },
    postcondition: () => {
      forgedCalls += 1;
      return genuine.postcondition();
    },
  };
  for (const symbol of Object.getOwnPropertySymbols(genuine)) {
    Object.defineProperty(forged, symbol, { value: genuine[symbol], enumerable: false });
  }
  Object.setPrototypeOf(forged, Object.getPrototypeOf(genuine));

  assert.equal(isFakeAdapter(genuine, "executor"), true);
  assert.equal(isFakeAdapter(forged, "executor"), false);
  assert.equal(isFakeAdapter({ ...genuine }, "executor"), false);

  const entry = createCase("normal");
  const result = await runProtocolHarness(
    entry.scenario,
    Object.freeze({ lease: entry.adapters.lease, executor: forged, probe: entry.adapters.probe }),
  );
  assert.equal(result.code, HARNESS_CODES.ADAPTER_NOT_FAKE);
  assert.equal(result.detail, "only_fakes_accepted");
  assert.equal(forgedCalls, 0);
  assert.equal(result.sideEffects.tempDirCreated, false);
});

test("P2-1 访问器 scenario.mode：读取 0 次 getter，拒绝渲染不回读，固定拒绝细节", async () => {
  const entry = createCase("normal");
  let getterCalls = 0;
  Object.defineProperty(entry.scenario, "mode", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return "real";
    },
  });
  const result = await runProtocolHarness(entry.scenario, entry.adapters);
  assert.equal(getterCalls, 0, "reject accessor scenario without invoking caller code");
  assert.equal(result.code, HARNESS_CODES.INVALID_REQUEST);
  assert.equal(result.detail, "scenario_accessor_mode");
  assert.equal(result.scenario, null);
  assert.equal(result.sideEffects.tempDirCreated, false);
  assert.equal(result.sideEffects.adapterMethodsCalled, 0);
});

test("P2-1 访问器 adapter 容器：不执行 executor getter，零副作用拒绝", async () => {
  const entry = createCase("normal");
  let getterCalls = 0;
  const adapters = { lease: entry.adapters.lease, probe: entry.adapters.probe };
  Object.defineProperty(adapters, "executor", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return entry.adapters.executor;
    },
  });
  const result = await runProtocolHarness(entry.scenario, adapters);
  assert.equal(getterCalls, 0, "adapter container accessor must not execute");
  assert.equal(result.code, HARNESS_CODES.ADAPTER_NOT_FAKE);
  assert.equal(result.detail, "adapter_accessor_executor");
  assert.equal(result.sideEffects.tempDirCreated, false);
});

test("P2-1 访问器 adapter 方法：不执行 execute getter，零副作用拒绝", async () => {
  const entry = createCase("normal");
  const executor = createFakeExecutor({
    raw: NORMAL_RAW,
    methodAccessor: "execute",
  });
  assert.equal(isFakeAdapter(executor, "executor"), true);
  const result = await runProtocolHarness(
    entry.scenario,
    Object.freeze({ lease: entry.adapters.lease, executor, probe: entry.adapters.probe }),
  );
  assert.equal(executor.calls.accessorExecute, 0, "adapter method getter must not execute");
  assert.equal(result.code, HARNESS_CODES.ADAPTER_NOT_FAKE);
  assert.equal(result.detail, "adapter_method_accessor_execute");
  assert.equal(result.sideEffects.tempDirCreated, false);
});

test("P2-1 访问器 postcondition 记录：不执行 getter，完整入口拒绝且零残留", async () => {
  const entry = createCase("normal");
  let getterCalls = 0;
  const stdio = { closed: true, stderrBytes: 0 };
  Object.defineProperty(stdio, "stdoutBytes", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });
  const executor = createFakeExecutor({
    raw: NORMAL_RAW,
    postconditionOverride: {
      exit: { confirmed: true, code: 0, signal: null },
      job: { state: "cleaned", dirRemoved: true, ownerRemoved: true },
      processGroup: { own: true, groupGone: true, unknownDescendants: "declared_none" },
      stdio,
      dispose: { called: true, calls: 1, pending: false },
    },
  });
  const result = await runProtocolHarness(
    entry.scenario,
    Object.freeze({ lease: entry.adapters.lease, executor, probe: entry.adapters.probe }),
  );
  assert.equal(getterCalls, 0, "postcondition accessor must not execute");
  assert.equal(result.code, HARNESS_CODES.POSTCONDITION_FAILED);
  assert.equal(result.detail, "postcondition_missing");
  assert.equal(result.cleanup.tempDirRemoved, true);
  assertNoSecrets(result);
});

test("P2-2 复核反例：success 下 code7/SIGTERM/null/-1 全部拒绝，失败 scope 不要求零退出", () => {
  const raw = {
    exit: { confirmed: true, code: 7, signal: "SIGTERM" },
    job: { state: "cleaned", dirRemoved: true, ownerRemoved: true },
    processGroup: { own: true, groupGone: true, unknownDescendants: "declared_none" },
    stdio: { closed: true, stdoutBytes: null, stderrBytes: -1 },
    dispose: { called: true, calls: 1, pending: false },
  };
  const post = pickPostconditions(raw);
  const check = evaluatePostconditions(post, { success: true });
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes("success_exit_code_not_zero"));
  assert.ok(check.failures.includes("success_exit_signal_not_null"));
  assert.ok(check.failures.includes("stdout_bytes_not_safe_integer"));
  assert.ok(check.failures.includes("stderr_bytes_negative"));

  const failureCheck = evaluatePostconditions(post, { success: false });
  assert.equal(failureCheck.scope, "failure");
  assert.equal(failureCheck.ok, false);
  assert.equal(failureCheck.failures.includes("success_exit_code_not_zero"), false);
  assert.equal(failureCheck.failures.includes("success_exit_signal_not_null"), false);
});

test("P2-2 成功退出：非零 code / 非 null signal / 未 confirmed 分别经完整入口拒绝", async () => {
  const cases = [
    { name: "code7", exit: { confirmed: true, code: 7, signal: null }, detail: "success_exit_code_not_zero" },
    { name: "signal", exit: { confirmed: true, code: 0, signal: "SIGTERM" }, detail: "success_exit_signal_not_null" },
    { name: "signal_number", exit: { confirmed: true, code: 0, signal: 7 }, detail: "success_exit_signal_not_null" },
    {
      name: "signal_missing",
      exit: { confirmed: true, code: 0, signal: undefined },
      detail: "success_exit_signal_not_null",
    },
    { name: "unconfirmed", exit: { confirmed: false, code: 0, signal: null }, detail: "exit_not_confirmed" },
  ];
  for (const item of cases) {
    const executor = createFakeExecutor({ raw: NORMAL_RAW, successExit: item.exit });
    const { result } = await runWithExecutor("normal", executor);
    assert.equal(result.code, HARNESS_CODES.POSTCONDITION_FAILED, item.name);
    assert.ok(result.detail.includes(item.detail), `${item.name}: ${result.detail}`);
    assert.equal(result.cleanup.tempDirRemoved, true);
  }
});

test("P2-2 stdout 计数：null/missing/负/NaN/Infinity/超安全整数/超限逐项经完整入口拒绝", async () => {
  const cases = [
    { name: "null", stdio: { stdoutBytes: null }, detail: "stdout_bytes_not_safe_integer" },
    { name: "missing", omit: true, detail: "stdout_bytes_not_safe_integer" },
    { name: "negative", stdio: { stdoutBytes: -1 }, detail: "stdout_bytes_negative" },
    { name: "nan", stdio: { stdoutBytes: Number.NaN }, detail: "stdout_bytes_not_safe_integer" },
    { name: "infinity", stdio: { stdoutBytes: Number.POSITIVE_INFINITY }, detail: "stdout_bytes_not_safe_integer" },
    {
      name: "unsafe",
      stdio: { stdoutBytes: Number.MAX_SAFE_INTEGER + 1 },
      detail: "stdout_bytes_not_safe_integer",
    },
    { name: "over", stdio: { stdoutBytes: PROTOCOL_LIMITS.stdoutBytes + 1 }, detail: "stdout_bytes_over_budget" },
  ];
  for (const item of cases) {
    const executor = createFakeExecutor({
      raw: NORMAL_RAW,
      successStdio: item.stdio,
      omitSuccessStdoutBytes: item.omit === true,
    });
    const { result } = await runWithExecutor("normal", executor);
    assert.equal(result.code, HARNESS_CODES.POSTCONDITION_FAILED, item.name);
    assert.ok(result.detail.includes(item.detail), `${item.name}: ${result.detail}`);
    assert.equal(result.cleanup.tempDirRemoved, true);
  }
});

test("P2-2 stderr 计数：null/负/NaN/超限逐项经完整入口拒绝", async () => {
  const cases = [
    { name: "null", stdio: { stderrBytes: null }, detail: "stderr_bytes_not_safe_integer" },
    { name: "negative", stdio: { stderrBytes: -1 }, detail: "stderr_bytes_negative" },
    { name: "nan", stdio: { stderrBytes: Number.NaN }, detail: "stderr_bytes_not_safe_integer" },
    { name: "over", stdio: { stderrBytes: PROTOCOL_LIMITS.stderrBytes + 1 }, detail: "stderr_bytes_over_budget" },
  ];
  for (const item of cases) {
    const executor = createFakeExecutor({ raw: NORMAL_RAW, successStdio: item.stdio });
    const { result } = await runWithExecutor("normal", executor);
    assert.equal(result.code, HARNESS_CODES.POSTCONDITION_FAILED, item.name);
    assert.ok(result.detail.includes(item.detail), `${item.name}: ${result.detail}`);
    assert.equal(result.cleanup.tempDirRemoved, true);
  }
});

test("P2-1 异常形状：null/数组/缺槽位/adapter 非 fake 均在副作用前拒绝", async () => {
  const entry = createCase("normal");
  const shapes = [
    { label: "null", adapters: null, detail: "adapters_shape" },
    { label: "array", adapters: [], detail: "adapters_shape" },
    { label: "missing_executor", adapters: { lease: entry.adapters.lease, probe: entry.adapters.probe }, detail: "adapter_missing_executor" },
    {
      label: "null_executor",
      adapters: { lease: entry.adapters.lease, executor: null, probe: entry.adapters.probe },
      detail: "only_fakes_accepted",
    },
  ];
  for (const item of shapes) {
    const result = await runProtocolHarness(entry.scenario, item.adapters);
    assert.equal(result.code, HARNESS_CODES.ADAPTER_NOT_FAKE, item.label);
    assert.equal(result.detail, item.detail, item.label);
    assert.equal(result.sideEffects.tempDirCreated, false, item.label);
    assert.equal(result.sideEffects.adapterMethodsCalled, 0, item.label);
  }
});

test("P2-1 异常 postcondition 记录：缺字段即拒绝，仍 dispose/lease/清临时目录", async () => {
  const executor = createFakeExecutor({ raw: NORMAL_RAW, postconditionOverride: {} });
  const { result } = await runWithExecutor("normal", executor);
  assert.equal(result.code, HARNESS_CODES.POSTCONDITION_FAILED);
  assert.equal(result.detail, "postcondition_missing");
  assert.equal(result.cleanup.tempDirRemoved, true);
  assert.equal(result.cleanup.leaseReleased, true);
});

test("临时目录无残留：canonical 场景跑完后无 t13i-protocol-harness-* 目录", async () => {
  const prefix = "t13i-protocol-harness-";
  const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix)));
  for (const name of ["normal", "timeout", "cleanup_failure", "noncompliant_output"]) {
    await run(name);
  }
  const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix) && !before.has(name));
  assert.deepEqual(after, []);
});

// ── round3 P2：retained constructor options ──────────────────────────────────

function normalAdaptersWith(overrides = {}) {
  const entry = createCase("normal");
  return {
    entry,
    adapters: Object.freeze({
      lease: overrides.lease ?? entry.adapters.lease,
      executor: overrides.executor ?? entry.adapters.executor,
      probe: overrides.probe ?? entry.adapters.probe,
    }),
  };
}

test("P3 原反例：构造后给 caller options 加 hang getter，getter 0 次且 normal 仍 OK", async () => {
  const options = { raw: NORMAL_RAW };
  const executor = createFakeExecutor(options);
  let getterCalls = 0;
  for (const key of ["hang", "cleanupFailure", "throwCode", "raw", "successExit", "successStdio"]) {
    Object.defineProperty(options, key, {
      configurable: true,
      get() {
        getterCalls += 1;
        return key === "hang" || key === "cleanupFailure";
      },
    });
  }
  const { entry, adapters } = normalAdaptersWith({ executor });
  const result = await runProtocolHarness(entry.scenario, adapters);
  assert.equal(getterCalls, 0, "fake must not retain caller options that inject callbacks after registration");
  assert.equal(result.code, HARNESS_CODES.OK);
  assert.equal(result.adapterCalls.executorExecute, 1);
  assert.equal(result.cleanup.tempDirRemoved, true);
  assert.equal(Object.isFrozen(options), false, "caller options must keep caller ownership");
});

test("P3 嵌套记录构造后 mutation：descriptor/successExit/successStdio/probe result 均不生效", async () => {
  const entry = createCase("normal");
  const descriptor = { ...makeDescriptor() };
  const lease = createFakeLease({ descriptor, releaseFailure: false });
  descriptor.binarySha256 = "0".repeat(64);
  descriptor.version = "9.9.9";

  const successExit = { confirmed: true, code: 0, signal: null };
  const successStdio = { closed: true, stderrBytes: 0 };
  const executor = createFakeExecutor({ raw: NORMAL_RAW, successExit, successStdio });
  successExit.code = 7;
  successExit.signal = "SIGTERM";
  successStdio.stdoutBytes = -1;
  successStdio.stderrBytes = PROTOCOL_LIMITS.stderrBytes + 1;

  const probeResult = { durationSec: 2 };
  const probe = createFakeProbe({ result: probeResult });
  probeResult.durationSec = -1;
  probeResult.format = 42;

  const adapters = Object.freeze({ lease, executor, probe });
  const result = await runProtocolHarness(entry.scenario, adapters);
  assert.equal(result.code, HARNESS_CODES.OK, result.detail ?? "unexpected failure");
  assert.equal(result.output.durationSec, 2);
  assert.equal(result.identity.descriptor.binarySha256, entry.scenario.descriptor.binarySha256);
  assert.equal(result.postconditions.exit.code, 0);
  assert.equal(result.postconditions.exit.signal, null);
  assert.equal(result.postconditions.stdio.stdoutBytes, Buffer.byteLength(NORMAL_RAW));
  assert.equal(result.postconditions.stdio.stderrBytes, 0);
  assert.equal(result.cleanup.tempDirRemoved, true);
});

test("P3 嵌套访问器：构造时固定拒绝，getter 0 次，不执行调用方代码", () => {
  let getterCalls = 0;
  const accessor = (value) => ({
    configurable: true,
    enumerable: true,
    get() {
      getterCalls += 1;
      return value;
    },
  });

  const rawOptions = {};
  Object.defineProperty(rawOptions, "raw", accessor(NORMAL_RAW));
  assert.throws(
    () => createFakeExecutor(rawOptions),
    (error) => error.code === HARNESS_CODES.INVALID_REQUEST && error.detail === "fake_executor_accessor_raw",
  );

  const descriptor = { ...makeDescriptor() };
  Object.defineProperty(descriptor, "binarySha256", accessor(makeDescriptor().binarySha256));
  assert.throws(
    () => createFakeLease({ descriptor }),
    (error) =>
      error.code === HARNESS_CODES.INVALID_REQUEST &&
      error.detail === "fake_lease_descriptor_accessor_binarySha256",
  );

  const successExit = {};
  Object.defineProperty(successExit, "code", accessor(0));
  assert.throws(
    () => createFakeExecutor({ raw: NORMAL_RAW, successExit }),
    (error) =>
      error.code === HARNESS_CODES.INVALID_REQUEST && error.detail === "fake_executor_success_exit_accessor_code",
  );

  const successStdio = {};
  Object.defineProperty(successStdio, "stdoutBytes", accessor(0));
  assert.throws(
    () => createFakeExecutor({ raw: NORMAL_RAW, successStdio }),
    (error) =>
      error.code === HARNESS_CODES.INVALID_REQUEST && error.detail === "fake_executor_success_stdio_accessor_stdoutBytes",
  );

  const probeResult = {};
  Object.defineProperty(probeResult, "durationSec", accessor(2));
  assert.throws(
    () => createFakeProbe({ result: probeResult }),
    (error) =>
      error.code === HARNESS_CODES.INVALID_REQUEST && error.detail === "fake_probe_result_accessor_durationSec",
  );

  assert.equal(getterCalls, 0, "constructor capture must reject accessors without invoking them");
});

test("P3 非法 raw 类型：构造时固定拒绝，不 String()/toString()/valueOf()", () => {
  let coercionCalls = 0;
  const evil = {
    toString() {
      coercionCalls += 1;
      return NORMAL_RAW;
    },
    valueOf() {
      coercionCalls += 1;
      return NORMAL_RAW;
    },
  };
  for (const raw of [42, null, [], {}, evil, Symbol("raw")]) {
    assert.throws(
      () => createFakeExecutor({ raw }),
      (error) => error.code === HARNESS_CODES.INVALID_REQUEST && error.detail === "fake_executor_raw_type",
    );
  }
  assert.equal(coercionCalls, 0, "invalid raw must not run caller coercion hooks");
});

test("P3 raw Buffer 复制：构造后改写 caller buffer 不影响输出", async () => {
  const source = Buffer.from(NORMAL_RAW, "utf8");
  const executor = createFakeExecutor({ raw: source });
  source.fill(0x41);
  const { entry, adapters } = normalAdaptersWith({ executor });
  const result = await runProtocolHarness(entry.scenario, adapters);
  assert.equal(result.code, HARNESS_CODES.OK);
  assert.equal(result.output.durationSec, 2);
});

test("P3 lease/probe 构造后 mutation：releaseFailure/failCode 不生效，构造时值仍生效", async () => {
  const entry = createCase("normal");
  const lease = createFakeLease({ descriptor: entry.scenario.descriptor, releaseFailure: false });
  const probe = createFakeProbe({ result: { durationSec: 2 } });

  const leaseOptions = { descriptor: entry.scenario.descriptor, releaseFailure: false };
  const lease2 = createFakeLease(leaseOptions);
  const probeOptions = {};
  const probe2 = createFakeProbe(probeOptions);
  leaseOptions.releaseFailure = true;
  probeOptions.failCode = HARNESS_CODES.PROBE_FAILED;
  const adapters = Object.freeze({ lease: lease2, executor: entry.adapters.executor, probe: probe2 });
  const ok = await runProtocolHarness(entry.scenario, adapters);
  assert.equal(ok.code, HARNESS_CODES.OK);
  assert.equal(ok.adapterCalls.leaseRelease, 1);
  assert.equal(ok.adapterCalls.probe, 1);

  const failingLease = createFakeLease({ descriptor: entry.scenario.descriptor, releaseFailure: true });
  const failedRelease = await runProtocolHarness(
    entry.scenario,
    Object.freeze({ lease: failingLease, executor: entry.adapters.executor, probe }),
  );
  assert.equal(failedRelease.code, HARNESS_CODES.LEASE_RELEASE_FAILED);

  const failingProbe = createFakeProbe({ failCode: HARNESS_CODES.PROBE_FAILED });
  const failedProbe = await runProtocolHarness(
    entry.scenario,
    Object.freeze({ lease, executor: entry.adapters.executor, probe: failingProbe }),
  );
  assert.equal(failedProbe.code, HARNESS_CODES.PROBE_FAILED);
  assert.equal(failedProbe.adapterCalls.executorExecute, 0);
  assert.equal(failedProbe.cleanup.tempDirRemoved, true);
});
