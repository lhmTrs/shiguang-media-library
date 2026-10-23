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
    !jobId
  ) {
    fail("INVALID_REQUEST");
  }
  checkAbort(signal);

  let rootReal;
  let sourceReal;
  let before;
  try {
    rootReal = await fs.realpath(rootPath);
    const rootStat = await fs.lstat(rootReal);
    if (!rootStat.isDirectory()) fail("SOURCE_OUTSIDE_ROOT");
    sourceReal = await fs.realpath(sourcePath);
  } catch (error) {
    throw mapFsError(error);
  }
  if (!within(rootReal, sourceReal)) fail("SOURCE_OUTSIDE_ROOT");
  if (sourceReal === rootReal) fail("SOURCE_NOT_REGULAR");

  try {
    // 最终组件必须是普通文件，不接受符号链接（即使指向根内）；父级符号链接仅在其
    // realpath 仍落在登记根内时允许。
    const lst = await fs.lstat(sourcePath);
    if (lst.isSymbolicLink()) fail("SOURCE_NOT_REGULAR");
    if (!lst.isFile()) fail("SOURCE_NOT_REGULAR");
    before = identityOf(lst);
  } catch (error) {
    throw mapFsError(error);
  }
  if (before.size > maxBytes) fail("INPUT_LIMIT_EXCEEDED");

  if (typeof hooks.beforeOpen === "function") await hooks.beforeOpen({ sourcePath, sourceReal });

  let handle;
  try {
    handle = await fs.open(
      sourceReal,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
    );
  } catch (error) {
    throw mapFsError(error);
  }

  let opened;
  try {
    opened = await handle.stat();
    if (!opened.isFile()) fail("SOURCE_NOT_REGULAR");
    if (!sameIdentity(before, identityOf(opened))) fail("SOURCE_CHANGED");
  } catch (error) {
    await handle.close().catch(() => {});
    throw mapFsError(error);
  }

  const base = path.join(dataDir, "audio-jobs");
  const token = crypto.randomBytes(16).toString("hex");
  const dir = path.join(base, `job-${process.pid}-${token.slice(0, 16)}`);
  let created = false;
  let markerWritten = false;
  let out;
  try {
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    await fs.chmod(base, 0o700).catch(() => {});
    await fs.mkdir(dir, { mode: 0o700 });
    created = true;
    await fs.writeFile(
      path.join(dir, MARKER),
      JSON.stringify({ token, jobId, pid: process.pid, createdAt: new Date().toISOString() }),
      { mode: 0o600, flag: "wx" },
    );
    markerWritten = true;
    const filePath = path.join(dir, SNAPSHOT_FILE);
    out = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    let bytes = 0;
    let chunks = 0;
    for (;;) {
      checkAbort(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
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
        const { bytesWritten } = await out.write(buffer, written, bytesRead - written);
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
      copyStat = await out.stat();
    } catch {
      fail("SNAPSHOT_FAILED");
    }
    if (copyStat.size !== bytes) fail("SNAPSHOT_FAILED");

    let after;
    try {
      after = await handle.stat();
    } catch {
      fail("SOURCE_CHANGED");
    }
    if (!sameIdentity(opened, identityOf(after))) fail("SOURCE_CHANGED");
    if (bytes !== opened.size) fail("SOURCE_CHANGED");

    // 路径仍指向打开时的同一对象；realpath 也不能在复制期间换到别处。
    let now;
    try {
      now = await fs.lstat(sourceReal);
      const realAgain = await fs.realpath(sourcePath);
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
      cleanup: null,
    };
    snapshot.cleanup = async () => {
      if (snapshot.cleaned) return;
      await removeOwnedDir(base, dir, token);
      snapshot.cleaned = true;
    };
    return snapshot;
  } catch (error) {
    try {
      await out?.close();
    } catch {
      /* close 失败由目录清理兜底 */
    }
    out = null;
    let cleanupError = null;
    if (created) {
      try {
        if (markerWritten) await removeOwnedDir(base, dir, token);
        else await removeIncompleteDir(base, dir);
      } catch {
        cleanupError = true;
      }
    }
    if (cleanupError) throw new AudioSnapshotError("CLEANUP_FAILED");
    throw mapFsError(error);
  } finally {
    await out?.close().catch(() => {});
    await handle.close().catch(() => {});
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
