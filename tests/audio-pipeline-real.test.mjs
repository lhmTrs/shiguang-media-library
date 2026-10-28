/**
 * T-LOCAL-013I 组合测试：真实 AudioEngine 运行租约 + 真实 AudioExecutor
 * + 临时 SQLite 结果库 + 现有 pipeline。引擎二进制由本测试合成，经真实
 * 安全安装器（回环 TLS、临时归档）装入临时 dataDir；不运行发行引擎。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AudioEngine } from "../server/audio-engine.mjs";
import { AudioExecutor, createAudioExecutorLauncherConfig } from "../server/audio-executor.mjs";
import { AudioResultStore } from "../server/audio-result-store.mjs";
import { AudioAnalysisPipeline } from "../server/audio-analysis-pipeline.mjs";
import {
  assertErrorEvidence,
  assertEvidenceV1,
  assertSuccessGate,
  summarizeEvidence,
} from "./t13i-protocol-evidence/evidence-contract.mjs";
import {
  delay,
  makeRelease,
  makeTar,
  makeTlsFixture,
  startTlsServer,
  tempDir,
  waitForJob,
} from "./audio-engine-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const LAUNCHER_C = path.join(PROJECT, "server", "native", "audio-executor-launcher.c");
const CLANG = "/usr/bin/clang";
const NODE = process.execPath;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function compileLauncher(outDir) {
  if (!fssync.existsSync(CLANG) || !fssync.existsSync(LAUNCHER_C)) {
    return { ok: false, reason: "clang 或 launcher 源码不存在" };
  }
  const out = path.join(outDir, "audio-executor-launcher");
  const result = spawnSync(CLANG, ["-O2", "-Wall", "-Wextra", "-o", out, LAUNCHER_C], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: `clang 编译失败：${result.error?.message || result.stderr}` };
  }
  fssync.chmodSync(out, 0o700);
  return { ok: true, path: out };
}

const buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-real-build-")));
const launcherBuild = compileLauncher(buildRoot);
const skipAll = launcherBuild.ok ? false : launcherBuild.reason;
after(async () => {
  await fs.rm(buildRoot, { recursive: true, force: true }).catch(() => {});
});

function rawSuccess(over = {}) {
  return JSON.stringify({
    bpm: 126.5,
    key: { best: "C major", r: 0.81 },
    loud: { peak: -1.2, rms: -14.7 },
    energy: { min: -39.4, max: -2.1, std: 5.8 },
    fit: { beat: 0.88, tonal: 0.79, chord: 0.63 },
    seg: [0.2, 0.7],
    ...over,
  });
}

function makeEngineBinary(root, mode) {
  const file = path.join(root, `engine-${mode}-${crypto.randomBytes(4).toString("hex")}.mjs`);
  const source = [
    `#!${NODE}`,
    `const mode = ${JSON.stringify(mode)};`,
    `const success = ${JSON.stringify(rawSuccess())};`,
    'switch (mode) {',
    '  case "success": process.stdout.write(success); break;',
    '  case "cleanup-fail": { process.stdout.write(success); const fsm = await import("node:fs"); fsm.chmodSync("..", 0o500); break; }',
    '  case "nonzero": process.stderr.write("synthetic engine failure\\n"); process.exitCode = 7; break;',
    '  case "sleep": setInterval(() => {}, 60000); break;',
    '  case "flood": { const chunk = Buffer.alloc(4096, "x"); setInterval(() => { for (let i = 0; i < 8; i += 1) process.stdout.write(chunk); }, 5); setInterval(() => {}, 60000); break; }',
    '  default: process.exitCode = 64;',
    '}',
    "",
  ].join("\n");
  fssync.writeFileSync(file, source, { mode: 0o700 });
  fssync.chmodSync(file, 0o700);
  return file;
}

function posixNonRoot() {
  return (
    (process.platform === "darwin" || process.platform === "linux") &&
    typeof process.geteuid === "function" &&
    process.geteuid() !== 0
  );
}

function countLauncherProcesses(launcherPath) {
  const observed = observeOwnedProcesses([launcherPath]);
  return observed.state === "unknown" ? null : observed.count;
}

/**
 * 进程观察只匹配本轮已知的自有 fixture/root 绝对路径（launcher、合成 engine、
 * 独占 root），不扫未知 PID、不杀进程。ps 失败才退回 pgrep 精确匹配；两条
 * 路径都失败时返回 unknown，由调用方保留现场，绝不把 unknown 当 0。
 */
function observeOwnedProcesses(paths) {
  const needles = [...new Set(paths.filter((value) => typeof value === "string" && value.length > 0))];
  if (needles.length === 0) return { state: "not-created", count: 0 };
  if (fssync.existsSync("/bin/ps")) {
    const result = spawnSync("/bin/ps", ["-axo", "command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
    });
    if (!result.error && result.status === 0 && typeof result.stdout === "string") {
      const count = result.stdout
        .split("\n")
        .filter((line) => needles.some((needle) => line.includes(needle))).length;
      return { state: count === 0 ? "zero" : "nonzero", count };
    }
  }
  if (fssync.existsSync("/usr/bin/pgrep")) {
    let count = 0;
    for (const needle of needles) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const result = spawnSync("/usr/bin/pgrep", ["-f", "--", escaped], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      });
      if (result.error) return { state: "unknown", count: null };
      if (result.status === 1) continue;
      if (result.status === 0 && typeof result.stdout === "string") {
        count += result.stdout.split("\n").filter(Boolean).length;
      } else {
        return { state: "unknown", count: null };
      }
    }
    return { state: count === 0 ? "zero" : "nonzero", count };
  }
  return { state: "unknown", count: null };
}

function bounded(ms, fn) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("BOUNDED")), ms);
  });
  return Promise.race([Promise.resolve().then(fn), timeout]).finally(() => clearTimeout(timer));
}

async function listJobDirs(jobsRoot, io = fs) {
  const entries = await io.readdir(jobsRoot);
  return entries.filter((name) => name.startsWith("job-")).map((name) => path.join(jobsRoot, name));
}

/** 只有明确 ENOENT 才是 absent；EACCES/EPERM/EIO 等一律 unknown。 */
function absentOrUnknown(error) {
  return error?.code === "ENOENT" ? "absent" : "unknown";
}

async function observe(io, operation) {
  try {
    return { state: "present", value: await operation() };
  } catch (error) {
    return { state: absentOrUnknown(error), error };
  }
}

