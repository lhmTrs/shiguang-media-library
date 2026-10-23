/**
 * T-LOCAL-013B：内存任务队列/租约/取消/终态保留的隔离测试。
 *
 * 使用临时目录、64KiB 合成文件与合成 executor；不启动真实引擎、不读真实素材/数据库、不联网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { AudioJobQueue } from "../server/audio-job-queue.mjs";

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

async function tempBase(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-queue-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
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

async function waitState(queue, id, state) {
  return waitFor(async () => {
    try {
      const job = await queue.get(id);
      return job.state === state ? job : null;
    } catch {
      return null;
    }
  }, `${id} -> ${state}`);
}

async function expectQueueCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, String(error));
    return true;
  });
}

async function harness(t, options = {}) {
  const base = await tempBase(t);
  const root = path.join(base, "media");
  const dataDir = path.join(base, "data");
  await fs.mkdir(root, { recursive: true });
  const assets = new Map();
  const stats = {
    resolves: 0,
    active: 0,
    maxConcurrent: 0,
    executions: [],
  };
  let executor = options.executor || (async () => ({ ok: true }));
  const hooks = options.hooks || {};

  const resolveAsset = async (assetId) => {
    stats.resolves += 1;
    const asset = assets.get(assetId);
    if (!asset) return null;
    return options.reuseResolvedObject ? asset : { ...asset };
  };
  const execute = async (snapshot, context) => {
    stats.active += 1;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.active);
    const entry = {
      assetId: snapshot.jobId,
      snapshotDir: snapshot.dir,
      filePath: snapshot.filePath,
      sha256: snapshot.sha256,
      startedAt: Date.now(),
      endedAt: null,
    };
    stats.executions.push(entry);
    try {
      return await executor(snapshot, context);
    } finally {
      stats.active -= 1;
      entry.endedAt = Date.now();
    }
  };

  const queue = new AudioJobQueue({
    dataDir,
    resolveAsset,
    execute,
    wallDeadlineMs: options.wallDeadlineMs ?? 1000,
    maxSnapshotBytes: 1024 * 1024,
    maxWaiting: options.maxWaiting ?? 8,
    maxTerminal: options.maxTerminal ?? 100,
    terminalTtlMs: options.terminalTtlMs ?? 24 * 60 * 60 * 1000,
    hooks,
  });
  t.after(async () => {
    await queue.dispose().catch(() => {});
  });

  async function addAsset(id, overrides = {}) {
    const sourcePath = path.join(root, `${id}.bin`);
    if (!(await fs.lstat(sourcePath).catch(() => null))) {
      await fs.writeFile(sourcePath, crypto.randomBytes(96 * 1024));
    }
    const asset = {
      assetId: id,
      kind: "music",
      sourcePath,
      rootPath: root,
      rootId: "root-1",
      online: true,
      trashed: false,
      retired: false,
      rootRetired: false,
      busy: false,
      assetGeneration: 1,
      libraryGeneration: 1,
      sourceGeneration: 1,
      ...overrides,
    };
    assets.set(id, asset);
    return asset;
  }

  const lockPath = path.join(dataDir, "audio-jobs", ".queue-lease");
  const jobsPath = path.join(dataDir, "audio-jobs");
  return {
    base,
    root,
    dataDir,
    queue,
    assets,
    stats,
    hooks,
    lockPath,
    jobsPath,
    addAsset,
    setExecutor(fn) {
      executor = fn;
    },
  };
}

async function jobDirs(jobsPath) {
  const entries = await fs.readdir(jobsPath).catch(() => []);
  return entries.filter((name) => name.startsWith("job-"));
}

test("严格输入：未知字段/非 boolean force/错误 assetId 拒绝，未知 job 固定 JOB_NOT_FOUND", async (t) => {
  const h = await harness(t);
  await h.addAsset("a");
  await expectQueueCode(h.queue.submit(""), "INVALID_REQUEST");
  await expectQueueCode(h.queue.submit(42), "INVALID_REQUEST");
  await expectQueueCode(h.queue.submit("a", null), "INVALID_REQUEST");
  await expectQueueCode(h.queue.submit("a", { force: "true" }), "INVALID_REQUEST");
  await expectQueueCode(h.queue.submit("a", { model: "x" }), "INVALID_REQUEST");
  await expectQueueCode(h.queue.get("missing"), "JOB_NOT_FOUND");
  await expectQueueCode(h.queue.get(""), "JOB_NOT_FOUND");
  await expectQueueCode(h.queue.cancel("missing"), "JOB_NOT_FOUND");
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null, "构造/get 不写锁");
  assert.equal(h.queue.busy, false);
});

test("单 worker、8 等待上限、同 asset/force 合并、完成后重新解析并生成新任务", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    executor: async () => {
      await gate.promise;
      return { ok: true };
    },
  });
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  for (const id of ids) await h.addAsset(id);
  await h.addAsset("extra");
  const jobs = [];
  for (const id of ids) jobs.push(await h.queue.submit(id));
  await waitState(h.queue, jobs[0].id, "running");
  await expectQueueCode(h.queue.submit("extra"), "AUDIO_QUEUE_FULL");
  const merged = await h.queue.submit("a", { force: true });
  assert.equal(merged.id, jobs[0].id, "非终态同 asset 合并，force 也不重复");
  assert.equal(jobs[0].queuePosition, null);

  gate.resolve();
  for (const job of jobs) await waitState(h.queue, job.id, "succeeded");
  assert.equal(h.stats.maxConcurrent, 1, "最多一个 worker 同时执行");
  assert.deepEqual(
    h.stats.executions.map((entry) => entry.assetId),
    jobs.map((job) => job.id),
    "按提交顺序执行",
  );
  assert.equal((await h.queue.get(jobs[0].id)).state, "succeeded");

  const before = h.stats.resolves;
  const next = await h.queue.submit("a");
  assert.notEqual(next.id, jobs[0].id, "完成后新提交必须新任务");
  await waitState(h.queue, next.id, "succeeded");
  assert.ok(h.stats.resolves - before >= 2, "重新解析素材");
  assert.equal((await jobDirs(h.jobsPath)).length, 0, "任务目录均已清理");
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null, "租约已释放");
});

test("排队取消立即移除；终态 cancel 不改变结果", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    executor: async () => {
      await gate.promise;
      return { ok: true };
    },
  });
  for (const id of ["a", "b", "c"]) await h.addAsset(id);
  const a = await h.queue.submit("a");
  await waitState(h.queue, a.id, "running");
  const b = await h.queue.submit("b");
  const c = await h.queue.submit("c");
  assert.equal(b.queuePosition, 1);
  const cancelled = await h.queue.cancel(b.id);
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await h.queue.get(c.id)).queuePosition, 1);
  gate.resolve();
  await waitState(h.queue, a.id, "succeeded");
  await waitState(h.queue, c.id, "succeeded");
  assert.equal((await h.queue.get(b.id)).state, "cancelled");
  assert.deepEqual(
    h.stats.executions.map((entry) => entry.assetId),
    [a.id, c.id],
    "取消的排队任务没有执行",
  );
  assert.equal((await h.queue.cancel(a.id)).state, "succeeded", "成功后 cancel 幂等且不改结果");
});

test("运行中取消：cancelling 等待 execute settle + 快照清理后才 cancelled，然后才下一项", async (t) => {
  let first = true;
  const h = await harness(t, {
    executor: async (snapshot, { signal }) => {
      if (!first) return { ok: true };
      first = false;
      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => resolve({ aborted: true }), 30);
          },
          { once: true },
        );
      });
    },
  });
  await h.addAsset("a");
  await h.addAsset("b");
  const a = await h.queue.submit("a");
  await waitState(h.queue, a.id, "running");
  const b = await h.queue.submit("b");
  const started = Date.now();
  const cancelling = await h.queue.cancel(a.id);
  assert.equal(cancelling.state, "cancelling");
  await delay(10);
  assert.equal((await h.queue.get(a.id)).state, "cancelling", "execute 未 settle 前不得公布 cancelled");
  assert.equal((await h.queue.get(b.id)).state, "queued", "前一任务未清理前不得启动下一项");
  const done = await waitState(h.queue, a.id, "cancelled");
  assert.ok(Date.now() - started >= 30, "确实等待 settle");
  assert.equal(done.error, null);
  await waitState(h.queue, b.id, "succeeded");
  assert.equal(await fs.lstat(h.stats.executions[0].snapshotDir).catch(() => null), null);
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
});

test("超时：wall deadline abort 并等待 settle，failed TIMEOUT，下一项可执行", async (t) => {
  let first = true;
  const h = await harness(t, {
    wallDeadlineMs: 100,
    executor: async (snapshot, { signal }) => {
      if (!first) return { ok: true };
      first = false;
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => setTimeout(() => resolve({ late: true }), 20), { once: true });
      });
    },
  });
  await h.addAsset("a");
  await h.addAsset("b");
  const a = await h.queue.submit("a");
  const failed = await waitState(h.queue, a.id, "failed");
  assert.equal(failed.error.code, "TIMEOUT");
  const b = await h.queue.submit("b");
  await waitState(h.queue, b.id, "succeeded");
  assert.equal((await jobDirs(h.jobsPath)).length, 0);
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
});

test("执行失败受控、摘要不泄露路径/原始错误，随后下一任务成功", async (t) => {
  let first = true;
  const h = await harness(t, {
    executor: async () => {
      if (first) {
        first = false;
        throw new Error("boom /private/tmp/x stderr=raw");
      }
      return { ok: true };
    },
  });
  await h.addAsset("a");
  await h.addAsset("b");
  const a = await h.queue.submit("a");
  const failed = await waitState(h.queue, a.id, "failed");
  assert.equal(failed.error.code, "EXECUTION_FAILED");
  const text = JSON.stringify(failed);
  assert.equal(text.includes(h.base), false, "摘要不含绝对路径");
  assert.equal(text.includes("boom"), false, "摘要不含原始异常消息");
  assert.equal(text.includes("stderr"), false);
  const b = await h.queue.submit("b");
  await waitState(h.queue, b.id, "succeeded");
  assert.equal((await jobDirs(h.jobsPath)).length, 0);
});

test("成功/取消交错：最终校验前的取消不被旧成功覆盖；已公布成功后不可改", async (t) => {
  const reached = deferred();
  const gate = deferred();
  const h = await harness(t);
  h.hooks.afterExecute = async () => {
    reached.resolve();
    await gate.promise;
  };
  await h.addAsset("a");
  const a = await h.queue.submit("a");
  await reached.promise;
  await h.queue.cancel(a.id);
  gate.resolve();
  const final = await waitState(h.queue, a.id, "cancelled");
  assert.equal(final.error, null);

  h.hooks.afterExecute = null;
  await h.addAsset("b");
  const b = await h.queue.submit("b");
  await waitState(h.queue, b.id, "succeeded");
  assert.equal((await h.queue.cancel(b.id)).state, "succeeded");
});

test("复制阶段取消：不执行 executor，快照目录清理，状态 cancelled", async (t) => {
  const reached = deferred();
  const gate = deferred();
  const h = await harness(t);
  h.hooks.snapshotHooks = {
    afterChunk: async ({ chunks }) => {
      if (chunks === 1) {
        reached.resolve();
        await gate.promise;
      }
    },
  };
  await h.addAsset("a");
  const a = await h.queue.submit("a");
  await reached.promise;
  const cancelling = await h.queue.cancel(a.id);
  assert.equal(cancelling.state, "cancelling");
  gate.resolve();
  await waitState(h.queue, a.id, "cancelled");
  assert.equal(h.stats.executions.length, 0);
  assert.equal((await jobDirs(h.jobsPath)).length, 0);
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
});

test("开工前 generation/状态变化与完成后在线/废纸篓/注销/root/占用变化均受控失败", async (t) => {
  const h = await harness(t);
  await h.addAsset("blocker");
  await h.addAsset("target");
  const blockerGate = deferred();
  let blockFirst = true;
  h.setExecutor(async () => {
    if (blockFirst) {
      blockFirst = false;
      await blockerGate.promise;
    }
    return { ok: true };
  });
  const blocker = await h.queue.submit("blocker");
  await waitState(h.queue, blocker.id, "running");
  const target = await h.queue.submit("target");
  h.assets.get("target").assetGeneration = 2;
  blockerGate.resolve();
  await waitState(h.queue, blocker.id, "succeeded");
  const changed = await waitState(h.queue, target.id, "failed");
  assert.equal(changed.error.code, "SOURCE_CHANGED");

  for (const [field, value, code] of [
    ["online", false, "SOURCE_OFFLINE"],
    ["trashed", true, "SOURCE_TRASHED"],
    ["retired", true, "SOURCE_RETIRED"],
    ["rootRetired", true, "ROOT_RETIRED"],
    ["busy", true, "ASSET_BUSY"],
    ["libraryGeneration", 9, "SOURCE_CHANGED"],
    ["sourceGeneration", 9, "SOURCE_CHANGED"],
  ]) {
    const id = `case-${field}`;
    await h.addAsset(id);
    h.hooks.afterExecute = async () => {
      h.assets.get(id)[field] = value;
    };
    const job = await h.queue.submit(id);
    const failed = await waitFor(async () => {
      const summary = await h.queue.get(job.id);
      return summary.state === "failed" ? summary : null;
    }, `${id} failed`);
    assert.equal(failed.error.code, code, `${field} -> ${code}`);
  }

  h.hooks.afterExecute = null;
  await h.addAsset("file-change");
  h.hooks.afterExecute = async () => {
    const source = h.assets.get("file-change").sourcePath;
    await fs.writeFile(source, crypto.randomBytes(96 * 1024));
  };
  const modified = await h.queue.submit("file-change");
  const modifiedDone = await waitState(h.queue, modified.id, "failed");
  assert.equal(modifiedDone.error.code, "SOURCE_CHANGED");
  assert.equal(h.stats.maxConcurrent, 1);
});

test("源文件在排队期间删除：SOURCE_MISSING，不返回旧成功", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    executor: async () => {
      await gate.promise;
      return { ok: true };
    },
  });
  await h.addAsset("first");
  await h.addAsset("gone");
  const first = await h.queue.submit("first");
  await waitState(h.queue, first.id, "running");
  const gone = await h.queue.submit("gone");
  await fs.rm(h.assets.get("gone").sourcePath);
  gate.resolve();
  await waitState(h.queue, first.id, "succeeded");
  const failed = await waitState(h.queue, gone.id, "failed");
  assert.equal(failed.error.code, "SOURCE_MISSING");
});

test("同 dataDir 两实例：已存在租约 fail-closed，不并行执行；释放后可继续", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    executor: async (snapshot, { signal }) => {
      if (snapshot.jobId) await gate.promise;
      return { ok: true };
    },
  });
  await h.addAsset("a");
  await h.addAsset("b");
  const a = await h.queue.submit("a");
  await waitState(h.queue, a.id, "running");
  assert.ok(await fs.lstat(h.lockPath), "执行期间持有租约");

  const second = new AudioJobQueue({
    dataDir: h.dataDir,
    resolveAsset: async (id) => ({ ...h.assets.get(id) }),
    execute: async () => ({ ok: true }),
    maxSnapshotBytes: 1024 * 1024,
  });
  t.after(async () => second.dispose());
  await expectQueueCode(second.get("x"), "JOB_NOT_FOUND");
  assert.ok(await fs.lstat(h.lockPath), "构造/get 不改动别人的锁");
  const blocked = await second.submit("b");
  const blockedDone = await waitState(second, blocked.id, "failed");
  assert.equal(blockedDone.error.code, "AUDIO_ENGINE_BUSY");
  assert.equal((await second.get(blocked.id)).state, "failed");

  gate.resolve();
  await waitState(h.queue, a.id, "succeeded");
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
  const resumed = await second.submit("b");
  await waitState(second, resumed.id, "succeeded");
  assert.equal(h.stats.maxConcurrent, 1);
});

test("dispose：取消排队与活跃任务，await settle/清理，不自动恢复", async (t) => {
  const h = await harness(t, {
    executor: async (snapshot, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => setTimeout(() => resolve({ aborted: true }), 25), { once: true });
      }),
  });
  for (const id of ["a", "b", "c"]) await h.addAsset(id);
  const a = await h.queue.submit("a");
  await waitState(h.queue, a.id, "running");
  const b = await h.queue.submit("b");
  const c = await h.queue.submit("c");
  const disposing = h.queue.dispose();
  await delay(5);
  assert.equal((await h.queue.get(a.id)).state, "cancelling");
  assert.equal((await h.queue.get(b.id)).state, "cancelled");
  assert.equal((await h.queue.get(c.id)).state, "cancelled");
  await disposing;
  assert.equal((await h.queue.get(a.id)).state, "cancelled");
  assert.equal((await jobDirs(h.jobsPath)).length, 0);
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
  await expectQueueCode(h.queue.submit("a"), "QUEUE_DISPOSED");
  await h.queue.dispose();
});

test("终态最多保留 maxTerminal 条且按 TTL 惰性清理", async (t) => {
  const h = await harness(t, { maxTerminal: 2, terminalTtlMs: 60 });
  const ids = ["a", "b", "c"];
  const done = [];
  for (const id of ids) {
    await h.addAsset(id);
    const job = await h.queue.submit(id);
    await waitState(h.queue, job.id, "succeeded");
    done.push(job.id);
  }
  await expectQueueCode(h.queue.get(done[0]), "JOB_NOT_FOUND");
  assert.equal((await h.queue.get(done[2])).state, "succeeded");
  await delay(80);
  await h.addAsset("d");
  const d = await h.queue.submit("d");
  await waitState(h.queue, d.id, "succeeded");
  await expectQueueCode(h.queue.get(done[1]), "JOB_NOT_FOUND");
});

test("清理失败 fail-closed：任务 failed CLEANUP_FAILED，保留租约且不执行后续任务", async (t) => {
  const h = await harness(t);
  h.hooks.afterSnapshot = async ({ snapshot }) => {
    await fs.writeFile(path.join(snapshot.dir, ".owner.json"), JSON.stringify({ token: "tampered" }));
  };
  await h.addAsset("a");
  await h.addAsset("b");
  const a = await h.queue.submit("a");
  const failed = await waitState(h.queue, a.id, "failed");
  assert.equal(failed.error.code, "CLEANUP_FAILED");
  assert.ok(await fs.lstat(h.lockPath), "清理未完成不得释放租约");
  const b = await h.queue.submit("b");
  await delay(30);
  assert.equal((await h.queue.get(b.id)).state, "queued", "租约损坏时不启动后续任务");
  assert.equal(h.queue.busy, true);
  assert.equal((await h.queue.cancel(b.id)).state, "cancelled");
  await h.queue.dispose();
  assert.ok(await fs.lstat(h.lockPath), "dispose 也不静默释放未完成清理的租约");
});

test("创建阶段内部清理失败：failed CLEANUP_FAILED，保留租约/busy，后续任务不启动且 dispose 不假称清理", async (t) => {
  const h = await harness(t);
  h.hooks.snapshotHooks = {
    afterChunk: async ({ dir }) => {
      await fs.unlink(path.join(dir, ".owner.json"));
      throw new Error("synthetic snapshot failure /private/tmp/secret");
    },
  };
  await h.addAsset("a");
  await h.addAsset("b");
  const a = await h.queue.submit("a");
  const failed = await waitState(h.queue, a.id, "failed");
  assert.equal(failed.error.code, "CLEANUP_FAILED");
  assert.equal(failed.error.message, "任务清理失败");
  assert.equal(JSON.stringify(failed).includes(h.base), false, "摘要不含私人路径");
  assert.ok(await fs.lstat(h.lockPath), "创建阶段清理失败必须保留租约");
  assert.equal(h.queue.busy, true);
  const residual = await jobDirs(h.jobsPath);
  assert.equal(residual.length, 1, "只保留未清理的自有残留目录，不递归删未知内容");

  const b = await h.queue.submit("b");
  await delay(30);
  assert.equal((await h.queue.get(b.id)).state, "queued", "故障后不得启动后续任务");
  assert.equal(h.stats.executions.length, 0, "快照创建失败时执行器一次也不应被调用");
  await h.queue.dispose();
  assert.equal((await h.queue.get(b.id)).state, "cancelled");
  assert.ok(await fs.lstat(h.lockPath), "dispose 不释放未完成清理的租约");
  assert.equal((await jobDirs(h.jobsPath)).length, 1, "dispose 也不假称清理完成");
});

test("创建阶段清理失败优先于取消：failed CLEANUP_FAILED 且保留租约", async (t) => {
  const reached = deferred();
  const gate = deferred();
  const h = await harness(t);
  h.hooks.snapshotHooks = {
    afterChunk: async ({ dir, chunks }) => {
      if (chunks !== 1) return;
      reached.resolve();
      await gate.promise;
      await fs.unlink(path.join(dir, ".owner.json"));
      throw new Error("synthetic snapshot failure");
    },
  };
  await h.addAsset("a");
  const a = await h.queue.submit("a");
  await reached.promise;
  assert.equal((await h.queue.cancel(a.id)).state, "cancelling");
  gate.resolve();
  const failed = await waitState(h.queue, a.id, "failed");
  assert.equal(failed.error.code, "CLEANUP_FAILED", "取消不能覆盖创建阶段清理失败");
  assert.ok(await fs.lstat(h.lockPath));
  assert.equal(h.queue.busy, true);
  await h.queue.dispose();
  assert.ok(await fs.lstat(h.lockPath), "dispose 也不释放");
});

test("resolver 复用同一可变对象：原位改 generation/管理状态不能绕过已接受基线", async (t) => {
  const h = await harness(t, { reuseResolvedObject: true });
  const cases = [
    ["libraryGeneration", 2, "SOURCE_CHANGED"],
    ["assetGeneration", 2, "SOURCE_CHANGED"],
    ["sourceGeneration", 2, "SOURCE_CHANGED"],
    ["online", false, "SOURCE_OFFLINE"],
    ["trashed", true, "SOURCE_TRASHED"],
    ["retired", true, "SOURCE_RETIRED"],
    ["rootRetired", true, "ROOT_RETIRED"],
    ["busy", true, "ASSET_BUSY"],
  ];
  for (const [field, value, code] of cases) {
    const id = `alias-${field}`;
    const asset = await h.addAsset(id);
    h.setExecutor(async () => {
      asset[field] = value;
      return { ok: true };
    });
    const job = await h.queue.submit(id);
    const failed = await waitState(h.queue, job.id, "failed");
    assert.equal(failed.error.code, code, `${field} -> ${code}`);
  }
});

test("busy 只读状态：排队/运行/持有租约时为真，构造与 get 不写锁", async (t) => {
  const gate = deferred();
  const h = await harness(t, {
    executor: async () => {
      await gate.promise;
      return { ok: true };
    },
  });
  await h.addAsset("a");
  assert.equal(h.queue.busy, false);
  const a = await h.queue.submit("a");
  await waitState(h.queue, a.id, "running");
  assert.equal(h.queue.busy, true);
  assert.ok(await fs.lstat(h.lockPath));
  gate.resolve();
  await waitState(h.queue, a.id, "succeeded");
  assert.equal(h.queue.busy, false);
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null);
});

test("executor 固定错误码透传：ENGINE_FAILED 失败、CANCELLED 归为 cancelled", async (t) => {
  const h = await harness(t);
  h.setExecutor(async () => {
    throw Object.assign(new Error("raw stderr /private/tmp/secret"), { code: "ENGINE_FAILED" });
  });
  await h.addAsset("engine");
  const engine = await h.queue.submit("engine");
  const failed = await waitState(h.queue, engine.id, "failed");
  assert.equal(failed.error.code, "ENGINE_FAILED");
  assert.equal(JSON.stringify(failed).includes("/private/tmp/secret"), false);

  h.setExecutor(async () => {
    throw Object.assign(new Error("inner cancel"), { code: "CANCELLED" });
  });
  await h.addAsset("self-cancel");
  const cancelled = await h.queue.submit("self-cancel");
  const done = await waitState(h.queue, cancelled.id, "cancelled");
  assert.equal(done.error, null);
});

test("marker 部分写入 + rmdir 失败 + 取消交错：CLEANUP_FAILED，保留租约且后续不启动", async (t) => {
  const reached = deferred();
  const gate = deferred();
  const h = await harness(t);
  await h.addAsset("a");
  await h.addAsset("b");

  const originalWriteFile = fs.writeFile;
  const originalRmdir = fs.rmdir;
  let injected = false;
  fs.writeFile = async (file, ...rest) => {
    if (!injected && path.basename(String(file)) === ".owner.json") {
      injected = true;
      // 先真实写入半段标记，挂起到取消发生后再模拟 ENOSPC。
      await originalWriteFile(file, "{partial", { mode: 0o600, flag: "wx" });
      reached.resolve();
      await gate.promise;
      throw Object.assign(new Error("synthetic disk-full"), { code: "ENOSPC" });
    }
    return originalWriteFile(file, ...rest);
  };
  fs.rmdir = async (p, ...rest) => {
    if (path.basename(String(p)).startsWith("job-")) {
      throw Object.assign(new Error("synthetic rmdir failure"), { code: "EACCES" });
    }
    return originalRmdir(p, ...rest);
  };

  try {
    const a = await h.queue.submit("a");
    await reached.promise;
    assert.equal((await h.queue.cancel(a.id)).state, "cancelling");
    gate.resolve();
    const failed = await waitState(h.queue, a.id, "failed");
    assert.equal(failed.error.code, "CLEANUP_FAILED", "取消不能覆盖半段 marker 的清理失败");
    assert.ok(await fs.lstat(h.lockPath), "清理失败必须保留租约");
    assert.equal(h.queue.busy, true);
    assert.equal(h.stats.executions.length, 0, "marker 未写成时执行器一次也不应被调用");

    const b = await h.queue.submit("b");
    await delay(30);
    assert.equal((await h.queue.get(b.id)).state, "queued", "故障后不得启动后续任务");
    await h.queue.dispose();
    assert.equal((await h.queue.get(b.id)).state, "cancelled");
    assert.ok(await fs.lstat(h.lockPath), "dispose 不释放未完成清理的租约");
    assert.equal((await jobDirs(h.jobsPath)).length, 1, "只保留未清理的自有残留目录");
  } finally {
    fs.writeFile = originalWriteFile;
    fs.rmdir = originalRmdir;
  }
});
