#!/usr/bin/env node
/**
 * T-LOCAL-013A 短基准：正常启动→close、取消→close、timeout、RSS 短采样。
 * 合成 Node 子进程；不是发行引擎性能，也不证明 BPM/调性。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LocalExecutor } from "./executor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "fixtures", "child.mjs");
const RSS = path.join(HERE, "build", "rss-of");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "t13a-bench-"));
const dataDir = path.join(root, "data");
const executor = new LocalExecutor(dataDir, {
  graceMs: 150,
  rssSampleMs: 50,
  rssHelper: await fs.access(RSS).then(() => RSS).catch(() => null),
});

const base = (mode, extra = {}) => ({
  command: process.execPath,
  args: [CHILD, mode],
  timeoutMs: 3000,
  stdoutLimitBytes: 8 * 1024,
  stderrLimitBytes: 8 * 1024,
  ...extra,
});

const out = { generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, runs: {} };

const success = [];
for (let i = 0; i < 8; i += 1) {
  const r = await executor.run(base("success"));
  success.push({ durationMs: r.durationMs, rssMaxKb: r.rssMaxKb, rssSamples: r.rssSamples });
}
out.runs.success = summarize(success);

const cancels = [];
for (let i = 0; i < 5; i += 1) {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150).unref();
  const r = await executor.run(base("cancel", { signal: controller.signal, timeoutMs: 5000 }));
  cancels.push({ durationMs: r.durationMs, cancelToCloseMs: r.cancelToCloseMs, rssMaxKb: r.rssMaxKb, rssSamples: r.rssSamples });
}
out.runs.cancel = summarize(cancels, "cancelToCloseMs");

const timeouts = [];
for (let i = 0; i < 3; i += 1) {
  const r = await executor.run(base("timeout", { timeoutMs: 500 }));
  timeouts.push({ durationMs: r.durationMs, rssMaxKb: r.rssMaxKb, rssSamples: r.rssSamples });
}
out.runs.timeout = summarize(timeouts);

console.log(JSON.stringify(out, null, 2));
await fs.writeFile(path.join(HERE, "evidence", "timing.json"), JSON.stringify(out, null, 2) + "\n");
await fs.rm(root, { recursive: true, force: true }).catch(() => {});
await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});

function summarize(rows, key = "durationMs") {
  const values = rows.map((row) => row[key]).filter((value) => typeof value === "number").sort((a, b) => a - b);
  const rss = rows.map((row) => row.rssMaxKb).filter((value) => typeof value === "number").sort((a, b) => a - b);
  return {
    samples: rows.length,
    metric: key,
    minMs: values[0] ?? null,
    medianMs: values.length ? values[Math.floor(values.length / 2)] : null,
    maxMs: values.at(-1) ?? null,
    rssMaxKb: rss.at(-1) ?? null,
    note: "RSS 为 libproc 短采样软监督，不是 RLIMIT_AS 硬内存隔离",
  };
}
