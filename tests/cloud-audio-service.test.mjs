/**
 * T-LOCAL-014B：下载服务编排测试（合成云端适配器 + 临时 Library）。
 *
 * 不连正式云端/账户/素材：fake CloudAuth 只返回固定 DTO 与合成 Readable；
 * Library 使用临时 MEDIA_DATA_DIR 与临时根。覆盖：懒加载 catalog 不取详情、
 * 来源选择、完整下载并可见索引、重复点击去重、取消、摘要/长度失败、来源撤销、
 * 根变化、登录代际变化、数据库失败不返回假成功、默认关闭。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Library } from "../server/library.mjs";
import { CloudAudioService, CloudAudioServiceError } from "../server/cloud-audio-service.mjs";
import { CloudAudioInstaller } from "../server/cloud-audio-install.mjs";
import { CloudAudioReceiver } from "../server/cloud-audio-receiver.mjs";
import { CloudAudioJobStore } from "../server/cloud-audio-store.mjs";

function wavBytes(seed = 1, length = 256) {
  const data = Buffer.alloc(length, seed);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function makeCloud() {
  const bytes = wavBytes(11);
  const audioId = crypto.randomUUID();
  const shareId = crypto.randomUUID();
  const secondShareId = crypto.randomUUID();
  const cloud = {
    epoch: 4,
    loggedIn: true,
    accountId: "account-a",
    deviceId: "device-a",
    bytes,
    audioId,
    shareId,
    secondShareId,
    mediaKind: "SFX",
    calls: { catalog: 0, details: 0, stream: 0 },
    flags: { noShares: false, emptyCatalog: false, wrongBytes: null, truncate: false, streamGate: null, detailGate: null },
    getState() {
      return {
        configured: true,
        state: this.loggedIn ? "logged-in" : "needs-login",
        accountId: this.accountId,
        deviceId: this.deviceId,
        originHost: "mock.local",
      };
    },
    async forgetSession() {
      this.epoch += 1;
    },
    async proxy(method, pathname) {
      if (pathname.startsWith("/media/audio/catalog")) {
        this.calls.catalog += 1;
        if (this.flags.emptyCatalog) return { items: [], hasMore: false };
        return {
          items: [{
            id: this.audioId,
            sha256: sha(this.bytes),
            bytes: this.bytes.length,
            contentType: "audio/wav",
            createdAt: "2026-10-24T00:00:00Z",
            preferredShareId: this.shareId,
            ownerAccountId: "owner-a",
            fileName: "环境音.wav",
            mediaKind: this.mediaKind,
            category: "音效",
            subcategory: "环境",
            visibleShareCount: 2,
          }],
          hasMore: false,
        };
      }
      this.calls.details += 1;
      if (this.flags.detailGate && this.calls.details >= 2) await this.flags.detailGate.promise;
      const shares = this.flags.noShares ? [] : [
        {
          id: this.shareId,
          ownerAccountId: "owner-a",
          fileName: "环境音.wav",
          mediaKind: this.mediaKind,
          category: "音效",
          subcategory: "环境",
          createdAt: "2026-10-24T00:00:00Z",
          version: 0,
        },
        {
          id: this.secondShareId,
          ownerAccountId: "owner-b",
          fileName: "另一个名字.wav",
          mediaKind: this.mediaKind,
          category: "音效",
          subcategory: "环境",
          createdAt: "2026-10-23T00:00:00Z",
          version: 1,
        },
      ];
      return {
        audio: {
          id: this.audioId,
          sha256: sha(this.bytes),
          bytes: this.bytes.length,
          contentType: "audio/wav",
          createdAt: "2026-10-24T00:00:00Z",
        },
        shares,
      };
    },
    async openAudioContentStream(audioId, { signal }) {
      this.calls.stream += 1;
      assert.equal(audioId, this.audioId);
      const payload = this.flags.wrongBytes || this.bytes;
      const declared = this.flags.truncate ? payload.length + 10 : payload.length;
      const gate = this.flags.streamGate;
      const body = new Readable({
        read() {
          if (this.started) return;
          this.started = true;
          this.push(payload.subarray(0, Math.max(1, Math.floor(payload.length / 2))));
          const finish = () => {
            if (!this.destroyed) this.push(payload.subarray(Math.max(1, Math.floor(payload.length / 2))));
            if (!this.destroyed) this.push(null);
          };
          if (gate) gate.promise.then(finish);
          else setTimeout(finish, 1);
        },
      });
      body.on("close", () => { this.bodyClosed = true; });
      signal?.addEventListener("abort", () => body.destroy(), { once: true });
      return {
        status: 200,
        headers: { "content-type": "audio/wav", "content-length": String(declared) },
        body,
      };
    },
  };
  return cloud;
}

async function setup(t, { enabled = true, cloud: suppliedCloud = null } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-ca-service-")));
  const mediaRoot = path.join(base, "素材库");
  const dataDir = path.join(base, "data");
  await fs.mkdir(mediaRoot, { recursive: true });
  const lib = await new Library(dataDir, { directoryClassification: true }).init();
  const root = await lib.addRoot(mediaRoot, "sfx");
  const cloud = suppliedCloud || makeCloud();
  const service = await new CloudAudioService(lib, { dataDir, cloudAuth: cloud, enabled }).init();
  t.after(async () => {
    await service.dispose();
    try {
      lib.db.close();
    } catch {
      /* 某个用例可能已关闭 */
    }
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, mediaRoot, dataDir, lib, root, cloud, service };
}

