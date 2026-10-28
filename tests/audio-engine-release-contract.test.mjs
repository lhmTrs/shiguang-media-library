/**
 * MUSIC-RELEASE-CONTRACT-INTEGRATION-01-20261027
 *
 * 真实 AudioEngine 的“声明合同接入”定向测试：
 * - 原 archive-only 发布描述继续走原安全路径，事实为 LEGACY_MEMBER_METADATA_UNAVAILABLE；
 * - 只有调用方显式提供 release.members 的受控发布才解析 v0 legacy 单成员声明；
 * - 外部 pin 只能经独立 memberExpectation 传入，缺失只解析、不声称 matches；
 * - v1 多成员/未知 format 在构造或后赋消费入口、任何 FS/锁/网络/Agent 动作前拒绝；
 * - 全部使用临时目录、本地回环 TLS、合成归档；不下载真实引擎、不执行所装文件、
 *   不访问真实素材/库、不部署/提交/推送。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { AudioEngine } from "../server/audio-engine.mjs";
import { parseReleaseMembers } from "../server/audio-release-members.mjs";
import { exists, makeRelease, makeTar, sha256, waitForJob } from "./audio-engine-fixtures.mjs";

// 本轮安全修订：不再调用共享 fixtures 的 tempDir/makeTlsFixture/startTlsServer。
// 它们会向 node:test 注册 t.after 递归删除（tempDir/makeTlsFixture），本轮改为
// 本文件自有临时根，全部 RETAIN_ALL 登记且不删除；只关闭本测试自己打开的 TLS
// server 与 engine。makeTar/makeRelease/sha256/waitForJob/exists 为无清理注册的
// 纯/只读 helper，保留复用。
const RETAIN_ALL = [];
const CLOSE_TIMEOUT_MS = 5000;
const run = promisify(execFile);

async function ownTempDir(prefix = "shiguang-release-contract-") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  RETAIN_ALL.push(dir);
  return dir;
}

/** 自有 TLS 夹具：只写本测试独占临时根，退出不删除（RETAIN_ALL）。 */
async function ownTlsFixture() {
  const dir = await ownTempDir("shiguang-release-contract-tls-");
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  const configPath = path.join(dir, "openssl.cnf");
  await fs.writeFile(
    configPath,
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=v3",
      "prompt=no",
      "[dn]",
      "CN=127.0.0.1",
      "[v3]",
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=CA:TRUE",
      "keyUsage=digitalSignature,keyEncipherment,keyCertSign",
      "",
    ].join("\n"),
  );
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-config",
    configPath,
  ]);
  return {
    dir,
    key: await fs.readFile(keyPath),
    cert: await fs.readFile(certPath),
    ca: await fs.readFile(certPath),
  };
}

