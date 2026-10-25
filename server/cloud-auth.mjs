/**
 * 云端认证适配（T-LOCAL-CLOUD-001，第一阶段：隔离 mock）。
 *
 * 边界（见 拾光云端后台/docs/AUTH-API.md 与 collab/specs/T-LOCAL-CLOUD-001.md）：
 *   - 只在本地后端使用：mTLS 客户端证书、JWT、刷新令牌都不出本进程、不进浏览器。
 *   - 严格校验 CA / 主机名：rejectUnauthorized 恒为 true，不跟随重定向，不回退 HTTP。
 *   - access 只在内存；refresh 进 SecretStore（AES-256-GCM + 文件主密钥，不弹系统授权）。
 *   - 刷新必须 single-flight；超时/响应丢失/崩溃恢复 → 需重新登录，不无限重试旧令牌。
 *   - 日志与对外状态不含令牌、密码、P12 密码、私钥或本机路径。
 *
 * 生命周期（#0011 返工）：所有会改变配置/凭据/会话的操作递增 epoch 并中止旧请求；
 * 旧请求的迟到响应/错误在提交前核验 epoch，不能恢复已退出状态或清掉新一轮 single-flight。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { SecretStore } from "./secrets.mjs";

const CONFIG_FILE = "cloud-auth.json";
const STATE_FILE = "cloud-auth-state.json";
const REFRESH_SECRET = "cloud.refreshToken";
const P12_SECRET = "cloud.p12Pass";
const API_PREFIX = "/api/v1";
/** 提前 120 秒按需刷新（契约建议值） */
const REFRESH_SKEW_MS = 120_000;
/** 响应体上限：避免恶意/异常云端把本地内存打满 */
const MAX_RESPONSE_CHARS = 1_000_000;
/**
 * 受控 keep-alive 连接池（T-LOCAL-011）：只复用同一实例、同一套 TLS 材料的连接。
 * 并发上限保持小而有界；空闲连接最多保留 4 条并在 30s 后被主动关闭。
 *
 * 注意：Node 核心 http.Agent 并不读取 `freeSocketTimeout`（那是 agentkeepalive 的
 * 扩展字段），所以这里不依赖它，而是在 Agent 的 `free` 事件上对真正处于空闲池的
 * socket 挂有界计时器；socket 被复用/关闭时不会误杀，具体见 #armIdleTimer。
 */
const AGENT_MAX_SOCKETS = 4;
const AGENT_MAX_FREE_SOCKETS = 4;
const AGENT_IDLE_TIMEOUT_MS = 30_000;
const AGENT_KEEPALIVE_MS = 1_000;
/** 429 没有可用 Retry-After 时的安全冷却 */
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** 这些网络错误说明请求根本没被云端消费，可以保留凭据等下次重试 */
const NETWORK_ERRORS = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);
/** 证书/握手类错误：连接没到业务层，令牌未被消费 */
const CERT_ERRORS = new Set([
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "EPROTO",
]);
const UNCONSUMED_ERRORS = new Set([...NETWORK_ERRORS, ...CERT_ERRORS]);

/** 解析 Retry-After：数字秒、HTTP 日期、非法值都收敛到有界毫秒数 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value === undefined || value === null || value === "") return DEFAULT_RETRY_AFTER_MS;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_RETRY_AFTER_MS;
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(seconds * 1000)));
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    const delta = at - nowMs;
    if (delta <= 0) return MIN_RETRY_AFTER_MS;
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, delta));
  }
  return DEFAULT_RETRY_AFTER_MS;
}

export class CloudAuthError extends Error {
  constructor(message, { kind = "cloud", code = null, status = null, requestId = null, retryAfterMs = 0, cause = null, cloudMessage = false } = {}) {
    super(message);
    /** 消息是否来自云端响应（泄露风险高 → 对外只用固定文案） */
    this.cloudMessage = cloudMessage;
    this.name = "CloudAuthError";
    this.kind = kind; // config | cert | network | timeout | cloud | auth
    this.code = code;
    this.status = status;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
    this.cause = cause;
  }
  /** 对外只给可展示的脱敏信息 */
  toPublic() {
    const code = safeCode(this.code || this.kind);
    return {
      code,
      kind: this.kind,
      status: this.status,
      requestId: safeRequestId(this.requestId),
      retryAfterMs: Math.max(0, Number(this.retryAfterMs) || 0),
      message: this.cloudMessage
        ? PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES[this.kind] || "云端请求未完成"
        : String(this.message || "云端请求未完成").slice(0, 200),
    };
  }
}

const PUBLIC_MESSAGES = {
  config: "云端连接尚未配置完整",
  cert: "客户端证书或云端 CA 校验失败，请检查证书文件与主机名",
  network: "无法连接云端服务",
  timeout: "云端请求超时",
  cloud: "云端返回错误",
  auth: "登录状态无效",
  internal: "云端认证操作失败",
  INVALID_REQUEST: "请求参数不合法",
  UNAUTHORIZED: "凭据或会话已失效",
  NOT_FOUND: "资源不存在",
  RATE_LIMITED: "请求过于频繁，请稍后再试",
  NOT_LOGGED_IN: "尚未登录",
  REFRESH_INTERRUPTED: "上次刷新未完成，需要重新登录",
  REFRESH_TIMEOUT: "刷新响应丢失，需要重新登录",
  ACCOUNT_SWITCHED: "已切换账户，请重新登录",
  CERT_FILE_UNREADABLE: "无法读取云端证书文件，请重新配置",
  CERT_INVALID: "客户端证书或私钥配置无效",
  STORAGE_ERROR: "本地云端配置保存失败",
  STALE: "认证请求已被更新的操作取代",
  RESPONSE_INCOMPLETE: "云端响应不完整",
  RESPONSE_ABORTED: "云端响应中断",
  RESPONSE_TOO_LARGE: "云端响应过大",
  REQUEST_TIMEOUT: "云端请求超时",
  P12_PASSPHRASE_MISSING: "缺少 P12 口令，请重新填写设备证书口令",
  // T-LOCAL-007 设备自动开通
  ENROLLMENT_UNAVAILABLE: "本机自动开通尚未就绪",
  DEVICE_ALREADY_ENROLLED: "本机已开通，无需重复操作",
  DEVICE_KEY_LOST: "原设备密钥已丢失，需要重新开通",
  DEVICE_PENDING_IDENTITY_MISMATCH: "本机存在另一笔未完成的开通记录，请使用原开通码和设备名重试",
  DEVICE_PENDING_INVALID: "本机设备材料或开通记录不一致，已保留原文件，请联系管理员",
  DEVICE_LIMIT: "该账户的设备数量已达上限，请联系管理员",
  DEVICE_KEY_REUSED: "该公钥已被其他设备使用，需要重新开通",
  ACCOUNT_ACTIVATION_PENDING: "该账户已有待激活设备，请联系管理员",
  CERT_KEY_MISMATCH: "设备证书与本机密钥不匹配",
  CERT_EXPIRED: "设备证书不在有效期内",
  CERT_CHAIN_INVALID: "设备证书链校验失败",
  ENROLLMENT_RESPONSE_INVALID: "云端开通响应不完整",
  ENROLLMENT_RESPONSE_TOO_LARGE: "云端开通响应过大",
  ENROLLMENT_RESPONSE_INCOMPLETE: "云端开通响应不完整",
  ENROLLMENT_RESPONSE_ABORTED: "云端开通响应中断",
  ENROLLMENT_REDIRECT: "云端开通服务返回了重定向，已拒绝",
  ENROLLMENT_TIMEOUT: "云端开通请求超时",
  ENROLLMENT_NETWORK: "无法连接云端开通服务",
  ENROLLMENT_TLS_ERROR: "云端开通服务证书或主机名校验失败",
  ENROLLMENT_FAILED: "云端开通未完成",
  REQUEST_TOO_LARGE: "开通请求过大",
  FORBIDDEN: "没有执行该操作的权限",
};

