/**
 * T-LOCAL-014B：云端音频的受控安装器（本地文件系统边界）。
 *
 * 只做两件事：
 *   1. 把接收器已校验的私有产物复制到目标根所在文件系统的暂存文件（copy + fsync）；
 *   2. 用 link(2) 做原子 no-replace 发布，绝不覆盖既有文件。
 *
 * 安全边界：
 *   - 根目录必须是绝对、已存在、realpath 与自身一致、逐级无符号链接的普通目录；
 *     不能是磁盘根、应用数据目录或它们的上级。
 *   - 分类只允许两级，每个组件与文件名都按不可信输入校验：拒绝分隔符、控制字符、
 *     "."/".."、Windows 保留名、盘符/UNC、尾随点/空格与超长组件。
 *   - 暂存文件建在目标目录内（同文件系统），随机名 + O_EXCL|O_NOFOLLOW + 0600；
 *     复制时边读边算 SHA-256，长度/摘要/源 inode 与打开前快照全部一致才发布。
 *   - 发布用硬链接，天然不覆盖；同名但内容不同时用固定的 " (2)".." (99)" 后缀，
 *     同名同内容则校验后复用，且从不把既有文件声明为本次任务所有。
 *   - 每次发布前复核根 dev:ino、目标目录仍是根内真实目录、无符号链接组件，
 *     并要求调用方的认证/根代际检查同步通过。
 *
 * 已知限制（不声称 JS 路径字符串是沙箱）：Node 没有 openat/linkat，检查与 link 之间
 * 仍存在同权限本地进程替换目录的 TOCTOU 窗口；本模块只缩小窗口并对最终 inode 做复核，
 * 不能抵御拥有同一账户写权限的恶意进程。发布失败不会删除任何非本任务创建的文件。
 */
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AUDIO } from "./fs-identity.mjs";

const MAX_NAME_CHARS = 180;
const MAX_NAME_BYTES = 240;
const MAX_COMPONENT_CHARS = 60;
const MAX_COMPONENT_BYTES = 120;
const MAX_COLLISION = 99;
const CHUNK_SIZE = 64 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const STAGING_PREFIX = ".shiguang-audio-";

export const CLOUD_AUDIO_INSTALL_MESSAGES = Object.freeze({
  INVALID_ROOT: "下载目录不合法",
  ROOT_UNSAFE: "下载目录不安全或不可写",
  ROOT_CHANGED: "下载目录已变化，请重新选择",
  INVALID_NAME: "云端文件名不合法",
  INVALID_CATEGORY: "云端分类不合法",
  INVALID_MIME: "云端音频类型不合法",
  SOURCE_CHANGED: "接收产物已变化，已停止安装",
  STAGING_FAILED: "无法在下载目录创建临时文件",
  PUBLISH_FAILED: "无法发布音频文件",
  COLLISION_LIMIT: "同名文件过多，无法安全命名",
  VERIFY_FAILED: "已存在文件内容校验失败",
  CLEANUP_FAILED: "临时文件清理失败",
  TARGET_CHANGED: "目标目录已变化",
  CANCELLED: "下载已取消",
});

export class CloudAudioInstallError extends Error {
  constructor(code) {
    super(Object.hasOwn(CLOUD_AUDIO_INSTALL_MESSAGES, code)
      ? CLOUD_AUDIO_INSTALL_MESSAGES[code]
      : CLOUD_AUDIO_INSTALL_MESSAGES.PUBLISH_FAILED);
    this.name = "CloudAudioInstallError";
    this.code = Object.hasOwn(CLOUD_AUDIO_INSTALL_MESSAGES, code) ? code : "PUBLISH_FAILED";
  }
}

const fail = (code) => {
  throw new CloudAudioInstallError(code);
};

const byteLength = (value) => Buffer.byteLength(value, "utf8");

