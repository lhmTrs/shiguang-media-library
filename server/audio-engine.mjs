/**
 * 音频分析引擎安装器（T-LOCAL-012）。
 *
 * 安全边界：
 * - 只信任应用内固定发布描述（版本/平台/URL/大小/hash），HTTP 与环境变量不能替换；
 * - 只支持 darwin-arm64；固定公开 CA，严格 TLS，不跟随重定向；
 * - 流式下载，长度/字节/hash 三重校验，空闲超时 + 总截止 + 显式取消；
 * - 复用成熟 tar-stream 解析，只允许白名单普通文件，拒绝链接/设备/PAX 路径；
 * - 安装/取消/卸载共享跨进程锁与单一状态机，先提交新版本再切换指针，旧版本保留到提交成功；
 * - 状态只读本地可信标记，错误返回固定码，不泄露本地路径/令牌/原始异常。
 */
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import tar from "tar-stream";
import {
  CONTRACT_VERSION as RELEASE_MEMBERS_CONTRACT_VERSION,
  CODES as RELEASE_MEMBERS_CODES,
  parseReleaseMembers,
  checkExternalExpectation,
} from "./audio-release-members.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CA_FILE = path.join(HERE, "audio-engine-ca.pem");
const MiB = 1024 * 1024;
/** 安装器私有临时目录前缀；只有同时通过 owner 标记校验的同前缀目录才可清理。 */
const TMP_JOB_PREFIX = "audio-installer-job-";
const TMP_OWNER_FILE = ".owner.json";
const TMP_OWNER_KIND = "shiguang-audio-installer";
/** 标记/锁 owner 等本机元数据文件的有界读取上限。 */
const MAX_METADATA_BYTES = 4 * 1024;
/** tar 头/PAX/GNU 元数据/padding 的小额固定预算，超过 extractedMaxBytes 后仍受此上限约束。 */
const TAR_METADATA_ALLOWANCE = 64 * 1024;
/** 运行前/安装提交时二进制摘要的固定分块大小；禁止整文件 readFile。 */
const HASH_CHUNK_BYTES = 256 * 1024;
/** 安装元数据版本；旧 marker 无该字段时仍可展示 status，但运行必须显式重装。 */
const INSTALL_METADATA_VERSION = 2;
const SCOPE_BUDGET_EXHAUSTED = Symbol("audioEngineScopeBudgetExhausted");
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GENERATION_PATTERN = /^[0-9a-f]{32,64}$/;
/** 只有 tar.gz 进入现有安装器；成员声明也只能描述同一归档格式。 */
const RELEASE_ARCHIVE_FORMAT = "tar.gz";
/** 只有 archive size/hash 的既有发布描述：成员元数据不可用，绝不由归档身份反推。 */
export const LEGACY_MEMBER_METADATA_UNAVAILABLE = "LEGACY_MEMBER_METADATA_UNAVAILABLE";
/** 调用方显式提供成员声明并由已验合同解析后的状态。 */
export const DECLARED_MEMBER_METADATA = "DECLARED";
const RELEASE_MEMBERS_MISMATCH_CODES = new Set([
  RELEASE_MEMBERS_CODES.EXTERNAL_PIN_MISMATCH,
  RELEASE_MEMBERS_CODES.EXTERNAL_BYTES_MISMATCH,
  RELEASE_MEMBERS_CODES.EXTERNAL_VERSION_MISMATCH,
  RELEASE_MEMBERS_CODES.EXTERNAL_MEMBERS_MISMATCH,
]);
const RELEASE_MEMBERS_UNSUPPORTED_CODES = new Set([
  RELEASE_MEMBERS_CODES.SCHEMA_UNKNOWN,
  RELEASE_MEMBERS_CODES.SCHEMA_VERSION_UNKNOWN,
  RELEASE_MEMBERS_CODES.ARCHIVE_FORMAT_UNSUPPORTED,
  RELEASE_MEMBERS_CODES.PLATFORM_UNSUPPORTED,
  RELEASE_MEMBERS_CODES.ARCH_UNSUPPORTED,
]);

/** 应用内固定发布描述；生产路径不允许环境变量/浏览器覆盖。 */
export const ENGINE_RELEASE = Object.freeze({
  id: "audio-engine-v1-macos-arm64",
  version: "1.0.0",
  platform: "darwin",
  arch: "arm64",
  url: "https://112.74.109.173/downloads/audio-engine-v1-macos-arm64.tar.gz",
  size: 120156053,
  sha256: "61911f96c26a5cda6aae214fcde622d952729d48475754902d42905bedc7413e",
  archiveMaxBytes: 130 * MiB,
  extractedMaxBytes: 256 * MiB,
  maxEntries: 8,
  binary: "audio-analyze",
});

const CODES = {
  UNSUPPORTED_PLATFORM: "UNSUPPORTED_PLATFORM",
  CONFIRM_REQUIRED: "ENGINE_CONFIRM_REQUIRED",
  BUSY: "ENGINE_BUSY",
  DISK_SPACE_LOW: "ENGINE_DISK_SPACE_LOW",
  HTTP_STATUS: "ENGINE_HTTP_STATUS",
  CONTENT_ENCODING: "ENGINE_CONTENT_ENCODING",
  LENGTH_MISMATCH: "ENGINE_LENGTH_MISMATCH",
  HASH_MISMATCH: "ENGINE_HASH_MISMATCH",
  TIMEOUT: "ENGINE_TIMEOUT",
  CANCELLED: "ENGINE_CANCELLED",
  TLS_FAILED: "ENGINE_TLS_FAILED",
  DOWNLOAD_FAILED: "ENGINE_DOWNLOAD_FAILED",
  WRITE_FAILED: "ENGINE_WRITE_FAILED",
  ARCHIVE_INVALID: "ENGINE_ARCHIVE_INVALID",
  ARCHIVE_UNSAFE: "ENGINE_ARCHIVE_UNSAFE",
  ARCHIVE_TOO_LARGE: "ENGINE_ARCHIVE_TOO_LARGE",
  UNSAFE_TARGET: "ENGINE_UNSAFE_TARGET",
  COMMIT_FAILED: "ENGINE_COMMIT_FAILED",
  INSTALL_FAILED: "ENGINE_INSTALL_FAILED",
  LOCK_FAILED: "ENGINE_LOCK_FAILED",
  NOT_INSTALLED: "ENGINE_NOT_INSTALLED",
  REINSTALL_REQUIRED: "ENGINE_REINSTALL_REQUIRED",
  RELEASE_MISMATCH: "ENGINE_RELEASE_MISMATCH",
  RELEASE_DECLARATION_INVALID: "ENGINE_RELEASE_DECLARATION_INVALID",
  RELEASE_DECLARATION_UNSUPPORTED: "ENGINE_RELEASE_DECLARATION_UNSUPPORTED",
  RELEASE_EXPECTATION_INVALID: "ENGINE_RELEASE_EXPECTATION_INVALID",
  RELEASE_EXPECTATION_MISMATCH: "ENGINE_RELEASE_EXPECTATION_MISMATCH",
  INTEGRITY_FAILED: "ENGINE_INTEGRITY_FAILED",
  RUN_FAILED: "ENGINE_RUN_FAILED",
  INVALID_CALLBACK: "ENGINE_INVALID_CALLBACK",
};

/**
 * callback 允许保留的固定运行码（只保留分类，不保留 message/status）；
 * 其它 AudioEngineError 与普通异常一律折叠为 RUN_FAILED。
 */
const CALLBACK_ERROR_CODES = new Set([CODES.RUN_FAILED, CODES.CANCELLED]);

const MESSAGES = {
  [CODES.UNSUPPORTED_PLATFORM]: "当前平台不支持音频引擎安装",
  [CODES.CONFIRM_REQUIRED]: "需要明确确认后才能安装",
  [CODES.BUSY]: "安装器正忙；若已确认没有安装/卸载进程，请按维护说明清理残留安装锁",
  [CODES.DISK_SPACE_LOW]: "磁盘空间不足",
  [CODES.HTTP_STATUS]: "下载服务器响应异常",
  [CODES.CONTENT_ENCODING]: "下载响应包含不支持的压缩编码",
  [CODES.LENGTH_MISMATCH]: "下载大小与发布描述不一致",
  [CODES.HASH_MISMATCH]: "安装包校验失败",
  [CODES.TIMEOUT]: "下载超时",
  [CODES.CANCELLED]: "安装已取消",
  [CODES.TLS_FAILED]: "下载服务器证书校验失败",
  [CODES.DOWNLOAD_FAILED]: "下载失败",
  [CODES.WRITE_FAILED]: "写入安装临时文件失败",
  [CODES.ARCHIVE_INVALID]: "安装包格式无效",
  [CODES.ARCHIVE_UNSAFE]: "安装包包含不安全内容",
  [CODES.ARCHIVE_TOO_LARGE]: "安装包展开超出限制",
  [CODES.UNSAFE_TARGET]: "安装目录不安全",
  [CODES.COMMIT_FAILED]: "安装提交失败",
  [CODES.INSTALL_FAILED]: "安装失败",
  [CODES.LOCK_FAILED]: "无法获取安装锁",
  [CODES.NOT_INSTALLED]: "尚未安装音频引擎",
  [CODES.REINSTALL_REQUIRED]: "当前安装缺少可信摘要，需要重新安装或验证",
  [CODES.RELEASE_MISMATCH]: "已安装版本与当前发布描述不一致",
  [CODES.RELEASE_DECLARATION_INVALID]: "发布成员声明无效",
  [CODES.RELEASE_DECLARATION_UNSUPPORTED]: "发布成员声明尚未获准用于安装或运行",
  [CODES.RELEASE_EXPECTATION_INVALID]: "外部成员期望无效",
  [CODES.RELEASE_EXPECTATION_MISMATCH]: "发布成员声明与外部期望不一致",
  [CODES.INTEGRITY_FAILED]: "安装内容校验失败",
  [CODES.RUN_FAILED]: "音频运行失败",
  [CODES.INVALID_CALLBACK]: "运行接口参数无效",
};

export class AudioEngineError extends Error {
  constructor(code, message = MESSAGES[code] || MESSAGES[CODES.INSTALL_FAILED], status) {
    super(message);
    this.name = "AudioEngineError";
    this.code = code;
    this.status = status || statusForCode(code);
  }
}

export function isAudioEngineError(error) {
  return error instanceof AudioEngineError;
}

function statusForCode(code) {
  if (code === CODES.CONFIRM_REQUIRED) return 400;
  if (code === CODES.BUSY || code === CODES.UNSUPPORTED_PLATFORM) return 409;
  if (code === CODES.NOT_INSTALLED || code === CODES.REINSTALL_REQUIRED || code === CODES.RELEASE_MISMATCH) return 409;
  if (code === CODES.RELEASE_DECLARATION_UNSUPPORTED || code === CODES.RELEASE_EXPECTATION_MISMATCH) return 409;
  if (code === CODES.DISK_SPACE_LOW) return 507;
  return 400;
}

/**
 * 已验成员 parser 的严格预检：只回答“调用方原始输入能否被原合同接受”，不读取
 * 调用方 getter（parser 自己按 descriptor 归一化），也不向调用方抛业务异常。
 * 失败只表示不能进入私有快照；真正的拒绝仍由 evaluateReleaseContract 给固定码。
 */
function isStrictMemberDeclaration(value) {
  try {
    const parsed = parseReleaseMembers(value);
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      parsed.ok === true &&
      parsed.declaration !== null &&
      typeof parsed.declaration === "object"
    );
  } catch {
    return false;
  }
}