const AUDIO_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const nowIso = (ms) => new Date(ms).toISOString();

export class CloudAuth {
  constructor(lib, { dataDir, clock = () => Date.now(), timeoutMs = 15_000, idleSocketMs = AGENT_IDLE_TIMEOUT_MS, secrets = null } = {}) {
    this.lib = lib;
    this.dataDir = dataDir || lib.dataDir;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
    /** 空闲 socket 保留时长；测试可注入更短值，生产默认 30s。 */
    this.idleSocketMs = Number.isFinite(idleSocketMs) && idleSocketMs > 0 ? idleSocketMs : AGENT_IDLE_TIMEOUT_MS;
    this.secrets = secrets || new SecretStore(lib);
    this.configPath = path.join(this.dataDir, CONFIG_FILE);
    this.statePath = path.join(this.dataDir, STATE_FILE);
    this.config = null;
    this.state = { state: "unconfigured", refreshing: false, lastError: null };
    this.accessToken = null;
    this.accessExpiresAt = 0;
    /** { epoch, promise }：只有同一个 entry 才能清空 single-flight */
    this.inflightRefresh = null;
    /** 进行中的 HTTP 请求，生命周期变化时主动中止 */
    this.activeRequests = new Set();
    /**
     * 受控 keep-alive 池：只保留一套当前 TLS 材料的 agent。
     * agentKey 是 origin + CA/证书/私钥/P12 内容的摘要（不含原始材料或口令）；
     * 材料或配置变化时销毁旧池，旧连接不会继续服务新身份。
     */
    this.agent = null;
    this.agentKey = null;
    this.poolGenerations = 0;
    /** 空闲 socket -> 回收计时器；随池一起清理。 */
    this.idleTimers = new Map();
    this.idleSocketsWatched = new WeakSet();
    /** 认证生命周期代次：logout/configure/login/activate 都会递增并中止旧请求 */
    this.epoch = 0;
    /** 控制类操作串行，避免 logout/configure/login 同时改状态文件 */
    this.controlChain = Promise.resolve();
    /** 状态文件写入串行，写入时取最新内存状态 */
    this.persistChain = Promise.resolve();
    /**
     * 跨 configure/activate/login/最终提交的"操作身份"：设备开通持有它，
     * 外部退出/换账户/高级配置会撤销它。它不随内部 epoch 变化失效，否则
     * 开通自己调用 configure/login 时就会把自己的身份取消掉。
     */
    this.operation = null;
  }

  /** 开始一段可被外部认证操作取消的组合操作（同一时刻只保留一个）。 */
  beginOperation() {
    if (this.operation) this.operation.active = false;
    this.operation = { active: true };
    return this.operation;
  }

  /** 结束组合操作；已被外部撤销或已被新操作取代时是幂等的。 */
  endOperation(operation) {
    if (operation) operation.active = false;
    if (this.operation === operation) this.operation = null;
  }

  /** 主动取消组合操作：撤销身份、中止其进行中的认证请求并推进 epoch。 */
  abortOperation(operation) {
    if (!operation || !operation.active) return false;
    this.endOperation(operation);
    this.#invalidate();
    return true;
  }

  /** 只读连接池信息，供测试/诊断使用；不含证书、口令、令牌或本机路径。 */
  getConnectionPoolInfo() {
    const agent = this.agent;
    const count = (map) => (map ? Object.values(map).reduce((total, list) => total + list.length, 0) : 0);
    return {
      configured: !!agent,
      generations: this.poolGenerations,
      activeSockets: count(agent?.sockets),
      freeSockets: count(agent?.freeSockets),
      maxSockets: agent?.maxSockets ?? 0,
      maxFreeSockets: agent?.maxFreeSockets ?? 0,
      idleSocketMs: this.idleSocketMs,
      idleTimers: this.idleTimers.size,
    };
  }

  /** 关闭空闲连接池；进程退出或测试清理时调用，不影响已保存的配置/会话。 */
  dispose() {
    this.#destroyAgent();
  }

