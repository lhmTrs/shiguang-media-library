/**
 * T-LOCAL-013H / MUSIC-LAUNCHER-DELIVERY-20261026：受限 launcher 的可审构建/校验/安装入口。
 *
 * 只新增本文件与 tests/audio-executor-launcher-build.test.mjs；不改 C、executor、
 * runtime 配置、package.json 或打包清单。build/verify/install 都只写自有临时根、
 * releases/ 下的候选/安装目录与锁目录；不联网、不下载编译器、不提权。
 *
 * 产物身份 = 本次实际产物的 SHA256 + 字节数（本机 clang 构建不可复现，已由总监裁定）。
 * 本工具不把构建成功等同真实音频引擎 READY，也不声明签名/公证/公开发行。
 */
import fsp from "node:fs/promises";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT_RAW = path.dirname(path.dirname(path.dirname(SCRIPT_PATH)));

const SOURCE_SHA256 = "9ff0e66713c22e1a29d2cab9b7c746b6fa30eeeb360e084385a951b0da898e13";
const SOURCE_BYTES = 2430;
const SOURCE_MAX_BYTES = 65536;
const LAUNCHER_MAX_BYTES = 16 * 1024 * 1024;
const ARTIFACT_MAX_BYTES = 16384;
const SUMS_MAX_BYTES = 512;
const OWNER_MAX_BYTES = 1024;
const COMPILER_PATH = "/usr/bin/clang";
const COMPILER_MAX_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[0-9a-f]{16}$/;
const BINARY_NAME = "audio-executor-launcher";
const ARTIFACT_NAME = "artifact.json";
const SUMS_NAME = "SHA256SUMS";
const LOCK_NAME = ".shiguang-launcher-publish.lock";
const STAGE_RE = /^\.stage-[0-9]+-[0-9a-f]{16}$/;
const TMP_RE = /^\.audio-executor-launcher\.tmp-[0-9]+-[0-9a-f]{16}$/;
const LOCK_WAIT_MS = 8000;
const LOCK_POLL_MS = 50;
const PROBE_TIMEOUT_MS = 10000;
const PROBE_STREAM_BYTES = 8192;
const COMPILE_TIMEOUT_MS = 60000;
const COMPILE_STREAM_BYTES = 65536;
const TERM_SETTLE_MS = 2000;
const KILL_SETTLE_MS = 3000;
const FINAL_SETTLE_MS = 2000;
const CLOSE_SETTLE_MS = 2000;
const TERMINATION_DEADLINE_MS = 9000;
const ARGS = Object.freeze(["-O2", "-Wall", "-Wextra"]);

const EXIT = Object.freeze({
  INTERNAL: 1,
  USAGE: 2,
  VERIFY_FAILED: 3,
  BUILD_FAILED: 4,
  UNSUPPORTED_HOST: 4,
  SOURCE_MISMATCH: 5,
  TARGET_EXISTS: 6,
  PATH_UNSAFE: 7,
  PUBLISH_BUSY: 8,
});

const MESSAGES = Object.freeze({
  INTERNAL: "内部错误或清理未确认",
  USAGE: "参数不合法",
  VERIFY_FAILED: "产物校验失败",
  BUILD_FAILED: "构建失败",
  UNSUPPORTED_HOST: "仅支持 macOS arm64",
  SOURCE_MISMATCH: "源码身份不匹配",
  TARGET_EXISTS: "目标已存在且不可覆盖",
  PATH_UNSAFE: "路径不安全",
  PUBLISH_BUSY: "发布锁被占用",
});

class ToolError extends Error {
  constructor(code, { details, inventory, cleanup, warnings } = {}) {
    super(MESSAGES[code] ?? MESSAGES.INTERNAL);
    this.name = "ToolError";
    this.code = code;
    this.exitCode = EXIT[code] ?? EXIT.INTERNAL;
    this.details = details ?? null;
    this.inventory = inventory ?? [];
    this.cleanup = cleanup ?? (code === "INTERNAL" ? "unknown" : "done");
    this.warnings = warnings ?? [];
  }
}

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errCode(error) {
  return typeof error?.code === "string" ? error.code : null;
}

function isMissing(error) {
  return errCode(error) === "ENOENT";
}

function pathInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

async function lstatOrNull(target) {
  try {
    return await fsp.lstat(target, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function modeOf(stat) {
  return Number(stat.mode & 0o777n);
}

function sameIdentity(a, b, fields = ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) {
  return fields.every((field) => a[field] === b[field]);
}

async function readExactNoFollow(target, size, maxBytes) {
  const before = await fsp.lstat(target, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new ToolError("PATH_UNSAFE");
  }
  if (before.size <= 0n || before.size > BigInt(maxBytes)) {
    throw new ToolError("VERIFY_FAILED");
  }
  if (size !== undefined && before.size !== BigInt(size)) {
    throw new ToolError("VERIFY_FAILED");
  }
  const handle = await fsp.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened, ["dev", "ino", "size"])) {
      throw new ToolError("PATH_UNSAFE");
    }
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length) throw new ToolError("VERIFY_FAILED");
    const extra = Buffer.alloc(1);
    const tail = await handle.read(extra, 0, 1, buffer.length);
    if (tail.bytesRead !== 0) throw new ToolError("VERIFY_FAILED");
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw new ToolError("VERIFY_FAILED");
    return { buffer, stat: after };
  } finally {
    await handle.close().catch(() => {});
  }
}

function checkMachO(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;
  return (
    buffer.readUInt32LE(0) === 0xfeedfacf &&
    buffer.readUInt32LE(4) === 0x0100000c &&
    buffer.readUInt32LE(12) === 2
  );
}

function machoFacts(buffer) {
  return {
    magic: `0x${buffer.readUInt32LE(0).toString(16)}`,
    cputype: `0x${buffer.readUInt32LE(4).toString(16).padStart(8, "0")}`,
    filetype: buffer.readUInt32LE(12),
  };
}

function channelData(result) {
  const details = {
    timedOut: result.timedOut,
    outputOverflow: result.outputOverflow,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stderrSha256: result.stderrSha256,
    exited: result.exited,
    groupSettled: result.groupSettled,
    streamsClosed: result.streamsClosed,
    terminationTrigger: result.terminationTrigger,
    termSent: result.termSent,
    killSent: result.killSent,
    groupAliveAfterTerm: result.groupAliveAfterTerm,
    settleMs: result.settleMs,
  };
  return details;
}

function classifySettlement(exited, groupSettled, streamsClosed) {
  const missing = [];
  if (!exited) missing.push("exited");
  if (!groupSettled) missing.push("groupSettled");
  if (!streamsClosed) missing.push("streamsClosed");
  return { cleanup: missing.length === 0 ? "done" : "unknown", missing };
}

function killGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if (isMissing(error) || errCode(error) === "ESRCH") return false;
    return true;
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (errCode(error) === "ESRCH") return false;
    return true;
  }
}

async function waitGroupGone(pgid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

async function waitFor(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
  });
  const outcome = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return outcome;
}

