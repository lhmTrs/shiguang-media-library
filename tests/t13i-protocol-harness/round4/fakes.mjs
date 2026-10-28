/**
 * T13I-PROTOCOL-HARNESS-20261024 round4：注入边界上的假 executor / probe / lease。
 *
 * round3 已修 retained-options P2：构造时按 own data descriptor 校验并把允许的选项
 * 复制到私有配置，闭包不再读取调用方可变 options。round4 只修独立审查 round3 的
 * 唯一剩余窄 P2：`Buffer.from(buffer)` 在 Node22 会调用普通 Buffer 额外的 own
 * `valueOf`，把调用方回调带进 raw 捕获边界。
 *
 * round4 的 raw 复制只做一次 typed-array 内部 slot 复制，不经过 Buffer.from(buffer)
 * 的普通对象/coercion 路径，也不读取实例上的 length/constructor/valueOf/toString
 * 等属性；之后调用方 mutation 不影响 fake 行为。其它构造字段、postconditionOverride
 * 惰性例外与产品源码均未改。
 *
 * 仍只是**同进程受控对象防误用**，不是对任意恶意 JS/Proxy 的沙箱；不声称
 * 可阻止刻意通过反射陷阱伪造同一进程内的任意行为。
 *
 * 假对象只做三件事：记录调用、返回确定性合成结果、模拟失败/挂起/清理失败。
 * 它不 spawn、不读写真实素材、不访问网络、不安装/解包/运行引擎、不连服务器。
 */
import { harnessError, HARNESS_CODES } from "./contracts.mjs";

const FAKE_KIND = new WeakMap();
const DEFAULT_RAW = '{"bpm":120}';
const LEASE_DESCRIPTOR_FIELDS = Object.freeze([
  "version",
  "binarySha256",
  "binarySize",
  "generation",
  "binaryPath",
  "platform",
  "arch",
]);
const PROBE_RESULT_DEFAULTS = Object.freeze({
  durationSec: 2,
  channels: 2,
  sampleRate: 44_100,
  totalSamples: 88_200,
  format: "wav",
});

function registerFake(kind, object) {
  FAKE_KIND.set(object, kind);
  return Object.freeze(object);
}

export function isFakeAdapter(value, kind) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return FAKE_KIND.get(value) === kind;
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function requirePlainRecord(value, label) {
  if (!isPlainObject(value)) throw harnessError(HARNESS_CODES.INVALID_REQUEST, `${label}_shape`);
  return value;
}

/**
 * 只读 own data descriptor；缺失返回 present=false，访问器/反射异常固定拒绝。
 * 拒绝 detail 只含固定 label/key，不回显调用方文案，也不执行 getter。
 */
function readOwnField(record, key, label) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, key);
  } catch {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, `${label}_reflection`);
  }
  if (!descriptor) return { present: false, value: undefined };
  if (!("value" in descriptor)) {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, `${label}_accessor_${key}`);
  }
  return { present: true, value: descriptor.value };
}

function readConstructorOptions(options, label) {
  requirePlainRecord(options, `${label}_options`);
  return (key) => readOwnField(options, key, label);
}

/** 逐字段复制 descriptor，保留缺失字段为 undefined（与旧 copyDescriptor 一致）。 */
function captureDescriptor(raw) {
  const record = requirePlainRecord(raw, "fake_lease_descriptor");
  const out = Object.create(null);
  for (const key of LEASE_DESCRIPTOR_FIELDS) {
    out[key] = readOwnField(record, key, "fake_lease_descriptor").value;
  }
  return Object.freeze(out);
}

function copyDescriptor(descriptor) {
  return Object.freeze({
    version: descriptor.version,
    binarySha256: descriptor.binarySha256,
    binarySize: descriptor.binarySize,
    generation: descriptor.generation,
    binaryPath: descriptor.binaryPath,
    platform: descriptor.platform,
    arch: descriptor.arch,
  });
}

