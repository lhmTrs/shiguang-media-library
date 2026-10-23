/**
 * T-LOCAL-013C：可信引擎描述符与运行租约的定向测试。
 *
 * 全部使用临时目录、随机回环 TLS、合成小归档与合成进程；不访问生产服务器、
 * 不下载/运行发行引擎、不碰真实素材/库、不部署/重启/提交推送。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AudioEngine } from "../server/audio-engine.mjs";
import {
  delay,
  exists,
  makeRelease,
  makeTar,
  makeTlsFixture,
  startTlsServer,
  tempDir,
  waitForJob,
} from "./audio-engine-fixtures.mjs";

const PROJECT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BINARY = Buffer.from("#!/bin/sh\necho runtime-fixture\n", "utf8");
const execFileAsync = promisify(execFile);

async function setup(t, archive, overrides = {}) {
  const root = await tempDir(t, "shiguang-t13c-");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const tls = await makeTlsFixture(t);
  let body = archive;
  const server = await startTlsServer(t, tls, async (req, res) => {
    if (overrides.handler) return overrides.handler(req, res, body);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": body.length });
    res.end(body);
  });
  const release = makeRelease(archive, server.url, overrides.release);
  const engine = new AudioEngine(dataDir, {
    release,
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    idleTimeoutMs: 1000,
    totalTimeoutMs: 5000,
    diskFreeBytes: overrides.diskFreeBytes ?? 1024 * 1024 * 1024,
    hooks: overrides.hooks,
  });
  t.after(() => engine.dispose());
  const setBody = (next) => {
    body = next;
  };
  return { root, dataDir, tls, server, release, engine, setBody };
}

function lockPath(dataDir) {
  return path.join(dataDir, "engines", ".audio-install.lock");
}

async function installOk(engine) {
  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  return status;
}

async function installPaths(dataDir) {
  const engineRoot = path.join(dataDir, "engines", "audio");
  const pointer = JSON.parse(await fs.readFile(path.join(engineRoot, "current.json"), "utf8"));
  const dir = path.join(engineRoot, "versions", pointer.dir);
  const marker = JSON.parse(await fs.readFile(path.join(dir, ".installed.json"), "utf8"));
  return { engineRoot, versions: path.join(engineRoot, "versions"), dir, pointer, marker, binary: path.join(dir, "audio-analyze") };
}

async function writeJson(file, value) {
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
}

async function cleanLock(dataDir) {
  await fs.rm(lockPath(dataDir), { recursive: true, force: true }).catch(() => {});
}

function assertLockReleased(dataDir) {
  assert.equal(exists(lockPath(dataDir)), false, "运行结束后锁必须释放");
}

test("新安装写入 v2 元数据；withRunLease 交付冻结 descriptor 且不联网/不写状态", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY, mode: 0o755 }]);
  const { dataDir, server, engine, release } = await setup(t, archive);
  await installOk(engine);
  const paths = await installPaths(dataDir);

  assert.equal(paths.pointer.metadataVersion, 2);
  assert.equal(paths.marker.metadataVersion, 2);
  assert.equal(paths.pointer.binarySha256, crypto.createHash("sha256").update(BINARY).digest("hex"));
  assert.equal(paths.marker.binarySha256, paths.pointer.binarySha256);
  assert.equal(paths.marker.binarySize, BINARY.length);
  assert.equal(paths.pointer.binarySize, BINARY.length);
  assert.match(paths.marker.generation, /^[0-9a-f]{32,64}$/);
  assert.equal(paths.pointer.generation, paths.marker.generation);

  const requestsBefore = server.counts.requests;
  let seen = null;
  const result = await engine.withRunLease(async (descriptor, signal) => {
    seen = descriptor;
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
    assert.equal(signal.signal, signal);
    return 42;
  });
  assert.equal(result, 42);
  assert.ok(Object.isFrozen(seen));
  assert.deepEqual(Object.keys(seen).sort(), [
    "arch",
    "binaryPath",
    "binarySha256",
    "binarySize",
    "generation",
    "platform",
    "releaseSha256",
    "version",
  ]);
  assert.equal(seen.version, release.version);
  assert.equal(seen.platform, release.platform);
  assert.equal(seen.arch, release.arch);
  assert.equal(seen.releaseSha256, release.sha256);
  assert.equal(seen.binarySha256, paths.marker.binarySha256);
  assert.equal(seen.binarySize, BINARY.length);
  assert.equal(seen.generation, paths.marker.generation);
  assert.equal(seen.binaryPath, paths.binary);
  assert.equal(server.counts.requests, requestsBefore, "运行校验不得联网");
  assertLockReleased(dataDir);
  assert.equal(engine.status().path, null, "公开 status 不得带本机路径");

  // status/getter 只读本地元数据：不创建锁、不修改安装文件或 hash。
  const before = fssync.statSync(paths.binary);
  for (let i = 0; i < 100; i += 1) {
    assert.equal(engine.status().installed, true);
    assert.equal(engine.version, release.version);
    assert.equal(engine.binaryPath, paths.binary);
  }
  const after = fssync.statSync(paths.binary);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
  assert.equal(exists(lockPath(dataDir)), false);
  const tmp = path.join(dataDir, "engines", ".tmp");
  if (exists(tmp)) assert.deepEqual(fssync.readdirSync(tmp), []);
});

test("旧 marker/generation 缺失时 status 兼容但运行固定拒绝；显式同版本重装升级且仍校验归档", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, server, engine, release } = await setup(t, archive);
  await installOk(engine);
  const paths = await installPaths(dataDir);
  const firstGeneration = paths.marker.generation;

  for (const file of [path.join(dataDir, "engines/audio/current.json"), path.join(paths.dir, ".installed.json")]) {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    delete value.metadataVersion;
    delete value.binarySha256;
    delete value.binarySize;
    delete value.generation;
    await writeJson(file, value);
  }
  assert.equal(engine.status().installed, true, "旧元数据保留 status 兼容");
  assert.equal(engine.version, release.version);
  let called = false;
  await assert.rejects(
    engine.withRunLease(async () => {
      called = true;
    }),
    (error) => error.code === "ENGINE_REINSTALL_REQUIRED",
  );
  assert.equal(called, false, "旧安装不得调用 callback");
  assertLockReleased(dataDir);

  // 同版本快速返回必须被旧元数据挡住，走完整下载/归档校验后升级。
  const requestsBefore = server.counts.requests;
  await installOk(engine);
  assert.equal(server.counts.requests, requestsBefore + 1, "旧元数据必须真正重装而不是快速返回");
  const upgraded = await installPaths(dataDir);
  assert.equal(upgraded.marker.metadataVersion, 2);
  assert.notEqual(upgraded.marker.generation, firstGeneration, "重装必须产生新 generation");
  await engine.withRunLease(async () => {});
  assertLockReleased(dataDir);

  // 旧平铺安装：status 兼容、运行拒绝；同版本重装升级。
  await fs.rm(path.join(dataDir, "engines/audio/current.json"));
  await fs.copyFile(upgraded.binary, path.join(dataDir, "engines/audio/audio-analyze"));
  await writeJson(path.join(dataDir, "engines/audio/.installed.json"), {
    version: release.version,
    sha256: release.sha256,
    binary: "audio-analyze",
  });
  assert.equal(engine.status().installed, true);
  await assert.rejects(
    engine.withRunLease(async () => {}),
    (error) => error.code === "ENGINE_REINSTALL_REQUIRED",
  );
  const flatRequests = server.counts.requests;
  await installOk(engine);
  assert.equal(server.counts.requests, flatRequests + 1);
  assert.equal(exists(path.join(dataDir, "engines/audio/audio-analyze")), false, "升级后应清理旧平铺文件");
  await engine.withRunLease(async () => {});
  assertLockReleased(dataDir);

  // 为升级元数据也不能绕过归档校验：发布摘要错误时必须失败且旧平铺安装仍在。
  const beforeBadUpgrade = await installPaths(dataDir);
  await fs.rm(path.join(dataDir, "engines/audio/current.json"));
  await fs.copyFile(beforeBadUpgrade.binary, path.join(dataDir, "engines/audio/audio-analyze"));
  await writeJson(path.join(dataDir, "engines/audio/.installed.json"), {
    version: release.version,
    sha256: release.sha256,
    binary: "audio-analyze",
  });
  engine.release = Object.freeze({ ...release, sha256: "0".repeat(64) });
  engine.install({ confirm: true });
  const bad = await waitForJob(engine);
  assert.equal(bad.job.state, "error", JSON.stringify(bad));
  assert.equal(bad.job.error.code, "ENGINE_HASH_MISMATCH");
  assert.equal(exists(path.join(dataDir, "engines/audio/.installed.json")), true, "失败的升级不得删除旧安装");
  assertLockReleased(dataDir);
});

test("篡改同长度文件、错误摘要、伪造发行身份、pointer/marker 代次冲突均拒绝", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine, release } = await setup(t, archive);

  const reset = async () => {
    await engine.uninstall();
    await installOk(engine);
    return installPaths(dataDir);
  };

  let paths = await reset();
  await fs.writeFile(paths.binary, Buffer.alloc(BINARY.length, 0x41), { mode: 0o755 });
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_INTEGRITY_FAILED");
  assertLockReleased(dataDir);

  paths = await reset();
  paths.pointer.binarySha256 = "0".repeat(64);
  paths.marker.binarySha256 = "0".repeat(64);
  await writeJson(path.join(dataDir, "engines/audio/current.json"), paths.pointer);
  await writeJson(path.join(paths.dir, ".installed.json"), paths.marker);
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_INTEGRITY_FAILED");
  assertLockReleased(dataDir);

  paths = await installPaths(dataDir);
  paths.pointer.version = "9.9.9-forged";
  paths.pointer.releaseSha256 = "f".repeat(64);
  paths.marker.version = paths.pointer.version;
  paths.marker.releaseSha256 = paths.pointer.releaseSha256;
  await writeJson(path.join(dataDir, "engines/audio/current.json"), paths.pointer);
  await writeJson(path.join(paths.dir, ".installed.json"), paths.marker);
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_RELEASE_MISMATCH");
  assertLockReleased(dataDir);

  paths = await reset();
  paths.pointer.generation = "b".repeat(32);
  await writeJson(path.join(dataDir, "engines/audio/current.json"), paths.pointer);
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_INTEGRITY_FAILED");
  assertLockReleased(dataDir);

  // 平台与内置发布不一致时，运行前拒绝。
  paths = await reset();
  engine.platform = "linux";
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "UNSUPPORTED_PLATFORM");
  engine.platform = "darwin";
  assertLockReleased(dataDir);
  await engine.withRunLease(async () => {});
  assert.equal(engine.status().version, release.version);

  await engine.uninstall();
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_NOT_INSTALLED");
  assertLockReleased(dataDir);
});

test("路径链链接、FIFO、hash 期间替换/原位修改均受控拒绝且不跟随", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { root, dataDir, engine } = await setup(t, archive);
  await installOk(engine);
  let paths = await installPaths(dataDir);

  const outside = path.join(root, "outside-versions");
  await fs.rename(paths.versions, outside);
  await fs.symlink(outside, paths.versions);
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_UNSAFE_TARGET");
  assertLockReleased(dataDir);
  await fs.rm(paths.versions);
  await fs.rename(outside, paths.versions);

  // FIFO 替换：O_NONBLOCK 打开不能挂起，fstat 非普通文件必须拒绝。
  const fifo = paths.binary;
  const saved = path.join(root, "saved-binary");
  await fs.rename(fifo, saved);
  await execFileAsync("mkfifo", [fifo]);
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_INTEGRITY_FAILED");
  assertLockReleased(dataDir);
  await fs.rm(fifo);
  await fs.rename(saved, fifo);

  // hash 期间把路径换成同内容但不同 inode 的文件：打开的 fd 内容通过，最终路径身份不一致必须拒绝。
  let swapped = false;
  engine.hooks.runtimeHashChunk = async ({ offset }) => {
    if (swapped || offset <= 0) return;
    swapped = true;
    const moved = path.join(root, "moved-during-hash");
    await fs.rename(fifo, moved);
    await fs.writeFile(fifo, BINARY, { mode: 0o755 });
  };
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_INTEGRITY_FAILED");
  assert.equal(swapped, true);
  assertLockReleased(dataDir);
  engine.hooks.runtimeHashChunk = undefined;
  await engine.uninstall();
  await installOk(engine);
  paths = await installPaths(dataDir);

  // 原位改写：读取前后 ctime/mtime 或内容变化都必须拒绝。
  let modified = false;
  engine.hooks.runtimeHashChunk = async ({ offset, total }) => {
    if (modified || offset <= 0) return;
    modified = true;
    const handle = await fs.open(paths.binary, "r+");
    try {
      await handle.write(Buffer.from([0xff]), 0, 1, total - 1);
    } finally {
      await handle.close();
    }
  };
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_INTEGRITY_FAILED");
  assert.equal(modified, true);
  assertLockReleased(dataDir);
  engine.hooks.runtimeHashChunk = undefined;

  // hash 期间替换 pointer 的 generation（文件本身不变）：重读 pointer 后必须拒绝。
  let pointerChanged = false;
  const pointerPath = path.join(dataDir, "engines/audio/current.json");
  engine.hooks.runtimeHashChunk = async ({ offset }) => {
    if (pointerChanged || offset <= 0) return;
    pointerChanged = true;
    const pointer = JSON.parse(await fs.readFile(pointerPath, "utf8"));
    pointer.generation = "c".repeat(32);
    await writeJson(pointerPath, pointer);
  };
  await assert.rejects(
    engine.withRunLease(async () => {}),
    (error) => error.code === "ENGINE_INTEGRITY_FAILED" && !error.message.includes(dataDir),
  );
  assert.equal(pointerChanged, true);
  assertLockReleased(dataDir);
  engine.hooks.runtimeHashChunk = undefined;

  // 失败后重装即可恢复下一次运行。
  await engine.uninstall();
  await installOk(engine);
  await engine.withRunLease(async () => {});
  assertLockReleased(dataDir);
});

test("运行租约与安装/卸载/第二实例/独立 Node 子进程共享同一把跨进程锁", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine, release } = await setup(t, archive);
  await installOk(engine);

  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const runPromise = engine.withRunLease(async () => {
    signalStarted();
    await gate;
    return "held";
  });
  await started;
  assert.equal(exists(lockPath(dataDir)), true);

  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error.code === "ENGINE_BUSY",
    "运行持锁时 install 必须 BUSY",
  );
  await assert.rejects(engine.uninstall(), (error) => error.code === "ENGINE_BUSY");
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_BUSY");

  const other = new AudioEngine(dataDir, {
    release,
    ca: Buffer.alloc(0),
    platform: "darwin",
    arch: "arm64",
    diskFreeBytes: 1024 * 1024 * 1024,
  });
  t.after(() => other.dispose());
  await assert.rejects(other.withRunLease(async () => {}), (error) => error.code === "ENGINE_BUSY");

  const base = await tempDir(t, "shiguang-t13c-child-");
  const script = path.join(base, "child-run.mjs");
  await fs.writeFile(
    script,
    `
import { AudioEngine } from ${JSON.stringify(pathToFileURL(path.join(PROJECT, "server/audio-engine.mjs")).href)};
const engine = new AudioEngine(process.env.DATA_DIR, {
  release: JSON.parse(process.env.RELEASE_JSON),
  ca: Buffer.alloc(0),
  platform: "darwin",
  arch: "arm64",
  diskFreeBytes: 1024 * 1024 * 1024,
});
try {
  await engine.withRunLease(async () => {
    console.log("CHILD_LEASED");
    if (process.env.MODE === "hold") await new Promise((resolve) => setTimeout(resolve, 1200));
  });
  console.log("CHILD_OK");
} catch (error) {
  console.log("CHILD_" + (error.code || "ERROR"));
} finally {
  engine.dispose();
}
`,
  );
  const env = { ...process.env, DATA_DIR: dataDir, RELEASE_JSON: JSON.stringify(release), MODE: "probe" };
  const child = spawn(process.execPath, [script], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !output.includes("CHILD_")) await delay(20);
  assert.match(output, /CHILD_ENGINE_BUSY/, output);
  releaseGate();
  assert.equal(await runPromise, "held");
  await engine.withRunLease(async () => { "parent can run after release"; });
  assertLockReleased(dataDir);

  // 反向：子进程持锁，父进程 BUSY；子进程结束后父进程恢复。
  const holder = spawn(process.execPath, [script], {
    env: { ...env, MODE: "hold" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let holderOutput = "";
  holder.stdout.setEncoding("utf8").on("data", (chunk) => (holderOutput += chunk));
  holder.stderr.setEncoding("utf8").on("data", (chunk) => (holderOutput += chunk));
  t.after(() => {
    if (holder.exitCode === null) holder.kill("SIGKILL");
  });
  const holderDeadline = Date.now() + 5000;
  while (Date.now() < holderDeadline && !holderOutput.includes("CHILD_LEASED")) await delay(20);
  assert.match(holderOutput, /CHILD_LEASED/, holderOutput);
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_BUSY");
  await Promise.race([once(holder, "exit"), delay(5000)]);
  assertLockReleased(dataDir);
  await engine.withRunLease(async () => {});
});

test("callback 同步 throw/reject/缺省参数受控；预取消、运行中 Abort、cancel、dispose 都等到真正结束才放锁", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine } = await setup(t, archive);
  await installOk(engine);

  await assert.rejects(engine.withRunLease(), (error) => error.code === "ENGINE_INVALID_CALLBACK");
  assertLockReleased(dataDir);

  await assert.rejects(
    engine.withRunLease(() => {
      throw new Error("secret callback detail");
    }),
    (error) => error.code === "ENGINE_RUN_FAILED" && !error.message.includes("secret"),
  );
  assertLockReleased(dataDir);

  await assert.rejects(
    engine.withRunLease(async () => {
      throw new Error("secret async detail");
    }),
    (error) => error.code === "ENGINE_RUN_FAILED" && !error.message.includes("secret"),
  );
  assertLockReleased(dataDir);
  await engine.withRunLease(async () => {});

  const pre = new AbortController();
  pre.abort();
  let preCalled = false;
  await assert.rejects(
    engine.withRunLease(async () => {
      preCalled = true;
    }, { signal: pre.signal }),
    (error) => error.code === "ENGINE_CANCELLED",
  );
  assert.equal(preCalled, false);
  assertLockReleased(dataDir);

  // AbortSignal：abort 后 promise 不得抢先 settle，锁保持到 callback 真正结束。
  {
    const controller = new AbortController();
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    let startedSignal;
    const started = new Promise((resolve) => {
      startedSignal = resolve;
    });
    let callbackSignal = null;
    let settled = false;
    const promise = engine.withRunLease(
      async (_descriptor, { signal }) => {
        callbackSignal = signal;
        startedSignal();
        await gate;
        return "late";
      },
      { signal: controller.signal },
    );
    promise.finally(() => {
      settled = true;
    }).catch(() => {});
    await started;
    controller.abort();
    await delay(40);
    assert.equal(settled, false, "abort 不能 Promise.race 提前返回");
    assert.equal(exists(lockPath(dataDir)), true, "callback 未结束前不得放锁");
    assert.equal(callbackSignal.aborted, true, "callback 必须收到取消信号");
    releaseGate();
    await assert.rejects(promise, (error) => error.code === "ENGINE_CANCELLED");
    assert.equal(settled, true);
    assertLockReleased(dataDir);
  }

  // engine.cancel()：等待 callback settle 后才返回，且不提前放锁。
  {
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    let startedSignal;
    const started = new Promise((resolve) => {
      startedSignal = resolve;
    });
    let settled = false;
    const promise = engine.withRunLease(async () => {
      startedSignal();
      await gate;
      return "late";
    });
    promise.finally(() => {
      settled = true;
    }).catch(() => {});
    await started;
    const cancelPromise = engine.cancel();
    let cancelSettled = false;
    cancelPromise.finally(() => {
      cancelSettled = true;
    });
    await delay(40);
    assert.equal(settled, false);
    assert.equal(cancelSettled, false, "cancel() 不得在 callback 结束前返回");
    assert.equal(exists(lockPath(dataDir)), true);
    releaseGate();
    await cancelPromise;
    await assert.rejects(promise, (error) => error.code === "ENGINE_CANCELLED");
    assertLockReleased(dataDir);
  }

  // dispose() 只请求取消；不强制结束不合作 callback。
  {
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    let startedSignal;
    const started = new Promise((resolve) => {
      startedSignal = resolve;
    });
    let settled = false;
    const promise = engine.withRunLease(async () => {
      startedSignal();
      await gate;
      return "late";
    });
    promise.finally(() => {
      settled = true;
    }).catch(() => {});
    await started;
    engine.dispose();
    await delay(40);
    assert.equal(settled, false, "dispose 不得强制结束 callback");
    assert.equal(exists(lockPath(dataDir)), true, "dispose 不得提前释放锁");
    releaseGate();
    await assert.rejects(promise, (error) => error.code === "ENGINE_CANCELLED");
    assertLockReleased(dataDir);
  }
});

test("锁释放失败/坏 owner/未知条目 fail-closed：保留锁与未知内容，不递归删除", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine } = await setup(t, archive);
  await installOk(engine);

  // 未知条目：释放不得递归删除，必须保留并返回 LOCK_FAILED。
  await assert.rejects(
    engine.withRunLease(async () => {
      await fs.writeFile(path.join(lockPath(dataDir), "unknown-entry.txt"), "keep");
    }),
    (error) => error.code === "ENGINE_LOCK_FAILED",
  );
  assert.equal(exists(path.join(lockPath(dataDir), "unknown-entry.txt")), true, "未知条目必须保留");
  assert.equal(exists(path.join(lockPath(dataDir), "owner.json")), true, "锁仍应可识别");
  await cleanLock(dataDir);
  await engine.withRunLease(async () => {});

  // owner token 被替换：归属不明，保留锁并拒绝假装释放。
  await assert.rejects(
    engine.withRunLease(async () => {
      await writeJson(path.join(lockPath(dataDir), "owner.json"), {
        pid: process.pid,
        token: "not-ours",
        jobId: "foreign",
        startedAt: new Date().toISOString(),
      });
    }),
    (error) => error.code === "ENGINE_LOCK_FAILED",
  );
  assert.equal(JSON.parse(await fs.readFile(path.join(lockPath(dataDir), "owner.json"), "utf8")).token, "not-ours");
  await cleanLock(dataDir);
  await engine.withRunLease(async () => {});

  // unlink 失败：保留 owner 与锁，返回固定码；恢复后下一次运行正常。
  const unlink = fs.unlink;
  const ownerPath = path.join(lockPath(dataDir), "owner.json");
  let injected = false;
  fs.unlink = async (target) => {
    if (!injected && target === ownerPath) {
      injected = true;
      const error = new Error("synthetic unlink failure");
      error.code = "EACCES";
      throw error;
    }
    return unlink(target);
  };
  t.after(() => {
    fs.unlink = unlink;
  });
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_LOCK_FAILED");
  fs.unlink = unlink;
  assert.equal(injected, true);
  assert.equal(exists(lockPath(dataDir)), true, "释放失败必须保留锁");
  assert.equal(exists(ownerPath), true);
  await cleanLock(dataDir);
  await engine.withRunLease(async () => {});
  assertLockReleased(dataDir);

  // rmdir 失败：删除 owner 后必须恢复 owner，保留可识别锁并返回固定码。
  const rmdir = fs.rmdir;
  let rmdirInjected = false;
  fs.rmdir = async (target, options) => {
    if (!rmdirInjected && target === lockPath(dataDir)) {
      rmdirInjected = true;
      const error = new Error("synthetic rmdir failure");
      error.code = "ENOTEMPTY";
      throw error;
    }
    return rmdir(target, options);
  };
  t.after(() => {
    fs.rmdir = rmdir;
  });
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_LOCK_FAILED");
  fs.rmdir = rmdir;
  assert.equal(rmdirInjected, true);
  assert.equal(exists(ownerPath), true, "rmdir 失败后 owner 必须恢复");
  await cleanLock(dataDir);
  await engine.withRunLease(async () => {});
  assertLockReleased(dataDir);

  // 独立 Node 子进程视角：坏 owner 锁同样 BUSY，不盲删。
  await fs.mkdir(lockPath(dataDir), { recursive: true });
  await writeJson(path.join(lockPath(dataDir), "owner.json"), {
    pid: 2147483647,
    token: "dead-owner",
    jobId: "dead",
    startedAt: new Date().toISOString(),
  });
  await assert.rejects(engine.withRunLease(async () => {}), (error) => error.code === "ENGINE_BUSY");
  assert.equal(exists(lockPath(dataDir)), true);
  await cleanLock(dataDir);
});
