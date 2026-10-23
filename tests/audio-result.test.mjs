/**
 * T-LOCAL-013D：合成 brief-v1 结果规范化与版本指纹的定向测试。
 *
 * 全部输入均为合成 JSON/Buffer；不读写真实素材/库，不启动服务，不联网，
 * 不运行发行引擎。边界与验收项对应
 * `拾光云端后台/collab/specs/T-LOCAL-013D.md`。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  normalizeAudioResult,
  createAudioResultFingerprint,
  MAX_RESULT_BYTES,
  MAX_SEG_POINTS,
  SCHEMA_VERSION,
  PROTOCOL,
  WARNINGS,
  ERROR_CODES,
} from "../server/audio-result.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, "..", "server", "audio-result.mjs");

const CTX = Object.freeze({
  kind: "music",
  sourceSha256: "a".repeat(64),
  sourceSize: 12_345_678,
  durationSec: 245.5,
  engineVersion: "1.0.0",
  engineBinarySha256: "b".repeat(64),
  engineGeneration: "c".repeat(32),
  parameters: Object.freeze({ brief: true }),
});

function ctx(overrides = {}) {
  return { ...CTX, ...overrides };
}

function json(value) {
  return JSON.stringify(value);
}

function normalize(value, context = CTX) {
  const raw = typeof value === "string" || Buffer.isBuffer(value) ? value : json(value);
  return normalizeAudioResult(raw, context);
}

function ok(value, context = CTX) {
  const result = normalize(value, context);
  assert.equal(result.ok, true, `expected success, got ${json(result)}`);
  return result;
}

function failWith(value, code, context = CTX) {
  const result = normalize(value, context);
  assert.equal(result.ok, false, `expected failure, got ${json(result)}`);
  assert.equal(result.code, code, json(result));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0 && result.message.length <= 120);
  assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"]);
  return result;
}

/* ------------------------------------------------------------------ */
/* 正常结果与测量语义                                                   */
/* ------------------------------------------------------------------ */

test("正常音乐结果：完整字段、正 peak、0 分、seg 全部保留", () => {
  const result = ok({
    bpm: 128.5,
    key: { best: "C# minor", r: 0 },
    loud: { peak: 3, rms: -12.5 },
    energy: { min: -40, max: -6, std: 0 },
    fit: { beat: 1, tonal: 0, chord: 0.5 },
    seg: [0, 12.5, 60],
  });
  assert.equal(result.schemaVersion, SCHEMA_VERSION);
  assert.equal(result.protocol, PROTOCOL);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.value.bpm, 128.5);
  assert.deepEqual(result.value.key, {
    tonic: "C#",
    mode: "minor",
    keyScore: 0,
    recognized: true,
  });
  assert.deepEqual(result.value.loud, { peakDbfs: 3, rmsDbfs: -12.5 });
  assert.deepEqual(result.value.energy, { minDbfs: -40, maxDbfs: -6, stdDb: 0 });
  assert.deepEqual(result.value.fit, { beat: 1, tonal: 0, chord: 0.5 });
  assert.deepEqual(result.value.seg, { energyChangeSec: [0, 12.5, 60] });
});

test("sfx：仅 loud 也可成功", () => {
  const result = ok({ loud: { rms: -18 } }, ctx({ kind: "sfx", durationSec: 3 }));
  assert.equal(result.ok, true);
  assert.equal(result.provenance.kind, "sfx");
  assert.equal(result.value.bpm, null);
  assert.deepEqual(result.value.loud, { peakDbfs: null, rmsDbfs: -18 });
});

test("静音候选：边界 -200 dBFS 与 std=0 原样保留", () => {
  const result = ok({
    loud: { peak: -200, rms: -200 },
    energy: { min: -200, max: -200, std: 0 },
  });
  assert.deepEqual(result.value.loud, { peakDbfs: -200, rmsDbfs: -200 });
  assert.deepEqual(result.value.energy, { minDbfs: -200, maxDbfs: -200, stdDb: 0 });
});

