/**
 * T13I-PROTOCOL-HARNESS-20261024 round4：raw Buffer 复制边界的定向自测。
 *
 * 只跑合成 fake adapter + 临时目录；不启动引擎/真实 clang/ffprobe，不读真实素材，
 * 不联网，不安装/解包/下载，不改产品模块。
 *
 * round4 只针对独立审查 round3 的唯一剩余窄 P2：`Buffer.from(buffer)` 会调用普通
 * Buffer 额外的 own `valueOf`。这里验证完整入口 copy 不执行调用方 coercion/getter、
 * 普通 Buffer 副本与调用方后续 mutation 隔离、原 raw 类型拒绝不回归；不重跑
 * round2/round3 的 32 项或 canonical 套件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { HARNESS_CODES } from "./contracts.mjs";
import { runProtocolHarness } from "./harness.mjs";
import { createCase, makeDescriptor, NORMAL_RAW } from "./scenarios.mjs";
import { createFakeExecutor } from "./fakes.mjs";

const SNAPSHOT = Object.freeze({
  filePath: "/tmp/t13i-synthetic-raw-boundary.wav",
  bytes: 1,
  sha256: "0".repeat(64),
});

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

test("原审查反例：普通 Buffer 加 own valueOf，完整入口 coercionCalls=0 且 normal OK", async () => {
  const source = Buffer.from(NORMAL_RAW, "utf8");
  let coercionCalls = 0;
  Object.defineProperty(source, "valueOf", {
    value() {
      coercionCalls += 1;
      return source;
    },
  });

  const executor = createFakeExecutor({ raw: source });
  const result = await runFull(executor);

  assert.equal(coercionCalls, 0, "accepted Buffer raw copy must not invoke caller coercion");
  assert.equal(result.code, HARNESS_CODES.OK, result.detail ?? "unexpected failure");
  assert.equal(result.postconditions.stdio.stdoutBytes, Buffer.byteLength(NORMAL_RAW));
});

test("普通 Buffer 独立副本：构造后 caller mutation 不影响输出，输出也不反向别名 caller", async () => {
  const source = Buffer.from(NORMAL_RAW, "utf8");
  const executor = createFakeExecutor({ raw: source });

  source.fill(0x41);
  assert.equal(Object.isFrozen(source), false, "caller Buffer must keep caller ownership");
  const result = await runFull(executor);
  assert.equal(result.code, HARNESS_CODES.OK, result.detail ?? "unexpected failure");

  const first = await rawFromExecute(executor);
  assert.equal(first.toString("utf8"), NORMAL_RAW, "caller mutation must not change captured raw");

  first.fill(0x42);
  const second = await rawFromExecute(executor);
  assert.equal(second.toString("utf8"), NORMAL_RAW, "returned raw must not alias the captured copy");
  assert.notStrictEqual(first, second, "each execute must return its own Buffer object");
});

test("raw 复制不读取实例上的 coercion/结构 getter", async () => {
  const source = Buffer.from(NORMAL_RAW, "utf8");
  let getterCalls = 0;
  const accessor = (key) => ({
    configurable: true,
    get() {
      getterCalls += 1;
      if (key === "constructor") return Buffer;
      if (key === "valueOf") return source;
      if (key === "toString") return () => NORMAL_RAW;
      return Buffer.byteLength(NORMAL_RAW);
    },
  });
  for (const key of ["valueOf", "toString", "constructor", "length", "byteLength", "byteOffset", "buffer"]) {
    Object.defineProperty(source, key, accessor(key));
  }

  const executor = createFakeExecutor({ raw: source });
  const raw = await rawFromExecute(executor);
  assert.equal(getterCalls, 0, "raw copy must not read caller accessors");
  assert.equal(raw.toString("utf8"), NORMAL_RAW);
});

test("Buffer 子类 / extended Buffer 也按字节复制，不执行 own coercion", async () => {
  class DerivedBuffer extends Buffer {}
  const source = DerivedBuffer.from(NORMAL_RAW, "utf8");
  let coercionCalls = 0;
  Object.defineProperty(source, "valueOf", {
    value() {
      coercionCalls += 1;
      return source;
    },
  });

  const executor = createFakeExecutor({ raw: source });
  source.fill(0x43);
  const raw = await rawFromExecute(executor);

  assert.equal(coercionCalls, 0);
  assert.equal(raw.toString("utf8"), NORMAL_RAW);
  assert.equal(Buffer.isBuffer(raw), true);
});

test("非法 raw 类型仍固定拒绝且不执行 coercion", () => {
  let coercionCalls = 0;
  const evil = {
    valueOf() {
      coercionCalls += 1;
      return NORMAL_RAW;
    },
    toString() {
      coercionCalls += 1;
      return NORMAL_RAW;
    },
  };
  const values = [42, null, [], {}, evil, new String(NORMAL_RAW), Symbol("raw")];
  for (const raw of values) {
    assert.throws(
      () => createFakeExecutor({ raw }),
      (error) => error.code === HARNESS_CODES.INVALID_REQUEST && error.detail === "fake_executor_raw_type",
    );
  }
  assert.equal(coercionCalls, 0, "invalid raw must not run caller coercion hooks");
});

test("string raw 仍支持并走完整入口", async () => {
  const executor = createFakeExecutor({ raw: NORMAL_RAW });
  const result = await runFull(executor);
  assert.equal(result.code, HARNESS_CODES.OK, result.detail ?? "unexpected failure");
  const raw = await rawFromExecute(executor);
  assert.equal(raw.toString("utf8"), NORMAL_RAW);
});