/** 自有回环 TLS server；after 只关已知 server，有界等待实际 close，不删任何根。 */
async function ownStartTlsServer(t, tls, handler) {
  const counts = { connections: 0, handshakes: 0, requests: 0 };
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    counts.requests += 1;
    Promise.resolve(handler(req, res, counts)).catch(() => {
      try {
        res.destroy();
      } catch {}
    });
  });
  server.on("connection", () => {
    counts.connections += 1;
  });
  server.on("secureConnection", () => {
    counts.handshakes += 1;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections?.();
    let timer;
    try {
      await Promise.race([
        new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`TLS server close 超过 ${CLOSE_TIMEOUT_MS}ms，保留现场`)),
            CLOSE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  return {
    server,
    counts,
    url: `https://127.0.0.1:${server.address().port}/engine.tar.gz`,
  };
}

after(() => {
  console.log(`RETAIN_ALL count=${RETAIN_ALL.length}`);
  for (const dir of RETAIN_ALL) console.log(`RETAIN_ALL ${dir}`);
});

const BINARY = Buffer.from("#!/bin/sh\necho release-contract-fixture\n", "utf8");
const BINARY_SHA = sha256(BINARY);

function v0Declaration(release, overrides = {}) {
  return {
    schema: "audio-release-members",
    schemaVersion: 0,
    release: { version: release.version, platform: "darwin", arch: "arm64" },
    archive: { format: "tar.gz", bytes: release.size, sha256: release.sha256 },
    members: [
      {
        path: "audio-analyze",
        type: "file",
        mode: "0755",
        bytes: BINARY.length,
        sha256: BINARY_SHA,
      },
    ],
    totalMemberBytes: BINARY.length,
    ...overrides,
  };
}

function v1Declaration(release) {
  return {
    schema: "audio-release-members",
    schemaVersion: 1,
    release: { version: release.version, platform: "darwin", arch: "arm64" },
    archive: { format: "tar.gz", bytes: release.size, sha256: release.sha256 },
    members: [
      {
        path: "audio-analyze",
        type: "file",
        mode: "0755",
        bytes: BINARY.length,
        sha256: BINARY_SHA,
      },
      {
        path: "lib/fixture.dylib",
        type: "file",
        mode: "0644",
        bytes: 64,
        sha256: "b".repeat(64),
      },
    ],
    totalMemberBytes: BINARY.length + 64,
  };
}

function externalExpectation(release, overrides = {}) {
  return {
    archiveSha256: release.sha256,
    archiveBytes: release.size,
    releaseVersion: release.version,
    members: [{ path: "audio-analyze", bytes: BINARY.length, sha256: BINARY_SHA }],
    ...overrides,
  };
}

async function setup(t, overrides = {}) {
  const root = await ownTempDir("shiguang-release-contract-");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const tls = await ownTlsFixture();
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY, mode: 0o755 }]);
  const server = await ownStartTlsServer(t, tls, async (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    res.end(archive);
  });
  const release = makeRelease(archive, server.url, overrides.release);
  const engine = new AudioEngine(dataDir, {
    release,
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    idleTimeoutMs: overrides.idleTimeoutMs ?? 1000,
    totalTimeoutMs: overrides.totalTimeoutMs ?? 5000,
    diskFreeBytes: overrides.diskFreeBytes ?? 1024 * 1024 * 1024,
    memberExpectation: overrides.memberExpectation,
    hooks: overrides.hooks,
  });
  t.after(() => engine.dispose());
  return { root, dataDir, tls, server, archive, release, engine };
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, error && error.stack);
    return true;
  });
}

test("archive-only 发布描述保留原路径，事实为 LEGACY_MEMBER_METADATA_UNAVAILABLE", async (t) => {
  const { engine, server } = await setup(t);
  const contract = engine.releaseContract;
  assert.equal(contract.mode, "archive-only");
  assert.equal(contract.memberMetadata, "LEGACY_MEMBER_METADATA_UNAVAILABLE");
  assert.equal(contract.declarationParsed, false);
  assert.equal(contract.externalPinProvided, false);
  assert.equal(contract.archiveSha256Matched, null);
  assert.equal(contract.membersMatched, null);
  assert.equal(contract.contentVerified, false);
  assert.equal(contract.publisherAuthenticated, false);
  assert.equal(contract.runtimeIdentityVerified, false);
  assert.equal(contract.trusted, false);
  assert.equal(Object.isFrozen(contract), true);

  const status = engine.status();
  assert.equal(status.releaseContract.memberMetadata, "LEGACY_MEMBER_METADATA_UNAVAILABLE");
  assert.equal(status.releaseContract.declarationParsed, false);
  assert.equal(server.counts.requests, 0);
});

test("显式 v0 单成员声明可解析；未给独立外部 pin 时只解析、不声称 matches", async (t) => {
  const { engine, release } = await setup(t, { release: {} });
  engine.release = { ...release, members: v0Declaration(release) };
  const contract = engine.releaseContract;
  assert.equal(contract.mode, "declared-single-member");
  assert.equal(contract.memberMetadata, "DECLARED");
  assert.equal(contract.declarationParsed, true);
  assert.equal(contract.declarationOnly, true);
  assert.equal(contract.compatibility, "legacy-single-member");
  assert.equal(contract.schemaVersion, 0);
  assert.equal(contract.memberCount, 1);
  assert.equal(contract.externalPinProvided, false);
  assert.equal(contract.externalPinSource, null);
  assert.equal(contract.declarationMatchesExternal, null);
  assert.equal(contract.membersMatched, null);
  assert.equal(contract.contentVerified, false);
  assert.equal(contract.trusted, false);
});

