/**
 * T12 Round 4：适配 GPT #0075 空锁竞态反例。
 *
 * 云端 probe 的注入点是 fs.rename(creating, lockRoot)。Round 4 改用排他 mkdir 抢锁后，
 * 该 rename 已不存在，原注入点不可达；这里把同一时序（同步 peek 已通过、异步获取锁之前）
 * 改注入到新的获取原语 fs.mkdir(lockRoot) 之前，保留原 probe 的核心断言：
 *   injected=true / ENGINE_BUSY / 原锁 inode 不变 / 零下载。
 * 仅临时目录、合成归档、回环 TLS；不改云端 probe。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { AudioEngine } from "../../../../server/audio-engine.mjs";
import { tempDir, makeTlsFixture, startTlsServer, makeTar, makeRelease, waitForJob } from "../../../../tests/audio-engine-fixtures.mjs";

test("T12: empty lock appearing after sync peek stays BUSY and unchanged", async (t) => {
  const dataDir = await tempDir(t);
  const tls = await makeTlsFixture(t);
  const archive = await makeTar([{ name: "audio-analyze", data: Buffer.from("synthetic-only") }]);
  const server = await startTlsServer(t, tls, (_req, res) => {
    res.writeHead(200, { "content-length": archive.length });
    res.end(archive);
  });
  const engine = new AudioEngine(dataDir, {
    release: makeRelease(archive, server.url), ca: tls.ca, diskFreeBytes: 1e9,
  });
  t.after(() => engine.dispose());
  const lock = path.join(dataDir, "engines", ".audio-install.lock");
  const originalMkdir = fs.mkdir;
  let injected = false;
  let beforeIno;
  fs.mkdir = async (target, options) => {
    if (!injected && target === lock) {
      injected = true;
      await originalMkdir(lock);
      beforeIno = (await fs.lstat(lock)).ino;
    }
    return originalMkdir(target, options);
  };
  t.after(() => { fs.mkdir = originalMkdir; });
  engine.install({ confirm: true });
  const status = await waitForJob(engine);
  t.diagnostic(JSON.stringify({ injected, state: status.job.state, code: status.job.error?.code, requests: server.counts.requests }));
  assert.equal(injected, true);
  assert.equal(status.job.error?.code, "ENGINE_BUSY", "empty lock must not be overwritten by exclusive mkdir");
  assert.equal((await fs.lstat(lock)).ino, beforeIno);
  assert.equal(server.counts.requests, 0);
});
