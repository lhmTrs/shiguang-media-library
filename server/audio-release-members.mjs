/**
 * MUSIC-RELEASE-MEMBERS-01-20261027
 *
 * 纯成员合同桥：只解析/校验成员声明，供未来 audio engine / executor 共用。
 *
 * 本文件刻意没有任何 import，也不访问 FS、网络、进程、环境变量、时钟或执行器：
 *  - 不读取归档、不计算内容 SHA、不安装、不加载、不执行任何成员；
 *  - 不把声明自报的 archive.sha256 当成外部 pin；
 *  - 不把"声明合法"升级成 contentVerified / publisherAuthenticated /
 *    runtimeIdentityVerified / trusted；
 *  - 多成员执行未获批准，executionEligibility() 一律拒绝。
 *
 * 输入通道（同一 CONTRACT_VERSION 内收紧，不新增 schema）：
 *  - parseReleaseMembers / checkExternalExpectation：JSON 文本（≤4096 B）或受限纯数据对象；
 *  - 受限纯数据只含 null/boolean/有限 number/string/普通对象/普通数组，且只能由
 *    enumerable、own、data descriptor 组成；先按 descriptor 归一化，绝不调用
 *    getter/toJSON/函数，再读取字段或 JSON.stringify；拒绝 accessor、function、
 *    symbol、隐藏/非枚举字段、自定义 prototype、toJSON、循环和共享引用；
 *  - executionEligibility：只接受本模块 parse 成功返回的私有品牌结果；克隆结果或
 *    伪造 {ok:true, declaration:...} 一律拒绝，且不读取其属性。
 *  - 三个 public 入口统一固定错误边界，不把调用方异常 message/stack 返回给调用方。
 *
 * 成员格式只有两版：
 *  - schemaVersion 1：固定两成员 audio-analyze + lib/fixture.dylib（候选合同）；
 *  - schemaVersion 0：legacy 单成员 audio-analyze，只做显式版本兼容解析。
 *
 * 现有整体限额沿用 ENGINE_RELEASE / executor 口径：归档 130 MiB、展开 256 MiB、
 * executor RLIMIT_FSIZE 64 MiB。64 MiB 是执行器写限额，不是可读成员大小上限，
 * 本模块不会把它套到 members[].bytes 上。
 */

export const CONTRACT_VERSION = "1.0.0";
export const SCHEMA = "audio-release-members";
export const SCHEMA_VERSION = 1;
export const LEGACY_SCHEMA_VERSION = 0;
export const COMPATIBILITY_MULTI = "multi-member";
export const COMPATIBILITY_LEGACY = "legacy-single-member";

export const FIXED_MEMBERS = Object.freeze(["audio-analyze", "lib/fixture.dylib"]);
export const LEGACY_MEMBERS = Object.freeze(["audio-analyze"]);
export const MEMBER_TYPE = "file";
export const MEMBER_MODES = Object.freeze(["0644", "0755"]);

const MiB = 1024 * 1024;

export const LIMITS = Object.freeze({
  descriptionBytes: 4096,
  pathBytes: 128,
  versionChars: 64,
  maxMembers: 2,
  archiveMaxBytes: 130 * MiB,
  extractedMaxBytes: 256 * MiB,
  memberMaxBytes: 256 * MiB,
  totalMemberMaxBytes: 256 * MiB,
  /** 执行器 launcher RLIMIT_FSIZE；只记录，不用于可读成员大小校验。 */
  executorFileSizeLimitBytes: 64 * MiB,
});

/** 固定成员的路径/类型/mode；不接受同义路径或其它 mode。 */
export const MEMBER_POLICY = Object.freeze({
  "audio-analyze": Object.freeze({ type: MEMBER_TYPE, mode: "0755" }),
  "lib/fixture.dylib": Object.freeze({ type: MEMBER_TYPE, mode: "0644" }),
});

