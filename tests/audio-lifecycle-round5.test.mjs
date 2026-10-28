/**
 * T-LOCAL-013I-LIFECYCLE-IMPL-001 round5：CLEANUP_FAILED 不得切断 sticky evidence。
 *
 * 反例来源：source-read/source-recheck 在任务目录已创建后超时，失败清理耗尽预算时
 * 用新的 CLEANUP_FAILED 替换了持有 evidence 的原 TIMEOUT，导致迟到 close 只更新
 * 旧错误，上层拿到的错误没有任何资源证据。本文件验证：
 *   1. 直接调用 createSnapshot 时，CLEANUP_FAILED 与原 TIMEOUT 共享同一 evidence
 *      对象；返回后释放 gate 产生的迟到 close 失败仍在该对象上可见；
 *   2. 真实 queue 在该路径上仍进入故障门：保留租约、busy、后续任务不启动，
 *      dispose 不假称清理，且不产生未处理拒绝。
 *
 * 只用临时目录、1KiB 合成文件和受控 gate；fd 先真实关闭再注入失败，不碰真实素材。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createSnapshot } from "../server/audio-snapshot.mjs";
import { AudioJobQueue } from "../server/audio-job-queue.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function waitFor(fn, label, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`等待超时：${label}`);
    await delay(5);
  }
}

async function tempBase(t, prefix) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });
  return base;
}

async function snapshotFixture(t) {
  const base = await tempBase(t, "t13i-r5-evidence-");
  const rootPath = path.join(base, "media");
  const dataDir = path.join(base, "data");
  const sourcePath = path.join(rootPath, "synthetic.bin");
  await fs.mkdir(rootPath);
  await fs.mkdir(dataDir);
  await fs.writeFile(sourcePath, Buffer.alloc(1024, 5));
  return { base, rootPath, dataDir, sourcePath };
}

function failCloseAfterReal(label, onClosed) {
  return (handle) => {
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      onClosed();
      throw Object.assign(new Error(`synthetic-late-close-failure:${label}`), { code: "EIO" });
    };
  };
}

const DIRECT_CASES = [
  { kind: "source-read", label: "source-read-late", reason: "SNAPSHOT_SOURCE_READ_DEADLINE" },
  { kind: "source-recheck", label: "source-recheck-late", reason: "SNAPSHOT_SOURCE_RECHECK_DEADLINE" },
];

for (const current of DIRECT_CASES) {
  test(`snapshot ${current.kind} 超时清理失败：CLEANUP_FAILED 与原 TIMEOUT 共享 sticky evidence`, async (t) => {
    const { rootPath, dataDir, sourcePath } = await snapshotFixture(t);
    const gate = deferred();
    const entered = deferred();
    const unhandled = [];
    const capture = (error) => unhandled.push(error?.message ?? String(error));
    const originalOpen = fs.open;
    let actualClosed = false;
    let snapshotError = null;

    // 受控 gate 等待期间没有任何 ref'd I/O；snapshot 的 deadline timer 自身会
    // unref，测试需自持一个句柄，否则事件循环会在断言前退出。
    const keep = setInterval(() => {}, 1000);
    process.on("unhandledRejection", capture);
    fs.open = async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) !== sourcePath) return handle;
      failCloseAfterReal(current.kind, () => {
        actualClosed = true;
      })(handle);
      if (current.kind === "source-read") {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          entered.resolve();
          await gate.promise;
          return originalRead(...readArgs);
        };
      } else {
        const originalStat = handle.stat.bind(handle);
        let statCalls = 0;
        handle.stat = async (...statArgs) => {
          statCalls += 1;
          // 第 1 次是 open 后身份核对；第 2 次是复制完成后的 recheck。
          if (statCalls === 2) {
            entered.resolve();
            await gate.promise;
          }
          return originalStat(...statArgs);
        };
      }
      return handle;
    };

    try {
      snapshotError = await createSnapshot({
        dataDir,
        rootPath,
        sourcePath,
        jobId: "synthetic",
        deadlineAtMs: performance.now() + 200,
      }).then(
        () => null,
        (error) => error,
      );
      await Promise.race([
        entered.promise,
        delay(1000).then(() => {
          throw new Error(`${current.kind} 受控操作未进入`);
        }),
      ]);
      assert.ok(snapshotError, "入口 deadline 必须停止等待，不能挂住");
      assert.equal(snapshotError.code, "CLEANUP_FAILED", "清理失败安全码优先");

      const evidence = snapshotError.evidence;
      assert.ok(evidence && typeof evidence === "object", "CLEANUP_FAILED 必须携带原 evidence");
      assert.equal(evidence.reason, current.reason, "必须保留原 TIMEOUT 的 reason");
      assert.equal(evidence.resourceUnknown, true);
      assert.equal(evidence.closeSettled, false);
      assert.equal(evidence.creationPending, false);
      assert.ok(
        evidence.pendingOperations.includes(current.kind),
        "必须保留发起中的 source 操作归属",
      );
      assert.equal(evidence.closeFailed, undefined, "释放 gate 前尚未发生迟到 close 失败");

      // 释放 gate：迟到句柄返回后由接管链 close，并在同一个 evidence 对象上记录失败。
      gate.resolve();
      await waitFor(() => actualClosed, "迟到 fd 实际关闭");
      await waitFor(() => evidence.closeFailed === true, "迟到 close 失败写入 sticky evidence");
      assert.equal(evidence.resourceUnknown, true);
      assert.equal(evidence.closeSettled, false);
      assert.ok(
        evidence.lateCloseFailures.includes(current.label),
        `必须记录迟到 close 标签 ${current.label}`,
      );
      assert.equal(snapshotError.code, "CLEANUP_FAILED", "迟到证据不得改写已公布终态");
      assert.deepEqual(unhandled, [], "迟到 close 拒绝必须留在固定错误边界内");
    } finally {
      gate.resolve();
      clearInterval(keep);
      fs.open = originalOpen;
      process.off("unhandledRejection", capture);
    }
  });
}

test("真实 queue：source-read 超时清理失败仍保留 sticky fault、租约与后续拒绝", async (t) => {
  const base = await tempBase(t, "t13i-r5-queue-");
  const rootPath = path.join(base, "media");
  const dataDir = path.join(base, "data");
  const sourceA = path.join(rootPath, "a.bin");
  const sourceB = path.join(rootPath, "b.bin");
  await fs.mkdir(rootPath);
  await fs.mkdir(dataDir);
  await fs.writeFile(sourceA, Buffer.alloc(1024, 3));
  await fs.writeFile(sourceB, Buffer.alloc(1024, 4));

  const assets = new Map([
    [
      "a",
      {
        assetId: "a",
        kind: "music",
        sourcePath: sourceA,
        rootPath,
        rootId: "root-1",
        online: true,
        trashed: false,
        retired: false,
        rootRetired: false,
        busy: false,
        assetGeneration: 1,
        libraryGeneration: 1,
        sourceGeneration: 1,
      },
    ],
    [
      "b",
      {
        assetId: "b",
        kind: "music",
        sourcePath: sourceB,
        rootPath,
        rootId: "root-1",
        online: true,
        trashed: false,
        retired: false,
        rootRetired: false,
        busy: false,
        assetGeneration: 1,
        libraryGeneration: 1,
        sourceGeneration: 1,
      },
    ],
  ]);

  const gate = deferred();
  const entered = deferred();
  const unhandled = [];
  const capture = (error) => unhandled.push(error?.message ?? String(error));
  const originalOpen = fs.open;
  let actualClosed = false;
  const executions = [];

  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) !== sourceA) return handle;
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      entered.resolve();
      await gate.promise;
      return originalRead(...readArgs);
    };
    failCloseAfterReal("queue-source-read", () => {
      actualClosed = true;
    })(handle);
    return handle;
  };

  const lockPath = path.join(dataDir, "audio-jobs", ".queue-lease");
  const queue = new AudioJobQueue({
    dataDir,
    resolveAsset: async (assetId) => assets.get(assetId) ?? null,
    execute: async () => {
      executions.push(1);
      return { ok: true };
    },
    wallDeadlineMs: 120,
    maxSnapshotBytes: 1024 * 1024,
    maxWaiting: 8,
    maxTerminal: 100,
    terminalTtlMs: 60_000,
  });

  const keep = setInterval(() => {}, 1000);
  process.on("unhandledRejection", capture);
  try {
    const a = await queue.submit("a");
    await Promise.race([
      entered.promise,
      delay(2000).then(() => {
        throw new Error("queue source-read 受控操作未进入");
      }),
    ]);
    const failed = await waitFor(async () => {
      const job = await queue.get(a.id).catch(() => null);
      return job?.state === "failed" ? job : null;
    }, "queue failed");
    assert.equal(failed.error.code, "CLEANUP_FAILED", "queue 保持清理失败安全码");
    assert.equal(queue.busy, true, "故障后 queue 必须保持 busy");
    assert.ok(await fs.lstat(lockPath), "清理证据未 settle 时不得释放租约");
    assert.equal(executions.length, 0, "快照失败时执行器一次也不应被调用");

    const b = await queue.submit("b");
    await delay(50);
    assert.equal((await queue.get(b.id)).state, "queued", "故障门后不得启动后续任务");

    // 迟到 read/close 完成后仍不得自动解锁或改判。
    gate.resolve();
    await waitFor(() => actualClosed, "queue 迟到 fd 实际关闭");
    await delay(50);
    assert.equal((await queue.get(a.id)).state, "failed", "迟到完成不得改已公布终态");
    assert.ok(await fs.lstat(lockPath), "迟到完成不得自动释放租约");
    assert.equal(queue.busy, true);

    await queue.dispose();
    assert.equal((await queue.get(b.id)).state, "cancelled");
    assert.ok(await fs.lstat(lockPath), "dispose 也不静默释放未完成清理的租约");
    assert.deepEqual(unhandled, [], "迟到 close 拒绝不得逃逸为未处理拒绝");
  } finally {
    gate.resolve();
    clearInterval(keep);
    fs.open = originalOpen;
    process.off("unhandledRejection", capture);
    await queue.dispose().catch(() => {});
  }
});
