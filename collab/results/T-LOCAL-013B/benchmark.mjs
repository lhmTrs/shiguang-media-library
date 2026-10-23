/**
 * T-LOCAL-013B 合成计时：不运行真实引擎，不读取真实素材。
 * 输出 evidence/timing.json，并由命令行 tee 到 evidence/timing.log。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { AudioJobQueue } from "../../../server/audio-job-queue.mjs";
import { createSnapshot } from "../../../server/audio-snapshot.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-queue-bench-")));
const root = path.join(base, "media");
const dataDir = path.join(base, "data");
await fs.mkdir(root, { recursive: true });
const SIZE = 8 * 1024 * 1024;
const content = crypto.randomBytes(SIZE);
const sourcePath = path.join(root, "synthetic.bin");
await fs.writeFile(sourcePath, content);
const expectedSha = crypto.createHash("sha256").update(content).digest("hex");
const asset = {
  assetId: "synthetic",
  kind: "music",
  sourcePath,
  rootPath: root,
  rootId: "bench-root",
  online: true,
  trashed: false,
  retired: false,
  rootRetired: false,
  busy: false,
  assetGeneration: 1,
  libraryGeneration: 1,
  sourceGeneration: 1,
};

const directStart = performance.now();
const direct = await createSnapshot({ dataDir, rootPath: root, sourcePath, maxBytes: 64 * 1024 * 1024, jobId: "bench-snapshot" });
const directCopyMs = performance.now() - directStart;
const cleanupStart = performance.now();
await direct.cleanup();
const directCleanupMs = performance.now() - cleanupStart;

let mode = "success";
let active = 0;
let maxConcurrent = 0;
const dirs = [];
const queue = new AudioJobQueue({
  dataDir,
  resolveAsset: async () => ({ ...asset }),
  execute: async (snapshot, { signal }) => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    dirs.push(snapshot.dir);
    try {
      if (mode === "cancel") {
        return await new Promise((resolve) => {
          signal.addEventListener("abort", () => setTimeout(() => resolve({ aborted: true }), 20), { once: true });
        });
      }
      await delay(25);
      return { sha256: snapshot.sha256, bytes: snapshot.bytes };
    } finally {
      active -= 1;
    }
  },
  wallDeadlineMs: 5000,
  maxSnapshotBytes: 64 * 1024 * 1024,
});

async function waitState(id, state) {
  for (;;) {
    const job = await queue.get(id);
    if (job.state === state) return job;
    await delay(2);
  }
}

const submitSamples = [];
const endToEndSamples = [];
for (let i = 0; i < 3; i += 1) {
  const start = performance.now();
  const job = await queue.submit("synthetic");
  submitSamples.push(performance.now() - start);
  await waitState(job.id, "succeeded");
  endToEndSamples.push(performance.now() - start);
}

mode = "cancel";
const cancelStart = performance.now();
const cancellingJob = await queue.submit("synthetic");
await waitState(cancellingJob.id, "running");
const cancelIssued = await queue.cancel(cancellingJob.id);
await waitState(cancellingJob.id, "cancelled");
const cancelToCancelledMs = performance.now() - cancelStart;

const after = await fs.readdir(path.join(dataDir, "audio-jobs")).catch(() => []);
const result = {
  date: new Date().toISOString(),
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  fixture: { bytes: SIZE, sha256: expectedSha, file: "synthetic 8MiB random buffer" },
  hashMethod: "64KiB 读循环 + crypto.createHash('sha256') 同步更新，复制与 hash 同一条流",
  directSnapshot: { copyMs: Number(directCopyMs.toFixed(2)), cleanupMs: Number(directCleanupMs.toFixed(2)), bytes: direct.bytes, sha256: direct.sha256, shaMatches: direct.sha256 === expectedSha },
  queue: {
    submitMs: submitSamples.map((n) => Number(n.toFixed(2))),
    endToEndMs: endToEndSamples.map((n) => Number(n.toFixed(2))),
    cancel: { issuedState: cancelIssued.state, cancelToCancelledMs: Number(cancelToCancelledMs.toFixed(2)) },
    maxConcurrent,
    leftoverJobDirsAtEnd: after.filter((name) => name.startsWith("job-")).length,
    leasePresentAtEnd: Boolean(await fs.lstat(path.join(dataDir, "audio-jobs", ".queue-lease")).catch(() => null)),
  },
  note: "合成 executor 的 25ms sleep 不是真实引擎性能；只证明队列/快照开销与单 worker 行为。",
};
console.log(JSON.stringify(result, null, 2));
await queue.dispose();
await fs.rm(base, { recursive: true, force: true });