  #revokeOperation() {
    if (this.operation) {
      this.operation.active = false;
      this.operation = null;
    }
  }

  #assertOperation(operation) {
    if (operation && (!operation.active || this.operation !== operation)) throw this.#staleError();
  }

  async init() {
    await this.secrets.init();
    this.config = await this.#readJson(this.configPath);
    const persisted = await this.#readJson(this.statePath);
    this.state = { ...this.state, ...(persisted || {}) };
    // 兼容上一版只存 retryAfterMs 的状态文件
    if (Number(this.state.retryAfterMs) > 0 && !Number(this.state.retryAt)) {
      this.state.retryAt = this.clock() + Number(this.state.retryAfterMs);
    }
    if (!this.config) {
      this.state.state = "unconfigured";
    } else if (this.state.refreshing) {
      // 上次刷新没走完就被中断：令牌可能已被云端消费，按契约转为"需重新登录"，
      // 并且必须清掉旧刷新令牌 —— 留着它只会在下次启动时又拿它去换，触发云端撤销整个会话。
      this.secrets.remove(REFRESH_SECRET);
      this.state.state = "needs-login";
      this.state.refreshing = false;
      this.state.lastError = { code: "REFRESH_INTERRUPTED", kind: "auth", message: PUBLIC_MESSAGES.REFRESH_INTERRUPTED };
    } else if (!this.secrets.get(REFRESH_SECRET)) {
      this.state.state = "logged-out";
    } else if (!this.state.state || this.state.state === "unconfigured") {
      this.state.state = "logged-out";
    }
    await this.#persistState();
    return this;
  }

  /** 对外状态：绝不含令牌、私钥、P12 密码或本机路径 */
  getState() {
    const host = this.config ? safeHost(this.config.origin) : null;
    const retryAt = Number(this.state.retryAt) || 0;
    const retryAfterMs = retryAt > this.clock() ? retryAt - this.clock() : 0;
    return {
      configured: !!this.config,
      originHost: host,
      hasCA: !!this.config?.caPath,
      hasClientCertificate: !!(this.config?.certPath || this.config?.p12Path),
      state: this.state.state,
      username: this.state.username || null,
      displayName: this.state.displayName || null,
      accountId: this.state.accountId || null,
      deviceId: this.state.deviceId || null,
      sessionId: this.state.sessionId || null,
      refreshExpiresAt: this.state.refreshExpiresAt || null,
      accessExpiresInMs: this.accessToken ? Math.max(0, this.accessExpiresAt - this.clock()) : null,
      needsLogin: this.state.state === "needs-login",
      lastError: this.state.lastError || null,
      retryAfterMs: retryAfterMs || null,
    };
  }

  /**
   * 保存连接配置；P12 密码只进 SecretStore，配置文件不含任何密码/令牌。
   * 设备开通传入自己的 operation：内部配置不能取消自己；任何外部 configure
   * 都会先撤销该 operation，使旧开通不能继续登录/提交。
   */
  async configure(patch = {}, { operation = null } = {}) {
    this.#assertOperation(operation);
    const abortingEnrollment = !operation && this.operation !== null;
    if (!operation) this.#revokeOperation();
    // origin/证书/CA/P12 口令变化，或外部配置打断了进行中的开通，都必须中止旧认证请求，
    // 避免旧池继续代表旧身份。
    const secretChanged = patch.p12Password !== undefined || patch.clearP12Password === true;
    if (this.#connectionChanged(patch) || abortingEnrollment || (!operation && secretChanged)) this.#invalidate();
    return this.#withControl(() => {
      this.#assertOperation(operation);
      return this.#configure(patch, operation);
    });
  }

  async activate({ activationToken, password } = {}, { operation = null } = {}) {
    this.#assertOperation(operation);
    if (!operation) this.#revokeOperation();
    this.#invalidate();
    return this.#withControl(() => {
      this.#assertOperation(operation);
      return this.#activate({ activationToken, password }, operation);
    });
  }

  async login({ username, password } = {}, { operation = null } = {}) {
    this.#assertOperation(operation);
    if (!operation) this.#revokeOperation();
    this.#invalidate();
    return this.#withControl(() => {
      this.#assertOperation(operation);
      return this.#login({ username, password }, operation);
    });
  }

  /** 本人资料（GET /me）；401 时最多尝试一次合规刷新 */
  async me() {
    const epoch = this.epoch;
    const token = await this.#access(epoch);
    if (epoch !== this.epoch) throw this.#staleError();
    try {
      return await this.#request("GET", "/me", { bearer: token, epoch });
    } catch (e) {
      if (epoch !== this.epoch) throw this.#staleError();
      if (!(e.status === 401 || e.code === "UNAUTHORIZED")) throw e;
      const fresh = await this.refresh();
      const epoch2 = this.epoch;
      try {
        return await this.#request("GET", "/me", { bearer: fresh, epoch: epoch2 });
      } catch (again) {
        if (epoch2 !== this.epoch) throw this.#staleError();
        if (again.status === 401 || again.code === "UNAUTHORIZED") {
          await this.#clear("needs-login", again.toPublic ? again.toPublic() : null, epoch2);
        }
        throw again;
      }
    }
  }

  async logout() {
    this.#revokeOperation();
    this.#invalidate();
    return this.#withControl(() => this.#logout());
  }

  /** 到期前按需刷新；并发调用共享同一次刷新（single-flight） */
  async ensureAccess() {
    return this.#access();
  }

  /**
   * 受控业务请求（T-LOCAL-008）：只给上层固定白名单模块使用。
   *
   * 这里不接受浏览器给的任意 URL/头：调用方必须已经从固定路由表构造出相对
   * /api/v1 的业务路径。令牌仍然只在 Node 内存里；mTLS 仍由 #tlsOptions 强制。
   * 401 不在这里自动递归刷新（可能是设备/会话被撤销），由调用方清身份。
   */
  async proxy(method, pathname, { body = null, bearer = true, epoch = this.epoch } = {}) {
    if (typeof method !== "string" || !/^[A-Z]{3,7}$/.test(method))
      throw new CloudAuthError("云端请求方法不合法", { kind: "config", code: "INVALID_REQUEST" });
    if (
      typeof pathname !== "string" ||
      !pathname.startsWith("/") ||
      pathname.includes("..") ||
      /[\r\n]/.test(pathname)
    )
      throw new CloudAuthError("云端请求路径不合法", { kind: "config", code: "INVALID_REQUEST" });
    // 调用方可以固定入队时的代次；不能用“执行时最新”的会话顶替旧意图。
    if (epoch !== this.epoch) throw this.#staleError();
    const token = bearer ? await this.#access(epoch) : null;
    if (epoch !== this.epoch) throw this.#staleError();
    return this.#request(method, pathname, { body, bearer: token, epoch });
  }

  /**
   * T-LOCAL-014B：固定的音频内容流方法（GET /media/audio/{id}/content）。
   *
   * 只接受规范小写 UUID 与调用方捕获的 epoch；不接受 URL/头/证书/令牌参数。
   * 成功后返回 {status, headers, body}，body 是未解码的 Node Readable，由调用方
   * 负责消费/销毁；本方法不读取、不缓冲、不 base64、不跟随重定向。
   * 与普通 JSON 请求共用同一套 TLS 材料、同一个有界 keep-alive 池和 epoch 中止集合：
   * logout/configure/换设备会 abort 正在传输的流，旧 epoch 不能拿新会话继续下载。
   */
  async openAudioContentStream(audioId, { epoch = this.epoch, signal = null } = {}) {
    if (typeof audioId !== "string" || !AUDIO_ID_RE.test(audioId))
      throw new CloudAuthError("音频标识不合法", { kind: "config", code: "INVALID_REQUEST" });
    if (epoch !== this.epoch) throw this.#staleError();
    if (signal !== null) {
      const valid =
        typeof signal === "object" &&
        typeof signal.aborted === "boolean" &&
        typeof signal.addEventListener === "function" &&
        typeof signal.removeEventListener === "function";
      if (!valid) throw new CloudAuthError("下载取消信号不合法", { kind: "config", code: "INVALID_REQUEST" });
      if (signal.aborted) throw new CloudAuthError("下载已取消", { kind: "network", code: "ABORTED" });
    }
    const token = await this.#access(epoch);
    if (epoch !== this.epoch) throw this.#staleError();
    if (signal !== null && signal.aborted) throw new CloudAuthError("下载已取消", { kind: "network", code: "ABORTED" });
    return this.#requestStream(`/media/audio/${audioId}/content`, { bearer: token, epoch, signal });
  }

  // Fixed raw PUT; only a trusted local snapshot stream is accepted, never browser URLs/headers.
  async uploadAudioContent(requestId, { source, bytes, epoch = this.epoch, signal = null } = {}) {
    if (!AUDIO_ID_RE.test(requestId || "") || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 256_000_000
      || !source || typeof source.pipe !== "function") throw new CloudAuthError("上传参数不合法", { code: "INVALID_REQUEST" });
    // Own errors from the moment the caller hands us the stream, including TLS/access awaits.
    source.on("error", () => {});
    try {
      if (epoch !== this.epoch) throw this.#staleError();
      const token = await this.#access(epoch);
      return await this.#request("PUT", `/media/upload-requests/${requestId}/content`, {
        bearer: token, epoch, rawUpload: { source, bytes, signal },
      });
    } finally { source.destroy(); }
  }

  /**
   * 云端已经判定当前会话失效（401、本人改密、撤销当前设备、密码重置成功）：
   * 清掉本机保存的刷新令牌与登录态，但不删除设备证书/私钥，也不改连接配置。
   */
  async forgetSession(reason = null, { epoch = null } = {}) {
    this.#revokeOperation();
    // 携带 epoch 的调用只允许清掉它自己绑定的那个会话；如果调用方已经切到
    // 新登录/新配置，直接放弃，绝不能把新会话清掉。
    if (epoch !== null && this.epoch !== epoch) return this.getState();
    // 先占一个代次再排队；如果排队期间已有新登录/配置推进代次，
    // 旧 401 的清理必须放弃，不能把新会话清掉。
    const expected = this.epoch + 1;
    this.#invalidate();
    return this.#withControl(async () => {
      if (this.epoch !== expected) return this.getState();
      await this.#clear("needs-login", reason, this.epoch);
      return this.getState();
    });
  }

  /** Fixed mTLS-only recovery check; no Bearer or browser-supplied destination. */
  async resetRevokedEnrollment({ deviceId, config, archive }, { operation } = {}) {
    this.#assertOperation(operation);
    this.#invalidate();
    return this.#withControl(async () => {
      this.#assertOperation(operation);
      const previous = this.config;
      if (previous && ["origin", "caPath", "certPath", "keyPath", "p12Path"].some(key => (previous[key] || null) !== (config[key] || null)))
        throw new CloudAuthError("当前连接不属于本机自动开通，已停止恢复", { code: "DEVICE_RECOVERY_UNSAFE", kind: "config", status: 409 });
      const epoch = this.epoch;
      let detached = false;
      try {
        // A crash after detaching leaves the original directory intact. Its own pinned
        // configuration may be used again solely to re-check revocation, never to log in.
        this.config = config;
        const proof = await this.#request("POST", "/auth/device-recovery", { body: { deviceId }, epoch });
        this.#assertOperation(operation);
        if (epoch !== this.epoch) throw this.#staleError();
        if (proof?.deviceId !== deviceId || proof?.revoked !== true)
          throw new CloudAuthError("云端未确认设备已撤销，原材料保持不变", { code: "DEVICE_NOT_REVOKED", kind: "cloud", status: 409 });
        await this.#writeJson(this.configPath, null);
        detached = true;
        this.config = null;
        await this.#clear("unconfigured", null, epoch);
        this.#assertOperation(operation);
        if (epoch + 1 !== this.epoch) throw this.#staleError();
        // Synchronous atomic directory rename: cancellation cannot interleave with it.
        archive();
        return this.getState();
      } finally {
        if (!detached) this.config = previous;
      }
    });
  }

  async refresh() {
    if (this.inflightRefresh) return this.inflightRefresh.promise;
    const epoch = this.epoch;
    const entry = { epoch, promise: null };
    entry.promise = this.#doRefresh(epoch).finally(() => {
      // 旧 finally 不能清掉后来新一轮的 single-flight
      if (this.inflightRefresh === entry) this.inflightRefresh = null;
    });
    this.inflightRefresh = entry;
    return entry.promise;
  }

  // ── 控制类操作（串行 + epoch 校验） ─────────────────────

  async #configure(patch, operation = null) {
    const epoch = this.epoch;
    this.#assertOperation(operation);
    const next = {
      origin: patch.origin ?? this.config?.origin ?? null,
      caPath: patch.caPath ?? this.config?.caPath ?? null,
      certPath: patch.certPath ?? this.config?.certPath ?? null,
      keyPath: patch.keyPath ?? this.config?.keyPath ?? null,
      p12Path: patch.p12Path ?? this.config?.p12Path ?? null,
    };
    if (!next.origin) throw new CloudAuthError("请填写云端地址", { kind: "config" });
    let url;
    try {
      url = new URL(next.origin);
    } catch {
      throw new CloudAuthError("云端地址格式不正确", { kind: "config" });
    }
    if (url.protocol !== "https:") throw new CloudAuthError("云端地址必须使用 HTTPS", { kind: "config" });
    if (!next.caPath) throw new CloudAuthError("请提供云端 CA 证书路径", { kind: "config" });
    if (!((next.certPath && next.keyPath) || next.p12Path))
      throw new CloudAuthError("请提供设备证书与私钥（PEM 或 P12）", { kind: "config" });
    for (const [label, p] of [
      ["云端 CA", next.caPath],
      ["设备证书", next.certPath || next.p12Path],
      ["设备私钥", next.keyPath],
    ]) {
      if (!p) continue;
      const ok = await fs
        .stat(p)
        .then((s) => s.isFile())
        .catch(() => false);
      if (!ok) throw new CloudAuthError(`${label}文件不存在或不可读`, { kind: "config" });
      this.#assertOperation(operation);
      if (epoch !== this.epoch) throw this.#staleError();
    }
    const previous = this.config || null;
    const previousOrigin = previous?.origin || null;
    const identityChanged =
      !!previous &&
      (previous.certPath !== next.certPath ||
        previous.keyPath !== next.keyPath ||
        previous.p12Path !== next.p12Path ||
        previous.caPath !== next.caPath);
    if (patch.p12Password) await this.secrets.set(P12_SECRET, String(patch.p12Password));
    if (patch.clearP12Password) this.secrets.remove(P12_SECRET);
    this.#assertOperation(operation);
    if (epoch !== this.epoch) throw this.#staleError();
    this.config = next;
    await this.#writeJson(this.configPath, next);
    this.#assertOperation(operation);
    if (epoch !== this.epoch) throw this.#staleError();
    if (previousOrigin && (previousOrigin !== next.origin || identityChanged)) {
      await this.#clear("logged-out", null, epoch);
      this.#assertOperation(operation);
      return this.getState();
    }
    if (!this.secrets.get(REFRESH_SECRET)) {
      this.state = { ...this.state, state: "logged-out", refreshing: false, retryAt: 0, retryAfterMs: 0 };
    }
    this.#assertOperation(operation);
    if (epoch !== this.epoch) throw this.#staleError();
    await this.#persistState();
    this.#assertOperation(operation);
    return this.getState();
  }

  async #activate({ activationToken, password }, operation = null) {
    const startEpoch = this.epoch;
    if (!this.config) throw new CloudAuthError("请先配置云端连接", { kind: "config" });
    if (typeof activationToken !== "string" || !activationToken.trim())
      throw new CloudAuthError("请填写激活凭证", { kind: "cloud", code: "INVALID_REQUEST" });
    if (typeof password !== "string" || password.length < 12)
      throw new CloudAuthError("密码至少 12 个字符", { kind: "cloud", code: "INVALID_REQUEST" });
    await this.#clear("logged-out", null, startEpoch);
    const epoch = this.epoch;
    const data = await this.#request("POST", "/auth/activate", {
      body: { activationToken: activationToken.trim(), password },
      epoch,
    });
    this.#assertOperation(operation);
    await this.#applySession(data, epoch, operation);
    await this.#refreshProfile(epoch, operation);
    return this.getState();
  }

  async #login({ username, password }, operation = null) {
    const startEpoch = this.epoch;
    if (!this.config) throw new CloudAuthError("请先配置云端连接", { kind: "config" });
    if (typeof username !== "string" || !username.trim())
      throw new CloudAuthError("请填写用户名", { kind: "cloud", code: "INVALID_REQUEST" });
    if (typeof password !== "string" || !password)
      throw new CloudAuthError("请填写密码", { kind: "cloud", code: "INVALID_REQUEST" });
    await this.#clear("logged-out", null, startEpoch);
    const epoch = this.epoch;
    const data = await this.#request("POST", "/auth/login", {
      body: { username: username.trim().toLowerCase(), password },
      epoch,
    });
    this.#assertOperation(operation);
    await this.#applySession(data, epoch, operation);
    await this.#refreshProfile(epoch, operation);
    return this.getState();
  }

  async #logout() {
    const epoch = this.epoch;
    const access = this.accessToken && this.accessExpiresAt > this.clock() ? this.accessToken : null;
    let cloudRevoked = false;
    let error = null;
    if (access) {
      try {
        await this.#request("POST", "/auth/logout", { bearer: access, epoch });
        cloudRevoked = true;
      } catch (e) {
        if (epoch !== this.epoch) throw this.#staleError();
        if (e.status === 401 || e.code === "UNAUTHORIZED") cloudRevoked = true; // 已撤销，等同于退出成功
        else error = e.toPublic ? e.toPublic() : { code: "network" };
      }
    }
    await this.#clear("logged-out", null, epoch);
    return {
      localLoggedOut: true,
      // 云端不可达时如实区分：本地已退出 ≠ 云端已撤销
      cloudRevoked,
      error,
      state: this.getState(),
    };
  }

  // ── 内部 ──────────────────────────────────────────────

  #staleError() {
    return new CloudAuthError("认证请求已被更新的操作取代", { kind: "auth", code: "STALE" });
  }

  #invalidate() {
    this.epoch += 1;
    const error = this.#staleError();
    for (const entry of [...this.activeRequests]) {
      try {
        entry.abort(error);
      } catch {
        /* 请求可能已经结束 */
      }
    }
    this.activeRequests.clear();
    this.inflightRefresh = null;
    // 退出/换身份/配置变化后，旧池里的空闲连接也不能继续代表旧身份。
    this.#destroyAgent();
    return this.epoch;
  }

  #withControl(fn) {
    const run = this.controlChain.then(fn, fn);
    this.controlChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #connectionChanged(patch) {
    const config = this.config;
    if (!config) return true;
    for (const key of ["origin", "caPath", "certPath", "keyPath", "p12Path"]) {
      if (patch[key] !== undefined && patch[key] !== config[key]) return true;
    }
    return false;
  }

  async #access(epoch = this.epoch) {
    if (epoch !== this.epoch) throw this.#staleError();
    if (this.accessToken && this.accessExpiresAt - this.clock() > REFRESH_SKEW_MS) return this.accessToken;
    return this.refresh();
  }

  async #doRefresh(epoch) {
    if (epoch !== this.epoch) throw this.#staleError();
    const token = this.secrets.get(REFRESH_SECRET);
    if (!token) {
      await this.#clear("logged-out", null, epoch);
      throw new CloudAuthError("尚未登录", { kind: "auth", code: "NOT_LOGGED_IN" });
    }
    const expiresAt = this.state.refreshExpiresAt ? Date.parse(this.state.refreshExpiresAt) : null;
    if (expiresAt && expiresAt <= this.clock()) {
      await this.#clear("needs-login", { code: "UNAUTHORIZED", kind: "auth", message: PUBLIC_MESSAGES.UNAUTHORIZED }, epoch);
      throw new CloudAuthError("会话已到最长期限，需要重新登录", { kind: "auth", code: "UNAUTHORIZED" });
    }
    // 429 冷却：截止前不发新云端请求（HTTP 的 Retry-After 不能只记录不执行）
    const retryAt = Number(this.state.retryAt) || 0;
    if (retryAt > this.clock()) {
      throw new CloudAuthError("请求过于频繁，请稍后再试", {
        kind: "cloud",
        code: "RATE_LIMITED",
        status: 429,
        retryAfterMs: retryAt - this.clock(),
      });
    }
    // 先落盘"刷新进行中"：崩溃/断电后重启能识别为未完成刷新
    await this.#patchState({ refreshing: true }, epoch);
    try {
      const data = await this.#request("POST", "/auth/refresh", { body: { refreshToken: token }, epoch });
      await this.#applySession(data, epoch);
      return this.accessToken;
    } catch (e) {
      if (epoch !== this.epoch) throw this.#staleError();
      if (e.status === 401 || e.code === "UNAUTHORIZED") {
        await this.#clear("needs-login", e.toPublic ? e.toPublic() : null, epoch);
        throw e;
      }
      if (e.status === 429 || e.code === "RATE_LIMITED") {
        // 请求被限流、令牌未被消费：保留凭据，但在 retryAt 之前不再发新请求
        const retryAfterMs = Math.max(MIN_RETRY_AFTER_MS, Number(e.retryAfterMs) || DEFAULT_RETRY_AFTER_MS);
        e.retryAfterMs = retryAfterMs;
        await this.#patchState(
          {
            refreshing: false,
            state: "rate-limited",
            retryAt: this.clock() + retryAfterMs,
            retryAfterMs,
            lastError: e.toPublic ? e.toPublic() : null,
          },
          epoch,
        );
        throw e;
      }
      if (e.kind === "cert" || (e.cause && UNCONSUMED_ERRORS.has(e.cause.code))) {
        // 证书/连不上：请求没有到达业务层，令牌未被消费，保留凭据等恢复
        await this.#patchState(
          {
            refreshing: false,
            state: e.kind === "cert" ? "cert-error" : "cloud-unreachable",
            retryAt: 0,
            retryAfterMs: 0,
            lastError: e.toPublic ? e.toPublic() : null,
          },
          epoch,
        );
        throw e;
      }
      // 超时 / 响应丢失 / 5xx：令牌状态不确定，按契约要求重新登录，绝不重试旧令牌
      await this.#clear(
        "needs-login",
        {
          code: e.kind === "timeout" ? "REFRESH_TIMEOUT" : "UNAUTHORIZED",
          kind: e.kind === "timeout" ? "timeout" : "cloud",
          status: e.status || null,
          message: PUBLIC_MESSAGES[e.kind === "timeout" ? "REFRESH_TIMEOUT" : "UNAUTHORIZED"],
        },
        epoch,
      );
      throw e;
    }
  }

  async #request(method, pathname, { body = null, bearer = null, epoch = this.epoch, rawUpload = null } = {}) {
    if (epoch !== this.epoch) throw this.#staleError();
    if (!this.config) throw new CloudAuthError("云端连接尚未配置", { kind: "config" });
    const url = new URL(API_PREFIX + pathname, this.config.origin);
    if (url.protocol !== "https:") throw new CloudAuthError("云端地址必须使用 HTTPS", { kind: "config" });
    const headers = { accept: "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let payload = null;
    if (body) {
      payload = Buffer.from(JSON.stringify(body), "utf8");
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    if (rawUpload) {
      headers["content-type"] = "application/octet-stream";
      headers["content-length"] = String(rawUpload.bytes);
    }
    let tls;
    let agent;
    try {
      const prepared = await this.#tlsOptions();
      tls = prepared.options;
      if (epoch !== this.epoch) throw this.#staleError();
      // 同一套配置/材料复用连接；材料内容一变就换新池，旧池立即销毁。
      agent = this.#agentFor(prepared.key);
    } catch (e) {
      throw e instanceof CloudAuthError ? e : new CloudAuthError(PUBLIC_MESSAGES.CERT_INVALID, { kind: "cert", code: "CERT_INVALID", cause: e });
    }
    if (epoch !== this.epoch) throw this.#staleError();
    if (rawUpload?.source.errored) throw this.#classify(rawUpload.source.errored);

    return await new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      let deadline = null;
      const entry = {
        abort: (error) => {
          try {
            req?.destroy(error);
          } catch {
            /* 已结束 */
          }
        },
      };
      const cancelUpload = () => entry.abort(new CloudAuthError("上传结果需要核对", { code: "ABORTED", kind: "network" }));
      const sourceError = error => { req?.destroy(error); fail(error); };
      this.activeRequests.add(entry);
      const cleanup = () => {
        rawUpload?.signal?.removeEventListener("abort", cancelUpload);
        if (rawUpload) { rawUpload.source.destroy(); if (!req?.writableFinished) req?.destroy(); }
        if (deadline) {
          clearTimeout(deadline);
          deadline = null;
        }
        this.activeRequests.delete(entry);
      };
      const settle = (fn, value) => {
        if (settled) return false;
        settled = true;
        cleanup();
        fn(value);
        return true;
      };
      const fail = (error) => settle(reject, error instanceof CloudAuthError ? error : this.#classify(error));
      const succeed = (value) => settle(resolve, value);

      const onResponse = (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (settled) return;
          text += chunk;
          if (text.length > MAX_RESPONSE_CHARS) {
            res.destroy();
            fail(new CloudAuthError(PUBLIC_MESSAGES.RESPONSE_TOO_LARGE, { kind: "cloud", code: "RESPONSE_TOO_LARGE" }));
          }
        });
        res.on("end", () => {
          if (settled) return;
          if (!res.complete) {
            return fail(new CloudAuthError(PUBLIC_MESSAGES.RESPONSE_INCOMPLETE, { kind: "network", code: "RESPONSE_INCOMPLETE" }));
          }
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            return fail(new CloudAuthError("云端响应无法解析", { kind: "cloud", status: res.statusCode }));
          }
          if (rawUpload && !req.writableFinished) return fail(new CloudAuthError(PUBLIC_MESSAGES.RESPONSE_INCOMPLETE, { kind: "network", code: "RESPONSE_INCOMPLETE" }));
          if (res.statusCode >= 200 && res.statusCode < 300 && parsed?.code === "OK") return succeed(parsed.data ?? null);
          const retryHeader = res.headers["retry-after"];
          const retryAfterMs =
            res.statusCode === 429
              ? parseRetryAfterMs(retryHeader, this.clock())
              : retryHeader
                ? parseRetryAfterMs(retryHeader, this.clock())
                : 0;
          fail(
            new CloudAuthError(parsed?.message || "云端返回错误", {
              kind: "cloud",
              cloudMessage: true,
              code: parsed?.code || `HTTP_${res.statusCode}`,
              status: res.statusCode || null,
              requestId: parsed?.requestId || null,
              retryAfterMs,
            }),
          );
        });
        res.on("aborted", () => {
          fail(new CloudAuthError(PUBLIC_MESSAGES.RESPONSE_ABORTED, { kind: "network", code: "RESPONSE_ABORTED" }));
        });
        res.on("error", (e) => {
          fail(new CloudAuthError(PUBLIC_MESSAGES.RESPONSE_ABORTED, { kind: "network", code: "RESPONSE_ABORTED", cause: e }));
        });
        res.on("close", () => {
          if (!settled && !res.complete) {
            fail(new CloudAuthError(PUBLIC_MESSAGES.RESPONSE_INCOMPLETE, { kind: "network", code: "RESPONSE_INCOMPLETE" }));
          }
        });
      };

      try {
        req = https.request(
          url,
          {
            method,
            headers,
            ...tls,
            // 关键：绝不关闭证书/主机名校验，也不接受 HTTP 回退
            rejectUnauthorized: true,
            timeout: this.timeoutMs,
            agent,
          },
          onResponse,
        );
      } catch (e) {
        fail(new CloudAuthError(PUBLIC_MESSAGES.CERT_INVALID, { kind: "cert", code: "CERT_INVALID", cause: e }));
        return;
      }
      // 完整请求的绝对截止时间，不依赖 socket inactivity timeout
      deadline = setTimeout(() => {
        const error = new CloudAuthError(PUBLIC_MESSAGES.REQUEST_TIMEOUT, { kind: "timeout", code: "REQUEST_TIMEOUT" });
        try {
          req.destroy(error);
        } catch {
          /* 已结束 */
        }
        fail(error);
      }, rawUpload ? 300_000 : Math.max(1, Number(this.timeoutMs) || 15_000));
      req.on("timeout", () => {
        const error = new CloudAuthError(PUBLIC_MESSAGES.REQUEST_TIMEOUT, { kind: "timeout", code: "REQUEST_TIMEOUT" });
        req.destroy(error);
        fail(error);
      });
      req.on("error", (e) => fail(e));
      if (rawUpload) {
        rawUpload.source.on("error", sourceError);
        rawUpload.signal?.addEventListener("abort", cancelUpload, { once: true });
        if (rawUpload.signal?.aborted) cancelUpload();
        else rawUpload.source.pipe(req);
      } else { if (payload) req.write(payload); req.end(); }
    });
  }

  /**
   * 原始流请求：响应头到了就 resolve，body 原样交给调用方；不解析 JSON、不设 utf8。
   * 请求仍登记在 activeRequests 中，直到响应体 close；epoch 失效时主动 destroy。
   */
  async #requestStream(pathname, { bearer, epoch, signal }) {
    if (epoch !== this.epoch) throw this.#staleError();
    if (!this.config) throw new CloudAuthError("云端连接尚未配置", { kind: "config" });
    const url = new URL(API_PREFIX + pathname, this.config.origin);
    if (url.protocol !== "https:") throw new CloudAuthError("云端地址必须使用 HTTPS", { kind: "config" });
    let tls;
    let agent;
    try {
      const prepared = await this.#tlsOptions();
      tls = prepared.options;
      if (epoch !== this.epoch) throw this.#staleError();
      agent = this.#agentFor(prepared.key);
    } catch (e) {
      throw e instanceof CloudAuthError ? e : new CloudAuthError(PUBLIC_MESSAGES.CERT_INVALID, { kind: "cert", code: "CERT_INVALID", cause: e });
    }
    if (epoch !== this.epoch) throw this.#staleError();
    if (signal !== null && signal.aborted) throw new CloudAuthError("下载已取消", { kind: "network", code: "ABORTED" });

    return await new Promise((resolve, reject) => {
      let settled = false;
      let req = null;
      let res = null;
      let headerTimer = null;
      const entry = {
        abort: () => {
          const error = this.#staleError();
          try {
            req?.destroy(error);
          } catch {
            /* 已结束 */
          }
          try {
            res?.destroy(error);
          } catch {
            /* 已结束 */
          }
        },
      };
      this.activeRequests.add(entry);
      const clearHeaderTimer = () => {
        if (headerTimer) {
          clearTimeout(headerTimer);
          headerTimer = null;
        }
      };
      const detachSignal = () => {
        if (signal !== null) signal.removeEventListener("abort", onSignalAbort);
      };
      const finish = () => {
        clearHeaderTimer();
        detachSignal();
        this.activeRequests.delete(entry);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error instanceof CloudAuthError ? error : this.#classify(error));
      };
      const succeed = (value) => {
        if (settled) return;
        settled = true;
        // 只清响应头截止计时；signal 必须保留到 body close/error/end，否则
        // 调用者在响应头之后 abort 无法停止已打开的响应体。
        clearHeaderTimer();
        resolve(value);
      };
      const onSignalAbort = () => {
        const error = new CloudAuthError("下载已取消", { kind: "network", code: "ABORTED" });
        try {
          req?.destroy(error);
        } catch {
          /* 已结束 */
        }
        try {
          res?.destroy(error);
        } catch {
          /* 已结束 */
        }
        if (settled) {
          // 已经 resolve 后，错误通过 body 的 error/close 传递；这里主动释放
          // 监听与 activeRequests，避免 body 不合作时残留。
          finish();
          return;
        }
        fail(error);
      };

      if (signal !== null) {
        signal.addEventListener("abort", onSignalAbort, { once: true });
        if (signal.aborted) {
          onSignalAbort();
          return;
        }
      }
      try {
        req = https.request(
          url,
          {
            method: "GET",
            headers: { accept: "audio/*", authorization: `Bearer ${bearer}` },
            ...tls,
            rejectUnauthorized: true,
            agent,
          },
          (incoming) => {
            if (settled || epoch !== this.epoch) {
              incoming.destroy();
              if (epoch !== this.epoch) fail(this.#staleError());
              return;
            }
            res = incoming;
            if (headerTimer) {
              clearTimeout(headerTimer);
              headerTimer = null;
            }
            incoming.once("close", finish);
            incoming.once("end", finish);
            incoming.once("error", finish);
            const headers = {};
            for (const [key, value] of Object.entries(incoming.headers)) headers[key] = value;
            succeed({ status: incoming.statusCode, headers, body: incoming });
          },
        );
      } catch (e) {
        fail(new CloudAuthError(PUBLIC_MESSAGES.CERT_INVALID, { kind: "cert", code: "CERT_INVALID", cause: e }));
        return;
      }
      req.on("error", (e) => fail(e));
      headerTimer = setTimeout(() => {
        const error = new CloudAuthError(PUBLIC_MESSAGES.REQUEST_TIMEOUT, { kind: "timeout", code: "REQUEST_TIMEOUT" });
        try {
          req.destroy(error);
        } catch {
          /* 已结束 */
        }
        fail(error);
      }, Math.max(1, Number(this.timeoutMs) || 15_000));
      headerTimer.unref?.();
      req.end();
    });
  }

  #classify(e) {
    if (e instanceof CloudAuthError) return e;
    const code = e?.code || "";
    if (code === "ABORT_ERR" || e?.name === "AbortError") return this.#staleError();
    const message = String(e?.message || "");
    if (
      CERT_ERRORS.has(code) ||
      /CERT|TLS|SSL|SELF_SIGNED|VERIFY|ALTNAME|ERR_OSSL|PEM|X509/i.test(code) ||
      /certificate|handshake|PEM/i.test(message)
    )
      return new CloudAuthError("客户端证书或云端 CA 校验失败", { kind: "cert", code, cause: e });
    return new CloudAuthError("无法连接云端服务", { kind: "network", code, cause: e });
  }

  async #tlsOptions() {
    const cfg = this.config;
    if (!cfg) throw new CloudAuthError("云端连接尚未配置", { kind: "config" });
    const read = async (p, label) => {
      try {
        return await fs.readFile(p);
      } catch (e) {
        throw new CloudAuthError(`无法读取${label}文件，请重新配置`, { kind: "cert", code: "CERT_FILE_UNREADABLE", cause: e });
      }
    };
    const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
    const ca = await read(cfg.caPath, "云端 CA 证书");
    const options = { ca, minVersion: "TLSv1.2" };
    const parts = [cfg.origin || "", digest(ca)];
    if (cfg.p12Path) {
      const passphrase = this.secrets.get(P12_SECRET);
      if (!passphrase)
        throw new CloudAuthError(PUBLIC_MESSAGES.P12_PASSPHRASE_MISSING, { kind: "config", code: "P12_PASSPHRASE_MISSING" });
      const pfx = await read(cfg.p12Path, "设备 P12 证书");
      options.pfx = pfx;
      options.passphrase = passphrase;
      // 口令只取其摘要参与池标识，绝不出现在日志/状态/返回结构中。
      parts.push("p12", digest(pfx), digest(String(passphrase)));
    } else {
      const cert = await read(cfg.certPath, "设备证书");
      const key = await read(cfg.keyPath, "设备私钥");
      options.cert = cert;
      options.key = key;
      parts.push("pem", digest(cert), digest(key));
    }
    return { options, key: parts.join("|") };
  }

  /**
   * 取当前 TLS 材料对应的受控 keep-alive 池。key 由配置文件内容摘要组成：
   * 同一路径下证书/私钥/P12/CA 被续换时 key 变化，旧池立即销毁，不会永远使用旧材料。
   * 池有界（最多 4 个并发 socket、4 个空闲 socket），并且只属于当前 CloudAuth 实例。
   */
  #agentFor(key) {
    if (this.agent && this.agentKey === key) return this.agent;
    this.#destroyAgent();
    const agent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: AGENT_KEEPALIVE_MS,
      maxSockets: AGENT_MAX_SOCKETS,
      maxFreeSockets: AGENT_MAX_FREE_SOCKETS,
      scheduling: "lifo",
    });
    // 空闲连接不阻止进程退出；下一次请求仍可复用同一 socket。
    agent.on("free", (socket) => {
      // 核心 Agent 只负责把 socket 放入空闲池，不提供“空闲 N 秒后关闭”的选项；
      // 这里显式回收，避免空闲连接无限期占用云端/本机资源。
      this.#armIdleTimer(agent, socket);
      try {
        socket.unref();
      } catch {
        /* socket 已关闭 */
      }
    });
    this.agent = agent;
    this.agentKey = key;
    this.poolGenerations += 1;
    return agent;
  }

  /**
   * 给空闲 socket 挂有界回收计时器。计时器触发时只销毁“仍在 agent.freeSockets 里”
   * 的 socket：若它已被新请求取走，就什么都不做，避免误杀在途请求。
   */
  #armIdleTimer(agent, socket) {
    if (!socket || socket.destroyed) return;
    const previous = this.idleTimers.get(socket);
    if (previous) clearTimeout(previous);
    if (!this.idleSocketsWatched.has(socket)) {
      this.idleSocketsWatched.add(socket);
      socket.once("close", () => {
        const timer = this.idleTimers.get(socket);
        if (timer) clearTimeout(timer);
        this.idleTimers.delete(socket);
      });
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(socket);
      if (socket.destroyed) return;
      const free = Object.values(agent.freeSockets || {}).some(
        (list) => Array.isArray(list) && list.includes(socket),
      );
      if (!free) return;
      try {
        socket.destroy();
      } catch {
        /* 已由其它路径关闭 */
      }
    }, this.idleSocketMs);
    // 空闲计时器不阻止进程退出；下一次请求仍复用，超时后才关闭。
    timer.unref?.();
    this.idleTimers.set(socket, timer);
  }

  #destroyAgent() {
    const agent = this.agent;
    this.agent = null;
    this.agentKey = null;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    if (!agent) return;
    try {
      agent.destroy();
    } catch {
      /* 已销毁 */
    }
  }

  async #applySession(data, epoch, operation = null) {
    this.#assertOperation(operation);
    if (epoch !== this.epoch) throw this.#staleError();
    if (!data || typeof data.accessToken !== "string" || typeof data.refreshToken !== "string")
      throw new CloudAuthError("云端认证响应缺少令牌字段", { kind: "cloud" });
    const expiresIn = Number(data.expiresIn);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0)
      throw new CloudAuthError("云端认证响应缺少有效的 expiresIn", { kind: "cloud" });
    // 原子替换刷新令牌（SecretStore.set 内部事务 + 回读校验）
    await this.secrets.set(REFRESH_SECRET, data.refreshToken);
    this.#assertOperation(operation);
    if (epoch !== this.epoch) {
      // 迟到响应不能把旧凭据写进新上下文；只删除仍属于本次响应的值
      if (this.secrets.get(REFRESH_SECRET) === data.refreshToken) this.secrets.remove(REFRESH_SECRET);
      throw this.#staleError();
    }
    this.accessToken = data.accessToken;
    this.accessExpiresAt = this.clock() + expiresIn * 1000;
    this.state = {
      ...this.state,
      refreshing: false,
      state: "logged-in",
      lastError: null,
      retryAt: 0,
      retryAfterMs: 0,
      accessExpiresAt: nowIso(this.accessExpiresAt),
      refreshExpiresAt: data.refreshExpiresAt || this.state.refreshExpiresAt || null,
    };
    await this.#persistState();
  }

  async #refreshProfile(epoch, operation = null) {
    const profile = await this.me();
    this.#assertOperation(operation);
    if (epoch !== this.epoch) throw this.#staleError();
    this.state = {
      ...this.state,
      username: profile?.username || this.state.username || null,
      displayName: profile?.displayName || null,
      accountId: profile?.accountId || null,
      deviceId: profile?.deviceId || null,
      sessionId: profile?.sessionId || null,
      superAdmin: profile?.superAdmin === true,
      state: "logged-in",
    };
    await this.#persistState();
  }

  async #clear(stateName, publicError = null, epoch = null) {
    if (epoch !== null && epoch !== this.epoch) throw this.#staleError();
    this.#invalidate();
    this.secrets.remove(REFRESH_SECRET);
    this.accessToken = null;
    this.accessExpiresAt = 0;
    this.state = {
      ...this.state,
      state: stateName,
      refreshing: false,
      username: null,
      displayName: null,
      accountId: null,
      deviceId: null,
      sessionId: null,
      superAdmin: false,
      lastError: publicError || null,
      retryAt: 0,
      retryAfterMs: 0,
    };
    await this.#persistState();
  }

  async #patchState(patch, epoch = null) {
    if (epoch !== null && epoch !== this.epoch) throw this.#staleError();
    this.state = { ...this.state, ...patch };
    await this.#persistState();
  }

  #persistState() {
    const write = async () => {
      const out = { ...this.state };
      delete out._;
      await this.#writeJson(this.statePath, out);
    };
    this.persistChain = this.persistChain.then(write, write);
    return this.persistChain;
  }

  async #readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw new CloudAuthError("本地云端配置文件无法读取", { kind: "config", code: "STORAGE_ERROR", cause: e });
    }
  }

  async #writeJson(file, value) {
    const dir = path.dirname(file);
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      await fs.mkdir(dir, { recursive: true });
      const handle = await fs.open(tmp, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new CloudAuthError("本地云端配置保存失败", { kind: "config", code: "STORAGE_ERROR", cause: e });
    }
  }
}