/** root 内包含关系必须按路径分量判断，不能只看 realpath 相等。 */
function containedBy(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** 只接受本用户所有的真实目录；符号链接/外部 uid 一律否。 */
function ownedDirectory(stat) {
  return (
    !stat.isSymbolicLink() &&
    stat.isDirectory() &&
    (typeof process.geteuid !== "function" || stat.uid === process.geteuid())
  );
}

/**
 * 测试侧独占清理协调器。root 只由本协调器创建，不经过共享 tempDir，
 * 因此共享 after hook 不持有该 root 的删除路径。
 *
 * 唯一顺序：root 分配/身份采集（allocated→verified）→ 先核 root dev/ino/
 * 非 symlink/owner 与 data/audio-executor/jobs 每层祖先的完整包含关系 →
 * restore 自有 job 权限 → 有界 await pipeline/executor/engine → TLS 实际
 * close 事件 → 2-4 settled 后 close DB → 观察门（已知自有路径的进程计数 +
 * executor/engine/evidence 退出事实）→ 仅 removalAllowed 且无 errors 才 rm
 * → inventory。任何 EACCES/观察失败都是 unknown：只做安全非破坏关闭，保留
 * 现场（含恢复权限后的 job），并以固定步骤标签失败；未验证分配绝不删除。
 */
function createOwnedCleanup(t, options = {}) {
  const io = options.fs ?? fs;
  const waitMs = options.boundedMs ?? 5000;
  const state = {
    // 分配与验证分开：mkdtemp 成功后立即记录 allocated；只有 realpath 与
    // 身份采集都成功才升级为 verified root，绝不让未验证路径进入删除捷径。
    allocated: null,
    ownership: "none",
    root: null,
    rootIdentity: null,
    server: null,
    engine: null,
    executor: null,
    db: null,
    pipeline: null,
    launcherPath: null,
    evidence: null,
  };
  const ownedPaths = new Set();
  const serverSockets = new Set();
  let serverClose = null;
  let finished = null;
  let preserveRequested = null;
  let inventory = null;

  const api = {
    track(key, value) {
      if (value === undefined || value === null) return;
      if (key === "server") {
        state.server = value;
        if (!serverClose && typeof value.once === "function") {
          serverClose = new Promise((resolve) => value.once("close", () => resolve(true)));
        }
        if (typeof value.on === "function") {
          value.on("connection", (socket) => {
            serverSockets.add(socket);
            socket.once("close", () => serverSockets.delete(socket));
          });
        }
        return;
      }
      state[key] = value;
      if (key === "launcherPath" || key === "enginePath") ownedPaths.add(value);
    },
    async createRoot(prefix) {
      const allocated = await io.mkdtemp(path.join(os.tmpdir(), prefix));
      state.allocated = allocated;
      state.ownership = "unverified";
      try {
        const allocatedStat = await io.lstat(allocated);
        if (!ownedDirectory(allocatedStat)) throw new Error("ROOT_NOT_OWNED_DIRECTORY");
        const real = await io.realpath(allocated);
        const realStat = await io.lstat(real);
        if (!ownedDirectory(realStat)) throw new Error("ROOT_NOT_OWNED_DIRECTORY");
        if (realStat.dev !== allocatedStat.dev || realStat.ino !== allocatedStat.ino) {
          throw new Error("ROOT_IDENTITY_CHANGED");
        }
        state.root = real;
        state.rootIdentity = Object.freeze({ dev: realStat.dev, ino: realStat.ino });
        state.ownership = "verified";
        ownedPaths.add(real);
        return real;
      } catch (error) {
        // 保留 allocated 现场，标为未验证；finish 必须失败且不 chmod/rm。
        const failure = new AggregateError(
          [new Error("root.unverified")],
          `owned-cleanup:root.unverified:${error?.code ?? "error"}`,
        );
        throw failure;
      }
    },
    requestPreserve(reason) {
      preserveRequested = reason;
    },
    get inventory() {
      return inventory;
    },
    finish() {
      if (!finished) finished = run();
      return finished;
    },
  };

  async function run() {
    const inv = {
      ownedLauncherProcesses: "unknown",
      ownedProcesses: "unknown",
      componentExit: "unknown",
      retainedJobDirs: 0,
      restoredMode: "0700",
      tlsClose: state.server ? "unknown" : "not-created",
      dbClosed: false,
      disposeErrors: 0,
      removalAllowed: false,
      rootAbsent: "unknown",
      jobDirsAfterRm: 0,
      mode0500After: 0,
      tmpRootsLeft: 0,
      preservedRoot: false,
      rootOwnership: state.ownership,
      ancestorContainment: "unknown",
      rootReverify: "not-run",
    };
    const root = state.root;
    const unverified = state.ownership === "unverified";
    // 分配成功但 realpath/身份采集失败：不得当作 not-created，也不得 chmod/rm
    // 未验证路径；但已 track 的自有组件/TLS/DB 仍必须走步骤 2-7 的有界非破坏
    // 关闭，不能因保留目录而跳过关闭已有资源（例如已监听的 loopback server）。
    if (unverified) {
      inv.rootOwnership = "unverified";
      inv.ancestorContainment = "unknown";
      inv.retainedJobDirs = "unknown";
      inv.restoredMode = "unknown";
      inv.rootAbsent = "unknown";
      inv.preservedRoot = true;
      inv.tmpRootsLeft = "unknown";
      inv.jobDirsAfterRm = "unknown";
      inv.mode0500After = "unknown";
    }
    if (!root && !unverified) {
      inv.removalAllowed = true;
      inv.rootAbsent = "not-created";
      inv.rootOwnership = "none";
      inv.ancestorContainment = "not-created";
      inv.dbClosed = !state.db;
      inv.componentExit = "not-created";
      inv.ownedProcesses = "not-created";
      inv.ownedLauncherProcesses = "not-created";
      inventory = Object.freeze(inv);
      return;
    }
    const errors = [];
    const label = (value) => {
      errors.push(value);
    };
    let restoreOk = true;
    let shutdownUnknown = false;
    let componentsSettled = true;
    let dbClosed = false;

    // 0. root/祖先身份与包含关系必须先于任何 chmod/rm：root 必须是已验证
    // dev/ino、非 symlink、本用户目录；data/audio-executor/jobs 每层都不得是
    // symlink，且 realpath 与词法路径一致、按分量包含在 root 内。jobsRoot 的
    // realpath 等于 job 的 parent 只证明两者相同，不能证明包含关系。
    async function verifyRootChain() {
      const jobsRoot = path.join(root, "data", "audio-executor", "jobs");
      const rootObs = await observe(io, () => io.lstat(root));
      if (rootObs.state !== "present") {
        return {
          state: rootObs.state,
          label: rootObs.state === "unknown" ? "root.observe" : null,
          jobsRoot,
          jobsState: rootObs.state,
        };
      }
      if (!ownedDirectory(rootObs.value)) {
        return { state: "foreign", label: "root.identity", jobsRoot, jobsState: "foreign" };
      }
      if (
        rootObs.value.dev !== state.rootIdentity.dev ||
        rootObs.value.ino !== state.rootIdentity.ino
      ) {
        return { state: "foreign", label: "root.identity", jobsRoot, jobsState: "foreign" };
      }
      let target = root;
      for (const rel of ["data", "audio-executor", "jobs"]) {
        target = path.join(target, rel);
        const obs = await observe(io, () => io.lstat(target));
        if (obs.state === "absent") {
          return { state: "verified", jobsRoot, jobsState: "absent" };
        }
        if (obs.state === "unknown") {
          return { state: "unknown", label: "ancestor.observe", jobsRoot, jobsState: "unknown" };
        }
        if (!ownedDirectory(obs.value) || !containedBy(root, target)) {
          return { state: "foreign", label: "ancestor.containment", jobsRoot, jobsState: "foreign" };
        }
        const realObs = await observe(io, () => io.realpath(target));
        if (realObs.state !== "present" || realObs.value !== target) {
          return {
            state: realObs.state === "unknown" ? "unknown" : "foreign",
            label: realObs.state === "unknown" ? "ancestor.observe" : "ancestor.containment",
            jobsRoot,
            jobsState: realObs.state === "unknown" ? "unknown" : "foreign",
          };
        }
      }
      return { state: "verified", jobsRoot, jobsState: "verified" };
    }

    let chain = {
      state: "unknown",
      jobsState: "unknown",
      jobsRoot: root ? path.join(root, "data", "audio-executor", "jobs") : null,
      label: unverified ? "root.unverified" : "root.observe",
    };
    if (unverified) {
      // 未验证 root 不进入任何 chmod/readdir/rm 分支，只保留现场并失败。
      restoreOk = false;
      label("root.unverified");
    } else {
      chain = await verifyRootChain();
      inv.ancestorContainment =
        chain.state === "verified"
          ? "verified"
          : chain.state === "absent"
            ? "not-created"
            : chain.state === "foreign"
              ? "foreign"
              : "unknown";
      if (chain.state === "unknown" || chain.state === "foreign") {
        restoreOk = false;
        label(chain.label);
      }
    }

    // 1. restore：只在 root 与祖先已验证时枚举 jobs 下一层自有 job-*。
    const jobsRoot = chain.jobsRoot;
    let jobNames = [];
    let retainedKnown = false;
    if (chain.state === "verified" && chain.jobsState === "verified") {
      const readObs = await observe(io, () => io.readdir(jobsRoot));
      if (readObs.state === "present") {
        jobNames = readObs.value.filter((name) => name.startsWith("job-"));
        retainedKnown = true;
      } else if (readObs.state === "absent") {
        jobNames = [];
        retainedKnown = true;
      } else {
        restoreOk = false;
        label("jobs.readdir");
      }
    } else if (
      chain.state === "verified" ||
      (chain.state === "absent" && chain.jobsState === "absent")
    ) {
      jobNames = [];
      retainedKnown = true;
    }
    inv.retainedJobDirs = retainedKnown ? jobNames.length : "unknown";
    for (const name of jobNames) {
      const dir = path.join(jobsRoot, name);
      const statObs = await observe(io, () => io.lstat(dir));
      if (statObs.state === "absent") continue;
      if (statObs.state === "unknown") {
        restoreOk = false;
        label("job.lstat");
        continue;
      }
      const realObs = await observe(io, () => io.realpath(dir));
      const own =
        ownedDirectory(statObs.value) &&
        realObs.state === "present" &&
        realObs.value === dir &&
        path.dirname(dir) === jobsRoot &&
        containedBy(root, dir);
      if (!own) {
        restoreOk = false;
        label(realObs.state === "unknown" ? "job.parent" : "job.ownership");
        continue;
      }
      try {
        await io.chmod(dir, 0o700);
      } catch {
        restoreOk = false;
        label("job.restore");
      }
    }
    inv.restoredMode =
      chain.state === "absent" ? "not-created" : restoreOk && chain.state === "verified" ? "0700" : "unknown";

    // 2-4. 有界、有序关闭自有组件；超时只算 unknown，不冒充已回收。
    for (const [key, labelName] of [
      ["pipeline", "pipeline.dispose"],
      ["executor", "executor.dispose"],
      ["engine", "engine.dispose"],
    ]) {
      const component = state[key];
      if (!component) continue;
      try {
        await bounded(waitMs, () => component.dispose());
      } catch {
        label(labelName);
        shutdownUnknown = true;
        componentsSettled = false;
      }
    }

    // 5. loopback TLS：non-listening 不等于 close 完成。close() 只发起关闭；
    // 有界等待真实 close 事件，并在等待期间反复关闭自有连接（覆盖连接尚未
    // 被 accept 的窗口）。超时/无事件=unknown，保现场。
    if (state.server) {
      let tlsClose = "unknown";
      try {
        const closeEvent =
          serverClose ??
          new Promise((resolve) => {
            if (typeof state.server.once === "function") state.server.once("close", () => resolve(true));
          });
        try {
          state.server.close();
        } catch {
          /* 已关闭/关闭中由 close 事件裁决 */
        }
        const deadline = Date.now() + waitMs;
        let closed = false;
        for (;;) {
          for (const socket of serverSockets) {
            try {
              socket.destroy();
            } catch {
              /* close 事件裁决 */
            }
          }
          // net.Server 没有 closeAllConnections；只按本用例 server 身份从当前
          // Node 活动句柄中关闭自有连接，不扫描 PID/进程表。
          if (typeof process._getActiveHandles === "function") {
            for (const handle of process._getActiveHandles()) {
              if (handle && handle !== state.server && (handle.server === state.server || handle._server === state.server)) {
                try {
                  handle.destroy();
                } catch {
                  /* close 事件裁决 */
                }
              }
            }
          }
          try {
            state.server.closeAllConnections?.();
          } catch {
            /* 事件仍是唯一 closed 依据 */
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          let timer;
          const tick = new Promise((resolve) => {
            timer = setTimeout(() => resolve(false), Math.min(50, remaining));
          });
          closed = await Promise.race([closeEvent.then(() => true), tick]).finally(() => clearTimeout(timer));
          if (closed) break;
        }
        if (closed === true) {
          tlsClose = "closed";
        } else {
          label("tls.close");
          shutdownUnknown = true;
        }
      } catch {
        label("tls.close");
        shutdownUnknown = true;
      }
      inv.tlsClose = tlsClose;
    }

    // 6. 2-4 全部 settled 后才关闭临时 DB。
    if (componentsSettled && state.db) {
      try {
        if (state.db.open) state.db.close();
        dbClosed = true;
      } catch {
        label("db.close");
        shutdownUnknown = true;
        dbClosed = false;
      }
    } else if (componentsSettled && !state.db) {
      dbClosed = true;
    }
    inv.dbClosed = dbClosed;

    // 6b. 停机 await 阶段不能让 dispose 前的旧 root 身份永久授权删除：临破坏性
    // rm 前重新核对原 root 的 dev/ino 与真实祖先/包含身份。变更/未知一律保留
    // 原 root 与替身两现场并失败，绝不删除同路径上的替身 sentinel。只闭合实际
    // await 间隙的有界检查，不声称抵御任意恶意竞态或通用 OS 沙箱。
    if (!unverified) {
      const postChain = await verifyRootChain();
      inv.rootReverify = postChain.state;
      if (postChain.state === "verified") {
        inv.ancestorContainment = "verified";
      } else {
        chain = postChain;
        restoreOk = false;
        inv.ancestorContainment =
          postChain.state === "absent"
            ? "not-created"
            : postChain.state === "foreign"
              ? "foreign"
              : "unknown";
        if (postChain.state !== "absent") label(postChain.label ?? "root.reverify");
      }
    }

    // 7. 观察门：已知自有路径的进程计数 + 组件/证据退出事实。
    const processObs = observeOwnedProcesses([...ownedPaths]);
    inv.ownedProcesses = processObs.state;
    inv.ownedLauncherProcesses =
      processObs.state === "unknown" || processObs.state === "not-created" ? processObs.state : processObs.count;
    if (processObs.state === "unknown") label("process.observe");
    if (processObs.state === "nonzero") label("process.leftover");

    let componentOk = true;
    if (state.executor) {
      try {
        if (state.executor.busy !== false) {
          componentOk = false;
          label("executor.busy");
        }
      } catch {
        componentOk = false;
        label("executor.observe");
      }
    }
    if (state.engine) {
      try {
        const jobState = state.engine.status()?.job?.state ?? null;
        if (![null, "installed", "cancelled", "failed"].includes(jobState)) {
          componentOk = false;
          label("engine.job");
        }
      } catch {
        componentOk = false;
        label("engine.observe");
      }
    }
    if (state.evidence) {
      try {
        if (state.evidence.group?.state !== "reclaimed" || state.evidence.child?.closeSettled !== true) {
          componentOk = false;
          label("evidence.exit");
        }
      } catch {
        componentOk = false;
        label("evidence.observe");
      }
    }
    inv.componentExit = componentOk && componentsSettled ? "confirmed" : "unknown";

    const processOk = processObs.state === "zero" || processObs.state === "not-created";
    const rootGateOk = !unverified && (chain.state === "verified" || chain.state === "absent");
    const removalAllowed =
      rootGateOk &&
      restoreOk &&
      componentsSettled &&
      !shutdownUnknown &&
      errors.length === 0 &&
      processOk &&
      componentOk &&
      preserveRequested === null;
    inv.removalAllowed = removalAllowed;
    inv.disposeErrors = errors.length;

    // 8. 仅 root/祖先两次验证都通过且 removalAllowed 才删除本用例自有 root；
    // root 事先 ENOENT 时无需删除，也绝不从 allocated 旧路径反推。
    if (removalAllowed && chain.state === "verified") {
      try {
        await io.rm(root, { recursive: true, force: true });
      } catch {
        label("root.rm");
        inv.removalAllowed = false;
      }
    } else if (!removalAllowed) {
      label("preserved-root");
    }

    // 9. 清理后 inventory；只输出字段值/状态，不输出路径/PID/命令行/token。
    // 未验证分配只观察 allocated 原路径，不 readdir 未验证根下的 jobs。
    const observedRoot = unverified ? state.allocated : root;
    const remainsObs = await observe(io, () => io.lstat(observedRoot));
    if (!unverified && remainsObs.state === "absent") {
      inv.rootAbsent = true;
      inv.jobDirsAfterRm = 0;
      inv.mode0500After = 0;
      inv.tmpRootsLeft = 0;
    } else if (remainsObs.state === "unknown") {
      inv.rootAbsent = "unknown";
      inv.tmpRootsLeft = "unknown";
      inv.jobDirsAfterRm = "unknown";
      inv.mode0500After = "unknown";
      label("root.observe");
    } else if (unverified) {
      inv.rootAbsent = false;
      inv.tmpRootsLeft = 1;
      inv.jobDirsAfterRm = "unknown";
      inv.mode0500After = "unknown";
    } else {
      inv.rootAbsent = false;
      inv.tmpRootsLeft = 1;
      const listObs = await observe(io, () => io.readdir(jobsRoot));
      let left = [];
      if (listObs.state === "present") {
        left = listObs.value.filter((name) => name.startsWith("job-"));
        inv.jobDirsAfterRm = left.length;
      } else if (listObs.state === "absent") {
        inv.jobDirsAfterRm = 0;
      } else {
        inv.jobDirsAfterRm = "unknown";
        label("jobDirs.observe");
      }
      let modeUnknown = false;
      let mode0500 = 0;
      for (const name of left) {
        const statObs = await observe(io, () => io.lstat(path.join(jobsRoot, name)));
        if (statObs.state === "present") {
          if ((statObs.value.mode & 0o777) === 0o500) mode0500 += 1;
        } else if (statObs.state === "unknown") {
          modeUnknown = true;
          label("jobDirs.lstat");
        }
      }
      inv.mode0500After = modeUnknown ? "unknown" : mode0500;
    }
    inv.preservedRoot = inv.rootAbsent === false || inv.rootAbsent === "unknown";
    inv.disposeErrors = errors.length;
    inventory = Object.freeze(inv);

    if (errors.length > 0) {
      throw new AggregateError(
        errors.map((item) => new Error(item)),
        `owned-cleanup:${errors.join(",")}`,
      );
    }
  }

  if (options.autoAfter !== false) {
    t.after(async () => {
      await api.finish();
    });
  }
  return api;
}

async function installEngine(t, mode, overrides = {}) {
  const cleanup = overrides.cleanup;
  const root = cleanup ? await cleanup.createRoot("t13i-real-") : await tempDir(t, "t13i-real-");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const binary = await makeEngineBinary(root, mode);
  const archive = await makeTar([{ name: "audio-analyze", data: await fs.readFile(binary), mode: 0o755 }]);
  const tls = await makeTlsFixture(t);
  const server = await startTlsServer(t, tls, async (req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    res.end(archive);
  });
  if (cleanup) {
    // startTlsServer 返回 {server, counts, url}；清理协调器必须持有真实句柄。
    cleanup.track("server", server.server);
    cleanup.track("launcherPath", launcherBuild.path);
  }
  const release = makeRelease(archive, server.url, { version: "1.0.0-t13i" });
  const engine = new AudioEngine(dataDir, {
    release,
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    idleTimeoutMs: 1000,
    totalTimeoutMs: 5000,
    diskFreeBytes: 1024 * 1024 * 1024,
  });
  if (cleanup) cleanup.track("engine", engine);
  else t.after(() => engine.dispose());
  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  return { root, dataDir, engine, binary, release };
}

async function harness(t, mode = "success", overrides = {}) {
  const cleanup = overrides.cleanup;
  const installed = await installEngine(t, mode, overrides);
  const { root, dataDir, engine } = installed;
  const mediaRoot = path.join(root, "media");
  await fs.mkdir(mediaRoot, { recursive: true });
  const bytes = Buffer.from(overrides.bytes ?? "synthetic T13I source bytes ".repeat(16));
  const file = path.join(mediaRoot, "source.bin");
  await fs.writeFile(file, bytes);
  const digest = sha256(bytes);
  const assetId = "asset_t13i";
  const generation = {
    libraryGeneration: "1".repeat(32),
    assetGeneration: "2".repeat(32),
    sourceGeneration: "3".repeat(32),
  };
  const current = {
    assetId,
    rootId: "root_t13i",
    kind: "music",
    online: true,
    trashed: false,
    retired: false,
    rootRetired: false,
    busy: false,
    ...generation,
  };
  const probeValue = Object.freeze({
    durationSec: 1,
    channels: 2,
    sampleRate: 44_100,
    totalSamples: 44_100,
    format: "wav",
  });
  const context = {
    kind: "music",
    sourceSha256: digest,
    sourceSize: bytes.length,
    durationSec: probeValue.durationSec,
    engineVersion: "1.0.0-t13i",
    engineBinarySha256: "0".repeat(64),
    engineGeneration: "a".repeat(32),
    parameters: { brief: true },
  };
  // context 的引擎身份必须来自真实运行 descriptor；测试在运行时用最近一次 lease
  // descriptor 覆盖，确保 store.begin 与真实 descriptor 一致。
  let latestDescriptor = null;
  const resolveCurrent = (id) =>
    id === assetId && current.online
      ? {
          ...current,
          context: latestDescriptor
            ? {
                ...context,
                engineVersion: latestDescriptor.version,
                engineBinarySha256: latestDescriptor.binarySha256,
                engineGeneration: latestDescriptor.generation,
              }
            : context,
        }
      : null;
  const resolveAsset = async (id) => {
    const cur = resolveCurrent(id);
    if (!cur) return null;
    return {
      assetId: cur.assetId,
      kind: cur.kind,
      sourcePath: file,
      rootPath: mediaRoot,
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
  const launcher = createAudioExecutorLauncherConfig({
    path: launcherBuild.path,
    sha256: sha256(await fs.readFile(launcherBuild.path)),
  });
  const executor = new AudioExecutor({
    dataDir,
    launcher,
    limits: { wallMs: 5000, stdoutBytes: overrides.stdoutBytes ?? 64 * 1024, termGraceMs: 150 },
  });
  if (cleanup) cleanup.track("executor", executor);
  else t.after(() => executor.dispose().catch(() => {}));

  const db = new Database(path.join(root, "store.sqlite"));
  if (cleanup) cleanup.track("db", db);
  else {
    t.after(() => {
      try {
        db.close();
      } catch {}
    });
  }
  const store = new AudioResultStore({ db, resolveCurrent: (id) => resolveCurrent(id) });
  const probe = overrides.probe ?? (async () => probeValue);
  const withRunLease = async (callback, options) =>
    engine.withRunLease(async (descriptor, signal) => {
      latestDescriptor = descriptor;
      return callback(descriptor, signal);
    }, options);
  let latestEvidence = null;
  let boundaryRejection = null;
  const execute =
    overrides.execute ??
    (async (snapshot, descriptor, options) => {
      if (overrides.evidence !== true) {
        const raw = await executor.execute(snapshot, descriptor, options);
        if (typeof overrides.afterExecute === "function") await overrides.afterExecute({ dataDir });
        return raw;
      }
      // 观察点 A：已批准 executor-wrapper 边界。对实际 executor 调用的返回
      // promise 单独挂拒绝观察，只记录原对象后原样再抛，不 clone/wrap/replace，
      // 也不改 executor/server/queue API；与观察点 B 相互独立。
      const observed = Promise.resolve()
        .then(() => executor.executeWithEvidence(snapshot, descriptor, options))
        .catch((error) => {
          boundaryRejection = error;
          throw error;
        });
      try {
        const { raw, evidence } = await observed;
        latestEvidence = evidence;
        if (typeof overrides.afterExecute === "function") await overrides.afterExecute({ dataDir });
        return raw;
      } catch (error) {
        // 观察点 B：包装层 catch，必须与 A 看到同一原始错误对象。
        latestEvidence = error;
        throw error;
      }
    });
  const pipeline = new AudioAnalysisPipeline({
    dataDir,
    resolveAsset,
    store,
    resolveCurrent,
    probe,
    withRunLease,
    withLifecycleScope: engine.withLifecycleScope.bind(engine),
    execute,
    wallDeadlineMs: overrides.wallDeadlineMs ?? 4000,
    maxSnapshotBytes: 1024 * 1024,
    maxWaiting: 4,
  });
  if (cleanup) cleanup.track("pipeline", pipeline);
  else t.after(() => pipeline.dispose().catch(() => {}));
  pipeline.init();
  return {
    ...installed,
    file,
    bytes,
    digest,
    assetId,
    executor,
    db,
    store,
    pipeline,
    lockPath: path.join(dataDir, "engines", ".audio-install.lock"),
    jobsPath: path.join(dataDir, "audio-jobs"),
    getEvidence: () => latestEvidence,
    getBoundaryRejection: () => boundaryRejection,
  };
}

async function waitState(pipeline, id, state, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const job = await pipeline.get(id);
    if (job.state === state) return job;
    if (Date.now() - started > timeoutMs) throw new Error(`等待 ${state} 超时：${JSON.stringify(job)}`);
    await delay(10);
  }
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

test("真实租约+真实 executor+SQLite+pipeline：成功、descriptor 身份入 provenance、锁释放", { skip: skipAll }, async (t) => {
  const h = await harness(t, "success");
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "succeeded");
  assert.equal(done.resultSaved, true);
  assert.equal(done.error, null);
  const result = h.pipeline.getResult(h.assetId);
  assert.equal(result.status, "ready");
  assert.equal(result.result.provenance.sourceSha256, h.digest);
  assert.equal(result.result.provenance.sourceSize, h.bytes.length);
  assert.equal(result.result.provenance.engineVersion, "1.0.0-t13i");
  assert.match(result.result.provenance.engineBinarySha256, /^[0-9a-f]{64}$/);
  assert.equal(count(h.db, "audio_result_records"), 1);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n,
    0,
  );
  assert.equal(await fs.lstat(h.lockPath).catch(() => null), null, "运行结束必须释放安装锁");
  assert.deepEqual(await fs.readdir(h.jobsPath).catch(() => []), []);
});

test("真实租约+真实 executor：输出超限/非零退出保留固定执行码，不折叠为 lease 失败", { skip: skipAll }, async (t) => {
  const limited = await harness(t, "flood", { stdoutBytes: 1024, wallDeadlineMs: 4000 });
  let job = await limited.pipeline.submit(limited.assetId);
  let done = await waitState(limited.pipeline, job.id, "failed");
  assert.equal(done.error.code, "OUTPUT_LIMIT", "execute 的 OUTPUT_LIMIT 必须在 lease 释放后原样保留");
  assert.equal(done.resultSaved, false);
  assert.equal(count(limited.db, "audio_result_records"), 0);
  assert.equal(await fs.lstat(limited.lockPath).catch(() => null), null);

  const failed = await harness(t, "nonzero");
  job = await failed.pipeline.submit(failed.assetId);
  done = await waitState(failed.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ENGINE_FAILED");
  assert.equal(done.resultSaved, false);
  assert.equal(count(failed.db, "audio_result_records"), 0);
  assert.equal(await fs.lstat(failed.lockPath).catch(() => null), null);
});

test("真实租约+真实 executor：队列超时/取消在进程组回收后才释放锁", { skip: skipAll }, async (t) => {
  const timed = await harness(t, "sleep", { wallDeadlineMs: 300 });
  let job = await timed.pipeline.submit(timed.assetId);
  let done = await waitState(timed.pipeline, job.id, "failed");
  assert.equal(done.error.code, "TIMEOUT");
  assert.equal(done.resultSaved, false);
  assert.equal(await fs.lstat(timed.lockPath).catch(() => null), null);
  assert.deepEqual(await fs.readdir(timed.jobsPath).catch(() => []), []);

  const cancelling = await harness(t, "sleep", { wallDeadlineMs: 5000 });
  job = await cancelling.pipeline.submit(cancelling.assetId);
  await waitState(cancelling.pipeline, job.id, "running");
  const requested = await cancelling.pipeline.cancel(job.id);
  assert.equal(requested.state, "cancelling");
  done = await waitState(cancelling.pipeline, job.id, "cancelled");
  assert.equal(done.resultSaved, false);
  assert.equal(await fs.lstat(cancelling.lockPath).catch(() => null), null);
});

test("真实租约：busy/完整性故障优先且不产生资格/结果", { skip: skipAll }, async (t) => {
  const h = await harness(t, "success");

  const gate = (async () => {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    return { promise, release };
  })();
  const held = await gate;
  const lease = h.engine.withRunLease(async () => {
    await held.promise;
    return "held";
  });
  lease.catch(() => {});
  await delay(50);
  let job = await h.pipeline.submit(h.assetId);
  let done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ENGINE_BUSY");
  assert.equal(count(h.db, "audio_result_commits"), 0, "busy 时不得申请资格");
  held.release();
  await lease;

  const binary = await fs.readFile(h.engine.binaryPath);
  const tampered = Buffer.from(binary);
  tampered[tampered.length - 1] ^= 0x01;
  await fs.writeFile(h.engine.binaryPath, tampered);
  job = await h.pipeline.submit(h.assetId);
  done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "ENGINE_LEASE_FAILED", "完整性故障不得被执行错误吞掉");
  assert.equal(count(h.db, "audio_result_records"), 0);
  await fs.writeFile(h.engine.binaryPath, binary);
});

test("真实租约释放失败优先：save 前撤销产物并报 lease 故障", { skip: skipAll }, async (t) => {
  let enginesRoot = null;
  const h = await harness(t, "success", {
    async afterExecute() {
      // 运行回调已成功、engine 尚未释放锁；从 callback 内部移除 engines 目录写权限，
      // 让真实 #releaseLock 的 rmdir 失败，验证 pipeline 不会把已生成的产物当成成功。
      enginesRoot = path.join(h.dataDir, "engines");
      await fs.chmod(enginesRoot, 0o500);
    },
  });
  t.after(async () => {
    if (enginesRoot) await fs.chmod(enginesRoot, 0o700).catch(() => {});
    await fs.rm(h.lockPath, { recursive: true, force: true }).catch(() => {});
  });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed");
  // 先恢复目录权限并清掉故意留下的锁，避免临时根清理时被 0500 挡住。
  if (enginesRoot) await fs.chmod(enginesRoot, 0o700).catch(() => {});
  await fs.rm(h.lockPath, { recursive: true, force: true }).catch(() => {});
  assert.equal(done.error.code, "ENGINE_LEASE_FAILED");
  assert.equal(done.resultSaved, false);
  assert.equal(count(h.db, "audio_result_records"), 0);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n,
    0,
    "释放失败时 pipeline 必须定向撤销产物 token",
  );
});

test("真实 engine scope + pipeline + queue：execute resourceUnknown 保锁/快照/queue 租约现场", { skip: skipAll }, async (t) => {
  // 跨层 sticky 证据：真实 AudioEngine.withLifecycleScope/withRunLease + 真实 pipeline
  // + 真实 queue/临时快照；execute 只注入合成 resourceUnknown 证据，不启动引擎进程。
  const h = await harness(t, "success", {
    execute: async () => {
      const error = new Error("synthetic process unknown");
      error.code = "TIMEOUT";
      error.evidence = { resourceUnknown: true, closeSettled: false, reason: "SYNTHETIC_UNKNOWN" };
      throw error;
    },
  });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed");
  assert.equal(done.error.code, "TIMEOUT");
  assert.equal(done.resultSaved, false);
  assert.ok(await fs.lstat(h.lockPath).catch(() => null), "engine scope 必须保留安装/运行锁");
  assert.ok(
    await fs.lstat(path.join(h.jobsPath, ".queue-lease")).catch(() => null),
    "queue 必须保留故障租约",
  );
  const entries = await fs.readdir(h.jobsPath);
  assert.ok(entries.some((name) => name.startsWith("job-")), "resourceUnknown 不得删除快照现场");
  assert.equal(count(h.db, "audio_result_records"), 0);
  assert.equal(
    h.db.prepare("SELECT COUNT(*) AS n FROM audio_result_commits WHERE consumed_at_ms IS NULL").get().n,
    0,
    "撤销后不得留下未消费提交资格",
  );
  // 本用例故意保留锁/快照现场；显式标记实例已故障，避免后续误用。
  assert.equal(typeof h.engine._scopeFaulted, "boolean");
});

test("证据模式：真实 executor 成功证据穿过真实 pipeline，只返回 raw 且锁释放", { skip: skipAll }, async (t) => {
  const cleanup = createOwnedCleanup(t);
  const h = await harness(t, "success", { evidence: true, cleanup });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "succeeded");
  assert.equal(done.resultSaved, true);
  assert.equal(done.error, null);
  assert.equal(count(h.db, "audio_result_records"), 1);
  const evidence = h.getEvidence();
  assert.ok(evidence && typeof evidence === "object", "成功路径必须捕获真实 evidence");
  assertEvidenceV1(evidence, { outcome: "success" });
  assertSuccessGate(evidence);
  cleanup.track("evidence", evidence);

  const expectedBytes = Buffer.byteLength(rawSuccess(), "utf8");
  assert.equal(expectedBytes, 186, "rawSuccess 仅作漂移 guard，expected 由实际序列化字节得出");
  assert.equal(evidence.outcome, "success");
  assert.equal(evidence.code, null);
  assert.equal(evidence.resourceUnknown, false);
  assert.deepEqual([...evidence.unknownResources], []);
  assert.equal(evidence.child.state, "exited");
  assert.equal(evidence.child.exitCode, 0);
  assert.equal(evidence.child.signal, null);
  assert.equal(evidence.child.closeSettled, true);
  assert.equal(evidence.stdio.stdout.final, true);
  assert.equal(evidence.stdio.stdout.observedBytes, expectedBytes);
  assert.equal(evidence.stdio.stdout.observedBytes, evidence.stdio.stdout.retainedBytes);
  assert.equal(evidence.stdio.stderr.retainedBytes, 0);
  assert.equal(evidence.group.state, "reclaimed");
  assert.equal(evidence.directory.state, "removed");
  assert.equal(evidence.directory.postcondition, "absent");
  assert.notEqual(evidence.timing.cleanupFinishedAtMs, null);
  assert.equal(typeof evidence.timing.totalMs, "number");

  const summary = summarizeEvidence(evidence);
  t.diagnostic(`T13I_EVIDENCE_SAMPLE_SUCCESS ${JSON.stringify(summary)}`);
  assert.equal(Object.isFrozen(summary), true);
  const text = JSON.stringify(summary);
  assert.equal(text.includes(h.root), false, "摘要不得包含临时根路径");
  assert.equal(text.includes(h.dataDir), false, "摘要不得包含 dataDir");
  assert.equal(text.includes("SECRET_"), false);
  assert.equal(text.includes('"pid"'), false);
  assert.equal(
    (await observe(fs, () => fs.lstat(h.lockPath))).state,
    "absent",
    "成功结束必须释放安装锁；只有 ENOENT 才算已释放，EACCES 不得当 absent",
  );
  assert.deepEqual(await listJobDirs(path.join(h.dataDir, "audio-executor", "jobs")), []);

  await cleanup.finish();
  const inv = cleanup.inventory;
  t.diagnostic(`T13I_CLEANUP_INVENTORY_SUCCESS ${JSON.stringify(inv)}`);
  assert.deepEqual({ ...inv }, {
    ownedLauncherProcesses: 0,
    ownedProcesses: "zero",
    componentExit: "confirmed",
    retainedJobDirs: 0,
    restoredMode: "0700",
    tlsClose: "closed",
    dbClosed: true,
    disposeErrors: 0,
    removalAllowed: true,
    rootAbsent: true,
    jobDirsAfterRm: 0,
    mode0500After: 0,
    tmpRootsLeft: 0,
    preservedRoot: false,
    rootOwnership: "verified",
    ancestorContainment: "verified",
    rootReverify: "verified",
  });
});

