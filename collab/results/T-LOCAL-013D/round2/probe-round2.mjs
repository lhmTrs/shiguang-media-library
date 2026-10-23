/**
 * T-LOCAL-013D round2 本地对抗探针（合成数据，纯内存）。
 *
 * 覆盖 #0092 要求的 context 边界：顶层/parameters 访问器不执行、
 * 撤销 Proxy 与反射 trap 抛错收敛为固定 INVALID_CONTEXT、两个导出函数
 * 都不向调用方抛异常/不带输入片段；同时回归合法纯数据/null-prototype/冻结。
 */
import assert from 'node:assert/strict';
import {
  normalizeAudioResult,
  createAudioResultFingerprint,
  ERROR_CODES,
} from '../../../../server/audio-result.mjs';

const SECRET = '/private/synthetic/probe-context-secret';
const FIELDS = [
  'kind', 'sourceSha256', 'sourceSize', 'durationSec',
  'engineVersion', 'engineBinarySha256', 'engineGeneration', 'parameters',
];
const context = () => ({
  kind: 'music', sourceSha256: 'a'.repeat(64), sourceSize: 100,
  durationSec: 10, engineVersion: '1.0.0', engineBinarySha256: 'b'.repeat(64),
  engineGeneration: 'c'.repeat(32), parameters: { brief: true },
});
const raw = '{"bpm":120}';
const results = [];

function check(label, ctx) {
  let getterCalls = 0;
  for (const [name, invoke] of [
    ['normalizeAudioResult', () => normalizeAudioResult(raw, ctx)],
    ['createAudioResultFingerprint', () => createAudioResultFingerprint(ctx)],
  ]) {
    let result;
    try {
      result = invoke();
    } catch (error) {
      throw new Error(`${label}/${name} threw: ${error && error.message}`);
    }
    assert.equal(result.ok, false, `${label}/${name} accepted`);
    assert.equal(result.code, ERROR_CODES.INVALID_CONTEXT, `${label}/${name} code`);
    assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok']);
    assert.equal(JSON.stringify(result).includes(SECRET), false, `${label}/${name} leaked`);
    assert.equal(JSON.stringify(result).includes('/private/'), false, `${label}/${name} leaked path`);
    results.push({ label, fn: name, ok: result.ok, code: result.code, getterCalls });
  }
}

// 1) 8 个顶层字段逐个改为返回合法值的 getter：必须拒绝且不执行 getter。
for (const field of FIELDS) {
  let calls = 0;
  const ctx = context();
  Object.defineProperty(ctx, field, {
    enumerable: true, configurable: true,
    get() { calls++; return context()[field]; },
  });
  check(`top-level-accessor:${field}`, ctx);
  assert.equal(calls, 0, `${field} getter executed`);
}
results.push({ label: 'top-level-accessors', getterCalls: 0, verdict: 'not-executed' });

// 2) parameters.brief 抛错/返回合法值两种访问器均拒绝且不执行。
for (const mode of ['throw', 'value']) {
  let calls = 0;
  const ctx = context();
  Object.defineProperty(ctx.parameters, 'brief', {
    enumerable: true, configurable: true,
    get() {
      calls++;
      if (mode === 'throw') throw new Error(SECRET);
      return true;
    },
  });
  check(`parameters-brief-accessor:${mode}`, ctx);
  assert.equal(calls, 0, `parameters.brief ${mode} getter executed`);
}
results.push({ label: 'parameters-accessors', getterCalls: 0, verdict: 'not-executed' });

// 3) 撤销 Proxy 与反射 trap 自身抛错 -> 固定错误，不抛给调用方。
const revoked = Proxy.revocable(context(), {});
revoked.revoke();
const reflectionCases = [
  ['revoked-proxy', revoked.proxy],
  ['ownKeys-throws', new Proxy(context(), { ownKeys() { throw new Error(SECRET); } })],
  ['ownKeys-invalid-key', new Proxy(context(), { ownKeys() { return [1]; } })],
  ['getPrototypeOf-throws', new Proxy(context(), { getPrototypeOf() { throw new Error(SECRET); } })],
  ['getOwnPropertyDescriptor-throws', new Proxy(context(), {
    getOwnPropertyDescriptor() { throw new Error(SECRET); },
  })],
  ['descriptor-value-getter-throws', new Proxy(context(), {
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true, get value() { throw new Error(SECRET); } };
    },
  })],
];
for (const [label, ctx] of reflectionCases) check(label, ctx);

// 4) 合法纯数据回归：普通/冻结/null-prototype context 指纹一致。
const plain = createAudioResultFingerprint(context());
const bare = Object.assign(Object.create(null), context());
bare.parameters = Object.assign(Object.create(null), { brief: true });
const bareResult = createAudioResultFingerprint(bare);
const frozenResult = createAudioResultFingerprint(Object.freeze(context()));
const normalized = normalizeAudioResult(raw, bare);
assert.equal(plain.ok, true);
assert.equal(bareResult.ok, true);
assert.equal(frozenResult.ok, true);
assert.equal(normalized.ok, true);
assert.equal(bareResult.fingerprint, plain.fingerprint);
assert.equal(frozenResult.fingerprint, plain.fingerprint);
assert.equal(normalized.fingerprint, plain.fingerprint);
results.push({ label: 'legit-data-regression', verdict: 'fingerprint-consistent' });

console.log(JSON.stringify({
  probe: 'T-LOCAL-013D-round2-local',
  checks: results,
  summary: { cases: results.length, verdict: 'all-fixed-invalid-context-without-getter-execution' },
}, null, 2));