export const CODES = Object.freeze({
  INPUT_INVALID: "RELEASE_MEMBERS_INPUT_INVALID",
  INPUT_JSON_INVALID: "RELEASE_MEMBERS_INPUT_JSON_INVALID",
  INPUT_TOO_LARGE: "RELEASE_MEMBERS_INPUT_TOO_LARGE",
  SCHEMA_UNKNOWN: "RELEASE_MEMBERS_SCHEMA_UNKNOWN",
  SCHEMA_VERSION_UNKNOWN: "RELEASE_MEMBERS_SCHEMA_VERSION_UNKNOWN",
  KEYS_INVALID: "RELEASE_MEMBERS_KEYS_INVALID",
  RELEASE_INVALID: "RELEASE_MEMBERS_RELEASE_INVALID",
  RELEASE_VERSION_INVALID: "RELEASE_MEMBERS_RELEASE_VERSION_INVALID",
  PLATFORM_UNSUPPORTED: "RELEASE_MEMBERS_PLATFORM_UNSUPPORTED",
  ARCH_UNSUPPORTED: "RELEASE_MEMBERS_ARCH_UNSUPPORTED",
  ARCHIVE_INVALID: "RELEASE_MEMBERS_ARCHIVE_INVALID",
  ARCHIVE_FORMAT_UNSUPPORTED: "RELEASE_MEMBERS_ARCHIVE_FORMAT_UNSUPPORTED",
  ARCHIVE_BYTES_INVALID: "RELEASE_MEMBERS_ARCHIVE_BYTES_INVALID",
  ARCHIVE_TOO_LARGE: "RELEASE_MEMBERS_ARCHIVE_TOO_LARGE",
  ARCHIVE_SHA_INVALID: "RELEASE_MEMBERS_ARCHIVE_SHA_INVALID",
  MEMBERS_INVALID: "RELEASE_MEMBERS_MEMBERS_INVALID",
  MEMBER_COUNT_INVALID: "RELEASE_MEMBERS_MEMBER_COUNT_INVALID",
  MEMBER_INVALID: "RELEASE_MEMBERS_MEMBER_INVALID",
  MEMBER_PATH_INVALID: "RELEASE_MEMBERS_MEMBER_PATH_INVALID",
  MEMBER_PATH_TOO_LONG: "RELEASE_MEMBERS_MEMBER_PATH_TOO_LONG",
  MEMBER_PATH_ABSOLUTE: "RELEASE_MEMBERS_MEMBER_PATH_ABSOLUTE",
  MEMBER_PATH_SEPARATOR: "RELEASE_MEMBERS_MEMBER_PATH_SEPARATOR",
  MEMBER_PATH_CONTROL: "RELEASE_MEMBERS_MEMBER_PATH_CONTROL",
  MEMBER_PATH_ALIAS: "RELEASE_MEMBERS_MEMBER_PATH_ALIAS",
  MEMBER_PATH_NONCANONICAL: "RELEASE_MEMBERS_MEMBER_PATH_NONCANONICAL",
  MEMBER_PATH_UNKNOWN: "RELEASE_MEMBERS_MEMBER_PATH_UNKNOWN",
  MEMBER_ORDER_INVALID: "RELEASE_MEMBERS_MEMBER_ORDER_INVALID",
  MEMBER_DUPLICATE: "RELEASE_MEMBERS_MEMBER_DUPLICATE",
  MEMBER_TYPE_INVALID: "RELEASE_MEMBERS_MEMBER_TYPE_INVALID",
  MEMBER_MODE_INVALID: "RELEASE_MEMBERS_MEMBER_MODE_INVALID",
  MEMBER_BYTES_INVALID: "RELEASE_MEMBERS_MEMBER_BYTES_INVALID",
  MEMBER_TOO_LARGE: "RELEASE_MEMBERS_MEMBER_TOO_LARGE",
  MEMBER_SHA_INVALID: "RELEASE_MEMBERS_MEMBER_SHA_INVALID",
  MEMBER_VERSION_INVALID: "RELEASE_MEMBERS_MEMBER_VERSION_INVALID",
  TOTAL_INVALID: "RELEASE_MEMBERS_TOTAL_INVALID",
  TOTAL_MISMATCH: "RELEASE_MEMBERS_TOTAL_MISMATCH",
  TOTAL_TOO_LARGE: "RELEASE_MEMBERS_TOTAL_TOO_LARGE",
  TOTAL_OVERFLOW: "RELEASE_MEMBERS_TOTAL_OVERFLOW",
  DECLARATION_INVALID: "RELEASE_MEMBERS_DECLARATION_INVALID",
  EXPECTATION_INVALID: "RELEASE_MEMBERS_EXPECTATION_INVALID",
  EXTERNAL_PIN_MISSING: "RELEASE_MEMBERS_EXTERNAL_PIN_MISSING",
  EXTERNAL_PIN_MISMATCH: "RELEASE_MEMBERS_EXTERNAL_PIN_MISMATCH",
  EXTERNAL_BYTES_MISMATCH: "RELEASE_MEMBERS_EXTERNAL_BYTES_MISMATCH",
  EXTERNAL_VERSION_MISMATCH: "RELEASE_MEMBERS_EXTERNAL_VERSION_MISMATCH",
  EXTERNAL_MEMBERS_MISMATCH: "RELEASE_MEMBERS_EXTERNAL_MEMBERS_MISMATCH",
  MULTI_MEMBER_EXECUTION_NOT_APPROVED: "RELEASE_MEMBERS_MULTI_MEMBER_EXECUTION_NOT_APPROVED",
  LEGACY_EXECUTION_NOT_GRANTED: "RELEASE_MEMBERS_LEGACY_EXECUTION_NOT_GRANTED",
});

