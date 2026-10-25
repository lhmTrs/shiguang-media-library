/**
 * T-LOCAL-014A：云端音频接收核心定向测试。
 *
 * 全部使用临时 0700 目录、合成 Buffer/Readable 与同步上下文回调：
 *   - 不联网、不读证书/令牌、不接触真实素材或素材库；
 *   - 覆盖状态/头/长度/MIME/编码、短写、超时、取消、中断、上下文代际、
 *     并发上限、私有文件、符号链接、清理失败与固定错误码边界。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  CloudAudioReceiver,
  CloudAudioReceiverError,
  CLOUD_AUDIO_RECEIVER_MESSAGES,
  MAX_AUDIO_BYTES,
  writeAllChunk,
} from "../server/cloud-audio-receiver.mjs";

const AUDIO_ID = "3f2b8c1e-9a4d-4e6f-8a1b-2c3d4e5f6a7b";
const MIME = "audio/wav";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function makeDir(t) {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, "cloud-audio-"));
  await fs.chmod(dir, 0o700);
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function createReceiver(t, { openStream, resolveContext = () => "gen-1", ...rest }) {
  const workDir = await makeDir(t);
  const receiver = new CloudAudioReceiver({ workDir, openStream, resolveContext, ...rest });
  t.after(async () => {
    try {
      await receiver.dispose();
    } catch {
      /* 故障场景由测试自行断言 */
    }
  });
  return { receiver, workDir };
}

function metadataFor(buffer, overrides = {}) {
  return {
    audioId: AUDIO_ID,
    bytes: buffer.length,
    sha256: sha256(buffer),
    mimeType: MIME,
    ...overrides,
  };
}

function splitChunks(buffer, size) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, offset + size));
  }
  return chunks;
}

function makeBody(buffer, { chunkSize = 8, delayMs = 0 } = {}) {
  const chunks = splitChunks(buffer, chunkSize);
  if (delayMs === 0) return Readable.from(chunks);
  return Readable.from((async function* generate() {
    for (const chunk of chunks) {
      await sleep(delayMs);
      yield chunk;
    }
  })());
}

function makeTransport(buffer, options = {}) {
  const {
    status = 200,
    mime = MIME,
    headers,
    chunkSize = 8,
    delayMs = 0,
    body,
    onOpen,
  } = options;
  const calls = [];
  async function openStream(audioId, signal) {
    calls.push({ audioId, signal, argumentCount: arguments.length });
    if (onOpen !== undefined) await onOpen({ audioId, signal });
    return {
      status,
      headers: headers ?? {
        "Content-Type": mime,
        "Content-Length": String(buffer.length),
      },
      body: body ?? makeBody(buffer, { chunkSize, delayMs }),
    };
  }
  return { openStream, calls };
}