test("缺失测量与 null 语义：所有允许字段都存在，缺失为 null", () => {
  const result = ok({ bpm: null, loud: { peak: null, rms: -1 }, fit: null, key: null });
  assert.deepEqual(Object.keys(result.value).sort(), [
    "bpm",
    "energy",
    "fit",
    "key",
    "loud",
    "seg",
  ]);
  assert.equal(result.value.bpm, null);
  assert.deepEqual(result.value.key, {
    tonic: null,
    mode: null,
    keyScore: null,
    recognized: false,
  });
  assert.deepEqual(result.value.energy, { minDbfs: null, maxDbfs: null, stdDb: null });
  assert.deepEqual(result.value.fit, { beat: null, tonal: null, chord: null });
  assert.equal(result.value.seg, null);
  assert.equal(Object.hasOwn(result.value.loud, "peakDbfs"), true);
  assert.equal(result.value.loud.peakDbfs, null);
});

test("bpm=0 归一 null 并固定 BPM_UNAVAILABLE，不称 0BPM", () => {
  const result = ok({ bpm: 0, loud: { rms: -10 } });
  assert.equal(result.value.bpm, null);
  assert.deepEqual(result.warnings, [WARNINGS.BPM_UNAVAILABLE]);
  // 只有 0 BPM 没有其它有效测量 -> 拒绝
  failWith({ bpm: 0 }, ERROR_CODES.NO_MEASUREMENT);
});

test("bpm 边界：合法 0.0001/400，非法负数/超界/字符串/布尔/1e999", () => {
  assert.equal(ok({ bpm: 0.0001 }).value.bpm, 0.0001);
  assert.equal(ok({ bpm: 400 }).value.bpm, 400);
  for (const bpm of [-1, 400.1, "120", true, [], {}]) {
    failWith({ bpm }, ERROR_CODES.INVALID_BPM);
  }
  // JSON 里的 1e999 解析为 Infinity；不能用 JSON.stringify（会变成 null）
  assert.equal(normalizeAudioResult('{"bpm":1e999}', CTX).code, ERROR_CODES.INVALID_BPM);
});

test("调性语法映射：空格/冒号、大小写 mode、升降号与 maj/min 归一", () => {
  const cases = [
    ["C major", "C", "major"],
    ["A minor", "A", "minor"],
    ["C:maj", "C", "major"],
    ["A:min", "A", "minor"],
    ["F#:major", "F#", "major"],
    ["Bb minor", "Bb", "minor"],
    ["Cb:min", "Cb", "minor"],
  ];
  for (const [best, tonic, mode] of cases) {
    const result = ok({ key: { best, r: 0.5 }, loud: { rms: -1 } });
    assert.deepEqual(result.value.key, {
      tonic,
      mode,
      keyScore: 0.5,
      recognized: true,
    }, best);
  }
});

test("无法识别的调性：不保留原文、不猜 major，固定 KEY_UNRECOGNIZED", () => {
  for (const best of ["C Major", "H major", "C", "C dorian", "C  major", "C:maj ", "x".repeat(32)]) {
    const result = ok({ bpm: 100, key: { best, r: 0.9 } });
    assert.deepEqual(result.value.key, {
      tonic: null,
      mode: null,
      keyScore: 0.9,
      recognized: false,
    }, best);
    assert.deepEqual(result.warnings, [WARNINGS.KEY_UNRECOGNIZED]);
    if (best.length > 1) {
      const serialized = json(result);
      assert.equal(serialized.includes(best), false);
    }
  }
  // 缺失/null 是 unknown，但没有“识别失败”warning
  const missing = ok({ bpm: 100, key: { best: null } });
  assert.deepEqual(missing.warnings, []);
  assert.equal(missing.value.key.recognized, false);
  assert.equal(ok({ bpm: 100, key: { best: "C major" } }).value.key.recognized, true);
  // 制表符/换行不算合法分隔
  for (const best of ["C\tmajor", "C\nmajor"]) {
    const result = ok({ bpm: 100, key: { best } });
    assert.equal(result.warnings.includes(WARNINGS.KEY_UNRECOGNIZED), true);
    assert.equal(result.value.key.tonic, null);
  }
});