test("独立 memberExpectation 匹配时只确认声明元数据，绝不升级 content/trusted", async (t) => {
  const { release } = await setup(t, { release: {} });
  const tls = await ownTlsFixture();
  const dataDir = await ownTempDir("shiguang-release-contract-");
  const engine = new AudioEngine(dataDir, {
    release: { ...release, members: v0Declaration(release) },
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    memberExpectation: externalExpectation(release),
  });
  t.after(() => engine.dispose());
  const contract = engine.releaseContract;
  assert.equal(contract.externalPinProvided, true);
  assert.equal(contract.externalPinSource, "caller");
  assert.equal(contract.archiveSha256Matched, true);
  assert.equal(contract.archiveBytesMatched, true);
  assert.equal(contract.releaseVersionMatched, true);
  assert.equal(contract.membersMatched, true);
  assert.equal(contract.declarationMatchesExternal, true);
  assert.equal(contract.contentVerified, false);
  assert.equal(contract.publisherAuthenticated, false);
  assert.equal(contract.runtimeIdentityVerified, false);
  assert.equal(contract.trusted, false);
});

test("外部期望不匹配/缺失/只给 archive pin/直接复用声明都在构造期拒绝，且不读 CA", async (t) => {
  const { release, tls } = await setup(t, { release: {} });
  const dataDir = await ownTempDir("shiguang-release-contract-");
  const declaration = v0Declaration(release);
  const originalRead = fssync.readFileSync;
  let reads = 0;
  fssync.readFileSync = function patchedReadFileSync(...args) {
    reads += 1;
    return originalRead.apply(this, args);
  };
  try {
    expectCode(
      () =>
        new AudioEngine(dataDir, {
          release: { ...release, members: declaration },
          platform: "darwin",
          arch: "arm64",
          memberExpectation: externalExpectation(release, {
            members: [{ path: "audio-analyze", sha256: "c".repeat(64) }],
          }),
        }),
      "ENGINE_RELEASE_EXPECTATION_MISMATCH",
    );
    expectCode(
      () =>
        new AudioEngine(dataDir, {
          release: { ...release, members: declaration },
          platform: "darwin",
          arch: "arm64",
          memberExpectation: { archiveBytes: release.size },
        }),
      "ENGINE_RELEASE_EXPECTATION_INVALID",
    );
    expectCode(
      () =>
        new AudioEngine(dataDir, {
          release: { ...release, members: declaration },
          platform: "darwin",
          arch: "arm64",
          memberExpectation: { archiveSha256: release.sha256 },
        }),
      "ENGINE_RELEASE_EXPECTATION_INVALID",
    );
    expectCode(
      () =>
        new AudioEngine(dataDir, {
          release: { ...release, members: declaration },
          platform: "darwin",
          arch: "arm64",
          memberExpectation: declaration,
        }),
      "ENGINE_RELEASE_EXPECTATION_INVALID",
    );
  } finally {
    fssync.readFileSync = originalRead;
  }
  assert.equal(reads, 0, "声明门必须先于默认 CA 读取");
  assert.equal(exists(path.join(dataDir, "engines")), false);
  // 仅确认 TLS 夹具本身可用；未发起安装/请求。
  assert.ok(tls.ca.length > 0);
});

test("archive-only 不能借归档 identity 伪造外部成员 pin", async (t) => {
  const { release, tls } = await setup(t, { release: {} });
  const dataDir = await ownTempDir("shiguang-release-contract-");
  expectCode(
    () =>
      new AudioEngine(dataDir, {
        release,
        ca: tls.ca,
        platform: "darwin",
        arch: "arm64",
        memberExpectation: { archiveSha256: release.sha256 },
      }),
    "ENGINE_RELEASE_EXPECTATION_INVALID",
  );
});