/** 云端认证路由的末端错误边界：所有异常都收敛为固定公开码，绝不透传原始 message/本机路径 */
export function cloudAuthErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const isCloud = error instanceof CloudAuthError;
  const pub = isCloud
    ? error.toPublic()
    : { code: "INTERNAL", kind: "internal", status: null, requestId: null, retryAfterMs: 0, message: PUBLIC_MESSAGES.internal };
  if (!isCloud) console.error("[cloud-auth] INTERNAL");
  else if (pub.status !== 401 && pub.status !== 429) console.error(`[cloud-auth] ${pub.code}`);
  const status = [400, 401, 403, 404, 409, 413, 429, 503].includes(pub.status) ? pub.status : 400;
  if (pub.retryAfterMs > 0) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(pub.retryAfterMs / 1000))));
  res.status(status).json({
    error: pub.message,
    code: pub.code,
    kind: pub.kind,
    ...(pub.retryAfterMs > 0 ? { retryAfterMs: pub.retryAfterMs } : {}),
    ...(pub.requestId ? { requestId: pub.requestId } : {}),
  });
}

function safeCode(value) {
  const code = typeof value === "string" ? value : String(value || "");
  return /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "UNKNOWN";
}

function safeRequestId(value) {
  const id = typeof value === "string" ? value : "";
  return /^[A-Za-z0-9._:-]{1,64}$/.test(id) ? id : null;
}

function safeHost(origin) {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}
