/**
 * 音频分析引擎安装器（T-LOCAL-012）。
 *
 * 安全边界：
 * - 只信任应用内固定发布描述（版本/平台/URL/大小/hash），HTTP 与环境变量不能替换；
 * - 只支持 darwin-arm64；固定公开 CA，严格 TLS，不跟随重定向；
 * - 流式下载，长度/字节/hash 三重校验，空闲超时 + 总截止 + 显式取消；
 * - 复用成熟 tar-stream 解析，只允许白名单普通文件，拒绝链接/设备/PAX 路径；
 * - 安装/取消/卸载共享跨进程锁与单一状态机，先提交新版本再切换指针，旧版本保留到提交成功；
 * - 状态只读本地可信标记，错误返回固定码，不泄露本地路径/令牌/原始异常。
 */
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { createGunzip } from "node:zlib";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import tar from "tar-stream";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CA_FILE = path.join(HERE, "audio-engine-ca.pem");
const MiB = 1024 * 1024;
/** 安装器私有临时目录前缀；只有同时通过 owner 标记校验的同前缀目录才可清理。 */
const TMP_JOB_PREFIX = "audio-installer-job-";
const TMP_OWNER_FILE = ".owner.json";
const TMP_OWNER_KIND = "shiguang-audio-installer";
/** 标记/锁 owner 等本机元数据文件的有界读取上限。 */
const MAX_METADATA_BYTES = 4 * 1024;
/** tar 头/PAX/GNU 元数据/padding 的小额固定预算，超过 extractedMaxBytes 后仍受此上限约束。 */
const TAR_METADATA_ALLOWANCE = 64 * 1024;

/** 应用内固定发布描述；生产路径不允许环境变量/浏览器覆盖。 */
export const ENGINE_RELEASE = Object.freeze({
  id: "audio-engine-v1-macos-arm64",
  version: "1.0.0",
  platform: "darwin",
  arch: "arm64",
  url: "https://112.74.109.173/downloads/audio-engine-v1-macos-arm64.tar.gz",
  size: 120156053,
  sha256: "61911f96c26a5cda6aae214fcde622d952729d48475754902d42905bedc7413e",
  archiveMaxBytes: 130 * MiB,
  extractedMaxBytes: 256 * MiB,
  maxEntries: 8,
  binary: "audio-analyze",
});

const CODES = {
  UNSUPPORTED_PLATFORM: "UNSUPPORTED_PLATFORM",
  CONFIRM_REQUIRED: "ENGINE_CONFIRM_REQUIRED",
  BUSY: "ENGINE_BUSY",
  DISK_SPACE_LOW: "ENGINE_DISK_SPACE_LOW",
  HTTP_STATUS: "ENGINE_HTTP_STATUS",
  CONTENT_ENCODING: "ENGINE_CONTENT_ENCODING",
  LENGTH_MISMATCH: "ENGINE_LENGTH_MISMATCH",
  HASH_MISMATCH: "ENGINE_HASH_MISMATCH",
  TIMEOUT: "ENGINE_TIMEOUT",
  CANCELLED: "ENGINE_CANCELLED",
  TLS_FAILED: "ENGINE_TLS_FAILED",
  DOWNLOAD_FAILED: "ENGINE_DOWNLOAD_FAILED",
  WRITE_FAILED: "ENGINE_WRITE_FAILED",
  ARCHIVE_INVALID: "ENGINE_ARCHIVE_INVALID",
  ARCHIVE_UNSAFE: "ENGINE_ARCHIVE_UNSAFE",
  ARCHIVE_TOO_LARGE: "ENGINE_ARCHIVE_TOO_LARGE",
  UNSAFE_TARGET: "ENGINE_UNSAFE_TARGET",
  COMMIT_FAILED: "ENGINE_COMMIT_FAILED",
  INSTALL_FAILED: "ENGINE_INSTALL_FAILED",
  LOCK_FAILED: "ENGINE_LOCK_FAILED",
};

const MESSAGES = {
  [CODES.UNSUPPORTED_PLATFORM]: "当前平台不支持音频引擎安装",
  [CODES.CONFIRM_REQUIRED]: "需要明确确认后才能安装",
  [CODES.BUSY]: "安装器正忙，请稍后重试",
  [CODES.DISK_SPACE_LOW]: "磁盘空间不足",
  [CODES.HTTP_STATUS]: "下载服务器响应异常",
  [CODES.CONTENT_ENCODING]: "下载响应包含不支持的压缩编码",
  [CODES.LENGTH_MISMATCH]: "下载大小与发布描述不一致",
  [CODES.HASH_MISMATCH]: "安装包校验失败",
  [CODES.TIMEOUT]: "下载超时",
  [CODES.CANCELLED]: "安装已取消",
  [CODES.TLS_FAILED]: "下载服务器证书校验失败",
  [CODES.DOWNLOAD_FAILED]: "下载失败",
  [CODES.WRITE_FAILED]: "写入安装临时文件失败",
  [CODES.ARCHIVE_INVALID]: "安装包格式无效",
  [CODES.ARCHIVE_UNSAFE]: "安装包包含不安全内容",
  [CODES.ARCHIVE_TOO_LARGE]: "安装包展开超出限制",
  [CODES.UNSAFE_TARGET]: "安装目录不安全",
  [CODES.COMMIT_FAILED]: "安装提交失败",
  [CODES.INSTALL_FAILED]: "安装失败",
  [CODES.LOCK_FAILED]: "无法获取安装锁",
};