async function rejectsWithCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CloudAudioReceiverError, `unexpected error: ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.message, CLOUD_AUDIO_RECEIVER_MESSAGES[code]);
    return true;
  });
}

async function assertDirEmpty(dir) {
  assert.deepEqual(await fs.readdir(dir), []);
}

async function expectFailureNoLeak(t, transport, meta, code, extra = {}) {
  const { receiver, workDir } = await createReceiver(t, { ...transport, ...extra });
  await rejectsWithCode(receiver.receive(meta), code);
  await assertDirEmpty(workDir);
  assert.equal(receiver.stats().active, 0);
  assert.equal(receiver.stats().orphans, 0);
  return { receiver, workDir };
}

test("合法流式接收：精确长度/SHA、0600 私有文件、产物快照不含路径，release 幂等", async (t) => {
  const payload = crypto.randomBytes(101);
  const transport = makeTransport(payload, { chunkSize: 7 });
  const { receiver, workDir } = await createReceiver(t, transport);

  const artifact = await receiver.receive(metadataFor(payload));
  assert.ok(Object.isFrozen(artifact));
  assert.deepEqual(Object.keys(artifact).sort(), ["artifactId", "audioId", "bytes", "mimeType", "sha256"]);
  assert.match(artifact.artifactId, /^[0-9a-f]{32}$/);
  assert.equal(artifact.audioId, AUDIO_ID);
  assert.equal(artifact.bytes, payload.length);
  assert.equal(artifact.sha256, sha256(payload));
  assert.equal(artifact.mimeType, MIME);
  assert.equal(JSON.stringify(artifact).includes(workDir), false);
  assert.equal(receiver.stats().artifacts, 1);

  const entries = await fs.readdir(workDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[0-9a-f]{32}\.part$/);
  const storedPath = path.join(workDir, entries[0]);
  assert.deepEqual(await fs.readFile(storedPath), payload);
  const stat = await fs.stat(storedPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.nlink, 1);

  assert.equal(await receiver.release(artifact.artifactId), true);
  assert.equal(await receiver.release(artifact.artifactId), false);
  await assertDirEmpty(workDir);
  assert.equal(receiver.stats().artifacts, 0);
});

test("短流：实际字节少于 Content-Length/声明 → LENGTH_MISMATCH 并清理", async (t) => {
  const payload = crypto.randomBytes(40);
  const cut = payload.subarray(0, 17);
  const transport = makeTransport(payload, { body: Readable.from([cut]) });
  await expectFailureNoLeak(t, transport, metadataFor(payload), "LENGTH_MISMATCH");
});

test("长流：超出声明长度立即失败 → TOO_LARGE 并清理", async (t) => {
  const payload = crypto.randomBytes(32);
  const transport = makeTransport(payload, {
    body: Readable.from([payload, Buffer.from("extra-bytes")]),
  });
  await expectFailureNoLeak(t, transport, metadataFor(payload), "TOO_LARGE");
});

test("同长度但摘要不符 → DIGEST_MISMATCH 且不返回产物", async (t) => {
  const payload = crypto.randomBytes(64);
  const transport = makeTransport(payload);
  await expectFailureNoLeak(t, transport, metadataFor(payload, { sha256: "0".repeat(64) }), "DIGEST_MISMATCH");
});

test("状态码边界：206/3xx/5xx 均按固定码拒绝", async (t) => {
  const payload = crypto.randomBytes(16);
  await expectFailureNoLeak(t, makeTransport(payload, { status: 206 }), metadataFor(payload), "PARTIAL_REJECTED");
  await expectFailureNoLeak(t,
    makeTransport(payload, { status: 302, headers: { Location: "https://private.example/x", "Content-Type": MIME, "Content-Length": "16" } }),
    metadataFor(payload), "REDIRECT_REJECTED");
  await expectFailureNoLeak(t, makeTransport(payload, { status: 500 }), metadataFor(payload), "STATUS_REJECTED");
});

test("200 带 Location/Content-Range/Transfer-Encoding 也拒绝", async (t) => {
  const payload = crypto.randomBytes(16);
  const base = { "Content-Type": MIME, "Content-Length": "16" };
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: { ...base, Location: "/private/tmp/x" } }),
    metadataFor(payload), "REDIRECT_REJECTED");
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: { ...base, "Content-Range": "bytes 0-15/16" } }),
    metadataFor(payload), "PARTIAL_REJECTED");
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: { ...base, "Transfer-Encoding": "chunked" } }),
    metadataFor(payload), "RESPONSE_INVALID");
});

test("MIME：非白名单/与声明不一致 → UNSUPPORTED_MIME / MIME_MISMATCH", async (t) => {
  const payload = crypto.randomBytes(16);
  await expectFailureNoLeak(t,
    makeTransport(payload, { mime: "text/plain" }), metadataFor(payload), "UNSUPPORTED_MIME");
  await expectFailureNoLeak(t,
    makeTransport(payload, { mime: "audio/mpeg" }), metadataFor(payload), "MIME_MISMATCH");
});

test("压缩编码拒绝；identity 允许", async (t) => {
  const payload = crypto.randomBytes(16);
  const base = { "Content-Type": MIME, "Content-Length": "16" };
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: { ...base, "Content-Encoding": "gzip" } }),
    metadataFor(payload), "ENCODING_REJECTED");

  const { receiver, workDir } = await createReceiver(t, makeTransport(payload, {
    headers: { ...base, "Content-Encoding": "identity" },
  }));
  const artifact = await receiver.receive(metadataFor(payload));
  assert.equal(artifact.sha256, sha256(payload));
  await receiver.release(artifact.artifactId);
  await assertDirEmpty(workDir);
});

test("长度头：缺失/非法/0/与声明不符分别固定拒绝", async (t) => {
  const payload = crypto.randomBytes(16);
  const typeOnly = { "Content-Type": MIME };
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: typeOnly }), metadataFor(payload), "RESPONSE_INVALID");
  for (const bad of ["16x", "-16", "1e3", "016", " 16"]) {
    await expectFailureNoLeak(t,
      makeTransport(payload, { headers: { "Content-Type": MIME, "Content-Length": bad } }),
      metadataFor(payload), "RESPONSE_INVALID");
  }
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: { "Content-Type": MIME, "Content-Length": "0" } }),
    metadataFor(payload), "RESPONSE_INVALID");
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: { "Content-Type": MIME, "Content-Length": "17" } }),
    metadataFor(payload), "LENGTH_MISMATCH");
  await expectFailureNoLeak(t,
    makeTransport(payload, { headers: { "Content-Type": MIME, "Content-Length": String(MAX_AUDIO_BYTES + 1) } }),
    metadataFor(payload), "TOO_LARGE");
});

test("空闲超时：Readable 完全不产出也按时中止并清理", async (t) => {
  const payload = crypto.randomBytes(16);
  const stalled = new Readable({ read() {} });
  const transport = makeTransport(payload, { body: stalled });
  const { receiver, workDir } = await createReceiver(t, { ...transport, idleTimeoutMs: 60 });
  const started = Date.now();
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "IDLE_TIMEOUT");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 40 && elapsed < 1000, `idle settle ${elapsed}ms`);
  await assertDirEmpty(workDir);
});

test("绝对超时：持续有数据也必须在总时限中止", async (t) => {
  const payload = crypto.randomBytes(64);
  const transport = makeTransport(payload, { body: makeBody(payload, { chunkSize: 8, delayMs: 15 }) });
  const { receiver, workDir } = await createReceiver(t, {
    ...transport,
    idleTimeoutMs: 5000,
    absoluteTimeoutMs: 70,
  });
  const started = Date.now();
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "ABSOLUTE_TIMEOUT");
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 50 && elapsed < 1000, `absolute settle ${elapsed}ms`);
  await assertDirEmpty(workDir);
});

test("openStream 永不返回时，空闲超时仍能及时结束（不悬挂）", async (t) => {
  const payload = crypto.randomBytes(8);
  const { receiver, workDir } = await createReceiver(t, {
    openStream: () => new Promise(() => {}),
    idleTimeoutMs: 50,
  });
  const started = Date.now();
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "IDLE_TIMEOUT");
  assert.ok(Date.now() - started < 1000);
  await assertDirEmpty(workDir);
});

test("调用方取消：开始前直接 ABORTED 且不调用 openStream；复制中取消及时清理", async (t) => {
  const payload = crypto.randomBytes(64);
  const transport = makeTransport(payload);
  const { receiver, workDir } = await createReceiver(t, transport);
  const pre = new AbortController();
  pre.abort();
  await rejectsWithCode(receiver.receive(metadataFor(payload), { signal: pre.signal }), "ABORTED");
  assert.equal(transport.calls.length, 0);
  await assertDirEmpty(workDir);

  const mid = new AbortController();
  const midTransport = makeTransport(payload, { body: makeBody(payload, { chunkSize: 8, delayMs: 25 }) });
  const second = await createReceiver(t, midTransport);
  const started = Date.now();
  const pending = rejectsWithCode(
    second.receiver.receive(metadataFor(payload), { signal: mid.signal }), "ABORTED");
  setTimeout(() => mid.abort(), 40);
  await pending;
  assert.ok(Date.now() - started < 1000);
  await assertDirEmpty(second.workDir);
  assert.equal(second.receiver.stats().active, 0);
});

test("流中断：中途 error 固定 STREAM_FAILED，不泄露原始错误文本", async (t) => {
  const payload = crypto.randomBytes(64);
  const workDirHint = "/private/secret/path";
  const body = new Readable({
    read() {
      if (this.offset === undefined) {
        this.offset = 0;
        this.push(payload.subarray(0, 16));
        this.offset = 16;
      } else {
        this.destroy(new Error(`interrupted at ${workDirHint}`));
      }
    },
  });
  const transport = makeTransport(payload, { body });
  const { receiver, workDir } = await createReceiver(t, transport);
  await assert.rejects(receiver.receive(metadataFor(payload)), (error) => {
    assert.equal(error.code, "STREAM_FAILED");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  await assertDirEmpty(workDir);
});

test("复制中上下文代际变化 → CONTEXT_CHANGED，旧身份不返回成功", async (t) => {
  const payload = crypto.randomBytes(40);
  let calls = 0;
  const transport = makeTransport(payload, { chunkSize: 8 });
  const { receiver, workDir } = await createReceiver(t, {
    ...transport,
    resolveContext: () => {
      calls += 1;
      return calls <= 2 ? "account-a/device-1/config-7" : "account-b/device-1/config-7";
    },
  });
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "CONTEXT_CHANGED");
  await assertDirEmpty(workDir);
});

test("EOF 后、成功提交前上下文变化 → CONTEXT_CHANGED", async (t) => {
  const payload = crypto.randomBytes(24);
  let ended = false;
  let index = 0;
  const chunks = splitChunks(payload, 8);
  const body = new Readable({
    read() {
      if (index < chunks.length) {
        this.push(chunks[index]);
        index += 1;
      } else {
        ended = true;
        this.push(null);
      }
    },
  });
  const transport = makeTransport(payload, { body });
  const { receiver, workDir } = await createReceiver(t, {
    ...transport,
    resolveContext: () => (ended ? "switched" : "stable"),
  });
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "CONTEXT_CHANGED");
  await assertDirEmpty(workDir);
});

test("上下文边界：Promise/拒绝 Promise/访问器 thenable/抛错/对象 均为固定错误且不触发 getter", async (t) => {
  const payload = crypto.randomBytes(8);
  const transport = makeTransport(payload);
  const cases = [];
  cases.push({ resolve: () => Promise.resolve("gen-1"), label: "native promise" });
  cases.push({ resolve: () => Promise.reject(new Error("private /secret")), label: "rejected promise" });
  let getterCalls = 0;
  cases.push({
    label: "getter thenable",
    resolve: () => ({
      get then() {
        getterCalls += 1;
        throw new Error("must not run");
      },
    }),
  });
  cases.push({ resolve: () => { throw new Error("private /secret/path"); }, label: "throw" });
  cases.push({ resolve: () => ({ generation: "gen-1" }), label: "object" });
  cases.push({ resolve: () => null, label: "null" });
  for (const entry of cases) {
    const { receiver, workDir } = await createReceiver(t, { ...transport, resolveContext: entry.resolve });
    await rejectsWithCode(receiver.receive(metadataFor(payload)), "CONTEXT_UNAVAILABLE");
    await assertDirEmpty(workDir);
  }
  assert.equal(getterCalls, 0);
  await sleep(20);
});

test("并发上限：2 个活动传输后第 3 个固定 BUSY，无排队；取消后额度释放", async (t) => {
  const payload = crypto.randomBytes(16);
  const stalled = () => new Readable({ read() {} });
  const transport = makeTransport(payload, { body: stalled() });
  const { receiver, workDir } = await createReceiver(t, transport);

  const controllerA = new AbortController();
  const controllerB = new AbortController();
  const first = rejectsWithCode(
    receiver.receive(metadataFor(payload), { signal: controllerA.signal }), "ABORTED");
  const second = rejectsWithCode(
    receiver.receive(metadataFor(payload), { signal: controllerB.signal }), "ABORTED");
  await sleep(20);
  assert.equal(receiver.stats().active, 2);
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "BUSY");
  controllerA.abort();
  controllerB.abort();
  await Promise.all([first, second]);
  assert.equal(receiver.stats().active, 0);
  await assertDirEmpty(workDir);
});

test("短写循环：句柄每次只写 1–3 字节也能写全；0 写入立即失败", async () => {
  const source = Buffer.from("0123456789abcdef", "utf8");
  const written = [];
  const handle = {
    async write(buffer, offset, length) {
      const take = Math.min(3, length);
      written.push(Buffer.from(buffer.subarray(offset, offset + take)));
      return { bytesWritten: take };
    },
  };
  await writeAllChunk(handle, source);
  assert.deepEqual(Buffer.concat(written), source);
  await assert.rejects(
    writeAllChunk({ async write() { return { bytesWritten: 0 }; } }, Buffer.from("x")),
    /progress/,
  );
  await assert.rejects(
    writeAllChunk({ async write() { return { bytesWritten: 9 }; } }, Buffer.from("xy")),
    /progress/,
  );
});

test("工作目录安全：符号链接祖先/0755/相对路径/不存在 均在构造期拒绝", async (t) => {
  const payload = crypto.randomBytes(8);
  const transport = makeTransport(payload);
  const base = await makeDir(t);
  const real = path.join(base, "real");
  await fs.mkdir(real, { mode: 0o700 });
  const link = path.join(base, "link");
  await fs.symlink(real, link);
  assert.throws(
    () => new CloudAudioReceiver({ workDir: link, openStream: transport.openStream, resolveContext: () => "g" }),
    (error) => error.code === "INVALID_REQUEST",
  );
  const open = path.join(base, "open");
  await fs.mkdir(open, { mode: 0o755 });
  await fs.chmod(open, 0o755);
  assert.throws(
    () => new CloudAudioReceiver({ workDir: open, openStream: transport.openStream, resolveContext: () => "g" }),
    (error) => error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => new CloudAudioReceiver({ workDir: "relative/dir", openStream: transport.openStream, resolveContext: () => "g" }),
    (error) => error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => new CloudAudioReceiver({ workDir: path.join(base, "missing"), openStream: transport.openStream, resolveContext: () => "g" }),
    (error) => error.code === "INVALID_REQUEST",
  );
});

test("产物路径被替换为符号链接：release 拒绝误删、进入故障态、dispose 保留归属", async (t) => {
  const payload = crypto.randomBytes(32);
  const transport = makeTransport(payload);
  const { receiver, workDir } = await createReceiver(t, transport);
  const artifact = await receiver.receive(metadataFor(payload));
  const victim = path.join(workDir, "victim.bin");
  const victimBytes = Buffer.from("victim-content");
  await fs.writeFile(victim, victimBytes, { mode: 0o600 });

  const [storedName] = (await fs.readdir(workDir)).filter((name) => name.endsWith(".part"));
  const storedPath = path.join(workDir, storedName);
  await fs.unlink(storedPath);
  await fs.symlink(victim, storedPath);

  await rejectsWithCode(receiver.release(artifact.artifactId), "CLEANUP_FAILED");
  assert.deepEqual(await fs.readFile(victim), victimBytes);
  assert.equal(receiver.stats().faulted, true);
  assert.equal(receiver.stats().orphans, 0);
  assert.equal(receiver.stats().artifacts, 1);
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "RECEIVER_FAULTED");
  await rejectsWithCode(receiver.dispose(), "CLEANUP_FAILED");
  assert.deepEqual(await fs.readFile(victim), victimBytes);

  // 人工恢复：只删除自己工作目录里被替换的链接，再 dispose 复核。
  await fs.unlink(storedPath);
  assert.equal(await receiver.dispose(), true);
  assert.equal(receiver.stats().orphans, 0);
  assert.equal(receiver.stats().artifacts, 0);
});

test("响应头访问器/非可迭代 body → RESPONSE_INVALID 且不调用 getter", async (t) => {
  const payload = crypto.randomBytes(8);
  const normal = makeTransport(payload);
  const { receiver, workDir } = await createReceiver(t, normal);
  let getter = 0;
  const headers = {};
  Object.defineProperty(headers, "Content-Type", {
    enumerable: true,
    get() {
      getter += 1;
      return MIME;
    },
  });
  Object.defineProperty(headers, "Content-Length", { enumerable: true, value: "8" });
  const badHeaderTransport = makeTransport(payload, { headers });
  const second = await createReceiver(t, badHeaderTransport);
  await rejectsWithCode(second.receiver.receive(metadataFor(payload)), "RESPONSE_INVALID");
  assert.equal(getter, 0);
  await assertDirEmpty(second.workDir);

  const badBodyTransport = makeTransport(payload, { body: { not: "a stream" } });
  const third = await createReceiver(t, badBodyTransport);
  await rejectsWithCode(third.receiver.receive(metadataFor(payload)), "RESPONSE_INVALID");
  await assertDirEmpty(third.workDir);

  // 正常接收器保持可用。
  const artifact = await receiver.receive(metadataFor(payload));
  await receiver.release(artifact.artifactId);
  await assertDirEmpty(workDir);
});

test("状态/头拒绝路径销毁实际响应体；访问器/非 Readable body 不触发伪造清理", async (t) => {
  const payload = crypto.randomBytes(32);

  // 404：body 在状态校验前已被安全拥有，拒绝时必须销毁实际传输流。
  const notFoundBody = new Readable({ read() {} });
  t.after(() => notFoundBody.destroy());
  const notFound = await createReceiver(t, makeTransport(payload, { status: 404, body: notFoundBody }));
  await rejectsWithCode(notFound.receiver.receive(metadataFor(payload)), "STATUS_REJECTED");
  assert.equal(notFoundBody.destroyed, true);
  await assertDirEmpty(notFound.workDir);

  // 200 但缺 Content-Length：头校验拒绝同样不能泄漏已打开的流。
  const badHeaderBody = new Readable({ read() {} });
  t.after(() => badHeaderBody.destroy());
  const badHeader = await createReceiver(t, makeTransport(payload, {
    headers: { "Content-Type": MIME },
    body: badHeaderBody,
  }));
  await rejectsWithCode(badHeader.receiver.receive(metadataFor(payload)), "RESPONSE_INVALID");
  assert.equal(badHeaderBody.destroyed, true);
  await assertDirEmpty(badHeader.workDir);

  // 普通对象伪造 destroy/异步迭代器：固定 RESPONSE_INVALID，绝不调用其 cleanup。
  let fakeDestroy = 0;
  let fakeIterator = 0;
  const fake = {
    destroy() {
      fakeDestroy += 1;
    },
    [Symbol.asyncIterator]() {
      fakeIterator += 1;
      return { next: async () => ({ done: true, value: undefined }) };
    },
  };
  const fakeReceiver = await createReceiver(t, makeTransport(payload, { body: fake }));
  await rejectsWithCode(fakeReceiver.receiver.receive(metadataFor(payload)), "RESPONSE_INVALID");
  assert.equal(fakeDestroy, 0);
  assert.equal(fakeIterator, 0);
  await assertDirEmpty(fakeReceiver.workDir);

  // body 访问器：不得触发 getter，也不能把 getter 返回值当作可清理资源。
  let bodyGetter = 0;
  const accessor = await createReceiver(t, {
    openStream: async () => {
      const opened = {
        status: 200,
        headers: { "Content-Type": MIME, "Content-Length": String(payload.length) },
      };
      Object.defineProperty(opened, "body", {
        enumerable: true,
        get() {
          bodyGetter += 1;
          return Readable.from([payload]);
        },
      });
      return opened;
    },
  });
  await rejectsWithCode(accessor.receiver.receive(metadataFor(payload)), "RESPONSE_INVALID");
  assert.equal(bodyGetter, 0);
  await assertDirEmpty(accessor.workDir);
});

test("最终 close 期间上下文变化 → CONTEXT_CHANGED，不登记产物且清理", async (t) => {
  const payload = crypto.randomBytes(48);
  let generation = "gen-1";
  const { receiver, workDir } = await createReceiver(t, {
    ...makeTransport(payload),
    resolveContext: () => generation,
  });
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      // 模拟发生在最后一次 await close 完成时的身份切换。
      generation = "gen-2";
    };
    return handle;
  };
  try {
    await rejectsWithCode(receiver.receive(metadataFor(payload)), "CONTEXT_CHANGED");
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(receiver.stats().artifacts, 0);
  await assertDirEmpty(workDir);
});

test("最终 close 期间调用方取消 → ABORTED，不登记产物且清理", async (t) => {
  const payload = crypto.randomBytes(48);
  const controller = new AbortController();
  const { receiver, workDir } = await createReceiver(t, makeTransport(payload));
  const originalOpen = fs.open;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      controller.abort();
    };
    return handle;
  };
  try {
    await rejectsWithCode(
      receiver.receive(metadataFor(payload), { signal: controller.signal }), "ABORTED");
  } finally {
    fs.open = originalOpen;
  }
  assert.equal(receiver.stats().artifacts, 0);
  assert.equal(receiver.stats().active, 0);
  await assertDirEmpty(workDir);
});

test("元数据：非法 UUID/长度/摘要/类型/未知字段（URL、文件名）全部拒绝", async (t) => {
  const payload = crypto.randomBytes(8);
  const transport = makeTransport(payload);
  const { receiver } = await createReceiver(t, transport);
  const bad = [
    [metadataFor(payload, { audioId: "not-a-uuid" }), "INVALID_METADATA"],
    [metadataFor(payload, { bytes: 0 }), "INVALID_METADATA"],
    [metadataFor(payload, { bytes: MAX_AUDIO_BYTES + 1 }), "INVALID_METADATA"],
    [metadataFor(payload, { bytes: 8.5 }), "INVALID_METADATA"],
    [metadataFor(payload, { sha256: "abc" }), "INVALID_METADATA"],
    [metadataFor(payload, { mimeType: "audio/" }), "INVALID_METADATA"],
    [metadataFor(payload, { mimeType: "text/plain" }), "UNSUPPORTED_MIME"],
    [{ ...metadataFor(payload), url: "https://private.example/x" }, "INVALID_METADATA"],
    [{ ...metadataFor(payload), fileName: "../escape.wav" }, "INVALID_METADATA"],
    [null, "INVALID_METADATA"],
    ["metadata", "INVALID_METADATA"],
  ];
  for (const [metadata, code] of bad) {
    await rejectsWithCode(receiver.receive(metadata), code);
  }
  assert.equal(transport.calls.length, 0);

  const unknownMime = metadataFor(payload, { mimeType: "audio/ogg" });
  await rejectsWithCode(receiver.receive(unknownMime), "MIME_MISMATCH");
});

test("openStream 只收到小写 UUID 与 AbortSignal，超时会中止该 signal", async (t) => {
  const payload = crypto.randomBytes(8);
  let captured;
  const transport = makeTransport(payload, {
    onOpen: ({ audioId, signal }) => {
      captured = { audioId, signal };
    },
  });
  const { receiver, workDir } = await createReceiver(t, transport);
  const artifact = await receiver.receive(metadataFor(payload, { audioId: AUDIO_ID.toUpperCase() }));
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].argumentCount, 2);
  assert.equal(captured.audioId, AUDIO_ID);
  assert.ok(captured.signal instanceof AbortSignal);
  assert.equal(captured.signal.aborted, false);
  await receiver.release(artifact.artifactId);
  await assertDirEmpty(workDir);

  let timeoutSignal;
  const stalled = new Readable({ read() {} });
  const timeoutTransport = makeTransport(payload, {
    body: stalled,
    onOpen: ({ signal }) => {
      timeoutSignal = signal;
    },
  });
  const second = await createReceiver(t, { ...timeoutTransport, idleTimeoutMs: 40 });
  await rejectsWithCode(second.receiver.receive(metadataFor(payload)), "IDLE_TIMEOUT");
  assert.equal(timeoutSignal.aborted, true);
});

test("dispose 中止活动下载、释放产物，之后拒绝新请求且幂等", async (t) => {
  const payload = crypto.randomBytes(24);
  const transport = makeTransport(payload);
  const { receiver, workDir } = await createReceiver(t, transport);
  const artifact = await receiver.receive(metadataFor(payload));
  assert.equal(receiver.stats().artifacts, 1);
  assert.equal(await receiver.dispose(), true);
  assert.equal(receiver.stats().disposed, true);
  assert.equal(receiver.stats().artifacts, 0);
  await assertDirEmpty(workDir);
  assert.equal(await receiver.dispose(), true);
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "ALREADY_DISPOSED");
});

test("release 参数边界：非字符串拒绝，未知 id 幂等返回 false", async (t) => {
  const payload = crypto.randomBytes(8);
  const { receiver } = await createReceiver(t, makeTransport(payload));
  await rejectsWithCode(receiver.release(null), "INVALID_REQUEST");
  await rejectsWithCode(receiver.release(""), "INVALID_REQUEST");
  assert.equal(await receiver.release("f".repeat(32)), false);
});

test("失败清理本身失败：CLEANUP_FAILED、保留归属、进入故障态，恢复后可 dispose", async (t) => {
  const payload = crypto.randomBytes(64);
  const transport = makeTransport(payload, { body: makeBody(payload, { chunkSize: 8, delayMs: 15 }) });
  const { receiver, workDir } = await createReceiver(t, transport);
  const failing = rejectsWithCode(
    receiver.receive(metadataFor(payload, { sha256: "0".repeat(64) })), "CLEANUP_FAILED");
  // 等到临时文件确实创建后再收紧目录权限，确保失败路径的 unlink 真正失败。
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await fs.readdir(workDir)).length > 0) break;
    await sleep(5);
  }
  await fs.chmod(workDir, 0o500);
  try {
    await failing;
  } finally {
    await fs.chmod(workDir, 0o700);
  }
  assert.equal(receiver.stats().faulted, true);
  assert.equal(receiver.stats().orphans, 1);
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "RECEIVER_FAULTED");
  assert.equal(await receiver.dispose(), true);
  assert.equal(receiver.stats().orphans, 0);
  await assertDirEmpty(workDir);
});

test("dispose 中止活动下载：等待其按 ABORTED 收尾并清理，不挂起", async (t) => {
  const payload = crypto.randomBytes(32);
  const stalled = new Readable({ read() {} });
  const transport = makeTransport(payload, { body: stalled });
  const { receiver, workDir } = await createReceiver(t, transport);
  const pending = rejectsWithCode(receiver.receive(metadataFor(payload)), "ABORTED");
  await sleep(20);
  assert.equal(receiver.stats().active, 1);
  const started = Date.now();
  assert.equal(await receiver.dispose(), true);
  assert.ok(Date.now() - started < 1000);
  await pending;
  assert.equal(receiver.stats().active, 0);
  await assertDirEmpty(workDir);
});

test("openStream 迟到响应在取消后单独销毁，不成为活动流", async (t) => {
  const payload = crypto.randomBytes(16);
  let lateBody = null;
  const { receiver, workDir } = await createReceiver(t, {
    idleTimeoutMs: 40,
    openStream: async () => {
      await sleep(90);
      const { PassThrough } = await import("node:stream");
      lateBody = new PassThrough();
      return {
        status: 200,
        headers: { "Content-Type": MIME, "Content-Length": "16" },
        body: lateBody,
      };
    },
  });
  await rejectsWithCode(receiver.receive(metadataFor(payload)), "IDLE_TIMEOUT");
  await sleep(120);
  assert.ok(lateBody !== null);
  assert.equal(lateBody.destroyed, true);
  await assertDirEmpty(workDir);
});

test("失败路径不产生 unhandledRejection，错误与统计不泄露路径/原始文本", async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.removeListener("unhandledRejection", onUnhandled));

  const payload = crypto.randomBytes(24);
  const secretPath = "/private/secret/account-token";
  const scenarios = [
    {
      transport: makeTransport(payload, {
        body: new Readable({
          read() {
            this.destroy(new Error(secretPath));
          },
        }),
      }),
      code: "STREAM_FAILED",
    },
    {
      transport: makeTransport(payload),
      code: "CONTEXT_UNAVAILABLE",
      resolveContext: () => Promise.reject(new Error(secretPath)),
    },
    {
      transport: { openStream: async () => { throw new Error(secretPath); } },
      code: "TRANSPORT_FAILED",
    },
    {
      transport: makeTransport(payload),
      code: "CONTEXT_UNAVAILABLE",
      resolveContext: () => ({
        get then() {
          throw new Error(secretPath);
        },
      }),
    },
  ];
  for (const scenario of scenarios) {
    const { receiver, workDir } = await createReceiver(t, {
      ...scenario.transport,
      ...(scenario.resolveContext ? { resolveContext: scenario.resolveContext } : {}),
    });
    await assert.rejects(receiver.receive(metadataFor(payload)), (error) => {
      assert.equal(error.code, scenario.code);
      assert.equal(error.message.includes(secretPath), false);
      assert.equal(error.message.includes(workDir), false);
      assert.equal(error.message.includes("account-token"), false);
      return true;
    });
    const statsText = JSON.stringify(receiver.stats());
    assert.equal(statsText.includes(workDir), false);
    assert.equal(statsText.includes(secretPath), false);
    await assertDirEmpty(workDir);
  }
  await sleep(60);
  assert.deepEqual(unhandled, []);
});
