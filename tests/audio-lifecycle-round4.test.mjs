/**
 * T-LOCAL-013I-LIFECYCLE-IMPL-001 round4：snapshot 迟到接管链的拒绝归属。
 *
 * 反例来源：round3 的 closeLate 记录了 closeFailed，却把原始 rejected close promise
 * 交给无人 await 的 `.then` 派生链，产生 unhandledRejection。本文件对
 * source-open / source-stat / source-read / source-recheck / output-open / output-write
 * 六个同构分支做确定性合成验证：close 失败必须被消费为证据，不得逃逸为未处理拒绝。
 *
 * 只用临时目录、1KiB 合成文件和受控 gate；fd 先真实关闭再注入失败，不遗留句柄。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createSnapshot } from "../server/audio-snapshot.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function snapshotFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-r4-late-close-")));
  const rootPath = path.join(base, "media");
  const dataDir = path.join(base, "data");
  const sourcePath = path.join(rootPath, "synthetic.bin");
  await fs.mkdir(rootPath);
  await fs.mkdir(dataDir);
  await fs.writeFile(sourcePath, Buffer.alloc(1024, 7));
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
  });
  return { base, rootPath, dataDir, sourcePath };
}

const CASES = [
  { kind: "source-open", label: "source-open-late", creationPending: false, deadlineMs: 60, expectedCode: "TIMEOUT" },
  { kind: "source-stat", label: "source-stat-late", creationPending: false, deadlineMs: 60, expectedCode: "TIMEOUT" },
  { kind: "source-read", label: "source-read-late", creationPending: false, deadlineMs: 60, expectedCode: "CLEANUP_FAILED" },
  { kind: "source-recheck", label: "source-recheck-late", creationPending: false, deadlineMs: 200, expectedCode: "CLEANUP_FAILED" },
  { kind: "output-open", label: "output-open-late", creationPending: true, deadlineMs: 60, expectedCode: "TIMEOUT" },
  { kind: "output-write", label: "output-write-late", creationPending: true, deadlineMs: 60, expectedCode: "TIMEOUT" },
];

for (const current of CASES) {
  test(`snapshot ${current.kind} 迟到 close 失败：无未处理拒绝且证据保留`, async (t) => {
    const { rootPath, dataDir, sourcePath } = await snapshotFixture(t);
    const gate = deferred();
    const entered = deferred();
    const unhandled = [];
    const capture = (error) => unhandled.push(error?.message ?? String(error));
    const originalOpen = fs.open;
    let actualClosed = false;

    // 先真实 close，再注入失败：验证 fd 没有因为“记录证据”而泄漏。
    const failCloseAfterReal = (handle) => {
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        await originalClose();
        actualClosed = true;
        throw Object.assign(new Error(`synthetic-late-close-failure:${current.kind}`), {
          code: "EIO",
        });
      };
    };

    const isOutput = (value) => String(value).includes("job-") && String(value).endsWith("source.bin");

    process.on("unhandledRejection", capture);
    try {
      fs.open = async (...args) => {
        const handle = await originalOpen(...args);
        const target = String(args[0]);
        if (current.kind === "source-open" && target === sourcePath) {
          failCloseAfterReal(handle);
          entered.resolve();
          // open 本身迟到返回：调用侧已按 deadline 失败，fd 由迟到接管链负责 close。
          await gate.promise;
        } else if (current.kind === "source-stat" && target === sourcePath) {
          const originalStat = handle.stat.bind(handle);
          handle.stat = async (...statArgs) => {
            entered.resolve();
            await gate.promise;
            return originalStat(...statArgs);
          };
          failCloseAfterReal(handle);
        } else if (current.kind === "source-read" && target === sourcePath) {
          const originalRead = handle.read.bind(handle);
          handle.read = async (...readArgs) => {
            entered.resolve();
            await gate.promise;
            return originalRead(...readArgs);
          };
          failCloseAfterReal(handle);
        } else if (current.kind === "source-recheck" && target === sourcePath) {
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
          failCloseAfterReal(handle);
        } else if (current.kind === "output-open" && isOutput(target)) {
          failCloseAfterReal(handle);
          entered.resolve();
          await gate.promise;
        } else if (current.kind === "output-write" && isOutput(target)) {
          const originalWrite = handle.write.bind(handle);
          handle.write = async (...writeArgs) => {
            entered.resolve();
            await gate.promise;
            return originalWrite(...writeArgs);
          };
          failCloseAfterReal(handle);
        }
        return handle;
      };

      const outcome = await Promise.race([
        createSnapshot({
          dataDir,
          rootPath,
          sourcePath,
          jobId: "synthetic",
          deadlineAtMs: performance.now() + current.deadlineMs,
        }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
        delay(2000).then(() => ({ timeout: true })),
      ]);
      await Promise.race([
        entered.promise,
        delay(1000).then(() => {
          throw new Error(`${current.kind} 受控操作未进入`);
        }),
      ]);
      assert.equal(outcome.timeout, undefined, "入口 deadline 必须停止等待，不能挂住");
      assert.ok(outcome.error, "必须在 deadline 内以受控失败结束");
      assert.equal(
        outcome.error.code,
        current.expectedCode,
        `受控失败码应为 ${current.expectedCode}，实际 ${outcome.error.code}`,
      );
      const evidence = outcome.error.evidence;
      assert.ok(evidence && typeof evidence === "object", "CLEANUP_FAILED/TIMEOUT 必须携带 evidence");
      assert.equal(evidence.resourceUnknown, true);
      assert.equal(
        evidence.creationPending,
        current.creationPending,
        "共享副作用 pending 语义不变",
      );

      // 释放 gate：迟到句柄返回/read/write 完成后，接管链负责 close。
      gate.resolve();
      await delay(150);
      assert.equal(actualClosed, true, "迟到 fd 必须实际关闭后才注入 close 失败");
      assert.equal(evidence.closeFailed, true, "close 失败必须保留独立证据");
      assert.equal(evidence.closeSettled, false);
      assert.ok(
        evidence.lateCloseFailures.includes(current.label),
        `必须记录迟到 close 标签 ${current.label}`,
      );
      assert.equal(
        outcome.error.code,
        current.expectedCode,
        "迟到证据不得改写已公布终态",
      );
      assert.deepEqual(unhandled, [], "迟到 close 拒绝必须留在固定错误边界内");
    } finally {
      gate.resolve();
      fs.open = originalOpen;
      process.off("unhandledRejection", capture);
    }
  });
}
