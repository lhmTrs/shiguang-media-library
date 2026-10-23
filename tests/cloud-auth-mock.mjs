/**
 * 隔离的云端认证 mock（T-LOCAL-CLOUD-001 测试夹具）。
 *
 * - 真实 HTTPS + 双向 TLS：服务端要求客户端证书，证书由一次性 CA 签发，全部生成在临时目录。
 * - 只在本机 127.0.0.1 随机端口监听，跑完关掉；不连正式云端、不碰真实账户。
 * - 按 `拾光云端后台/docs/AUTH-API.md` 实现 login / activate / refresh / logout / me 的语义：
 *   refresh 轮换 + 旧令牌重放 → 撤销会话；429 限流；401 失效。
 *
 * 测试用：`const cloud = await startMockCloud();` → `cloud.origin / cloud.caCert / cloud.clientCertA ...`
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const token = () => b64url(crypto.randomBytes(32));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function openssl(args) {
  await run("openssl", args, { maxBuffer: 2e6 });
}

async function makeCa(dir, name, cn) {
  const key = path.join(dir, `${name}.key`);
  const crt = path.join(dir, `${name}.crt`);
  await openssl([
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
    "-keyout", key, "-out", crt, "-days", "2", "-subj", `/CN=${cn}`,
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

export async function startMockCloud() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-cloud-mock-"));
  const ca = await makeCa(dir, "ca", "Shiguang Test CA");
  const otherCa = await makeCa(dir, "other-ca", "Untrusted Test CA");
  const server = await makeCert(dir, "server", ca, {
    cn: "localhost",
    san: "DNS:localhost,IP:127.0.0.1",
    eku: "serverAuth",
  });
  const clientA = await makeCert(dir, "client-a", ca, { cn: "device-a", eku: "clientAuth" });
  const clientB = await makeCert(dir, "client-b", ca, { cn: "device-b", eku: "clientAuth" });
  const clientUntrusted = await makeCert(dir, "client-x", otherCa, { cn: "device-x", eku: "clientAuth" });

  const accounts = new Map(); // username -> { password, displayName, superAdmin, deviceFp, deviceId }
  const devices = new Map(); // fingerprint -> { id, accountId, state }
  const activations = new Map(); // token -> { username, deviceFp, expiresAt }
  const sessions = new Map(); // id -> { accountId, deviceId, fp, refreshHash, used:Set, revoked, expiresAt }
  const accessTokens = new Map(); // jwt-ish -> sessionId
  const counts = { login: 0, activate: 0, refresh: 0, logout: 0, me: 0 };
  const flags = {
    dropRefreshResponse: false,
    rateLimitRefresh: false,
    revokeSessions: false,
    partialRefreshResponse: false,
    stallRefreshResponse: false,
    oversizeRefreshResponse: false,
  };
  // 测试可控闸门：刷新已消费并轮换令牌、但客户端还没收到响应时暂停
  let refreshGate = null;

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  const ok = (res, data = null) => json(res, 200, { code: "OK", data });
  const fail = (res, status, code, message = "失败") => json(res, status, { code, message, requestId: crypto.randomUUID() });

  const fpOf = (req) => {
    const cert = req.socket.getPeerCertificate?.();
    return cert?.fingerprint256 || null;
  };
  const newSession = (accountId, deviceId, fp) => {
    const id = crypto.randomUUID();
    const refreshToken = token();
    sessions.set(id, {
      id,
      accountId,
      deviceId,
      fp,
      refreshHash: sha256(refreshToken),
      used: new Set(),
      revoked: false,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
    });
    return { id, refreshToken, session: sessions.get(id) };
  };
  const issue = (session, refreshToken) => {
    const access = token();
    accessTokens.set(access, session.id);
    return {
      accessToken: access,
      refreshToken,
      tokenType: "Bearer",
      expiresIn: 1800,
      refreshExpiresAt: new Date(session.expiresAt).toISOString(),
    };
  };
  const bearer = (req) => {
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Bearer ")) return null;
    return accessTokens.get(h.slice(7)) || null;
  };

  const server_ = https.createServer(
    { key: await fs.readFile(server.key), cert: await fs.readFile(server.crt), ca: await fs.readFile(ca.crt), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.2" },
    async (req, res) => {
      const url = new URL(req.url, "https://127.0.0.1");
      const fp = fpOf(req);
      let body = "";
      for await (const chunk of req) body += chunk;
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return fail(res, 400, "INVALID_REQUEST", "JSON 无效");
      }
      const route = `${req.method} ${url.pathname.replace(/^\/api\/v1/, "")}`;
      const device = fp ? devices.get(fp) : null;

      if (route === "POST /auth/login") {
        counts.login++;
        if (!device || device.state !== "ACTIVE") return fail(res, 401, "UNAUTHORIZED", "设备未激活");
        const account = accounts.get(String(payload.username || "").toLowerCase());
        if (!account || account.password !== payload.password || account.deviceFp !== fp)
          return fail(res, 401, "UNAUTHORIZED", "凭据无效");
        const { id, refreshToken, session } = newSession(account.id, device.id, fp);
        return ok(res, issue(session, refreshToken));
      }

      if (route === "POST /auth/activate") {
        counts.activate++;
        const record = activations.get(String(payload.activationToken || ""));
        if (!record || record.used || record.expiresAt < Date.now() || record.deviceFp !== fp)
          return fail(res, 401, "UNAUTHORIZED", "激活凭证无效");
        if (String(payload.password || "").length < 12) return fail(res, 400, "INVALID_REQUEST", "密码太短");
        record.used = true;
        const account = accounts.get(record.username);
        account.password = String(payload.password);
        account.deviceFp = fp;
        const dev = devices.get(fp);
        dev.state = "ACTIVE";
        const { refreshToken, session } = newSession(account.id, dev.id, fp);
        return ok(res, issue(session, refreshToken));
      }

      if (route === "POST /auth/refresh") {
        counts.refresh++;
        if (flags.rateLimitRefresh) {
          res.setHeader("retry-after", "1");
          return fail(res, 429, "RATE_LIMITED", "限流");
        }
        const presented = String(payload.refreshToken || "");
        const hash = sha256(presented);
        const session = [...sessions.values()].find((s) => s.refreshHash === hash || s.used.has(hash));
        if (!session || session.revoked || session.fp !== fp) return fail(res, 401, "UNAUTHORIZED", "刷新令牌无效");
        if (session.used.has(hash)) {
          // 重放旧刷新令牌 → 撤销整个会话（契约第 5 节）
          session.revoked = true;
          for (const [at, sid] of accessTokens) if (sid === session.id) accessTokens.delete(at);
          return fail(res, 401, "UNAUTHORIZED", "刷新令牌已使用");
        }
        if (session.expiresAt < Date.now()) {
          session.revoked = true;
          return fail(res, 401, "UNAUTHORIZED", "会话到期");
        }
        session.used.add(hash);
        const nextRefresh = token();
        session.refreshHash = sha256(nextRefresh);
        if (flags.dropRefreshResponse) {
          // 响应丢失：令牌已在服务端轮换，但客户端收不到
          session.refreshHash = sha256(nextRefresh);
          req.socket.destroy();
          return;
        }
        const data = issue(session, nextRefresh);
        if (refreshGate) {
          const gate = refreshGate;
          refreshGate = null;
          gate.entered();
          await gate.released;
          // 客户端可能已因 logout/configure 主动中止请求
          if (res.destroyed || res.writableEnded) return;
        }
        if (flags.partialRefreshResponse) {
          // 200 + 部分 JSON 后断流：客户端不能永久悬挂
          res.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
          res.write('{"code":"OK","data":');
          setImmediate(() => res.destroy());
          return;
        }
        if (flags.stallRefreshResponse) {
          // 200 + 部分 JSON 后一直不结束：必须靠完整请求 deadline 收敛
          res.writeHead(200, { "content-type": "application/json", "content-length": "10000" });
          res.write('{"code":"OK","data":');
          return;
        }
        if (flags.oversizeRefreshResponse) {
          return json(res, 200, { code: "OK", data: { ...data, padding: "x".repeat(1_100_000) } });
        }
        return ok(res, data);
      }

      if (route === "POST /auth/logout") {
        counts.logout++;
        const sid = bearer(req);
        const session = sid && sessions.get(sid);
        if (!session || session.fp !== fp) return fail(res, 401, "UNAUTHORIZED", "会话无效");
        session.revoked = true;
        for (const [at, id] of accessTokens) if (id === session.id) accessTokens.delete(at);
        return ok(res, null);
      }

      if (route === "GET /me") {
        counts.me++;
        const sid = bearer(req);
        const session = sid && sessions.get(sid);
        if (!session || session.revoked || session.fp !== fp) return fail(res, 401, "UNAUTHORIZED", "会话无效");
        const account = [...accounts.values()].find((a) => a.id === session.accountId);
        return ok(res, {
          accountId: session.accountId,
          username: account.username,
          displayName: account.displayName,
          deviceId: session.deviceId,
          sessionId: session.id,
          superAdmin: !!account.superAdmin,
        });
      }

      return fail(res, 404, "NOT_FOUND", "接口不存在");
    },
  );

  // T-LOCAL-011：统计真实 TLS 握手次数，用于验证受控 keep-alive 复用。
  let secureConnections = 0;
  server_.on("secureConnection", () => {
    secureConnections += 1;
  });
  await new Promise((resolve) => server_.listen(0, "127.0.0.1", resolve));
  const { port } = server_.address();

  const api = {
    origin: `https://127.0.0.1:${port}`,
    caCert: ca.crt,
    otherCaCert: otherCa.crt,
    clientCertA: clientA.crt,
    clientKeyA: clientA.key,
    clientCertB: clientB.crt,
    clientKeyB: clientB.key,
    clientUntrustedCert: clientUntrusted.crt,
    clientUntrustedKey: clientUntrusted.key,
    counts,
    flags,
    /** 本 mock 接受的 TLS 握手总数（keep-alive 复用回归用） */
    secureConnections: () => secureConnections,
    /** 登记一个账户 + 绑定设备证书（测试夹具用，等价于云端离线登记工具） */
    async enroll({ username, password, displayName, superAdmin = false, clientCert, clientKey }) {
      const pem = await fs.readFile(clientCert, "utf8");
      const fp = fingerprintOf(pem);
      const accountId = crypto.randomUUID();
      const deviceId = crypto.randomUUID();
      accounts.set(username.toLowerCase(), { id: accountId, username: username.toLowerCase(), password, displayName, superAdmin, deviceFp: fp, deviceId });
      devices.set(fp, { id: deviceId, accountId, state: "ACTIVE" });
      return { accountId, deviceId };
    },
    /** 创建待激活账户（PENDING 设备 + 一次性激活凭证） */
    async enrollPending({ username, displayName, clientCert }) {
      const pem = await fs.readFile(clientCert, "utf8");
      const fp = fingerprintOf(pem);
      const accountId = crypto.randomUUID();
      const deviceId = crypto.randomUUID();
      accounts.set(username.toLowerCase(), { id: accountId, username: username.toLowerCase(), password: null, displayName, superAdmin: false, deviceFp: fp, deviceId });
      devices.set(fp, { id: deviceId, accountId, state: "PENDING" });
      const activationToken = token();
      activations.set(activationToken, { username: username.toLowerCase(), deviceFp: fp, expiresAt: Date.now() + 24 * 3600 * 1000 });
      return { accountId, deviceId, activationToken };
    },
    /** 让云端撤销全部会话（模拟停用/撤权） */
    revokeAllSessions() {
      for (const session of sessions.values()) session.revoked = true;
      accessTokens.clear();
    },
    /** 暂停下一次刷新响应：返回 entered（已到响应头阶段）与 release() */
    gateRefreshResponse() {
      let enteredResolve;
      let releasedResolve;
      const entered = new Promise((resolve) => (enteredResolve = resolve));
      const released = new Promise((resolve) => (releasedResolve = resolve));
      refreshGate = { entered: enteredResolve, released };
      return { entered, release: () => releasedResolve() };
    },
    sessionCount: () => sessions.size,
    deviceCount: () => devices.size,
    close: () =>
      new Promise((resolve) => {
        server_.closeAllConnections?.();
        server_.close(() => resolve());
      }),
    dir,
  };
  return api;
}
