/**
 * T-LOCAL-007：本机设备自动开通（device enrollment v1）。
 *
 * 安全边界：
 *   - 私钥只在本机后端数据目录（目录 0700、文件 0600），绝不发送云端或浏览器；
 *     浏览器只提交开通码/密码并拿到脱敏状态。
 *   - 兑换只走 HTTPS，使用发行配置里的 serverCaPem 校验 CA 与主机名；不跟随重定向、
 *     不关闭证书校验、不携带任何令牌/客户端证书。
 *   - 返回的设备证书必须先匹配本机私钥、clientAuth/非 CA/有效期，并链到预置
 *     deviceCaPem，才原子落盘；异常响应绝不覆盖已正常使用的设备配置。
 *   - single-flight；原码响应丢失时复用原私钥与设备名；开通码只存 SHA-256。
 *   - 组合操作身份（CloudAuth.operation）：退出/切换账户/高级配置会撤销它，
 *     迟到的配置、激活/登录与最终元数据提交都不能复活旧配置。
 */
import crypto from "node:crypto";
import { rmSync, lstatSync, readdirSync, readFileSync, mkdirSync, chmodSync, renameSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { CloudAuthError, parseRetryAfterMs } from "./cloud-auth.mjs";

const SCHEMA_VERSION = 1;
const DEVICE_DIR = "cloud-device";
const PENDING_FILE = "pending-enrollment.json";
const METADATA_FILE = "device.json";
const KEY_FILE = "device-key.pem";
const CERT_FILE = "device-cert.pem";
const SERVER_CA_FILE = "server-ca.pem";
const CLIENT_AUTH_EKU = "1.3.6.1.5.5.7.3.2";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_CERT_DAYS = 90;
const MAX_CERT_MS = MAX_CERT_DAYS * 24 * 60 * 60 * 1000;
/** 允许签发端与本机的少量时钟偏差；过期仍严格按本机时间判断。 */
const CERT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

const fail = (code, message, { kind = "cloud", status = null, retryAfterMs = 0, cause = null } = {}) =>
  new CloudAuthError(message, { kind, code, status, retryAfterMs, cause, cloudMessage: true });

const isControl = (value) => /[\u0000-\u001f\u007f]/.test(value);

function normalizeDeviceName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return "本机";
  if (name.length > 128 || isControl(name)) return null;
  return name;
}

function normalizeOpeningCode(value) {
  if (typeof value !== "string") return null;
  const code = value.trim();
  // 云端是 43 位 Base64URL；宽松到 16–256 位，兼容测试与后续长度，但不接受空白/控制符。
  if (code.length < 16 || code.length > 256 || /\s/.test(code) || isControl(code)) return null;
  return code;
}

function publicKeyHashOf(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function canonicalEnrollmentText({ openingCode, publicKeyHash, deviceName }) {
  return `shiguang-device-enrollment-v1\n${openingCode}\n${publicKeyHash}\n${deviceName}`;
}

/** 把 PEM 里的证书按出现顺序解析；只接受 CERTIFICATE，拒绝私钥。 */
export function parseCertificateChain(pem, label = "certificateChainPem") {
  if (typeof pem !== "string" || /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(pem))
    throw fail("CERT_CHAIN_INVALID", "设备证书链无效");
  const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g)].map((m) => m[0]);
  if (!blocks.length) throw fail("CERT_CHAIN_INVALID", "设备证书链无效");
  try {
    return { pem: blocks.join("\n") + "\n", certificates: blocks.map((block) => new crypto.X509Certificate(block)) };
  } catch {
    throw fail("CERT_CHAIN_INVALID", "设备证书链无效");
  }
}

// ── 最小 DER 读取：只读 basicConstraints / keyUsage 这类证书扩展 ─────────
// Node 的 X509Certificate 不暴露 pathLen 与 keyUsage，逐级签名校验也不检查
// 中间 CA 的有效期/CA 约束。这里补足 RFC 5280 路径约束所需字段。

function readDer(buf, offset = 0) {
  if (!Buffer.isBuffer(buf) || offset < 0 || offset >= buf.length) throw new Error("der truncated");
  const first = buf[offset];
  if ((first & 0x1f) === 0x1f) throw new Error("der high tag unsupported");
  let cursor = offset + 1;
  if (cursor >= buf.length) throw new Error("der truncated");
  let length = buf[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count < 1 || count > 4 || cursor + count > buf.length) throw new Error("der length");
    length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + buf[cursor++];
    if (length < 0x80) throw new Error("der non-minimal length");
  }
  if (cursor + length > buf.length) throw new Error("der truncated value");
  return {
    tag: first,
    cls: first >> 6,
    constructed: (first & 0x20) !== 0,
    number: first & 0x1f,
    start: offset,
    valueStart: cursor,
    valueEnd: cursor + length,
    end: cursor + length,
  };
}

function derChildren(buf, element) {
  if (!element.constructed) throw new Error("der not constructed");
  const out = [];
  let offset = element.valueStart;
  while (offset < element.valueEnd) {
    const child = readDer(buf, offset);
    out.push(child);
    offset = child.end;
  }
  if (offset !== element.valueEnd) throw new Error("der children");
  return out;
}