test("调性类型/长度/keyScore 边界", () => {
  for (const best of [123, true, [], {}, "", "x".repeat(33)]) {
    failWith({ key: { best } }, ERROR_CODES.INVALID_KEY);
  }
  for (const r of [-0.1, 1.1, "0.5", true, []]) {
    failWith({ key: { best: "C major", r } }, ERROR_CODES.INVALID_KEY);
  }
  assert.equal(
    normalizeAudioResult('{"key":{"best":"C major","r":1e999}}', CTX).code,
    ERROR_CODES.INVALID_KEY,
  );
  // r 合法 0 保留
  assert.equal(ok({ key: { best: "C major", r: 0 } }).value.key.keyScore, 0);
  // 无 best 但有合法 r：保留分数；best 无法识别时 r 也不丢
  const unrecognizedScore = ok({ key: { best: "H major", r: 0.75 } });
  assert.deepEqual(unrecognizedScore.value.key, {
    tonic: null,
    mode: null,
    keyScore: 0.75,
    recognized: false,
  });
  const scoreOnly = ok({ key: { r: 0.25 } });
  assert.deepEqual(scoreOnly.value.key, {
    tonic: null,
    mode: null,
    keyScore: 0.25,
    recognized: false,
  });
});

test("loud：null/负值/合法 0/正 peak 保留，越界/类型错误拒绝", () => {
  const result = ok({ loud: { peak: 0, rms: -200 } });
  assert.equal(Object.is(result.value.loud.peakDbfs, 0), true);
  assert.equal(result.value.loud.rmsDbfs, -200);
  const negativeZero = ok('{"loud":{"peak":-0}}');
  assert.equal(Object.is(negativeZero.value.loud.peakDbfs, -0), true);

  for (const peak of [50.1, -200.1, "0", true, [], {}]) {
    failWith({ loud: { peak } }, ERROR_CODES.INVALID_LOUD);
  }
  assert.equal(
    normalizeAudioResult('{"loud":{"peak":1e999}}', CTX).code,
    ERROR_CODES.INVALID_LOUD,
  );
  failWith({ loud: [] }, ERROR_CODES.INVALID_LOUD);
  failWith({ loud: "x" }, ERROR_CODES.INVALID_LOUD);
});

test("energy：范围、min<=max、std>=0，边界保留", () => {
  assert.equal(ok({ energy: { min: 50, max: 50, std: 200 } }).value.energy.stdDb, 200);
  for (const energy of [
    { min: 1, max: 0 },
    { min: -201 },
    { max: 50.1 },
    { std: -0.1 },
    { std: 200.1 },
    { std: "0" },
    [],
    "x",
  ]) {
    failWith({ energy }, ERROR_CODES.INVALID_ENERGY);
  }
  // 只有 std 也算有效测量
  assert.equal(ok({ energy: { std: 0 } }).value.energy.stdDb, 0);
});

test("fit：仅 [0,1] 或 null，合法 0 保留", () => {
  const result = ok({ fit: { beat: 0, tonal: 1, chord: 0.5 } });
  assert.deepEqual(result.value.fit, { beat: 0, tonal: 1, chord: 0.5 });
  for (const fit of [{ beat: -0.01 }, { tonal: 1.01 }, { chord: "0.5" }, { beat: true }, []]) {
    failWith({ fit }, ERROR_CODES.INVALID_FIT);
  }
});