async function runBoundedChild(command, args, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : COMPILE_TIMEOUT_MS;
  const maxStdoutBytes = Number.isInteger(options.maxStdoutBytes)
    ? options.maxStdoutBytes
    : COMPILE_STREAM_BYTES;
  const maxStderrBytes = Number.isInteger(options.maxStderrBytes)
    ? options.maxStderrBytes
    : COMPILE_STREAM_BYTES;
  const start = Date.now();

  let child;
  try {
    child = spawn(command, args, {
      shell: false,
      detached: true,
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      command,
      status: null,
      signal: null,
      spawnError: { code: errCode(error) ?? "UNKNOWN" },
      exited: false,
      groupSettled: false,
      streamsClosed: false,
      timedOut: false,
      outputOverflow: false,
      terminationTrigger: "none",
      termSent: false,
      killSent: false,
      groupAliveAfterTerm: false,
      cleanup: "unknown",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stderrSha256: sha256(Buffer.alloc(0)),
      settleMs: 0,
      exitAt: null,
      termAt: null,
      killAt: null,
    };
  }

  const pgid = child.pid;
  let exitFact = null;
  let closeFact = null;
  let spawnError = null;
  let timedOut = false;
  let outputOverflow = false;
  let terminationTrigger = "none";
  let termSent = false;
  let killSent = false;
  let groupSettled = false;
  let streamsClosed = false;
  let groupAliveAfterTerm = false;
  let termAt = null;
  let killAt = null;
  let settleMs = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks = [];
  const stderrChunks = [];
  let stdoutStored = 0;
  let stderrStored = 0;

  const exitP = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      exitFact = { code, signal, at: Date.now() };
      resolve(exitFact);
    });
  });
  const closeP = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closeFact = { code, signal, at: Date.now() };
      resolve(closeFact);
    });
  });
  const errorP = new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = { code: errCode(error) ?? "UNKNOWN" };
      resolve(spawnError);
    });
  });

  let termination = null;

  async function terminateAndSettle(trigger) {
    const deadline = Date.now() + TERMINATION_DEADLINE_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    termAt = Date.now();
    termSent = killGroup(pgid, "SIGTERM");
    let gone = !termSent ? true : await waitGroupGone(pgid, Math.min(TERM_SETTLE_MS, remaining()));
    groupAliveAfterTerm = !gone;
    if (!gone) {
      killAt = Date.now();
      killSent = true;
      killGroup(pgid, "SIGKILL");
      gone = await waitGroupGone(pgid, Math.min(KILL_SETTLE_MS, remaining()));
      if (!gone) gone = await waitGroupGone(pgid, Math.min(FINAL_SETTLE_MS, remaining()));
    }
    groupSettled = gone;
    if (!exitFact) await waitFor(exitP, Math.min(TERM_SETTLE_MS, remaining()));
    if (!closeFact) await waitFor(closeP, Math.min(CLOSE_SETTLE_MS, remaining()));
    streamsClosed = Boolean(closeFact);
    settleMs = Date.now() - termAt;
    terminationTrigger = trigger;
  }

  function beginTermination(trigger) {
    if (!termination) termination = terminateAndSettle(trigger);
    return termination;
  }

  child.stdout?.on("data", (chunk) => {
    if (outputOverflow) return;
    stdoutBytes += chunk.length;
    if (stdoutStored < maxStdoutBytes) {
      const take = Math.min(chunk.length, maxStdoutBytes - stdoutStored);
      stdoutChunks.push(chunk.subarray(0, take));
      stdoutStored += take;
    }
    if (stdoutBytes > maxStdoutBytes) {
      outputOverflow = true;
      void beginTermination("output-overflow");
    }
  });
  child.stderr?.on("data", (chunk) => {
    if (outputOverflow) return;
    stderrBytes += chunk.length;
    if (stderrStored < maxStderrBytes) {
      const take = Math.min(chunk.length, maxStderrBytes - stderrStored);
      stderrChunks.push(chunk.subarray(0, take));
      stderrStored += take;
    }
    if (stderrBytes > maxStderrBytes) {
      outputOverflow = true;
      void beginTermination("output-overflow");
    }
  });

  let timeoutTimer;
  const timeoutP = new Promise((resolve) => {
    timeoutTimer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
  });
  const first = await Promise.race([
    exitP.then((fact) => ({ kind: "exit", fact })),
    errorP.then((fact) => ({ kind: "error", fact })),
    timeoutP,
  ]);
  clearTimeout(timeoutTimer);

  if (first.kind === "timeout") {
    timedOut = true;
    await beginTermination("timeout");
  } else if (first.kind === "error") {
    await waitFor(closeP, Math.min(CLOSE_SETTLE_MS, timeoutMs));
    streamsClosed = Boolean(closeFact);
    groupSettled = false;
  } else {
    if (groupAlive(pgid)) {
      await beginTermination("group-residual");
    } else {
      groupSettled = true;
      if (!closeFact) await waitFor(closeP, CLOSE_SETTLE_MS);
      streamsClosed = Boolean(closeFact);
    }
  }
  if (termination) await termination;

  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  const settlement = classifySettlement(Boolean(exitFact), groupSettled, streamsClosed);
  return {
    command,
    status: exitFact ? exitFact.code : null,
    signal: exitFact ? exitFact.signal : null,
    spawnError,
    exited: Boolean(exitFact),
    groupSettled,
    streamsClosed,
    timedOut,
    outputOverflow,
    terminationTrigger,
    termSent,
    killSent,
    groupAliveAfterTerm,
    cleanup: spawnError ? "unknown" : settlement.cleanup,
    stdoutBytes,
    stderrBytes,
    stdout,
    stderr,
    stderrSha256: sha256(stderr),
    settleMs,
    exitAt: exitFact ? exitFact.at : null,
    termAt,
    killAt,
    elapsedMs: Date.now() - start,
  };
}

function parseOwner(buffer) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.format !== 1) return null;
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.nonce !== "string" || !NONCE_RE.test(value.nonce)) return null;
  if (value.action !== "build" && value.action !== "install") return null;
  if (typeof value.startedAt !== "string" || value.startedAt.length > 64) return null;
  if (typeof value.hostname !== "string" || value.hostname.length > 255) return null;
  return value;
}

async function readOwnerBounded(lockDir) {
  const ownerPath = path.join(lockDir, "owner.json");
  const before = await fsp.lstat(ownerPath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) return { state: "unreadable" };
  if (before.size <= 0n || before.size > BigInt(OWNER_MAX_BYTES)) return { state: "unreadable" };
  const handle = await fsp.open(ownerPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened, ["dev", "ino", "size"])) {
      return { state: "unreadable" };
    }
    const buffer = Buffer.alloc(Number(opened.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) return { state: "unreadable" };
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) return { state: "unreadable" };
    const owner = parseOwner(buffer);
    if (!owner) return { state: "malformed" };
    return { state: "ok", owner };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function observeOwner(lockDir) {
  try {
    const lockStat = await fsp.lstat(lockDir, { bigint: true });
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) return "unknown";
  } catch (error) {
    if (isMissing(error)) return "missing";
    return "unknown";
  }
  let ownerPath;
  try {
    ownerPath = path.join(lockDir, "owner.json");
    const ownerStat = await fsp.lstat(ownerPath, { bigint: true });
    if (ownerStat.isSymbolicLink() || !ownerStat.isFile()) return "unreadable";
    if (ownerStat.size <= 0n || ownerStat.size > BigInt(OWNER_MAX_BYTES)) return "unreadable";
  } catch (error) {
    return isMissing(error) ? "missing" : "unreadable";
  }
  try {
    const parsed = await readOwnerBounded(lockDir);
    if (parsed.state !== "ok") return parsed.state;
    try {
      process.kill(parsed.owner.pid, 0);
      return "live";
    } catch (error) {
      if (errCode(error) === "ESRCH") return "dead";
      if (errCode(error) === "EPERM") return "live";
      return "unknown";
    }
  } catch {
    return "unreadable";
  }
}

