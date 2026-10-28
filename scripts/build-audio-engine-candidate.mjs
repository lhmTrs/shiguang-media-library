#!/usr/bin/env node
/**
 * 离线洁净音频引擎候选包工具（T-MUSIC-ENGINE-CANDIDATE 实施）。
 *
 * 只做两件事：
 *   build  —— 从一个显式钉住 SHA256/大小的普通文件，生成仅含 audio-analyze 的
 *             USTAR + gzip 候选、candidate.json、SHA256SUMS 和 COMPLETE。
 *   verify —— 独立重读归档/描述/校验和，单遍解析 gzip/tar，给出退出码结论。
 *
 * 安全边界：不联网、不执行任何输入字节、不安装、不读真实素材、不写 out-dir 之外；
 * 只引用 node: 内置模块与已有 tar-stream；无新依赖、无子进程、无监听。
 */
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import tar from "tar-stream";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

const MiB = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * MiB;
const MAX_ARCHIVE_BYTES = 130 * MiB;
const MAX_DESCRIPTION_BYTES = 4096;
const MAX_SUMS_BYTES = 1024;
const MAX_COMPLETE_BYTES = 1024;
const MAX_OUTPUT_JSON_BYTES = 4096;
// 512 header + 最大成员 + 最大 padding + 1024 结束块；超出的展开立即拒绝。
const MAX_EXPANDED_BYTES = 512 + MAX_INPUT_BYTES + 512 + 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const BUILD_DEADLINE_MS = 120_000;
const VERIFY_DEADLINE_MS = 60_000;
const CLEANUP_MS = 2000;
const MEMBER_NAME = "audio-analyze";
const DESCRIPTION_FILE = "candidate.json";
const SUMS_FILE = "SHA256SUMS";
const COMPLETE_FILE = "COMPLETE";
const COMPLETE_SCHEMA = "shiguang-audio-engine-candidate-complete/v1";
const DESCRIPTION_SCHEMA = "shiguang-audio-engine-candidate/v1";
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const HEX_PATTERN = /^[0-9a-f]{64}$/;
const BASENAME_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

const CODES = {
  USAGE: ["CANDIDATE_USAGE", 2],
  UNSUPPORTED_TARGET: ["CANDIDATE_UNSUPPORTED_TARGET", 2],
  INPUT_UNSAFE: ["CANDIDATE_INPUT_UNSAFE", 3],
  INPUT_PIN_MISMATCH: ["CANDIDATE_INPUT_PIN_MISMATCH", 3],
  INPUT_CHANGED: ["CANDIDATE_INPUT_CHANGED", 3],
  INPUT_TOO_LARGE: ["CANDIDATE_INPUT_TOO_LARGE", 3],
  OUTPUT_EXISTS: ["CANDIDATE_OUTPUT_EXISTS", 4],
  OUTPUT_UNSAFE: ["CANDIDATE_OUTPUT_UNSAFE", 4],
  ARCHIVE_TOO_LARGE: ["CANDIDATE_ARCHIVE_TOO_LARGE", 5],
  ARCHIVE_INVALID: ["CANDIDATE_ARCHIVE_INVALID", 5],
  ARCHIVE_MISMATCH: ["CANDIDATE_ARCHIVE_MISMATCH", 6],
  ARCHIVE_CHANGED: ["CANDIDATE_ARCHIVE_CHANGED", 6],
  DESCRIPTION_INVALID: ["CANDIDATE_DESCRIPTION_INVALID", 6],
  DESCRIPTION_MISMATCH: ["CANDIDATE_DESCRIPTION_MISMATCH", 6],
  COMPLETE_INVALID: ["CANDIDATE_COMPLETE_INVALID", 6],
  SUMS_INVALID: ["CANDIDATE_SUMS_INVALID", 6],
  WRITE_FAILED: ["CANDIDATE_WRITE_FAILED", 7],
  TIMEOUT: ["CANDIDATE_TIMEOUT", 8],
  CANCELLED: ["CANDIDATE_CANCELLED", 8],
  CLEANUP_UNKNOWN: ["CANDIDATE_CLEANUP_UNKNOWN", 9],
};

class Failure extends Error {
  constructor(key, stage) {
    const [code, exit] = CODES[key];
    super(code);
    this.code = code;
    this.exit = exit;
    this.stage = stage || "unknown";
  }
}

function fail(key, stage) {
  return new Failure(key, stage);
}

function mapError(error, key, stage) {
  if (error instanceof Failure) return error;
  return fail(key, stage);
}

const state = {
  abort: null,
  deadlineTimer: null,
  cleanupPromise: null,
  cleanupDeadline: null,
  cleanupStarted: false,
  cleanupFinished: false,
  streams: new Set(),
  handles: new Set(),
  closes: new Set(),
  tracks: new Set(),
  abortWaiters: new Set(),
  closeFailed: false,
  outDir: null,
  outIdentity: null,
};

function checkAbort(stage) {
  if (state.abort === "TIMEOUT") throw fail("TIMEOUT", stage);
  if (state.abort === "CANCELLED") throw fail("CANCELLED", stage);
}

/** 单一 abort 入口：deadline 与 SIGINT/SIGTERM 都经这里，先到先得。 */
function triggerAbort(kind) {
  if (state.abort) return;
  state.abort = kind;
  for (const resolve of state.abortWaiters) resolve();
  state.abortWaiters.clear();
}

function waitAbort() {
  if (state.abort) return Promise.resolve();
  return new Promise((resolve) => state.abortWaiters.add(resolve));
}

/**
 * 登记任意在途 I/O 的 settlement，供唯一 cleanup 时钟动态等待。
 * 返回原始 promise（保留 rejection），另挂一个吞掉 rejection 的 guard 防止
 * abort 先返回后迟到 rejection 变成未处理拒绝。
 */
function observe(promise) {
  const original = Promise.resolve(promise);
  const guarded = original.then(
    () => undefined,
    () => undefined,
  );
  state.tracks.add(guarded);
  guarded.then(() => state.tracks.delete(guarded));
  return original;
}

/**
 * 有界等待一个 read/write/stream 操作：work abort 先到就抛固定 8 错误，
 * 不让停滞的内核 I/O 永久卡住主流程；真正的 close/settle 由 cleanupOnce 判定。
 */
async function raceAbort(promise, stage) {
  const marker = Symbol("abort");
  const winner = await Promise.race([promise, waitAbort().then(() => marker)]);
  if (winner === marker) checkAbort(stage);
  return winner;
}

function startDeadline(ms) {
  // 不 unref：停滞的伪 I/O 没有 libuv 句柄时，deadline 必须是保持事件循环的锚点。
  state.deadlineTimer = setTimeout(() => {
    triggerAbort("TIMEOUT");
  }, ms);
}

function startCleanupClock() {
  if (state.cleanupDeadline === null) state.cleanupDeadline = Date.now() + CLEANUP_MS;
  state.cleanupStarted = true;
  return state.cleanupDeadline;
}

/**
 * 收尾阶段唯一绝对时钟：失败诊断/FAILED.json/inventory 与 close/settlement
 * 共用同一个 2 s deadline，不允许诊断在收尾前后再开一个 2 s 窗口。
 */
async function raceCleanup(promise, stage) {
  const remaining = state.cleanupDeadline === null ? CLEANUP_MS : state.cleanupDeadline - Date.now();
  if (remaining <= 0) throw fail("CLEANUP_UNKNOWN", stage);
  const marker = Symbol("cleanup");
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(marker), remaining);
  });
  try {
    const winner = await Promise.race([promise, expired]);
    if (winner === marker) throw fail("CLEANUP_UNKNOWN", stage);
    return winner;
  } finally {
    clearTimeout(timer);
  }
}

/** 登记后竞速：正常工作路径用 work abort，失败诊断路径用唯一 cleanup 时钟。 */
async function bounded(promise, stage, { cleanup = false } = {}) {
  const observed = observe(promise);
  return cleanup ? raceCleanup(observed, stage) : raceAbort(observed, stage);
}

