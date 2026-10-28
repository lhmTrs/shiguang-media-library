/**
 * 云端账户 / 小组 / 授权管理适配（T-LOCAL-008）。
 *
 * 边界（`拾光云端后台/docs/{MANAGEMENT,GROUP,AUTHORIZATION,AUTH}-API.md`）：
 *   - 浏览器只调用本文件的固定本地路由；Node 用固定方法 + 固定路径模板 + 参数白名单
 *     访问云端，浏览器不能提交任意 origin/path/header，Node 不是开放代理。
 *   - mTLS 客户端证书、Bearer、刷新令牌只在 Node；响应 DTO 在这里逐字段收敛，
 *     不把云 JWT、私钥、密码哈希或无关字段透给浏览器。
 *   - 一次性开通码/重置码是唯一明确允许回浏览器的敏感字段，不写本地文件/日志/存储。
 *   - 401 清本地会话；409 原样上报版本冲突，绝不静默覆盖；写请求不自动重试。
 */
import crypto from "node:crypto";
import { CloudAuthError } from "./cloud-auth.mjs";
import { strictJson } from "./cloud-upload-task-router.mjs";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const ROLE_CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const STATE_RE = /^(PENDING|ACTIVE|DISABLED)$/;
const SCOPE_RE = /^(SYSTEM|GROUP)$/;
const MAX_PAGE = 100;

const PUBLIC_MESSAGES = {
  INVALID_REQUEST: "请求参数不合法",
  UNAUTHORIZED: "登录状态无效或凭据已失效",
  FORBIDDEN: "没有执行该操作的权限",
  NOT_FOUND: "资源不存在或对当前账户不可见",
  VERSION_CONFLICT: "数据已被其他人更新，请重新读取后再操作",
  IDEMPOTENCY_CONFLICT: "重复请求与原请求参数不一致",
  LEADER_TRANSFER_REQUIRED: "目标账户仍是小组负责人，请先交接",
  GROUP_NEEDS_LEADER: "小组暂无有效负责人，请先指定负责人",
  GROUP_NOT_ACTIVE: "小组当前不是启用状态",
  ROLE_EXISTS: "角色编码已存在",
  ACCOUNT_EXISTS: "用户名已存在",
  DEVICE_LIMIT: "该账户设备数量已达上限",
  INVALID_GROUP: "小组参数不合法",
  INVALID_AUTHORIZATION: "角色或授权范围不合法",
  RATE_LIMITED: "请求过于频繁，请稍后再试",
  STALE: "操作已被更新的请求取代，请重试",
  NOT_LOGGED_IN: "尚未登录云端账户",
  RESPONSE_INVALID: "云端响应格式不符合约定",
  CERT_INVALID: "设备证书或云端 CA 校验失败",
  REQUEST_TIMEOUT: "云端请求超时",
  CLOUD_ERROR: "云端管理请求未完成",
};

