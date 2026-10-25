/**
 * T-LOCAL-014A：隔离的云端音频接收核心（未接入 HTTP / Library / 前端）。
 *
 * 职责边界：
 *   - 只接受已授权的 200 全量音频流；`openStream(audioId, signal)` 由内部注入，
 *     本文件不实现真实网络、不读证书/令牌，也不接受 URL、文件名或临时文件名。
 *   - 校验响应状态/长度/MIME/编码，边读边写临时文件并计算 SHA-256；
 *     完成后返回"已校验私有产物"，不是已安装的素材库资源。
 *   - 每 1 次接收在开始前、收到响应、复制过程中、成功提交前复核账户/设备/配置代际，
 *     代际变化立即中止且不会用旧身份返回成功。
 *   - 临时文件只落在构造时指定的 0700 私有目录，随机名 + O_EXCL|O_NOFOLLOW + 0600；
 *     失败/取消立即删除；删除失败则记故障并保留归属，拒绝继续接收。
 *   - 不含导入期单例、全局状态、HTTP 路由，不写正式素材目录，不读原始素材。
 *
 * 公开接口：
 *   new CloudAudioReceiver({ workDir, openStream, resolveContext,
 *                            maxActiveTransfers?, idleTimeoutMs?, absoluteTimeoutMs? })
 *     workDir           绝对、已存在、非符号链接、权限恰为 0700 的专用临时目录。
 *     openStream        async (audioId, AbortSignal) => { status, headers, body }
 *                       headers 为普通对象（HTTP 头名字符串）；body 为 Node Readable。
 *                       audioId 是已校验的小写 UUID；不会传 URL/头/路径/凭据。
 *     resolveContext    () => string|number|bigint|boolean，同步返回账户/设备/配置代际。
 *     onProgress        async (receivedBytes, audioId) => void，可选；只用于本地展示，异常被忽略。
 *   receiver.receive({ audioId, bytes, sha256, mimeType }, { signal? })
 *                       => Promise<Readonly<{ artifactId, audioId, bytes, sha256, mimeType }>>
 *   receiver.consume(artifactId, consumer) => Promise<T|false>  // 受信任内部消费，结束后释放临时租约
 *   receiver.release(artifactId) => Promise<boolean>  // 幂等；删除并释放该产物租约
 *   receiver.dispose()          => Promise<true>      // 中止活动下载并清理全部产物
 *   receiver.stats()            => Readonly<{ active, artifacts, orphans, faulted, disposed }>
 *
 * 错误：统一 CloudAudioReceiverError，只有固定 code 与固定中文文案，不透传注入方异常文本。
 * 清理失败的人工恢复：实例进入故障态并保留内部归属，之后拒绝新接收；不按目录前缀批量清理，
 * 也不自动回收。操作者确认是该实例工作目录内的残留后手工删除，再新建实例；dispose() 可重试。
 */
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { types as utilTypes } from "node:util";

export const MAX_AUDIO_BYTES = 256_000_000;
export const AUDIO_MIME_TYPES = Object.freeze([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/vnd.wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
  "audio/x-flac",
  "audio/ogg",
  "audio/aiff",
  "audio/x-aiff",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
]);