function safeRelease(release) {
  const merged = { ...ENGINE_RELEASE, ...release };
  for (const key of ["version", "platform", "arch", "url", "sha256", "binary", "id"]) {
    if (typeof merged[key] !== "string" || !merged[key]) throw new Error(`发布描述缺少 ${key}`);
  }
  if (!/^[0-9a-f]{64}$/.test(merged.sha256)) throw new Error("发布描述 hash 无效");
  for (const key of ["size", "archiveMaxBytes", "extractedMaxBytes", "maxEntries"]) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] <= 0) throw new Error(`发布描述 ${key} 无效`);
  }
  if (merged.size > merged.archiveMaxBytes) throw new Error("发布描述大小超过归档上限");
  const tarCeiling = merged.extractedMaxBytes + TAR_METADATA_ALLOWANCE;
  if (!Number.isSafeInteger(tarCeiling)) throw new Error("发布描述展开上限过大");
  if (merged.tarMaxBytes === undefined) merged.tarMaxBytes = tarCeiling;
  else merged.tarMaxBytes = Math.min(merged.tarMaxBytes, tarCeiling);
  if (!Number.isSafeInteger(merged.tarMaxBytes) || merged.tarMaxBytes <= merged.extractedMaxBytes) {
    throw new Error("发布描述 tarMaxBytes 无效");
  }
  // safeRelease 只浅冻结合并结果；members 是调用方持有的嵌套对象，必须复制成
  // 私有不可变快照。否则构造/后赋后修改原对象会改变 engine.release 的有效声明，
  // 而缓存合同仍是旧值（P2-1）。
  //
  // 复制前必须先用已验严格 parser 校验调用方原始输入（P2 round4）：快照只能收紧
  // 结构，不能“清洗”掉 symbol、数组额外/隐藏字段等原合同应拒绝的内容。若先克隆
  // 再解析，这些字段会在克隆时被丢弃，把非法声明洗成合法并返回 declarationParsed
  // 成功。原始输入不通过时保留原引用，交由合同入口按固定码
  // ENGINE_RELEASE_DECLARATION_INVALID 拒绝，不在这里抛通用异常。
  if (merged.members !== undefined && isStrictMemberDeclaration(merged.members)) {
    merged.members = snapshotPureData(merged.members);
  }
  return Object.freeze(merged);
}

/**
 * 归档身份-only 的既有发布描述。这里只描述“成员元数据不可用”，
 * 绝不把 archive size/hash 当作成员 pin，也不声称成员声明已解析。
 */
const ARCHIVE_ONLY_RELEASE_FACTS = Object.freeze({
  contractVersion: RELEASE_MEMBERS_CONTRACT_VERSION,
  mode: "archive-only",
  format: RELEASE_ARCHIVE_FORMAT,
  memberMetadata: LEGACY_MEMBER_METADATA_UNAVAILABLE,
  declarationParsed: false,
  declarationOnly: false,
  compatibility: null,
  schemaVersion: null,
  memberCount: 0,
  externalPinProvided: false,
  externalPinSource: null,
  archiveSha256Matched: null,
  archiveBytesMatched: null,
  releaseVersionMatched: null,
  membersMatched: null,
  declarationMatchesExternal: null,
  contentVerified: false,
  publisherAuthenticated: false,
  runtimeIdentityVerified: false,
  trusted: false,
});

function releaseDeclarationError(code) {
  return new AudioEngineError(code);
}

/**
 * 受限纯数据快照：成功时返回深冻结的私有副本，调用方之后修改原对象不能改变
 * 已固定的声明/期望；遇到 accessor/自定义原型/循环/共享引用就保留原值，交给
 * 合同入口按固定诊断拒绝，绝不调用 getter。
 */
function snapshotPureData(value) {
  if (value === null || typeof value !== "object") return value;
  try {
    const seen = new Set();
    const clone = (input, depth) => {
      if (input === null || typeof input !== "object") return input;
      if (depth > 16 || seen.has(input)) throw new Error("unsupported");
      seen.add(input);
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype) throw new Error("unsupported");
        // 快照不能丢弃数组上的 symbol/额外/隐藏属性；否则克隆会掩盖原合同应拒绝的
        // 结构。只允许规范索引 + length，其它任何 own 属性都保留原值交给 parser。
        if (Object.getOwnPropertySymbols(input).length !== 0) throw new Error("unsupported");
        const names = Object.getOwnPropertyNames(input);
        if (names.length !== input.length + 1) throw new Error("unsupported");
        for (const key of names) {
          if (key === "length") continue;
          if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length) {
            throw new Error("unsupported");
          }
        }
        const out = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
            throw new Error("unsupported");
          }
          out.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(out);
      }
      const prototype = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("unsupported");
      // 同上：symbol own key 不能被 for...getOwnPropertyNames 静默丢弃。
      if (Object.getOwnPropertySymbols(input).length !== 0) throw new Error("unsupported");
      const out = Object.create(null);
      for (const key of Object.getOwnPropertyNames(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new Error("unsupported");
        }
        Object.defineProperty(out, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return Object.freeze(out);
    };
    return clone(value, 0);
  } catch {
    return value;
  }
}

/**
 * 声明只描述“它自己”；成功消费前必须把声明中的 release/archive 身份绑到当前
 * 实际 safeRelease，并确认声明包含实际 binary 对应的成员。否则声明与外 pin
 * 互相自洽也只是在描述另一个工件（P2-2）。不匹配按声明无效拒绝，不降级成
 * “已解析未匹配”，也不从 archive 字段反推外部成员 pin。
 */
function assertDeclarationBoundToRelease(declaration, release) {
  const bound =
    declaration.release.version === release.version &&
    declaration.release.platform === release.platform &&
    declaration.release.arch === release.arch &&
    declaration.archive.format === RELEASE_ARCHIVE_FORMAT &&
    declaration.archive.bytes === release.size &&
    declaration.archive.sha256 === release.sha256 &&
    declaration.members.some((member) => member.path === release.binary);
  if (!bound) throw releaseDeclarationError(CODES.RELEASE_DECLARATION_INVALID);
}

/**
 * 纯同步评估发布描述中的声明合同；不读 FS/网络/进程，不创建 Agent，不取锁。
 *
 * 支持范围（本票只接声明，不接多成员执行）：
 * - 无 `format`/`members`：原 archive-only 路径，事实为 LEGACY_MEMBER_METADATA_UNAVAILABLE；
 * - `format` 只允许 "tar.gz"；其它值在构造/消费入口直接拒绝；
 * - `members` 交给已验 `audio-release-members.mjs` 解析；
 *   v1 多成员本票明确未获准，直接拒绝；仅 v0 legacy 单成员可作为声明通过；
 * - `memberExpectation` 必须由调用方经独立参数显式提供，绝不从 release 的
 *   archive size/hash 或成员声明自身反向填充；未提供时只解析，不声称 matches。
 */
function evaluateReleaseContract(release, memberExpectation) {
  const hasFormat = release.format !== undefined;
  const hasMembers = release.members !== undefined;
  const hasExpectation = memberExpectation !== undefined && memberExpectation !== null;

  if (!hasMembers) {
    if (hasExpectation) throw releaseDeclarationError(CODES.RELEASE_EXPECTATION_INVALID);
    if (!hasFormat || release.format === RELEASE_ARCHIVE_FORMAT) return ARCHIVE_ONLY_RELEASE_FACTS;
    throw releaseDeclarationError(CODES.RELEASE_DECLARATION_UNSUPPORTED);
  }
  if (hasFormat && release.format !== RELEASE_ARCHIVE_FORMAT) {
    throw releaseDeclarationError(CODES.RELEASE_DECLARATION_UNSUPPORTED);
  }

  const parsed = parseReleaseMembers(release.members);
  if (!parsed || parsed.ok !== true || !parsed.declaration) {
    const parsedCode = parsed && Array.isArray(parsed.errors) && parsed.errors[0]
      ? parsed.errors[0].code
      : null;
    throw releaseDeclarationError(
      RELEASE_MEMBERS_UNSUPPORTED_CODES.has(parsedCode)
        ? CODES.RELEASE_DECLARATION_UNSUPPORTED
        : CODES.RELEASE_DECLARATION_INVALID,
    );
  }
  const declaration = parsed.declaration;
  if (declaration.compatibility !== "legacy-single-member" || declaration.schemaVersion !== 0) {
    throw releaseDeclarationError(CODES.RELEASE_DECLARATION_UNSUPPORTED);
  }
  assertDeclarationBoundToRelease(declaration, release);

  let external = null;
  if (hasExpectation) {
    // 最粗的“把同一 release 的声明对象直接当外部 pin”在读取前拒绝；来源真实性
    // 仍由调用方负责，引擎不声称能证明调用方没有复制值。
    if (memberExpectation === release.members) {
      throw releaseDeclarationError(CODES.RELEASE_EXPECTATION_INVALID);
    }
    const checked = checkExternalExpectation(parsed, memberExpectation);
    if (!checked || checked.ok !== true) {
      const code = checked && Array.isArray(checked.errors) && checked.errors[0]
        ? checked.errors[0].code
        : null;
      throw releaseDeclarationError(
        RELEASE_MEMBERS_MISMATCH_CODES.has(code)
          ? CODES.RELEASE_EXPECTATION_MISMATCH
          : CODES.RELEASE_EXPECTATION_INVALID,
      );
    }
    // 本票要求外部期望必须真正提供成员 bytes/hash；只给 archive pin 不足以
    // 声称成员声明已匹配，按期望无效处理，而不是降级成 parse-only。
    if (checked.facts.membersMatched !== true) {
      throw releaseDeclarationError(CODES.RELEASE_EXPECTATION_INVALID);
    }
    external = checked.facts;
  }

  return Object.freeze({
    contractVersion: RELEASE_MEMBERS_CONTRACT_VERSION,
    mode: "declared-single-member",
    format: declaration.archive.format,
    memberMetadata: DECLARED_MEMBER_METADATA,
    declarationParsed: true,
    declarationOnly: true,
    compatibility: declaration.compatibility,
    schemaVersion: declaration.schemaVersion,
    memberCount: declaration.members.length,
    externalPinProvided: external ? external.externalPinProvided === true : false,
    externalPinSource: external ? external.externalPinSource : null,
    archiveSha256Matched: external ? external.archiveSha256Matched : null,
    archiveBytesMatched: external ? external.archiveBytesMatched : null,
    releaseVersionMatched: external ? external.releaseVersionMatched : null,
    membersMatched: external ? external.membersMatched : null,
    declarationMatchesExternal: external ? external.declarationMatchesExternal : null,
    // 声明元数据一致不等于归档内容、发布者或运行身份已认证。
    contentVerified: false,
    publisherAuthenticated: false,
    runtimeIdentityVerified: false,
    trusted: false,
  });
}

export class AudioEngine {
  #release;
  #releaseContract = null;
  #memberExpectation;
  #activeScopes = 0;

  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    // release setter 需要这些实例状态先就绪；也保证构造期没有任何 FS/网络动作。
    this._state = "idle";
    this._runLease = null;
    this._scopeFaulted = false;
    this.#memberExpectation = options.memberExpectation;
    this.release = options.release;
    // 声明合同必须在读取 CA、创建 Agent 之前完成；multi/unknown 在这里就 fail-closed。
    this.#releaseView();
    // 已验期望冻结为私有快照；后赋 release 仍用这根固定 pin 复核。
    this.#memberExpectation = snapshotPureData(this.#memberExpectation);
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.ca = options.ca !== undefined ? options.ca : fssync.readFileSync(DEFAULT_CA_FILE);
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 600_000;
    this.diskReserveBytes = options.diskReserveBytes ?? 64 * MiB;
    this.diskFreeBytes = options.diskFreeBytes; // 仅测试注入；生产用 statfs
    this.hooks = options.hooks || {};