test("seg：严格递增、0..duration、最多 1000 点，不排序修复", () => {
  const max = Array.from({ length: MAX_SEG_POINTS }, (_, i) => i * 0.5);
  const result = ok({ seg: max }, ctx({ durationSec: 600 }));
  assert.equal(result.value.seg.energyChangeSec.length, MAX_SEG_POINTS);

  for (const seg of [
    Array.from({ length: 1001 }, (_, i) => i * 0.1),
    [0, 0],
    [1, 0.5],
    [-0.1, 1],
    [0, 245.5001],
    [0, "1"],
    [0, null],
    {},
    "x",
  ]) {
    failWith({ seg }, ERROR_CODES.INVALID_SEG);
  }
  // duration=0 时只允许一个 0 点
  assert.deepEqual(ok({ seg: [0] }, ctx({ durationSec: 0 })).value.seg.energyChangeSec, [0]);
  failWith({ seg: [0, 0] }, ERROR_CODES.INVALID_SEG, ctx({ durationSec: 0 }));
});

test("空 object / 只有未知字段 / 空嵌套对象 -> NO_MEASUREMENT", () => {
  for (const value of [{}, { future: 1 }, { key: {} }, { loud: {} }, { energy: {} }, { fit: {} }, { seg: [] }, { seg: null, key: null }]) {
    failWith(value, ERROR_CODES.NO_MEASUREMENT);
  }
});

/* ------------------------------------------------------------------ */
/* 输入形态：raw 类型、UTF-8、大小、JSON                                */
/* ------------------------------------------------------------------ */

test("raw 只接受 string/Buffer，不做隐式 String 转换", () => {
  for (const raw of [{}, [], 5, true, null, undefined, Symbol("x"), new Uint8Array([123, 125])]) {
    const result = normalizeAudioResult(raw, CTX);
    assert.equal(result.ok, false);
    assert.equal(result.code, ERROR_CODES.INVALID_RAW_TYPE);
  }
});

test("坏 JSON -> INVALID_JSON；顶层非普通对象 -> INVALID_SHAPE", () => {
  for (const raw of ['{"bpm":', "", "NaN", "{'bpm':1}"]) {
    failWith(raw, ERROR_CODES.INVALID_JSON);
  }
  for (const raw of ["[]", '"text"', "123", "null", "true"]) {
    failWith(raw, ERROR_CODES.INVALID_SHAPE);
  }
});

test("Buffer 非法 UTF-8 拒绝，不用替换字符掩盖", () => {
  const bad = Buffer.from([0x7b, 0xff, 0x7d]);
  const result = normalizeAudioResult(bad, CTX);
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.INVALID_UTF8);
});

test("64 KiB 实际字节边界：恰好 65536 接受，65537 拒绝", () => {
  const make = (size) => {
    const prefix = '{"loud":{"peak":-1},"pad":"';
    const suffix = '"}';
    const pad = "x".repeat(size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix));
    return prefix + pad + suffix;
  };
  const exact = make(MAX_RESULT_BYTES);
  assert.equal(Buffer.byteLength(exact), MAX_RESULT_BYTES);
  assert.equal(ok(exact).value.loud.peakDbfs, -1);
  assert.equal(ok(Buffer.from(exact)).value.loud.peakDbfs, -1);

  const over = make(MAX_RESULT_BYTES + 1);
  failWith(over, ERROR_CODES.RESULT_TOO_LARGE);
  assert.equal(normalizeAudioResult(Buffer.from(over), CTX).code, ERROR_CODES.RESULT_TOO_LARGE);
  // 多字节字符按实际 UTF-8 字节计
  const multibyte = '{"loud":{"peak":-1},"pad":"' + "音".repeat(22_000) + '"}';
  assert.ok(Buffer.byteLength(multibyte) > MAX_RESULT_BYTES);
  failWith(multibyte, ERROR_CODES.RESULT_TOO_LARGE);
});

/* ------------------------------------------------------------------ */
/* 未知字段与隐私                                                       */
/* ------------------------------------------------------------------ */