const MESSAGES = Object.freeze({
  [CODES.INPUT_INVALID]: "成员声明必须是 JSON 对象",
  [CODES.INPUT_JSON_INVALID]: "成员声明不是合法 JSON",
  [CODES.INPUT_TOO_LARGE]: "成员声明超过字节上限",
  [CODES.SCHEMA_UNKNOWN]: "成员声明 schema 未知",
  [CODES.SCHEMA_VERSION_UNKNOWN]: "成员声明 schemaVersion 未知",
  [CODES.KEYS_INVALID]: "成员声明字段集合不符合固定 schema",
  [CODES.RELEASE_INVALID]: "release 字段结构无效",
  [CODES.RELEASE_VERSION_INVALID]: "release.version 无效",
  [CODES.PLATFORM_UNSUPPORTED]: "平台声明不受支持",
  [CODES.ARCH_UNSUPPORTED]: "架构声明不受支持",
  [CODES.ARCHIVE_INVALID]: "archive 字段结构无效",
  [CODES.ARCHIVE_FORMAT_UNSUPPORTED]: "归档格式不受支持",
  [CODES.ARCHIVE_BYTES_INVALID]: "archive.bytes 无效",
  [CODES.ARCHIVE_TOO_LARGE]: "归档大小超过上限",
  [CODES.ARCHIVE_SHA_INVALID]: "archive.sha256 格式无效",
  [CODES.MEMBERS_INVALID]: "members 必须是数组",
  [CODES.MEMBER_COUNT_INVALID]: "成员数量与 schemaVersion 不符",
  [CODES.MEMBER_INVALID]: "成员条目必须是对象",
  [CODES.MEMBER_PATH_INVALID]: "成员路径无效",
  [CODES.MEMBER_PATH_TOO_LONG]: "成员路径超过字节上限",
  [CODES.MEMBER_PATH_ABSOLUTE]: "成员路径不能是绝对路径",
  [CODES.MEMBER_PATH_SEPARATOR]: "成员路径不能包含反斜杠分隔符",
  [CODES.MEMBER_PATH_CONTROL]: "成员路径不能包含控制字符",
  [CODES.MEMBER_PATH_ALIAS]: "成员路径不能包含空段、. 或 .. 别名",
  [CODES.MEMBER_PATH_NONCANONICAL]: "成员路径不是 NFC 规范形式",
  [CODES.MEMBER_PATH_UNKNOWN]: "成员路径不在固定成员集合内",
  [CODES.MEMBER_ORDER_INVALID]: "成员顺序不符合固定顺序",
  [CODES.MEMBER_DUPLICATE]: "成员路径重复",
  [CODES.MEMBER_TYPE_INVALID]: "成员类型必须是普通文件",
  [CODES.MEMBER_MODE_INVALID]: "成员 mode 不是固定合法值",
  [CODES.MEMBER_BYTES_INVALID]: "成员 bytes 必须是正安全整数",
  [CODES.MEMBER_TOO_LARGE]: "成员大小超过展开上限",
  [CODES.MEMBER_SHA_INVALID]: "成员 sha256 格式无效",
  [CODES.MEMBER_VERSION_INVALID]: "成员 version 无效",
  [CODES.TOTAL_INVALID]: "totalMemberBytes 无效",
  [CODES.TOTAL_MISMATCH]: "totalMemberBytes 与成员大小和不等",
  [CODES.TOTAL_TOO_LARGE]: "成员总大小超过展开上限",
  [CODES.TOTAL_OVERFLOW]: "成员总大小计算溢出安全整数",
  [CODES.DECLARATION_INVALID]: "成员声明未通过解析，不能做外部核验或执行判断",
  [CODES.EXPECTATION_INVALID]: "外部期望参数结构或取值无效",
  [CODES.EXTERNAL_PIN_MISSING]: "缺少调用方提供的外部归档 pin",
  [CODES.EXTERNAL_PIN_MISMATCH]: "外部归档 pin 与声明不一致",
  [CODES.EXTERNAL_BYTES_MISMATCH]: "外部归档大小与声明不一致",
  [CODES.EXTERNAL_VERSION_MISMATCH]: "外部版本与声明不一致",
  [CODES.EXTERNAL_MEMBERS_MISMATCH]: "外部成员期望与声明不一致",
  [CODES.MULTI_MEMBER_EXECUTION_NOT_APPROVED]: "多成员执行未获批准，拒绝",
  [CODES.LEGACY_EXECUTION_NOT_GRANTED]: "legacy 单成员仅做声明兼容，本模块不授予执行",
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const DRIVE_PATTERN = /^[A-Za-z]:/;

const DECLARATION_ONLY_FACTS = Object.freeze({
  declarationParsed: false,
  declarationOnly: true,
  contentVerified: false,
  publisherAuthenticated: false,
  runtimeIdentityVerified: false,
  trusted: false,
});

/**
 * 私有品牌：只有本模块成功 parse 出来的结果才在集合里。
 * checkExternalExpectation / executionEligibility 先查品牌，不读取调用方对象的任何
 * 属性，因此伪造 {ok:true, declaration:...} 或带 getter 的对象不会被当成解析结果。
 * 克隆/结构化复制会丢失品牌，按明确政策拒绝，必须重新 parse。
 */
const PARSED_RESULTS = new WeakSet();
const parsedResultsHas = WeakSet.prototype.has;
const parsedResultsAdd = WeakSet.prototype.add;

/**
 * 私有内部错误登记：只按对象身份识别本模块自己 throw 的 ContractViolation。
 * 分类时不使用 instanceof，也不读取被抛值的 prototype / 属性：catch 收到的值由
 * 调用方控制，instanceof 会触发 Proxy.getPrototypeOf 陷阱；若陷阱再次抛错，就会在
 * catch 内形成第二个未保护路径并让原 marker 逃逸。WeakMap.get 只按身份查表，
 * 不触发任何 Proxy 陷阱，也不序列化未知 message/stack/cause。
 */
const INTERNAL_VIOLATIONS = new WeakMap();
const internalViolationsGet = WeakMap.prototype.get;
const internalViolationsSet = WeakMap.prototype.set;

/** 纯数据输入通道的结构上限；先于任何用户钩子/序列化生效。 */
const INPUT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 512,
  maxKeys: 64,
  maxArrayLength: 64,
});