/** 单个分类组件：空串允许；非空必须是安全文件名式的单段，不含任何路径语义。 */
export function validateCategoryComponent(value) {
  if (typeof value !== "string") fail("INVALID_CATEGORY");
  if (value === "") return "";
  if (value.trim() !== value || value === "未分类") fail("INVALID_CATEGORY");
  if (CONTROL_RE.test(value) || /[\\/:*?"<>|]/.test(value)) fail("INVALID_CATEGORY");
  if (value.startsWith(".")) fail("INVALID_CATEGORY");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("\\\\")) fail("INVALID_CATEGORY");
  if (value.endsWith(".") || value.endsWith(" ")) fail("INVALID_CATEGORY");
  if (WINDOWS_RESERVED.test(value)) fail("INVALID_CATEGORY");
  if (value.length > MAX_COMPONENT_CHARS || byteLength(value) > MAX_COMPONENT_BYTES) fail("INVALID_CATEGORY");
  return value;
}

/** 文件名同样按不可信输入处理；扩展名必须是素材库会索引的音频扩展名。 */
export function validateFileName(value) {
  if (typeof value !== "string" || value.length === 0) fail("INVALID_NAME");
  if (CONTROL_RE.test(value) || /[\\/:*?"<>|]/.test(value)) fail("INVALID_NAME");
  if (value === "." || value === ".." || value.startsWith(".")) fail("INVALID_NAME");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("\\\\")) fail("INVALID_NAME");
  if (value.endsWith(".") || value.endsWith(" ")) fail("INVALID_NAME");
  if (WINDOWS_RESERVED.test(value)) fail("INVALID_NAME");
  if (value.length > MAX_NAME_CHARS || byteLength(value) > MAX_NAME_BYTES) fail("INVALID_NAME");
  const ext = path.extname(value).slice(1).toLowerCase();
  if (!ext || !AUDIO.has(ext)) fail("INVALID_NAME");
  return { name: value, ext };
}

/** 两个分类段 -> 相对目录；sub 不能脱离 category 单独存在。 */
export function validateCategories(category, subcategory) {
  const primary = validateCategoryComponent(category ?? "");
  const second = validateCategoryComponent(subcategory ?? "");
  if (second !== "" && primary === "") fail("INVALID_CATEGORY");
  return { category: primary, subcategory: second };
}

export function validateMimeType(value) {
  if (typeof value !== "string") fail("INVALID_MIME");
  const mime = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)) fail("INVALID_MIME");
  return mime;
}

/** 逐级 lstat，拒绝任意符号链接组件（调用方应传 realpath 后的绝对路径）。 */
export async function assertNoSymlinkComponents(absolutePath) {
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) fail("INVALID_ROOT");
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const part of absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      fail("INVALID_ROOT");
    }
    if (stat.isSymbolicLink()) fail("ROOT_UNSAFE");
  }
}

/**
 * 选择下载根：绝对、存在、目录、realpath 一致、逐级无符号链接、非磁盘根、
 * 不与应用数据目录互相包含、可写可进入。
 */
export async function validateDownloadRoot(input, { dataDir = null } = {}) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0") || !path.isAbsolute(input))
    fail("INVALID_ROOT");
  const candidate = path.resolve(input);
  let real;
  try {
    real = await fs.realpath(candidate);
  } catch {
    fail("INVALID_ROOT");
  }
  if (real !== candidate) fail("ROOT_UNSAFE");
  await assertNoSymlinkComponents(candidate);
  let stat;
  try {
    stat = await fs.lstat(candidate);
  } catch {
    fail("INVALID_ROOT");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_ROOT");
  if (candidate === path.parse(candidate).root) fail("ROOT_UNSAFE");
  if (dataDir) {
    const dataReal = await fs.realpath(dataDir).catch(() => path.resolve(dataDir));
    const within = (base, p) => p === base || p.startsWith(base + path.sep);
    if (within(candidate, dataReal) || within(dataReal, candidate)) fail("ROOT_UNSAFE");
  }
  try {
    await fs.access(candidate, fsSync.constants.R_OK | fsSync.constants.W_OK | fsSync.constants.X_OK);
  } catch {
    fail("ROOT_UNSAFE");
  }
  return { path: candidate, dev: stat.dev, ino: stat.ino };
}