/** 只给 pipeline 这类“稍后由 cleanup 结算”的流用；错误已由调用方按需读取。 */
function trackPromise(promise) {
  return observe(promise).catch(() => undefined);
}

async function openTracked(file, flags, mode, stage = "unknown", { cleanup = false } = {}) {
  const opening = observe(fs.open(file, flags, mode));
  // open 在 await 返回前就已登记；abort/cleanup 先到时，迟到的 handle 由这里补 close。
  opening.then(
    (handle) => {
      state.handles.add(handle);
      if ((state.abort && !cleanup) || state.cleanupFinished) closeTracked(handle);
    },
    () => undefined,
  );
  const handle = await (cleanup ? raceCleanup(opening, stage) : raceAbort(opening, stage));
  state.handles.add(handle);
  if ((state.abort && !cleanup) || state.cleanupFinished) {
    closeTracked(handle);
    if (!cleanup) checkAbort(stage);
    if (state.cleanupFinished) throw fail("CLEANUP_UNKNOWN", stage);
  }
  return handle;
}

/**
 * 只发起 close 并登记；不在这里无界 await。
 * 正常路径由 cleanupOnce 统一等待；close 永不 settle 时 2 s 后判 unknown，
 * 不把残余内核 I/O 伪造成 done。
 */
async function closeTracked(handle) {
  if (!state.handles.delete(handle)) return;
  let closing;
  try {
    closing = Promise.resolve(handle.close()).then(
      () => undefined,
      () => {
        state.closeFailed = true;
      },
    );
  } catch {
    state.closeFailed = true;
    return;
  }
  state.closes.add(closing);
  closing.finally(() => state.closes.delete(closing));
}

async function cleanupOnce() {
  if (state.cleanupPromise) return state.cleanupPromise;
  startCleanupClock();
  state.cleanupPromise = (async () => {
    // 不取一次快照：每一轮都可能出现迟到 open / 新 close，必须动态计账到同一 deadline。
    for (;;) {
      for (const stream of [...state.streams]) {
        try {
          stream.destroy();
        } catch {
          /* 继续关闭其余流 */
        }
      }
      for (const handle of [...state.handles]) closeTracked(handle);
      const pending = [...state.tracks, ...state.closes];
      if (pending.length === 0) {
        state.cleanupFinished = true;
        return state.closeFailed ? "unknown" : "done";
      }
      const remaining = state.cleanupDeadline - Date.now();
      if (remaining <= 0) {
        state.cleanupFinished = true;
        return "unknown";
      }
      let timer;
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), remaining);
      });
      let settled;
      try {
        settled = await Promise.race([
          Promise.allSettled(pending).then(() => true),
          expired,
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!settled) {
        state.cleanupFinished = true;
        return "unknown";
      }
    }
  })();
  return state.cleanupPromise;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}

function isPositiveSafeInt(value, max) {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

function isBasename(value) {
  return (
    typeof value === "string" &&
    value !== "." &&
    value !== ".." &&
    BASENAME_PATTERN.test(value)
  );
}

function fileNameFor(version, platform, arch) {
  return `audio-engine-${version}-${platform}-${arch}.candidate.tar.gz`;
}

function roundUp512(value) {
  return Math.ceil(value / 512) * 512;
}

/* ───────────────────────────── 参数 ───────────────────────────── */

function parseArgs(argv) {
  const mode = argv[0];
  if (mode !== "build" && mode !== "verify") throw fail("USAGE", "args");
  const options = new Map();
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") || token === "--") throw fail("USAGE", "args");
    const name = token.slice(2);
    if (!name || options.has(name)) throw fail("USAGE", "args");
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw fail("USAGE", "args");
    options.set(name, value);
    i += 1;
  }
  const allowed =
    mode === "build"
      ? new Set([
          "input",
          "input-sha256",
          "input-size",
          "version",
          "platform",
          "arch",
          "out-dir",
        ])
      : new Set([
          "archive",
          "description",
          "expect-archive-sha256",
          "expect-archive-size",
          "expect-description-sha256",
          "dir",
        ]);
  for (const name of options.keys()) {
    if (!allowed.has(name)) throw fail("USAGE", "args");
  }
  if (mode === "verify") {
    // 幽灵参数：verify 不接受版本/期望版本。
    if (options.has("version") || options.has("expect-version")) throw fail("USAGE", "args");
  }
  return { mode, options };
}

function requireOption(options, name) {
  const value = options.get(name);
  if (value === undefined || value === "") throw fail("USAGE", "args");
  return value;
}

function parseDecimal(value, key) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw fail(key, "args");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw fail(key, "args");
  return number;
}

function assertAbsolute(value, key = "USAGE") {
  if (!path.isAbsolute(value) || value.includes("\0")) throw fail(key, "args");
}

function assertOutDirSyntax(value) {
  assertAbsolute(value);
  if (value !== "/" && value.endsWith(path.sep)) throw fail("OUTPUT_UNSAFE", "output");
  const parts = value.split(path.sep).filter(Boolean);
  if (parts.includes("..")) throw fail("OUTPUT_UNSAFE", "output");
  if (parts.length === 0) throw fail("OUTPUT_UNSAFE", "output");
  if (!isBasename(parts[parts.length - 1])) throw fail("OUTPUT_UNSAFE", "output");
}

/* ───────────────────────────── 路径 ───────────────────────────── */

async function tmpAlias(stage = "output") {
  const tmp = os.tmpdir();
  let real = tmp;
  try {
    real = await bounded(fs.realpath(tmp), stage);
  } catch (error) {
    if (error instanceof Failure) throw error;
    /* 保留词法 tmp */
  }
  return { tmp, real };
}

async function canonicalize(value, stage = "output") {
  const { tmp, real } = await tmpAlias(stage);
  if (value === tmp || value.startsWith(tmp + path.sep)) {
    return real + value.slice(tmp.length);
  }
  return value;
}

/**
 * 从可信根 / 逐层 lstat 到 target（含 target），任何 symlink/非目录/查询失败都拒绝。
 * 返回 canonical 路径与每层 dev/ino。
 */
async function walkNoLink(target, stage = "output") {
  const canonical = await canonicalize(target, stage);
  const parts = canonical.split(path.sep).filter(Boolean);
  let current = path.sep;
  const chain = [];
  for (const part of parts) {
    current = path.join(current, part);
    let st;
    try {
      st = await bounded(fs.lstat(current), stage);
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw fail("OUTPUT_UNSAFE", stage);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw fail("OUTPUT_UNSAFE", stage);
    chain.push({ path: current, dev: st.dev, ino: st.ino });
  }
  return { canonical, chain };
}

async function recheckChain(expectedChain, stage = "output", { cleanup = false } = {}) {
  for (const item of expectedChain) {
    let st;
    try {
      st = await bounded(fs.lstat(item.path), stage, { cleanup });
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw fail("OUTPUT_UNSAFE", stage);
    }
    if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== item.dev || st.ino !== item.ino) {
      throw fail("OUTPUT_UNSAFE", stage);
    }
  }
}

async function prepareOutDir(requested) {
  assertOutDirSyntax(requested);
  const canonical = await canonicalize(requested, "output");
  const parent = path.dirname(canonical);
  const base = path.basename(canonical);
  if (!isBasename(base)) throw fail("OUTPUT_UNSAFE", "output");
  const parentWalk = await walkNoLink(parent, "output");
  await recheckChain(parentWalk.chain);
  const outPath = path.join(parentWalk.canonical, base);
  try {
    await bounded(fs.mkdir(outPath, { mode: 0o700 }), "output");
  } catch (error) {
    if (error instanceof Failure) throw error;
    if (error && error.code === "EEXIST") throw fail("OUTPUT_EXISTS", "output");
    throw fail("OUTPUT_UNSAFE", "output");
  }
  let st;
  try {
    st = await bounded(fs.lstat(outPath), "output");
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail("OUTPUT_UNSAFE", "output");
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw fail("OUTPUT_UNSAFE", "output");
  const identity = { outPath, dev: st.dev, ino: st.ino, parentChain: parentWalk.chain };
  await assertOutIdentity(identity);
  return identity;
}

async function assertOutIdentity(identity, stage = "output", { cleanup = false } = {}) {
  await recheckChain(identity.parentChain, stage, { cleanup });
  let st;
  try {
    st = await bounded(fs.lstat(identity.outPath), stage, { cleanup });
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail("OUTPUT_UNSAFE", stage);
  }
  if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino) {
    throw fail("OUTPUT_UNSAFE", stage);
  }
}