/** 归一化遍历的粗预算，只为在读取海量数据前止损；最终仍按精确 JSON 字节 ≤4096 拒绝。 */
const NORMALIZE_BYTE_BUDGET = LIMITS.descriptionBytes * 2;

class ContractViolation extends Error {
  constructor(code, field) {
    super(MESSAGES[code] || MESSAGES[CODES.INPUT_INVALID]);
    this.name = "ContractViolation";
    this.code = code;
    this.field = field;
    internalViolationsSet.call(INTERNAL_VIOLATIONS, this, Object.freeze({ code, field }));
  }
}

/** 仅按模块私有身份分类；非本模块抛出的值（Proxy/primitive/伪 name+code）返回 null。 */
function internalViolation(error) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  return internalViolationsGet.call(INTERNAL_VIOLATIONS, error) || null;
}

function fail(code, field) {
  throw new ContractViolation(code, field);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    Object.freeze(value);
  }
  return value;
}

function errorEntry(code, field) {
  return Object.freeze({ code, field, message: MESSAGES[code] || MESSAGES[CODES.INPUT_INVALID] });
}

function resultError(code, field, declarationParsed = false) {
  return Object.freeze({
    ok: false,
    errors: Object.freeze([errorEntry(code, field)]),
    declaration: null,
    facts: Object.freeze({ ...DECLARATION_ONLY_FACTS, declarationParsed }),
  });
}

function checkKeys(value, required, optional, field) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) fail(CODES.KEYS_INVALID, field);
  }
  for (const key of required) {
    if (!hasOwn(value, key)) fail(CODES.KEYS_INVALID, field);
  }
}

function hasSerializationHook(prototype) {
  try {
    return Object.getOwnPropertyDescriptor(prototype, "toJSON") !== undefined;
  } catch {
    return true;
  }
}

/**
 * 只接受受限纯数据：null/boolean/有限 number/string/纯对象/普通数组。
 * 先按 descriptor 检查再读取 value，绝不调用 getter、toJSON 或函数；
 * 拒绝 accessor、function、symbol、非枚举/隐藏字段、自定义 prototype、循环和共享引用。
 * 输出是新的普通数据树，后续字段读取与 JSON.stringify 不再触碰调用方钩子。
 */
