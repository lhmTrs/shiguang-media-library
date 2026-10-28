/**
 * MUSIC-ANALYSIS-INTEGRATION-IMPL round1 定向隔离测试。
 *
 * 只用临时目录、合成 probe/引擎/launcher、真实 AudioEngine/AudioProbe/
 * AudioExecutor/AudioAnalysisPipeline/AudioJobQueue/AudioResultStore：
 * 不跑真实 ffprobe/发行引擎、不读真实素材/账户/数据库/服务器、不联网、
 * 不安装/下载/部署/重启。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Library } from "../server/library.mjs";
import { AudioEngine, ENGINE_RELEASE } from "../server/audio-engine.mjs";
import { AudioAnalysis } from "../server/audio-analysis.mjs";
import { AudioAnalysisPipeline } from "../server/audio-analysis-pipeline.mjs";
import { resolvePinnedAudioProbeTool } from "../server/audio-probe.mjs";
import { createAudioExecutorLauncherConfig, AudioExecutor } from "../server/audio-executor.mjs";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/**
 * 每个 test context 只注册一个 after：先确认子进程实际退出，再 dispose 组件、
 * 关 DB，最后才删临时根。任何一步失败或 unknown 都保留 root 并输出 inventory，
 * 不用吞错/强行删除掩盖资源事实。
 */
const CLEANUP = new WeakMap();

/**
 * 进程事实只来自本进程实际 spawn 的 ChildProcess 对象：记录 exit/signalCode，
 * 而不是用 ps/pgrep 0 或目录存在性代替。补丁只影响测试进程，不改产品源码。
 */
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
    state.roots.some((root) => childCommand(child).includes(root)),
  );
}

function cleanupState(t) {
  let state = CLEANUP.get(t);
  if (state) return state;
  state = {
    roots: [],
    children: [],
    components: [],
    closers: [],
    preserve: false,
    preserveReason: null,
  };
  CLEANUP.set(t, state);
  t.after(() => runCleanup(t, state));
  return state;
}

function preserveInventory(t, reason) {
  const state = cleanupState(t);
  state.preserve = true;
  state.preserveReason = reason;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function stopChild(child, label, errors) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {}
  if (await waitForExit(child, 3_000)) return;
  try {
    child.kill("SIGKILL");
  } catch {}
  // SIGKILL 后仍必须以 exit/close 事实为准，不能凭调度延迟直接删目录。
  if (!(await waitForExit(child, 5_000))) {
    errors.push(`${label} 未在 SIGKILL 后退出（pid=${child.pid}）`);
  }
}