    this.engineRoot = path.join(dataDir, "engines", "audio");
    this.versionsRoot = path.join(this.engineRoot, "versions");
    this.tmpRoot = path.join(dataDir, "engines", ".tmp");
    this.enginesRoot = path.join(dataDir, "engines");
    this.lockRoot = path.join(this.enginesRoot, ".audio-install.lock");

    this.job = null;
    this._jobSeq = 0;
    this._runPromise = null;
    this._cancelRequested = false;
    this._abort = null;

    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 1,
      maxFreeSockets: 1,
      timeout: this.idleTimeoutMs,
      scheduling: "lifo",
    });
  }

  get release() {
    return this.#release;
  }

  /**
   * 后赋 release 仍走同一 safeRelease 兼容层；声明合同在消费入口（install/run/
   * lifecycle/status）重新评估。安装/运行进行中拒绝替换，避免一份操作混用两份描述。
   */
  set release(value) {
    // 同一份声明对象不能同时冒充“独立外部 pin”。safeRelease 会把 members 复制成
    // 私有快照，因此身份守卫必须在复制前做（构造期 #memberExpectation 仍是原对象）。
    const membersDescriptor =
      value !== null && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "members") : null;
    if (
      membersDescriptor &&
      "value" in membersDescriptor &&
      this.#memberExpectation !== undefined &&
      this.#memberExpectation !== null &&
      membersDescriptor.value === this.#memberExpectation
    ) {
      throw releaseDeclarationError(CODES.RELEASE_EXPECTATION_INVALID);
    }
    const next = safeRelease(value);
    if (this._state !== "idle" || this._runLease || this.#activeScopes > 0) {
      throw new AudioEngineError(CODES.BUSY);
    }
    this.#release = next;
    this.#releaseContract = null;
  }

  /** 当前发布描述的只读合同事实；首次调用时做纯同步解析，失败抛固定码。 */
  get releaseContract() {
    return this.#releaseView();
  }

  #releaseView() {
    if (this.#releaseContract) return this.#releaseContract;
    this.#releaseContract = evaluateReleaseContract(this.#release, this.#memberExpectation);
    return this.#releaseContract;
  }

  /** 已安装版本；只从可信指针 + 安装标记读取。 */
  get version() {
    this.#releaseView();
    return this.#installedInfo()?.version ?? null;
  }

  /** 分析器内部使用的二进制路径；未通过可信链校验时返回 null，不提供越界路径。 */
  get binaryPath() {
    this.#releaseView();
    return this.#installedInfo()?.binaryPath ?? null;
  }

  status() {
    const contract = this.#releaseView();
    const info = this.#installedInfo();
    return {
      installed: !!info,
      version: info?.version ?? null,
      path: null,
      size: info?.size ?? 0,
      job: this.job ? cloneJob(this.job) : null,
      expected: {
        version: this.release.version,
        platform: this.release.platform,
        arch: this.release.arch,
        size: this.release.size,
        sha256: this.release.sha256,
      },
      releaseContract: contract,
    };
  }

  /**
   * 开始安装。必须显式 confirm:true；同一时刻只允许一个安装/取消/卸载。
   * 返回当前状态（job 可能仍在 downloading），不等待完成。
   */
  install({ confirm } = {}) {
    if (confirm !== true) throw new AudioEngineError(CODES.CONFIRM_REQUIRED);
    // 任何安装动作（锁/磁盘/下载）之前先过声明门；后赋 multi/unknown 在这里拒绝。
    this.#releaseView();
    if (this.platform !== this.release.platform || this.arch !== this.release.arch) {
      throw new AudioEngineError(CODES.UNSUPPORTED_PLATFORM);
    }
    if (this._state !== "idle") throw new AudioEngineError(CODES.BUSY);
    if (this.#peekLockBusy()) throw new AudioEngineError(CODES.BUSY);

    const current = this.#installedInfo();
    // 只有带新摘要/generation 的当前元数据才能快速返回。旧平铺/旧 marker 即使版本号
    // 相同也必须走完整归档校验后重装，不能被这里的快速返回挡住元数据升级。
    if (
      current &&
      !current.legacy &&
      current.metadataVersion === INSTALL_METADATA_VERSION &&
      current.version === this.release.version &&
      current.releaseSha256 === this.release.sha256
    ) {
      return this.status();
    }

    this._state = "busy";
    this._cancelRequested = false;
    const id = crypto.randomBytes(12).toString("hex");
    this.job = {
      id,
      state: "queued",
      bytes: 0,
      total: this.release.size,
      progress: 0,
      startedAt: new Date().toISOString(),
      error: null,
    };
    this._runPromise = this.#runInstall(id).catch(() => {});
    return this.status();
  }

  /** 取消当前任务；等待临时目录/网络/锁全部清理后才返回。 */
  async cancel() {
    // 运行租约只请求取消；必须等 callback 真正 settle、锁释放后才返回，不能 Promise.race。
    const lease = this._runLease;
    if (lease) {
      lease.controller.abort();
      await lease.promise.catch(() => {});
      return this.status();
    }

    const running = this._runPromise;
    if (!running) return this.status();
    this._cancelRequested = true;
    if (this._abort) this._abort();
    await running;
    if (this.job && this.job.state !== "installed") {
      this.job = {
        ...this.job,
        state: "cancelled",
        progress: 0,
        error: { code: CODES.CANCELLED, message: MESSAGES[CODES.CANCELLED] },
      };
    }
    return this.status();
  }

  /** 卸载；安装中直接 409，不会先卸载再让安装目录冒出来。 */
  async uninstall() {
    if (this._state !== "idle") throw new AudioEngineError(CODES.BUSY);
    this.#releaseView();
    this._state = "busy";
    let lock = null;
    try {
      await this.#ensureBaseDirs();
      lock = await this.#acquireLock("uninstall");
      await this.#cleanOwnedTmp();
      const root = await lstatOrNull(this.engineRoot);
      if (!root) {
        this.job = null;
        return this.status();
      }
      if (root.isSymbolicLink() || !root.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
      // 先摘掉指针，再删自己目录；即使中途崩溃也不会让旧版本重新“出现”。
      await unlinkRegular(path.join(this.engineRoot, "current.json"));
      await unlinkRegular(path.join(this.engineRoot, this.release.binary));
      await unlinkRegular(path.join(this.engineRoot, ".installed.json"));
      const versions = await lstatOrNull(this.versionsRoot);
      if (versions) {
        if (versions.isSymbolicLink() || !versions.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
        await fs.rm(this.versionsRoot, { recursive: true, force: true });
      }
      await fs.rm(this.engineRoot, { recursive: true, force: true });
      this.job = null;
      return this.status();
    } finally {
      if (lock) await this.#releaseLock(lock).catch(() => {});
      this._state = "idle";
    }
  }

  /**
   * 测试/进程退出时释放连接池；HTTP 不暴露。
   * 对运行租约只调用 AbortController.abort() 请求取消，不强制结束不合作的 callback，
   * 也不同步等待锁释放；调用方应 await 正在进行的 withRunLease 以确认真正释放。
   */
  dispose() {
    if (this._runLease) this._runLease.controller.abort();
    if (this._abort) this._abort();
    this.agent.destroy();
  }

  /**
   * 内部运行租约（T-LOCAL-013C）。
   *
   * 只接受函数 callback，不接受命令/URL/路径；自身不 spawn。callback 收到冻结的
   * 可信 descriptor 和取消信号，必须返回“执行进程 close 且清理结束”后才 settle 的 Promise。
   * 从运行前 hash 校验开始一直持有安装器同一把排他锁，callback 真正结束前不释放；
   * cancel/AbortSignal/dispose 只请求取消，不提前返回或放锁。
   */
  withRunLease(callback, options = {}) {
    const { signal, deadlineAtMs } = options || {};
    if (typeof callback !== "function") {
      return Promise.reject(new AudioEngineError(CODES.INVALID_CALLBACK));
    }
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    ) {
      return Promise.reject(new AudioEngineError(CODES.INVALID_CALLBACK));
    }
    if (signal?.aborted) return Promise.reject(new AudioEngineError(CODES.CANCELLED));
    if (this._scopeFaulted) return Promise.reject(new AudioEngineError(CODES.BUSY));
    if (this._runLease) return Promise.reject(new AudioEngineError(CODES.BUSY));
    // 运行租约取锁/读 FS 之前先过声明门；不拿漏过的 multi/unknown 去碰实际安装。
    try {
      this.#releaseView();
    } catch (error) {
      return Promise.reject(error);
    }

    const controller = new AbortController();
    const entry = { controller, promise: null };
    this._runLease = entry;
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    let work;
    if (deadlineAtMs === undefined) {
      // 旧入口兼容：行为、错误码、顺序、锁/owner 格式保持今日语义，不纳入新账本。
      work = this.#withRunLeaseLegacy(callback, controller.signal);
    } else if (!Number.isFinite(deadlineAtMs)) {
      work = Promise.reject(new AudioEngineError(CODES.INVALID_CALLBACK));
    } else {
      work = this.#withRunLeaseScoped(callback, controller.signal, deadlineAtMs);
    }
    const promise = work.finally(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (this._runLease === entry) this._runLease = null;
    });
    entry.promise = promise;
    return promise;
  }

  /**
   * 内部 lifecycle scope：同一把 `.audio-install.lock`，不要求 run record/已安装。
   * 只用于 pipeline 原 probe 位置与 scoped run；独立 AudioProbe 直接调用不在此列。
   * 所有 scope 获取/释放 FS 调用发起前登记 pending，并受同一 mono deadline 约束。
   */
  withLifecycleScope(callback, options = {}) {
    const { scope = "probe", signal, deadlineAtMs } = options || {};
    if (typeof callback !== "function") {
      return Promise.reject(new AudioEngineError(CODES.INVALID_CALLBACK));
    }
    if (scope !== "probe" && scope !== "run") {
      return Promise.reject(new AudioEngineError(CODES.INVALID_CALLBACK));
    }
    if (!Number.isFinite(deadlineAtMs)) {
      return Promise.reject(new AudioEngineError(CODES.INVALID_CALLBACK));
    }
    if (
      signal !== undefined &&
      (!signal ||
        typeof signal.aborted !== "boolean" ||
        typeof signal.addEventListener !== "function" ||
        typeof signal.removeEventListener !== "function")
    ) {
      return Promise.reject(new AudioEngineError(CODES.INVALID_CALLBACK));
    }
    if (signal?.aborted) return Promise.reject(new AudioEngineError(CODES.CANCELLED));
    if (this._scopeFaulted) return Promise.reject(new AudioEngineError(CODES.BUSY));
    try {
      this.#releaseView();
    } catch (error) {
      return Promise.reject(error);
    }
    this.#activeScopes += 1;
    try {
      const promise = this.#withLifecycleScope(callback, { scope, signal, deadlineAtMs });
      return promise.finally(() => {
        this.#activeScopes -= 1;
      });
    } catch (error) {
      this.#activeScopes -= 1;
      return Promise.reject(error);
    }
  }

  async #withRunLeaseScoped(callback, signal, deadlineAtMs) {
    return this.withLifecycleScope(
      async (guard) => {
        const enginesStat = await lstatOrNull(this.enginesRoot);
        if (!enginesStat) throw new AudioEngineError(CODES.NOT_INSTALLED);
        if (enginesStat.isSymbolicLink() || !enginesStat.isDirectory()) {
          throw new AudioEngineError(CODES.UNSAFE_TARGET);
        }
        if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);
        const record = await this.#loadRunRecord();
        if (!record) throw new AudioEngineError(CODES.NOT_INSTALLED);
        if (record.legacy) throw new AudioEngineError(CODES.REINSTALL_REQUIRED);
        const descriptor = await this.#verifyRunDescriptor(record, signal);
        if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);
        try {
          Object.defineProperty(signal, "signal", { value: signal, configurable: true });
        } catch {}
        const result = await this.#invokeRunCallback(callback, descriptor, signal, guard);
        if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);
        return result;
      },
      { scope: "run", signal, deadlineAtMs },
    );
  }

  /** 今日原路径：保留原获取/校验/释放顺序，不接新 deadline/pending/迟到接管。 */
  async #withRunLeaseLegacy(callback, signal) {
    let lock = null;
    try {
      const enginesStat = await lstatOrNull(this.enginesRoot);
      if (!enginesStat) throw new AudioEngineError(CODES.NOT_INSTALLED);
      if (enginesStat.isSymbolicLink() || !enginesStat.isDirectory()) {
        throw new AudioEngineError(CODES.UNSAFE_TARGET);
      }
      // 先占锁，再做指针/marker/路径链/摘要校验；不在校验后再补一把“运行锁”，
      // 因而安装/卸载/第二次运行都只能通过同一个排他 mkdir 竞争。
      lock = await this.#acquireLock("run");
      if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);

      const record = await this.#loadRunRecord();
      if (!record) throw new AudioEngineError(CODES.NOT_INSTALLED);
      if (record.legacy) throw new AudioEngineError(CODES.REINSTALL_REQUIRED);
      const descriptor = await this.#verifyRunDescriptor(record, signal);
      if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);

      // 第二参数直接是取消信号；同时带一个自引用 .signal，兼容 `{ signal }` 解构。
      try {
        Object.defineProperty(signal, "signal", { value: signal, configurable: true });
      } catch {}
      const result = await this.#invokeRunCallback(callback, descriptor, signal, null);
      if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);
      return result;
    } catch (error) {
      if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);
      if (isAudioEngineError(error)) throw error;
      throw new AudioEngineError(CODES.RUN_FAILED);
    } finally {
      if (lock) {
        try {
          // 释放失败/归属不明必须 fail-closed：保留锁并返回固定码，不假装已恢复可运行。
          await this.#releaseLock(lock, { strict: true });
        } catch {
          throw new AudioEngineError(CODES.LOCK_FAILED);
        }
      }
    }
  }

  async #withLifecycleScope(callback, { scope, signal, deadlineAtMs }) {
    const attempt = {
      scope,
      entryAtMono: monoNow(),
      deadlineAtMs,
      ownerToken: crypto.randomBytes(16).toString("hex"),
      root: { state: "not-started", dev: null, ino: null, late: false },
      lock: { state: "not-started", dev: null, ino: null, late: false, ownerWritten: false },
      ops: new Set(),
      faulted: false,
      faultReason: null,
      guard: null,
      ownerRemovedLate: false,
      releasedLate: false,
      releaseFailedLate: false,
      closeFailed: false,
    };
    const beginOp = (kind) => {
      const op = { kind, settled: false, late: false, outcome: null };
      attempt.ops.add(op);
      return op;
    };
    const settleOp = (op, outcome) => {
      if (!op || op.settled) return;
      op.settled = true;
      op.outcome = outcome;
      if (!op.late) attempt.ops.delete(op);
    };
    const runFs = (kind, fn) => {
      const hook = this.hooks?.scopeFs;
      if (typeof hook === "function") return hook(kind, fn);
      return fn();
    };
    const scopeFailure = (code, reason, extra = {}) => {
      const error = new AudioEngineError(code);
      error.evidence = {
        scope,
        scopeAcquire: attempt.lock.state === "owned" ? "ok" : "unknown",
        ownerToken: attempt.ownerToken,
        pending: [...attempt.ops].filter((op) => !op.settled).map((op) => op.kind),
        faulted: attempt.faulted,
        reason,
        ...extra,
      };
      return error;
    };
    const lockFailed = (reason, extra = {}) => {
      attempt.faulted = true;
      attempt.faultReason = reason;
      attempt.lock.state = attempt.lock.state === "owned" ? "held" : attempt.lock.state;
      return scopeFailure(CODES.LOCK_FAILED, reason, extra);
    };

    let guard = null;
    try {
      try {
        // enginesRoot：lstat 只读检查；absent 才登记 ensure-root 后非递归 mkdir。
        let rootStat = await runFs("root-lstat", () => lstatOrNull(this.enginesRoot));
        if (signal?.aborted) throw new AudioEngineError(CODES.CANCELLED);
        if (!rootStat) {
          attempt.root.state = "creating";
          const op = beginOp("ensure-root");
          const promise = runFs("root-mkdir", () => fs.mkdir(this.enginesRoot, { mode: 0o700 })).catch(
            (error) => {
              // 并发创建：EEXIST 由后续 lstat 复核必须是普通目录；其它失败保持 unknown。
              if (error?.code === "EEXIST") return null;
              throw new AudioEngineError(CODES.LOCK_FAILED);
            },
          );
          const outcome = await raceBudget(promise, remaining(attempt.deadlineAtMs));
          if (outcome === SCOPE_BUDGET_EXHAUSTED) {
            op.late = true;
            attempt.root.state = "unknown";
            promise.then(
              async () => {
                const created = await lstatOrNull(this.enginesRoot);
                if (created && created.isDirectory() && !created.isSymbolicLink()) {
                  attempt.root.dev = created.dev;
                  attempt.root.ino = created.ino;
                  attempt.root.late = true;
                  attempt.root.state = "present";
                }
                settleOp(op, { ok: true });
              },
              () => {},
            );
            throw lockFailed("SCOPE_ROOT_DEADLINE", { op: "ensure-root" });
          }
          settleOp(op, { ok: true });
          rootStat = await lstatOrNull(this.enginesRoot);
        }
        if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
          throw new AudioEngineError(CODES.UNSAFE_TARGET);
        }
        attempt.root.state = "present";
        attempt.root.dev = rootStat.dev;
        attempt.root.ino = rootStat.ino;
        if (remaining(attempt.deadlineAtMs) <= 0) throw lockFailed("SCOPE_DEADLINE", { op: "before-lock" });

        // 排他 mkdir lock；EEXIST 等一律 BUSY，不写 owner、不删除、不重试。
        attempt.lock.state = "mkdir-pending";
        const mkdirOp = beginOp("mkdir-lock");
        const mkdirPromise = runFs("lock-mkdir", () => fs.mkdir(this.lockRoot, { mode: 0o700 })).catch(
          (error) => {
            if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error?.code)) {
              throw new AudioEngineError(CODES.BUSY);
            }
            throw new AudioEngineError(CODES.LOCK_FAILED);
          },
        );
        const acquired = await raceBudget(mkdirPromise, remaining(attempt.deadlineAtMs));
        if (acquired === SCOPE_BUDGET_EXHAUSTED) {
          mkdirOp.late = true;
          attempt.lock.state = "acquire-unknown";
          // 迟到成功只留空锁（不补 owner/open/write/fsync/close），交人工恢复。
          mkdirPromise.then(
            async () => {
              const created = await lstatOrNull(this.lockRoot);
              if (created && created.isDirectory() && !created.isSymbolicLink()) {
                attempt.lock.state = "empty-lock-late";
                attempt.lock.dev = created.dev;
                attempt.lock.ino = created.ino;
                attempt.lock.late = true;
              }
              settleOp(mkdirOp, { ok: true });
            },
            (error) => {
              if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error?.code)) {
                attempt.lock.state = "busy-late";
              }
              settleOp(mkdirOp, { ok: false, error });
            },
          );
          throw lockFailed("SCOPE_ACQUIRE_DEADLINE", { op: "mkdir-lock" });
        }
        settleOp(mkdirOp, { ok: true });

        const lockStat = await lstatOrNull(this.lockRoot);
        if (!lockStat || lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
          throw lockFailed("SCOPE_LOCK_UNSAFE", { op: "mkdir-lock" });
        }
        attempt.lock.dev = lockStat.dev;
        attempt.lock.ino = lockStat.ino;
        attempt.lock.state = "mkdir-created";

        // owner.json：open/write/fsync/close 逐项发起前登记；迟到 fd 仍负责 close。
        attempt.lock.state = "owner-pending";
        const ownerPath = path.join(this.lockRoot, "owner.json");
        const ownerBody = JSON.stringify({
          pid: process.pid,
          jobId: scope,
          token: attempt.ownerToken,
          startedAt: new Date().toISOString(),
        });
        let handle = null;
        const openOp = beginOp("owner-open");
        const openPromise = runFs("owner-open", () => fs.open(ownerPath, "wx", 0o600));
        const opened = await raceBudget(openPromise, remaining(attempt.deadlineAtMs));
        if (opened === SCOPE_BUDGET_EXHAUSTED) {
          openOp.late = true;
          openPromise.then(
            (lateHandle) => {
              settleOp(openOp, { ok: true, lateFd: true });
              lateHandle.close().catch(() => {
                attempt.closeFailed = true;
              });
            },
            () => {},
          );
          throw lockFailed("SCOPE_OWNER_OPEN_DEADLINE", { op: "owner-open" });
        }
        handle = opened;
        settleOp(openOp, { ok: true });

        const writeOp = beginOp("owner-write");
        const written = await raceBudget(
          handle.writeFile(ownerBody, { encoding: "utf8" }),
          remaining(attempt.deadlineAtMs),
        );
        if (written === SCOPE_BUDGET_EXHAUSTED) {
          writeOp.late = true;
          Promise.resolve(handle.close()).catch(() => {
            attempt.closeFailed = true;
          });
          throw lockFailed("SCOPE_OWNER_WRITE_DEADLINE", { op: "owner-write" });
        }
        settleOp(writeOp, { ok: true });

        const closeOp = beginOp("owner-close");
        const closed = await raceBudget(handle.close(), remaining(attempt.deadlineAtMs));
        if (closed === SCOPE_BUDGET_EXHAUSTED) {
          closeOp.late = true;
          throw lockFailed("SCOPE_OWNER_CLOSE_DEADLINE", { op: "owner-close" });
        }
        settleOp(closeOp, { ok: true });
        attempt.lock.state = "owned";
        attempt.lock.ownerWritten = true;

        const pendingResources = new Set();
        guard = {
          retained: false,
          retainReason: null,
          retain(reason) {
            this.retained = true;
            this.retainReason = typeof reason === "string" && reason ? reason : "resource-unknown";
            attempt.lock.state = "held";
          },
          track(kind) {
            pendingResources.add(String(kind));
          },
          settle(kind) {
            pendingResources.delete(String(kind));
          },
          get pending() {
            return new Set(pendingResources);
          },
          get evidence() {
            return {
              scope,
              ownerToken: attempt.ownerToken,
              pending: [...pendingResources],
              faulted: attempt.faulted,
            };
          },
        };
        attempt.guard = guard;
      } catch (error) {
        if (isAudioEngineError(error) && error.code === CODES.BUSY) {
          attempt.faulted = false;
          throw error;
        }
        if (isAudioEngineError(error)) {
          // 确定性目标错误不 latch 实例故障门；只有 unknown/获取失败才 fail-closed。
          attempt.faulted = error.code !== CODES.UNSAFE_TARGET;
          if (!error.evidence) {
            error.evidence = {
              scope,
              scopeAcquire: "unknown",
              ownerToken: attempt.ownerToken,
              pending: [...attempt.ops].filter((op) => !op.settled).map((op) => op.kind),
              faulted: true,
            };
          }
          throw error;
        }
        throw lockFailed("SCOPE_ACQUIRE_FAILED");
      }
      return await callback(guard);
    } finally {
      if (guard?.retained) {
        attempt.lock.state = "held";
      } else if (attempt.lock.state === "owned") {
        try {
          await this.#releaseScope(attempt, guard, runFs);
        } catch (error) {
          attempt.faulted = true;
          this._scopeFaulted = true;
          throw isAudioEngineError(error) ? error : new AudioEngineError(CODES.LOCK_FAILED);
        }
      } else if (attempt.lock.state === "empty-lock-late") {
        // 空锁保留，交人工；不改写证据、不 release、不新发起 owner 写入。
      } else if (["acquire-unknown", "owner-pending", "release-pending"].includes(attempt.lock.state)) {
        attempt.lock.state = "held";
      }
      if (attempt.faulted) this._scopeFaulted = true;
    }
  }

  async #releaseScope(attempt, guard, runFs = (_kind, fn) => fn()) {
    const lockFailed = (reason, extra = {}) => {
      attempt.faulted = true;
      attempt.faultReason = reason;
      attempt.lock.state = "release-pending";
      const error = new AudioEngineError(CODES.LOCK_FAILED);
      error.evidence = {
        scope: attempt.scope,
        ownerToken: attempt.ownerToken,
        scopeRelease: "pending",
        reason,
        ...extra,
      };
      return error;
    };
    if (remaining(attempt.deadlineAtMs) <= 0) throw lockFailed("RELEASE_DEADLINE");
    attempt.lock.state = "releasing";

    const before = await lstatOrNull(this.lockRoot);
    if (!before) throw lockFailed("RELEASE_LOCK_MISSING");
    if (before.isSymbolicLink() || !before.isDirectory()) throw lockFailed("RELEASE_LOCK_UNSAFE");
    if (attempt.lock.dev !== null && (before.dev !== attempt.lock.dev || before.ino !== attempt.lock.ino)) {
      throw lockFailed("RELEASE_LOCK_REPLACED");
    }
    const raw = await readSmallText(path.join(this.lockRoot, "owner.json"), MAX_METADATA_BYTES);
    if (raw === null) throw lockFailed("OWNER_MISMATCH");
    let owner;
    try {
      owner = sanitizeLockOwner(JSON.parse(raw));
    } catch {
      owner = null;
    }
    if (!owner || owner.token !== attempt.ownerToken) throw lockFailed("OWNER_MISMATCH");
    const entries = await fs.readdir(this.lockRoot).catch(() => null);
    if (!entries || entries.length !== 1 || entries[0] !== "owner.json") {
      throw lockFailed("OWNER_MISMATCH");
    }
    const afterRead = await lstatOrNull(this.lockRoot);
    if (!afterRead || afterRead.dev !== before.dev || afterRead.ino !== before.ino) {
      throw lockFailed("RELEASE_LOCK_REPLACED");
    }
    const ownerStat = await lstatOrNull(path.join(this.lockRoot, "owner.json"));
    if (!ownerStat || ownerStat.isSymbolicLink() || !ownerStat.isFile()) {
      throw lockFailed("OWNER_MISMATCH");
    }

    const unlinkOp = { kind: "release-unlink", settled: false, late: false, outcome: null };
    attempt.ops.add(unlinkOp);
    const unlinkPromise = runFs("release-unlink", () => fs.unlink(path.join(this.lockRoot, "owner.json")));
    const unlinked = await raceBudget(unlinkPromise, remaining(attempt.deadlineAtMs));
    if (unlinked === SCOPE_BUDGET_EXHAUSTED) {
      unlinkOp.late = true;
      unlinkPromise.then(
        () => {
          attempt.ownerRemovedLate = true;
          unlinkOp.settled = true;
          unlinkOp.outcome = { ok: true, late: true };
        },
        () => {
          attempt.releaseFailedLate = true;
          unlinkOp.settled = true;
          unlinkOp.outcome = { ok: false, late: true };
        },
      );
      throw lockFailed("RELEASE_UNLINK_DEADLINE");
    }
    unlinkOp.settled = true;
    attempt.ops.delete(unlinkOp);

    const rmdirOp = { kind: "release-rmdir", settled: false, late: false, outcome: null };
    attempt.ops.add(rmdirOp);
    const rmdirPromise = runFs("release-rmdir", () => fs.rmdir(this.lockRoot));
    const removed = await raceBudget(rmdirPromise, remaining(attempt.deadlineAtMs));
    if (removed === SCOPE_BUDGET_EXHAUSTED) {
      rmdirOp.late = true;
      rmdirPromise.then(
        () => {
          attempt.releasedLate = true;
          rmdirOp.settled = true;
          rmdirOp.outcome = { ok: true, late: true };
        },
        () => {
          attempt.releaseFailedLate = true;
          rmdirOp.settled = true;
          rmdirOp.outcome = { ok: false, late: true };
        },
      );
      throw lockFailed("RELEASE_RMDIR_DEADLINE");
    }
    rmdirOp.settled = true;
    attempt.ops.delete(rmdirOp);
    attempt.lock.state = "released";
  }

  /**
   * callback 错误边界：安装器内部错误（指针/路径/摘要/锁）仍按原固定码抛出；
   * callback 自己的异常只允许列表内的 code，并用默认文案与默认 status 重建，
   * 不透传 message/code/status，避免私有路径随错误外泄。
   */
  async #invokeRunCallback(callback, descriptor, signal, guard) {
    try {
      return await callback(descriptor, signal);
    } catch (error) {
      // D10：retain 由实际 pending/unknown 证据决定，不再按“非白名单”一刀切。
      const evidence = error && typeof error === "object" ? error.evidence : null;
      if (
        guard &&
        (guard.retained ||
          guard.pending.size > 0 ||
          evidence?.resourceUnknown === true ||
          evidence?.closeSettled === false)
      ) {
        guard.retain("callback-resource-unknown");
      }
      if (isAudioEngineError(error) && CALLBACK_ERROR_CODES.has(error.code)) {
        const mapped = new AudioEngineError(error.code);
        if (evidence) mapped.evidence = evidence;
        throw mapped;
      }
      const mapped = new AudioEngineError(CODES.RUN_FAILED);
      if (evidence) mapped.evidence = evidence;
      throw mapped;
    }
  }

  /** 读取并校验运行所需的指针/marker/路径链；只做结构性校验，不 hash。 */
  async #loadRunRecord() {
    const release = this.release;
    if (this.platform !== release.platform || this.arch !== release.arch) {
      throw new AudioEngineError(CODES.UNSUPPORTED_PLATFORM);
    }
    for (const dir of [this.enginesRoot, this.engineRoot]) {
      const stat = await lstatOrNull(dir);
      if (!stat) return null;
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
    }

    const pointerPath = path.join(this.engineRoot, "current.json");
    const pointerStat = await lstatOrNull(pointerPath);
    if (!pointerStat) return this.#loadLegacyRunRecord();
    if (pointerStat.isSymbolicLink() || !pointerStat.isFile() || pointerStat.size > MAX_METADATA_BYTES) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    const pointer = await readSmallJson(pointerPath, MAX_METADATA_BYTES);
    if (!isValidPointer(pointer, release.binary)) throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    if (pointer.version !== release.version || pointer.releaseSha256 !== release.sha256) {
      throw new AudioEngineError(CODES.RELEASE_MISMATCH);
    }

    const versionsStat = await lstatOrNull(this.versionsRoot);
    if (!versionsStat) throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    if (versionsStat.isSymbolicLink() || !versionsStat.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
    const versionDir = path.join(this.versionsRoot, pointer.dir);
    const dirStat = await lstatOrNull(versionDir);
    if (!dirStat) throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);

    const binary = path.join(versionDir, pointer.binary);
    // 用 bigint lstat 一次性取回 dev/ino/size/mtime/ctime 身份；后续 open 后 fstat、
    // hash 后路径 lstat 与重读记录都必须与该独立快照完全一致。只比 size 无法发现
    // “rename 后写入同内容新 inode”的替换。
    const binaryStat = await lstatOrNull(binary, { bigint: true });
    if (!binaryStat || binaryStat.isSymbolicLink() || !binaryStat.isFile()) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    const binarySize = Number(binaryStat.size);
    if (!Number.isSafeInteger(binarySize) || binarySize <= 0 || binarySize > release.extractedMaxBytes) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }

    const markerPath = path.join(versionDir, ".installed.json");
    const markerStat = await lstatOrNull(markerPath);
    if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_METADATA_BYTES) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    const marker = await readSmallJson(markerPath, MAX_METADATA_BYTES);
    if (!marker || typeof marker !== "object") throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    if (
      marker.version !== pointer.version ||
      marker.releaseSha256 !== pointer.releaseSha256 ||
      marker.binary !== pointer.binary
    ) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }

    const pointerVersion = pointer.metadataVersion;
    const markerVersion = marker.metadataVersion;
    const legacyMeta = (value) => value === undefined || value === 1;
    if (legacyMeta(pointerVersion) && legacyMeta(markerVersion)) {
      return {
        legacy: true,
        metadataVersion: null,
        binaryPath: binary,
        version: pointer.version,
        releaseSha256: pointer.releaseSha256,
      };
    }
    if (pointerVersion !== INSTALL_METADATA_VERSION || markerVersion !== INSTALL_METADATA_VERSION) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    if (!isSha256Hex(marker.binarySha256) || marker.binarySha256 !== pointer.binarySha256) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    if (!isGeneration(marker.generation) || marker.generation !== pointer.generation) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    if (
      !Number.isSafeInteger(marker.binarySize) ||
      marker.binarySize <= 0 ||
      marker.binarySize !== pointer.binarySize ||
      marker.binarySize !== binarySize
    ) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    if (marker.archiveBytes !== undefined && marker.archiveBytes !== release.size) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }

    return {
      legacy: false,
      metadataVersion: INSTALL_METADATA_VERSION,
      version: pointer.version,
      releaseSha256: pointer.releaseSha256,
      binarySha256: marker.binarySha256,
      binarySize: marker.binarySize,
      generation: marker.generation,
      binaryPath: binary,
      binaryIdentity: statIdentity(binaryStat),
      dir: pointer.dir,
      binary: pointer.binary,
    };
  }

  /** 旧平铺安装只用于 status 兼容；运行一律要求显式重装，不拿现有文件 hash 自动补信任。 */
  async #loadLegacyRunRecord() {
    const release = this.release;
    const versionsStat = await lstatOrNull(this.versionsRoot);
    if (versionsStat && (versionsStat.isSymbolicLink() || !versionsStat.isDirectory())) {
      throw new AudioEngineError(CODES.UNSAFE_TARGET);
    }
    const binary = path.join(this.engineRoot, release.binary);
    const binaryStat = await lstatOrNull(binary);
    const markerPath = path.join(this.engineRoot, ".installed.json");
    const markerStat = await lstatOrNull(markerPath);
    if (!binaryStat && !markerStat) return null;
    if (!binaryStat || binaryStat.isSymbolicLink() || !binaryStat.isFile()) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    if (binaryStat.size <= 0 || binaryStat.size > release.extractedMaxBytes) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_METADATA_BYTES) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    const marker = await readSmallJson(markerPath, MAX_METADATA_BYTES);
    if (!marker || marker.sha256 !== release.sha256) throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    if (typeof marker.version !== "string" || marker.version.length === 0) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    if (marker.binary !== undefined && marker.binary !== release.binary) {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    return {
      legacy: true,
      metadataVersion: null,
      version: marker.version,
      releaseSha256: release.sha256,
      binaryPath: binary,
    };
  }

  /** 在已持锁状态下流式校验二进制，成功后返回冻结 descriptor。 */
  async #verifyRunDescriptor(record, signal) {
    const release = this.release;
    let handle;
    try {
      const flags =
        fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0) | (fssync.constants.O_NONBLOCK || 0);
      handle = await fs.open(record.binaryPath, flags);
    } catch {
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    }
    try {
      const before = await handle.stat().catch(() => null);
      if (!before || !before.isFile()) throw new AudioEngineError(CODES.INTEGRITY_FAILED);
      if (before.size !== record.binarySize || before.size <= 0 || before.size > release.extractedMaxBytes) {
        throw new AudioEngineError(CODES.INTEGRITY_FAILED);
      }
      // 打开后的 fstat 必须与 #loadRunRecord 保存的独立身份一致：lstat 与 open 之间
      // 被 rename 成同内容新 inode（或原位改动）时，dev/ino/mtime/ctime 会变化。
      const openedIdentity = statIdentity(await handle.stat({ bigint: true }));
      if (!sameFileIdentity(openedIdentity, record.binaryIdentity)) {
        throw new AudioEngineError(CODES.INTEGRITY_FAILED);
      }
      const hashed = await hashOpenHandle(handle, {
        before,
        expectedSize: before.size,
        signal,
        code: CODES.INTEGRITY_FAILED,
        onChunk: async (progress) => {
          if (typeof this.hooks.runtimeHashChunk === "function") await this.hooks.runtimeHashChunk(progress);
        },
      });
      if (hashed.sha256 !== record.binarySha256) throw new AudioEngineError(CODES.INTEGRITY_FAILED);

      // 打开的文件句柄与路径必须仍指向同一个普通文件；期间被 rename/替换/原位修改都拒绝。
      const pathStat = await lstatOrNull(record.binaryPath, { bigint: true });
      if (!pathStat || pathStat.isSymbolicLink() || !pathStat.isFile()) {
        throw new AudioEngineError(CODES.INTEGRITY_FAILED);
      }
      if (!sameFileIdentity(statIdentity(pathStat), record.binaryIdentity)) {
        throw new AudioEngineError(CODES.INTEGRITY_FAILED);
      }
      // hash 结束后句柄身份仍必须与打开前/加载时一致。
      const finalIdentity = statIdentity(await handle.stat({ bigint: true }));
      if (!sameFileIdentity(finalIdentity, record.binaryIdentity)) {
        throw new AudioEngineError(CODES.INTEGRITY_FAILED);
      }
      if (signal.aborted) throw new AudioEngineError(CODES.CANCELLED);

      // hash 期间指针/marker 可能被替换；重新读取并要求 generation/摘要/路径/身份完全一致。
      const again = await this.#loadRunRecord();
      if (
        !again ||
        again.legacy ||
        again.generation !== record.generation ||
        again.binarySha256 !== record.binarySha256 ||
        again.binarySize !== record.binarySize ||
        again.binaryPath !== record.binaryPath ||
        again.releaseSha256 !== record.releaseSha256 ||
        !sameFileIdentity(again.binaryIdentity, record.binaryIdentity)
      ) {
        throw new AudioEngineError(CODES.INTEGRITY_FAILED);
      }

      return Object.freeze({
        version: release.version,
        platform: release.platform,
        arch: release.arch,
        releaseSha256: release.sha256,
        binarySha256: record.binarySha256,
        binarySize: record.binarySize,
        generation: record.generation,
        binaryPath: record.binaryPath,
      });
    } catch (error) {
      if (isAudioEngineError(error)) throw error;
      throw new AudioEngineError(CODES.INTEGRITY_FAILED);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  async #runInstall(jobId) {
    let tmpDir = null;
    let staging = null;
    let lock = null;
    let terminalState = null;
    let terminalError = null;
    try {
      await this.#ensureBaseDirs();
      lock = await this.#acquireLock(jobId);
      await this.#cleanOwnedTmp();
      await this.#checkDiskSpace();

      this.#setJobState("downloading");
      tmpDir = await fs.mkdtemp(path.join(this.tmpRoot, TMP_JOB_PREFIX));
      await fs.chmod(tmpDir, 0o700);
      await this.#writeTmpOwner(tmpDir, jobId);
      const archive = path.join(tmpDir, "release.tar.gz");
      const downloaded = await this.#download(archive);
      this._abort = null;

      this.#throwIfCancelled();
      this.#setJobState("verifying");
      const stat = await fs.lstat(archive);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== this.release.size) {
        throw new AudioEngineError(CODES.LENGTH_MISMATCH);
      }
      if (downloaded.sha256 !== this.release.sha256) throw new AudioEngineError(CODES.HASH_MISMATCH);

      this.#throwIfCancelled();
      this.#setJobState("extracting");
      staging = path.join(tmpDir, "staging");
      await fs.mkdir(staging, { mode: 0o700 });
      await this.#extract(archive, staging);
      this._abort = null;
      if (this.hooks.afterExtract) await this.hooks.afterExtract({ staging, tmpDir });
      this.#throwIfCancelled();

      const binary = path.join(staging, this.release.binary);
      const binaryStat = await fs.lstat(binary);
      if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new AudioEngineError(CODES.ARCHIVE_UNSAFE);
      if (binaryStat.size <= 0 || binaryStat.size > this.release.extractedMaxBytes) {
        throw new AudioEngineError(CODES.ARCHIVE_TOO_LARGE);
      }
      await fs.chmod(binary, 0o755);

      if (this.hooks.beforeCommit) await this.hooks.beforeCommit({ staging, tmpDir });
      this.#throwIfCancelled();
      this.#setJobState("installing");
      await this.#commit(staging, jobId);
      staging = null;
      terminalState = "installed";
    } catch (error) {
      const normalized = normalizeError(error, this._cancelRequested);
      terminalState = normalized.code === CODES.CANCELLED ? "cancelled" : "error";
      terminalError = { code: normalized.code, message: normalized.message };
      console.error(`[audio-engine] ${normalized.code}`);
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (lock) await this.#releaseLock(lock).catch(() => {});
      // 清理完成后再公布终态，避免测试/调用方看到 error 时锁还没释放。
      this.job = {
        ...(this.job || { id: jobId, total: this.release.size, bytes: 0 }),
        state: terminalState || "error",
        bytes: terminalState === "installed" ? this.release.size : this.job?.bytes || 0,
        total: this.release.size,
        progress: terminalState === "installed" ? 100 : 0,
        error: terminalError,
      };
      this._cancelRequested = false;
      this._abort = null;
      this._runPromise = null;
      this._state = "idle";
    }
  }

  #throwIfCancelled() {
    if (this._cancelRequested) throw new AudioEngineError(CODES.CANCELLED);
  }

  #setJobState(state) {
    if (!this.job) return;
    this.job = { ...this.job, state };
  }

  async #checkDiskSpace() {
    const free = await this.#freeBytes();
    const required = this.release.size * 2 + this.diskReserveBytes;
    if (!Number.isFinite(free) || free < required) throw new AudioEngineError(CODES.DISK_SPACE_LOW);
  }

  async #freeBytes() {
    if (typeof this.diskFreeBytes === "function") return await this.diskFreeBytes();
    if (typeof this.diskFreeBytes === "number") return this.diskFreeBytes;
    const stats = await fs.statfs(this.dataDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  async #ensureBaseDirs() {
    await fs.mkdir(this.enginesRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.#assertOwnedDir(this.enginesRoot);
    await fs.mkdir(this.engineRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.#assertOwnedDir(this.engineRoot);
    await fs.mkdir(this.tmpRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.#assertOwnedDir(this.tmpRoot);
  }

  async #assertOwnedDir(dir) {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
  }

  async #cleanOwnedTmp() {
    // engines/.tmp 可能与其它引擎/任务共享。只处理本安装器前缀的私有任务目录，
    // 且必须同时满足：非链接目录 + owner 标记格式有效 + 记录进程已死。
    // 未知目录、无标记目录、仍存活的进程目录一律保留（fail-closed）。
    const entries = await fs.readdir(this.tmpRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.name.startsWith(TMP_JOB_PREFIX)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(this.tmpRoot, entry.name);
      const owner = await readTmpOwner(dir);
      if (!owner) continue;
      if (isProcessAlive(owner.pid)) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #writeTmpOwner(dir, jobId) {
    const owner = {
      kind: TMP_OWNER_KIND,
      pid: process.pid,
      jobId,
      token: crypto.randomBytes(16).toString("hex"),
      startedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, TMP_OWNER_FILE), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  }

  #download(dest) {
    const release = this.release;
    const url = new URL(release.url);
    if (url.protocol !== "https:") throw new AudioEngineError(CODES.HTTP_STATUS);

    return new Promise((resolve, reject) => {
      let settled = false;
      let received = 0;
      let req = null;
      let res = null;
      let out = null;
      let totalTimer = null;
      const hash = crypto.createHash("sha256");

      const cleanup = () => {
        if (totalTimer) clearTimeout(totalTimer);
        if (req) {
          try {
            req.setTimeout(0);
          } catch {}
          req.destroy();
        }
        if (res) res.destroy();
        if (out) out.destroy();
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      };
      const fail = (code, message) => finish(new AudioEngineError(code, message));

      this._abort = () => {
        fail(CODES.CANCELLED);
      };

      try {
        req = https.request(
          url,
          {
            method: "GET",
            agent: this.agent,
            ca: this.ca,
            rejectUnauthorized: true,
            timeout: this.idleTimeoutMs,
            headers: {
              accept: "application/octet-stream",
              "accept-encoding": "identity",
              "user-agent": "shiguang-audio-installer/1",
            },
          },
          (response) => {
            res = response;
            if (this._cancelRequested) return fail(CODES.CANCELLED);
            if (res.statusCode !== 200) {
              res.resume();
              return fail(CODES.HTTP_STATUS);
            }
            const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
            if (encoding && encoding !== "identity") return fail(CODES.CONTENT_ENCODING);
            const transfer = String(res.headers["transfer-encoding"] || "").toLowerCase();
            if (transfer && transfer !== "identity") return fail(CODES.LENGTH_MISMATCH);
            const rawLength = String(res.headers["content-length"] ?? "");
            if (!/^\d+$/.test(rawLength)) return fail(CODES.LENGTH_MISMATCH);
            const total = Number(rawLength);
            if (!Number.isSafeInteger(total) || total !== release.size || total > release.archiveMaxBytes) {
              return fail(CODES.LENGTH_MISMATCH);
            }
            this.job = { ...this.job, total, bytes: 0, progress: 0 };

            out = fssync.createWriteStream(dest, { flags: "wx", mode: 0o600 });
            out.on("error", (error) => {
              if (error.code === "ENOSPC") fail(CODES.DISK_SPACE_LOW);
              else fail(CODES.WRITE_FAILED);
            });

            res.on("data", (chunk) => {
              if (settled) return;
              received += chunk.length;
              if (received > release.size) return fail(CODES.LENGTH_MISMATCH);
              hash.update(chunk);
              this.job = {
                ...this.job,
                bytes: received,
                progress: Math.min(99, Math.floor((received / total) * 100)),
              };
            });
            res.on("aborted", () => fail(CODES.DOWNLOAD_FAILED));
            res.on("error", () => fail(CODES.DOWNLOAD_FAILED));
            res.pipe(out);
            out.on("finish", () => {
              if (settled) return;
              if (received !== release.size) return fail(CODES.LENGTH_MISMATCH);
              finish(null, { sha256: hash.digest("hex"), bytes: received });
            });
          },
        );
        req.on("timeout", () => fail(CODES.TIMEOUT));
        req.on("error", (error) => {
          if (this._cancelRequested) return fail(CODES.CANCELLED);
          const raw = String(error?.code || "");
          if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS/.test(raw)) {
            return fail(CODES.TLS_FAILED);
          }
          return fail(CODES.DOWNLOAD_FAILED);
        });
        totalTimer = setTimeout(() => fail(CODES.TIMEOUT), this.totalTimeoutMs);
        totalTimer.unref?.();
        req.end();
      } catch {
        fail(CODES.DOWNLOAD_FAILED);
      }
    });
  }

  #extract(archive, staging) {
    const release = this.release;
    const allowed = new Set([release.binary]);
    const tarLimit = release.tarMaxBytes;

    return new Promise((resolve, reject) => {
      const extractor = tar.extract();
      const read = fssync.createReadStream(archive);
      const gunzip = createGunzip();
      // tar-stream 在触发 entry 之前会先缓冲 PAX/GNU 扩展头；只在 entry 回调里统计
      // header.size 会漏掉这些元数据。这里在 gunzip 之后、parser 之前按“解压后的
      // tar 总字节数”设硬上限，包含头/元数据/padding，并只给固定的小额开销。
      let tarBytes = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          tarBytes += chunk.length;
          if (tarBytes > tarLimit) return callback(new AudioEngineError(CODES.ARCHIVE_TOO_LARGE));
          callback(null, chunk);
        },
      });
      const seen = new Set();
      let count = 0;
      let expanded = 0;
      let failed = false;

      const fail = (code) => {
        if (failed) return;
        failed = true;
        counter.destroy();
        gunzip.destroy();
        extractor.destroy();
        read.destroy();
        reject(new AudioEngineError(code));
      };
      this._abort = () => fail(CODES.CANCELLED);

      extractor.on("entry", (header, stream, next) => {
        if (failed) {
          stream.resume();
          return next();
        }
        count += 1;
        if (count > release.maxEntries) return fail(CODES.ARCHIVE_TOO_LARGE);
        if (!header || header.type !== "file" || header.linkname || header.sparse) {
          stream.resume();
          return fail(CODES.ARCHIVE_UNSAFE);
        }
        let name;
        try {
          name = validateEntryName(header.name);
          validatePax(header);
        } catch {
          stream.resume();
          return fail(CODES.ARCHIVE_UNSAFE);
        }
        if (!allowed.has(name) || seen.has(name)) {
          stream.resume();
          return fail(CODES.ARCHIVE_UNSAFE);
        }
        seen.add(name);
        if (!Number.isSafeInteger(header.size) || header.size < 0) {
          stream.resume();
          return fail(CODES.ARCHIVE_INVALID);
        }
        if (expanded + header.size > release.extractedMaxBytes) {
          stream.resume();
          return fail(CODES.ARCHIVE_TOO_LARGE);
        }
        expanded += header.size;

        let written = 0;
        const target = path.join(staging, name);
        const out = fssync.createWriteStream(target, { flags: "wx", mode: 0o600 });
        stream.on("data", (chunk) => {
          written += chunk.length;
          if (written > header.size || expanded > release.extractedMaxBytes) fail(CODES.ARCHIVE_TOO_LARGE);
        });
        out.on("error", () => fail(CODES.WRITE_FAILED));
        pipeline(stream, out)
          .then(() => {
            if (failed) return;
            if (written !== header.size) return fail(CODES.ARCHIVE_INVALID);
            next();
          })
          .catch(() => fail(CODES.ARCHIVE_INVALID));
      });

      extractor.on("finish", () => {
        if (failed) return;
        if (!seen.has(release.binary)) return fail(CODES.ARCHIVE_INVALID);
        resolve();
      });
      extractor.on("error", () => fail(CODES.ARCHIVE_INVALID));
      gunzip.on("error", () => fail(CODES.ARCHIVE_INVALID));
      counter.on("error", () => fail(CODES.ARCHIVE_TOO_LARGE));
      read.on("error", () => fail(CODES.ARCHIVE_INVALID));
      read.pipe(gunzip).pipe(counter).pipe(extractor);
      if (this.hooks.extracting) {
        try {
          this.hooks.extracting({ tarLimit });
        } catch {
          fail(CODES.INSTALL_FAILED);
        }
      }
    });
  }

  async #commit(staging, jobId) {
    const release = this.release;
    const versions = await this.#ensureVersionsDir();
    const dirName = `${sanitizeSegment(release.version)}-${release.sha256.slice(0, 12)}`;
    const finalDir = path.join(versions, dirName);
    let created = null;
    try {
      // 在提交路径上对实际待提交的二进制流式计算摘要；不接受 HTTP/调用方传入的摘要。
      const stagedBinary = path.join(staging, release.binary);
      const digest = await hashFileStreaming(stagedBinary, {
        maxBytes: release.extractedMaxBytes,
        isCancelled: () => this._cancelRequested,
        code: CODES.ARCHIVE_INVALID,
      });
      if (digest.size <= 0 || digest.size !== digest.stat.size) throw new AudioEngineError(CODES.ARCHIVE_INVALID);
      // 每次真正提交生成新的不可复用 generation；旧 marker 不自动补信任。
      const generation = crypto.randomBytes(16).toString("hex");

      const existing = await lstatOrNull(finalDir);
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
        await fs.rm(finalDir, { recursive: true, force: true });
      }
      await fs.rename(staging, finalDir);
      created = finalDir;
      const marker = {
        metadataVersion: INSTALL_METADATA_VERSION,
        version: release.version,
        releaseSha256: release.sha256,
        archiveBytes: release.size,
        binary: release.binary,
        binarySha256: digest.sha256,
        binarySize: digest.size,
        generation,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(finalDir, ".installed.json"), JSON.stringify(marker), { mode: 0o600 });
      const pointer = {
        metadataVersion: INSTALL_METADATA_VERSION,
        version: release.version,
        dir: dirName,
        binary: release.binary,
        releaseSha256: release.sha256,
        size: release.size,
        binarySha256: digest.sha256,
        binarySize: digest.size,
        generation,
        installedAt: marker.installedAt,
      };
      const tmpPointer = path.join(this.engineRoot, `.current-${jobId}.tmp`);
      await fs.writeFile(tmpPointer, JSON.stringify(pointer), { mode: 0o600 });
      await fs.rename(tmpPointer, path.join(this.engineRoot, "current.json"));
      created = null;
      // 新版本已提交；旧版平铺文件清理失败不能反过来把已提交的新版本判为失败。
      await unlinkRegular(path.join(this.engineRoot, release.binary)).catch(() => {});
      await unlinkRegular(path.join(this.engineRoot, ".installed.json")).catch(() => {});
    } catch (error) {
      if (created) await fs.rm(created, { recursive: true, force: true }).catch(() => {});
      if (isAudioEngineError(error)) throw error;
      throw new AudioEngineError(CODES.COMMIT_FAILED);
    }
  }

  async #ensureVersionsDir() {
    if (!(await this.#isTrustedDir(this.enginesRoot)) || !(await this.#isTrustedDir(this.engineRoot))) {
      throw new AudioEngineError(CODES.UNSAFE_TARGET);
    }
    await fs.mkdir(this.versionsRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await this.#isTrustedDir(this.versionsRoot))) throw new AudioEngineError(CODES.UNSAFE_TARGET);
    return this.versionsRoot;
  }

  async #isTrustedDir(target) {
    const stat = await lstatOrNull(target);
    return !!stat && !stat.isSymbolicLink() && stat.isDirectory();
  }

  #installedInfo() {
    const release = this.release;
    // 从 dataDir 往下的每一级祖先都必须是真实目录，不能只检查最终 binary。
    if (!trustedDirSync(this.enginesRoot) || !trustedDirSync(this.engineRoot)) return null;

    const pointerPath = path.join(this.engineRoot, "current.json");
    const pointerStat = lstatOrNullSync(pointerPath);
    if (pointerStat) {
      // 指针存在就必须可信；损坏/链接/超限一律视为未安装，不静默回退到 legacy。
      if (pointerStat.isSymbolicLink() || !pointerStat.isFile() || pointerStat.size > MAX_METADATA_BYTES) return null;
      const pointer = readSmallJsonSync(pointerPath, MAX_METADATA_BYTES);
      if (!pointer || typeof pointer !== "object") return null;
      if (
        !isSafeDirName(pointer.dir) ||
        pointer.binary !== release.binary ||
        typeof pointer.version !== "string" ||
        pointer.version.length === 0 ||
        pointer.version.length > 128 ||
        typeof pointer.releaseSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(pointer.releaseSha256)
      ) {
        return null;
      }
      if (!trustedDirSync(this.versionsRoot)) return null;
      const dir = path.join(this.versionsRoot, pointer.dir);
      if (!trustedDirSync(dir)) return null;
      const binary = path.join(dir, pointer.binary);
      const binaryStat = lstatOrNullSync(binary);
      if (!binaryStat || binaryStat.isSymbolicLink() || !binaryStat.isFile()) return null;
      if (binaryStat.size <= 0 || binaryStat.size > release.extractedMaxBytes) return null;
      const markerPath = path.join(dir, ".installed.json");
      const markerStat = lstatOrNullSync(markerPath);
      if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_METADATA_BYTES) {
        return null;
      }
      const marker = readSmallJsonSync(markerPath, MAX_METADATA_BYTES);
      if (!marker || typeof marker !== "object") return null;
      if (
        marker.version !== pointer.version ||
        marker.releaseSha256 !== pointer.releaseSha256 ||
        marker.binary !== pointer.binary
      ) {
        return null;
      }
      const pointerVersion = pointer.metadataVersion;
      const markerVersion = marker.metadataVersion;
      const legacyMeta = (value) => value === undefined || value === 1;
      if (legacyMeta(pointerVersion) && legacyMeta(markerVersion)) {
        return {
          version: marker.version,
          releaseSha256: marker.releaseSha256,
          size: binaryStat.size,
          binaryPath: binary,
          legacy: true,
          metadataVersion: null,
          binarySha256: null,
          binarySize: binaryStat.size,
          generation: null,
        };
      }
      if (pointerVersion !== INSTALL_METADATA_VERSION || markerVersion !== INSTALL_METADATA_VERSION) return null;
      if (!isSha256Hex(marker.binarySha256) || marker.binarySha256 !== pointer.binarySha256) return null;
      if (!isGeneration(marker.generation) || marker.generation !== pointer.generation) return null;
      if (
        !Number.isSafeInteger(marker.binarySize) ||
        marker.binarySize <= 0 ||
        marker.binarySize !== pointer.binarySize ||
        marker.binarySize !== binaryStat.size
      ) {
        return null;
      }
      return {
        version: marker.version,
        releaseSha256: marker.releaseSha256,
        size: binaryStat.size,
        binaryPath: binary,
        legacy: false,
        metadataVersion: INSTALL_METADATA_VERSION,
        binarySha256: marker.binarySha256,
        binarySize: marker.binarySize,
        generation: marker.generation,
      };
    }

    // 兼容旧版平铺安装：只有标记存在、非链接且有界读取、hash 与当前可信发布一致才算可信。
    // 若存在 versionsRoot，也同样要求它是真实目录，不能借未使用的旧路径绕过信任链。
    const legacyVersionsStat = lstatOrNullSync(this.versionsRoot);
    if (legacyVersionsStat && (legacyVersionsStat.isSymbolicLink() || !legacyVersionsStat.isDirectory())) return null;
    const legacyBinary = path.join(this.engineRoot, release.binary);
    const legacyStat = lstatOrNullSync(legacyBinary);
    if (!legacyStat || legacyStat.isSymbolicLink() || !legacyStat.isFile()) return null;
    if (legacyStat.size <= 0 || legacyStat.size > release.extractedMaxBytes) return null;
    const markerPath = path.join(this.engineRoot, ".installed.json");
    const markerStat = lstatOrNullSync(markerPath);
    if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_METADATA_BYTES) {
      return null;
    }
    const marker = readSmallJsonSync(markerPath, MAX_METADATA_BYTES);
    if (!marker || typeof marker !== "object") return null;
    if (marker.sha256 !== release.sha256 || typeof marker.version !== "string" || marker.version.length === 0) {
      return null;
    }
    if (marker.binary !== undefined && marker.binary !== release.binary) return null;
    return {
      version: marker.version,
      releaseSha256: marker.sha256,
      size: legacyStat.size,
      binaryPath: legacyBinary,
      legacy: true,
      metadataVersion: null,
      binarySha256: null,
      binarySize: legacyStat.size,
      generation: null,
    };
  }

  #peekLockBusy() {
    // 保守策略：锁目录只要存在就视为占用，不在运行期自动回收。
    // 死锁清理改为显式维护；这样不存在“先判死、再被新持锁者换入、最后无条件 rename 搬走活锁”的竞态。
    return lstatOrNullSync(this.lockRoot) !== null;
  }

  async #acquireLock(jobId) {
    // scope 获取/释放出现 unknown 后，本实例 run/install/uninstall 一律 fail-closed。
    if (this._scopeFaulted) throw new AudioEngineError(CODES.BUSY);
    const token = crypto.randomBytes(16).toString("hex");
    const owner = {
      pid: process.pid,
      jobId,
      token,
      startedAt: new Date().toISOString(),
    };
    // 用排他 mkdir 直接抢锁：POSIX 的 rename(creating, lockRoot) 会静默覆盖已存在的空目录，
    // “同步 peek 之后、rename 之前”新出现的空锁会被覆盖。mkdir 不会覆盖任何已存在路径，
    // EEXIST 即 BUSY，因此不存在“覆盖别人锁”的窗口。
    // 代价是 mkdir 成功到写 owner 之间有一个极短的无 owner 窗口：此间竞争者只会看到锁存在
    // 并 fail-closed BUSY，不会删除/搬走它；本进程写 owner 失败时只清理自己刚建的空锁。
    try {
      await fs.mkdir(this.lockRoot, { mode: 0o700 });
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code)) {
        // 任意已存在的锁一律 BUSY：包括无 owner、owner 不可校验、owner 进程已死。
        // 不做自动回收、不 rename/删除已存在锁；由维护者在确认无安装/卸载进程后手动清理。
        throw new AudioEngineError(CODES.BUSY);
      }
      throw new AudioEngineError(CODES.LOCK_FAILED);
    }
    try {
      await fs.writeFile(path.join(this.lockRoot, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
        flag: "wx",
      });
      return { token };
    } catch {
      // 只回收本进程刚建立、仍无 owner 的空锁；owner 已存在或目录已被替换则原样保留。
      await removeEmptyLockDir(this.lockRoot).catch(() => {});
      throw new AudioEngineError(CODES.LOCK_FAILED);
    }
  }

  async #releaseLock(lock, { strict = false } = {}) {
    const fail = () => {
      if (strict) throw new AudioEngineError(CODES.LOCK_FAILED);
    };
    const before = await lstatOrNull(this.lockRoot);
    if (!before) return fail();
    if (before.isSymbolicLink() || !before.isDirectory()) return fail();

    const raw = await readSmallText(path.join(this.lockRoot, "owner.json"), MAX_METADATA_BYTES);
    if (raw === null) return fail();
    let owner;
    try {
      owner = sanitizeLockOwner(JSON.parse(raw));
    } catch {
      return fail();
    }
    if (!owner || owner.token !== lock.token) return fail();

    // 只允许释放“只有本进程 owner.json”的锁目录；未知条目/额外文件一律保留并 fail-closed。
    const entries = await fs.readdir(this.lockRoot).catch(() => null);
    if (!entries || entries.length !== 1 || entries[0] !== "owner.json") return fail();
    const afterRead = await lstatOrNull(this.lockRoot);
    if (!afterRead || afterRead.dev !== before.dev || afterRead.ino !== before.ino) return fail();

    const ownerPath = path.join(this.lockRoot, "owner.json");
    const ownerStat = await lstatOrNull(ownerPath);
    if (!ownerStat || ownerStat.isSymbolicLink() || !ownerStat.isFile()) return fail();
    try {
      await fs.unlink(ownerPath);
    } catch {
      return fail();
    }
    try {
      await fs.rmdir(this.lockRoot);
    } catch {
      // 删除 owner 后 rmdir 失败（例如竞态插入未知条目）：尽力恢复 owner，保持可识别的锁。
      await fs.writeFile(ownerPath, raw, { mode: 0o600, flag: "wx" }).catch(() => {});
      return fail();
    }
    if ((await lstatOrNull(this.lockRoot)) !== null) return fail();
  }
}

