/**
 * T-LOCAL-013A：Mac 本地音频执行器可行性原型（仅隔离测试，不接服务）。
 *
 * 这不是生产执行器，也不宣称沙箱：
 * - 固定命令由调用方给出，生产落地时必须改为发布描述白名单；
 * - 只用 Node 自带能力：shell:false、最小 env、独立进程组、有界输出、wall deadline、取消；
 * - OS 硬限制需配合 fixtures/rlimit-launcher.c 在 exec 前设置，Node 本身不设置 rlimit；
 * - 无 OS 网络隔离；本原型只验证“最小 env + 进程组回收”，不把可信引擎承诺当沙箱。
 */
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KiB = 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_STDOUT_LIMIT = 1 * 1024 * KiB;
const DEFAULT_STDERR_LIMIT = 64 * KiB;
const DEFAULT_TERM_GRACE_MS = 150;
const MAX_METADATA_BYTES = 4 * KiB;
const LEASE_FILE = ".audio-executor.lock";
const JOB_PREFIX = "executor-job-";

/** 子进程只拿这些变量；不继承父进程的 API key、代理、JWT、PYTHONPATH/DYLD 等。 */
const BASE_ENV = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "C",
  LC_ALL: "C",
  BLAS_NUM_THREADS: "1",
  OMP_NUM_THREADS: "1",
  MKL_NUM_THREADS: "1",
  OPENBLAS_NUM_THREADS: "1",
  VECLIB_MAXIMUM_THREADS: "1",
});

export class ExecutorError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = "ExecutorError";
    this.code = code;
  }
}

export class LocalExecutor {
  constructor(dataDir, options = {}) {
    if (typeof dataDir !== "string" || !dataDir) throw new ExecutorError("INVALID_SPEC", "dataDir required");
    this.dataDir = path.resolve(dataDir);
    this.jobsRoot = path.join(this.dataDir, "executor-jobs");
    this.leasePath = path.join(this.dataDir, LEASE_FILE);
    this.graceMs = options.graceMs ?? DEFAULT_TERM_GRACE_MS;
    this.rssSampleMs = options.rssSampleMs ?? 100;
    // 仅实验用：macOS libproc 小型辅助程序；不设置时不做 RSS 采样。
    // 生产不能依赖此二进制，RSS 本身也只是软监督，不是 RLIMIT_AS 硬隔离。
    this.rssHelper = options.rssHelper ? path.resolve(options.rssHelper) : null;
  }

  /**
   * 运行一个合成/受信命令。
   * @param {{command:string,args?:string[],timeoutMs?:number,stdoutLimitBytes?:number,stderrLimitBytes?:number,signal?:AbortSignal,onSpawn?:Function}} spec
   */
  async run(spec) {
    validateSpec(spec);
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const stdoutLimit = spec.stdoutLimitBytes ?? DEFAULT_STDOUT_LIMIT;
    const stderrLimit = spec.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT;
    const token = crypto.randomBytes(16).toString("hex");
    await this.#acquireLease(token, spec.command);

    const jobDir = path.join(this.jobsRoot, `${JOB_PREFIX}${process.pid}-${token}`);
    const workDir = path.join(jobDir, "work");
    const homeDir = path.join(jobDir, "home");
    const tmpDir = path.join(jobDir, "tmp");
    let child = null;
    let pgid = null;
    let timeoutTimer = null;
    let killTimer = null;
    let rssTimer = null;
    let termination = null;
    let terminationAt = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutChunks = [];
    let stderrChunks = [];
    let rssMaxKb = 0;
    let rssSamples = 0;
    let spawnError = null;
    let onAbort = null;
    let exitCode = null;
    let exitSignal = null;
    let startedAt = 0;
    let closedAt = 0;

    try {
      await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(homeDir, { recursive: true, mode: 0o700 });
      await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });

      const env = {
        ...BASE_ENV,
        HOME: homeDir,
        TMPDIR: tmpDir,
        TMP: tmpDir,
        TEMP: tmpDir,
      };

