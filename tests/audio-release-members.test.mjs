/**
 * MUSIC-RELEASE-MEMBERS-01-20261027 合同测试。
 *
 * 只用内存对象与坏输入；不读写真实素材、不连网、不安装/加载/执行任何成员，
 * 不依赖第三方包或真实引擎。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CONTRACT_VERSION,
  SCHEMA,
  SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION,
  COMPATIBILITY_MULTI,
  COMPATIBILITY_LEGACY,
  FIXED_MEMBERS,
  LEGACY_MEMBERS,
  LIMITS,
  CODES,
  parseReleaseMembers,
  checkExternalExpectation,
  executionEligibility,
} from "../server/audio-release-members.mjs";

const sha = (char) => char.repeat(64);
const MiB = 1024 * 1024;

function v1(overrides = {}) {
  return {
    schema: SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    release: { version: "1.0.0", platform: "darwin", arch: "arm64" },
    archive: { format: "tar.gz", bytes: 1024, sha256: sha("a") },
    members: [
      { path: "audio-analyze", type: "file", mode: "0755", bytes: 600, sha256: sha("b"), version: "1.0.0" },
      { path: "lib/fixture.dylib", type: "file", mode: "0644", bytes: 400, sha256: sha("c"), version: "0.9.0" },
    ],
    totalMemberBytes: 1000,
    ...overrides,
  };
}

function v0(overrides = {}) {
  return {
    schema: SCHEMA,
    schemaVersion: LEGACY_SCHEMA_VERSION,
    release: { version: "0.9.0", platform: "darwin", arch: "arm64" },
    archive: { format: "tar.gz", bytes: 512, sha256: sha("d") },
    members: [{ path: "audio-analyze", type: "file", mode: "0755", bytes: 600, sha256: sha("e") }],
    totalMemberBytes: 600,
    ...overrides,
  };
}

function assertFail(result, code, field) {
  assert.equal(result.ok, false);
  assert.equal(result.declaration, null);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, code);
  if (field !== undefined) assert.equal(result.errors[0].field, field);
  assert.equal(result.facts.declarationParsed, false);
  assert.equal(result.facts.contentVerified, false);
  assert.equal(result.facts.trusted, false);
}

test("v1 两成员声明通过，事实保持 declaration-only", () => {
  const result = parseReleaseMembers(v1());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.declaration.compatibility, COMPATIBILITY_MULTI);
  assert.deepEqual(result.declaration.members.map((m) => m.path), [...FIXED_MEMBERS]);
  assert.equal(result.declaration.totalMemberBytes, 1000);
  assert.equal(result.facts.declarationParsed, true);
  assert.equal(result.facts.declarationOnly, true);
  assert.equal(result.facts.contentVerified, false);
  assert.equal(result.facts.publisherAuthenticated, false);
  assert.equal(result.facts.runtimeIdentityVerified, false);
  assert.equal(result.facts.trusted, false);
  assert.equal(Object.isFrozen(result.declaration), true);
  assert.equal(Object.isFrozen(result.declaration.members[1]), true);
});

test("候选两成员可分别声明不同 version，不强制相等", () => {
  const different = v1();
  assert.equal(parseReleaseMembers(different).ok, true);
  assert.equal(parseReleaseMembers(v1({ members: [
    { path: "audio-analyze", type: "file", mode: "0755", bytes: 600, sha256: sha("b"), version: "2.0.0" },
    { path: "lib/fixture.dylib", type: "file", mode: "0644", bytes: 400, sha256: sha("c"), version: "0.1.0" },
  ] })).ok, true);
});

test("v0 legacy 单成员显式版本兼容，但本模块不授予执行", () => {
  const result = parseReleaseMembers(v0());
  assert.equal(result.ok, true);
  assert.equal(result.declaration.schemaVersion, LEGACY_SCHEMA_VERSION);
  assert.equal(result.declaration.compatibility, COMPATIBILITY_LEGACY);
  assert.deepEqual(result.declaration.members.map((m) => m.path), [...LEGACY_MEMBERS]);
  const eligibility = executionEligibility(result);
  assert.equal(eligibility.approved, false);
  assert.equal(eligibility.code, CODES.LEGACY_EXECUTION_NOT_GRANTED);
});

test("未知 schema / schemaVersion / 顶层或嵌套字段被拒绝", () => {
  assertFail(parseReleaseMembers(v1({ schema: "other" })), CODES.SCHEMA_UNKNOWN, "schema");
  assertFail(parseReleaseMembers(v1({ schemaVersion: 2 })), CODES.SCHEMA_VERSION_UNKNOWN, "schemaVersion");
  assertFail(parseReleaseMembers(v1({ extra: true })), CODES.KEYS_INVALID, "input");
  const missing = v1();
  delete missing.totalMemberBytes;
  assertFail(parseReleaseMembers(missing), CODES.KEYS_INVALID, "input");
  const releaseExtra = v1();
  releaseExtra.release.extra = true;
  assertFail(parseReleaseMembers(releaseExtra), CODES.KEYS_INVALID, "release");
  const archiveExtra = v1();
  archiveExtra.archive.extra = true;
  assertFail(parseReleaseMembers(archiveExtra), CODES.KEYS_INVALID, "archive");
  const memberExtra = v1();
  memberExtra.members[0].extra = true;
  assertFail(parseReleaseMembers(memberExtra), CODES.KEYS_INVALID, "members[0]");
});

test("非对象、坏 JSON、超字节上限被拒绝", () => {
  for (const value of [null, [], 42, true]) {
    assertFail(parseReleaseMembers(value), CODES.INPUT_INVALID, "input");
  }
  assertFail(parseReleaseMembers("plain"), CODES.INPUT_JSON_INVALID, "input");
  assertFail(parseReleaseMembers('{"schema":'), CODES.INPUT_JSON_INVALID, "input");
  assertFail(parseReleaseMembers(v1({ padding: "x".repeat(5000) })), CODES.INPUT_TOO_LARGE, "input");
  assertFail(parseReleaseMembers(JSON.stringify(v1({ padding: "x".repeat(5000) }))), CODES.INPUT_TOO_LARGE, "input");
});

test("绝对路径、反斜杠、别名、控制字符、非 NFC、未知路径被拒绝", () => {
  const mutate = (path) => {
    const value = v1();
    value.members[0].path = path;
    return value;
  };
  assertFail(parseReleaseMembers(mutate("/audio-analyze")), CODES.MEMBER_PATH_ABSOLUTE, "members[0].path");
  assertFail(parseReleaseMembers(mutate("C:/audio-analyze")), CODES.MEMBER_PATH_ABSOLUTE, "members[0].path");
  assertFail(parseReleaseMembers(mutate("lib\\fixture.dylib")), CODES.MEMBER_PATH_SEPARATOR, "members[0].path");
  assertFail(parseReleaseMembers(mutate("./audio-analyze")), CODES.MEMBER_PATH_ALIAS, "members[0].path");
  assertFail(parseReleaseMembers(mutate("lib//fixture.dylib")), CODES.MEMBER_PATH_ALIAS, "members[0].path");
  assertFail(parseReleaseMembers(mutate("lib/../lib/fixture.dylib")), CODES.MEMBER_PATH_ALIAS, "members[0].path");
  assertFail(parseReleaseMembers(mutate("audio-analyze\u0000")), CODES.MEMBER_PATH_CONTROL, "members[0].path");
  assertFail(parseReleaseMembers(mutate("a\u0308udio-analyze")), CODES.MEMBER_PATH_NONCANONICAL, "members[0].path");
  assertFail(parseReleaseMembers(mutate("audio-analyse")), CODES.MEMBER_PATH_UNKNOWN, "members[0].path");
  assertFail(parseReleaseMembers(mutate("ａudio-analyze")), CODES.MEMBER_PATH_UNKNOWN, "members[0].path");
  assertFail(parseReleaseMembers(mutate(`${"a".repeat(LIMITS.pathBytes + 1)}`)), CODES.MEMBER_PATH_TOO_LONG, "members[0].path");
});

test("重复、顺序错误、成员数量不符被拒绝", () => {
  const duplicate = v1();
  duplicate.members[1].path = "audio-analyze";
  assertFail(parseReleaseMembers(duplicate), CODES.MEMBER_DUPLICATE, "members[1].path");

  const order = v1();
  order.members.reverse();
  assertFail(parseReleaseMembers(order), CODES.MEMBER_ORDER_INVALID, "members[0].path");

  const count = v1();
  count.members.pop();
  count.totalMemberBytes = 600;
  assertFail(parseReleaseMembers(count), CODES.MEMBER_COUNT_INVALID, "members");

  const legacyCount = v0();
  legacyCount.members.push({ path: "lib/fixture.dylib", type: "file", mode: "0644", bytes: 1, sha256: sha("f") });
  assertFail(parseReleaseMembers(legacyCount), CODES.MEMBER_COUNT_INVALID, "members");
});

test("类型 / mode 只接受固定合法值", () => {
  const type = v1();
  type.members[1].type = "directory";
  assertFail(parseReleaseMembers(type), CODES.MEMBER_TYPE_INVALID, "members[1].type");

  const mode = v1();
  mode.members[0].mode = "0777";
  assertFail(parseReleaseMembers(mode), CODES.MEMBER_MODE_INVALID, "members[0].mode");

  const dylibMode = v1();
  dylibMode.members[1].mode = "0755";
  assertFail(parseReleaseMembers(dylibMode), CODES.MEMBER_MODE_INVALID, "members[1].mode");

  const legacyMode = v0();
  legacyMode.members[0].mode = "0644";
  assertFail(parseReleaseMembers(legacyMode), CODES.MEMBER_MODE_INVALID, "members[0].mode");
});

test("size 只接受正安全整数，hash 只接受小写 64 位 hex", () => {
  for (const bytes of [0, -1, 1.5, "600", Number.MAX_SAFE_INTEGER + 1]) {
    const value = v1();
    value.members[0].bytes = bytes;
    assertFail(parseReleaseMembers(value), CODES.MEMBER_BYTES_INVALID, "members[0].bytes");
  }
  const big = v0();
  big.members[0].bytes = LIMITS.memberMaxBytes + 1;
  big.totalMemberBytes = big.members[0].bytes;
  assertFail(parseReleaseMembers(big), CODES.MEMBER_TOO_LARGE, "members[0].bytes");

  for (const digest of ["A".repeat(64), "a".repeat(63), "g".repeat(64), 7]) {
    const value = v1();
    value.members[1].sha256 = digest;
    assertFail(parseReleaseMembers(value), CODES.MEMBER_SHA_INVALID, "members[1].sha256");
  }
});

test("version / platform / arch / archive 格式与 hash 严格校验", () => {
  const badVersion = v1();
  badVersion.release.version = "1.0.0/../x";
  assertFail(parseReleaseMembers(badVersion), CODES.RELEASE_VERSION_INVALID, "release.version");

  const badPlatform = v1();
  badPlatform.release.platform = "linux";
  assertFail(parseReleaseMembers(badPlatform), CODES.PLATFORM_UNSUPPORTED, "release.platform");

  const badArch = v1();
  badArch.release.arch = "x64";
  assertFail(parseReleaseMembers(badArch), CODES.ARCH_UNSUPPORTED, "release.arch");

  const badFormat = v1();
  badFormat.archive.format = "zip";
  assertFail(parseReleaseMembers(badFormat), CODES.ARCHIVE_FORMAT_UNSUPPORTED, "archive.format");

  const badBytes = v1();
  badBytes.archive.bytes = 0;
  assertFail(parseReleaseMembers(badBytes), CODES.ARCHIVE_BYTES_INVALID, "archive.bytes");

  const badSha = v1();
  badSha.archive.sha256 = "A".repeat(64);
  assertFail(parseReleaseMembers(badSha), CODES.ARCHIVE_SHA_INVALID, "archive.sha256");

  const badMemberVersion = v1();
  badMemberVersion.members[0].version = "";
  assertFail(parseReleaseMembers(badMemberVersion), CODES.MEMBER_VERSION_INVALID, "members[0].version");
});

test("总量必须等于成员和，并受 256 MiB 展开上限约束", () => {
  const mismatch = v1();
  mismatch.totalMemberBytes = 999;
  assertFail(parseReleaseMembers(mismatch), CODES.TOTAL_MISMATCH, "totalMemberBytes");

  const over = v1();
  over.totalMemberBytes = 300 * MiB;
  assertFail(parseReleaseMembers(over), CODES.TOTAL_TOO_LARGE, "totalMemberBytes");

  const zero = v1();
  zero.totalMemberBytes = 0;
  assertFail(parseReleaseMembers(zero), CODES.TOTAL_INVALID, "totalMemberBytes");
});

test("整体限额边界：归档 130 MiB、展开 256 MiB，64 MiB 只记录不套成员", () => {
  const archiveEdge = v1();
  archiveEdge.archive.bytes = LIMITS.archiveMaxBytes;
  assert.equal(parseReleaseMembers(archiveEdge).ok, true);

  const archiveOver = v1();
  archiveOver.archive.bytes = LIMITS.archiveMaxBytes + 1;
  assertFail(parseReleaseMembers(archiveOver), CODES.ARCHIVE_TOO_LARGE, "archive.bytes");

  const expandedEdge = v0();
  expandedEdge.members[0].bytes = LIMITS.extractedMaxBytes;
  expandedEdge.totalMemberBytes = LIMITS.extractedMaxBytes;
  assert.equal(parseReleaseMembers(expandedEdge).ok, true);

  const expandedOver = v0();
  expandedOver.members[0].bytes = LIMITS.extractedMaxBytes + 1;
  expandedOver.totalMemberBytes = expandedOver.members[0].bytes;
  assertFail(parseReleaseMembers(expandedOver), CODES.MEMBER_TOO_LARGE, "members[0].bytes");

  const aboveExecutor = v0();
  aboveExecutor.members[0].bytes = 65 * MiB;
  aboveExecutor.totalMemberBytes = 65 * MiB;
  assert.equal(parseReleaseMembers(aboveExecutor).ok, true);
  assert.equal(LIMITS.executorFileSizeLimitBytes, 64 * MiB);
  assert.equal(LIMITS.memberMaxBytes, 256 * MiB);
});

test("外部 pin 缺失时拒绝，绝不从声明自动补", () => {
  const parsed = parseReleaseMembers(v1());
  assert.equal(parsed.ok, true);
  const missing = checkExternalExpectation(parsed, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.errors[0].code, CODES.EXTERNAL_PIN_MISSING);
  assert.equal(missing.facts.externalPinProvided, false);
  assert.equal(missing.facts.contentVerified, false);
  assert.equal(missing.facts.trusted, false);
});

test("外部 pin / 大小 / 版本 / 成员不一致分别拒绝", () => {
  const parsed = parseReleaseMembers(v1());
  assert.equal(checkExternalExpectation(parsed, { archiveSha256: sha("f") }).errors[0].code, CODES.EXTERNAL_PIN_MISMATCH);
  assert.equal(
    checkExternalExpectation(parsed, { archiveSha256: sha("a"), archiveBytes: 2048 }).errors[0].code,
    CODES.EXTERNAL_BYTES_MISMATCH,
  );
  assert.equal(
    checkExternalExpectation(parsed, { archiveSha256: sha("a"), releaseVersion: "2.0.0" }).errors[0].code,
    CODES.EXTERNAL_VERSION_MISMATCH,
  );
  assert.equal(
    checkExternalExpectation(parsed, {
      archiveSha256: sha("a"),
      members: [{ path: "audio-analyze", sha256: sha("c") }],
    }).errors[0].code,
    CODES.EXTERNAL_MEMBERS_MISMATCH,
  );
});

test("外部元数据一致也只是声明核验，contentVerified 仍为 false", () => {
  const parsed = parseReleaseMembers(v1());
  const checked = checkExternalExpectation(parsed, {
    archiveSha256: sha("a"),
    archiveBytes: 1024,
    releaseVersion: "1.0.0",
    members: [
      { path: "audio-analyze", sha256: sha("b"), bytes: 600 },
      { path: "lib/fixture.dylib", sha256: sha("c"), bytes: 400 },
    ],
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.facts.externalPinSource, "caller");
  assert.equal(checked.facts.archiveSha256Matched, true);
  assert.equal(checked.facts.archiveBytesMatched, true);
  assert.equal(checked.facts.releaseVersionMatched, true);
  assert.equal(checked.facts.membersMatched, true);
  assert.equal(checked.facts.declarationMatchesExternal, true);
  assert.equal(checked.facts.contentVerified, false);
  assert.equal(checked.facts.publisherAuthenticated, false);
  assert.equal(checked.facts.runtimeIdentityVerified, false);
  assert.equal(checked.facts.trusted, false);

  const invalid = checkExternalExpectation({ ok: false }, { archiveSha256: sha("a") });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors[0].code, CODES.DECLARATION_INVALID);
});

test("多成员执行未获批准一律拒绝", () => {
  const parsed = parseReleaseMembers(v1());
  const eligibility = executionEligibility(parsed);
  assert.equal(eligibility.approved, false);
  assert.equal(eligibility.code, CODES.MULTI_MEMBER_EXECUTION_NOT_APPROVED);
  assert.equal(eligibility.memberCount, 2);
  assert.deepEqual(executionEligibility(null), {
    approved: false,
    code: CODES.DECLARATION_INVALID,
    memberCount: 0,
  });
});

test("错误诊断不含输入内容", () => {
  const secret = "/Users/secret-user/private/../../audio-analyze";
  const value = v1();
  value.members[0].path = secret;
  const result = parseReleaseMembers(value);
  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret-user"), false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("private"), false);
});

test("输入不被修改，返回结构冻结", () => {
  const input = v1();
  const snapshot = structuredClone(input);
  const result = parseReleaseMembers(input);
  assert.deepEqual(input, snapshot);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.facts), true);
  assert.equal(Object.isFrozen(result.declaration.archive), true);
  assert.equal(Object.isFrozen(result.declaration.members), true);
});

test("对象输入先按 descriptor 拒绝 accessor/隐藏/函数/symbol/自定义原型，且零调用", () => {
  let calls = 0;
  const getter = v1();
  Object.defineProperty(getter.release, "version", {
    enumerable: true,
    get() {
      calls += 1;
      return "1.0.0";
    },
  });
  assertFail(parseReleaseMembers(getter), CODES.INPUT_INVALID, "input");
  assert.equal(calls, 0);

  const hidden = v1();
  Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
  assertFail(parseReleaseMembers(hidden), CODES.INPUT_INVALID, "input");

  const func = v1();
  func.release.version = () => "1.0.0";
  assertFail(parseReleaseMembers(func), CODES.INPUT_INVALID, "input");

  const sym = v1();
  sym[Symbol("hidden")] = 1;
  assertFail(parseReleaseMembers(sym), CODES.INPUT_INVALID, "input");

  const proto = Object.assign(Object.create({ inherited: true }), v1());
  assertFail(parseReleaseMembers(proto), CODES.INPUT_INVALID, "input");

  const withToJSON = v1();
  Object.defineProperty(withToJSON, "toJSON", {
    enumerable: true,
    value() {
      calls += 1;
      return v1();
    },
  });
  assertFail(parseReleaseMembers(withToJSON), CODES.INPUT_INVALID, "input");
  assert.equal(calls, 0);
});

test("调用方 getter 抛错不逃逸，三入口固定诊断且不回显 marker", () => {
  const marker = "SYNTHETIC_TEST_MARKER_ACCESSOR";
  let calls = 0;
  const value = v1();
  Object.defineProperty(value.release, "version", {
    enumerable: true,
    get() {
      calls += 1;
      throw Error(marker);
    },
  });
  let thrown;
  let result;
  try {
    result = parseReleaseMembers(value);
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown, undefined);
  assert.equal(calls, 0);
  assertFail(result, CODES.INPUT_INVALID, "input");
  assert.equal(JSON.stringify(result).includes(marker), false);

  const parsed = parseReleaseMembers(v1());
  let expectedCalls = 0;
  const expected = {};
  Object.defineProperty(expected, "archiveSha256", {
    enumerable: true,
    get() {
      expectedCalls += 1;
      throw Error(marker);
    },
  });
  let expectedThrown;
  let expectedResult;
  try {
    expectedResult = checkExternalExpectation(parsed, expected);
  } catch (error) {
    expectedThrown = error;
  }
  assert.equal(expectedThrown, undefined);
  assert.equal(expectedCalls, 0);
  assert.equal(expectedResult.ok, false);
  assert.equal(expectedResult.errors[0].code, CODES.EXPECTATION_INVALID);
  assert.equal(JSON.stringify(expectedResult).includes(marker), false);

  let parsedCalls = 0;
  const forged = {};
  Object.defineProperty(forged, "ok", {
    enumerable: true,
    get() {
      parsedCalls += 1;
      throw Error(marker);
    },
  });
  let parsedThrown;
  let eligibility;
  try {
    eligibility = executionEligibility(forged);
  } catch (error) {
    parsedThrown = error;
  }
  assert.equal(parsedThrown, undefined);
  assert.equal(parsedCalls, 0);
  assert.equal(eligibility.approved, false);
  assert.equal(eligibility.code, CODES.DECLARATION_INVALID);
});

test("任意抛出值不逃逸：Proxy 抛出值/原始值/伪内部错误固定 fallback 且不读原型", () => {
  const marker = "SYNTHETIC_TEST_MARKER_THROWN_VALUE";
  let thrownPrototypeReads = 0;
  const thrownValue = new Proxy({}, {
    getPrototypeOf() {
      thrownPrototypeReads += 1;
      throw Error(marker);
    },
  });
  const throwingInput = new Proxy({}, {
    getPrototypeOf() {
      throw thrownValue;
    },
  });
  let escaped;
  let result;
  try {
    result = parseReleaseMembers(throwingInput);
  } catch (error) {
    escaped = error;
  }
  assert.equal(escaped, undefined);
  assert.equal(thrownPrototypeReads, 0);
  assertFail(result, CODES.INPUT_INVALID, "input");
  assert.equal(JSON.stringify(result).includes(marker), false);

  const parsed = parseReleaseMembers(v1());
  let expectedEscaped;
  let expectedResult;
  try {
    expectedResult = checkExternalExpectation(parsed, throwingInput);
  } catch (error) {
    expectedEscaped = error;
  }
  assert.equal(expectedEscaped, undefined);
  assert.equal(thrownPrototypeReads, 0);
  assert.equal(expectedResult.ok, false);
  assert.equal(expectedResult.errors[0].code, CODES.EXPECTATION_INVALID);
  assert.equal(JSON.stringify(expectedResult).includes(marker), false);

  for (const primitive of ["primitive-marker", 42, Symbol("primitive")]) {
    const primitiveInput = new Proxy({}, {
      getPrototypeOf() {
        throw primitive;
      },
    });
    let primitiveEscaped;
    let primitiveResult;
    try {
      primitiveResult = parseReleaseMembers(primitiveInput);
    } catch (error) {
      primitiveEscaped = error;
    }
    assert.equal(primitiveEscaped, undefined);
    assertFail(primitiveResult, CODES.INPUT_INVALID, "input");
  }

  const forged = Object.assign(new Error(marker), {
    name: "ContractViolation",
    code: CODES.SCHEMA_UNKNOWN,
    field: "schema",
  });
  const forgedInput = new Proxy({}, {
    getPrototypeOf() {
      throw forged;
    },
  });
  const forgedResult = parseReleaseMembers(forgedInput);
  assertFail(forgedResult, CODES.INPUT_INVALID, "input");
  assert.notEqual(forgedResult.errors[0].code, CODES.SCHEMA_UNKNOWN);
  assert.equal(JSON.stringify(forgedResult).includes(marker), false);
});

test("外部期望对象也走受限纯数据通道，不在 toJSON/原型/getter 上执行", () => {
  const parsed = parseReleaseMembers(v1());
  let calls = 0;
  const proto = Object.assign(Object.create({
    toJSON() {
      calls += 1;
      return { archiveSha256: sha("a") };
    },
  }), { archiveSha256: sha("a") });
  const protoResult = checkExternalExpectation(parsed, proto);
  assert.equal(protoResult.ok, false);
  assert.equal(protoResult.errors[0].code, CODES.EXPECTATION_INVALID);
  assert.equal(calls, 0);

  const hiddenHook = { archiveSha256: sha("a") };
  Object.defineProperty(hiddenHook, "toJSON", {
    value() {
      calls += 1;
      return { archiveSha256: sha("a") };
    },
  });
  const hiddenResult = checkExternalExpectation(parsed, hiddenHook);
  assert.equal(hiddenResult.ok, false);
  assert.equal(hiddenResult.errors[0].code, CODES.EXPECTATION_INVALID);
  assert.equal(calls, 0);

  const hiddenData = { archiveSha256: sha("a") };
  Object.defineProperty(hiddenData, "extra", { value: true, enumerable: false });
  assert.equal(checkExternalExpectation(parsed, hiddenData).ok, false);

  assert.equal(checkExternalExpectation(parsed, JSON.stringify({ archiveSha256: sha("a") })).ok, true);
});

test("只接受本模块真实 parse 品牌；伪造/克隆 parsed 一律拒绝", () => {
  const parsed = parseReleaseMembers(v1());
  assert.equal(checkExternalExpectation(parsed, { archiveSha256: sha("a") }).ok, true);

  const forged = { ok: true, declaration: { archive: { sha256: sha("a") } } };
  const forgedResult = checkExternalExpectation(forged, { archiveSha256: sha("a") });
  assert.equal(forgedResult.ok, false);
  assert.equal(forgedResult.errors[0].code, CODES.DECLARATION_INVALID);
  assert.notEqual(forgedResult.facts.declarationMatchesExternal, true);

  const cloned = structuredClone(parsed);
  const clonedResult = checkExternalExpectation(cloned, { archiveSha256: sha("a") });
  assert.equal(clonedResult.ok, false);
  assert.equal(clonedResult.errors[0].code, CODES.DECLARATION_INVALID);
  const clonedEligibility = executionEligibility(cloned);
  assert.equal(clonedEligibility.approved, false);
  assert.equal(clonedEligibility.code, CODES.DECLARATION_INVALID);

  const assigned = Object.assign({}, parsed);
  assert.equal(checkExternalExpectation(assigned, { archiveSha256: sha("a") }).ok, false);
});

test("循环、共享引用、过深结构和超限字符串在归一化阶段拒绝", () => {
  const cycle = v1();
  cycle.self = cycle;
  assertFail(parseReleaseMembers(cycle), CODES.INPUT_INVALID, "input");

  const shared = { value: 1 };
  const dag = v1();
  dag.first = shared;
  dag.second = shared;
  assertFail(parseReleaseMembers(dag), CODES.INPUT_INVALID, "input");

  let deep = 1;
  for (let index = 0; index < 20; index += 1) deep = { next: deep };
  const tooDeep = v1();
  tooDeep.deep = deep;
  assertFail(parseReleaseMembers(tooDeep), CODES.INPUT_INVALID, "input");

  const tooLarge = v1();
  tooLarge.padding = "x".repeat(5000);
  assertFail(parseReleaseMembers(tooLarge), CODES.INPUT_TOO_LARGE, "input");
});

test("__proto__ 只当普通键拒绝且不污染原型；null-prototype 纯数据可接受", () => {
  const polluted = v1();
  Object.defineProperty(polluted, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assertFail(parseReleaseMembers(polluted), CODES.KEYS_INVALID, "input");
  assert.equal({}.polluted, undefined);

  const nullProto = Object.assign(Object.create(null), v1());
  const result = parseReleaseMembers(nullProto);
  assert.equal(result.ok, true);
  const descriptor = Object.getOwnPropertyDescriptor(result.declaration.release, "version");
  assert.equal(typeof descriptor.value, "string");
  assert.equal(descriptor.get, undefined);
});


test("模块源码无 import / FS / 网络 / 进程 / 时钟 / 执行器依赖", () => {
  const source = fs.readFileSync(new URL("../server/audio-release-members.mjs", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/^\s*import\b/m.test(code), false);
  assert.equal(/\brequire\s*\(/.test(code), false);
  assert.equal(/\bnode:fs\b/.test(code), false);
  assert.equal(/\bnode:net\b/.test(code), false);
  assert.equal(/\bnode:http\b/.test(code), false);
  assert.equal(/\bchild_process\b/.test(code), false);
  assert.equal(/\bprocess\./.test(code), false);
  assert.equal(/\bDate\.now\b|\bnew Date\b/.test(code), false);
  assert.equal(/\bMath\.random\b/.test(code), false);
  assert.equal(/\bfetch\s*\(/.test(code), false);
  assert.equal(/\b(opendir|readdir|readFile|createReadStream)\b/.test(code), false);
  assert.equal(/\bENGINE_RELEASE\b/.test(code), false);
  assert.equal(/\bAudioEngine\b|\bAudioExecutor\b/.test(code), false);
});

test("合同常量与固定成员集合", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
  assert.equal(SCHEMA, "audio-release-members");
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(LEGACY_SCHEMA_VERSION, 0);
  assert.deepEqual([...FIXED_MEMBERS], ["audio-analyze", "lib/fixture.dylib"]);
  assert.deepEqual([...LEGACY_MEMBERS], ["audio-analyze"]);
  assert.equal(LIMITS.archiveMaxBytes, 130 * MiB);
  assert.equal(LIMITS.extractedMaxBytes, 256 * MiB);
  assert.equal(LIMITS.totalMemberMaxBytes, 256 * MiB);
  assert.equal(LIMITS.executorFileSizeLimitBytes, 64 * MiB);
});