function normalizeData(value, field, depth, state, codes) {
  if (value === null || typeof value === "boolean") {
    state.bytes += 1;
    return value;
  }
  if (typeof value === "string") {
    state.bytes += Buffer.byteLength(value, "utf8") + 2;
    if (state.bytes > NORMALIZE_BYTE_BUDGET) fail(codes.tooLarge, field);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(codes.invalid, field);
    state.bytes += 8;
    if (state.bytes > NORMALIZE_BYTE_BUDGET) fail(codes.tooLarge, field);
    return value;
  }
  if (typeof value !== "object") fail(codes.invalid, field);
  if (depth > INPUT_LIMITS.maxDepth) fail(codes.invalid, field);
  if (state.seen.has(value)) fail(codes.invalid, field);
  state.nodes += 1;
  if (state.nodes > INPUT_LIMITS.maxNodes) fail(codes.tooLarge, field);
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      hasSerializationHook(Array.prototype) ||
      hasSerializationHook(Object.prototype)
    ) {
      fail(codes.invalid, field);
    }
    if (Object.getOwnPropertySymbols(value).length !== 0) fail(codes.invalid, field);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    ) {
      fail(codes.invalid, field);
    }
    if (lengthDescriptor.value > INPUT_LIMITS.maxArrayLength) fail(codes.tooLarge, field);
    for (const key of Object.getOwnPropertyNames(value)) {
      if (key === "length") continue;
      if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= lengthDescriptor.value) {
        fail(codes.invalid, field);
      }
    }
    state.bytes += lengthDescriptor.value + 4;
    if (state.bytes > NORMALIZE_BYTE_BUDGET) fail(codes.tooLarge, field);
    const out = new Array(lengthDescriptor.value);
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(codes.invalid, field);
      out[index] = normalizeData(descriptor.value, field, depth + 1, state, codes);
    }
    return out;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(codes.invalid, field);
  if (hasSerializationHook(Object.prototype)) fail(codes.invalid, field);
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(codes.invalid, field);
  const names = Object.getOwnPropertyNames(value);
  if (names.length > INPUT_LIMITS.maxKeys) fail(codes.tooLarge, field);
  const out = {};
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(codes.invalid, field);
    if (key === "toJSON") fail(codes.invalid, field);
    state.bytes += Buffer.byteLength(key, "utf8") + 4;
    if (state.bytes > NORMALIZE_BYTE_BUDGET) fail(codes.tooLarge, field);
    Object.defineProperty(out, key, {
      value: normalizeData(descriptor.value, field, depth + 1, state, codes),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

function normalizePublicInput(input, field, codes, jsonInvalidCode) {
  let value = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > LIMITS.descriptionBytes) fail(codes.tooLarge, field);
    try {
      value = JSON.parse(input);
    } catch {
      fail(jsonInvalidCode || codes.invalid, field);
    }
  }
  const state = { nodes: 0, bytes: 0, seen: new WeakSet() };
  const normalized = normalizeData(value, field, 0, state, codes);
  let serialized;
  try {
    serialized = JSON.stringify(normalized);
  } catch {
    fail(codes.invalid, field);
  }
  if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > LIMITS.descriptionBytes) {
    fail(codes.tooLarge, field);
  }
  return normalized;
}

function isGenuineParsedResult(value) {
  return value !== null && typeof value === "object" && parsedResultsHas.call(PARSED_RESULTS, value);
}

function checkVersion(value, field, code) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) fail(code, field);
  return value;
}

function checkRelease(value) {
  if (!isRecord(value)) fail(CODES.RELEASE_INVALID, "release");
  checkKeys(value, ["version", "platform", "arch"], [], "release");
  const version = checkVersion(value.version, "release.version", CODES.RELEASE_VERSION_INVALID);
  if (value.platform !== "darwin") fail(CODES.PLATFORM_UNSUPPORTED, "release.platform");
  if (value.arch !== "arm64") fail(CODES.ARCH_UNSUPPORTED, "release.arch");
  return { version, platform: "darwin", arch: "arm64" };
}

function checkArchive(value) {
  if (!isRecord(value)) fail(CODES.ARCHIVE_INVALID, "archive");
  checkKeys(value, ["format", "bytes", "sha256"], [], "archive");
  if (value.format !== "tar.gz") fail(CODES.ARCHIVE_FORMAT_UNSUPPORTED, "archive.format");
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) fail(CODES.ARCHIVE_BYTES_INVALID, "archive.bytes");
  if (value.bytes > LIMITS.archiveMaxBytes) fail(CODES.ARCHIVE_TOO_LARGE, "archive.bytes");
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    fail(CODES.ARCHIVE_SHA_INVALID, "archive.sha256");
  }
  return { format: "tar.gz", bytes: value.bytes, sha256: value.sha256 };
}

