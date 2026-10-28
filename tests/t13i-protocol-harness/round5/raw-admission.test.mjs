/**
 * T13I-PROTOCOL-HARNESS-20261024 round5：raw 准入守卫的定向自测。
 *
 * 只使用合成 fake adapter 与临时目录；不启动引擎/真实 clang/ffprobe，不读真实素材，
 * 不联网，不安装/解包/下载，不改产品模块。
 *
 * round5 只补独立审查 round4 的窄 P2：`Buffer.isBuffer(Object.create(Buffer.prototype))`
 * 为 true，但 `ArrayBuffer.isView()` 为 false，旧 `new Uint8Array(value)` 会回退到
 * 调用方 `Symbol.iterator`。这里验证：真实 byte view 才准入；非 view/Proxy/普通原型
 * 伪装在复制前固定拒绝且 0 次 iterator/coercion；真实 Buffer 的复制与隔离不回归。
 *
 * 按工单不重跑 round2/round3 的 32 项、canonical 12、strict success 与旧 27+12。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HARNESS_CODES } from "./contracts.mjs";
import { runProtocolHarness } from "./harness.mjs";
import { createCase, makeDescriptor, NORMAL_RAW } from "./scenarios.mjs";
import { createFakeExecutor } from "./fakes.mjs";

const SNAPSHOT = Object.freeze({
  filePath: "/tmp/t13i-synthetic-raw-admission.wav",
  bytes: 1,
  sha256: "0".repeat(64),
});
const RAW_TYPE_REJECT = (error) =>
  error.code === HARNESS_CODES.INVALID_REQUEST && error.detail === "fake_executor_raw_type";

function assertFixedReject(raw) {
  assert.throws(() => createFakeExecutor({ raw }), RAW_TYPE_REJECT);
}

async function runFull(executor) {
  const entry = createCase("normal");
  const adapters = Object.freeze({
    lease: entry.adapters.lease,
    executor,
    probe: entry.adapters.probe,
  });
  return runProtocolHarness(entry.scenario, adapters);
}

async function rawFromExecute(executor) {
  const raw = await executor.execute(SNAPSHOT, makeDescriptor(), Object.freeze({}));
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
}

test("原审查反例：非 view 的 Buffer.prototype 伪装在 iterable fallback 前固定拒绝", () => {
  const raw = Object.create(Buffer.prototype);
  let iteratorCalls = 0;
  Object.defineProperty(raw, Symbol.iterator, {
    value: function* () {
      iteratorCalls += 1;
      yield* Buffer.from(NORMAL_RAW, "utf8");
    },
  });

  assert.equal(Buffer.isBuffer(raw), true, "counterexample must still satisfy Buffer.isBuffer");
  assert.equal(ArrayBuffer.isView(raw), false, "counterexample must not be a real typed-array view");
  assertFixedReject(raw);
  assert.equal(iteratorCalls, 0, "rejection must happen before iterable fallback");
});

test("同一非 view 伪装无 iterator / 带 coercion accessor 也固定拒绝且不读 getter", () => {
  const raw = Object.create(Buffer.prototype);
  let getterCalls = 0;
  for (const key of ["valueOf", "toString", "length", "constructor", "buffer", "byteOffset", "byteLength"]) {
    Object.defineProperty(raw, key, {
      configurable: true,
      get() {
        getterCalls += 1;
        throw new Error("caller getter must not run");
      },
    });
  }

  assertFixedReject(raw);
  assert.equal(getterCalls, 0, "guard must use intrinsic slot checks, not caller getters");
});

test("普通原型伪装矩阵：Buffer.prototype / Uint8Array.prototype / 空原型均拒绝", () => {
  const values = [
    Object.create(Buffer.prototype),
    Object.create(Uint8Array.prototype),
    Buffer.prototype,
    Object.create(null),
  ];
  for (const raw of values) {
    assertFixedReject(raw);
  }
});

test("Proxy 包真实 Buffer：Buffer.isBuffer=true 但非 view，固定拒绝且不触发 get/iterator", () => {
  const target = Buffer.from(NORMAL_RAW, "utf8");
  let iteratorCalls = 0;
  Object.defineProperty(target, Symbol.iterator, {
    value: function* () {
      iteratorCalls += 1;
      yield* Buffer.from(NORMAL_RAW, "utf8");
    },
  });
  let getCalls = 0;
  const proxy = new Proxy(target, {
    get(object, key, receiver) {
      getCalls += 1;
      return Reflect.get(object, key, receiver);
    },
  });

  assert.equal(Buffer.isBuffer(proxy), true);
  assert.equal(ArrayBuffer.isView(proxy), false);
  assertFixedReject(proxy);
  assert.equal(getCalls, 0, "guard must not read through the proxy");
  assert.equal(iteratorCalls, 0, "guard must not iterate the proxy target");
});

test("带真实内部 slot 但非 8-bit 的 Uint16Array 伪装也拒绝", () => {
  const raw = new Uint16Array([0x4142, 0x4344]);
  Object.setPrototypeOf(raw, Buffer.prototype);

  assert.equal(Buffer.isBuffer(raw), true);
  assert.equal(ArrayBuffer.isView(raw), true);
  assertFixedReject(raw);
});

test("真实 Buffer 仍准入并复制：own accessor/iterator 0 次，caller/返回副本互不别名", async () => {
  const source = Buffer.from(NORMAL_RAW, "utf8");
  let hookCalls = 0;
  for (const key of ["valueOf", "toString", "length", "constructor", "buffer", "byteOffset", "byteLength"]) {
    Object.defineProperty(source, key, {
      configurable: true,
      get() {
        hookCalls += 1;
        throw new Error("caller getter must not run");
      },
    });
  }
  Object.defineProperty(source, Symbol.iterator, {
    value: function* () {
      hookCalls += 1;
      yield* Buffer.from(NORMAL_RAW, "utf8");
    },
  });

  const executor = createFakeExecutor({ raw: source });
  assert.equal(hookCalls, 0, "admission/copy must not read caller accessors or iterator");

  source[0] = 0x41;
  const result = await runFull(executor);
  assert.equal(result.code, HARNESS_CODES.OK, result.detail ?? "unexpected failure");

  const first = await rawFromExecute(executor);
  assert.equal(first.toString("utf8"), NORMAL_RAW, "caller mutation must not change captured raw");

  first.fill(0x42);
  const second = await rawFromExecute(executor);
  assert.equal(second.toString("utf8"), NORMAL_RAW, "returned raw must not alias the captured copy");
  assert.notStrictEqual(first, second, "each execute must return its own Buffer object");
  assert.equal(Object.isFrozen(source), false, "caller Buffer must keep caller ownership");
});

test("Buffer 子类仍按真实 slot 复制，不执行 own iterator/coercion", async () => {
  class DerivedBuffer extends Buffer {}
  const source = DerivedBuffer.from(NORMAL_RAW, "utf8");
  let iteratorCalls = 0;
  Object.defineProperty(source, Symbol.iterator, {
    value: function* () {
      iteratorCalls += 1;
      yield* Buffer.from(NORMAL_RAW, "utf8");
    },
  });

  const executor = createFakeExecutor({ raw: source });
  assert.equal(iteratorCalls, 0);
  source[0] = 0x41;
  const raw = await rawFromExecute(executor);
  assert.equal(raw.toString("utf8"), NORMAL_RAW);
  assert.equal(Buffer.isBuffer(raw), true);
});

test("string 与缺省 raw 仍支持并走完整入口", async () => {
  const fromString = createFakeExecutor({ raw: NORMAL_RAW });
  const stringResult = await runFull(fromString);
  assert.equal(stringResult.code, HARNESS_CODES.OK, stringResult.detail ?? "unexpected failure");
  assert.equal((await rawFromExecute(fromString)).toString("utf8"), NORMAL_RAW);

  const fromDefault = createFakeExecutor({});
  const defaultResult = await runFull(fromDefault);
  assert.equal(defaultResult.code, HARNESS_CODES.OK, defaultResult.detail ?? "unexpected failure");
  assert.equal((await rawFromExecute(fromDefault)).toString("utf8"), '{"bpm":120}');
});

test("非 Buffer 类型仍固定拒绝：number/null/array/object/String 对象/symbol/Uint8Array/DataView", () => {
  let coercionCalls = 0;
  let iteratorCalls = 0;
  const evil = {
    valueOf() {
      coercionCalls += 1;
      return NORMAL_RAW;
    },
    toString() {
      coercionCalls += 1;
      return NORMAL_RAW;
    },
    [Symbol.iterator]: function* () {
      iteratorCalls += 1;
      yield* Buffer.from(NORMAL_RAW, "utf8");
    },
  };
  const values = [
    42,
    null,
    [],
    {},
    evil,
    new String(NORMAL_RAW),
    Symbol("raw"),
    new Uint8Array([1, 2, 3]),
    new DataView(new ArrayBuffer(3)),
  ];
  for (const raw of values) {
    assertFixedReject(raw);
  }
  assert.equal(coercionCalls, 0, "invalid raw must not run caller coercion hooks");
  assert.equal(iteratorCalls, 0, "invalid raw must not run caller iterator");
});
