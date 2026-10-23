/**
 * T-LOCAL-007 隔离开通 mock：真实 HTTPS、真实 TLS 客户端证书、真实 RSA 持钥证明。
 *
 * 全部证书/密钥生成在临时目录，只监听 127.0.0.1 随机端口；跑完即关闭。
 * - 开通端口：不要求客户端证书，只允许 POST /api/v1/device-enrollment/redeem。
 * - 业务端口：要求 clientAuth 证书，提供 activate/login/me。
 * - 不连接任何真实云端、账户、旧 18443 探针，也不读写真实素材库。
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

async function makeServerCert(dir, ca, san = "IP:127.0.0.1,DNS:localhost") {
  const key = path.join(dir, "server.key");
  const csr = path.join(dir, "server.csr");
  const crt = path.join(dir, "server.crt");
  const ext = path.join(dir, "server.ext");
  await fs.writeFile(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
  await openssl(["req", "-newkey", "rsa:2048", "-nodes", "-sha256", "-keyout", key, "-out", csr, "-subj", "/CN=localhost"]);
  await openssl([
    "x509", "-req", "-in", csr, "-CA", ca.crt, "-CAkey", ca.key, "-CAcreateserial",
    "-out", crt, "-days", "2", "-sha256", "-extfile", ext,
  ]);
  return { key, crt };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error("too large");
        error.code = "TOO_LARGE";
        req.destroy(error);
        return reject(error);
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const json = (res, status, value, headers = {}) => {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length), ...headers });
  res.end(body);
};

export async function startEnrollmentMock({ san = "IP:127.0.0.1,DNS:localhost" } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shiguang-enroll-mock-"));
  const ca = await makeCa(dir, "ca", "Shiguang Enrollment Test CA");
  const server = await makeServerCert(dir, ca, san);
  const dummyKey = path.join(dir, "dummy.key");
  await openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", dummyKey]);

  const state = {
    dir,
    requests: 0,
    redeemCalls: [],
    bindings: new Map(), // codeHash -> { publicKeyHash, deviceName, deviceId, certPem, activated, accountId, activationToken }
    accounts: new Map(),
    accessTokens: new Map(),
    failNext: null,
    delayMs: 0,
    dropNextResponse: false,
    redirectNext: false,
    oversizeNext: false,
    truncateNext: false,
    noLengthNext: false,
    closed: false,
  };
  const deviceCounter = { n: 0 };

  function addAccount({ username, password, displayName, stateName = "ACTIVE", accountId = `acct-${username}` }) {
    state.accounts.set(username, { username, password, displayName, state: stateName, accountId });
  }
  addAccount({ username: "alice", password: "correct horse battery staple", displayName: "爱丽丝", stateName: "PENDING" });
  addAccount({ username: "bob", password: "bob password 123456", displayName: "鲍勃" });

  async function signClientCert(publicKeyPem, deviceId) {
    const pub = path.join(dir, `pub-${deviceId}.pem`);
    const csr = path.join(dir, `csr-${deviceId}.csr`);
    const crt = path.join(dir, `client-${deviceId}.crt`);
    const ext = path.join(dir, `client-${deviceId}.ext`);
    await fs.writeFile(pub, publicKeyPem, { mode: 0o600 });
    await fs.writeFile(ext, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
    await openssl(["req", "-new", "-key", dummyKey, "-subj", `/CN=${deviceId}`, "-out", csr]);
    await openssl([
      "x509", "-req", "-in", csr, "-force_pubkey", pub, "-CA", ca.crt, "-CAkey", ca.key,
      "-set_serial", `0x${crypto.randomBytes(8).toString("hex")}`, "-days", "30", "-sha256",
      "-extfile", ext, "-out", crt,
    ]);
    return fs.readFile(crt, "utf8");
  }

  const enrollment = https.createServer({ key: await fs.readFile(server.key), cert: await fs.readFile(server.crt) });
  enrollment.on("request", async (req, res) => {
    if (req.method !== "POST" || req.url !== "/api/v1/device-enrollment/redeem")
      return json(res, 404, { code: "NOT_FOUND" });
    state.requests += 1;
    if (state.noLengthNext || req.headers["content-length"] === undefined) {
      state.noLengthNext = false;
      return json(res, 413, { code: "INVALID_REQUEST" });
    }
    const length = Number(req.headers["content-length"]);
    if (!Number.isFinite(length) || length <= 0 || length > 16 * 1024) return json(res, 413, { code: "INVALID_REQUEST" });
    let body;
    try {
      body = JSON.parse((await readBody(req, 16 * 1024)).toString("utf8"));
    } catch {
      return json(res, 400, { code: "INVALID_REQUEST" });
    }
    state.redeemCalls.push({ openingCode: body.openingCode, deviceName: body.deviceName, publicKeyPem: body.publicKeyPem });

    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.closed) return;
    if (state.failNext) {
      const { status, code } = state.failNext;
      state.failNext = null;
      const headers = status === 429 ? { "retry-after": "7" } : {};
      return json(res, status, { code }, headers);
    }
    if (state.redirectNext) {
      state.redirectNext = false;
      res.writeHead(302, { location: "https://127.0.0.1:1/elsewhere", "content-length": "0" });
      return res.end();
    }
    if (state.oversizeNext) {
      state.oversizeNext = false;
      const huge = "x".repeat(200 * 1024);
      res.writeHead(200, { "content-type": "application/json", "content-length": String(huge.length) });
      return res.end(huge);
    }
    if (state.truncateNext) {
      state.truncateNext = false;
      res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      res.write('{"code":"OK","data":{');
      return setTimeout(() => res.destroy(), 10);
    }

    const openingCode = body.openingCode;
    const publicKeyPem = body.publicKeyPem;
    const signature = body.signature;
    const deviceName = String(body.deviceName || "").trim();
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(publicKeyPem);
    } catch {
      return json(res, 400, { code: "INVALID_REQUEST" });
    }
    const publicKeyHash = crypto.createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const canonical = `shiguang-device-enrollment-v1\n${openingCode}\n${publicKeyHash}\n${deviceName}`;
    let validSignature = false;
    try {
      validSignature = crypto.verify("sha256", Buffer.from(canonical, "utf8"), publicKey, Buffer.from(String(signature || ""), "base64"));
    } catch {
      validSignature = false;
    }
    if (!validSignature) return json(res, 401, { code: "UNAUTHORIZED" });

    const account = state.accounts.get("alice");
    const codeHash = crypto.createHash("sha256").update(String(openingCode)).digest("hex");
    let binding = state.bindings.get(codeHash);
    if (binding) {
      if (binding.publicKeyHash !== publicKeyHash || binding.deviceName !== deviceName)
        return json(res, 401, { code: "UNAUTHORIZED" });
      // PENDING 重试：废弃旧激活凭证，返回新的；已激活后不再返回激活凭证。
      if (account.state === "PENDING") binding.activationToken = b64url(crypto.randomBytes(24));
      else binding.activationToken = null;
      binding.activated = account.state !== "PENDING";
    } else {
      if (state.closed) return;
      deviceCounter.n += 1;
      const deviceId = `device-${deviceCounter.n}`;
      const certPem = await signClientCert(publicKeyPem, deviceId);
      binding = {
        publicKeyHash,
        deviceName,
        deviceId,
        certPem,
        accountId: account.accountId,
        activated: account.state !== "PENDING",
        activationToken: account.state === "PENDING" ? b64url(crypto.randomBytes(24)) : null,
      };
      state.bindings.set(codeHash, binding);
    }

    const data = {
      accountId: binding.accountId,
      username: account.username,
      deviceId: binding.deviceId,
      certificateChainPem: `${binding.certPem}\n${await fs.readFile(ca.crt, "utf8")}`,
      certificateExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      activationToken: binding.activationToken,
      activationExpiresAt: binding.activationToken ? new Date(Date.now() + 3600_000).toISOString() : null,
      needsActivation: account.state === "PENDING",
    };
    if (state.dropNextResponse) {
      state.dropNextResponse = false;
      return req.socket.destroy();
    }
    json(res, 200, { code: "OK", data });
  });

  const business = https.createServer(
    {
      key: await fs.readFile(server.key),
      cert: await fs.readFile(server.crt),
      ca: await fs.readFile(ca.crt),
      requestCert: true,
      rejectUnauthorized: true,
    },
    async (req, res) => {
      const peer = req.socket.getPeerCertificate();
      if (!peer || !peer.subject?.CN) return json(res, 401, { code: "UNAUTHORIZED" });
      const deviceId = peer.subject.CN;
      const binding = [...state.bindings.values()].find((b) => b.deviceId === deviceId);
      if (!binding) return json(res, 401, { code: "UNAUTHORIZED" });

      let body = {};
      if (req.method === "POST") {
        try {
          body = JSON.parse((await readBody(req, 32 * 1024)).toString("utf8") || "{}");
        } catch {
          return json(res, 400, { code: "INVALID_REQUEST" });
        }
      }
      const account = state.accounts.get(binding.username || "alice");
      if (req.url === "/api/v1/auth/activate") {
        if (!binding.activationToken || body.activationToken !== binding.activationToken)
          return json(res, 401, { code: "UNAUTHORIZED" });
        if (typeof body.password !== "string" || body.password.length < 12)
          return json(res, 400, { code: "INVALID_REQUEST" });
        account.password = body.password;
        account.state = "ACTIVE";
        binding.activationToken = null;
        return json(res, 200, { code: "OK", data: issueTokens(account, deviceId) });
      }
      if (req.url === "/api/v1/auth/login") {
        if (account.state !== "ACTIVE" || body.username !== account.username || body.password !== account.password)
          return json(res, 401, { code: "UNAUTHORIZED" });
        return json(res, 200, { code: "OK", data: issueTokens(account, deviceId) });
      }
      if (req.url === "/api/v1/me") {
        const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const session = state.accessTokens.get(token);
        if (!session) return json(res, 401, { code: "UNAUTHORIZED" });
        return json(res, 200, {
          code: "OK",
          data: {
            username: account.username,
            displayName: account.displayName,
            accountId: account.accountId,
            deviceId,
            sessionId: session.sessionId,
            superAdmin: false,
          },
        });
      }
      if (req.url === "/api/v1/auth/logout") return json(res, 200, { code: "OK", data: {} });
      return json(res, 404, { code: "NOT_FOUND" });
    },
  );

  function issueTokens(account, deviceId) {
    const accessToken = b64url(crypto.randomBytes(24));
    const refreshToken = b64url(crypto.randomBytes(24));
    const sessionId = `sess-${crypto.randomBytes(4).toString("hex")}`;
    state.accessTokens.set(accessToken, { sessionId });
    return {
      accessToken,
      refreshToken,
      expiresIn: 3600,
      refreshExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      deviceId,
    };
  }

  await Promise.all([
    new Promise((resolve) => enrollment.listen(0, "127.0.0.1", resolve)),
    new Promise((resolve) => business.listen(0, "127.0.0.1", resolve)),
  ]);
  const enrollmentPort = enrollment.address().port;
  const businessPort = business.address().port;
  return {
    caCert: ca.crt,
    caKey: ca.key,
    apiOrigin: `https://127.0.0.1:${businessPort}`,
    enrollmentOrigin: `https://127.0.0.1:${enrollmentPort}`,
    serverCaPem: await fs.readFile(ca.crt, "utf8"),
    deviceCaPem: await fs.readFile(ca.crt, "utf8"),
    state,
    addAccount,
    getUser: (name) => state.accounts.get(name),
    setFailNext: (status, code) => (state.failNext = { status, code }),
    setDelayMs: (ms) => (state.delayMs = ms),
    dropNextResponse: () => (state.dropNextResponse = true),
    redirectNext: () => (state.redirectNext = true),
    oversizeNext: () => (state.oversizeNext = true),
    truncateNext: () => (state.truncateNext = true),
    noLengthNext: () => (state.noLengthNext = true),
    async close() {
      state.closed = true;
      await Promise.all([
        new Promise((resolve) => enrollment.close(resolve)),
        new Promise((resolve) => business.close(resolve)),
      ]);
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