const DEFAULT_MAX_ACTIVE = 2;
const MAX_ACTIVE_LIMIT = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_CONTEXT_LENGTH = 256;
const MIME_SET = new Set(AUDIO_MIME_TYPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTENT_LENGTH_RE = /^(0|[1-9][0-9]{0,8})$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const META_KEYS = new Set(["audioId", "bytes", "sha256", "mimeType"]);
const OPTION_KEYS = new Set(["signal"]);

export const CLOUD_AUDIO_RECEIVER_MESSAGES = Object.freeze({
  INVALID_REQUEST: "音频接收参数不合法",
  INVALID_METADATA: "音频元数据不合法",
  UNSUPPORTED_MIME: "不支持的音频类型",
  BUSY: "同时进行的下载任务过多",
  ABORTED: "下载已取消",
  IDLE_TIMEOUT: "下载空闲超时",
  ABSOLUTE_TIMEOUT: "下载总时长超时",
  CONTEXT_CHANGED: "云端账户或设备状态已变化",
  CONTEXT_UNAVAILABLE: "无法确认云端账户或设备状态",
  TRANSPORT_FAILED: "音频下载连接失败",
  RESPONSE_INVALID: "音频响应头不合法",
  STATUS_REJECTED: "音频下载返回异常状态",
  REDIRECT_REJECTED: "音频下载不允许重定向",
  PARTIAL_REJECTED: "音频下载不支持分段响应",
  LENGTH_MISMATCH: "音频长度与声明不一致",
  ENCODING_REJECTED: "音频下载不支持压缩编码",
  MIME_MISMATCH: "音频类型与声明不一致",
  DIGEST_MISMATCH: "音频内容校验失败",
  TOO_LARGE: "音频超出大小限制",
  STREAM_FAILED: "音频流中断",
  FILESYSTEM_ERROR: "音频临时文件读写失败",
  RECEIVER_FAULTED: "接收器存在未清理的临时文件",
  ALREADY_DISPOSED: "接收器已关闭",
  CLEANUP_FAILED: "音频临时文件清理失败",
});

export class CloudAudioReceiverError extends Error {
  constructor(code) {
    super(Object.hasOwn(CLOUD_AUDIO_RECEIVER_MESSAGES, code)
      ? CLOUD_AUDIO_RECEIVER_MESSAGES[code]
      : CLOUD_AUDIO_RECEIVER_MESSAGES.TRANSPORT_FAILED);
    this.name = "CloudAudioReceiverError";
    this.code = Object.hasOwn(CLOUD_AUDIO_RECEIVER_MESSAGES, code) ? code : "TRANSPORT_FAILED";
  }
}

const fail = (code) => {
  throw new CloudAudioReceiverError(code);
};

const NOOP = () => {};

/** 只消费原生 Promise 的拒绝，不读取/调用自有 then 或 getter（沿用已验收 T13 模式）。 */
function consumeNativeRejection(value) {
  try {
    Promise.prototype.then.call(value, undefined, NOOP);
  } catch {
    /* 无法挂载时仍固定失败，不扩散异常 */
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * FileHandle 短写循环：每次只接受 1..剩余长度的整数写入量，0/负数/超界立即失败。
 * 导出仅为定向测试注入短写句柄；接收路径内部同样使用它。
 */
export async function writeAllChunk(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const result = await handle.write(chunk, offset, chunk.length - offset);
    const written = result?.bytesWritten;
    if (!Number.isInteger(written) || written <= 0 || written > chunk.length - offset) {
      throw new Error("write did not make progress");
    }
    offset += written;
  }
}

/**
 * 只从普通响应对象的自有数据属性中取真实 Node Readable：
 *   - 不触发访问器（getter 不会被调用），也不沿原型链取 body；
 *   - 不接受鸭子类型对象，拒绝路径上的清理只作用于确实拥有的流，
 *     绝不调用任意对象的 destroy/return。
 * 返回 null 表示没有可安全拥有的响应体；由后续响应校验固定拒绝。
 */
function captureOwnedBody(opened) {
  try {
    if (!isPlainObject(opened)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(opened, "body");
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return null;
    const candidate = descriptor.value;
    return candidate instanceof Readable ? candidate : null;
  } catch {
    return null;
  }
}

function destroyStream(body) {
  let genuine = false;
  try {
    genuine = body instanceof Readable;
  } catch {
    genuine = false;
  }
  if (!genuine) return;
  try {
    Readable.prototype.destroy.call(body);
  } catch {
    /* 清理失败不扩散到调用方 */
  }
}

function validateTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw new CloudAudioReceiverError("INVALID_REQUEST");
  }
  return value;
}

function validateMetadata(metadata) {
  try {
    return validateMetadataInner(metadata);
  } catch (error) {
    if (error instanceof CloudAudioReceiverError) throw error;
    fail("INVALID_METADATA");
  }
}

function validateMetadataInner(metadata) {
  if (!isPlainObject(metadata)) fail("INVALID_METADATA");
  for (const key of Object.keys(metadata)) {
    if (!META_KEYS.has(key)) fail("INVALID_METADATA");
  }
  const { audioId, bytes, sha256, mimeType } = metadata;
  if (typeof audioId !== "string") fail("INVALID_METADATA");
  const normalizedId = audioId.toLowerCase();
  if (!UUID_RE.test(normalizedId)) fail("INVALID_METADATA");
  if (!Number.isInteger(bytes) || bytes < 1 || bytes > MAX_AUDIO_BYTES) fail("INVALID_METADATA");
  if (typeof sha256 !== "string") fail("INVALID_METADATA");
  const normalizedSha = sha256.toLowerCase();
  if (!SHA256_RE.test(normalizedSha)) fail("INVALID_METADATA");
  if (typeof mimeType !== "string") fail("INVALID_METADATA");
  const normalizedMime = mimeType.trim().toLowerCase();
  if (!MIME_RE.test(normalizedMime)) fail("INVALID_METADATA");
  if (!MIME_SET.has(normalizedMime)) fail("UNSUPPORTED_MIME");
  return { audioId: normalizedId, bytes, sha256: normalizedSha, mimeType: normalizedMime };
}

function validateCallerSignal(signal) {
  if (signal === undefined) return null;
  if (signal === null || typeof signal !== "object") fail("INVALID_REQUEST");
  if (typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function") {
    fail("INVALID_REQUEST");
  }
  return signal;
}

function headerMap(headers) {
  if (!isPlainObject(headers)) fail("RESPONSE_INVALID");
  const map = new Map();
  for (const key of Object.keys(headers)) {
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string") {
      fail("RESPONSE_INVALID");
    }
    const name = key.toLowerCase();
    if (map.has(name)) fail("RESPONSE_INVALID");
    map.set(name, descriptor.value);
  }
  return map;
}