/* ───────────────────────────── 有界读取 ───────────────────────────── */

function identityOf(st) {
  return { dev: st.dev, ino: st.ino, size: st.size };
}

async function readSnapshot(file, limit, key, stage) {
  let before;
  try {
    before = await bounded(fs.lstat(file), stage);
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail(key, stage);
  }
  if (!before.isFile() || before.isSymbolicLink()) throw fail(key, stage);
  if (before.size > limit) throw fail(key, stage);
  let handle;
  try {
    handle = await openTracked(
      file,
      fssync.constants.O_RDONLY | fssync.constants.O_NOFOLLOW | fssync.constants.O_NONBLOCK,
      0o600,
      stage,
    );
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail(key, stage);
  }
  try {
    const opened = await bounded(handle.stat(), stage);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw fail(key, stage);
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      checkAbort(stage);
      const { bytesRead } = await bounded(
        handle.read(buffer, offset, buffer.length - offset, null),
        stage,
      );
      if (bytesRead === 0) throw fail(key, stage);
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: trailing } = await bounded(handle.read(extra, 0, 1, null), stage);
    if (trailing !== 0) throw fail(key, stage);
    const after = await bounded(handle.stat(), stage);
    let pathAfter;
    try {
      pathAfter = await bounded(fs.lstat(file), stage);
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw fail(key, stage);
    }
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size
    ) {
      throw fail(key, stage);
    }
    return {
      buffer,
      size: opened.size,
      sha256: sha256Hex(buffer),
      dev: opened.dev,
      ino: opened.ino,
    };
  } finally {
    await closeTracked(handle);
  }
}

/* ───────────────────────────── 描述/标记校验 ───────────────────────────── */

function checkSha(value) {
  return typeof value === "string" && HEX_PATTERN.test(value);
}

function checkVersion(value) {
  return (
    typeof value === "string" &&
    VERSION_PATTERN.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function parseDescription(buffer, { archiveBase = null } = {}) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  if (
    !exactKeys(value, [
      "schema",
      "candidate",
      "member",
      "declared",
      "format",
      "source",
      "verification",
    ]) ||
    value.schema !== DESCRIPTION_SCHEMA
  ) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  const { candidate, member, declared, format, source, verification } = value;
  if (
    !exactKeys(candidate, ["file", "bytes", "sha256"]) ||
    !isBasename(candidate.file) ||
    !isPositiveSafeInt(candidate.bytes, MAX_ARCHIVE_BYTES) ||
    !checkSha(candidate.sha256)
  ) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  if (
    !exactKeys(member, ["name", "bytes", "sha256", "mode", "uid", "gid", "mtime"]) ||
    member.name !== MEMBER_NAME ||
    !isPositiveSafeInt(member.bytes, MAX_INPUT_BYTES) ||
    !checkSha(member.sha256) ||
    member.mode !== "0755" ||
    member.uid !== 0 ||
    member.gid !== 0 ||
    member.mtime !== 0
  ) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  if (
    !exactKeys(declared, ["version", "platform", "arch"]) ||
    !checkVersion(declared.version) ||
    declared.platform !== "darwin" ||
    declared.arch !== "arm64"
  ) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  if (
    !exactKeys(format, ["container", "tar", "gzipLevel", "gzipMtime", "gzipFilename", "members"]) ||
    format.container !== "tar.gz" ||
    format.tar !== "ustar" ||
    format.gzipLevel !== 9 ||
    format.gzipMtime !== 0 ||
    format.gzipFilename !== false ||
    format.members !== 1
  ) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  if (
    !exactKeys(source, ["input", "pinned", "absolutePathRecorded"]) ||
    source.input !== "explicit-regular-file" ||
    source.pinned !== true ||
    source.absolutePathRecorded !== false
  ) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  if (
    !exactKeys(verification, ["binaryArchitecture", "executable", "signature"]) ||
    verification.binaryArchitecture !== "declared-only" ||
    verification.executable !== "not-run" ||
    verification.signature !== "not-verified"
  ) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  const expected = fileNameFor(declared.version, declared.platform, declared.arch);
  if (candidate.file !== expected) throw fail("DESCRIPTION_INVALID", "description");
  if (archiveBase !== null && archiveBase !== candidate.file) {
    throw fail("DESCRIPTION_INVALID", "description");
  }
  return value;
}

function parseComplete(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw fail("COMPLETE_INVALID", "complete");
  }
  if (
    !exactKeys(value, ["schema", "state", "contentVerified", "archive", "description", "sums"]) ||
    value.schema !== COMPLETE_SCHEMA ||
    value.state !== "produced" ||
    value.contentVerified !== false
  ) {
    throw fail("COMPLETE_INVALID", "complete");
  }
  for (const [name, expectedFile] of [
    ["archive", null],
    ["description", DESCRIPTION_FILE],
    ["sums", SUMS_FILE],
  ]) {
    const item = value[name];
    if (
      !exactKeys(item, ["file", "bytes", "sha256"]) ||
      !isBasename(item.file) ||
      !isPositiveSafeInt(item.bytes, MAX_ARCHIVE_BYTES) ||
      !checkSha(item.sha256)
    ) {
      throw fail("COMPLETE_INVALID", "complete");
    }
    if (expectedFile !== null && item.file !== expectedFile) {
      throw fail("COMPLETE_INVALID", "complete");
    }
  }
  return value;
}

function parseSums(buffer, candidateFile) {
  const text = buffer.toString("utf8");
  const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]{1,128})\n([0-9a-f]{64}) {2}candidate\.json\n$/.exec(
    text,
  );
  if (!match || match[2] !== candidateFile) throw fail("SUMS_INVALID", "sums");
  return { archiveSha256: match[1], archiveFile: match[2], descriptionSha256: match[3] };
}

/* ───────────────────────────── tar/gzip 单遍校验 ───────────────────────────── */

function parseOctalField(buffer, { allowEmpty = false } = {}) {
  const raw = buffer.toString("latin1");
  const nul = raw.indexOf("\0");
  const trimmed = (nul >= 0 ? raw.slice(0, nul) : raw).trim();
  if (trimmed === "") {
    if (allowEmpty) return 0;
    throw new Error("empty octal");
  }
  if (!/^[0-7]+$/.test(trimmed)) throw new Error("bad octal");
  const value = Number.parseInt(trimmed, 8);
  if (!Number.isSafeInteger(value)) throw new Error("octal overflow");
  return value;
}

function allZero(buffer) {
  for (let i = 0; i < buffer.length; i += 1) if (buffer[i] !== 0) return false;
  return true;
}

class TarChecker {
  constructor() {
    // 固定 header/padding/end 窗口；成员正文逐片消费，绝不累积整个 member。
    this.buffer = Buffer.alloc(0);
    this.header = Buffer.alloc(512);
    this.headerOffset = 0;
    this.state = "HEADER";
    this.error = null;
    this.memberName = null;
    this.memberBytes = 0;
    this.memberRemaining = 0;
    this.padRemaining = 0;
    this.endOffset = 0;
    this.memberSha256 = null;
    this.members = 0;
    this.total = 0;
    this.hash = crypto.createHash("sha256");
  }

  invalid() {
    if (!this.error) this.error = fail("ARCHIVE_INVALID", "archive");
  }

