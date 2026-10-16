/**
 * 文件系统对账（reconcile）：把"外部整理过的文件"重新认领回原来的素材 id。
 *
 * 设计要点（与 fs-manifest.mjs 的分工）：
 *   - 文件系统是**存在性与位置**的真相；清单是**身份与元数据**的载体；SQLite 是可重建投影
 *   - 匹配逐级降级：路径 → dev:ino → xattr id → sha256 → 「同名同大小且唯一」启发式
 *   - **永不删除**：认领不到的清单条目只标 `online=0` 并在清单里记 `state:"missing"`；
 *     认领不到的文件按新素材入库（这是外部新增文件的正常路径）
 *   - 对账后 `roots.revision` +1，前端照旧 5 秒轮询即可看到变化，无需改前端
 *
 * 两条入口：
 *   - reconcileRoot：全量走盘，用于启动、手动、以及精简路径模式兜不住的情况
 *   - reconcilePaths：只处理监听报出来的少量路径（外部改名/移动 1~2 秒内接上）
 */
import fs from "node:fs/promises";
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import { fileCreated, id } from "./library.mjs";
import { kindForExt, readAssetId, sha256File, walkFiles, within, writeAssetId } from "./fs-identity.mjs";
import {
  emptyManifest,
  entryFromAsset,
  insideManifestDir,
  manifestPath,
  metaFromEntry,
  moveManifest,
  readManifest,
  writeManifest,
} from "./fs-manifest.mjs";

/** 渐进补齐 sha256 的默认预算：条数与字节数双限，避免对账把大库读穿。 */
const HASH_BUDGET_FILES = 500;
const HASH_BUDGET_BYTES = 512 * 1024 * 1024;
/** 第 4 级"内容相同但 inode 变了"的匹配预算：与补哈希预算相互独立（见该处注释）。 */
const MATCH_HASH_BUDGET_FILES = 200;
/** 每轮对账最多给多少个文件写 xattr（每个文件一次进程调用，必须限量；靠 tagged 标记逐轮收敛）。 */
const TAG_BUDGET_FILES = 300;

const relOf = (root, abs) => path.relative(root.path, abs).split(path.sep).join("/");
const isIgnoredRel = (rel) => !rel || insideManifestDir(rel) || rel.split("/").some((seg) => seg.startsWith("."));

function assetsOfRoot(lib, rootId) {
  return lib.db.prepare("SELECT * FROM assets WHERE root_id=? AND trashed=0").all(rootId);
}

/** 把数据库现有元数据物化成清单（首次启用 / 清单丢失时使用）。 */
export async function materializeManifest(lib, root) {
  const manifest = emptyManifest(root);
  for (const row of assetsOfRoot(lib, root.id)) {
    manifest.entries[row.id] = {
      ...entryFromAsset(row),
      // 清单里一律存**相对登记根的路径**：走盘索引用的就是这个坐标系，
      // 存绝对路径会让"路径未变"这一级永远匹配不上，把全部条目挤到最不可靠的
      // "同名同大小"启发式上（曾因此把记录误配到别的文件、撞 MySQL 的唯一约束）。
      relPath: relIfInside(root, row.path) ?? row.path,
      ...(row.dev && row.ino ? { dev: row.dev, ino: row.ino } : {}),
    };
  }
  return manifest;
}

/** 登记根内的绝对路径 → 相对路径；不在根内（或就是根本身）返回 null。 */
function relIfInside(root, abs) {
  if (typeof abs !== "string" || !abs) return null;
  const rel = path.relative(root.path, abs).split(path.sep).join("/");
  return rel && !rel.startsWith("..") ? rel : null;
}

/** 兼容早期写下的清单：把绝对路径归一化成相对路径，让旧清单自愈。 */
function normalizeEntryPaths(root, manifest) {
  for (const entry of Object.values(manifest.entries || {})) {
    if (typeof entry.relPath !== "string" || !path.isAbsolute(entry.relPath)) continue;
    const rel = relIfInside(root, entry.relPath);
    if (rel) entry.relPath = rel;
  }
  return manifest;
}

async function readManifestOrBuild(lib, root, report) {
  const { manifest, reason, detail } = await readManifest(root);
  if (manifest) return normalizeEntryPaths(root, manifest);
  if (reason === "missing") {
    report.manifestIssue = "created";
  } else {
    report.manifestIssue = detail || reason;
    // 损坏的清单不直接丢弃：挪到一边留证，再从数据库重建
    try {
      await fs.rename(manifestPath(root), `${manifestPath(root)}.broken-${Date.now()}`);
    } catch {}
  }
  return materializeManifest(lib, root);
}

/**
 * 全量对账一个登记根。
 * @param {object} lib Library 实例
 * @param {object} root roots 表的一行
 * @param {object} [opts]
 * @param {boolean} [opts.importMetadata] 把清单里的元数据并入数据库（默认只做"数据库 → 清单"镜像）
 * @param {boolean} [opts.tagFiles] 是否给文件写 xattr id（默认写；只读盘/不支持的文件系统上静默失败）
 * @param {number}  [opts.hashBudgetFiles] / [opts.hashBudgetBytes] 渐进哈希预算
 */
