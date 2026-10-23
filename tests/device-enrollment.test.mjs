/**
 * T-LOCAL-007：内置发行配置 + 本机自动开通（隔离 HTTPS/mTLS mock）。
 *
 * 全部使用一次性 CA/证书、本机随机端口、临时 MEDIA_DATA_DIR；不连正式云端、
 * 不建正式账户、不碰真实素材/库/系统信任。
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Library } from "../server/library.mjs";
import { CloudAuth } from "../server/cloud-auth.mjs";
import { DeviceEnrollment, parseCertificateChain, verifyEnrolledCertificate } from "../server/device-enrollment.mjs";
import { validateReleaseConfig } from "../server/cloud-release-config.mjs";
import { startEnrollmentMock } from "./device-enrollment-mock.mjs";

const run = promisify(execFile);
const PASSWORD = "correct horse battery staple";
const CODE = "A".repeat(43);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeForeignCa() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-foreign-ca-"));
  const key = path.join(dir, "ca.key");
  const crt = path.join(dir, "ca.crt");
  await run("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-keyout", key, "-out", crt, "-days", "2", "-subj", "/CN=Foreign Test CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
  ]);
  const pem = await fs.readFile(crt, "utf8");
  return { dir, pem, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

function releaseFor(mock, patch = {}) {
  const checked = validateReleaseConfig({
    schemaVersion: 1,
    enabled: true,
    apiOrigin: mock.apiOrigin,
    enrollmentOrigin: mock.enrollmentOrigin,
    serverCaPem: mock.serverCaPem,
    deviceCaPem: mock.deviceCaPem,
    ...patch,
  });
  assert.deepEqual(checked.errors, []);
  assert.equal(checked.usable, true);
  return { ...checked.config, usable: checked.usable, errors: checked.errors, warnings: checked.warnings };
}

async function newInstance(t, mock, { releasePatch = {}, timeoutMs, clock } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-enroll-")));
  const lib = await new Library(path.join(base, "data")).init();
  let now = clock || Date.now();
  const auth = await new CloudAuth(lib, {
    dataDir: lib.dataDir,
    clock: () => now,
    ...(timeoutMs ? { timeoutMs } : {}),
  }).init();
  const enrollment = await new DeviceEnrollment(lib, {
    dataDir: lib.dataDir,
    cloudAuth: auth,
    release: releaseFor(mock, releasePatch),
    clock: () => now,
    ...(timeoutMs ? { timeoutMs } : {}),
  }).init();
  t.after(async () => {
    lib.db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, lib, auth, enrollment, advance: (ms) => (now += ms) };
}

async function setup(t, options) {
  const mock = await startEnrollmentMock(options?.mock);
  t.after(() => mock.close());
  const instance = await newInstance(t, mock, options);
  return { mock, ...instance };
}

const statusText = (value) => JSON.stringify(value);

test("发行配置：默认关闭，拒绝私钥与带路径的 origin", async () => {
  const off = validateReleaseConfig({ schemaVersion: 1, enabled: false, apiOrigin: "", enrollmentOrigin: "", serverCaPem: "", deviceCaPem: "" });
  assert.deepEqual(off.errors, []);
  assert.equal(off.usable, false);

  const privateKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  const withKey = validateReleaseConfig({ schemaVersion: 1, enabled: true, apiOrigin: "https://a.example", enrollmentOrigin: "https://b.example", serverCaPem: privateKey, deviceCaPem: privateKey });
  assert.ok(withKey.errors.some((e) => /私钥/.test(e)));

  const badOrigin = validateReleaseConfig({
    schemaVersion: 1,
    enabled: true,
    apiOrigin: "https://a.example/path",
    enrollmentOrigin: "https://b.example",
    serverCaPem: "",
    deviceCaPem: "",
  });
  assert.ok(badOrigin.errors.some((e) => /路径/.test(e)));
});

test("首次开通：独立 RSA3072 密钥、证书落盘 0600、激活并登录，浏览器状态不含密钥/开通码", async (t) => {
  const { mock, auth, enrollment } = await setup(t);
  const result = await enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" });
  assert.equal(result.enrolled, true);
  assert.equal(result.session, true);
  assert.equal(result.state.state, "logged-in");
  assert.equal(result.state.username, "alice");
  assert.equal(result.state.hasClientCertificate, true);

  const dirStat = await fs.stat(enrollment.deviceDir);
  assert.equal(dirStat.mode & 0o777, 0o700);
  const keyStat = await fs.stat(enrollment.keyPath);
  assert.equal(keyStat.mode & 0o777, 0o600);
  const metaStat = await fs.stat(enrollment.metadataPath);
  assert.equal(metaStat.mode & 0o777, 0o600);

  const keyPem = await fs.readFile(enrollment.keyPath, "utf8");
  const certPem = await fs.readFile(enrollment.certPath, "utf8");
  const leaf = parseCertificateChain(certPem).certificates[0];
  assert.equal(leaf.checkPrivateKey(crypto.createPrivateKey(keyPem)), true);
  assert.equal(leaf.ca, false);
  assert.deepEqual(leaf.toLegacyObject().ext_key_usage, ["1.3.6.1.5.5.7.3.2"]);
  assert.equal(leaf.publicKey.export({ type: "spki", format: "der" }).equals(crypto.createPublicKey(keyPem).export({ type: "spki", format: "der" })), true);
  assert.equal((await fs.stat(enrollment.keyPath)).size > 0, true);

  // 开通码明文不落盘，pending 在成功后删除；对外状态/配置文件不含私钥或码。
  const pending = await fs.readFile(enrollment.pendingPath, "utf8").catch(() => null);
  assert.equal(pending, null);
  const visible = statusText(enrollment.getStatus()) + statusText(auth.getState());
  assert.equal(visible.includes(CODE), false);
  assert.equal(visible.includes("PRIVATE KEY"), false);
  const configText = await fs.readFile(auth.configPath, "utf8");
  assert.equal(configText.includes(CODE), false);
  assert.equal(configText.includes("PRIVATE KEY"), false);
  assert.equal(configText.includes(enrollment.keyPath), true, "配置只保存本机路径，不保存私钥内容");

  assert.equal(mock.state.requests, 1);
  assert.equal(mock.state.redeemCalls[0].deviceName, "测试机");
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
});

test("响应丢失后用原码原钥恢复同一设备；换钥匙被 401 拒绝", async (t) => {
  const { mock, enrollment } = await setup(t);
  mock.dropNextResponse();
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => ["ENROLLMENT_RESPONSE_ABORTED", "ENROLLMENT_RESPONSE_INCOMPLETE", "ENROLLMENT_NETWORK"].includes(e.code),
  );
  const firstKey = mock.state.redeemCalls[0].publicKeyPem;
  const result = await enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" });
  assert.equal(result.session, true);
  assert.equal(mock.state.redeemCalls.length, 2);
  assert.equal(mock.state.redeemCalls[1].publicKeyPem, firstKey, "必须复用原私钥");
  assert.equal(mock.state.bindings.size, 1, "一码只绑定一个公钥");

  // 另一台机器用同一码但新密钥 → 401，且不落盘。
  const other = await newInstance(t, mock);
  await assert.rejects(
    () => other.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "UNAUTHORIZED" && e.status === 401,
  );
  assert.equal(other.auth.getState().hasClientCertificate, false);
  assert.equal(await fs.readFile(other.enrollment.certPath, "utf8").catch(() => null), null);
});

test("已激活账户：不重置现有密码，用返回用户名+输入密码登录", async (t) => {
  const { mock, auth, enrollment } = await setup(t);
  mock.getUser("alice").state = "ACTIVE";
  const before = mock.getUser("alice").password;
  const result = await enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" });
  assert.equal(result.session, true);
  assert.equal(mock.getUser("alice").password, before, "开通码不能重置已有密码");
  assert.equal(auth.getState().username, "alice");
  assert.equal(result.activationPending, false);
});

test("错误映射：429/503/401 使用固定码与状态，不泄露云端原文", async (t) => {
  const { mock, enrollment } = await setup(t);
  mock.setFailNext(429, "RATE_LIMITED");
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "RATE_LIMITED" && e.status === 429 && e.retryAfterMs >= 6_000 && !String(e.message).includes("correct horse"),
  );
  mock.setFailNext(503, "ENROLLMENT_UNAVAILABLE");
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "ENROLLMENT_UNAVAILABLE" && e.status === 503,
  );
  mock.setFailNext(401, "UNAUTHORIZED");
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "UNAUTHORIZED" && e.status === 401,
  );
});

test("TLS 信任：错误 server CA 与主机名不匹配都安全失败", async (t) => {
  const foreign = await makeForeignCa();
  t.after(() => foreign.cleanup());
  const wrongCa = await setup(t, { releasePatch: { serverCaPem: foreign.pem } });
  await assert.rejects(
    () => wrongCa.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "ENROLLMENT_TLS_ERROR",
  );
  assert.equal(wrongCa.auth.getState().hasClientCertificate, false);

  const wrongHost = await setup(t, { mock: { san: "DNS:localhost" } });
  await assert.rejects(
    () => wrongHost.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "ENROLLMENT_TLS_ERROR",
  );
});

test("重定向/超大响应/半响应/超时都不落盘", async (t) => {
  const redirect = await setup(t);
  redirect.mock.redirectNext();
  await assert.rejects(
    () => redirect.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "ENROLLMENT_REDIRECT",
  );

  const big = await setup(t);
  big.mock.oversizeNext();
  await assert.rejects(
    () => big.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "ENROLLMENT_RESPONSE_TOO_LARGE",
  );

  const half = await setup(t);
  half.mock.truncateNext();
  await assert.rejects(
    () => half.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => ["ENROLLMENT_RESPONSE_INCOMPLETE", "ENROLLMENT_RESPONSE_ABORTED"].includes(e.code),
  );

  const slow = await setup(t, { timeoutMs: 80 });
  slow.mock.setDelayMs(500);
  await assert.rejects(
    () => slow.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "ENROLLMENT_TIMEOUT",
  );
});

test("single-flight：并发开通只发一次兑换", async (t) => {
  const { mock, enrollment } = await setup(t);
  mock.setDelayMs(120);
  const [first, second] = await Promise.all([
    enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
  ]);
  assert.equal(mock.state.requests, 1);
  assert.equal(first.session, true);
  assert.equal(second.session, true);
});

test("退出后迟到开通响应不能复活会话或写设备配置", async (t) => {
  const { mock, auth, enrollment } = await setup(t);
  mock.setDelayMs(250);
  const pending = enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" });
  const settled = pending.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await sleep(40);
  await auth.logout();
  const outcome = await settled;
  assert.equal(outcome.error?.code, "STALE");
  assert.equal(auth.getState().hasClientCertificate, false);
  assert.equal(await fs.readFile(enrollment.certPath, "utf8").catch(() => null), null);
  assert.equal(await fs.readFile(enrollment.metadataPath, "utf8").catch(() => null), null);
  assert.equal(await fs.readFile(auth.configPath, "utf8").catch(() => null), null);
});

test("设备目录不可写时失败且不写 CloudAuth 配置", async (t) => {
  const { lib, auth, enrollment } = await setup(t);
  await fs.writeFile(path.join(lib.dataDir, "cloud-device"), "not a directory");
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "STORAGE_ERROR",
  );
  assert.equal(await fs.readFile(auth.configPath, "utf8").catch(() => null), null);
  assert.deepEqual(JSON.parse(JSON.stringify(enrollment.getStatus())).ready, true);
});

test("证书过期与错误 device CA 都被拒绝", async (t) => {
  const expired = await setup(t, { clock: Date.now() + 40 * 86400_000 });
  await assert.rejects(
    () => expired.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "CERT_EXPIRED",
  );

  const foreign = await makeForeignCa();
  t.after(() => foreign.cleanup());
  const wrongChain = await setup(t, { releasePatch: { deviceCaPem: foreign.pem } });
  await assert.rejects(
    () => wrongChain.enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "测试机" }),
    (e) => e.code === "CERT_CHAIN_INVALID",
  );
  assert.equal(await fs.readFile(wrongChain.enrollment.certPath, "utf8").catch(() => null), null);
});

// ── 007 round-2：review 三项反例的确定性回归 ─────────────────────────

const openssl = (args) => run("openssl", args, { maxBuffer: 4e6 });

async function makeRoot(dir, name, { pathLen = null, keyUsage = "keyCertSign,cRLSign" } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const key = path.join(dir, "root.key");
  const crt = path.join(dir, "root.crt");
  const constraints = pathLen === null ? "critical,CA:TRUE" : `critical,CA:TRUE,pathlen:${pathLen}`;
  await openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-keyout", key, "-out", crt, "-days", "2", "-subj", `/CN=${name}`,
    "-addext", `basicConstraints=${constraints}`,
    "-addext", `keyUsage=critical,${keyUsage}`,
  ]);
  return { key, crt, pem: await fs.readFile(crt, "utf8") };
}

async function makeIntermediate(dir, ca, name, { days = "2", constraints = "critical,CA:TRUE", keyUsage = "critical,keyCertSign,cRLSign" } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const key = path.join(dir, "intermediate.key");
  const csr = path.join(dir, "intermediate.csr");
  const crt = path.join(dir, "intermediate.crt");
  const ext = path.join(dir, "intermediate.ext");
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", key, "-out", csr, "-subj", `/CN=${name}`]);
  await fs.writeFile(ext, `basicConstraints=${constraints}\nkeyUsage=${keyUsage}\n`);
  await openssl([
    "x509", "-req", "-in", csr, "-CA", ca.crt, "-CAkey", ca.key,
    "-set_serial", `0x${crypto.randomBytes(6).toString("hex")}`, "-days", days,
    "-sha256", "-extfile", ext, "-out", crt,
  ]);
  return { key, crt, pem: await fs.readFile(crt, "utf8") };
}

async function makeLeaf(dir, ca, name, { days = "1", eku = "clientAuth", constraints = "critical,CA:FALSE", keyUsage = "critical,digitalSignature" } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const key = path.join(dir, "leaf.key");
  const csr = path.join(dir, "leaf.csr");
  const crt = path.join(dir, "leaf.crt");
  const ext = path.join(dir, "leaf.ext");
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", key, "-out", csr, "-subj", `/CN=${name}`]);
  await fs.writeFile(ext, `basicConstraints=${constraints}\nkeyUsage=${keyUsage}\nextendedKeyUsage=${eku}\n`);
  await openssl([
    "x509", "-req", "-in", csr, "-CA", ca.crt, "-CAkey", ca.key,
    "-set_serial", `0x${crypto.randomBytes(6).toString("hex")}`, "-days", days,
    "-sha256", "-extfile", ext, "-out", crt,
  ]);
  return { key, crt, pem: await fs.readFile(crt, "utf8") };
}

async function newChainDir(t, label) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `shiguang-chain-${label}-`));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("证书链：有效中间链通过；过期/非CA/缺keyCertSign/pathLen/serverAuth/错锚均拒绝", async (t) => {
  const base = await newChainDir(t, "valid");
  const root = await makeRoot(path.join(base, "root"), "Round2 Root", { pathLen: 1 });
  const intermediate = await makeIntermediate(path.join(base, "intermediate"), root, "Round2 Intermediate");
  const leaf = await makeLeaf(path.join(base, "leaf"), intermediate, "Round2 Device");
  const leafKey = crypto.createPrivateKey(await fs.readFile(leaf.key));

  const accepted = verifyEnrolledCertificate({
    chainPem: leaf.pem + intermediate.pem,
    privateKey: leafKey,
    deviceCaPem: root.pem,
  });
  assert.equal(accepted.leaf.subject, "CN=Round2 Device");
  // 返回链里带根也应通过；根只作为预置锚，不要求根自签验证。
  verifyEnrolledCertificate({
    chainPem: leaf.pem + intermediate.pem + root.pem,
    privateKey: leafKey,
    deviceCaPem: root.pem,
  });

  const expired = await makeIntermediate(path.join(base, "expired"), root, "Expired Intermediate", { days: "-1" });
  const expiredLeaf = await makeLeaf(path.join(base, "expired-leaf"), expired, "Expired Device");
  const expiredLeafKey = crypto.createPrivateKey(await fs.readFile(expiredLeaf.key));
  assert.throws(
    () => verifyEnrolledCertificate({
      chainPem: expiredLeaf.pem + expired.pem,
      privateKey: expiredLeafKey,
      deviceCaPem: root.pem,
    }),
    (e) => e.code === "CERT_EXPIRED",
  );

  const nonCa = await makeIntermediate(path.join(base, "nonca"), root, "Not A CA", { constraints: "critical,CA:FALSE" });
  const nonCaLeaf = await makeLeaf(path.join(base, "nonca-leaf"), nonCa, "NonCA Device");
  const nonCaLeafKey = crypto.createPrivateKey(await fs.readFile(nonCaLeaf.key));
  assert.throws(
    () => verifyEnrolledCertificate({
      chainPem: nonCaLeaf.pem + nonCa.pem,
      privateKey: nonCaLeafKey,
      deviceCaPem: root.pem,
    }),
    (e) => e.code === "CERT_CHAIN_INVALID",
  );

  const noKeyCertSign = await makeIntermediate(path.join(base, "nokcs"), root, "No KeyCertSign", { keyUsage: "critical,digitalSignature" });
  const noKsLeaf = await makeLeaf(path.join(base, "nokcs-leaf"), noKeyCertSign, "NoKs Device");
  const noKsLeafKey = crypto.createPrivateKey(await fs.readFile(noKsLeaf.key));
  assert.throws(
    () => verifyEnrolledCertificate({
      chainPem: noKsLeaf.pem + noKeyCertSign.pem,
      privateKey: noKsLeafKey,
      deviceCaPem: root.pem,
    }),
    (e) => e.code === "CERT_CHAIN_INVALID",
  );

  const strictRoot = await makeRoot(path.join(base, "pathlen"), "PathLen Zero Root", { pathLen: 0 });
  const underStrict = await makeIntermediate(path.join(base, "pathlen-intermediate"), strictRoot, "Too Deep Intermediate");
  const strictLeaf = await makeLeaf(path.join(base, "pathlen-leaf"), underStrict, "PathLen Device");
  const strictLeafKey = crypto.createPrivateKey(await fs.readFile(strictLeaf.key));
  assert.throws(
    () => verifyEnrolledCertificate({
      chainPem: strictLeaf.pem + underStrict.pem,
      privateKey: strictLeafKey,
      deviceCaPem: strictRoot.pem,
    }),
    (e) => e.code === "CERT_CHAIN_INVALID",
  );

  const serverLeaf = await makeLeaf(path.join(base, "serverleaf"), intermediate, "Server Leaf", { eku: "serverAuth" });
  const serverLeafKey = crypto.createPrivateKey(await fs.readFile(serverLeaf.key));
  assert.throws(
    () => verifyEnrolledCertificate({
      chainPem: serverLeaf.pem + intermediate.pem,
      privateKey: serverLeafKey,
      deviceCaPem: root.pem,
    }),
    (e) => e.code === "CERT_CHAIN_INVALID",
  );

  const longLeaf = await makeLeaf(path.join(base, "longleaf"), intermediate, "Long Leaf", { days: "91" });
  const longLeafKey = crypto.createPrivateKey(await fs.readFile(longLeaf.key));
  assert.throws(
    () => verifyEnrolledCertificate({
      chainPem: longLeaf.pem + intermediate.pem,
      privateKey: longLeafKey,
      deviceCaPem: root.pem,
    }),
    (e) => e.code === "CERT_EXPIRED",
  );

  const foreign = await makeRoot(path.join(base, "foreign"), "Foreign Root");
  assert.throws(
    () => verifyEnrolledCertificate({ chainPem: leaf.pem + intermediate.pem, privateKey: leafKey, deviceCaPem: foreign.pem }),
    (e) => e.code === "CERT_CHAIN_INVALID",
  );

  const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.throws(
    () => verifyEnrolledCertificate({ chainPem: leaf.pem + intermediate.pem, privateKey: otherKey, deviceCaPem: root.pem }),
    (e) => e.code === "CERT_KEY_MISMATCH",
  );
});

test("证书链：pathLen 向叶端计数，根是否随响应返回不改变结论", async (t) => {
  const base = await newChainDir(t, "pathlen-direction");

  // root(pathLen0) → intermediate → leaf：超限，带/不带根都必须拒绝。
  const zeroRoot = await makeRoot(path.join(base, "zero-root"), "Direction Zero Root", { pathLen: 0 });
  const zeroIntermediate = await makeIntermediate(path.join(base, "zero-intermediate"), zeroRoot, "Direction Zero Intermediate");
  const zeroLeaf = await makeLeaf(path.join(base, "zero-leaf"), zeroIntermediate, "Direction Zero Leaf");
  const zeroKey = crypto.createPrivateKey(await fs.readFile(zeroLeaf.key));
  for (const chainPem of [
    zeroLeaf.pem + zeroIntermediate.pem,
    zeroLeaf.pem + zeroIntermediate.pem + zeroRoot.pem,
  ]) {
    assert.throws(
      () => verifyEnrolledCertificate({ chainPem, privateKey: zeroKey, deviceCaPem: zeroRoot.pem }),
      (e) => e.code === "CERT_CHAIN_INVALID",
    );
  }

  // root(2) → parent(1) → child(0) → leaf：合法，带/不带根都必须接受。
  const legalRoot = await makeRoot(path.join(base, "legal-root"), "Direction Legal Root", { pathLen: 2 });
  const legalParent = await makeIntermediate(path.join(base, "legal-parent"), legalRoot, "Direction Legal Parent", {
    constraints: "critical,CA:TRUE,pathlen:1",
  });
  const legalChild = await makeIntermediate(path.join(base, "legal-child"), legalParent, "Direction Legal Child", {
    constraints: "critical,CA:TRUE,pathlen:0",
  });
  const legalLeaf = await makeLeaf(path.join(base, "legal-leaf"), legalChild, "Direction Legal Leaf");
  const legalKey = crypto.createPrivateKey(await fs.readFile(legalLeaf.key));
  for (const chainPem of [
    legalLeaf.pem + legalChild.pem + legalParent.pem,
    legalLeaf.pem + legalChild.pem + legalParent.pem + legalRoot.pem,
  ]) {
    const accepted = verifyEnrolledCertificate({ chainPem, privateKey: legalKey, deviceCaPem: legalRoot.pem });
    assert.equal(accepted.leaf.subject, "CN=Direction Legal Leaf");
  }

  // root(2) → parent(0) → child(5) → leaf：parent 下方已有一张中间 CA，超限；
  // 只看根端会误判为合法，带/不带根都必须拒绝。
  const overRoot = await makeRoot(path.join(base, "over-root"), "Direction Over Root", { pathLen: 2 });
  const overParent = await makeIntermediate(path.join(base, "over-parent"), overRoot, "Direction Over Parent", {
    constraints: "critical,CA:TRUE,pathlen:0",
  });
  const overChild = await makeIntermediate(path.join(base, "over-child"), overParent, "Direction Over Child", {
    constraints: "critical,CA:TRUE,pathlen:5",
  });
  const overLeaf = await makeLeaf(path.join(base, "over-leaf"), overChild, "Direction Over Leaf");
  const overKey = crypto.createPrivateKey(await fs.readFile(overLeaf.key));
  for (const chainPem of [
    overLeaf.pem + overChild.pem + overParent.pem,
    overLeaf.pem + overChild.pem + overParent.pem + overRoot.pem,
  ]) {
    assert.throws(
      () => verifyEnrolledCertificate({ chainPem, privateKey: overKey, deviceCaPem: overRoot.pem }),
      (e) => e.code === "CERT_CHAIN_INVALID",
    );
  }
});

const snapshotDeviceFiles = async (enrollment) => ({
  key: await fs.readFile(enrollment.keyPath, "utf8").catch(() => null),
  cert: await fs.readFile(enrollment.certPath, "utf8").catch(() => null),
  config: await fs.readFile(enrollment.cloudAuth.configPath, "utf8").catch(() => null),
  pending: await fs.readFile(enrollment.pendingPath, "utf8").catch(() => null),
});

test("未激活时改设备名/换码不覆盖原密钥，原码原名仍可恢复", async (t) => {
  const { mock, enrollment } = await setup(t);
  const first = await enrollment.enroll({ openingCode: CODE, password: "short", deviceName: "original-device" });
  assert.equal(first.activationPending, true);
  const keyBefore = await fs.readFile(enrollment.keyPath, "utf8");
  const before = await snapshotDeviceFiles(enrollment);

  for (const attempt of [
    { openingCode: CODE, deviceName: "renamed-device" },
    { openingCode: "B".repeat(43), deviceName: "original-device" },
  ]) {
    await assert.rejects(
      () => enrollment.enroll({ ...attempt, password: PASSWORD }),
      (e) => e.code === "DEVICE_PENDING_IDENTITY_MISMATCH" && e.status === 409,
    );
    assert.deepEqual(await snapshotDeviceFiles(enrollment), before, "身份不匹配时不得改动 key/cert/config/pending");
  }

  const retry = await enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "original-device" });
  assert.equal(retry.session, true);
  assert.equal(await fs.readFile(enrollment.keyPath, "utf8"), keyBefore, "原码原名必须复用原私钥");
  assert.equal(mock.state.redeemCalls.length, 2, "不一致重试不得发兑换请求");
  assert.equal(await fs.readFile(enrollment.pendingPath, "utf8").catch(() => null), null);
});

test("pending 记录损坏/缺失时 fail closed，保留 key/cert/config 且恢复记录后可续做", async (t) => {
  const { enrollment } = await setup(t);
  await enrollment.enroll({ openingCode: CODE, password: "short", deviceName: "damaged-device" });
  const keyBefore = await fs.readFile(enrollment.keyPath, "utf8");
  const certBefore = await fs.readFile(enrollment.certPath, "utf8");
  const configBefore = await fs.readFile(enrollment.cloudAuth.configPath, "utf8");
  const pendingBefore = await fs.readFile(enrollment.pendingPath, "utf8");

  await fs.writeFile(enrollment.pendingPath, "{not json");
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "damaged-device" }),
    (e) => e.code === "DEVICE_PENDING_INVALID",
  );
  assert.equal(await fs.readFile(enrollment.keyPath, "utf8"), keyBefore);
  assert.equal(await fs.readFile(enrollment.certPath, "utf8"), certBefore);
  assert.equal(await fs.readFile(enrollment.cloudAuth.configPath, "utf8"), configBefore);
  assert.equal(await fs.readFile(enrollment.pendingPath, "utf8"), "{not json");

  await fs.writeFile(enrollment.pendingPath, "null");
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "damaged-device" }),
    (e) => e.code === "DEVICE_PENDING_INVALID",
  );
  assert.equal(await fs.readFile(enrollment.keyPath, "utf8"), keyBefore);
  assert.equal(await fs.readFile(enrollment.pendingPath, "utf8"), "null");

  await fs.rm(enrollment.pendingPath, { force: true });
  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "damaged-device" }),
    (e) => e.code === "DEVICE_PENDING_INVALID",
  );
  assert.equal(await fs.readFile(enrollment.keyPath, "utf8"), keyBefore);
  assert.equal(await fs.readFile(enrollment.certPath, "utf8"), certBefore);
  assert.equal(await fs.readFile(enrollment.cloudAuth.configPath, "utf8"), configBefore);

  // 人工恢复原 journal 后仍可用原码原名续做；损坏/缺失本身绝不自动删除旧材料。
  await fs.writeFile(enrollment.pendingPath, pendingBefore);
  const retry = await enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "damaged-device" });
  assert.equal(retry.session, true);
  assert.equal(await fs.readFile(enrollment.keyPath, "utf8"), keyBefore);
});

test("待开通身份在真实重启后仍可原码原名恢复", async (t) => {
  const { base, mock, enrollment } = await setup(t);
  const first = await enrollment.enroll({ openingCode: CODE, password: "short", deviceName: "restart-device" });
  assert.equal(first.activationPending, true);
  const keyBefore = await fs.readFile(enrollment.keyPath, "utf8");

  const release = releaseFor(mock);
  const script = `
    import { Library } from ${JSON.stringify(new URL("../server/library.mjs", import.meta.url).href)};
    import { CloudAuth } from ${JSON.stringify(new URL("../server/cloud-auth.mjs", import.meta.url).href)};
    import { DeviceEnrollment } from ${JSON.stringify(new URL("../server/device-enrollment.mjs", import.meta.url).href)};
    import { validateReleaseConfig } from ${JSON.stringify(new URL("../server/cloud-release-config.mjs", import.meta.url).href)};
    const f = JSON.parse(process.env.SHIGUANG_ENROLL_CHILD);
    const lib = await new Library(f.dataDir).init();
    try {
      const auth = await new CloudAuth(lib, { dataDir: lib.dataDir }).init();
      const checked = validateReleaseConfig(f.release);
      if (!checked.usable) throw new Error("release config not usable");
      const enrollment = await new DeviceEnrollment(lib, {
        dataDir: lib.dataDir, cloudAuth: auth,
        release: { ...checked.config, usable: true },
      }).init();
      const result = await enrollment.enroll(f.request);
      console.log(JSON.stringify({ session: result.session, activationPending: result.activationPending }));
    } finally {
      lib.db.close();
    }
  `;
  const child = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    timeout: 30_000,
    env: {
      ...process.env,
      SHIGUANG_ENROLL_CHILD: JSON.stringify({
        dataDir: enrollment.dataDir,
        release,
        request: { openingCode: CODE, password: PASSWORD, deviceName: "restart-device" },
      }),
    },
  });
  const result = JSON.parse(child.stdout.trim().split("\n").pop());
  assert.equal(result.session, true);
  assert.equal(result.activationPending, false);
  assert.equal(await fs.readFile(enrollment.keyPath, "utf8"), keyBefore, "重启不得更换已绑定私钥");
  assert.equal(await fs.readFile(enrollment.pendingPath, "utf8").catch(() => null), null);
  const metadata = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(metadata.activated, true);
  assert.equal(mock.state.redeemCalls.length, 2);
});

test("configure 返回后取消/退出：旧开通不得继续激活或复活会话", async (t) => {
  const { auth, enrollment } = await setup(t);
  let openGate;
  let arrivedResolve;
  const gate = new Promise((resolve) => (openGate = resolve));
  const arrived = new Promise((resolve) => (arrivedResolve = resolve));
  const original = auth.configure.bind(auth);
  auth.configure = async (...args) => {
    const result = await original(...args);
    arrivedResolve();
    await gate;
    return result;
  };

  const pending = enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "gate-device" });
  await arrived;
  enrollment.cancel();
  await auth.logout();
  assert.equal(auth.getState().state, "logged-out");
  openGate();
  await assert.rejects(pending, (e) => e.code === "STALE");
  assert.equal(auth.getState().state, "logged-out");
  const metadata = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(metadata.activated, false);
});

test("configure 后切换到高级配置：旧开通不得写入登录态", async (t) => {
  const { auth, enrollment } = await setup(t);
  const foreign = await makeForeignCa();
  t.after(() => foreign.cleanup());
  let openGate;
  let arrivedResolve;
  let first = true;
  const gate = new Promise((resolve) => (openGate = resolve));
  const arrived = new Promise((resolve) => (arrivedResolve = resolve));
  const original = auth.configure.bind(auth);
  auth.configure = async (...args) => {
    const result = await original(...args);
    if (!first) return result;
    first = false;
    arrivedResolve();
    await gate;
    return result;
  };

  const pending = enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "config-switch-device" });
  await arrived;
  enrollment.cancel();
  const switching = auth.configure({
    origin: auth.config.origin,
    caPath: foreign.dir + "/ca.crt",
    certPath: auth.config.certPath,
    keyPath: auth.config.keyPath,
  });
  openGate();
  await Promise.all([assert.rejects(pending, (e) => e.code === "STALE"), switching]);
  assert.equal(auth.getState().state, "logged-out");
  assert.equal(auth.config.caPath, foreign.dir + "/ca.crt");
});

test("登录返回后取消/退出：不得提交成功元数据或复活会话", async (t) => {
  const { mock, auth, enrollment } = await setup(t);
  mock.getUser("alice").state = "ACTIVE";
  let openGate;
  let arrivedResolve;
  const gate = new Promise((resolve) => (openGate = resolve));
  const arrived = new Promise((resolve) => (arrivedResolve = resolve));
  const original = auth.login.bind(auth);
  auth.login = async (...args) => {
    const result = await original(...args);
    arrivedResolve();
    await gate;
    return result;
  };

  const pending = enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "login-gate-device" });
  await arrived;
  assert.equal(auth.getState().state, "logged-in");
  enrollment.cancel();
  await auth.logout();
  openGate();
  await assert.rejects(pending, (e) => e.code === "STALE");
  assert.equal(auth.getState().state, "logged-out");
  const metadata = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(metadata.activated, false);
});

test("最终元数据提交窗口取消：不写入 activated=true", async (t) => {
  const { mock, auth, enrollment } = await setup(t);
  mock.getUser("alice").state = "ACTIVE";
  const baseClock = enrollment.clock.bind(enrollment);
  let calls = 0;
  let logoutPromise = null;
  enrollment.clock = () => {
    calls += 1;
    const value = baseClock();
    // 第 4 次：pending.createdAt、证书校验 now、install metadata、最终 metadata。
    // 最后一次在最终提交前同步撤销 operation，模拟外部退出正好落在提交窗口。
    if (calls === 4) {
      enrollment.cancel();
      logoutPromise = auth.logout();
    }
    return value;
  };

  await assert.rejects(
    () => enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "commit-gate-device" }),
    (e) => e.code === "STALE",
  );
  await logoutPromise;
  assert.equal(auth.getState().state, "logged-out");
  const metadata = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(metadata.activated, false);
});

test("最终元数据 rename gate：取消后回滚，磁盘/内存不残留 activated=true", async (t) => {
  const { mock, auth, enrollment } = await setup(t);
  mock.getUser("alice").state = "ACTIVE";

  let openGate;
  let arrivedResolve;
  const gate = new Promise((resolve) => (openGate = resolve));
  const arrived = new Promise((resolve) => (arrivedResolve = resolve));
  const originalRename = fs.rename;
  // 与独立验收相同的位置：activated=true 已写入临时文件，真正 rename 之前。
  fs.rename = async (source, target) => {
    if (target === enrollment.metadataPath) {
      const staged = JSON.parse(await fs.readFile(source, "utf8"));
      if (staged.activated === true) {
        arrivedResolve();
        await gate;
      }
    }
    return originalRename(source, target);
  };
  t.after(() => {
    fs.rename = originalRename;
  });

  const pending = enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "rename-gate-device" });
  await arrived;
  enrollment.cancel();
  await auth.logout();
  openGate();

  await assert.rejects(pending, (e) => e.code === "STALE");
  assert.equal(auth.getState().state, "logged-out");
  const disk = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(disk.activated, false, "rename 期间的旧提交必须回滚到磁盘");
  assert.equal(enrollment.metadata.activated, false, "rename 期间的旧提交不得留在内存");
  const leftovers = (await fs.readdir(enrollment.deviceDir)).filter((name) => name.includes(".device.json.tmp-"));
  assert.deepEqual(leftovers, [], "旧提交的暂存文件必须清理");

  // 旧操作的回滚不得覆盖后一笔提交。
  const retry = await enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "rename-gate-device" });
  assert.equal(retry.session, true);
  const committed = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(committed.activated, true);
});

test("最终元数据真实 I/O gate：取消后内存/磁盘都不接受旧提交，重试可完成", async (t) => {
  const { mock, auth, enrollment } = await setup(t);
  mock.getUser("alice").state = "ACTIVE";

  let openGate;
  let arrivedResolve;
  const gate = new Promise((resolve) => (openGate = resolve));
  const arrived = new Promise((resolve) => (arrivedResolve = resolve));
  const originalChmod = fs.chmod;
  let metadataTemps = 0;
  // 真实文件 I/O gate：等 activated=true 的临时文件写完、fsync、chmod 完成，
  // rename 尚未发生（#stageFile 已返回、提交临界区尚未进入）。
  fs.chmod = async (file, mode) => {
    const result = await originalChmod(file, mode);
    if (String(file).includes(".device.json.tmp-")) {
      metadataTemps += 1;
      if (metadataTemps === 2) {
        arrivedResolve();
        await gate;
      }
    }
    return result;
  };
  t.after(() => {
    fs.chmod = originalChmod;
  });

  const pending = enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "io-gate-device" });
  await arrived;
  assert.equal(auth.getState().state, "logged-in");
  enrollment.cancel();
  await auth.logout();
  assert.equal(auth.getState().state, "logged-out");
  openGate();

  await assert.rejects(pending, (e) => e.code === "STALE");
  assert.equal(auth.getState().state, "logged-out");
  const disk = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(disk.activated, false, "取消后的旧提交不得写入磁盘");
  assert.equal(enrollment.metadata.activated, false, "取消后的旧提交不得留在内存");
  const leftovers = (await fs.readdir(enrollment.deviceDir)).filter((name) => name.includes(".device.json.tmp-"));
  assert.deepEqual(leftovers, [], "旧提交的暂存文件必须清理");

  // 旧操作清理/回滚不得影响后一笔提交：原码原钥重试可正常完成。
  const retry = await enrollment.enroll({ openingCode: CODE, password: PASSWORD, deviceName: "io-gate-device" });
  assert.equal(retry.session, true);
  const committed = JSON.parse(await fs.readFile(enrollment.metadataPath, "utf8"));
  assert.equal(committed.activated, true);
  assert.equal(await fs.readFile(enrollment.pendingPath, "utf8").catch(() => null), null);
});
