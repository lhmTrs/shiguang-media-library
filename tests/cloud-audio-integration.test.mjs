/**
 * T-LOCAL-014B：真实回环 mTLS + 临时 Library 的纵向集成测试。
 *
 * 只使用一次性证书、127.0.0.1 随机端口 mock、临时数据目录与临时素材根；
 * 不连正式云端/账户/素材。验证 catalog → details → CloudAuth 原始流 → T14A
 * 接收 → 受控安装 → Library 可见索引的完整链路，以及连续下载的 TLS 复用。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Library } from "../server/library.mjs";
import { CloudAuth } from "../server/cloud-auth.mjs";
import { CloudAudioService } from "../server/cloud-audio-service.mjs";
import { startMockCloud } from "./cloud-auth-mock.mjs";

const PASSWORD = "correct horse battery staple";

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-ca-integration-")));
  const mediaRoot = path.join(base, "素材库");
  await fs.mkdir(mediaRoot, { recursive: true });
  const lib = await new Library(path.join(base, "data"), { directoryClassification: true }).init();
  const root = await lib.addRoot(mediaRoot, "sfx");
  const cloud = await startMockCloud();
  await cloud.enroll({
    username: "alice",
    password: PASSWORD,
    displayName: "爱丽丝",
    superAdmin: true,
    clientCert: cloud.clientCertA,
    clientKey: cloud.clientKeyA,
  });
  const auth = await new CloudAuth(lib, { dataDir: lib.dataDir }).init();
  await auth.configure({ origin: cloud.origin, caPath: cloud.caCert, certPath: cloud.clientCertA, keyPath: cloud.clientKeyA });
  await auth.login({ username: "alice", password: PASSWORD });
  const service = await new CloudAudioService(lib, { dataDir: lib.dataDir, cloudAuth: auth, enabled: true }).init();
  t.after(async () => {
    await service.dispose();
    auth.dispose();
    try {
      lib.db.close();
    } catch {
      /* 已关闭 */
    }
    await cloud.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, mediaRoot, lib, root, cloud, auth, service };
}

async function waitJob(service, id, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const job = service.getJob(id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job timeout ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("回环 mTLS 全链路：目录/来源/字节校验/安装/可见索引；重复下载复用同一文件", async (t) => {
  const { service, cloud, root, lib, mediaRoot } = await setup(t);
  const page = await service.catalog({ limit: 50, offset: 0 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, cloud.audio.audioId);
  assert.equal(page.items[0].sha256, cloud.audio.sha256);
  const details = await service.details(cloud.audio.audioId);
  assert.equal(details.shares.length, 1);
  assert.equal(cloud.counts.audioDetails, 1, "列表阶段不请求详情");

  const baseHandshakes = cloud.secureConnections();
  const job = await service.startDownload({
    audioId: cloud.audio.audioId,
    shareId: cloud.audio.shareId,
    rootId: root.id,
  });
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(cloud.counts.audioContent, 1);

  const expected = path.join(mediaRoot, "音效", "环境", "测试音频.wav");
  assert.equal(await fs.readFile(expected).then((buffer) => crypto.createHash("sha256").update(buffer).digest("hex")), cloud.audio.sha256);
  const asset = lib.db.prepare("SELECT id,online,trashed,size FROM assets WHERE path=?").get(expected);
  assert.ok(asset);
  assert.equal(asset.id, done.assetId);
  assert.equal(asset.online, 1);
  assert.equal(asset.trashed, 0);

  // 连续第二次下载复用同一身份/同一 keep-alive 池；文件内容相同，发布复用而非复制。
  const second = await service.startDownload({
    audioId: cloud.audio.audioId,
    shareId: cloud.audio.shareId,
    rootId: root.id,
  });
  const again = await waitJob(service, second.id);
  assert.equal(again.state, "completed");
  assert.equal(again.createdFile, false);
  assert.equal(again.assetId, done.assetId);
  assert.equal(cloud.counts.audioContent, 2);
  assert.equal(cloud.secureConnections(), baseHandshakes, "两次下载应复用同一 TLS 池，不重新握手");

  const jobs = service.listJobs();
  assert.equal(jobs.length, 2);
  assert.equal(JSON.stringify(jobs).includes(mediaRoot), false, "任务 DTO 不暴露本机路径");
  assert.equal(JSON.stringify(jobs).includes("Bearer"), false);
});