async function runCleanup(t, state) {
  const errors = [];
  for (const entry of state.children) {
    await stopChild(entry.child, entry.label, errors);
  }
  for (const entry of state.components) {
    try {
      await entry.dispose();
    } catch (error) {
      errors.push(`${entry.label} dispose 失败：${error?.stack || error?.message || error}`);
    }
  }
  for (const entry of state.closers) {
    try {
      entry.close();
    } catch (error) {
      errors.push(`${entry.label} close 失败：${error?.message || error}`);
    }
  }

  const tracked = trackedChildrenUnder(state);
  for (const child of tracked) {
    if (!hasExited(child)) {
      await stopChild(child, `synthetic child pid=${child.pid}`, errors);
    }
  }
  const inventory = state.roots.map(
    (root) => `${root} trackedChildren=${trackedChildrenUnder(state).filter((child) => childCommand(child).includes(root)).length}`,
  );
  for (const child of trackedChildrenUnder(state)) {
    if (!hasExited(child)) errors.push(`合成子进程未退出：pid=${child.pid} ${childCommand(child)}`);
  }
  if (state.preserve || errors.length > 0) {
    const reason = state.preserveReason || errors.join("; ");
    t.diagnostic(`CLEANUP_PRESERVED ${reason}`);
    for (const line of inventory) t.diagnostic(`INVENTORY ${line}`);
    await Promise.all(
      state.roots.map(async (root) => {
        const exists = await fs.lstat(root).then(() => true, () => false);
        if (exists) t.diagnostic(`PRESERVED_ROOT ${root}`);
      }),
    );
  } else {
    for (const root of state.roots) {
      try {
        await fs.rm(root, { recursive: true, force: false });
      } catch (error) {
        errors.push(`临时根清理失败：${root}：${error?.message || error}`);
      }
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "test cleanup failed");
}

async function tempDir(t, prefix = "shiguang-mai-", { preserve = false } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const state = cleanupState(t);
  state.roots.push(dir);
  if (preserve) preserveInventory(t, "explicit preserve");
  return dir;
}

async function writeExecutable(file, content) {
  await fs.writeFile(file, content, { mode: 0o755 });
  await fs.chmod(file, 0o755);
}

const PROBE_JSON = JSON.stringify({
  format: { format_name: "wav", duration: "12.5" },
  streams: [
    { codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "44100" },
  ],
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
    [
      "#!/bin/sh",
      `if [ -f '${path.join(base, "probe-video")}' ]; then`,
      `  printf '%s' '{"format":{"format_name":"mov","duration":"12.5"},"streams":[{"codec_type":"video","codec_name":"h264"}]}'`,
      "  exit 0",
      "fi",
      `printf '%s' '${PROBE_JSON}'`,
      "",
    ].join("\n"),
  );
  await writeExecutable(
    engine,
    [
      "#!/bin/sh",
      `printf 'run\\n' >> '${path.join(base, "exec-count")}'`,
      `if [ -f '${path.join(base, "engine-fail")}' ]; then echo 'synthetic failure' >&2; exit 1; fi`,
      `if [ -f '${path.join(base, "engine-slow")}' ]; then sleep 10; fi`,
      `if [ -f '${path.join(base, "engine-gate")}' ]; then`,
      `  while [ -f '${path.join(base, "engine-gate")}' ]; do sleep 0.05; done`,
      "fi",
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
  const library = options.library || (await makeLibrary(t, base, options.libraryOptions));
  const tools = await makeTools(t, base);
  await installFakeEngine(library.dataDir, tools.engine);
  const engine = options.engine || new AudioEngine(library.dataDir);
  const analysis = new AudioAnalysis(library.lib, engine, {
    dataDir: library.dataDir,
    probeTool: options.probeTool || tools.probeTool,
    launcher: options.launcher || tools.launcherConfig,
    httpWaitMs: options.httpWaitMs ?? 8_000,
    cancelSettleMs: options.cancelSettleMs ?? 200,
    cacheIdentityTimeoutMs: options.cacheIdentityTimeoutMs ?? 2_000,
    wallDeadlineMs: options.wallDeadlineMs ?? 10_000,
    ...(options.pipeline ? { pipeline: options.pipeline } : {}),
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

test("T02/T03/T06/T07：真实受控链成功、GET 投影、缓存命中与 force 重算", async (t) => {
  const { library, analysis, base } = await makeAnalysis(t);

  const first = await analysis.analyze("asset_a", { force: true });
  assert.equal(first.cached, false);
  assert.equal(first.asset_id, "asset_a");
  assert.equal(first.bpm, 120);
  assert.equal(first.key_root, "C");
  assert.equal(first.key_mode, "major");
  assert.equal(first.loudness_rms, -12);
  assert.equal(first.loudness_peak, 2.5);
  assert.equal(first.energy_min, -30);
  assert.equal(first.energy_max, -4);
  assert.equal(first.duration, 12.5);
  assert.equal(first.structure_json, null);
  assert.equal(first.engine_version, ENGINE_RELEASE.version);
  assert.equal(typeof first.analyzed_at, "string");
  assert.equal(Number.isSafeInteger(first.analyzed_ms), true);

  const saved = record(library.db, "asset_a");
  assert.ok(saved);
  assert.equal(saved.invalidated_at_ms, null);
  assert.equal(saved.job_id.length > 0, true);

  const got = await analysis.get("asset_a");
  assert.equal(got.asset_id, "asset_a");
  assert.equal(got.bpm, 120);
  assert.equal("cached" in got, false);

  const second = await analysis.analyze("asset_a", { force: false });
  assert.equal(second.cached, true);
  assert.equal(second.bpm, 120);
  const countAfterCache = Number(
    (await fs.readFile(path.join(base, "exec-count"), "utf8")).trim().split("\n").length,
  );
  assert.equal(countAfterCache, 1, "缓存命中不得再次 execute");

  const third = await analysis.analyze("asset_a", { force: true });
  assert.equal(third.cached, false);
  const countAfterForce = Number(
    (await fs.readFile(path.join(base, "exec-count"), "utf8")).trim().split("\n").length,
  );
  assert.equal(countAfterForce, 2, "force 必须重算");
});

test("T04/T05：旧 asset_audio 只读回退，缺失/不可管理返回 null", async (t) => {
  const { library, analysis } = await makeAnalysis(t, {
    libraryOptions: { assetId: "asset_old", bytes: Buffer.from("old synthetic bytes") },
  });
  library.db.exec(`CREATE TABLE asset_audio (
    asset_id TEXT PRIMARY KEY, sha256 TEXT, bpm REAL, key_root TEXT, key_mode TEXT,
    loudness_rms REAL, loudness_peak REAL, energy_min REAL, energy_max REAL,
    duration REAL, structure_json TEXT, engine_version TEXT, analyzed_ms INTEGER, analyzed_at TEXT
  )`);
  library.db
    .prepare("INSERT INTO asset_audio VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("asset_old", sha256(library.bytes), 90, "D", "minor", -20, -1, -40, -3, 8, null, "0.9.0", 100, "2026-10-20T00:00:00.000Z");

  const legacy = await analysis.get("asset_old");
  assert.equal(legacy.asset_id, "asset_old");
  assert.equal(legacy.bpm, 90);
  assert.equal(legacy.engine_version, "0.9.0");

  library.db.prepare("UPDATE assets SET trashed=1 WHERE id=?").run("asset_old");
  assert.equal(await analysis.get("asset_old"), null);
});

test("T09/T19b：失败保旧 payload/时间并置 stale，GET 仍读历史，缓存 miss 重算", async (t) => {
  const { library, analysis, base } = await makeAnalysis(t);
  const first = await analysis.analyze("asset_a", { force: true });
  assert.equal(first.cached, false);
  const before = record(library.db, "asset_a");
  assert.ok(before);
  assert.equal(before.invalidated_at_ms, null);

  await fs.writeFile(path.join(base, "engine-fail"), "1");
  await assert.rejects(
    () => analysis.analyze("asset_a", { force: true }),
    (error) => {
      assert.equal(error.code, "ENGINE_FAILED");
      assert.equal(error.status, 400);
      return true;
    },
  );
  const afterFailure = record(library.db, "asset_a");
  assert.equal(afterFailure.job_id, before.job_id);
  assert.equal(afterFailure.payload_json, before.payload_json);
  assert.equal(afterFailure.payload_bytes, before.payload_bytes);
  assert.equal(afterFailure.payload_sha256, before.payload_sha256);
  assert.equal(afterFailure.analyzed_ms, before.analyzed_ms);
  assert.equal(afterFailure.analyzed_at_ms, before.analyzed_at_ms);
  assert.equal(afterFailure.saved_at_ms, before.saved_at_ms);
  assert.notEqual(afterFailure.invalidated_at_ms, null);

  const historical = await analysis.get("asset_a");
  assert.equal(historical.asset_id, "asset_a");
  assert.equal(historical.bpm, 120);
  assert.equal("cached" in historical, false);

  await fs.rm(path.join(base, "engine-fail"), { force: true });
  const recovered = await analysis.analyze("asset_a", { force: false });
  assert.equal(recovered.cached, false, "invalidated 记录不得作为缓存命中");
  const afterRecovery = record(library.db, "asset_a");
  assert.equal(afterRecovery.invalidated_at_ms, null);
  assert.notEqual(afterRecovery.job_id, before.job_id);
});

test("T11/T12：引擎未安装与运行配置缺失固定 503/409，GET 不受 runtime 影响", async (t) => {
  const { base, library, tools } = await makeAnalysis(t);
  await installFakeEngine(library.dataDir, tools.engine);

  const withoutRuntime = new AudioAnalysis(library.lib, new AudioEngine(library.dataDir), {
    dataDir: library.dataDir,
    runtimeConfigPath: path.join(base, "missing-runtime.json"),
    httpWaitMs: 1_000,
  });
  cleanupState(t).components.push({ label: "withoutRuntime", dispose: () => withoutRuntime.dispose() });
  await assert.rejects(
    () => withoutRuntime.analyze("asset_a", { force: true }),
    (error) => {
      assert.equal(error.code, "AUDIO_RUNTIME_UNAVAILABLE");
      assert.equal(error.status, 503);
      return true;
    },
  );
  assert.equal(await withoutRuntime.get("asset_a"), null);

  const noEngineData = await tempDir(t);
  const noEngineLibrary = await makeLibrary(t, noEngineData, { assetId: "asset_no_engine" });
  const noEngine = new AudioAnalysis(noEngineLibrary.lib, new AudioEngine(noEngineLibrary.dataDir), {
    dataDir: noEngineLibrary.dataDir,
    probeTool: tools.probeTool,
    launcher: tools.launcherConfig,
  });
  cleanupState(t).components.push({ label: "noEngine", dispose: () => noEngine.dispose() });
  await assert.rejects(
    () => noEngine.analyze("asset_no_engine", { force: true }),
    (error) => {
      assert.equal(error.code, "ENGINE_NOT_INSTALLED");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("T16：合成引擎阻塞时 adapter 固定 TIMEOUT/400 且不落新记录", async (t) => {
  const { library, analysis, base } = await makeAnalysis(t, {
    wallDeadlineMs: 5_000,
    httpWaitMs: 1_000,
    cancelSettleMs: 300,
  });
  await fs.writeFile(path.join(base, "engine-slow"), "1");
  await assert.rejects(
    () => analysis.analyze("asset_a", { force: true }),
    (error) => {
      assert.equal(error.code, "TIMEOUT");
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(record(library.db, "asset_a"), undefined);
});

function fakePipeline({ submit, get, cancel }) {
  return {
    submit: async () => (typeof submit === "function" ? submit() : submit),
    get: async () => (typeof get === "function" ? get() : get),
    cancel: async () => (typeof cancel === "function" ? cancel() : cancel),
    dispose: async () => {},
  };
}

async function makeFakeBranchAnalysis(t, pipeline) {
  const base = await tempDir(t);
  const db = new Database(path.join(base, "store.sqlite"));
  db.exec(`
    CREATE TABLE roots(id TEXT PRIMARY KEY, path TEXT, online INTEGER, revision INTEGER, retired INTEGER);
    CREATE TABLE assets(id TEXT PRIMARY KEY, root_id TEXT, path TEXT, kind TEXT, size INTEGER,
      mtime REAL, dev INTEGER, ino INTEGER, sha256 TEXT, duration REAL, online INTEGER, trashed INTEGER);
  `);
  db.prepare("INSERT INTO roots VALUES(?,?,?,?,?)").run("root_01", base, 1, 1, 0);
  db.prepare("INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
    "asset_a",
    "root_01",
    path.join(base, "a.wav"),
    "music",
    10,
    1,
    1,
    1,
    "a".repeat(64),
    null,
    1,
    0,
  );
  const lib = { db, locks: new Set() };
  const engine = { binaryPath: "/synthetic/engine", withRunLease: async () => assert.fail("不应取引擎租约") };
  const analysis = new AudioAnalysis(lib, engine, {
    dataDir: base,
    probeTool: {},
    launcher: {},
    pipeline,
    httpWaitMs: 120,
    cancelSettleMs: 80,
    cacheIdentityTimeoutMs: 20,
  });
  await analysis.init();
  const state = cleanupState(t);
  state.components.push({ label: "fake analysis", dispose: () => analysis.dispose() });
  state.closers.push({ label: "fake store", close: () => db.close() });
  return { base, db, lib, analysis };
}

test("T16d：2s 结算后仍 saving 且 resultSaved=true -> 503 STORAGE_ERROR 固定文案", async (t) => {
  const pipeline = fakePipeline({
    submit: { id: "job_d", state: "queued" },
    get: { id: "job_d", state: "saving", resultSaved: true },
    cancel: { id: "job_d", state: "saving", resultSaved: true },
  });
  const { analysis } = await makeFakeBranchAnalysis(t, pipeline);
  await assert.rejects(
    () => analysis.analyze("asset_a", { force: true }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "STORAGE_ERROR");
      assert.equal(error.message, "结果已保存，任务收尾未确认");
      return true;
    },
  );
});

test("T16e：saving 后 releaseLease 失败 -> 400 LEASE_RELEASE_FAILED 固定文案", async (t) => {
  let calls = 0;
  const pipeline = fakePipeline({
    submit: { id: "job_e", state: "queued" },
    get: { id: "job_e", state: "saving", resultSaved: true },
    cancel: { id: "job_e", state: "failed", resultSaved: true, error: { code: "LEASE_RELEASE_FAILED" } },
  });
  const { analysis } = await makeFakeBranchAnalysis(t, pipeline);
  await assert.rejects(
    () => analysis.analyze("asset_a", { force: true }),
    (error) => {
      calls += 1;
      assert.equal(error.status, 400);
      assert.equal(error.code, "LEASE_RELEASE_FAILED");
      assert.equal(error.message, "分析队列租约释放失败");
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("T16f/T16g：JOB_NOT_FOUND 仅按本次 jobId + saved_at_ms 绑定，不冒充成功", async (t) => {
  const notFound = () => {
    const error = new Error("missing");
    error.code = "JOB_NOT_FOUND";
    return error;
  };
  const throwing = fakePipeline({
    submit: { id: "job_f", state: "queued" },
    get: () => {
      throw notFound();
    },
    cancel: () => {
      throw notFound();
    },
  });
  const { db, analysis } = await makeFakeBranchAnalysis(t, throwing);
  const insert = db.prepare(
    `INSERT INTO audio_result_records(asset_id, token_sha256, job_id, root_id, kind,
      library_generation, asset_generation, source_generation, context_json, fingerprint,
      payload_json, payload_bytes, payload_sha256, analyzed_ms, analyzed_at_ms, saved_at_ms, invalidated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    "asset_a",
    "0".repeat(64),
    "job_f",
    "root_01",
    "music",
    "1".repeat(32),
    "2".repeat(32),
    "3".repeat(32),
    "[]",
    "f".repeat(64),
    "{}",
    2,
    "e".repeat(64),
    1,
    2,
    3,
    null,
  );
  await assert.rejects(
    () => analysis.analyze("asset_a", { force: true }),
    (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "STORAGE_ERROR");
      assert.equal(error.message, "结果已保存，任务收尾未确认");
      return true;
    },
  );

  const other = await makeFakeBranchAnalysis(
    t,
    fakePipeline({
      submit: { id: "job_g", state: "queued" },
      get: () => {
        throw notFound();
      },
      cancel: () => {
        throw notFound();
      },
    }),
  );
  await assert.rejects(
    () => other.analysis.analyze("asset_a", { force: true }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "TIMEOUT");
      return true;
    },
  );
});


async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function prepareHttpData(t, base, tools) {
  const dataDir = path.join(base, "data");
  const mediaRoot = path.join(base, "media");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(mediaRoot, { recursive: true });
  const assetId = "http_asset_01";
  const bytes = Buffer.from("http synthetic audio bytes ".repeat(20));
  const file = path.join(mediaRoot, "http.wav");
  await fs.writeFile(file, bytes);
  const stat = await fs.stat(file);
  const trashHash = crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(PROJECT, "server/trash.swift")))
    .digest("hex")
    .slice(0, 12);
  await fs.writeFile(path.join(dataDir, `trash-helper-${trashHash}`), "", { mode: 0o755 });

  const library = await new Library(dataDir, { directoryClassification: true }).init();
  const root = await library.addRoot(mediaRoot, "music");
  library.db
    .prepare(
      `INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,dev,ino,sha256,duration,online,trashed)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(assetId, root.id, file, "http.wav", ".wav", "music", stat.size, stat.mtimeMs, stat.dev, stat.ino, sha256(bytes), null, 1, 0);
  library.db.close();

  await installFakeEngine(dataDir, tools.engine);
  const configPath = path.join(base, "audio-analysis-runtime.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      probe: {
        path: tools.probe,
        sha256: sha256(await fs.readFile(tools.probe)),
        version: "synthetic-1",
      },
      launcher: {
        path: tools.launcher,
        sha256: sha256(await fs.readFile(tools.launcher)),
      },
    }),
  );
  return { dataDir, mediaRoot, assetId, file, bytes, configPath };
}

async function startIndex(t, { dataDir, configPath, enabled = true }) {
  const port = await freePort();
  const env = {
    ...process.env,
    MEDIA_DATA_DIR: dataDir,
    MEDIA_SKIP_IMPORT: "1",
    MEDIA_SKIP_RECONCILE: "1",
    MEDIA_NO_WATCH: "1",
    MEDIA_CLOUD_AUDIO_ENABLED: "0",
    NODE_ENV: "production",
    PORT: String(port),
    SHIGUANG_AUDIO_ANALYSIS: enabled ? "1" : "",
    SHIGUANG_AUDIO_RUNTIME_CONFIG: configPath || "",
  };
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: PROJECT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  cleanupState(t).children.push({ label: "index server", child });
  const deadline = Date.now() + 15_000;
  let url = null;
  while (Date.now() < deadline) {
    const match = output.match(/拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      url = match[1];
      break;
    }
    if (child.exitCode !== null) throw new Error(`本地服务提前退出：\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(url, `本地服务未在期限内启动：\n${output}`);
  const session = await fetch(`${url}/api/session`);
  const setCookie = session.headers.getSetCookie?.()[0] || session.headers.get("set-cookie");
  const cookie = String(setCookie).split(";")[0];
  const { token } = await session.json();
  return { child, url, cookie, token, output: () => output };
}

function call(server, pathname, { method = "GET", body, token = true } = {}) {
  const headers = { cookie: server.cookie };
  if (method !== "GET" && token) headers["x-local-token"] = server.token;
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${server.url}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test(
  "T02 HTTP：真实 index 路由 -> 受控链 -> 落库，GET/缓存/force 响应形状兼容",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const base = await tempDir(t, "shiguang-mai-http-");
    const tools = await makeTools(t, base);
    const data = await prepareHttpData(t, base, tools);
    const server = await startIndex(t, data);
    const pathname = `/api/assets/${data.assetId}/analyze-audio`;

    const post = await call(server, pathname, { method: "POST", body: { force: true } });
    const postText = await post.text();
    assert.equal(post.status, 200, postText);
    const result = JSON.parse(postText);
    assert.equal(result.cached, false);
    assert.equal(result.asset_id, data.assetId);
    assert.equal(result.bpm, 120);
    assert.equal(result.structure_json, null);
    assert.equal(result.engine_version, ENGINE_RELEASE.version);
    assert.equal(postText.includes(data.dataDir), false, "响应不得泄露本机路径");

    const get = await call(server, `/api/assets/${data.assetId}/audio`);
    assert.equal(get.status, 200);
    const projected = await get.json();
    assert.equal(projected.asset_id, data.assetId);
    assert.equal(projected.bpm, 120);
    assert.equal("cached" in projected, false);

    const cached = await call(server, pathname, { method: "POST", body: { force: false } });
    const cachedBody = await cached.json();
    assert.equal(cached.status, 200);
    assert.equal(cachedBody.cached, true);

    const forced = await call(server, pathname, { method: "POST", body: { force: true } });
    const forcedBody = await forced.json();
    assert.equal(forced.status, 200);
    assert.equal(forcedBody.cached, false);

    const missing = await call(server, "/api/assets/no_such_asset/audio");
    assert.equal(missing.status, 200);
    assert.equal(await missing.json(), null);
  },
);

test(
  "T01 HTTP：功能关闭仍 503 AUDIO_FEATURE_DISABLED，且不建分析表/引擎目录",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const base = await tempDir(t, "shiguang-mai-http-off-");
    const tools = await makeTools(t, base);
    const data = await prepareHttpData(t, base, tools);
    // 关闭态使用全新 dataDir，避免成功用例已经建表造成误判。
    const offDir = path.join(base, "off-data");
    await fs.mkdir(offDir, { recursive: true });
    const server = await startIndex(t, { dataDir: offDir, configPath: "", enabled: false });
    for (const [method, pathname] of [
      ["GET", "/api/assets/any/audio"],
      ["POST", "/api/assets/any/analyze-audio"],
    ]) {
      const response = await call(server, pathname, { method, body: method === "POST" ? {} : undefined });
      const text = await response.text();
      assert.equal(response.status, 503, text);
      assert.equal(JSON.parse(text).code, "AUDIO_FEATURE_DISABLED");
    }
    const opened = new Database(path.join(offDir, "library.sqlite"), { readonly: true });
    const tables = opened
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    opened.close();
    for (const name of ["audio_result_records", "audio_result_commits", "audio_result_store_meta", "asset_audio"]) {
      assert.equal(tables.includes(name), false, `关闭态不得创建 ${name}`);
    }
    await assert.rejects(fs.access(path.join(offDir, "engines")), /ENOENT/);
    await assert.rejects(fs.access(path.join(offDir, "audio-jobs")), /ENOENT/);
  },
);


async function setEngineGeneration(dataDir, generation) {
  const engineRoot = path.join(dataDir, "engines", "audio");
  const pointerPath = path.join(engineRoot, "current.json");
  const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
  pointer.generation = generation;
  await fs.writeFile(pointerPath, JSON.stringify(pointer));
  const markerPath = path.join(engineRoot, "versions", pointer.dir, ".installed.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  marker.generation = generation;
  await fs.writeFile(markerPath, JSON.stringify(marker));
}

function executionCount(base) {
  return fs
    .readFile(path.join(base, "exec-count"), "utf8")
    .then((text) => text.trim().split("\n").filter(Boolean).length)
    .catch(() => 0);
}

test("T06b/T18：同版本新 generation 缓存 miss；新实例现场取 descriptor 后可命中", async (t) => {
  const { library, analysis, base, engine, tools } = await makeAnalysis(t);
  const first = await analysis.analyze("asset_a", { force: true });
  assert.equal(first.cached, false);
  assert.equal(await executionCount(base), 1);

  await setEngineGeneration(library.dataDir, "b".repeat(32));
  const afterReinstall = await analysis.analyze("asset_a", { force: false });
  assert.equal(afterReinstall.cached, false, "generation 变必须 miss");
  assert.equal(await executionCount(base), 2);
  const saved = record(library.db, "asset_a");
  assert.equal(saved.context_json.includes("b".repeat(32)), true);

  // 新实例：内存无 descriptor，仍必须现场 withRunLease 取得 fresh descriptor。
  const restarted = new AudioAnalysis(library.lib, engine, {
    dataDir: library.dataDir,
    probeTool: tools.probeTool,
    launcher: tools.launcherConfig,
    httpWaitMs: 5_000,
    cacheIdentityTimeoutMs: 2_000,
    wallDeadlineMs: 10_000,
  });
  cleanupState(t).components.push({ label: "restarted", dispose: () => restarted.dispose() });
  const reused = await restarted.analyze("asset_a", { force: false });
  assert.equal(reused.cached, true, "同一安装的 fresh descriptor 应允许命中");
  assert.equal(await executionCount(base), 2);
});

test("T08/T10/T19：源变更缓存 miss、probe 拒绝不 execute、损坏新记录回退旧行", async (t) => {
  const { library, analysis, base } = await makeAnalysis(t);
  await analysis.analyze("asset_a", { force: true });
  assert.equal(await executionCount(base), 1);

  await fs.writeFile(library.file, Buffer.concat([library.bytes, Buffer.from("changed")]));
  const changed = await analysis.analyze("asset_a", { force: false });
  assert.equal(changed.cached, false, "源文件变化必须 miss");
  assert.equal(await executionCount(base), 2);

  await fs.writeFile(path.join(base, "probe-video"), "1");
  await assert.rejects(
    () => analysis.analyze("asset_a", { force: true }),
    (error) => {
      assert.equal(error.code, "PROBE_REJECTED");
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(await executionCount(base), 2, "probe 拒绝不得 execute");
  await fs.rm(path.join(base, "probe-video"), { force: true });

  library.db.exec(`CREATE TABLE asset_audio (
    asset_id TEXT PRIMARY KEY, sha256 TEXT, bpm REAL, key_root TEXT, key_mode TEXT,
    loudness_rms REAL, loudness_peak REAL, energy_min REAL, energy_max REAL,
    duration REAL, structure_json TEXT, engine_version TEXT, analyzed_ms INTEGER, analyzed_at TEXT
  )`);
  library.db
    .prepare("INSERT INTO asset_audio VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("asset_a", sha256(library.bytes), 77, "E", "minor", -18, -2, -35, -5, 9, null, "0.8.0", 9, "2026-10-19T00:00:00.000Z");
  library.db.prepare("UPDATE audio_result_records SET payload_json='not-json' WHERE asset_id=?").run("asset_a");
  const fallback = await analysis.get("asset_a");
  assert.equal(fallback.asset_id, "asset_a");
  assert.equal(fallback.bpm, 77, "损坏新记录必须回退旧 asset_audio");
});


async function waitFor(check, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("T14：同 asset 并发提交合并为 1 个 job，两个响应都基于同一次成功", async (t) => {
  const { library, analysis, base } = await makeAnalysis(t);
  await fs.writeFile(path.join(base, "engine-gate"), "1");
  const first = analysis.analyze("asset_a", { force: true });
  await waitFor(async () => (await executionCount(base)) === 1, "第一个 job 进入 execute");
  const second = analysis.analyze("asset_a", { force: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(path.join(base, "engine-gate"), { force: true });
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.cached, false);
  assert.equal(two.cached, false);
  assert.equal(one.bpm, 120);
  assert.equal(two.bpm, 120);
  assert.equal(await executionCount(base), 1, "同 asset 并发不得重复 execute");
  const rows = library.db.prepare("SELECT COUNT(*) AS n FROM audio_result_records").get();
  assert.equal(rows.n, 1);

  // 已有旧记录 + 活跃 job 时，force=false 不得用旧缓存抢先返回，必须合并到活跃 job。
  await fs.writeFile(path.join(base, "engine-gate"), "1");
  const running = analysis.analyze("asset_a", { force: true });
  await waitFor(async () => (await executionCount(base)) === 2, "第二个 job 进入 execute");
  const merged = analysis.analyze("asset_a", { force: false });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.rm(path.join(base, "engine-gate"), { force: true });
  const [runningResult, mergedResult] = await Promise.all([running, merged]);
  assert.equal(runningResult.cached, false);
  assert.equal(mergedResult.cached, false, "活跃 job 存在时不得返回旧缓存");
  assert.equal(await executionCount(base), 2, "合并请求不得重复 execute");
});


async function addAssets(library, count) {
  const ids = [];
  const root = path.dirname(library.file);
  for (let index = 1; index <= count; index += 1) {
    const assetId = `asset_q${index}`;
    const bytes = Buffer.from(`queued synthetic audio ${index} `.repeat(10));
    const file = path.join(root, `${assetId}.wav`);
    await fs.writeFile(file, bytes);
    const stat = await fs.stat(file);
    library.db
      .prepare(
        `INSERT INTO assets(id,root_id,path,name,kind,size,mtime,dev,ino,sha256,duration,online,trashed)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(assetId, "root_01", file, path.basename(file), "music", stat.size, stat.mtimeMs, stat.dev, stat.ino, sha256(bytes), null, 1, 0);
    ids.push(assetId);
  }
  return ids;
}

test("T15：1 running + 8 queued 时第 10 个不同 asset 固定 429，前 9 个串行完成", async (t) => {
  const { library, analysis, base } = await makeAnalysis(t, { httpWaitMs: 20_000, wallDeadlineMs: 20_000 });
  const ids = await addAssets(library, 10);
  await fs.writeFile(path.join(base, "engine-gate"), "1");

  const firstNine = ids.slice(0, 9).map((assetId) => analysis.analyze(assetId, { force: true }));
  await waitFor(async () => (await executionCount(base)) === 1, "第一个 job 进入 execute");
  await new Promise((resolve) => setTimeout(resolve, 250));

  await assert.rejects(
    () => analysis.analyze(ids[9], { force: true }),
    (error) => {
      assert.equal(error.code, "AUDIO_QUEUE_FULL");
      assert.equal(error.status, 429);
      return true;
    },
  );
  await fs.rm(path.join(base, "engine-gate"), { force: true });
  const results = await Promise.all(firstNine);
  assert.equal(results.length, 9);
  assert.equal(results.every((item) => item.cached === false), true);
  assert.equal(await executionCount(base), 9);
  const rows = library.db.prepare("SELECT COUNT(*) AS n FROM audio_result_records").get();
  assert.equal(rows.n, 9);
});


test("T20：probe 未知资源事实在 runner 边界保留，pipeline retain 安装锁", async (t) => {
  const { library, analysis, base } = await makeAnalysis(t);
  analysis.limits = { wallMs: 5_000, termGraceMs: 1 };
  const originalProbe = AudioExecutor.prototype.probe;
  const originalRm = fs.rm;
  let executorUnknown = false;
  fs.rm = async function (target, ...args) {
    if (String(target).startsWith(path.join(library.dataDir, "audio-executor", "jobs") + path.sep)) {
      // 仅本用例私有 executor job 目录：模拟清理悬停，保留 unknown 现场。
      return new Promise(() => {});
    }
    return originalRm.call(this, target, ...args);
  };
  AudioExecutor.prototype.probe = async function (...args) {
    try {
      return await originalProbe.apply(this, args);
    } catch (error) {
      executorUnknown = error?.evidence?.resourceUnknown === true;
      throw error;
    }
  };

  let error;
  try {
    error = await analysis.analyze("asset_a", { force: true }).catch((failure) => failure);
  } finally {
    AudioExecutor.prototype.probe = originalProbe;
    fs.rm = originalRm;
    // 先于断言标记保留：断言失败时也不能把 unknown 现场/锁当普通根删掉。
    preserveInventory(t, "probe resource unknown retained");
  }

  assert.equal(executorUnknown, true);
  assert.equal(error.code, "PROBE_REJECTED");
  const lock = path.join(library.dataDir, "engines", ".audio-install.lock");
  const lockRetained = await fs.lstat(lock).then(() => true, (failure) => {
    if (failure.code === "ENOENT") return false;
    throw failure;
  });
  const retainedJobs = await fs.readdir(path.join(library.dataDir, "audio-executor", "jobs"));
  assert.equal(retainedJobs.length > 0, true, "unknown executor job 目录必须保留");
  assert.equal(lockRetained, true, "pipeline 必须 retain probe 安装锁");

  // 实际子进程必须已退出；不能用“目录还在”代替进程事实，也不能用 pgrep 0 代替。
  await waitFor(
    () => trackedChildrenUnder(cleanupState(t)).every((child) => hasExited(child)),
    "synthetic executor child exit",
    5_000,
  );
});

test("T21：190s 总预算包含初始化，超时后不得 submit", async (t) => {
  let submitted = 0;
  const { analysis } = await makeFakeBranchAnalysis(
    t,
    fakePipeline({
      submit: () => {
        submitted += 1;
        return { id: "review_job", state: "failed", error: { code: "ENGINE_FAILED" } };
      },
    }),
  );
  const original = analysis.init.bind(analysis);
  analysis.init = async () => {
    await new Promise((resolve) => setTimeout(resolve, 180));
    return original();
  };
  const started = performance.now();
  const error = await analysis.analyze("asset_a", { force: true }).catch((failure) => failure);
  const elapsed = performance.now() - started;
  assert.equal(error.code, "TIMEOUT");
  assert.equal(submitted, 0, "初始化超过总预算后不得 submit");
  assert.equal(elapsed < 170, true, `入口预算必须覆盖初始化，实际 ${elapsed}ms`);
});

test("T22：JOB_NOT_FOUND 的 saved_at_ms 只接受无损安全整数", async (t) => {
  const notFound = () => Object.assign(new Error("missing"), { code: "JOB_NOT_FOUND" });
  const { db, analysis } = await makeFakeBranchAnalysis(
    t,
    fakePipeline({
      submit: { id: "job_t", state: "queued" },
      get: () => {
        throw notFound();
      },
      cancel: () => {
        throw notFound();
      },
    }),
  );
  const insert = db.prepare(
    `INSERT INTO audio_result_records(asset_id, token_sha256, job_id, root_id, kind,
      library_generation, asset_generation, source_generation, context_json, fingerprint,
      payload_json, payload_bytes, payload_sha256, analyzed_ms, analyzed_at_ms, saved_at_ms, invalidated_at_ms)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    "asset_a", "0".repeat(64), "job_t", "root_01", "music",
    "1".repeat(32), "2".repeat(32), "3".repeat(32), "[]", "f".repeat(64),
    "{}", 2, "e".repeat(64), 1, 2, " ", null,
  );

  // 实际 SQLite TEXT 空白：Number(' ') 会假变成 0，必须拒绝。
  const whitespace = await analysis.analyze("asset_a", { force: true }).catch((failure) => failure);
  assert.equal(whitespace.code, "TIMEOUT");
  assert.equal(whitespace.status, 400);

  // SQLite INTEGER affinity 会把 "03"/"3.0" 规范成数字，字符串严格性用同一查询的
  // 驱动返回值定向验证；不伪造存储层事实，也不改产品查询。
  const originalPrepare = db.prepare.bind(db);
  let savedOverride = 3;
  db.prepare = (sql) => {
    if (typeof sql === "string" && sql.includes("SELECT job_id, saved_at_ms")) {
      return { get: () => ({ job_id: "job_t", saved_at_ms: savedOverride }) };
    }
    return originalPrepare(sql);
  };
  for (const invalid of [" ", "", "03", "3.0", "9007199254740993", "-1", 3.5, -1, true, null, {}, []]) {
    savedOverride = invalid;
    const error = await analysis.analyze("asset_a", { force: true }).catch((failure) => failure);
    assert.equal(error.code, "TIMEOUT", `saved_at_ms=${JSON.stringify(invalid)} 不得当作保存事实`);
    assert.equal(error.status, 400);
  }
  for (const valid of [3, "3"]) {
    savedOverride = valid;
    const error = await analysis.analyze("asset_a", { force: true }).catch((failure) => failure);
    assert.equal(error.code, "STORAGE_ERROR", `saved_at_ms=${JSON.stringify(valid)} 是合法保存事实`);
    assert.equal(error.status, 503);
  }
});

test("T23：缺运行配置失败后补正确 JSON，可显式重试恢复且不重建健康 pipeline", async (t) => {
  const { base, library, tools, engine } = await makeAnalysis(t);
  const config = path.join(base, "late-runtime.json");
  const late = new AudioAnalysis(library.lib, engine, {
    dataDir: library.dataDir,
    runtimeConfigPath: config,
    httpWaitMs: 8_000,
  });
  cleanupState(t).components.push({ label: "late analysis", dispose: () => late.dispose() });

  assert.equal(await late.get("asset_a"), null);
  await fs.writeFile(
    config,
    JSON.stringify({
      probe: { path: tools.probe, sha256: sha256(await fs.readFile(tools.probe)), version: "synthetic-1" },
      launcher: { path: tools.launcher, sha256: sha256(await fs.readFile(tools.launcher)) },
    }),
  );
  const result = await late.analyze("asset_a", { force: true });
  assert.equal(result.cached, false);
  assert.equal(result.bpm, 120);
  const again = await late.analyze("asset_a", { force: false });
  assert.equal(again.cached, true, "恢复后健康 pipeline 必须复用");
});

test("T21b：缓存 stat 等候受同一总截止约束，超时后不得 submit", async (t) => {
  let submitted = 0;
  const { analysis, base } = await makeFakeBranchAnalysis(
    t,
    fakePipeline({
      submit: () => {
        submitted += 1;
        return { id: "cache_job", state: "failed", error: { code: "ENGINE_FAILED" } };
      },
    }),
  );
  const assetPath = path.join(base, "a.wav");
  const originalStat = fs.stat;
  fs.stat = async function stalledStat(target, ...args) {
    if (String(target) === assetPath) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return originalStat.call(this, target, ...args);
  };
  try {
    const error = await analysis.analyze("asset_a", { force: false }).catch((failure) => failure);
    assert.equal(error.code, "TIMEOUT");
    assert.equal(error.status, 400);
    assert.equal(submitted, 0, "缓存身份等候超过总预算后不得 submit");
  } finally {
    fs.stat = originalStat;
  }
});

test("T23b：运行配置恢复的并发显式重试只创建一次健康 pipeline", async (t) => {
  const { base, library, tools, engine } = await makeAnalysis(t);
  const config = path.join(base, "late-concurrent-runtime.json");
  const late = new AudioAnalysis(library.lib, engine, {
    dataDir: library.dataDir,
    runtimeConfigPath: config,
    httpWaitMs: 8_000,
  });
  cleanupState(t).components.push({ label: "late concurrent analysis", dispose: () => late.dispose() });

  assert.equal(await late.get("asset_a"), null);
  await fs.writeFile(
    config,
    JSON.stringify({
      probe: { path: tools.probe, sha256: sha256(await fs.readFile(tools.probe)), version: "synthetic-1" },
      launcher: { path: tools.launcher, sha256: sha256(await fs.readFile(tools.launcher)) },
    }),
  );

  let initCalls = 0;
  const originalPipelineInit = AudioAnalysisPipeline.prototype.init;
  AudioAnalysisPipeline.prototype.init = function countedPipelineInit(...args) {
    initCalls += 1;
    return originalPipelineInit.apply(this, args);
  };
  try {
    await Promise.all([late.init(), late.init(), late.init()]);
  } finally {
    AudioAnalysisPipeline.prototype.init = originalPipelineInit;
  }
  assert.equal(initCalls, 1, "并发显式重试只允许创建一个健康 pipeline/queue");

  const first = await late.analyze("asset_a", { force: true });
  assert.equal(first.cached, false);
  const cached = await late.analyze("asset_a", { force: false });
  assert.equal(cached.cached, true, "恢复后健康 pipeline 必须复用");
});

test("T24：迟到 submit 被所有权观察接管，queued/running 都走 cancel，迟到拒绝被消费", async (t) => {
  for (const state of ["queued", "running"]) {
    const seen = { accepted: 0, cancelled: 0 };
    const pipeline = fakePipeline({
      submit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        seen.accepted += 1;
        return { id: `late_${state}`, state };
      },
      get: { id: `late_${state}`, state },
      cancel: () => {
        seen.cancelled += 1;
        return { id: `late_${state}`, state: "cancelled" };
      },
    });
    const { analysis } = await makeFakeBranchAnalysis(t, pipeline);
    analysis.httpWaitMs = 25;
    const error = await analysis.analyze("asset_a", { force: true }).catch((failure) => failure);
    assert.equal(error.code, "TIMEOUT");
    await waitFor(() => seen.cancelled === 1, `late ${state} submit cancel`, 2_000);
    assert.equal(seen.accepted, 1, `late ${state} 必须被接受一次`);
    assert.equal(seen.cancelled, 1, `late ${state} job 不得在超时后被静默遗弃`);
  }

  let rejected = 0;
  let cancelled = 0;
  const pipeline = fakePipeline({
    submit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      rejected += 1;
      throw Object.assign(new Error("late rejection"), { code: "ENGINE_FAILED" });
    },
    cancel: () => {
      cancelled += 1;
      return { id: "late_reject", state: "cancelled" };
    },
  });
  const { analysis } = await makeFakeBranchAnalysis(t, pipeline);
  analysis.httpWaitMs = 25;
  const error = await analysis.analyze("asset_a", { force: true }).catch((failure) => failure);
  assert.equal(error.code, "TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(rejected, 1, "迟到拒绝必须被观察并消费");
  assert.equal(cancelled, 0, "迟到拒绝不得重试提交或调用 cancel");
});

test("T25：历史 GET 只等待 store，运行配置读取未放行时仍返回旧行", async (t) => {
  const { library, engine, tools, base } = await makeAnalysis(t);
  library.db.exec("CREATE TABLE asset_audio(asset_id TEXT PRIMARY KEY,bpm REAL)");
  library.db.prepare("INSERT INTO asset_audio VALUES (?,?)").run("asset_a", 90);
  const config = path.join(base, "gated-runtime.json");
  await fs.writeFile(
    config,
    JSON.stringify({
      probe: { path: tools.probe, sha256: sha256(await fs.readFile(tools.probe)), version: "synthetic-1" },
      launcher: { path: tools.launcher, sha256: sha256(await fs.readFile(tools.launcher)) },
    }),
  );
  const late = new AudioAnalysis(library.lib, engine, {
    dataDir: library.dataDir,
    runtimeConfigPath: config,
    httpWaitMs: 8_000,
  });
  cleanupState(t).components.push({ label: "gated runtime analysis", dispose: () => late.dispose() });

  let release;
  let arrived;
  const hold = new Promise((resolve) => (release = resolve));
  const arrivedPromise = new Promise((resolve) => (arrived = resolve));
  const originalReadFile = fs.readFile;
  fs.readFile = async function gatedReadFile(file, ...args) {
    if (String(file) === config) {
      arrived();
      await hold;
    }
    return originalReadFile.call(this, file, ...args);
  };
  const pending = late.get("asset_a");
  try {
    await Promise.race([
      arrivedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("GET 未启动共享运行初始化")), 500)),
    ]);
    const state = await Promise.race([
      pending.then((value) => ({ ready: true, bpm: value?.bpm })),
      new Promise((resolve) => setTimeout(() => resolve({ ready: false }), 70)),
    ]);
    assert.equal(state.ready, true, "历史读取不得等待运行配置 I/O");
    assert.equal(state.bpm, 90);
  } finally {
    release();
    fs.readFile = originalReadFile;
    await pending;
    await late.init().catch(() => {});
  }
});

test("T26：三个可选时间预算只降不升，超上限固定 INVALID_REQUEST", async (t) => {
  const base = await tempDir(t);
  const db = new Database(":memory:");
  cleanupState(t).closers.push({ label: "budget db", close: () => db.close() });
  const lib = { db, locks: new Set() };
  const engine = { binaryPath: "/synthetic/engine", withRunLease: async () => {} };
  for (const [key, value] of [
    ["httpWaitMs", 190_001],
    ["cacheIdentityTimeoutMs", 15_001],
    ["cancelSettleMs", 2_001],
  ]) {
    assert.throws(
      () => new AudioAnalysis(lib, engine, { dataDir: base, [key]: value }),
      (error) => error.code === "INVALID_REQUEST",
      `${key} 超过批准上限必须拒绝`,
    );
  }
  const lowered = new AudioAnalysis(lib, engine, {
    dataDir: base,
    httpWaitMs: 190_000,
    cacheIdentityTimeoutMs: 15_000,
    cancelSettleMs: 2_000,
    wallDeadlineMs: 180_000,
  });
  assert.equal(lowered.httpWaitMs, 190_000);
  assert.equal(lowered.cacheIdentityTimeoutMs, 15_000);
  assert.equal(lowered.cancelSettleMs, 2_000);
  assert.equal(lowered.wallDeadlineMs, 180_000);
  await lowered.dispose();
});

test("T27：unknown 桥接保留已确认 closeSettled=true，不凭空改成 false", async (t) => {
  const { analysis, engine } = await makeAnalysis(t);
  let projected;
  const scope = engine.withLifecycleScope.bind(engine);
  engine.withLifecycleScope = (callback, options) =>
    scope(async (guard) => {
      try {
        return await callback(guard);
      } catch (error) {
        projected = error.evidence;
        throw error;
      }
    }, options);
  const originalProbe = AudioExecutor.prototype.probe;
  AudioExecutor.prototype.probe = () =>
    Promise.reject(
      Object.assign(new Error("synthetic fixed boundary"), {
        code: "EXECUTION_UNAVAILABLE",
        evidence: { resourceUnknown: true, closeSettled: true },
      }),
    );
  try {
    await analysis.analyze("asset_a", { force: true }).catch(() => {});
  } finally {
    AudioExecutor.prototype.probe = originalProbe;
    // 该固定证据会触发既有 retain；unknown 现场/锁按合同保留。
    preserveInventory(t, "synthetic close fact retained");
  }
  assert.equal(projected?.resourceUnknown, true);
  assert.equal(projected?.closeSettled, true, "已确认 close 事实不得被 unknown 改写成 false");
});

test("T27b：没有 close 观测时省略 closeSettled，不凭空造 false", async (t) => {
  const { analysis, engine } = await makeAnalysis(t);
  let projected;
  const scope = engine.withLifecycleScope.bind(engine);
  engine.withLifecycleScope = (callback, options) =>
    scope(async (guard) => {
      try {
        return await callback(guard);
      } catch (error) {
        projected = error.evidence;
        throw error;
      }
    }, options);
  const originalProbe = AudioExecutor.prototype.probe;
  AudioExecutor.prototype.probe = () =>
    Promise.reject(
      Object.assign(new Error("synthetic fixed boundary"), {
        code: "EXECUTION_UNAVAILABLE",
        evidence: { resourceUnknown: true },
      }),
    );
  try {
    await analysis.analyze("asset_a", { force: true }).catch(() => {});
  } finally {
    AudioExecutor.prototype.probe = originalProbe;
    preserveInventory(t, "synthetic omitted close fact retained");
  }
  assert.equal(projected?.resourceUnknown, true);
  assert.equal(Object.hasOwn(projected, "closeSettled"), false, "未观测 close 时不得补 false");
});

test("T28：仅观测 closeSettled=false 也桥接 retain，且不伪造 resourceUnknown", async (t) => {
  const { analysis, engine, library } = await makeAnalysis(t);
  let projected;
  const scope = engine.withLifecycleScope.bind(engine);
  engine.withLifecycleScope = (callback, options) =>
    scope(async (guard) => {
      try {
        return await callback(guard);
      } catch (error) {
        projected = error.evidence;
        throw error;
      }
    }, options);
  const originalProbe = AudioExecutor.prototype.probe;
  AudioExecutor.prototype.probe = () =>
    Promise.reject(
      Object.assign(new Error("synthetic fixed close-only boundary"), {
        code: "TIMEOUT",
        evidence: { closeSettled: false },
      }),
    );
  try {
    await analysis.analyze("asset_a", { force: true }).catch(() => {});
  } finally {
    AudioExecutor.prototype.probe = originalProbe;
    preserveInventory(t, "synthetic close-only fact retained");
  }
  assert.equal(projected?.closeSettled, false, "close=false 必须独立进入 pipeline retain 证据");
  assert.equal(
    Object.hasOwn(projected ?? {}, "resourceUnknown"),
    false,
    "未观测 resourceUnknown 时不得伪造 true",
  );
  const lock = path.join(library.dataDir, "engines", ".audio-install.lock");
  const lockRetained = await fs.lstat(lock).then(() => true, (failure) => {
    if (failure.code === "ENOENT") return false;
    throw failure;
  });
  assert.equal(lockRetained, true, "close-only unknown 必须 retain 安装锁");
});

test("T28b：resourceUnknown=false 与 closeSettled=false 并存时仍只保留观测布尔", async (t) => {
  const { analysis, engine } = await makeAnalysis(t);
  let projected;
  const scope = engine.withLifecycleScope.bind(engine);
  engine.withLifecycleScope = (callback, options) =>
    scope(async (guard) => {
      try {
        return await callback(guard);
      } catch (error) {
        projected = error.evidence;
        throw error;
      }
    }, options);
  const originalProbe = AudioExecutor.prototype.probe;
  AudioExecutor.prototype.probe = () =>
    Promise.reject(
      Object.assign(new Error("synthetic fixed close-only boundary"), {
        code: "TIMEOUT",
        evidence: { resourceUnknown: false, closeSettled: false },
      }),
    );
  try {
    await analysis.analyze("asset_a", { force: true }).catch(() => {});
  } finally {
    AudioExecutor.prototype.probe = originalProbe;
    preserveInventory(t, "synthetic close-only false variant retained");
  }
  assert.equal(projected?.closeSettled, false);
  assert.equal(Object.hasOwn(projected ?? {}, "resourceUnknown"), false);
});
