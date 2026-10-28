/**
 * T-LOCAL-013H：受限执行器的隔离测试。
 *
 * 只使用临时目录、合成 Node 子进程、现有 clang 临时编译的 launcher；不运行发行
 * 引擎、不读真实素材、不联网、不启动现有库/前端、不写正式服务。
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
import {
  AudioExecutor,
  AudioExecutorError,
  createAudioExecutorLauncherConfig,
} from "../server/audio-executor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const CHILD = path.join(HERE, "fixtures", "audio-executor-child.mjs");
const LAUNCHER_C = path.join(PROJECT, "server", "native", "audio-executor-launcher.c");
const NODE = process.execPath;
const CLANG = "/usr/bin/clang";

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hashFile = async (file) => sha256(await fs.readFile(file));

function compileLauncher(outDir, name, defines = {}) {
  if (!fssync.existsSync(CLANG) || !fssync.existsSync(LAUNCHER_C)) {
    return { ok: false, reason: "clang 或 launcher 源码不存在，资源限制未验证" };
  }
  const out = path.join(outDir, name);
  const args = ["-O2", "-Wall", "-Wextra", "-o", out, LAUNCHER_C];
  for (const [key, value] of Object.entries(defines)) args.push(`-D${key}=${value}`);
  const result = spawnSync(CLANG, args, { encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: `clang 编译失败：${result.error?.message || result.stderr}` };
  }
  fssync.chmodSync(out, 0o700);
  return { ok: true, path: out };
}

const buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13h-build-")));
const mainBuild = compileLauncher(buildRoot, "audio-executor-launcher");
const limitsBuild = compileLauncher(buildRoot, "audio-executor-launcher-limits", {
  AUDIO_EXECUTOR_LIMIT_CPU_SECONDS: 1,
  AUDIO_EXECUTOR_LIMIT_FSIZE_BYTES: 65536,
  AUDIO_EXECUTOR_LIMIT_NOFILE: 64,
});
const skipAll = mainBuild.ok ? false : mainBuild.reason;
const skipResource = skipAll || (limitsBuild.ok ? false : limitsBuild.reason);

after(async () => {
  await fs.rm(buildRoot, { recursive: true, force: true }).catch(() => {});
});

async function makeRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13h-")));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

async function makeSnapshot(dataDir, content = "synthetic audio snapshot") {
  const base = path.join(dataDir, "audio-jobs");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.chmod(base, 0o700);
  const dir = path.join(base, `job-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const filePath = path.join(dir, "source.bin");
  const bytes = Buffer.from(content);
  await fs.writeFile(filePath, bytes, { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600);
  return { filePath, dir, sha256: sha256(bytes), bytes: bytes.length, cleanup: async () => {} };
}

async function makeBinary(root, mode, extra = []) {
  const file = path.join(root, `engine-${mode}-${crypto.randomBytes(4).toString("hex")}.mjs`);
  const source =
    `#!${NODE}\n` +
    `process.argv.splice(2, 0, ${JSON.stringify(mode)}, ...${JSON.stringify(extra)});\n` +
    `await import(${JSON.stringify(CHILD)});\n`;
  await fs.writeFile(file, source, { mode: 0o700, flag: "wx" });
  await fs.chmod(file, 0o700);
  return file;
}

async function makeSwitchableBinary(root, initialMode, extra = []) {
  const control = path.join(root, `mode-${crypto.randomBytes(4).toString("hex")}.txt`);
  await fs.writeFile(control, initialMode, { mode: 0o600, flag: "wx" });
  const file = path.join(root, `engine-switch-${crypto.randomBytes(4).toString("hex")}.mjs`);
  const source =
    `#!${NODE}\n` +
    `import fss from "node:fs";\n` +
    `const mode = fss.readFileSync(${JSON.stringify(control)}, "utf8").trim();\n` +
    `process.argv.splice(2, 0, mode, ...${JSON.stringify(extra)});\n` +
    `await import(${JSON.stringify(CHILD)});\n`;
  await fs.writeFile(file, source, { mode: 0o700, flag: "wx" });
  await fs.chmod(file, 0o700);
  return { file, control };
}

async function makeDescriptor(bin, overrides = {}) {
  const body = await fs.readFile(bin);
  const stat = await fs.stat(bin);
  return {
    version: "1.0.0",
    platform: process.platform,
    arch: process.arch,
    releaseSha256: "a".repeat(64),
    binaryPath: bin,
    binarySha256: sha256(body),
    binarySize: stat.size,
    generation: crypto.randomBytes(16).toString("hex"),
    ...overrides,
  };
}

async function setup(t, { limits = { wallMs: 5000 }, launcher = mainBuild.path, mode = "success", extra = [] } = {}) {
  const root = await makeRoot(t);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  const bin = await makeBinary(root, mode, extra);
  const snapshot = await makeSnapshot(dataDir);
  const descriptor = await makeDescriptor(bin);
  const launcherSha = await hashFile(launcher);
  const config = createAudioExecutorLauncherConfig({ path: launcher, sha256: launcherSha });
  const executor = new AudioExecutor({ dataDir, launcher: config, limits });
  t.after(async () => {
    await executor.dispose().catch(() => {});
  });
  return { root, dataDir, bin, snapshot, descriptor, executor, launcher, launcherSha, config };
}

async function jobDirs(dataDir) {
  const root = path.join(dataDir, "audio-executor", "jobs");
  const entries = await fs.readdir(root).catch(() => []);
  return entries.filter((name) => name.startsWith("job-")).map((name) => path.join(root, name));
}

async function waitFor(fn, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error("waitFor timeout");
    await delay(intervalMs);
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const isCode = (code) => (error) => error instanceof AudioExecutorError && error.code === code;

test("正常 raw：固定 argv/最小 env/独立进程组，成功返回有界 Buffer 且只清理自己的 job", { skip: skipAll }, async (t) => {
  const { root, dataDir, executor, snapshot, descriptor } = await setup(t, { mode: "argv" });
  const jobsRoot = path.join(dataDir, "audio-executor", "jobs");
  await fs.mkdir(jobsRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(jobsRoot, 0o700);
  const keep = path.join(jobsRoot, "keep.txt");
  await fs.writeFile(keep, "keep", { mode: 0o600 });

  const raw = await executor.execute(snapshot, descriptor);
  assert.ok(Buffer.isBuffer(raw), "成功必须返回 Buffer");
  const report = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(report.args, [snapshot.filePath, "--json", "--brief"]);
  assert.deepEqual(await jobDirs(dataDir), [], "本任务目录应清理");
  assert.equal(await fs.readFile(keep, "utf8"), "keep", "共享父目录/未知文件不得删除");
  assert.equal((await fs.stat(root)).isDirectory(), true);
});

test("env 净化：不继承密钥/代理/PYTHONPATH/DYLD/NODE_OPTIONS，HOME/TMP 为任务私有", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, { mode: "env" });
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
    NODE_OPTIONS: "--require=/tmp/sentinel.js",
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

  const raw = await executor.execute(snapshot, descriptor);
  const report = JSON.parse(raw.toString("utf8"));
  for (const key of Object.keys(sentinels)) {
    assert.equal(report.sentinels[key], false, `${key} 不应被继承`);
  }
  assert.equal(report.allowed.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(report.allowed.LANG, "C");
  assert.equal(report.allowed.LC_ALL, "C");
  assert.equal(report.allowed.BLAS_NUM_THREADS, "1");
  const jobsRoot = path.join(dataDir, "audio-executor", "jobs") + path.sep;
  assert.ok(report.allowed.HOME.startsWith(jobsRoot), "HOME 必须位于本任务私有目录");
  assert.ok(report.allowed.TMPDIR.startsWith(jobsRoot), "TMPDIR 必须位于本任务私有目录");
  assert.equal(report.allowed.TMP, report.allowed.TMPDIR);
  assert.equal(report.allowed.TEMP, report.allowed.TMPDIR);
});

test("nonzero：固定 ENGINE_FAILED，不把 stderr 原文返给上层；失败后同实例可继续", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { mode: 0o700 });
  const { file: bin, control } = await makeSwitchableBinary(root, "nonzero");
  const snapshot = await makeSnapshot(dataDir);
  const descriptor = await makeDescriptor(bin);
  const config = createAudioExecutorLauncherConfig({
    path: mainBuild.path,
    sha256: await hashFile(mainBuild.path),
  });
  const executor = new AudioExecutor({ dataDir, launcher: config, limits: { wallMs: 5000 } });
  t.after(async () => executor.dispose());

  const failed = await executor.execute(snapshot, descriptor).then(
    () => null,
    (error) => error,
  );
  assert.ok(failed instanceof AudioExecutorError);
  assert.equal(failed.code, "ENGINE_FAILED");
  assert.equal(failed.message.includes("synthetic failure"), false, "不得透传 stderr 原文");
  assert.deepEqual(await jobDirs(dataDir), []);

  await fs.writeFile(control, "success", { mode: 0o600 });
  const raw = await executor.execute(snapshot, descriptor);
  assert.equal(JSON.parse(raw.toString("utf8")).bpm, 128.4);
});

test("stdout 字节上限/多字节边界：按实际 bytes 终止，返回缓冲不超过上限", { skip: skipAll }, async (t) => {
  const tight = await setup(t, { mode: "multibyte", limits: { wallMs: 5000, stdoutBytes: 20 } });
  await assert.rejects(tight.executor.execute(tight.snapshot, tight.descriptor), isCode("OUTPUT_LIMIT"));
  assert.deepEqual(await jobDirs(tight.dataDir), []);

  const exact = await setup(t, { mode: "multibyte", limits: { wallMs: 5000, stdoutBytes: 21 } });
  const raw = await exact.executor.execute(exact.snapshot, exact.descriptor);
  assert.equal(raw.length, 21, "7 个三字节字符共 21 bytes，不能被按字符数截断");
  assert.equal(raw.length <= 21, true);
  assert.equal(raw.toString("utf8"), "音".repeat(7));
});

test("stderr 字节上限：超限立即终止并固定 OUTPUT_LIMIT", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    mode: "stderr-flood",
    limits: { wallMs: 5000, stderrBytes: 1024 },
  });
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("OUTPUT_LIMIT"));
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("timeout：wall deadline 杀独立进程组，固定 TIMEOUT 且清理完成", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    mode: "sleep",
    limits: { wallMs: 4000, termGraceMs: 100 },
  });
  const started = Date.now();
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("TIMEOUT"));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 800 && elapsed < 6000, `elapsed=${elapsed}`);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("小 wall 不足 allowance：不 spawn、NO_SPAWN_BUDGET、无 job 目录", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    mode: "success",
    limits: { wallMs: 350, termGraceMs: 100 },
  });
  await assert.rejects(
    executor.execute(snapshot, descriptor),
    (error) => error?.code === "TIMEOUT" && error?.evidence?.reason === "NO_SPAWN_BUDGET",
  );
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("运行前取消：不 spawn、不建 job、不占用 busy", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    executor.execute(snapshot, descriptor, { signal: controller.signal }),
    isCode("CANCELLED"),
  );
  assert.equal(executor.busy, false);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("运行中取消：等进程组结束/目录清理后才 settle", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, { mode: "sleep" });
  const controller = new AbortController();
  const running = executor.execute(snapshot, descriptor, { signal: controller.signal });
  running.catch(() => {});
  await waitFor(async () => (await jobDirs(dataDir)).length === 1);
  const started = Date.now();
  controller.abort();
  await assert.rejects(running, isCode("CANCELLED"));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `cancel→settle=${elapsed}`);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("取消/退出交错：不挂起、不泄漏，随后任务可恢复", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, { mode: "success" });
  const controller = new AbortController();
  const racing = executor.execute(snapshot, descriptor, { signal: controller.signal });
  controller.abort();
  const outcome = await racing.then(
    () => "success",
    (error) => error?.code,
  );
  assert.ok(outcome === "success" || outcome === "CANCELLED", `outcome=${outcome}`);
  assert.deepEqual(await jobDirs(dataDir), []);

  const raw = await executor.execute(snapshot, descriptor);
  assert.equal(JSON.parse(raw.toString("utf8")).bpm, 128.4);
});

test("dispose：幂等、等待当前实际回收，关闭后拒绝新任务", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, { mode: "sleep" });
  const running = executor.execute(snapshot, descriptor);
  running.catch(() => {});
  await waitFor(() => executor.busy);
  await waitFor(async () => (await jobDirs(dataDir)).length === 1);

  const first = executor.dispose();
  const second = executor.dispose();
  assert.equal(first, second, "dispose 必须幂等");
  await first;
  await assert.rejects(running, isCode("CANCELLED"));
  assert.equal(executor.busy, false);
  assert.deepEqual(await jobDirs(dataDir), []);
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("EXECUTION_UNAVAILABLE"));
});

test("第二任务 BUSY；job 目录 0700、owner 0600；取消后恢复", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { mode: 0o700 });
  const { file: bin, control } = await makeSwitchableBinary(root, "sleep");
  const snapshot = await makeSnapshot(dataDir);
  const descriptor = await makeDescriptor(bin);
  const config = createAudioExecutorLauncherConfig({
    path: mainBuild.path,
    sha256: await hashFile(mainBuild.path),
  });
  const executor = new AudioExecutor({ dataDir, launcher: config, limits: { wallMs: 5000 } });
  t.after(async () => executor.dispose());

  const controller = new AbortController();
  const running = executor.execute(snapshot, descriptor, { signal: controller.signal });
  running.catch(() => {});
  const dir = await waitFor(async () => (await jobDirs(dataDir))[0]);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dir, ".owner.json"))).mode & 0o777, 0o600);
  for (const name of ["work", "home", "tmp"]) {
    assert.equal((await fs.stat(path.join(dir, name))).mode & 0o777, 0o700);
  }
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("EXECUTION_BUSY"));
  controller.abort();
  await assert.rejects(running, isCode("CANCELLED"));
  await fs.writeFile(control, "success", { mode: 0o600 });
  const raw = await executor.execute(snapshot, descriptor);
  assert.ok(Buffer.isBuffer(raw));
});

test("spawn ENOENT/EACCES：受控 ENGINE_FAILED，等 close、清目录，同实例下一任务成功", { skip: skipAll }, async (t) => {
  const { root, dataDir, snapshot, descriptor } = await setup(t);
  const interp = path.join(root, "synthetic-interp");
  await fs.symlink("/bin/sh", interp);
  const script = path.join(root, "synthetic-launcher");
  await fs.writeFile(script, `#!${interp}\nexec "$@"\n`, { mode: 0o700, flag: "wx" });
  await fs.chmod(script, 0o700);
  const config = createAudioExecutorLauncherConfig({ path: script, sha256: await hashFile(script) });
  const executor = new AudioExecutor({ dataDir, launcher: config, limits: { wallMs: 5000 } });
  t.after(async () => executor.dispose());

  const ok = await executor.execute(snapshot, descriptor);
  assert.ok(Buffer.isBuffer(ok));

  await fs.unlink(interp);
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("ENGINE_FAILED"));
  assert.deepEqual(await jobDirs(dataDir), []);

  await fs.symlink("/bin/sh", interp);
  assert.ok(Buffer.isBuffer(await executor.execute(snapshot, descriptor)));

  await fs.chmod(script, 0o600);
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("ENGINE_FAILED"));
  assert.deepEqual(await jobDirs(dataDir), []);

  await fs.chmod(script, 0o700);
  assert.ok(Buffer.isBuffer(await executor.execute(snapshot, descriptor)));
});

test("launcher 缺失/篡改：固定 EXECUTION_UNAVAILABLE，恢复后同实例可运行", { skip: skipAll }, async (t) => {
  const { root, dataDir, snapshot, descriptor } = await setup(t);
  const copy = path.join(root, "launcher-copy");
  await fs.copyFile(mainBuild.path, copy);
  await fs.chmod(copy, 0o700);
  const original = await fs.readFile(copy);
  const config = createAudioExecutorLauncherConfig({ path: copy, sha256: sha256(original) });
  const executor = new AudioExecutor({ dataDir, launcher: config, limits: { wallMs: 5000 } });
  t.after(async () => executor.dispose());

  assert.ok(Buffer.isBuffer(await executor.execute(snapshot, descriptor)));

  await fs.unlink(copy);
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("EXECUTION_UNAVAILABLE"));
  assert.deepEqual(await jobDirs(dataDir), []);

  await fs.writeFile(copy, original, { mode: 0o700 });
  assert.ok(Buffer.isBuffer(await executor.execute(snapshot, descriptor)));

  await fs.appendFile(copy, "tampered");
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("EXECUTION_UNAVAILABLE"));
  assert.deepEqual(await jobDirs(dataDir), []);

  await fs.writeFile(copy, original, { mode: 0o700 });
  assert.ok(Buffer.isBuffer(await executor.execute(snapshot, descriptor)));
});

test("binary 同长度篡改：摘要校验拒绝且不 spawn；恢复后成功", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor, bin } = await setup(t);
  const original = await fs.readFile(bin);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0x01;
  await fs.writeFile(bin, tampered, { mode: 0o700 });
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("EXECUTION_UNAVAILABLE"));
  assert.deepEqual(await jobDirs(dataDir), []);
  await fs.writeFile(bin, original, { mode: 0o700 });
  assert.ok(Buffer.isBuffer(await executor.execute(snapshot, descriptor)));
});

test("路径 symlink：快照/二进制符号链接均拒绝，外部目标不变", { skip: skipAll }, async (t) => {
  const { root, dataDir, executor, snapshot, descriptor, bin } = await setup(t);
  const external = path.join(root, "external.bin");
  await fs.writeFile(external, "external-content", { mode: 0o600 });
  const externalBefore = await fs.readFile(external);

  const linkDir = path.join(dataDir, "audio-jobs", "job-symlink");
  await fs.mkdir(linkDir, { mode: 0o700 });
  await fs.chmod(linkDir, 0o700);
  const link = path.join(linkDir, "source.bin");
  await fs.symlink(external, link);
  const linkSnapshot = {
    filePath: link,
    dir: linkDir,
    sha256: sha256(externalBefore),
    bytes: externalBefore.length,
  };
  const linkError = await executor.execute(linkSnapshot, descriptor).then(
    () => null,
    (error) => error,
  );
  assert.ok(linkError instanceof AudioExecutorError);
  assert.ok(["EXECUTION_UNAVAILABLE", "INVALID_REQUEST"].includes(linkError.code), linkError.code);
  assert.deepEqual(await fs.readFile(external), externalBefore, "外部目标不得被修改");

  const binLink = path.join(root, "engine-link.mjs");
  await fs.symlink(bin, binLink);
  const linkedDescriptor = { ...descriptor, binaryPath: binLink };
  await assert.rejects(executor.execute(snapshot, linkedDescriptor), isCode("EXECUTION_UNAVAILABLE"));
});

test("jobs 祖先 symlink：准备前拒绝，外部目标不新增/不改动", { skip: skipAll }, async (t) => {
  const { root, dataDir, executor, snapshot, descriptor } = await setup(t);
  const outside = path.join(root, "outside-target");
  await fs.mkdir(outside, { mode: 0o700 });
  await fs.chmod(outside, 0o700);
  await fs.writeFile(path.join(outside, "keep"), "unchanged", { mode: 0o600 });
  await fs.symlink(outside, path.join(dataDir, "audio-executor"));

  const error = await executor.execute(snapshot, descriptor).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error instanceof AudioExecutorError);
  assert.equal(error.code, "EXECUTION_UNAVAILABLE");
  assert.deepEqual((await fs.readdir(outside)).sort(), ["keep"], "不得穿过链接创建 jobs");
  assert.equal(await fs.readFile(path.join(outside, "keep"), "utf8"), "unchanged");
});

test("jobs 祖先为普通文件/准备失败：固定 EXECUTION_UNAVAILABLE，不泄露私有路径", { skip: skipAll }, async (t) => {
  const { root, dataDir, executor, snapshot, descriptor } = await setup(t);
  const blocked = path.join(dataDir, "audio-executor");
  await fs.writeFile(blocked, "blocking file", { mode: 0o600 });

  const first = await executor.execute(snapshot, descriptor).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(first instanceof AudioExecutorError);
  assert.equal(first.code, "EXECUTION_UNAVAILABLE");
  assert.equal(first.message, "音频执行器不可用");
  assert.equal(String(first.message).includes(root), false, "不得返回原始路径");
  assert.equal(String(first.message).includes(dataDir), false, "不得返回原始路径");

  // 缺 jobs 且父级正常：逐级准备失败也必须走同一边界（旧实现此处会漏 ENOTDIR）。
  await fs.unlink(blocked);
  await fs.mkdir(blocked, { mode: 0o700 });
  await fs.chmod(blocked, 0o700);
  await fs.writeFile(path.join(blocked, "jobs"), "blocking jobs", { mode: 0o600 });
  const second = await executor.execute(snapshot, descriptor).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(second instanceof AudioExecutorError);
  assert.equal(second.code, "EXECUTION_UNAVAILABLE");
  assert.equal(String(second.message).includes(root), false);
  assert.equal(await fs.readFile(path.join(blocked, "jobs"), "utf8"), "blocking jobs");
});

test("清理不跟随未验证祖先：运行中 audio-executor 被换成 symlink，外部目标不被删除", { skip: skipAll }, async (t) => {
  const { root, dataDir, executor, snapshot, descriptor } = await setup(t, { mode: "sleep" });
  const controller = new AbortController();
  const running = executor.execute(snapshot, descriptor, { signal: controller.signal });
  running.catch(() => {});
  const jobDir = await waitFor(async () => {
    const dir = (await jobDirs(dataDir))[0];
    if (!dir) return null;
    const marker = await fs.lstat(path.join(dir, ".owner.json")).catch(() => null);
    return marker ? dir : null;
  });
  const jobName = path.basename(jobDir);

  const outside = path.join(root, "outside-cleanup");
  const decoy = path.join(outside, "jobs", jobName);
  await fs.mkdir(decoy, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(decoy, "keep"), "external", { mode: 0o600 });
  await fs.copyFile(path.join(jobDir, ".owner.json"), path.join(decoy, ".owner.json"));

  const audioRoot = path.join(dataDir, "audio-executor");
  await fs.rename(audioRoot, path.join(dataDir, "audio-executor-moved"));
  await fs.symlink(outside, audioRoot);

  controller.abort();
  await assert.rejects(running, isCode("EXECUTION_UNAVAILABLE"));
  assert.deepEqual(await fs.readdir(path.join(outside, "jobs")), [jobName], "外部诱饵目录不得被删");
  assert.equal(await fs.readFile(path.join(decoy, "keep"), "utf8"), "external");
});

test("descriptor 形状/平台/绝对路径：不支持平台与相对路径固定拒绝", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t);
  await assert.rejects(
    executor.execute(snapshot, { ...descriptor, platform: "unsupported-platform" }),
    isCode("EXECUTION_UNAVAILABLE"),
  );
  await assert.rejects(
    executor.execute(snapshot, { ...descriptor, binaryPath: "relative-binary" }),
    isCode("EXECUTION_UNAVAILABLE"),
  );
  await assert.rejects(executor.execute(snapshot, { ...descriptor, binarySha256: "x" }), isCode("INVALID_REQUEST"));
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("无 launcher / 提高上限 / 非受信配置：构造或执行前固定拒绝", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t);
  const noLauncher = new AudioExecutor({ dataDir });
  await assert.rejects(noLauncher.execute(snapshot, descriptor), isCode("EXECUTION_UNAVAILABLE"));
  await noLauncher.dispose();

  assert.throws(
    () => new AudioExecutor({ dataDir, launcher: { path: mainBuild.path, sha256: "a".repeat(64) } }),
    isCode("INVALID_REQUEST"),
  );
  assert.throws(
    () => new AudioExecutor({ dataDir, launcher: { path: mainBuild.path, sha256: "a".repeat(64) }, limits: { wallMs: 180_001 } }),
    isCode("INVALID_REQUEST"),
  );
  assert.throws(
    () => createAudioExecutorLauncherConfig({ path: "relative", sha256: "a".repeat(64) }),
    isCode("INVALID_REQUEST"),
  );
  await assert.rejects(executor.execute(snapshot, descriptor, { command: "/bin/sh" }), isCode("INVALID_REQUEST"));
});

test("清理失败：保持故障 busy，不接受下一任务；只动本次目录", { skip: skipAll }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, { mode: "sleep" });
  const controller = new AbortController();
  const running = executor.execute(snapshot, descriptor, { signal: controller.signal });
  running.catch(() => {});
  const dir = await waitFor(async () => (await jobDirs(dataDir))[0]);
  await fs.chmod(dir, 0o500);
  controller.abort();
  await assert.rejects(running, isCode("EXECUTION_UNAVAILABLE"));
  assert.equal(executor.busy, false);
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("EXECUTION_UNAVAILABLE"));

  // 现场保留用于诊断；测试结束前恢复权限让临时根可回收。
  await fs.chmod(dir, 0o700);
});

test("父退出、孙进程继承 stdio：close 被拖住，wall deadline 杀整组", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const pidFile = path.join(root, "grandchild-inherit.pid");
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    mode: "grandchild-inherit",
    extra: [pidFile],
    limits: { wallMs: 4000, termGraceMs: 100 },
  });
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("TIMEOUT"));
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(pidAlive(pid), false, `孙进程 ${pid} 仍存活`);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("父退出、孙进程关闭 stdio：close 后仍检测并清理同组孙进程", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const pidFile = path.join(root, "grandchild-closed.pid");
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    mode: "grandchild-closed",
    extra: [pidFile],
    limits: { wallMs: 5000 },
  });
  const raw = await executor.execute(snapshot, descriptor);
  assert.ok(Buffer.isBuffer(raw));
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(pidAlive(pid), false, `孙进程 ${pid} 仍存活`);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("launcher 资源限制：CPU 1s 触发 SIGXCPU 固定 RESOURCE_LIMIT", { skip: skipResource }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    launcher: limitsBuild.path,
    mode: "cpu",
    limits: { wallMs: 5000, termGraceMs: 100 },
  });
  await assert.rejects(executor.execute(snapshot, descriptor), isCode("RESOURCE_LIMIT"));
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("launcher 资源限制：FSIZE 65536 字节内收口", { skip: skipResource }, async (t) => {
  const root = await makeRoot(t);
  const target = path.join(root, "fsize.bin");
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    launcher: limitsBuild.path,
    mode: "fsize",
    extra: [target],
    limits: { wallMs: 5000 },
  });
  const outcome = await executor.execute(snapshot, descriptor).then(
    () => "success",
    (error) => error?.code,
  );
  assert.ok(outcome === "success" || outcome === "RESOURCE_LIMIT", `outcome=${outcome}`);
  const stat = await fs.stat(target);
  assert.ok(stat.size > 0 && stat.size <= 65536, `fsize=${stat.size}`);
  assert.deepEqual(await jobDirs(dataDir), []);
});

test("launcher 资源限制：NOFILE 64 内触发 EMFILE", { skip: skipResource }, async (t) => {
  const { dataDir, executor, snapshot, descriptor } = await setup(t, {
    launcher: limitsBuild.path,
    mode: "nofile",
    limits: { wallMs: 5000 },
  });
  const raw = await executor.execute(snapshot, descriptor);
  const report = JSON.parse(raw.toString("utf8"));
  assert.equal(report.errorCode, "EMFILE");
  assert.ok(report.opened > 0 && report.opened < 64, `opened=${report.opened}`);
  assert.deepEqual(await jobDirs(dataDir), []);
});