export async function reconcileRoot(lib, root, opts = {}) {
  const started = Date.now();
  const report = {
    mode: "full",
    rootId: root.id,
    root: root.path,
    matchedByPath: 0,
    moved: 0,
    renamed: 0,
    adoptedByXattr: 0,
    adoptedByHash: 0,
    suspected: 0,
    recovered: 0,
    added: 0,
    missing: 0,
    hashed: 0,
    matchHashes: 0,
    skipped: 0,
    tagged: 0,
    conflicts: [],
    walkErrors: [],
  };
  const manifest = await readManifestOrBuild(lib, root, report);

  const files = await walkFiles(root, {
    onError: (p, e) => report.walkErrors.push(`${relOf(root, p)}: ${e.code || e.message}`),
  });
  const rootRows = assetsOfRoot(lib, root.id);
  const rowById = new Map(rootRows.map((r) => [r.id, r]));
  const rowByPath = new Map(rootRows.map((r) => [r.path, r]));

  const freeEntries = new Map(Object.entries(manifest.entries));
  const freeFiles = new Map(files.map((f) => [f.relPath, f]));
  const claims = new Map(); // entryId -> { file, how, digest? }
  const claim = (entryId, file, how, digest) => {
    // 防护：目标路径若已属于**另一条**记录，就绝不认领（否则会撞 path 唯一约束，
    // 更糟的是把元数据挂到别人的文件上）。该条目保持未认领 → 之后按"失联"如实标记。
    const owner = rowByPath.get(file.abs);
    // 只有当"占着这个路径的那条记录本身也是已知素材"时才算真抢占（避免误配）；
    // 若它不在清单里，那是数据库被重建后扫描出来的**孤儿行**，正应该由下面
    // "数据库行丢失"的分支把清单元数据并回去，所以这里放行。
    if (owner && owner.id !== entryId && Object.hasOwn(manifest.entries, owner.id)) {
      report.conflicts.push({ entryId, path: file.abs, error: "路径已属于另一条素材记录，跳过认领", code: "PATH_OWNED" });
      freeFiles.delete(file.relPath); // 这个文件已有归属，不要再当新素材插入
      return;
    }
    claims.set(entryId, { file, how, digest });
    freeEntries.delete(entryId);
    freeFiles.delete(file.relPath);
  };

  // ── 第 1 级：路径未变（绝大多数）
  for (const [entryId, entry] of [...freeEntries]) {
    const file = entry.relPath ? freeFiles.get(entry.relPath) : null;
    if (file) {
      claim(entryId, file, "path");
      report.matchedByPath++;
    }
  }

  // ── 第 2 级：dev:ino（同盘改名/移动；清单没记 ino 时回落到数据库里存的）
  if (freeEntries.size && freeFiles.size) {
    const byIno = new Map();
    for (const file of freeFiles.values()) if (file.ino) byIno.set(`${file.dev}:${file.ino}`, file);
    for (const [entryId, entry] of [...freeEntries]) {
      const row = rowById.get(entryId);
      const dev = entry.dev ?? row?.dev;
      const ino = entry.ino ?? row?.ino;
      if (!dev || !ino) continue;
      const file = byIno.get(`${dev}:${ino}`);
      if (file) claim(entryId, file, "ino");
    }
  }

  // ── 第 3 级：xattr 里的 id（文件被复制过、inode 变了也能认出）
  if (freeEntries.size && freeFiles.size) {
    for (const file of [...freeFiles.values()]) {
      if (!freeEntries.size) break;
      const xid = await readAssetId(file.abs);
      if (xid && freeEntries.has(xid)) {
        claim(xid, file, "xattr");
        report.adoptedByXattr++;
      }
    }
  }

  // ── 第 4 级：sha256（跨盘移动、复制后删除）
  // 注意预算语义：这里算哈希是**为了认出来**，不能被"本轮不补哈希"的开关关掉，
  // 因此用独立的 matchHashBudgetFiles（默认 200）；补哈希的预算只管第 9 步的渐进补齐。
  let hashedBytes = 0;
  let matchHashes = 0;
  const hashBudgetFiles = opts.hashBudgetFiles ?? HASH_BUDGET_FILES;
  const hashBudgetBytes = opts.hashBudgetBytes ?? HASH_BUDGET_BYTES;
  const matchHashBudget = opts.matchHashBudgetFiles ?? MATCH_HASH_BUDGET_FILES;
  if (freeEntries.size && freeFiles.size) {
    const digestOf = new Map();
    const hashOne = async (file) => {
      let digest = digestOf.get(file.abs);
      if (digest) return digest;
      if (matchHashes >= matchHashBudget) {
        report.hashBudgetExhausted = true;
        return null;
      }
      digest = await sha256File(file.abs).catch(() => null);
      if (!digest) return null;
      digestOf.set(file.abs, digest);
      matchHashes++;
      report.matchHashes = matchHashes;
      return digest;
    };
    for (const [entryId, entry] of [...freeEntries]) {
      if (!entry.sha256) continue;
      const candidates = [...freeFiles.values()].filter((f) => entry.size === undefined || f.size === entry.size);
      for (const file of candidates) {
        const digest = await hashOne(file);
        if (!digest) break;
        if (digest === entry.sha256) {
          claim(entryId, file, "sha256", digest);
          report.adoptedByHash++;
          break;
        }
      }
    }
  }

  // ── 第 5 级（保守启发式）：同名 + 同大小，且候选唯一才认领，并记进 suspected 供人工核对
  if (freeEntries.size && freeFiles.size) {
    const filesByName = new Map();
    for (const file of freeFiles.values()) {
      const name = path.basename(file.relPath);
      const list = filesByName.get(name) ?? [];
      list.push(file);
      filesByName.set(name, list);
    }
    for (const [entryId, entry] of [...freeEntries]) {
      const name = entry.relPath ? path.basename(entry.relPath) : "";
      if (!name || !rowById.has(entryId)) continue;
      const candidates = (filesByName.get(name) ?? []).filter((f) => entry.size === undefined || f.size === entry.size);
      if (candidates.length !== 1) continue;
      claim(entryId, candidates[0], "name-size");
      report.suspected++;
    }
  }

  // ── 落库 1：认领成功的条目（path 是全局唯一约束，冲突只记录不崩）
  const updateAsset = lib.db.prepare(
    "UPDATE assets SET path=?,name=?,ext=?,size=?,mtime=?,dev=?,ino=?,online=1 WHERE id=?",
  );
  const setDigest = lib.db.prepare("UPDATE assets SET sha256=? WHERE id=?");
  const claimOrder = [...claims.entries()].sort((a, b) => (a[1].how === "path" ? -1 : 0) - (b[1].how === "path" ? -1 : 0));
  const insertRecovered = lib.db.prepare(
    "INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,created_ms,category,sub,basis,review,dev,ino,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const adoptMeta = lib.db.prepare("UPDATE assets SET tags=?,note=?,category=?,sub=?,favorite=?,captured_ms=? WHERE id=?");
  for (const [entryId, { file, how, digest }] of claimOrder) {
    const entry = manifest.entries[entryId];
    const parentChanged = path.dirname(entry.relPath || "") !== path.dirname(file.relPath);
    if (!rowById.has(entryId)) {
      // 清单条目还在、数据库行没了（数据库被删/换机/重建）：清单是这些元数据的唯一副本，
      // 所以这里无论 importMetadata 开关都要并入，否则"数据库可重建"就是空话。
      const meta = metaFromEntry(entry);
      const live = rowByPath.get(file.abs); // 扫描可能已经把这个文件重新入了库（新 id）
      if (live) {
        adoptMeta.run(meta.tags ?? "[]", meta.note ?? "", meta.category ?? "", meta.sub ?? "", meta.favorite ?? 0, meta.captured_ms ?? null, live.id);
        manifest.entries[live.id] = { ...entry, ...meta, relPath: file.relPath, dev: file.dev, ino: file.ino, size: file.size };
        delete manifest.entries[entryId];
      } else {
        insertRecovered.run(
          entryId, root.id, file.abs, path.basename(file.relPath),
          path.extname(file.relPath).slice(1).toLowerCase(),
          kindForExt(path.extname(file.relPath).slice(1).toLowerCase(), root.kind) || "sfx",
          file.size, file.mtimeMs, fileCreated({ birthtimeMs: file.birthtimeMs }),
          meta.category ?? "", meta.sub ?? "", "清单恢复", 0, file.dev, file.ino, digest ?? entry.sha256 ?? null,
        );
        adoptMeta.run(meta.tags ?? "[]", meta.note ?? "", meta.category ?? "", meta.sub ?? "", meta.favorite ?? 0, meta.captured_ms ?? null, entryId);
      }
      report.recovered = (report.recovered || 0) + 1;
      continue;
    }
    // 稳态下（外部没动过）绝大多数条目都没变：这时**一次数据库写入都不该发生**。
    // 否则每次启动都要对上万个资产逐行 UPDATE，走 MySQL worker 的 IPC 会拖到几分钟。
    const rowNow = rowById.get(entryId);
    const unchanged =
      rowNow &&
      rowNow.path === file.abs &&
      Number(rowNow.size) === file.size &&
      Math.abs(Number(rowNow.mtime) - file.mtimeMs) < 1 &&
      Number(rowNow.dev) === file.dev &&
      Number(rowNow.ino) === file.ino;
    if (unchanged) report.skipped++;
    try {
      if (!unchanged)
        updateAsset.run(
          file.abs,
          path.basename(file.relPath),
          path.extname(file.relPath).slice(1).toLowerCase(),
          file.size,
          file.mtimeMs,
          file.dev,
          file.ino,
          entryId,
        );
    } catch (e) {
      // 例如另一条陈旧记录仍占着这个 path：交给人工核对，绝不动文件
      report.conflicts.push({ entryId, path: file.abs, error: String(e.message || e), code: e.code, errno: e.errno, sql: e.sql });
      continue;
    }
    if (digest) {
      setDigest.run(digest, entryId);
    } else if (rowNow && (Number(rowNow.size) !== file.size || Math.abs(Number(rowNow.mtime) - file.mtimeMs) >= 1)) {
      // 文件内容原地变了（size/mtime 变）而本轮没重算哈希：**必须清掉旧哈希**，
      // 否则将来跨盘移动时会拿过期哈希去匹配，认不回来。
      lib.db.prepare("UPDATE assets SET sha256=NULL WHERE id=?").run(entryId);
      delete entry.sha256;
    }
    entry.relPath = file.relPath;
    entry.size = file.size;
    entry.dev = file.dev;
    entry.ino = file.ino;
    if (digest) entry.sha256 = digest;
    delete entry.state;
    if (how === "ino" || how === "xattr" || how === "sha256") {
      if (parentChanged) report.moved++;
      else report.renamed++;
    }
    // xattr 打标：每个文件一次进程调用，必须限量；tagged 记在清单里，逐轮收敛（首轮不会一次打几千个）
    const needTag = how !== "path" || entry.tagged !== true;
    if (needTag && opts.tagFiles !== false && report.tagged < (opts.tagBudget ?? TAG_BUDGET_FILES)) {
      if (await writeAssetId(file.abs, entryId)) {
        entry.tagged = true;
        report.tagged++;
      }
    }
  }

  // ── 落库 2：未认领的文件 → 新素材（外部新增/移入的正常路径）
  const insertAsset = lib.db.prepare(
    "INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,created_ms,category,sub,basis,review,dev,ino,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const file of [...freeFiles.values()]) {
    const ext = path.extname(file.relPath).slice(1).toLowerCase();
    const kind = kindForExt(ext, root.kind);
    if (!kind) continue; // 非媒体文件不索引（与扫描器口径一致）
    const newId = id();
    try {
      insertAsset.run(
        newId,
        root.id,
        file.abs,
        path.basename(file.relPath),
        ext,
        kind,
        file.size,
        file.mtimeMs,
        fileCreated({ birthtimeMs: file.birthtimeMs }),
        root.kind === "music" ? path.basename(path.dirname(file.relPath)) : "",
        "",
        "",
        0,
        file.dev,
        file.ino,
        null,
      );
    } catch (e) {
      report.conflicts.push({ path: file.abs, error: String(e.message || e), code: e.code, errno: e.errno, sql: e.sql });
      continue;
    }
    manifest.entries[newId] = {
      relPath: file.relPath,
      size: file.size,
      dev: file.dev,
      ino: file.ino,
      tags: [],
      note: "",
      category: "",
      sub: "",
      favorite: false,
      confirmed: false,
      capturedMs: null,
    };
    if (opts.tagFiles !== false && report.tagged < (opts.tagBudget ?? TAG_BUDGET_FILES)) {
      if (await writeAssetId(file.abs, newId)) report.tagged++;
    }
    lib.enqueue(newId, true); // 参数与拍摄日期交给既有的后台任务读取
    report.added++;
  }

  // ── 落库 3：认领不到的条目 → 只标离线，**绝不删除**
  const markOffline = lib.db.prepare("UPDATE assets SET online=0 WHERE id=?");
  for (const [entryId, entry] of freeEntries) {
    if (!rowById.has(entryId)) continue;
    markOffline.run(entryId);
    entry.state = "missing";
    entry.missingSince = entry.missingSince || new Date().toISOString();
    report.missing++;
  }

  // ── 元数据：先按需"清单 → 数据库"并入，再"数据库 → 清单"镜像（默认方向只有一个，不会互相覆盖）
  const freshRows = new Map(assetsOfRoot(lib, root.id).map((r) => [r.id, r]));
  for (const [entryId, entry] of Object.entries(manifest.entries)) {
    let row = freshRows.get(entryId);
    if (!row) continue;
    if (opts.importMetadata) {
      const meta = metaFromEntry(entry);
      const next = {
        tags: meta.tags ?? row.tags,
        note: meta.note ?? row.note,
        category: meta.category ?? row.category,
        sub: meta.sub ?? row.sub,
        favorite: meta.favorite ?? row.favorite,
      };
      try {
        lib.db
          .prepare("UPDATE assets SET tags=?,note=?,category=?,sub=?,favorite=? WHERE id=?")
          .run(next.tags, next.note, next.category, next.sub, next.favorite, entryId);
        if (meta.captured_ms !== undefined)
          lib.db.prepare("UPDATE assets SET captured_ms=? WHERE id=?").run(meta.captured_ms, entryId);
        row = { ...row, ...meta, ...next };
      } catch (e) {
        report.conflicts.push({ entryId, error: "元数据并入失败：" + String(e.message || e), code: e.code, errno: e.errno, sql: e.sql });
      }
    }
    Object.assign(entry, entryFromAsset({ ...row, rel_path: entry.relPath }), {
      relPath: entry.relPath,
      dev: entry.dev,
      ino: entry.ino,
      size: entry.size,
      ...(entry.state ? { state: entry.state } : {}),
      ...(entry.missingSince ? { missingSince: entry.missingSince } : {}),
    });
  }

  // ── 渐进补齐 sha256：给"已认领但没有哈希"的条目补，受预算限制；多跑几轮自然补全
  for (const entryId of claims.keys()) {
    const entry = manifest.entries[entryId];
    if (!entry || entry.sha256) continue;
    if (report.hashed >= hashBudgetFiles || hashedBytes >= hashBudgetBytes) break;
    const digest = await sha256File(path.join(root.path, entry.relPath)).catch(() => null);
    if (!digest) continue;
    report.hashed++;
    hashedBytes += entry.size ?? 0;
    entry.sha256 = digest;
    try {
      setDigest.run(digest, entryId);
    } catch {}
  }

  // ── 写清单 + 记版本号（写不进去不算失败：只读挂载/容器只读模式仍然可以索引）
  manifest.revision = Number(manifest.revision || 0) + 1;
  try {
    await writeManifest(root, manifest);
  } catch (e) {
    report.manifestWriteError = String(e.code || e.message);
  }
  lib.db.prepare("UPDATE roots SET revision=COALESCE(revision,0)+1,reconciled_ms=? WHERE id=?").run(Date.now(), root.id);
  // 根本身读不到（被改名/搬走/未挂载）→ 明确标离线，界面据此给出"重新指定位置"的提醒；
  // 只有个别子目录读不到时不动在线状态（不制造误报）。
  const rootReachable = await fs.access(root.path).then(() => true).catch(() => false);
  if (!rootReachable) lib.db.prepare("UPDATE roots SET online=0 WHERE id=?").run(root.id);
  else if (!report.walkErrors.length) lib.db.prepare("UPDATE roots SET online=1 WHERE id=?").run(root.id);
  report.rootReachable = rootReachable;
  report.revision = manifest.revision;
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * 精简路径对账：只处理监听报出来的少量路径（外部改名/移动的"快路径"）。
 * 返回 { handled, needFullReconcile, ... }；`needFullReconcile` 为真时调用方应跑一次全量。
 */
export async function reconcilePaths(lib, root, relPaths, opts = {}) {
  const targets = [...new Set(relPaths.map((r) => String(r).split(path.sep).join("/")))].filter((r) => !isIgnoredRel(r));
  if (!targets.length) return { handled: 0, needFullReconcile: false };
  const report = { handled: 0, needFullReconcile: false, vanished: 0, adopted: 0, touched: 0 };
  let createdManifest = false;
  let manifest = (await readManifest(root)).manifest;
  if (manifest) manifest = normalizeEntryPaths(root, manifest);
  if (!manifest) {
    // 清单还不存在（例如刚登记目录就发生外部改名）：就地物化一份，
    // 否则元数据只留在数据库里，数据库一丢身份就没了 —— 那正是这次改造要消灭的情况。
    manifest = await materializeManifest(lib, root);
    createdManifest = true;
  }
  const byPath = lib.db.prepare("SELECT * FROM assets WHERE path=?");
  const justOffline = []; // 本轮刚被标离线的记录：外部改名时"旧名字"就在这里

  // 第一遍：已经消失的路径（改名/移走的"旧名字"）先标离线，给第二遍腾出候选
  for (const rel of targets) {
    const abs = path.join(root.path, rel);
    try {
      await fs.stat(abs);
    } catch {
      const row = byPath.get(abs);
      if (row && !row.trashed && row.online) {
        lib.db.prepare("UPDATE assets SET online=0 WHERE id=?").run(row.id);
        justOffline.push(row);
        report.vanished++;
      }
    }
  }

  // 第二遍：仍在的路径刷新身份；新路径按"同根内离线 + 同名 + 同大小且唯一"认领
  for (const rel of targets) {
    const abs = path.join(root.path, rel);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const ext = path.extname(rel).slice(1).toLowerCase();
    const current = byPath.get(abs);
    if (current) {
      if (!current.trashed) {
        lib.db
          .prepare("UPDATE assets SET size=?,mtime=?,dev=?,ino=?,online=1 WHERE id=?")
          .run(stat.size, stat.mtimeMs, stat.dev, stat.ino, current.id);
        report.touched++;
      }
      continue;
    }
    // ① 先按 dev:ino 精确认领：外部改名时旧记录仍是旧名字，只有 inode 能对上
    let candidates = lib.db
      .prepare("SELECT * FROM assets WHERE root_id=? AND trashed=0 AND dev=? AND ino=?")
      .all(root.id, stat.dev, stat.ino);
    // ② 退一步：本轮刚离线 + 同大小 + 同扩展名，且唯一 —— 覆盖"建库后还没记过身份就改名"的情况
    if (!candidates.length && justOffline.length) {
      const hits = justOffline.filter((r) => r.size === stat.size && String(r.ext || "").toLowerCase() === ext);
      if (hits.length === 1) candidates = hits;
    }
    // ③ 再退到"同根内离线 + 同名 + 同大小"，覆盖跨目录移动但没改名的场景
    if (!candidates.length)
      candidates = lib.db
        .prepare("SELECT * FROM assets WHERE root_id=? AND trashed=0 AND name=? AND size=? AND online=0")
        .all(root.id, path.basename(rel), stat.size);
    if (candidates.length === 1) {
      const target = candidates[0];
      try {
        lib.db
          .prepare("UPDATE assets SET path=?,name=?,ext=?,size=?,mtime=?,dev=?,ino=?,online=1 WHERE id=?")
          .run(abs, path.basename(rel), ext, stat.size, stat.mtimeMs, stat.dev, stat.ino, target.id);
      } catch {
        report.needFullReconcile = true; // 目标路径被别的记录占着，交给全量对账精确处理
        continue;
      }
      if (manifest?.entries?.[target.id]) {
        Object.assign(manifest.entries[target.id], { relPath: rel, size: stat.size, dev: stat.dev, ino: stat.ino });
      }
      if (opts.tagFiles !== false) await writeAssetId(abs, target.id);
      report.adopted++;
      report.handled++;
      continue;
    }
    // 0 个候选（可能是外部新增文件）或多个候选（歧义）→ 交给全量对账精确处理
    report.needFullReconcile = true;
  }

  if (report.adopted || report.vanished || createdManifest) {
    report.manifestCreated = createdManifest;
    manifest.revision = Number(manifest.revision || 0) + 1;
    try {
      await writeManifest(root, manifest);
    } catch (e) {
      report.manifestWriteError = String(e.code || e.message);
    }
    lib.db.prepare("UPDATE roots SET revision=COALESCE(revision,0)+1,reconciled_ms=? WHERE id=?").run(Date.now(), root.id);
    report.revision = manifest.revision;
  }
  return report;
}

/**
 * 监听所有登记根：外部改名/移动后触发精简对账，兜不住再跑全量。
 * 返回 { stop, refresh, activeRoots }；`refresh` 用于新增/删除根之后重建监听。
 */
export function startWatcher(lib, options = {}) {
  const debounceMs = options.debounceMs ?? 700;
  const log = options.log ?? ((msg) => console.log(msg));
  const watch = options.watchFn ?? fsWatch;
  const watchers = new Map();
  const pending = new Map();
  let timer = null;
  let running = false;
  let needFull = false;

  const busy = () => lib.locks.size > 0 || [...lib.jobs.values()].some((j) => j.status === "running") || running;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), debounceMs);
  };
  const runFull = async () => {
    for (const root of lib.roots()) await reconcileRoot(lib, root, { ...options, hashBudgetFiles: 0, hashBudgetBytes: 0 });
  };

  async function flush() {
    timer = null;
    if (busy()) {
      schedule(); // 应用正在做文件操作/扫描：等它做完再对账，避免互相干扰
      return;
    }
    const batch = new Map(pending);
    pending.clear();
    const full = needFull;
    needFull = false;
    if (!batch.size && !full) return;
    running = true;
    try {
      if (full) {
        await runFull();
      } else {
        for (const root of lib.roots()) {
          const rels = batch.get(root.id);
          if (!rels) continue;
          const result = await reconcilePaths(lib, root, [...rels], options);
          if (result.needFullReconcile) needFull = true;
        }
        if (needFull) {
          await runFull();
          needFull = false;
        }
      }
    } catch (e) {
      log(`[reconcile] 对账失败：${e.message}`);
    } finally {
      running = false;
      if (pending.size) schedule();
    }
  }

  function onEvent(root, filename) {
    if (filename == null) {
      needFull = true; // 个别平台不报具体名字，只能全量
      schedule();
      return;
    }
    const rel = String(filename).split(path.sep).join("/");
    if (isIgnoredRel(rel)) return;
    const set = pending.get(root.id) ?? new Set();
    set.add(rel);
    pending.set(root.id, set);
    schedule();
  }

  function watchRoot(root) {
    try {
      const watcher = watch(root.path, { recursive: true }, (_event, filename) => onEvent(root, filename));
      watcher.on?.("error", () => {
        watchers.delete(root.id);
        try {
          watcher.close();
        } catch {}
      });
      return watcher;
    } catch (e) {
      log(`[reconcile] 无法监听 ${root.path}：${e.code || e.message}`);
      return null;
    }
  }

  /** 清单缺失时才建；已损坏的交给全量对账处理（那里会留证并重建），避免这里静默覆盖。 */
  async function ensureManifest(root) {
    try {
      const { manifest, reason } = await readManifest(root);
      if (manifest || reason !== "missing") return;
      await writeManifest(root, await materializeManifest(lib, root));
    } catch {}
  }

  async function refresh() {
    const roots = lib.roots();
    const ids = new Set(roots.map((r) => r.id));
    const byId = new Map(roots.map((r) => [r.id, r]));
    for (const [rootId, entry] of [...watchers]) {
      const root = byId.get(rootId);
      // 根被注销/删除，或**路径被迁移**：都要重挂监听，否则会继续盯着旧路径
      if (root && root.path === entry.path) continue;
      try {
        entry.watcher.close();
      } catch {}
      watchers.delete(rootId);
    }
    for (const root of roots) {
      if (watchers.has(root.id)) continue;
      const watcher = watchRoot(root);
      if (watcher) {
        watchers.set(root.id, { watcher, path: root.path });
        void ensureManifest(root); // 新监听的根立即补一份清单，别等下一次全量对账
      }
    }
  }

  // 兜底刷新：目录增删由路由显式 refresh()，这里再兜一层，间隔短一点代价很小（只比对 id）
  const refreshTimer = setInterval(() => void refresh(), 5000);
  void refresh();

  return {
    refresh,
    stop() {
      if (timer) clearTimeout(timer);
      clearInterval(refreshTimer);
      for (const entry of watchers.values()) {
        try {
          entry.watcher.close();
        } catch {}
      }
      watchers.clear();
    },
    get activeRoots() {
      return watchers.size;
    },
  };
}

