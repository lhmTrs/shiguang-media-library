/**
 * 登记根内的清单文件：`<root>/.shiguang/manifest.json`
 *
 * 定位：这是"外部整理后身份不丢"的落点。
 *   - 文件系统是**存在性与位置**的真相（只有它知道文件在哪）
 *   - 清单是**身份与元数据**的载体（id / sha256 / tags / note / category…）
 *   - SQLite 是可随时重建的投影
 * 这样 GPT（或任何脚本）直接搬动/改名文件后，应用能按"路径 → dev:ino → xattr id → sha256"
 * 逐级把文件重新认领回原来的 id，标签与项目关联不再随路径丢失。
 *
 * 写盘约定：临时文件 + fsync + rename 原子替换，并保留上一版 `.bak`；
 * 未知字段原样保留（沿用项目里 config 的做法），避免把别的工具写的附加信息洗掉。
 */
import fs from "node:fs/promises";
import path from "node:path";

export const MANIFEST_DIR = ".shiguang";
export const MANIFEST_NAME = "manifest.json";
export const MANIFEST_FORMAT = 1;

export function manifestPath(root) {
  return path.join(root.path, MANIFEST_DIR, MANIFEST_NAME);
}

/** 该相对路径是否属于应用自己的数据目录（对账时必须忽略）。 */
export function insideManifestDir(relPath) {
  return relPath === MANIFEST_DIR || relPath.startsWith(MANIFEST_DIR + "/");
}

export function emptyManifest(root) {
  return {
    format: MANIFEST_FORMAT,
    root: root.name || "",
    updatedAt: new Date().toISOString(),
    revision: 0,
    entries: {},
  };
}

/** 结构校验；返回 null 表示合格，否则返回原因（不抛错，调用方决定降级策略）。 */
export function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "清单不是对象";
  if (!value.entries || typeof value.entries !== "object" || Array.isArray(value.entries))
    return "清单缺少 entries 映射";
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!id || typeof id !== "string") return "存在空 id";
    if (!entry || typeof entry !== "object") return `条目 ${id} 不是对象`;
    if (entry.tags !== undefined && !Array.isArray(entry.tags)) return `条目 ${id} 的 tags 不是数组`;
    if (entry.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(entry.sha256)))
      return `条目 ${id} 的 sha256 非法`;
  }
  return null;
}

/** 读取清单；缺失返回 { manifest: null, reason: "missing" }，损坏返回 reason 并附原始文本长度，绝不抛错。 */
export async function readManifest(root) {
  const file = manifestPath(root);
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    return { manifest: null, reason: e.code === "ENOENT" ? "missing" : String(e.code || e.message) };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { manifest: null, reason: "unparsable", bytes: text.length };
  }
  const invalid = validateManifest(parsed);
  if (invalid) return { manifest: null, reason: "invalid", detail: invalid };
  return { manifest: parsed, reason: "ok" };
}

/** 原子写入：tmp → fsync → rename，并保留一份 .bak。返回写入字节数。 */
export async function writeManifest(root, manifest) {
  const file = manifestPath(root);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const payload = { ...manifest, format: MANIFEST_FORMAT, updatedAt: new Date().toISOString() };
  const text = JSON.stringify(payload, null, 2) + "\n";
  const tmp = `${file}.tmp-${process.pid}`;
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.copyFile(file, `${file}.bak`);
  } catch {} // 首次写入没有旧文件，属正常
  await fs.rename(tmp, file);
  return Buffer.byteLength(text);
}

/** 数据库的一行 → 清单条目（元数据镜像；relPath 会在对账时被刷新）。 */
export function entryFromAsset(asset) {
  let tags = [];
  try {
    const parsed = JSON.parse(asset.tags ?? "[]");
    if (Array.isArray(parsed)) tags = parsed.filter((t) => typeof t === "string");
  } catch {}
  return {
    relPath: asset.rel_path ?? asset.path ?? "",
    sha256: asset.sha256 || undefined,
    size: asset.size ?? undefined,
    tags,
    note: asset.note ?? "",
    category: asset.category ?? "",
    sub: asset.sub ?? "",
    favorite: asset.favorite ? true : false,
    confirmed: asset.confirmed ? true : false,
    capturedMs: asset.captured_ms ?? null,
  };
}

/** 清单条目 → 数据库可写字段（仅在显式 importMetadata 时使用，避免静默覆盖人工编辑）。 */
export function metaFromEntry(entry) {
  const out = {};
  if (Array.isArray(entry.tags)) out.tags = JSON.stringify(entry.tags.filter((t) => typeof t === "string"));
  if (typeof entry.note === "string") out.note = entry.note;
  if (typeof entry.category === "string") out.category = entry.category;
  if (typeof entry.sub === "string") out.sub = entry.sub;
  if (typeof entry.favorite === "boolean") out.favorite = entry.favorite ? 1 : 0;
  if (entry.capturedMs === null || typeof entry.capturedMs === "number") out.captured_ms = entry.capturedMs;
  return out;
}