function monoNow() {
  return performance.now();
}

function remaining(deadlineAtMs) {
  return deadlineAtMs - monoNow();
}

/** 只停止等待，不取消内核 FS 调用；迟到结果仍由创建时的 handler 接管。 */
function raceBudget(promise, budgetMs) {
  if (!(budgetMs > 0)) return Promise.resolve(SCOPE_BUDGET_EXHAUSTED);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(SCOPE_BUDGET_EXHAUSTED);
    }, budgetMs);
    if (typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function isSha256Hex(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isGeneration(value) {
  return typeof value === "string" && GENERATION_PATTERN.test(value);
}

function isValidPointer(pointer, binary) {
  return (
    !!pointer &&
    typeof pointer === "object" &&
    isSafeDirName(pointer.dir) &&
    pointer.binary === binary &&
    typeof pointer.version === "string" &&
    pointer.version.length > 0 &&
    pointer.version.length <= 128 &&
    isSha256Hex(pointer.releaseSha256)
  );
}

/**
 * 流式读取并计算摘要；固定小块，禁止整文件 readFile。调用方负责传入已打开的句柄，
 * 本函数校验读取前后 dev/ino/size/mtime/ctime 不变、实际字节数等于预期且到达 EOF。
 */
async function hashOpenHandle(handle, { before, expectedSize, signal, isCancelled, onChunk, code }) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new AudioEngineError(code);
  const hash = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(HASH_CHUNK_BYTES, expectedSize));
  let offset = 0;
  while (offset < expectedSize) {
    if (signal?.aborted || isCancelled?.()) throw new AudioEngineError(CODES.CANCELLED);
    const length = Math.min(buffer.length, expectedSize - offset);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) throw new AudioEngineError(code);
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
    if (onChunk) await onChunk({ offset, total: expectedSize });
  }
  // 额外读 1 字节验证没有在读取期间增长。
  const probe = Buffer.allocUnsafe(1);
  const { bytesRead: extra } = await handle.read(probe, 0, 1, offset);
  if (extra !== 0) throw new AudioEngineError(code);
  const after = await handle.stat();
  if (
    !after.isFile() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.size !== offset ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  ) {
    throw new AudioEngineError(code);
  }
  return { sha256: hash.digest("hex"), size: offset, stat: after };
}