export class CloudManagementError extends Error {
  constructor(code, status, message = null, { retryAfterMs = 0, requestId = null } = {}) {
    super(message || PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.CLOUD_ERROR);
    this.name = "CloudManagementError";
    this.code = /^[A-Z][A-Z0-9_]{1,63}$/.test(String(code || "")) ? code : "CLOUD_ERROR";
    this.message = message || PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.CLOUD_ERROR;
    this.status = status;
    this.retryAfterMs = Math.max(0, Number(retryAfterMs) || 0);
    this.requestId = requestId;
  }
  toPublic() {
    return {
      error: this.message,
      code: this.code,
      ...(this.status ? { status: this.status } : {}),
      ...(this.retryAfterMs > 0 ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

const invalid = (message = null) => {
  throw new CloudManagementError("INVALID_REQUEST", 400, message);
};

function text(value, { min = 1, max = 128, trim = true, name = "字段" } = {}) {
  if (typeof value !== "string") invalid(`${name}必须是字符串`);
  const out = trim ? value.trim() : value;
  if (out.length < min || out.length > max) invalid(`${name}长度不合法`);
  return out;
}

function integer(value, { min = 0, max = Number.MAX_SAFE_INTEGER, name = "字段" } = {}) {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) invalid(`${name}不合法`);
  return n;
}

function bool(value, name = "字段") {
  if (typeof value !== "boolean") invalid(`${name}必须是布尔值`);
  return value;
}

function id(value, name = "ID") {
  if (typeof value !== "string" || !ID_RE.test(value)) invalid(`${name}不合法`);
  return value;
}

function page(query = {}) {
  const limit = query.limit === undefined ? 50 : integer(Number(query.limit), { min: 1, max: MAX_PAGE, name: "limit" });
  const offset = query.offset === undefined ? 0 : integer(Number(query.offset), { min: 0, name: "offset" });
  return { limit, offset };
}

function bodyOf(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid("包含未知字段");
  return value;
}

function username(value) {
  const out = text(value, { min: 3, max: 64, name: "用户名" }).toLowerCase();
  if (!USERNAME_RE.test(out)) invalid("用户名格式不合法");
  return out;
}

function password(value, name = "密码") {
  if (typeof value !== "string") invalid(`${name}必须是字符串`);
  if (value.length < 12 || Buffer.byteLength(value, "utf8") > 72) invalid(`${name}不符合长度策略`);
  return value;
}

function permissions(value) {
  if (!Array.isArray(value) || value.length > 100) invalid("权限列表不合法");
  const out = [...new Set(value.map((v) => text(v, { min: 1, max: 64, name: "权限" })))].sort();
  return out;
}

const qs = (query) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};

// ── DTO 收敛：只保留契约字段，任何未知/多余字段都丢掉 ──────────────────
const s = (v) => (typeof v === "string" ? v : null);
const n = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const arr = (v) => (Array.isArray(v) ? v : []);

function sanitizeMe(v) {
  if (!v || typeof v !== "object") throw invalidResponse();
  return {
    accountId: s(v.accountId),
    username: s(v.username),
    displayName: s(v.displayName),
    deviceId: s(v.deviceId),
    sessionId: s(v.sessionId),
    superAdmin: v.superAdmin === true,
  };
}

function sanitizeDevice(v) {
  return {
    id: s(v?.id),
    name: s(v?.name),
    state: s(v?.state),
    certificateExpiresAt: s(v?.certificateExpiresAt),
    createdAt: s(v?.createdAt),
    lastSeenAt: s(v?.lastSeenAt),
  };
}

function sanitizeGroup(v) {
  return {
    id: s(v?.id),
    name: s(v?.name),
    leaderAccountId: s(v?.leaderAccountId),
    state: s(v?.state),
    version: n(v?.version),
  };
}

function sanitizeMember(v) {
  return { accountId: s(v?.accountId), state: s(v?.state) };
}

function sanitizeProfile(v) {
  return {
    accountId: s(v?.accountId),
    username: s(v?.username),
    displayName: s(v?.displayName),
    memberState: s(v?.memberState),
    accountState: s(v?.accountState),
  };
}

function sanitizeAccount(v) {
  return {
    id: s(v?.id),
    username: s(v?.username),
    displayName: s(v?.displayName),
    state: s(v?.state),
    securityVersion: n(v?.securityVersion),
    createdAt: s(v?.createdAt),
    superAdmin: v?.superAdmin === true,
  };
}

function sanitizePermission(v) {
  return {
    code: s(v?.code),
    scopeType: s(v?.scopeType),
    customAssignable: v?.customAssignable === true,
  };
}

function sanitizeRole(v) {
  return {
    id: s(v?.id),
    code: s(v?.code),
    name: s(v?.name),
    scopeType: s(v?.scopeType),
    builtIn: v?.builtIn === true,
    version: n(v?.version),
  };
}

function sanitizeRoleView(v) {
  return { role: sanitizeRole(v?.role), permissions: arr(v?.permissions).map(s).filter(Boolean) };
}

function sanitizeAssignment(v) {
  return {
    id: s(v?.id),
    accountId: s(v?.accountId),
    roleId: s(v?.roleId),
    scopeType: s(v?.scopeType),
    scopeKey: s(v?.scopeKey),
    groupId: s(v?.groupId),
    grantedBy: s(v?.grantedBy),
  };
}

function sanitizeImpact(v) {
  return {
    totalAssignments: n(v?.totalAssignments),
    assignments: arr(v?.assignments).map(sanitizeAssignment),
    limit: n(v?.limit),
    offset: n(v?.offset),
    hasMore: v?.hasMore === true,
  };
}

function sanitizeAudit(v) {
  return {
    id: s(v?.id),
    actorAccountId: s(v?.actorAccountId),
    eventType: s(v?.eventType),
    targetId: s(v?.targetId),
    createdAt: s(v?.createdAt),
  };
}

function sanitizeOpening(v) {
  return {
    id: s(v?.id),
    accountId: s(v?.accountId),
    username: s(v?.username),
    openingCode: s(v?.openingCode),
    expiresAt: s(v?.expiresAt),
  };
}

function sanitizeReset(v) {
  return {
    resetToken: s(v?.resetToken),
    accountId: s(v?.accountId),
    expiresAt: s(v?.expiresAt),
  };
}

function sanitizeCandidate(v) {
  return { id: s(v?.id), username: s(v?.username), displayName: s(v?.displayName) };
}

function sanitizeCapabilities(v) {
  if (!v || typeof v !== "object") throw invalidResponse();
  return {
    superAdmin: v.superAdmin === true,
    systemPermissions: arr(v.systemPermissions).map(s).filter(Boolean),
    groups: arr(v.groups).map((g) => ({
      groupId: s(g?.groupId),
      name: s(g?.name),
      state: s(g?.state),
      leader: g?.leader === true,
      canReadShared: g?.canReadShared === true,
      permissions: arr(g?.permissions).map(s).filter(Boolean),
    })),
  };
}

const invalidResponse = () => {
  throw new CloudManagementError("RESPONSE_INVALID", 400);
};

function sanitizePage(v, item) {
  if (!v || typeof v !== "object" || !Array.isArray(v.items)) throw invalidResponse();
  return {
    items: v.items.map(item),
    total: n(v.total),
    limit: n(v.limit),
    offset: n(v.offset),
  };
}

function list(v, item) {
  if (!Array.isArray(v)) throw invalidResponse();
  return v.map(item);
}

function sanitizeScalar(v) {
  if (v !== null && typeof v !== "object") return v;
  return null;
}

function sanitizeUploadApprovalSettings(v) {
  if (!v || !Number.isSafeInteger(v.thresholdMb) || v.thresholdMb < 1 ||
      !Number.isSafeInteger(v.thresholdBytes) || v.thresholdBytes !== v.thresholdMb * 1_000_000 ||
      !Number.isSafeInteger(v.version) || v.version < 0 || typeof v.configured !== "boolean") throw invalidResponse();
  return { thresholdMb: v.thresholdMb, thresholdBytes: v.thresholdBytes, version: v.version, configured: v.configured };
}

// Maintenance has a deliberately narrower input contract than other management APIs.
const MAINTENANCE_UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAINTENANCE_HASH = /^[a-f0-9]{64}$/;
const MAINTENANCE_STATES = new Set(["PLANNED", "BOUND", "NEEDS_RECHECK", "ENABLED"]);
const maintenanceUuid = v => { if (typeof v !== "string" || !MAINTENANCE_UUID.test(v)) invalid(); return v; };
const maintenanceHash = v => { if (typeof v !== "string" || !MAINTENANCE_HASH.test(v)) invalid(); return v; };
const maintenanceNumber = v => integer(v, { max: Number.MAX_SAFE_INTEGER - 1 });
function maintenanceBody(value, keys) {
  bodyOf(value, keys);
  if (Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k)) || Buffer.byteLength(JSON.stringify(value), "utf8") > 4096) invalid();
  return value;
}
export async function readAudioMaintenanceRequest(req, { write } = {}) {
  if (req.originalUrl.includes("?") || req.headers["transfer-encoding"] !== undefined || req.headers["content-encoding"] !== undefined) invalid();
  const length = req.headers["content-length"];
  if (!write) {
    if (length !== undefined && length !== "0") invalid();
    return null;
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] || "") || typeof length !== "string" || !/^[1-9][0-9]*$/.test(length)) invalid();
  const size = Number(length);
  if (!Number.isSafeInteger(size) || size > 4096) throw new CloudManagementError("INVALID_REQUEST", 413);
  const raw = await new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    const cleanup = () => { clearTimeout(timer); req.off("data", data); req.off("end", end); req.off("error", failed); req.off("aborted", failed); };
    const failed = () => { cleanup(); reject(new CloudManagementError("INVALID_REQUEST", 400)); };
    const data = chunk => { bytes += chunk.length; if (bytes > size || bytes > 4096) { failed(); req.destroy(); } else chunks.push(chunk); };
    const end = () => { cleanup(); bytes === size ? resolve(Buffer.concat(chunks)) : reject(new CloudManagementError("INVALID_REQUEST", 400)); };
    const timer = setTimeout(() => { failed(); req.destroy(); }, 10000);
    req.on("data", data); req.once("end", end); req.once("error", failed); req.once("aborted", failed);
  });
  try { return strictJson(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { invalid(); }
}
function sanitizeAudioMaintenance(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  try {
    const v = value;
    const result = { runId: maintenanceUuid(v.runId), operationId: maintenanceUuid(v.operationId), manifestFingerprint: maintenanceHash(v.manifestFingerprint), state: v.state,
      expiresAt: text(v.expiresAt, { max: 64, trim: false }), objects: maintenanceNumber(v.objects), bytes: maintenanceNumber(v.bytes), receipt: null };
    if (!MAINTENANCE_STATES.has(v.state) || !Number.isFinite(Date.parse(v.expiresAt))) throw invalidResponse();
    if (v.state !== "ENABLED") { if (v.receipt !== null) throw invalidResponse(); }
    else {
      const r = v.receipt;
      if (!r || typeof r !== "object" || Array.isArray(r) || r.runId !== result.runId || r.manifestFingerprint !== result.manifestFingerprint || r.objects !== result.objects || r.verifiedBytes !== result.bytes || r.writeMode !== "READY" || r.storageState !== "READY" || typeof r.adoptedAt !== "string" || r.adoptedAt.length > 64 || !Number.isFinite(Date.parse(r.adoptedAt))) throw invalidResponse();
      result.receipt = { runId: result.runId, manifestFingerprint: result.manifestFingerprint, objects: result.objects, verifiedBytes: result.bytes,
        protocolVersion: maintenanceNumber(r.protocolVersion), reconciliationVersion: maintenanceNumber(r.reconciliationVersion), writeMode: "READY", storageState: "READY", adoptedAt: r.adoptedAt };
    }
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 4096) throw invalidResponse();
    return result;
  } catch { throw invalidResponse(); }
}