async function acquireLock(lockDir, action) {
  const waitedFrom = Date.now();
  let ownerState = "missing";
  for (;;) {
    let created = false;
    try {
      await fsp.mkdir(lockDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw new ToolError("PATH_UNSAFE");
    }
    if (created) {
      const lockStat = await fsp.lstat(lockDir, { bigint: true });
      if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
        throw new ToolError("PATH_UNSAFE", { cleanup: "unknown" });
      }
      const nonce = crypto.randomBytes(8).toString("hex");
      const owner = {
        format: 1,
        pid: process.pid,
        hostname: os.hostname().slice(0, 255),
        startedAt: new Date().toISOString(),
        nonce,
        action,
      };
      const payload = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
      let writeOk = false;
      let ownerCreated = false;
      try {
        const handle = await fsp.open(path.join(lockDir, "owner.json"), "wx", 0o600);
        ownerCreated = true;
        try {
          await handle.writeFile(payload);
          await handle.sync();
          writeOk = true;
        } finally {
          await handle.close().catch(() => {});
        }
      } catch {
        writeOk = false;
      }
      if (!writeOk) {
        const current = await lstatOrNull(lockDir);
        let removed = false;
        if (current && current.ino === lockStat.ino) {
          if (ownerCreated) {
            try {
              await fsp.unlink(path.join(lockDir, "owner.json"));
            } catch {
              /* owner 可能部分创建 */
            }
          }
          try {
            await fsp.rmdir(lockDir);
            removed = true;
          } catch {
            removed = false;
          }
        }
        throw new ToolError("INTERNAL", {
          cleanup: removed ? "done" : "unknown",
          inventory: removed
            ? []
            : [{ kind: "lock", path: lockDir, state: "unknown" }],
        });
      }
      return { lockDir, lockIno: lockStat.ino, nonce, action };
    }

    ownerState = await observeOwner(lockDir);
    const waitedMs = Date.now() - waitedFrom;
    if (waitedMs >= LOCK_WAIT_MS) {
      throw new ToolError("PUBLISH_BUSY", {
        details: { ownerState, waitedMs },
        inventory: [{ kind: "lock", path: lockDir, state: "preserved" }],
      });
    }
    await delay(Math.min(LOCK_POLL_MS, LOCK_WAIT_MS - waitedMs));
  }
}

async function releaseLock(lock) {
  try {
    const lockStat = await fsp.lstat(lock.lockDir, { bigint: true });
    if (lockStat.isSymbolicLink() || !lockStat.isDirectory() || lockStat.ino !== lock.lockIno) {
      return false;
    }
    const entries = await fsp.readdir(lock.lockDir);
    if (entries.length !== 1 || entries[0] !== "owner.json") return false;
    const parsed = await readOwnerBounded(lock.lockDir);
    if (parsed.state !== "ok") return false;
    if (
      parsed.owner.nonce !== lock.nonce ||
      parsed.owner.pid !== process.pid ||
      parsed.owner.action !== lock.action
    ) {
      return false;
    }
    await fsp.unlink(path.join(lock.lockDir, "owner.json"));
    await fsp.rmdir(lock.lockDir);
    return true;
  } catch {
    return false;
  }
}

async function ensureChildDir(anchorCanonical, name) {
  if (typeof name !== "string" || name === "" || name.includes(path.sep) || name === "..") {
    throw new ToolError("PATH_UNSAFE");
  }
  const child = path.join(anchorCanonical, name);
  let stat = await lstatOrNull(child);
  if (!stat) {
    try {
      await fsp.mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (errCode(error) !== "EEXIST") throw new ToolError("PATH_UNSAFE");
    }
    stat = await fsp.lstat(child, { bigint: true });
  }
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new ToolError("PATH_UNSAFE");
  const real = await fsp.realpath(child);
  if (real !== child) throw new ToolError("PATH_UNSAFE");
  return child;
}

async function validateDirChain(anchorCanonical, targetAbs, options = {}) {
  if (!path.isAbsolute(targetAbs)) throw new ToolError("USAGE");
  const anchorStat = await lstatOrNull(anchorCanonical);
  if (!anchorStat || anchorStat.isSymbolicLink() || !anchorStat.isDirectory()) {
    throw new ToolError("PATH_UNSAFE");
  }
  const rel = path.relative(anchorCanonical, targetAbs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new ToolError("PATH_UNSAFE");
  }
  const segments = rel.split(path.sep);
  let current = anchorCanonical;
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") throw new ToolError("PATH_UNSAFE");
    current = path.join(current, segment);
    let stat = await lstatOrNull(current);
    if (!stat) {
      if (!options.create) throw new ToolError("PATH_UNSAFE");
      try {
        await fsp.mkdir(current, { mode: 0o700 });
      } catch (error) {
        if (errCode(error) !== "EEXIST") throw new ToolError("PATH_UNSAFE");
      }
      stat = await fsp.lstat(current, { bigint: true });
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new ToolError("PATH_UNSAFE");
    const real = await fsp.realpath(current);
    if (real !== current) throw new ToolError("PATH_UNSAFE");
  }
  return path.join(anchorCanonical, ...segments);
}

async function resolveBuildDirs(repoRoot, explicitOutRoot) {
  let outRoot;
  if (explicitOutRoot) {
    const stat = await lstatOrNull(explicitOutRoot);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) throw new ToolError("PATH_UNSAFE");
    outRoot = await fsp.realpath(explicitOutRoot);
  } else {
    let current = repoRoot;
    for (const segment of ["releases", "launcher-candidates"]) {
      current = await ensureChildDir(current, segment);
    }
    outRoot = current;
  }
  const arm64 = await ensureChildDir(outRoot, "macos-arm64");
  const revalidate = async () => {
    const outStat = await lstatOrNull(outRoot);
    if (!outStat || outStat.isSymbolicLink() || !outStat.isDirectory()) {
      throw new ToolError("PATH_UNSAFE");
    }
    const armStat = await lstatOrNull(arm64);
    if (!armStat || armStat.isSymbolicLink() || !armStat.isDirectory()) {
      throw new ToolError("PATH_UNSAFE");
    }
    if ((await fsp.realpath(outRoot)) !== outRoot) throw new ToolError("PATH_UNSAFE");
    if ((await fsp.realpath(arm64)) !== arm64) throw new ToolError("PATH_UNSAFE");
  };
  return { outRoot, arm64, revalidate };
}

async function resolveInstallDirs(repoRoot, explicitDir) {
  const launcherRoot = path.join(repoRoot, "releases", "launcher");
  let dir;
  if (explicitDir) {
    // 显式路径先做合法性/包含关系与既有完整链校验；此模式绝不创建默认 releases/launcher。
    const explicitStat = await lstatOrNull(explicitDir);
    if (!explicitStat || explicitStat.isSymbolicLink() || !explicitStat.isDirectory()) {
      throw new ToolError("PATH_UNSAFE");
    }
    const literal = path.resolve(explicitDir);
    const literalRel = path.relative(launcherRoot, literal);
    const literalInside =
      literalRel !== "" &&
      literalRel !== ".." &&
      !literalRel.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(literalRel);
    let candidate;
    if (literalInside) {
      // 显式路径在 launcher 根下：逐字校验每一级，拒绝指向根内的符号链接。
      candidate = literal;
    } else {
      // 祖先别名（如 /var、/tmp）按操作者信任处理，只看 canonical 结果。
      try {
        candidate = await fsp.realpath(explicitDir);
      } catch {
        throw new ToolError("PATH_UNSAFE");
      }
      if (!pathInside(launcherRoot, candidate)) throw new ToolError("PATH_UNSAFE");
    }
    dir = await validateDirChain(repoRoot, candidate, { create: false });
  } else {
    let current = repoRoot;
    for (const segment of ["releases", "launcher"]) {
      current = await ensureChildDir(current, segment);
    }
    dir = await ensureChildDir(current, "macos-arm64");
  }
  const revalidate = async () => {
    // 锁内复用完整链检查，而不只核 dir 自身；任一级缺失/符号链接/别名都拒绝。
    await validateDirChain(repoRoot, dir, { create: false });
  };
  return { dir, launcherRoot, revalidate };
}