  push(chunk) {
    if (this.error || chunk.length === 0) return;
    let offset = 0;
    while (offset < chunk.length && !this.error) {
      if (this.state === "HEADER") {
        const take = Math.min(512 - this.headerOffset, chunk.length - offset);
        chunk.copy(this.header, this.headerOffset, offset, offset + take);
        this.headerOffset += take;
        this.total += take;
        offset += take;
        if (this.headerOffset === 512) {
          if (!this.acceptHeader(this.header)) {
            this.invalid();
            return;
          }
          this.state = "DATA";
          this.memberRemaining = this.memberBytes;
        }
      } else if (this.state === "DATA") {
        const take = Math.min(this.memberRemaining, chunk.length - offset);
        if (take > 0) {
          this.hash.update(chunk.subarray(offset, offset + take));
          this.memberRemaining -= take;
          this.total += take;
          offset += take;
        }
        if (this.memberRemaining === 0) {
          this.padRemaining = roundUp512(this.memberBytes) - this.memberBytes;
          this.state = "PAD";
        }
      } else if (this.state === "PAD") {
        const take = Math.min(this.padRemaining, chunk.length - offset);
        if (!allZero(chunk.subarray(offset, offset + take))) {
          this.invalid();
          return;
        }
        this.padRemaining -= take;
        this.total += take;
        offset += take;
        if (this.padRemaining === 0) this.state = "END";
      } else if (this.state === "END") {
        const take = Math.min(1024 - this.endOffset, chunk.length - offset);
        if (!allZero(chunk.subarray(offset, offset + take))) {
          this.invalid();
          return;
        }
        this.endOffset += take;
        this.total += take;
        offset += take;
        if (this.endOffset === 1024) this.state = "DONE";
      } else {
        // DONE 之后任何额外展开字节都拒绝（单成员、精确长度）。
        this.invalid();
        return;
      }
    }
  }