/** 发布前后都用同一份根身份；任何变化固定 ROOT_CHANGED。 */
export async function assertRootIdentity(rootPath, expected) {
  let stat;
  try {
    stat = await fs.lstat(rootPath);
  } catch {
    fail("ROOT_CHANGED");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("ROOT_CHANGED");
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino)) fail("ROOT_CHANGED");
  let real;
  try {
    real = await fs.realpath(rootPath);
  } catch {
    fail("ROOT_CHANGED");
  }
  if (real !== rootPath) fail("ROOT_CHANGED");
  return { dev: stat.dev, ino: stat.ino };
}

function assertNotAborted(signal) {
  if (signal?.aborted) fail("CANCELLED");
}

async function statOpened(handle) {
  try {
    return await handle.stat();
  } catch {
    fail("STAGING_FAILED");
  }
}

/** 打开源产物并核对 inode/size；返回句柄与打开后的 fstat。 */
async function openArtifact(artifactPath, identity, expectedBytes) {
  let handle;
  try {
    handle = await fs.open(
      artifactPath,
      fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW,
    );
  } catch {
    fail("SOURCE_CHANGED");
  }
  let stat;
  try {
    stat = await statOpened(handle);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  if (!stat.isFile() || stat.nlink !== 1
    || stat.dev !== identity.dev || stat.ino !== identity.ino
    || stat.size !== expectedBytes) {
    await handle.close().catch(() => {});
    fail("SOURCE_CHANGED");
  }
  return { handle, stat };
}

/** 只读校验一个已存在的同名文件；符号链接/非普通文件一律拒绝。 */
async function hashExisting(candidate, expectedBytes) {
  let handle;
  try {
    const before = await fs.lstat(candidate);
    if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedBytes) return null;
    handle = await fs.open(candidate, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== expectedBytes) return null;
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > expectedBytes) return null;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (total !== expectedBytes) return null;
    return hash.digest("hex");
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * 在目标目录里找与请求名等价的既有普通文件名。
 * macOS/Windows 的大小写与 Unicode 归一化不敏感：只按字节精确比较会在中文
 * NFC/NFD 或大小写差异上误判“文件不存在”，进而发布第二份同名文件。
 * 其它平台保持字节精确语义（不把 Linux 上真实不同的两个文件名合并）。
 */
async function findEquivalentFile(targetDir, fileName) {
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    fail("TARGET_CHANGED");
  }
  const normalized = fileName.normalize("NFC");
  const folded = normalized.toLocaleLowerCase("en-US");
  const insensitive = process.platform === "darwin" || process.platform === "win32";
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile()) continue;
    const candidate = entry.name.normalize("NFC");
    if (candidate === normalized || (insensitive && candidate.toLocaleLowerCase("en-US") === folded)) {
      return path.join(targetDir, entry.name);
    }
  }
  return null;
}

function collisionName(fileName, attempt) {
  if (attempt === 0) return fileName;
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  return `${base} (${attempt + 1})${ext}`;
}

/**
 * 逐段创建目标目录：已存在的组件必须是真实目录，绝不跟随符号链接。
 * 不用 mkdir({recursive:true})，因为它在遇到既有符号链接时会先写到链接目标里再被检查。
 */
async function ensureDirectoryNoFollow(rootPath, segments) {
  let current = rootPath;
  for (const segment of segments) {
    const candidate = path.join(current, segment);
    let stat = null;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") fail("STAGING_FAILED");
    }
    if (stat === null) {
      try {
        await fs.mkdir(candidate, { mode: 0o755 });
      } catch (error) {
        if (error?.code === "EEXIST") {
          // 竞争创建：下面统一复核，绝不盲信。
        } else {
          fail("STAGING_FAILED");
        }
      }
      try {
        stat = await fs.lstat(candidate);
      } catch {
        fail("STAGING_FAILED");
      }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("TARGET_CHANGED");
    current = candidate;
  }
  return current;
}

export class CloudAudioInstaller {
  #dataDir;

  constructor({ dataDir = null } = {}) {
    this.#dataDir = dataDir;
  }

