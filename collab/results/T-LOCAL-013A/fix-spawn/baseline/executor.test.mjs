/**
 * T-LOCAL-013A：执行器原型的隔离测试。
 * 只用临时目录、合成 Node 子进程、随机本机回环端口；不运行发行引擎、不读真实素材、不访问公网。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { LocalExecutor, ExecutorError } from "../executor.mjs";
import { parseBrief } from "../brief.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CHILD = path.join(ROOT, "fixtures", "child.mjs");
const RSS_HELPER = path.join(ROOT, "build", "rss-of");
const NODE = process.execPath;

async function setup(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "t13a-"));
  const dataDir = path.join(root, "data");
  const executor = new LocalExecutor(dataDir, {
    graceMs: 150,
    rssSampleMs: 50,
    rssHelper: fssync.existsSync(RSS_HELPER) ? RSS_HELPER : null,
    ...options,
  });
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return { root, dataDir, executor };
}

function baseRun(mode, extra = {}) {
  const { args: extraArgs = [], ...rest } = extra;
  return {
    command: NODE,
    args: [CHILD, mode, ...extraArgs],
    timeoutMs: 3000,
    stdoutLimitBytes: 8 * 1024,
    stderrLimitBytes: 8 * 1024,
    ...rest,
  };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(file, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`file not ready: ${file}`);
}

test("success：固定 argv/shell:false/最小 env，正常 close 并解析合成 brief", async (t) => {
  const { dataDir, executor } = await setup(t);
  const result = await executor.run(baseRun("success"));
  assert.equal(result.state, "success", JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.equal(result.exitSignal, null);
  assert.equal(result.groupReaped, true);
  assert.deepEqual(result.leftoverPids, []);
  assert.ok(result.durationMs >= 1 && result.durationMs < 3000, `duration=${result.durationMs}`);

  const parsed = parseBrief(result.stdout);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.bpm, 128.4);
  assert.equal(parsed.value.key.best, "A");
  assert.equal(parsed.value.loud.rms, -14.2);
  assert.equal(parsed.value.energy.min, -40);

  assert.equal(fssync.existsSync(path.join(dataDir, ".audio-executor.lock")), false, "租约应释放");
  const jobsRoot = path.join(dataDir, "executor-jobs");
  assert.equal(fssync.existsSync(jobsRoot) ? fssync.readdirSync(jobsRoot).length : 0, 0, "任务临时目录应清理");
});

test("nonzero：退出码透传，不把失败当成功", async (t) => {
  const { executor } = await setup(t);
  const result = await executor.run(baseRun("nonzero"));
  assert.equal(result.state, "nonzero");
  assert.equal(result.exitCode, 7);
  assert.match(result.stderr, /synthetic failure/);
});

test("timeout：wall deadline 杀进程组，记录 close 耗时与短采样 RSS（软监督）", async (t) => {
  const { executor } = await setup(t);
  const result = await executor.run(baseRun("timeout", { timeoutMs: 700 }));
  assert.equal(result.state, "timeout", JSON.stringify(result));
  assert.equal(result.termination, "timeout");
  assert.ok(result.durationMs >= 650 && result.durationMs < 2500, `duration=${result.durationMs}`);
  assert.equal(result.groupReaped, true);
  assert.deepEqual(result.leftoverPids, []);
  if (fssync.existsSync(RSS_HELPER)) {
    assert.ok(result.rssSamples > 0, "应有 RSS 采样");
    assert.ok(result.rssMaxKb > 0, "RSS 应大于 0");
  }
});

test("cancel：AbortSignal 取消后等 close/回收，记录 cancel→close 耗时", async (t) => {
  const { executor } = await setup(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150).unref();
  const result = await executor.run(baseRun("cancel", { signal: controller.signal, timeoutMs: 5000 }));
  assert.equal(result.state, "cancelled", JSON.stringify(result));
  assert.equal(result.termination, "cancelled");
  assert.ok(result.cancelToCloseMs !== null && result.cancelToCloseMs < 1500, `cancelToClose=${result.cancelToCloseMs}`);
  assert.equal(result.groupReaped, true);
});

test("stdout-limit：有界缓冲并在超限时杀进程组", async (t) => {
  const { executor } = await setup(t);
  const limit = 4 * 1024;
  const result = await executor.run(baseRun("stdout-limit", { stdoutLimitBytes: limit, timeoutMs: 3000 }));
  assert.equal(result.state, "stdout-limit", JSON.stringify(result));
  assert.equal(result.outputLimit, "stdout-limit");
  assert.ok(result.stdoutBytes > limit, `bytes=${result.stdoutBytes}`);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= limit, "返回缓冲不得超过上限");
  assert.equal(result.groupReaped, true);
});

test("stderr-limit：stderr 有界并在超限时杀进程组", async (t) => {
  const { executor } = await setup(t);
  const limit = 4 * 1024;
  const result = await executor.run(baseRun("stderr-limit", { stderrLimitBytes: limit, timeoutMs: 3000 }));
  assert.equal(result.state, "stderr-limit", JSON.stringify(result));
  assert.equal(result.outputLimit, "stderr-limit");
  assert.ok(result.stderrBytes > limit, `bytes=${result.stderrBytes}`);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= limit, "返回缓冲不得超过上限");
  assert.equal(result.groupReaped, true);
});

test("grandchild-cleanup：孙进程与父进程同组，close 后组内无残留", async (t) => {
  const { root, executor } = await setup(t);
  const pidFile = path.join(root, "grandchild.pid");
  const result = await executor.run(baseRun("grandchild", { args: [pidFile], timeoutMs: 2000 }));
  const grandchildPid = Number(await waitForFile(pidFile));
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);
  assert.equal(result.state, "timeout", JSON.stringify(result));
  assert.equal(result.groupReaped, true);
  assert.deepEqual(result.leftoverPids, []);
  assert.equal(pidAlive(grandchildPid), false, `孙进程 ${grandchildPid} 仍存活`);
});

test("env-scrub：不继承哨兵密钥/代理/PYTHONPATH/DYLD，只给最小 env", async (t) => {
  const { executor } = await setup(t);
  const sentinels = {
    API_KEY: "sentinel-api-key",
    OPENAI_API_KEY: "sentinel-openai",
    ANTHROPIC_API_KEY: "sentinel-anthropic",
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    ALL_PROXY: "socks5://127.0.0.1:9",
    PYTHONPATH: "/tmp/sentinel-python",
    DYLD_INSERT_LIBRARIES: "/tmp/sentinel.dylib",
    DYLD_LIBRARY_PATH: "/tmp/sentinel-lib",
    JWT_SECRET: "sentinel-jwt",
    AWS_SECRET_ACCESS_KEY: "sentinel-aws",
  };
  const previous = {};
  for (const [key, value] of Object.entries(sentinels)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let jobDir = null;
  const result = await executor.run(baseRun("env", { onSpawn: (info) => { jobDir = info.jobDir; } }));
  assert.equal(result.state, "success", JSON.stringify(result));
  const report = JSON.parse(result.stdout);
  for (const key of Object.keys(sentinels)) {
    assert.equal(report.sentinels[key], false, `${key} 不应被继承`);
  }
  assert.equal(report.allowed.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(report.allowed.LANG, "C");
  assert.equal(report.allowed.BLAS_NUM_THREADS, "1");
  assert.ok(report.allowed.HOME.startsWith(jobDir), "HOME 应指向本任务私有目录");
  assert.ok(report.allowed.TMPDIR.startsWith(jobDir), "TMPDIR 应指向本任务私有目录");
});

test("lock-release：活跃执行期间第二个 run 明确 BUSY，取消后租约释放可继续", async (t) => {
  const { dataDir, executor } = await setup(t);
  const controller = new AbortController();
  let spawnedResolve;
  const spawned = new Promise((resolve) => { spawnedResolve = resolve; });
  const firstPromise = executor.run(baseRun("cancel", {
    signal: controller.signal,
    timeoutMs: 5000,
    onSpawn: () => spawnedResolve(),
  }));
  await spawned;

  const contender = new LocalExecutor(dataDir, { graceMs: 150 });
  await assert.rejects(
    () => contender.run(baseRun("success")),
    (error) => error instanceof ExecutorError && error.code === "EXECUTION_BUSY",
  );

  controller.abort();
  const first = await firstPromise;
  assert.equal(first.state, "cancelled", JSON.stringify(first));
  assert.equal(fssync.existsSync(path.join(dataDir, ".audio-executor.lock")), false, "取消后租约应释放");

  const next = await executor.run(baseRun("success"));
  assert.equal(next.state, "success");
});

test("同进程连续任务：timeout 清理后可立即执行下一任务", async (t) => {
  const { executor } = await setup(t);
  const first = await executor.run(baseRun("timeout", { timeoutMs: 300 }));
  assert.equal(first.state, "timeout");
  const second = await executor.run(baseRun("success"));
  assert.equal(second.state, "success");
  assert.equal(second.exitCode, 0);
});

test("shell:false：参数中的 shell 元字符按字面传递，且拒绝相对命令", async (t) => {
  const { executor } = await setup(t);
  const result = await executor.run({
    command: "/bin/echo",
    args: ["literal; echo injected"],
    timeoutMs: 2000,
    stdoutLimitBytes: 1024,
    stderrLimitBytes: 1024,
  });
  assert.equal(result.state, "success", JSON.stringify(result));
  assert.equal(result.stdout, "literal; echo injected\n");
  await assert.rejects(
    () => executor.run({ command: "node", args: ["-e", "0"], timeoutMs: 1000 }),
    (error) => error instanceof ExecutorError && error.code === "INVALID_SPEC",
  );
});

test("网络隔离缺口：未设置 OS 限制时，合成子进程可连本机回环（不宣称沙箱）", async (t) => {
  const { executor } = await setup(t);
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  let report = null;
  // 偶发连接建立慢时重试，仍只连本机临时回环端口。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await executor.run(baseRun("connect", { args: ["127.0.0.1", String(port)] }));
    assert.equal(result.state, "success", JSON.stringify(result));
    report = JSON.parse(result.stdout);
    if (report.connected === true) break;
  }
  // 这是“缺口证据”：本原型没有 OS 网络隔离，不能把“可信引擎无主动联网”写成沙箱已完成。
  assert.equal(report.connected, true, "未设置 OS 隔离时应能连本机回环；若为 false 说明环境有额外限制，需记录");
});