async function readSourceSnapshot(sourcePath) {
  let before;
  try {
    before = await fsp.lstat(sourcePath, { bigint: true });
  } catch (error) {
    throw new ToolError(isMissing(error) ? "SOURCE_MISMATCH" : "PATH_UNSAFE");
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new ToolError("PATH_UNSAFE");
  if (before.size <= 0n || before.size > BigInt(SOURCE_MAX_BYTES)) {
    throw new ToolError("SOURCE_MISMATCH");
  }
  let snapshot;
  try {
    snapshot = await readExactNoFollow(sourcePath, Number(before.size), SOURCE_MAX_BYTES);
  } catch (error) {
    if (error instanceof ToolError && error.code === "VERIFY_FAILED") {
      throw new ToolError("SOURCE_MISMATCH");
    }
    throw error;
  }
  const digest = sha256(snapshot.buffer);
  if (digest !== SOURCE_SHA256 || snapshot.buffer.length !== SOURCE_BYTES) {
    throw new ToolError("SOURCE_MISMATCH");
  }
  return { buffer: snapshot.buffer, sha256: digest, bytes: snapshot.buffer.length };
}

async function readArtifactSnapshot(artifactPath, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !SHA256_RE.test(expectedSha256)) {
    throw new ToolError("USAGE");
  }
  if (!path.isAbsolute(artifactPath)) throw new ToolError("USAGE");
  let stat;
  try {
    stat = await fsp.lstat(artifactPath, { bigint: true });
  } catch (error) {
    throw new ToolError(isMissing(error) ? "VERIFY_FAILED" : "PATH_UNSAFE");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new ToolError("PATH_UNSAFE");
  if (stat.size <= 0n || stat.size > BigInt(LAUNCHER_MAX_BYTES)) {
    throw new ToolError("VERIFY_FAILED");
  }
  let snapshot;
  try {
    snapshot = await readExactNoFollow(artifactPath, Number(stat.size), LAUNCHER_MAX_BYTES);
  } catch (error) {
    if (error instanceof ToolError && error.code === "PATH_UNSAFE") throw error;
    throw new ToolError("VERIFY_FAILED");
  }
  const digest = sha256(snapshot.buffer);
  if (digest !== expectedSha256) throw new ToolError("VERIFY_FAILED");
  if (!checkMachO(snapshot.buffer)) throw new ToolError("VERIFY_FAILED");
  return { buffer: snapshot.buffer, sha256: digest, bytes: snapshot.buffer.length };
}

function parseSha256Sums(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(String(input), "utf8");
  if (buffer.length <= 0 || buffer.length > SUMS_MAX_BYTES) throw new ToolError("VERIFY_FAILED");
  if (buffer.includes(0x0d) || buffer.includes(0x00)) throw new ToolError("VERIFY_FAILED");
  const text = buffer.toString("utf8");
  if (!text.endsWith("\n")) throw new ToolError("VERIFY_FAILED");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length !== 2) throw new ToolError("VERIFY_FAILED");
  const pattern = /^([0-9a-f]{64})  (audio-executor-launcher|artifact\.json)$/;
  const seen = new Map();
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) throw new ToolError("VERIFY_FAILED");
    if (seen.has(match[2])) throw new ToolError("VERIFY_FAILED");
    seen.set(match[2], match[1]);
  }
  if (lines[0] !== `${seen.get(BINARY_NAME)}  ${BINARY_NAME}`) throw new ToolError("VERIFY_FAILED");
  if (lines[1] !== `${seen.get(ARTIFACT_NAME)}  ${ARTIFACT_NAME}`) throw new ToolError("VERIFY_FAILED");
  return {
    binarySha256: seen.get(BINARY_NAME),
    artifactSha256: seen.get(ARTIFACT_NAME),
  };
}

function assertExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolError("VERIFY_FAILED");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ToolError("VERIFY_FAILED");
  }
}

function validateArtifactJson(buffer, facts) {
  if (buffer.length <= 0 || buffer.length > ARTIFACT_MAX_BYTES) throw new ToolError("VERIFY_FAILED");
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new ToolError("VERIFY_FAILED");
  }
  assertExactKeys(value, [
    "format",
    "status",
    "buildId",
    "platform",
    "arch",
    "source",
    "compiler",
    "args",
    "binary",
    "signature",
    "createdAt",
  ]);
  if (value.format !== 1 || value.status !== "candidate") throw new ToolError("VERIFY_FAILED");
  if (value.platform !== "macos" || value.arch !== "arm64") throw new ToolError("VERIFY_FAILED");
  if (typeof value.buildId !== "string" || !NONCE_RE.test(value.buildId)) {
    throw new ToolError("VERIFY_FAILED");
  }
  assertExactKeys(value.source, ["origin", "sha256", "bytes"]);
  if (value.source.origin !== "pinned" || value.source.sha256 !== SOURCE_SHA256) {
    throw new ToolError("VERIFY_FAILED");
  }
  if (value.source.bytes !== SOURCE_BYTES) throw new ToolError("VERIFY_FAILED");
  assertExactKeys(value.compiler, ["path", "sha256", "version", "target"]);
  if (value.compiler.path !== COMPILER_PATH) throw new ToolError("VERIFY_FAILED");
  if (typeof value.compiler.sha256 !== "string" || !SHA256_RE.test(value.compiler.sha256)) {
    throw new ToolError("VERIFY_FAILED");
  }
  if (
    typeof value.compiler.version !== "string" ||
    value.compiler.version.length === 0 ||
    value.compiler.version.length > 200 ||
    typeof value.compiler.target !== "string" ||
    value.compiler.target.length === 0 ||
    value.compiler.target.length > 200
  ) {
    throw new ToolError("VERIFY_FAILED");
  }
  if (
    !Array.isArray(value.args) ||
    value.args.length !== ARGS.length ||
    value.args.some((arg, index) => arg !== ARGS[index])
  ) {
    throw new ToolError("VERIFY_FAILED");
  }
  assertExactKeys(value.binary, ["name", "sha256", "bytes", "macho"]);
  if (value.binary.name !== BINARY_NAME) throw new ToolError("VERIFY_FAILED");
  if (value.binary.sha256 !== facts.binarySha256) throw new ToolError("VERIFY_FAILED");
  if (value.binary.bytes !== facts.binaryBytes) throw new ToolError("VERIFY_FAILED");
  assertExactKeys(value.binary.macho, ["magic", "cputype", "filetype"]);
  if (
    value.binary.macho.magic !== facts.macho.magic ||
    value.binary.macho.cputype !== facts.macho.cputype ||
    value.binary.macho.filetype !== facts.macho.filetype
  ) {
    throw new ToolError("VERIFY_FAILED");
  }
  assertExactKeys(value.signature, ["kind", "verified"]);
  if (value.signature.kind !== "linker-adhoc" || value.signature.verified !== false) {
    throw new ToolError("VERIFY_FAILED");
  }
  if (typeof value.createdAt !== "string" || value.createdAt.length > 64) {
    throw new ToolError("VERIFY_FAILED");
  }
  if (Number.isNaN(Date.parse(value.createdAt))) throw new ToolError("VERIFY_FAILED");
  return value;
}

