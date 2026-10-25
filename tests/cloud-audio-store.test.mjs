/**
 * T-LOCAL-014B：后台任务/来源记录私有存储测试。
 *
 * 临时目录；不接触真实库。覆盖：未完成任务重启后 interrupted、原子 0600 写入、
 * 未知字段/令牌/路径字段被丢弃、记录数有界、损坏文件隔离、来源按 assetId 幂等。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CloudAudioJobStore } from "../server/cloud-audio-store.mjs";

const uuid = () => crypto.randomUUID();

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-jobstore-")));
  const dataDir = path.join(base, "data");
  t.after(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, dataDir };
}

function input(overrides = {}) {
  return {
    audioId: uuid(),
    shareId: uuid(),
    accountId: "account-1",
    deviceId: "device-1",
    originHost: "cloud.example:443",
    epoch: 7,
    rootId: "root-1",
    rootName: "测试根",
    rootPath: "/tmp/does-not-matter",
    rootGeneration: "a".repeat(64),
    category: "音效",
    subcategory: "环境",
    fileName: "测试.wav",
    mediaKind: "MUSIC",
    bytes: 108,
    sha256: "b".repeat(64),
    mimeType: "audio/wav",
    ...overrides,
  };
}

test("创建/更新/完成：0600 原子文件，来源记录按 assetId 幂等", async (t) => {
  const { dataDir } = await setup(t);
  const store = await new CloudAudioJobStore(dataDir).init();
  const job = await store.create(input());
  assert.equal(job.state, "queued");
  assert.equal(job.mediaKind, "MUSIC", "任务必须持久化可信来源类型");
  const downloading = await store.update(job.id, { state: "downloading", startedAt: Date.now() });
  assert.equal(downloading.state, "downloading");

  const assetId = uuid();
  const done = await store.complete(job.id, { assetId, createdFile: true, receivedBytes: job.bytes }, {
    audioId: job.audioId,
    shareId: job.shareId,
    sha256: job.sha256,
    bytes: job.bytes,
    category: job.category,
    subcategory: job.subcategory,
  });
  assert.equal(done.state, "completed");
  assert.equal(done.assetId, assetId);
  assert.equal(done.createdFile, true);
  assert.equal(store.provenance(assetId).audioId, job.audioId);
  assert.equal(store.provenance(assetId).mediaKind, "MUSIC");

  await store.complete(job.id, { assetId, createdFile: true }, {
    audioId: job.audioId,
    shareId: job.shareId,
    sha256: job.sha256,
    bytes: job.bytes,
  });
  assert.equal(store.provenanceList().length, 1, "同一 assetId 只保留一条来源");

  const jobsFile = path.join(dataDir, "cloud-audio-jobs.json");
  const provenanceFile = path.join(dataDir, "cloud-audio-provenance.json");
  assert.equal((await fs.stat(jobsFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(provenanceFile)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await fs.readFile(jobsFile, "utf8"));
  assert.equal(persisted.jobs.length, 1);
  assert.equal(persisted.jobs[0].rootPath, "/tmp/does-not-matter");
  assert.equal(JSON.stringify(persisted).includes("refreshToken"), false);
  await store.close();
});

test("重启：queued/downloading/installing 一律 interrupted，需手动重试且不自动续传", async (t) => {
  const { dataDir } = await setup(t);
  const first = await new CloudAudioJobStore(dataDir).init();
  const a = await first.create(input());
  const b = await first.create(input({ audioId: uuid() }));
  const c = await first.create(input({ audioId: uuid() }));
  await first.update(a.id, { state: "downloading" });
  await first.update(b.id, { state: "installing" });
  await first.close();

  const restarted = await new CloudAudioJobStore(dataDir).init();
  assert.equal(restarted.interruptedCount, 3);
  for (const job of restarted.list()) {
    assert.equal(job.state, "interrupted");
    assert.equal(job.errorCode, "INTERRUPTED");
    assert.equal(job.cancelRequested, false);
  }
  assert.equal(restarted.list().find((job) => job.id === c.id).state, "interrupted");
  const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "cloud-audio-jobs.json"), "utf8"));
  assert.ok(persisted.jobs.every((job) => job.state === "interrupted"), "重启后的 interrupted 必须落盘");
  await restarted.close();
});

test("未知字段、令牌、任意路径字段不会写入持久文件；活动任务去重与计数", async (t) => {
  const { dataDir } = await setup(t);
  const store = await new CloudAudioJobStore(dataDir).init();
  const job = await store.create(input({
    accessToken: "eyJ-secret",
    refreshToken: "secret-refresh",
    tempPath: "/private/tmp/artifact.part",
    headers: { authorization: "Bearer x" },
    rootPath: "/tmp/ok",
  }));
  const serialized = await fs.readFile(path.join(dataDir, "cloud-audio-jobs.json"), "utf8");
  for (const forbidden of ["eyJ-secret", "secret-refresh", "artifact.part", "authorization", "Bearer"])
    assert.equal(serialized.includes(forbidden), false, `不得持久化 ${forbidden}`);
  assert.equal(serialized.includes("/tmp/ok"), true, "根路径是本地私有字段，允许保存");
  assert.equal(store.findActive({ audioId: job.audioId, shareId: job.shareId, rootId: job.rootId, accountId: job.accountId, deviceId: job.deviceId, originHost: job.originHost }).id, job.id);
  assert.equal(store.findActive({ audioId: job.audioId, shareId: job.shareId, rootId: job.rootId, accountId: job.accountId, deviceId: job.deviceId, originHost: "other.example" }), null);
  assert.equal(store.countActive(), 1);
  await store.update(job.id, { state: "completed" });
  assert.equal(store.countActive(), 0);
  await store.close();
});

test("记录数有界：超过 200 条时只裁掉最旧的终态任务，保留活动任务", async (t) => {
  const { dataDir } = await setup(t);
  const store = await new CloudAudioJobStore(dataDir).init();
  const active = await store.create(input({ audioId: uuid() }));
  await store.update(active.id, { state: "downloading" });
  for (let i = 0; i < 205; i += 1) {
    const job = await store.create(input({ audioId: uuid() }));
    await store.update(job.id, { state: "failed", errorCode: "TEST" });
  }
  assert.ok(store.list().length <= 200, `任务数应有界，实际 ${store.list().length}`);
  assert.equal(store.get(active.id).state, "downloading", "活动任务不能被裁剪");
  await store.close();
});

test("损坏文件：隔离改名后从空状态启动，不阻塞应用", async (t) => {
  const { dataDir } = await setup(t);
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "cloud-audio-jobs.json"), "{not json", { mode: 0o600 });
  const store = await new CloudAudioJobStore(dataDir).init();
  assert.deepEqual(store.list(), []);
  const files = await fs.readdir(dataDir);
  assert.ok(files.some((file) => file.startsWith("cloud-audio-jobs.json.corrupt-")));
  await store.close();
});
