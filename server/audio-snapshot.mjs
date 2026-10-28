/**
 * T-LOCAL-013B：登记根内源文件的有界私有快照。
 *
 * 只接受内部可信 resolver 产物（assetId/rootPath/sourcePath 等），不接触 HTTP 输入。
 * 设计目标：
 *   - realpath 后复用 fs-identity.within 做登记根边界判断；
 *   - 只接受普通文件，拒绝目录/FIFO/设备/最终符号链接与逃逸链接；
 *   - 打开时 O_NOFOLLOW|O_NONBLOCK，打开后 fstat 复核身份，防止“验证后被换成 FIFO”挂死；
 *   - 单个 64KiB 读循环同时完成复制与 SHA256，不 readFile 整文件；
 *   - 前后核对 dev/ino/size/mtime/ctime，复制中增长/修改/替换都报 SOURCE_CHANGED；
 *   - 任务目录 0700、文件 0600 且排他创建；清理只删带本任务 token 标记的目录。
 *
 * 本模块不启动进程、不联网、不读数据库、不写日志。
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { within } from "./fs-identity.mjs";

const CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const MARKER = ".owner.json";
const SNAPSHOT_FILE = "source.bin";

export const SNAPSHOT_CODES = Object.freeze({
  SOURCE_MISSING: "SOURCE_MISSING",
  SOURCE_NOT_REGULAR: "SOURCE_NOT_REGULAR",
  SOURCE_OUTSIDE_ROOT: "SOURCE_OUTSIDE_ROOT",
  SOURCE_UNREADABLE: "SOURCE_UNREADABLE",
  SOURCE_CHANGED: "SOURCE_CHANGED",
  INPUT_LIMIT_EXCEEDED: "INPUT_LIMIT_EXCEEDED",
  CANCELLED: "CANCELLED",
  SNAPSHOT_FAILED: "SNAPSHOT_FAILED",
  CLEANUP_FAILED: "CLEANUP_FAILED",
  TIMEOUT: "TIMEOUT",
  INVALID_REQUEST: "INVALID_REQUEST",
});

const MESSAGES = Object.freeze({
  SOURCE_MISSING: "源文件不存在",
  SOURCE_NOT_REGULAR: "源不是普通文件",
  SOURCE_OUTSIDE_ROOT: "源超出登记根",
  SOURCE_UNREADABLE: "源文件不可读",
  SOURCE_CHANGED: "源文件已变化",
  INPUT_LIMIT_EXCEEDED: "源文件超出大小限制",
  CANCELLED: "快照已取消",
  SNAPSHOT_FAILED: "快照失败",
  CLEANUP_FAILED: "快照清理失败",
  TIMEOUT: "快照超时",
  INVALID_REQUEST: "快照参数无效",
});

export class AudioSnapshotError extends Error {
  constructor(code, message) {
    super(message || MESSAGES[code] || "快照失败");
    this.name = "AudioSnapshotError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new AudioSnapshotError(code);
};

const SNAPSHOT_BUDGET_EXHAUSTED = Symbol("snapshotBudgetExhausted");

const monoNow = () => performance.now();
const remaining = (deadlineAtMs) => deadlineAtMs - monoNow();

function raceBudget(promise, budgetMs) {
  if (!(budgetMs > 0)) return Promise.resolve(SNAPSHOT_BUDGET_EXHAUSTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(SNAPSHOT_BUDGET_EXHAUSTED);
    }, budgetMs);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 创建阶段的共享副作用；超时未 settle 时不得按“未创建”回收现场。 */
const MUTATING_OPERATIONS = new Set([
  "base-mkdir",
  "base-chmod",
  "job-mkdir",
  "marker-write",
  "output-open",
  "output-write",
]);

const isAborted = (signal) => Boolean(signal?.aborted);
const checkAbort = (signal) => {
  if (isAborted(signal)) fail("CANCELLED");
};

