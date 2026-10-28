/**
 * MUSIC-RESULT-SETTLEMENT-VERIFY 定向隔离测试（2026-10-25）。
 *
 * 只用临时目录、独占合成 probe/引擎/launcher、真实 AudioEngine/AudioAnalysis/
 * AudioAnalysisPipeline/AudioJobQueue/AudioResultStore 与临时 SQLite：
 * 不跑真实 ffprobe/发行引擎，不读真实素材/账户/数据库/服务器，不联网，
 * 不安装/下载/部署/重启，不修改任何产品模块。
 *
 * 本文件只补既有 T16 缺口：保存成功（job_id/saved_at_ms 已落库）后，实际
 * AudioJobQueue `#releaseLease` 的异步时序。故障注入只命中本测试独占的
 * `<临时 dataDir>/audio-jobs/.queue-lease`，并在 finally 恢复。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ChildProcess } from "node:child_process";
import { once } from "node:events";
import Database from "better-sqlite3";
import { AudioEngine, ENGINE_RELEASE } from "../server/audio-engine.mjs";
import { AudioAnalysis } from "../server/audio-analysis.mjs";
import { AudioAnalysisPipeline } from "../server/audio-analysis-pipeline.mjs";
import { AudioResultStore } from "../server/audio-result-store.mjs";
import { resolvePinnedAudioProbeTool } from "../server/audio-probe.mjs";
import { createAudioExecutorLauncherConfig } from "../server/audio-executor.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const CLEANUP = new WeakMap();
const DISPOSE_TIMEOUT_MS = 5_000;

/** 有界等待；超时/拒绝都返回事实，不把进程退出当成 Promise 已结算。 */
async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ ok: true, value, label }),
        (error) => ({ ok: false, error, label }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, timeout: true, label, afterMs: timeoutMs }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 只观察本进程实际 spawn 的 ChildProcess 的 exit/signalCode，不用 ps/pgrep 0 冒充资源事实。 */
const SPAWNED_CHILDREN = new Set();
const originalChildSpawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function patchedChildSpawn(options) {
  const result = originalChildSpawn.call(this, options);
  SPAWNED_CHILDREN.add(this);
  return result;
};

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function childCommand(child) {
  return [child.spawnfile, ...(Array.isArray(child.spawnargs) ? child.spawnargs : [])].join(" ");
}

function trackedChildrenUnder(state) {
  return [...SPAWNED_CHILDREN].filter((child) =>
    state.roots.some((entry) => childCommand(child).includes(entry.path)),
  );
}

function cleanupState(t) {
  let state = CLEANUP.get(t);
  if (state) return state;
  state = { roots: [], components: [], closers: [] };
  CLEANUP.set(t, state);
  t.after(() => runCleanup(t, state));
  return state;
}

async function tempDir(t, prefix = "shiguang-mrs-", { preserve = false, preserveReason = null } = {}) {
  const state = cleanupState(t);
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  state.roots.push({ path: dir, preserve, reason: preserveReason });
  return dir;
}

