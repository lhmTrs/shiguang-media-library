/**
 * T-LOCAL-013A：macOS rlimit launcher 实验。
 * 只在临时目录编译/运行小型 C launcher；不装系统依赖、不触发 xcode-select 安装、不跑发行引擎。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LocalExecutor, ExecutorError } from "../executor.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CHILD = path.join(ROOT, "fixtures", "child.mjs");
const SOURCE = path.join(ROOT, "fixtures", "rlimit-launcher.c");
const BUILD_DIR = path.join(ROOT, "build");
const LAUNCHER = path.join(BUILD_DIR, "rlimit-launcher");
const NODE = process.execPath;

async function ensureLauncher() {
  if (fssync.existsSync(LAUNCHER)) return true;
  try {
    const { stdout } = await execFileAsync("/usr/bin/xcode-select", ["-p"], { timeout: 2000 });
    if (!stdout.trim()) return false;
  } catch {
    return false;
  }
  await fs.mkdir(BUILD_DIR, { recursive: true });
  try {
    await execFileAsync("/usr/bin/cc", ["-O2", "-Wall", "-Wextra", "-o", LAUNCHER, SOURCE], { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const available = await ensureLauncher();

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t13a-rl-"));
  const executor = new LocalExecutor(path.join(root, "data"), { graceMs: 150 });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });
  return { root, executor };
}

test("Mac RLIMIT_CPU：软限制 SIGXCPU 终止忙循环", { skip: !available && "no compiler/launcher" }, async (t) => {
  const { executor } = await setup(t);
  const result = await executor.run({
    command: LAUNCHER,
    args: ["1", "2", "0", "0", NODE, CHILD, "cpu"],
    timeoutMs: 5000,
    stdoutLimitBytes: 8 * 1024,
    stderrLimitBytes: 8 * 1024,
  });
  assert.equal(result.state, "resource-limit", JSON.stringify(result));
  assert.ok(["SIGXCPU", "SIGKILL"].includes(result.exitSignal), `signal=${result.exitSignal}`);
  assert.ok(result.durationMs >= 900, `duration=${result.durationMs}`);
  assert.equal(result.groupReaped, true);
});

test("Mac RLIMIT_FSIZE：写入超过上限报 EFBIG，文件不超过上限", { skip: !available && "no compiler/launcher" }, async (t) => {
  const { root, executor } = await setup(t);
  const target = path.join(root, "fsize.bin");
  const limit = 64 * 1024;
  const result = await executor.run({
    command: LAUNCHER,
    args: ["0", "0", String(limit), "0", NODE, CHILD, "fsize", target],
    timeoutMs: 5000,
    stdoutLimitBytes: 8 * 1024,
    stderrLimitBytes: 8 * 1024,
  });
  const stat = await fs.stat(target);
  assert.ok(stat.size <= limit, `size=${stat.size}`);
  assert.equal(stat.size, limit, "应写满软限制后失败");
  assert.match(result.stderr, /EFBIG/);
  assert.equal(result.groupReaped, true);
});

test("Mac RLIMIT_NOFILE：子进程打开到 EMFILE，不无限增长", { skip: !available && "no compiler/launcher" }, async (t) => {
  const { root, executor } = await setup(t);
  const outFile = path.join(root, "nofile.json");
  const limit = 1016; // 低于 Node 启动+1000 fd 需要；实测在 1016 时子进程仍能完成结果写入
  const result = await executor.run({
    command: LAUNCHER,
    args: ["0", "0", "0", String(limit), NODE, CHILD, "nofile", outFile],
    timeoutMs: 5000,
    stdoutLimitBytes: 8 * 1024,
    stderrLimitBytes: 8 * 1024,
  });
  assert.equal(result.state, "success", JSON.stringify(result));
  const report = JSON.parse(await fs.readFile(outFile, "utf8"));
  assert.equal(report.errorCode, "EMFILE", JSON.stringify(report));
  assert.ok(report.opened > 0 && report.opened < 5000, `opened=${report.opened}`);
});