/**
 * 清单同步器：界面里改了标签/备注/分类后，把清单尽快刷新（防抖），
 * 这样"GPT 直接读清单"看到的永远是最新元数据，而不是上次对账时的旧值。
 *
 * 为什么用防抖 + 重建而不是"每次编辑重写一遍"：批量打标签会触发成百次编辑，
 * 每次都重写 JSON 既慢又容易互相覆盖；这里合并成 1 秒内一次原子替换。
 *
 * 由 index.mjs 注入到 `lib.onMetadataChanged`，避免 library.mjs 反向依赖本模块。
 */
export function createManifestSync(lib, options = {}) {
  const debounceMs = options.debounceMs ?? 1000;
  const log = options.log ?? (() => {});
  const dirty = new Set();
  let all = false;
  let timer = null;
  let writing = false;

  const strip = (entry) => {
    const out = {};
    for (const [k, v] of Object.entries(entry)) if (v !== undefined) out[k] = v;
    return out;
  };

  async function writeRoot(root) {
    const { manifest } = await readManifest(root);
    const built = await materializeManifest(lib, root);
    for (const [entryId, entry] of Object.entries(built.entries)) {
      const previous = manifest?.entries?.[entryId];
      // 保留上一版里的未知字段、dev/ino、sha256、tagged 与 missing 痕迹；受管字段用数据库现值覆盖
      built.entries[entryId] = previous ? { ...previous, ...strip(entry) } : strip(entry);
    }
    for (const [entryId, previous] of Object.entries(manifest?.entries ?? {}))
      if (!built.entries[entryId]) built.entries[entryId] = previous;
    built.revision = Number(manifest?.revision || 0) + 1;
    await writeManifest(root, built);
  }

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => void flush(), debounceMs);
  };

  async function flush() {
    timer = null;
    if (writing) return schedule();
    const roots = all ? lib.roots() : lib.roots().filter((r) => dirty.has(r.id));
    all = false;
    dirty.clear();
    if (!roots.length) return;
    writing = true;
    try {
      for (const root of roots) {
        try {
          await writeRoot(root);
        } catch (e) {
          log(`[manifest] ${root.path} 清单同步失败：${e.code || e.message}`);
        }
      }
    } finally {
      writing = false;
    }
  }

  return {
    /** 标记某个根（或不传 = 全部）的元数据已变更，防抖后写清单 */
    touch(rootId) {
      if (rootId) dirty.add(rootId);
      else all = true;
      schedule();
    },
    flush,
    stop() {
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * 把一个根迁移到新路径（整目录改名 / 搬盘）。
 *
 * 关键设计：**保持同一个 root_id**，只改 roots.path，然后让对账把每条素材按身份重新认领，
 * 因此 assets.id 不变 → 标签、备注、分类、项目关联全部天然保留（不需要迁移任何关联表）。
 * 有意不做 SQL 前缀替换：那样要处理两种方言的字符串函数，还会撞 path 唯一约束。
 */
export async function relocateRoot(lib, rootId, input, opts = {}) {
  const root = lib.rootById(rootId);
  if (root.retired) throw Error("该目录已注销，请先恢复登记再迁移路径");
  if (typeof input !== "string" || !input.trim() || !path.isAbsolute(input)) throw Error("请输入绝对路径");
  const next = await fs.realpath(input).catch(() => {
    throw Error("新路径不存在或无法访问");
  });
  if (!(await fs.stat(next)).isDirectory()) throw Error("请选择文件夹");
  if (next === root.path) throw Error("新旧路径相同，无需迁移");
  if (next === path.parse(next).root) throw Error("不能指向磁盘根目录");
  if (within(next, lib.dataDir) || within(lib.dataDir, next)) throw Error("不能指向应用数据目录或其上级");
  for (const other of lib.allRoots()) {
    if (other.id === rootId) continue;
    if (within(next, other.path) || within(other.path, next))
      throw Error(`新路径与${other.retired ? "已注销" : "已登记"}目录「${other.name}」重叠，请选择互不包含的文件夹`);
  }

  // 预检：新位置与原根的重合度（同盘靠 dev:ino，跨盘退化为"相对位置相同 + 同大小"）
  const rows = lib.db.prepare("SELECT id,path,size,dev,ino FROM assets WHERE root_id=? AND trashed=0").all(rootId);
  const files = await walkFiles({ path: next, name: root.name, kind: root.kind });
  const byIno = new Map(files.map((f) => [`${f.dev}:${f.ino}`, f]));
  const byRel = new Map(files.map((f) => [f.relPath, f]));
  let matched = 0;
  for (const row of rows) {
    if (row.dev && row.ino && byIno.has(`${row.dev}:${row.ino}`)) {
      matched++;
      continue;
    }
    const rel = path.relative(next, row.path).split(path.sep).join("/");
    const candidate = rel && !rel.startsWith("..") ? byRel.get(rel) : null;
    if (candidate && (!row.size || candidate.size === row.size)) matched++;
  }
  const total = rows.length;
  const ratio = total ? matched / total : 1;
  const oldExists = await fs.stat(root.path).then(() => true).catch(() => false);
  const warnings = [];
  if (total && ratio < (opts.minRatio ?? 0.5))
    warnings.push(`新位置只匹配到 ${Math.round(ratio * 100)}% 的原有素材（${matched}/${total}）`);
  if (oldExists) warnings.push("旧路径仍然存在，这可能是一次复制而不是搬家");
  if (warnings.length && opts.confirm !== true)
    return { needsConfirm: true, matchRatio: ratio, matched, total, oldPath: root.path, newPath: next, warnings };

  const offlineBefore = lib.db.prepare("SELECT COUNT(*) n FROM assets WHERE root_id=? AND trashed=0 AND online=0").get(rootId).n;
  lib.db.prepare("UPDATE roots SET path=?,name=?,online=1 WHERE id=?").run(next, path.basename(next), rootId);
  const manifest = await moveManifest(root.path, next).catch((e) => ({ moved: false, reason: String(e.message || e) }));
  const report = await reconcileRoot(lib, lib.rootById(rootId), {
    tagFiles: opts.tagFiles,
    hashBudgetFiles: opts.hashBudgetFiles ?? 0,
    hashBudgetBytes: opts.hashBudgetBytes ?? 0,
  });
  const offlineAfter = lib.db.prepare("SELECT COUNT(*) n FROM assets WHERE root_id=? AND trashed=0 AND online=0").get(rootId).n;
  const verified = report.conflicts.length === 0 && offlineAfter <= offlineBefore;
  const risky = warnings.length > 0; // 已经过人工确认才会走到这里
  let rolledBack = false;
  if (!verified && oldExists && !risky) {
    // 未确认的高风险迁移：只有旧位置还在时才可能回滚（改回去再对账一次，凭 dev:ino/xattr 仍能认回）
    lib.db.prepare("UPDATE roots SET path=?,name=? WHERE id=?").run(root.path, root.name, rootId);
    await reconcileRoot(lib, lib.rootById(rootId), { hashBudgetFiles: 0, hashBudgetBytes: 0 }).catch(() => {});
    rolledBack = true;
  } else if (!verified) {
    // 用户已明确确认"这就是搬家"：保留迁移结果（roots.path 指向新位置才是事实），
    // 但把失联/冲突如实回报，界面据此提示核对。
    lib.db.prepare("UPDATE roots SET online=0 WHERE id=?").run(rootId);
  }
  return {
    ok: verified,
    needsAttention: !verified,
    warnings,
    rolledBack,
    manifest,
    matchRatio: ratio,
    matched,
    total,
    offlineBefore,
    offlineAfter,
    report: {
      moved: report.moved, renamed: report.renamed, adopted: report.adoptedByXattr + report.adoptedByHash,
      added: report.added, missing: report.missing, conflicts: report.conflicts.length, skipped: report.skipped, elapsedMs: report.elapsedMs,
    },
  };
}