test("证据模式：cleanup-fail 真实 retained/CLEANUP_ERROR 经 pipeline 保留锁/租约/快照", { skip: skipAll }, async (t) => {
  if (!posixNonRoot()) {
    t.skip("cleanup-fail 前置：需要非 root POSIX");
    return;
  }
  if (!fssync.existsSync("/bin/ps") && !fssync.existsSync("/usr/bin/pgrep")) {
    t.skip("cleanup-fail 前置：无 /bin/ps");
    return;
  }
  // P2：本机临时 FS 的 0500 必须真正阻止 recursive rm；不把 rm 成功当通过。
  // scratch 自身 finally 的 chmod/rm/最终观察也必须有真实结果，不吞错。
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "t13i-cleanup-probe-"));
  const scratch = { rmBlocked: false, chmod: "ok", rm: "ok", absent: "unknown" };
  try {
    await fs.mkdir(path.join(probeRoot, "child"));
    await fs.chmod(probeRoot, 0o500);
    try {
      await fs.rm(probeRoot, { recursive: true, force: false });
    } catch {
      scratch.rmBlocked = true;
    }
  } finally {
    try {
      await fs.chmod(probeRoot, 0o700);
    } catch (error) {
      scratch.chmod = error?.code ?? "error";
    }
    try {
      await fs.rm(probeRoot, { recursive: true, force: true });
    } catch (error) {
      scratch.rm = error?.code ?? "error";
    }
    const remains = await observe(fs, () => fs.lstat(probeRoot));
    scratch.absent = remains.state === "present" ? false : remains.state;
  }
  t.diagnostic(`T13I_SCRATCH_CLEANUP ${JSON.stringify(scratch)}`);
  assert.equal(scratch.chmod, "ok", "scratch 权限恢复失败不得继续");
  assert.equal(scratch.rm, "ok", "scratch 自身 rm 失败不得吞错");
  assert.equal(scratch.absent, "absent", "scratch 根必须确认删除");
  if (!scratch.rmBlocked) {
    t.skip("cleanup-fail 前置：0500 未阻止 rm");
    return;
  }

  const cleanup = createOwnedCleanup(t);
  const h = await harness(t, "cleanup-fail", { evidence: true, cleanup });
  const job = await h.pipeline.submit(h.assetId);
  const done = await waitState(h.pipeline, job.id, "failed", 12_000);
  const rawError = h.getEvidence();
  const boundaryError = h.getBoundaryRejection();
  const evidence = rawError?.executionEvidence;
  const expectedBytes = Buffer.byteLength(rawSuccess(), "utf8");
  assert.equal(expectedBytes, 186, "rawSuccess 仅作漂移 guard");

  // G2：包装层原始错误，未被 pipeline 映射覆盖，也未携带 raw。两个独立观察点
  // （executor-wrapper catch 与 execute catch）必须捕获同一对象；不以从同一
  // 属性取出的值自比来证明转发。
  assert.ok(boundaryError instanceof Error, "观察点 A 必须看到原始错误对象");
  assert.equal(boundaryError, rawError, "观察点 A/B 必须是同一原始错误对象（无 clone/wrap）");
  assert.equal(rawError.code, "EXECUTION_UNAVAILABLE");
  assert.equal(rawError.evidence?.resourceUnknown, true);
  assert.equal(Object.hasOwn(rawError, "raw"), false);
  assert.equal(Object.hasOwn(boundaryError, "executionEvidence"), true, "原始错误必须自带 executionEvidence");
  assert.ok(evidence && typeof evidence === "object", "失败路径必须捕获真实 executionEvidence");
  assert.equal(Object.isFrozen(evidence), true);
  assertErrorEvidence(rawError);
  assertEvidenceV1(evidence, { outcome: "failure" });
  t.diagnostic(`T13I_EVIDENCE_SAMPLE_FAILURE ${JSON.stringify(summarizeEvidence(evidence))}`);

  // G1：真实 retained / CLEANUP_ERROR，而不是注入或伪造的 present。
  assert.equal(evidence.outcome, "failure");
  assert.equal(evidence.resourceUnknown, true);
  assert.ok([...evidence.unknownResources].includes("directory"));
  assert.equal(evidence.directory.state, "retained");
  assert.equal(evidence.directory.postcondition, "present");
  assert.equal(evidence.directory.cleanupRan, true);
  assert.equal(evidence.directory.removalAttempted, true);
  assert.equal(evidence.directory.removalSettled, true);
  assert.equal(evidence.directory.reason, "CLEANUP_ERROR");
  assert.equal(evidence.group.state, "reclaimed");
  assert.equal(evidence.child.closeSettled, true);
  assert.equal(evidence.stdio.stdout.observedBytes, expectedBytes);
  assert.equal(evidence.stdio.stdout.final, true);
  assert.equal(evidence.stdio.stdout.available, "none");
  assert.equal(evidence.stdio.stdout.retainedBytes, 0);
  assert.equal(evidence.handoff.retainLeaseRequired, true);

  // G3：pipeline/queue 折叠后的结果；公开 summary 只允许实际 code/message。
  assert.equal(done.state, "failed");
  assert.equal(done.resultSaved, false);
  assert.deepEqual(Object.keys(done.error).sort(), ["code", "message"], "公开 summary 只暴露 code/message");
  assert.equal(done.error.code, "ENGINE_FAILED");
  assert.equal(done.error.message, "音频引擎执行失败", "必须使用 pipeline 固定文案，不得转发原始 message");
  assert.equal(Object.hasOwn(done.error, "evidence"), false, "不要求不存在的 summary.evidence，也不伪造");
  const rawSummary = assertErrorEvidence(rawError);
  assert.equal(rawSummary.executionResourceUnknown, true);
  assert.equal(rawSummary.legacyResourceUnknown, true);
  cleanup.track("evidence", evidence);

  // G4：安装锁、queue 租约、快照 job、executor job 全部保留。
  assert.ok(await fs.lstat(h.lockPath).catch(() => null), "安装锁必须保留");
  const engineLockOwner = JSON.parse(await fs.readFile(path.join(h.lockPath, "owner.json"), "utf8"));
  assert.match(engineLockOwner.token, /^[0-9a-f]{32}$/, "engine 锁 owner token 形状必须保留");
  assert.equal(typeof engineLockOwner.jobId, "string");
  assert.ok(engineLockOwner.jobId.length > 0);
  assert.ok(
    await fs.lstat(path.join(h.jobsPath, ".queue-lease")).catch(() => null),
    ".queue-lease 必须保留",
  );
  const queueLeaseOwner = JSON.parse(
    await fs.readFile(path.join(h.jobsPath, ".queue-lease", "owner.json"), "utf8"),
  );
  assert.equal(queueLeaseOwner.purpose, "audio-job-queue");
  assert.match(queueLeaseOwner.token, /^[0-9a-f]{32}$/, "queue 租约 owner token 形状必须保留");
  const snapshotJobs = (await fs.readdir(h.jobsPath)).filter((name) => name.startsWith("job-"));
  assert.ok(snapshotJobs.length > 0, "audio-jobs 快照不得删除");
  const snapshotDir = path.join(h.jobsPath, snapshotJobs[0]);
  assert.ok((await fs.lstat(path.join(snapshotDir, ".owner.json"))).isFile(), "快照 owner 必须保留");
  assert.ok((await fs.lstat(path.join(snapshotDir, "source.bin"))).isFile(), "快照内容必须保留");
  const jobsRoot = path.join(h.dataDir, "audio-executor", "jobs");
  const executorJobs = await listJobDirs(jobsRoot);
  if (executorJobs.length !== 1) {
    cleanup.requestPreserve("p3");
    assert.equal(executorJobs.length, 1, "cleanup-fail 必须恰好留下一个 executor job 现场");
  }
  const jobDir = executorJobs[0];
  const first = await fs.lstat(jobDir);
  const second = await fs.lstat(jobDir);
  const jobsReal = await fs.realpath(jobsRoot);
  const parentReal = await fs.realpath(path.dirname(jobDir));
  const p3Ok =
    !first.isSymbolicLink() &&
    first.isDirectory() &&
    first.uid === process.geteuid() &&
    (first.mode & 0o777) === 0o500 &&
    parentReal === jobsReal &&
    first.dev === second.dev &&
    first.ino === second.ino;
  if (!p3Ok) {
    cleanup.requestPreserve("p3");
    assert.fail(
      `P3 目录身份/权限不成立：state=${first.isDirectory() ? "directory" : "other"} ` +
        `mode=${(first.mode & 0o777).toString(8)} uid=${first.uid} reason=${evidence.directory.reason}`,
    );
  }

  // P4：0500 只落在 job.dir；jobsRoot 与 work 仍 0700，dataDir 未被改成 0500。
  const jobsMode = (await fs.lstat(jobsRoot)).mode & 0o777;
  const dataMode = (await fs.lstat(h.dataDir)).mode & 0o777;
  const workMode = (await fs.lstat(path.join(jobDir, "work"))).mode & 0o777;
  if (jobsMode === 0o500 || dataMode === 0o500 || workMode !== 0o700) {
    cleanup.requestPreserve("p4");
    assert.fail(
      `P4 chmod 目标越界：jobs=${jobsMode.toString(8)} data=${dataMode.toString(8)} work=${workMode.toString(8)}`,
    );
  }

  // G5：结果库无记录；保留的 commit 必须关联同一 asset/job 且已实际消费。
  assert.equal(count(h.db, "audio_result_records"), 0, "resourceUnknown 不得保存结果");
  const commitRows = h.db
    .prepare("SELECT asset_id, job_id, consumed_at_ms FROM audio_result_commits ORDER BY created_at_ms")
    .all();
  const pending = commitRows.filter((row) => row.consumed_at_ms === null).length;
  const consumedNonNull = commitRows.every((row) => Number.isSafeInteger(row.consumed_at_ms));
  const assetMatches = commitRows.length > 0 && commitRows.every((row) => row.asset_id === h.assetId);
  const jobMatches = commitRows.length > 0 && commitRows.every((row) => row.job_id === job.id);
  assert.ok(commitRows.length >= 1, "必须存在至少 1 条实际 commit（total=1 合法，不要求 0）");
  assert.equal(pending, 0, "不得留下未消费提交资格");
  assert.equal(consumedNonNull, true, "保留的 commit 必须有实际非空 consumed_at_ms");
  assert.equal(assetMatches, true, "保留的 commit 必须关联本轮 asset");
  assert.equal(jobMatches, true, "保留的 commit 必须关联本轮 job");
  t.diagnostic(
    `T13I_COMMIT_FACTS ${JSON.stringify({
      total: commitRows.length,
      pending,
      consumedNonNull,
      assetMatches,
      jobMatches,
    })}`,
  );

  // 测试侧收尾：restore 自有权限 -> 有界关闭 -> 观察门 -> 才删自有 root。
  await cleanup.finish();
  const inv = cleanup.inventory;
  t.diagnostic(`T13I_CLEANUP_INVENTORY ${JSON.stringify(inv)}`);
  assert.deepEqual({ ...inv }, {
    ownedLauncherProcesses: 0,
    ownedProcesses: "zero",
    componentExit: "confirmed",
    retainedJobDirs: 1,
    restoredMode: "0700",
    tlsClose: "closed",
    dbClosed: true,
    disposeErrors: 0,
    removalAllowed: true,
    rootAbsent: true,
    jobDirsAfterRm: 0,
    mode0500After: 0,
    tmpRootsLeft: 0,
    preservedRoot: false,
    rootOwnership: "verified",
    ancestorContainment: "verified",
    rootReverify: "verified",
  });
});