/**
 * 复制 Buffer 字节，不走 `Buffer.from(buffer)` 的普通对象/coercion 路径。
 *
 * Node22 的 `Buffer.from(buffer)` 仍会读取 Buffer 实例上的 own `valueOf`
 * （审查反例即普通 Buffer 加 own valueOf，完整入口调用 1 次）。这里先用显式
 * `new Uint8Array(value)` 按 typed-array 内部 slot 复制字节，不读取实例上的
 * `length` / `constructor` / `valueOf` / `toString` / `buffer` / `byteOffset` 等
 * 属性；再用这份独立 ArrayBuffer 构造 Buffer，不保留调用方 buffer 引用。
 * Proxy、detached buffer 等无法按 typed-array 读取的输入固定拒绝，不执行回调。
 */
function copyBufferBytes(value) {
  try {
    const copy = new Uint8Array(value);
    return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
  } catch {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, "fake_executor_raw_type");
  }
}

/** raw 只在构造时接受 string / Buffer；绝不调用 String()/toString()/valueOf()。 */
function captureRaw(value) {
  if (value === undefined) return Buffer.from(DEFAULT_RAW, "utf8");
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (Buffer.isBuffer(value)) return copyBufferBytes(value);
  throw harnessError(HARNESS_CODES.INVALID_REQUEST, "fake_executor_raw_type");
}

function captureSuccessExit(value) {
  if (value === undefined) return null;
  const record = requirePlainRecord(value, "fake_executor_success_exit");
  const confirmed = readOwnField(record, "confirmed", "fake_executor_success_exit").value === true;
  const code = readOwnField(record, "code", "fake_executor_success_exit").value;
  const signal = readOwnField(record, "signal", "fake_executor_success_exit");
  return Object.freeze({
    confirmed,
    code: typeof code === "number" ? code : null,
    signalPresent: signal.present,
    signal: signal.value,
  });
}

function captureSuccessStdio(value) {
  if (value === undefined) return null;
  const record = requirePlainRecord(value, "fake_executor_success_stdio");
  const closed = readOwnField(record, "closed", "fake_executor_success_stdio").value;
  const stdout = readOwnField(record, "stdoutBytes", "fake_executor_success_stdio");
  const stderr = readOwnField(record, "stderrBytes", "fake_executor_success_stdio");
  return Object.freeze({
    closed: closed === undefined ? true : closed === true,
    stdoutPresent: stdout.present,
    stdoutBytes: stdout.value,
    stderrPresent: stderr.present,
    stderrBytes: stderr.value,
  });
}

/** 只复制 harness 实际消费的 probe 字段；额外字段丢弃，调用方后续 mutation 无效。 */
function captureProbeResult(value) {
  if (value === undefined) return PROBE_RESULT_DEFAULTS;
  const record = requirePlainRecord(value, "fake_probe_result");
  const out = { ...PROBE_RESULT_DEFAULTS };
  for (const key of Object.keys(PROBE_RESULT_DEFAULTS)) {
    const field = readOwnField(record, key, "fake_probe_result");
    if (field.present) out[key] = field.value;
  }
  return Object.freeze(out);
}

/** 假 lease：可返回任意 descriptor，记录 acquire/release，永不执行 install。 */
export function createFakeLease(options = {}) {
  const read = readConstructorOptions(options, "fake_lease");
  const descriptorField = read("descriptor");
  if (!descriptorField.present) throw harnessError(HARNESS_CODES.INVALID_REQUEST, "fake_lease_descriptor");
  const descriptor = captureDescriptor(descriptorField.value);
  const releaseFailure = read("releaseFailure").value === true;
  const state = {
    acquireCalls: 0,
    releaseCalls: 0,
    installCalls: 0,
    active: false,
    lastDeadlineAtMs: null,
  };
  const lease = {
    get calls() {
      return Object.freeze({
        acquire: state.acquireCalls,
        release: state.releaseCalls,
        install: state.installCalls,
      });
    },
    async withRunLease(callback, callOptions = {}) {
      if (typeof callback !== "function") throw harnessError(HARNESS_CODES.INVALID_REQUEST, "lease_callback");
      state.acquireCalls += 1;
      state.active = true;
      state.lastDeadlineAtMs = Number.isFinite(callOptions.deadlineAtMs) ? callOptions.deadlineAtMs : null;
      try {
        return await callback(copyDescriptor(descriptor), callOptions.signal);
      } finally {
        state.active = false;
        state.releaseCalls += 1;
        if (releaseFailure) {
          throw harnessError(HARNESS_CODES.LEASE_RELEASE_FAILED, "injected_release_failure");
        }
      }
    },
    async install() {
      state.installCalls += 1;
      throw harnessError(HARNESS_CODES.INSTALL_NOT_AUTHORIZED, "fake_install_must_not_run");
    },
    postcondition() {
      return Object.freeze({
        active: state.active,
        acquireCalls: state.acquireCalls,
        releaseCalls: state.releaseCalls,
        installCalls: state.installCalls,
        lastDeadlineAtMs: state.lastDeadlineAtMs,
      });
    },
  };
  return registerFake("lease", lease);
}

