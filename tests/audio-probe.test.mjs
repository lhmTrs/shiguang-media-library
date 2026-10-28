/**
 * T-LOCAL-013I 定向测试：受限 ffprobe probe。
 *
 * 只使用临时目录、合成 WAV/媒体与现有本机 ffprobe；不读真实素材/库，不联网，
 * 不安装依赖。需要 Homebrew ffprobe 的用例在工具缺失时明确 skip。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  AudioExecutor,
  createAudioExecutorLauncherConfig,
} from "../server/audio-executor.mjs";
import {
  AudioProbe,
  AudioProbeError,
  createAudioProbeToolConfig,
  parseProbeOutput,
  resolveAudioProbeTool,
} from "../server/audio-probe.mjs";

const NODE = process.execPath;
const CLANG = "/usr/bin/clang";
const FFPROBE_CANDIDATE = "/opt/homebrew/bin/ffprobe";
const FFPEG_CANDIDATE = "/opt/homebrew/bin/ffmpeg";
const LAUNCHER_C = fileURLToPath(new URL("../server/native/audio-executor-launcher.c", import.meta.url));

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hashFile = async (file) => sha256(await fs.readFile(file));

function compileLauncher(outDir, name) {
  if (!fssync.existsSync(CLANG) || !fssync.existsSync(LAUNCHER_C)) {
    return { ok: false, reason: "clang 或 launcher 源码不存在" };
  }
  const out = path.join(outDir, name);
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

const buildRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "t13i-probe-build-")));
const launcherBuild = compileLauncher(buildRoot, "audio-executor-launcher");
after(async () => {
  await fs.rm(buildRoot, { recursive: true, force: true }).catch(() => {});
});

let ffprobeTool = null;
let ffprobeVersion = null;
if (fssync.existsSync(FFPROBE_CANDIDATE)) {
  const versionResult = spawnSync(FFPROBE_CANDIDATE, ["-version"], { encoding: "utf8", timeout: 10_000 });
  if (versionResult.status === 0) {
    ffprobeVersion = String(versionResult.stdout).split("\n")[0].trim();
    ffprobeTool = await resolveAudioProbeTool({
      path: FFPROBE_CANDIDATE,
      version: ffprobeVersion,
    });
  }
}
const skipAll = launcherBuild.ok ? (ffprobeTool ? false : "本机 ffprobe 不可用") : launcherBuild.reason;
const ffmpegOk = fssync.existsSync(FFPEG_CANDIDATE);

if (ffprobeTool) {
  console.log(
    `# ffprobe tool version=${JSON.stringify(ffprobeVersion)} realPath=${ffprobeTool.path} sha256=${ffprobeTool.sha256}`,
  );
}

async function makeRoot(t, prefix = "t13i-probe-") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
  return root;
}

function makeWav({ channels = 2, sampleRate = 44_100, durationSec = 1, freq = 440 } = {}) {
  const frames = Math.max(1, Math.round(sampleRate * durationSec));
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * frame) / sampleRate) * 8000);
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(sample, offset);
      offset += 2;
    }
  }
  return buffer;
}

async function makeDataDir(t, root, prefix = "data") {
  const dataDir = path.join(root, prefix);
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.chmod(dataDir, 0o700);
  return dataDir;
}

async function makeSnapshot(dataDir, content, name = "source.bin") {
  const base = path.join(dataDir, "audio-jobs");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.chmod(base, 0o700);
  const dir = path.join(base, `job-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, { mode: 0o600, flag: "wx" });
  await fs.chmod(filePath, 0o600);
  return { filePath, dir, sha256: sha256(content), bytes: content.length };
}

async function makeProbe(t, dataDir, toolConfig, { limits = { wallMs: 5000 } } = {}) {
  const launcher = createAudioExecutorLauncherConfig({
    path: launcherBuild.path,
    sha256: await hashFile(launcherBuild.path),
  });
  const runner = new AudioExecutor({ dataDir, launcher, probeTool: toolConfig, limits });
  t.after(async () => {
    await runner.dispose().catch(() => {});
  });
  return { runner, probe: new AudioProbe({ runner, tool: toolConfig }) };
}

async function probeBuffer(t, content, { name = "source.bin", tool = ffprobeTool, limits } = {}) {
  const root = await makeRoot(t);
  const dataDir = await makeDataDir(t, root);
  const snapshot = await makeSnapshot(dataDir, content, name);
  const { probe } = await makeProbe(t, dataDir, tool, limits ? { limits } : {});
  return { root, dataDir, snapshot, value: await probe.probe(snapshot) };
}

const isProbeCode = (code) => (error) => error instanceof AudioProbeError && error.code === code;
const isProbeCodeIn = (...codes) => (error) =>
  error instanceof AudioProbeError && codes.includes(error.code);

async function ffmpeg(t, args, suffix) {
  const root = await makeRoot(t);
  const out = path.join(root, `fixture.${suffix}`);
  const result = spawnSync(FFPEG_CANDIDATE, ["-hide_banner", "-loglevel", "error", "-y", ...args, out], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, reason: `ffmpeg 失败：${result.error?.message || result.stderr}` };
  }
  return { ok: true, path: out };
}

test("真实合成 WAV：固定参数、真实 ffprobe、元数据/格式映射正确且只清理自己的 job", { skip: skipAll }, async (t) => {
  const content = makeWav({ channels: 2, sampleRate: 44_100, durationSec: 1 });
  const { dataDir, snapshot, value, root } = await probeBuffer(t, content);
  assert.equal(value.format, "wav");
  assert.equal(value.channels, 2);
  assert.equal(value.sampleRate, 44_100);
  assert.equal(value.durationSec, 1);
  assert.equal(value.totalSamples, 44_100);
  assert.equal(Object.isFrozen(value), true);
  assert.deepEqual(await fs.readdir(path.join(dataDir, "audio-executor", "jobs")), []);
  assert.equal((await fs.stat(root)).isDirectory(), true);

  const mono = await probeBuffer(t, makeWav({ channels: 1, sampleRate: 8_000, durationSec: 0.25 }));
  assert.equal(mono.value.channels, 1);
  assert.equal(mono.value.sampleRate, 8_000);
  assert.equal(mono.value.totalSamples, 2_000);
});

test("格式白名单按 demuxer/编解码器映射，不信扩展名", { skip: skipAll || (ffmpegOk ? false : "本机 ffmpeg 不可用") }, async (t) => {
  const cases = [
    { suffix: "flac", args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-ac", "1", "-ar", "32000", "-c:a", "flac"], format: "flac" },
    { suffix: "mp3", args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame"], format: "mp3" },
    { suffix: "m4a", args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-ac", "2", "-ar", "44100", "-c:a", "aac"], format: "m4a" },
    { suffix: "opus", args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-ac", "1", "-ar", "48000", "-c:a", "libopus"], format: "opus" },
    { suffix: "aiff", args: ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16be"], format: "aiff" },
  ];
  for (const item of cases) {
    const fixture = await ffmpeg(t, item.args, item.suffix);
    assert.equal(fixture.ok, true, fixture.reason);
    const content = await fs.readFile(fixture.path);
    // 故意使用错误的 .wav 名字，证明只看容器/编解码器，不看扩展名。
    const { value } = await probeBuffer(t, content, { name: "source.bin" });
    assert.equal(value.format, item.format, item.suffix);
  }
});

test("拒绝视频、多音轨、>2 声道与非白名单容器", { skip: skipAll || (ffmpegOk ? false : "本机 ffmpeg 不可用") }, async (t) => {
  const video = await ffmpeg(
    t,
    ["-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.3", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-shortest", "-c:v", "mpeg4", "-c:a", "aac"],
    "mp4",
  );
  assert.equal(video.ok, true, video.reason);
  await assert.rejects(
    probeBuffer(t, await fs.readFile(video.path)).then((r) => r.value),
    isProbeCode("PROBE_REJECTED"),
  );

  const multi = await ffmpeg(
    t,
    [
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=0.3",
      "-map", "0:a", "-map", "1:a", "-c:a", "aac",
    ],
    "m4a",
  );
  assert.equal(multi.ok, true, multi.reason);
  await assert.rejects(
    probeBuffer(t, await fs.readFile(multi.path)).then((r) => r.value),
    isProbeCode("PROBE_REJECTED"),
  );

  const three = makeWav({ channels: 3, sampleRate: 44_100, durationSec: 0.2 });
  await assert.rejects(probeBuffer(t, three).then((r) => r.value), isProbeCode("PROBE_REJECTED"));

  const webm = await ffmpeg(
    t,
    ["-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:a", "libopus"],
    "webm",
  );
  if (webm.ok) {
    // 白名单在 ffprobe 进程内直接拒绝未知 demuxer，退出码非零；这属于“输入被拒绝”，
    // 与工具损坏/超时区分，但不再伪装成 JSON 解析成功。
    await assert.rejects(
      probeBuffer(t, await fs.readFile(webm.path)).then((r) => r.value),
      isProbeCodeIn("PROBE_REJECTED", "PROBE_UNAVAILABLE"),
    );
  }
});

test("拒绝外部引用/网络 playlist：只允许 file 协议，回环端点零请求", { skip: skipAll }, async (t) => {
  const requests = { count: 0 };
  const server = http.createServer((req, res) => {
    requests.count += 1;
    res.writeHead(200);
    res.end("not audio");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const playlist = Buffer.from(
    `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${port}/segment.aac\n#EXT-X-ENDLIST\n`,
  );
  await assert.rejects(
    probeBuffer(t, playlist, { name: "playlist.m3u8" }).then((r) => r.value),
    isProbeCodeIn("PROBE_REJECTED", "PROBE_UNAVAILABLE"),
  );
  assert.equal(requests.count, 0, "不得访问外部/回环地址");

  const concat = Buffer.from("ffconcat version 1.0\nfile 'http://127.0.0.1:1/x.wav'\n");
  await assert.rejects(
    probeBuffer(t, concat, { name: "list.ffconcat" }).then((r) => r.value),
    isProbeCodeIn("PROBE_REJECTED", "PROBE_UNAVAILABLE"),
  );
  assert.equal(requests.count, 0);
});

test("纯解析：未知/非法时长、缺字段、坏 JSON、超 64KiB 均固定拒绝", async () => {
  const base = { format: { format_name: "wav", duration: "1.0" }, streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "44100" }] };
  assert.equal(parseProbeOutput(JSON.stringify(base)).durationSec, 1);

  const rejects = [
    { ...base, format: { format_name: "wav" } },
    { ...base, format: { format_name: "wav", duration: "N/A" } },
    { ...base, format: { format_name: "wav", duration: "0" } },
    { ...base, format: { format_name: "wav", duration: "600.0001" } },
    { ...base, streams: [] },
    { ...base, streams: [{ codec_type: "video", codec_name: "h264" }] },
    { ...base, streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 0, sample_rate: "44100" }] },
    { ...base, streams: [{ codec_type: "audio", codec_name: "pcm_s16le", channels: 2, sample_rate: "48001" }] },
    { ...base, format: { format_name: "matroska,webm", duration: "1.0" } },
    { ...base, format: { format_name: "wav,http", duration: "1.0" } },
  ];
  for (const value of rejects) {
    await assert.rejects(async () => parseProbeOutput(JSON.stringify(value)), isProbeCode("PROBE_REJECTED"));
  }
  await assert.rejects(async () => parseProbeOutput("{not json"), isProbeCode("PROBE_REJECTED"));
  await assert.rejects(async () => parseProbeOutput(Buffer.alloc(64 * 1024 + 1, 0x20)), isProbeCode("PROBE_REJECTED"));
  await assert.rejects(async () => parseProbeOutput("[]"), isProbeCode("PROBE_REJECTED"));
});

async function makeSyntheticTool(root, body) {
  const file = path.join(root, `tool-${crypto.randomBytes(4).toString("hex")}.mjs`);
  await fs.writeFile(file, `#!${NODE}\n${body}\n`, { mode: 0o700, flag: "wx" });
  await fs.chmod(file, 0o700);
  const version = "synthetic-1.0";
  return createAudioProbeToolConfig({ path: file, sha256: await hashFile(file), version });
}

test("进程失败与解析失败分开：坏 JSON/未知时长/超输出", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const badJson = await makeSyntheticTool(root, 'process.stdout.write("not json")');
  await assert.rejects(
    probeBuffer(t, "x", { tool: badJson, name: "source.bin" }).then((r) => r.value),
    isProbeCode("PROBE_REJECTED"),
  );

  const unknownDuration = await makeSyntheticTool(
    root,
    'process.stdout.write(JSON.stringify({format:{format_name:"wav"},streams:[{codec_type:"audio",codec_name:"pcm_s16le",channels:2,sample_rate:"44100"}]}))',
  );
  await assert.rejects(
    probeBuffer(t, "x", { tool: unknownDuration, name: "source.bin" }).then((r) => r.value),
    isProbeCode("PROBE_REJECTED"),
  );

  const flood = await makeSyntheticTool(root, 'process.stdout.write("x".repeat(128*1024))');
  await assert.rejects(
    probeBuffer(t, "x", { tool: flood, name: "source.bin", limits: { wallMs: 5000 } }).then((r) => r.value),
    isProbeCode("PROBE_UNAVAILABLE"),
  );
});

test("工具替换/缺失：摘要复核后固定不可用，恢复后同实例继续", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const copy = path.join(root, "ffprobe-copy");
  await fs.copyFile(ffprobeTool.path, copy);
  await fs.chmod(copy, 0o700);
  const original = await fs.readFile(copy);
  const config = createAudioProbeToolConfig({
    path: copy,
    sha256: sha256(original),
    version: ffprobeVersion,
  });
  const dataDir = await makeDataDir(t, root);
  const { probe } = await makeProbe(t, dataDir, config);
  const success = await probe.probe(await makeSnapshot(dataDir, makeWav({ durationSec: 0.2 })));
  assert.equal(success.format, "wav");

  await fs.writeFile(copy, Buffer.concat([original, Buffer.from("tampered")]), { mode: 0o700 });
  await assert.rejects(
    probe.probe(await makeSnapshot(dataDir, makeWav({ durationSec: 0.2 }))),
    isProbeCode("PROBE_UNAVAILABLE"),
  );

  await fs.writeFile(copy, original, { mode: 0o700 });
  assert.equal((await probe.probe(await makeSnapshot(dataDir, makeWav({ durationSec: 0.2 })))).format, "wav");

  await fs.unlink(copy);
  await assert.rejects(
    probe.probe(await makeSnapshot(dataDir, makeWav({ durationSec: 0.2 }))),
    isProbeCode("PROBE_UNAVAILABLE"),
  );
});

test("取消/超时：等进程组结束与目录清理后才 settle", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const slow = await makeSyntheticTool(root, "setInterval(() => {}, 60000)");
  const dataDir = await makeDataDir(t, root);
  const { probe } = await makeProbe(t, dataDir, slow, { limits: { wallMs: 4000, termGraceMs: 100 } });

  const started = Date.now();
  await assert.rejects(
    probe.probe(await makeSnapshot(dataDir, "x")),
    isProbeCode("TIMEOUT"),
  );
  assert.ok(Date.now() - started < 6000);
  assert.deepEqual(await fs.readdir(path.join(dataDir, "audio-executor", "jobs")), []);

  const controller = new AbortController();
  const running = probe.probe(await makeSnapshot(dataDir, "x"), { signal: controller.signal });
  running.catch(() => {});
  await delay(60);
  controller.abort();
  await assert.rejects(running, isProbeCode("CANCELLED"));
  assert.deepEqual(await fs.readdir(path.join(dataDir, "audio-executor", "jobs")), []);
});

test("路径 symlink 快照拒绝，外部目标不变", { skip: skipAll }, async (t) => {
  const root = await makeRoot(t);
  const dataDir = await makeDataDir(t, root);
  const external = path.join(root, "external.wav");
  await fs.writeFile(external, makeWav({ durationSec: 0.1 }), { mode: 0o600 });
  const before = await fs.readFile(external);
  const base = path.join(dataDir, "audio-jobs");
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.chmod(base, 0o700);
  const dir = path.join(base, `job-${process.pid}-link`);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const link = path.join(dir, "source.bin");
  await fs.symlink(external, link);
  const { probe } = await makeProbe(t, dataDir, ffprobeTool);
  await assert.rejects(
    probe.probe({ filePath: link, dir, sha256: sha256(before), bytes: before.length }),
    isProbeCode("PROBE_UNAVAILABLE"),
  );
  assert.deepEqual(await fs.readFile(external), before);
});