async function readMemberNoFollow(member, maxBytes, requiredMode) {
  const stat = await fsp.lstat(member, { bigint: true });
  if (stat.isSymbolicLink()) throw new ToolError("PATH_UNSAFE");
  if (!stat.isFile()) throw new ToolError("VERIFY_FAILED");
  if (stat.size <= 0n || stat.size > BigInt(maxBytes)) throw new ToolError("VERIFY_FAILED");
  if (requiredMode !== undefined && modeOf(stat) !== requiredMode) {
    throw new ToolError("VERIFY_FAILED");
  }
  return readExactNoFollow(member, Number(stat.size), maxBytes);
}

async function verifyCandidateAtPath(dirPath, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !SHA256_RE.test(expectedSha256)) {
    throw new ToolError("VERIFY_FAILED");
  }
  const dirStat = await lstatOrNull(dirPath);
  if (!dirStat) throw new ToolError("VERIFY_FAILED");
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new ToolError("PATH_UNSAFE");
  const entries = await fsp.readdir(dirPath);
  const expectedEntries = [BINARY_NAME, ARTIFACT_NAME, SUMS_NAME].sort();
  if (
    entries.length !== expectedEntries.length ||
    entries.slice().sort().some((name, index) => name !== expectedEntries[index])
  ) {
    throw new ToolError("VERIFY_FAILED");
  }
  const binary = await readMemberNoFollow(path.join(dirPath, BINARY_NAME), LAUNCHER_MAX_BYTES, 0o500);
  const binarySha = sha256(binary.buffer);
  if (binarySha !== expectedSha256 || path.basename(dirPath) !== binarySha) {
    throw new ToolError("VERIFY_FAILED");
  }
  if (!checkMachO(binary.buffer)) throw new ToolError("VERIFY_FAILED");
  const macho = machoFacts(binary.buffer);
  const artifact = await readMemberNoFollow(path.join(dirPath, ARTIFACT_NAME), ARTIFACT_MAX_BYTES, 0o400);
  const artifactSha = sha256(artifact.buffer);
  const sums = await readMemberNoFollow(path.join(dirPath, SUMS_NAME), SUMS_MAX_BYTES, 0o400);
  const parsed = parseSha256Sums(sums.buffer);
  if (parsed.binarySha256 !== binarySha || parsed.artifactSha256 !== artifactSha) {
    throw new ToolError("VERIFY_FAILED");
  }
  const manifest = validateArtifactJson(artifact.buffer, {
    binarySha256: binarySha,
    binaryBytes: binary.buffer.length,
    macho,
  });
  return {
    binarySha256: binarySha,
    binaryBytes: binary.buffer.length,
    artifactSha256: artifactSha,
    manifest,
    path: dirPath,
  };
}

async function writeExclusive(target, buffer, mode, onOpen) {
  const handle = await fsp.open(target, "wx", mode);
  try {
    if (typeof onOpen === "function") await onOpen(handle);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
      if (bytesWritten <= 0) throw new ToolError("INTERNAL");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function fsyncDir(dir) {
  try {
    const handle = await fsp.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    return "done";
  } catch (error) {
    const code = errCode(error);
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR" || code === "EBADF") {
      return "unsupported";
    }
    throw new ToolError("INTERNAL");
  }
}

async function scanResidues(arm64) {
  const residue = [];
  let entries;
  try {
    entries = await fsp.readdir(arm64, { withFileTypes: true });
  } catch {
    return residue;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".stage-")) {
      residue.push({ kind: "stage-residue", path: path.join(arm64, entry.name), state: "preserved" });
    } else if (entry.name.startsWith(LOCK_NAME)) {
      residue.push({ kind: "lock-residue", path: path.join(arm64, entry.name), state: "preserved" });
    }
  }
  return residue;
}

async function removeOwnedDir(dir, pattern) {
  try {
    let stat;
    try {
      stat = await fsp.lstat(dir, { bigint: true });
    } catch (error) {
      // 只有 ENOENT 能证明本次自有根已不存在；EACCES 等观察失败必须保留并报 unknown。
      if (isMissing(error)) return { ok: true, removed: true };
      throw error;
    }
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !pattern.test(path.basename(dir))) {
      return { ok: false };
    }
    await fsp.rm(dir, { recursive: true, force: false });
    const after = await fsp.lstat(dir).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    return after ? { ok: false } : { ok: true, removed: true };
  } catch {
    return { ok: false };
  }
}

async function inspectCompiler() {
  const stat = await lstatOrNull(COMPILER_PATH);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) throw new ToolError("BUILD_FAILED");
  if (stat.size <= 0n || stat.size > BigInt(COMPILER_MAX_BYTES)) throw new ToolError("BUILD_FAILED");
  const snapshot = await readExactNoFollow(COMPILER_PATH, Number(stat.size), COMPILER_MAX_BYTES);
  return { path: COMPILER_PATH, sha256: sha256(snapshot.buffer) };
}

function parseCompilerProbe(result) {
  if (!result.exited || !result.groupSettled || !result.streamsClosed) {
    throw new ToolError("INTERNAL", { details: channelData(result) });
  }
  if (result.status !== 0 || result.timedOut || result.outputOverflow) {
    throw new ToolError("BUILD_FAILED", { details: channelData(result) });
  }
  const lines = result.stdout.toString("utf8").split("\n").map((line) => line.trim());
  const version = (lines.find((line) => line.length > 0) ?? "").slice(0, 200);
  const targetLine = lines.find((line) => line.startsWith("Target:")) ?? "";
  const target = targetLine.slice("Target:".length).trim().slice(0, 200);
  if (!version || !target) throw new ToolError("BUILD_FAILED");
  return { version, target };
}

function childFailure(result) {
  if (!result.exited || !result.groupSettled || !result.streamsClosed) {
    return new ToolError("INTERNAL", { details: channelData(result), cleanup: "unknown" });
  }
  if (result.timedOut || result.outputOverflow || result.status !== 0) {
    return new ToolError("BUILD_FAILED", { details: channelData(result), cleanup: "done" });
  }
  return null;
}

