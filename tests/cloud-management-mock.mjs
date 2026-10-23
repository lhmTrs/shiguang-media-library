/**
 * T-LOCAL-008 隔离管理云端 mock。
 *
 * - 真实 HTTPS + 双向 TLS，一次性 CA/证书全部生成在临时目录；只监听 127.0.0.1。
 * - 按 拾光云端后台/docs/{MANAGEMENT,GROUP,AUTHORIZATION,AUTH}-API.md 实现本轮本地
 *   管理界面会用到的方法/路径/DTO/错误码，便于 Node 适配与无头 UI 验收。
 * - 不连接正式云端、不使用真实账户/素材；数据只在内存，关闭即丢。
 *
 * 测试用：`const cloud = await startManagementCloud();` → `cloud.origin/caCert/...`
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const PASSWORD = "correct horse battery staple";
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = () => b64url(crypto.randomBytes(32));
const now = () => new Date().toISOString();
const plusMinutes = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
const uid = () => crypto.randomUUID();

async function openssl(args) {
  await run("openssl", args, { maxBuffer: 2e6 });
}
async function makeCa(dir, name, cn) {
  const key = path.join(dir, `${name}.key`);
  const crt = path.join(dir, `${name}.crt`);
  await openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", key, "-out", crt,
    "-days", "2", "-subj", `/CN=${cn}`,
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  return { key, crt };
}
async function makeCert(dir, name, ca, { cn, san, eku }) {
  const key = path.join(dir, `${name}.key`);
  const csr = path.join(dir, `${name}.csr`);
  const crt = path.join(dir, `${name}.crt`);
  const ext = path.join(dir, `${name}.ext`);
  const lines = ["basicConstraints=critical,CA:FALSE", `extendedKeyUsage=${eku}`];
  if (san) lines.push(`subjectAltName=${san}`);
  await fs.writeFile(ext, lines.join("\n") + "\n");
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", key, "-out", csr, "-subj", `/CN=${cn}`]);
  await openssl([
    "x509", "-req", "-in", csr, "-CA", ca.crt, "-CAkey", ca.key, "-CAcreateserial",
    "-out", crt, "-days", "2", "-sha256", "-extfile", ext,
  ]);
  return { key, crt };
}
const fingerprintOf = (pem) => new crypto.X509Certificate(pem).fingerprint256;

export async function startManagementCloud() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-management-mock-"));
  const ca = await makeCa(dir, "ca", "Shiguang Management Test CA");
  const serverCert = await makeCert(dir, "server", ca, {
    cn: "localhost", san: "DNS:localhost,IP:127.0.0.1", eku: "serverAuth",
  });
  const clientOwner = await makeCert(dir, "client-owner", ca, { cn: "device-owner", eku: "clientAuth" });
  const clientAdmin = await makeCert(dir, "client-admin", ca, { cn: "device-admin", eku: "clientAuth" });
  const clientOwner2 = await makeCert(dir, "client-owner2", ca, { cn: "device-owner2", eku: "clientAuth" });
  const clientReader = await makeCert(dir, "client-reader", ca, { cn: "device-reader", eku: "clientAuth" });
  const clientMember = await makeCert(dir, "client-member", ca, { cn: "device-member", eku: "clientAuth" });
  const clientCreator = await makeCert(dir, "client-creator", ca, { cn: "device-creator", eku: "clientAuth" });

  const accounts = new Map(); // id -> account
  const byName = new Map(); // username -> account
  const devices = new Map(); // id -> device
  const deviceByFp = new Map(); // fp -> device
  const sessions = new Map(); // access token -> {accountId,deviceId,fp,refreshToken}
  const refreshTokens = new Map(); // refresh token -> access key
  const groups = new Map(); // id -> group
  const members = new Map(); // groupId -> Map(accountId -> state)
  const roles = new Map(); // id -> {role, permissions}
  const assignments = new Map(); // id -> assignment
  const openings = new Map(); // id -> opening
  const resetCodes = new Map(); // token -> {accountId, securityVersion, expiresAt, used}
  const audits = [];
  const idempotency = new Map(); // requestId -> {body, groupId}
  const flags = { failNext: null, failPaths: new Map(), hold: null };
  const requests = [];
  let counter = 0;

  const audit = (actor, eventType, targetId) =>
    audits.unshift({ id: `audit-${++counter}`, actorAccountId: actor, eventType, targetId: targetId || "", createdAt: now() });

  function addAccount({ username, displayName, state = "ACTIVE", superAdmin = false, password = PASSWORD }) {
    const account = {
      id: uid(), username: username.toLowerCase(), displayName, state, superAdmin,
      securityVersion: 1, createdAt: now(), password,
    };
    accounts.set(account.id, account);
    byName.set(account.username, account);
    return account;
  }
  function addDevice(account, { name, certPem, state = "ACTIVE" }) {
    const fp = fingerprintOf(certPem);
    const device = { id: uid(), accountId: account.id, name, state, fp, certificateExpiresAt: plusMinutes(60 * 24 * 80), createdAt: now(), lastSeenAt: null };
    devices.set(device.id, device);
    deviceByFp.set(fp, device);
    return device;
  }
  function addGroup({ name, leader, state = "ACTIVE" }) {
    const group = { id: uid(), name, leaderAccountId: leader?.id || null, state, version: 0 };
    groups.set(group.id, group);
    members.set(group.id, new Map());
    if (leader) members.get(group.id).set(leader.id, "ACTIVE");
    return group;
  }
  function addRole({ code, name, scopeType, builtIn, permissions }) {
    const role = { id: uid(), code, name, scopeType, builtIn, version: 0 };
    roles.set(role.id, { role, permissions: [...permissions] });
    return role;
  }
  function assign(account, role, groupId = null, grantedBy = null) {
    const existing = [...assignments.values()].find(
      (a) => a.accountId === account.id && a.roleId === role.id && (a.groupId || null) === (groupId || null),
    );
    if (existing) return existing;
    const item = {
      id: uid(), accountId: account.id, roleId: role.id, scopeType: role.scopeType,
      scopeKey: role.scopeType === "SYSTEM" ? "SYSTEM" : groupId, groupId, grantedBy,
    };
    assignments.set(item.id, item);
    return item;
  }

  // ── 一次性隔离夹具 ──────────────────────────────────────────────
  const owner = addAccount({ username: "owner", displayName: "唯一负责人", superAdmin: true });
  const admin = addAccount({ username: "admin", displayName: "管理员" });
  const leader = addAccount({ username: "leader", displayName: "组长小李" });
  const member = addAccount({ username: "member", displayName: "组员小王" });
  const pending = addAccount({ username: "pending", displayName: "待激活小赵", state: "PENDING", password: null });
  const disabled = addAccount({ username: "disabled", displayName: "已停用小陈", state: "DISABLED" });
  const newbie = addAccount({ username: "newbie", displayName: "新组员小周" });
  const creator = addAccount({ username: "creator", displayName: "创建员小周" });

  const deviceOwner = addDevice(owner, { name: "owner 的验收机", certPem: await fs.readFile(clientOwner.crt, "utf8") });
  addDevice(owner, { name: "owner 的备用机", certPem: await fs.readFile(clientOwner2.crt, "utf8") });
  addDevice(admin, { name: "admin 的验收机", certPem: await fs.readFile(clientAdmin.crt, "utf8") });
  addDevice(leader, { name: "组长的验收机", certPem: await fs.readFile(clientReader.crt, "utf8") });
  addDevice(member, { name: "组员的验收机", certPem: await fs.readFile(clientMember.crt, "utf8") });
  addDevice(creator, { name: "创建员的验收机", certPem: await fs.readFile(clientCreator.crt, "utf8") });

  const adminRole = addRole({
    code: "ADMINISTRATOR", name: "管理员", scopeType: "SYSTEM", builtIn: true,
    permissions: ["account:read", "account:create", "account:disable", "group:create", "group:administer"],
  });
  const memberRole = addRole({ code: "GROUP_MEMBER", name: "组员", scopeType: "GROUP", builtIn: true, permissions: [] });
  const reviewer = addRole({ code: "MEDIA_REVIEWER", name: "音频审核员", scopeType: "GROUP", builtIn: false, permissions: ["media:review"] });
  const emptyRole = addRole({ code: "EMPTY_HELPER", name: "空权限角色", scopeType: "GROUP", builtIn: false, permissions: [] });
  const creatorRole = addRole({
    code: "ACCOUNT_CREATOR", name: "仅创建账户", scopeType: "SYSTEM", builtIn: false,
    permissions: ["account:create"],
  });
  assign(admin, adminRole, null, owner.id);
  assign(creator, creatorRole, null, owner.id);

  const groupA = addGroup({ name: "音频组", leader });
  const groupB = addGroup({ name: "项目组", leader: admin });
  const groupC = addGroup({ name: "待接管组", leader: disabled, state: "NEEDS_LEADER" });
  const groupD = addGroup({ name: "旧项目组", leader, state: "DISABLED" });
  members.get(groupA.id).set(member.id, "ACTIVE");
  members.get(groupA.id).set(admin.id, "ACTIVE");
  members.get(groupB.id).set(member.id, "ACTIVE");
  members.get(groupC.id).set(member.id, "ACTIVE");
  assign(member, memberRole, groupA.id, owner.id);
  assign(member, reviewer, groupA.id, owner.id);
  assign(member, memberRole, groupB.id, owner.id);

  const permissionsCatalog = [
    { code: "account:read", scopeType: "SYSTEM", customAssignable: true },
    { code: "account:create", scopeType: "SYSTEM", customAssignable: true },
    { code: "account:disable", scopeType: "SYSTEM", customAssignable: true },
    { code: "group:create", scopeType: "SYSTEM", customAssignable: true },
    { code: "group:administer", scopeType: "SYSTEM", customAssignable: true },
    { code: "group:member:manage", scopeType: "GROUP", customAssignable: true },
    { code: "group:profile:edit", scopeType: "GROUP", customAssignable: true },
    { code: "media:review", scopeType: "GROUP", customAssignable: true },
    { code: "group:leader:replace", scopeType: "SYSTEM", customAssignable: false },
  ];

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const ok = (res, data = null) => json(res, 200, { code: "OK", data });
  const fail = (res, status, code, message = "失败") => json(res, status, { code, message, requestId: uid() });
  const page = (items, limit, offset) => ({
    items: items.slice(offset, offset + limit), total: items.length, limit, offset,
  });
  const pageParams = (url) => {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
    return { limit, offset };
  };
  const bearer = (req) => {
    const header = String(req.headers.authorization || "");
    if (!header.startsWith("Bearer ")) return null;
    return sessions.get(header.slice(7)) || null;
  };
  const fpOf = (req) => req.socket.getPeerCertificate?.()?.fingerprint256 || null;
  const deviceOf = (req, session) => {
    const fp = fpOf(req);
    const device = fp ? deviceByFp.get(fp) : null;
    if (!device || !session || device.id !== session.deviceId || device.fp !== fp) return null;
    return device;
  };
  function systemPermissions(account) {
    if (!account) return new Set();
    if (account.superAdmin) return new Set(permissionsCatalog.map((p) => p.code));
    const set = new Set();
    for (const item of assignments.values()) {
      if (item.accountId === account.id && item.scopeType === "SYSTEM") {
        for (const code of roles.get(item.roleId)?.permissions || []) set.add(code);
      }
    }
    return set;
  }
  function requireSystem(account, permission) {
    return account.superAdmin || systemPermissions(account).has(permission);
  }
  function groupPermissions(account, groupId) {
    const group = groups.get(groupId);
    const state = members.get(groupId)?.get(account.id);
    if (!group || state !== "ACTIVE") return [];
    const set = new Set();
    if (group.leaderAccountId === account.id) {
      set.add("group:member:manage");
      set.add("group:profile:edit");
    }
    for (const item of assignments.values()) {
      if (item.accountId === account.id && item.scopeType === "GROUP" && item.groupId === groupId) {
        for (const code of roles.get(item.roleId)?.permissions || []) set.add(code);
      }
    }
    return [...set];
  }
  function capabilitiesOf(account) {
    const result = {
      superAdmin: account.superAdmin,
      systemPermissions: [...systemPermissions(account)].sort(),
      groups: [],
    };
    for (const group of groups.values()) {
      const memberState = members.get(group.id)?.get(account.id);
      if (!memberState) continue;
      const leader = group.leaderAccountId === account.id;
      if (group.state === "DISABLED" && !leader) continue;
      result.groups.push({
        groupId: group.id,
        name: group.name,
        state: group.state,
        leader,
        canReadShared: group.state !== "DISABLED",
        permissions: group.state === "NEEDS_LEADER" ? [] : groupPermissions(account, group.id),
      });
    }
    return result;
  }
  const visibleGroup = (account, group) => {
    if (account.superAdmin || systemPermissions(account).has("group:administer")) return true;
    if (!members.get(group.id)?.has(account.id)) return false;
    return group.state !== "DISABLED";
  };
  const canManageGroup = (account, group) =>
    requireSystem(account, "group:administer") ||
    (group.state === "ACTIVE" && groupPermissions(account, group.id).includes("group:member:manage"));

  function newSession(account, device) {
    const access = token();
    const refresh = token();
    sessions.set(access, {
      accountId: account.id, deviceId: device.id, fp: device.fp,
      refreshToken: refresh, expiresAt: Date.now() + 30 * 24 * 3600_000,
    });
    refreshTokens.set(refresh, access);
    device.lastSeenAt = now();
    return { accessToken: access, refreshToken: refresh, tokenType: "Bearer", expiresIn: 1800, refreshExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString() };
  }

  const server = https.createServer(
    {
      key: await fs.readFile(serverCert.key), cert: await fs.readFile(serverCert.crt),
      ca: await fs.readFile(ca.crt), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2",
    },
    async (req, res) => {
      const url = new URL(req.url, "https://127.0.0.1");
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return fail(res, 400, "INVALID_REQUEST", "JSON 无效");
      }
      requests.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        hasAuth: !!req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      if (flags.failNext) {
        const { status, code } = flags.failNext;
        flags.failNext = null;
        return fail(res, status, code);
      }
      // 测试用：挂起指定路径的响应，便于复现“旧 profile 在途 → 403 → 新读取”。
      if (flags.hold && flags.hold.remaining > 0 && url.pathname === flags.hold.path) {
        const hold = flags.hold;
        hold.remaining -= 1;
        hold.arrivedResolve();
        await hold.gate;
      }
      const route = `${req.method} ${url.pathname.replace(/^\/api\/v1/, "")}`;
      const session = bearer(req);
      const account = session ? accounts.get(session.accountId) : null;
      const device = account ? deviceOf(req, session) : null;
      const authOk = () => account && device && account.state === "ACTIVE" && device.state === "ACTIVE";

      // ── 认证 ──────────────────────────────────────────────
      if (route === "POST /auth/login") {
        const user = byName.get(String(payload.username || "").toLowerCase());
        const fp = fpOf(req);
        const dev = fp ? deviceByFp.get(fp) : null;
        if (!user || user.state !== "ACTIVE" || !dev || dev.accountId !== user.id || user.password !== payload.password)
          return fail(res, 401, "UNAUTHORIZED");
        return ok(res, newSession(user, dev));
      }
      if (route === "POST /auth/refresh") {
        const access = refreshTokens.get(String(payload.refreshToken || ""));
        const current = access ? sessions.get(access) : null;
        if (!current || current.refreshToken !== payload.refreshToken) return fail(res, 401, "UNAUTHORIZED");
        const user = accounts.get(current.accountId);
        const dev = devices.get(current.deviceId);
        if (!user || !dev || dev.fp !== fpOf(req)) return fail(res, 401, "UNAUTHORIZED");
        const next = newSession(user, dev);
        sessions.delete(access);
        refreshTokens.delete(payload.refreshToken);
        return ok(res, next);
      }
      if (route === "POST /auth/logout") {
        if (!authOk()) return fail(res, 401, "UNAUTHORIZED");
        sessions.delete(bearerKey(req));
        return ok(res, null);
      }
      if (route === "POST /auth/reset-password") {
        // 不需要旧 Bearer：只要求本机设备证书仍属于该码账户且状态有效。
        const fp = fpOf(req);
        const resetDevice = fp ? deviceByFp.get(fp) : null;
        const resetAccount = resetDevice ? accounts.get(resetDevice.accountId) : null;
        if (!resetDevice || resetDevice.state !== "ACTIVE" || !resetAccount || resetAccount.state !== "ACTIVE")
          return fail(res, 401, "UNAUTHORIZED");
        const record = resetCodes.get(String(payload.resetToken || ""));
        if (!record || record.used || record.expiresAt < Date.now() || record.accountId !== resetAccount.id || record.securityVersion !== resetAccount.securityVersion)
          return fail(res, 401, "UNAUTHORIZED");
        if (String(payload.newPassword || "").length < 12) return fail(res, 400, "INVALID_REQUEST");
        record.used = true;
        resetAccount.password = payload.newPassword;
        resetAccount.securityVersion += 1;
        for (const [key, value] of sessions) if (value.accountId === resetAccount.id) sessions.delete(key);
        audit(resetAccount.id, "PASSWORD_RESET_COMPLETED", resetAccount.id);
        return ok(res, null);
      }
      if (route === "GET /me") {
        if (!authOk()) return fail(res, 401, "UNAUTHORIZED");
        return ok(res, {
          accountId: account.id, username: account.username, displayName: account.displayName,
          deviceId: device.id, sessionId: "session", superAdmin: account.superAdmin,
        });
      }
      if (route === "GET /me/devices") {
        if (!authOk()) return fail(res, 401, "UNAUTHORIZED");
        return ok(res, [...devices.values()].filter((d) => d.accountId === account.id).map((d) => ({
          id: d.id, name: d.name, state: d.state, certificateExpiresAt: d.certificateExpiresAt,
          createdAt: d.createdAt, lastSeenAt: d.lastSeenAt,
        })));
      }
      if (route.startsWith("DELETE /me/devices/")) {
        if (!authOk()) return fail(res, 401, "UNAUTHORIZED");
        const target = devices.get(route.split("/").pop());
        if (!target || target.accountId !== account.id) return fail(res, 404, "NOT_FOUND");
        target.state = "REVOKED";
        for (const [key, value] of sessions) if (value.deviceId === target.id) sessions.delete(key);
        audit(account.id, "DEVICE_REVOKED", target.id);
        return ok(res, null);
      }
      if (route === "POST /me/password") {
        if (!authOk()) return fail(res, 401, "UNAUTHORIZED");
        if (account.password !== payload.currentPassword) return fail(res, 401, "UNAUTHORIZED");
        if (String(payload.newPassword || "").length < 12) return fail(res, 400, "INVALID_REQUEST");
        account.password = payload.newPassword;
        account.securityVersion += 1;
        for (const [key, value] of sessions) if (value.accountId === account.id) sessions.delete(key);
        audit(account.id, "PASSWORD_CHANGED", account.id);
        return ok(res, null);
      }

      // 之后所有管理接口都要求有效 mTLS 会话
      if (!route.startsWith("POST /auth/")) {
        if (!authOk()) return fail(res, 401, "UNAUTHORIZED");
      }

      if (route === "GET /me/capabilities") return ok(res, capabilitiesOf(account));

      // ── 账户与候选 ────────────────────────────────────────
      if (route === "GET /accounts") {
        if (!requireSystem(account, "account:read")) return fail(res, 403, "FORBIDDEN");
        const query = String(url.searchParams.get("query") || "").toLowerCase();
        const state = String(url.searchParams.get("state") || "");
        let list = [...accounts.values()];
        if (query) list = list.filter((a) => a.username.includes(query) || a.displayName.toLowerCase().includes(query));
        if (state) list = list.filter((a) => a.state === state);
        const { limit, offset } = pageParams(url);
        return ok(res, page(list.map((a) => ({
          id: a.id, username: a.username, displayName: a.displayName, state: a.state,
          securityVersion: a.securityVersion, createdAt: a.createdAt, superAdmin: a.superAdmin,
        })), limit, offset));
      }
      if (route === "GET /account-candidates") {
        const username = String(url.searchParams.get("username") || "").trim().toLowerCase();
        const groupId = url.searchParams.get("groupId");
        const allowed = groupId
          ? requireSystem(account, "group:administer") ||
            (groupId && members.get(groupId)?.get(account.id) === "ACTIVE" && groupPermissions(account, groupId).includes("group:member:manage"))
          : requireSystem(account, "group:create") || requireSystem(account, "group:administer");
        if (!allowed) return fail(res, 403, "FORBIDDEN");
        const target = byName.get(username);
        if (!target || target.state !== "ACTIVE") return ok(res, []);
        return ok(res, [{ id: target.id, username: target.username, displayName: target.displayName }]);
      }
      if (route === "POST /accounts") {
        if (!requireSystem(account, "account:create")) return fail(res, 403, "FORBIDDEN");
        const username = String(payload.username || "").toLowerCase();
        if (byName.has(username)) return fail(res, 409, "ACCOUNT_EXISTS");
        const created = addAccount({ username, displayName: payload.displayName, state: "PENDING", password: null });
        const opening = { id: uid(), accountId: created.id, username: created.username, openingCode: token(), expiresAt: plusMinutes(24 * 60) };
        openings.set(opening.id, { ...opening, securityVersion: created.securityVersion });
        audit(account.id, "ACCOUNT_CREATED", created.id);
        return ok(res, opening);
      }
      if (route.startsWith("POST /accounts/") && route.endsWith("/device-opening-codes")) {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const target = accounts.get(route.split("/")[2]);
        if (!target) return fail(res, 404, "NOT_FOUND");
        const opening = { id: uid(), accountId: target.id, username: target.username, openingCode: token(), expiresAt: plusMinutes(24 * 60) };
        openings.set(opening.id, { ...opening, securityVersion: target.securityVersion });
        audit(account.id, "OPENING_CODE_ISSUED", target.id);
        return ok(res, opening);
      }
      if (route.startsWith("DELETE /device-opening-codes/")) {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        openings.delete(route.split("/").pop());
        return ok(res, null);
      }
      if (route.startsWith("POST /accounts/") && route.endsWith("/state")) {
        if (!requireSystem(account, "account:disable")) return fail(res, 403, "FORBIDDEN");
        const target = accounts.get(route.split("/")[2]);
        if (!target) return fail(res, 404, "NOT_FOUND");
        if (target.superAdmin) return fail(res, 403, "FORBIDDEN");
        if (target.securityVersion !== payload.expectedSecurityVersion) return fail(res, 409, "VERSION_CONFLICT");
        if (target.state === "PENDING") return fail(res, 400, "INVALID_REQUEST");
        const ledGroups = [...groups.values()].filter((g) => g.leaderAccountId === target.id && g.state === "ACTIVE");
        if (!payload.enabled && ledGroups.length && payload.emergency !== true) return fail(res, 409, "LEADER_TRANSFER_REQUIRED");
        target.state = payload.enabled ? "ACTIVE" : "DISABLED";
        target.securityVersion += 1;
        if (!payload.enabled) {
          for (const [key, value] of sessions) if (value.accountId === target.id) sessions.delete(key);
          if (payload.emergency === true) for (const g of ledGroups) g.state = "NEEDS_LEADER";
        }
        audit(account.id, payload.enabled ? "ACCOUNT_ENABLED" : "ACCOUNT_DISABLED", target.id);
        return ok(res, null);
      }
      if (route.startsWith("POST /accounts/") && route.endsWith("/password-resets")) {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const target = accounts.get(route.split("/")[2]);
        if (!target) return fail(res, 404, "NOT_FOUND");
        if (target.id === account.id || target.superAdmin || target.state !== "ACTIVE") return fail(res, 403, "FORBIDDEN");
        if (target.securityVersion !== payload.expectedSecurityVersion) return fail(res, 409, "VERSION_CONFLICT");
        if (account.password !== payload.currentPassword) return fail(res, 401, "UNAUTHORIZED");
        for (const [code, record] of resetCodes) if (record.accountId === target.id && !record.used) resetCodes.delete(code);
        const resetToken = token();
        resetCodes.set(resetToken, {
          accountId: target.id, securityVersion: target.securityVersion,
          expiresAt: Date.now() + 15 * 60_000, used: false,
        });
        audit(account.id, "PASSWORD_RESET_ISSUED", target.id);
        return ok(res, { resetToken, accountId: target.id, expiresAt: plusMinutes(15) });
      }
      if (route.match(/^GET \/accounts\/[^/]+$/)) {
        if (!requireSystem(account, "account:read")) return fail(res, 403, "FORBIDDEN");
        const target = accounts.get(route.split("/")[2]);
        if (!target) return fail(res, 404, "NOT_FOUND");
        return ok(res, {
          id: target.id, username: target.username, displayName: target.displayName, state: target.state,
          securityVersion: target.securityVersion, createdAt: target.createdAt, superAdmin: target.superAdmin,
        });
      }

      // ── 小组 ──────────────────────────────────────────────
      if (route === "GET /groups") {
        const management = url.searchParams.get("management") === "true";
        if (management && !requireSystem(account, "group:administer")) return fail(res, 403, "FORBIDDEN");
        const managed = management && requireSystem(account, "group:administer");
        const { limit, offset } = pageParams(url);
        const list = [...groups.values()]
          .filter((g) => managed || (members.get(g.id)?.has(account.id) && g.state !== "DISABLED"))
          .sort((a, b) => a.name.localeCompare(b.name));
        return ok(res, list.slice(offset, offset + limit).map((g) => ({ id: g.id, name: g.name, leaderAccountId: g.leaderAccountId, state: g.state, version: g.version })));
      }
      if (route.match(/^GET \/groups\/[^/]+$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group || !visibleGroup(account, group)) return fail(res, 404, "NOT_FOUND");
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: group.version });
      }
      if (route.match(/^GET \/groups\/[^/]+\/members$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group || !visibleGroup(account, group)) return fail(res, 404, "NOT_FOUND");
        const { limit, offset } = pageParams(url);
        const list = [...members.get(group.id).entries()].filter(([, state]) => state === "ACTIVE").sort(([a], [b]) => a.localeCompare(b));
        return ok(res, page(list.map(([accountId, state]) => ({ accountId, state })), limit, offset).items);
      }
      if (route.match(/^GET \/groups\/[^/]+\/member-profiles$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group || !visibleGroup(account, group)) return fail(res, 404, "NOT_FOUND");
        const { limit, offset } = pageParams(url);
        const list = [...members.get(group.id).entries()].filter(([, state]) => state === "ACTIVE").sort(([a], [b]) => a.localeCompare(b));
        return ok(res, page(list.map(([accountId, state]) => {
          const target = accounts.get(accountId);
          return {
            accountId, username: target?.username || null, displayName: target?.displayName || null,
            memberState: state, accountState: target?.state || "DISABLED",
          };
        }), limit, offset).items);
      }
      if (route === "POST /groups") {
        if (!requireSystem(account, "group:create")) return fail(res, 403, "FORBIDDEN");
        const requestId = String(payload.requestId || "");
        const initial = accounts.get(payload.initialLeaderAccountId);
        if (!initial || initial.state !== "ACTIVE") return fail(res, 400, "INVALID_GROUP");
        const normalized = { name: String(payload.name || "").trim(), leader: initial.id };
        const existing = idempotency.get(requestId);
        if (existing) {
          if (existing.body.name !== normalized.name || existing.body.leader !== normalized.leader) return fail(res, 409, "IDEMPOTENCY_CONFLICT");
          const replay = groups.get(existing.groupId);
          return ok(res, { id: replay.id, name: replay.name, leaderAccountId: replay.leaderAccountId, state: replay.state, version: 0 });
        }
        const group = addGroup({ name: normalized.name, leader: initial });
        idempotency.set(requestId, { body: normalized, groupId: group.id });
        audit(account.id, "GROUP_CREATED", group.id);
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: 0 });
      }
      if (route.match(/^PUT \/groups\/[^/]+$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group) return fail(res, 404, "NOT_FOUND");
        if (!(requireSystem(account, "group:administer") || (group.state === "ACTIVE" && groupPermissions(account, group.id).includes("group:profile:edit"))))
          return fail(res, 403, "FORBIDDEN");
        if (group.version !== payload.expectedVersion) return fail(res, 409, "VERSION_CONFLICT");
        group.name = String(payload.name || "").trim();
        group.version += 1;
        audit(account.id, "GROUP_RENAMED", group.id);
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: group.version });
      }
      if (route.match(/^POST \/groups\/[^/]+\/members$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group) return fail(res, 404, "NOT_FOUND");
        if (!canManageGroup(account, group)) return fail(res, 403, "FORBIDDEN");
        if (group.version !== payload.expectedVersion) return fail(res, 409, "VERSION_CONFLICT");
        const target = accounts.get(payload.accountId);
        if (!target || target.state !== "ACTIVE") return fail(res, 400, "INVALID_GROUP");
        if (members.get(group.id).get(target.id) !== "ACTIVE") {
          members.get(group.id).set(target.id, "ACTIVE");
          group.version += 1;
          audit(account.id, "GROUP_MEMBER_ADDED", target.id);
        }
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: group.version });
      }
      if (route.match(/^DELETE \/groups\/[^/]+\/members\/[^/]+$/)) {
        const [, , groupId, , targetId] = route.split("/");
        const group = groups.get(groupId);
        if (!group) return fail(res, 404, "NOT_FOUND");
        if (!canManageGroup(account, group)) return fail(res, 403, "FORBIDDEN");
        if (group.version !== payload.expectedVersion) return fail(res, 409, "VERSION_CONFLICT");
        if (group.leaderAccountId === targetId) return fail(res, 409, "LEADER_TRANSFER_REQUIRED");
        members.get(group.id).set(targetId, "REMOVED");
        group.version += 1;
        for (const [id, item] of assignments) if (item.accountId === targetId && item.groupId === group.id) assignments.delete(id);
        audit(account.id, "GROUP_MEMBER_REMOVED", targetId);
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: group.version });
      }
      if (route.match(/^POST \/groups\/[^/]+\/leave$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group) return fail(res, 404, "NOT_FOUND");
        if (group.version !== payload.expectedVersion) return fail(res, 409, "VERSION_CONFLICT");
        if (group.leaderAccountId === account.id) return fail(res, 409, "LEADER_TRANSFER_REQUIRED");
        members.get(group.id).set(account.id, "LEFT");
        group.version += 1;
        for (const [id, item] of assignments) if (item.accountId === account.id && item.groupId === group.id) assignments.delete(id);
        audit(account.id, "GROUP_LEFT", group.id);
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: group.version });
      }
      if (route.match(/^POST \/groups\/[^/]+\/leader-transfers$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group) return fail(res, 404, "NOT_FOUND");
        if (!requireSystem(account, "group:leader:replace")) return fail(res, 403, "FORBIDDEN");
        if (group.version !== payload.expectedVersion) return fail(res, 409, "VERSION_CONFLICT");
        const target = accounts.get(payload.accountId);
        if (!target || target.state !== "ACTIVE" || members.get(group.id).get(target.id) !== "ACTIVE") return fail(res, 400, "INVALID_GROUP");
        group.leaderAccountId = target.id;
        group.version += 1;
        audit(account.id, "GROUP_LEADER_TRANSFERRED", target.id);
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: group.version });
      }
      if (route.match(/^POST \/groups\/[^/]+\/state$/)) {
        const group = groups.get(route.split("/")[2]);
        if (!group) return fail(res, 404, "NOT_FOUND");
        if (!requireSystem(account, "group:administer")) return fail(res, 403, "FORBIDDEN");
        if (group.version !== payload.expectedVersion) return fail(res, 409, "VERSION_CONFLICT");
        if (payload.enabled) {
          const current = accounts.get(group.leaderAccountId);
          if (!current || current.state !== "ACTIVE" || members.get(group.id).get(current.id) !== "ACTIVE") return fail(res, 409, "GROUP_NEEDS_LEADER");
          group.state = "ACTIVE";
        } else {
          group.state = "DISABLED";
        }
        group.version += 1;
        audit(account.id, payload.enabled ? "GROUP_ENABLED" : "GROUP_DISABLED", group.id);
        return ok(res, { id: group.id, name: group.name, leaderAccountId: group.leaderAccountId, state: group.state, version: group.version });
      }

      // ── 角色与审计 ────────────────────────────────────────
      if (route === "GET /permissions") {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        return ok(res, permissionsCatalog);
      }
      if (route === "GET /roles") {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const { limit, offset } = pageParams(url);
        return ok(res, page([...roles.values()].map((item) => ({ role: item.role, permissions: item.permissions })), limit, offset).items);
      }
      if (route.match(/^GET \/roles\/[^/]+\/impact$/)) {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const roleId = route.split("/")[2];
        if (!roles.has(roleId)) return fail(res, 404, "NOT_FOUND");
        const { limit, offset } = pageParams(url);
        const list = [...assignments.values()].filter((item) => item.roleId === roleId);
        return ok(res, {
          totalAssignments: list.length,
          assignments: list.slice(offset, offset + limit),
          limit, offset, hasMore: offset + limit < list.length,
        });
      }
      if (route === "POST /roles") {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const code = String(payload.code || "").toUpperCase();
        if ([...roles.values()].some((item) => item.role.code === code)) return fail(res, 409, "ROLE_EXISTS");
        const role = addRole({ code, name: payload.name, scopeType: payload.scopeType, builtIn: false, permissions: payload.permissions || [] });
        audit(account.id, "ROLE_CREATED", role.id);
        return ok(res, { role, permissions: roles.get(role.id).permissions });
      }
      if (route.match(/^PUT \/roles\/[^/]+\/permissions$/)) {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const roleId = route.split("/")[2];
        const item = roles.get(roleId);
        if (!item) return fail(res, 404, "NOT_FOUND");
        if (item.role.version !== payload.expectedVersion) return fail(res, 409, "VERSION_CONFLICT");
        item.permissions = [...new Set(payload.permissions || [])].sort();
        item.role.version += 1;
        audit(account.id, "ROLE_PERMISSIONS_UPDATED", roleId);
        return ok(res, { role: item.role, permissions: item.permissions });
      }
      if (route === "POST /role-assignments") {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const target = accounts.get(payload.accountId);
        const item = roles.get(payload.roleId);
        if (!target || !item) return fail(res, 400, "INVALID_AUTHORIZATION");
        if (item.role.scopeType === "GROUP") {
          if (!payload.groupId || !groups.get(payload.groupId) || members.get(payload.groupId).get(target.id) !== "ACTIVE")
            return fail(res, 400, "INVALID_AUTHORIZATION");
        } else if (payload.groupId) return fail(res, 400, "INVALID_AUTHORIZATION");
        const assignment = assign(target, item.role, payload.groupId || null, account.id);
        audit(account.id, "ROLE_ASSIGNED", target.id);
        return ok(res, assignment);
      }
      if (route.startsWith("DELETE /role-assignments/")) {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        assignments.delete(route.split("/").pop());
        return ok(res, null);
      }
      if (route.match(/^GET \/accounts\/[^/]+\/role-assignments$/)) {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const targetId = route.split("/")[2];
        if (!accounts.has(targetId)) return fail(res, 404, "NOT_FOUND");
        const { limit, offset } = pageParams(url);
        return ok(res, page([...assignments.values()].filter((item) => item.accountId === targetId), limit, offset));
      }
      if (route === "GET /audit-events") {
        if (!account.superAdmin) return fail(res, 403, "FORBIDDEN");
        const { limit, offset } = pageParams(url);
        return ok(res, page(audits, limit, offset));
      }

      return fail(res, 404, "NOT_FOUND", "接口不存在");
    },
  );

  function bearerKey(req) {
    const header = String(req.headers.authorization || "");
    return header.startsWith("Bearer ") ? header.slice(7) : null;
  }

  // T-LOCAL-011：统计真实 TLS 握手次数，用于验证受控 keep-alive 复用。
  let secureConnections = 0;
  server.on("secureConnection", () => {
    secureConnections += 1;
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    origin: `https://127.0.0.1:${port}`,
    caCert: ca.crt,
    clientOwner: { cert: clientOwner.crt, key: clientOwner.key },
    clientAdmin: { cert: clientAdmin.crt, key: clientAdmin.key },
    clientOwner2: { cert: clientOwner2.crt, key: clientOwner2.key },
    clientReader: { cert: clientReader.crt, key: clientReader.key },
    clientMember: { cert: clientMember.crt, key: clientMember.key },
    clientCreator: { cert: clientCreator.crt, key: clientCreator.key },
    password: PASSWORD,
    ids: {
      owner: owner.id, admin: admin.id, leader: leader.id, member: member.id,
      pending: pending.id, disabled: disabled.id, newbie: newbie.id, creator: creator.id,
      devices: { owner: deviceOwner.id },
      groups: { a: groupA.id, b: groupB.id, c: groupC.id, d: groupD.id },
      roles: { admin: adminRole.id, member: memberRole.id, reviewer: reviewer.id, empty: emptyRole.id, creator: creatorRole.id },
    },
    state: { accounts, groups, members, roles, assignments, openings, resetCodes, audits },
    flags,
    requests,
    /** 本 mock 接受的 TLS 握手总数（keep-alive 复用回归用） */
    secureConnections: () => secureConnections,
    failNext(status, code) {
      flags.failNext = { status, code };
    },
    /**
     * 测试用：挂起接下来 count 个匹配 pathname 的响应。
     * 返回的 arrived 在请求进入服务端后 resolve；release 放行。
     */
    holdNext(pathname, count = 1) {
      let releaseGate;
      let arrivedResolve;
      const gate = new Promise((resolve) => {
        releaseGate = resolve;
      });
      const arrived = new Promise((resolve) => {
        arrivedResolve = resolve;
      });
      const entry = { path: pathname, remaining: count, gate, arrivedResolve };
      flags.hold = entry;
      return {
        arrived,
        release: () => {
          releaseGate();
          if (flags.hold === entry && entry.remaining <= 0) flags.hold = null;
        },
      };
    },
    revokeAllSessions() {
      sessions.clear();
      refreshTokens.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    dir,
  };
}
