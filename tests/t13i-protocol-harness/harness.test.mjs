/**
 * T13I-PROTOCOL-HARNESS-20261024：注入式 protocol harness 自测。
 *
 * 只跑合成 fake adapter + 临时目录；不启动引擎/真实 clang/ffprobe，不读真实素材，
 * 不联网，不安装/解包/下载，不改产品模块。测试入口与 CLI 共用同一个
 * runProtocolHarness。
 */
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import {
  PROTOCOL_LIMITS,
  computeExecutorDeadline,
  createMonotonicClock,
  HARNESS_CODES,
} from "./contracts.mjs";
import { runProtocolHarness } from "./harness.mjs";
import { createCase } from "./scenarios.mjs";

async function run(name) {
  const entry = createCase(name);
  const result = await runProtocolHarness(entry.scenario, entry.adapters);
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

test("只接受品牌 fake；真实 adapter 形状在文件写入前拒绝", async () => {
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

test("临时目录无残留：canonical 场景跑完后无 t13i-protocol-harness-* 目录", async () => {
  const prefix = "t13i-protocol-harness-";
  const before = new Set((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix)));
  for (const name of ["normal", "timeout", "cleanup_failure", "noncompliant_output"]) {
    await run(name);
  }
  const after = (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith(prefix) && !before.has(name));
  assert.deepEqual(after, []);
});