      startedAt = nowMs();
      child = spawn(spec.command, spec.args ?? [], {
        cwd: workDir,
        env,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      pgid = child.pid;

      // 必须在任何可能抛错/回调之前挂上 error/close：
      // ENOENT/EACCES 的 'error' 是下一个 tick 异步发出的，晚挂监听会变成未处理事件并终止宿主。
      // closePromise 只在 'close' 时 resolve；'error' 只记录 spawnError，失败路径也真正等到 close。
      const closePromise = new Promise((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
        child.once("error", (error) => {
          spawnError = error;
        });
      });

      const requestTermination = (reason) => {
        if (termination) return;
        if (!Number.isSafeInteger(pgid) || pgid <= 0) {
          // 进程未建立（spawn 失败）：没有可终止的组，等 'close' 收尾即可。
          termination = reason;
          terminationAt = nowMs();
          return;
        }
        termination = reason;
        terminationAt = nowMs();
        killGroup(pgid, "SIGTERM");
        killTimer = setTimeout(() => {
          if (groupAlive(pgid)) killGroup(pgid, "SIGKILL");
        }, this.graceMs);
        if (typeof killTimer.unref === "function") killTimer.unref();
      };

      // 先挂输出/超时，再执行外部 onSpawn：回调抛错时也已有完整清理链路。
      timeoutTimer = setTimeout(() => requestTermination("timeout"), timeoutMs);
      onAbort = () => requestTermination("cancelled");
      if (spec.signal) {
        if (spec.signal.aborted) onAbort();
        else spec.signal.addEventListener("abort", onAbort, { once: true });
        // 清理在 finally 里通过 removeEventListener 完成（保留引用）。
      }

      child.stdout?.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        stdoutChunks = appendBounded(stdoutChunks, chunk, stdoutLimit);
        if (stdoutBytes > stdoutLimit) requestTermination("stdout-limit");
      });
      child.stderr?.on("data", (chunk) => {
        stderrBytes += chunk.length;
        stderrChunks = appendBounded(stderrChunks, chunk, stderrLimit);
        if (stderrBytes > stderrLimit) requestTermination("stderr-limit");
      });

      if (this.rssHelper && Number.isSafeInteger(pgid) && pgid > 0) {
        rssTimer = setInterval(() => {
          if (!child || child.exitCode !== null || child.signalCode !== null) return;
          execFileAsync(this.rssHelper, [String(pgid)], { timeout: 500 })
            .then(({ stdout }) => {
              const value = Number.parseInt(String(stdout).trim(), 10);
              if (Number.isSafeInteger(value) && value > 0) {
                rssSamples += 1;
                if (value > rssMaxKb) rssMaxKb = value;
              }
            })
            .catch(() => {});
        }, this.rssSampleMs);
      }
      if (rssTimer && typeof rssTimer.unref === "function") rssTimer.unref();

      if (!Number.isSafeInteger(pgid) || pgid <= 0) {
        // spawn 失败（pid 未建立）：不在这里 throw，交给 close 后的 classify 归一为 spawn-error。
      } else {
        try {
          spec.onSpawn?.({ pid: pgid, jobDir, workDir, homeDir, tmpDir });
        } catch {
          // 外部回调异常也走受控失败：终止进程组、等 close，再抛固定码；finally 仍清理租约/临时目录。
          requestTermination("on-spawn-failed");
          await closePromise;
          throw new ExecutorError("SPAWN_CALLBACK_FAILED", "onSpawn callback failed");
        }
      }

      const closed = await closePromise;
      if ((!Number.isSafeInteger(pgid) || pgid <= 0) && !spawnError) {
        spawnError = new Error("spawn failed without pid");
      }
      closedAt = nowMs();
      exitCode = closed.code;
      exitSignal = closed.signal;
      if (spec.signal) spec.signal.removeEventListener("abort", onAbort);

      // close 后回收同组残余（孙进程/忽略 TERM 的进程）；这是“完整进程组回收”的关键。
      let leftoverPids = [];
      if (Number.isSafeInteger(pgid) && pgid > 0) {
        if (groupAlive(pgid)) killGroup(pgid, "SIGKILL");
        leftoverPids = await waitForGroupGone(pgid, 1500);
      }

      const state = classify({
        termination,
        spawnError,
        exitCode,
        exitSignal,
      });