function preserveRoot(t, root, reason) {
  const state = cleanupState(t);
  const entry = state.roots.find((item) => item.path === root);
  if (entry) {
    entry.preserve = true;
    entry.reason = reason;
  } else {
    state.roots.push({ path: root, preserve: true, reason });
  }
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function stopChild(child, label, errors) {
  if (hasExited(child)) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  if (await waitForExit(child, 3_000)) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  if (!(await waitForExit(child, 5_000))) {
    errors.push(`${label} 未在 SIGKILL 后退出（pid=${child.pid}）`);
  }
}

async function runCleanup(t, state) {
  const errors = [];
  // dispose/子进程任一项未确认，就不删除任何自有根；宁可保守保留全部现场。
  let cleanupUnconfirmed = false;
  for (const child of trackedChildrenUnder(state)) {
    if (!hasExited(child)) await stopChild(child, `synthetic child pid=${child.pid}`, errors);
    if (!hasExited(child)) cleanupUnconfirmed = true;
  }
  for (const entry of state.components) {
    const result = await withTimeout(
      Promise.resolve().then(() => entry.dispose()),
      DISPOSE_TIMEOUT_MS,
      `${entry.label} dispose`,
    );
    if (result.timeout) {
      cleanupUnconfirmed = true;
      errors.push(`${entry.label} dispose 超时（>${DISPOSE_TIMEOUT_MS}ms），保留现场`);
    } else if (!result.ok) {
      cleanupUnconfirmed = true;
      errors.push(
        `${entry.label} dispose 失败：${result.error?.stack || result.error?.message || result.error}`,
      );
    }
  }
  for (const entry of state.closers) {
    try {
      entry.close();
    } catch (error) {
      cleanupUnconfirmed = true;
      errors.push(`${entry.label} close 失败：${error?.message || error}`);
    }
  }
  for (const child of trackedChildrenUnder(state)) {
    if (!hasExited(child)) {
      cleanupUnconfirmed = true;
      errors.push(`合成子进程未退出：pid=${child.pid} ${childCommand(child)}`);
    }
  }
  for (const child of trackedChildrenUnder(state)) {
    t.diagnostic(
      `CHILD pid=${child.pid} exitCode=${child.exitCode} signalCode=${child.signalCode} cmd=${childCommand(child)}`,
    );
  }
  for (const entry of state.roots) {
    const tracked = trackedChildrenUnder(state).filter((child) => childCommand(child).includes(entry.path));
    t.diagnostic(`INVENTORY root=${entry.path} trackedChildren=${tracked.length}`);
    if (entry.preserve) {
      t.diagnostic(`PRESERVED_ROOT ${entry.path}${entry.reason ? ` reason=${entry.reason}` : ""}`);
      continue;
    }
    if (cleanupUnconfirmed) {
      t.diagnostic(`PRESERVED_ROOT ${entry.path} reason=cleanup-unconfirmed`);
      continue;
    }
    try {
      await fs.lstat(entry.path);
    } catch (error) {
      if (error?.code === "ENOENT") continue; // 已经不存在，无需 rm / 无需报错。
      t.diagnostic(
        `UNKNOWN_ROOT ${entry.path} reason=lstat-${error?.code || "unknown"} 保留，不把不可读当不存在`,
      );
      errors.push(`临时根状态未知，保留现场：${entry.path}：${error?.code || error?.message || error}`);
      continue;
    }
    try {
      await fs.rm(entry.path, { recursive: true, force: false });
    } catch (error) {
      errors.push(`临时根清理失败：${entry.path}：${error?.message || error}`);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "test cleanup failed");
}

async function writeExecutable(file, content) {
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

const PROBE_JSON = JSON.stringify({
  format: { format_name: "wav", duration: "12.5" },
  streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "44100" }],
});

const RESULT_JSON = JSON.stringify({
  bpm: 120,
  key: { best: "C major", r: 0.8 },
  loud: { peak: 2.5, rms: -12 },
  energy: { min: -30, max: -4, std: 3 },
  fit: { beat: 0.9, tonal: 0.8, chord: 0.5 },
  seg: [0, 5, 10],
});

async function makeTools(t, base) {
  const dir = path.join(base, "tools");
  await fs.mkdir(dir, { recursive: true });
  const probe = path.join(dir, "ffprobe-synthetic");
  const engine = path.join(dir, "engine-synthetic");
  const launcher = path.join(dir, "launcher.sh");
  await writeExecutable(
    probe,
    ["#!/bin/sh", `printf '%s' '${PROBE_JSON}'`, ""].join("\n"),
  );
  await writeExecutable(
    engine,
    [
      "#!/bin/sh",
      `printf 'run\\n' >> '${path.join(base, "exec-count")}'`,
      `printf '%s' '${RESULT_JSON}'`,
      "",
    ].join("\n"),
  );
  await writeExecutable(launcher, '#!/bin/sh\nexec "$@"\n');
  const probeTool = await resolvePinnedAudioProbeTool({
    path: probe,
    version: "synthetic-1",
    expectedSha256: sha256(await fs.readFile(probe)),
  });
  const launcherConfig = createAudioExecutorLauncherConfig({
    path: launcher,
    sha256: sha256(await fs.readFile(launcher)),
  });
  return { probe, engine, launcher, probeTool, launcherConfig };
}

/** 合成一个与产品 ENGINE_RELEASE 元数据一致的临时安装，供真实 AudioEngine 校验。 */
async function installFakeEngine(dataDir, engineScript) {
  const engineRoot = path.join(dataDir, "engines", "audio");
  const versionsRoot = path.join(engineRoot, "versions");
  const dirName = "v1";
  const binaryName = ENGINE_RELEASE.binary;
  const versionDir = path.join(versionsRoot, dirName);
  await fs.mkdir(versionDir, { recursive: true });
  const binary = path.join(versionDir, binaryName);
  const bytes = await fs.readFile(engineScript);
  await fs.writeFile(binary, bytes, { mode: 0o755 });
  await fs.chmod(binary, 0o755);
  const stat = await fs.stat(binary);
  const metadata = {
    metadataVersion: 2,
    dir: dirName,
    binary: binaryName,
    version: ENGINE_RELEASE.version,
    releaseSha256: ENGINE_RELEASE.sha256,
    binarySha256: sha256(bytes),
    binarySize: stat.size,
    generation: "a".repeat(32),
  };
  await fs.writeFile(path.join(engineRoot, "current.json"), JSON.stringify(metadata));
  await fs.writeFile(path.join(versionDir, ".installed.json"), JSON.stringify(metadata));
  return binary;
}

async function makeLibrary(t, base, { assetId = "asset_a", bytes = Buffer.from("synthetic audio bytes ".repeat(32)) } = {}) {
  const root = path.join(base, "media");
  const dataDir = path.join(base, "data");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const file = path.join(root, `${assetId}.wav`);
  await fs.writeFile(file, bytes);
  const stat = await fs.stat(file);
  const db = new Database(path.join(base, "library.sqlite"));
  db.exec(`
    CREATE TABLE roots(id TEXT PRIMARY KEY, path TEXT, online INTEGER, revision INTEGER, retired INTEGER);
    CREATE TABLE assets(id TEXT PRIMARY KEY, root_id TEXT, path TEXT, name TEXT, kind TEXT, size INTEGER,
      mtime REAL, dev INTEGER, ino INTEGER, sha256 TEXT, duration REAL, online INTEGER, trashed INTEGER);
  `);
  db.prepare("INSERT INTO roots(id,path,online,revision,retired) VALUES(?,?,?,?,?)").run(
    "root_01",
    root,
    1,
    1,
    0,
  );
  db.prepare(
    `INSERT INTO assets(id,root_id,path,name,kind,size,mtime,dev,ino,sha256,duration,online,trashed)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    assetId,
    "root_01",
    file,
    path.basename(file),
    "music",
    stat.size,
    stat.mtimeMs,
    stat.dev,
    stat.ino,
    sha256(bytes),
    null,
    1,
    0,
  );
  const lib = { db, locks: new Set() };
  cleanupState(t).closers.push({ label: `library ${assetId}`, close: () => db.close() });
  return { root, dataDir, file, bytes, db, lib, assetId };
}

async function makeAnalysis(t, options = {}) {
  const base = await tempDir(t);
  const library = await makeLibrary(t, base);
  const tools = await makeTools(t, base);
  await installFakeEngine(library.dataDir, tools.engine);
  const engine = new AudioEngine(library.dataDir);
  const analysis = new AudioAnalysis(library.lib, engine, {
    dataDir: library.dataDir,
    probeTool: tools.probeTool,
    launcher: tools.launcherConfig,
    httpWaitMs: options.httpWaitMs ?? 8_000,
    cancelSettleMs: options.cancelSettleMs ?? 200,
    cacheIdentityTimeoutMs: options.cacheIdentityTimeoutMs ?? 2_000,
    wallDeadlineMs: options.wallDeadlineMs ?? 10_000,
  });
  const state = cleanupState(t);
  state.components.push({ label: "analysis", dispose: () => analysis.dispose() });
  state.components.push({ label: "engine", dispose: () => engine.dispose() });
  return { base, library, tools, engine, analysis };
}

function record(db, assetId = "asset_a") {
  return db
    .prepare(
      `SELECT asset_id, job_id, context_json, fingerprint, payload_json, payload_bytes,
              payload_sha256, analyzed_ms, analyzed_at_ms, saved_at_ms, invalidated_at_ms
         FROM audio_result_records WHERE asset_id=?`,
    )
    .get(assetId);
}

function assetRow(db, assetId = "asset_a") {
  return db
    .prepare("SELECT id, path, kind, size, mtime, dev, ino, sha256, online, trashed FROM assets WHERE id=?")
    .get(assetId);
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    // 只有 ENOENT 能确认“不存在”；EACCES/EPERM/ENOTDIR 等都是未知，必须向上抛。
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readLines(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function waitUntil(predicate, timeoutMs = 5_000, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 观察真实 pipeline 实例与真实 store.save 次数；不改变返回值/时序。
 * 仅用于读取实际 queue.get 的终态，不用替身编造 summary。
 */
function instrumentRealComponents() {
  const counters = { submitCalls: 0, saveCalls: 0, pipeline: null };
  const originalSubmit = AudioAnalysisPipeline.prototype.submit;
  const originalSave = AudioResultStore.prototype.save;
  AudioAnalysisPipeline.prototype.submit = function observedSubmit(...args) {
    counters.submitCalls += 1;
    counters.pipeline = this;
    const promise = originalSubmit.apply(this, args);
    promise.then((summary) => { counters.lastSubmit = summary; }, () => {});
    return promise;
  };
  AudioResultStore.prototype.save = function observedSave(...args) {
    counters.saveCalls += 1;
    return originalSave.apply(this, args);
  };
  return {
    counters,
    restore() {
      AudioAnalysisPipeline.prototype.submit = originalSubmit;
      AudioResultStore.prototype.save = originalSave;
    },
  };
}

/**
 * 只拦截本测试独占 lockRoot 的 fs.rm：
 * - delay 模式：真正释放前保持 `.queue-lease` 存在，形成 delayed 精确时序；
 * - failOnce 模式：实际 `#releaseLease` 的 rm 抛一次受控错误。
 * 其它路径全部透传，finally 恢复原函数。
 */
function patchLeaseRelease(lockRoot) {
  const original = fs.rm;
  const state = {
    target: lockRoot,
    armed: true,
    entered: false,
    delay: false,
    gateReleased: false,
    failures: 0,
    calls: 0,
    resolveGate: null,
    gate: null,
  };
  state.gate = new Promise((resolve) => {
    state.resolveGate = resolve;
  });
  fs.rm = async function patchedRm(target, options) {
    if (path.resolve(String(target)) === state.target) {
      state.calls += 1;
      if (state.armed && state.failures > 0) {
        // 已注入一次失败后不再重复命中。
        return original.call(this, target, options);
      }
      if (state.armed && state.delay) {
        state.entered = true;
        await state.gate;
      } else if (state.armed && state.failOnce) {
        state.armed = false;
        state.failures += 1;
        const error = new Error("synthetic lease release failure");
        error.code = "EACCES";
        throw error;
      }
    }
    return original.call(this, target, options);
  };
  return {
    state,
    mode(mode) {
      state.delay = mode === "delay";
      state.failOnce = mode === "failOnce";
      state.armed = true;
    },
    releaseGate() {
      if (state.gateReleased) return;
      state.gateReleased = true;
      state.resolveGate();
    },
    restore() {
      fs.rm = original;
    },
  };
}

test(
  "MRS-01 保存后真实 queue lease 延迟：saving+resultSaved→503/STORAGE_ERROR，解除后实际结算且不丢不重",
  { timeout: 30_000 },
  async (t) => {
    const { base, library, analysis } = await makeAnalysis(t, {
      httpWaitMs: 3_000,
      cancelSettleMs: 250,
    });
    const lockRoot = path.join(library.dataDir, "audio-jobs", ".queue-lease");
    const lease = patchLeaseRelease(lockRoot);
    lease.mode("delay");
    const instrument = instrumentRealComponents();
    const assetBefore = assetRow(library.db);
    let running = null;
    let closing = null;
    try {
      running = analysis.analyze("asset_a", { force: true }).catch((error) => {
        closing = error;
      });

      const entered = await waitUntil(() => lease.state.entered, 5_000);
      assert.equal(entered, true, "实际 #releaseLease 未进入受控延迟");
      const duringRow = record(library.db);
      assert.ok(duringRow, "commit 后结果行应已存在");
      const during = await instrument.counters.pipeline.get(duringRow.job_id);
      assert.equal(during.state, "saving");
      assert.equal(during.resultSaved, true);

      await running;
      assert.ok(closing, "adapter 应拒绝而不是假成功");
      assert.equal(closing.code, "STORAGE_ERROR");
      assert.equal(closing.status, 503);
      assert.equal(closing.message, "结果已保存，任务收尾未确认");
      assert.equal(lease.state.entered, true, "延迟必须命中实际 releaseLease");

      const atClose = await instrument.counters.pipeline.get(duringRow.job_id);
      assert.equal(atClose.state, "saving");
      assert.equal(atClose.resultSaved, true);
      assert.equal(atClose.error, null);

      const rowAtClose = record(library.db);
      assert.deepEqual(rowAtClose, duringRow);
      assert.equal(rowAtClose.job_id, duringRow.job_id);
      assert.equal(Number.isSafeInteger(rowAtClose.saved_at_ms), true);
      assert.match(rowAtClose.payload_sha256, /^[0-9a-f]{64}$/);

      lease.releaseGate();
      const settled = await waitUntil(async () => {
        const summary = await instrument.counters.pipeline.get(duringRow.job_id);
        return summary.state === "succeeded" ? summary : null;
      }, 5_000);
      assert.ok(settled, "解除延迟后实际 queue 未结算为 succeeded");
      assert.equal(settled.resultSaved, true);
      assert.equal(settled.error, null);
      assert.equal(await pathExists(lockRoot), false, "成功后实际 lease 应释放");
      assert.equal(instrument.counters.saveCalls, 1, "同一 job 不得重复保存");

      const rowAfterSettle = record(library.db);
      assert.deepEqual(rowAfterSettle, rowAtClose, "结算不得改写已保存结果");
      const assetAfter = assetRow(library.db);
      assert.deepEqual(assetAfter, assetBefore, "素材身份/路径不得被改写");

      // GET 仍读同一份已保存结果；随后可重入新任务，证明 queue 未停在延迟态。
      const got = await analysis.get("asset_a");
      assert.equal(got.bpm, 120);
      assert.deepEqual(record(library.db), rowAtClose);

      const reentry = await analysis.analyze("asset_a");
      assert.equal(reentry.bpm, 120);
      assert.equal(instrument.counters.saveCalls, 2);
      assert.equal(await readLines(path.join(base, "exec-count")), 2);
      const rows = library.db
        .prepare("SELECT COUNT(*) AS n FROM audio_result_records WHERE asset_id=?")
        .get("asset_a");
      assert.equal(rows.n, 1, "结果表对同一素材只保留一行");
      const rowReentry = record(library.db);
      assert.notEqual(rowReentry.job_id, duringRow.job_id);
      assert.equal(Number.isSafeInteger(rowReentry.saved_at_ms), true);

      t.diagnostic(
        `EVIDENCE ${JSON.stringify({
          scenario: "delayed-release",
          closing: { code: closing.code, status: closing.status, message: closing.message },
          atClose: { state: atClose.state, resultSaved: atClose.resultSaved },
          settled: { state: settled.state, resultSaved: settled.resultSaved },
          jobId: duringRow.job_id,
          savedAtMs: rowAtClose.saved_at_ms,
          analyzedMs: rowAtClose.analyzed_ms,
          payloadSha256: rowAtClose.payload_sha256,
          contextFingerprint: rowAtClose.fingerprint,
          saveCallsAtClose: 1,
          reentryJobId: rowReentry.job_id,
          reentryExecCount: 2,
          execCount: await readLines(path.join(base, "exec-count")),
          rowCount: rows.n,
          leaseReleased: !(await pathExists(lockRoot)),
        })}`,
      );
    } finally {
      instrument.restore();
      // 无条件、幂等释放 gate；即使断言在 entered 之后提前失败也不能留下悬挂 Promise。
      lease.releaseGate();
      try {
        const startedAt = Date.now();
        const waits = [analysis.dispose()];
        if (running) waits.push(running);
        const results = await Promise.all(
          waits.map((promise, index) =>
            withTimeout(promise, 5_000, index === 0 ? "analysis.dispose" : "analysis.analyze"),
          ),
        );
        let queueSummary = null;
        try {
          const row = record(library.db);
          if (row && instrument.counters.pipeline) {
            const observed = await withTimeout(
              instrument.counters.pipeline.get(row.job_id),
              1_000,
              "queue.get(final)",
            );
            if (observed.ok) queueSummary = observed.value;
          }
        } catch (error) {
          queueSummary = { readError: error?.code || error?.message || String(error) };
        }
        let lockPresent;
        try {
          lockPresent = await pathExists(lockRoot);
        } catch (error) {
          lockPresent = `unknown:${error?.code || "lstat"}`;
        }
        const allSettled = results.every((result) => result.ok);
        t.diagnostic(
          `MRS01_FINALLY gateReleased=${lease.state.gateReleased} gateCalls=${lease.state.calls} ` +
            `handlesSettled=${allSettled} dispose=${results[0]?.ok ?? "n/a"} ` +
            `analyze=${results[1]?.ok ?? "n/a"} queueState=${queueSummary?.state ?? "unknown"} ` +
            `queueResultSaved=${queueSummary?.resultSaved ?? "unknown"} lockPresent=${lockPresent} ` +
            `elapsedMs=${Date.now() - startedAt}`,
        );
        if (!allSettled || lockPresent !== false) {
          preserveRoot(t, base, "MRS-01 cleanup unconfirmed after gate release");
        }
      } finally {
        lease.restore();
      }
    }
  },
);

test(
  "MRS-02 实际 lease 释放受控失败一次：真实 queue failed/LEASE_RELEASE_FAILED + 400，保存数据不篡改、锁保留",
  { timeout: 30_000 },
  async (t) => {
    const { base, library, analysis } = await makeAnalysis(t, {
      httpWaitMs: 5_000,
      cancelSettleMs: 250,
    });
    const lockRoot = path.join(library.dataDir, "audio-jobs", ".queue-lease");
    const lease = patchLeaseRelease(lockRoot);
    lease.mode("failOnce");
    // 注入可能进入“结果已保存、lease 保留”态：在启动 analyze 前就登记保留，
    // 不等到所有断言之后；提前断言失败时也不能让 cleanup 删掉带锁根。
    preserveRoot(t, base, "MRS-02 possible retained lease before controlled release failure");
    const instrument = instrumentRealComponents();
    const assetBefore = assetRow(library.db);
    try {
      let failure = null;
      try {
        await analysis.analyze("asset_a", { force: true });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, "实际 lease 释放失败时 adapter 必须拒绝");
      assert.equal(failure.code, "LEASE_RELEASE_FAILED");
      assert.equal(failure.status, 400);
      assert.equal(failure.message, "分析队列租约释放失败");
      assert.equal(lease.state.failures, 1, "受控失败必须只注入一次");

      const saved = record(library.db);
      assert.ok(saved, "lease 释放失败不得丢已保存结果");
      assert.equal(saved.asset_id, "asset_a");
      assert.equal(Number.isSafeInteger(saved.saved_at_ms), true);
      assert.match(saved.payload_sha256, /^[0-9a-f]{64}$/);
      assert.equal(instrument.counters.saveCalls, 1);

      const summary = await instrument.counters.pipeline.get(saved.job_id);
      assert.equal(summary.state, "failed");
      assert.equal(summary.resultSaved, true);
      assert.deepEqual(summary.error, {
        code: "LEASE_RELEASE_FAILED",
        message: "分析队列租约释放失败",
      });
      assert.equal(await pathExists(lockRoot), true, "真实 queue 失败态应保留 lease 现场");
      const owner = JSON.parse(await fs.readFile(path.join(lockRoot, "owner.json"), "utf8"));
      assert.equal(owner.purpose, "audio-job-queue");
      assert.equal(typeof owner.token, "string");
      assert.equal(owner.token.length > 0, true);
      assert.equal(owner.pid, process.pid);

      const assetAfter = assetRow(library.db);
      assert.deepEqual(assetAfter, assetBefore, "失败不得篡改素材身份/路径");
      assert.deepEqual(record(library.db), saved, "失败不得改写已保存结果行");

      const jobEntries = (await fs.readdir(path.join(library.dataDir, "audio-jobs"))).sort();
      preserveRoot(t, base, "lease retained after controlled LEASE_RELEASE_FAILED");

      t.diagnostic(
        `EVIDENCE ${JSON.stringify({
          scenario: "lease-release-failure",
          failure: { code: failure.code, status: failure.status, message: failure.message },
          queue: {
            state: summary.state,
            resultSaved: summary.resultSaved,
            error: summary.error,
          },
          jobId: saved.job_id,
          savedAtMs: saved.saved_at_ms,
          analyzedMs: saved.analyzed_ms,
          payloadSha256: saved.payload_sha256,
          saveCalls: instrument.counters.saveCalls,
          injectedFailures: lease.state.failures,
          leaseRetained: await pathExists(lockRoot),
          ownerPurpose: owner.purpose,
          jobEntries,
        })}`,
      );
    } finally {
      instrument.restore();
      lease.releaseGate();
      try {
        const disposed = await withTimeout(analysis.dispose(), 5_000, "analysis.dispose");
        let lockPresent;
        try {
          lockPresent = await pathExists(lockRoot);
        } catch (error) {
          lockPresent = `unknown:${error?.code || "lstat"}`;
        }
        t.diagnostic(
          `MRS02_FINALLY dispose=${disposed.ok} disposeTimeout=${disposed.timeout === true} ` +
            `lockPresent=${lockPresent} injectedFailures=${lease.state.failures}`,
        );
        if (!disposed.ok || lockPresent !== true) {
          preserveRoot(t, base, "MRS-02 cleanup/lock state unconfirmed");
        }
      } finally {
        lease.restore();
      }
    }
  },
);

test(
  "MRS-CLEANUP-01 dispose 未确认时不删除自有根，AggregateError 现场保留",
  { timeout: 10_000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-mrs-cleanup-")),
    );
    const lockDir = path.join(root, "data", "audio-jobs", ".queue-lease");
    await fs.mkdir(lockDir, { recursive: true });
    try {
      const diagnostics = [];
      await assert.rejects(
        runCleanup(
          { diagnostic: (line) => diagnostics.push(line) },
          {
            roots: [{ path: root, preserve: false }],
            components: [
              {
                label: "synthetic unknown close",
                async dispose() {
                  throw new Error("UNKNOWN_CLOSE");
                },
              },
            ],
            closers: [],
          },
        ),
        AggregateError,
      );
      assert.equal(await pathExists(root), true, "dispose 未确认时不得删除根");
      assert.equal(await pathExists(lockDir), true, "保留态 lease 目录必须仍在");
      assert.equal(
        diagnostics.some((line) => line.includes("PRESERVED_ROOT") && line.includes("cleanup-unconfirmed")),
        true,
        "应输出可追踪的 cleanup-unconfirmed 保留清单",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "MRS-CLEANUP-02 pathExists 仅 ENOENT=false，其它 lstat 错误作为未知抛出",
  { timeout: 10_000 },
  async () => {
    const originalLstat = fs.lstat;
    fs.lstat = async () => {
      const error = new Error("synthetic permission denied");
      error.code = "EACCES";
      throw error;
    };
    try {
      await assert.rejects(pathExists(path.join(os.tmpdir(), "shiguang-mrs-unreadable")), (error) => {
        assert.equal(error.code, "EACCES");
        return true;
      });
    } finally {
      fs.lstat = originalLstat;
    }
    assert.equal(
      await pathExists(path.join(os.tmpdir(), `shiguang-mrs-missing-${process.pid}-${Date.now()}`)),
      false,
    );
  },
);

test(
  "MRS-CLEANUP-03 cleanup 遇非 ENOENT lstat 视为未知并保留根",
  { timeout: 10_000 },
  async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-mrs-cleanup-unknown-")),
    );
    const originalLstat = fs.lstat;
    const diagnostics = [];
    fs.lstat = async (target) => {
      if (path.resolve(String(target)) === path.resolve(root)) {
        const error = new Error("synthetic cleanup lstat denied");
        error.code = "EACCES";
        throw error;
      }
      return originalLstat.call(fs, target);
    };
    try {
      try {
        await assert.rejects(
          runCleanup(
            { diagnostic: (line) => diagnostics.push(line) },
            { roots: [{ path: root, preserve: false }], components: [], closers: [] },
          ),
          AggregateError,
        );
      } finally {
        fs.lstat = originalLstat;
      }
      assert.equal(await pathExists(root), true, "不可读根必须保留，不能当不存在删除");
      assert.equal(
        diagnostics.some((line) => line.includes(`UNKNOWN_ROOT ${root}`) && line.includes("EACCES")),
        true,
        "应输出 UNKNOWN_ROOT/EACCES 清单",
      );
    } finally {
      fs.lstat = originalLstat;
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