// ── 固定路由表：方法 + 路径模板 + 返回 DTO ──────────────────────────────
const ROUTES = {
  audioMaintenancePlan: { method: "POST", path: () => "/system/audio-maintenance/plan", parse: sanitizeAudioMaintenance },
  audioMaintenanceApply: { method: "POST", path: ({ id }) => `/system/audio-maintenance/runs/${id}/apply`, parse: sanitizeAudioMaintenance },
  audioMaintenanceStatus: { method: "GET", path: ({ id }) => `/system/audio-maintenance/runs/${id}`, parse: sanitizeAudioMaintenance },
  uploadApprovalSettings: { method: "GET", path: () => "/system/upload-approval-settings", parse: sanitizeUploadApprovalSettings },
  updateUploadApprovalSettings: { method: "PUT", path: () => "/system/upload-approval-settings", parse: sanitizeUploadApprovalSettings },
  me: { method: "GET", path: () => "/me", parse: sanitizeMe },
  devices: { method: "GET", path: () => "/me/devices", parse: (v) => list(v, sanitizeDevice) },
  revokeDevice: { method: "DELETE", path: ({ id }) => `/me/devices/${id}`, parse: sanitizeScalar },
  changePassword: { method: "POST", path: () => "/me/password", parse: sanitizeScalar },
  resetPassword: { method: "POST", path: () => "/auth/reset-password", auth: false, parse: sanitizeScalar },
  capabilities: { method: "GET", path: () => "/me/capabilities", parse: sanitizeCapabilities },
  groups: { method: "GET", path: ({ query }) => `/groups${qs(query)}`, parse: (v) => list(v, sanitizeGroup) },
  group: { method: "GET", path: ({ id }) => `/groups/${id}`, parse: sanitizeGroup },
  groupMembers: {
    method: "GET",
    path: ({ id, query }) => `/groups/${id}/members${qs(query)}`,
    parse: (v) => list(v, sanitizeMember),
  },
  groupProfiles: {
    method: "GET",
    path: ({ id, query }) => `/groups/${id}/member-profiles${qs(query)}`,
    parse: (v) => list(v, sanitizeProfile),
  },
  createGroup: { method: "POST", path: () => "/groups", parse: sanitizeGroup },
  renameGroup: { method: "PUT", path: ({ id }) => `/groups/${id}`, parse: sanitizeGroup },
  addGroupMember: { method: "POST", path: ({ id }) => `/groups/${id}/members`, parse: sanitizeGroup },
  removeGroupMember: {
    method: "DELETE",
    path: ({ id, accountId }) => `/groups/${id}/members/${accountId}`,
    parse: sanitizeGroup,
  },
  leaveGroup: { method: "POST", path: ({ id }) => `/groups/${id}/leave`, parse: sanitizeGroup },
  transferLeader: { method: "POST", path: ({ id }) => `/groups/${id}/leader-transfers`, parse: sanitizeGroup },
  groupState: { method: "POST", path: ({ id }) => `/groups/${id}/state`, parse: sanitizeGroup },
  accounts: {
    method: "GET",
    path: ({ query }) => `/accounts${qs(query)}`,
    parse: (v) => sanitizePage(v, sanitizeAccount),
  },
  account: { method: "GET", path: ({ id }) => `/accounts/${id}`, parse: sanitizeAccount },
  accountDevices: { method: "GET", path: ({ id, query }) => `/accounts/${id}/devices${qs(query)}`, parse: (v) => sanitizePage(v, sanitizeDevice) },
  revokeAccountDevice: { method: "POST", path: ({ id, accountId }) => `/accounts/${accountId}/devices/${id}/revoke`, parse: sanitizeScalar },
  createAccount: { method: "POST", path: () => "/accounts", parse: sanitizeOpening },
  openingCode: { method: "POST", path: ({ id }) => `/accounts/${id}/device-opening-codes`, parse: sanitizeOpening },
  revokeOpeningCode: { method: "DELETE", path: ({ id }) => `/device-opening-codes/${id}`, parse: sanitizeScalar },
  accountState: { method: "POST", path: ({ id }) => `/accounts/${id}/state`, parse: sanitizeScalar },
  passwordReset: { method: "POST", path: ({ id }) => `/accounts/${id}/password-resets`, parse: sanitizeReset },
  candidates: { method: "GET", path: ({ query }) => `/account-candidates${qs(query)}`, parse: (v) => list(v, sanitizeCandidate) },
  permissions: { method: "GET", path: () => "/permissions", parse: (v) => list(v, sanitizePermission) },
  roles: { method: "GET", path: ({ query }) => `/roles${qs(query)}`, parse: (v) => list(v, sanitizeRoleView) },
  roleImpact: {
    method: "GET",
    path: ({ id, query }) => `/roles/${id}/impact${qs(query)}`,
    parse: sanitizeImpact,
  },
  createRole: { method: "POST", path: () => "/roles", parse: sanitizeRoleView },
  updateRole: { method: "PUT", path: ({ id }) => `/roles/${id}/permissions`, parse: sanitizeRoleView },
  roleAssignments: {
    method: "GET",
    path: ({ id, query }) => `/accounts/${id}/role-assignments${qs(query)}`,
    parse: (v) => sanitizePage(v, sanitizeAssignment),
  },
  assignRole: { method: "POST", path: () => "/role-assignments", parse: sanitizeAssignment },
  revokeRole: { method: "DELETE", path: ({ id }) => `/role-assignments/${id}`, parse: sanitizeScalar },
  auditEvents: {
    method: "GET",
    path: ({ query }) => `/audit-events${qs(query)}`,
    parse: (v) => sanitizePage(v, sanitizeAudit),
  },
};