async function buildCommand(options) {
  const repoRoot = await fsp.realpath(REPO_ROOT_RAW);
  const repoStat = await fsp.lstat(repoRoot, { bigint: true });
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) throw new ToolError("PATH_UNSAFE");
  const sourcePath = options.source ?? path.join(repoRoot, "server", "native", "audio-executor-launcher.c");
  let workRoot = null;
  let stage = null;
  let lock = null;
  const inventory = [];
  const warnings = [];
  let stageCleanup = "done";
  let workCleanup = "done";
  let lockCleanup = "done";
  let stageDirFsync = "done";

  try {
    workRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "shiguang-launcher-build-"));
    await fsp.chmod(workRoot, 0o700);
    const source = await readSourceSnapshot(sourcePath);
    const copyPath = path.join(workRoot, "source.c");
    await writeExclusive(copyPath, source.buffer, 0o600);
    const copyCheck = await readExactNoFollow(copyPath, source.bytes, SOURCE_MAX_BYTES);
    if (sha256(copyCheck.buffer) !== SOURCE_SHA256) throw new ToolError("INTERNAL");

    const compiler = await inspectCompiler();
    const probe = await runBoundedChild(compiler.path, ["--version"], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdoutBytes: PROBE_STREAM_BYTES,
      maxStderrBytes: PROBE_STREAM_BYTES,
      cwd: workRoot,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: workRoot },
    });
    const probeFacts = parseCompilerProbe(probe);

    const compile = await runBoundedChild(
      compiler.path,
      [...ARGS, "-o", path.join(workRoot, "out"), copyPath],
      {
        timeoutMs: COMPILE_TIMEOUT_MS,
        maxStdoutBytes: COMPILE_STREAM_BYTES,
        maxStderrBytes: COMPILE_STREAM_BYTES,
        cwd: workRoot,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: workRoot },
      },
    );
    const failure = childFailure(compile);
    if (failure) throw failure;

    const outPath = path.join(workRoot, "out");
    const outStat = await fsp.lstat(outPath, { bigint: true }).catch(() => null);
    if (!outStat || outStat.isSymbolicLink() || !outStat.isFile()) throw new ToolError("BUILD_FAILED");
    if (outStat.size <= 0n || outStat.size > BigInt(LAUNCHER_MAX_BYTES)) {
      throw new ToolError("BUILD_FAILED");
    }
    const outCheck = await readExactNoFollow(outPath, Number(outStat.size), LAUNCHER_MAX_BYTES);
    if (!checkMachO(outCheck.buffer)) throw new ToolError("VERIFY_FAILED");
    const binarySha = sha256(outCheck.buffer);
    await fsp.chmod(outPath, 0o500);
    const sourceAfter = await readExactNoFollow(copyPath, source.bytes, SOURCE_MAX_BYTES);
    if (sha256(sourceAfter.buffer) !== SOURCE_SHA256) throw new ToolError("BUILD_FAILED");

    const dirs = await resolveBuildDirs(repoRoot, options.outRoot);
    inventory.push(...(await scanResidues(dirs.arm64)));
    const nonce = crypto.randomBytes(8).toString("hex");
    stage = path.join(dirs.arm64, `.stage-${process.pid}-${nonce}`);
    await fsp.mkdir(stage, { mode: 0o700 });
    const stageStat = await fsp.lstat(stage, { bigint: true });
    if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) throw new ToolError("PATH_UNSAFE");
    if ((await fsp.realpath(stage)) !== stage) throw new ToolError("PATH_UNSAFE");

    const manifest = {
      format: 1,
      status: "candidate",
      buildId: nonce,
      platform: "macos",
      arch: "arm64",
      source: { origin: "pinned", sha256: SOURCE_SHA256, bytes: source.bytes },
      compiler: {
        path: COMPILER_PATH,
        sha256: compiler.sha256,
        version: probeFacts.version,
        target: probeFacts.target,
      },
      args: [...ARGS],
      binary: {
        name: BINARY_NAME,
        sha256: binarySha,
        bytes: outCheck.buffer.length,
        macho: machoFacts(outCheck.buffer),
      },
      signature: { kind: "linker-adhoc", verified: false },
      createdAt: new Date().toISOString(),
    };
    const artifactBuffer = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    if (artifactBuffer.length > ARTIFACT_MAX_BYTES) throw new ToolError("INTERNAL");
    const sumsBuffer = Buffer.from(
      `${binarySha}  ${BINARY_NAME}\n${sha256(artifactBuffer)}  ${ARTIFACT_NAME}\n`,
      "utf8",
    );

    await writeExclusive(path.join(stage, BINARY_NAME), outCheck.buffer, 0o500);
    await writeExclusive(path.join(stage, ARTIFACT_NAME), artifactBuffer, 0o400);
    await writeExclusive(path.join(stage, SUMS_NAME), sumsBuffer, 0o400);
    stageDirFsync = await fsyncDir(stage);

    lock = await acquireLock(path.join(dirs.arm64, LOCK_NAME), "build");
    await dirs.revalidate();
    const target = path.join(dirs.arm64, binarySha);
    const published = await publishCandidate(stage, target, binarySha);

    const stageResult = await removeOwnedDir(stage, STAGE_RE);
    if (stageResult.ok) {
      stage = null;
    } else {
      stageCleanup = "unknown";
      inventory.push({ kind: "stage", path: stage, state: "unknown" });
    }

    if (lock) {
      const released = await releaseLock(lock);
      lock = null;
      if (!released) {
        lockCleanup = "unknown";
        warnings.push("LOCK_RELEASE_UNKNOWN");
        inventory.push({ kind: "lock", path: path.join(dirs.arm64, LOCK_NAME), state: "unknown" });
      }
    }

    const workResult = await removeOwnedDir(workRoot, /^shiguang-launcher-build-/);
    if (workResult.ok) {
      workRoot = null;
    } else {
      workCleanup = "unknown";
      inventory.push({ kind: "tmp", path: workRoot, state: "unknown" });
    }
    const cleanup = stageCleanup === "done" && workCleanup === "done" && lockCleanup === "done"
      ? "done"
      : "unknown";
    if (cleanup === "unknown" && !warnings.includes("TEMP_CLEANUP_UNKNOWN")) {
      warnings.push("TEMP_CLEANUP_UNKNOWN");
    }
    return {
      action: "build",
      changed: published.changed,
      candidate: target,
      sha256: binarySha,
      bytes: outCheck.buffer.length,
      source: { sha256: SOURCE_SHA256, bytes: source.bytes },
      compiler: {
        path: COMPILER_PATH,
        sha256: compiler.sha256,
        version: probeFacts.version,
        target: probeFacts.target,
      },
      dirFsync: stageDirFsync,
      cleanup,
      inventory,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    let toolError =
      error instanceof ToolError
        ? error
        : new ToolError("INTERNAL", { cleanup: "unknown" });
    if (lock) {
      const lockDir = lock.lockDir;
      const released = await releaseLock(lock);
      lock = null;
      if (!released) {
        inventory.push({ kind: "lock", path: lockDir, state: "unknown" });
        toolError = new ToolError("INTERNAL", {
          details: toolError.details,
          cleanup: "unknown",
          inventory: [...toolError.inventory, ...inventory],
          warnings: ["LOCK_RELEASE_UNKNOWN"],
        });
      }
    }
    if (stage) {
      if (toolError.exitCode === 1) {
        stageCleanup = "unknown";
        inventory.push({ kind: "stage", path: stage, state: "unknown" });
      } else {
        const stageResult = await removeOwnedDir(stage, STAGE_RE);
        if (!stageResult.ok) {
          stageCleanup = "unknown";
          inventory.push({ kind: "stage", path: stage, state: "unknown" });
        }
      }
    }
    if (workRoot) {
      if (toolError.exitCode === 1) {
        workCleanup = "unknown";
        inventory.push({ kind: "tmp", path: workRoot, state: "unknown" });
      } else {
        const workResult = await removeOwnedDir(workRoot, /^shiguang-launcher-build-/);
        if (!workResult.ok) {
          workCleanup = "unknown";
          inventory.push({ kind: "tmp", path: workRoot, state: "unknown" });
        }
      }
    }
    const cleanupUnknown = stageCleanup === "unknown" || workCleanup === "unknown";
    throw new ToolError(toolError.code, {
      details: toolError.details,
      cleanup: cleanupUnknown || toolError.cleanup === "unknown" ? "unknown" : toolError.cleanup,
      inventory: [...toolError.inventory, ...inventory],
      warnings: toolError.warnings,
    });
  }
}