  inspectRoot(input) {
    return validateDownloadRoot(input, { dataDir: this.#dataDir });
  }

  /**
   * 发布后复核：只读打开（NOFOLLOW）、长度与 SHA-256 必须一致，返回 dev:ino。
   * 用于 Library 登记前确认磁盘上的最终文件仍是本任务发布的内容。
   */
  async verifyPublished(filePath, expectedBytes, expectedSha256) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) fail("VERIFY_FAILED");
    if (!Number.isInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 256_000_000) fail("VERIFY_FAILED");
    if (typeof expectedSha256 !== "string" || !SHA256_RE.test(expectedSha256)) fail("VERIFY_FAILED");
    let before;
    try {
      before = await fs.lstat(filePath);
    } catch {
      fail("VERIFY_FAILED");
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size !== expectedBytes) fail("VERIFY_FAILED");
    const digest = await hashExisting(filePath, expectedBytes);
    if (digest !== expectedSha256) fail("VERIFY_FAILED");
    let after;
    try {
      after = await fs.lstat(filePath);
    } catch {
      fail("VERIFY_FAILED");
    }
    if (!after.isFile() || after.isSymbolicLink() || after.size !== expectedBytes
      || after.dev !== before.dev || after.ino !== before.ino) {
      fail("VERIFY_FAILED");
    }
    return { dev: after.dev, ino: after.ino, size: after.size };
  }

  /**
   * 复制并发布一个已校验产物。
   * @returns {{path:string, created:boolean, bytes:number, sha256:string}}
   */
  async publish({
    artifactPath,
    artifactIdentity,
    expectedBytes,
    expectedSha256,
    mimeType,
    fileName,
    category,
    subcategory,
    rootPath,
    rootIdentity,
    signal = null,
    assertContext = null,
    snapshotPreexisting = null,
  }) {
    validateMimeType(mimeType);
    const file = validateFileName(fileName);
    const cats = validateCategories(category, subcategory);
    if (!Number.isInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > 256_000_000)
      fail("SOURCE_CHANGED");
    if (typeof expectedSha256 !== "string" || !SHA256_RE.test(expectedSha256)) fail("SOURCE_CHANGED");
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) fail("INVALID_ROOT");
    if (!artifactIdentity || !Number.isInteger(artifactIdentity.dev) || !Number.isInteger(artifactIdentity.ino))
      fail("SOURCE_CHANGED");
    const checkContext = () => {
      if (typeof assertContext === "function") assertContext();
    };
    if (snapshotPreexisting !== null && typeof snapshotPreexisting !== "function") fail("SOURCE_CHANGED");
    assertNotAborted(signal);
    checkContext();
    await assertRootIdentity(rootPath, rootIdentity);

    const segments = [cats.category, cats.subcategory].filter(Boolean);
    const targetDir = segments.length
      ? await ensureDirectoryNoFollow(rootPath, segments)
      : rootPath;
    await assertNoSymlinkComponents(targetDir);
    let dirStat;
    try {
      dirStat = await fs.lstat(targetDir);
    } catch {
      fail("TARGET_CHANGED");
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) fail("TARGET_CHANGED");
    let realTarget;
    try {
      realTarget = await fs.realpath(targetDir);
    } catch {
      fail("TARGET_CHANGED");
    }
    const relativeReal = path.relative(rootPath, realTarget);
    if (relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) fail("TARGET_CHANGED");

