/**
 * T-LOCAL-013D 纯解析基准（合成 JSON，非真实音频分析性能）。
 *
 * 只测 normalizeAudioResult / createAudioResultFingerprint 的重复调用耗时，
 * 不启动服务、不读写素材、不运行引擎。
 */
import { performance } from "node:perf_hooks";
import {
  normalizeAudioResult,
  createAudioResultFingerprint,
} from "../../../server/audio-result.mjs";

const CTX = Object.freeze({
  kind: "music",
  sourceSha256: "a".repeat(64),
  sourceSize: 12_345_678,
  durationSec: 600,
  engineVersion: "1.0.0",
  engineBinarySha256: "b".repeat(64),
  engineGeneration: "c".repeat(32),
  parameters: Object.freeze({ brief: true }),
});

const SMALL = JSON.stringify({
  bpm: 128.5,
  key: { best: "C# minor", r: 0.42 },
  loud: { peak: 3, rms: -12.5 },
  energy: { min: -40, max: -6, std: 2.5 },
  fit: { beat: 0.9, tonal: 0.7, chord: 0.4 },
  seg: [0, 12.5, 60],
});

// 接近 64 KiB：1000 个合法 seg 点 + 一段未知 pad 字段（只用于撑大输入）。
const seg = Array.from({ length: 1000 }, (_, i) => i * 0.5);
const baseLarge = JSON.stringify({
  bpm: 128.5,
  key: { best: "C# minor", r: 0.42 },
  loud: { peak: 3, rms: -12.5 },
  energy: { min: -40, max: -6, std: 2.5 },
  fit: { beat: 0.9, tonal: 0.7, chord: 0.4 },
  seg,
  pad: "",
});
const LARGE = baseLarge.replace('"pad":""', `"pad":"${"x".repeat(64 * 1024 - Buffer.byteLength(baseLarge))}"`);
if (Buffer.byteLength(LARGE) > 64 * 1024) throw new Error("large fixture exceeds 64 KiB");

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  return {
    rounds: samples.length,
    medianMsPerOp: Number(sorted[Math.floor(sorted.length / 2)].toFixed(6)),
    meanMsPerOp: Number((sum / samples.length).toFixed(6)),
    minMsPerOp: Number(sorted[0].toFixed(6)),
    maxMsPerOp: Number(sorted[sorted.length - 1].toFixed(6)),
    opsPerSec: Math.round(1000 / (sum / samples.length)),
  };
}

function measure(fn, iterations, rounds = 7) {
  for (let i = 0; i < Math.min(iterations, 500); i += 1) fn();
  const samples = [];
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now();
    for (let i = 0; i < iterations; i += 1) fn();
    samples.push((performance.now() - start) / iterations);
  }
  return stats(samples);
}

// 先确认夹具本身合法。
const smallResult = normalizeAudioResult(SMALL, CTX);
const largeResult = normalizeAudioResult(LARGE, CTX);
if (!smallResult.ok || !largeResult.ok) {
  throw new Error(`fixture rejected: ${smallResult.code ?? ""} ${largeResult.code ?? ""}`);
}

const cases = [
  {
    name: "small-json-normalize",
    inputBytes: Buffer.byteLength(SMALL),
    outputBytes: Buffer.byteLength(JSON.stringify(smallResult)),
    iterations: 20_000,
    ...measure(() => normalizeAudioResult(SMALL, CTX), 20_000),
  },
  {
    name: "near-64KiB-json-normalize",
    inputBytes: Buffer.byteLength(LARGE),
    outputBytes: Buffer.byteLength(JSON.stringify(largeResult)),
    iterations: 1_000,
    ...measure(() => normalizeAudioResult(LARGE, CTX), 1_000),
  },
  {
    name: "fingerprint",
    inputBytes: 0,
    outputBytes: Buffer.byteLength(JSON.stringify(createAudioResultFingerprint(CTX))),
    iterations: 50_000,
    ...measure(() => createAudioResultFingerprint(CTX), 50_000),
  },
];

const report = {
  note: "synthetic JSON parsing/normalization/fingerprint benchmark; NOT real audio-analysis performance",
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  date: new Date().toISOString(),
  largeFixtureBytes: Buffer.byteLength(LARGE),
  maxResultBytes: 64 * 1024,
  cases,
};

console.log(JSON.stringify(report, null, 2));