      const result = {
        state,
        termination,
        exitCode,
        exitSignal,
        durationMs: Math.round(closedAt - startedAt),
        cancelToCloseMs: terminationAt ? Math.round(closedAt - terminationAt) : null,
        stdoutBytes,
        stderrBytes,
        outputLimit: termination === "stdout-limit" || termination === "stderr-limit" ? termination : null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        rssMaxKb: rssMaxKb || null,
        rssSamples,
        groupReaped: leftoverPids.length === 0,
        leftoverPids,
        pid: Number.isSafeInteger(pgid) && pgid > 0 ? pgid : null,
      };
      return result;
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (rssTimer) clearInterval(rssTimer);
      if (spec.signal && onAbort) spec.signal.removeEventListener("abort", onAbort);
      if (Number.isSafeInteger(pgid) && pgid > 0) {
        if (groupAlive(pgid)) {
          killGroup(pgid, "SIGKILL");
          await waitForGroupGone(pgid, 1000);
        }
      }
      if (child && child.stdout && !child.stdout.destroyed) child.stdout.destroy();
      if (child && child.stderr && !child.stderr.destroyed) child.stderr.destroy();
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      await this.#releaseLease(token).catch(() => {});
    }
  }

  async #acquireLease(token, command) {
    await fs.mkdir(this.dataDir, { recursive: true });
    let handle;
    try {
      handle = await fs.open(this.leasePath, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, commandBasename: path.basename(command), startedAt: new Date().toISOString() }),
      );
    } catch (error) {
      if (error.code === "EEXIST") {
        // 与 T12 锁策略一致：已存在的租约一律 BUSY，不在运行期按时间/pid 自动回收。
        throw new ExecutorError("EXECUTION_BUSY", "another execution lease is present");
      }
      throw new ExecutorError("EXECUTION_UNAVAILABLE", "cannot create execution lease");
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  async #releaseLease(token) {
    let stat;
    try {
      stat = await fs.lstat(this.leasePath);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_METADATA_BYTES) return;
    let parsed = null;
    try {
      parsed = JSON.parse(await fs.readFile(this.leasePath, "utf8"));
    } catch {
      return;
    }
    if (!parsed || parsed.token !== token) return;
    await fs.unlink(this.leasePath).catch(() => {});
  }
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") throw new ExecutorError("INVALID_SPEC", "spec required");
  if (typeof spec.command !== "string" || !path.isAbsolute(spec.command)) {
    throw new ExecutorError("INVALID_SPEC", "command must be an absolute path");
  }
  if (spec.args !== undefined && (!Array.isArray(spec.args) || spec.args.some((a) => typeof a !== "string"))) {
    throw new ExecutorError("INVALID_SPEC", "args must be string[]");
  }
  for (const [key, value] of [
    ["timeoutMs", spec.timeoutMs],
    ["stdoutLimitBytes", spec.stdoutLimitBytes],
    ["stderrLimitBytes", spec.stderrLimitBytes],
  ]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new ExecutorError("INVALID_SPEC", `${key} must be a positive integer`);
    }
  }
}

function appendBounded(chunks, chunk, limit) {
  const used = chunks.reduce((sum, item) => sum + item.length, 0);
  if (used >= limit) return chunks;
  const remaining = limit - used;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return chunks;
}

function killGroup(pgid, signal) {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function listProcessGroup(pgid) {
  // 沙箱可能禁止 /bin/ps；/usr/bin/pgrep -g 只按进程组列出 pid，够用于“组是否清空”的判断。
  try {
    const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-g", String(pgid)], { timeout: 1000 });
    return String(stdout)
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch (error) {
    if (error.code === 1) return []; // pgrep：无匹配
    return groupAlive(pgid) ? [-1] : [];
  }
}

async function waitForGroupGone(pgid, timeoutMs) {
  const deadline = nowMs() + timeoutMs;
  let pids = await listProcessGroup(pgid);
  while (pids.length > 0 && nowMs() < deadline) {
    killGroup(pgid, "SIGKILL");
    await delay(25);
    pids = await listProcessGroup(pgid);
  }
  return pids;
}

function classify({ termination, spawnError, exitCode, exitSignal }) {
  if (spawnError) return "spawn-error";
  if (termination === "timeout") return "timeout";
  if (termination === "cancelled") return "cancelled";
  if (termination === "stdout-limit" || termination === "stderr-limit") return termination;
  if (exitSignal === "SIGXCPU" || exitSignal === "SIGXFSZ") return "resource-limit";
  if (exitCode === 0) return "success";
  return "nonzero";
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
