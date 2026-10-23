/**
 * T-LOCAL-013A：brief JSON 的合成协议夹具解析器。
 *
 * 只按当前可读源码 / T-LOCAL-013-DRAFT 的字段做静态核对，用合成 JSON 验证边界；
 * 不代表已运行真实发行引擎，也不宣称 BPM/调性准确。
 */
const MAX_BRIEF_BYTES = 64 * 1024;
const KNOWN_TOP = new Set(["bpm", "key", "loud", "energy", "fit", "seg"]);

export function parseBrief(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
  if (Buffer.byteLength(text, "utf8") > MAX_BRIEF_BYTES) {
    return fail("OUTPUT_LIMIT", "brief exceeds 64 KiB");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("INVALID_OUTPUT", "brief is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fail("INVALID_OUTPUT", "brief must be an object");
  }

  const value = {};
  const warnings = [];

  if (Object.prototype.hasOwnProperty.call(parsed, "bpm")) {
    if (parsed.bpm === null) {
      value.bpm = null;
    } else if (isFiniteNumber(parsed.bpm) && parsed.bpm > 0 && parsed.bpm <= 400) {
      value.bpm = parsed.bpm;
    } else {
      return fail("INVALID_OUTPUT", "bpm must be null or a finite number in (0, 400]");
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "key")) {
    const key = parsed.key;
    if (!key || typeof key !== "object" || Array.isArray(key)) return fail("INVALID_OUTPUT", "key must be an object");
    value.key = {};
    if (key.best !== undefined) {
      if (typeof key.best !== "string" || key.best.length === 0 || key.best.length > 32) {
        return fail("INVALID_OUTPUT", "key.best must be a short string");
      }
      value.key.best = key.best;
    }
    if (key.r !== undefined) {
      if (!isFiniteNumber(key.r) || key.r < 0 || key.r > 1) return fail("INVALID_OUTPUT", "key.r must be in [0,1]");
      value.key.r = key.r;
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "loud")) {
    const loud = parsed.loud;
    if (!loud || typeof loud !== "object" || Array.isArray(loud)) return fail("INVALID_OUTPUT", "loud must be an object");
    value.loud = {};
    for (const field of ["peak", "rms"]) {
      if (loud[field] !== undefined) {
        if (!isFiniteNumber(loud[field]) || loud[field] < -200 || loud[field] > 50) {
          return fail("INVALID_OUTPUT", `loud.${field} out of range`);
        }
        // 合法 0 与负 dBFS 原样保留，不做 Number(x) || null。
        value.loud[field] = loud[field];
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "energy")) {
    const energy = parsed.energy;
    if (!energy || typeof energy !== "object" || Array.isArray(energy)) {
      return fail("INVALID_OUTPUT", "energy must be an object");
    }
    value.energy = {};
    for (const field of ["min", "max", "std"]) {
      if (energy[field] !== undefined) {
        if (!isFiniteNumber(energy[field]) || energy[field] < -200 || energy[field] > 200) {
          return fail("INVALID_OUTPUT", `energy.${field} out of range`);
        }
        value.energy[field] = energy[field];
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "fit")) {
    const fit = parsed.fit;
    if (!fit || typeof fit !== "object" || Array.isArray(fit)) return fail("INVALID_OUTPUT", "fit must be an object");
    value.fit = {};
    for (const field of ["beat", "tonal", "chord"]) {
      if (fit[field] !== undefined) {
        if (!isFiniteNumber(fit[field]) || fit[field] < 0 || fit[field] > 1) {
          return fail("INVALID_OUTPUT", `fit.${field} must be in [0,1]`);
        }
        value.fit[field] = fit[field];
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(parsed, "seg")) {
    if (!Array.isArray(parsed.seg) || parsed.seg.length > 1000) return fail("INVALID_OUTPUT", "seg must be a bounded array");
    for (const point of parsed.seg) {
      if (!isFiniteNumber(point) || point < 0 || point > 86_400) return fail("INVALID_OUTPUT", "seg point out of range");
    }
    value.seg = [...parsed.seg];
  }

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP.has(key)) warnings.push(`unknown field ignored: ${key}`);
  }

  if (Object.keys(value).length === 0) return fail("INVALID_OUTPUT", "brief has no known measurement field");
  return { ok: true, value, warnings };
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function fail(code, message) {
  return { ok: false, code, message };
}

export { MAX_BRIEF_BYTES };