test("未知顶层/嵌套字段丢弃，UNKNOWN_FIELDS_IGNORED 只出现一次", () => {
  const result = ok({
    bpm: 120,
    loud: { peak: -1, path: "/private/a.wav" },
    key: { best: "C major", debug: "secret" },
    src: "/Users/private/source.wav",
    asr: { text: "private lyrics" },
    future: { nested: true },
  });
  assert.deepEqual(result.warnings, [WARNINGS.UNKNOWN_FIELDS_IGNORED]);
  assert.equal(result.warnings.filter((w) => w === WARNINGS.UNKNOWN_FIELDS_IGNORED).length, 1);
  const serialized = json(result);
  assert.equal(serialized.includes("private"), false);
  assert.equal(serialized.includes("source.wav"), false);
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("future"), false);
  assert.deepEqual(Object.keys(result.value).sort(), ["bpm", "energy", "fit", "key", "loud", "seg"]);
});

test("warning 只用固定枚举，不插入未知调性文本/路径", () => {
  const result = ok({ bpm: 90, key: { best: "/Users/secret" }, src: "/private/x" });
  assert.deepEqual([...result.warnings].sort(), [
    WARNINGS.KEY_UNRECOGNIZED,
    WARNINGS.UNKNOWN_FIELDS_IGNORED,
  ].sort());
  for (const warning of result.warnings) {
    assert.equal(typeof warning, "string");
    assert.equal(Object.values(WARNINGS).includes(warning), true);
  }
  const serialized = json(result);
  assert.equal(serialized.includes("/Users"), false);
  assert.equal(serialized.includes("/private"), false);
});

test("原型污染输入不改变输出原型/全局，也不出现污染键", () => {
  const raw = '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"bpm":100}';
  const result = normalizeAudioResult(raw, CTX);
  assert.equal(result.ok, true);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result.value, "polluted"), false);
  assert.equal(Object.getPrototypeOf(result.value), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.value.key), Object.prototype);
  assert.deepEqual(result.warnings, [WARNINGS.UNKNOWN_FIELDS_IGNORED]);

  const nested = normalizeAudioResult(
    '{"bpm":100,"key":{"best":"C major","__proto__":{"x":1}}}',
    CTX,
  );
  assert.equal(nested.ok, true);
  assert.equal(Object.getPrototypeOf(nested.value.key), Object.prototype);
  assert.deepEqual(nested.warnings, [WARNINGS.UNKNOWN_FIELDS_IGNORED]);
});

/* ------------------------------------------------------------------ */
/* context 严格校验                                                     */
/* ------------------------------------------------------------------ */

test("context 必填字段逐个缺失/错误类型 -> INVALID_CONTEXT", () => {
  const fields = [
    "kind",
    "sourceSha256",
    "sourceSize",
    "durationSec",
    "engineVersion",
    "engineBinarySha256",
    "engineGeneration",
    "parameters",
  ];
  for (const field of fields) {
    const broken = ctx();
    delete broken[field];
    const result = normalizeAudioResult('{"bpm":120}', broken);
    assert.equal(result.ok, false, field);
    assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT, field);
  }
  for (const context of [null, undefined, [], "x", 5, true]) {
    assert.equal(normalizeAudioResult('{"bpm":120}', context).code, ERROR_CODES.INVALID_CONTEXT);
  }
});

test("context 未知字段/符号键/非枚举键都拒绝", () => {
  assert.equal(
    normalizeAudioResult('{"bpm":120}', ctx({ path: "/private" })).code,
    ERROR_CODES.INVALID_CONTEXT,
  );
  const symbolic = ctx();
  symbolic[Symbol("extra")] = 1;
  assert.equal(normalizeAudioResult('{"bpm":120}', symbolic).code, ERROR_CODES.INVALID_CONTEXT);

  const hidden = ctx();
  Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false });
  assert.equal(normalizeAudioResult('{"bpm":120}', hidden).code, ERROR_CODES.INVALID_CONTEXT);
});