function checkMemberPath(value, index, expected, seen) {
  const field = `members[${index}].path`;
  if (typeof value !== "string" || value.length === 0) fail(CODES.MEMBER_PATH_INVALID, field);
  if (Buffer.byteLength(value, "utf8") > LIMITS.pathBytes) fail(CODES.MEMBER_PATH_TOO_LONG, field);
  if (value.startsWith("/") || DRIVE_PATTERN.test(value)) fail(CODES.MEMBER_PATH_ABSOLUTE, field);
  if (value.includes("\\")) fail(CODES.MEMBER_PATH_SEPARATOR, field);
  if (CONTROL_PATTERN.test(value)) fail(CODES.MEMBER_PATH_CONTROL, field);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(CODES.MEMBER_PATH_ALIAS, field);
  }
  if (value.normalize("NFC") !== value) fail(CODES.MEMBER_PATH_NONCANONICAL, field);
  if (seen.has(value)) fail(CODES.MEMBER_DUPLICATE, field);
  if (!expected.includes(value)) fail(CODES.MEMBER_PATH_UNKNOWN, field);
  if (expected[index] !== value) fail(CODES.MEMBER_ORDER_INVALID, field);
  seen.add(value);
  return value;
}

function checkMember(value, index, expected, seen) {
  const field = `members[${index}]`;
  if (!isRecord(value)) fail(CODES.MEMBER_INVALID, field);
  checkKeys(value, ["path", "type", "mode", "bytes", "sha256"], ["version"], field);
  const memberPath = checkMemberPath(value.path, index, expected, seen);
  const policy = MEMBER_POLICY[memberPath];
  if (value.type !== policy.type) fail(CODES.MEMBER_TYPE_INVALID, `${field}.type`);
  if (typeof value.mode !== "string" || !MEMBER_MODES.includes(value.mode) || value.mode !== policy.mode) {
    fail(CODES.MEMBER_MODE_INVALID, `${field}.mode`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes <= 0) fail(CODES.MEMBER_BYTES_INVALID, `${field}.bytes`);
  if (value.bytes > LIMITS.memberMaxBytes) fail(CODES.MEMBER_TOO_LARGE, `${field}.bytes`);
  if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
    fail(CODES.MEMBER_SHA_INVALID, `${field}.sha256`);
  }
  const member = { path: memberPath, type: policy.type, mode: policy.mode, bytes: value.bytes, sha256: value.sha256 };
  if (hasOwn(value, "version")) {
    member.version = checkVersion(value.version, `${field}.version`, CODES.MEMBER_VERSION_INVALID);
  }
  return member;
}

/**
 * 解析并校验成员声明。纯函数，不抛业务异常。
 *
 * @param {object|string} input 受限纯数据对象或 JSON 文本（均 ≤4096 B）
 * @returns {{ok:boolean, errors:ReadonlyArray<{code:string,field:string,message:string}>,
 *            declaration:object|null, facts:object}}
 */
export function parseReleaseMembers(input) {
  try {
    const value = normalizePublicInput(
      input,
      "input",
      { tooLarge: CODES.INPUT_TOO_LARGE, invalid: CODES.INPUT_INVALID },
      CODES.INPUT_JSON_INVALID,
    );
    if (!isRecord(value)) fail(CODES.INPUT_INVALID, "input");

    checkKeys(
      value,
      ["schema", "schemaVersion", "release", "archive", "members", "totalMemberBytes"],
      [],
      "input",
    );
    if (value.schema !== SCHEMA) fail(CODES.SCHEMA_UNKNOWN, "schema");
    if (value.schemaVersion !== SCHEMA_VERSION && value.schemaVersion !== LEGACY_SCHEMA_VERSION) {
      fail(CODES.SCHEMA_VERSION_UNKNOWN, "schemaVersion");
    }

    const legacy = value.schemaVersion === LEGACY_SCHEMA_VERSION;
    const expectedMembers = legacy ? LEGACY_MEMBERS : FIXED_MEMBERS;
    const compatibility = legacy ? COMPATIBILITY_LEGACY : COMPATIBILITY_MULTI;

    const release = checkRelease(value.release);
    const archive = checkArchive(value.archive);

    if (!Array.isArray(value.members)) fail(CODES.MEMBERS_INVALID, "members");
    if (value.members.length !== expectedMembers.length) fail(CODES.MEMBER_COUNT_INVALID, "members");

    const seen = new Set();
    const members = [];
    let computedTotal = 0;
    for (let index = 0; index < value.members.length; index += 1) {
      const member = checkMember(value.members[index], index, expectedMembers, seen);
      if (!Number.isSafeInteger(computedTotal + member.bytes)) fail(CODES.TOTAL_OVERFLOW, "totalMemberBytes");
      computedTotal += member.bytes;
      members.push(member);
    }

    if (!Number.isSafeInteger(value.totalMemberBytes) || value.totalMemberBytes <= 0) {
      fail(CODES.TOTAL_INVALID, "totalMemberBytes");
    }
    if (computedTotal > LIMITS.totalMemberMaxBytes || value.totalMemberBytes > LIMITS.totalMemberMaxBytes) {
      fail(CODES.TOTAL_TOO_LARGE, "totalMemberBytes");
    }
    if (value.totalMemberBytes !== computedTotal) fail(CODES.TOTAL_MISMATCH, "totalMemberBytes");

    const declaration = freezeDeep({
      schema: SCHEMA,
      schemaVersion: value.schemaVersion,
      compatibility,
      release,
      archive,
      members,
      totalMemberBytes: value.totalMemberBytes,
    });
    const facts = Object.freeze({ ...DECLARATION_ONLY_FACTS, declarationParsed: true });
    const result = Object.freeze({ ok: true, errors: Object.freeze([]), declaration, facts });
    parsedResultsAdd.call(PARSED_RESULTS, result);
    return result;
  } catch (error) {
    const violation = internalViolation(error);
    if (violation) return resultError(violation.code, violation.field);
    return resultError(CODES.INPUT_INVALID, "input");
  }
}