export class AudioEngineError extends Error {
  constructor(code, message = MESSAGES[code] || MESSAGES[CODES.INSTALL_FAILED], status) {
    super(message);
    this.name = "AudioEngineError";
    this.code = code;
    this.status = status || statusForCode(code);
  }
}

export function isAudioEngineError(error) {
  return error instanceof AudioEngineError;
}

function statusForCode(code) {
  if (code === CODES.CONFIRM_REQUIRED) return 400;
  if (code === CODES.BUSY || code === CODES.UNSUPPORTED_PLATFORM) return 409;
  if (code === CODES.DISK_SPACE_LOW) return 507;
  return 400;
}

function safeRelease(release) {
  const merged = { ...ENGINE_RELEASE, ...release };
  for (const key of ["version", "platform", "arch", "url", "sha256", "binary", "id"]) {
    if (typeof merged[key] !== "string" || !merged[key]) throw new Error(`发布描述缺少 ${key}`);
  }
  if (!/^[0-9a-f]{64}$/.test(merged.sha256)) throw new Error("发布描述 hash 无效");
  for (const key of ["size", "archiveMaxBytes", "extractedMaxBytes", "maxEntries"]) {
    if (!Number.isSafeInteger(merged[key]) || merged[key] <= 0) throw new Error(`发布描述 ${key} 无效`);
  }
  if (merged.size > merged.archiveMaxBytes) throw new Error("发布描述大小超过归档上限");
  const tarCeiling = merged.extractedMaxBytes + TAR_METADATA_ALLOWANCE;
  if (!Number.isSafeInteger(tarCeiling)) throw new Error("发布描述展开上限过大");
  if (merged.tarMaxBytes === undefined) merged.tarMaxBytes = tarCeiling;
  else merged.tarMaxBytes = Math.min(merged.tarMaxBytes, tarCeiling);
  if (!Number.isSafeInteger(merged.tarMaxBytes) || merged.tarMaxBytes <= merged.extractedMaxBytes) {
    throw new Error("发布描述 tarMaxBytes 无效");
  }
  return Object.freeze(merged);
}

export class AudioEngine {
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.release = safeRelease(options.release);
    this.platform = options.platform || process.platform;
    this.arch = options.arch || process.arch;
    this.ca = options.ca !== undefined ? options.ca : fssync.readFileSync(DEFAULT_CA_FILE);
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30_000;
    this.totalTimeoutMs = options.totalTimeoutMs ?? 600_000;
    this.diskReserveBytes = options.diskReserveBytes ?? 64 * MiB;
    this.diskFreeBytes = options.diskFreeBytes; // 仅测试注入；生产用 statfs
    this.hooks = options.hooks || {};

    this.engineRoot = path.join(dataDir, "engines", "audio");
    this.versionsRoot = path.join(this.engineRoot, "versions");
    this.tmpRoot = path.join(dataDir, "engines", ".tmp");
    this.enginesRoot = path.join(dataDir, "engines");
    this.lockRoot = path.join(this.enginesRoot, ".audio-install.lock");

    this.job = null;
    this._jobSeq = 0;
    this._state = "idle";
    this._runPromise = null;
    this._cancelRequested = false;
    this._abort = null;

