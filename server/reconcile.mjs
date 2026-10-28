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
import { repairRootState, mergeAlias } from "./asset-repair.mjs";
import { watch as fsWatch } from "node:fs";
import path from "node:path";
import { fileCreated, id } from "./library.mjs";
import { kindForExt, readAssetId, rootIdentity, sha256File, walkFiles, within, writeAssetId } from "./fs-identity.mjs";
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

function registeredRootSnapshot(lib, expected) {
  const current = lib.db.prepare("SELECT * FROM roots WHERE id=?").get(expected.id);
  return current && !current.retired && current.path === expected.path && current.kind === expected.kind ? current : null;
}
function rootRegistrationUnchanged(lib, snapshot) {
  const current = snapshot && registeredRootSnapshot(lib, snapshot);
  return !!current && Number(current.revision || 0) === Number(snapshot.revision || 0);
}

async function adoptMovedFromRoot(lib, root, file) {
  const targetRegistration = registeredRootSnapshot(lib, root);
  if (!targetRegistration || !file.dev || !file.ino) return null;
  const rows = lib.db.prepare("SELECT * FROM assets WHERE dev=? AND ino=? AND trashed=0 LIMIT 3").all(file.dev, file.ino);
  if (rows.length !== 1) return null;
  const previous = rows[0];
  if (previous.root_id === root.id || lib.locks.has(previous.id) || previous.size !== file.size ||
      Math.abs(previous.mtime - file.mtimeMs) >= 1 ||
      previous.kind !== kindForExt(path.extname(file.abs).slice(1), root.kind)) return null;
  const oldRoot = lib.roots().find(r => r.id === previous.root_id && !r.retired);
  if (!oldRoot || !within(oldRoot.path, previous.path)) return null;
  try {
    const oldKey = await rootIdentity(oldRoot), newKey = await rootIdentity(root);
    try { await fs.lstat(previous.path); return null; }
    catch (error) { if (error.code !== "ENOENT") return null; }
    const real = await fs.realpath(file.abs), current = await fs.lstat(file.abs);
    if (real !== file.abs || !within(root.path, real) || !current.isFile() || current.nlink !== 1 ||
        current.dev !== file.dev || current.ino !== file.ino || current.size !== file.size ||
        Math.abs(current.mtimeMs - file.mtimeMs) >= 1) return null;
    if (oldKey !== await rootIdentity(oldRoot) || newKey !== await rootIdentity(root)) return null;
    try { await fs.lstat(previous.path); return null; }
    catch (error) { if (error.code !== "ENOENT") return null; }
    return lib.db.transaction(() => {
      if (!rootRegistrationUnchanged(lib, oldRoot) || !rootRegistrationUnchanged(lib, targetRegistration)) return null;
      const fresh = lib.db.prepare("SELECT * FROM assets WHERE id=?").get(previous.id);
      if (!fresh || fresh.trashed || fresh.root_id !== previous.root_id || fresh.path !== previous.path ||
          fresh.dev !== previous.dev || fresh.ino !== previous.ino || fresh.size !== previous.size ||
          fresh.mtime !== previous.mtime || lib.locks.has(previous.id) ||
          lib.db.prepare("SELECT id FROM assets WHERE path=?").get(file.abs) ||
          lib.db.prepare("SELECT id FROM operations WHERE asset_id=? AND status='pending'").get(previous.id)) return null;
      lib.db.prepare("UPDATE assets SET root_id=?,path=?,name=?,ext=?,sha256=NULL,online=1,file_status='unknown',file_checked_ms=0 WHERE id=?")
        .run(root.id, file.abs, path.basename(file.abs), path.extname(file.abs).slice(1).toLowerCase(), previous.id);
      lib.db.prepare("UPDATE roots SET revision=COALESCE(revision,0)+1 WHERE id=?").run(previous.root_id);
      return lib.db.prepare("SELECT * FROM assets WHERE id=?").get(previous.id);
    })();
  } catch { return null; }
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
async function trackedIndexWork(lib, deferred, work) {
  if (lib.locks.size) return { ...deferred, deferred: true, repairPending: true, code: "ASSET_OPERATION_IN_PROGRESS" };
  const count = lib.repairIndexReaders ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count >= 1024) throw Object.assign(Error("INDEX_ACTIVITY_UNKNOWN"), { code: "INDEX_ACTIVITY_UNKNOWN" });
  lib.repairIndexReaders = count + 1;
  try { return await work(); }
  finally { const current = lib.repairIndexReaders; lib.repairIndexReaders = Number.isSafeInteger(current) && current > 0 ? current - 1 : NaN; }
}
export async function reconcileRoot(lib, root, opts = {}) {
  const work = () => trackedIndexWork(lib, { mode: "full", rootId: root.id, skipped: 0, walkErrors: [], conflicts: [] }, () => reconcileRootWork(lib, root, opts));
  return lib.scanProof ? lib.scanProof.run(root.id, 'FULL', work, { signal: opts.signal }) : work();
}
async function reconcileRootWork(lib, root, opts = {}) {
  const started = Date.now();
  const targetRegistration = registeredRootSnapshot(lib, root);
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
  if (!targetRegistration) { report.registrationChanged = true; report.elapsedMs = Date.now() - started; return report; }
  const repairManifest = await readManifest(root);
  const repair = repairRootState(lib, root, repairManifest.manifest);
  if (repairManifest.reason === "repair-invalid" || repair.blocked) return { ...report, deferred: true, repairPending: true, code: repair.code || "REPAIR_MARKER_INVALID" };
  // 先判定登记目录本身是否还在：**不可读就立刻退出**。
  // 否则下面的清单写入会 mkdir -p 把"已搬走的旧目录"重新创建出来，随后又判定它可访问，
  // 于是离线判断与"重新指定位置"的提醒全部失效（已实测复现）。
  report.rootReachable = await fs
    .stat(root.path)
    .then((st) => st.isDirectory())
    .catch(() => false);
  if (!report.rootReachable) {
    lib.db.prepare("UPDATE roots SET online=0 WHERE id=?").run(root.id);
    report.walkErrors.push(`${root.path}: 登记目录不存在或不可访问`);
    report.elapsedMs = Date.now() - started;
    return report;
  }

  const manifest = await readManifestOrBuild(lib, root, report);
  if (repairRootState(lib, root, manifest).blocked) return { ...report, deferred: true, repairPending: true, code: "REPAIR_PENDING" };

  const files = await walkFiles(root, {
    onError: (p, e) => report.walkErrors.push(`${relOf(root, p)}: ${e.code || e.message}`),
  });
  const rootRows = assetsOfRoot(lib, root.id);
  const rowById = new Map(rootRows.map((r) => [r.id, r]));
  const rowByPath = new Map(rootRows.map((r) => [r.path, r]));

  // Only nonlocal IDs need a lookup; steady roots must not add an IPC per asset.
  for (const entryId of Object.keys(manifest.entries)) {
    if (mergeAlias(lib, entryId)) { delete manifest.entries[entryId]; continue; }
    if (rowById.has(entryId)) continue;
    const owner = lib.db.prepare("SELECT root_id FROM assets WHERE id=?").get(entryId);
    if (owner && owner.root_id !== root.id) delete manifest.entries[entryId];
  }

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
    // An application move commits the new database path before the debounced manifest is written.
    const recorded = relIfInside(root, rowById.get(entryId)?.path);
    const file = (entry.relPath ? freeFiles.get(entry.relPath) : null) || (recorded ? freeFiles.get(recorded) : null);
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

  // ── 第 5 级：同名 + 同大小且候选唯一。这一级**没有任何身份证据**，只是"看起来像"，
  // 所以默认**只提示、不认领**：以前它直接认领，等于把另一个内容不同的文件继承上旧素材的
  // id 与标签（已实测复现：两个内容不同的同名同大小文件，旧标签被错误继承）。
  // 现在：
  //   · 条目已有 sha256 而候选哈希不同 → 这是"不是同一个文件"的正面证据，直接排除；
  //   · 默认只记进 report.suspected（供人工确认），除非显式 opts.adoptSuspected / MEDIA_ADOPT_SUSPECTED=1；
  //   · 真正可靠的同盘改名/移动由第 2 级 dev:ino 覆盖，所以收紧这里几乎不损失能力。
  if (freeEntries.size && freeFiles.size) {
    const adoptSuspected = opts.adoptSuspected ?? process.env.MEDIA_ADOPT_SUSPECTED === "1";
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
      const candidates = (filesByName.get(name) ?? []).filter(
        (f) => freeFiles.has(f.relPath) && (entry.size === undefined || f.size === entry.size),
      );
      if (candidates.length !== 1) continue;
      const candidate = candidates[0];
      if (entry.sha256) {
        const digest = await sha256File(candidate.abs).catch(() => null);
        if (digest && digest !== entry.sha256) {
          report.hashMismatch = (report.hashMismatch || 0) + 1;
          continue; // 内容不同：绝不认领
        }
      }
      report.suspected++;
      (report.suspectedClaims ||= []).push({
        entryId,
        relPath: candidate.relPath,
        size: candidate.size,
        reason: entry.sha256 ? "同名同大小且哈希一致" : "同名同大小且候选唯一（无哈希证据）",
      });
      if (!adoptSuspected) continue;
      claim(entryId, candidate, "name-size");
    }
  }

  // ── 落库 1：认领成功的条目（path 是全局唯一约束，冲突只记录不崩）
  const updateAsset = lib.db.prepare(
    "UPDATE assets SET path=?,name=?,ext=?,size=?,mtime=?,dev=?,ino=?,online=1,file_checked_ms=0,file_status='unknown' WHERE id=?",
  );
  const setDigest = lib.db.prepare("UPDATE assets SET sha256=? WHERE id=?");
  const claimOrder = [...claims.entries()].sort((a, b) => (a[1].how === "path" ? -1 : 0) - (b[1].how === "path" ? -1 : 0));
  const insertRecovered = lib.db.prepare(
    "INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,created_ms,category,sub,basis,review,dev,ino,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const adoptMeta = lib.db.prepare("UPDATE assets SET tags=?,note=?,category=?,sub=?,favorite=?,captured_ms=?,capture_source=?,confirmed=? WHERE id=?");
  for (const [entryId, { file, how, digest }] of claimOrder) {
    const entry = manifest.entries[entryId];
    const parentChanged = path.dirname(entry.relPath || "") !== path.dirname(file.relPath);
    if (!rowById.has(entryId)) {
      // 清单条目还在、数据库行没了（数据库被删/换机/重建）：清单是这些元数据的唯一副本，
      // 所以这里无论 importMetadata 开关都要并入，否则"数据库可重建"就是空话。
      const meta = metaFromEntry(entry);
      const live = rowByPath.get(file.abs); // 扫描可能已经把这个文件重新入了库（新 id）
      if (live) {
        lib.metadataVersions.edit(live.id, () => adoptMeta.run(meta.tags ?? "[]", meta.note ?? "", meta.category ?? "", meta.sub ?? "", meta.favorite ?? 0, meta.captured_ms ?? null, meta.capture_source ?? "", meta.confirmed ?? 0, live.id), { source: "import", forceUnknown: true });
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
        lib.metadataVersions.edit(entryId, () => adoptMeta.run(meta.tags ?? "[]", meta.note ?? "", meta.category ?? "", meta.sub ?? "", meta.favorite ?? 0, meta.captured_ms ?? null, meta.capture_source ?? "", meta.confirmed ?? 0, entryId), { source: "import", forceUnknown: true });
      }
      report.recovered = (report.recovered || 0) + 1;
      continue;
    }
    // 稳态下（外部没动过）绝大多数条目都没变：这时**一次数据库写入都不该发生**。
    // 否则每次启动都要对上万个资产逐行 UPDATE，走 MySQL worker 的 IPC 会拖到几分钟。
    const rowNow = rowById.get(entryId);
    const bindingChanged = !!entry.fingerprintBinding && entry.fingerprintBinding.file?.ctimeMs !== file.ctimeMs;
    const unchanged =
      rowNow &&
      Number(rowNow.online) === 1 && !bindingChanged &&
      rowNow.path === file.abs &&
      !["missing", "offline", "unavailable"].includes(rowNow.file_status) &&
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
    } else if (rowNow && (rowNow.path !== file.abs || Number(rowNow.size) !== file.size || Number(rowNow.mtime) !== file.mtimeMs || Number(rowNow.dev) !== file.dev || Number(rowNow.ino) !== file.ino || bindingChanged)) {
      // 文件内容原地变了（size/mtime 变）而本轮没重算哈希：**必须清掉旧哈希**，
      // 否则将来跨盘移动时会拿过期哈希去匹配，认不回来。
      lib.db.prepare("UPDATE assets SET sha256=NULL WHERE id=?").run(entryId);
      delete entry.sha256;
    }
    if (rowNow && (rowNow.path !== file.abs || Number(rowNow.size) !== file.size || Number(rowNow.mtime) !== file.mtimeMs || Number(rowNow.dev) !== file.dev || Number(rowNow.ino) !== file.ino) || digest || bindingChanged) delete entry.fingerprintBinding;
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
    const moved = await adoptMovedFromRoot(lib, root, file);
    if (moved) {
      manifest.entries[moved.id] = { ...entryFromAsset(moved), relPath: file.relPath, dev: file.dev, ino: file.ino, size: file.size };
      report.moved++;
      continue;
    }
    const newId = id();
    try {
      const inserted = lib.db.transaction(() => {
        if (!rootRegistrationUnchanged(lib, targetRegistration)) return false;
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
        return true;
      })();
      if (!inserted) { report.registrationChanged = true; report.skipped++; report.elapsedMs = Date.now() - started; return report; }
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
  const markOffline = lib.db.prepare("UPDATE assets SET online=0 WHERE id=? AND root_id=? AND path=?");
  for (const [entryId, entry] of freeEntries) {
    if (!rowById.has(entryId)) continue;
    markOffline.run(entryId, root.id, rowById.get(entryId).path);
    entry.state = "missing";
    entry.missingSince = entry.missingSince || new Date().toISOString();
    report.missing++;
  }

  // ── 元数据：先按需"清单 → 数据库"并入，再"数据库 → 清单"镜像（默认方向只有一个，不会互相覆盖）
  lib.directoryClassification?.sync(root.id);
  const freshRows = new Map(assetsOfRoot(lib, root.id).map((r) => [r.id, r]));
  for (const [entryId, entry] of Object.entries(manifest.entries)) {
    let row = freshRows.get(entryId);
    if (!row) continue;
    if (opts.importMetadata) {
      const meta = metaFromEntry(entry);
      const next = {
        tags: meta.tags ?? row.tags,
        note: meta.note ?? row.note,
        category: lib.directoryClassification ? row.category : meta.category ?? row.category,
        sub: lib.directoryClassification ? row.sub : meta.sub ?? row.sub,
        favorite: meta.favorite ?? row.favorite,
        confirmed: lib.directoryClassification && row.review ? 0 : meta.confirmed ?? row.confirmed,
      };
      try {
        lib.metadataVersions.edit(entryId, () => {
          lib.db.prepare("UPDATE assets SET tags=?,note=?,category=?,sub=?,favorite=?,confirmed=? WHERE id=?").run(next.tags, next.note, next.category, next.sub, next.favorite, next.confirmed, entryId);
          if (meta.captured_ms !== undefined) lib.db.prepare("UPDATE assets SET captured_ms=?,capture_source=? WHERE id=?").run(meta.captured_ms, meta.capture_source ?? "", entryId);
        }, { source: "import", forceUnknown: true });
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
  // 只有个别子目录读不到时不动在线状态（不制造误报）
  if (!report.walkErrors.length) lib.db.prepare("UPDATE roots SET online=1 WHERE id=?").run(root.id);
  report.revision = manifest.revision;
  report.elapsedMs = Date.now() - started;
  return report;
}

/**
 * 精简路径对账：只处理监听报出来的少量路径（外部改名/移动的"快路径"）。
 * 返回 { handled, needFullReconcile, ... }；`needFullReconcile` 为真时调用方应跑一次全量。
 */
export async function reconcilePaths(lib, root, relPaths, opts = {}) {
  const work = () => trackedIndexWork(lib, { handled: 0, needFullReconcile: false }, () => reconcilePathsWork(lib, root, relPaths, opts));
  return lib.scanProof ? lib.scanProof.run(root.id, 'QUICK', work, { signal: opts.signal }) : work();
}
async function reconcilePathsWork(lib, root, relPaths, opts = {}) {
  const targets = [...new Set(relPaths.map((r) => String(r).split(path.sep).join("/")))].filter((r) => !isIgnoredRel(r));
  if (!targets.length) return { handled: 0, needFullReconcile: false };
  const report = { handled: 0, needFullReconcile: false, vanished: 0, adopted: 0, touched: 0 };
  const targetRegistration = registeredRootSnapshot(lib, root);
  if (!targetRegistration) return { ...report, registrationChanged: true };
  let createdManifest = false;
  const initialManifest = await readManifest(root);
  let manifest = initialManifest.manifest;
  const repair = repairRootState(lib, root, manifest);
  if (initialManifest.reason === "repair-invalid" || repair.blocked) return { ...report, deferred: true, repairPending: true, code: repair.code || "REPAIR_MARKER_INVALID" };
  if (manifest) manifest = normalizeEntryPaths(root, manifest);
  if (!manifest) {
    // 清单还不存在（例如刚登记目录就发生外部改名）：就地物化一份，
    // 否则元数据只留在数据库里，数据库一丢身份就没了 —— 那正是这次改造要消灭的情况。
    manifest = await materializeManifest(lib, root);
    createdManifest = true;
  }
  const byPath = lib.db.prepare("SELECT * FROM assets WHERE path=?");

  // 第一遍：已经消失的路径（改名/移走的"旧名字"）先标离线，给第二遍腾出候选
  for (const rel of targets) {
    const abs = path.join(root.path, rel);
    try {
      await fs.stat(abs);
    } catch {
      const row = byPath.get(abs);
      if (row && !row.trashed && row.online) {
        lib.db.prepare("UPDATE assets SET online=0 WHERE id=?").run(row.id);
        report.vanished++;
      }
      // 该路径下还有记录 → 消失的是一个**目录**，其下文件路径全部变了
      const descendants = lib.db
        .prepare("SELECT 1 AS ok FROM assets WHERE root_id=? AND trashed=0 AND path LIKE ? LIMIT 1")
        .get(root.id, abs + "/%");
      if (descendants) report.needFullReconcile = true;
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
    if (!stat.isFile()) {
      // 目录事件（例如整个子目录被改名）：它下面的每个文件路径都变了，
      // 必须在全量对账里重算，不能当成"没事发生"跳过（已实测复现）。
      report.needFullReconcile = true;
      continue;
    }
    const ext = path.extname(rel).slice(1).toLowerCase();
    const current = byPath.get(abs);
    if (current) {
      if (!current.trashed) {
        lib.db
          .prepare("UPDATE assets SET size=?,mtime=?,dev=?,ino=?,online=1,file_checked_ms=0,file_status='unknown' WHERE id=?")
          .run(stat.size, stat.mtimeMs, stat.dev, stat.ino, current.id);
        if (Number(current.size) !== stat.size || Number(current.mtime) !== stat.mtimeMs || Number(current.dev) !== stat.dev || Number(current.ino) !== stat.ino || manifest.entries[current.id]?.fingerprintBinding?.file?.ctimeMs !== undefined && manifest.entries[current.id].fingerprintBinding.file.ctimeMs !== stat.ctimeMs) {
          lib.db.prepare('UPDATE assets SET sha256=NULL WHERE id=?').run(current.id);
          if (manifest.entries[current.id]) { delete manifest.entries[current.id].sha256; delete manifest.entries[current.id].fingerprintBinding; }
        }
        report.touched++;
      }
      continue;
    }
    // ① 先按 dev:ino 精确认领：外部改名时旧记录仍是旧名字，只有 inode 能对上
    let candidates = lib.db
      .prepare("SELECT * FROM assets WHERE root_id=? AND trashed=0 AND dev=? AND ino=?")
      .all(root.id, stat.dev, stat.ino);
    // Weak name/size matches need the full reconciler's evidence, never quick-path adoption.
    if (candidates.length === 1) {
      const target = candidates[0];
      try {
        lib.db
          .prepare("UPDATE assets SET path=?,name=?,ext=?,size=?,mtime=?,dev=?,ino=?,sha256=NULL,online=1,file_checked_ms=0,file_status='unknown' WHERE id=?")
          .run(abs, path.basename(rel), ext, stat.size, stat.mtimeMs, stat.dev, stat.ino, target.id);
      } catch {
        report.needFullReconcile = true; // 目标路径被别的记录占着，交给全量对账精确处理
        continue;
      }
      if (manifest?.entries?.[target.id]) {
        delete manifest.entries[target.id].sha256; delete manifest.entries[target.id].fingerprintBinding;
        Object.assign(manifest.entries[target.id], { relPath: rel, size: stat.size, dev: stat.dev, ino: stat.ino });
      }
      if (opts.tagFiles !== false) await writeAssetId(abs, target.id);
      report.adopted++;
      report.handled++;
      continue;
    }
    const moved = await adoptMovedFromRoot(lib, root, { abs, relPath: rel, size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino });
    if (!rootRegistrationUnchanged(lib, targetRegistration)) return { ...report, registrationChanged: true };
    if (moved) {
      manifest.entries[moved.id] = { ...entryFromAsset(moved), relPath: rel, dev: stat.dev, ino: stat.ino, size: stat.size };
      report.adopted++;
      report.handled++;
      continue;
    }
    // 0 个候选（可能是外部新增文件）或多个候选（歧义）→ 交给全量对账精确处理
    report.needFullReconcile = true;
  }

  if (lib.directoryClassification) {
    lib.directoryClassification.sync(root.id);
    const built = await materializeManifest(lib, root);
    for (const [id, entry] of Object.entries(built.entries)) manifest.entries[id] = { ...manifest.entries[id], ...entry };
  }
  if (report.adopted || report.vanished || createdManifest || lib.directoryClassification && report.touched) {
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
    // File-operation previews/execution already defer to running jobs. Include reconciliation
    // so a walk begun between batches cannot later overwrite a freshly committed move.
    const job = { id: "reconcile-watcher", rootId: null, type: "reconcile", status: "running", count: 0, errors: [] };
    lib.jobs.delete(job.id);
    lib.jobs.set(job.id, job);
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
      job.errors.push(e.message);
      log(`[reconcile] 对账失败：${e.message}`);
    } finally {
      job.status = job.errors.length ? "failed" : "done";
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
    const work = () => trackedIndexWork(lib, {}, () => writeRootWork(root));
    return lib.scanProof ? lib.scanProof.run(root.id, 'MANIFEST', work) : work();
  }
  async function writeRootWork(root) {
    const read = await readManifest(root), manifest = read.manifest;
    const repair = repairRootState(lib, root, manifest);
    if (read.reason === "repair-invalid" || repair.blocked) return { deferred: true, repairPending: true, code: repair.code || "REPAIR_MARKER_INVALID" };
    const built = await materializeManifest(lib, root);
    for (const [entryId, entry] of Object.entries(built.entries)) {
      const previous = manifest?.entries?.[entryId];
      // 保留上一版里的未知字段、dev/ino、sha256、tagged 与 missing 痕迹；受管字段用数据库现值覆盖
      built.entries[entryId] = previous ? { ...previous, ...strip(entry) } : strip(entry);
      if (!entry.sha256) { delete built.entries[entryId].sha256; delete built.entries[entryId].fingerprintBinding; }
    }
    for (const [entryId, previous] of Object.entries(manifest?.entries ?? {}))
      if (!built.entries[entryId] && !mergeAlias(lib, entryId)) built.entries[entryId] = previous;
    repairRootState(lib, root, built);
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
    const deferred = [];
    try {
      for (const root of roots) {
        try {
          const result = await writeRoot(root);
          if (result?.deferred) { dirty.add(root.id); deferred.push({ rootId: root.id, code: result.code }); } // no new timer
        } catch (e) {
          log(`[manifest] ${root.path} 清单同步失败：${e.code || e.message}`);
        }
      }
    } finally {
      writing = false;
    }
    if (deferred.length) return { deferred: true, repairPending: true, roots: deferred };
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
