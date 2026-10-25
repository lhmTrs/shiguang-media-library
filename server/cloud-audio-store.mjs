/**
 * T-LOCAL-014B：云端音频后台任务与本地来源记录的私有持久化。
 *
 * 只保存本机需要的最小字段：任务状态、音频/分享 ID、账户/设备身份摘要、
 * 根 ID 与根代际、分类/文件名、长度/SHA-256、错误码与时间戳。
 * 绝不保存 JWT、刷新令牌、私钥、证书口令、云端 URL、请求头或接收器临时路径。
 *
 * 文件位于本机 dataDir，0600，临时文件 + fsync + rename 原子替换；记录数有界。
 * 启动时任何未完成状态（queued/downloading/installing）都标记为 interrupted，
 * 要求用户手动重试，不做自动续传/自动重试。
 */
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const JOB_STATES = Object.freeze([
  "queued",
  "downloading",
  "installing",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const ACTIVE_STATES = new Set(["queued", "downloading", "installing"]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MAX_JOBS = 200;
const MAX_PROVENANCE = 5000;
const MAX_TEXT = 200;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isPlain = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const safeText = (value, max = MAX_TEXT) =>
  typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL_RE.test(value) ? value : "";

function safeId(value) {
  return typeof value === "string" && UUID_RE.test(value) ? value : "";
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** 只保留明确允许的任务字段；未知字段一律丢弃，避免把令牌/路径写进持久文件。 */
function normalizeJob(raw) {
  if (!isPlain(raw)) return null;
  const id = safeId(raw.id);
  const audioId = safeId(raw.audioId);
  const shareId = safeId(raw.shareId);
  const rootId = safeText(raw.rootId, 80);
  if (!id || !audioId || !shareId || !rootId) return null;
  const state = JOB_STATES.includes(raw.state) ? raw.state : "failed";
  const bytes = Number.isSafeInteger(raw.bytes) && raw.bytes > 0 && raw.bytes <= 256_000_000 ? raw.bytes : 0;
  const sha256 = typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256) ? raw.sha256 : "";
  const record = {
    id,
    audioId,
    shareId,
    accountId: safeText(raw.accountId, 80),
    deviceId: safeText(raw.deviceId, 80),
    originHost: safeText(raw.originHost, 255),
    rootId,
    rootName: safeText(raw.rootName, 80),
    rootPath: typeof raw.rootPath === "string" && raw.rootPath.startsWith("/") && raw.rootPath.length <= 1024 && !CONTROL_RE.test(raw.rootPath) ? raw.rootPath : "",
    rootGeneration: safeText(raw.rootGeneration, 128),
    epoch: Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 ? raw.epoch : 0,
    category: safeText(raw.category, 60),
    subcategory: safeText(raw.subcategory, 60),
    fileName: safeText(raw.fileName, 180),
    mediaKind: raw.mediaKind === "MUSIC" || raw.mediaKind === "SFX" ? raw.mediaKind : "",
    bytes,
    sha256,
    mimeType: safeText(raw.mimeType, 80),
    state,
    errorCode: safeText(raw.errorCode, 80),
    assetId: safeText(raw.assetId, 80),
    createdFile: raw.createdFile === true,
    cancelRequested: raw.cancelRequested === true,
    cleanupWarning: raw.cleanupWarning === true,
    receivedBytes: Number.isSafeInteger(raw.receivedBytes) && raw.receivedBytes >= 0 ? raw.receivedBytes : 0,
    createdAt: safeTimestamp(raw.createdAt),
    updatedAt: safeTimestamp(raw.updatedAt),
    startedAt: safeTimestamp(raw.startedAt),
    completedAt: safeTimestamp(raw.completedAt),
  };
  if (!record.category && record.subcategory) return null;
  if (!record.rootPath) return null;
  return record;
}

function normalizeProvenance(raw) {
  if (!isPlain(raw)) return null;
  const audioId = safeId(raw.audioId);
  const shareId = safeId(raw.shareId);
  const assetId = safeText(raw.assetId, 80);
  if (!audioId || !shareId || !assetId) return null;
  const sha256 = typeof raw.sha256 === "string" && SHA256_RE.test(raw.sha256) ? raw.sha256 : "";
  if (!sha256) return null;
  return {
    assetId,
    audioId,
    shareId,
    sha256,
    bytes: Number.isSafeInteger(raw.bytes) && raw.bytes > 0 ? raw.bytes : 0,
    mediaKind: raw.mediaKind === "MUSIC" || raw.mediaKind === "SFX" ? raw.mediaKind : "",
    category: safeText(raw.category, 60),
    subcategory: safeText(raw.subcategory, 60),
    downloadedAt: safeTimestamp(raw.downloadedAt),
  };
}

export class CloudAudioJobStore {
  #dataDir;
  #jobsFile;
  #provenanceFile;
  #jobs = new Map();
  #provenance = new Map();
  #writeChain = Promise.resolve();
  #closed = false;
  #interrupted = 0;

  constructor(dataDir) {
    if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) throw new Error("dataDir must be absolute");
    this.#dataDir = dataDir;
    this.#jobsFile = path.join(dataDir, "cloud-audio-jobs.json");
    this.#provenanceFile = path.join(dataDir, "cloud-audio-provenance.json");
  }

  get interruptedCount() {
    return this.#interrupted;
  }

  async init() {
    await fs.mkdir(this.#dataDir, { recursive: true });
    const jobs = await this.#readJson(this.#jobsFile);
    if (isPlain(jobs) && Array.isArray(jobs.jobs)) {
      for (const raw of jobs.jobs) {
        const record = normalizeJob(raw);
        if (!record) continue;
        if (ACTIVE_STATES.has(record.state)) {
          record.state = "interrupted";
          record.errorCode = "INTERRUPTED";
          record.cancelRequested = false;
          record.updatedAt = Date.now();
          record.completedAt = record.updatedAt;
          this.#interrupted += 1;
        }
        this.#jobs.set(record.id, record);
      }
    }
    const provenance = await this.#readJson(this.#provenanceFile);
    if (isPlain(provenance) && Array.isArray(provenance.items)) {
      for (const raw of provenance.items) {
        const record = normalizeProvenance(raw);
        if (record) this.#provenance.set(record.assetId, record);
      }
    }
    this.#prune();
    if (this.#interrupted > 0) await this.#persistJobs();
    return this;
  }

  list() {
    return [...this.#jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) {
    return this.#jobs.get(id) || null;
  }

  /** 同一次点击的重复任务：账户/音频/分享/根完全相同且仍未结束。 */
  findActive({ audioId, shareId, rootId, accountId, deviceId, originHost }) {
    for (const job of this.#jobs.values()) {
      if (ACTIVE_STATES.has(job.state)
        && job.audioId === audioId && job.shareId === shareId
        && job.rootId === rootId && job.accountId === accountId
        && job.deviceId === deviceId && job.originHost === originHost) {
        return job;
      }
    }
    return null;
  }

  countActive() {
    let count = 0;
    for (const job of this.#jobs.values()) if (ACTIVE_STATES.has(job.state)) count += 1;
    return count;
  }

  async create(input) {
    if (this.#closed) throw new Error("store closed");
    const now = Date.now();
    const record = normalizeJob({
      ...input,
      id: crypto.randomUUID(),
      state: "queued",
      errorCode: "",
      assetId: "",
      createdFile: false,
      cancelRequested: false,
      cleanupWarning: false,
      receivedBytes: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: 0,
      completedAt: 0,
    });
    if (!record) throw new Error("invalid job");
    this.#jobs.set(record.id, record);
    this.#prune();
    await this.#persistJobs();
    return record;
  }

  async update(id, patch) {
    if (this.#closed) return null;
    const current = this.#jobs.get(id);
    if (!current) return null;
    const next = normalizeJob({ ...current, ...patch, id, updatedAt: Date.now() });
    if (!next) throw new Error("invalid job update");
    this.#jobs.set(id, next);
    await this.#persistJobs();
    return next;
  }

  /** 完成时同时写来源记录；同 assetId 的重复下载只保留一条（不覆盖个人标签）。 */
  async complete(id, patch, provenance) {
    const job = await this.update(id, { ...patch, state: "completed", errorCode: "", completedAt: Date.now() });
    if (!job) return null;
    const record = normalizeProvenance({
      ...provenance,
      assetId: job.assetId,
      audioId: job.audioId,
      shareId: job.shareId,
      sha256: job.sha256,
      bytes: job.bytes,
      mediaKind: provenance.mediaKind || job.mediaKind,
      downloadedAt: Date.now(),
    });
    if (record) {
      this.#provenance.set(record.assetId, record);
      this.#pruneProvenance();
      await this.#persistProvenance();
    }
    return job;
  }

  provenance(assetId) {
    return this.#provenance.get(assetId) || null;
  }

  provenanceList() {
    return [...this.#provenance.values()].sort((a, b) => b.downloadedAt - a.downloadedAt);
  }

  #prune() {
    if (this.#jobs.size <= MAX_JOBS) return;
    const finished = [...this.#jobs.values()]
      .filter((job) => TERMINAL_STATES.has(job.state))
      .sort((a, b) => a.updatedAt - b.updatedAt);
    let remove = this.#jobs.size - MAX_JOBS;
    for (const job of finished) {
      if (remove <= 0) break;
      this.#jobs.delete(job.id);
      remove -= 1;
    }
  }

  #pruneProvenance() {
    if (this.#provenance.size <= MAX_PROVENANCE) return;
    const items = [...this.#provenance.values()].sort((a, b) => a.downloadedAt - b.downloadedAt);
    for (const item of items.slice(0, this.#provenance.size - MAX_PROVENANCE)) {
      this.#provenance.delete(item.assetId);
    }
  }

  async close() {
    this.#closed = true;
    await this.#writeChain.catch(() => {});
  }

  async #readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      // 损坏文件不阻塞启动：隔离改名保留证据，从空状态开始（任务需手动重试）。
      const quarantine = `${file}.corrupt-${Date.now()}`;
      await fs.rename(file, quarantine).catch(() => {});
      return null;
    }
  }

  #writeJson(file, value) {
    const write = async () => {
      const dir = path.dirname(file);
      const tmp = path.join(
        dir,
        `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
      );
      let handle = null;
      try {
        await fs.mkdir(dir, { recursive: true });
        handle = await fs.open(tmp, fsSync.constants.O_CREAT | fsSync.constants.O_EXCL
          | fsSync.constants.O_WRONLY | fsSync.constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.chmod(tmp, 0o600);
        await fs.rename(tmp, file);
      } catch {
        await handle?.close().catch(() => {});
        await fs.unlink(tmp).catch(() => {});
        throw new Error("cloud audio store write failed");
      }
    };
    this.#writeChain = this.#writeChain.then(write, write);
    return this.#writeChain;
  }

  #persistJobs() {
    return this.#writeJson(this.#jobsFile, { version: 1, jobs: this.list() });
  }

  #persistProvenance() {
    return this.#writeJson(this.#provenanceFile, { version: 1, items: this.provenanceList() });
  }
}
