/**
 * T-LOCAL-013D：合成 brief-v1 音频结果的规范化与版本指纹。
 *
 * 纯函数模块：只做有界 UTF-8/JSON 解析、允许字段校验与稳定指纹计算，
 * 不读写文件、不联网、不 spawn、不建表、不接触真实素材/库/引擎。
 *
 * 重要边界（见 collab/results/T-LOCAL-013D/report.md）：
 *   - protocol 固定标记为 "brief-v1"，表示这是**合成协议**，尚未经真实发行
 *     二进制协议验收，不宣称已与正式引擎兼容。
 *   - context 的 durationSec 由未来可信内部调用者提供；本模块不 probe 媒体，
 *     不证明该时长与真实文件一致。
 *   - fingerprint 只描述调用者给出的身份，不证明文件已 hash、当前仍被管理、
 *     缓存命中或已持久化；这些属于 T13B/T13C 与未来存储集成。
 */
import { createHash } from "node:crypto";

export const SCHEMA_VERSION = 1;
export const PROTOCOL = "brief-v1";
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_SEG_POINTS = 1000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const GENERATION_HEX = /^[0-9a-f]{32,64}$/;
const ENGINE_VERSION = /^[A-Za-z0-9._+-]{1,128}$/;
const KEY_BEST = /^([A-G])([#b]?)(?::| )(major|minor|maj|min)$/;

const CONTEXT_FIELDS = Object.freeze([
  "kind",
  "sourceSha256",
  "sourceSize",
  "durationSec",
  "engineVersion",
  "engineBinarySha256",
  "engineGeneration",
  "parameters",
]);
const CONTEXT_FIELD_SET = new Set(CONTEXT_FIELDS);
const TOP_FIELDS = new Set(["bpm", "key", "loud", "energy", "fit", "seg"]);
const KEY_FIELDS = new Set(["best", "r"]);
const LOUD_FIELDS = new Set(["peak", "rms"]);
const ENERGY_FIELDS = new Set(["min", "max", "std"]);
const FIT_FIELDS = new Set(["beat", "tonal", "chord"]);

/** 固定 warning 枚举；不含任何输入文本/字段名/路径。 */
export const WARNINGS = Object.freeze({
  BPM_UNAVAILABLE: "BPM_UNAVAILABLE",
  KEY_UNRECOGNIZED: "KEY_UNRECOGNIZED",
  UNKNOWN_FIELDS_IGNORED: "UNKNOWN_FIELDS_IGNORED",
});

/** 固定失败码（message 同样是固定短文案，不回显输入）。 */
export const ERROR_CODES = Object.freeze({
  INVALID_CONTEXT: "INVALID_CONTEXT",
  INVALID_RAW_TYPE: "INVALID_RAW_TYPE",
  RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
  INVALID_UTF8: "INVALID_UTF8",
  INVALID_JSON: "INVALID_JSON",
  INVALID_SHAPE: "INVALID_SHAPE",
  INVALID_BPM: "INVALID_BPM",
  INVALID_KEY: "INVALID_KEY",
  INVALID_LOUD: "INVALID_LOUD",
  INVALID_ENERGY: "INVALID_ENERGY",
  INVALID_FIT: "INVALID_FIT",
  INVALID_SEG: "INVALID_SEG",
  NO_MEASUREMENT: "NO_MEASUREMENT",
});

const MESSAGES = Object.freeze({
  INVALID_CONTEXT: "context does not match the required shape",
  INVALID_RAW_TYPE: "raw must be a string or Buffer",
  RESULT_TOO_LARGE: "result exceeds 64 KiB",
  INVALID_UTF8: "result is not valid UTF-8",
  INVALID_JSON: "result is not valid JSON",
  INVALID_SHAPE: "result must be a plain object",
  INVALID_BPM: "bpm must be null or a number in (0, 400]",
  INVALID_KEY: "key does not match the required shape",
  INVALID_LOUD: "loud does not match the required shape",
  INVALID_ENERGY: "energy does not match the required shape",
  INVALID_FIT: "fit does not match the required shape",
  INVALID_SEG: "seg does not match the required shape",
  NO_MEASUREMENT: "result has no supported measurement",
});

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * 规范化一条合成 brief-v1 结果。
 *
 * @param {string|Buffer} raw JSON 文本或 UTF-8 Buffer
 * @param {object} context 可信内部调用者提供的身份上下文
 * @returns {{ok:true, schemaVersion:1, protocol:"brief-v1", value:object,
 *   warnings:string[], provenance:object, fingerprint:string}
 *   | {ok:false, code:string, message:string}}
 */
export function normalizeAudioResult(raw, context) {
  const snapshot = validateContext(context);
  if (!snapshot.ok) return failure(ERROR_CODES.INVALID_CONTEXT);

  const parsed = parseRaw(raw);
  if (!parsed.ok) return parsed;

  const input = parsed.value;
  const warnings = [];
  const addWarning = (code) => {
    if (!warnings.includes(code)) warnings.push(code);
  };

  let unknownSeen = false;
  for (const name of Object.keys(input)) {
    if (!TOP_FIELDS.has(name)) unknownSeen = true;
  }

  const bpm = readBpm(input, addWarning);
  if (bpm.error) return failure(bpm.error);

  const key = readKey(input, addWarning, () => { unknownSeen = true; });
  if (key.error) return failure(key.error);

  const loud = readLoud(input, () => { unknownSeen = true; });
  if (loud.error) return failure(loud.error);

  const energy = readEnergy(input, () => { unknownSeen = true; });
  if (energy.error) return failure(energy.error);

  const fit = readFit(input, () => { unknownSeen = true; });
  if (fit.error) return failure(fit.error);

  const seg = readSeg(input, snapshot.durationSec);
  if (seg.error) return failure(seg.error);

  if (unknownSeen) addWarning(WARNINGS.UNKNOWN_FIELDS_IGNORED);

  const value = {
    bpm: bpm.value,
    key: key.value,
    loud: loud.value,
    energy: energy.value,
    fit: fit.value,
    seg: seg.value,
  };

  const hasMeasurement =
    bpm.present ||
    key.present ||
    loud.present ||
    energy.present ||
    fit.present ||
    seg.present;
  if (!hasMeasurement) return failure(ERROR_CODES.NO_MEASUREMENT);

  const provenance = buildProvenance(snapshot);
  const fingerprint = fingerprintOf(snapshot);

  return deepFreeze({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL,
    value,
    warnings,
    provenance,
    fingerprint,
  });
}

/**
 * 只用严格校验后的 context 生成稳定 SHA256 指纹。
 * 返回值为 allowlist provenance + 指纹，不回显整个 context。
 */
export function createAudioResultFingerprint(context) {
  const snapshot = validateContext(context);
  if (!snapshot.ok) return failure(ERROR_CODES.INVALID_CONTEXT);

  return deepFreeze({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    protocol: PROTOCOL,
    fingerprint: fingerprintOf(snapshot),
    provenance: buildProvenance(snapshot),
  });
}

/* ------------------------------------------------------------------ */
/* context                                                             */
/* ------------------------------------------------------------------ */

/**
 * context 只接受纯数据：逐字段读自有 data descriptor，访问器一律拒绝且**不执行**
 * getter；反射操作自身抛错（撤销 Proxy、trap 抛错、非法描述符）也收敛为固定
 * INVALID_CONTEXT，绝不向调用方传播输入异常或原始 message。
 */
function validateContext(context) {
  try {
    return readContext(context);
  } catch {
    return { ok: false };
  }
}

function readContext(context) {
  const data = ownDataValues(context, CONTEXT_FIELDS);
  if (data === null) return { ok: false };

  const { kind, sourceSha256, sourceSize, durationSec } = data;
  const { engineVersion, engineBinarySha256, engineGeneration, parameters } = data;

  if (kind !== "music" && kind !== "sfx") return { ok: false };
  if (typeof sourceSha256 !== "string" || !SHA256_HEX.test(sourceSha256)) return { ok: false };
  if (!Number.isSafeInteger(sourceSize) || sourceSize < 0 || sourceSize > 256 * 1024 * 1024) {
    return { ok: false };
  }
  if (!isFiniteNumber(durationSec) || durationSec < 0 || durationSec > 600) return { ok: false };
  if (typeof engineVersion !== "string" || !ENGINE_VERSION.test(engineVersion)) return { ok: false };
  if (typeof engineBinarySha256 !== "string" || !SHA256_HEX.test(engineBinarySha256)) {
    return { ok: false };
  }
  if (typeof engineGeneration !== "string" || !GENERATION_HEX.test(engineGeneration)) {
    return { ok: false };
  }
  const params = ownDataValues(parameters, ["brief"]);
  if (params === null || params.brief !== true) return { ok: false };

  // 只快照原始基本类型，不保留调用方可变引用。
  return {
    ok: true,
    kind,
    sourceSha256,
    sourceSize,
    durationSec,
    engineVersion,
    engineBinarySha256,
    engineGeneration,
    parameters: Object.freeze({ brief: true }),
  };
}

function buildProvenance(snapshot) {
  return Object.freeze({
    kind: snapshot.kind,
    sourceSha256: snapshot.sourceSha256,
    sourceSize: snapshot.sourceSize,
    durationSec: snapshot.durationSec,
    engineVersion: snapshot.engineVersion,
    engineBinarySha256: snapshot.engineBinarySha256,
    engineGeneration: snapshot.engineGeneration,
    parameters: Object.freeze({ brief: true }),
  });
}

/**
 * 结构化 canonical 编码：固定数组字段顺序 + 域标签，不依赖对象属性插入顺序，
 * 也不用分隔符字符串拼接。
 */
function canonicalPayload(snapshot) {
  return JSON.stringify([
    "shiguang.audio-result.fingerprint",
    SCHEMA_VERSION,
    PROTOCOL,
    snapshot.kind,
    snapshot.sourceSha256,
    snapshot.sourceSize,
    snapshot.durationSec,
    snapshot.engineVersion,
    snapshot.engineBinarySha256,
    snapshot.engineGeneration,
    "brief",
    true,
  ]);
}

function fingerprintOf(snapshot) {
  return createHash("sha256").update(canonicalPayload(snapshot), "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* raw parsing                                                         */
/* ------------------------------------------------------------------ */

function parseRaw(raw) {
  let text;
  if (typeof raw === "string") {
    if (Buffer.byteLength(raw, "utf8") > MAX_RESULT_BYTES) {
      return failure(ERROR_CODES.RESULT_TOO_LARGE);
    }
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    if (raw.length > MAX_RESULT_BYTES) return failure(ERROR_CODES.RESULT_TOO_LARGE);
    try {
      // fatal：非法 UTF-8 直接拒绝，不用 U+FFFD 掩盖。
      text = UTF8.decode(raw);
    } catch {
      return failure(ERROR_CODES.INVALID_UTF8);
    }
  } else {
    return failure(ERROR_CODES.INVALID_RAW_TYPE);
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return failure(ERROR_CODES.INVALID_JSON);
  }
  if (!isPlainObject(value)) return failure(ERROR_CODES.INVALID_SHAPE);
  return { ok: true, value };
}

/* ------------------------------------------------------------------ */
/* field readers                                                       */
/* ------------------------------------------------------------------ */

function readBpm(input, addWarning) {
  if (!hasOwn(input, "bpm")) return emptyField(null);
  const bpm = input.bpm;
  if (bpm === null) return emptyField(null);
  if (!isFiniteNumber(bpm)) return { error: ERROR_CODES.INVALID_BPM };
  if (bpm === 0) {
    // 0 表示“没有有效 BPM”，归一为 null，不称 0 BPM。
    addWarning(WARNINGS.BPM_UNAVAILABLE);
    return emptyField(null);
  }
  if (bpm < 0 || bpm > 400) return { error: ERROR_CODES.INVALID_BPM };
  return { value: bpm, present: true };
}

function readKey(input, addWarning, markUnknown) {
  if (!hasOwn(input, "key") || input.key === null) return emptyKey();
  const key = input.key;
  if (!isPlainObject(key)) return { error: ERROR_CODES.INVALID_KEY };
  for (const name of Object.keys(key)) {
    if (!KEY_FIELDS.has(name)) markUnknown();
  }

  let tonic = null;
  let mode = null;
  let recognized = false;
  let present = false;

  if (hasOwn(key, "best") && key.best !== null) {
    if (typeof key.best !== "string") return { error: ERROR_CODES.INVALID_KEY };
    if (key.best.length === 0 || key.best.length > 32) {
      return { error: ERROR_CODES.INVALID_KEY };
    }
    const match = KEY_BEST.exec(key.best);
    if (match) {
      tonic = `${match[1]}${match[2]}`;
      mode = match[3] === "maj" ? "major" : match[3] === "min" ? "minor" : match[3];
      recognized = true;
      present = true;
    } else {
      // 不保留原始 best，也不猜 major；tonic/mode 保持 null。
      addWarning(WARNINGS.KEY_UNRECOGNIZED);
    }
  }

  let keyScore = null;
  if (hasOwn(key, "r") && key.r !== null) {
    if (!isFiniteNumber(key.r) || key.r < 0 || key.r > 1) {
      return { error: ERROR_CODES.INVALID_KEY };
    }
    // keyScore 是独立数值测量；best 无法识别时仍保留，但 recognized=false。
    keyScore = key.r;
    present = true;
  }

  return {
    value: { tonic, mode, keyScore, recognized },
    present,
  };
}

function readLoud(input, markUnknown) {
  if (!hasOwn(input, "loud") || input.loud === null) return emptyLoud();
  const loud = input.loud;
  if (!isPlainObject(loud)) return { error: ERROR_CODES.INVALID_LOUD };
  for (const name of Object.keys(loud)) {
    if (!LOUD_FIELDS.has(name)) markUnknown();
  }

  let peak = null;
  let rms = null;
  let present = false;
  for (const [name, target] of [["peak", "peak"], ["rms", "rms"]]) {
    if (!hasOwn(loud, name) || loud[name] === null) continue;
    const value = loud[name];
    if (!isFiniteNumber(value) || value < -200 || value > 50) {
      return { error: ERROR_CODES.INVALID_LOUD };
    }
    if (target === "peak") peak = value;
    else rms = value;
    present = true;
  }
  return { value: { peakDbfs: peak, rmsDbfs: rms }, present };
}

function readEnergy(input, markUnknown) {
  if (!hasOwn(input, "energy") || input.energy === null) return emptyEnergy();
  const energy = input.energy;
  if (!isPlainObject(energy)) return { error: ERROR_CODES.INVALID_ENERGY };
  for (const name of Object.keys(energy)) {
    if (!ENERGY_FIELDS.has(name)) markUnknown();
  }

  let min = null;
  let max = null;
  let std = null;
  let present = false;
  for (const name of ["min", "max"]) {
    if (!hasOwn(energy, name) || energy[name] === null) continue;
    const value = energy[name];
    if (!isFiniteNumber(value) || value < -200 || value > 50) {
      return { error: ERROR_CODES.INVALID_ENERGY };
    }
    if (name === "min") min = value;
    else max = value;
    present = true;
  }
  if (min !== null && max !== null && min > max) {
    return { error: ERROR_CODES.INVALID_ENERGY };
  }
  if (hasOwn(energy, "std") && energy.std !== null) {
    const value = energy.std;
    if (!isFiniteNumber(value) || value < 0 || value > 200) {
      return { error: ERROR_CODES.INVALID_ENERGY };
    }
    std = value;
    present = true;
  }
  return { value: { minDbfs: min, maxDbfs: max, stdDb: std }, present };
}

function readFit(input, markUnknown) {
  if (!hasOwn(input, "fit") || input.fit === null) return emptyFit();
  const fit = input.fit;
  if (!isPlainObject(fit)) return { error: ERROR_CODES.INVALID_FIT };
  for (const name of Object.keys(fit)) {
    if (!FIT_FIELDS.has(name)) markUnknown();
  }

  const value = { beat: null, tonal: null, chord: null };
  let present = false;
  for (const name of ["beat", "tonal", "chord"]) {
    if (!hasOwn(fit, name) || fit[name] === null) continue;
    const score = fit[name];
    if (!isFiniteNumber(score) || score < 0 || score > 1) {
      return { error: ERROR_CODES.INVALID_FIT };
    }
    value[name] = score;
    present = true;
  }
  return { value, present };
}

function readSeg(input, durationSec) {
  if (!hasOwn(input, "seg") || input.seg === null) return emptySeg();
  const seg = input.seg;
  if (!Array.isArray(seg) || seg.length > MAX_SEG_POINTS) {
    return { error: ERROR_CODES.INVALID_SEG };
  }
  let previous = -Infinity;
  for (const point of seg) {
    if (!isFiniteNumber(point)) return { error: ERROR_CODES.INVALID_SEG };
    if (point < 0 || point > durationSec) return { error: ERROR_CODES.INVALID_SEG };
    // 严格递增：不排序“修复”逆序/重复输入。
    if (point <= previous) return { error: ERROR_CODES.INVALID_SEG };
    previous = point;
  }
  return {
    value: { energyChangeSec: [...seg] },
    present: seg.length > 0,
  };
}

/* ------------------------------------------------------------------ */
/* empty values                                                        */
/* ------------------------------------------------------------------ */

function emptyField(value) {
  return { value, present: false };
}

function emptyKey() {
  return { value: { tonic: null, mode: null, keyScore: null, recognized: false }, present: false };
}

function emptyLoud() {
  return { value: { peakDbfs: null, rmsDbfs: null }, present: false };
}

function emptyEnergy() {
  return { value: { minDbfs: null, maxDbfs: null, stdDb: null }, present: false };
}

function emptyFit() {
  return { value: { beat: null, tonal: null, chord: null }, present: false };
}

function emptySeg() {
  return { value: null, present: false };
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function failure(code) {
  return Object.freeze({ ok: false, code, message: MESSAGES[code] });
}

function hasOwn(object, name) {
  return Object.prototype.hasOwnProperty.call(object, name);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 读取恰好 expected 个自有字符串键的 data descriptor 值。
 * 访问器（无论是否 enumerable）、符号键、未知/缺失键一律返回 null；
 * 这里只做数据读取，不执行调用方 getter。反射 trap 抛出的异常由调用方收敛。
 */
function ownDataValues(object, expected) {
  if (!isPlainObject(object)) return null;
  const keys = Reflect.ownKeys(object);
  if (keys.length !== expected.length) return null;
  const values = Object.create(null);
  for (const name of keys) {
    if (typeof name !== "string" || !expected.includes(name)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    values[name] = descriptor.value;
  }
  for (const name of expected) {
    if (!Object.hasOwn(values, name)) return null;
  }
  return values;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const name of Object.keys(value)) deepFreeze(value[name]);
  return Object.freeze(value);
}