test("v1 多成员与未知 format 在构造/后赋消费入口都被明确拒绝", async (t) => {
  const { dataDir, release, engine } = await setup(t, { release: {} });
  const tls = await ownTlsFixture();
  const originalRead = fssync.readFileSync;
  let reads = 0;
  fssync.readFileSync = function patchedReadFileSync(...args) {
    reads += 1;
    return originalRead.apply(this, args);
  };
  try {
    expectCode(
      () =>
        new AudioEngine(dataDir, {
          release: { ...release, members: v1Declaration(release) },
          platform: "darwin",
          arch: "arm64",
        }),
      "ENGINE_RELEASE_DECLARATION_UNSUPPORTED",
    );
    expectCode(
      () =>
        new AudioEngine(dataDir, {
          release: { ...release, format: "zip" },
          platform: "darwin",
          arch: "arm64",
        }),
      "ENGINE_RELEASE_DECLARATION_UNSUPPORTED",
    );
    expectCode(
      () =>
        new AudioEngine(dataDir, {
          release: { ...release, members: v0Declaration(release, { schemaVersion: 2 }) },
          platform: "darwin",
          arch: "arm64",
        }),
      "ENGINE_RELEASE_DECLARATION_UNSUPPORTED",
    );
  } finally {
    fssync.readFileSync = originalRead;
  }
  assert.equal(reads, 0, "multi/unknown 必须在 CA 读取前拒绝");
  assert.ok(tls.ca.length > 0);

  // 后赋同样过消费门：install/run/lifecycle/status 在 FS/锁/网络前拒绝。
  engine.release = { ...release, members: v1Declaration(release) };
  expectCode(() => engine.install({ confirm: true }), "ENGINE_RELEASE_DECLARATION_UNSUPPORTED");
  expectCode(() => engine.status(), "ENGINE_RELEASE_DECLARATION_UNSUPPORTED");
  await assert.rejects(
    engine.withRunLease(async () => {}),
    (error) => error.code === "ENGINE_RELEASE_DECLARATION_UNSUPPORTED",
  );
  await assert.rejects(
    engine.withLifecycleScope(async () => {}, { scope: "probe", deadlineAtMs: Date.now() + 1000 }),
    (error) => error.code === "ENGINE_RELEASE_DECLARATION_UNSUPPORTED",
  );
  assert.equal(exists(path.join(dataDir, "engines")), false, "拒绝前不得创建/读取安装目录");
  assert.equal(exists(path.join(dataDir, "engines", ".audio-install.lock")), false);
});

test("后赋未知 format 的 uninstall 在删除前拒绝", async (t) => {
  const { dataDir, release, engine } = await setup(t, { release: {} });
  const sentinel = path.join(dataDir, "engines", "audio", "sentinel.txt");
  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, "keep", "utf8");
  engine.release = { ...release, format: "zip" };
  await assert.rejects(
    engine.uninstall(),
    (error) => error.code === "ENGINE_RELEASE_DECLARATION_UNSUPPORTED",
  );
  assert.equal(exists(sentinel), true, "声明门拒绝时不得删除任何安装内容");
});

test("后赋 v0 单成员声明的受控发布可继续走原安装安全路径", async (t) => {
  const { dataDir, release, engine, server } = await setup(t, { release: {} });
  engine.release = { ...release, members: v0Declaration(release) };
  const started = engine.install({ confirm: true });
  assert.equal(started.job.state, "queued");
  const status = await waitForJob(engine);
  assert.equal(status.job.state, "installed", JSON.stringify(status));
  assert.equal(status.installed, true);
  assert.equal(status.version, release.version);
  assert.equal(status.releaseContract.declarationParsed, true);
  assert.equal(status.releaseContract.membersMatched, null);
  assert.equal(status.releaseContract.contentVerified, false);
  assert.equal(server.counts.requests, 1);

  const pointer = JSON.parse(
    await fs.readFile(path.join(dataDir, "engines", "audio", "current.json"), "utf8"),
  );
  const installed = await fs.readFile(
    path.join(dataDir, "engines", "audio", "versions", pointer.dir, "audio-analyze"),
  );
  assert.deepEqual(installed, BINARY);
  assert.equal(exists(path.join(dataDir, "engines", ".audio-install.lock")), false);
});

test("未知扩展键保持兼容；format=tar.gz 无 members 仍是 archive-only", async (t) => {
  const { engine } = await setup(t, {
    release: { customInjectionKey: "kept", format: "tar.gz" },
  });
  assert.equal(engine.release.customInjectionKey, "kept");
  assert.equal(engine.release.format, "tar.gz");
  assert.equal(engine.releaseContract.mode, "archive-only");
  assert.equal(engine.releaseContract.memberMetadata, "LEGACY_MEMBER_METADATA_UNAVAILABLE");
});