  acceptHeader(header) {
    if (this.members !== 0) return false;
    this.members = 1;
    const nameField = header.subarray(0, 100);
    const nul = nameField.indexOf(0);
    if (nul < 0) return false;
    const name = nameField.subarray(0, nul).toString("latin1");
    if (name !== MEMBER_NAME) return false;
    if (!allZero(nameField.subarray(nul))) return false;
    let mode;
    let uid;
    let gid;
    let size;
    let mtime;
    let checksum;
    try {
      mode = parseOctalField(header.subarray(100, 108));
      uid = parseOctalField(header.subarray(108, 116));
      gid = parseOctalField(header.subarray(116, 124));
      size = parseOctalField(header.subarray(124, 136));
      mtime = parseOctalField(header.subarray(136, 148));
      checksum = parseOctalField(header.subarray(148, 156));
    } catch {
      return false;
    }
    if (mode !== 0o755 || uid !== 0 || gid !== 0 || mtime !== 0) return false;
    if (!(size > 0 && size <= MAX_INPUT_BYTES)) return false;
    if (header[156] !== 0x30) return false;
    if (!allZero(header.subarray(157, 257))) return false;
    if (header.subarray(257, 263).toString("latin1") !== "ustar\0") return false;
    if (header.subarray(263, 265).toString("latin1") !== "00") return false;
    if (!allZero(header.subarray(265, 329))) return false;
    try {
      // devmajor/devminor 语义为 0；tar-stream 可能写零串或空。
      if (parseOctalField(header.subarray(329, 337), { allowEmpty: true }) !== 0) return false;
      if (parseOctalField(header.subarray(337, 345), { allowEmpty: true }) !== 0) return false;
    } catch {
      return false;
    }
    if (!allZero(header.subarray(345, 500))) return false;
    if (!allZero(header.subarray(500, 512))) return false;
    const copy = Buffer.from(header);
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of copy) sum += byte;
    if (sum !== checksum) return false;
    this.memberName = name;
    this.memberBytes = size;
    return true;
  }

  finish() {
    if (this.error) throw this.error;
    if (this.state !== "DONE" || this.buffer.length !== 0) throw fail("ARCHIVE_INVALID", "archive");
    if (this.members !== 1) throw fail("ARCHIVE_INVALID", "archive");
    const expectedLength = 512 + roundUp512(this.memberBytes) + 1024;
    if (this.total !== expectedLength) throw fail("ARCHIVE_INVALID", "archive");
    return {
      name: this.memberName,
      bytes: this.memberBytes,
      sha256: this.hash.digest("hex"),
    };
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc, buffer) {
  let value = crc >>> 0;
  for (let i = 0; i < buffer.length; i += 1) {
    value = CRC_TABLE[(value ^ buffer[i]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function parseGzipHeader(header) {
  if (header.length !== 10) throw fail("ARCHIVE_INVALID", "archive");
  if (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 0x08) {
    throw fail("ARCHIVE_INVALID", "archive");
  }
  if (header[3] !== 0) throw fail("ARCHIVE_INVALID", "archive");
  if (header.readUInt32LE(4) !== 0) throw fail("ARCHIVE_INVALID", "archive");
  // XFL/OS 自由字节，接受任意值（I01/I02a 用它们制造结构合法的摘要变异）。
}

/**
 * 单遍读取归档：归档 SHA、gzip 头/trailer、deflate、tar 都由同一串字节推进。
 * 不整文件缓存，不做第二遍解析。
 */
async function verifyArchiveFile(archivePath, description) {
  let before;
  try {
    before = await bounded(fs.lstat(archivePath), "archive");
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail("ARCHIVE_INVALID", "archive");
  }
  if (!before.isFile() || before.isSymbolicLink()) throw fail("ARCHIVE_INVALID", "archive");
  if (before.size > MAX_ARCHIVE_BYTES) throw fail("ARCHIVE_TOO_LARGE", "archive");
  let handle;
  try {
    handle = await openTracked(
      archivePath,
      fssync.constants.O_RDONLY | fssync.constants.O_NOFOLLOW | fssync.constants.O_NONBLOCK,
      0o600,
      "archive",
    );
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail("ARCHIVE_INVALID", "archive");
  }
  try {
    const opened = await bounded(handle.stat(), "archive");
    if (!opened.isFile()) throw fail("ARCHIVE_INVALID", "archive");
    if (opened.size > MAX_ARCHIVE_BYTES) throw fail("ARCHIVE_TOO_LARGE", "archive");
    if (opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw fail("ARCHIVE_CHANGED", "archive");
    }
    const initialSize = opened.size;
    const archiveHash = crypto.createHash("sha256");
    const inflate = zlib.createInflateRaw();
    state.streams.add(inflate);
    const tarChecker = new TarChecker();
    let inflateEnded = false;
    let inflateError = null;
    let inflatedBytes = 0;
    let crc = 0xffffffff;
    const stopInflate = () => {
      try {
        inflate.destroy();
      } catch {
        /* 结构错误已经确定；cleanup 仍会再次 destroy */
      }
    };
    inflate.on("data", (chunk) => {
      if (tarChecker.error) {
        stopInflate();
        return;
      }
      inflatedBytes += chunk.length;
      if (inflatedBytes > MAX_EXPANDED_BYTES) {
        tarChecker.invalid();
        stopInflate();
        return;
      }
      crc = crc32Update(crc, chunk);
      tarChecker.push(chunk);
      // 解析器一旦判定结构/长度越界，立即停止 inflate，不继续解码炸弹。
      if (tarChecker.error) stopInflate();
    });
    const inflateDone = new Promise((resolve) => {
      inflate.once("end", () => {
        inflateEnded = true;
        resolve();
      });
      inflate.once("error", (error) => {
        inflateError = error;
        resolve();
      });
      // 结构错误后主动 destroy 不会发 end/error；close 也必须让收尾继续，
      // 否则“立即停止 inflate”会退化成等 work deadline。
      inflate.once("close", () => {
        resolve();
      });
    });
    let header = Buffer.alloc(0);
    let pending = Buffer.alloc(0);
    let fed = 0;
    let total = 0;
    let headerDone = false;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    while (true) {
      checkAbort("archive");
      const { bytesRead } = await bounded(
        handle.read(chunk, 0, READ_CHUNK_BYTES, null),
        "archive",
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > initialSize) throw fail("ARCHIVE_CHANGED", "archive");
      const read = chunk.subarray(0, bytesRead);
      archiveHash.update(read);
      let rest = read;
      if (!headerDone) {
        const need = 10 - header.length;
        const take = rest.subarray(0, Math.min(need, rest.length));
        header = header.length ? Buffer.concat([header, take]) : Buffer.from(take);
        rest = rest.subarray(take.length);
        if (header.length < 10) continue;
        parseGzipHeader(header);
        headerDone = true;
      }
      const combined = pending.length ? Buffer.concat([pending, rest]) : rest;
      if (combined.length > 8) {
        const feed = combined.subarray(0, combined.length - 8);
        pending = Buffer.from(combined.subarray(combined.length - 8));
        if (inflateEnded || tarChecker.error) throw fail("ARCHIVE_INVALID", "archive");
        if (!inflate.write(feed)) {
          await bounded(
            Promise.race([once(inflate, "drain"), inflateDone]),
            "archive",
          );
        }
        if (tarChecker.error) throw tarChecker.error;
        fed += feed.length;
      } else {
        pending = Buffer.from(combined);
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (total !== initialSize) throw fail("ARCHIVE_CHANGED", "archive");
    if (!headerDone) throw fail("ARCHIVE_INVALID", "archive");
    if (tarChecker.error) throw tarChecker.error;
    if (pending.length !== 8) throw fail("ARCHIVE_INVALID", "archive");
    if (inflate.writableEnded === false) inflate.end();
    trackPromise(inflateDone);
    await raceAbort(inflateDone, "archive");
    if (inflateError) throw fail("ARCHIVE_INVALID", "archive");
    if (inflate.bytesWritten !== fed) throw fail("ARCHIVE_INVALID", "archive");
    const member = tarChecker.finish();
    const trailer = pending;
    const storedCrc = trailer.readUInt32LE(0) >>> 0;
    const storedSize = trailer.readUInt32LE(4) >>> 0;
    if (storedCrc !== ((crc ^ 0xffffffff) >>> 0)) throw fail("ARCHIVE_INVALID", "archive");
    if (storedSize !== (inflatedBytes >>> 0)) throw fail("ARCHIVE_INVALID", "archive");
    const after = await bounded(handle.stat(), "archive");
    let pathAfter;
    try {
      pathAfter = await bounded(fs.lstat(archivePath), "archive");
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw fail("ARCHIVE_CHANGED", "archive");
    }
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== before.size
    ) {
      throw fail("ARCHIVE_CHANGED", "archive");
    }
    // 归档 SHA 与解析来自同一循环；成员摘要/大小只在这里产出一份真实值。
    return {
      archiveSha256: archiveHash.digest("hex"),
      archiveSize: total,
      member,
    };
  } catch (error) {
    throw mapError(error, "ARCHIVE_INVALID", "archive");
  } finally {
    await closeTracked(handle);
  }
}

/* ───────────────────────────── build ───────────────────────────── */

class ArchiveSink extends Writable {
  constructor(file) {
    super({ highWaterMark: 256 * 1024 });
    this.file = file;
    this.fd = null;
    this.hash = crypto.createHash("sha256");
    this.bytes = 0;
  }

  _construct(callback) {
    try {
      fssync.open(
        this.file,
        fssync.constants.O_WRONLY |
          fssync.constants.O_CREAT |
          fssync.constants.O_EXCL |
          fssync.constants.O_NOFOLLOW,
        0o600,
        (error, fd) => {
          if (error) {
            callback(error && error.code === "EEXIST" ? fail("OUTPUT_EXISTS", "output") : fail("WRITE_FAILED", "write"));
            return;
          }
          this.fd = fd;
          callback();
        },
      );
    } catch {
      callback(fail("WRITE_FAILED", "write"));
    }
  }

  _write(chunk, _encoding, callback) {
    if (this.bytes + chunk.length > MAX_ARCHIVE_BYTES) {
      callback(fail("ARCHIVE_TOO_LARGE", "archive"));
      return;
    }
    let offset = 0;
    const writeFrom = () => {
      try {
        fssync.write(
          this.fd,
          chunk,
          offset,
          chunk.length - offset,
          null,
          (error, written) => {
            if (error || !(written > 0)) {
              callback(fail("WRITE_FAILED", "write"));
              return;
            }
            offset += written;
            if (offset < chunk.length) {
              writeFrom();
              return;
            }
            this.hash.update(chunk);
            this.bytes += chunk.length;
            callback();
          },
        );
      } catch {
        callback(fail("WRITE_FAILED", "write"));
      }
    };
    writeFrom();
  }

  _final(callback) {
    try {
      fssync.fsync(this.fd, (error) => {
        if (error) {
          callback(fail("WRITE_FAILED", "write"));
          return;
        }
        fssync.close(this.fd, (closeError) => {
          this.fd = null;
          callback(closeError ? fail("WRITE_FAILED", "write") : undefined);
        });
      });
    } catch {
      callback(fail("WRITE_FAILED", "write"));
    }
  }

  _destroy(error, callback) {
    if (this.fd === null) {
      callback(error);
      return;
    }
    const fd = this.fd;
    this.fd = null;
    try {
      fssync.close(fd, () => callback(error));
    } catch {
      callback(error);
    }
  }
}

async function writeExclusive(identity, name, buffer) {
  await assertOutIdentity(identity);
  const target = path.join(identity.outPath, name);
  let handle;
  try {
    handle = await openTracked(
      target,
      fssync.constants.O_WRONLY |
        fssync.constants.O_CREAT |
        fssync.constants.O_EXCL |
        fssync.constants.O_NOFOLLOW,
      0o600,
      "write",
    );
  } catch (error) {
    if (error instanceof Failure) throw error;
    if (error && error.code === "EEXIST") throw fail("OUTPUT_EXISTS", "output");
    throw fail("WRITE_FAILED", "write");
  }
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await bounded(
        handle.write(buffer, offset, buffer.length - offset),
        "write",
      );
      if (!(bytesWritten > 0)) throw fail("WRITE_FAILED", "write");
      offset += bytesWritten;
    }
    await bounded(handle.sync(), "write");
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw mapError(error, "WRITE_FAILED", "write");
  } finally {
    await closeTracked(handle);
  }
}

async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await openTracked(directory, fssync.constants.O_RDONLY, 0o600, "write");
    await bounded(handle.sync(), "write");
    return "ok";
  } catch (error) {
    if (state.abort) checkAbort("write");
    return "failed";
  } finally {
    if (handle) await closeTracked(handle);
  }
}

async function doBuild(options) {
  const input = requireOption(options, "input");
  assertAbsolute(input);
  const inputSha = requireOption(options, "input-sha256");
  if (!HEX_PATTERN.test(inputSha)) throw fail("USAGE", "args");
  const inputSize = parseDecimal(requireOption(options, "input-size"), "USAGE");
  const version = requireOption(options, "version");
  if (!checkVersion(version)) throw fail("USAGE", "args");
  const platform = requireOption(options, "platform");
  const arch = requireOption(options, "arch");
  if (platform !== "darwin" || arch !== "arm64") throw fail("UNSUPPORTED_TARGET", "args");
  const requestedOut = requireOption(options, "out-dir");

  if (inputSize <= 0) throw fail("USAGE", "args");

  const identity = await prepareOutDir(requestedOut);
  state.outDir = identity.outPath;
  state.outIdentity = identity;

  let inputBefore;
  try {
    inputBefore = await bounded(fs.lstat(input), "input");
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail("INPUT_UNSAFE", "input");
  }
  if (!inputBefore.isFile() || inputBefore.isSymbolicLink()) throw fail("INPUT_UNSAFE", "input");
  if (inputBefore.size > MAX_INPUT_BYTES) throw fail("INPUT_TOO_LARGE", "input");
  if (inputBefore.size === 0) throw fail("INPUT_UNSAFE", "input");
  if (inputBefore.size !== inputSize) throw fail("INPUT_PIN_MISMATCH", "input");

  let inputHandle;
  try {
    inputHandle = await openTracked(
      input,
      fssync.constants.O_RDONLY | fssync.constants.O_NOFOLLOW | fssync.constants.O_NONBLOCK,
      0o600,
      "input",
    );
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail("INPUT_UNSAFE", "input");
  }

  let archiveName;
  let archiveSha;
  let archiveBytes;
  const inputHash = crypto.createHash("sha256");
  try {
    const opened = await bounded(inputHandle.stat(), "input");
    if (
      !opened.isFile() ||
      opened.dev !== inputBefore.dev ||
      opened.ino !== inputBefore.ino ||
      opened.size !== inputBefore.size
    ) {
      throw fail("INPUT_CHANGED", "input");
    }
    const pathAgain = await bounded(fs.lstat(input), "input");
    if (
      pathAgain.dev !== opened.dev ||
      pathAgain.ino !== opened.ino ||
      pathAgain.size !== opened.size
    ) {
      throw fail("INPUT_CHANGED", "input");
    }

    archiveName = fileNameFor(version, platform, arch);
    const archivePath = path.join(identity.outPath, archiveName);
    await assertOutIdentity(identity);
    const sink = new ArchiveSink(archivePath);
    const pack = tar.pack();
    const gzip = zlib.createGzip({ level: 9 });
    state.streams.add(pack);
    state.streams.add(gzip);
    state.streams.add(sink);
    const completed = pipeline(pack, gzip, sink);
    // 从创建起就吞掉迟到 rejection：超时 destroy 时不能让 Node 以未处理拒绝退出。
    trackPromise(completed);
    const entry = pack.entry({
      name: MEMBER_NAME,
      type: "file",
      size: inputSize,
      mode: 0o755,
      uid: 0,
      gid: 0,
      uname: "",
      gname: "",
      mtime: new Date(0),
    });
    const readBuffer = Buffer.alloc(READ_CHUNK_BYTES);
    let consumed = 0;
    while (consumed < inputSize) {
      checkAbort("input");
      const want = Math.min(READ_CHUNK_BYTES, inputSize - consumed);
      const { bytesRead } = await bounded(
        inputHandle.read(readBuffer, 0, want, null),
        "input",
      );
      if (bytesRead === 0) throw fail("INPUT_CHANGED", "input");
      const chunk = readBuffer.subarray(0, bytesRead);
      consumed += bytesRead;
      inputHash.update(chunk);
      if (!entry.write(chunk)) await bounded(once(entry, "drain"), "input");
    }
    const extra = Buffer.alloc(1);
    const { bytesRead: trailing } = await bounded(
      inputHandle.read(extra, 0, 1, null),
      "input",
    );
    if (trailing !== 0) throw fail("INPUT_CHANGED", "input");
    entry.end();
    pack.finalize();
    try {
      await raceAbort(completed, "write");
    } catch (error) {
      throw mapError(error, "WRITE_FAILED", "write");
    }
    archiveSha = sink.hash.digest("hex");
    archiveBytes = sink.bytes;
    if (archiveBytes > MAX_ARCHIVE_BYTES) throw fail("ARCHIVE_TOO_LARGE", "archive");

    const after = await bounded(inputHandle.stat(), "input");
    const pathAfter = await bounded(fs.lstat(input), "input");
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino ||
      pathAfter.size !== opened.size ||
      consumed !== inputSize
    ) {
      throw fail("INPUT_CHANGED", "input");
    }
    const actualInputSha = inputHash.digest("hex");
    if (consumed !== inputSize || actualInputSha !== inputSha) {
      throw fail("INPUT_PIN_MISMATCH", "input");
    }

    const description = {
      schema: DESCRIPTION_SCHEMA,
      candidate: { file: archiveName, bytes: archiveBytes, sha256: archiveSha },
      member: {
        name: MEMBER_NAME,
        bytes: inputSize,
        sha256: actualInputSha,
        mode: "0755",
        uid: 0,
        gid: 0,
        mtime: 0,
      },
      declared: { version, platform, arch },
      format: {
        container: "tar.gz",
        tar: "ustar",
        gzipLevel: 9,
        gzipMtime: 0,
        gzipFilename: false,
        members: 1,
      },
      source: { input: "explicit-regular-file", pinned: true, absolutePathRecorded: false },
      verification: {
        binaryArchitecture: "declared-only",
        executable: "not-run",
        signature: "not-verified",
      },
    };
    const descriptionBuffer = Buffer.from(JSON.stringify(description), "utf8");
    if (descriptionBuffer.length > MAX_DESCRIPTION_BYTES) throw fail("WRITE_FAILED", "write");
    const descriptionSha = sha256Hex(descriptionBuffer);
    await writeExclusive(identity, DESCRIPTION_FILE, descriptionBuffer);

    const sumsBuffer = Buffer.from(
      `${archiveSha}  ${archiveName}\n${descriptionSha}  ${DESCRIPTION_FILE}\n`,
      "utf8",
    );
    if (sumsBuffer.length > MAX_SUMS_BYTES) throw fail("WRITE_FAILED", "write");
    const sumsSha = sha256Hex(sumsBuffer);
    await writeExclusive(identity, SUMS_FILE, sumsBuffer);

    // 写 COMPLETE 前只重读描述与 sums；归档不重读，其大小/摘要就是写入循环账本。
    const descriptionAgain = await readSnapshot(
      path.join(identity.outPath, DESCRIPTION_FILE),
      MAX_DESCRIPTION_BYTES,
      "WRITE_FAILED",
      "recheck",
    );
    if (descriptionAgain.sha256 !== descriptionSha || descriptionAgain.size !== descriptionBuffer.length) {
      throw fail("WRITE_FAILED", "recheck");
    }
    const sumsAgain = await readSnapshot(
      path.join(identity.outPath, SUMS_FILE),
      MAX_SUMS_BYTES,
      "WRITE_FAILED",
      "recheck",
    );
    if (sumsAgain.sha256 !== sumsSha || sumsAgain.size !== sumsBuffer.length) {
      throw fail("WRITE_FAILED", "recheck");
    }
    parseDescription(descriptionAgain.buffer, { archiveBase: archiveName });
    let sumsParsed;
    try {
      sumsParsed = parseSums(sumsAgain.buffer, archiveName);
    } catch {
      throw fail("WRITE_FAILED", "recheck");
    }
    if (
      sumsParsed.archiveSha256 !== archiveSha ||
      sumsParsed.descriptionSha256 !== descriptionSha
    ) {
      throw fail("WRITE_FAILED", "recheck");
    }

    const complete = {
      schema: COMPLETE_SCHEMA,
      state: "produced",
      contentVerified: false,
      archive: { file: archiveName, bytes: archiveBytes, sha256: archiveSha },
      description: {
        file: DESCRIPTION_FILE,
        bytes: descriptionBuffer.length,
        sha256: descriptionSha,
      },
      sums: { file: SUMS_FILE, bytes: sumsBuffer.length, sha256: sumsSha },
    };
    const completeBuffer = Buffer.from(JSON.stringify(complete), "utf8");
    if (completeBuffer.length > MAX_COMPLETE_BYTES) throw fail("WRITE_FAILED", "write");
    const completeSha = sha256Hex(completeBuffer);
    await writeExclusive(identity, COMPLETE_FILE, completeBuffer);

    const completeAgain = await readSnapshot(
      path.join(identity.outPath, COMPLETE_FILE),
      MAX_COMPLETE_BYTES,
      "WRITE_FAILED",
      "recheck",
    );
    if (completeAgain.sha256 !== completeSha || completeAgain.size !== completeBuffer.length) {
      throw fail("WRITE_FAILED", "recheck");
    }
    const parsedComplete = parseComplete(completeAgain.buffer);
    if (
      parsedComplete.archive.file !== archiveName ||
      parsedComplete.archive.bytes !== archiveBytes ||
      parsedComplete.archive.sha256 !== archiveSha ||
      parsedComplete.description.sha256 !== descriptionSha ||
      parsedComplete.sums.sha256 !== sumsSha
    ) {
      throw fail("WRITE_FAILED", "recheck");
    }

    await assertOutIdentity(identity);
    const dirFsync = await fsyncDirectory(identity.outPath);

    return {
      ok: true,
      mode: "build",
      archive: { file: archiveName, bytes: archiveBytes, sha256: archiveSha },
      description: {
        file: DESCRIPTION_FILE,
        bytes: descriptionBuffer.length,
        sha256: descriptionSha,
      },
      member: { name: MEMBER_NAME, bytes: inputSize, sha256: actualInputSha },
      binding: { archiveHashAndParse: "write-ledger", description: "bounded-one-snapshot" },
      complete: {
        file: COMPLETE_FILE,
        bytes: completeBuffer.length,
        sha256: completeSha,
        state: "produced",
        contentComplete: false,
        contentVerifiedBy: null,
        durable: "not-claimed",
      },
      externalArchivePin: false,
      externalDescriptionPin: false,
      dirFsync,
      notVerified: [
        "binary-architecture",
        "executable",
        "signature",
        "install",
        "crash-durability",
      ],
    };
  } finally {
    await closeTracked(inputHandle);
  }
}

