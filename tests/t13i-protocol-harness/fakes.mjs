/**
 * T13I-PROTOCOL-HARNESS-20261024：注入边界上的假 executor / probe / lease。
 *
 * 假对象只做三件事：记录调用、返回确定性合成结果、模拟失败/挂起/清理失败。
 * 它不 spawn、不读写真实素材、不访问网络、不安装/解包/运行引擎、不连服务器。
 * 品牌符号由本模块私有持有；harness 只接受本模块构造的对象，避免把真实
 * AudioEngine/AudioExecutor 误当注入 fake 使用。
 */
import { harnessError, HARNESS_CODES } from "./contracts.mjs";

const FAKE_BRAND = Symbol("t13i.protocolHarness.fakeAdapter");

function brand(kind, object) {
  Object.defineProperty(object, FAKE_BRAND, {
    value: kind,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return object;
}

export function isFakeAdapter(value, kind) {
  return value !== null && typeof value === "object" && value[FAKE_BRAND] === kind;
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

/** 假 lease：可返回任意 descriptor，记录 acquire/release，永不执行 install。 */
export function createFakeLease(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, "fake_lease_options");
  }
  if (!options.descriptor || typeof options.descriptor !== "object") {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, "fake_lease_descriptor");
  }
  const descriptor = copyDescriptor(options.descriptor);
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
        if (options.releaseFailure === true) {
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
  return brand("lease", lease);
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
 */
export function createFakeExecutor(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, "fake_executor_options");
  }
  const post = initialPost();
  const state = {
    executeCalls: 0,
    disposeCalls: 0,
    lastSnapshot: null,
    lastDescriptor: null,
    lastOptions: null,
    pendingAbort: null,
    aborted: false,
  };
  const rawValue = options.raw === undefined ? '{"bpm":120}' : options.raw;

  const finishSuccess = (raw) => {
    post.exit = { confirmed: true, code: 0, signal: null };
    post.job = { state: "cleaned", dirRemoved: true, ownerRemoved: true };
    post.processGroup = {
      own: true,
      groupGone: options.successGroupGone !== false,
      unknownDescendants: options.successGroupGone === false ? "not_scanned" : "declared_none",
    };
    post.stdio = {
      closed: true,
      stdoutBytes: raw.length,
      stderrBytes: Number.isSafeInteger(options.stderrBytes) ? options.stderrBytes : 0,
    };
  };
  const finishFailure = (code) => {
    post.exit = { confirmed: true, code: 1, signal: null };
    post.job = { state: "cleaned", dirRemoved: true, ownerRemoved: true };
    post.processGroup = { own: true, groupGone: true, unknownDescendants: "declared_none" };
    post.stdio = {
      closed: true,
      stdoutBytes: 0,
      stderrBytes: Number.isSafeInteger(options.stderrBytes) ? options.stderrBytes : 0,
    };
    post.disposeErrorCode = code;
  };

  const executor = {
    get calls() {
      return Object.freeze({ execute: state.executeCalls, dispose: state.disposeCalls });
    },
    async execute(snapshot, descriptor, callOptions = {}) {
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

      if (options.hang === true) {
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

      if (options.throwCode !== undefined) {
        finishFailure(options.throwCode);
        const error = harnessError(options.throwCode, "injected_executor_failure");
        // 故意携带 raw stderr/原文，验证 harness 不把它透传出去。
        error.stderr = "SECRET_RAW_STDERR_SHOULD_NOT_LEAVE_ADAPTER";
        error.rawMessage = "SECRET_RAW_MESSAGE_SHOULD_NOT_LEAVE_ADAPTER";
        throw error;
      }

      const raw = Buffer.isBuffer(rawValue) ? Buffer.from(rawValue) : Buffer.from(String(rawValue), "utf8");
      finishSuccess(raw);
      return raw;
    },
    async dispose() {
      if (post.dispose.called && post.dispose.pending === false) return;
      state.disposeCalls += 1;
      post.dispose.calls = state.disposeCalls;
      if (state.pendingAbort) state.pendingAbort();
      if (options.cleanupFailure === true) {
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
      if (options.hang === true) {
        // 合成挂起进程被 dispose 终止；仍不宣称观测到真实进程组。
        post.exit = { confirmed: false, code: null, signal: "SIGKILL" };
        post.job = { state: "cleaned", dirRemoved: true, ownerRemoved: true };
        post.processGroup = { own: true, groupGone: false, unknownDescendants: "not_scanned" };
        post.stdio = { closed: true, stdoutBytes: 0, stderrBytes: 0 };
      }
    },
    postcondition() {
      return clonePost(post);
    },
  };
  return brand("executor", executor);
}

/** 假 probe：返回确定性合成 probe 元数据，或固定码失败。 */
export function createFakeProbe(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw harnessError(HARNESS_CODES.INVALID_REQUEST, "fake_probe_options");
  }
  const state = { calls: 0, lastSnapshot: null };
  const result = Object.freeze({
    durationSec: 2,
    channels: 2,
    sampleRate: 44_100,
    totalSamples: 88_200,
    format: "wav",
    ...(options.result && typeof options.result === "object" ? options.result : {}),
  });
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
      if (options.failCode !== undefined) throw harnessError(options.failCode, "injected_probe_failure");
      return result;
    },
    postcondition() {
      return Object.freeze({
        calls: state.calls,
        lastSnapshot: state.lastSnapshot ? Object.freeze({ ...state.lastSnapshot }) : null,
      });
    },
  };
  return brand("probe", probe);
}

/**
 * 拒绝路径专用毒对象：不是 fake 品牌，任何方法调用都会计数并抛错。
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