test("context 各字段边界：kind/sha/size/duration/version/generation", () => {
  const bad = [
    { kind: "audio" },
    { kind: null },
    { sourceSha256: "A".repeat(64) },
    { sourceSha256: "a".repeat(63) },
    { sourceSha256: "g".repeat(64) },
    { sourceSha256: 123 },
    { sourceSize: -1 },
    { sourceSize: 1.5 },
    { sourceSize: 256 * 1024 * 1024 + 1 },
    { sourceSize: "123" },
    { sourceSize: 1e999 },
    { durationSec: -0.1 },
    { durationSec: 600.1 },
    { durationSec: Infinity },
    { durationSec: NaN },
    { durationSec: "245" },
    { engineVersion: "" },
    { engineVersion: "a".repeat(129) },
    { engineVersion: "1.0 beta" },
    { engineVersion: "1.0\n" },
    { engineVersion: 1 },
    { engineBinarySha256: "B".repeat(64) },
    { engineBinarySha256: "b".repeat(63) },
    { engineGeneration: "c".repeat(31) },
    { engineGeneration: "c".repeat(65) },
    { engineGeneration: "C".repeat(32) },
    { engineGeneration: "z".repeat(32) },
  ];
  for (const override of bad) {
    const result = normalizeAudioResult('{"bpm":120}', ctx(override));
    assert.equal(result.ok, false, json(override));
    assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT, json(override));
  }

  // 合法边界
  const edges = [
    { sourceSize: 0 },
    { sourceSize: 256 * 1024 * 1024 },
    { durationSec: 0 },
    { durationSec: 600 },
    { engineVersion: "a".repeat(128) },
    { engineVersion: "1.0.0-rc.1+build_5" },
    { engineGeneration: "c".repeat(64) },
  ];
  for (const override of edges) {
    assert.equal(normalizeAudioResult('{"bpm":120}', ctx(override)).ok, true, json(override));
  }
});

test("context.parameters 固定 {brief:true}，顺序无关、多余键/错误值拒绝", () => {
  for (const parameters of [
    null,
    {},
    { brief: false },
    { brief: 1 },
    { brief: true, extra: 1 },
    { extra: 1 },
    [],
    "brief",
  ]) {
    const result = normalizeAudioResult('{"bpm":120}', ctx({ parameters }));
    assert.equal(result.ok, false, json(parameters));
    assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT);
  }
  const reordered = Object.fromEntries([["brief", true]]);
  assert.equal(normalizeAudioResult('{"bpm":120}', ctx({ parameters: reordered })).ok, true);
});

test("context 顶层访问器不执行 getter：两个导出函数都返回固定 INVALID_CONTEXT", () => {
  const fields = [
    "kind",
    "sourceSha256",
    "sourceSize",
    "durationSec",
    "engineVersion",
    "engineBinarySha256",
    "engineGeneration",
    "parameters",
  ];
  for (const field of fields) {
    let called = 0;
    const context = ctx();
    Object.defineProperty(context, field, {
      enumerable: true,
      configurable: true,
      get() {
        called++;
        // 即使 getter 返回合法值也必须拒绝，且绝不能执行。
        return CTX[field];
      },
    });
    for (const result of [
      createAudioResultFingerprint(context),
      normalizeAudioResult('{"bpm":120}', context),
    ]) {
      assert.equal(result.ok, false, field);
      assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT, field);
      assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"], field);
      assert.equal(json(result).includes("/private/"), false, field);
    }
    assert.equal(called, 0, `${field} getter must not run`);
  }
});

test("parameters.brief 访问器不执行 getter：抛错/合法返回值都拒绝", () => {
  for (const mode of ["throw", "value"]) {
    let called = 0;
    const parameters = {};
    Object.defineProperty(parameters, "brief", {
      enumerable: true,
      configurable: true,
      get() {
        called++;
        if (mode === "throw") throw new Error("/private/synthetic/context-secret");
        return true;
      },
    });
    for (const result of [
      createAudioResultFingerprint(ctx({ parameters })),
      normalizeAudioResult('{"bpm":120}', ctx({ parameters })),
    ]) {
      assert.equal(result.ok, false, mode);
      assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT, mode);
      assert.equal(json(result).includes("/private/"), false, mode);
    }
    assert.equal(called, 0, `${mode} brief getter must not run`);
  }
});

