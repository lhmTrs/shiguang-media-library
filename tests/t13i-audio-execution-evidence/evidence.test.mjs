/**
 * T13I / AUDIO-EXECUTION-EVIDENCE-IMPL-20261024 合成证据矩阵（E01-E27）。
 *
 * 只使用临时 MEDIA_DATA_DIR、合成 Node 引擎夹具与注入的观测/清理钩子；
 * 不运行发行引擎/ffprobe/真实音频，不联网，不连接数据库或正式账户。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AudioExecutor, createAudioExecutorLauncherConfig } from "../../server/audio-executor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(path.dirname(HERE));
const FIXTURE = path.join(HERE, "fixtures", "engine.mjs");
const NODE = process.execPath;
const TEST_HOOKS = Symbol.for("dsh.audioExecutor.testHooks");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// executor 的预算计时器 unref()；测试进程没有服务句柄，需自保一个 ref 句柄，
// 否则 cleanup 预算耗尽用例会在等待期间被 Node 提前判定 event loop resolved。
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

async function makeRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-evidence-")));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

async function makeSnapshot(dataDir) {
  const base = path.join(dataDir, "audio-jobs");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.chmod(base, 0o700);
  const dir = path.join(base, `job-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  await fs.mkdir(dir, { mode: 0o700 });
  const filePath = path.join(dir, "source.bin");
  const bytes = Buffer.from("synthetic audio snapshot for evidence matrix");
  await fs.writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600);
  return { filePath, dir, sha256: sha256(bytes), bytes: bytes.length };
}

async function makeLauncher(root) {
  const file = path.join(root, `launcher-${crypto.randomBytes(4).toString("hex")}.sh`);
  await fs.writeFile(file, `#!/bin/sh\nexec "${NODE}" "$@"\n`, { mode: 0o700, flag: "wx" });
  await fs.chmod(file, 0o700);
  return file;
}

async function makeEngine(root, mode, options = {}) {
  const file = path.join(root, `engine-${mode}-${crypto.randomBytes(4).toString("hex")}.mjs`);
  const source =
    `import { run } from ${JSON.stringify(pathToFileURL(FIXTURE).href)};\n` +
    `await run(${JSON.stringify(mode)}, ${JSON.stringify(options)});\n`;
  await fs.writeFile(file, source, { mode: 0o700, flag: "wx" });
  await fs.chmod(file, 0o700);
  return file;
}

async function makeDescriptor(bin) {
  const body = await fs.readFile(bin);
  const stat = await fs.stat(bin);
  return {
    version: "1.0.0",
    platform: process.platform,
    arch: process.arch,
    binaryPath: bin,
    binarySha256: sha256(body),
    binarySize: stat.size,
    generation: crypto.randomBytes(16).toString("hex"),
  };
}

async function setup(t, { mode = "success", engineOptions = {}, limits = { wallMs: 5000 }, hooks } = {}) {
  const root = await makeRoot(t);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  const bin = await makeEngine(root, mode, engineOptions);
  const snapshot = await makeSnapshot(dataDir);
  const descriptor = await makeDescriptor(bin);
  const launcher = await makeLauncher(root);
  const config = createAudioExecutorLauncherConfig({ path: launcher, sha256: sha256(await fs.readFile(launcher)) });
  const options = { dataDir, launcher: config, limits };
  if (hooks) options[TEST_HOOKS] = hooks;
  const executor = new AudioExecutor(options);
  t.after(async () => {
    await executor.dispose().catch(() => {});
  });
  return { root, dataDir, bin, snapshot, descriptor, executor, launcher };
}

async function jobDirs(dataDir) {
  const root = path.join(dataDir, "audio-executor", "jobs");
  const entries = await fs.readdir(root).catch(() => []);
  return entries.filter((name) => name.startsWith("job-")).map((name) => path.join(root, name));
}

async function waitFor(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await delay(intervalMs);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function rejected(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}

const spinUntil = (atMs) => {
  while (performance.now() < atMs) {
    // 只为确定性越过 hardDeadline；不发起任何系统调用。
  }
};

function assertFrozen(value) {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) assertFrozen(item);
}

test("E01 旧 execute 成功兼容：仍返回 Buffer 且不带 executionEvidence", async (t) => {
  const { executor, dataDir, snapshot, descriptor } = await setup(t);
  const raw = await executor.execute(snapshot, descriptor);
  assert.ok(Buffer.isBuffer(raw));
  assert.equal(JSON.parse(raw.toString("utf8")).evidenceFixture, true);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("E02 证据模式成功：退出/close/stdio/group/directory 全部 confirmed", async (t) => {
  const { executor, dataDir, snapshot, descriptor } = await setup(t);
  const oldRaw = await executor.execute(snapshot, descriptor);
  const { raw, evidence } = await executor.executeWithEvidence(snapshot, descriptor);
  assert.ok(Buffer.isBuffer(raw));
  assert.deepEqual(raw, oldRaw);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.operation, "execute");
  assert.equal(evidence.outcome, "success");
  assert.equal(evidence.code, null);
  assert.equal(evidence.primaryCode, null);
  assert.equal(evidence.resourceUnknown, false);
  assert.deepEqual(evidence.unknownResources, []);
  assert.equal(evidence.identity.binarySha256, descriptor.binarySha256);
  assert.equal(evidence.identity.snapshotSha256, snapshot.sha256);
  assert.equal(evidence.identity.descriptorValidated, true);
  assert.equal(evidence.identity.snapshotValidated, true);
  assert.equal(evidence.timing.clock, "monotonic");
  assert.equal(evidence.timing.sourceDeadline, "executor");
  assert.equal(evidence.timing.wallBudgetMs, 5000);
  assert.equal(typeof evidence.timing.spawnAtMs, "number");
  assert.equal(typeof evidence.timing.closeAtMs, "number");
  assert.equal(evidence.timing.budgetExhausted, false);
  assert.equal(evidence.spawn.state, "confirmed");
  assert.equal(evidence.spawn.reason, null);
  assert.equal(evidence.child.state, "exited");
  assert.equal(evidence.child.exitCode, 0);
  assert.equal(evidence.child.signal, null);
  assert.equal(evidence.child.closeSettled, true);
  assert.equal(evidence.child.pidObserved, true);
  assert.equal(evidence.stdio.stdout.state, "settled");
  assert.equal(evidence.stdio.stdout.final, true);
  assert.equal(evidence.stdio.stdout.observedBytes, raw.length);
  assert.equal(evidence.stdio.stdout.retainedBytes, raw.length);
  assert.equal(evidence.stdio.stdout.available, "buffer");
  assert.equal(evidence.stdio.stdout.truncated, false);
  assert.equal(evidence.stdio.stderr.final, true);
  assert.equal(evidence.stdio.stderr.retainedBytes, 0);
  assert.equal(evidence.stdio.stderr.available, "none");
  assert.equal(evidence.group.state, "reclaimed");
  assert.equal(evidence.group.confirmedBy, "main");
  assert.equal(evidence.group.membersObserved, 0);
  assert.equal(evidence.group.finalConfirm, "empty");
  assert.equal(evidence.group.escapedDescendants, "not-observable");
  assert.equal(evidence.directory.state, "removed");
  assert.equal(evidence.directory.marker, "written");
  assert.equal(evidence.directory.cleanupRan, true);
  assert.equal(evidence.directory.removalAttempted, true);
  assert.equal(evidence.directory.removalSettled, true);
  assert.equal(evidence.directory.postcondition, "absent");
  assert.equal(evidence.directory.reason, null);
  assert.equal(evidence.failure, null);
  assert.equal(evidence.instance.stateBefore, "ready");
  assert.equal(evidence.instance.faultedAfter, false);
  assert.deepEqual(evidence.handoff, {
    resourceUnknown: false,
    retainLeaseRequired: false,
    retryPolicy: "not-decided-by-executor",
  });
  assertFrozen(evidence);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("E03 非零退出：ENGINE_FAILED，保留 exitCode 与已清理事实", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, { mode: "nonzero" });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "ENGINE_FAILED");
  const ev = error.executionEvidence;
  assert.equal(ev.outcome, "failure");
  assert.equal(ev.code, "ENGINE_FAILED");
  assert.equal(ev.primaryCode, "ENGINE_FAILED");
  assert.equal(ev.child.exitCode, 7);
  assert.equal(ev.child.signal, null);
  assert.equal(ev.child.state, "exited");
  assert.equal(ev.directory.state, "removed");
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(ev.stdio.stdout.available, "none");
  assert.equal(ev.stdio.stdout.retainedBytes, 0);
  assert.deepEqual(error.evidence, {
    reason: "NONZERO_EXIT",
    spawn: "confirmed",
    closeSettled: true,
    resourceUnknown: false,
  });
});

test("E04 信号退出：child.state=signaled 且 signal=SIGTERM", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, { mode: "sigterm" });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "ENGINE_FAILED");
  const ev = error.executionEvidence;
  assert.equal(ev.child.exitCode, null);
  assert.equal(ev.child.signal, "SIGTERM");
  assert.equal(ev.child.state, "signaled");
});

test("E05 资源信号：SIGXCPU 映射 RESOURCE_LIMIT 且清理完成", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, { mode: "sigxcpu" });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "RESOURCE_LIMIT");
  const ev = error.executionEvidence;
  assert.equal(ev.child.signal, "SIGXCPU");
  assert.equal(ev.directory.state, "removed");
  assert.equal(ev.group.state, "reclaimed");
});

test("E06 stdout 超限：truncated 与 observed/retained 分离", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    mode: "stdout-flood",
    limits: { wallMs: 5000, stdoutBytes: 64 },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "OUTPUT_LIMIT");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "STDOUT_LIMIT");
  assert.equal(ev.stdio.stdout.truncated, true);
  assert.ok(ev.stdio.stdout.observedBytes > 64);
  assert.ok(ev.stdio.stdout.retainedBytes <= 64);
  assert.equal(ev.directory.state, "removed");
});

test("E07 stderr 超限：count-only，不返回正文也不做 bytes==retained", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    mode: "stderr-flood",
    limits: { wallMs: 5000, stderrBytes: 64 },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "OUTPUT_LIMIT");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "STDERR_LIMIT");
  assert.ok(ev.stdio.stderr.observedBytes > 64);
  assert.equal(ev.stdio.stderr.truncated, true);
  assert.equal(ev.stdio.stderr.retainedBytes, 0);
  assert.equal(ev.stdio.stderr.available, "none");
  assert.equal(error.message.includes("eeeeeeee"), false);
});

test("E08 wall timeout：WALL_DEADLINE，组与目录仍按既有控制流回收", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    mode: "sleep",
    limits: { wallMs: 3000, termGraceMs: 50 },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "TIMEOUT");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "WALL_DEADLINE");
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(ev.directory.state, "removed");
  assert.equal(typeof ev.timing.totalMs, "number");
  assert.ok(ev.timing.totalMs > 0);
});

test("E09 spawn 前取消：入口拒绝且无证据、无 job、不占 busy", async (t) => {
  const { executor, dataDir, snapshot, descriptor } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor, { signal: controller.signal }));
  assert.equal(error.code, "CANCELLED");
  assert.equal(error.executionEvidence, undefined);
  assert.equal(executor.busy, false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("E10 运行中取消：证据存在且组/目录不漏清理", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, { mode: "sleep", limits: { wallMs: 4000, termGraceMs: 50 } });
  const controller = new AbortController();
  const pending = executor.executeWithEvidence(snapshot, descriptor, { signal: controller.signal });
  await delay(120);
  controller.abort();
  const error = await rejected(pending);
  assert.equal(error.code, "CANCELLED");
  const ev = error.executionEvidence;
  assert.ok(ev);
  assert.equal(ev.failure.reason, "CALLER_ABORTED");
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(ev.directory.state, "removed");
});

test("E11 spawn 前预算不足：旧 evidence 原样，新证据 spawn=not-started", async (t) => {
  const { executor, dataDir, snapshot, descriptor } = await setup(t, { limits: { wallMs: 600 } });
  const legacy = await rejected(executor.execute(snapshot, descriptor));
  assert.equal(legacy.code, "TIMEOUT");
  assert.deepEqual(legacy.evidence, {
    reason: "NO_SPAWN_BUDGET",
    resourceUnknown: false,
    spawn: "not-created",
  });
  assert.equal(legacy.executionEvidence, undefined);

  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "NO_SPAWN_BUDGET");
  assert.equal(ev.failure.stage, "spawn");
  assert.equal(ev.spawn.state, "not-started");
  assert.equal(ev.child.state, "not-created");
  assert.equal(ev.directory.state, "removed");
  assert.equal(ev.resourceUnknown, false);
  assert.deepEqual(error.evidence, {
    reason: "NO_SPAWN_BUDGET",
    spawn: "not-created",
    resourceUnknown: false,
  });
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("E12 spawn deadline：spawn unknown、resourceUnknown、目录不得 removed", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    mode: "sleep",
    limits: { wallMs: 2700, termGraceMs: 1 },
    hooks: {
      afterSpawn() {
        spinUntil(performance.now() + 2800);
      },
    },
  });
  const deadlineAtMs = performance.now() + 2600;
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor, { deadlineAtMs }));
  assert.equal(error.code, "TIMEOUT");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "SPAWN_DEADLINE");
  assert.equal(ev.spawn.state, "unknown");
  assert.equal(ev.resourceUnknown, true);
  assert.notEqual(ev.directory.state, "removed");
  assert.equal(error.evidence.reason, "SPAWN_DEADLINE");
  assert.equal(error.evidence.spawn, "unknown");
  const next = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(next.code, "EXECUTION_UNAVAILABLE");
  assert.equal(next.executionEvidence, undefined);
});

test("E13 close deadline：保留已观测前缀，final=false 且后续拒绝", async (t) => {
  const { executor, dataDir, snapshot, descriptor } = await setup(t, {
    mode: "sleep",
    limits: { wallMs: 2700, termGraceMs: 1 },
    hooks: {
      async afterSpawnConfirmed() {
        await delay(20);
        spinUntil(performance.now() + 2800);
      },
    },
  });
  const deadlineAtMs = performance.now() + 2600;
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor, { deadlineAtMs }));
  assert.equal(error.code, "TIMEOUT");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "CLOSE_DEADLINE");
  assert.equal(ev.child.closeSettled, false);
  assert.equal(ev.child.state, "unknown");
  assert.equal(typeof ev.stdio.stdout.observedBytes, "number");
  assert.equal(ev.stdio.stdout.final, false);
  assert.equal(ev.resourceUnknown, true);
  assert.ok(["unknown", "retained"].includes(ev.directory.state));
  assert.deepEqual(error.evidence, {
    reason: "CLOSE_DEADLINE",
    spawn: "confirmed",
    closeSettled: false,
    resourceUnknown: true,
  });
  const next = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(next.code, "EXECUTION_UNAVAILABLE");
  assert.equal(next.executionEvidence, undefined);
  await fs.rm(path.join(dataDir, "audio-executor"), { recursive: true, force: true });
});

test("E14/E26/E27 cleanup 预算耗尽：成功门拒绝；D5 收紧后旧 execute 同样拒绝", async (t) => {
  const never = () => new Promise(() => {});
  const { executor, snapshot, descriptor } = await setup(t, {
    limits: { wallMs: 5000, termGraceMs: 1 },
    hooks: { removeJob: never },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "EXECUTION_UNAVAILABLE");
  const ev = error.executionEvidence;
  assert.equal(ev.primaryCode, null);
  assert.equal(ev.failure.reason, "RESOURCE_UNKNOWN");
  assert.equal(ev.failure.overriddenBy, "gate");
  assert.equal(ev.failure.finalCode, "EXECUTION_UNAVAILABLE");
  assert.equal(ev.resourceUnknown, true);
  assert.deepEqual(ev.unknownResources, ["directory"]);
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(ev.child.closeSettled, true);
  assert.equal(ev.stdio.stdout.final, true);
  assert.equal(ev.directory.state, "unknown");
  assert.equal(ev.directory.removalSettled, false);
  assert.equal(ev.directory.postcondition, "unknown");
  assert.equal(ev.directory.reason, "CLEANUP_DEADLINE");
  assert.equal(ev.directory.cleanupRan, true);
  assert.equal(error.evidence.resourceUnknown, true);
  assert.equal(error.evidence.closeSettled, true);

  // D5（2026-10-25 用户批准收紧）：同一场景旧 execute 也不再返回 Buffer。
  // 失败路径的旧 error.evidence 形状不变；旧入口不暴露新的 executionEvidence。
  const { executor: legacyExecutor, snapshot: legacySnapshot, descriptor: legacyDescriptor } = await setup(t, {
    limits: { wallMs: 5000, termGraceMs: 1 },
    hooks: { removeJob: never },
  });
  const legacyError = await rejected(legacyExecutor.execute(legacySnapshot, legacyDescriptor));
  assert.equal(legacyError.code, "EXECUTION_UNAVAILABLE");
  assert.deepEqual(legacyError.evidence, { reason: "RESOURCE_UNKNOWN", resourceUnknown: true });
  assert.equal("executionEvidence" in legacyError, false, "旧入口不暴露新证据对象");
});

test("E14b 原本失败 + cleanup 预算耗尽：最终码保持原码，聚合 unknown 升级", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    mode: "nonzero",
    limits: { wallMs: 5000, termGraceMs: 1 },
    hooks: { removeJob: () => new Promise(() => {}) },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "ENGINE_FAILED");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "NONZERO_EXIT");
  assert.equal(ev.failure.finalCode, "ENGINE_FAILED");
  assert.equal(ev.resourceUnknown, true);
  assert.equal(ev.directory.state, "unknown");
  assert.equal(ev.directory.reason, "CLEANUP_DEADLINE");
  assert.equal(error.evidence.reason, "NONZERO_EXIT");
  assert.equal(error.evidence.resourceUnknown, true);
  assert.equal(error.evidence.closeSettled, true);
});

test("E15 cleanup 失败：CLEANUP_ERROR，目录 present/retained", async (t) => {
  const { executor, dataDir, snapshot, descriptor } = await setup(t, { mode: "corrupt-owner" });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "EXECUTION_UNAVAILABLE");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "CLEANUP_ERROR");
  assert.equal(ev.failure.overriddenBy, "cleanup");
  assert.equal(ev.failure.primaryCode, null);
  assert.equal(ev.directory.removalSettled, true);
  assert.ok(["retained", "unknown"].includes(ev.directory.state));
  assert.ok(["present", "unknown"].includes(ev.directory.postcondition));
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(error.evidence.resourceUnknown, true);
  assert.equal(error.evidence.closeSettled, true);
  await fs.rm(path.join(dataDir, "audio-executor"), { recursive: true, force: true });
});

test("E16a 主路径组残留：GROUP_UNKNOWN，清理跳过且不写 removed/retained", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    hooks: {
      observeGroup(pid, timeoutMs, call) {
        return call === 1
          ? { pids: [4242], reliable: true, observation: "kill0+pgrep" }
          : { pids: [], reliable: true, observation: "kill0+pgrep" };
      },
    },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "EXECUTION_UNAVAILABLE");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "GROUP_UNKNOWN");
  assert.equal(ev.group.state, "unknown");
  assert.equal(ev.group.failureSource, "main-leftover");
  assert.equal(ev.group.membersObserved, 1);
  assert.equal(ev.group.finalConfirm, "timeout");
  assert.equal(ev.directory.cleanupRan, false);
  assert.equal(ev.directory.state, "unknown");
  assert.equal(ev.directory.postcondition, "not-checked");
  assert.equal(ev.directory.reason, "CLEANUP_SKIPPED_UNKNOWN");
  assert.equal(ev.resourceUnknown, true);
  assert.deepEqual(error.evidence, {
    reason: "GROUP_UNKNOWN",
    spawn: "confirmed",
    closeSettled: true,
    resourceUnknown: true,
  });
});

test("E16b 仅 finally 组失败但目录已删：group unknown 与 directory removed 并存", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    hooks: {
      observeGroup(pid, timeoutMs, call) {
        return call === 1
          ? { pids: [], reliable: true, observation: "kill0+pgrep" }
          : { pids: [4243], reliable: true, observation: "kill0+pgrep" };
      },
    },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "EXECUTION_UNAVAILABLE");
  const ev = error.executionEvidence;
  assert.equal(ev.group.state, "unknown");
  assert.equal(ev.group.failureSource, "finally-leftover");
  assert.equal(ev.directory.state, "removed");
  assert.equal(ev.directory.postcondition, "absent");
  assert.equal(ev.child.closeSettled, true);
  assert.equal(ev.resourceUnknown, true);
  assert.deepEqual(ev.unknownResources, ["group"]);
  assert.equal(ev.failure.primaryCode, null);
  assert.equal(ev.failure.overriddenBy, "group");
  assert.equal(ev.failure.stage, "finalize");
  assert.deepEqual(error.evidence, {
    reason: "GROUP_UNKNOWN",
    spawn: "confirmed",
    closeSettled: true,
    resourceUnknown: true,
  });
});

test("E17 迟到 spawn：证据保持 unknown，迟到子进程被尽力 SIGKILL", async (t) => {
  const pidFile = path.join(os.tmpdir(), `t13i-late-${crypto.randomBytes(6).toString("hex")}.pid`);
  t.after(async () => {
    await fs.rm(pidFile, { force: true }).catch(() => {});
  });
  const { executor, snapshot, descriptor } = await setup(t, {
    mode: "sleep-pid",
    engineOptions: { pidFile },
    limits: { wallMs: 2700, termGraceMs: 1 },
    hooks: {
      afterSpawn() {
        spinUntil(performance.now() + 2800);
      },
    },
  });
  const deadlineAtMs = performance.now() + 2600;
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor, { deadlineAtMs }));
  assert.equal(error.code, "TIMEOUT");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "SPAWN_DEADLINE");
  assert.equal(ev.spawn.state, "unknown");
  assert.equal(ev.resourceUnknown, true);
  const pidText = await waitFor(async () => {
    try {
      return await fs.readFile(pidFile, "utf8");
    } catch {
      return null;
    }
  });
  const pid = Number(pidText);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  await waitFor(async () => !pidAlive(pid));
  const next = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(next.code, "EXECUTION_UNAVAILABLE");
  assert.equal(next.executionEvidence, undefined);
});

test("E18 证据冻结：返回后迟到事件不回写，故障后入口拒绝无证据", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t);
  const { evidence } = await executor.executeWithEvidence(snapshot, descriptor);
  const snapshotJson = JSON.stringify(evidence);
  assertFrozen(evidence);
  await delay(120);
  assert.equal(JSON.stringify(evidence), snapshotJson);

  const { executor: faulty, snapshot: faultySnapshot, descriptor: faultyDescriptor } = await setup(t, {
    mode: "corrupt-owner",
  });
  const first = await rejected(faulty.executeWithEvidence(faultySnapshot, faultyDescriptor));
  assert.ok(first.executionEvidence);
  const second = await rejected(faulty.executeWithEvidence(faultySnapshot, faultyDescriptor));
  assert.equal(second.code, "EXECUTION_UNAVAILABLE");
  assert.equal(second.executionEvidence, undefined);
});

test("E19 v1 options：capture/未知键固定 INVALID_REQUEST，不占槽位", async (t) => {
  const { executor, dataDir, snapshot, descriptor } = await setup(t);
  for (const extra of [
    { capture: { stdout: "never" } },
    { stdout: "never" },
    { stderr: "bounded" },
    { maxStderrBytes: 1 },
    { anything: true },
  ]) {
    const error = await rejected(executor.executeWithEvidence(snapshot, descriptor, extra));
    assert.equal(error.code, "INVALID_REQUEST");
    assert.equal(error.executionEvidence, undefined);
    assert.equal(executor.busy, false);
  }
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("E20 脱敏与尺寸：无路径/token/PID 数值/stderr 正文，JSON≤8KiB", async (t) => {
  const { root, dataDir, bin, snapshot, descriptor, executor } = await setup(t);
  const { evidence } = await executor.executeWithEvidence(snapshot, descriptor);
  const json = JSON.stringify(evidence);
  assert.ok(Buffer.byteLength(json) <= 8 * 1024);
  for (const secret of [root, dataDir, bin, snapshot.filePath, "synthetic-stderr-secret"]) {
    assert.equal(json.includes(secret), false);
  }
  assert.equal(/"pid"\s*:/.test(json), false);
  assert.equal(/"pgid"\s*:/i.test(json), false);
  assert.equal(Buffer.isBuffer(evidence), false);
  assert.deepEqual(JSON.parse(json), evidence);
  assertFrozen(evidence);
});

test("E21 caller deadline 更早：sourceDeadline=caller，清理按剩余预算", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, { mode: "sleep", limits: { wallMs: 5000 } });
  const deadlineAtMs = performance.now() + 3000;
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor, { deadlineAtMs }));
  assert.equal(error.code, "TIMEOUT");
  const ev = error.executionEvidence;
  assert.equal(ev.timing.sourceDeadline, "caller");
  assert.ok(ev.timing.hardDeadlineOffsetMs < 5000);
  assert.equal(ev.failure.reason, "WALL_DEADLINE");
  assert.equal(ev.directory.state, "removed");
});

test("E22 入口拒绝：disposed/faulted/busy/非法 options 均无证据", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t);
  const invalid = await rejected(executor.executeWithEvidence(snapshot, descriptor, { deadlineAtMs: "soon" }));
  assert.equal(invalid.code, "INVALID_REQUEST");
  assert.equal(invalid.executionEvidence, undefined);

  const { executor: disposed, snapshot: s2, descriptor: d2 } = await setup(t);
  await disposed.dispose();
  const gone = await rejected(disposed.executeWithEvidence(s2, d2));
  assert.equal(gone.code, "EXECUTION_UNAVAILABLE");
  assert.equal(gone.executionEvidence, undefined);

  const { executor: busyExecutor, snapshot: s3, descriptor: d3 } = await setup(t, {
    mode: "sleep",
    limits: { wallMs: 5000, termGraceMs: 50 },
  });
  const controller = new AbortController();
  const running = busyExecutor.executeWithEvidence(s3, d3, { signal: controller.signal });
  try {
    await delay(80);
    const busy = await rejected(busyExecutor.executeWithEvidence(s3, d3));
    assert.equal(busy.code, "EXECUTION_BUSY");
    assert.equal(busy.executionEvidence, undefined);
    assert.equal(busyExecutor.busy, true);
  } finally {
    controller.abort();
    await rejected(running);
  }
});

test("E23 pgrep 不可靠 fallback：不得写 reclaimed，只能 unknown+error", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    hooks: {
      observeGroup() {
        return { pids: [], reliable: false, observation: "kill0" };
      },
    },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "EXECUTION_UNAVAILABLE");
  const ev = error.executionEvidence;
  assert.equal(ev.group.state, "unknown");
  assert.equal(ev.group.finalConfirm, "error");
  assert.equal(ev.failure.reason, "RESOURCE_UNKNOWN");
  assert.equal(ev.failure.overriddenBy, "gate");
  assert.equal(ev.directory.state, "removed");
  assert.equal(ev.resourceUnknown, true);
  const next = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(next.code, "EXECUTION_UNAVAILABLE");
  assert.equal(next.executionEvidence, undefined);
});

test("E24 旧错误 evidence 回归：NO_SPAWN_BUDGET/CLOSE_DEADLINE/GROUP_UNKNOWN 对象值原样", async (t) => {
  {
    const { executor, snapshot, descriptor } = await setup(t, { limits: { wallMs: 600 } });
    const error = await rejected(executor.execute(snapshot, descriptor));
    assert.equal(error.executionEvidence, undefined);
    assert.deepEqual(error.evidence, {
      reason: "NO_SPAWN_BUDGET",
      resourceUnknown: false,
      spawn: "not-created",
    });
  }
  {
    const { executor, snapshot, descriptor } = await setup(t, {
      mode: "sleep",
      limits: { wallMs: 2700, termGraceMs: 1 },
      hooks: {
        async afterSpawnConfirmed() {
          await delay(20);
          spinUntil(performance.now() + 2800);
        },
      },
    });
    const deadlineAtMs = performance.now() + 2600;
    const error = await rejected(executor.execute(snapshot, descriptor, { deadlineAtMs }));
    assert.equal(error.executionEvidence, undefined);
    assert.deepEqual(error.evidence, {
      reason: "CLOSE_DEADLINE",
      resourceUnknown: true,
      closeSettled: false,
    });
  }
  {
    const { executor, snapshot, descriptor } = await setup(t, {
      hooks: {
        observeGroup(pid, timeoutMs, call) {
          return call === 1
            ? { pids: [4244], reliable: true, observation: "kill0+pgrep" }
            : { pids: [], reliable: true, observation: "kill0+pgrep" };
        },
      },
    });
    const error = await rejected(executor.execute(snapshot, descriptor));
    assert.equal(error.executionEvidence, undefined);
    assert.deepEqual(error.evidence, {
      reason: "GROUP_UNKNOWN",
      resourceUnknown: true,
      closeSettled: true,
    });
  }
});

test("E25 合并优先级：早期 resourceUnknown=false 被最终 true 覆盖，reason/spawn 保留", async (t) => {
  const { executor, snapshot, descriptor } = await setup(t, {
    limits: { wallMs: 2650 },
    hooks: { removeJob: () => new Promise(() => {}) },
  });
  const error = await rejected(executor.executeWithEvidence(snapshot, descriptor));
  assert.equal(error.code, "TIMEOUT");
  const ev = error.executionEvidence;
  assert.equal(ev.failure.reason, "NO_SPAWN_BUDGET");
  assert.equal(ev.spawn.state, "not-started");
  assert.equal(ev.directory.state, "unknown");
  assert.equal(ev.resourceUnknown, true);
  assert.deepEqual(error.evidence, {
    reason: "NO_SPAWN_BUDGET",
    spawn: "not-created",
    resourceUnknown: true,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(error.evidence, "closeSettled"), false);
  assertFrozen(ev);
});

// 独立验收 P2-1 原反例（probe-body.mjs）逐字保留逻辑/断言；仅把 gate 用例的
// wallMs 从 2800 调到 5000，避免与 P2-2 相同的运行预算不足，保证确实到达成功门。
test('reviewer: gate failure must not advertise returned raw Buffer', async t=>{
 const {executor,snapshot,descriptor}=await setup(t,{limits:{wallMs:5000,termGraceMs:1},hooks:{removeJob:()=>new Promise(()=>{})}});
 const error=await rejected(executor.executeWithEvidence(snapshot,descriptor));
 console.log('REVIEWER_GATE',JSON.stringify({code:error.code,stdout:error.executionEvidence.stdio.stdout,hasRaw:Object.hasOwn(error,'raw')}));
 assert.equal(error.executionEvidence.stdio.stdout.available,'none');
 assert.equal(error.executionEvidence.stdio.stdout.retainedBytes,0);
});
test('reviewer: finally group failure must not advertise returned raw Buffer', async t=>{
 const {executor,snapshot,descriptor}=await setup(t,{hooks:{observeGroup:(_pid,_budget,call)=>({pids:call===1?[]:[4243],reliable:true,observation:'kill0+pgrep'})}});
 const error=await rejected(executor.executeWithEvidence(snapshot,descriptor));
 console.log('REVIEWER_FINALLY',JSON.stringify({code:error.code,stdout:error.executionEvidence.stdio.stdout,directory:error.executionEvidence.directory.state,hasRaw:Object.hasOwn(error,'raw')}));
 assert.equal(error.executionEvidence.stdio.stdout.available,'none');
 assert.equal(error.executionEvidence.stdio.stdout.retainedBytes,0);
});