function contentTypeOf(raw) {
  const media = raw.split(";")[0].trim().toLowerCase();
  if (!MIME_RE.test(media)) fail("RESPONSE_INVALID");
  return media;
}

export class CloudAudioReceiver {
  #workDir;
  #openStream;
  #resolveContext;
  #maxActive;
  #onProgress;
  #idleTimeoutMs;
  #absoluteTimeoutMs;
  #active = new Set();
  #idleWaiters = [];
  #artifacts = new Map();
  #orphans = new Map();
  #disposed = false;
  #faulted = false;

  constructor(options) {
    if (!isPlainObject(options)) fail("INVALID_REQUEST");
    const {
      workDir,
      openStream,
      resolveContext,
      maxActiveTransfers = DEFAULT_MAX_ACTIVE,
      onProgress = null,
      idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
      absoluteTimeoutMs = DEFAULT_ABSOLUTE_TIMEOUT_MS,
    } = options;
    if (typeof workDir !== "string" || workDir.length === 0 || workDir.includes("\0")
      || !path.isAbsolute(workDir)) {
      fail("INVALID_REQUEST");
    }
    if (typeof openStream !== "function" || typeof resolveContext !== "function") {
      fail("INVALID_REQUEST");
    }
    if (!Number.isInteger(maxActiveTransfers) || maxActiveTransfers < 1
      || maxActiveTransfers > MAX_ACTIVE_LIMIT) {
      fail("INVALID_REQUEST");
    }
    if (onProgress !== null && typeof onProgress !== "function") fail("INVALID_REQUEST");
    this.#workDir = path.resolve(workDir);
    this.#openStream = openStream;
    this.#resolveContext = resolveContext;
    this.#maxActive = maxActiveTransfers;
    this.#onProgress = onProgress;
    this.#idleTimeoutMs = validateTimeout(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    this.#absoluteTimeoutMs = validateTimeout(absoluteTimeoutMs, DEFAULT_ABSOLUTE_TIMEOUT_MS);
    this.#assertWorkDirSync();
  }