async function publishCandidate(stage, target, expectedSha256) {
  let targetStat = await lstatOrNull(target);
  if (targetStat) {
    if (targetStat.isSymbolicLink()) throw new ToolError("PATH_UNSAFE");
    if (!targetStat.isDirectory()) throw new ToolError("TARGET_EXISTS");
    try {
      await verifyCandidateAtPath(target, expectedSha256);
      return { changed: false };
    } catch (error) {
      if (error instanceof ToolError && error.code === "PATH_UNSAFE") throw error;
      throw new ToolError("TARGET_EXISTS");
    }
  }
  let created = false;
  try {
    await fsp.mkdir(target, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errCode(error) !== "EEXIST") throw new ToolError("INTERNAL", { cleanup: "unknown" });
  }
  if (!created) {
    try {
      await verifyCandidateAtPath(target, expectedSha256);
      return { changed: false };
    } catch (error) {
      if (error instanceof ToolError && error.code === "PATH_UNSAFE") throw error;
      throw new ToolError("TARGET_EXISTS");
    }
  }
  const targetIno = (await fsp.lstat(target, { bigint: true })).ino;
  const linked = [];
  let linking = true;
  try {
    for (const name of [BINARY_NAME, ARTIFACT_NAME, SUMS_NAME]) {
      const sourcePath = path.join(stage, name);
      const targetPath = path.join(target, name);
      try {
        await fsp.link(sourcePath, targetPath);
      } catch (error) {
        if (errCode(error) === "EEXIST") {
          throw new ToolError("TARGET_EXISTS");
        }
        throw new ToolError("INTERNAL", { cleanup: "unknown" });
      }
      linked.push(name);
      const sourceStat = await fsp.lstat(sourcePath, { bigint: true });
      const targetMember = await fsp.lstat(targetPath, { bigint: true });
      if (sourceStat.dev !== targetMember.dev || sourceStat.ino !== targetMember.ino) {
        throw new ToolError("INTERNAL", { cleanup: "unknown" });
      }
    }
    linking = false;
    await fsyncDir(target);
    await verifyCandidateAtPath(target, expectedSha256);
    const afterIno = (await fsp.lstat(target, { bigint: true })).ino;
    if (afterIno !== targetIno) throw new ToolError("INTERNAL", { cleanup: "unknown" });
    return { changed: true };
  } catch (error) {
    if (!linking) {
      // 发布后复验失败：目标可能已是他人字节，保留现场，不自动删除。
      throw new ToolError("INTERNAL", {
        cleanup: "unknown",
        inventory: [{ kind: "target", path: target, state: "unknown" }],
      });
    }
    // 仅在成员链接阶段、目标目录 inode 未变且已链接成员全部指向本进程 stage 时回滚。
    // 先只读核验全部成员/目录身份，任一不符则一个成员都不删。
    let canRollback = true;
    try {
      const current = await fsp.lstat(target, { bigint: true });
      if (current.ino !== targetIno || current.isSymbolicLink() || !current.isDirectory()) {
        canRollback = false;
      }
    } catch {
      canRollback = false;
    }
    const verified = [];
    if (canRollback) {
      for (const name of linked) {
        try {
          const sourceStat = await fsp.lstat(path.join(stage, name), { bigint: true });
          const targetStatNow = await fsp.lstat(path.join(target, name), { bigint: true });
          if (sourceStat.dev !== targetStatNow.dev || sourceStat.ino !== targetStatNow.ino) {
            canRollback = false;
            break;
          }
          verified.push(name);
        } catch {
          canRollback = false;
          break;
        }
      }
    }
    if (canRollback && verified.length !== linked.length) canRollback = false;
    if (canRollback) {
      // 删除前再核一次目录身份，避免只读核验与回滚之间目录被替换。
      try {
        const current = await fsp.lstat(target, { bigint: true });
        if (current.ino !== targetIno || current.isSymbolicLink() || !current.isDirectory()) {
          canRollback = false;
        }
      } catch {
        canRollback = false;
      }
    }
    if (canRollback) {
      for (const name of verified) {
        try {
          await fsp.unlink(path.join(target, name));
        } catch {
          canRollback = false;
          break;
        }
      }
    }
    if (canRollback) {
      try {
        await fsp.rmdir(target);
      } catch {
        canRollback = false;
      }
    }
    if (canRollback) throw error instanceof ToolError ? error : new ToolError("INTERNAL");
    throw new ToolError("INTERNAL", {
      cleanup: "unknown",
      inventory: [{ kind: "target", path: target, state: "unknown" }],
    });
  }
}

async function publishFileExclusive(tmpPath, targetPath) {
  try {
    const tmpStat = await fsp.lstat(tmpPath, { bigint: true });
    if (tmpStat.isSymbolicLink() || !tmpStat.isFile()) throw new ToolError("PATH_UNSAFE");
    await fsp.link(tmpPath, targetPath);
    const targetStat = await fsp.lstat(targetPath, { bigint: true });
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new ToolError("PATH_UNSAFE");
    }
    if (tmpStat.dev !== targetStat.dev || tmpStat.ino !== targetStat.ino) {
      throw new ToolError("INTERNAL");
    }
    return { created: true };
  } catch (error) {
    if (errCode(error) === "EEXIST") return { created: false, code: "EEXIST" };
    throw error;
  }
}

async function removeOwnedTmp(tmpPath, identity) {
  // 删除候选 tmp 前必须复核创建时 fstat 得到的 dev/ino；身份缺失或观察失败一律保留。
  if (!identity || typeof identity.dev !== "bigint" || typeof identity.ino !== "bigint") {
    return { ok: false };
  }
  let stat;
  try {
    stat = await fsp.lstat(tmpPath, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return { ok: true, removed: false };
    return { ok: false };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    return { ok: false };
  }
  try {
    await fsp.unlink(tmpPath);
  } catch (error) {
    if (isMissing(error)) return { ok: true, removed: false };
    return { ok: false };
  }
  return { ok: true, removed: true };
}

async function readExistingLauncher(target, expectedSha256) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const stat = await fsp.lstat(target, { bigint: true });
      if (stat.isSymbolicLink()) throw new ToolError("PATH_UNSAFE");
      if (!stat.isFile()) throw new ToolError("TARGET_EXISTS");
      if (stat.size <= 0n || stat.size > BigInt(LAUNCHER_MAX_BYTES)) {
        throw new ToolError("TARGET_EXISTS");
      }
      const snapshot = await readExactNoFollow(target, Number(stat.size), LAUNCHER_MAX_BYTES);
      const mode = modeOf(snapshot.stat);
      const digest = sha256(snapshot.buffer);
      if (digest !== expectedSha256) throw new ToolError("TARGET_EXISTS");
      if (mode !== 0o500) throw new ToolError("TARGET_EXISTS");
      return { ok: true, bytes: snapshot.buffer.length, sha256: digest };
    } catch (error) {
      lastError = error;
      if (error instanceof ToolError && error.code === "PATH_UNSAFE") throw error;
      if (error instanceof ToolError && error.code === "TARGET_EXISTS") throw error;
      if (errCode(error) === "ENOENT") throw new ToolError("TARGET_EXISTS");
      await delay(25);
    }
  }
  if (lastError instanceof ToolError && lastError.code === "PATH_UNSAFE") throw lastError;
  throw new ToolError("TARGET_EXISTS");
}