test("证据模式：独占清理协调器覆盖早退/挂起 dispose/未知观察/恢复权限失败", { skip: skipAll }, async (t) => {
  // 1. 早退/构造失败：不靠 t.after 兜底，显式 finish 仍须确认删除。
  {
    const cleanup = createOwnedCleanup(t, { autoAfter: false });
    let root = null;
    await assert.rejects(async () => {
      root = await cleanup.createRoot("t13i-early-");
      await fs.mkdir(path.join(root, "data"), { recursive: true });
      await fs.writeFile(path.join(root, "data", "partial.bin"), "x");
      throw new Error("CONSTRUCT_FAILED");
    }, /CONSTRUCT_FAILED/);
    await cleanup.finish();
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_EARLY ${JSON.stringify(inv)}`);
    assert.equal(inv.removalAllowed, true);
    assert.equal(inv.rootAbsent, true);
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
  }

  // 2. 挂起 dispose：有界超时只算 unknown，保留现场并失败，不冒充已回收。
  {
    const cleanup = createOwnedCleanup(t, { autoAfter: false, boundedMs: 50 });
    const root = await cleanup.createRoot("t13i-hang-");
    cleanup.track("pipeline", { dispose: () => new Promise(() => {}) });
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_HANG ${JSON.stringify(inv)}`);
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.rootAbsent, false);
    assert.equal(inv.preservedRoot, true);
    assert.ok(inv.disposeErrors > 0);
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "present");
    await fs.chmod(root, 0o700);
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
  }

  // 3. root 观察失败（EACCES）发生在任何 chmod/rm 之前：不得删除实际 root。
  {
    let root = null;
    let failRootObservation = false;
    const failingFs = {
      ...fs,
      lstat: async (target, ...rest) => {
        if (failRootObservation && target === root) {
          const error = new Error("synthetic EACCES");
          error.code = "EACCES";
          throw error;
        }
        return fs.lstat(target, ...rest);
      },
    };
    const cleanup = createOwnedCleanup(t, { autoAfter: false, boundedMs: 50, fs: failingFs });
    root = await cleanup.createRoot("t13i-unknown-observe-");
    await fs.mkdir(path.join(root, "data", "audio-executor", "jobs", "job-unknown"), { recursive: true });
    failRootObservation = true;
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_UNKNOWN_OBSERVATION ${JSON.stringify(inv)}`);
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.rootAbsent, "unknown");
    assert.equal(inv.preservedRoot, true);
    assert.equal(inv.retainedJobDirs, "unknown");
    assert.equal(inv.restoredMode, "unknown");
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "present");
    failRootObservation = false;
    await fs.chmod(root, 0o700);
    await fs.chmod(path.join(root, "data", "audio-executor", "jobs", "job-unknown"), 0o700);
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
  }

  // 3b. root 已验证但单个 job 观察失败：不得 chmod，保留 root 并失败。
  {
    let root = null;
    let failJobObservation = false;
    const failingFs = {
      ...fs,
      lstat: async (target, ...rest) => {
        if (failJobObservation && String(target).includes("job-observe")) {
          const error = new Error("synthetic EACCES");
          error.code = "EACCES";
          throw error;
        }
        return fs.lstat(target, ...rest);
      },
    };
    const cleanup = createOwnedCleanup(t, { autoAfter: false, boundedMs: 50, fs: failingFs });
    root = await cleanup.createRoot("t13i-job-unknown-observe-");
    const jobDir = path.join(root, "data", "audio-executor", "jobs", "job-observe");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.chmod(jobDir, 0o500);
    failJobObservation = true;
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_JOB_UNKNOWN_OBSERVATION ${JSON.stringify(inv)}`);
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.rootAbsent, false);
    assert.equal(inv.preservedRoot, true);
    assert.equal(inv.retainedJobDirs, 1);
    assert.equal(inv.restoredMode, "unknown");
    assert.equal((await fs.lstat(jobDir)).mode & 0o777, 0o500, "unknown 观察不得 chmod job");
    failJobObservation = false;
    await fs.chmod(jobDir, 0o700);
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
  }

  // 4. restore 失败不吞错：保留恢复前现场并失败，人工恢复后才删除。
  {
    const failingChmodFs = {
      ...fs,
      chmod: async (target, mode) => {
        if (String(target).includes("job-")) {
          const error = new Error("synthetic EACCES chmod");
          error.code = "EACCES";
          throw error;
        }
        return fs.chmod(target, mode);
      },
    };
    const cleanup = createOwnedCleanup(t, { autoAfter: false, boundedMs: 50, fs: failingChmodFs });
    const root = await cleanup.createRoot("t13i-restore-fail-");
    const jobDir = path.join(root, "data", "audio-executor", "jobs", "job-restore");
    await fs.mkdir(jobDir, { recursive: true });
    await fs.chmod(jobDir, 0o500);
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_RESTORE_FAIL ${JSON.stringify(inv)}`);
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.rootAbsent, false);
    assert.equal(inv.preservedRoot, true);
    assert.equal(inv.restoredMode, "unknown");
    assert.equal((await fs.lstat(jobDir)).mode & 0o777, 0o500);
    await fs.chmod(jobDir, 0o700);
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
  }

  // 5. TLS close 永不完成：non-listening/等待超时只能是 unknown，不得 rm。
  {
    const neverServer = {
      listening: true,
      once() {},
      on() {},
      close() {
        this.listening = false;
      },
      closeAllConnections() {},
    };
    const cleanup = createOwnedCleanup(t, { autoAfter: false, boundedMs: 50 });
    const root = await cleanup.createRoot("t13i-tls-unknown-");
    cleanup.track("server", neverServer);
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_TLS_UNKNOWN ${JSON.stringify(inv)}`);
    assert.equal(inv.tlsClose, "unknown");
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.rootAbsent, false);
    assert.equal(inv.preservedRoot, true);
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "present");
    await fs.chmod(root, 0o700);
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
  }

  // 6. rm 失败不吞错：保留现场并失败，人工确认后才删除。
  {
    const failingRmFs = {
      ...fs,
      rm: async () => {
        const error = new Error("synthetic EACCES rm");
        error.code = "EACCES";
        throw error;
      },
    };
    const cleanup = createOwnedCleanup(t, { autoAfter: false, boundedMs: 50, fs: failingRmFs });
    const root = await cleanup.createRoot("t13i-rm-fail-");
    await fs.writeFile(path.join(root, "partial.bin"), "x");
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_RM_FAIL ${JSON.stringify(inv)}`);
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.rootAbsent, false);
    assert.equal(inv.preservedRoot, true);
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "present");
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
  }

  // 7. mkdtemp 成功但 realpath 失败：allocated 未验证，finish 必须失败保现场，
  // 不得把已分配目录当 not-created，也不得删除未验证路径。
  {
    const allocated = [];
    const failingRealpathFs = {
      ...fs,
      mkdtemp: async (prefix) => {
        const value = await fs.mkdtemp(prefix);
        allocated.push(value);
        return value;
      },
      realpath: async () => {
        const error = new Error("synthetic EACCES realpath");
        error.code = "EACCES";
        throw error;
      },
    };
    const cleanup = createOwnedCleanup(t, { autoAfter: false, fs: failingRealpathFs });
    let createFailed = false;
    try {
      await cleanup.createRoot("t13i-unverified-");
    } catch {
      createFailed = true;
    }
    assert.equal(createFailed, true, "realpath 失败必须让 createRoot 失败，不能静默降级");
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_UNVERIFIED_ALLOCATION ${JSON.stringify(inv)}`);
    assert.equal(inv.rootOwnership, "unverified");
    assert.notEqual(inv.rootAbsent, "not-created");
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.preservedRoot, true);
    assert.equal(allocated.length, 1);
    assert.equal((await observe(fs, () => fs.lstat(allocated[0]))).state, "present");
    await fs.rm(allocated[0], { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(allocated[0]))).state, "absent");
  }

  // 8. 祖先 symlink 指向兄弟外部目录：不得 chmod 外部 job，也不得删 root。
  {
    const cleanup = createOwnedCleanup(t, { autoAfter: false });
    const root = await cleanup.createRoot("t13i-symlink-ancestor-");
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "t13i-external-"));
    const outsideJob = path.join(external, "job-outside");
    await fs.mkdir(outsideJob);
    await fs.chmod(outsideJob, 0o500);
    await fs.mkdir(path.join(root, "data", "audio-executor"), { recursive: true });
    await fs.symlink(external, path.join(root, "data", "audio-executor", "jobs"));
    await assert.rejects(cleanup.finish(), (error) => error instanceof AggregateError);
    const inv = cleanup.inventory;
    t.diagnostic(`T13I_CLEANUP_SYMLINK_ANCESTOR ${JSON.stringify(inv)}`);
    assert.equal(inv.removalAllowed, false);
    assert.equal(inv.preservedRoot, true);
    assert.equal(inv.ancestorContainment, "foreign");
    assert.equal((await fs.lstat(outsideJob)).mode & 0o777, 0o500, "外部 job 不得被 chmod");
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "present");
    await fs.chmod(outsideJob, 0o700);
    await fs.rm(external, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await observe(fs, () => fs.lstat(root))).state, "absent");
    assert.equal((await observe(fs, () => fs.lstat(external))).state, "absent");
  }
});
