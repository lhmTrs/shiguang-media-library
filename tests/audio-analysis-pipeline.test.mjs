/**
 * T-LOCAL-013G 定向测试：合成分析流水线、saving/commit/abort 与 token 定向撤销。
 *
 * 只用临时目录、合成文件、内存 SQLite 与合成 probe/executor；不启动服务/引擎、
 * 不读写真实素材库、不联网、不访问云端账户、不部署。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { AudioResultStore } from "../server/audio-result-store.mjs";
import { AudioAnalysisPipeline } from "../server/audio-analysis-pipeline.mjs";
import { AudioQueueError } from "../server/audio-job-queue.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(fn, label, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await delay(5);
  }
}

async function waitState(pipeline, id, state) {
  return waitFor(async () => {
    try {
      const job = await pipeline.get(id);
      return job.state === state ? job : null;
    } catch {
      return null;
    }
  }, `${id} -> ${state}`);
}

async function tempBase(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-pipeline-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const SHA = (value) => createHash("sha256").update(value).digest("hex");

function rawResult(over = {}) {
  return JSON.stringify({
    bpm: 120,
    key: { best: "C major", r: 0.8 },
    loud: { peak: 2.5, rms: -12 },
    energy: { min: -30, max: -4, std: 3 },
    fit: { beat: 0.9, tonal: 0.8, chord: 0.5 },
    seg: [0, 5, 10],
    ...over,
  });
}

async function harness(t, overrides = {}) {
  const base = await tempBase(t);
  const root = path.join(base, "media");
  const dataDir = path.join(base, "data");
  await fs.mkdir(root, { recursive: true });
  const assetId = overrides.assetId ?? "asset_a";
  const kind = overrides.kind ?? "music";
  const bytes = Buffer.from(overrides.bytes ?? "synthetic audio bytes for T13G ".repeat(32));
  const file = path.join(root, `${assetId}.bin`);
  await fs.writeFile(file, bytes);
  const digest = SHA(bytes);

  const generation = {
    libraryGeneration: "1".repeat(32),
    assetGeneration: "2".repeat(32),
    sourceGeneration: "3".repeat(32),
  };
  const descriptor = Object.freeze({
    version: "1.2.3",
    binarySha256: "b".repeat(64),
    generation: "c".repeat(32),
  });
  const current = {
    assetId,
    rootId: "root_01",
    kind,
    online: true,
    trashed: false,
    retired: false,
    rootRetired: false,
    busy: false,
    ...generation,
  };
  const probeValue = Object.freeze({
    durationSec: 12.5,
    channels: 2,
    sampleRate: 44_100,
    totalSamples: 551_250,
    format: "wav",
  });
  const contextFor = (probe) => ({
    kind,
    sourceSha256: digest,
    sourceSize: bytes.length,
    durationSec: probe.durationSec,
    engineVersion: descriptor.version,
    engineBinarySha256: descriptor.binarySha256,
    engineGeneration: descriptor.generation,
    parameters: { brief: true },
  });
  const state = {
    visible: true,
    current: { ...current },
    context: contextFor(probeValue),
    resolveCurrentCalls: 0,
    probeCalls: 0,
    leaseCalls: 0,
    executeCalls: 0,
  };

  const resolveCurrent =
    overrides.resolveCurrent ??
    ((id) => {
      state.resolveCurrentCalls += 1;
      if (!state.visible || id !== assetId) return null;
      return { ...state.current, context: state.context };
    });
  const resolveAsset = async (id) => {
    const cur = resolveCurrent(id);
    if (!cur) return null;
    return {
      assetId: cur.assetId,
      kind: cur.kind,
      sourcePath: file,
      rootPath: root,
      rootId: cur.rootId,
      online: cur.online,
      trashed: cur.trashed,
      retired: cur.retired,
      rootRetired: cur.rootRetired,
      busy: cur.busy,
      assetGeneration: cur.assetGeneration,
      libraryGeneration: cur.libraryGeneration,
      sourceGeneration: cur.sourceGeneration,
    };
  };
  const probe =
    overrides.probe ??
    (async () => {
      state.probeCalls += 1;
      return probeValue;
    });
  const withRunLease =
    overrides.withRunLease ??
    (async (callback, { signal } = {}) => {
      state.leaseCalls += 1;
      return callback(descriptor, signal);
    });
  const execute =
    overrides.execute ??
    (async () => {
      state.executeCalls += 1;
      return rawResult();
    });

  const db = new Database(path.join(base, "store.sqlite"));
  const store = new AudioResultStore({ db, resolveCurrent: (id) => resolveCurrent(id) });
  const pipeline = new AudioAnalysisPipeline({
    dataDir,
    resolveAsset,
    store,
    resolveCurrent,
    probe,
    withRunLease,
    execute,
    wallDeadlineMs: overrides.wallDeadlineMs ?? 1000,
    maxSnapshotBytes: overrides.maxSnapshotBytes ?? 1024 * 1024,
    maxWaiting: overrides.maxWaiting ?? 8,
    hooks: overrides.hooks ?? {},
  });
  t.after(async () => {
    await pipeline.dispose().catch(() => {});
    try {
      db.close();
    } catch {}
  });
  if (overrides.init !== false) pipeline.init();
  return {
    base,
    root,
    dataDir,
    file,
    bytes,
    digest,
    assetId,
    kind,
    descriptor,
    probeValue,
    contextFor,
    state,
    db,
    store,
    pipeline,
    lockPath: path.join(dataDir, "audio-jobs", ".queue-lease"),
    jobsPath: path.join(dataDir, "audio-jobs"),
  };
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

async function jobDirs(jobsPath) {
  const entries = await fs.readdir(jobsPath).catch(() => []);
  return entries.filter((name) => name.startsWith("job-"));
}

test("T13G 音乐成功链：真实快照 digest 入 provenance、saving 提交、resultSaved 且无路径/token 泄漏", async (t) => {
  const seen = [];
  const h = await harness(t, {
    hooks: {
      async afterSnapshot() {
        seen.push("snapshot");
      },
      async afterExecute() {
        seen.push("execute");
      },
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  await waitState(h.pipeline, job.id, "succeeded");
  const done = await h.pipeline.get(job.id);
  assert.equal(done.resultSaved, true);
  assert.equal(done.error, null);
  assert.deepEqual(seen, ["snapshot", "execute"]);
  const result = h.pipeline.getResult(h.assetId);
  assert.equal(result.status, "ready");
  assert.equal(result.result.provenance.sourceSha256, h.digest);
  assert.equal(result.result.provenance.sourceSize, h.bytes.length);
  assert.equal(result.result.provenance.durationSec, h.probeValue.durationSec);
  assert.equal(result.result.provenance.engineBinarySha256, h.descriptor.binarySha256);
  assert.equal(count(h.db, "audio_result_records"), 1);
  const commit = h.db.prepare("SELECT consumed_at_ms FROM audio_result_commits").get();
  assert.notEqual(commit.consumed_at_ms, null);
  assert.deepEqual(await jobDirs(h.jobsPath), []);
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);

  const summaryText = JSON.stringify(done);
  assert.doesNotMatch(summaryText, new RegExp(h.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(summaryText, /token|bpm|sha256|filePath|raw/i);
});

test("T13G sfx 成功链与相同上限；snapshot 内实际字节数进入 context", async (t) => {
  const h = await harness(t, { kind: "sfx", assetId: "asset_sfx" });
  h.state.context = h.contextFor(h.probeValue);
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "succeeded");
  assert.equal(done.resultSaved, true);
  const result = h.pipeline.getResult(h.assetId);
  assert.equal(result.status, "ready");
  assert.equal(result.result.provenance.kind, "sfx");
  assert.equal(result.result.provenance.sourceSize, h.bytes.length);
});

test("T13G probe 各限制：坏探测固定 PROBE_REJECTED，不产生资格/结果/残留", async (t) => {
  const cases = [
    { durationSec: -1 },
    { durationSec: 601 },
    { durationSec: Number.NaN },
    { channels: 0 },
    { channels: 3 },
    { sampleRate: 0 },
    { sampleRate: 48_001 },
    { totalSamples: 60_000_001 },
    { totalSamples: 1.5 },
    { format: "exe" },
    { durationSec: "12" },
  ];
  for (const over of cases) {
    const h = await harness(t, {
      probe: async () => ({ ...h0Probe(), ...over }),
    });
    const job = await h.pipeline.submit(h.assetId);
    const done = await waitState(h.pipeline, job.id, "failed");
    assert.equal(done.error.code, "PROBE_REJECTED", JSON.stringify(over));
    assert.equal(done.resultSaved, false);
    assert.equal(count(h.db, "audio_result_records"), 0);
    assert.equal(count(h.db, "audio_result_commits"), 0);
    assert.deepEqual(await jobDirs(h.jobsPath), []);
    assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
  }

  function h0Probe() {
    return {
      durationSec: 12.5,
      channels: 2,
      sampleRate: 44_100,
      totalSamples: 551_250,
      format: "wav",
    };
  }
});

test("T13G 坏 raw/超 64KiB raw：固定 INVALID_OUTPUT，token 定向撤销且无结果", async (t) => {
  for (const raw of ["not json", JSON.stringify({ seg: "bad" }), "x".repeat(64 * 1024 + 1)]) {
    const h = await harness(t, { execute: async () => raw });
    const job = await h.pipeline.submit(h.assetId);
    const done = await waitState(h.pipeline, job.id, "failed");
    assert.equal(done.error.code, "INVALID_OUTPUT", String(raw).slice(0, 12));
    assert.equal(done.resultSaved, false);
    assert.equal(count(h.db, "audio_result_records"), 0);
    const commit = h.db.prepare("SELECT consumed_at_ms FROM audio_result_commits").get();
    assert.notEqual(commit.consumed_at_ms, null, "失败后 token 必须已撤销");
    assert.equal(h.pipeline.getResult(h.assetId).status, "missing");
  }
});

test("T13G 引擎租约失败/执行拒绝：无资格或定向撤销，错误不透传自定义文案", async (t) => {
  const lease = await harness(t, {
    withRunLease: async () => {
      throw new Error("secret /tmp/engine path");
    },
  });
  let job = await lease.pipeline.submit(lease.assetId);
  let done = await waitState(lease.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ENGINE_LEASE_FAILED");
  assert.doesNotMatch(done.error.message, /secret|tmp|engine path/);
  assert.equal(count(lease.db, "audio_result_commits"), 0);

  const exec = await harness(t, {
    execute: async () => {
      throw new Error("secret /tmp/exec path");
    },
  });
  job = await exec.pipeline.submit(exec.assetId);
  done = await waitState(exec.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ENGINE_FAILED");
  assert.doesNotMatch(done.error.message, /secret|tmp|exec path/);
  assert.equal(count(exec.db, "audio_result_records"), 0);
  assert.notEqual(exec.db.prepare("SELECT consumed_at_ms FROM audio_result_commits").get().consumed_at_ms, null);
});

test("T13G 超时/执行中取消：token 撤销、无结果；超时清理未 settle 保留租约，取消可释放", async (t) => {
  const timed = await harness(t, {
    wallDeadlineMs: 40,
    execute: async () => {
      await delay(160);
      return rawResult();
    },
  });
  let job = await timed.pipeline.submit(timed.assetId);
  let done = await waitState(timed.pipeline, job.id, "failed");
  // T13I round2 合同调整：execute 越过 deadline 后清理只剩 0 预算，不得无界等待，
  // 终态固定为 CLEANUP_FAILED 并保留故障租约；原“租约已释放”断言随之作废。
  assert.equal(done.error.code, "CLEANUP_FAILED");
  assert.equal(timed.pipeline.getResult(timed.assetId).status, "missing");
  assert.notEqual(timed.db.prepare("SELECT consumed_at_ms FROM audio_result_commits").get().consumed_at_ms, null);
  assert.ok(await fs.lstat(timed.lockPath), "超时清理未 settle 必须保留故障租约");

  const gate = deferred();
  const cancelling = await harness(t, {
    execute: async () => {
      await gate.promise;
      return rawResult();
    },
  });
  job = await cancelling.pipeline.submit(cancelling.assetId);
  await waitState(cancelling.pipeline, job.id, "running");
  const requested = await cancelling.pipeline.cancel(job.id);
  assert.equal(requested.state, "cancelling");
  gate.resolve();
  done = await waitState(cancelling.pipeline, job.id, "cancelled");
  assert.equal(done.resultSaved, false);
  assert.equal(cancelling.pipeline.getResult(cancelling.assetId).status, "missing");
  assert.equal(await fs.lstat(cancelling.lockPath).catch(() => null), null);
});

test("T13G dispose 等待执行 settle/清理，之后拒绝新任务且不自动恢复", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    execute: async () => {
      await gate.promise;
      return rawResult();
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  await waitState(h.pipeline, job.id, "running");
  const disposing = h.pipeline.dispose();
  gate.resolve();
  await disposing;
  assert.equal((await h.pipeline.get(job.id)).state, "cancelled");
  assert.equal(h.pipeline.getResult(h.assetId).status, "missing");
  await assert.rejects(h.pipeline.submit(h.assetId), (error) => error.code === "PIPELINE_DISPOSED");
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
});

test("T13G 执行中同对象 generation 变化：不落库、abort 撤销新 token、消息固定", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    execute: async () => {
      await gate.promise;
      return rawResult();
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  await waitState(h.pipeline, job.id, "running");
  h.state.current.assetGeneration = "9".repeat(32);
  gate.resolve();
  const done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "SOURCE_CHANGED");
  assert.equal(done.resultSaved, false);
  assert.equal(count(h.db, "audio_result_records"), 0);
  const commit = h.db.prepare("SELECT consumed_at_ms FROM audio_result_commits").get();
  assert.notEqual(commit.consumed_at_ms, null, "源复查失败必须撤销产物 token");
  assert.equal(h.pipeline.getResult(h.assetId).status, "missing");
});

test("T13G 提交时 context 变化：save 同步重验失败，旧成功不被覆盖且 token 撤销", async (t) => {
  const h = await harness(t, {
    hooks: {
      async afterExecute() {
        // 文件/管理身份不变，但可信 context（时长）改变：只能由 store.save 的同步事务发现。
        h.state.context = { ...h.state.context, durationSec: 99 };
      },
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "IDENTITY_CHANGED");
  assert.equal(done.resultSaved, false);
  assert.equal(count(h.db, "audio_result_records"), 0);
  assert.notEqual(h.db.prepare("SELECT consumed_at_ms FROM audio_result_commits").get().consumed_at_ms, null);
});

test("T13G 快照清理失败：不 commit、无结果、保留故障 busy/租约", async (t) => {
  const h = await harness(t, {
    hooks: {
      async afterSnapshot({ snapshot }) {
        snapshot.cleanup = async () => {
          throw new Error("cleanup failure /tmp/secret");
        };
      },
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "CLEANUP_FAILED");
  assert.equal(done.resultSaved, false);
  assert.equal(count(h.db, "audio_result_records"), 0);
  assert.notEqual(h.db.prepare("SELECT consumed_at_ms FROM audio_result_commits").get().consumed_at_ms, null);
  assert.ok(await fs.lstat(h.lockPath), "清理失败保留故障锁");
  const blocked = await h.pipeline.submit(h.assetId);
  await delay(20);
  assert.equal((await h.pipeline.get(blocked.id)).state, "queued", "故障后不得启动下一项");
});

test("T13G 未 init 拒绝 submit/getResult；init 显式且幂等；旧 token 撤销不影响新成功", async (t) => {
  const h = await harness(t, { init: false });
  await assert.rejects(h.pipeline.submit(h.assetId), (error) => error.code === "PIPELINE_NOT_INITIALIZED");
  assert.throws(() => h.pipeline.getResult(h.assetId), (error) => error.code === "PIPELINE_NOT_INITIALIZED");
  assert.deepEqual(h.pipeline.init(), { ok: true, schemaVersion: 1, created: true });
  assert.deepEqual(h.pipeline.init(), { ok: true, schemaVersion: 1, created: false });

  const old = h.store.begin(h.assetId, "old_job", { ...h.state.current, context: h.state.context });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "succeeded");
  assert.equal(done.resultSaved, true);
  assert.equal(h.pipeline.getResult(h.assetId).status, "ready");
  const late = h.store.invalidateToken(old.token);
  assert.deepEqual(late, { ok: true, tokenMatched: false, revokedCommit: false, invalidatedResult: false });
  assert.equal(h.pipeline.getResult(h.assetId).status, "ready");
  const row = h.db.prepare("SELECT token_sha256 FROM audio_result_commits").get();
  assert.notEqual(row.token_sha256, SHA(old.token), "旧 token 不得覆盖新资格");
});

test("T13G 队列去重/排满/force 仍沿用 B 规则", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    maxWaiting: 1,
    execute: async () => {
      await gate.promise;
      return rawResult();
    },
  });
  const first = await h.pipeline.submit(h.assetId);
  const duplicate = await h.pipeline.submit(h.assetId);
  assert.equal(duplicate.id, first.id);
  await waitState(h.pipeline, first.id, "running");
  gate.resolve();
  await waitState(h.pipeline, first.id, "succeeded");
  const forced = await h.pipeline.submit(h.assetId, { force: true });
  assert.notEqual(forced.id, first.id);
  await waitState(h.pipeline, forced.id, "succeeded");
  assert.equal(h.pipeline.getResult(h.assetId).status, "ready");
});

test("T13G begin 后执行失败且定向撤销失败：ABORT_FAILED、资格/租约保留，取消/超时不覆盖且下一项不启动", async (t) => {
  for (const mode of ["immediate", "timeout"]) {
    const h = await harness(t, {
      wallDeadlineMs: mode === "timeout" ? 30 : 300,
      execute: async () => {
        if (mode === "timeout") await delay(70);
        throw new AudioQueueError("ENGINE_FAILED", "/private/synthetic/exec.wav");
      },
    });
    h.store.invalidateToken = () => {
      throw new Error("/private/synthetic/revoke.wav");
    };
    const job = await h.pipeline.submit(h.assetId);
    const done = await waitState(h.pipeline, job.id, "failed");
    assert.equal(done.error.code, "ABORT_FAILED", mode);
    assert.match(done.error.message, /撤销失败/);
    assert.doesNotMatch(JSON.stringify(done), /private|synthetic/);
    assert.equal(done.resultSaved, false);
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n,
      1,
      "撤销失败必须保留未消费资格",
    );
    assert.equal(count(h.db, "audio_result_records"), 0);
    assert.ok(await fs.lstat(h.lockPath), "撤销失败必须保留故障租约");
    const afterCancel = await h.pipeline.cancel(job.id);
    assert.equal(afterCancel.error.code, "ABORT_FAILED", "取消不得覆盖撤销失败");
    const next = await h.pipeline.submit(h.assetId);
    await delay(20);
    assert.equal((await h.pipeline.get(next.id)).state, "queued", "故障态阻止下一项");
  }
});

test("T13G 注入 AudioQueueError 一律重建固定文案：probe/lease/execute/begin/get/getResult 反射均不泄露路径", async (t) => {
  const scenarios = [
    ["probe", { probe: () => { throw new AudioQueueError("PROBE_REJECTED", "/private/synthetic/probe.wav"); } }, "PROBE_REJECTED"],
    ["lease", { withRunLease: async () => { throw new AudioQueueError("ENGINE_LEASE_FAILED", "/private/synthetic/lease.wav"); } }, "ENGINE_LEASE_FAILED"],
    ["execute", { execute: async () => { throw new AudioQueueError("ENGINE_FAILED", "/private/synthetic/exec.wav"); } }, "ENGINE_FAILED"],
  ];
  for (const [label, overrides, code] of scenarios) {
    const h = await harness(t, overrides);
    const job = await h.pipeline.submit(h.assetId);
    const done = await waitState(h.pipeline, job.id, "failed");
    assert.equal(done.error.code, code, label);
    assert.doesNotMatch(JSON.stringify(done), /private|synthetic|\.wav/, label);
  }

  const begin = await harness(t);
  begin.store.begin = () => {
    throw new AudioQueueError("IDENTITY_CHANGED", "/private/synthetic/begin.wav");
  };
  let job = await begin.pipeline.submit(begin.assetId);
  let done = await waitState(begin.pipeline, job.id, "failed");
  assert.equal(done.error.code, "IDENTITY_CHANGED");
  assert.doesNotMatch(JSON.stringify(done), /private|synthetic|\.wav/);

  const read = await harness(t);
  read.store.get = () => {
    throw new AudioQueueError("STORAGE_ERROR", "/private/synthetic/get.wav");
  };
  assert.throws(
    () => read.pipeline.getResult(read.assetId),
    (error) => {
      assert.equal(error.code, "STORAGE_ERROR");
      assert.doesNotMatch(error.message, /private|synthetic|\.wav/);
      return true;
    },
  );

  const reflected = await harness(t, {
    resolveCurrent: () =>
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("/private/synthetic/proxy.wav");
          },
        },
      ),
  });
  assert.throws(
    () => reflected.pipeline.getResult(reflected.assetId),
    (error) => {
      assert.equal(error.code, "RESOLVER_FAILED");
      assert.doesNotMatch(error.message, /private|synthetic|\.wav/);
      return true;
    },
  );
});

test("T13G 同步契约：init/begin/save 返回 Promise/thenable 固定失败并安全消费，不假成功", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const h = await harness(t, { init: false });
  const originalInit = h.store.initSchema.bind(h.store);
  h.store.initSchema = () => {
    const rejected = Promise.reject(new Error("async init"));
    Object.defineProperty(rejected, "then", { value: null });
    return rejected;
  };
  assert.throws(
    () => h.pipeline.init(),
    (error) => error.code === "STORAGE_ERROR",
  );
  h.store.initSchema = originalInit;
  h.pipeline.init();

  const originalBegin = h.store.begin.bind(h.store);
  h.store.begin = () => Promise.reject(new Error("async begin"));
  let job = await h.pipeline.submit(h.assetId);
  let done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "STORAGE_ERROR");
  h.store.begin = originalBegin;

  const originalSave = h.store.save.bind(h.store);
  let thenCalls = 0;
  h.store.save = () => ({
    then() {
      thenCalls += 1;
      throw new Error("save then 不得执行");
    },
  });
  job = await h.pipeline.submit(h.assetId);
  done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "STORAGE_ERROR");
  assert.equal(thenCalls, 0);
  assert.equal(count(h.db, "audio_result_records"), 0);
  h.store.save = originalSave;

  h.store.save = () => {
    const rejected = Promise.reject(new Error("async save"));
    Object.defineProperty(rejected, "then", { value: null });
    return rejected;
  };
  job = await h.pipeline.submit(h.assetId);
  done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "STORAGE_ERROR");
  h.store.save = originalSave;
  await delay(20);
  assert.deepEqual(unhandled, []);
});

test("T13G 定向撤销返回异步值即按 ABORT_FAILED：不误释放资格，原生拒绝无 unhandled", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const h = await harness(t, {
    hooks: {
      async afterExecute({ job }) {
        await h.pipeline.cancel(job.id);
      },
    },
  });
  h.store.invalidateToken = () => {
    const rejected = Promise.reject(new Error("async revoke"));
    Object.defineProperty(rejected, "then", { value: null });
    return rejected;
  };
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ABORT_FAILED");
  assert.equal(done.resultSaved, false);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n,
    1,
  );
  assert.ok(await fs.lstat(h.lockPath), "撤销失败保留故障租约");
  await delay(20);
  assert.deepEqual(unhandled, []);
});

test("T13I 真实 engine callback 边界：execute TIMEOUT 不被 RUN_FAILED/lease 映射吞掉", async (t) => {
  const h = await harness(t, {
    execute: async () => {
      const error = new Error("/private/synthetic/exec.wav");
      error.code = "TIMEOUT";
      throw error;
    },
    // 模拟 AudioEngine.#invokeRunCallback：callback 的非白名单错误会被折叠为 RUN_FAILED。
    // 新适配层不应让 callback 抛错，因此这里捕获不到任何错误，最终由 pipeline 在
    // lease 成功返回后抛出原始 TIMEOUT。
    withRunLease: async (callback, { signal } = {}) => {
      try {
        return await callback(h_descriptor(), signal);
      } catch {
        const masked = new Error("engine callback masked");
        masked.code = "ENGINE_RUN_FAILED";
        throw masked;
      }
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "TIMEOUT", "必须保留执行超时，而不是 ENGINE_LEASE_FAILED");
  assert.equal(done.resultSaved, false);
  assert.equal(count(h.db, "audio_result_records"), 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n, 0);
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);

  function h_descriptor() {
    return Object.freeze({
      version: "1.2.3",
      binarySha256: "b".repeat(64),
      generation: "c".repeat(32),
    });
  }
});

test("T13I 租约释放失败优先：callback 成功但释放失败时撤销产物并报 ENGINE_LEASE_FAILED", async (t) => {
  const h = await harness(t, {
    withRunLease: async (callback, { signal } = {}) => {
      await callback(
        Object.freeze({ version: "1.2.3", binarySha256: "b".repeat(64), generation: "c".repeat(32) }),
        signal,
      );
      const error = new Error("/private/synthetic/lock.wav");
      error.code = "ENGINE_LOCK_FAILED";
      throw error;
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ENGINE_LEASE_FAILED");
  assert.equal(done.resultSaved, false);
  assert.equal(count(h.db, "audio_result_records"), 0);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n,
    0,
    "释放失败时产物 token 必须定向撤销",
  );
  assert.doesNotMatch(JSON.stringify(done), /private|synthetic|lock\.wav/);
});

test("T13I 同时故障：engine 取消优先于普通执行失败；ABORT_FAILED 不被取消覆盖", async (t) => {
  const descriptor = Object.freeze({ version: "1.2.3", binarySha256: "b".repeat(64), generation: "c".repeat(32) });

  const ordinary = await harness(t, {
    execute: async () => {
      const error = new Error("/private/exec");
      error.code = "TIMEOUT";
      throw error;
    },
    withRunLease: async (callback, { signal } = {}) => {
      await callback(descriptor, signal);
      const error = new Error("cancelled after callback");
      error.code = "CANCELLED";
      throw error;
    },
  });
  let job = await ordinary.pipeline.submit(ordinary.assetId);
  let done = await waitState(ordinary.pipeline, job.id, "cancelled");
  assert.equal(done.error, null, "engine 取消优先于普通 TIMEOUT，终态为 cancelled");
  assert.equal(done.resultSaved, false);
  assert.equal(count(ordinary.db, "audio_result_records"), 0);

  const abort = await harness(t, {
    execute: async () => {
      throw new AudioQueueError("ENGINE_FAILED", "/private/exec");
    },
    withRunLease: async (callback, { signal } = {}) => {
      await callback(descriptor, signal);
      const error = new Error("cancelled after callback");
      error.code = "CANCELLED";
      throw error;
    },
  });
  abort.store.invalidateToken = () => {
    throw new Error("/private/revoke");
  };
  job = await abort.pipeline.submit(abort.assetId);
  done = await waitState(abort.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ABORT_FAILED", "store 撤销故障不得被取消掩盖");
  assert.equal(
    abort.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n,
    1,
  );
  assert.ok(await fs.lstat(abort.lockPath), "ABORT_FAILED 保留故障租约");
});