/* ───────────────────────────── verify ───────────────────────────── */

function crossCheckArchive(result, description, expectSha, expectSize) {
  if (expectSha !== null && result.archiveSha256 !== expectSha) {
    throw fail("ARCHIVE_MISMATCH", "verify");
  }
  if (expectSize !== null && result.archiveSize !== expectSize) {
    throw fail("ARCHIVE_MISMATCH", "verify");
  }
  if (
    description.candidate.sha256 !== result.archiveSha256 ||
    description.candidate.bytes !== result.archiveSize
  ) {
    throw fail("ARCHIVE_MISMATCH", "verify");
  }
  if (
    description.member.name !== result.member.name ||
    description.member.sha256 !== result.member.sha256 ||
    description.member.bytes !== result.member.bytes
  ) {
    throw fail("ARCHIVE_MISMATCH", "verify");
  }
}

async function doVerify(options) {
  const hasDir = options.has("dir");
  const hasArchive = options.has("archive") || options.has("description");
  if (hasDir === hasArchive) throw fail("USAGE", "args");

  const expectDescriptionSha = options.get("expect-description-sha256") ?? null;
  if (expectDescriptionSha !== null && !HEX_PATTERN.test(expectDescriptionSha)) {
    throw fail("USAGE", "args");
  }

  if (hasDir) {
    const dir = requireOption(options, "dir");
    assertAbsolute(dir);
    const expectSha = options.get("expect-archive-sha256") ?? null;
    const expectSizeRaw = options.get("expect-archive-size") ?? null;
    if (expectSha !== null && !HEX_PATTERN.test(expectSha)) throw fail("USAGE", "args");
    const expectSize = expectSizeRaw === null ? null : parseDecimal(expectSizeRaw, "USAGE");
    return verifyDirectory(dir, expectSha, expectSize, expectDescriptionSha);
  }

  const archivePath = requireOption(options, "archive");
  const descriptionPath = requireOption(options, "description");
  assertAbsolute(archivePath);
  assertAbsolute(descriptionPath);
  const expectSha = requireOption(options, "expect-archive-sha256");
  if (!HEX_PATTERN.test(expectSha)) throw fail("USAGE", "args");
  const expectSize = parseDecimal(requireOption(options, "expect-archive-size"), "USAGE");

  const descriptionSnapshot = await readSnapshot(
    descriptionPath,
    MAX_DESCRIPTION_BYTES,
    "DESCRIPTION_INVALID",
    "description",
  );
  if (expectDescriptionSha !== null && descriptionSnapshot.sha256 !== expectDescriptionSha) {
    throw fail("DESCRIPTION_MISMATCH", "description");
  }
  const description = parseDescription(descriptionSnapshot.buffer, {
    archiveBase: path.basename(archivePath),
  });
  const result = await verifyArchiveFile(archivePath, description);
  crossCheckArchive(result, description, expectSha, expectSize);
  return {
    ok: true,
    mode: "verify-archive",
    archive: { file: description.candidate.file, bytes: result.archiveSize, sha256: result.archiveSha256 },
    description: {
      file: DESCRIPTION_FILE,
      bytes: descriptionSnapshot.size,
      sha256: descriptionSnapshot.sha256,
    },
    member: {
      name: result.member.name,
      bytes: result.member.bytes,
      sha256: result.member.sha256,
    },
    declared: description.declared,
    binding: { archiveHashAndParse: "single-pass", description: "bounded-one-snapshot" },
    checks: {
      gzipSingleMember: true,
      tarSingleUstarMember: true,
      archiveSha256: true,
      memberSha256: true,
      exactLengths: true,
    },
    complete: { checked: false },
    externalArchivePin: true,
    externalDescriptionPin: expectDescriptionSha !== null,
    notVerified: ["binary-architecture", "executable", "signature", "install"],
  };
}

