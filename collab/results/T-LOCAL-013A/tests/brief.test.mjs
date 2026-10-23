/**
 * T-LOCAL-013A：brief JSON 合成协议夹具测试。
 * 只验证字段/边界/未知字段/0/负 dBFS 的解析行为；不运行真实引擎，不宣称 BPM/调性准确。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseBrief, MAX_BRIEF_BYTES } from "../brief.mjs";

test("合法 0 与负 dBFS 原样保留，null bpm 不被写成 0", () => {
  const parsed = parseBrief(JSON.stringify({
    bpm: null,
    key: { best: "unknown" },
    loud: { peak: 0, rms: -14.25 },
    energy: { min: 0, max: 0, std: 0 },
  }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.value.bpm, null);
  assert.equal(parsed.value.loud.peak, 0);
  assert.equal(parsed.value.loud.rms, -14.25);
  assert.equal(parsed.value.energy.min, 0);
  assert.equal(parsed.value.energy.max, 0);
});

test("负零与合法负值不被 truthy 判断吞掉", () => {
  const parsed = parseBrief('{"loud":{"peak":-0,"rms":-0.5},"energy":{"min":-60,"max":-1,"std":0}}');
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(Object.is(parsed.value.loud.peak, -0), true);
  assert.equal(parsed.value.loud.rms, -0.5);
  assert.equal(parsed.value.energy.std, 0);
});

test("未知字段忽略并给 warning，不因未来扩展字段失败", () => {
  const parsed = parseBrief(JSON.stringify({
    bpm: 120,
    loud: { peak: -1 },
    future_metric: 123,
    nested_future: { x: 1 },
  }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.value, { bpm: 120, loud: { peak: -1 } });
  assert.ok(parsed.warnings.some((line) => line.includes("future_metric")));
  assert.ok(parsed.warnings.some((line) => line.includes("nested_future")));
});

test("非法类型/范围/0 bpm 明确 INVALID_OUTPUT", () => {
  for (const raw of [
    '{"bpm":0}',
    '{"bpm":"120"}',
    '{"bpm":-1}',
    '{"loud":{"rms":"-14"}}',
    '{"loud":{"rms":-500}}',
    '{"key":{"r":1.5}}',
    '{"energy":{"min":null}}',
    '{"seg":[1,"2"]}',
    '{"seg":' + JSON.stringify(Array.from({ length: 1001 }, (_, i) => i)) + '}',
    '[]',
    '"text"',
    '{"unknown_only":1}',
  ]) {
    const parsed = parseBrief(raw);
    assert.equal(parsed.ok, false, raw);
    assert.equal(parsed.code, "INVALID_OUTPUT", raw);
  }
});

test("坏 JSON 明确 INVALID_OUTPUT，不抛异常", () => {
  const parsed = parseBrief('{"bpm":');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "INVALID_OUTPUT");
});

test("超过 64 KiB 明确 OUTPUT_LIMIT", () => {
  const raw = JSON.stringify({ loud: { peak: -1 }, padding: "x".repeat(MAX_BRIEF_BYTES) });
  const parsed = parseBrief(raw);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, "OUTPUT_LIMIT");
});
