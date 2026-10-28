/**
 * 文件身份与路径边界（共享底层）。
 *
 * 为什么要有这个模块：`within()` 此前在 library.mjs、missing-files.mjs 各有一份，
 * 新写的 folder-browser.mjs 又内联了第三份；卷身份（dev:ino）判断只在 missing-files 里，
 * 于是新功能漏判了"拔盘/换盘"。这里收敛成唯一一份，谁要判边界、判根健康都从这里取。
 *
 * 身份分三层，能力与代价递增：
 *   - 路径：最廉价，但改名/移动即失效（这就是外部整理会丢元数据的根因）
 *   - dev:ino：同盘改名/移动后仍稳定；复制/跨盘会变（stat 一次即可拿到）
 *   - sha256：内容同一性；跨盘、复制后删除都能认出来，代价是读全文件
 * 另有 xattr（`com.shiguang.assetid`）把 id 直接存在文件上：同盘 mv/cp/ditto 都保留（实测），
 * 但**过不了 zip 归档**（实测），所以只能当"快线索"，不能当唯一载体。
 */
import fs from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 路径是否在 base 之内（含 base 自身）。全项目只此一份。 */
export const within = (base, p) => p === base || p.startsWith(base + path.sep);

/** 存文件 id 的扩展属性名；macOS 上由系统随文件一起复制。 */
export const XATTR_KEY = "com.shiguang.assetid";

/**
 * 根目录健康检查，返回根身份 `${dev}:${ino}`。
 * 抛错信息与旧实现逐字一致（missing-files 的调用方与测试依赖这些文案）：
 *   - realpath 与登记路径不一致 → 目录被换过位置
 *   - 不是目录 / 不可读不可进入 → 素材目录不可用
 *   - 位于 /Volumes 且 dev 等于 /Volumes 自身 → 外接硬盘未挂载
 */
export async function rootIdentity(root) {
  const real = await fs.realpath(root.path);
  if (real !== root.path) throw Error("登记目录位置已变化");
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw Error("素材目录不可用");
  await fs.access(real, constants.R_OK | constants.X_OK);
  const handle = await fs.opendir(real);
  await handle.close();
  if (within("/Volumes", real) && stat.dev === (await fs.stat("/Volumes")).dev)
    throw Error("外接硬盘未挂载");
  return `${stat.dev}:${stat.ino}`;
}

/** 失败一律返回 null：读不到 xattr 是常态（网络盘/exFAT/非 macOS），不该影响主流程。 */
export async function readAssetId(file) {
  if (process.platform !== "darwin") return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("xattr", ["-p", XATTR_KEY, file], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
    const value = String(stdout).trim();
    return value && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}

/** 写入文件 id；失败静默（只读盘、非 macOS、不支持 xattr 的文件系统）。 */
export async function writeAssetId(file, id) {
  if (process.platform !== "darwin") return false;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("xattr", ["-w", XATTR_KEY, id, file], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** 流式 sha256，用于内容同一性（只在按路径/inode 都认不出来时才调用）。 */
export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(p);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * 可索引的媒体扩展名 —— **全项目唯一一份**（扫描器与对账器都从这里取，
 * 否则会出现"对账认了但扫描不认"这类只在边界上暴露的不一致）。
 * 要支持新格式只改这里。
 */
export const PHOTO = new Set([
  "jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "tif", "tiff",
  "arw", "cr2", "cr3", "nef", "dng", "raf", "orf", "rw2",
]);
export const VIDEO = new Set(["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm"]);
export const AUDIO = new Set(["mp3", "wav", "m4a", "aac", "aif", "aiff", "flac", "ogg", "opus", "ncm"]);

/** 按扩展名 + 根类型推断素材类型；与扫描器口径一致（识别不了返回 null，不索引）。 */
export function kindForExt(ext, rootKind) {
  const e = String(ext || "").toLowerCase();
  if (!e) return null;
  if (PHOTO.has(e)) return "photo";
  if (VIDEO.has(e)) return "video";
  if (AUDIO.has(e)) return rootKind === "music" ? "music" : "sfx";
  return null;
}

/** 遍历一个登记根下的所有可索引文件（跳过点目录、符号链接），返回相对路径与身份信息。 */
export async function walkFiles(root, { skipDir = ".shiguang", onError } = {}) {
  const files = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      onError?.(dir, e);
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.stat(abs);
        files.push({
          abs,
          relPath: path.relative(root.path, abs).split(path.sep).join("/"),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          birthtimeMs: stat.birthtimeMs,
          dev: stat.dev,
          ino: stat.ino,
        });
      } catch (e) {
        onError?.(abs, e);
      }
    }
  };
  await walk(root.path);
  return files.filter((f) => !f.relPath.startsWith(skipDir + "/"));
}

// Explicit fingerprint jobs only. Legacy reconcile hashing keeps its existing behavior.
export const fingerprintFileIdentity = s => ({ dev: s.dev, ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs, nlink: s.nlink });
export async function fingerprintRootIdentity(root) {
  const key = await rootIdentity(root), stat = await fs.lstat(root.path);
  if (![stat.dev, stat.ino].every(n => Number.isSafeInteger(n) && n > 0) || `${stat.dev}:${stat.ino}` !== key)
    throw Object.assign(Error('ROOT_IDENTITY_UNAVAILABLE'), { code: 'ROOT_IDENTITY_UNAVAILABLE' });
  return key;
}
export async function stableFileSha256(root, file, { remainingBytes, signal, check = () => {}, onRead = () => {} } = {}) {
  const error = code => Object.assign(Error(code), { code });
  const guard = () => { check(); if (signal?.aborted) throw error('CANCELLED'); };
  guard();
  if (!Number.isSafeInteger(remainingBytes) || remainingBytes < 0 || !path.isAbsolute(file) || path.normalize(file) !== file || !within(root.path, file) || file === root.path) throw error('INVALID_FILE');
  const rootKey = await fingerprintRootIdentity(root); guard();
  const before = await fs.lstat(file); guard();
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || ![before.dev, before.ino].every(n => Number.isSafeInteger(n) && n > 0) || ![before.mtimeMs, before.ctimeMs, before.birthtimeMs].every(n => Number.isFinite(n) && n >= 0)) throw error('FILE_IDENTITY_UNAVAILABLE');
  if (before.size > remainingBytes) throw error('BYTE_BUDGET');
  if (await fs.realpath(file) !== file) throw error('FILE_LINK'); guard();
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); guard();
    const same = s => JSON.stringify(fingerprintFileIdentity(s)) === JSON.stringify(fingerprintFileIdentity(before));
    if (!same(await handle.stat())) throw error('FILE_CHANGED'); guard();
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let position = 0;
    while (position < before.size) {
      guard(); const want = Math.min(buffer.length, before.size - position, remainingBytes - position);
      if (want < 1) throw error('BYTE_BUDGET');
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      onRead(bytesRead); guard();
      if (bytesRead < 1 || bytesRead > want) throw error('FILE_CHANGED');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    if (!same(await handle.stat())) throw error('FILE_CHANGED'); guard();
    if (!same(await fs.lstat(file)) || await fs.realpath(file) !== file || await fingerprintRootIdentity(root) !== rootKey) throw error('FILE_CHANGED'); guard();
    return { sha256: hash.digest('hex'), bytes: position, file: fingerprintFileIdentity(before), rootIdentity: rootKey };
  } finally { await handle?.close(); }
}