  #assertWorkDirSync() {
    let stat;
    let real;
    try {
      stat = fsSync.lstatSync(this.#workDir);
      real = fsSync.realpathSync(this.#workDir);
    } catch {
      fail("INVALID_REQUEST");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_REQUEST");
    if ((stat.mode & 0o777) !== 0o700) fail("INVALID_REQUEST");
    if (real !== this.#workDir) fail("INVALID_REQUEST");
  }

  async #assertWorkDir() {
    let stat;
    let real;
    try {
      stat = await fs.lstat(this.#workDir);
      real = await fs.realpath(this.#workDir);
    } catch {
      fail("FILESYSTEM_ERROR");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink() || real !== this.#workDir
      || (stat.mode & 0o777) !== 0o700) {
      fail("FILESYSTEM_ERROR");
    }
  }

  #readContext() {
    let value;
    try {
      value = this.#resolveContext();
    } catch {
      fail("CONTEXT_UNAVAILABLE");
    }
    if (value === null || value === undefined) fail("CONTEXT_UNAVAILABLE");
    const kind = typeof value;
    if (kind === "object" || kind === "function") {
      let genuine = false;
      try {
        genuine = utilTypes.isPromise(value);
      } catch {
        genuine = false;
      }
      if (genuine) consumeNativeRejection(value);
      fail("CONTEXT_UNAVAILABLE");
    }
    if (kind !== "string" && kind !== "number" && kind !== "bigint" && kind !== "boolean") {
      fail("CONTEXT_UNAVAILABLE");
    }
    if (kind === "number" && !Number.isFinite(value)) fail("CONTEXT_UNAVAILABLE");
    if (kind === "string" && (value.length === 0 || value.length > MAX_CONTEXT_LENGTH)) {
      fail("CONTEXT_UNAVAILABLE");
    }
    return value;
  }

  #assertContext(initial) {
    const current = this.#readContext();
    if (!Object.is(initial, current)) fail("CONTEXT_CHANGED");
  }

  #validateResponse(opened, metadata, body) {
    try {
      return this.#validateResponseInner(opened, metadata, body);
    } catch (error) {
      if (error instanceof CloudAudioReceiverError) throw error;
      fail("RESPONSE_INVALID");
    }
  }

  #validateResponseInner(opened, metadata, body) {
    if (!isPlainObject(opened)) fail("RESPONSE_INVALID");
    if (!Number.isInteger(opened.status)) fail("RESPONSE_INVALID");
    const headers = headerMap(opened.headers);
    if (!(body instanceof Readable)) fail("RESPONSE_INVALID");
    if (opened.status === 206) fail("PARTIAL_REJECTED");
    if (opened.status >= 300 && opened.status <= 399) fail("REDIRECT_REJECTED");
    if (opened.status !== 200) fail("STATUS_REJECTED");
    if (headers.has("location")) fail("REDIRECT_REJECTED");
    if (headers.has("transfer-encoding")) fail("RESPONSE_INVALID");
    if (headers.has("content-range")) fail("PARTIAL_REJECTED");
    const encoding = headers.get("content-encoding");
    if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
      fail("ENCODING_REJECTED");
    }
    const rawType = headers.get("content-type");
    if (rawType === undefined) fail("RESPONSE_INVALID");
    const media = contentTypeOf(rawType);
    if (!MIME_SET.has(media)) fail("UNSUPPORTED_MIME");
    if (media !== metadata.mimeType) fail("MIME_MISMATCH");
    const rawLength = headers.get("content-length");
    if (rawLength === undefined || !CONTENT_LENGTH_RE.test(rawLength)) fail("RESPONSE_INVALID");
    const declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared < 1) fail("RESPONSE_INVALID");
    if (declared > MAX_AUDIO_BYTES) fail("TOO_LARGE");
    if (declared !== metadata.bytes) fail("LENGTH_MISMATCH");
    return body;
  }

  async #unlinkOwned(filePath, identity) {
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) return false;
      if (identity !== null && (stat.dev !== identity.dev || stat.ino !== identity.ino)) {
        return false;
      }
      await fs.unlink(filePath);
      return true;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }

  #recordOrphan(filePath, identity) {
    const orphanId = crypto.randomBytes(8).toString("hex");
    this.#orphans.set(orphanId, { path: filePath, identity });
  }

  #settleIdleWaiters() {
    if (this.#active.size !== 0) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  #waitForIdle() {
    if (this.#active.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.#idleWaiters.push(resolve);
    });
  }

  stats() {
    return Object.freeze({
      active: this.#active.size,
      artifacts: this.#artifacts.size,
      orphans: this.#orphans.size,
      faulted: this.#faulted,
      disposed: this.#disposed,
    });
  }

  async receive(metadata, options = {}) {
    if (this.#disposed) fail("ALREADY_DISPOSED");
    if (this.#faulted) fail("RECEIVER_FAULTED");
    const meta = validateMetadata(metadata);
    let callerSignal;
    try {
      if (!isPlainObject(options)) fail("INVALID_REQUEST");
      for (const key of Object.keys(options)) {
        if (!OPTION_KEYS.has(key)) fail("INVALID_REQUEST");
      }
      callerSignal = validateCallerSignal(options.signal);
    } catch (error) {
      if (error instanceof CloudAudioReceiverError) throw error;
      fail("INVALID_REQUEST");
    }
    if (callerSignal?.aborted) fail("ABORTED");
    if (this.#active.size >= this.#maxActive) fail("BUSY");

    const controller = new AbortController();
    const slot = { controller };
    this.#active.add(slot);
    const onCallerAbort = () => {
      try {
        controller.abort();
      } catch {
        /* AbortController 自身不会抛；保守吞掉 */
      }
    };
    if (callerSignal !== null) {
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      if (callerSignal.aborted) controller.abort();
    }
    try {
      return await this.#receive(meta, controller);
    } finally {
      if (callerSignal !== null) callerSignal.removeEventListener("abort", onCallerAbort);
      this.#active.delete(slot);
      this.#settleIdleWaiters();
    }
  }

  async #receive(metadata, controller) {
    let handle = null;
    let filePath = null;
    let identity = null;
    let body = null;
    let bodyErrorGuard = null;
    let committed = false;
    let phase = "open";
    let abortCode = null;
    let abortReject = NOOP;
    const abortPromise = new Promise((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(NOOP);

    const requestAbort = (code) => {
      if (abortCode !== null) return;
      abortCode = code;
      try {
        controller.abort();
      } catch {
        /* 已中止或不可中止时仍按固定码失败 */
      }
      destroyStream(body);
      abortReject(new CloudAudioReceiverError(code));
    };
    const onSignalAbort = () => {
      if (abortCode !== null) return;
      abortCode = "ABORTED";
      destroyStream(body);
      abortReject(new CloudAudioReceiverError("ABORTED"));
    };
    controller.signal.addEventListener("abort", onSignalAbort, { once: true });

    const absoluteTimer = setTimeout(() => requestAbort("ABSOLUTE_TIMEOUT"), this.#absoluteTimeoutMs);
    const idleTimer = setTimeout(() => requestAbort("IDLE_TIMEOUT"), this.#idleTimeoutMs);
    const refreshIdle = () => {
      try {
        idleTimer.refresh();
      } catch {
        /* 定时器已清理 */
      }
    };

    try {
      const initialContext = this.#readContext();
      await this.#assertWorkDir();

      // 即使 openStream 不响应 AbortSignal 地挂起，取消/超时也必须及时结束本次接收；
      // 迟到的响应体在包装器内单独销毁，不会泄漏为活动流。
      const openedPromise = (async () => {
        const value = await this.#openStream(metadata.audioId, controller.signal);
        if (abortCode !== null) destroyStream(captureOwnedBody(value));
        return value;
      })();
      let opened;
      try {
        opened = await Promise.race([openedPromise, abortPromise]);
      } catch {
        if (abortCode !== null) fail(abortCode);
        fail("TRANSPORT_FAILED");
      }
      if (abortCode !== null) fail(abortCode);
      // 先安全地拥有真实响应体，再做状态/头校验：任何拒绝路径都能在 finally
      // 销毁实际传输流；访问器 body 与非 Readable 对象不会被当作可清理资源。
      body = captureOwnedBody(opened);
      this.#validateResponse(opened, metadata, body);
      // 响应体在文件创建/迭代器挂载之间可能已出错；先挂空监听避免无监听 'error'
      // 造成进程级未捕获异常，真正的失败仍由异步迭代器按固定码上报。
      try {
        bodyErrorGuard = NOOP;
        if (typeof body.on === "function") body.on("error", bodyErrorGuard);
        else bodyErrorGuard = null;
      } catch {
        bodyErrorGuard = null;
      }
      phase = "response";
      refreshIdle();
      this.#assertContext(initialContext);

      const fileName = `${crypto.randomBytes(16).toString("hex")}.part`;
      const candidate = path.join(this.#workDir, fileName);
      let createdHandle;
      try {
        createdHandle = await fs.open(
          candidate,
          fsSync.constants.O_CREAT | fsSync.constants.O_EXCL
            | fsSync.constants.O_WRONLY | fsSync.constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        fail("FILESYSTEM_ERROR");
      }
      handle = createdHandle;
      filePath = candidate;

      let openedStat;
      let pathStat;
      try {
        await handle.chmod(0o600);
        openedStat = await handle.stat();
        pathStat = await fs.lstat(candidate);
      } catch {
        fail("FILESYSTEM_ERROR");
      }
      if (!openedStat.isFile() || openedStat.nlink !== 1
        || (openedStat.mode & 0o777) !== 0o600
        || !pathStat.isFile() || pathStat.isSymbolicLink()
        || pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
        fail("FILESYSTEM_ERROR");
      }
      identity = { dev: openedStat.dev, ino: openedStat.ino };
      // 打开后再次核对工作目录与真实父目录，防止检查后被祖先符号链接替换。
      try {
        await this.#assertWorkDir();
        const realParent = path.dirname(await fs.realpath(candidate));
        if (realParent !== this.#workDir) fail("FILESYSTEM_ERROR");
      } catch (error) {
        if (error instanceof CloudAudioReceiverError) throw error;
        fail("FILESYSTEM_ERROR");
      }
      phase = "copy";

      let iterator;
      try {
        iterator = body[Symbol.asyncIterator]();
      } catch {
        fail("RESPONSE_INVALID");
      }
      if (iterator === null || typeof iterator?.next !== "function") fail("RESPONSE_INVALID");

      let bytes = 0;
      const hash = crypto.createHash("sha256");
      const copyPromise = (async () => {
        for (;;) {
          let step;
          try {
            step = await iterator.next();
          } catch {
            if (abortCode !== null) return;
            fail("STREAM_FAILED");
          }
          if (abortCode !== null) return;
          if (step === null || typeof step !== "object") fail("STREAM_FAILED");
          if (step.done === true) return;
          const chunk = step.value;
          if (!(chunk instanceof Uint8Array)) fail("STREAM_FAILED");
          if (chunk.length === 0) continue;
          this.#assertContext(initialContext);
          if (bytes + chunk.length > metadata.bytes) fail("TOO_LARGE");
          try {
            await writeAllChunk(handle, chunk);
          } catch {
            fail("FILESYSTEM_ERROR");
          }
          hash.update(chunk);
          bytes += chunk.length;
          if (this.#onProgress !== null) {
            // 进度回调只用于本地任务展示；回调异常不能改变接收结果。
            try {
              this.#onProgress(bytes, metadata.audioId);
            } catch {
              /* 忽略展示层异常 */
            }
          }
          refreshIdle();
        }
      })();

      await Promise.race([copyPromise, abortPromise]);
      if (abortCode !== null) fail(abortCode);
      phase = "verify";
      if (bytes !== metadata.bytes) fail("LENGTH_MISMATCH");
      const digest = hash.digest("hex");
      if (digest !== metadata.sha256) fail("DIGEST_MISMATCH");
      this.#assertContext(initialContext);
      if (controller.signal.aborted) fail(abortCode ?? "ABORTED");
      try {
        await handle.sync();
      } catch {
        fail("FILESYSTEM_ERROR");
      }
      this.#assertContext(initialContext);
      if (controller.signal.aborted || this.#disposed) fail(abortCode ?? "ABORTED");
      try {
        await handle.close();
      } catch {
        handle = null;
        fail("FILESYSTEM_ERROR");
      }
      handle = null;
      if (abortCode !== null || controller.signal.aborted || this.#disposed) {
        fail(abortCode ?? "ABORTED");
      }
      // 最后一次 await（close）之后、登记产物之前必须再同步复核身份；
      // 这里到 #artifacts.set 之间不允许再出现 await。
      this.#assertContext(initialContext);

      const artifactId = crypto.randomBytes(16).toString("hex");
      const artifact = Object.freeze({
        artifactId,
        audioId: metadata.audioId,
        bytes,
        sha256: digest,
        mimeType: metadata.mimeType,
      });
      this.#artifacts.set(artifactId, {
        path: filePath,
        identity,
        audioId: metadata.audioId,
        bytes,
        sha256: digest,
        mimeType: metadata.mimeType,
      });
      committed = true;
      return artifact;
    } catch (error) {
      if (error instanceof CloudAudioReceiverError) throw error;
      if (abortCode !== null) throw new CloudAudioReceiverError(abortCode);
      if (phase === "open") throw new CloudAudioReceiverError("TRANSPORT_FAILED");
      if (phase === "response") throw new CloudAudioReceiverError("RESPONSE_INVALID");
      if (phase === "verify") throw new CloudAudioReceiverError("FILESYSTEM_ERROR");
      throw new CloudAudioReceiverError("STREAM_FAILED");
    } finally {
      clearTimeout(absoluteTimer);
      clearTimeout(idleTimer);
      controller.signal.removeEventListener("abort", onSignalAbort);
      if (body !== null && bodyErrorGuard !== null && typeof body.removeListener === "function") {
        try {
          body.removeListener("error", bodyErrorGuard);
        } catch {
          /* 清理监听失败不影响固定错误路径 */
        }
      }
      destroyStream(body);

      let closeFailed = false;
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          closeFailed = true;
        }
        handle = null;
      }
      if (!committed && filePath !== null) {
        const removed = await this.#unlinkOwned(filePath, identity);
        if (!removed) {
          this.#faulted = true;
          this.#recordOrphan(filePath, identity);
          throw new CloudAudioReceiverError("CLEANUP_FAILED");
        }
      }
      if (!committed && closeFailed) {
        this.#faulted = true;
        throw new CloudAudioReceiverError("CLEANUP_FAILED");
      }
    }
  }

  async release(artifactId) {
    if (typeof artifactId !== "string" || artifactId.length === 0) fail("INVALID_REQUEST");
    const record = this.#artifacts.get(artifactId);
    if (record === undefined) return false;
    const removed = await this.#unlinkOwned(record.path, record.identity);
    if (!removed) {
      this.#faulted = true;
      throw new CloudAudioReceiverError("CLEANUP_FAILED");
    }
    this.#artifacts.delete(artifactId);
    return true;
  }

  /**
   * 受信任的内部消费接口（T-LOCAL-014B）：把产物路径交给同进程的安装器，
   * 消费结束后无论成功/失败都释放该产物的临时文件租约。路径永不进入 HTTP DTO。
   * consumer 收到冻结快照 { path, identity, bytes, sha256, mimeType }。
   * 未知 artifactId 返回 false；释放失败按既有故障语义抛 CLEANUP_FAILED。
   */
  async consume(artifactId, consumer) {
    if (this.#disposed) fail("ALREADY_DISPOSED");
    if (this.#faulted) fail("RECEIVER_FAULTED");
    if (typeof artifactId !== "string" || artifactId.length === 0) fail("INVALID_REQUEST");
    if (typeof consumer !== "function") fail("INVALID_REQUEST");
    const record = this.#artifacts.get(artifactId);
    if (record === undefined) return false;
    const snapshot = Object.freeze({
      path: record.path,
      identity: Object.freeze({ dev: record.identity.dev, ino: record.identity.ino }),
      bytes: record.bytes,
      sha256: record.sha256,
      mimeType: record.mimeType,
    });
    try {
      return await consumer(snapshot);
    } finally {
      await this.release(artifactId);
    }
  }

  async dispose() {
    this.#disposed = true;
    for (const slot of this.#active) {
      try {
        slot.controller.abort();
      } catch {
        /* 保守忽略中止异常 */
      }
    }
    await this.#waitForIdle();
    let failed = false;
    for (const [artifactId, record] of [...this.#artifacts]) {
      if (await this.#unlinkOwned(record.path, record.identity)) {
        this.#artifacts.delete(artifactId);
      } else {
        failed = true;
      }
    }
    for (const [orphanId, record] of [...this.#orphans]) {
      if (await this.#unlinkOwned(record.path, record.identity)) {
        this.#orphans.delete(orphanId);
      } else {
        failed = true;
      }
    }
    if (failed) {
      this.#faulted = true;
      fail("CLEANUP_FAILED");
    }
    return true;
  }
}
