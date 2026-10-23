/**
 * T-LOCAL-013C 隔离性能/行为证据。只用临时目录、回环 TLS 与合成 8MiB 文件；
 * 不运行发行引擎、不访问真实服务器/素材/库。
 *
 * 计时边界：
 * - verifyMs：withRunLease 从调用到 descriptor 交付（含获取锁、指针/marker 校验、
 *   8MiB 流式 SHA256、路径身份复核），不含 callback。
 * - cancelToSettledMs：从 AbortController.abort() 到 withRunLease 真正 reject 且锁已释放；
 *   不是真实音频分析耗时。
 * - contentionFailMs：持锁期间第二次运行被 BUSY 拒绝的同步/异步失败耗时。
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { AudioEngine } from "../../../server/audio-engine.mjs";
import {
  delay,
  exists,
  makeRelease,
  makeTar,
  makeTlsFixture,
  startTlsServer,
  waitForJob,
} from "../../../tests/audio-engine-fixtures.mjs";

const cleanups = [];
const ctx = { after: (fn) => cleanups.push(fn) };

async function main() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-t13c-bench-"));
  cleanups.push(async () => fs.rm(base, { recursive: true, force: true }));
  const dataDir = path.join(base, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const binary = crypto.randomBytes(8 * 1024 * 1024);
  const archive = await makeTar([{ name: "audio-analyze", data: binary, mode: 0o755 }]);
  const tls = await makeTlsFixture(ctx);
  const server = await startTlsServer(ctx, tls, (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    res.end(archive);
  });
  const release = makeRelease(archive, server.url, {
    version: "1.0.0-bench",
    archiveMaxBytes: archive.length + 4096,
    extractedMaxBytes: 16 * 1024 * 1024,
  });
  const engine = new AudioEngine(dataDir, {
    release,
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    idleTimeoutMs: 5000,
    totalTimeoutMs: 30000,
    diskFreeBytes: 1024 * 1024 * 1024,
  });
  cleanups.push(() => engine.dispose());

  const installStart = performance.now();
  engine.install({ confirm: true });
  const installed = await waitForJob(engine, { timeout: 30000 });
  const installMs = performance.now() - installStart;
  if (installed.job.state !== "installed") throw new Error(JSON.stringify(installed.job));

  const verifySamples = [];
  let maxLoopGap = 0;
  for (let i = 0; i < 3; i += 1) {
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLoopGap = Math.max(maxLoopGap, now - last);
      last = now;
    }, 1);
    const start = performance.now();
    await engine.withRunLease(async (descriptor) => {
      if (descriptor.binarySize !== binary.length) throw new Error("unexpected descriptor size");
    });
    verifySamples.push(performance.now() - start);
    clearInterval(timer);
  }

  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  const hold = engine.withRunLease(async () => {
    await gate;
  });
  await delay(50);
  const tContend = performance.now();
  let installBusy = false;
  try {
    engine.install({ confirm: true });
  } catch (error) {
    installBusy = error.code === "ENGINE_BUSY";
  }
  const installBusyMs = performance.now() - tContend;
  const tSecond = performance.now();
  let secondBusy = false;
  try {
    await engine.withRunLease(async () => {});
  } catch (error) {
    secondBusy = error.code === "ENGINE_BUSY";
  }
  const secondRunBusyMs = performance.now() - tSecond;
  releaseGate();
  await hold;

  let startedResolve;
  const started = new Promise((resolve) => {
    startedResolve = resolve;
  });
  const controller = new AbortController();
  const cancelled = engine.withRunLease(
    async (_descriptor, { signal }) => {
      startedResolve();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    { signal: controller.signal },
  );
  await started;
  const tCancel = performance.now();
  controller.abort();
  let cancelCode = null;
  await cancelled.catch((error) => {
    cancelCode = error.code;
  });
  const cancelToSettledMs = performance.now() - tCancel;
  const lockReleased = !exists(path.join(dataDir, "engines", ".audio-install.lock"));

  await engine.uninstall();
  const result = {
    binarySize: binary.length,
    archiveSize: archive.length,
    hashChunkBytes: 256 * 1024,
    installMs,
    verifySamplesMs: verifySamples,
    verifyMedianMs: verifySamples.slice().sort((a, b) => a - b)[Math.floor(verifySamples.length / 2)],
    eventLoopMaxGapMs: maxLoopGap,
    installBusy,
    installBusyMs,
    secondRunBusy: secondBusy,
    secondRunBusyMs,
    cancelCode,
    cancelToSettledMs,
    lockReleased,
    requests: server.counts.requests,
    timingBoundaries: {
      verifyMs: "withRunLease call to descriptor delivery; includes lock acquisition, metadata/path checks and full 8MiB streaming SHA256; excludes callback",
      cancelToSettledMs: "AbortController.abort() to withRunLease rejection and lock removal; synthetic wait, not real analysis",
      contentionFailMs: "synchronous install() BUSY throw and second withRunLease BUSY rejection while first callback holds lock",
    },
    note: "synthetic local loopback + 8MiB random file; not a real engine/analysis benchmark",
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  await main();
} finally {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {}
  }
}