/** 安装提交路径用：打开、校验普通文件后流式 hash；不跟随链接、不阻塞 FIFO。 */
async function hashFileStreaming(file, { maxBytes, isCancelled, code = CODES.INTEGRITY_FAILED } = {}) {
  const flags = fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0) | (fssync.constants.O_NONBLOCK || 0);
  let handle;
  try {
    handle = await fs.open(file, flags);
  } catch {
    throw new AudioEngineError(code);
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) throw new AudioEngineError(code);
    const hashed = await hashOpenHandle(handle, { before, expectedSize: before.size, isCancelled, code });
    const pathStat = await lstatOrNull(file);
    if (
      !pathStat ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.dev !== hashed.stat.dev ||
      pathStat.ino !== hashed.stat.ino ||
      pathStat.size !== hashed.stat.size
    ) {
      throw new AudioEngineError(code);
    }
    return hashed;
  } finally {
    await handle.close().catch(() => {});
  }
}

function validateEntryName(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) throw new Error("bad name");
  if (raw.includes("\0") || raw.includes("\\")) throw new Error("bad name");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error("absolute");
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new Error("bad segment");
  }
  return raw;
}

function validatePax(header) {
  const pax = header.pax;
  if (!pax) return;
  for (const [key, value] of Object.entries(pax)) {
    if (key === "path") {
      if (value !== header.name) throw new Error("pax path mismatch");
    } else if (key === "linkpath") {
      throw new Error("pax link");
    } else if (key === "size") {
      if (!/^\d+$/.test(String(value)) || Number(value) !== header.size) throw new Error("pax size");
    } else if (!/^(mtime|atime|ctime|uid|gid|uname|gname)$/.test(key) && !/^(SCHILY|LIBARCHIVE)\.(xattr|acl)\./.test(key)) {
      throw new Error("pax extension");
    }
  }
}

function sanitizeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "engine";
}

function isSafeDirName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
    && value !== "." && value !== "..";
}

function normalizeError(error, cancelled) {
  if (cancelled) return new AudioEngineError(CODES.CANCELLED);
  if (isAudioEngineError(error)) return error;
  if (error?.code === "ENOSPC") return new AudioEngineError(CODES.DISK_SPACE_LOW);
  return new AudioEngineError(CODES.INSTALL_FAILED);
}

function cloneJob(job) {
  return {
    ...job,
    error: job.error ? { ...job.error } : null,
  };
}

function lstatOrNullSync(target) {
  try {
    return fssync.lstatSync(target);
  } catch {
    return null;
  }
}

/** 可信目录：存在、非符号链接、且本身是目录。 */
function trustedDirSync(target) {
  const stat = lstatOrNullSync(target);
  return !!stat && !stat.isSymbolicLink() && stat.isDirectory();
}

/** 只读打开并校验普通文件；O_NOFOLLOW 避免 lstat 后目标被换成链接。 */
function readSmallTextSync(file, maxBytes) {
  let fd;
  try {
    const flags = fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0) | (fssync.constants.O_NONBLOCK || 0);
    fd = fssync.openSync(file, flags);
    const stat = fssync.fstatSync(fd);
    if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fssync.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fssync.closeSync(fd);
      } catch {}
    }
  }
}