function mapFsError(error) {
  if (error instanceof AudioSnapshotError) return error;
  switch (error?.code) {
    case "ENOENT":
    case "ENOTDIR":
      return new AudioSnapshotError("SOURCE_MISSING");
    case "ELOOP":
    case "EISDIR":
    case "ENXIO":
      return new AudioSnapshotError("SOURCE_NOT_REGULAR");
    case "EACCES":
    case "EPERM":
      return new AudioSnapshotError("SOURCE_UNREADABLE");
    default:
      return new AudioSnapshotError("SNAPSHOT_FAILED");
  }
}

function closeTo(a, b) {
  return typeof a === "number" && typeof b === "number" && a === b;
}

/** dev/ino/size/mtime/ctime 同步身份；ctime 用于识别“内容被改但 mtime 被还原”。 */
function sameIdentity(a, b) {
  return (
    a &&
    b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    closeTo(a.mtimeMs, b.mtimeMs) &&
    closeTo(a.ctimeMs, b.ctimeMs)
  );
}

function identityOf(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

async function readMarker(dir) {
  try {
    const raw = await fs.readFile(path.join(dir, MARKER), { encoding: "utf8", flag: "r" });
    if (raw.length > 4096) return null;
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** 只删除本进程创建、token 仍匹配、且位于私有 audio-jobs 根内的任务目录。 */
async function removeOwnedDir(base, dir, token) {
  const marker = await readMarker(dir);
  if (!marker || marker.token !== token) fail("CLEANUP_FAILED");
  if (!within(base, dir) || dir === base) fail("CLEANUP_FAILED");
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    fail("CLEANUP_FAILED");
  }
  if (await exists(dir)) fail("CLEANUP_FAILED");
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建阶段失败、marker 尚未确认完整写入时的回收。
 *
 * 此目录只可能是本进程刚用排他 mkdir、随机 token 路径在 0700 私有根下创建的；
 * 此时 marker 可能只有半段字节，不能按 marker 归属校验。这里只删除本任务固定
 * 路径的 marker 和这个空目录，绝不递归删除目录内容；只要目录仍存在或任一步
 * 失败就抛 CLEANUP_FAILED，交给上层保留租约/故障 busy。
 */
async function removeIncompleteDir(base, dir) {
  if (!within(base, dir) || dir === base) fail("CLEANUP_FAILED");
  // 只允许回收“除了本次未写完的 marker 之外什么都没有”的目录；出现任何未知
  // 条目都保留现场，避免把并发/外部内容一起删掉。
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    fail("CLEANUP_FAILED");
  }
  if (entries.some((name) => name !== MARKER)) fail("CLEANUP_FAILED");
  try {
    await fs.unlink(path.join(dir, MARKER));
  } catch (error) {
    if (error?.code !== "ENOENT") fail("CLEANUP_FAILED");
  }
  try {
    await fs.rmdir(dir);
  } catch {
    fail("CLEANUP_FAILED");
  }
  if (await exists(dir)) fail("CLEANUP_FAILED");
}

/**
 * 创建一份快照。
 *
 * @param {object} options
 * @param {string} options.dataDir 应用数据目录；快照落在 <dataDir>/audio-jobs/ 下
 * @param {string} options.rootPath 已登记根
 * @param {string} options.sourcePath 源文件
 * @param {number} [options.maxBytes] 实际复制字节上限，默认 256MiB
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.jobId]
 * @param {object} [options.hooks] 仅测试使用的注入点：beforeOpen / afterChunk
 */
export async function createSnapshot(options = {}) {
  const {
    dataDir,
    rootPath,
    sourcePath,
    maxBytes = DEFAULT_MAX_BYTES,
    signal,
    jobId = "snapshot",
    deadlineAtMs,
    hooks = {},
  } = options;
  if (
    typeof dataDir !== "string" ||
    !dataDir ||
    typeof rootPath !== "string" ||
    !rootPath ||
    typeof sourcePath !== "string" ||
    !sourcePath ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    typeof jobId !== "string" ||
    !jobId ||
    (deadlineAtMs !== undefined && (typeof deadlineAtMs !== "number" || !Number.isFinite(deadlineAtMs)))
  ) {
    fail("INVALID_REQUEST");
  }
  checkAbort(signal);

  // 创建失败时带给 queue 的归属证据：pending 中的操作已发起但未 settle，
  // 仍可能产生目录/文件/句柄；存在共享副作用 pending 时不得并发删除或重建。
  const pendingOperations = new Set();
  const closeFailures = [];
  let mutationPending = false;
  let failure = null;

  const deadlineError = (reason, extra = {}) => {
    const error = new AudioSnapshotError("TIMEOUT");
    error.evidence = {
      reason,
      resourceUnknown: true,
      closeSettled: false,
      creationPending:
        mutationPending || [...pendingOperations].some((label) => MUTATING_OPERATIONS.has(label)),
      pendingOperations: [...pendingOperations],
      ...extra,
    };
    return error;
  };
  const recordCloseFailure = (label, error) => {
    closeFailures.push(label);
    if (error?.evidence && typeof error.evidence === "object") {
      error.evidence.closeFailed = true;
      error.evidence.resourceUnknown = true;
      error.evidence.closeSettled = false;
      error.evidence.lateCloseFailures = [...closeFailures];
    }
  };
  // 已发起的只读/写句柄迟到返回：close 后失败仍记独立证据，不吞错。
  // 返回的 promise 对“close 成功/失败”一律 resolve：迟到接管链的 `.then` 派生
  // promise 无人 await，若把 close 拒绝透传出去就会变成 unhandledRejection。
  // 拒绝在这里被完整消费并归属为 closeFailed/lateCloseFailures，不外抛、不改终态。
  const closeLate = (handle, label, error) => {
    pendingOperations.add(label);
    return Promise.resolve()
      .then(() => handle.close())
      .then(
        () => {
          pendingOperations.delete(label);
          return true;
        },
        () => {
          pendingOperations.delete(label);
          recordCloseFailure(label, error);
          return false;
        },
      );
  };
  const checkBudget = () => {
    if (deadlineAtMs !== undefined && remaining(deadlineAtMs) <= 0) {
      throw deadlineError("SNAPSHOT_ENTRY_DEADLINE");
    }
  };
  const budgeted = async (promise, label, { mutation = false, reason = label } = {}) => {
    const guarded = Promise.resolve(promise);
    guarded.catch(() => {});
    pendingOperations.add(label);
    let outcome;
    try {
      outcome =
        deadlineAtMs === undefined ? await guarded : await raceBudget(guarded, remaining(deadlineAtMs));
    } catch (error) {
      pendingOperations.delete(label);
      throw error;
    }
    if (outcome === SNAPSHOT_BUDGET_EXHAUSTED) {
      if (mutation) mutationPending = true;
      throw deadlineError(reason);
    }
    pendingOperations.delete(label);
    return outcome;
  };
  const closeBounded = async (handle, label, error) => {
    if (!handle) return true;
    pendingOperations.add(label);
    const closePromise = Promise.resolve().then(() => handle.close()).then(
      () => ({ ok: true }),
      (closeError) => ({ ok: false, closeError }),
    );
    if (deadlineAtMs === undefined) {
      const outcome = await closePromise;
      pendingOperations.delete(label);
      if (!outcome.ok) {
        recordCloseFailure(label, error);
        return false;
      }
      return true;
    }
    const outcome = await raceBudget(closePromise, remaining(deadlineAtMs));
    if (outcome === SNAPSHOT_BUDGET_EXHAUSTED) {
      // 只停止等待；迟到 close 失败仍记独立证据，不改变已公布终态。
      closePromise.then((late) => {
        pendingOperations.delete(label);
        if (!late.ok) recordCloseFailure(label, error);
      });
      return false;
    }
    pendingOperations.delete(label);
    if (!outcome.ok) {
      recordCloseFailure(label, error);
      return false;
    }
    return true;
  };

  let rootReal;
  let sourceReal;
  let before;
  try {
    rootReal = await budgeted(fs.realpath(rootPath), "root-realpath");
    const rootStat = await budgeted(fs.lstat(rootReal), "root-lstat");
    if (!rootStat.isDirectory()) fail("SOURCE_OUTSIDE_ROOT");
    sourceReal = await budgeted(fs.realpath(sourcePath), "source-realpath");
  } catch (error) {
    throw mapFsError(error);
  }
  if (!within(rootReal, sourceReal)) fail("SOURCE_OUTSIDE_ROOT");
  if (sourceReal === rootReal) fail("SOURCE_NOT_REGULAR");

  try {
    // 最终组件必须是普通文件，不接受符号链接（即使指向根内）；父级符号链接仅在其
    // realpath 仍落在登记根内时允许。
    const lst = await budgeted(fs.lstat(sourcePath), "source-lstat");
    if (lst.isSymbolicLink()) fail("SOURCE_NOT_REGULAR");
    if (!lst.isFile()) fail("SOURCE_NOT_REGULAR");
    before = identityOf(lst);
  } catch (error) {
    throw mapFsError(error);
  }
  if (before.size > maxBytes) fail("INPUT_LIMIT_EXCEEDED");
  checkBudget();

  if (typeof hooks.beforeOpen === "function") await hooks.beforeOpen({ sourcePath, sourceReal });
  checkBudget();

  let handle;
  {
    const openPromise = Promise.resolve().then(() =>
      fs.open(
        sourceReal,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
      ),
    );
    openPromise.catch(() => {});
    pendingOperations.add("source-open");
    let openedOutcome;
    try {
      openedOutcome =
        deadlineAtMs === undefined
          ? await openPromise
          : await raceBudget(openPromise, remaining(deadlineAtMs));
    } catch (error) {
      pendingOperations.delete("source-open");
      throw mapFsError(error);
    }
    if (openedOutcome === SNAPSHOT_BUDGET_EXHAUSTED) {
      const error = deadlineError("SNAPSHOT_SOURCE_OPEN_DEADLINE");
      // open 已发起：迟到返回的 fd 由本次调用负责 close，close 失败记独立证据。
      openPromise.then(
        (lateHandle) => closeLate(lateHandle, "source-open-late", error),
        () => {},
      );
      throw error;
    }
    pendingOperations.delete("source-open");
    handle = openedOutcome;
  }

  let opened;
  {
    const statPromise = Promise.resolve().then(() => handle.stat());
    statPromise.catch(() => {});
    pendingOperations.add("source-stat");
    let statOutcome;
    try {
      statOutcome =
        deadlineAtMs === undefined
          ? await statPromise
          : await raceBudget(statPromise, remaining(deadlineAtMs));
    } catch (error) {
      pendingOperations.delete("source-stat");
      await closeBounded(handle, "source-stat-close", error);
      handle = null;
      throw mapFsError(error);
    }
    if (statOutcome === SNAPSHOT_BUDGET_EXHAUSTED) {
      const error = deadlineError("SNAPSHOT_SOURCE_STAT_DEADLINE");
      const lateHandle = handle;
      handle = null;
      statPromise.then(
        () => closeLate(lateHandle, "source-stat-late", error),
        () => closeLate(lateHandle, "source-stat-late", error),
      );
      throw error;
    }
    pendingOperations.delete("source-stat");
    opened = statOutcome;
    try {
      if (!opened.isFile()) fail("SOURCE_NOT_REGULAR");
      if (!sameIdentity(before, identityOf(opened))) fail("SOURCE_CHANGED");
    } catch (error) {
      await closeBounded(handle, "source-identity-close", error);
      handle = null;
      throw mapFsError(error);
    }
  }

  const base = path.join(dataDir, "audio-jobs");
  const token = crypto.randomBytes(16).toString("hex");
  const dir = path.join(base, `job-${process.pid}-${token.slice(0, 16)}`);
  let created = false;
  let markerWritten = false;
  let out;
  try {
    await budgeted(fs.mkdir(base, { recursive: true, mode: 0o700 }), "base-mkdir", {
      mutation: true,
    });
    await budgeted(fs.chmod(base, 0o700).catch(() => {}), "base-chmod", { mutation: true });
    await budgeted(fs.mkdir(dir, { mode: 0o700 }), "job-mkdir", { mutation: true });
    created = true;
    await budgeted(
      fs.writeFile(
        path.join(dir, MARKER),
        JSON.stringify({ token, jobId, pid: process.pid, createdAt: new Date().toISOString() }),
        { mode: 0o600, flag: "wx" },
      ),
      "marker-write",
      { mutation: true },
    );
    markerWritten = true;
    const filePath = path.join(dir, SNAPSHOT_FILE);
    {
      const outputOpenPromise = Promise.resolve().then(() =>
        fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600),
      );
      outputOpenPromise.catch(() => {});
      pendingOperations.add("output-open");
      let outputOpenOutcome;
      try {
        outputOpenOutcome =
          deadlineAtMs === undefined
            ? await outputOpenPromise
            : await raceBudget(outputOpenPromise, remaining(deadlineAtMs));
      } catch (error) {
        pendingOperations.delete("output-open");
        throw error;
      }
      if (outputOpenOutcome === SNAPSHOT_BUDGET_EXHAUSTED) {
        mutationPending = true;
        const error = deadlineError("SNAPSHOT_OUTPUT_OPEN_DEADLINE");
        // output open 已发起：迟到返回的 fd 由本次调用 close，不并发删除现场。
        outputOpenPromise.then(
          (lateOut) => closeLate(lateOut, "output-open-late", error),
          () => {},
        );
        throw error;
      }
      pendingOperations.delete("output-open");
      out = outputOpenOutcome;
    }

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let bytes = 0;
    let chunks = 0;
    for (;;) {
      checkAbort(signal);
      checkBudget();
      const readPromise = Promise.resolve().then(() => handle.read(buffer, 0, buffer.length, null));
      readPromise.catch(() => {});
      pendingOperations.add("source-read");
      let readOutcome;
      try {
        readOutcome =
          deadlineAtMs === undefined
            ? await readPromise
            : await raceBudget(readPromise, remaining(deadlineAtMs));
      } catch (error) {
        pendingOperations.delete("source-read");
        throw error;
      }
      if (readOutcome === SNAPSHOT_BUDGET_EXHAUSTED) {
        const error = deadlineError("SNAPSHOT_SOURCE_READ_DEADLINE");
        const lateHandle = handle;
        handle = null;
        // 读已发起：等这次 read 返回后再 close 同一个 fd；close 失败保留独立证据。
        readPromise.then(
          () => closeLate(lateHandle, "source-read-late", error),
          () => closeLate(lateHandle, "source-read-late", error),
        );
        throw error;
      }
      pendingOperations.delete("source-read");
      const { bytesRead } = readOutcome;
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes) fail("INPUT_LIMIT_EXCEEDED");
      // 复制中增长：早于后置 fstat 给出确定错误，避免继续多读。
      if (bytes > opened.size) fail("SOURCE_CHANGED");
      hash.update(buffer.subarray(0, bytesRead));
      // FileHandle.write 允许短写；必须循环到本块全部落盘。零进度/越界立即受控失败，
      // 不能把“已读入 buffer”当成“已写入副本”。
      let written = 0;
      while (written < bytesRead) {
        const writePromise = Promise.resolve().then(() =>
          out.write(buffer, written, bytesRead - written),
        );
        writePromise.catch(() => {});
        pendingOperations.add("output-write");
        let writeOutcome;
        try {
          writeOutcome =
            deadlineAtMs === undefined
              ? await writePromise
              : await raceBudget(writePromise, remaining(deadlineAtMs));
        } catch (error) {
          pendingOperations.delete("output-write");
          throw error;
        }
        if (writeOutcome === SNAPSHOT_BUDGET_EXHAUSTED) {
          // 写已发起且可能产生共享副作用：保留现场，不并发第二次 rm/创建；
          // 写 settle 后仍负责 close 本实例 fd。
          mutationPending = true;
          const error = deadlineError("SNAPSHOT_OUTPUT_WRITE_DEADLINE");
          const lateOut = out;
          out = null;
          writePromise.then(
            () => closeLate(lateOut, "output-write-late", error),
            () => closeLate(lateOut, "output-write-late", error),
          );
          throw error;
        }
        pendingOperations.delete("output-write");
        const { bytesWritten } = writeOutcome;
        if (
          !Number.isInteger(bytesWritten) ||
          bytesWritten <= 0 ||
          bytesWritten > bytesRead - written
        ) {
          fail("SNAPSHOT_FAILED");
        }
        written += bytesWritten;
      }
      chunks += 1;
      if (typeof hooks.afterChunk === "function") {
        await hooks.afterChunk({ bytes, chunks, dir, filePath, sourcePath });
      }
    }
    checkAbort(signal);

    // 成功前核对副本的实际字节数，避免“报告 bytes/hash 来自源读取、副本却缺失”。
    let copyStat;
    try {
      copyStat = await budgeted(out.stat(), "output-stat");
    } catch {
      fail("SNAPSHOT_FAILED");
    }
    if (copyStat.size !== bytes) fail("SNAPSHOT_FAILED");

    let after;
    {
      const statPromise = Promise.resolve().then(() => handle.stat());
      statPromise.catch(() => {});
      pendingOperations.add("source-recheck");
      let statOutcome;
      try {
        statOutcome =
          deadlineAtMs === undefined
            ? await statPromise
            : await raceBudget(statPromise, remaining(deadlineAtMs));
      } catch {
        pendingOperations.delete("source-recheck");
        fail("SOURCE_CHANGED");
      }
      if (statOutcome === SNAPSHOT_BUDGET_EXHAUSTED) {
        const error = deadlineError("SNAPSHOT_SOURCE_RECHECK_DEADLINE");
        const lateHandle = handle;
        handle = null;
        statPromise.then(
          () => closeLate(lateHandle, "source-recheck-late", error),
          () => closeLate(lateHandle, "source-recheck-late", error),
        );
        throw error;
      }
      pendingOperations.delete("source-recheck");
      after = statOutcome;
    }
    if (!sameIdentity(opened, identityOf(after))) fail("SOURCE_CHANGED");
    if (bytes !== opened.size) fail("SOURCE_CHANGED");

    // 路径仍指向打开时的同一对象；realpath 也不能在复制期间换到别处。
    let now;
    try {
      now = await budgeted(fs.lstat(sourceReal), "source-final-lstat");
      const realAgain = await budgeted(fs.realpath(sourcePath), "source-final-realpath");
      if (realAgain !== sourceReal) fail("SOURCE_CHANGED");
      if (!within(rootReal, realAgain)) fail("SOURCE_OUTSIDE_ROOT");
    } catch (error) {
      throw mapFsError(error);
    }
    if (now.isSymbolicLink() || !now.isFile()) fail("SOURCE_CHANGED");
    if (now.dev !== opened.dev || now.ino !== opened.ino) fail("SOURCE_CHANGED");
    if (!sameIdentity(identityOf(opened), identityOf(now))) fail("SOURCE_CHANGED");

    const digest = hash.digest("hex");
    const snapshot = {
      filePath,
      dir,
      token,
      sha256: digest,
      bytes,
      chunks,
      sourcePath,
      sourceReal,
      rootReal,
      rootPath,
      jobId,
      source: identityOf(opened),
      cleaned: false,
      cleanupPending: false,
      cleanupSettled: false,
      cleanupPromise: null,
      cleanup: null,
    };
    snapshot.cleanup = async (cleanupOptions = {}) => {
      if (snapshot.cleaned) return;
      // 唯一一次 rm：并发/重入清理只共享同一个 promise，绝不再发起第二次 rm。
      if (!snapshot.cleanupPromise) {
        snapshot.cleanupPromise = removeOwnedDir(base, dir, token).then(
          () => {
            snapshot.cleaned = true;
            snapshot.cleanupPending = false;
            snapshot.cleanupSettled = true;
          },
          (error) => {
            snapshot.cleanupPending = false;
            snapshot.cleanupSettled = true;
            throw error;
          },
        );
      }
      const cleanupDeadline =
        cleanupOptions && Number.isFinite(cleanupOptions.deadlineAtMs)
          ? cleanupOptions.deadlineAtMs
          : null;
      if (Number.isFinite(cleanupDeadline)) {
        const outcome = await raceBudget(snapshot.cleanupPromise, remaining(cleanupDeadline));
        if (outcome === SNAPSHOT_BUDGET_EXHAUSTED) {
          // 只停止等待：迟到完成只改善证据，不重开 rm、不改上层终态。
          snapshot.cleanupPending = true;
          fail("CLEANUP_FAILED");
        }
      } else {
        await snapshot.cleanupPromise;
      }
      snapshot.cleaned = true;
    };
    return snapshot;
  } catch (error) {
    failure = error;
    // 先按同一 deadline 收敛输出句柄；createSnapshot 返回的对象尚不存在，
    // queue 只能靠错误 evidence 判断是否必须保留现场和租约。
    await closeBounded(out, "output-close", error);
    out = null;
    if (mutationPending && error?.evidence && typeof error.evidence === "object") {
      error.evidence.creationPending = true;
      error.evidence.creationPreserved = true;
      error.evidence.pendingOperations = [...pendingOperations];
    }
    let cleanupError = null;
    // 共享副作用（mkdir/marker/output-open/write）尚未 settle 时：
    //   - 不能按“未创建”删除或重建；
    //   - 不并发第二次 rm；
    //   - 迟到完成只改善证据，由上层保留租约与现场。
    if (created && !mutationPending) {
      const cleanup = markerWritten
        ? removeOwnedDir(base, dir, token)
        : removeIncompleteDir(base, dir);
      try {
        if (deadlineAtMs !== undefined) {
          // 创建失败回收同样受同一绝对 deadline 约束；预算耗尽只发起一次、
          // 不等待，迟到结果只作证据，最终仍 fail-closed 为 CLEANUP_FAILED。
          const outcome = await raceBudget(cleanup, remaining(deadlineAtMs));
          if (outcome === SNAPSHOT_BUDGET_EXHAUSTED) {
            cleanup.catch(() => {});
            cleanupError = true;
          }
        } else {
          await cleanup;
        }
      } catch {
        cleanupError = true;
      }
    }
    if (cleanupError) {
      // 清理失败优先只改安全错误码：原错误的 evidence 对象必须原样移交，
      // 不能复制当时字段。迟到 close 失败会继续更新同一个对象，上层在
      // CLEANUP_FAILED 返回后仍能观察到 closeFailed/lateCloseFailures/unknown。
      const cleanupFailed = new AudioSnapshotError("CLEANUP_FAILED");
      if (error?.evidence && typeof error.evidence === "object") {
        cleanupFailed.evidence = error.evidence;
      }
      throw cleanupFailed;
    }
    throw mapFsError(error);
  } finally {
    const outClosed = await closeBounded(out, "output-close-finally", failure);
    const sourceClosed = await closeBounded(handle, "source-close-finally", failure);
    if (!failure && (!outClosed || !sourceClosed)) {
      // 成功路径上 close 未证实：不得返回一个可能仍持有 fd 的快照对象。
      const error = new AudioSnapshotError(
        closeFailures.length > 0 ? "SNAPSHOT_FAILED" : "TIMEOUT",
      );
      error.evidence = {
        reason: "SNAPSHOT_CLOSE_DEADLINE",
        resourceUnknown: true,
        closeSettled: false,
        closeFailed: closeFailures.length > 0,
        lateCloseFailures: [...closeFailures],
      };
      throw error;
    }
  }
}

/** 运行结束后核对源文件仍是快照时的同一对象；返回 true 或抛固定错误。 */
export async function assertSourceUnchanged(snapshot) {
  if (!snapshot || typeof snapshot !== "object") fail("SOURCE_CHANGED");
  try {
    const realAgain = await fs.realpath(snapshot.sourcePath);
    if (realAgain !== snapshot.sourceReal) fail("SOURCE_CHANGED");
    if (!within(snapshot.rootReal, realAgain)) fail("SOURCE_OUTSIDE_ROOT");
    const now = await fs.lstat(snapshot.sourceReal);
    if (now.isSymbolicLink() || !now.isFile()) fail("SOURCE_CHANGED");
    if (!sameIdentity(snapshot.source, identityOf(now))) fail("SOURCE_CHANGED");
    return true;
  } catch (error) {
    throw mapFsError(error);
  }
}