    this.agent = new https.Agent({
      keepAlive: true,
      maxSockets: 1,
      maxFreeSockets: 1,
      timeout: this.idleTimeoutMs,
      scheduling: "lifo",
    });
  }

  /** 已安装版本；只从可信指针 + 安装标记读取。 */
  get version() {
    return this.#installedInfo()?.version ?? null;
  }

  /** 分析器内部使用的二进制路径；未通过可信链校验时返回 null，不提供越界路径。 */
  get binaryPath() {
    return this.#installedInfo()?.binaryPath ?? null;
  }

  status() {
    const info = this.#installedInfo();
    return {
      installed: !!info,
      version: info?.version ?? null,
      path: null,
      size: info?.size ?? 0,
      job: this.job ? cloneJob(this.job) : null,
      expected: {
        version: this.release.version,
        platform: this.release.platform,
        arch: this.release.arch,
        size: this.release.size,
        sha256: this.release.sha256,
      },
    };
  }

  /**
   * 开始安装。必须显式 confirm:true；同一时刻只允许一个安装/取消/卸载。
   * 返回当前状态（job 可能仍在 downloading），不等待完成。
   */
  install({ confirm } = {}) {
    if (confirm !== true) throw new AudioEngineError(CODES.CONFIRM_REQUIRED);
    if (this.platform !== this.release.platform || this.arch !== this.release.arch) {
      throw new AudioEngineError(CODES.UNSUPPORTED_PLATFORM);
    }
    if (this._state !== "idle") throw new AudioEngineError(CODES.BUSY);
    if (this.#peekLockBusy()) throw new AudioEngineError(CODES.BUSY);

    const current = this.#installedInfo();
    if (current && current.version === this.release.version && current.releaseSha256 === this.release.sha256) {
      return this.status();
    }

    this._state = "busy";
    this._cancelRequested = false;
    const id = crypto.randomBytes(12).toString("hex");
    this.job = {
      id,
      state: "queued",
      bytes: 0,
      total: this.release.size,
      progress: 0,
      startedAt: new Date().toISOString(),
      error: null,
    };
    this._runPromise = this.#runInstall(id).catch(() => {});
    return this.status();
  }

  /** 取消当前任务；等待临时目录/网络/锁全部清理后才返回。 */
  async cancel() {
    const running = this._runPromise;
    if (!running) return this.status();
    this._cancelRequested = true;
    if (this._abort) this._abort();
    await running;
    if (this.job && this.job.state !== "installed") {
      this.job = {
        ...this.job,
        state: "cancelled",
        progress: 0,
        error: { code: CODES.CANCELLED, message: MESSAGES[CODES.CANCELLED] },
      };
    }
    return this.status();
  }

  /** 卸载；安装中直接 409，不会先卸载再让安装目录冒出来。 */
  async uninstall() {
    if (this._state !== "idle") throw new AudioEngineError(CODES.BUSY);
    this._state = "busy";
    let lock = null;
    try {
      await this.#ensureBaseDirs();
      lock = await this.#acquireLock("uninstall");
      await this.#cleanOwnedTmp();
      const root = await lstatOrNull(this.engineRoot);
      if (!root) {
        this.job = null;
        return this.status();
      }
      if (root.isSymbolicLink() || !root.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
      // 先摘掉指针，再删自己目录；即使中途崩溃也不会让旧版本重新“出现”。
      await unlinkRegular(path.join(this.engineRoot, "current.json"));
      await unlinkRegular(path.join(this.engineRoot, this.release.binary));
      await unlinkRegular(path.join(this.engineRoot, ".installed.json"));
      const versions = await lstatOrNull(this.versionsRoot);
      if (versions) {
        if (versions.isSymbolicLink() || !versions.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
        await fs.rm(this.versionsRoot, { recursive: true, force: true });
      }
      await fs.rm(this.engineRoot, { recursive: true, force: true });
      this.job = null;
      return this.status();
    } finally {
      if (lock) await this.#releaseLock(lock).catch(() => {});
      this._state = "idle";
    }
  }

  /** 测试/进程退出时释放连接池；HTTP 不暴露。 */
  dispose() {
    if (this._abort) this._abort();
    this.agent.destroy();
  }

  async #runInstall(jobId) {
    let tmpDir = null;
    let staging = null;
    let lock = null;
    let terminalState = null;
    let terminalError = null;
    try {
      await this.#ensureBaseDirs();
      lock = await this.#acquireLock(jobId);
      await this.#cleanOwnedTmp();
      await this.#checkDiskSpace();

      this.#setJobState("downloading");
      tmpDir = await fs.mkdtemp(path.join(this.tmpRoot, TMP_JOB_PREFIX));
      await fs.chmod(tmpDir, 0o700);
      await this.#writeTmpOwner(tmpDir, jobId);
      const archive = path.join(tmpDir, "release.tar.gz");
      const downloaded = await this.#download(archive);
      this._abort = null;

      this.#throwIfCancelled();
      this.#setJobState("verifying");
      const stat = await fs.lstat(archive);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== this.release.size) {
        throw new AudioEngineError(CODES.LENGTH_MISMATCH);
      }
      if (downloaded.sha256 !== this.release.sha256) throw new AudioEngineError(CODES.HASH_MISMATCH);

      this.#throwIfCancelled();
      this.#setJobState("extracting");
      staging = path.join(tmpDir, "staging");
      await fs.mkdir(staging, { mode: 0o700 });
      await this.#extract(archive, staging);
      this._abort = null;
      if (this.hooks.afterExtract) await this.hooks.afterExtract({ staging, tmpDir });
      this.#throwIfCancelled();

      const binary = path.join(staging, this.release.binary);
      const binaryStat = await fs.lstat(binary);
      if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) throw new AudioEngineError(CODES.ARCHIVE_UNSAFE);
      if (binaryStat.size <= 0 || binaryStat.size > this.release.extractedMaxBytes) {
        throw new AudioEngineError(CODES.ARCHIVE_TOO_LARGE);
      }
      await fs.chmod(binary, 0o755);

      if (this.hooks.beforeCommit) await this.hooks.beforeCommit({ staging, tmpDir });
      this.#throwIfCancelled();
      this.#setJobState("installing");
      await this.#commit(staging, jobId);
      staging = null;
      terminalState = "installed";
    } catch (error) {
      const normalized = normalizeError(error, this._cancelRequested);
      terminalState = normalized.code === CODES.CANCELLED ? "cancelled" : "error";
      terminalError = { code: normalized.code, message: normalized.message };
      console.error(`[audio-engine] ${normalized.code}`);
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      if (lock) await this.#releaseLock(lock).catch(() => {});
      // 清理完成后再公布终态，避免测试/调用方看到 error 时锁还没释放。
      this.job = {
        ...(this.job || { id: jobId, total: this.release.size, bytes: 0 }),
        state: terminalState || "error",
        bytes: terminalState === "installed" ? this.release.size : this.job?.bytes || 0,
        total: this.release.size,
        progress: terminalState === "installed" ? 100 : 0,
        error: terminalError,
      };
      this._cancelRequested = false;
      this._abort = null;
      this._runPromise = null;
      this._state = "idle";
    }
  }

  #throwIfCancelled() {
    if (this._cancelRequested) throw new AudioEngineError(CODES.CANCELLED);
  }

  #setJobState(state) {
    if (!this.job) return;
    this.job = { ...this.job, state };
  }

  async #checkDiskSpace() {
    const free = await this.#freeBytes();
    const required = this.release.size * 2 + this.diskReserveBytes;
    if (!Number.isFinite(free) || free < required) throw new AudioEngineError(CODES.DISK_SPACE_LOW);
  }

  async #freeBytes() {
    if (typeof this.diskFreeBytes === "function") return await this.diskFreeBytes();
    if (typeof this.diskFreeBytes === "number") return this.diskFreeBytes;
    const stats = await fs.statfs(this.dataDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  async #ensureBaseDirs() {
    await fs.mkdir(this.enginesRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.#assertOwnedDir(this.enginesRoot);
    await fs.mkdir(this.engineRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.#assertOwnedDir(this.engineRoot);
    await fs.mkdir(this.tmpRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.#assertOwnedDir(this.tmpRoot);
  }

  async #assertOwnedDir(dir) {
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
  }

  async #cleanOwnedTmp() {
    // engines/.tmp 可能与其它引擎/任务共享。只处理本安装器前缀的私有任务目录，
    // 且必须同时满足：非链接目录 + owner 标记格式有效 + 记录进程已死。
    // 未知目录、无标记目录、仍存活的进程目录一律保留（fail-closed）。
    const entries = await fs.readdir(this.tmpRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.name.startsWith(TMP_JOB_PREFIX)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const dir = path.join(this.tmpRoot, entry.name);
      const owner = await readTmpOwner(dir);
      if (!owner) continue;
      if (isProcessAlive(owner.pid)) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #writeTmpOwner(dir, jobId) {
    const owner = {
      kind: TMP_OWNER_KIND,
      pid: process.pid,
      jobId,
      token: crypto.randomBytes(16).toString("hex"),
      startedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(dir, TMP_OWNER_FILE), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  }

  #download(dest) {
    const release = this.release;
    const url = new URL(release.url);
    if (url.protocol !== "https:") throw new AudioEngineError(CODES.HTTP_STATUS);

    return new Promise((resolve, reject) => {
      let settled = false;
      let received = 0;
      let req = null;
      let res = null;
      let out = null;
      let totalTimer = null;
      const hash = crypto.createHash("sha256");

      const cleanup = () => {
        if (totalTimer) clearTimeout(totalTimer);
        if (req) {
          try {
            req.setTimeout(0);
          } catch {}
          req.destroy();
        }
        if (res) res.destroy();
        if (out) out.destroy();
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      };
      const fail = (code, message) => finish(new AudioEngineError(code, message));

      this._abort = () => {
        fail(CODES.CANCELLED);
      };

      try {
        req = https.request(
          url,
          {
            method: "GET",
            agent: this.agent,
            ca: this.ca,
            rejectUnauthorized: true,
            timeout: this.idleTimeoutMs,
            headers: {
              accept: "application/octet-stream",
              "accept-encoding": "identity",
              "user-agent": "shiguang-audio-installer/1",
            },
          },
          (response) => {
            res = response;
            if (this._cancelRequested) return fail(CODES.CANCELLED);
            if (res.statusCode !== 200) {
              res.resume();
              return fail(CODES.HTTP_STATUS);
            }
            const encoding = String(res.headers["content-encoding"] || "").toLowerCase();
            if (encoding && encoding !== "identity") return fail(CODES.CONTENT_ENCODING);
            const transfer = String(res.headers["transfer-encoding"] || "").toLowerCase();
            if (transfer && transfer !== "identity") return fail(CODES.LENGTH_MISMATCH);
            const rawLength = String(res.headers["content-length"] ?? "");
            if (!/^\d+$/.test(rawLength)) return fail(CODES.LENGTH_MISMATCH);
            const total = Number(rawLength);
            if (!Number.isSafeInteger(total) || total !== release.size || total > release.archiveMaxBytes) {
              return fail(CODES.LENGTH_MISMATCH);
            }
            this.job = { ...this.job, total, bytes: 0, progress: 0 };

            out = fssync.createWriteStream(dest, { flags: "wx", mode: 0o600 });
            out.on("error", (error) => {
              if (error.code === "ENOSPC") fail(CODES.DISK_SPACE_LOW);
              else fail(CODES.WRITE_FAILED);
            });

            res.on("data", (chunk) => {
              if (settled) return;
              received += chunk.length;
              if (received > release.size) return fail(CODES.LENGTH_MISMATCH);
              hash.update(chunk);
              this.job = {
                ...this.job,
                bytes: received,
                progress: Math.min(99, Math.floor((received / total) * 100)),
              };
            });
            res.on("aborted", () => fail(CODES.DOWNLOAD_FAILED));
            res.on("error", () => fail(CODES.DOWNLOAD_FAILED));
            res.pipe(out);
            out.on("finish", () => {
              if (settled) return;
              if (received !== release.size) return fail(CODES.LENGTH_MISMATCH);
              finish(null, { sha256: hash.digest("hex"), bytes: received });
            });
          },
        );
        req.on("timeout", () => fail(CODES.TIMEOUT));
        req.on("error", (error) => {
          if (this._cancelRequested) return fail(CODES.CANCELLED);
          const raw = String(error?.code || "");
          if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ERR_TLS/.test(raw)) {
            return fail(CODES.TLS_FAILED);
          }
          return fail(CODES.DOWNLOAD_FAILED);
        });
        totalTimer = setTimeout(() => fail(CODES.TIMEOUT), this.totalTimeoutMs);
        totalTimer.unref?.();
        req.end();
      } catch {
        fail(CODES.DOWNLOAD_FAILED);
      }
    });
  }

  #extract(archive, staging) {
    const release = this.release;
    const allowed = new Set([release.binary]);
    const tarLimit = release.tarMaxBytes;

    return new Promise((resolve, reject) => {
      const extractor = tar.extract();
      const read = fssync.createReadStream(archive);
      const gunzip = createGunzip();
      // tar-stream 在触发 entry 之前会先缓冲 PAX/GNU 扩展头；只在 entry 回调里统计
      // header.size 会漏掉这些元数据。这里在 gunzip 之后、parser 之前按“解压后的
      // tar 总字节数”设硬上限，包含头/元数据/padding，并只给固定的小额开销。
      let tarBytes = 0;
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          tarBytes += chunk.length;
          if (tarBytes > tarLimit) return callback(new AudioEngineError(CODES.ARCHIVE_TOO_LARGE));
          callback(null, chunk);
        },
      });
      const seen = new Set();
      let count = 0;
      let expanded = 0;
      let failed = false;

      const fail = (code) => {
        if (failed) return;
        failed = true;
        counter.destroy();
        gunzip.destroy();
        extractor.destroy();
        read.destroy();
        reject(new AudioEngineError(code));
      };
      this._abort = () => fail(CODES.CANCELLED);

      extractor.on("entry", (header, stream, next) => {
        if (failed) {
          stream.resume();
          return next();
        }
        count += 1;
        if (count > release.maxEntries) return fail(CODES.ARCHIVE_TOO_LARGE);
        if (!header || header.type !== "file" || header.linkname || header.sparse) {
          stream.resume();
          return fail(CODES.ARCHIVE_UNSAFE);
        }
        let name;
        try {
          name = validateEntryName(header.name);
          validatePax(header);
        } catch {
          stream.resume();
          return fail(CODES.ARCHIVE_UNSAFE);
        }
        if (!allowed.has(name) || seen.has(name)) {
          stream.resume();
          return fail(CODES.ARCHIVE_UNSAFE);
        }
        seen.add(name);
        if (!Number.isSafeInteger(header.size) || header.size < 0) {
          stream.resume();
          return fail(CODES.ARCHIVE_INVALID);
        }
        if (expanded + header.size > release.extractedMaxBytes) {
          stream.resume();
          return fail(CODES.ARCHIVE_TOO_LARGE);
        }
        expanded += header.size;

        let written = 0;
        const target = path.join(staging, name);
        const out = fssync.createWriteStream(target, { flags: "wx", mode: 0o600 });
        stream.on("data", (chunk) => {
          written += chunk.length;
          if (written > header.size || expanded > release.extractedMaxBytes) fail(CODES.ARCHIVE_TOO_LARGE);
        });
        out.on("error", () => fail(CODES.WRITE_FAILED));
        pipeline(stream, out)
          .then(() => {
            if (failed) return;
            if (written !== header.size) return fail(CODES.ARCHIVE_INVALID);
            next();
          })
          .catch(() => fail(CODES.ARCHIVE_INVALID));
      });

      extractor.on("finish", () => {
        if (failed) return;
        if (!seen.has(release.binary)) return fail(CODES.ARCHIVE_INVALID);
        resolve();
      });
      extractor.on("error", () => fail(CODES.ARCHIVE_INVALID));
      gunzip.on("error", () => fail(CODES.ARCHIVE_INVALID));
      counter.on("error", () => fail(CODES.ARCHIVE_TOO_LARGE));
      read.on("error", () => fail(CODES.ARCHIVE_INVALID));
      read.pipe(gunzip).pipe(counter).pipe(extractor);
      if (this.hooks.extracting) {
        try {
          this.hooks.extracting({ tarLimit });
        } catch {
          fail(CODES.INSTALL_FAILED);
        }
      }
    });
  }

  async #commit(staging, jobId) {
    const release = this.release;
    const versions = await this.#ensureVersionsDir();
    const dirName = `${sanitizeSegment(release.version)}-${release.sha256.slice(0, 12)}`;
    const finalDir = path.join(versions, dirName);
    let created = null;
    try {
      const existing = await lstatOrNull(finalDir);
      if (existing) {
        if (existing.isSymbolicLink() || !existing.isDirectory()) throw new AudioEngineError(CODES.UNSAFE_TARGET);
        await fs.rm(finalDir, { recursive: true, force: true });
      }
      await fs.rename(staging, finalDir);
      created = finalDir;
      const marker = {
        version: release.version,
        releaseSha256: release.sha256,
        archiveBytes: release.size,
        binary: release.binary,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(finalDir, ".installed.json"), JSON.stringify(marker), { mode: 0o600 });
      const pointer = {
        version: release.version,
        dir: dirName,
        binary: release.binary,
        releaseSha256: release.sha256,
        size: release.size,
        installedAt: marker.installedAt,
      };
      const tmpPointer = path.join(this.engineRoot, `.current-${jobId}.tmp`);
      await fs.writeFile(tmpPointer, JSON.stringify(pointer), { mode: 0o600 });
      await fs.rename(tmpPointer, path.join(this.engineRoot, "current.json"));
      created = null;
      // 新版本已提交；旧版平铺文件清理失败不能反过来把已提交的新版本判为失败。
      await unlinkRegular(path.join(this.engineRoot, release.binary)).catch(() => {});
      await unlinkRegular(path.join(this.engineRoot, ".installed.json")).catch(() => {});
    } catch (error) {
      if (created) await fs.rm(created, { recursive: true, force: true }).catch(() => {});
      if (isAudioEngineError(error)) throw error;
      throw new AudioEngineError(CODES.COMMIT_FAILED);
    }
  }

  async #ensureVersionsDir() {
    if (!(await this.#isTrustedDir(this.enginesRoot)) || !(await this.#isTrustedDir(this.engineRoot))) {
      throw new AudioEngineError(CODES.UNSAFE_TARGET);
    }
    await fs.mkdir(this.versionsRoot, { recursive: true, mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await this.#isTrustedDir(this.versionsRoot))) throw new AudioEngineError(CODES.UNSAFE_TARGET);
    return this.versionsRoot;
  }

  async #isTrustedDir(target) {
    const stat = await lstatOrNull(target);
    return !!stat && !stat.isSymbolicLink() && stat.isDirectory();
  }

  #installedInfo() {
    const release = this.release;
    // 从 dataDir 往下的每一级祖先都必须是真实目录，不能只检查最终 binary。
    if (!trustedDirSync(this.enginesRoot) || !trustedDirSync(this.engineRoot)) return null;

    const pointerPath = path.join(this.engineRoot, "current.json");
    const pointerStat = lstatOrNullSync(pointerPath);
    if (pointerStat) {
      // 指针存在就必须可信；损坏/链接/超限一律视为未安装，不静默回退到 legacy。
      if (pointerStat.isSymbolicLink() || !pointerStat.isFile() || pointerStat.size > MAX_METADATA_BYTES) return null;
      const pointer = readSmallJsonSync(pointerPath, MAX_METADATA_BYTES);
      if (!pointer || typeof pointer !== "object") return null;
      if (
        !isSafeDirName(pointer.dir) ||
        pointer.binary !== release.binary ||
        typeof pointer.version !== "string" ||
        pointer.version.length === 0 ||
        pointer.version.length > 128 ||
        typeof pointer.releaseSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(pointer.releaseSha256)
      ) {
        return null;
      }
      if (!trustedDirSync(this.versionsRoot)) return null;
      const dir = path.join(this.versionsRoot, pointer.dir);
      if (!trustedDirSync(dir)) return null;
      const binary = path.join(dir, pointer.binary);
      const binaryStat = lstatOrNullSync(binary);
      if (!binaryStat || binaryStat.isSymbolicLink() || !binaryStat.isFile()) return null;
      if (binaryStat.size <= 0 || binaryStat.size > release.extractedMaxBytes) return null;
      const markerPath = path.join(dir, ".installed.json");
      const markerStat = lstatOrNullSync(markerPath);
      if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_METADATA_BYTES) {
        return null;
      }
      const marker = readSmallJsonSync(markerPath, MAX_METADATA_BYTES);
      if (!marker || typeof marker !== "object") return null;
      if (
        marker.version !== pointer.version ||
        marker.releaseSha256 !== pointer.releaseSha256 ||
        marker.binary !== pointer.binary
      ) {
        return null;
      }
      return {
        version: marker.version,
        releaseSha256: marker.releaseSha256,
        size: binaryStat.size,
        binaryPath: binary,
        legacy: false,
      };
    }

    // 兼容旧版平铺安装：只有标记存在、非链接且有界读取、hash 与当前可信发布一致才算可信。
    // 若存在 versionsRoot，也同样要求它是真实目录，不能借未使用的旧路径绕过信任链。
    const legacyVersionsStat = lstatOrNullSync(this.versionsRoot);
    if (legacyVersionsStat && (legacyVersionsStat.isSymbolicLink() || !legacyVersionsStat.isDirectory())) return null;
    const legacyBinary = path.join(this.engineRoot, release.binary);
    const legacyStat = lstatOrNullSync(legacyBinary);
    if (!legacyStat || legacyStat.isSymbolicLink() || !legacyStat.isFile()) return null;
    if (legacyStat.size <= 0 || legacyStat.size > release.extractedMaxBytes) return null;
    const markerPath = path.join(this.engineRoot, ".installed.json");
    const markerStat = lstatOrNullSync(markerPath);
    if (!markerStat || markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size > MAX_METADATA_BYTES) {
      return null;
    }
    const marker = readSmallJsonSync(markerPath, MAX_METADATA_BYTES);
    if (!marker || typeof marker !== "object") return null;
    if (marker.sha256 !== release.sha256 || typeof marker.version !== "string" || marker.version.length === 0) {
      return null;
    }
    if (marker.binary !== undefined && marker.binary !== release.binary) return null;
    return {
      version: marker.version,
      releaseSha256: marker.sha256,
      size: legacyStat.size,
      binaryPath: legacyBinary,
      legacy: true,
    };
  }

  #peekLockBusy() {
    const stat = lstatOrNullSync(this.lockRoot);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return true;
    const owner = readLockOwnerSync(this.lockRoot);
    // 没有可验证 owner 的锁一律视为占用（fail-closed），不再按目录年龄盲删。
    if (!owner) return true;
    return isProcessAlive(owner.pid);
  }

  async #acquireLock(jobId) {
    const token = crypto.randomBytes(16).toString("hex");
    const owner = {
      pid: process.pid,
      jobId,
      token,
      startedAt: new Date().toISOString(),
    };
    // 先在私有目录写完整 owner，再原子 rename 成锁目录：锁一旦可见就带 owner，
    // 消除“mkdir 后、写 owner 前”的无主窗口。
    const creating = path.join(this.enginesRoot, `.audio-install.lock.creating-${process.pid}-${token}`);
    try {
      await fs.mkdir(creating, { mode: 0o700 });
      await fs.writeFile(path.join(creating, "owner.json"), JSON.stringify(owner), { mode: 0o600 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await fs.rename(creating, this.lockRoot);
          return { token };
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].includes(error.code)) {
            throw new AudioEngineError(CODES.LOCK_FAILED);
          }
          const lockStat = await lstatOrNull(this.lockRoot);
          if (!lockStat || lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
            throw new AudioEngineError(CODES.BUSY);
          }
          const other = await readLockOwner(this.lockRoot);
          if (!other || isProcessAlive(other.pid)) throw new AudioEngineError(CODES.BUSY);
          // 回收前再读一次并核对 token，尽量缩小与新建锁的竞争窗口。
          const confirm = await readLockOwner(this.lockRoot);
          if (!confirm || confirm.token !== other.token || isProcessAlive(confirm.pid)) {
            throw new AudioEngineError(CODES.BUSY);
          }
          const stale = `${this.lockRoot}.stale-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
          try {
            await fs.rename(this.lockRoot, stale);
          } catch (renameError) {
            if (renameError.code === "ENOENT") continue;
            throw new AudioEngineError(CODES.LOCK_FAILED);
          }
          await fs.rm(stale, { recursive: true, force: true }).catch(() => {});
        }
      }
      throw new AudioEngineError(CODES.LOCK_FAILED);
    } finally {
      await fs.rm(creating, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #releaseLock(lock) {
    const current = await readLockOwner(this.lockRoot);
    if (!current || current.token !== lock.token) return;
    await fs.rm(this.lockRoot, { recursive: true, force: true });
  }
}

function validateEntryName(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) throw new Error("bad name");
  if (raw.includes("\0") || raw.includes("\\")) throw new Error("bad name");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error("absolute");
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === "." || segment === "..") throw new Error("bad segment");
  }
  return raw;
}

function validatePax(header) {
  const pax = header.pax;
  if (!pax) return;
  for (const [key, value] of Object.entries(pax)) {
    if (key === "path") {
      if (value !== header.name) throw new Error("pax path mismatch");
    } else if (key === "linkpath") {
      throw new Error("pax link");
    } else if (key === "size") {
      if (!/^\d+$/.test(String(value)) || Number(value) !== header.size) throw new Error("pax size");
    } else if (!/^(mtime|atime|ctime|uid|gid|uname|gname)$/.test(key) && !/^(SCHILY|LIBARCHIVE)\.(xattr|acl)\./.test(key)) {
      throw new Error("pax extension");
    }
  }
}

function sanitizeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48) || "engine";
}

function isSafeDirName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
    && value !== "." && value !== "..";
}

function normalizeError(error, cancelled) {
  if (cancelled) return new AudioEngineError(CODES.CANCELLED);
  if (isAudioEngineError(error)) return error;
  if (error?.code === "ENOSPC") return new AudioEngineError(CODES.DISK_SPACE_LOW);
  return new AudioEngineError(CODES.INSTALL_FAILED);
}

function cloneJob(job) {
  return {
    ...job,
    error: job.error ? { ...job.error } : null,
  };
}

function lstatOrNullSync(target) {
  try {
    return fssync.lstatSync(target);
  } catch {
    return null;
  }
}

/** 可信目录：存在、非符号链接、且本身是目录。 */
function trustedDirSync(target) {
  const stat = lstatOrNullSync(target);
  return !!stat && !stat.isSymbolicLink() && stat.isDirectory();
}

/** 只读打开并校验普通文件；O_NOFOLLOW 避免 lstat 后目标被换成链接。 */
function readSmallTextSync(file, maxBytes) {
  let fd;
  try {
    const flags = fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0) | (fssync.constants.O_NONBLOCK || 0);
    fd = fssync.openSync(file, flags);
    const stat = fssync.fstatSync(fd);
    if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fssync.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fssync.closeSync(fd);
      } catch {}
    }
  }
}

function readSmallJsonSync(file, maxBytes = MAX_METADATA_BYTES) {
  try {
    const raw = readSmallTextSync(file, maxBytes);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 安装器私有临时任务的归属标记；格式不完整时视为未知目录，保留不删。 */
function readTmpOwner(dir) {
  const owner = readSmallJsonSync(path.join(dir, TMP_OWNER_FILE));
  if (!owner) return null;
  if (owner.kind !== TMP_OWNER_KIND) return null;
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
  if (typeof owner.token !== "string" || !/^[0-9a-f]{32}$/.test(owner.token)) return null;
  if (typeof owner.jobId !== "string" || owner.jobId.length === 0) return null;
  return owner;
}

function readLockOwnerSync(lockRoot) {
  return sanitizeLockOwner(readSmallJsonSync(path.join(lockRoot, "owner.json")));
}

function sanitizeLockOwner(owner) {
  if (!owner) return null;
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return null;
  if (typeof owner?.token !== "string" || owner.token.length === 0 || owner.token.length > 128) return null;
  return owner;
}

async function readSmallText(file, maxBytes) {
  let handle;
  try {
    const flags = fssync.constants.O_RDONLY | (fssync.constants.O_NOFOLLOW || 0) | (fssync.constants.O_NONBLOCK || 0);
    handle = await fs.open(file, flags);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead <= 0) return null;
      offset += bytesRead;
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

async function unlinkRegular(target) {
  const stat = await lstatOrNull(target);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  await fs.unlink(target);
}

async function readLockOwner(lockRoot) {
  const raw = await readSmallText(path.join(lockRoot, "owner.json"), MAX_METADATA_BYTES);
  if (raw === null) return null;
  try {
    return sanitizeLockOwner(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