function readSmallJsonSync(file, maxBytes = MAX_METADATA_BYTES) {
  try {
    const raw = readSmallTextSync(file, maxBytes);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 安装器私有临时任务的归属标记；格式不完整时视为未知目录，保留不删。 */
function readTmpOwner(dir) {
  const owner = readSmallJsonSync(path.join(dir, TMP_OWNER_FILE));
  if (!owner) return null;
  if (owner.kind !== TMP_OWNER_KIND) return null;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
  if (typeof owner.token !== "string" || !/^[0-9a-f]{32}$/.test(owner.token)) return null;
  if (typeof owner.jobId !== "string" || owner.jobId.length === 0) return null;
  return owner;
}

function sanitizeLockOwner(owner) {
  if (!owner) return null;
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return null;
  if (typeof owner?.token !== "string" || owner.token.length === 0 || owner.token.length > 128) return null;
  return owner;
}

async function readSmallJson(file, maxBytes = MAX_METADATA_BYTES) {
  try {
    const raw = await readSmallText(file, maxBytes);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function readSmallText(file, maxBytes) {
  let handle;
  try {
    const flags = fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0) | (fssync.constants.O_NONBLOCK || 0);
    handle = await fs.open(file, flags);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function lstatOrNull(target, options) {
  try {
    return await fs.lstat(target, options);
  } catch {
    return null;
  }
}

/**
 * 把 bigint stat 收敛为可比较的独立基本类型身份快照；不保存 fs.Stats 引用，
 * 避免后续对象被复用/原地更新。mtimeNs/ctimeNs 用于发现同尺寸原位改写。
 */
function statIdentity(stat) {
  if (!stat || typeof stat.dev !== "bigint") return null;
  return Object.freeze({
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: Number(stat.size),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  });
}

function sameFileIdentity(a, b) {
  return (
    !!a &&
    !!b &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

async function unlinkRegular(target) {
  const stat = await lstatOrNull(target);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  await fs.unlink(target);
}

/** 仅删除“刚由本进程 mkdir、且仍无 owner.json”的空锁目录；其它情况一律保留。 */
async function removeEmptyLockDir(lockRoot) {
  const stat = await lstatOrNull(lockRoot);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return;
  if ((await lstatOrNull(path.join(lockRoot, "owner.json"))) !== null) return;
  await fs.rmdir(lockRoot).catch(() => {});
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