    const { handle: source, stat: sourceStat } = await openArtifact(artifactPath, artifactIdentity, expectedBytes);
    let stagingPath = null;
    let stagingIdentity = null;
    let published = false;
    try {
      const random = crypto.randomBytes(16).toString("hex");
      stagingPath = path.join(targetDir, `${STAGING_PREFIX}${random}.part`);
      let staging;
      try {
        staging = await fs.open(
          stagingPath,
          fsSync.constants.O_CREAT | fsSync.constants.O_EXCL
            | fsSync.constants.O_WRONLY | fsSync.constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        fail("STAGING_FAILED");
      }
      try {
        const opened = await statOpened(staging);
        if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o777) !== 0o600) fail("STAGING_FAILED");
        const stagingLstat = await fs.lstat(stagingPath).catch(() => null);
        if (!stagingLstat || stagingLstat.isSymbolicLink()
          || stagingLstat.dev !== opened.dev || stagingLstat.ino !== opened.ino) fail("STAGING_FAILED");
        stagingIdentity = { dev: opened.dev, ino: opened.ino };
        const hash = crypto.createHash("sha256");
        const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
        let total = 0;
        for (;;) {
          assertNotAborted(signal);
          let bytesRead;
          try {
            ({ bytesRead } = await source.read(buffer, 0, buffer.length, null));
          } catch {
            fail("SOURCE_CHANGED");
          }
          if (bytesRead === 0) break;
          if (total + bytesRead > expectedBytes) fail("SOURCE_CHANGED");
          let offset = 0;
          while (offset < bytesRead) {
            let written;
            try {
              ({ bytesWritten: written } = await staging.write(buffer, offset, bytesRead - offset));
            } catch {
              fail("STAGING_FAILED");
            }
            if (!Number.isInteger(written) || written <= 0 || written > bytesRead - offset) fail("STAGING_FAILED");
            offset += written;
          }
          hash.update(buffer.subarray(0, bytesRead));
          total += bytesRead;
        }
        if (total !== expectedBytes) fail("SOURCE_CHANGED");
        const digest = hash.digest("hex");
        if (digest !== expectedSha256) fail("SOURCE_CHANGED");
        assertNotAborted(signal);
        checkContext();
        try {
          await staging.sync();
        } catch {
          fail("STAGING_FAILED");
        }
        try {
          await staging.chmod(0o644);
        } catch {
          fail("STAGING_FAILED");
        }
        await staging.close().catch(() => fail("STAGING_FAILED"));
        staging = null;

        // 发布前最后一次同步复核：根身份、目标目录真实位置、认证/根代际。
        await assertRootIdentity(rootPath, rootIdentity);
        await assertNoSymlinkComponents(targetDir);
        const finalDir = await fs.lstat(targetDir).catch(() => null);
        if (!finalDir || !finalDir.isDirectory() || finalDir.isSymbolicLink()
          || finalDir.dev !== dirStat.dev || finalDir.ino !== dirStat.ino) fail("TARGET_CHANGED");
        checkContext();
        assertNotAborted(signal);

        const stagingStat = await fs.lstat(stagingPath).catch(() => null);
        if (!stagingStat || !stagingStat.isFile() || stagingStat.isSymbolicLink()
          || stagingStat.dev !== stagingIdentity.dev || stagingStat.ino !== stagingIdentity.ino
          || stagingStat.size !== expectedBytes || (stagingStat.mode & 0o777) !== 0o644) {
          fail("STAGING_FAILED");
        }

        // 每个 await 之后都重新检查：取消、认证代际、根身份、目标目录 inode、
        // 暂存文件 inode/长度/权限。这样 readdir/hash 期间的上下文变化也会在
        // 发布前被发现，而不是只在循环开头检查一次。
        const assertPublicationBoundary = async () => {
          assertNotAborted(signal);
          checkContext();
          await assertRootIdentity(rootPath, rootIdentity);
          await assertNoSymlinkComponents(targetDir);
          const dirNow = await fs.lstat(targetDir).catch(() => null);
          if (!dirNow || !dirNow.isDirectory() || dirNow.isSymbolicLink()
            || dirNow.dev !== dirStat.dev || dirNow.ino !== dirStat.ino) {
            fail("TARGET_CHANGED");
          }
          const stagingNow = await fs.lstat(stagingPath).catch(() => null);
          if (!stagingNow || !stagingNow.isFile() || stagingNow.isSymbolicLink()
            || stagingNow.dev !== stagingIdentity.dev || stagingNow.ino !== stagingIdentity.ino
            || stagingNow.size !== expectedBytes || (stagingNow.mode & 0o777) !== 0o644) {
            fail("STAGING_FAILED");
          }
          // 上面几个 await 期间仍可能变化；在边界末尾再同步复核一次。
          checkContext();
          assertNotAborted(signal);
        };

        let result = null;
        for (let attempt = 0; attempt <= MAX_COLLISION; attempt += 1) {
          const candidateName = collisionName(file.name, attempt);
          const candidate = path.join(targetDir, candidateName);
          await assertPublicationBoundary();
          // 先按平台等价规则找既有文件：同内容复用，不同内容换确定性后缀。
          const equivalent = await findEquivalentFile(targetDir, candidateName);
          await assertPublicationBoundary();
          if (equivalent !== null) {
            const existingDigest = await hashExisting(equivalent, expectedBytes);
            await assertPublicationBoundary();
            if (existingDigest === expectedSha256) {
              result = { path: equivalent, created: false, bytes: expectedBytes, sha256: expectedSha256 };
              break;
            }
            if (attempt === MAX_COLLISION) fail("COLLISION_LIMIT");
            continue;
          }
          // 在真正 no-replace link 之前、按“实际候选路径”同步取得发布前索引事实。
          // 该回调必须是同步的：若在这里 await，后台扫描可能在本任务发布之后、
          // 快照之前先索引新文件，从而把本任务的新 inode 误判成既有个人资产。
          const prePublication = snapshotPreexisting === null
            ? undefined
            : snapshotPreexisting(candidate);
          let linked = false;
          try {
            await fs.link(stagingPath, candidate);
            linked = true;
            const linkedStat = await fs.lstat(candidate);
            if (!linkedStat.isFile() || linkedStat.isSymbolicLink()
              || linkedStat.dev !== stagingIdentity.dev || linkedStat.ino !== stagingIdentity.ino) {
              // 不删除身份不符的路径：它可能已被并发替换为别人的文件。
              linked = false;
              fail("PUBLISH_FAILED");
            }
            // 关键：link 返回后、报告成功前再核对取消/上下文/根/目录/源身份。
            await assertPublicationBoundary();
            const resolved = await fs.realpath(candidate).catch(() => candidate);
            // realpath 也是 await；它期间的变化同样不能假成功。
            await assertPublicationBoundary();
            result = { path: resolved, created: true, bytes: expectedBytes, sha256: expectedSha256, prePublication: prePublication ?? null };
            break;
          } catch (error) {
            if (linked) {
              // 只回滚本次刚创建、且 dev:ino 仍匹配暂存文件的目标；复用/外来文件绝不删。
              try {
                const now = await fs.lstat(candidate);
                if (now.isFile() && !now.isSymbolicLink()
                  && now.dev === stagingIdentity.dev && now.ino === stagingIdentity.ino) {
                  await fs.unlink(candidate);
                }
              } catch {
                fail("CLEANUP_FAILED");
              }
            }
            if (error instanceof CloudAudioInstallError) throw error;
            if (error?.code !== "EEXIST") {
              if (!error?.code) throw error;
              fail("PUBLISH_FAILED");
            }
            const existingDigest = await hashExisting(candidate, expectedBytes);
            await assertPublicationBoundary();
            if (existingDigest === expectedSha256) {
              const resolved = await fs.realpath(candidate).catch(() => candidate);
              result = { path: resolved, created: false, bytes: expectedBytes, sha256: expectedSha256 };
              break;
            }
            if (attempt === MAX_COLLISION) fail("COLLISION_LIMIT");
          }
        }
        if (!result) fail("COLLISION_LIMIT");
        // 发布成功后再删除暂存硬链接；失败时保留暂存文件供诊断，不碰已发布/既有文件。
        try {
          await fs.unlink(stagingPath);
          stagingPath = null;
        } catch {
          fail("CLEANUP_FAILED");
        }
        published = true;
        return result;
      } finally {
        if (staging) await staging.close().catch(() => {});
      }
    } finally {
      await source.close().catch(() => {});
      if (!published && stagingPath) {
        // 只删除本任务以随机名创建、且 dev:ino 仍匹配的暂存文件。
        try {
          const current = await fs.lstat(stagingPath);
          if (current.isFile() && !current.isSymbolicLink()
            && (!stagingIdentity
              || (current.dev === stagingIdentity.dev && current.ino === stagingIdentity.ino))) {
            await fs.unlink(stagingPath);
          }
        } catch {
          /* 已删除或已不属于本任务；不误删其它文件 */
        }
      }
    }
  }
}