function derOid(buf, element) {
  if (element.tag !== 0x06 || element.valueStart >= element.valueEnd) throw new Error("der oid");
  const bytes = buf.subarray(element.valueStart, element.valueEnd);
  const parts = [];
  let value = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    value = value * 128 + (bytes[i] & 0x7f);
    if (value > Number.MAX_SAFE_INTEGER) throw new Error("der oid overflow");
    if (!(bytes[i] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  if (bytes[bytes.length - 1] & 0x80 || !parts.length) throw new Error("der oid truncated");
  const first = parts.shift();
  const a = first < 80 ? Math.floor(first / 40) : 2;
  return [a, first - a * 40, ...parts].join(".");
}

function derBoolean(buf, element) {
  if (element.tag !== 0x01 || element.valueEnd - element.valueStart !== 1) throw new Error("der boolean");
  return buf[element.valueStart] !== 0;
}

function derInteger(buf, element) {
  if (element.tag !== 0x02) throw new Error("der integer");
  const bytes = buf.subarray(element.valueStart, element.valueEnd);
  if (!bytes.length || bytes[0] & 0x80) throw new Error("der integer");
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
    if (value > Number.MAX_SAFE_INTEGER) throw new Error("der integer overflow");
  }
  return value;
}

function certificateExtension(cert, oid) {
  const der = cert.raw;
  const root = readDer(der, 0);
  if (root.tag !== 0x30) throw new Error("certificate");
  const top = derChildren(der, root);
  if (!top.length) throw new Error("certificate");
  const fields = derChildren(der, top[0]);
  const wrapper = fields.find((field) => field.cls === 2 && field.number === 3);
  if (!wrapper) return null;
  const extensions = readDer(der, wrapper.valueStart);
  if (extensions.tag !== 0x30) throw new Error("extensions");
  for (const extension of derChildren(der, extensions)) {
    if (extension.tag !== 0x30) throw new Error("extension");
    const parts = derChildren(der, extension);
    if (parts.length < 2) throw new Error("extension");
    if (derOid(der, parts[0]) !== oid) continue;
    let index = 1;
    let critical = false;
    if (parts[index]?.tag === 0x01) {
      critical = derBoolean(der, parts[index]);
      index += 1;
    }
    if (parts[index]?.tag !== 0x04) throw new Error("extension value");
    return { critical, value: der.subarray(parts[index].valueStart, parts[index].valueEnd) };
  }
  return null;
}

function certificateBasicConstraints(cert) {
  const extension = certificateExtension(cert, "2.5.29.19");
  if (!extension) return { present: false, ca: false, pathLen: null };
  const sequence = readDer(extension.value, 0);
  if (sequence.tag !== 0x30) throw new Error("basicConstraints");
  let ca = false;
  let pathLen = null;
  for (const field of derChildren(extension.value, sequence)) {
    if (field.tag === 0x01) ca = derBoolean(extension.value, field);
    else if (field.tag === 0x02) pathLen = derInteger(extension.value, field);
    else throw new Error("basicConstraints field");
  }
  if (pathLen !== null && !ca) throw new Error("basicConstraints pathLen without CA");
  return { present: true, ca, pathLen };
}

function certificateKeyUsage(cert) {
  const extension = certificateExtension(cert, "2.5.29.15");
  if (!extension) return null;
  const bits = readDer(extension.value, 0);
  if (bits.tag !== 0x03) throw new Error("keyUsage");
  const value = extension.value;
  if (bits.valueStart >= bits.valueEnd) throw new Error("keyUsage empty");
  const unused = value[bits.valueStart];
  if (unused > 7) throw new Error("keyUsage unused bits");
  return { critical: extension.critical, bytes: value.subarray(bits.valueStart + 1, bits.valueEnd), unused };
}

function keyUsageHas(usage, bit) {
  const index = Math.floor(bit / 8);
  if (index >= usage.bytes.length) return false;
  return (usage.bytes[index] & (0x80 >> bit % 8)) !== 0;
}

function isSelfIssued(cert) {
  return cert.subject === cert.issuer;
}

function issuedBy(child, issuer) {
  try {
    return child.checkIssued(issuer) && child.verify(issuer.publicKey);
  } catch {
    return false;
  }
}

function checkValidity(cert, nowMs, maxLifetimeMs = null) {
  const from = Date.parse(cert.validFrom);
  const to = Date.parse(cert.validTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    throw fail("CERT_EXPIRED", "设备证书不在有效期内");
  if (from > nowMs + CERT_CLOCK_SKEW_MS || to <= nowMs)
    throw fail("CERT_EXPIRED", "设备证书不在有效期内");
  if (maxLifetimeMs !== null && to - from > maxLifetimeMs)
    throw fail("CERT_EXPIRED", "设备证书有效期超过允许范围");
  return { from, to };
}

function checkCaCertificate(cert, caBelow) {
  const constraints = certificateBasicConstraints(cert);
  if (!constraints.ca) throw fail("CERT_CHAIN_INVALID", "设备证书链包含非 CA 签发者");
  const usage = certificateKeyUsage(cert);
  if (usage && !keyUsageHas(usage, 5)) throw fail("CERT_CHAIN_INVALID", "设备证书链签发者缺少 keyCertSign");
  if (constraints.pathLen !== null && caBelow > constraints.pathLen)
    throw fail("CERT_CHAIN_INVALID", "设备证书链 pathLen 超出限制");
}

function countCaBelow(certificates, index) {
  // 数组是 叶(0) → 中间 CA(1…) → 根；pathLen 限制的是"本证书向叶端"还有
  // 多少张非 self-issued 中间 CA，绝不能朝根端数。叶和 self-issued 证书不计。
  let count = 0;
  for (let i = 1; i < index; i += 1) {
    if (certificateBasicConstraints(certificates[i]).ca && !isSelfIssued(certificates[i])) count += 1;
  }
  return count;
}

/**
 * 验证云端返回的设备证书（完整路径约束）。任何一项不满足都拒绝落盘。
 *
 * 除叶子私钥匹配/clientAuth/非 CA/90 天有效期外，还检查路径上每一张
 * 证书的有效期、CA basicConstraints、keyCertSign、pathLen 与预置信赖锚。
 * 这不是"逐级 verify 签名"：过期的中间 CA 即使签名正确也会被拒绝。
 * @returns {{chainPem:string, leaf:crypto.X509Certificate, expiresAt:string}}
 */
export function verifyEnrolledCertificate({ chainPem, privateKey, deviceCaPem, now = Date.now() }) {
  const chain = parseCertificateChain(chainPem);
  const certificates = chain.certificates;
  const leaf = certificates[0];
  const keyPublic = crypto.createPublicKey(privateKey);
  const keyDer = keyPublic.export({ type: "spki", format: "der" });
  let leafDer;
  try {
    leafDer = leaf.publicKey.export({ type: "spki", format: "der" });
  } catch {
    throw fail("CERT_KEY_MISMATCH", "设备证书与本机密钥不匹配");
  }
  if (!leafDer.equals(keyDer)) throw fail("CERT_KEY_MISMATCH", "设备证书与本机密钥不匹配");
  try {
    if (!leaf.checkPrivateKey(privateKey)) throw new Error("private key mismatch");
  } catch {
    throw fail("CERT_KEY_MISMATCH", "设备证书与本机密钥不匹配");
  }

  const nowMs = Number(now);
  if (!Number.isFinite(nowMs)) throw fail("CERT_EXPIRED", "设备证书不在有效期内");

  try {
    const leafConstraints = certificateBasicConstraints(leaf);
    if (leafConstraints.ca) throw fail("CERT_CHAIN_INVALID", "设备证书不能是 CA 证书");
    const leafUsage = certificateKeyUsage(leaf);
    if (leafUsage && !keyUsageHas(leafUsage, 0))
      throw fail("CERT_CHAIN_INVALID", "设备证书用途不包含 digitalSignature");
    const eku = leaf.toLegacyObject()?.ext_key_usage;
    if (!Array.isArray(eku) || !eku.includes(CLIENT_AUTH_EKU))
      throw fail("CERT_CHAIN_INVALID", "设备证书用途不是 clientAuth");
    if (eku.includes("1.3.6.1.5.5.7.3.1"))
      throw fail("CERT_CHAIN_INVALID", "设备证书不能用于 serverAuth");

    // 叶子证书的协议上限是 90 天；5 分钟只用于 notBefore 的签发端时钟偏差。
    checkValidity(leaf, nowMs, MAX_CERT_MS);

    const seen = new Set();
    for (const cert of certificates) {
      const fingerprint = cert.fingerprint256;
      if (seen.has(fingerprint)) throw fail("CERT_CHAIN_INVALID", "设备证书链包含重复证书");
      seen.add(fingerprint);
    }
    // 链顺序必须是 叶 → 中间 → … → 根，且每一级都由下一张签发。
    for (let i = 1; i < certificates.length; i += 1) {
      if (!issuedBy(certificates[i - 1], certificates[i]))
        throw fail("CERT_CHAIN_INVALID", "设备证书链签名无效");
    }

    const trusted = parseCertificateChain(deviceCaPem, "deviceCaPem").certificates;
    if (!trusted.length) throw fail("CERT_CHAIN_INVALID", "设备证书不是预置设备 CA 签发");
    const last = certificates[certificates.length - 1];
    let anchor = trusted.find((root) => root.fingerprint256 === last.fingerprint256) || null;
    const anchorInChain = anchor !== null;
    if (!anchor) anchor = trusted.find((root) => issuedBy(last, root)) || null;
    if (!anchor) throw fail("CERT_CHAIN_INVALID", "设备证书不是预置设备 CA 签发");

    // 中间证书必须有效期有效且是真正的 CA；叶子不是签发者，不在这里检查。
    for (let i = 1; i < certificates.length; i += 1) {
      const cert = certificates[i];
      const isAnchor = anchorInChain && cert.fingerprint256 === anchor.fingerprint256;
      if (!isAnchor) checkValidity(cert, nowMs);
      checkCaCertificate(cert, countCaBelow(certificates, i));
    }
    if (!anchorInChain) {
      // 预置锚不在返回链里时，也要约束它下面允许的中间 CA 数量。
      const caBelow = countCaBelow(certificates, certificates.length);
      checkCaCertificate(anchor, caBelow);
    }

    return { chainPem: chain.pem, leaf, expiresAt: new Date(Date.parse(leaf.validTo)).toISOString() };
  } catch (e) {
    if (e instanceof CloudAuthError) throw e;
    throw fail("CERT_CHAIN_INVALID", "设备证书链校验失败", { cause: e });
  }
}

export class DeviceEnrollment {
  constructor(lib, { dataDir, cloudAuth, release, clock = () => Date.now(), timeoutMs = 15_000 } = {}) {
    this.lib = lib;
    this.dataDir = dataDir || lib.dataDir;
    this.cloudAuth = cloudAuth;
    this.release = release || {};
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    this.deviceDir = path.join(this.dataDir, DEVICE_DIR);
    this.pendingPath = path.join(this.deviceDir, PENDING_FILE);
    this.metadataPath = path.join(this.deviceDir, METADATA_FILE);
    this.keyPath = path.join(this.deviceDir, KEY_FILE);
    this.certPath = path.join(this.deviceDir, CERT_FILE);
    this.serverCaPath = path.join(this.deviceDir, SERVER_CA_FILE);
    this.inflight = null;
    this.cancelToken = null;
    this.metadata = null;
    /** 元数据提交串行链与代次：旧提交的回滚不得覆盖后一笔提交。 */
    this.metadataPublishChain = Promise.resolve();
    this.metadataCommitSeq = 0;
  }

  async init() {
    try {
      this.metadata = JSON.parse(await fs.readFile(this.metadataPath, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") this.metadata = null;
    }
    return this;
  }

  /** 浏览器可读：只有脱敏状态，没有路径、码、密钥、证书内容。 */
  getStatus() {
    const release = this.release || {};
    const state = this.cloudAuth.getState();
    return {
      recoverySupported: true,
      ready: Boolean(release.usable),
      enabled: Boolean(release.enabled),
      configured: state.hasClientCertificate === true,
      deviceId: this.metadata?.deviceId || null,
      username: this.metadata?.username || null,
      certificateExpiresAt: this.metadata?.certificateExpiresAt || null,
      activated: this.metadata?.activated === true,
      activationPending: this.metadata?.needsActivation === true && this.metadata?.activated !== true,
      lastSessionErrorCode: /^[A-Z][A-Z0-9_]{1,63}$/.test(this.metadata?.lastSessionError || "") ? this.metadata.lastSessionError : null,
      message: release.usable ? null : release.errors?.[0] || (release.missing ? "当前版本未内置云端发行配置" : "云端发行配置不可用"),
    };
  }

  /** 退出/取消时中止进行中的兑换，并撤销本次组合操作的身份。 */
  cancel() {
    this.cancelRequested = true;
    if (this.operation) this.cloudAuth.abortOperation(this.operation);
    this.cancelToken?.cancel?.abort();
  }

  async recover({ confirm, deviceId } = {}) {
    if (confirm !== true || typeof deviceId !== "string" || deviceId !== this.metadata?.deviceId)
      throw fail("DEVICE_RECOVERY_CONFIRM_REQUIRED", "请确认需要重新开通的本机设备", { kind: "config", status: 409 });
    if (this.inflight) throw fail("DEVICE_RECOVERY_BUSY", "本机开通操作正在进行", { kind: "config", status: 409 });
    if (!this.release?.usable) throw fail("ENROLLMENT_UNAVAILABLE", "本机自动开通未就绪", { kind: "config", status: 503 });
    const operation = this.cloudAuth.beginOperation();
    this.operation = operation;
    this.recovering = true;
    this.cancelRequested = false;
    const run = async () => {
      try {
        const backups = path.join(this.dataDir, "backups");
        const backup = path.join(backups, `cloud-enroll-reset-${crypto.randomUUID()}`);
        const validate = () => {
          const root = realpathSync(this.dataDir);
          for (const dir of [this.deviceDir, backups]) {
            if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || path.dirname(realpathSync(dir)) !== root)
              throw new Error("unsafe recovery directory");
          }
          const allowed = new Set([PENDING_FILE, METADATA_FILE, KEY_FILE, CERT_FILE, SERVER_CA_FILE]);
          for (const name of readdirSync(this.deviceDir)) {
            const file = path.join(this.deviceDir, name);
            const stat = lstatSync(file);
            if (!allowed.has(name) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_RESPONSE_BYTES)
              throw new Error("unsafe recovery material");
          }
          if (JSON.parse(readFileSync(this.metadataPath, "utf8")).deviceId !== deviceId)
            throw new Error("device identity changed");
        };
        try { mkdirSync(backups, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
        validate();
        await this.cloudAuth.resetRevokedEnrollment({
          deviceId,
          config: { origin: this.release.apiOrigin, caPath: this.serverCaPath, certPath: this.certPath, keyPath: this.keyPath, p12Path: null },
          archive: () => {
            validate();
            chmodSync(backups, 0o700);
            chmodSync(this.deviceDir, 0o700);
            for (const name of readdirSync(this.deviceDir)) chmodSync(path.join(this.deviceDir, name), 0o600);
            renameSync(this.deviceDir, backup);
            this.metadata = null;
          },
        }, { operation });
        return { recovered: true, state: { ...this.cloudAuth.getState(), enrollment: this.getStatus() } };
      } catch (error) {
        throw error instanceof CloudAuthError ? error : fail("DEVICE_RECOVERY_UNSAFE", "本机材料未完成安全备份，已停止恢复；请联系管理员", { kind: "config", status: 409 });
      }
    };
    this.inflight = run().finally(() => {
      this.cloudAuth.endOperation(operation);
      if (this.operation === operation) this.operation = null;
      this.recovering = false;
      this.inflight = null;
    });
    return this.inflight;
  }

  async enroll({ openingCode, password, deviceName } = {}) {
    if (this.recovering) throw fail("DEVICE_RECOVERY_BUSY", "本机设备恢复正在进行", { kind: "config", status: 409 });
    const code = normalizeOpeningCode(openingCode);
    if (!code) throw fail("INVALID_REQUEST", "开通码格式不正确", { kind: "config", status: 400 });
    if (typeof password !== "string" || password.length < 1 || Buffer.byteLength(password, "utf8") > 72)
      throw fail("ENROLLMENT_PASSWORD_INVALID", "账户密码不能为空且不能超过 72 个 UTF-8 字节", { kind: "config", status: 400 });
    const name = normalizeDeviceName(deviceName);
    if (!name) throw fail("INVALID_REQUEST", "设备名称不合法", { kind: "config", status: 400 });

    if (!this.release?.usable)
      throw fail("ENROLLMENT_UNAVAILABLE", "本机自动开通未就绪", { kind: "config", status: 503 });
    const cloudState = this.cloudAuth.getState();
    // 已有设备证书（含高级设置里的手工配置）时不得用发行配置覆盖；只有本模块
    // 自己安装但尚未激活的记录允许用原码原钥续做激活。
    if (cloudState.hasClientCertificate && !this.metadata)
      throw fail("DEVICE_ALREADY_ENROLLED", "本机已开通，无需重复操作", { kind: "config", status: 409 });
    if (this.metadata?.activated === true && cloudState.hasClientCertificate)
      throw fail("DEVICE_ALREADY_ENROLLED", "本机已开通，无需重复操作", { kind: "config", status: 409 });

    if (this.inflight) return this.inflight;
    this.cancelRequested = false;
    const entry = {
      operation: this.cloudAuth.beginOperation(),
      cancel: null,
      promise: null,
    };
    this.operation = entry.operation;
    entry.promise = this.#runEnroll({ code, password, name, entry })
      .catch((e) => {
        // 文件权限/磁盘错误也收敛为固定码，绝不把本机路径或原始异常交给浏览器。
        throw e instanceof CloudAuthError ? e : fail("STORAGE_ERROR", "本地设备配置保存失败", { kind: "config", status: 400, cause: e });
      })
      .finally(() => {
        this.cloudAuth.endOperation(entry.operation);
        if (this.operation === entry.operation) this.operation = null;
        if (this.inflight === entry.promise) this.inflight = null;
        if (this.cancelToken === entry) this.cancelToken = null;
      });
    this.inflight = entry.promise;
    this.cancelToken = entry;
    return entry.promise;
  }

  async #runEnroll({ code, password, name, entry }) {
    this.#assertActive(entry);
    const pending = await this.#ensurePendingKey(code, name);
    this.#assertActive(entry);

    const signature = crypto
      .sign("sha256", Buffer.from(canonicalEnrollmentText({ openingCode: code, publicKeyHash: pending.publicKeyHash, deviceName: name }), "utf8"), pending.privateKey)
      .toString("base64");
    const payload = {
      openingCode: code,
      publicKeyPem: pending.publicKeyPem,
      signature,
      deviceName: name,
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    if (body.length > MAX_REQUEST_BYTES) throw fail("INVALID_REQUEST", "开通请求过大", { status: 400 });

    let data;
    try {
      data = await this.#redeem(body, entry);
    } catch (e) {
      if (!this.#isActive(entry)) throw this.#stale();
      throw e;
    }
    this.#assertActive(entry);

    const verified = verifyEnrolledCertificate({
      chainPem: data?.certificateChainPem,
      privateKey: pending.privateKey,
      deviceCaPem: this.release.deviceCaPem,
      now: this.clock(),
    });
    this.#assertActive(entry);

    const needsActivation = data?.needsActivation === true;
    if (typeof data?.accountId !== "string" || !data.accountId || typeof data?.username !== "string" || !data.username)
      throw fail("ENROLLMENT_RESPONSE_INVALID", "云端开通响应不完整");
    if (typeof data?.deviceId !== "string" || !data.deviceId)
      throw fail("ENROLLMENT_RESPONSE_INVALID", "云端开通响应不完整");
    if (needsActivation && (typeof data.activationToken !== "string" || !data.activationToken))
      throw fail("ENROLLMENT_RESPONSE_INVALID", "云端开通响应不完整");

    // 先写证书/元数据（原子 rename），再改 CloudAuth 配置；任何一步失败都不会
    // 动到旧证书文件或旧连接配置。
    await this.#installFiles(verified, { ...data, needsActivation }, entry);
    this.#assertActive(entry);

    const config = {
      origin: this.release.apiOrigin,
      caPath: this.serverCaPath,
      certPath: this.certPath,
      keyPath: this.keyPath,
      p12Path: null,
    };
    try {
      // configure/activate/login 与本次开通共享 operation：它们内部会改变
      // CloudAuth.epoch，但不会撤销本操作；外部退出/换账户/高级配置才会撤销。
      await this.cloudAuth.configure(config, { operation: entry.operation });
    } catch (e) {
      if (e?.code === "STALE" || !this.#isActive(entry)) throw this.#stale();
      throw e instanceof CloudAuthError
        ? e
        : fail("STORAGE_ERROR", "本地云端配置保存失败", { kind: "config", status: 400, cause: e });
    }
    // configure 返回后必须再次核对身份：这正是 review 的确定性 gate 窗口。
    this.#assertActive(entry);

    let session = false;
    let sessionError = null;
    try {
      if (needsActivation) {
        await this.cloudAuth.activate({ activationToken: data.activationToken, password }, { operation: entry.operation });
      } else {
        await this.cloudAuth.login({ username: data.username, password }, { operation: entry.operation });
      }
      this.#assertActive(entry);
      session = true;
    } catch (e) {
      // 外部退出/换账户/高级配置后，迟到的登录/激活不得作为成功结果提交。
      if (!this.#isActive(entry)) throw this.#stale();
      // 设备证书已安全落盘；激活/登录失败不回滚设备，交给用户重试。PENDING 账户
      // 保留 pending 记录，用原码原钥再次兑换可获取新的激活凭证。
      sessionError = e instanceof CloudAuthError ? e.toPublic() : fail("INTERNAL", "云端认证操作失败").toPublic();
    }
    this.#assertActive(entry);
    const finalMetadata = {
      ...this.#metadataFrom(verified, data, needsActivation),
      activated: session || !needsActivation,
      lastSessionError: sessionError?.code || null,
    };
    // 最终元数据是最后一次可见提交：暂存写完后异步 rename；rename 完成后再
    // 核验身份，若期间被取消则回滚到提交前值并返回 STALE，磁盘不会残留旧提交。
    await this.#saveMetadata(finalMetadata, entry);
    if (session) {
      // 提交点之后的清理保持同步，避免给取消留下"已提交却返回 STALE"的窗口。
      try {
        rmSync(this.pendingPath, { force: true });
      } catch {
        /* 清理失败不影响已提交结果 */
      }
    }
    return {
      enrolled: true,
      session,
      activationPending: needsActivation && !session,
      state: this.cloudAuth.getState(),
      enrollment: this.getStatus(),
      ...(sessionError ? { error: sessionError } : {}),
    };
  }

  #isActive(entry) {
    return !this.cancelRequested && entry.operation?.active === true;
  }

  #assertActive(entry) {
    if (!this.#isActive(entry)) throw this.#stale();
  }

  async #ensurePendingKey(code, deviceName) {
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    await this.#ensureDeviceDir();
    let existing;
    let journalPresent = false;
    try {
      existing = JSON.parse(await fs.readFile(this.pendingPath, "utf8"));
      journalPresent = true;
    } catch (e) {
      if (e.code !== "ENOENT")
        throw fail("DEVICE_PENDING_INVALID", "本机未完成的开通记录已损坏，已保留原设备材料", { kind: "config", status: 409 });
      existing = null;
    }

    if (journalPresent) {
      if (
        existing === null ||
        typeof existing !== "object" ||
        existing.schemaVersion !== SCHEMA_VERSION ||
        typeof existing.codeHash !== "string" ||
        typeof existing.deviceName !== "string" ||
        typeof existing.publicKeyHash !== "string"
      )
        throw fail("DEVICE_PENDING_INVALID", "本机未完成的开通记录已损坏，已保留原设备材料", { kind: "config", status: 409 });
      // 普通重试不能换码/换设备名：固定私钥只属于第一次绑定的身份，先覆盖再
      // 让云端拒绝会永久丢失原码原名恢复所需的私钥。不一致时安全拒绝、不动文件。
      if (existing.codeHash !== codeHash || existing.deviceName !== deviceName)
        throw fail("DEVICE_PENDING_IDENTITY_MISMATCH", "本机存在另一笔未完成的开通记录，请使用原开通码和设备名重试", {
          kind: "config",
          status: 409,
        });
      try {
        const privateKey = crypto.createPrivateKey(await fs.readFile(this.keyPath));
        const publicKeyHash = publicKeyHashOf(privateKey);
        if (existing.publicKeyHash !== publicKeyHash) throw new Error("hash mismatch");
        return {
          privateKey,
          publicKeyPem: crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }),
          publicKeyHash,
        };
      } catch {
        throw fail("DEVICE_KEY_LOST", "原设备密钥已丢失，需要重新开通", { kind: "config", status: 409 });
      }
    }

    // 没有 journal 却已有设备材料：可能是上次写到一半或记录损坏。此时生成新钥匙
    // 会覆盖唯一可恢复材料，必须 fail closed，保留原文件等待人工处理。
    for (const file of [this.keyPath, this.certPath, this.metadataPath]) {
      if (await this.#fileExists(file))
        throw fail("DEVICE_PENDING_INVALID", "本机已有设备材料但缺少未完成的开通记录，已保留原文件", {
          kind: "config",
          status: 409,
        });
    }

    const { privateKey, publicKey } = await new Promise((resolve, reject) => {
      crypto.generateKeyPair(
        "rsa",
        { modulusLength: 3072, publicExponent: 0x10001 },
        (error, pub, priv) => (error ? reject(error) : resolve({ privateKey: priv, publicKey: pub })),
      );
    });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const publicKeyHash = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
    await this.#writeFileAtomic(this.keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), 0o600);
    await this.#writeFileAtomic(
      this.pendingPath,
      JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          codeHash,
          deviceName,
          publicKeyHash,
          createdAt: new Date(this.clock()).toISOString(),
        },
        null,
        2,
      ) + "\n",
      0o600,
    );
    return { privateKey, publicKeyPem, publicKeyHash };
  }

  async #fileExists(file) {
    try {
      await fs.access(file);
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }

  #metadataFrom(verified, data, needsActivation) {
    return {
      schemaVersion: SCHEMA_VERSION,
      accountId: data.accountId,
      username: data.username,
      deviceId: data.deviceId,
      certificateExpiresAt: verified.expiresAt,
      needsActivation: needsActivation === true,
      installedAt: new Date(this.clock()).toISOString(),
    };
  }

  async #installFiles(verified, data, entry) {
    await this.#ensureDeviceDir();
    await this.#writeFileAtomic(this.serverCaPath, this.release.serverCaPem, 0o644);
    await this.#writeFileAtomic(this.certPath, verified.chainPem, 0o644);
    await this.#saveMetadata({ ...this.#metadataFrom(verified, data, data.needsActivation), activated: false }, entry);
  }

  /**
   * 元数据发布：内容先写入唯一临时文件，再在串行提交链里 rename。rename 是
   * 一次真实异步 I/O，取消可能正好落在 rename 期间；因此 rename 完成后必须
   * 再核验身份，已失活则把磁盘/内存恢复为提交前值并返回 STALE。
   *
   * 回滚安全：每次提交取单调代次 seq，只有磁盘仍归本次提交（seq 未被后一笔
   * 提交推进）时才回滚；串行链保证回滚先于后一笔提交，旧操作不会碰新暂存文件。
   * 这样不会出现"返回 STALE 但磁盘 activated=true"，也不会用回滚覆盖新提交。
   */
  async #saveMetadata(metadata, entry = null) {
    await this.#enqueueMetadataPublish(async () => {
      if (entry) this.#assertActive(entry);
      const tmp = await this.#stageFile(this.metadataPath, JSON.stringify(metadata, null, 2) + "\n", 0o600);
      try {
        if (entry) this.#assertActive(entry);
        const previous = this.metadata;
        const seq = (this.metadataCommitSeq += 1);
        await fs.rename(tmp, this.metadataPath);
        if (entry && !this.#isActive(entry)) {
          if (this.metadataCommitSeq === seq) await this.#restoreMetadata(previous).catch(() => {});
          throw this.#stale();
        }
        this.metadata = metadata;
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    });
  }

  #enqueueMetadataPublish(task) {
    const next = this.metadataPublishChain.then(task, task);
    this.metadataPublishChain = next.catch(() => {});
    return next;
  }

  async #restoreMetadata(previous) {
    if (previous === null || previous === undefined) {
      await fs.rm(this.metadataPath, { force: true });
      this.metadata = null;
      return;
    }
    const tmp = await this.#stageFile(this.metadataPath, JSON.stringify(previous, null, 2) + "\n", 0o600);
    try {
      await fs.rename(tmp, this.metadataPath);
      this.metadata = previous;
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async #ensureDeviceDir() {
    await fs.mkdir(this.deviceDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.deviceDir, 0o700);
  }

  async #stageFile(file, content, mode) {
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    try {
      const handle = await fs.open(tmp, "w", mode);
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(tmp, mode);
      return tmp;
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async #writeFileAtomic(file, content, mode) {
    const tmp = await this.#stageFile(file, content, mode);
    try {
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  #stale() {
    return new CloudAuthError("开通请求已被更新的操作取代", { kind: "auth", code: "STALE" });
  }

  /** 兑换：只信任发行 serverCaPem，校验主机名，不重定向、不带令牌/客户端证书。 */
  #redeem(body, entry) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      let deadline = null;
      const token = {
        aborted: false,
        abort: () => {
          token.aborted = true;
          try {
            req?.destroy(new Error("enrollment canceled"));
          } catch {
            /* 已结束 */
          }
        },
      };
      entry.cancel = token;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        fn(value);
      };
      const error = (e) => {
        if (token.aborted) return finish(reject, this.#stale());
        if (e instanceof CloudAuthError) return finish(reject, e);
        const code = String(e?.code || "");
        if (/CERT|TLS|SSL|SELF_SIGNED|VERIFY|ALTNAME|ERR_OSSL|PEM|X509/i.test(code) || /certificate|handshake/i.test(String(e?.message || "")))
          return finish(reject, fail("ENROLLMENT_TLS_ERROR", "云端开通服务证书或主机名校验失败", { kind: "cert", cause: e }));
        return finish(reject, fail("ENROLLMENT_NETWORK", "无法连接云端开通服务", { kind: "network", cause: e }));
      };

      let url;
      try {
        url = new URL("/api/v1/device-enrollment/redeem", this.release.enrollmentOrigin);
        if (url.protocol !== "https:") throw new Error("not https");
      } catch (e) {
        return error(fail("ENROLLMENT_UNAVAILABLE", "本机自动开通未就绪", { kind: "config", status: 503, cause: e }));
      }

      const options = {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        ca: this.release.serverCaPem,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        agent: false,
        timeout: this.timeoutMs,
      };
      // IP 地址不发送 SNI，但 Node 仍会用 IP 做证书 SAN 校验。
      if (!net.isIP(url.hostname)) options.servername = url.hostname;

      try {
        req = https.request(url, options, (res) => {
          if (settled) return res.destroy();
          const status = res.statusCode || 0;
          const challenge = res.headers["www-authenticate"];
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            if (settled) return;
            text += chunk;
            if (text.length > MAX_RESPONSE_BYTES) {
              error(fail("ENROLLMENT_RESPONSE_TOO_LARGE", "云端开通响应过大", { status: 413 }));
              res.destroy();
            }
          });
          res.on("end", () => {
            if (settled) return;
            if (!res.complete) return error(fail("ENROLLMENT_RESPONSE_INCOMPLETE", "云端开通响应不完整", { kind: "network" }));
            if (status >= 300 && status < 400)
              return error(fail("ENROLLMENT_REDIRECT", "云端开通服务返回了重定向，已拒绝", { status: 400 }));
            let parsed = null;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              return error(fail("ENROLLMENT_RESPONSE_INVALID", "云端开通响应无法解析"));
            }
            if (status >= 200 && status < 300) {
              if (parsed?.code !== "OK" || !parsed.data)
                return error(fail("ENROLLMENT_RESPONSE_INVALID", "云端开通响应不完整"));
              return finish(resolve, parsed.data);
            }
            const code = typeof parsed?.code === "string" ? parsed.code : `HTTP_${status}`;
            const retryAfterMs =
              status === 429
                ? Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, parseRetryAfterMs(res.headers["retry-after"], this.clock())))
                : 0;
            const known = new Set([
              "INVALID_REQUEST",
              "UNAUTHORIZED",
              "FORBIDDEN",
              "ACCOUNT_EXISTS",
              "DEVICE_LIMIT",
              "DEVICE_KEY_REUSED",
              "ACCOUNT_ACTIVATION_PENDING",
              "RATE_LIMITED",
              "ENROLLMENT_UNAVAILABLE",
            ]);
            const mapped = known.has(code)
              ? code
              : status === 401
                ? "UNAUTHORIZED"
                : status === 403
                  ? "FORBIDDEN"
                  : status === 413
                    ? "REQUEST_TOO_LARGE"
                    : status === 429
                      ? "RATE_LIMITED"
                      : status === 503
                        ? "ENROLLMENT_UNAVAILABLE"
                        : "ENROLLMENT_FAILED";
            error(
              fail(mapped, "云端开通未完成", {
                status: [400, 401, 403, 409, 413, 429, 503].includes(status) ? status : 400,
                retryAfterMs,
              }),
            );
          });
          res.on("aborted", () => error(fail("ENROLLMENT_RESPONSE_ABORTED", "云端开通响应中断", { kind: "network" })));
          res.on("error", (e) => error(fail("ENROLLMENT_RESPONSE_ABORTED", "云端开通响应中断", { kind: "network", cause: e })));
          res.on("close", () => {
            if (!settled && !res.complete) error(fail("ENROLLMENT_RESPONSE_INCOMPLETE", "云端开通响应不完整", { kind: "network" }));
          });
        });
      } catch (e) {
        return error(fail("ENROLLMENT_NETWORK", "无法连接云端开通服务", { kind: "network", cause: e }));
      }
      deadline = setTimeout(() => {
        const timeout = fail("ENROLLMENT_TIMEOUT", "云端开通请求超时", { kind: "timeout" });
        try {
          req.destroy(timeout);
        } catch {
          /* 已结束 */
        }
        error(timeout);
      }, Math.max(1, Number(this.timeoutMs) || 15_000));
      req.on("timeout", () => {
        const timeout = fail("ENROLLMENT_TIMEOUT", "云端开通请求超时", { kind: "timeout" });
        req.destroy(timeout);
        error(timeout);
      });
      req.on("error", (e) => error(e));
      req.write(body);
      req.end();
    });
  }
}
