/**
 * T13I / AUDIO-PROBE-GUARD：独立 AudioProbe 严格入口（probeGuarded）定向矩阵 G01–G15。
 *
 * 只用临时目录、合成 Node probe 工具、本机 shell launcher 与合成观测钩子；
 * 不运行真实 ffprobe/发行分析引擎，不读真实素材，不联网，不连数据库或服务器。
 * 每个用例自有临时根；unknown/held 现场（G10–G12）只在该根内保留，测试结束随根清理。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  AudioProbe,
  AudioProbeError,
  PROBE_CODES,
  createAudioProbeToolConfig,
  resolvePinnedAudioProbeTool,
} from "../../server/audio-probe.mjs";
import {
  AudioExecutor,
  AUDIO_PROBE_EVIDENCE,
  AUDIO_PROBE_TOOL_BINDING,
  createAudioExecutorLauncherConfig,
} from "../../server/audio-executor.mjs";
import { AudioEngine } from "../../server/audio-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");
const NODE = process.execPath;
const TEST_HOOKS = Symbol.for("dsh.audioExecutor.testHooks");
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const RELEASE = Object.freeze({
  id: "test-audio-engine",
  version: "1.0.0",
  platform: process.platform,
  arch: process.arch,
  url: "https://example.invalid/archive.tar.gz",
  sha256: "a".repeat(64),
  binary: "audio-analyze",
  size: 1024,
  archiveMaxBytes: 4096,
  extractedMaxBytes: 8192,
  maxEntries: 8,
});

// executor/engine 的预算计时器都 unref()；测试进程需要自己保一个 ref 句柄。
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));

async function exists(target) {
  return (await fs.lstat(target).catch(() => null)) !== null;
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

async function jobDirs(dataDir) {
  const root = path.join(dataDir, "audio-executor", "jobs");
  const entries = await fs.readdir(root).catch(() => []);
  return entries.filter((name) => name.startsWith("job-")).map((name) => path.join(root, name));
}

async function makeRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-probe-guard-")));
  t.after(async () => {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

async function makeLauncher(root) {
  const file = path.join(root, `launcher-${crypto.randomBytes(4).toString("hex")}.sh`);
  await fs.writeFile(file, `#!/bin/sh\nexec "${NODE}" "$@"\n`, { mode: 0o700, flag: "wx" });
  await fs.chmod(file, 0o700);
  return file;
}

async function makeToolPath(root, fixture) {
  const source = await fs.readFile(path.join(FIXTURES, fixture));
  const file = path.join(root, `tool-${fixture}-${crypto.randomBytes(4).toString("hex")}.mjs`);
  await fs.writeFile(file, source, { mode: 0o600, flag: "wx" });
  await fs.chmod(file, 0o600);
  return file;
}

async function makeSnapshot(dataDir) {
  const base = path.join(dataDir, "audio-jobs");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.chmod(base, 0o700);
  const dir = path.join(base, `job-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  await fs.mkdir(dir, { mode: 0o700 });
  const filePath = path.join(dir, "source.wav");
  const bytes = Buffer.from("synthetic snapshot for probe guard matrix");
  await fs.writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600);
  return { filePath, dir, sha256: sha256(bytes), bytes: bytes.length };
}

/** 共享环境：同一临时根 / dataDir / engine，可按需建多个 executor+adapter。 */
async function makeWorld(t, { engineHooks } = {}) {
  const root = await makeRoot(t);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  const launcherPath = await makeLauncher(root);
  const launcher = createAudioExecutorLauncherConfig({
    path: launcherPath,
    sha256: sha256(await fs.readFile(launcherPath)),
  });
  const engine = new AudioEngine(dataDir, { release: RELEASE, hooks: engineHooks });
  const snapshot = await makeSnapshot(dataDir);
  const lockRoot = path.join(dataDir, "engines", ".audio-install.lock");

  const makeProbe = async ({ fixture = "tool-ok.mjs", limits = { wallMs: 5000 }, executorHooks, pinned = true } = {}) => {
    const toolPath = await makeToolPath(root, fixture);
    const body = await fs.readFile(toolPath);
    const tool = pinned
      ? await resolvePinnedAudioProbeTool({ path: toolPath, version: "1.0.0", expectedSha256: sha256(body) })
      : createAudioProbeToolConfig({ path: toolPath, sha256: sha256(body), version: "1.0.0" });
    const options = { dataDir, launcher, probeTool: tool, limits };
    if (executorHooks) options[TEST_HOOKS] = executorHooks;
    const executor = new AudioExecutor(options);
    t.after(() => executor.dispose().catch(() => {}));
    const adapter = new AudioProbe({
      runner: executor,
      tool,
      withLifecycleScope: engine.withLifecycleScope.bind(engine),
    });
    return { tool, toolPath, executor, adapter };
  };

  return { root, dataDir, engine, launcher, snapshot, lockRoot, makeProbe };
}

