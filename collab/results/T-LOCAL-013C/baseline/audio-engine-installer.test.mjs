/**
 * T-LOCAL-012：音频引擎安装器安全加固的定向测试。
 *
 * 全部使用临时 MEDIA_DATA_DIR 等价的临时目录、随机回环 TLS、合成小归档；
 * 不访问 112.74.109.173、不下载真实 120MB 引擎、不运行发行引擎、不碰真实素材/库。
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
import { AudioEngine, AudioEngineError } from "../server/audio-engine.mjs";
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
const BINARY = Buffer.from("#!/bin/sh\necho test-engine\n", "utf8");
const execFileAsync = promisify(execFile);

async function setup(t, archive, overrides = {}) {
  const root = await tempDir(t);
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
    idleTimeoutMs: overrides.idleTimeoutMs ?? 1000,
    totalTimeoutMs: overrides.totalTimeoutMs ?? 5000,
    diskFreeBytes: overrides.diskFreeBytes ?? 1024 * 1024 * 1024,
    hooks: overrides.hooks,
  });
  t.after(() => engine.dispose());
  const setBody = (next) => {
    body = next;
  };
  const setRelease = (next) => {
    engine.release = next;
  };
  return { root, dataDir, tls, server, release, engine, setBody, setRelease };
}

function assertClean(dataDir) {
  assert.equal(exists(path.join(dataDir, "engines", ".audio-install.lock")), false, "安装锁应释放");
  const tmp = path.join(dataDir, "engines", ".tmp");
  if (exists(tmp)) assert.deepEqual(fssync.readdirSync(tmp), [], "临时目录应清空");
}

async function expectJobError(dataDir, engine, code) {
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "error", JSON.stringify(status));
  assert.equal(status.job.error.code, code, JSON.stringify(status));
  assert.equal(status.installed, false);
  assertClean(dataDir);
  return status;
}

test("成功安装：固定描述/长度/hash、0700 临时目录、0600 文件、提交后复用且 status 零外呼", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY, mode: 0o755 }]);
  const { dataDir, server, engine, release } = await setup(t, archive);

  const started = engine.install({ confirm: true });
  assert.equal(started.job.state, "queued");
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  assert.equal(status.installed, true);
  assert.equal(status.version, release.version);
  assert.equal(status.path, null, "状态不得返回本机安装路径");
  assert.equal(status.size, BINARY.length);
  assert.equal(server.counts.requests, 1);

  const current = JSON.parse(await fs.readFile(path.join(dataDir, "engines/audio/current.json"), "utf8"));
  assert.equal(current.version, release.version);
  assert.equal(current.releaseSha256, release.sha256);
  const versionDir = path.join(dataDir, "engines/audio/versions", current.dir);
  const marker = JSON.parse(await fs.readFile(path.join(versionDir, ".installed.json"), "utf8"));
  assert.equal(marker.version, release.version);
  assert.equal(marker.releaseSha256, release.sha256);
  const installed = await fs.readFile(path.join(versionDir, "audio-analyze"));
  assert.deepEqual(installed, BINARY);
  const binaryMode = (await fs.stat(path.join(versionDir, "audio-analyze"))).mode & 0o777;
  assert.equal(binaryMode, 0o755);
  assertClean(dataDir);

  // 已安装后重复 install 不再联网
  const again = engine.install({ confirm: true });
  assert.equal(again.installed, true);
  assert.equal(server.counts.requests, 1);

  const requestsBefore = server.counts.requests;
  for (let i = 0; i < 50; i += 1) engine.status();
  assert.equal(server.counts.requests, requestsBefore, "status 轮询不得发起外部请求");
  assert.equal(engine.version, release.version);
  assert.equal(exists(engine.binaryPath), true);

  const removed = await engine.uninstall();
  assert.equal(removed.installed, false);
  assert.equal(exists(path.join(dataDir, "engines/audio")), false);
  assertClean(dataDir);

  // 卸载后再装一轮，仍可成功（连接池可复用，不要求新握手）
  engine.install({ confirm: true });
  const second = await waitForJob(engine);
  assert.equal(second.job.state, "installed", JSON.stringify(second));
  assert.equal(server.counts.requests, 2);
});

test("确认、平台、磁盘不足在联网前被拒绝", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, server, engine, release, setRelease } = await setup(t, archive);

  assert.throws(
    () => engine.install({}),
    (error) => error instanceof AudioEngineError && error.code === "ENGINE_CONFIRM_REQUIRED",
  );
  assert.equal(server.counts.requests, 0);

  engine.platform = "linux";
  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error instanceof AudioEngineError && error.code === "UNSUPPORTED_PLATFORM",
  );
  engine.platform = "darwin";
  assert.equal(server.counts.requests, 0);

  engine.diskFreeBytes = 1;
  engine.install({ confirm: true });
  await expectJobError(dataDir, engine, "ENGINE_DISK_SPACE_LOW");
  assert.equal(server.counts.requests, 0);

  // 恢复可用磁盘后仍能安装，说明失败没有留下锁/临时目录
  engine.diskFreeBytes = 1024 * 1024 * 1024;
  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  assert.equal(status.version, release.version);
  setRelease(release);
});

test("hash 不匹配、缺失/错误长度、压缩编码、重定向、证书失败、中断都被拒绝", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);

  {
    const { dataDir, engine } = await setup(t, archive, { release: { sha256: "0".repeat(64) } });
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_HASH_MISMATCH");
  }

  {
    const { dataDir, engine } = await setup(t, archive, {
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(archive);
      },
    });
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_LENGTH_MISMATCH");
  }

  {
    const { dataDir, engine } = await setup(t, archive, {
      handler: (_req, res) => {
        res.writeHead(200, { "content-length": archive.length + 9 });
        res.end(archive);
      },
    });
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    assert.equal(status.job.state, "error");
    assert.ok(["ENGINE_LENGTH_MISMATCH", "ENGINE_DOWNLOAD_FAILED"].includes(status.job.error.code), JSON.stringify(status));
    assertClean(dataDir);
  }

  {
    const { dataDir, engine } = await setup(t, archive, {
      handler: (_req, res) => {
        res.writeHead(200, { "content-length": archive.length, "content-encoding": "gzip" });
        res.end(archive);
      },
    });
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_CONTENT_ENCODING");
  }

  {
    const { dataDir, engine } = await setup(t, archive, {
      handler: (_req, res) => {
        res.writeHead(302, { location: "/elsewhere" });
        res.end();
      },
    });
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_HTTP_STATUS");
  }

  {
    const other = await makeTlsFixture(t);
    const { dataDir, engine } = await setup(t, archive, { handler: (_req, res) => res.end(archive) });
    engine.ca = other.ca;
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_TLS_FAILED");
  }

  {
    const { dataDir, engine } = await setup(t, archive, {
      handler: (_req, res) => {
        res.writeHead(200, { "content-length": archive.length });
        res.write(archive.subarray(0, 10));
        res.destroy();
      },
    });
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_DOWNLOAD_FAILED");
  }
});

test("空闲超时与总截止：慢速滴流、停止发送都终止并清理", async (t) => {
  const big = Buffer.concat([BINARY, Buffer.alloc(4096, 1)]);
  const archive = await makeTar([{ name: "audio-analyze", data: big }]);

  {
    const { dataDir, engine } = await setup(t, archive, {
      idleTimeoutMs: 100,
      totalTimeoutMs: 5000,
      handler: (_req, res) => {
        res.writeHead(200, { "content-length": archive.length });
        res.write(archive.subarray(0, 5));
        // 之后不再发送，等待空闲超时
      },
    });
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    assert.equal(status.job.state, "error");
    assert.equal(status.job.error.code, "ENGINE_TIMEOUT", JSON.stringify(status));
    assertClean(dataDir);
  }

  {
    const { dataDir, engine } = await setup(t, archive, {
      idleTimeoutMs: 100,
      totalTimeoutMs: 220,
      handler: (_req, res) => {
        res.writeHead(200, { "content-length": archive.length });
        let sent = 0;
        const timer = setInterval(() => {
          if (res.destroyed || sent >= archive.length) {
            clearInterval(timer);
            if (!res.destroyed) res.end();
            return;
          }
          // 每 20ms 1 字节：低于空闲超时，但总时长超过总截止
          res.write(archive.subarray(sent, sent + 1));
          sent += 1;
        }, 20);
        res.on("close", () => clearInterval(timer));
      },
    });
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    assert.equal(status.job.state, "error");
    assert.equal(status.job.error.code, "ENGINE_TIMEOUT", JSON.stringify(status));
    assertClean(dataDir);
  }
});

test("取消下载：等待网络/临时目录清理，重入 BUSY，卸载竞态返回 BUSY", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  let releaseResponse;
  const gate = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const { dataDir, engine, server } = await setup(t, archive, {
    handler: async (_req, res) => {
      res.writeHead(200, { "content-length": archive.length });
      res.write(archive.subarray(0, 3));
      await gate;
      if (!res.destroyed) res.end(archive.subarray(3));
    },
  });

  engine.install({ confirm: true });
  const deadline = Date.now() + 2000;
  while (engine.status().job?.state !== "downloading" && Date.now() < deadline) await delay(10);
  assert.equal(engine.status().job.state, "downloading");
  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error instanceof AudioEngineError && error.code === "ENGINE_BUSY",
  );
  await assert.rejects(engine.uninstall(), (error) => error instanceof AudioEngineError && error.code === "ENGINE_BUSY");

  const cancelled = await engine.cancel();
  releaseResponse();
  assert.equal(cancelled.job.state, "cancelled");
  assert.equal(cancelled.job.error.code, "ENGINE_CANCELLED");
  assertClean(dataDir);
  assert.ok(server.counts.requests >= 1);

  // 取消后同一实例可重新安装
  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
});

test("取消解包/校验阶段：不留下 staging 或安装目录", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  let releaseHook;
  const gate = new Promise((resolve) => {
    releaseHook = resolve;
  });
  const { dataDir, engine } = await setup(t, archive, {
    hooks: {
      async afterExtract() {
        await gate;
      },
    },
  });
  engine.install({ confirm: true });
  const deadline = Date.now() + 2000;
  while (engine.status().job?.state !== "extracting" && Date.now() < deadline) await delay(10);
  const cancelPromise = engine.cancel();
  releaseHook();
  const status = await cancelPromise;
  assert.equal(status.job.state, "cancelled");
  assert.equal(status.job.error.code, "ENGINE_CANCELLED");
  assert.equal(status.installed, false);
  assertClean(dataDir);
  assert.equal(exists(path.join(dataDir, "engines/audio/current.json")), false);
});

test("取消解包流量：销毁 gunzip/parser 流并清理自有临时目录", async (t) => {
  const archive = await makeTar([
    { name: "audio-analyze", data: BINARY, pax: { gname: "x".repeat(64 * 1024) } },
  ]);
  let signal;
  const started = new Promise((resolve) => {
    signal = resolve;
  });
  const { dataDir, engine } = await setup(t, archive, {
    hooks: {
      extracting() {
        signal();
        void engine.cancel();
      },
    },
  });
  engine.install({ confirm: true });
  await started;
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "cancelled", JSON.stringify(status));
  assert.equal(status.job.error.code, "ENGINE_CANCELLED", JSON.stringify(status));
  assert.equal(status.installed, false);
  assertClean(dataDir);
});

test("恶意归档：类型/路径/重复/PAX/过长/超量/条目数都被拒绝且不越界写", async (t) => {
  const cases = [
    {
      name: "symlink",
      archive: await makeTar([{ name: "audio-analyze", type: "symlink", linkname: "/tmp/outside" }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "hardlink",
      archive: await makeTar([{ name: "audio-analyze", type: "link", linkname: "elsewhere" }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "fifo",
      archive: await makeTar([{ name: "audio-analyze", type: "fifo" }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "path traversal",
      archive: await makeTar([{ name: "../evil", data: BINARY }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "absolute path",
      archive: await makeTar([{ name: "/tmp/evil", data: BINARY }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "long name",
      archive: await makeTar([{ name: "a".repeat(300), data: BINARY }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "duplicate target",
      archive: await makeTar([
        { name: "audio-analyze", data: BINARY },
        { name: "audio-analyze", data: BINARY },
      ]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "pax path",
      archive: await makeTar([{ name: "audio-analyze", pax: { path: "../evil" }, data: BINARY }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "pax unknown extension",
      archive: await makeTar([{ name: "audio-analyze", pax: { comment: "x" }, data: BINARY }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "extra whitelist miss",
      archive: await makeTar([{ name: "README.txt", data: Buffer.from("hi") }]),
      code: "ENGINE_ARCHIVE_UNSAFE",
    },
    {
      name: "expanded too large",
      archive: await makeTar([{ name: "audio-analyze", data: Buffer.alloc(64, 1) }]),
      code: "ENGINE_ARCHIVE_TOO_LARGE",
      release: { extractedMaxBytes: 32 },
    },
    {
      name: "too many entries",
      archive: await makeTar([
        { name: "audio-analyze", data: BINARY },
        { name: "README.txt", data: Buffer.from("hi") },
      ]),
      code: "ENGINE_ARCHIVE_TOO_LARGE",
      release: { maxEntries: 1 },
    },
  ];

  for (const item of cases) {
    const { root, dataDir, engine } = await setup(t, item.archive, { release: item.release });
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    assert.equal(status.job.state, "error", `${item.name}: ${JSON.stringify(status)}`);
    assert.equal(status.job.error.code, item.code, `${item.name}: ${JSON.stringify(status)}`);
    assert.equal(status.installed, false, item.name);
    assertClean(dataDir);
    assert.equal(exists(path.join(root, "evil")), false, `${item.name} 不得写出数据目录`);
    assert.equal(exists(path.join(dataDir, "evil")), false, `${item.name} 不得写出数据目录`);
  }
});

test("目标/父目录符号链接：拒绝安装且不写链接指向", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);

  {
    const root = await tempDir(t);
    const dataDir = path.join(root, "data");
    const outside = path.join(root, "outside");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(outside);
    await fs.mkdir(path.join(dataDir, "engines"));
    await fs.symlink(outside, path.join(dataDir, "engines", "audio"));
    const tls = await makeTlsFixture(t);
    const server = await startTlsServer(t, tls, (_req, res) => {
      res.writeHead(200, { "content-length": archive.length });
      res.end(archive);
    });
    const engine = new AudioEngine(dataDir, {
      release: makeRelease(archive, server.url),
      ca: tls.ca,
      platform: "darwin",
      arch: "arm64",
      diskFreeBytes: 1024 * 1024 * 1024,
    });
    t.after(() => engine.dispose());
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_UNSAFE_TARGET");
    assert.deepEqual(await fs.readdir(outside), []);
  }

  {
    const root = await tempDir(t);
    const dataDir = path.join(root, "data");
    const outside = path.join(root, "outside");
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(dataDir, "engines"));
    const tls = await makeTlsFixture(t);
    const server = await startTlsServer(t, tls, (_req, res) => {
      res.writeHead(200, { "content-length": archive.length });
      res.end(archive);
    });
    const engine = new AudioEngine(dataDir, {
      release: makeRelease(archive, server.url),
      ca: tls.ca,
      platform: "darwin",
      arch: "arm64",
      diskFreeBytes: 1024 * 1024 * 1024,
    });
    t.after(() => engine.dispose());
    engine.install({ confirm: true });
    await expectJobError(dataDir, engine, "ENGINE_UNSAFE_TARGET");
    assert.deepEqual(await fs.readdir(outside), []);
  }
});

test("提交失败保留旧版本；状态不谎报新版本", async (t) => {
  const v1 = await makeTar([{ name: "audio-analyze", data: Buffer.from("#!/bin/sh\necho v1\n") }]);
  const v2 = await makeTar([{ name: "audio-analyze", data: Buffer.from("#!/bin/sh\necho v2\n") }]);
  const { dataDir, tls, engine, server, setBody } = await setup(t, v1, {
    release: { version: "1.0.0-test" },
  });
  engine.install({ confirm: true });
  const first = await waitForJob(engine);
  assert.equal(first.job.state, "installed", JSON.stringify(first));
  const v1Path = engine.binaryPath;
  const v1Bytes = await fs.readFile(v1Path);

  setBody(v2);
  const second = new AudioEngine(dataDir, {
    release: makeRelease(v2, server.url, { version: "2.0.0-test" }),
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    diskFreeBytes: 1024 * 1024 * 1024,
    hooks: {
      beforeCommit() {
        throw new Error("synthetic commit failure");
      },
    },
  });
  t.after(() => second.dispose());
  second.install({ confirm: true });
  const failed = await waitForJob(second);
  assert.equal(failed.job.state, "error");
  assert.equal(failed.job.error.code, "ENGINE_INSTALL_FAILED", JSON.stringify(failed));
  assert.equal(failed.installed, true);
  assert.equal(failed.version, "1.0.0-test");
  assert.deepEqual(await fs.readFile(second.binaryPath), v1Bytes);
  assertClean(dataDir);

  const removed = await second.uninstall();
  assert.equal(removed.installed, false);
});

test("跨进程锁：活锁与死进程残留锁均 BUSY，原样保留，维护清理后可安装", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine } = await setup(t, archive);
  const lock = path.join(dataDir, "engines", ".audio-install.lock");
  await fs.mkdir(path.join(dataDir, "engines"), { recursive: true });
  await fs.mkdir(lock);
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "live", jobId: "live", startedAt: new Date().toISOString() }),
  );
  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error instanceof AudioEngineError && error.code === "ENGINE_BUSY",
  );
  assert.equal(exists(lock), true, "活锁必须保留");
  await fs.rm(lock, { recursive: true, force: true });

  // 死 owner 不再被运行期自动回收：保守 fail-closed，保留原锁等待维护者确认后清理。
  await fs.mkdir(lock);
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "dead", jobId: "dead", startedAt: new Date().toISOString() }),
  );
  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error instanceof AudioEngineError && error.code === "ENGINE_BUSY",
  );
  assert.equal(exists(lock), true, "死进程残留锁不得被自动删除");
  assert.deepEqual(
    fssync.readdirSync(path.join(dataDir, "engines")).filter((name) => name.includes(".stale-")),
    [],
    "不得产生 stale 搬移目录",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")).token,
    "dead",
    "残留锁 owner 必须原样保留",
  );
  await fs.rm(lock, { recursive: true, force: true });

  // 仅在维护者显式清理后，同一实例才能继续安装，证明锁释放/重入路径未被破坏。
  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  assertClean(dataDir);
});

test("锁恢复竞态回归：死锁被换入活 owner 后，本进程不得 rename/删除活锁", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine } = await setup(t, archive);
  const lock = path.join(dataDir, "engines", ".audio-install.lock");
  await fs.mkdir(path.join(dataDir, "engines"), { recursive: true });
  await fs.mkdir(lock);
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: 2147483647, token: "dead-owner", jobId: "dead", startedAt: new Date().toISOString() }),
  );

  // 模拟另一进程在回收者“判定已死”之后用新活锁替换：回收者若仍 rename(lockRoot, stale)，
  // 就会把新活锁搬走。新实现必须在任何 rename 之前保守 BUSY，绝不搬移/删除已存在的锁。
  const rename = fs.rename;
  let staleAttempt = null;
  fs.rename = async (from, to) => {
    if (from === lock && String(to).includes(".stale-")) staleAttempt = { from, to };
    return rename(from, to);
  };
  t.after(() => { fs.rename = rename; });

  // 另一进程先原子换入自己的活锁（这里直接模拟换入完成后的状态）。
  await rename(lock, path.join(dataDir, "replacement-backup"));
  await fs.mkdir(lock);
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid, token: "replacement-live-owner", jobId: "live", startedAt: new Date().toISOString() }),
  );

  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error instanceof AudioEngineError && error.code === "ENGINE_BUSY",
  );
  assert.equal(staleAttempt, null, "不得尝试 stale rename");
  const owner = JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8"));
  assert.equal(owner.token, "replacement-live-owner", "替换后的活 owner 必须保留");
  await fs.rm(lock, { recursive: true, force: true });
});

test("无 owner 锁超过 2 秒仍 fail-closed，不按时间盲删", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine } = await setup(t, archive);
  const lock = path.join(dataDir, "engines", ".audio-install.lock");
  await fs.mkdir(lock, { recursive: true });
  await delay(2100);
  assert.throws(
    () => engine.install({ confirm: true }),
    (error) => error instanceof AudioEngineError && error.code === "ENGINE_BUSY",
  );
  assert.equal(exists(lock), true, "无 owner 的锁不得被时间策略删除");
  await fs.rm(lock, { recursive: true, force: true });
});

test("锁获取竞态回归：同步 peek 后新出现的空锁必须保留并 BUSY，零下载", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, server, engine } = await setup(t, archive);
  const lock = path.join(dataDir, "engines", ".audio-install.lock");
  const mkdir = fs.mkdir;
  let injected = false;
  let beforeIno;
  // 在“同步 peek 已通过、异步获取锁”的窗口注入一个无 owner 的空锁。
  // 旧实现的 rename(creating, lockRoot) 会静默覆盖它；排他 mkdir 必须得到 EEXIST。
  fs.mkdir = async (target, options) => {
    if (!injected && target === lock) {
      injected = true;
      await mkdir(lock);
      beforeIno = (await fs.lstat(lock)).ino;
    }
    return mkdir(target, options);
  };
  t.after(() => { fs.mkdir = mkdir; });

  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(injected, true, "竞态注入点必须命中");
  assert.equal(status.job.state, "error", JSON.stringify(status));
  assert.equal(status.job.error.code, "ENGINE_BUSY", JSON.stringify(status));
  assert.equal((await fs.lstat(lock)).ino, beforeIno, "已出现的空锁 inode 必须原样保留");
  assert.equal(server.counts.requests, 0, "拿到 BUSY 前不得发起下载");
  await fs.rm(lock, { recursive: true, force: true });
});

test("共享 .tmp：只清理本安装器已死任务，未知/活跃/非自有内容保留", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine } = await setup(t, archive);
  const tmp = path.join(dataDir, "engines", ".tmp");
  const unrelated = path.join(tmp, "unrelated-task", "keep.txt");
  await fs.mkdir(path.dirname(unrelated), { recursive: true });
  await fs.writeFile(unrelated, "must survive");

  const owner = (pid, token) => ({
    kind: "shiguang-audio-installer",
    pid,
    jobId: `job-${token}`,
    token,
    startedAt: new Date().toISOString(),
  });
  const live = path.join(tmp, "audio-installer-job-live");
  await fs.mkdir(live);
  await fs.writeFile(path.join(live, ".owner.json"), JSON.stringify(owner(process.pid, "a".repeat(32))));
  await fs.writeFile(path.join(live, "keep.txt"), "live task");
  const dead = path.join(tmp, "audio-installer-job-dead");
  await fs.mkdir(dead);
  await fs.writeFile(path.join(dead, ".owner.json"), JSON.stringify(owner(2147483647, "b".repeat(32))));
  await fs.writeFile(path.join(dead, "stale.txt"), "dead task");
  // 同前缀但没有合法 owner 标记的目录也必须保留（fail-closed）。
  const unmarked = path.join(tmp, "audio-installer-job-unmarked");
  await fs.mkdir(unmarked);
  await fs.writeFile(path.join(unmarked, "keep.txt"), "unknown");

  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  assert.equal(await fs.readFile(unrelated, "utf8"), "must survive");
  assert.equal(await fs.readFile(path.join(live, "keep.txt"), "utf8"), "live task");
  assert.equal(await fs.readFile(path.join(unmarked, "keep.txt"), "utf8"), "unknown");
  assert.equal(exists(dead), false, "已死且归属明确的私有任务目录应被回收");

  await engine.uninstall();
  assert.equal(await fs.readFile(unrelated, "utf8"), "must survive");
  assert.equal(exists(live), true);
  assert.equal(exists(unmarked), true);
});

test("状态信任链：versions/engineRoot/enginesRoot 或 legacy marker 为链接时一律未安装", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const { dataDir, engine } = await setup(t, archive);
  engine.install({ confirm: true });
  assert.equal((await waitForJob(engine)).installed, true);
  const engineRoot = path.join(dataDir, "engines", "audio");
  const versions = path.join(engineRoot, "versions");
  const outside = await tempDir(t);

  const expectNotInstalled = () => {
    const status = engine.status();
    assert.equal(status.installed, false, JSON.stringify(status));
    assert.equal(status.version, null);
    assert.equal(engine.version, null);
    assert.equal(engine.binaryPath, null, "未通过可信链时不得给出分析器路径");
  };

  const movedVersions = path.join(outside, "versions");
  await fs.rename(versions, movedVersions);
  await fs.symlink(movedVersions, versions);
  expectNotInstalled();
  await fs.rm(versions);
  await fs.rename(movedVersions, versions);

  const movedEngine = path.join(outside, "audio");
  await fs.rename(engineRoot, movedEngine);
  await fs.symlink(movedEngine, engineRoot);
  expectNotInstalled();
  await fs.rm(engineRoot);
  await fs.rename(movedEngine, engineRoot);

  const movedEngines = path.join(outside, "engines");
  await fs.rename(path.join(dataDir, "engines"), movedEngines);
  await fs.symlink(movedEngines, path.join(dataDir, "engines"));
  expectNotInstalled();
  await fs.rm(path.join(dataDir, "engines"));
  await fs.rename(movedEngines, path.join(dataDir, "engines"));

  // legacy 路径：平铺 binary + marker；marker 为链接时必须拒绝，且不得越界读取。
  await fs.rm(path.join(engineRoot, "current.json"));
  await fs.copyFile(
    path.join(engineRoot, "versions", fssync.readdirSync(path.join(engineRoot, "versions"))[0], "audio-analyze"),
    path.join(engineRoot, "audio-analyze"),
  );
  const outsideMarker = path.join(outside, "legacy-marker.json");
  await fs.writeFile(outsideMarker, JSON.stringify({ version: "legacy", sha256: engine.release.sha256 }));
  await fs.symlink(outsideMarker, path.join(engineRoot, ".installed.json"));
  expectNotInstalled();
  await fs.rm(path.join(engineRoot, ".installed.json"));
  await fs.writeFile(path.join(engineRoot, ".installed.json"), "x".repeat(5000));
  expectNotInstalled();
});

test("tar 元数据预算：PAX 膨胀与多个扩展头在 parser 前被总量上限拦截", async (t) => {
  const oversizedPax = await makeTar([
    { name: "audio-analyze", data: BINARY, pax: { gname: "x".repeat(2 * 1024 * 1024) } },
  ]);
  {
    const { dataDir, engine } = await setup(t, oversizedPax, { release: { extractedMaxBytes: 64 * 1024 } });
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    assert.equal(status.job.state, "error", JSON.stringify(status));
    assert.equal(status.job.error.code, "ENGINE_ARCHIVE_TOO_LARGE", JSON.stringify(status));
    assert.equal(status.installed, false);
    assertClean(dataDir);
  }

  const multiplePax = await makeTar([
    { name: "audio-analyze", data: BINARY, pax: { gname: "x".repeat(100 * 1024) } },
    { name: "audio-analyze", data: BINARY, pax: { gname: "y".repeat(100 * 1024) } },
  ]);
  {
    const { dataDir, engine } = await setup(t, multiplePax, { release: { extractedMaxBytes: 64 * 1024 } });
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    assert.equal(status.job.state, "error", JSON.stringify(status));
    assert.equal(status.job.error.code, "ENGINE_ARCHIVE_TOO_LARGE", JSON.stringify(status));
    assert.equal(status.installed, false);
    assertClean(dataDir);
  }
});

test("两个进程同时安装：一个成功，另一个明确 BUSY", async (t) => {
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY }]);
  const base = await tempDir(t);
  const dataDir = path.join(base, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const tls = await makeTlsFixture(t);
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const server = await startTlsServer(t, tls, async (_req, res) => {
    res.writeHead(200, { "content-length": archive.length });
    await gate;
    if (!res.destroyed) res.end(archive);
  });
  const release = makeRelease(archive, server.url);
  const childScript = path.join(base, "child-install.mjs");
  await fs.writeFile(
    childScript,
    `
import fs from "node:fs";
import { AudioEngine } from ${JSON.stringify(pathToFileURL(path.join(PROJECT, "server/audio-engine.mjs")).href)};
const engine = new AudioEngine(process.env.DATA_DIR, {
  release: JSON.parse(process.env.RELEASE_JSON),
  ca: fs.readFileSync(process.env.CA_FILE),
  platform: "darwin",
  arch: "arm64",
  idleTimeoutMs: 2000,
  totalTimeoutMs: 8000,
  diskFreeBytes: 1024 * 1024 * 1024,
});
try {
  engine.install({ confirm: true });
  console.log("STARTED");
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const status = engine.status();
    if (status.job && ["installed", "error", "cancelled"].includes(status.job.state)) {
      console.log("RESULT " + JSON.stringify(status.job));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
} catch (error) {
  console.log("BUSY " + error.code);
} finally {
  engine.dispose();
}
`,
  );
  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    RELEASE_JSON: JSON.stringify(release),
    CA_FILE: path.join(tls.dir, "cert.pem"),
  };
  const children = [0, 1].map(() =>
    spawn(process.execPath, [childScript], { env, stdio: ["ignore", "pipe", "pipe"] }),
  );
  const outputs = children.map(() => "");
  for (const [index, child] of children.entries()) {
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      outputs[index] += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      outputs[index] += chunk;
    });
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const started = outputs.filter((output) => output.includes("STARTED")).length;
    const busy = outputs.filter((output) => output.includes("ENGINE_BUSY")).length;
    if ((started >= 2 && busy >= 1) || (started >= 1 && busy >= 1)) break;
    await delay(20);
  }
  // 第一个进程已持锁并在等待响应；放行后让两个子进程结束。
  releaseGate();
  await Promise.all(
    children.map((child) =>
      Promise.race([
        child.exitCode !== null ? Promise.resolve() : once(child, "exit"),
        delay(8000).then(() => {
          child.kill("SIGKILL");
          return [null, null];
        }),
      ]),
    ),
  );

  const combined = outputs.join("\n");
  // 先拿到锁的进程成功；另一个可能在 install 同步阶段直接 BUSY，
  // 也可能在异步获取跨进程锁时得到带 ENGINE_BUSY 的失败任务。
  assert.match(combined, /BUSY ENGINE_BUSY|"code":"ENGINE_BUSY"/, combined);
  assert.equal((combined.match(/"state":"installed"/g) || []).length, 1, combined);
  assert.equal((combined.match(/"code":"ENGINE_BUSY"/g) || []).length, 1, combined);
  assertClean(dataDir);
});

test("公开 CA 随 Git 检出与分享包一致提供，不取消全局私钥忽略", async () => {
  const gitignore = await fs.readFile(path.join(PROJECT, ".gitignore"), "utf8");
  assert.match(gitignore, /^\*\.pem$/m);
  assert.match(gitignore, /^!server\/audio-engine-ca\.pem$/m);
  await assert.rejects(
    execFileAsync("git", ["check-ignore", "-q", "server/audio-engine-ca.pem"], { cwd: PROJECT }),
    (error) => error.code === 1,
    "server/audio-engine-ca.pem 不应再被 .gitignore 忽略",
  );
  const { collectFiles } = await import("../scripts/package.mjs");
  const files = await collectFiles(PROJECT, "server");
  assert.ok(files.includes("server/audio-engine-ca.pem"), "分享包必须包含公开 CA");
  assert.ok(!files.some((file) => /\.key$|id_rsa/.test(file)), "分享包不得携带私钥文件");
});

test("安装器错误对象只带固定码/短消息，不含本机路径", async () => {
  const error = new AudioEngineError("ENGINE_HASH_MISMATCH");
  assert.equal(error.code, "ENGINE_HASH_MISMATCH");
  assert.equal(error.message, "安装包校验失败");
  assert.equal(error.message.includes(os.tmpdir()), false);
  const unknown = new AudioEngineError("ENGINE_INSTALL_FAILED");
  assert.equal(unknown.message, "安装失败");
});
