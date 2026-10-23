/**
 * T-LOCAL-012 隔离性能证据：回环 TLS + 合成小归档。
 * 运行：node collab/results/T-LOCAL-012/perf.mjs
 * 只测安装器自身冷/热路径与 status 外呼，不代表公网 120MB 正式安装 SLA。
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { AudioEngine } from "../../../server/audio-engine.mjs";
import {
  makeRelease,
  makeTar,
  makeTlsFixture,
  startTlsServer,
  waitForJob,
} from "../../../tests/audio-engine-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cleanups = [];
const t = { after: (fn) => cleanups.push(fn) };

function nowMs() {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

async function main() {
  const archive = await makeTar([
    {
      name: "audio-analyze",
      data: Buffer.alloc(4096, 7),
      mode: 0o755,
    },
  ]);
  const tls = await makeTlsFixture(t);
  const server = await startTlsServer(t, tls, (_req, res) => {
    res.writeHead(200, { "content-length": archive.length });
    res.end(archive);
  });
  const release = makeRelease(archive, server.url, {
    version: "1.0.0-perf",
    extractedMaxBytes: 1024 * 1024,
  });

  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-t12-perf-")));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });

  const makeEngine = () =>
    new AudioEngine(dataDir, {
      release,
      ca: tls.ca,
      platform: "darwin",
      arch: "arm64",
      idleTimeoutMs: 5000,
      totalTimeoutMs: 30_000,
      diskFreeBytes: 1024 * 1024 * 1024,
    });

  // 冷路径：每轮新建实例与连接池，观察真实新握手。
  const cold = [];
  for (let i = 0; i < 5; i += 1) {
    const engine = makeEngine();
    const requestsBefore = server.counts.requests;
    const handshakesBefore = server.counts.handshakes;
    const started = nowMs();
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    if (status.job.state !== "installed") throw new Error(JSON.stringify(status));
    cold.push({
      ms: Math.round((nowMs() - started) * 100) / 100,
      requests: server.counts.requests - requestsBefore,
      handshakes: server.counts.handshakes - handshakesBefore,
    });
    await engine.uninstall();
    engine.dispose();
  }

  // 热路径：同一实例/连接池，卸载后立即重装，观察复用。
  const engine = makeEngine();
  cleanups.push(() => engine.dispose());
  const warm = [];
  for (let i = 0; i < 5; i += 1) {
    engine.install({ confirm: true });
    await waitForJob(engine);
    await engine.uninstall();
    const requestsBefore = server.counts.requests;
    const handshakesBefore = server.counts.handshakes;
    const started = nowMs();
    engine.install({ confirm: true });
    const status = await waitForJob(engine);
    if (status.job.state !== "installed") throw new Error(JSON.stringify(status));
    warm.push({
      ms: Math.round((nowMs() - started) * 100) / 100,
      requests: server.counts.requests - requestsBefore,
      handshakes: server.counts.handshakes - handshakesBefore,
    });
  }

  const statusRequestsBefore = server.counts.requests;
  const statusHandshakesBefore = server.counts.handshakes;
  const statusStarted = nowMs();
  for (let i = 0; i < 500; i += 1) engine.status();
  const statusMs = nowMs() - statusStarted;
  const statusNetwork = {
    requests: server.counts.requests - statusRequestsBefore,
    handshakes: server.counts.handshakes - statusHandshakesBefore,
  };

  const result = {
    ticket: "T-LOCAL-012",
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      note: "随机回环 TLS + 合成 4KB gzip 归档；临时 MEDIA_DATA_DIR；不访问生产、不下载真实引擎",
    },
    archive: { bytes: archive.length, sha256: release.sha256 },
    cold,
    warm,
    status: {
      calls: 500,
      totalMs: Math.round(statusMs * 100) / 100,
      perCallMs: Math.round((statusMs / 500) * 1000) / 1000,
      network: statusNetwork,
    },
    aggregate: {
      coldMeanMs: Math.round((cold.reduce((sum, item) => sum + item.ms, 0) / cold.length) * 100) / 100,
      warmMeanMs: Math.round((warm.reduce((sum, item) => sum + item.ms, 0) / warm.length) * 100) / 100,
      coldHandshakes: cold.reduce((sum, item) => sum + item.handshakes, 0),
      warmHandshakes: warm.reduce((sum, item) => sum + item.handshakes, 0),
    },
  };
  const output = path.join(HERE, "perf.json");
  await fs.writeFile(output, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n已写入 ${output}`);
}

try {
  await main();
} finally {
  for (const cleanup of cleanups.reverse()) {
    await Promise.resolve(cleanup()).catch(() => {});
  }
}