test("反射自身异常/撤销 Proxy 收敛为固定 INVALID_CONTEXT，不传播原文", () => {
  const secret = "/private/synthetic/context-secret";
  const revoked = Proxy.revocable(ctx(), {});
  revoked.revoke();
  const cases = [
    ["revoked", revoked.proxy],
    [
      "ownKeys throws",
      new Proxy(ctx(), {
        ownKeys() {
          throw new Error(secret);
        },
      }),
    ],
    [
      "ownKeys returns non-key",
      new Proxy(ctx(), {
        ownKeys() {
          return [1];
        },
      }),
    ],
    [
      "getPrototypeOf throws",
      new Proxy(ctx(), {
        getPrototypeOf() {
          throw new Error(secret);
        },
      }),
    ],
    [
      "getOwnPropertyDescriptor throws",
      new Proxy(ctx(), {
        getOwnPropertyDescriptor() {
          throw new Error(secret);
        },
      }),
    ],
    [
      "descriptor value getter throws",
      new Proxy(ctx(), {
        getOwnPropertyDescriptor() {
          return {
            enumerable: true,
            configurable: true,
            get value() {
              throw new Error(secret);
            },
          };
        },
      }),
    ],
  ];
  for (const [label, context] of cases) {
    for (const result of [
      createAudioResultFingerprint(context),
      normalizeAudioResult('{"bpm":120}', context),
    ]) {
      assert.equal(result.ok, false, label);
      assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT, label);
      assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"], label);
      assert.equal(json(result).includes(secret), false, label);
      assert.equal(json(result).includes("/private/"), false, label);
    }
  }
});

test("合法纯数据回归：冻结与 null-prototype context 仍可校验且指纹一致", () => {
  const bare = Object.assign(Object.create(null), CTX);
  bare.parameters = Object.assign(Object.create(null), { brief: true });
  const bareFingerprint = createAudioResultFingerprint(bare);
  const plainFingerprint = createAudioResultFingerprint(CTX);
  assert.equal(bareFingerprint.ok, true);
  assert.equal(bareFingerprint.fingerprint, plainFingerprint.fingerprint);

  const normalized = normalizeAudioResult('{"bpm":120}', bare);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.bpm, 120);
  assert.equal(normalized.fingerprint, plainFingerprint.fingerprint);

  const frozen = Object.freeze(ctx());
  const frozenFingerprint = createAudioResultFingerprint(frozen);
  assert.equal(frozenFingerprint.ok, true);
  assert.equal(frozenFingerprint.fingerprint, plainFingerprint.fingerprint);
});


/* ------------------------------------------------------------------ */
/* 指纹                                                                */
/* ------------------------------------------------------------------ */

test("指纹确定性：同 context 重复与参数键构造顺序一致", () => {
  const a = createAudioResultFingerprint(CTX);
  const b = createAudioResultFingerprint(ctx());
  const c = createAudioResultFingerprint(ctx({ parameters: Object.fromEntries([["brief", true]]) }));
  assert.equal(a.ok, true);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.fingerprint, c.fingerprint);
  assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(a.schemaVersion, 1);
  assert.equal(a.protocol, "brief-v1");
});

test("指纹：每个有效身份字段变化都改变结果", () => {
  const base = createAudioResultFingerprint(CTX).fingerprint;
  const variants = [
    { kind: "sfx" },
    { sourceSha256: "d".repeat(64) },
    { sourceSize: CTX.sourceSize + 1 },
    { durationSec: CTX.durationSec + 0.01 },
    { engineVersion: "1.0.1" },
    { engineBinarySha256: "e".repeat(64) },
    { engineGeneration: "f".repeat(32) },
  ];
  const seen = new Set([base]);
  for (const override of variants) {
    const fp = createAudioResultFingerprint(ctx(override)).fingerprint;
    assert.match(fp, /^[0-9a-f]{64}$/);
    assert.equal(seen.has(fp), false, json(override));
    seen.add(fp);
  }
  assert.equal(seen.size, variants.length + 1);
});