function mapCloudError(error) {
  if (error instanceof CloudManagementError) return error;
  if (!(error instanceof CloudAuthError)) return new CloudManagementError("CLOUD_ERROR", 400);
  const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
    ? error.code
    : "CLOUD_ERROR";
  const status = code === "NOT_LOGGED_IN"
    ? 401
    : [400, 401, 403, 404, 409, 413, 429, 503].includes(Number(error.status))
      ? Number(error.status)
      : 400;
  return new CloudManagementError(code, status, null, {
    retryAfterMs: error.retryAfterMs,
    requestId: /^[A-Za-z0-9._:-]{1,64}$/.test(String(error.requestId || "")) ? error.requestId : null,
  });
}

export class CloudManagement {
  constructor(lib, { cloudAuth } = {}) {
    if (!cloudAuth) throw new Error("CloudManagement 需要 CloudAuth");
    this.lib = lib;
    this.cloudAuth = cloudAuth;
    /** 写操作串行：避免双击/重复提交在本地并发，云端仍以版本号为准 */
    this.writeChain = Promise.resolve();
  }

  /**
   * 写操作在**入队时**绑定认证代次；真正开始执行前再核对一次。
   * 仅靠 #call 执行时读取 epoch 会让旧身份的排队写在新登录后拿到新 Bearer。
   */
  #write(task) {
    const epoch = this.cloudAuth.epoch;
    const start = () => {
      if (this.cloudAuth.epoch !== epoch) throw new CloudManagementError("STALE", 409);
      return task(epoch);
    };
    const run = this.writeChain.then(start, start);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 写操作成功后的清会话只允许作用于它自己绑定的那个代次。 */
  async #forgetBound(epoch, reason) {
    if (this.cloudAuth.epoch !== epoch) throw new CloudManagementError("STALE", 409);
    const state = await this.cloudAuth.forgetSession(reason, { epoch });
    if (state.state === "logged-in") throw new CloudManagementError("STALE", 409);
    return state;
  }

  async #call(routeName, { id: routeId = null, accountId = null, query = null, body = null, epoch = null } = {}) {
    const route = ROUTES[routeName];
    if (!route) throw new CloudManagementError("INVALID_REQUEST", 400);
    // 写操作把入队代次传进来；读操作则在发起时绑定。两种情况都由此处固定，
    // 不能等到 proxy 内部再取“最新”身份。
    const bound = epoch ?? this.cloudAuth.epoch;
    if (this.cloudAuth.epoch !== bound) throw new CloudManagementError("STALE", 409);
    let raw;
    try {
      raw = await this.cloudAuth.proxy(route.method, route.path({ id: routeId, accountId, query }), {
        body,
        bearer: route.auth !== false,
        epoch: bound,
      });
    } catch (error) {
      // 401 时只清掉"发起这次请求时"的会话；用户已经开始的新登录不能被旧响应清掉。
      if (error?.status === 401 && route.auth !== false && this.cloudAuth.epoch === bound) {
        await this.cloudAuth
          .forgetSession({ code: "UNAUTHORIZED", kind: "auth", message: "登录状态失效" }, { epoch: bound })
          .catch(() => undefined);
      }
      const mapped = mapCloudError(error);
      // 一侧 401 已经清掉会话后，同一批并发请求的 STALE 也统一收敛为"需重新登录"。
      if (mapped.code === "STALE" && this.cloudAuth.getState().state !== "logged-in")
        throw new CloudManagementError("UNAUTHORIZED", 401);
      throw mapped;
    }
    // 退出/换账户/换配置后，迟到的成功响应也不能进入新账户页面。
    if (this.cloudAuth.epoch !== bound) {
      if (this.cloudAuth.getState().state !== "logged-in")
        throw new CloudManagementError("UNAUTHORIZED", 401);
      throw new CloudManagementError("STALE", 409);
    }
    try {
      return route.parse(raw);
    } catch (error) {
      throw error instanceof CloudManagementError ? error : new CloudManagementError("RESPONSE_INVALID", 400);
    }
  }

  #maintenanceActor(value) {
    const state = this.cloudAuth.getState();
    const fields = [state.originHost, state.accountId, state.deviceId, state.sessionId];
    if (typeof value !== "string" || !MAINTENANCE_HASH.test(value) || state.state !== "logged-in" || fields.some(x => typeof x !== "string" || !x || x.length > 512) || value !== crypto.createHash("sha256").update(JSON.stringify(fields), "utf8").digest("hex")) throw new CloudManagementError("STALE", 409);
  }
  async planAudioMaintenance(payload) {
    const v = maintenanceBody(payload, ["operationId", "expectedProtocolVersion", "expectedStorageVersion", "clientIdentity"]);
    const actor = v.clientIdentity; this.#maintenanceActor(actor);
    const body = { operationId: maintenanceUuid(v.operationId), expectedProtocolVersion: maintenanceNumber(v.expectedProtocolVersion), expectedStorageVersion: maintenanceNumber(v.expectedStorageVersion) };
    return this.#write(async epoch => {
      this.#maintenanceActor(actor);
      const result = await this.#call("audioMaintenancePlan", { body, epoch });
      this.#maintenanceActor(actor);
      if (result.operationId !== body.operationId) throw invalidResponse();
      return result;
    });
  }
  async applyAudioMaintenance(runId, payload) {
    const value = maintenanceUuid(runId), v = maintenanceBody(payload, ["operationId", "manifestFingerprint", "recoverBound", "clientIdentity"]);
    const actor = v.clientIdentity; this.#maintenanceActor(actor);
    const body = { operationId: maintenanceUuid(v.operationId), manifestFingerprint: maintenanceHash(v.manifestFingerprint), recoverBound: bool(v.recoverBound) };
    return this.#write(async epoch => {
      this.#maintenanceActor(actor);
      const result = await this.#call("audioMaintenanceApply", { id: value, body, epoch });
      this.#maintenanceActor(actor);
      if (result.runId !== value || result.operationId !== body.operationId || result.manifestFingerprint !== body.manifestFingerprint) throw invalidResponse();
      return result;
    });
  }
  async audioMaintenanceStatus(runId, clientIdentity) {
    this.#maintenanceActor(clientIdentity);
    const value = maintenanceUuid(runId), result = await this.#call("audioMaintenanceStatus", { id: value });
    this.#maintenanceActor(clientIdentity);
    if (result.runId !== value) throw invalidResponse();
    return result;
  }

  // ── 个人安全 ────────────────────────────────────────────────
  async profile() {
    const [me, capabilities, devices] = await Promise.all([
      this.#call("me"),
      this.#call("capabilities"),
      this.#call("devices"),
    ]);
    return { me, capabilities, devices };
  }

  async revokeDevice(value) {
    const deviceId = id(value, "设备 ID");
    return this.#write(async (epoch) => {
      await this.#call("revokeDevice", { id: deviceId, epoch });
      if (this.cloudAuth.getState().deviceId === deviceId) {
        const state = await this.#forgetBound(epoch, {
          code: "UNAUTHORIZED",
          kind: "auth",
          message: "当前设备已撤销",
        });
        return { revoked: true, signedOut: true, state };
      }
      return { revoked: true, signedOut: false };
    });
  }

  async changePassword(payload) {
    const body = bodyOf(payload, ["currentPassword", "newPassword"]);
    const currentPassword = text(body.currentPassword, { min: 1, max: 128, trim: false, name: "当前密码" });
    const newPassword = password(body.newPassword, "新密码");
    return this.#write(async (epoch) => {
      await this.#call("changePassword", { body: { currentPassword, newPassword }, epoch });
      const state = await this.#forgetBound(epoch, {
        code: "UNAUTHORIZED",
        kind: "auth",
        message: "密码已修改",
      });
      return { changed: true, state };
    });
  }

  /** 忘记密码：mTLS 业务端口，不带 Bearer；成功后本地旧会话一并清除。 */
  async resetPassword(payload) {
    const body = bodyOf(payload, ["resetToken", "newPassword"]);
    if (typeof body.resetToken !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(body.resetToken.trim()))
      invalid("重置码格式不合法");
    const resetToken = body.resetToken.trim();
    const newPassword = password(body.newPassword, "新密码");
    return this.#write(async (epoch) => {
      await this.#call("resetPassword", { body: { resetToken, newPassword }, epoch });
      const state = await this.#forgetBound(epoch, {
        code: "UNAUTHORIZED",
        kind: "auth",
        message: "密码已重置",
      });
      return { reset: true, state };
    });
  }

  // ── 小组 ────────────────────────────────────────────────────
  async groups({ management = false, ...query } = {}) {
    const { limit, offset } = page(query);
    // 本地 query 是字符串；只接受明确的 true，不做任意真值转换。
    const managed = management === true || management === "true";
    return this.#call("groups", {
      query: { limit, offset, ...(managed ? { management: "true" } : {}) },
    });
  }

  async group(value) {
    return this.#call("group", { id: id(value, "小组 ID") });
  }

  async members(groupId, query = {}) {
    const gid = id(groupId, "小组 ID");
    const { limit, offset } = page(query);
    const [members, profiles] = await Promise.all([
      this.#call("groupMembers", { id: gid, query: { limit, offset } }),
      // member-profiles 失败不阻断成员列表，只是显示 ID；旧 members 契约仍可用。
      this.#call("groupProfiles", { id: gid, query: { limit, offset } }).catch((error) => {
        if (error?.code === "FORBIDDEN" || error?.code === "NOT_FOUND") return [];
        throw error;
      }),
    ]);
    const byId = new Map(profiles.map((p) => [p.accountId, p]));
    return members.map((m) => {
      const p = byId.get(m.accountId);
      return {
        accountId: m.accountId,
        state: m.state,
        username: p?.username ?? null,
        displayName: p?.displayName ?? null,
        memberState: p?.memberState ?? m.state,
        accountState: p?.accountState ?? null,
      };
    });
  }

  async createGroup(payload) {
    const body = bodyOf(payload, ["name", "initialLeaderAccountId", "requestId"]);
    const name = text(body.name, { min: 1, max: 128, name: "小组名称" });
    const initialLeaderAccountId = id(body.initialLeaderAccountId, "初始组长");
    if (typeof body.requestId !== "string" || !/^[0-9a-fA-F-]{36}$/.test(body.requestId)) invalid("requestId 不合法");
    const requestId = body.requestId.toLowerCase();
    return this.#write((epoch) =>
      this.#call("createGroup", { body: { name, initialLeaderAccountId, requestId }, epoch }),
    );
  }

  async renameGroup(groupId, payload) {
    const gid = id(groupId, "小组 ID");
    const body = bodyOf(payload, ["name", "expectedVersion"]);
    const name = text(body.name, { min: 1, max: 128, name: "小组名称" });
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    return this.#write((epoch) => this.#call("renameGroup", { id: gid, body: { name, expectedVersion }, epoch }));
  }

  async addMember(groupId, payload) {
    const gid = id(groupId, "小组 ID");
    const body = bodyOf(payload, ["accountId", "expectedVersion"]);
    const accountId = id(body.accountId, "账户 ID");
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    return this.#write((epoch) =>
      this.#call("addGroupMember", { id: gid, body: { accountId, expectedVersion }, epoch }),
    );
  }

  async removeMember(groupId, accountId, payload) {
    const gid = id(groupId, "小组 ID");
    const target = id(accountId, "账户 ID");
    const body = bodyOf(payload, ["expectedVersion"]);
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    return this.#write((epoch) =>
      this.#call("removeGroupMember", { id: gid, accountId: target, body: { expectedVersion }, epoch }),
    );
  }

  async leaveGroup(groupId, payload) {
    const gid = id(groupId, "小组 ID");
    const body = bodyOf(payload, ["expectedVersion"]);
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    return this.#write((epoch) => this.#call("leaveGroup", { id: gid, body: { expectedVersion }, epoch }));
  }

  async transferLeader(groupId, payload) {
    const gid = id(groupId, "小组 ID");
    const body = bodyOf(payload, ["accountId", "expectedVersion"]);
    const accountId = id(body.accountId, "账户 ID");
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    return this.#write((epoch) =>
      this.#call("transferLeader", { id: gid, body: { accountId, expectedVersion }, epoch }),
    );
  }

  async setGroupState(groupId, payload) {
    const gid = id(groupId, "小组 ID");
    const body = bodyOf(payload, ["enabled", "expectedVersion"]);
    const enabled = bool(body.enabled, "enabled");
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    return this.#write((epoch) =>
      this.#call("groupState", { id: gid, body: { enabled, expectedVersion }, epoch }),
    );
  }

  // ── 账户 ────────────────────────────────────────────────────
  async accounts(query = {}) {
    const { limit, offset } = page(query);
    const q = query.query === undefined || query.query === null ? "" : text(query.query, { min: 0, max: 128, name: "搜索" });
    const state = query.state === undefined || query.state === null || query.state === "" ? "" : String(query.state);
    if (state && !STATE_RE.test(state)) invalid("state 不合法");
    return this.#call("accounts", { query: { limit, offset, ...(q ? { query: q } : {}), ...(state ? { state } : {}) } });
  }

  async account(value) {
    return this.#call("account", { id: id(value, "账户 ID") });
  }

  async accountDevices(accountId, query = {}) {
    const target = id(accountId, "账户 ID");
    const params = page(query);
    const deviceId = query.deviceId ? id(query.deviceId, "设备 ID") : "";
    return this.#call("accountDevices", { id: target, query: { ...params, deviceId } });
  }

  async revokeAccountDevice(accountId, deviceId, payload) {
    const target = id(accountId, "账户 ID");
    const device = id(deviceId, "设备 ID");
    const body = bodyOf(payload, ["expectedSecurityVersion", "expectedState", "currentPassword"]);
    const expectedSecurityVersion = integer(body.expectedSecurityVersion);
    if (!["PENDING", "ACTIVE", "REVOKED"].includes(body.expectedState)) invalid();
    const currentPassword = text(body.currentPassword, { min: 1, max: 128, trim: false, name: "管理员密码" });
    if (Buffer.byteLength(currentPassword, "utf8") > 72) invalid();
    return this.#write(epoch => this.#call("revokeAccountDevice", {
      id: device, accountId: target, epoch,
      body: { expectedSecurityVersion, expectedState: body.expectedState, currentPassword },
    }));
  }

  async createAccount(payload) {
    const body = bodyOf(payload, ["username", "displayName"]);
    const user = username(body.username);
    const displayName = text(body.displayName, { min: 1, max: 128, name: "显示名" });
    return this.#write((epoch) => this.#call("createAccount", { body: { username: user, displayName }, epoch }));
  }

  async issueOpeningCode(accountId) {
    const target = id(accountId, "账户 ID");
    return this.#write((epoch) => this.#call("openingCode", { id: target, epoch }));
  }

  async revokeOpeningCode(value) {
    return this.#write((epoch) => this.#call("revokeOpeningCode", { id: id(value, "开通码 ID"), epoch }));
  }

  async setAccountState(accountId, payload) {
    const target = id(accountId, "账户 ID");
    const body = bodyOf(payload, ["enabled", "expectedSecurityVersion", "emergency"]);
    const enabled = bool(body.enabled, "enabled");
    const expectedSecurityVersion = integer(body.expectedSecurityVersion, { name: "expectedSecurityVersion" });
    const emergency = body.emergency === undefined ? false : bool(body.emergency, "emergency");
    return this.#write((epoch) =>
      this.#call("accountState", {
        id: target,
        body: { enabled, expectedSecurityVersion, emergency },
        epoch,
      }),
    );
  }

  async resetAccountPassword(accountId, payload) {
    const target = id(accountId, "账户 ID");
    const body = bodyOf(payload, ["expectedSecurityVersion", "currentPassword"]);
    const expectedSecurityVersion = integer(body.expectedSecurityVersion, { name: "expectedSecurityVersion" });
    const currentPassword = text(body.currentPassword, {
      min: 1,
      max: 128,
      trim: false,
      name: "本人当前密码",
    });
    return this.#write((epoch) =>
      this.#call("passwordReset", {
        id: target,
        body: { expectedSecurityVersion, currentPassword },
        epoch,
      }),
    );
  }

  async candidates(query = {}) {
    if (!query.username) invalid("必须提供完整用户名");
    const user = username(query.username);
    const groupId = query.groupId === undefined || query.groupId === null || query.groupId === ""
      ? null
      : id(String(query.groupId), "小组 ID");
    return this.#call("candidates", { query: { username: user, ...(groupId ? { groupId } : {}) } });
  }

  // ── 角色与授权 ──────────────────────────────────────────────
  async uploadApprovalSettings() {
    return this.#call("uploadApprovalSettings");
  }

  async updateUploadApprovalSettings(payload) {
    const body = bodyOf(payload, ["thresholdMb", "expectedVersion"]);
    const thresholdMb = integer(body.thresholdMb, { min: 1, max: 2048, name: "审批阈值 MB" });
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    return this.#write(epoch => this.#call("updateUploadApprovalSettings", { body: { thresholdMb, expectedVersion }, epoch }));
  }

  async permissions() {
    return this.#call("permissions");
  }

  async roles(query = {}) {
    const { limit, offset } = page(query);
    return this.#call("roles", { query: { limit, offset } });
  }

  async roleImpact(roleId, query = {}) {
    const rid = id(roleId, "角色 ID");
    const { limit, offset } = page(query);
    return this.#call("roleImpact", { id: rid, query: { limit, offset } });
  }

  async createRole(payload) {
    const body = bodyOf(payload, ["code", "name", "scopeType", "permissions"]);
    const code = text(body.code, { min: 3, max: 64, name: "角色编码" }).toUpperCase();
    if (!ROLE_CODE_RE.test(code)) invalid("角色编码不合法");
    const name = text(body.name, { min: 1, max: 128, name: "角色名称" });
    if (typeof body.scopeType !== "string" || !SCOPE_RE.test(body.scopeType)) invalid("scopeType 不合法");
    const perms = permissions(body.permissions);
    return this.#write((epoch) =>
      this.#call("createRole", { body: { code, name, scopeType: body.scopeType, permissions: perms }, epoch }),
    );
  }

  async updateRolePermissions(roleId, payload) {
    const rid = id(roleId, "角色 ID");
    const body = bodyOf(payload, ["expectedVersion", "permissions"]);
    const expectedVersion = integer(body.expectedVersion, { name: "expectedVersion" });
    const perms = permissions(body.permissions);
    return this.#write((epoch) =>
      this.#call("updateRole", { id: rid, body: { expectedVersion, permissions: perms }, epoch }),
    );
  }

  async roleAssignments(accountId, query = {}) {
    const target = id(accountId, "账户 ID");
    const { limit, offset } = page(query);
    return this.#call("roleAssignments", { id: target, query: { limit, offset } });
  }

  async assignRole(payload) {
    const body = bodyOf(payload, ["accountId", "roleId", "groupId"]);
    const accountId = id(body.accountId, "账户 ID");
    const roleId = id(body.roleId, "角色 ID");
    const groupId = body.groupId === undefined || body.groupId === null || body.groupId === ""
      ? null
      : id(body.groupId, "小组 ID");
    return this.#write((epoch) =>
      this.#call("assignRole", { body: { accountId, roleId, ...(groupId ? { groupId } : {}) }, epoch }),
    );
  }

  async revokeRole(value) {
    return this.#write((epoch) => this.#call("revokeRole", { id: id(value, "授权 ID"), epoch }));
  }

  // ── 审计 ────────────────────────────────────────────────────
  async auditEvents(query = {}) {
    const { limit, offset } = page(query);
    return this.#call("auditEvents", { query: { limit, offset } });
  }
}

/** 管理路由末端错误边界：只回固定公开码/文案，不透传云消息、URL、路径或堆栈。 */
export function cloudManagementErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const known = error instanceof CloudManagementError;
  const pub = known ? error.toPublic() : { error: PUBLIC_MESSAGES.CLOUD_ERROR, code: "CLOUD_ERROR" };
  if (!known) console.error("[cloud-management] INTERNAL");
  if (pub.retryAfterMs > 0) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(pub.retryAfterMs / 1000))));
  res.status(known && pub.status ? pub.status : 400).json(pub);
}
