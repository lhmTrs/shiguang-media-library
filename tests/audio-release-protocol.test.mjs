/**
 * T-LOCAL-013I 第 3 部分：当前发行引擎实物协议（显式 opt-in）。
 *
 * 只有 SHIGUANG_T13I_REAL_ENGINE=1 才解包/运行约 116MB 的发行归档；普通 npm test
 * 一律 skip。开启后任何安装/资源/协议失败都必须 fail，不能 skip。
 *
 * 边界：只用工作区归档与本地回环 TLS；不联网、不下载、不连接服务器/正式账户、
 * 不读真实素材，不改 Gatekeeper/系统安全设置，不改发行 URL/信任配置。
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
import { AudioEngine, ENGINE_RELEASE } from "../server/audio-engine.mjs";
import { AudioExecutor, createAudioExecutorLauncherConfig } from "../server/audio-executor.mjs";
import { AudioProbe, resolveAudioProbeTool } from "../server/audio-probe.mjs";
import { normalizeAudioResult } from "../server/audio-result.mjs";
import { makeRelease, makeTlsFixture, startTlsServer, tempDir, waitForJob } from "./audio-engine-fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const DEFAULT_ARCHIVE = path.join(PROJECT, "..", "audio-engine-dist", "audio-engine-v1-macos-arm64.tar.gz");
const ARCHIVE = process.env.SHIGUANG_T13I_ENGINE_ARCHIVE || DEFAULT_ARCHIVE;
const ENABLED = process.env.SHIGUANG_T13I_REAL_ENGINE === "1";
const BUDGET_BYTES = 256 * 1024 * 1024;
const WALL_MS = 30_000;
const CLANG = "/usr/bin/clang";
const LAUNCHER_C = path.join(PROJECT, "server", "native", "audio-executor-launcher.c");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function compileLauncher(outDir) {
  if (!fssync.existsSync(CLANG)) return { ok: false, reason: "clang 不存在" };
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

function makeWav({ sampleRate = 44_100, seconds = 2 } = {}) {
  const channels = 2;
  const dataBytes = sampleRate * channels * 2 * seconds;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < dataBytes / 2; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * i) / channels / sampleRate) * 6000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

async function directoryUsage(root) {
  let total = 0;
  let maxFile = { path: null, size: 0 };
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else {
        try {
          const stat = await fs.stat(target);
          total += stat.size;
          if (stat.size > maxFile.size) maxFile = { path: target, size: stat.size };
        } catch {}
      }
    }
  };
  await walk(root);
  return { total, maxFile };
}

test(
  "当前发行引擎实物协议（显式 opt-in；本地归档/回环安装/受限执行）",
  { skip: ENABLED ? false : "未设置 SHIGUANG_T13I_REAL_ENGINE=1；普通测试不解包/运行发行引擎" },
  async (t) => {
    const archiveStat = await fs.stat(ARCHIVE).catch(() => null);
    assert.ok(archiveStat && archiveStat.isFile(), `发行归档不存在：${ARCHIVE}`);
    assert.equal(archiveStat.size, ENGINE_RELEASE.size, "发行归档大小必须与 ENGINE_RELEASE 一致");
    const archiveHash = sha256(await fs.readFile(ARCHIVE));
    assert.equal(archiveHash, ENGINE_RELEASE.sha256, "发行归档 SHA256 必须与 ENGINE_RELEASE 一致");

    const buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-release-build-")));
    t.after(() => fs.rm(buildRoot, { recursive: true, force: true }).catch(() => {}));
    const launcher = compileLauncher(buildRoot);
    assert.equal(launcher.ok, true, launcher.reason);

    const root = await tempDir(t, "t13i-release-");
    const dataDir = path.join(root, "data");
    await fs.mkdir(dataDir, { mode: 0o700 });
    const tls = await makeTlsFixture(t);
    const server = await startTlsServer(t, tls, async (req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archiveStat.size });
      await new Promise((resolve, reject) => {
        const stream = fssync.createReadStream(ARCHIVE);
        stream.on("error", reject);
        res.on("error", reject);
        res.on("finish", resolve);
        stream.pipe(res);
      });
    });
    const release = makeRelease(Buffer.alloc(0), server.url, {
      ...ENGINE_RELEASE,
      url: server.url,
    });
    const engine = new AudioEngine(dataDir, {
      release,
      ca: tls.ca,
      platform: "darwin",
      arch: "arm64",
      idleTimeoutMs: 30_000,
      totalTimeoutMs: 300_000,
      diskFreeBytes: 2 * 1024 * 1024 * 1024,
    });
    t.after(() => engine.dispose());

    engine.install({ confirm: true });
    const installed = await waitForJob(engine, { timeout: 180_000 });
    assert.equal(
      installed.job.state,
      "installed",
      `发行归档无法通过现有安装器：${JSON.stringify(installed.job)}`,
    );

    const tool = await resolveAudioProbeTool({
      path: process.env.SHIGUANG_T13I_FFPROBE || "/opt/homebrew/bin/ffprobe",
      version: process.env.SHIGUANG_T13I_FFPROBE_VERSION || "ffprobe version 7.0.2",
    });
    const executor = new AudioExecutor({
      dataDir,
      launcher: createAudioExecutorLauncherConfig({
        path: launcher.path,
        sha256: sha256(await fs.readFile(launcher.path)),
      }),
      probeTool: tool,
      limits: { wallMs: WALL_MS, termGraceMs: 250 },
    });
    t.after(() => executor.dispose().catch(() => {}));
    const probe = new AudioProbe({ runner: executor, tool });

    const wav = makeWav({ sampleRate: 44_100, seconds: 2 });
    const jobsRoot = path.join(dataDir, "audio-jobs", "job-release");
    await fs.mkdir(jobsRoot, { recursive: true, mode: 0o700 });
    await fs.chmod(jobsRoot, 0o700);
    const filePath = path.join(jobsRoot, "source.bin");
    await fs.writeFile(filePath, wav, { mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    const snapshot = { filePath, dir: jobsRoot, sha256: sha256(wav), bytes: wav.length };

    const probeStarted = Date.now();
    const meta = await probe.probe(snapshot);
    assert.equal(meta.format, "wav");
    assert.equal(meta.channels, 2);
    assert.equal(meta.sampleRate, 44_100);

    const controller = new AbortController();
    const started = Date.now();
    let peak = 0;
    let maxFile = { path: null, size: 0 };
    let budgetExceeded = false;
    const monitor = setInterval(async () => {
      const usage = await directoryUsage(dataDir);
      peak = Math.max(peak, usage.total);
      if (usage.maxFile.size > maxFile.size) maxFile = usage.maxFile;
      if (usage.total > BUDGET_BYTES) {
        budgetExceeded = true;
        controller.abort();
      }
    }, 100);
    if (typeof monitor.unref === "function") monitor.unref();

    let raw;
    let seenDescriptor = null;
    try {
      raw = await engine.withRunLease(async (descriptor, signal) => {
        seenDescriptor = descriptor;
        const onAbort = () => controller.abort();
        controller.signal.addEventListener("abort", onAbort, { once: true });
        try {
          return await executor.execute(snapshot, descriptor, { signal });
        } finally {
          controller.signal.removeEventListener("abort", onAbort);
        }
      }, { signal: controller.signal });
    } finally {
      clearInterval(monitor);
    }
    const elapsedMs = Date.now() - started;

    const context = {
      kind: "music",
      sourceSha256: snapshot.sha256,
      sourceSize: snapshot.bytes,
      durationSec: meta.durationSec,
      engineVersion: seenDescriptor?.version || engine.version,
      engineBinarySha256: seenDescriptor?.binarySha256 || "0".repeat(64),
      engineGeneration: seenDescriptor?.generation || "0".repeat(32),
      parameters: { brief: true },
    };
    const normalized = normalizeAudioResult(raw, context);
    console.log(
      "# T13I release protocol",
      JSON.stringify({
        probeMs: started - probeStarted,
        elapsedMs,
        rawBytes: raw.length,
        rawText: raw.toString(),
        normalized,
        peakBytes: peak,
        maxFileBytes: maxFile.size,
        budgetExceeded,
        budgetBytes: BUDGET_BYTES,
      }),
    );
    assert.equal(budgetExceeded, false, `PyInstaller 自解压超出 ${BUDGET_BYTES} 字节监督预算`);
    assert.ok(elapsedMs <= WALL_MS, `单任务超过 ${WALL_MS}ms`);
    assert.equal(normalized.ok, true, `brief-v1 不兼容：${JSON.stringify(normalized)}`);
  },
);