test("后赋声明不能绕过构造期固定的外部期望", async (t) => {
  const root = await ownTempDir("shiguang-release-contract-");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const tls = await ownTlsFixture();
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY, mode: 0o755 }]);
  const server = await ownStartTlsServer(t, tls, async (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    res.end(archive);
  });
  const release = makeRelease(archive, server.url);
  const engine = new AudioEngine(dataDir, {
    release: { ...release, members: v0Declaration(release) },
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    memberExpectation: externalExpectation(release),
  });
  t.after(() => engine.dispose());
  const changed = v0Declaration(release, {
    members: [
      {
        path: "audio-analyze",
        type: "file",
        mode: "0755",
        bytes: BINARY.length,
        sha256: "d".repeat(64),
      },
    ],
  });
  engine.release = { ...release, members: changed };
  expectCode(() => engine.install({ confirm: true }), "ENGINE_RELEASE_EXPECTATION_MISMATCH");
  await assert.rejects(
    engine.withRunLease(async () => {}),
    (error) => error.code === "ENGINE_RELEASE_EXPECTATION_MISMATCH",
  );
  assert.equal(server.counts.requests, 0);
  assert.equal(exists(path.join(dataDir, "engines")), false);
});

test("构造后修改调用方期望对象不能改变已冻结的成员 pin", async (t) => {
  const root = await ownTempDir("shiguang-release-contract-");
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const tls = await ownTlsFixture();
  const archive = await makeTar([{ name: "audio-analyze", data: BINARY, mode: 0o755 }]);
  const server = await ownStartTlsServer(t, tls, async (_req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.length });
    res.end(archive);
  });
  const release = makeRelease(archive, server.url);
  const expectation = externalExpectation(release);
  const engine = new AudioEngine(dataDir, {
    release: { ...release, members: v0Declaration(release) },
    ca: tls.ca,
    platform: "darwin",
    arch: "arm64",
    memberExpectation: expectation,
  });
  t.after(() => engine.dispose());
  expectation.members[0].sha256 = "d".repeat(64);
  engine.release = {
    ...release,
    members: v0Declaration(release, {
      members: [
        {
          path: "audio-analyze",
          type: "file",
          mode: "0755",
          bytes: BINARY.length,
          sha256: "d".repeat(64),
        },
      ],
    }),
  };
  expectCode(() => engine.install({ confirm: true }), "ENGINE_RELEASE_EXPECTATION_MISMATCH");
  assert.equal(server.counts.requests, 0);
  assert.equal(exists(path.join(dataDir, "engines")), false);
});