async function installCommand(options) {
  const repoRoot = await fsp.realpath(REPO_ROOT_RAW);
  const repoStat = await fsp.lstat(repoRoot, { bigint: true });
  if (repoStat.isSymbolicLink() || !repoStat.isDirectory()) throw new ToolError("PATH_UNSAFE");
  const artifact = await readArtifactSnapshot(options.artifact, options.sha256);
  const dirs = await resolveInstallDirs(repoRoot, options.dir);
  const target = path.join(dirs.dir, BINARY_NAME);
  const nonce = crypto.randomBytes(8).toString("hex");
  let tmp = null;
  let tmpCreated = false;
  let tmpIdentity = null;
  let lock = null;
  const inventory = [];
  let changed = false;
  let warnings = [];
  let installDirFsync = "done";

  try {
    lock = await acquireLock(path.join(dirs.dir, LOCK_NAME), "install");
    await dirs.revalidate();
    const existing = await lstatOrNull(target);
    if (existing) {
      if (existing.isSymbolicLink()) throw new ToolError("PATH_UNSAFE");
      if (!existing.isFile()) throw new ToolError("TARGET_EXISTS");
      await readExistingLauncher(target, options.sha256);
      changed = false;
    } else {
      tmp = path.join(dirs.dir, `.audio-executor-launcher.tmp-${process.pid}-${nonce}`);
      await writeExclusive(tmp, artifact.buffer, 0o500, async (handle) => {
        tmpCreated = true;
        // 在创建句柄上记录身份，而不是只记一个布尔；后续任何删除都先复核。
        const created = await handle.stat({ bigint: true });
        tmpIdentity = { dev: created.dev, ino: created.ino };
      });
      const check = await readExactNoFollow(tmp, artifact.bytes, LAUNCHER_MAX_BYTES);
      if (sha256(check.buffer) !== options.sha256 || !checkMachO(check.buffer)) {
        throw new ToolError("INTERNAL");
      }
      let linked;
      try {
        linked = await publishFileExclusive(tmp, target);
      } catch (error) {
        throw error instanceof ToolError ? error : new ToolError("INTERNAL", { cleanup: "unknown" });
      }
      if (linked.created) {
        const targetCheck = await readExactNoFollow(target, artifact.bytes, LAUNCHER_MAX_BYTES);
        if (sha256(targetCheck.buffer) !== options.sha256) {
          throw new ToolError("INTERNAL", { cleanup: "unknown" });
        }
      }
      const tmpResult = await removeOwnedTmp(tmp, tmpIdentity);
      if (!tmpResult.ok) {
        warnings.push("TEMP_CLEANUP_UNKNOWN");
        inventory.push({ kind: "tmp", path: tmp, state: "unknown" });
      }
      tmp = null;
      tmpCreated = false;
      tmpIdentity = null;
      if (linked.created) {
        installDirFsync = await fsyncDir(dirs.dir);
        changed = true;
      } else {
        await readExistingLauncher(target, options.sha256);
        changed = false;
      }
    }
    if (lock) {
      const released = await releaseLock(lock);
      lock = null;
      if (!released) {
        warnings.push("LOCK_RELEASE_UNKNOWN");
        inventory.push({ kind: "lock", path: path.join(dirs.dir, LOCK_NAME), state: "unknown" });
      }
    }
    return {
      action: "install",
      changed,
      path: target,
      sha256: options.sha256,
      bytes: artifact.bytes,
      runtimeConfig: { launcher: { path: target, sha256: options.sha256 } },
      note: "runtime config is not written by this command",
      dirFsync: installDirFsync,
      cleanup: warnings.length > 0 ? "unknown" : "done",
      inventory,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error) {
    let toolError =
      error instanceof ToolError ? error : new ToolError("INTERNAL", { cleanup: "unknown" });
    if (tmp && tmpCreated) {
      const tmpResult = await removeOwnedTmp(tmp, tmpIdentity);
      if (tmpResult.ok) {
        tmp = null;
        tmpCreated = false;
        tmpIdentity = null;
      } else {
        inventory.push({ kind: "tmp", path: tmp, state: "unknown" });
        toolError = new ToolError(toolError.code, {
          details: toolError.details,
          cleanup: "unknown",
          inventory: toolError.inventory,
        });
      }
    }
    if (lock) {
      const released = await releaseLock(lock);
      lock = null;
      if (!released) {
        inventory.push({ kind: "lock", path: path.join(dirs.dir, LOCK_NAME), state: "unknown" });
        toolError = new ToolError("INTERNAL", {
          details: toolError.details,
          cleanup: "unknown",
          inventory: toolError.inventory,
          warnings: [...new Set([...toolError.warnings, "LOCK_RELEASE_UNKNOWN"])],
        });
      }
    }
    throw new ToolError(toolError.code, {
      details: toolError.details,
      cleanup: toolError.cleanup,
      inventory: [...toolError.inventory, ...inventory],
      warnings: toolError.warnings,
    });
  }
}

async function verifyCommand(options) {
  const artifact = await readArtifactSnapshot(options.artifact, options.sha256);
  return {
    action: "verify",
    ok: true,
    path: options.artifact,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    platform: "macos",
    arch: "arm64",
  };
}

function parseArgs(argv) {
  const command = argv[0];
  if (!["build", "verify", "install"].includes(command)) throw new ToolError("USAGE");
  const allowed = {
    build: new Set(["--source", "--out-root", "--json"]),
    verify: new Set(["--artifact", "--sha256", "--json"]),
    install: new Set(["--artifact", "--sha256", "--dir", "--json"]),
  }[command];
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!allowed.has(token)) throw new ToolError("USAGE");
    if (token === "--json") {
      if (values.json) throw new ToolError("USAGE");
      values.json = true;
      continue;
    }
    if (Object.hasOwn(values, token)) throw new ToolError("USAGE");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new ToolError("USAGE");
    values[token] = value;
    index += 1;
  }
  if (command === "verify" || command === "install") {
    if (!values["--artifact"] || !values["--sha256"]) throw new ToolError("USAGE");
    if (!SHA256_RE.test(values["--sha256"])) throw new ToolError("USAGE");
    if (!path.isAbsolute(values["--artifact"])) throw new ToolError("USAGE");
    if (values["--dir"] !== undefined && !path.isAbsolute(values["--dir"])) {
      throw new ToolError("USAGE");
    }
  }
  if (command === "build") {
    if (values["--source"] !== undefined && !path.isAbsolute(values["--source"])) {
      throw new ToolError("USAGE");
    }
    if (values["--out-root"] !== undefined && !path.isAbsolute(values["--out-root"])) {
      throw new ToolError("USAGE");
    }
  }
  return {
    command,
    source: values["--source"],
    outRoot: values["--out-root"],
    artifact: values["--artifact"],
    sha256: values["--sha256"],
    dir: values["--dir"],
  };
}

function assertHost() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new ToolError("UNSUPPORTED_HOST");
  }
}

function failurePayload(error) {
  const toolError =
    error instanceof ToolError ? error : new ToolError("INTERNAL", { cleanup: "unknown" });
  return {
    error: toolError.code,
    message: toolError.message,
    cleanup: toolError.cleanup,
    inventory: toolError.inventory,
    ...(toolError.details ? { details: toolError.details } : {}),
    ...(toolError.warnings.length > 0 ? { warnings: toolError.warnings } : {}),
  };
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.command === "build") {
    assertHost();
    return buildCommand(options);
  }
  if (options.command === "install") {
    assertHost();
    return installCommand(options);
  }
  return verifyCommand(options);
}

async function cli() {
  try {
    const result = await main(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 0;
  } catch (error) {
    const payload = failurePayload(error);
    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = error instanceof ToolError ? error.exitCode : EXIT.INTERNAL;
  }
}

const invokedDirectly =
  process.argv[1] && (await fsp.realpath(process.argv[1]).catch(() => process.argv[1])) === SCRIPT_PATH;
if (invokedDirectly) await cli();

export const __testInternals = {
  runBoundedChild,
  classifySettlement,
  publishFileExclusive,
  parseSha256Sums,
  validateDirChain,
  readSourceSnapshot,
  readArtifactSnapshot,
  verifyCandidateAtPath,
};