function initialPost() {
  return {
    exit: { confirmed: false, code: null, signal: null },
    job: { state: "not_started", dirRemoved: false, ownerRemoved: false },
    processGroup: { own: false, groupGone: false, unknownDescendants: "not_scanned" },
    stdio: { closed: false, stdoutBytes: 0, stderrBytes: 0 },
    dispose: { called: false, calls: 0, pending: false },
  };
}

function clonePost(post) {
  return Object.freeze({
    exit: Object.freeze({ ...post.exit }),
    job: Object.freeze({ ...post.job }),
    processGroup: Object.freeze({ ...post.processGroup }),
    stdio: Object.freeze({ ...post.stdio }),
    dispose: Object.freeze({ ...post.dispose }),
  });
}

/**
 * 假 executor：可正常返回 raw、固定码失败、挂起、清理失败。
 * postcondition 是“注入 adapter 自报”，不是真实 OS 观测；报告必须如此标注。
 *
 * 允许的构造选项在 createFakeExecutor 返回前被复制进私有 config；之后调用方
 * 对原 options / descriptor / successExit / successStdio 的任何 mutation 或访问器
 * 都不影响行为。postconditionOverride 只作为惰性数据记录保留引用，不读字段。
 */
export function createFakeExecutor(options = {}) {
  const read = readConstructorOptions(options, "fake_executor");
  const rawBytes = captureRaw(read("raw").value);
  const successExit = captureSuccessExit(read("successExit").value);
  const successStdio = captureSuccessStdio(read("successStdio").value);
  const overrideField = read("postconditionOverride");
  const postconditionOverride =
    overrideField.present && overrideField.value !== null && typeof overrideField.value === "object"
      ? overrideField.value
      : null;
  const config = Object.freeze({
    rawBytes,
    successExit,
    successStdio,
    omitSuccessStdoutBytes: read("omitSuccessStdoutBytes").value === true,
    omitSuccessStderrBytes: read("omitSuccessStderrBytes").value === true,
    successGroupGone: read("successGroupGone").value !== false,
    stderrBytes: Number.isSafeInteger(read("stderrBytes").value) ? read("stderrBytes").value : 0,
    hang: read("hang").value === true,
    throwCode: read("throwCode").value,
    cleanupFailure: read("cleanupFailure").value === true,
    postconditionOverride,
    methodAccessor: read("methodAccessor").value === "execute",
  });

  const post = initialPost();
  const state = {
    executeCalls: 0,
    disposeCalls: 0,
    accessorReads: 0,
    lastSnapshot: null,
    lastDescriptor: null,
    lastOptions: null,
    pendingAbort: null,
    aborted: false,
  };

  const finishSuccess = () => {
    const rawLength = config.rawBytes.length;
    post.exit = { confirmed: true, code: 0, signal: null };
    post.job = { state: "cleaned", dirRemoved: true, ownerRemoved: true };
    post.processGroup = {
      own: true,
      groupGone: config.successGroupGone,
      unknownDescendants: config.successGroupGone ? "declared_none" : "not_scanned",
    };
    post.stdio = {
      closed: true,
      stdoutBytes: rawLength,
      stderrBytes: config.stderrBytes,
    };
    if (config.successExit) {
      post.exit = {
        confirmed: config.successExit.confirmed,
        code: config.successExit.code,
        signal: config.successExit.signalPresent ? config.successExit.signal : null,
      };
    }
    if (config.successStdio) {
      post.stdio = {
        closed: config.successStdio.closed,
        stdoutBytes: config.successStdio.stdoutPresent ? config.successStdio.stdoutBytes : rawLength,
        stderrBytes: config.successStdio.stderrPresent ? config.successStdio.stderrBytes : 0,
      };
    }
    if (config.omitSuccessStdoutBytes) delete post.stdio.stdoutBytes;
    if (config.omitSuccessStderrBytes) delete post.stdio.stderrBytes;
  };
  const finishFailure = (code) => {
    post.exit = { confirmed: true, code: 1, signal: null };
    post.job = { state: "cleaned", dirRemoved: true, ownerRemoved: true };
    post.processGroup = { own: true, groupGone: true, unknownDescendants: "declared_none" };
    post.stdio = {
      closed: true,
      stdoutBytes: 0,
      stderrBytes: config.stderrBytes,
    };
    post.disposeErrorCode = code;
  };

  const executeImpl = async (snapshot, descriptor, callOptions = {}) => {
    state.executeCalls += 1;
    state.lastSnapshot = {
      filePath: typeof snapshot?.filePath === "string" ? snapshot.filePath : null,
      bytes: Number.isSafeInteger(snapshot?.bytes) ? snapshot.bytes : null,
      sha256: typeof snapshot?.sha256 === "string" ? snapshot.sha256 : null,
    };
    state.lastDescriptor = descriptor && typeof descriptor === "object" ? Object.freeze({ ...descriptor }) : null;
    state.lastOptions = Object.freeze({
      deadlineAtMs: Number.isFinite(callOptions.deadlineAtMs) ? callOptions.deadlineAtMs : null,
      hasSignal: Boolean(callOptions.signal && typeof callOptions.signal.addEventListener === "function"),
    });

    if (config.hang) {
      post.job = { state: "running", dirRemoved: false, ownerRemoved: false };
      post.processGroup = { own: true, groupGone: false, unknownDescendants: "not_scanned" };
      post.stdio = { closed: false, stdoutBytes: 0, stderrBytes: 0 };
      return await new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => finish(harnessError(HARNESS_CODES.CANCELLED, "injected_abort"));
        const cleanup = () => {
          callOptions.signal?.removeEventListener?.("abort", onAbort);
          state.pendingAbort = null;
        };
        const finish = (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          state.aborted = true;
          reject(error);
        };
        state.pendingAbort = () => finish(harnessError(HARNESS_CODES.TIMEOUT, "injected_dispose_after_timeout"));
        callOptions.signal?.addEventListener?.("abort", onAbort, { once: true });
        // 不主动 resolve：只有 abort/dispose 才能让本假进程“结束”。
        void resolve;
      });
    }

    if (config.throwCode !== undefined) {
      finishFailure(config.throwCode);
      const error = harnessError(config.throwCode, "injected_executor_failure");
      // 故意携带 raw stderr/原文，验证 harness 不把它透传出去。
      error.stderr = "SECRET_RAW_STDERR_SHOULD_NOT_LEAVE_ADAPTER";
      error.rawMessage = "SECRET_RAW_MESSAGE_SHOULD_NOT_LEAVE_ADAPTER";
      throw error;
    }

    const raw = Buffer.from(config.rawBytes);
    finishSuccess();
    return raw;
  };

  const executor = {
    get calls() {
      return Object.freeze({
        execute: state.executeCalls,
        dispose: state.disposeCalls,
        accessorExecute: state.accessorReads,
      });
    },
    execute: executeImpl,
    async dispose() {
      if (post.dispose.called && post.dispose.pending === false) return;
      state.disposeCalls += 1;
      post.dispose.calls = state.disposeCalls;
      if (state.pendingAbort) state.pendingAbort();
      if (config.cleanupFailure) {
        post.dispose.called = true;
        post.dispose.pending = true;
        post.exit = { confirmed: false, code: null, signal: null };
        post.job = { state: "cleanup_unknown", dirRemoved: true, ownerRemoved: true };
        post.processGroup = { own: true, groupGone: false, unknownDescendants: "not_scanned" };
        post.stdio = { closed: true, stdoutBytes: 0, stderrBytes: 0 };
        throw harnessError(HARNESS_CODES.CLEANUP_FAILED, "injected_cleanup_failure");
      }
      post.dispose.called = true;
      post.dispose.pending = false;
      if (state.executeCalls === 0) {
        // 身份/参数在 execute 前被拒绝：没有创建 job，也没有进程组。
        post.exit = { confirmed: false, code: null, signal: null };
        post.job = { state: "not_started", dirRemoved: true, ownerRemoved: true };
        post.processGroup = { own: false, groupGone: false, unknownDescendants: "not_scanned" };
        post.stdio = { closed: true, stdoutBytes: 0, stderrBytes: 0 };
      }
      if (config.hang) {
        // 合成挂起进程被 dispose 终止；仍不宣称观测到真实进程组。
        post.exit = { confirmed: false, code: null, signal: "SIGKILL" };
        post.job = { state: "cleaned", dirRemoved: true, ownerRemoved: true };
        post.processGroup = { own: true, groupGone: false, unknownDescendants: "not_scanned" };
        post.stdio = { closed: true, stdoutBytes: 0, stderrBytes: 0 };
      }
    },
    postcondition() {
      if (config.postconditionOverride !== null) {
        // 惰性记录：不读字段、不复制、不执行 getter；由 harness 的 own data 读取拒绝坏形状。
        return config.postconditionOverride;
      }
      return clonePost(post);
    },
  };

  if (config.methodAccessor) {
    Object.defineProperty(executor, "execute", {
      enumerable: true,
      configurable: false,
      get() {
        state.accessorReads += 1;
        return executeImpl;
      },
    });
  }
  return registerFake("executor", executor);
}