test("坏声明只返回固定码，不回显调用方 marker", async (t) => {
  const { release, tls } = await setup(t, { release: {} });
  const dataDir = await ownTempDir("shiguang-release-contract-");
  const marker = "PRIVATE-MARKER-SHOULD-NOT-LEAK";
  let error = null;
  try {
    new AudioEngine(dataDir, {
      release: {
        ...release,
        members: v0Declaration(release, {
          members: [
            {
              path: `../${marker}`,
              type: "file",
              mode: "0755",
              bytes: BINARY.length,
              sha256: BINARY_SHA,
            },
          ],
        }),
      },
      ca: tls.ca,
      platform: "darwin",
      arch: "arm64",
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.equal(error.code, "ENGINE_RELEASE_DECLARATION_INVALID");
  assert.equal(String(error.message).includes(marker), false);
  assert.equal(String(error.stack).includes(marker), false);
  assert.equal(error.cause, undefined);
});

// round3 P2-1：safeRelease 浅合并后，members 也必须固定为私有不可变快照；
// 构造完成后再改调用方原声明对象，不能改变 engine.release 的有效描述或缓存事实。
test("P2-1 构造后修改原声明对象不能改变已固定的成员声明快照", async (t) => {
  const { release, engine } = await setup(t, { release: {} });
  const declaration = v0Declaration(release);
  engine.release = { ...release, members: declaration };

  const before = engine.releaseContract;
  assert.equal(before.schemaVersion, 0);
  assert.equal(before.memberCount, 1);
  assert.equal(Object.isFrozen(engine.release.members), true);

  declaration.schemaVersion = 1;
  declaration.members.push({
    path: "lib/other",
    type: "file",
    mode: "0644",
    bytes: 1,
    sha256: "c".repeat(64),
  });
  declaration.members[0].sha256 = "d".repeat(64);
  declaration.totalMemberBytes = BINARY.length + 1;

  const after = engine.status();
  assert.equal(after.releaseContract.schemaVersion, 0);
  assert.equal(after.releaseContract.memberCount, 1);
  assert.equal(engine.release.members.schemaVersion, 0);
  assert.equal(engine.release.members.members.length, 1);
  assert.equal(engine.release.members.members[0].sha256, BINARY_SHA);
  assert.equal(Object.isFrozen(engine.release.members), true);
  assert.equal(Object.isFrozen(engine.release.members.members[0]), true);
});

// round3 P2-2：声明 + 自洽外部期望描述的是另一个工件时，必须在任何成功事实或
// 副作用前绑定实际 safeRelease 的 version/platform/arch/size/sha256/binary。
test("P2-2 声明未绑定实际发布身份时按声明无效拒绝，自洽外部期望也不例外", async (t) => {
  const { release, dataDir, tls } = await setup(t, { release: {} });
  const dataDirOther = await ownTempDir("shiguang-release-contract-");
  const mismatched = v0Declaration(release, {
    release: { version: "different-version", platform: "darwin", arch: "arm64" },
    archive: { format: "tar.gz", bytes: release.size + 1, sha256: "d".repeat(64) },
  });
  const selfConsistentExpectation = externalExpectation(mismatched);

  const attempts = [
    // 完全复现独立反例：声明与外部期望互相自洽，但与实际 release 不同。
    { release: { ...release, members: mismatched }, memberExpectation: selfConsistentExpectation },
    // 单项绑定失败：version / archive bytes / archive sha256 / binary。
    { release: { ...release, version: "9.9.9", members: v0Declaration(release) } },
    { release: { ...release, size: release.size + 1, members: v0Declaration(release) } },
    { release: { ...release, sha256: "d".repeat(64), members: v0Declaration(release) } },
    { release: { ...release, binary: "other-bin", members: v0Declaration(release) } },
  ];
  for (const attempt of attempts) {
    expectCode(
      () =>
        new AudioEngine(dataDirOther, {
          ...attempt,
          ca: tls.ca,
          platform: "darwin",
          arch: "arm64",
        }),
      "ENGINE_RELEASE_DECLARATION_INVALID",
    );
  }
  assert.equal(exists(path.join(dataDir, "engines")), false);
  assert.equal(exists(path.join(dataDirOther, "engines")), false);
});

// round4 输入归一化：私有快照只能收紧结构，不能把原严格成员合同应拒绝的字段
// “清洗”掉。object symbol / 数组额外 enumerable 属性 / 数组 hidden 属性三类原始
// 输入必须仍由 parser 与引擎按 ENGINE_RELEASE_DECLARATION_INVALID 拒绝。
for (const [variant, mutate] of [
  [
    "object-symbol",
    (declaration) => {
      declaration[Symbol("unsupported")] = 1;
    },
  ],
  [
    "array-extra",
    (declaration) => {
      Object.defineProperty(declaration.members, "unsupported", { value: 1, enumerable: true });
    },
  ],
  [
    "array-hidden",
    (declaration) => {
      Object.defineProperty(declaration.members, "unsupported", { value: 1, enumerable: false });
    },
  ],
]) {
  test(`round4 原始成员声明 ${variant} 仍按声明无效拒绝`, async () => {
    const root = await ownTempDir("shiguang-release-contract-import-");
    const release = makeRelease(Buffer.from("not-contacted"), "https://127.0.0.1:1/not-contacted");
    const declaration = v0Declaration(release);
    mutate(declaration);
    const direct = parseReleaseMembers(declaration);
    assert.equal(direct.ok, false, "原严格 parser 必须拒绝");
    let error;
    try {
      new AudioEngine(root, {
        release: { ...release, members: declaration },
        ca: Buffer.from(""),
        platform: "darwin",
        arch: "arm64",
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, "引擎必须拒绝");
    assert.equal(error.code, "ENGINE_RELEASE_DECLARATION_INVALID");
    assert.equal(exists(path.join(root, "engines")), false);
  });
}