async function verifyDirectory(dir, expectSha, expectSize, expectDescriptionSha) {
  const walk = await walkNoLink(dir, "verify");
  const base = walk.canonical;
  let dirStat;
  try {
    dirStat = await bounded(fs.lstat(base), "verify");
  } catch (error) {
    if (error instanceof Failure) throw error;
    throw fail("OUTPUT_UNSAFE", "verify");
  }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw fail("OUTPUT_UNSAFE", "verify");

  const completePath = path.join(base, COMPLETE_FILE);
  const completeSnapshot = await readSnapshot(
    completePath,
    MAX_COMPLETE_BYTES,
    "COMPLETE_INVALID",
    "complete",
  );
  const complete = parseComplete(completeSnapshot.buffer);

  const descriptionSnapshot = await readSnapshot(
    path.join(base, DESCRIPTION_FILE),
    MAX_DESCRIPTION_BYTES,
    "DESCRIPTION_INVALID",
    "description",
  );
  if (expectDescriptionSha !== null && descriptionSnapshot.sha256 !== expectDescriptionSha) {
    throw fail("DESCRIPTION_MISMATCH", "description");
  }
  const description = parseDescription(descriptionSnapshot.buffer);

  if (
    complete.archive.file !== description.candidate.file ||
    complete.description.file !== DESCRIPTION_FILE ||
    complete.sums.file !== SUMS_FILE
  ) {
    throw fail("COMPLETE_INVALID", "complete");
  }

  const sumsSnapshot = await readSnapshot(
    path.join(base, SUMS_FILE),
    MAX_SUMS_BYTES,
    "SUMS_INVALID",
    "sums",
  );
  const sums = parseSums(sumsSnapshot.buffer, description.candidate.file);
  if (sums.descriptionSha256 !== descriptionSnapshot.sha256) {
    throw fail("SUMS_INVALID", "sums");
  }

  const archivePath = path.join(base, description.candidate.file);
  const result = await verifyArchiveFile(archivePath, description);
  crossCheckArchive(result, description, expectSha, expectSize);
  if (sums.archiveSha256 !== result.archiveSha256) throw fail("ARCHIVE_MISMATCH", "verify");

  if (
    complete.archive.bytes !== result.archiveSize ||
    complete.archive.sha256 !== result.archiveSha256 ||
    complete.description.bytes !== descriptionSnapshot.size ||
    complete.description.sha256 !== descriptionSnapshot.sha256 ||
    complete.sums.bytes !== sumsSnapshot.size ||
    complete.sums.sha256 !== sumsSnapshot.sha256
  ) {
    throw fail("COMPLETE_INVALID", "complete");
  }

  const afterWalk = await walkNoLink(base, "verify");
  if (
    afterWalk.chain.length !== walk.chain.length ||
    afterWalk.chain.some((item, index) => {
      const old = walk.chain[index];
      return item.dev !== old.dev || item.ino !== old.ino;
    })
  ) {
    throw fail("OUTPUT_UNSAFE", "verify");
  }

  return {
    ok: true,
    mode: "verify-dir",
    archive: { file: description.candidate.file, bytes: result.archiveSize, sha256: result.archiveSha256 },
    description: {
      file: DESCRIPTION_FILE,
      bytes: descriptionSnapshot.size,
      sha256: descriptionSnapshot.sha256,
    },
    member: {
      name: result.member.name,
      bytes: result.member.bytes,
      sha256: result.member.sha256,
    },
    declared: description.declared,
    binding: { archiveHashAndParse: "single-pass", description: "bounded-one-snapshot" },
    checks: {
      gzipSingleMember: true,
      tarSingleUstarMember: true,
      archiveSha256: true,
      memberSha256: true,
      exactLengths: true,
    },
    complete: {
      file: COMPLETE_FILE,
      bytes: completeSnapshot.size,
      sha256: completeSnapshot.sha256,
      state: "produced",
      contentComplete: true,
      contentVerifiedBy: "verify-dir",
      durable: "not-claimed",
    },
    dirFsync: "not-attempted",
    externalArchivePin: expectSha !== null && expectSize !== null,
    externalDescriptionPin: expectDescriptionSha !== null,
    notVerified: ["binary-architecture", "executable", "signature", "install"],
  };
}