async function setup(t, options = {}) {
  const world = await makeWorld(t, { engineHooks: options.engineHooks });
  const probe = await world.makeProbe(options);
  return { ...world, ...probe };
}

/**
 * 成功/普通失败路径的默认预算。executor 的终止+两次组确认 allowance 约 2650ms，
 * 4s 预算只剩约 850ms 真跑时间，并发跑测试时会被误判 TIMEOUT（测试预算问题，
 * 不是产品缺陷）。只有 G08/G10/G13 故意压预算，仍用手写值。
 */
const GUARD_BUDGET_MS = 8000;
const budget = () => performance.now() + GUARD_BUDGET_MS;

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AudioProbeError, `期望 AudioProbeError，实际 ${error?.name}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`期望以 ${code} 拒绝，实际成功`);
}

test("G01 正常成功：结果与证据分开、资源已回收、锁已释放", async (t) => {
  const { adapter, snapshot, dataDir, lockRoot } = await setup(t);
  const { probe, evidence } = await adapter.probeGuarded(snapshot, {
    deadlineAtMs: budget(),
  });

  assert.equal(probe.format, "wav");
  assert.equal(probe.channels, 2);
  assert.equal(probe.sampleRate, 44100);
  assert.equal(probe.totalSamples, 44100);
  assert.equal(Object.isFrozen(probe), true);
  assert.equal(Object.isFrozen(evidence), true);

  assert.equal(evidence.operation, "probe");
  assert.equal(evidence.outcome, "success");
  assert.equal(evidence.code, null);
  assert.equal(evidence.identity.toolPinSource, "configured");
  assert.equal(evidence.identity.matched, true);
  assert.equal(evidence.identity.toolSha256, evidence.identity.toolSha256.toLowerCase());
  assert.equal(evidence.identity.snapshotDigestSource, "declared");
  assert.equal(evidence.spawn.state, "confirmed");
  assert.equal(evidence.child.closeSettled, true);
  assert.equal(evidence.group.state, "reclaimed");
  assert.equal(evidence.directory.state, "removed");
  assert.equal(evidence.parse.state, "accepted");
  assert.equal(evidence.lease.state, "released");
  assert.equal(evidence.lease.retainRequested, false);
  assert.equal(evidence.resourceUnknown, false);
  assert.deepEqual(evidence.unknownResources, []);
  assert.equal(evidence.budget.releaseReserveMs, 500);

  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("G02 旧入口不变：旧 probe 不持 scope、不产证据、可在外层 scope 内运行", async (t) => {
  const { adapter, snapshot, engine } = await setup(t);
  const plain = await adapter.probe(snapshot);
  assert.equal(plain.format, "wav");
  assert.equal(plain.probeEvidence, undefined);

  const nested = await engine.withLifecycleScope(
    async () => adapter.probe(snapshot),
    { scope: "run", deadlineAtMs: budget() },
  );
  assert.equal(nested.format, "wav");
  assert.equal(nested.probeEvidence, undefined);
});

test("G03 身份变动：spawn 前摘要不符即拒绝，不 spawn、不持锁", async (t) => {
  const { adapter, toolPath, snapshot, dataDir, lockRoot } = await setup(t);
  await fs.writeFile(toolPath, "process.stdout.write('{}');\n", { mode: 0o600 });
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  const ev = error.probeEvidence;
  assert.equal(ev.outcome, "failure");
  assert.equal(ev.spawn.state, "not-started");
  assert.equal(ev.identity, null);
  assert.equal(ev.resourceUnknown, false);
  assert.equal(ev.lease.state, "released");
  assert.equal(error.evidence, undefined);
  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("G04a 未 pin 配置：严格入口拒绝，未取锁、不 spawn", async (t) => {
  const { adapter, snapshot, dataDir, lockRoot } = await setup(t, { pinned: false });
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  assert.equal(error.probeEvidence.lease.state, "not-acquired");
  assert.equal(error.probeEvidence.spawn.state, "not-started");
  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("G04b 绑定不符：adapter 与 runner 的 pinned 工具不一致 → INVALID_REQUEST", async (t) => {
  const world = await makeWorld(t);
  const first = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const second = await world.makeProbe({ fixture: "tool-slow.mjs" });
  const mismatched = new AudioProbe({
    runner: second.executor,
    tool: first.tool,
    withLifecycleScope: world.engine.withLifecycleScope.bind(world.engine),
  });
  const error = await expectCode(
    mismatched.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "INVALID_REQUEST",
  );
  assert.equal(error.probeEvidence.lease.state, "not-acquired");
  assert.equal(await exists(world.lockRoot), false);
  assert.deepEqual(await jobDirs(world.dataDir), []);
});

test("G05 并发 busy：第二个立即 PROBE_BUSY，不排队、不删他人锁，第一个仍成功", async (t) => {
  const world = await makeWorld(t);
  const slow = await world.makeProbe({ fixture: "tool-slow.mjs" });
  const quick = await world.makeProbe({ fixture: "tool-ok.mjs" });

  // 预算要留够：executor 的终止/两次组确认 allowance 约 2650ms，400ms 合成工具在
  // 4s 预算下只剩约 850ms，负载高时会 TIMEOUT（这是测试预算问题，不是产品缺陷）。
  const first = slow.adapter.probeGuarded(world.snapshot, { deadlineAtMs: performance.now() + 8000 });
  await waitFor(() => exists(world.lockRoot), { timeoutMs: 3000 });

  const startedAt = performance.now();
  const busy = await expectCode(
    quick.adapter.probeGuarded(world.snapshot, { deadlineAtMs: performance.now() + 8000 }),
    "PROBE_BUSY",
  );
  const waitedMs = performance.now() - startedAt;
  assert.ok(waitedMs < 1000, `BUSY 不应等待慢工具（实际 ${waitedMs.toFixed(0)}ms）`);
  assert.equal(busy.probeEvidence.lease.state, "not-acquired");
  assert.deepEqual(busy.probeEvidence.lease.pendingAtExit, []);
  assert.equal(busy.probeEvidence.resourceUnknown, false);
  assert.equal(await exists(world.lockRoot), true, "B 不得删除 A 的锁");

  const ok = await first;
  assert.equal(ok.evidence.outcome, "success");
  assert.equal(await exists(world.lockRoot), false);
});

test("G06 嵌套租约：外层 run scope 内调用得到 PROBE_BUSY，外层不受影响", async (t) => {
  const { adapter, engine, snapshot, dataDir, lockRoot } = await setup(t);
  let nestedEvidence = null;
  const outer = await engine.withLifecycleScope(
    async () => {
      const error = await expectCode(
        adapter.probeGuarded(snapshot, { deadlineAtMs: performance.now() + 3000 }),
        "PROBE_BUSY",
      );
      nestedEvidence = error.probeEvidence;
      return "outer-ok";
    },
    { scope: "run", deadlineAtMs: performance.now() + 3000 },
  );
  assert.equal(outer, "outer-ok");
  assert.equal(nestedEvidence.lease.state, "not-acquired");
  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);

  // 外层不是 faulted：同一引擎的后续 scope 仍可获取并释放。
  const after = await engine.withLifecycleScope(async () => "again", {
    scope: "probe",
    deadlineAtMs: performance.now() + 2000,
  });
  assert.equal(after, "again");
});

test("G07 取消：CANCELLED、清理已证实、租约已释放、不附 resourceUnknown", async (t) => {
  const { adapter, snapshot, dataDir, lockRoot } = await setup(t, { fixture: "tool-hang.mjs" });
  const controller = new AbortController();
  const pending = adapter.probeGuarded(snapshot, {
    signal: controller.signal,
    deadlineAtMs: budget(),
  });
  await delay(120);
  controller.abort();
  const error = await expectCode(pending, "CANCELLED");
  const ev = error.probeEvidence;
  assert.equal(ev.outcome, "failure");
  assert.equal(ev.child.closeSettled, true);
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(ev.directory.state, "removed");
  assert.equal(ev.lease.state, "released");
  assert.equal(ev.resourceUnknown, false);
  assert.equal(error.evidence, undefined);
  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("G08 超时：TIMEOUT、预算与释放预留如实、清理已证实", async (t) => {
  const { adapter, snapshot, dataDir, lockRoot } = await setup(t, { fixture: "tool-hang.mjs" });
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: performance.now() + 4000 }),
    "TIMEOUT",
  );
  const ev = error.probeEvidence;
  assert.ok(Math.abs(ev.budget.probeDeadlineOffsetMs - 3500) <= 100, `probe deadline ≈3500，实际 ${ev.budget.probeDeadlineOffsetMs}`);
  assert.equal(ev.budget.releaseReserveMs, 500);
  assert.ok(["confirmed", "not-started"].includes(ev.spawn.state));
  assert.ok(["removed", "not-created"].includes(ev.directory.state));
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(ev.child.closeSettled, true);
  assert.equal(ev.lease.state, "released");
  assert.equal(ev.resourceUnknown, false);
  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("G09 解析拒绝：PROBE_REJECTED、executor 资源仍已回收、不返回结果", async (t) => {
  const { adapter, snapshot, dataDir, lockRoot } = await setup(t, { fixture: "tool-videojson.mjs" });
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: budget() }),
    "PROBE_REJECTED",
  );
  const ev = error.probeEvidence;
  assert.equal(ev.parse.state, "rejected");
  assert.equal(ev.parse.code, "PROBE_REJECTED");
  assert.equal(ev.failure.stage, "parse");
  assert.equal(ev.failure.overriddenBy, "parse");
  assert.equal(ev.group.state, "reclaimed");
  assert.equal(ev.directory.state, "removed");
  assert.equal(ev.resourceUnknown, false);
  assert.equal(ev.lease.state, "released");
  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("G10 cleanup unknown：PROBE_UNAVAILABLE、retain 锁、目录与锁保留在自有根内", async (t) => {
  const { adapter, snapshot, dataDir, lockRoot } = await setup(t, {
    fixture: "tool-ok.mjs",
    executorHooks: { removeJob: () => new Promise(() => {}) },
  });
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: performance.now() + 4000 }),
    "PROBE_UNAVAILABLE",
  );
  const ev = error.probeEvidence;
  assert.ok(["retained", "unknown"].includes(ev.directory.state), `directory=${ev.directory.state}`);
  assert.equal(ev.resourceUnknown, true);
  assert.ok(ev.unknownResources.includes("directory"));
  assert.ok(ev.unknownResources.includes("lease"));
  assert.equal(ev.lease.state, "held");
  assert.equal(ev.lease.retainRequested, true);
  assert.equal(ev.budget.releaseAtMs, null);
  assert.equal(ev.handoff.retainLeaseRequired, true);
  assert.equal(error.evidence.resourceUnknown, true);
  assert.equal(await exists(lockRoot), true);
  assert.ok((await jobDirs(dataDir)).length > 0);
});

test("G11 租约释放失败：即使 probe 成功也不发布 success，锁保留", async (t) => {
  const { adapter, snapshot, lockRoot } = await setup(t, {
    fixture: "tool-ok.mjs",
    engineHooks: {
      scopeFs: (kind, run) => (kind === "release-rmdir" ? Promise.reject(new Error("synthetic")) : run()),
    },
  });
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  const ev = error.probeEvidence;
  assert.equal(ev.lease.state, "held");
  assert.equal(ev.lease.reason, "RELEASE_FAILED");
  assert.equal(ev.budget.releaseAtMs, null);
  assert.equal(ev.resourceUnknown, true);
  assert.equal(ev.handoff.retainLeaseRequired, true);
  assert.equal(ev.failure.stage, "lease");
  assert.equal(error.evidence.resourceUnknown, true);
  assert.equal(await exists(lockRoot), true);
});

test("G12 迟到组残留：不发布 success，group 记 unknown 并 retain 锁", async (t) => {
  const { adapter, snapshot, lockRoot } = await setup(t, {
    fixture: "tool-ok.mjs",
    executorHooks: {
      observeGroup: async (pid, _timeoutMs, call) =>
        call >= 2
          ? { pids: [pid + 1], reliable: true, observation: "kill0" }
          : { pids: [], reliable: true, observation: "kill0" },
    },
  });
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  const ev = error.probeEvidence;
  assert.equal(ev.group.state, "unknown");
  assert.equal(ev.resourceUnknown, true);
  assert.ok(ev.unknownResources.includes("group"));
  assert.equal(ev.lease.state, "held");
  assert.ok(["GROUP_UNKNOWN", "CLOSE_DEADLINE"].includes(ev.failure.reason), `reason=${ev.failure.reason}`);
  assert.equal(await exists(lockRoot), true);
});

test("G13 预算过近：取锁前 TIMEOUT，不创建 lock/job", async (t) => {
  const { adapter, snapshot, dataDir, lockRoot } = await setup(t);
  const error = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: performance.now() + 400 }),
    "TIMEOUT",
  );
  const ev = error.probeEvidence;
  assert.equal(ev.lease.state, "not-acquired");
  assert.equal(ev.resourceUnknown, false);
  assert.equal(ev.spawn.state, "not-started");
  assert.equal(ev.failure.reason, "INSUFFICIENT_BUDGET");
  assert.equal(await exists(lockRoot), false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("G14 同实例重入：第二次 PROBE_BUSY/PROBE_REENTRANT，不取锁、不占槽", async (t) => {
  const { adapter, snapshot, lockRoot } = await setup(t, { fixture: "tool-slow.mjs" });
  const first = adapter.probeGuarded(snapshot, { deadlineAtMs: performance.now() + 8000 });
  await delay(150);
  const second = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: performance.now() + 8000 }),
    "PROBE_BUSY",
  );
  assert.equal(second.probeEvidence.lease.reason, "PROBE_REENTRANT");
  assert.equal(second.probeEvidence.lease.state, "not-acquired");
  assert.equal(second.probeEvidence.resourceUnknown, false);

  const ok = await first;
  assert.equal(ok.evidence.outcome, "success");
  assert.equal(await exists(lockRoot), false);
});

test("G15 旧 probe 缺口未偷改：外部 run scope 下旧入口仍成功（本单只新增严格入口）", async (t) => {
  const { adapter, engine, snapshot } = await setup(t);
  const result = await engine.withLifecycleScope(
    async () => {
      const plain = await adapter.probe(snapshot);
      return plain;
    },
    { scope: "run", deadlineAtMs: budget() },
  );
  assert.equal(result.format, "wav");
  assert.equal(result.probeEvidence, undefined);
});

test("G16 非法选项/形状/接线：INVALID_REQUEST 带证据，且不取锁", async (t) => {
  const { adapter, executor, engine, tool, snapshot, lockRoot } = await setup(t);
  const missing = await expectCode(adapter.probeGuarded(snapshot, {}), "INVALID_REQUEST");
  assert.equal(missing.probeEvidence.lease.state, "not-acquired");
  const extra = await expectCode(
    adapter.probeGuarded(snapshot, { deadlineAtMs: budget(), argv: [] }),
    "INVALID_REQUEST",
  );
  assert.equal(extra.probeEvidence.lease.state, "not-acquired");
  assert.equal(PROBE_CODES.PROBE_BUSY, "PROBE_BUSY");
  assert.equal(await exists(lockRoot), false);

  // 缺 scope / runner 无证据 seam 都属于接线错误：取锁前 INVALID_REQUEST。
  const noScope = new AudioProbe({ runner: executor, tool });
  const noScopeError = await expectCode(
    noScope.probeGuarded(snapshot, { deadlineAtMs: budget() }),
    "INVALID_REQUEST",
  );
  assert.equal(noScopeError.probeEvidence.lease.state, "not-acquired");

  const noSeam = new AudioProbe({
    runner: { probe: async () => Buffer.from("{}") },
    tool,
    withLifecycleScope: engine.withLifecycleScope.bind(engine),
  });
  const noSeamError = await expectCode(
    noSeam.probeGuarded(snapshot, { deadlineAtMs: budget() }),
    "INVALID_REQUEST",
  );
  assert.equal(noSeamError.probeEvidence.lease.state, "not-acquired");
  assert.equal(await exists(lockRoot), false);
});

test("G17 证据封套：≤9KiB、无路径/PID/token、递归冻结；失败证据同样受限", async (t) => {
  const world = await makeWorld(t);
  const ok = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const success = await ok.adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() });

  const inspect = (evidence, secrets) => {
    const json = JSON.stringify(evidence);
    assert.ok(Buffer.byteLength(json, "utf8") <= 9 * 1024, `证据 ${Buffer.byteLength(json, "utf8")} 字节超过 9KiB`);
    assert.ok(json.length > 200, "证据不应是空壳");
    assert.ok(json.includes('"operation":"probe"'));
    for (const secret of secrets) {
      assert.equal(json.includes(secret), false, `证据泄露受限内容: ${secret}`);
    }
    assert.equal(json.includes('"ownerToken"'), false);
    assert.equal(/"pid":/.test(json), false);
    assert.equal(/"argv":/.test(json), false);
    const walk = (value) => {
      if (value === null || typeof value !== "object") return;
      assert.equal(Object.isFrozen(value), true);
      for (const item of Object.values(value)) walk(item);
    };
    walk(evidence);
  };

  inspect(success.evidence, [
    world.root,
    world.dataDir,
    ok.toolPath,
    world.snapshot.filePath,
    world.snapshot.dir,
    ".audio-install.lock",
    "owner.json",
    "audio-executor",
  ]);
  assert.equal(success.evidence.identity.toolSha256, ok.tool.pinnedSha256);

  // 失败/unknown 证据同样受限：仍不得出现路径、PID 数值或原始 stderr。
  const failing = await world.makeProbe({
    fixture: "tool-ok.mjs",
    executorHooks: { removeJob: () => new Promise(() => {}) },
  });
  const error = await expectCode(
    failing.adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  inspect(error.probeEvidence, [world.root, world.dataDir, failing.toolPath, world.snapshot.filePath]);
  assert.equal(error.probeEvidence.resourceUnknown, true);
});

/* ------------------------------------------------------------------ *
 * G18–G21：不盲信 runner（对抗性自检）。
 * 用同一个 engine scope + 真实锁，但 runner 自报证据/错误，用来验证 adapter
 * 自己的成功门、unknown 判定与脱敏，而不是复述 executor 的结论。
 * ------------------------------------------------------------------ */

const VALID_RAW = Buffer.from(
  JSON.stringify({
    format: { format_name: "wav", duration: "1.0" },
    streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "44100" }],
  }),
);

function fakeRunner(tool, { out, error } = {}) {
  const binding = Object.freeze({
    path: tool.path,
    sha256: tool.sha256,
    pinnedSha256: tool.pinnedSha256,
    identitySource: tool.identitySource,
    version: tool.version,
  });
  const runner = {
    probe: async () => {
      if (error) throw error;
      return out.raw;
    },
  };
  runner[AUDIO_PROBE_EVIDENCE] = async () => {
    if (error) throw error;
    return out;
  };
  runner[AUDIO_PROBE_TOOL_BINDING] = () => binding;
  return runner;
}

function claimedSuccessEvidence(tool, overrides = {}) {
  const stream = {
    state: "settled",
    observedBytes: 128,
    final: true,
    retainedBytes: 128,
    limitBytes: 65536,
    truncated: false,
    available: "buffer",
  };
  return {
    schemaVersion: 1,
    operation: "probe",
    outcome: "success",
    code: null,
    primaryCode: null,
    resourceUnknown: false,
    unknownResources: [],
    identity: {
      kind: "probe-tool",
      version: tool.version,
      toolSha256: tool.pinnedSha256,
      toolPinSource: "configured",
      matched: true,
      snapshotSha256: "b".repeat(64),
      snapshotBytes: 32,
      snapshotDigestSource: "declared",
    },
    timing: {
      clock: "monotonic",
      sourceDeadline: "caller",
      wallBudgetMs: 10000,
      hardDeadlineOffsetMs: 3000,
      allowanceMs: 2650,
      spawnAtMs: 1,
      closeAtMs: 2,
      groupConfirmedAtMs: 3,
      cleanupFinishedAtMs: 4,
      totalMs: 5,
      budgetExhausted: false,
    },
    spawn: { state: "confirmed", reason: null, confirmedAtMs: 1 },
    child: {
      state: "exited",
      exitCode: 0,
      signal: null,
      closeSettled: true,
      pidObserved: true,
      streamError: false,
    },
    stdio: { stdout: { ...stream }, stderr: { ...stream, retainedBytes: 0, available: "none" } },
    group: {
      state: "reclaimed",
      confirmedBy: "main",
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
    handoff: { resourceUnknown: false, retainLeaseRequired: false, retryPolicy: "not-decided-by-executor" },
    ...overrides,
  };
}

function fakeAdapter(world, tool, runnerOptions) {
  return new AudioProbe({
    runner: fakeRunner(tool, runnerOptions),
    tool,
    withLifecycleScope: world.engine.withLifecycleScope.bind(world.engine),
  });
}

test("G18 runner 自报成功但身份缺失：adapter 不发布 success，且不 retain", async (t) => {
  const world = await makeWorld(t);
  const { tool } = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const adapter = fakeAdapter(world, tool, {
    out: { raw: VALID_RAW, evidence: claimedSuccessEvidence(tool, { identity: null }) },
  });
  const error = await expectCode(
    adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  const ev = error.probeEvidence;
  assert.equal(ev.identity, null);
  assert.equal(ev.failure.reason, "SUCCESS_GATE_INCOMPLETE");
  assert.equal(ev.resourceUnknown, false);
  assert.equal(ev.lease.state, "released");
  assert.equal(await exists(world.lockRoot), false);
  assert.deepEqual(await jobDirs(world.dataDir), []);
});

test("G19 runner 自报成功但目录未清理：adapter 拒绝并 retain 锁", async (t) => {
  const world = await makeWorld(t);
  const { tool } = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const adapter = fakeAdapter(world, tool, {
    out: {
      raw: VALID_RAW,
      evidence: claimedSuccessEvidence(tool, {
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
      }),
    },
  });
  const error = await expectCode(
    adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  const ev = error.probeEvidence;
  assert.equal(ev.failure.reason, "SUCCESS_GATE_INCOMPLETE");
  assert.equal(ev.resourceUnknown, true);
  assert.equal(ev.lease.state, "held");
  assert.equal(ev.lease.retainRequested, true);
  assert.equal(error.evidence.resourceUnknown, true);
  assert.equal(await exists(world.lockRoot), true);
});

test("G20 executor 槽忙：严格入口 PROBE_BUSY，旧 probe 仍折叠为 PROBE_UNAVAILABLE", async (t) => {
  const world = await makeWorld(t);
  const { tool } = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const busy = Object.assign(new Error("busy"), { code: "EXECUTION_BUSY" });
  const adapter = fakeAdapter(world, tool, { error: busy });

  const error = await expectCode(
    adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "PROBE_BUSY",
  );
  assert.equal(error.probeEvidence.lease.state, "released");
  assert.equal(error.probeEvidence.resourceUnknown, false);

  const legacy = new AudioProbe({
    runner: fakeRunner(tool, { error: Object.assign(new Error("busy"), { code: "EXECUTION_BUSY" }) }),
    tool,
  });
  await expectCode(legacy.probe(world.snapshot), "PROBE_UNAVAILABLE");
});

test("G21 任意 reason 串（可能是路径）不得进入证据：固定枚举过滤后为 null", async (t) => {
  const world = await makeWorld(t);
  const { tool } = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const leak = "/private/var/secret/shiguang/owner-token-abc";
  const failure = {
    stage: "prepare",
    reason: leak,
    primaryCode: "EXECUTION_UNAVAILABLE",
    finalCode: "EXECUTION_UNAVAILABLE",
    overriddenBy: null,
  };
  const error = Object.assign(new Error("boom"), {
    code: "EXECUTION_UNAVAILABLE",
    evidence: { reason: leak, resourceUnknown: false },
    executionEvidence: claimedSuccessEvidence(tool, {
      outcome: "failure",
      code: "EXECUTION_UNAVAILABLE",
      spawn: { state: "not-started", reason: null, confirmedAtMs: null },
      child: {
        state: "not-created",
        exitCode: null,
        signal: null,
        closeSettled: false,
        pidObserved: false,
        streamError: false,
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
      failure,
    }),
  });
  const adapter = fakeAdapter(world, tool, { error });
  const thrown = await expectCode(
    adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  const json = JSON.stringify(thrown.probeEvidence);
  assert.equal(json.includes(leak), false, "证据不得包含原始 reason 串");
  assert.equal(json.includes("secret"), false);
  assert.equal(thrown.probeEvidence.failure.reason, null);
  assert.equal(thrown.probeEvidence.failure.stage, "prepare");
  assert.equal(thrown.probeEvidence.primaryCode, "EXECUTION_UNAVAILABLE");
});

/* ------------------------------------------------------------------ *
 * G22：证据合同形状（字段存在性 + 枚举取值 + 预算常量）。
 * 这条只核合同表本身，用来挡住“字段悄悄改名/换枚举”的漂移。
 * ------------------------------------------------------------------ */

const EVIDENCE_KEYS = [
  "schemaVersion",
  "operation",
  "outcome",
  "code",
  "primaryCode",
  "resourceUnknown",
  "unknownResources",
  "identity",
  "timing",
  "budget",
  "spawn",
  "child",
  "stdio",
  "group",
  "directory",
  "failure",
  "instance",
  "handoff",
  "parse",
  "lease",
];
const CODES_OK = new Set([
  null,
  "PROBE_BUSY",
  "PROBE_UNAVAILABLE",
  "PROBE_REJECTED",
  "TIMEOUT",
  "CANCELLED",
  "INVALID_REQUEST",
]);
const STAGES_OK = new Set([
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
const OVERRIDDEN_OK = new Set([null, "lease", "parse", "group", "cleanup"]);

function checkEvidenceShape(evidence, label) {
  const where = (key) => `${label}.${key}`;
  assert.deepEqual(Object.keys(evidence).sort(), [...EVIDENCE_KEYS].sort(), `${label} 顶层字段漂移`);
  assert.equal(evidence.schemaVersion, 1, where("schemaVersion"));
  assert.equal(evidence.operation, "probe", where("operation"));
  assert.ok(["success", "failure"].includes(evidence.outcome), where("outcome"));
  assert.ok(CODES_OK.has(evidence.code), `${where("code")}=${evidence.code}`);
  assert.ok(CODES_OK.has(evidence.primaryCode) || typeof evidence.primaryCode === "string", where("primaryCode"));
  assert.equal(typeof evidence.resourceUnknown, "boolean", where("resourceUnknown"));
  assert.ok(Array.isArray(evidence.unknownResources), where("unknownResources"));
  for (const item of evidence.unknownResources) {
    assert.ok(
      ["lease", "spawn", "child", "stdio.stdout", "stdio.stderr", "group", "directory"].includes(item),
      `${where("unknownResources")} 出现非固定枚举 ${item}`,
    );
  }
  assert.equal(typeof evidence.budget, "object", where("budget"));
  assert.equal(evidence.budget.wallMs, 10000, where("budget.wallMs"));
  assert.equal(evidence.budget.releaseReserveMs, 500, where("budget.releaseReserveMs"));
  assert.equal(typeof evidence.budget.adapterTotalMs, "number", where("budget.adapterTotalMs"));
  assert.ok(["not-started", "confirmed", "failed", "unknown"].includes(evidence.spawn.state), where("spawn.state"));
  assert.ok(["not-created", "exited", "signaled", "unknown"].includes(evidence.child.state), where("child.state"));
  assert.equal(typeof evidence.child.closeSettled, "boolean", where("child.closeSettled"));
  for (const stream of ["stdout", "stderr"]) {
    assert.equal(typeof evidence.stdio[stream].final, "boolean", where(`stdio.${stream}.final`));
  }
  assert.ok(
    ["not-created", "reclaimed", "unknown"].includes(evidence.group.state),
    where("group.state"),
  );
  assert.ok(
    ["not-created", "removed", "retained", "unknown"].includes(evidence.directory.state),
    where("directory.state"),
  );
  assert.ok(["accepted", "rejected", "not-reached"].includes(evidence.parse.state), where("parse.state"));
  assert.ok(
    ["released", "held", "unknown", "not-acquired"].includes(evidence.lease.state),
    where("lease.state"),
  );
  assert.equal(evidence.lease.scope, "probe", where("lease.scope"));
  assert.equal(evidence.lease.ownership, "probe-adapter", where("lease.ownership"));
  assert.equal(evidence.handoff.retryPolicy, "not-decided-by-probe", where("handoff.retryPolicy"));
  assert.equal(evidence.handoff.resourceUnknown, evidence.resourceUnknown);
  assert.equal(evidence.handoff.retainLeaseRequired, evidence.resourceUnknown);
  if (evidence.outcome === "success") {
    assert.equal(evidence.resourceUnknown, false);
    assert.equal(evidence.parse.state, "accepted");
    assert.equal(evidence.lease.state, "released");
    assert.equal(evidence.failure, null);
    assert.equal(evidence.identity.toolPinSource, "configured");
    assert.equal(evidence.identity.matched, true);
  } else {
    assert.notEqual(evidence.failure, null, "failure 证据必须有 failure");
    assert.ok(STAGES_OK.has(evidence.failure.stage), `${where("failure.stage")}=${evidence.failure.stage}`);
    assert.ok(OVERRIDDEN_OK.has(evidence.failure.overriddenBy), where("failure.overriddenBy"));
    assert.equal(evidence.failure.finalCode, evidence.code);
  }
  if (evidence.resourceUnknown === true) {
    assert.equal(evidence.outcome, "failure");
    assert.ok(evidence.lease.state === "held" || evidence.lease.state === "unknown");
  }
}

test("G22 证据合同形状：成功/固定失败/unknown 三类都符合合同表", async (t) => {
  const world = await makeWorld(t);
  const ok = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const success = await ok.adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() });
  checkEvidenceShape(success.evidence, "success");

  const plain = await world.makeProbe({ fixture: "tool-videojson.mjs" });
  const rejected = await expectCode(
    plain.adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "PROBE_REJECTED",
  );
  checkEvidenceShape(rejected.probeEvidence, "rejected");

  const dirty = await world.makeProbe({
    fixture: "tool-ok.mjs",
    executorHooks: { removeJob: () => new Promise(() => {}) },
  });
  const unknown = await expectCode(
    dirty.adapter.probeGuarded(world.snapshot, { deadlineAtMs: budget() }),
    "PROBE_UNAVAILABLE",
  );
  checkEvidenceShape(unknown.probeEvidence, "unknown");
  assert.equal(unknown.probeEvidence.resourceUnknown, true);

  const near = await expectCode(
    ok.adapter.probeGuarded(world.snapshot, { deadlineAtMs: performance.now() + 400 }),
    "TIMEOUT",
  );
  checkEvidenceShape(near.probeEvidence, "not-acquired-timeout");
  assert.equal(near.probeEvidence.lease.state, "not-acquired");
});

/* ------------------------------------------------------------------ *
 * G23：D5b——旧 AudioExecutor.probe 也走成功门（正反双控）。
 * 正常仍返回 Buffer；清理未知时必须拒绝，不得返回"资源未证实"的 stdout。
 * ------------------------------------------------------------------ */

test("G23 旧 probe 的 unknown 门：正常返回 Buffer，cleanup 未知则拒绝", async (t) => {
  const world = await makeWorld(t);

  // 正控：没有故障注入时，旧 probe 的成功路径不变（仍返回 Buffer）。
  const ok = await world.makeProbe({ fixture: "tool-ok.mjs" });
  const raw = await ok.executor.probe(world.snapshot);
  assert.ok(Buffer.isBuffer(raw), "旧 probe 正常路径必须仍返回 Buffer");
  assert.ok(JSON.parse(raw.toString("utf8")).format.format_name === "wav");

  // 反控：job 目录清理永不 settle → 资源 unknown → 必须拒绝，且不暴露新证据对象。
  const dirty = await world.makeProbe({
    fixture: "tool-ok.mjs",
    executorHooks: { removeJob: () => new Promise(() => {}) },
  });
  const error = await dirty.executor.probe(world.snapshot).then(
    () => assert.fail("资源 unknown 时旧 probe 不得返回 Buffer"),
    (failure) => failure,
  );
  assert.equal(error.code, "EXECUTION_UNAVAILABLE");
  assert.equal(error.evidence.reason, "RESOURCE_UNKNOWN");
  assert.equal(error.evidence.resourceUnknown, true);
  assert.equal("executionEvidence" in error, false, "旧 probe 不暴露新证据对象");
});