async function waitJob(service, id, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const job = service.getJob(id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.state)) return job;
    if (Date.now() > deadline) throw new Error(`job timeout: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function makeRoot(lib, base, name, kind) {
  const dir = path.join(base, name);
  await fs.mkdir(dir, { recursive: true });
  return lib.addRoot(dir, kind);
}

async function waitScan(lib, scan) {
  const deadline = Date.now() + 8000;
  while (scan.status === "running") {
    if (Date.now() > deadline) throw new Error("scan timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(scan.status, "done");
}

async function filesUnder(dir) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full);
    }
  };
  await walk(dir);
  return found;
}

function gate() {
  let release;
  const promise = new Promise((resolve) => (release = resolve));
  return { promise, release };
}

/** 声明长度与真实流分离的合成云端：用于容量准入测试，流保持打开直到取消。 */
function makeCapacityCloud(specs) {
  const byId = new Map(specs.map((spec) => [spec.audioId, spec]));
  const calls = { stream: 0 };
  return {
    epoch: 1,
    calls,
    getState: () => ({
      configured: true,
      state: "logged-in",
      accountId: "account",
      deviceId: "device",
      originHost: "fixture",
    }),
    async proxy(method, pathname) {
      const audioId = pathname.slice("/media/audio/".length).split("?")[0];
      const spec = byId.get(audioId);
      if (!spec) throw new Error("unknown audio");
      return {
        audio: {
          id: audioId,
          bytes: spec.bytes,
          sha256: "d".repeat(64),
          contentType: "audio/wav",
          createdAt: "2026-10-24T00:00:00Z",
        },
        shares: [{
          id: spec.shareId,
          ownerAccountId: "owner",
          fileName: `${audioId}.wav`,
          mediaKind: "SFX",
          category: "音效",
          subcategory: "",
          createdAt: "2026-10-24T00:00:00Z",
          version: 0,
        }],
      };
    },
    async openAudioContentStream(audioId, { signal } = {}) {
      calls.stream += 1;
      const spec = byId.get(audioId);
      let started = false;
      const body = new Readable({
        read() {
          if (started) return;
          started = true;
          this.push(Buffer.from("short"));
        },
      });
      signal?.addEventListener("abort", () => body.destroy(), { once: true });
      return {
        status: 200,
        headers: { "content-type": "audio/wav", "content-length": String(spec.bytes) },
        body,
      };
    },
  };
}

test("catalog 只请求一次列表，不逐条取详情；分页/参数固定校验", async (t) => {
  const { service, cloud } = await setup(t);
  const page = await service.catalog({ limit: "10", offset: "0" });
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, false);
  assert.equal(cloud.calls.catalog, 1);
  assert.equal(cloud.calls.details, 0, "catalog 不得 fanout 详情");
  for (const bad of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 100001 }, { limit: "x" }])
    await assert.rejects(() => service.catalog(bad), (error) => error.code === "INVALID_REQUEST", JSON.stringify(bad));
  assert.equal(cloud.calls.catalog, 1, "非法分页不应请求云端");
  cloud.flags.emptyCatalog = true;
  const empty = await service.catalog({ limit: 50, offset: 0 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.hasMore, false);
  assert.equal(cloud.calls.details, 0, "空列表也不得逐条请求详情");
});

test("details 懒加载；显式选择第二个可见来源时只复制该来源的允许字段", async (t) => {
  const { service, cloud, root } = await setup(t);
  const details = await service.details(cloud.audioId, { limit: 50, offset: 0 });
  assert.equal(details.shares.length, 2);
  assert.equal(cloud.calls.details, 1);
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.secondShareId, rootId: root.id });
  assert.equal(job.fileName, "另一个名字.wav");
  assert.equal(cloud.calls.stream, 0);
  await service.cancel(job.id);
});

test("完整下载：接收/安装/可见索引/来源记录；重复下载复用同一文件不产生副本", async (t) => {
  const { service, cloud, root, lib, mediaRoot } = await setup(t);
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(done.errorCode, "");
  assert.equal(done.createdFile, true);
  assert.equal(done.receivedBytes, cloud.bytes.length);
  const expected = path.join(mediaRoot, "音效", "环境", "环境音.wav");
  assert.deepEqual(await filesUnder(mediaRoot), [expected]);
  assert.equal(await fs.readFile(expected).then(sha), sha(cloud.bytes));
  const asset = lib.db.prepare("SELECT id,online,trashed,category,sub,size FROM assets WHERE path=?").get(expected);
  assert.ok(asset, "必须产生可见索引，而不是只排队扫描");
  assert.equal(asset.id, done.assetId);
  assert.equal(asset.online, 1);
  assert.equal(asset.trashed, 0);
  assert.equal(asset.category, "音效");
  assert.equal(asset.sub, "环境");
  const provenance = service.listJobs().find((item) => item.id === job.id);
  assert.equal(provenance.shareId, cloud.shareId);
  assert.equal(JSON.stringify(provenance).includes(mediaRoot), false, "任务 DTO 不得含本机路径");

  const again = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const second = await waitJob(service, again.id);
  assert.equal(second.state, "completed");
  assert.equal(second.createdFile, false);
  assert.equal(second.assetId, done.assetId);
  assert.deepEqual(await filesUnder(mediaRoot), [expected], "重试/重复下载不得产生第二个文件");
});

test("MUSIC 正常新根：混合目录按来源入库为 music，分类保留且重扫不丢失", async (t) => {
  const { service, cloud, lib, base } = await setup(t);
  const root = await makeRoot(lib, base, "混合下载", "mixed");
  cloud.mediaKind = "MUSIC";
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  assert.equal(job.mediaKind, "MUSIC", "任务必须携带可信来源类型");
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "completed", JSON.stringify(done));
  assert.equal(done.createdFile, true);
  const expected = path.join(root.path, "音效", "环境", "环境音.wav");
  assert.deepEqual(await filesUnder(root.path), [expected]);
  const asset = lib.db.prepare("SELECT id,kind,category,sub,basis,online,trashed FROM assets WHERE id=?").get(done.assetId);
  assert.equal(asset.kind, "music", "MUSIC 来源不得被混合根默认成 sfx");
  assert.equal(asset.category, "音效", "只改类型，不丢失按目录得到的分类");
  assert.equal(asset.sub, "环境");
  assert.equal(asset.online, 1);
  assert.equal(asset.trashed, 0);

  const scan = lib.scan(root.id);
  await waitScan(lib, scan);
  const rescanned = lib.db.prepare("SELECT kind FROM assets WHERE id=?").get(done.assetId);
  assert.equal(rescanned.kind, "music", "重扫必须保留已设置的个人类型");
});

test("SFX 回归：混合目录仍按来源入库为 sfx", async (t) => {
  const { service, cloud, lib, base } = await setup(t);
  const root = await makeRoot(lib, base, "混合下载", "mixed");
  cloud.mediaKind = "SFX";
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "completed", JSON.stringify(done));
  const asset = lib.db.prepare("SELECT kind FROM assets WHERE id=?").get(done.assetId);
  assert.equal(asset.kind, "sfx");
});

test("发布后后台扫描先建索引：本任务新 MUSIC 仍完成，不被误判 KIND_CONFLICT", async (t) => {
  const { service, cloud, lib, base } = await setup(t);
  const root = await makeRoot(lib, base, "混合下载", "mixed");
  cloud.mediaKind = "MUSIC";
  const original = CloudAudioInstaller.prototype.publish;
  // 模拟允许的后台/手动扫描：在真实 no-replace 发布之后、service #register
  // 取“发布前快照”之前完成一次 Library.scan，先给新文件建 sfx 索引。
  CloudAudioInstaller.prototype.publish = async function (...args) {
    const installed = await original.apply(this, args);
    await waitScan(lib, lib.scan(root.id));
    return installed;
  };
  try {
    const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
    const done = await waitJob(service, job.id);
    assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal(done.errorCode, "");
    assert.equal(done.createdFile, true);
    const expected = path.join(root.path, "音效", "环境", "环境音.wav");
    const asset = lib.db.prepare("SELECT id,kind,dev,ino FROM assets WHERE path=?").get(expected);
    assert.equal(asset.id, done.assetId);
    assert.equal(asset.kind, "music", "后台先扫到本任务新 inode 不得被当成既有个人资产");
    assert.deepEqual(await filesUnder(root.path), [expected]);
  } finally {
    CloudAudioInstaller.prototype.publish = original;
  }
});

test("同名冲突候选：发布前快照按实际候选路径，MUSIC 新文件成功且旧 SFX 不变", async (t) => {
  const { service, cloud, lib, base } = await setup(t);
  const root = await makeRoot(lib, base, "混合下载", "mixed");
  cloud.mediaKind = "SFX";
  const first = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const firstDone = await waitJob(service, first.id);
  assert.equal(firstDone.state, "completed", JSON.stringify(firstDone));
  const originalPath = path.join(root.path, "音效", "环境", "环境音.wav");
  assert.equal(lib.db.prepare("SELECT kind FROM assets WHERE path=?").get(originalPath).kind, "sfx");

  // 同文件名、不同内容：安装器必须换到实际候选“环境音 (2).wav”。
  cloud.bytes = wavBytes(29);
  cloud.mediaKind = "MUSIC";
  const original = CloudAudioInstaller.prototype.publish;
  CloudAudioInstaller.prototype.publish = async function (...args) {
    const installed = await original.apply(this, args);
    await waitScan(lib, lib.scan(root.id));
    return installed;
  };
  try {
    const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
    const done = await waitJob(service, job.id);
    assert.equal(done.state, "completed", JSON.stringify(done));
    assert.equal(done.createdFile, true);
    const candidate = path.join(root.path, "音效", "环境", "环境音 (2).wav");
    const created = lib.db.prepare("SELECT id,kind FROM assets WHERE path=?").get(candidate);
    assert.equal(created.kind, "music", "快照必须查实际候选，不能查原始 basename");
    assert.notEqual(created.id, firstDone.assetId);
    const old = lib.db.prepare("SELECT id,kind FROM assets WHERE path=?").get(originalPath);
    assert.equal(old.id, firstDone.assetId);
    assert.equal(old.kind, "sfx", "碰撞候选的新类型不得改到旧资产");
  } finally {
    CloudAudioInstaller.prototype.publish = original;
  }
});

test("发布前已有同路径离线个人资产：不按云端 MUSIC 改类型，固定 KIND_CONFLICT", async (t) => {
  const { service, cloud, lib, base } = await setup(t);
  const root = await makeRoot(lib, base, "混合下载", "mixed");
  const dir = path.join(root.path, "音效", "环境");
  await fs.mkdir(dir, { recursive: true });
  const oldPath = path.join(dir, "环境音.wav");
  await fs.writeFile(oldPath, wavBytes(21));
  await waitScan(lib, lib.scan(root.id));
  const old = lib.db.prepare("SELECT id,kind FROM assets WHERE path=?").get(oldPath);
  assert.ok(old, "离线旧资产必须有索引行");
  assert.equal(old.kind, "sfx");
  // 文件被手工移走后只留下旧索引行；这不是“本任务新文件”，不能复活并改类型。
  await fs.unlink(oldPath);
  await waitScan(lib, lib.scan(root.id));
  assert.equal(lib.db.prepare("SELECT online FROM assets WHERE id=?").get(old.id).online, 0);

  cloud.mediaKind = "MUSIC";
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "failed", JSON.stringify(done));
  assert.equal(done.errorCode, "KIND_CONFLICT");
  assert.equal(done.assetId, "");
  const after = lib.db.prepare("SELECT id,kind FROM assets WHERE path=?").get(oldPath);
  assert.equal(after.id, old.id, "必须保留原个人资产 id");
  assert.equal(after.kind, "sfx", "离线旧资产的个人类型不得被云端类型覆盖");
});

test("根类型不兼容：MUSIC→音效根、SFX→音乐根都固定 ROOT_KIND，不建任务不传输", async (t) => {
  const { service, cloud, root, lib, base } = await setup(t);
  cloud.mediaKind = "MUSIC";
  await assert.rejects(
    () => service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id }),
    (error) => error.code === "ROOT_KIND" && error.status === 409,
    "音效根不得静默接收音乐",
  );
  const musicRoot = await makeRoot(lib, base, "音乐下载", "music");
  cloud.mediaKind = "SFX";
  await assert.rejects(
    () => service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: musicRoot.id }),
    (error) => error.code === "ROOT_KIND" && error.status === 409,
    "音乐根不得静默接收音效",
  );
  assert.equal(service.listJobs().length, 0, "被拒绝的根类型不得留下任务");
  assert.equal(cloud.calls.stream, 0);
});

test("复用已有文件/资产不覆盖个人类型：SFX 后同文件按 MUSIC 下载 → KIND_CONFLICT", async (t) => {
  const { service, cloud, lib, base } = await setup(t);
  const root = await makeRoot(lib, base, "混合下载", "mixed");
  cloud.mediaKind = "SFX";
  const first = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const firstDone = await waitJob(service, first.id);
  assert.equal(firstDone.state, "completed", JSON.stringify(firstDone));
  const expected = path.join(root.path, "音效", "环境", "环境音.wav");
  assert.equal(lib.db.prepare("SELECT kind FROM assets WHERE id=?").get(firstDone.assetId).kind, "sfx");

  cloud.mediaKind = "MUSIC";
  const second = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const secondDone = await waitJob(service, second.id);
  assert.equal(secondDone.state, "failed", JSON.stringify(secondDone));
  assert.equal(secondDone.errorCode, "KIND_CONFLICT");
  assert.equal(secondDone.createdFile, false);
  assert.equal(secondDone.assetId, "", "冲突不得假报入库成功");
  const asset = lib.db.prepare("SELECT id,kind FROM assets WHERE path=?").get(expected);
  assert.equal(asset.id, firstDone.assetId, "既有资产必须保持原 id");
  assert.equal(asset.kind, "sfx", "复用文件的个人类型不得被云端类型覆盖");
  assert.deepEqual(await filesUnder(root.path), [expected], "不得为隐藏冲突而复制文件");
  assert.equal(lib.db.prepare("SELECT COUNT(*) n FROM assets WHERE root_id=?").get(root.id).n, 1);
});

test("执行时复核来源 mediaKind：创建任务后被改成另一类型 → AUDIO_CHANGED，不安装", async (t) => {
  const { service, cloud, root, mediaRoot } = await setup(t);
  const g = gate();
  cloud.flags.detailGate = g;
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const deadline = Date.now() + 3000;
  while (cloud.calls.details < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cloud.calls.details, 2, "执行前应重新读取详情");
  cloud.mediaKind = "MUSIC";
  g.release();
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "failed", JSON.stringify(done));
  assert.equal(done.errorCode, "AUDIO_CHANGED");
  assert.equal(cloud.calls.stream, 0, "类型变化后不得打开内容流");
  assert.deepEqual(await filesUnder(mediaRoot), []);
});

test("重复点击：活动任务按同一音频去重，只发起一次传输", async (t) => {
  const { service, cloud, root } = await setup(t);
  const g = gate();
  cloud.flags.streamGate = g;
  const [first, second] = await Promise.all([
    service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id }),
    service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id }),
  ]);
  assert.equal(second.id, first.id, "并发重复点击必须返回同一个任务");
  const deadline = Date.now() + 3000;
  while (cloud.calls.stream === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cloud.calls.stream, 1);
  g.release();
  const done = await waitJob(service, first.id);
  assert.equal(done.state, "completed");
});

test("显式取消：传输中止、任务 cancelled、无文件/无接收器残留", async (t) => {
  const { service, cloud, root, mediaRoot } = await setup(t);
  const g = gate();
  cloud.flags.streamGate = g;
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const cancelling = await service.cancel(job.id);
  assert.equal(cancelling.cancelRequested, true);
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "cancelled");
  assert.equal(done.errorCode, "CANCELLED");
  assert.deepEqual(await filesUnder(mediaRoot), []);
  const settled = Date.now() + 3000;
  while ((await service.status()).active !== 0 && Date.now() < settled) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await service.status()).active, 0);
  g.release();
});

test("刚启动/尚未落盘 downloading 时取消：走 abort，不被 completed 覆盖", async (t) => {
  const { service, cloud, root, mediaRoot } = await setup(t);
  const g = gate();
  cloud.flags.streamGate = g;
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  // 不等待状态变为 downloading，立即取消，覆盖“queued 但已有活动执行器”的竞态。
  const cancelling = await service.cancel(job.id);
  assert.equal(cancelling.cancelRequested, true);
  g.release();
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "cancelled", JSON.stringify(done));
  assert.deepEqual(await filesUnder(mediaRoot), []);
});

test("摘要不符/长度不足：固定失败码、不安装、不残留临时产物", async (t) => {
  for (const mode of ["wrong", "truncate"]) {
    const { service, cloud, root, mediaRoot, dataDir } = await setup(t);
    if (mode === "wrong") cloud.flags.wrongBytes = wavBytes(99);
    else cloud.flags.truncate = true;
    const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
    const done = await waitJob(service, job.id);
    assert.equal(done.state, "failed");
    assert.ok(["DIGEST_MISMATCH", "LENGTH_MISMATCH"].includes(done.errorCode), done.errorCode);
    assert.deepEqual(await filesUnder(mediaRoot), []);
    const workEntries = await fs.readdir(path.join(dataDir, "cloud-audio-tmp"));
    assert.deepEqual(workEntries, [], "接收器临时文件必须清空");
    await service.dispose();
  }
});

test("下载前来源被撤销：SHARE_UNAVAILABLE，不发起传输", async (t) => {
  const { service, cloud, root, mediaRoot } = await setup(t);
  const g = gate();
  cloud.flags.detailGate = g;
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const deadline = Date.now() + 3000;
  while (cloud.calls.details < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(cloud.calls.details, 2, "运行期应重新读取详情");
  cloud.flags.noShares = true;
  g.release();
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "failed");
  assert.equal(done.errorCode, "SHARE_UNAVAILABLE");
  assert.equal(cloud.calls.stream, 0);
  assert.deepEqual(await filesUnder(mediaRoot), []);
});

test("下载后根被替换：ROOT_CHANGED，不写入新根", async (t) => {
  const { service, cloud, root, mediaRoot, base } = await setup(t);
  const g = gate();
  cloud.flags.streamGate = g;
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  await fs.rename(mediaRoot, path.join(base, "old-root"));
  await fs.mkdir(mediaRoot);
  g.release();
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "failed");
  assert.equal(done.errorCode, "ROOT_CHANGED");
  assert.deepEqual(await filesUnder(mediaRoot), []);
});

test("登录代际在传输中变化：不返回旧身份成功、无文件", async (t) => {
  const { service, cloud, root, mediaRoot } = await setup(t);
  const g = gate();
  cloud.flags.streamGate = g;
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  await new Promise((resolve) => setTimeout(resolve, 60));
  cloud.epoch += 1;
  g.release();
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "failed");
  assert.ok(["AUTH_CHANGED", "CONTEXT_CHANGED"].includes(done.errorCode), done.errorCode);
  assert.deepEqual(await filesUnder(mediaRoot), []);
});

test("已存在同名不同字节：保留原文件，使用确定后缀；索引指向新文件", async (t) => {
  const { service, cloud, root, mediaRoot } = await setup(t);
  const dir = path.join(mediaRoot, "音效", "环境");
  await fs.mkdir(dir, { recursive: true });
  const foreign = wavBytes(77, 100);
  await fs.writeFile(path.join(dir, "环境音.wav"), foreign);
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const done = await waitJob(service, job.id);
  assert.equal(done.state, "completed");
  assert.equal(await fs.readFile(path.join(dir, "环境音.wav")).then(sha), sha(foreign), "绝不能覆盖既有原文件");
  assert.equal(await fs.readFile(path.join(dir, "环境音 (2).wav")).then(sha), sha(cloud.bytes));
});

test("数据库失败：不返回成功；已创建文件保留供人工处理，既有文件不动", async (t) => {
  const { service, cloud, root, mediaRoot, lib } = await setup(t);
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  lib.db.close();
  const done = await waitJob(service, job.id);
  assert.notEqual(done.state, "completed");
  assert.ok(["INDEX_FAILED", "INDEX_BUSY", "INTERNAL", "ROOT_NOT_FOUND"].includes(done.errorCode), done.errorCode);
  const files = await filesUnder(mediaRoot);
  assert.ok(files.length <= 1, "失败任务不得产生多个文件");
  if (files.length === 1) assert.ok((await fs.stat(files[0])).isFile());
});

test("任务读取/取消/重试/去重按账户+设备+origin 隔离；登出不可读", async (t) => {
  const { service, cloud, root } = await setup(t);
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  assert.equal((await waitJob(service, job.id)).state, "completed");

  cloud.epoch += 1;
  assert.equal(service.listJobs().length, 1, "同一账户/设备重新登录后的历史仍可见");
  cloud.accountId = "account-b";
  cloud.deviceId = "device-b";
  cloud.epoch += 1;
  assert.deepEqual(service.listJobs(), [], "换账户后不得返回前账户的私有任务");
  assert.throws(() => service.getJob(job.id), (error) => error.code === "JOB_NOT_FOUND");
  await assert.rejects(() => service.cancel(job.id), (error) => error.code === "JOB_NOT_FOUND");
  await assert.rejects(() => service.retry(job.id), (error) => error.code === "JOB_NOT_FOUND");

  cloud.loggedIn = false;
  assert.throws(() => service.listJobs(), (error) => error.code === "NOT_LOGGED_IN");
  assert.throws(() => service.getJob(job.id), (error) => error.code === "NOT_LOGGED_IN");
});

test("外来身份的同一音频活动任务：只返回固定 BUSY，不泄露/不领养", async (t) => {
  const { service, cloud, root } = await setup(t);
  const g = gate();
  cloud.flags.streamGate = g;
  const first = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const owner = { accountId: cloud.accountId, deviceId: cloud.deviceId, epoch: cloud.epoch };
  cloud.accountId = "account-b";
  cloud.deviceId = "device-b";
  cloud.epoch += 1;
  await assert.rejects(
    () => service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id }),
    (error) => error.code === "BUSY",
  );
  cloud.accountId = owner.accountId;
  cloud.deviceId = owner.deviceId;
  cloud.epoch = owner.epoch;
  g.release();
  assert.equal((await waitJob(service, first.id)).state, "completed");
});

test("receive 成功后、consume 前失败：已校验产物必须释放，临时目录为空", async (t) => {
  const { service, cloud, root, mediaRoot, base, dataDir } = await setup(t);
  const original = CloudAudioReceiver.prototype.receive;
  CloudAudioReceiver.prototype.receive = async function (...args) {
    const result = await original.apply(this, args);
    await fs.rename(mediaRoot, path.join(base, "old-root"));
    await fs.mkdir(mediaRoot);
    return result;
  };
  try {
    const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
    const done = await waitJob(service, job.id);
    assert.equal(done.state, "failed");
    assert.equal(done.errorCode, "ROOT_CHANGED");
    assert.deepEqual(await fs.readdir(path.join(dataDir, "cloud-audio-tmp")), [], "失败任务不得留下 .part 租约");
  } finally {
    CloudAudioReceiver.prototype.receive = original;
  }
});

test("重试：账户/设备或根代际变化时固定拒绝，不静默换身份/换目录", async (t) => {
  const { service, cloud, root, base, mediaRoot } = await setup(t);
  cloud.flags.wrongBytes = wavBytes(99);
  const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id });
  const failed = await waitJob(service, job.id);
  assert.equal(failed.state, "failed");

  const account = cloud.accountId;
  cloud.accountId = "another-account";
  await assert.rejects(() => service.retry(job.id), (error) => error.code === "JOB_NOT_FOUND");
  cloud.accountId = account;

  await fs.rename(mediaRoot, path.join(base, "old-root"));
  await fs.mkdir(mediaRoot);
  await assert.rejects(() => service.retry(job.id), (error) => error.code === "ROOT_CHANGED");
});

test("默认关闭：不建临时目录、不联网，catalog/start 均固定 503", async (t) => {
  const { dataDir, service, cloud } = await setup(t, { enabled: false });
  const status = await service.status();
  assert.equal(status.enabled, false);
  await assert.rejects(() => service.catalog(), (error) => {
    assert.ok(error instanceof CloudAudioServiceError);
    assert.equal(error.code, "CLOUD_AUDIO_DISABLED");
    assert.equal(error.status, 503);
    return true;
  });
  await assert.rejects(() => service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: "x" }), (error) => error.code === "CLOUD_AUDIO_DISABLED");
  assert.equal(cloud.calls.catalog, 0);
  await assert.rejects(fs.access(path.join(dataDir, "cloud-audio-tmp")), /ENOENT/);
  await assert.rejects(fs.access(path.join(dataDir, "cloud-audio-jobs.json")), /ENOENT/);
});

test("根登记：安全绝对路径登记为素材根；符号链接/不安全路径固定拒绝", async (t) => {
  const { service, base } = await setup(t, { enabled: false });
  await assert.rejects(() => service.registerRoot({ path: base }), (error) => error.code === "CLOUD_AUDIO_DISABLED");
  const { service: live } = await setup(t);
  const fresh = path.join(base, "新下载根");
  await fs.mkdir(fresh);
  const root = await live.registerRoot({ path: fresh, kind: "sfx" });
  assert.equal(root.kind, "sfx");
  assert.ok(live.roots().some((item) => item.id === root.id));
  const mixed = path.join(base, "混合下载根");
  await fs.mkdir(mixed);
  const mixedRoot = await live.registerRoot({ path: mixed, kind: "mixed" });
  assert.equal(mixedRoot.kind, "mixed");
  assert.ok(live.roots().some((item) => item.id === mixedRoot.id && item.kind === "mixed"));
  const implicit = path.join(base, "默认下载根");
  await fs.mkdir(implicit);
  assert.equal((await live.registerRoot({ path: implicit })).kind, "mixed", "省略类型时不得默认音效根");
  const link = path.join(base, "link-root");
  await fs.symlink(fresh, link);
  await assert.rejects(() => live.registerRoot({ path: link }), (error) => ["ROOT_UNSAFE", "ROOT_NOT_FOUND"].includes(error.code));
});

test("重启恢复：store 把未完成任务标 interrupted，服务列表可读且不自动重跑", async (t) => {
  const { dataDir } = await setup(t, { enabled: false });
  const first = await new CloudAudioJobStore(dataDir).init();
  const job = await first.create({
    audioId: crypto.randomUUID(),
    shareId: crypto.randomUUID(),
    accountId: "a",
    deviceId: "d",
    epoch: 1,
    rootId: "r",
    rootName: "根",
    rootPath: "/tmp/root",
    rootGeneration: "a".repeat(64),
    category: "音效",
    subcategory: "",
    fileName: "x.wav",
    bytes: 10,
    sha256: "b".repeat(64),
    mimeType: "audio/wav",
  });
  await first.update(job.id, { state: "downloading" });
  await first.close();
  const second = await new CloudAudioJobStore(dataDir).init();
  assert.equal(second.get(job.id).state, "interrupted");
  assert.equal(second.countActive(), 0);
  await second.close();
});

test("启动不按文件名删除残留：随机 32-hex .part 与其它文件原样保留并保守计量", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-ca-residue-")));
  const dataDir = path.join(base, "data");
  const mediaRoot = path.join(base, "media");
  const work = path.join(dataDir, "cloud-audio-tmp");
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(work, { recursive: true, mode: 0o700 });
  await fs.chmod(work, 0o700);
  const foreign = path.join(work, `${"a".repeat(32)}.part`);
  await fs.writeFile(foreign, Buffer.alloc(123, 1), { mode: 0o600 });
  await fs.writeFile(path.join(work, "unrelated.tmp"), Buffer.alloc(9, 1), { mode: 0o600 });
  const lib = await new Library(dataDir, { directoryClassification: true }).init();
  const root = await lib.addRoot(mediaRoot, "sfx");
  const cloud = makeCloud();
  const service = await new CloudAudioService(lib, { dataDir, cloudAuth: cloud, enabled: true }).init();
  t.after(async () => {
    await service.dispose();
    try { lib.db.close(); } catch { /* 已关闭 */ }
    await fs.rm(base, { recursive: true, force: true });
  });
  const status = await service.status();
  assert.equal(status.recoveredTempFiles, undefined, "不再提供自动回收计数");
  assert.equal(status.staleTempFiles, 2, "所有现存条目都按未知/活动残留计量");
  assert.equal(status.staleTempBytes, 132);
  assert.equal(status.staleTempUnreadable, false);
  assert.deepEqual((await fs.readdir(work)).sort(), ["a".repeat(32) + ".part", "unrelated.tmp"],
    "32-hex 文件名不是归属证据，启动不得删除未知文件");
  assert.deepEqual(await fs.readFile(foreign), Buffer.alloc(123, 1));
  assert.ok(root.id);
});

test("启动拒绝 workDir 符号链接：不 chmod/删除链接目标，也不读写目标文件", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-ca-symlink-")));
  const dataDir = path.join(base, "data");
  const mediaRoot = path.join(base, "media");
  await fs.mkdir(mediaRoot, { recursive: true });
  const lib = await new Library(dataDir, { directoryClassification: true }).init();
  const outside = path.join(base, "outside");
  await fs.mkdir(outside, { mode: 0o755 });
  const foreign = path.join(outside, `${"b".repeat(32)}.part`);
  await fs.writeFile(foreign, Buffer.from("outside data"), { mode: 0o600 });
  const beforeMode = (await fs.stat(outside)).mode & 0o777;
  await fs.symlink(outside, path.join(dataDir, "cloud-audio-tmp"));
  const auth = { epoch: 1, getState: () => ({ configured: false, state: "unconfigured" }) };
  const service = new CloudAudioService(lib, { dataDir, cloudAuth: auth, enabled: true });
  t.after(async () => {
    await service.dispose();
    try { lib.db.close(); } catch { /* 已关闭 */ }
    await fs.rm(base, { recursive: true, force: true });
  });
  await assert.rejects(() => service.init(), (error) => error.code === "TEMP_UNSAFE");
  assert.equal(await fs.readFile(foreign, "utf8"), "outside data");
  assert.equal((await fs.stat(outside)).mode & 0o777, beforeMode, "失败启动不得 chmod 链接目标");
});

test("未知残留达到临时空间上限：保留文件并以 TEMP_LIMIT 拒绝新下载", async (t) => {
  const { service, cloud, root, dataDir } = await setup(t);
  const work = path.join(dataDir, "cloud-audio-tmp");
  const residual = path.join(work, `${"c".repeat(32)}.part`);
  const handle = await fs.open(residual, "w", 0o600);
  await handle.truncate(600_000_000);
  await handle.close();
  await assert.rejects(
    () => service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id }),
    (error) => error.code === "TEMP_LIMIT",
  );
  assert.equal((await fs.stat(residual)).size, 600_000_000, "容量门禁不得删除未知残留");
  assert.equal(cloud.calls.details, 0, "容量不足时不得先请求云端详情");
  const status = await service.status();
  assert.equal(status.staleTempFiles, 1);
  assert.equal(status.staleTempBytes, 600_000_000);
});

test("容量预留：550MB 残留 + 100MB 声明在打开内容流前固定 TEMP_LIMIT", async (t) => {
  const spec = { audioId: crypto.randomUUID(), shareId: crypto.randomUUID(), bytes: 100_000_000 };
  const cloud = makeCapacityCloud([spec]);
  const { service, root, dataDir } = await setup(t, { cloud });
  const residue = path.join(dataDir, "cloud-audio-tmp", "unknown-residue");
  const handle = await fs.open(residue, "w", 0o600);
  await handle.truncate(550_000_000);
  await handle.close();
  await assert.rejects(
    () => service.startDownload({ audioId: spec.audioId, shareId: spec.shareId, rootId: root.id }),
    (error) => error.code === "TEMP_LIMIT",
  );
  assert.equal(cloud.calls.stream, 0, "预留不足时不得打开内容流");
  assert.equal((await fs.stat(residue)).size, 550_000_000, "容量门禁不得删除未知残留");
});

test("容量并发准入：500MB 残留 + 两个 100MB 只准入一个，取消后定向释放", async (t) => {
  const specs = [
    { audioId: crypto.randomUUID(), shareId: crypto.randomUUID(), bytes: 100_000_000 },
    { audioId: crypto.randomUUID(), shareId: crypto.randomUUID(), bytes: 100_000_000 },
  ];
  const cloud = makeCapacityCloud(specs);
  const { service, root, dataDir } = await setup(t, { cloud });
  const residue = path.join(dataDir, "cloud-audio-tmp", "unknown-residue");
  const handle = await fs.open(residue, "w", 0o600);
  await handle.truncate(500_000_000);
  await handle.close();
  const results = await Promise.allSettled(specs.map((spec) =>
    service.startDownload({ audioId: spec.audioId, shareId: spec.shareId, rootId: root.id })));
  const accepted = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(accepted.length, 1, "并发请求不能重复使用同一份空余额");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, "TEMP_LIMIT");
  const running = accepted[0].value;
  await service.cancel(running.id);
  assert.equal((await waitJob(service, running.id)).state, "cancelled");
  // 取消必须释放预留：500MB + 100MB 应重新刚好准入，而不是残留两份预留。
  const retrySpec = specs.find((spec) => spec.audioId !== running.audioId);
  const retry = await service.startDownload({
    audioId: retrySpec.audioId,
    shareId: retrySpec.shareId,
    rootId: root.id,
  });
  assert.ok(retry.id);
  await service.cancel(retry.id);
  await waitJob(service, retry.id);
  assert.equal((await fs.stat(residue)).size, 500_000_000);
});

test("容量释放：接近上限的小文件下载完成后预留不泄漏，下一次仍可准入", async (t) => {
  const { service, cloud, root, dataDir } = await setup(t);
  const residue = path.join(dataDir, "cloud-audio-tmp", "unknown-residue");
  const handle = await fs.open(residue, "w", 0o600);
  await handle.truncate(599_999_700);
  await handle.close();
  const first = await service.startDownload({
    audioId: cloud.audioId,
    shareId: cloud.shareId,
    rootId: root.id,
  });
  assert.equal((await waitJob(service, first.id)).state, "completed");
  const second = await service.startDownload({
    audioId: cloud.audioId,
    shareId: cloud.shareId,
    rootId: root.id,
  });
  assert.equal((await waitJob(service, second.id)).state, "completed");
  assert.equal((await fs.stat(residue)).size, 599_999_700);
});