/* ───────────────────────────── 输出与收尾 ───────────────────────────── */

/**
 * 尽力写 FAILED.json（只写本次自己创建的 out-dir；绝不覆盖已有 COMPLETE/外来文件）。
 * 所有观测/写入都使用开始收尾时的唯一 2 s 时钟；任何一步无法确认就保留现场，
 * 不把失败观测伪造成空 inventory，也不在收尾后再开无界等待。
 */
async function writeFailedMarker(failure, initialInventory) {
  const identity = state.outIdentity;
  let inventory = initialInventory || {
    items: [],
    truncated: false,
    unknown: true,
    reason: "not-observed",
  };
  if (!identity) return { created: false, inventory };
  try {
    await assertOutIdentity(identity, "diagnostic", { cleanup: true });
    const completePath = path.join(identity.outPath, COMPLETE_FILE);
    let existing = null;
    try {
      existing = await bounded(fs.lstat(completePath), "diagnostic", { cleanup: true });
    } catch (error) {
      if (error instanceof Failure) throw error;
      if (error && error.code !== "ENOENT") throw error;
    }
    if (existing) return { created: false, inventory };
    const body = Buffer.from(
      JSON.stringify({
        ok: false,
        code: failure.code,
        stage: failure.stage,
        complete: false,
        inventory: inventory.items,
        ...(inventory.truncated ? { inventoryTruncated: true } : {}),
        ...(inventory.unknown ? { inventoryUnknown: true } : {}),
      }),
      "utf8",
    );
    if (body.length > MAX_DESCRIPTION_BYTES) return { created: false, inventory };
    const handle = await openTracked(
      path.join(identity.outPath, "FAILED.json"),
      fssync.constants.O_WRONLY |
        fssync.constants.O_CREAT |
        fssync.constants.O_EXCL |
        fssync.constants.O_NOFOLLOW,
      0o600,
      "diagnostic",
      { cleanup: true },
    );
    try {
      await bounded(handle.writeFile(body), "diagnostic", { cleanup: true });
      await bounded(handle.sync(), "diagnostic", { cleanup: true });
    } finally {
      await closeTracked(handle);
    }
  } catch {
    /* 诊断写失败不改变主错误码；现场保留，不递归清理 */
    return { created: false, inventory };
  }
  // FAILED.json 是本次 O_EXCL 创建并已结算的事实，无需再 readdir 证明；并入 inventory。
  const items = [...inventory.items];
  if (!items.includes("FAILED.json")) items.push("FAILED.json");
  items.sort();
  const truncated = inventory.truncated || items.length > 16;
  return {
    created: true,
    inventory: { ...inventory, items: items.slice(0, 16), truncated },
  };
}

async function inventoryOf(directory, stage = "diagnostic", { cleanup = true } = {}) {
  if (!directory) {
    return { items: [], truncated: false, unknown: true, reason: "no-directory" };
  }
  let entries;
  try {
    entries = await bounded(fs.readdir(directory, { withFileTypes: true }), stage, { cleanup });
  } catch (error) {
    if (error instanceof Failure && error.code === "CANDIDATE_CLEANUP_UNKNOWN") throw error;
    if (error instanceof Failure) throw error;
    if (error && error.code === "ENOENT") {
      // 只把 ENOENT 当作“确定不存在”；其它观测失败一律 unknown。
      return { items: [], truncated: false, unknown: false };
    }
    return {
      items: [],
      truncated: false,
      unknown: true,
      reason: (error && error.code) || "unknown",
    };
  }
  let items = entries
    .map((entry) => entry.name)
    .filter((name) => typeof name === "string" && name.length <= 128)
    .sort();
  const truncated = items.length > 16;
  items = items.slice(0, 16);
  return { items, truncated, unknown: false };
}

function emit(value, stream = 1) {
  let line = JSON.stringify(value);
  if (Buffer.byteLength(line) > MAX_OUTPUT_JSON_BYTES) {
    const short = { ...value };
    if (Array.isArray(short.inventory)) short.inventory = short.inventory.slice(0, 4);
    short.inventoryTruncated = true;
    line = JSON.stringify(short);
  }
  if (Buffer.byteLength(line) > MAX_OUTPUT_JSON_BYTES) {
    line = JSON.stringify({ ok: false, code: value.code || "CANDIDATE_USAGE", stage: value.stage || "output" });
  }
  fssync.writeSync(stream, `${line}\n`);
}

async function main() {
  const rawMode = process.argv[2];
  let mode =
    rawMode === "build"
      ? "build"
      : process.argv.includes("--dir")
        ? "verify-dir"
        : "verify-archive";
  let parsed = null;
  let cleanup = "done";
  try {
    parsed = parseArgs(process.argv.slice(2));
    mode =
      parsed.mode === "build"
        ? "build"
        : parsed.options.has("dir")
          ? "verify-dir"
          : "verify-archive";
    if (mode === "build") startDeadline(BUILD_DEADLINE_MS);
    else startDeadline(VERIFY_DEADLINE_MS);
    const result =
      mode === "build" ? await doBuild(parsed.options) : await doVerify(parsed.options);
    cleanup = await cleanupOnce();
    if (cleanup !== "done") throw fail("CLEANUP_UNKNOWN", "cleanup");
    emit(result, 1);
    return 0;
  } catch (error) {
    const failure = error instanceof Failure ? error : fail("ARCHIVE_INVALID", "unknown");
    // 收尾只有一个绝对 2 s 时钟：inventory / FAILED.json / close 全在同一窗口内。
    startCleanupClock();
    let inventory = {
      items: [],
      truncated: false,
      unknown: true,
      reason: "not-observed",
    };
    try {
      inventory = await inventoryOf(state.outDir, "diagnostic", { cleanup: true });
    } catch {
      /* 观测不到就保持 unknown，不伪造空目录 */
    }
    const marker = await writeFailedMarker(failure, inventory);
    inventory = marker.inventory;
    cleanup = await cleanupOnce();
    let finalFailure = failure;
    if (cleanup !== "done" && failure.exit !== 9) finalFailure = fail("CLEANUP_UNKNOWN", "cleanup");
    emit(
      {
        ok: false,
        code: finalFailure.code,
        stage: finalFailure.stage,
        mode,
        cleanup: finalFailure.exit === 9 ? "unknown" : cleanup,
        inventory: inventory.items,
        ...(inventory.truncated ? { inventoryTruncated: true } : {}),
        ...(inventory.unknown ? { inventoryUnknown: true } : {}),
      },
      2,
    );
    return finalFailure.exit;
  } finally {
    if (state.deadlineTimer) clearTimeout(state.deadlineTimer);
  }
}

process.on("SIGINT", () => {
  triggerAbort("CANCELLED");
});
process.on("SIGTERM", () => {
  triggerAbort("CANCELLED");
});

main()
  .then((code) => {
    process.exitCode = code;
    process.exit(code);
  })
  .catch(() => {
    emit({ ok: false, code: "CANDIDATE_CLEANUP_UNKNOWN", stage: "main" }, 2);
    process.exit(9);
  });