test("指纹失败固定 INVALID_CONTEXT，不回显输入", () => {
  const result = createAudioResultFingerprint({ ...CTX, engineVersion: "bad version /private" });
  assert.deepEqual(Object.keys(result).sort(), ["code", "message", "ok"]);
  assert.equal(result.ok, false);
  assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT);
  assert.equal(json(result).includes("/private"), false);
});

test("provenance 只含 allowlist 字段，不含路径/URL/argv", () => {
  const result = ok({ bpm: 100 });
  assert.deepEqual(Object.keys(result.provenance), [
    "kind",
    "sourceSha256",
    "sourceSize",
    "durationSec",
    "engineVersion",
    "engineBinarySha256",
    "engineGeneration",
    "parameters",
  ]);
  assert.deepEqual(result.provenance.parameters, { brief: true });
  assert.equal(Object.isFrozen(result.provenance), true);
  assert.equal(Object.isFrozen(result.provenance.parameters), true);
  assert.equal(result.provenance.fingerprint, undefined);
  assert.equal(result.provenance.path, undefined);
  assert.equal(result.provenance.sourceSha256, CTX.sourceSha256);
  assert.equal(result.fingerprint, createAudioResultFingerprint(CTX).fingerprint);
});

/* ------------------------------------------------------------------ */
/* 不可变 / 不保留调用方引用                                             */
/* ------------------------------------------------------------------ */

test("返回值深度不可变，输入 Buffer/context 后续修改不影响结果", () => {
  const raw = Buffer.from(json({ bpm: 120, loud: { peak: -1 } }));
  const context = ctx({ parameters: { brief: true } });
  const result = normalizeAudioResult(raw, context);
  assert.equal(result.ok, true);

  raw.fill(0x20);
  context.sourceSha256 = "d".repeat(64);
  context.parameters.brief = false;

  assert.equal(result.value.bpm, 120);
  assert.equal(result.provenance.sourceSha256, CTX.sourceSha256);
  assert.equal(result.provenance.parameters.brief, true);
  assert.equal(createAudioResultFingerprint(CTX).fingerprint, result.fingerprint);

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.seg), true);
  assert.throws(() => { result.value.bpm = 1; }, TypeError);
  assert.throws(() => { result.warnings.push("X"); }, TypeError);
  assert.throws(() => { result.provenance.kind = "sfx"; }, TypeError);
});

test("结果对象只含允许的顶层键", () => {
  const result = ok({ bpm: 100 });
  assert.deepEqual(Object.keys(result).sort(), [
    "fingerprint",
    "ok",
    "protocol",
    "provenance",
    "schemaVersion",
    "value",
    "warnings",
  ]);
  assert.equal(Object.hasOwn(result, "raw"), false);
  assert.equal(Object.hasOwn(result, "context"), false);
});

/* ------------------------------------------------------------------ */
/* 无副作用静态断言                                                     */
/* ------------------------------------------------------------------ */

test("模块不导入文件/网络/子进程能力，纯解析", async () => {
  const source = await readFile(MODULE_PATH, "utf8");
  for (const forbidden of [
    'from "node:fs',
    'from "fs',
    'from "node:net',
    'from "node:http',
    'from "node:https',
    'from "node:child_process',
    "child_process",
    "spawn(",
    "execFile(",
    "fetch(",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.match(source, /from "node:crypto"/);
});

test("失败结构稳定：同码同文案，且 message 不含输入片段", () => {
  const secret = "SECRET-DO-NOT-LEAK";
  const raw = `{"bpm":1e999,"note":${json(secret)}}`;
  const first = normalizeAudioResult(raw, CTX);
  const second = normalizeAudioResult(raw, CTX);
  assert.equal(first.code, second.code);
  assert.equal(first.message, second.message);
  assert.equal(json(first).includes(secret), false);
  assert.equal(first.code, ERROR_CODES.INVALID_BPM);
});
