/**
 * T-LOCAL-012 安装器隔离测试夹具：一次性 TLS 证书、回环 HTTPS、合成 tar.gz。
 * 只使用临时目录与本地回环，不访问生产服务器、不下载真实引擎。
 */
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import tar from "tar-stream";

const run = promisify(execFile);

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function tempDir(t, prefix = "shiguang-t12-") {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

/** 生成仅用于本机回环测试的自签 CA/服务器证书（私钥只在临时目录）。 */
export async function makeTlsFixture(t) {
  const dir = await tempDir(t, "shiguang-t12-tls-");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const config = path.join(dir, "openssl.cnf");
  await fs.writeFile(
    config,
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=v3",
      "prompt=no",
      "[dn]",
      "CN=127.0.0.1",
      "[v3]",
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=CA:TRUE",
      "keyUsage=digitalSignature,keyEncipherment,keyCertSign",
      "",
    ].join("\n"),
  );
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-config",
    config,
  ]);
  return {
    dir,
    key: await fs.readFile(key),
    cert: await fs.readFile(cert),
    ca: await fs.readFile(cert),
  };
}

export async function startTlsServer(t, tls, handler) {
  const counts = { connections: 0, handshakes: 0, requests: 0 };
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    counts.requests += 1;
    Promise.resolve(handler(req, res, counts)).catch(() => {
      try {
        res.destroy();
      } catch {}
    });
  });
  server.on("connection", () => {
    counts.connections += 1;
  });
  server.on("secureConnection", () => {
    counts.handshakes += 1;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    server,
    counts,
    url: `https://127.0.0.1:${server.address().port}/engine.tar.gz`,
  };
}

/** 用成熟 tar-stream 生成合成归档；支持 file/symlink/fifo/duplicate/PAX 等负例。 */
export async function makeTar(entries, { gzip = true } = {}) {
  const pack = tar.pack();
  const chunks = [];
  pack.on("data", (chunk) => chunks.push(chunk));
  const ended = once(pack, "end");
  for (const entry of entries) {
    const header = {
      name: entry.name,
      type: entry.type || "file",
      size: entry.data ? entry.data.length : 0,
      mode: entry.mode ?? 0o644,
    };
    if (entry.linkname) header.linkname = entry.linkname;
    if (entry.pax) header.pax = entry.pax;
    await new Promise((resolve, reject) => {
      pack.entry(header, entry.data || Buffer.alloc(0), (error) => (error ? reject(error) : resolve()));
    });
  }
  pack.finalize();
  await ended;
  const raw = Buffer.concat(chunks);
  return gzip ? gzipSync(raw) : raw;
}

export function makeRelease(archive, url, overrides = {}) {
  return {
    id: "test-engine",
    version: "1.0.0-test",
    platform: "darwin",
    arch: "arm64",
    url,
    size: archive.length,
    sha256: sha256(archive),
    archiveMaxBytes: archive.length + 4096,
    extractedMaxBytes: 1024 * 1024,
    maxEntries: 8,
    binary: "audio-analyze",
    ...overrides,
  };
}

export async function waitForJob(engine, { timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = engine.status();
    if (status.job && ["installed", "error", "cancelled"].includes(status.job.state)) return status;
    await delay(10);
  }
  throw new Error(`等待安装任务结束超时：${JSON.stringify(engine.status())}`);
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

export function exists(target) {
  try {
    fssync.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}