function checkExpectedMembers(value) {
  if (!Array.isArray(value)) fail(CODES.EXPECTATION_INVALID, "expected.members");
  if (value.length > LIMITS.maxMembers) fail(CODES.EXPECTATION_INVALID, "expected.members");
  const seen = new Set();
  const members = [];
  for (let index = 0; index < value.length; index += 1) {
    const field = `expected.members[${index}]`;
    const item = value[index];
    if (!isRecord(item)) fail(CODES.EXPECTATION_INVALID, field);
    checkKeys(item, ["path", "sha256"], ["bytes"], field);
    if (typeof item.path !== "string" || item.path.length === 0) fail(CODES.EXPECTATION_INVALID, `${field}.path`);
    if (Buffer.byteLength(item.path, "utf8") > LIMITS.pathBytes) fail(CODES.EXPECTATION_INVALID, `${field}.path`);
    if (seen.has(item.path)) fail(CODES.EXPECTATION_INVALID, `${field}.path`);
    seen.add(item.path);
    if (typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256)) {
      fail(CODES.EXPECTATION_INVALID, `${field}.sha256`);
    }
    const member = { path: item.path, sha256: item.sha256 };
    if (hasOwn(item, "bytes")) {
      if (!Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > LIMITS.memberMaxBytes) {
        fail(CODES.EXPECTATION_INVALID, `${field}.bytes`);
      }
      member.bytes = item.bytes;
    }
    members.push(member);
  }
  return members;
}

/**
 * 用调用方提供的外部期望核验声明。外部 pin 必须由调用方显式传入，绝不从声明
 * 的 archive.sha256 自动补；这里只比元数据，不读归档，因此 contentVerified
 * 永远为 false。
 *
 * @param {object} parsed 必须是本模块 parseReleaseMembers() 成功返回的原始对象；
 *   克隆/序列化复制/伪造 {ok:true} 均拒绝（私有品牌，不读取其属性）
 * @param {object|string} expectedInput 受限纯数据对象或 JSON 文本，至少包含
 *   archiveSha256；可选 archiveBytes/releaseVersion/members
 */
