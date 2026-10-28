/**
 * T-LOCAL-013I-LIFECYCLE-IMPL-001 round2：三个独立 P1 反例的回归 +
 * late/early spawn 与 PREPARE 迟到 fd 的确定性合成测试。
 *
 * 只使用临时目录、合成小文件、自有 Node/launcher 子进程与受控故障注入；
 * 不安装/运行发行引擎、不读真实素材、不联网、不改限额、不写正式服务。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ChildProcess } from "node:child_process";
import { AudioJobQueue } from "../server/audio-job-queue.mjs";
import { AudioExecutor, createAudioExecutorLauncherConfig } from "../server/audio-executor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function queueSetup(t, execute, hooks = {}, wallDeadlineMs = 1000) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-r2-queue-")));
  const media = path.join(root, "media");
  const dataDir = path.join(root, "data");
  await fs.mkdir(media);
  const sourcePath = path.join(media, "synthetic.bin");
  await fs.writeFile(sourcePath, Buffer.alloc(1024, 7));
  const asset = {
    assetId: "asset-one",
    kind: "music",
    sourcePath,
    rootPath: media,
    rootId: "root-one",
    online: true,
    trashed: false,
    retired: false,
    rootRetired: false,
    busy: false,
    assetGeneration: 1,
    libraryGeneration: 1,
    sourceGeneration: 1,
  };
  const queue = new AudioJobQueue({
    dataDir,
    resolveAsset: () => ({ ...asset }),
    execute,
    hooks,
    wallDeadlineMs,
  });
  t.after(async () => {
    await queue.dispose().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { queue, dataDir, root, media, sourcePath };
}

test("P1-1 过期队列清理：绝对 deadline 保留、只停止等待并保留故障租约", async (t) => {
  const gate = deferred();
  const entered = deferred();
  let options;
  const { queue, dataDir } = await queueSetup(
    t,
    (_snapshot, { signal }) =>
      new Promise((_, reject) => {
        const stop = () => reject(Object.assign(Error("synthetic stop"), { code: "CANCELLED" }));
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }),
    {
      afterSnapshot: ({ snapshot }) => {
        const original = snapshot.cleanup;
        snapshot.cleanup = async (value) => {
          options = value;
          entered.resolve();
          await gate.promise;
          return original(value);
        };
      },
    },
    60,
  );
  const submitted = await queue.submit("asset-one");
  await Promise.race([entered.promise, delay(500).then(() => { throw Error("cleanup not entered"); })]);
  await delay(100);
  const observed = await queue.get(submitted.id);
  assert.equal(observed.state, "failed");
  assert.equal(observed.error.code, "CLEANUP_FAILED");
  assert.ok(Number.isFinite(options?.deadlineAtMs), "过期后不得抹掉绝对 deadline");
  assert.equal(queue.busy, true);
  assert.ok(await fs.lstat(path.join(dataDir, "audio-jobs", ".queue-lease")), "清理 pending 保留租约");
  gate.resolve();
  await delay(50);
  const afterLate = await queue.get(submitted.id);
  assert.equal(afterLate.error.code, "CLEANUP_FAILED", "迟到清理不得改终态");
  assert.ok(await fs.lstat(path.join(dataDir, "audio-jobs", ".queue-lease")), "迟到清理不得自动解锁");
});

test("P1-2 resourceUnknown/close 未 settle：删除前保留快照与 queue 租约", async (t) => {
  let snapshotDir;
  const { queue, dataDir } = await queueSetup(t, async (snapshot) => {
    snapshotDir = snapshot.dir;
    const error = Object.assign(Error("synthetic process unknown"), {
      code: "EXECUTION_UNAVAILABLE",
      evidence: { resourceUnknown: true, closeSettled: false },
    });
    throw error;
  });
  const submitted = await queue.submit("asset-one");
  let job;
  for (let i = 0; i < 100; i += 1) {
    job = await queue.get(submitted.id);
    if (["failed", "cancelled", "succeeded"].includes(job.state)) break;
    await delay(5);
  }
  assert.equal(job.state, "failed");
  assert.ok(await fs.lstat(snapshotDir), "进程/close unknown 不得删除快照现场");
  assert.ok(await fs.lstat(path.join(dataDir, "audio-jobs", ".queue-lease")), "必须保留 queue 租约");
  assert.equal(queue.busy, true);
});

async function executorFixture(t, { wallMs = 80, launcherText = "synthetic file; never executed" } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-r2-exec-")));
  const file = path.join(dir, "synthetic-launcher");
  const bytes = Buffer.from(launcherText);
  await fs.writeFile(file, bytes, { mode: 0o700 });
  const executor = new AudioExecutor({
    dataDir: dir,
    launcher: createAudioExecutorLauncherConfig({ path: file, sha256: sha256(bytes) }),
    limits: { wallMs, termGraceMs: 1 },
  });
  t.after(async () => {
    await executor.dispose().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // 合法但从不被执行的 target/snapshot：让测试越过 descriptor/snapshot 校验，
  // 专门验证 spawn 监听注册与迟到确认路径。
  const targetBytes = Buffer.from("synthetic target; never executed");
  const targetPath = path.join(dir, "synthetic-target");
  await fs.writeFile(targetPath, targetBytes, { mode: 0o700 });
  const snapshotDir = path.join(dir, "snapshot");
  await fs.mkdir(snapshotDir, { mode: 0o700 });
  const snapshotBytes = Buffer.from("synthetic snapshot; never analyzed");
  const snapshotPath = path.join(snapshotDir, "source.bin");
  await fs.writeFile(snapshotPath, snapshotBytes, { mode: 0o600 });
  const snapshot = {
    filePath: snapshotPath,
    bytes: snapshotBytes.length,
    sha256: sha256(snapshotBytes),
    dir: snapshotDir,
  };
  const descriptor = {
    version: "1.0.0",
    platform: process.platform,
    arch: process.arch,
    binaryPath: targetPath,
    binarySha256: sha256(targetBytes),
    binarySize: targetBytes.length,
    generation: "a".repeat(32),
  };
  return { dir, file, executor, snapshot, descriptor };
}

test("P1-3 PREPARE read 受入口 deadline：不等待 read gate，迟到 fd 仍 close", async (t) => {
  const { file, executor } = await executorFixture(t, { wallMs: 60 });
  let release;
  let entered;
  const settled = { value: false };
  const gate = new Promise((r) => {
    release = r;
  });
  const started = new Promise((r) => {
    entered = r;
  });
  const original = fs.open;
  fs.open = async (...args) => {
    const handle = await original(...args);
    if (args[0] === file) {
      const read = handle.read.bind(handle);
      handle.read = async (...a) => {
        entered();
        await gate;
        return read(...a);
      };
    }
    return handle;
  };
  const execution = executor.execute({}, {}).then(
    () => {
      settled.value = true;
    },
    () => {
      settled.value = true;
    },
  );
  try {
    await Promise.race([started, delay(500).then(() => { throw Error("read not entered"); })]);
    await delay(150);
    assert.equal(settled.value, true, "入口 deadline 必须停止等待 PREPARE IO");
    assert.equal(executor.busy, false);
  } finally {
    release();
    await execution;
    fs.open = original;
  }
  // 迟到 read 之后必须 close；超时已按只读迟到 fd 保守置 unknown 故障门。
  await delay(30);
  await assert.rejects(executor.execute({}, {}), (error) => error.code === "EXECUTION_UNAVAILABLE");
});

test("early spawn error / close-before-spawn：监听同段注册、只 settle 一次、确认前不 kill", async (t) => {
  const originalOnce = ChildProcess.prototype.once;
  const signals = [];
  const originalKill = process.kill;
  process.kill = (pid, signal) => {
    signals.push({ pid, signal, at: Date.now() });
    return originalKill.call(process, pid, signal);
  };
  try {
    // close-before-spawn：延迟 spawn 事件，让真实子进程先退出。
    ChildProcess.prototype.once = function once(event, listener) {
      if (event === "spawn") {
        return originalOnce.call(this, event, (...args) => setTimeout(() => listener(...args), 500));
      }
      return originalOnce.call(this, event, listener);
    };
    const { executor, snapshot, descriptor } = await executorFixture(t, {
      wallMs: 3000,
      launcherText: "#!/bin/sh\nexit 0\n",
    });
    await assert.rejects(executor.execute(snapshot, descriptor), (error) => error.code === "ENGINE_FAILED");
    assert.equal(signals.length, 0, "未确认 spawn/close-before-spawn 不得发信号");
  } finally {
    ChildProcess.prototype.once = originalOnce;
    process.kill = originalKill;
  }
});

test("late spawn：确认前不 kill，确认后立即一次 SIGKILL 且无 TERM/续窗", async (t) => {
  const originalOnce = ChildProcess.prototype.once;
  const originalKill = process.kill;
  const signals = [];
  const killed = deferred();
  process.kill = (pid, signal) => {
    signals.push({ pid, signal, at: Date.now() });
    if (signal === "SIGKILL") killed.resolve();
    return originalKill.call(process, pid, signal);
  };
  let pgid = null;
  try {
    ChildProcess.prototype.once = function once(event, listener) {
      if (event === "spawn") {
        return originalOnce.call(this, event, (...args) =>
          setTimeout(() => {
            pgid = this.pid;
            listener(...args);
          }, 2900),
        );
      }
      return originalOnce.call(this, event, listener);
    };
    const { executor, snapshot, descriptor } = await executorFixture(t, {
      wallMs: 2600,
      launcherText: "#!/bin/sh\nsleep 30\n",
    });
    const started = Date.now();
    await assert.rejects(
      executor.execute(snapshot, descriptor),
      (error) => error.code === "TIMEOUT" && error.evidence?.resourceUnknown === true,
    );
    assert.ok(Date.now() - started < 2700, "deadline 必须停止等待未确认 spawn");
    assert.equal(signals.length, 0, "确认前不得按 pid kill");
    await Promise.race([killed.promise, delay(1000).then(() => { throw Error("late spawn not killed"); })]);
    assert.equal(signals[0].signal, "SIGKILL");
    assert.equal(signals.some((entry) => entry.signal === "SIGTERM"), false, "L1 无 TERM grace");
    assert.equal(pgid, -signals[0].pid, "SIGKILL 目标为子进程组");
  } finally {
    ChildProcess.prototype.once = originalOnce;
    process.kill = originalKill;
    if (pgid) {
      try {
        originalKill.call(process, -pgid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }
});