/** 假 probe：返回确定性合成 probe 元数据，或固定码失败。 */
export function createFakeProbe(options = {}) {
  const read = readConstructorOptions(options, "fake_probe");
  const failCode = read("failCode").value;
  const result = captureProbeResult(read("result").value);
  const state = { calls: 0, lastSnapshot: null };
  const probe = {
    get calls() {
      return state.calls;
    },
    async probe(snapshot, _callOptions = {}) {
      state.calls += 1;
      state.lastSnapshot = {
        filePath: typeof snapshot?.filePath === "string" ? snapshot.filePath : null,
        bytes: Number.isSafeInteger(snapshot?.bytes) ? snapshot.bytes : null,
        sha256: typeof snapshot?.sha256 === "string" ? snapshot.sha256 : null,
      };
      if (failCode !== undefined) throw harnessError(failCode, "injected_probe_failure");
      return result;
    },
    postcondition() {
      return Object.freeze({
        calls: state.calls,
        lastSnapshot: state.lastSnapshot ? Object.freeze({ ...state.lastSnapshot }) : null,
      });
    },
  };
  return registerFake("probe", probe);
}

/**
 * 拒绝路径专用毒对象：不是 fake membership，任何方法调用都会计数并抛错。
 * 用于证明 gate 在 adapter 方法/文件系统副作用之前就拒绝。
 */
export function createPoisonAdapters() {
  const calls = { lease: 0, install: 0, execute: 0, dispose: 0, probe: 0 };
  const poison = (fn) =>
    function poisoned() {
      fn();
      throw new Error("POISON_ADAPTER_MUST_NOT_BE_CALLED");
    };
  const lease = {
    withRunLease: poison(() => {
      calls.lease += 1;
    }),
    install: poison(() => {
      calls.install += 1;
    }),
    postcondition: poison(() => {
      calls.lease += 1;
    }),
  };
  const executor = {
    execute: poison(() => {
      calls.execute += 1;
    }),
    dispose: poison(() => {
      calls.dispose += 1;
    }),
    postcondition: poison(() => {
      calls.execute += 1;
    }),
  };
  const probe = {
    probe: poison(() => {
      calls.probe += 1;
    }),
    postcondition: poison(() => {
      calls.probe += 1;
    }),
  };
  return Object.freeze({
    adapters: Object.freeze({ lease, executor, probe }),
    calls,
  });
}