export function checkExternalExpectation(parsed, expectedInput) {
  if (!isGenuineParsedResult(parsed)) {
    return resultError(CODES.DECLARATION_INVALID, "declaration");
  }
  let externalPinProvided = false;
  try {
    const expected = normalizePublicInput(
      expectedInput,
      "expected",
      { tooLarge: CODES.EXPECTATION_INVALID, invalid: CODES.EXPECTATION_INVALID },
      CODES.EXPECTATION_INVALID,
    );
    if (!isRecord(expected)) fail(CODES.EXPECTATION_INVALID, "expected");
    externalPinProvided =
      hasOwn(expected, "archiveSha256") &&
      expected.archiveSha256 !== undefined &&
      expected.archiveSha256 !== null;
    if (!externalPinProvided) fail(CODES.EXTERNAL_PIN_MISSING, "expected.archiveSha256");
    checkKeys(expected, ["archiveSha256"], ["archiveBytes", "releaseVersion", "members"], "expected");
    if (typeof expected.archiveSha256 !== "string" || !SHA256_PATTERN.test(expected.archiveSha256)) {
      fail(CODES.EXPECTATION_INVALID, "expected.archiveSha256");
    }
    if (hasOwn(expected, "archiveBytes")) {
      if (
        !Number.isSafeInteger(expected.archiveBytes) ||
        expected.archiveBytes <= 0 ||
        expected.archiveBytes > LIMITS.archiveMaxBytes
      ) {
        fail(CODES.EXPECTATION_INVALID, "expected.archiveBytes");
      }
    }
    if (hasOwn(expected, "releaseVersion")) {
      checkVersion(expected.releaseVersion, "expected.releaseVersion", CODES.EXPECTATION_INVALID);
    }
    const expectedMembers = hasOwn(expected, "members") ? checkExpectedMembers(expected.members) : null;

    const declaration = parsed.declaration;
    if (expected.archiveSha256 !== declaration.archive.sha256) {
      fail(CODES.EXTERNAL_PIN_MISMATCH, "expected.archiveSha256");
    }
    if (hasOwn(expected, "archiveBytes") && expected.archiveBytes !== declaration.archive.bytes) {
      fail(CODES.EXTERNAL_BYTES_MISMATCH, "expected.archiveBytes");
    }
    if (hasOwn(expected, "releaseVersion") && expected.releaseVersion !== declaration.release.version) {
      fail(CODES.EXTERNAL_VERSION_MISMATCH, "expected.releaseVersion");
    }
    if (expectedMembers) {
      if (expectedMembers.length !== declaration.members.length) {
        fail(CODES.EXTERNAL_MEMBERS_MISMATCH, "expected.members");
      }
      const declaredByPath = new Map(declaration.members.map((member) => [member.path, member]));
      for (let index = 0; index < expectedMembers.length; index += 1) {
        const member = expectedMembers[index];
        const declared = declaredByPath.get(member.path);
        if (!declared || declared.sha256 !== member.sha256) {
          fail(CODES.EXTERNAL_MEMBERS_MISMATCH, `expected.members[${index}]`);
        }
        if (member.bytes !== undefined && declared.bytes !== member.bytes) {
          fail(CODES.EXTERNAL_MEMBERS_MISMATCH, `expected.members[${index}]`);
        }
      }
    }

    const facts = Object.freeze({
      declarationParsed: true,
      declarationOnly: true,
      externalPinProvided: true,
      externalPinSource: "caller",
      archiveSha256Matched: true,
      archiveBytesMatched: hasOwn(expected, "archiveBytes") ? true : null,
      releaseVersionMatched: hasOwn(expected, "releaseVersion") ? true : null,
      membersMatched: expectedMembers ? true : null,
      declarationMatchesExternal: true,
      contentVerified: false,
      publisherAuthenticated: false,
      runtimeIdentityVerified: false,
      trusted: false,
    });
    return Object.freeze({ ok: true, errors: Object.freeze([]), facts });
  } catch (error) {
    const violation = internalViolation(error);
    if (violation) {
      const result = resultError(violation.code, violation.field, true);
      return Object.freeze({
        ...result,
        facts: Object.freeze({ ...result.facts, externalPinProvided }),
      });
    }
    const result = resultError(CODES.EXPECTATION_INVALID, "expected", true);
    return Object.freeze({
      ...result,
      facts: Object.freeze({ ...result.facts, externalPinProvided: false }),
    });
  }
}

/**
 * 执行资格判断。本模块本身不接线、不执行；多成员执行未获批准，一律拒绝。
 * legacy 单成员只做声明兼容，也不由本模块授予执行。
 * 只接受本模块真实 parse 品牌；伪造/克隆 parsed 一律按 DECLARATION_INVALID 拒绝。
 */
export function executionEligibility(parsed) {
  if (!isGenuineParsedResult(parsed)) {
    return Object.freeze({ approved: false, code: CODES.DECLARATION_INVALID, memberCount: 0 });
  }
  try {
    const { declaration } = parsed;
    if (declaration.compatibility === COMPATIBILITY_MULTI) {
      return Object.freeze({
        approved: false,
        code: CODES.MULTI_MEMBER_EXECUTION_NOT_APPROVED,
        memberCount: declaration.members.length,
      });
    }
    return Object.freeze({
      approved: false,
      code: CODES.LEGACY_EXECUTION_NOT_GRANTED,
      memberCount: declaration.members.length,
    });
  } catch {
    return Object.freeze({ approved: false, code: CODES.DECLARATION_INVALID, memberCount: 0 });
  }
}
