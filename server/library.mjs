import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readCapture, parseCaptureTime } from "./capture.mjs";
import { folderPredicate } from "./folder-browser.mjs";
export const run = promisify(execFile);
const PHOTO = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "arw",
  "cr2",
  "cr3",
  "nef",
  "dng",
  "raf",
  "orf",
  "rw2",
]);
const VIDEO = new Set([
  "mp4",
  "mov",
  "m4v",
  "mkv",
  "avi",
  "mts",
  "m2ts",
  "webm",
]);
const AUDIO = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "aif",
  "aiff",
  "flac",
  "ogg",
  "opus",
  "ncm",
]);
export const within = (base, p) => p === base || p.startsWith(base + path.sep);
export const id = () => crypto.randomUUID();
export const fileCreated = (stat) =>
  Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtimeMs
    : null;
export function creationDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw Error("创建日期格式应为 YYYY-MM-DD");
  const check = new Date(value + "T00:00:00Z");
  if (
    !Number.isFinite(check.getTime()) ||
    check.toISOString().slice(0, 10) !== value
  )
    throw Error("创建日期无效");
  return Date.parse(value + "T00:00:00+08:00");
}
const sha = (p) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = createReadStream(p);
    s.on("data", (b) => h.update(b));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
export class Library {
  constructor(dataDir, { trashBin, database } = {}) {
    this.dataDir = dataDir;
    this.trashBin = trashBin;
    this.database = database;
    this.jobs = new Map();
    this.locks = new Set();
    this.metadataQueue = [];
    this.metadataPending = new Set();
    this.workers = 0;
  }
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true });
    this.cache = path.join(this.dataDir, "cache");
    await fs.mkdir(this.cache, { recursive: true });
    if (this.database) {
      this.db = this.database;
      this.ensureRevealCount();
      this.db
        .prepare(
          "UPDATE operations SET status='interrupted',error='操作中断，请核对源与目标文件；未自动删除任何文件' WHERE status='pending'",
        )
        .run();
      await this.backfillCreationDates();
      return this;
    }
    this.db = new Database(path.join(this.dataDir, "library.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY,path TEXT UNIQUE,kind TEXT,name TEXT,online INTEGER DEFAULT 1);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,root_id TEXT,path TEXT UNIQUE,name TEXT,ext TEXT,kind TEXT,size INTEGER,mtime REAL,category TEXT DEFAULT '',sub TEXT DEFAULT '',basis TEXT DEFAULT '',review INTEGER DEFAULT 0,confirmed INTEGER DEFAULT 0,tags TEXT DEFAULT '[]',note TEXT DEFAULT '',favorite INTEGER DEFAULT 0,online INTEGER DEFAULT 1,trashed INTEGER DEFAULT 0,duration REAL,width INTEGER,height INTEGER,codec TEXT,probe TEXT DEFAULT 'pending',error TEXT DEFAULT '');
      CREATE INDEX IF NOT EXISTS assets_root ON assets(root_id); CREATE INDEX IF NOT EXISTS assets_kind ON assets(kind);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,asset_id TEXT,action TEXT,source TEXT,target TEXT,status TEXT,error TEXT DEFAULT '',created_at TEXT,undone INTEGER DEFAULT 0);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(assets)")
        .all()
        .some((c) => c.name === "created_ms")
    )
      this.db.exec("ALTER TABLE assets ADD COLUMN created_ms REAL");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS assets_created ON assets(created_ms)",
    );
    const columns = new Set(
      this.db
        .prepare("PRAGMA table_info(assets)")
        .all()
        .map((c) => c.name),
    );
    for (const [name, type] of [
      ["captured_ms", "REAL"],
      ["capture_source", "TEXT DEFAULT ''"],
      ["capture_status", "TEXT DEFAULT 'pending'"],
      ["capture_error", "TEXT DEFAULT ''"],
    ])
      if (!columns.has(name))
        this.db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${type}`);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS assets_captured ON assets(captured_ms)",
    );
    this.db
      .prepare(
        `UPDATE assets SET capture_status='ready' WHERE capture_status='pending' AND ext NOT IN (${[...PHOTO, ...VIDEO].map(() => "?").join(",")})`,
      )
      .run(...PHOTO, ...VIDEO);
    this.db
      .prepare(
        "UPDATE operations SET status='interrupted',error='操作中断，请核对源与目标文件；未自动删除任何文件' WHERE status='pending'",
      )
      .run();
    this.ensureRevealCount();
    await this.backfillCreationDates();
    return this;
  }
  ensureRevealCount() {
    const columns = this.db.kind === "mysql"
      ? this.db.prepare("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assets'").all()
      : this.db.prepare("PRAGMA table_info(assets)").all();
    if (!columns.some(c => c.name === "reveal_count"))
      this.db.exec("ALTER TABLE assets ADD COLUMN reveal_count " + (this.db.kind === "mysql" ? "BIGINT" : "INTEGER") + " NOT NULL DEFAULT 0");
    for (const [name, type] of [
      ["file_status", "VARCHAR(24) NOT NULL DEFAULT 'unknown'"],
      ["file_checked_ms", (this.db.kind === "mysql" ? "DOUBLE" : "REAL") + " NOT NULL DEFAULT 0"],
      ["file_check_path", "TEXT"],
      ["file_root_identity", "VARCHAR(128)"],
      ["file_check_reason", "VARCHAR(500) NOT NULL DEFAULT ''"],
    ]) if (!columns.some(c => c.name === name)) this.db.exec(`ALTER TABLE assets ADD COLUMN ${name} ${type}`);
  }
  async reveal(assetId, openFile = p => {
    if (process.env.MEDIA_CONTAINER === "1") throw Error("容器不能打开宿主机文件管理器，请复制素材路径");
    if (process.platform === "darwin") return run("open", ["-R", p]);
    if (process.platform === "win32") return run("explorer.exe", ["/select," + p]);
    return run("xdg-open", [path.dirname(p)]);
  }) {
    const { p } = await this.source(assetId);
    await openFile(p);
    this.db.prepare("UPDATE assets SET reveal_count=reveal_count+1 WHERE id=?").run(assetId);
    return this.asset(assetId);
  }
  async backfillCreationDates() {
    const update = this.db.prepare("UPDATE assets SET created_ms=? WHERE id=?");
    for (const a of this.db
      .prepare(
        "SELECT id,path,root_id FROM assets WHERE created_ms IS NULL AND trashed=0",
      )
      .all()) {
      try {
        const p = await this.checked(a.path, a.root_id);
        update.run(fileCreated(await fs.stat(p)), a.id);
      } catch {}
    }
  }
  roots() {
    return this.db.prepare("SELECT * FROM roots ORDER BY name").all();
  }
  asset(assetId) {
    const a = this.db.prepare("SELECT * FROM assets WHERE id=?").get(assetId);
    if (!a) throw Error("素材不存在");
    return { ...a, tags: JSON.parse(a.tags) };
  }
  async addRoot(input, kind = "sfx") {
    if (!["sfx", "music", "photo", "video", "mixed"].includes(kind))
      throw Error("未知目录类型");
    const p = await fs.realpath(input);
    if (!(await fs.stat(p)).isDirectory()) throw Error("请选择文件夹");
    if (p === "/" || p === path.parse(p).root)
      throw Error("不能登记磁盘根目录");
    if (within(p, this.dataDir) || within(this.dataDir, p))
      throw Error("不能登记应用数据目录或其上级");
    for (const r of this.roots()) {
      if (r.path === p) return r;
      if (within(p, r.path) || within(r.path, p))
        throw Error("该目录与已登记目录重叠，请选择互不包含的文件夹");
    }
    const r = { id: id(), path: p, kind, name: path.basename(p) };
    this.db
      .prepare(
        "INSERT INTO roots(id,path,kind,name) VALUES(@id,@path,@kind,@name)",
      )
      .run(r);
    return r;
  }
  async checked(p, rootId) {
    const r = this.db.prepare("SELECT * FROM roots WHERE id=?").get(rootId);
    if (!r) throw Error("未登记的素材目录");
    const real = await fs.realpath(p);
    if (!within(r.path, real)) throw Error("路径超出登记目录");
    return real;
  }
  async source(assetId) {
    let a = this.asset(assetId);
    if (a.trashed) throw Error("素材已移入废纸篓");
    if (this.fileChecker) { await this.fileChecker.verify(a); a = this.asset(assetId); }
    const real = await this.checked(a.path, a.root_id);
    const stat = await fs.stat(real);
    if (!stat.isFile()) throw Error("不是普通文件");
    return { a, p: real, stat };
  }
  scan(rootId, classification = new Map()) {
    if (this.locks.size) throw Error("文件操作进行中，请完成后再扫描");
    if (
      [...this.jobs.values()].some(
        (j) => j.rootId === rootId && j.status === "running",
      )
    )
      throw Error("此目录正在扫描");
    const job = {
      id: id(),
      rootId,
      type: "scan",
      label: "扫描素材",
      status: "running",
      count: 0,
      errors: [],
      startedAt: Date.now(),
    };
    this.jobs.set(job.id, job);
    this.scanWork(job, classification).catch((e) => {
      job.status = "failed";
      job.errors.push(e.message);
    });
    return job;
  }
  async scanWork(job, classification) {
    const root = this.roots().find((r) => r.id === job.rootId);
    if (!root) throw Error("目录不存在");
    try {
      await fs.access(root.path);
    } catch {
      this.db.prepare("UPDATE roots SET online=0 WHERE id=?").run(root.id);
      this.db
        .prepare("UPDATE assets SET online=0 WHERE root_id=?")
        .run(root.id);
      throw Error("目录不可访问，已保留索引并标记离线");
    }
    const seen = new Set();
    if (this.categoryStore && root.kind === "music") {
      try { this.categoryStore.ensureFolder(root.name); } catch {}
    }
    const walk = async (dir) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (e) {
        job.errors.push(dir + ": " + e.message);
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.categoryStore) {
            try {
              await this.checked(p, root.id);
              this.categoryStore.folderPair(root, p);
            } catch (e) { job.errors.push(p + ": " + e.message); }
          }
          await walk(p);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(p).slice(1).toLowerCase();
        let kind = PHOTO.has(ext)
          ? "photo"
          : VIDEO.has(ext)
            ? "video"
            : AUDIO.has(ext)
              ? root.kind === "music"
                ? "music"
                : "sfx"
              : null;
        if (!kind) continue;
        try {
          const real = await this.checked(p, root.id);
          const s = await fs.stat(real);
          seen.add(real);
          const old = this.db
            .prepare("SELECT * FROM assets WHERE path=?")
            .get(real);
          const c = classification.get(real);
          if (old) {
            const changed = old.size !== s.size || old.mtime !== s.mtimeMs;
            const recheckMusic =
              VIDEO.has(ext) &&
              root.kind === "music" &&
              old.kind === "video" &&
              ["原音乐目录分类", "文件格式"].includes(old.basis);
            this.db
              .prepare(
                "UPDATE assets SET online=1,size=?,mtime=?,created_ms=?,probe=?,duration=?,width=?,height=?,codec=?,error=? WHERE id=?",
              )
              .run(
                s.size,
                s.mtimeMs,
                fileCreated(s),
                changed || recheckMusic ? "pending" : old.probe,
                changed ? null : old.duration,
                changed ? null : old.width,
                changed ? null : old.height,
                changed ? null : old.codec,
                changed ? "" : old.error,
                old.id,
              );
            if (changed && !old.capture_source?.startsWith("手动"))
              this.db
                .prepare(
                  "UPDATE assets SET captured_ms=NULL,capture_source='',capture_error='',capture_status='pending' WHERE id=?",
                )
                .run(old.id);
          } else {
            const hierarchy = this.categoryStore?.folderPair(root, path.dirname(real));
            const inferred = hierarchy ? hierarchy.category : this.categoryStore && path.dirname(real) !== root.path
              ? path.basename(path.dirname(real))
              : root.kind === "music"
                ? path
                    .relative(root.path, path.dirname(real))
                    .split(path.sep)[0] || root.name
                : "";
            const primary = this.categoryStore
              ? (() => { try { return this.categoryStore.existingName(c?.category || inferred); } catch { return ""; } })()
              : c?.category || inferred;
            let child = c ? c.sub || "" : hierarchy?.sub || "";
            if (this.hierarchyAvailable && child) {
              if (primary) {
                const parent = this.db.prepare("SELECT id FROM music_categories WHERE name=?").get(primary);
                child = this.categoryStore.ensureSubcategory(parent.id, child).name;
              } else child = "";
            }
            this.db
              .prepare(
                "INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,created_ms,category,sub,basis,review) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                id(),
                root.id,
                real,
                entry.name,
                ext,
                kind,
                s.size,
                s.mtimeMs,
                fileCreated(s),
                primary,
                child,
                c?.basis || (inferred ? "原音乐目录分类" : "文件格式"),
                c?.review ? 1 : 0,
              );
          }
          job.count++;
        } catch (e) {
          job.errors.push(p + ": " + e.message);
        }
      }
    };
    await walk(root.path);
    // An unreadable subdirectory is not proof that its indexed files vanished.
    if (!job.errors.length) {
      const mark = this.db.prepare("UPDATE assets SET online=0 WHERE id=?");
      this.db.transaction(() => {
        for (const a of this.db
          .prepare("SELECT id,path FROM assets WHERE root_id=? AND trashed=0")
          .all(root.id))
          if (!seen.has(a.path)) mark.run(a.id);
      })();
    }
    this.db.prepare("UPDATE roots SET online=1 WHERE id=?").run(root.id);
    job.status = job.errors.length ? "partial" : "done";
    job.finishedAt = Date.now();
    for (const a of this.db
      .prepare(
        "SELECT id FROM assets WHERE root_id=? AND (probe='pending' OR capture_status='pending') AND online=1 AND trashed=0",
      )
      .all(root.id))
      this.enqueue(a.id);
  }
  enqueue(assetId, priority = false) {
    if (this.metadataPending.has(assetId)) return;
    this.metadataPending.add(assetId);
    priority
      ? this.metadataQueue.unshift(assetId)
      : this.metadataQueue.push(assetId);
    this.pump();
  }
  pump() {
    if (this.migrating) return;
    while (this.workers < 2 && this.metadataQueue.length) {
      const assetId = this.metadataQueue.shift();
      this.workers++;
      this.probe(assetId)
        .catch(() => {})
        .finally(() => {
          this.metadataPending.delete(assetId);
          this.workers--;
          this.pump();
        });
    }
  }
  async probe(assetId) {
    const a = this.asset(assetId);
    if (
      (a.probe !== "pending" && a.capture_status !== "pending") ||
      this.locks.has(assetId)
    )
      return;
    if (a.capture_status === "pending") {
      try {
        const captured =
          PHOTO.has(a.ext) || VIDEO.has(a.ext)
            ? await readCapture((await this.source(assetId)).p)
            : { ms: null, source: "" };
        this.db
          .prepare(
            "UPDATE assets SET captured_ms=?,capture_source=?,capture_status='ready',capture_error='' WHERE id=? AND mtime=? AND size=? AND capture_source NOT LIKE '手动%'",
          )
          .run(captured.ms, captured.source, assetId, a.mtime, a.size);
      } catch (e) {
        this.db
          .prepare(
            "UPDATE assets SET capture_status='error',capture_error=? WHERE id=? AND mtime=? AND capture_source NOT LIKE '手动%'",
          )
          .run(
            e.code === "ENOENT" && String(e.syscall).startsWith("spawn")
              ? "ExifTool 不可用，无法读取拍摄时间"
              : "拍摄时间读取失败：" +
                  String(e.stderr || e.message).slice(0, 200),
            assetId,
            a.mtime,
          );
      }
    }
    if (a.probe !== "pending") return;
    if (a.ext === "ncm") {
      this.db
        .prepare(
          "UPDATE assets SET probe='error',error=? WHERE id=? AND mtime=?",
        )
        .run(
          "NCM 格式暂不支持直接试听，原文件保留，可搜索、分类及在访达中定位。",
          assetId,
          a.mtime,
        );
      return;
    }
    try {
      const { p } = await this.source(assetId);
      const { stdout } = await run(
        "ffprobe",
        ["-v", "error", "-show_format", "-show_streams", "-of", "json", p],
        { timeout: 20000, maxBuffer: 2e6 },
      );
      const m = JSON.parse(stdout);
      const video = m.streams?.find((s) => s.codec_type === "video");
      const audio = m.streams?.find((s) => s.codec_type === "audio");
      const root = this.roots().find((r) => r.id === a.root_id);
      if (audio && a.kind === "video" && (root?.kind === "music" || !video)) {
        this.db
          .prepare(
            "UPDATE assets SET kind=? WHERE id=? AND mtime=? AND kind='video' AND basis IN ('文件格式','原音乐目录分类')",
          )
          .run(root?.kind === "music" ? "music" : "sfx", assetId, a.mtime);
      }
      this.db
        .prepare(
          "UPDATE assets SET duration=?,width=?,height=?,codec=?,probe='ready',error='' WHERE id=? AND mtime=?",
        )
        .run(
          Number.isFinite(Number(m.format?.duration))
            ? Number(m.format.duration)
            : null,
          video?.width || null,
          video?.height || null,
          video?.codec_name || audio?.codec_name || null,
          assetId,
          a.mtime,
        );
    } catch (e) {
      this.db
        .prepare(
          "UPDATE assets SET probe='error',error=? WHERE id=? AND mtime=?",
        )
        .run(
          "媒体参数读取失败：" + String(e.stderr || e.message).slice(0, 250),
          assetId,
          a.mtime,
        );
    }
  }
  assetFilter(query = {}, ignoreCategory = false) {
    const where = ["trashed=0"],
      values = [];
    if (query.directoryRoot) {
      const scope = folderPredicate(this, query);
      where.push("(" + scope.sql + ")"); values.push(...scope.values);
    } else if (query.directory || query.includeChildren !== undefined) throw Error("请先选择登记的素材目录");
    for (const [key, col] of [
      ["kind", "kind"],
      ["category", "category"],
      ["ext", "ext"],
    ])
      if (query[key] && !(ignoreCategory && key === "category")) {
        if (key === "category" && this.musicLinksAvailable) {
          where.push(
            `(category=? OR (${this.allCategoryKinds ? "" : "kind='music' AND "}EXISTS(SELECT 1 FROM music_category_links l JOIN music_categories c ON c.id=l.category_id WHERE l.asset_id=assets.id AND c.name=?)))`,
          );
          values.push(query[key]);
        } else where.push(col + "=?");
        values.push(query[key]);
      }
    if (query.root) {
      const roots = [
        ...new Set(Array.isArray(query.root) ? query.root : [query.root]),
      ];
      if (
        roots.length > 100 ||
        roots.some((root) => typeof root !== "string" || !root)
      )
        throw Error("素材目录筛选参数无效");
      if (roots.length) {
        where.push(`root_id IN (${roots.map(() => "?").join(",")})`);
        values.push(...roots);
      }
    }
    if (query.subcategoryId) {
      if (!this.hierarchyAvailable) throw Error("子类功能尚未初始化");
      const child = this.categoryStore.subcategory(query.subcategoryId), parent = this.categoryStore.get(child.category_id);
      where.push("category=? AND sub=?"); values.push(parent.name, child.name);
    }
    if (query.view === "favorites") where.push("favorite=1");
    if (query.view === "review") where.push("review=1 AND confirmed=0");
    if (query.view === "offline") where.push("online=0");
    if (query.view === "missing") where.push("file_status='missing'");
    if (query.favorite === "1") where.push("favorite=1");
    if (query.tagName) {
      if (typeof query.tagName !== "string" || query.tagName.length > 60)
        throw Error("标签筛选无效");
      where.push(
        this.db.kind === "mysql"
          ? "JSON_CONTAINS(tags,?)"
          : "EXISTS(SELECT 1 FROM json_each(assets.tags) j WHERE j.value=?)",
      );
      values.push(
        this.db.kind === "mysql"
          ? JSON.stringify(query.tagName)
          : query.tagName,
      );
    }
    if (query.tagRules) {
      let rules;
      try { rules = typeof query.tagRules === "string" ? JSON.parse(query.tagRules) : null; } catch { throw Error("组合标签格式无效"); }
      if (!rules || typeof rules !== "object" || Array.isArray(rules) || Object.keys(rules).some(k => !["all", "any", "none"].includes(k))) throw Error("组合标签格式无效");
      for (const mode of ["all", "any", "none"]) {
        const tags = rules[mode] ?? [];
        if (!Array.isArray(tags) || tags.length > 20 || tags.some(t => typeof t !== "string" || !t.trim() || t.length > 60)) throw Error("每种组合最多 20 个有效标签");
        if (!tags.length) continue;
        const expressions = [...new Set(tags)].map(tag => {
          values.push(this.db.kind === "mysql" ? JSON.stringify(tag) : tag);
          return this.db.kind === "mysql" ? "JSON_CONTAINS(tags,?)" : "EXISTS(SELECT 1 FROM json_each(assets.tags) j WHERE j.value=?)";
        });
        where.push("(" + expressions.map(e => mode === "none" ? "NOT (" + e + ")" : e).join(mode === "any" ? " OR " : " AND ") + ")");
      }
    }
    if (query.untagged === "1")
      where.push(
        this.db.kind === "mysql"
          ? "JSON_LENGTH(tags)=0"
          : "json_array_length(tags)=0",
      );
    if (query.uncategorized === "1") {
      where.push("TRIM(category)=''");
      if (this.musicLinksAvailable)
        where.push(
          "NOT EXISTS(SELECT 1 FROM music_category_links l JOIN music_categories c ON c.id=l.category_id WHERE l.asset_id=assets.id)",
        );
    }
    if (query.q) {
      where.push(
        "(name LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\' OR sub LIKE ? ESCAPE '\\')",
      );
      const term = "%" + String(query.q).replace(/[\\%_]/g, "\\$&") + "%";
      values.push(...Array(5).fill(term));
    }
    if (query.duration === "short") where.push("duration < 10");
    if (query.duration === "medium")
      where.push("duration >= 10 AND duration <= 60");
    if (query.duration === "long") where.push("duration > 60");
    if (query.duration === "unknown") where.push("duration IS NULL");
    const from = query.createdFrom ? creationDay(query.createdFrom) : null;
    const to = query.createdTo ? creationDay(query.createdTo) : null;
    if (from !== null && to !== null && from > to)
      throw Error("创建日期起始时间不能晚于结束时间");
    if (from !== null) {
      where.push("created_ms >= ?");
      values.push(from);
    }
    if (to !== null) {
      where.push("created_ms < ?");
      values.push(to + 86400000);
    }
    const capturedFrom = query.capturedFrom
      ? creationDay(query.capturedFrom)
      : null;
    const capturedTo = query.capturedTo ? creationDay(query.capturedTo) : null;
    if (
      capturedFrom !== null &&
      capturedTo !== null &&
      capturedFrom > capturedTo
    )
      throw Error("拍摄日期起始时间不能晚于结束时间");
    if (query.captureUnknown === "1")
      where.push("captured_ms IS NULL AND capture_status<>'pending'");
    if (capturedFrom !== null) {
      where.push("captured_ms >= ?");
      values.push(capturedFrom);
    }
    if (capturedTo !== null) {
      where.push("captured_ms < ?");
      values.push(capturedTo + 86400000);
    }
    const w = where.join(" AND ");
    return { where: w, values };
  }
  categoryOptions(query = {}) {
    const { where, values } = this.assetFilter(query, true);
    if (this.musicLinksAvailable)
      return this.db
        .prepare(
          `SELECT category,COUNT(*) n FROM (SELECT id,category FROM assets WHERE ${where} ${this.allCategoryKinds ? "" : "AND kind IN ('music','sfx')"} AND TRIM(category)<>'' UNION SELECT a.id,c.name category FROM (SELECT * FROM assets WHERE ${where} ${this.allCategoryKinds ? "" : "AND kind='music'"}) a JOIN music_category_links l ON l.asset_id=a.id JOIN music_categories c ON c.id=l.category_id) matching GROUP BY category ORDER BY category`,
        )
        .all(...values, ...values);
    return this.db
      .prepare(
        `SELECT category,COUNT(*) n FROM assets WHERE ${where} AND kind IN ('music','sfx') AND TRIM(category)<>'' GROUP BY category ORDER BY category`,
      )
      .all(...values);
  }
  list(query = {}) {
    const { where: w, values } = this.assetFilter(query);
    const total = this.db
      .prepare("SELECT COUNT(*) n FROM assets WHERE " + w)
      .get(...values).n;
    const page = Math.max(1, Number(query.page) || 1);
    const limit = 60;
    const sort =
      query.sort === "revealCount"
        ? "reveal_count DESC,name COLLATE NOCASE ASC"
        : query.sort === "size"
        ? "size DESC"
        : query.sort === "recent"
          ? "mtime DESC"
          : query.sort === "createdNewest"
            ? "(created_ms IS NULL) ASC,created_ms DESC"
            : query.sort === "createdOldest"
              ? "(created_ms IS NULL) ASC,created_ms ASC"
              : query.sort === "capturedNewest"
                ? "(captured_ms IS NULL) ASC,captured_ms DESC"
                : query.sort === "capturedOldest"
                  ? "(captured_ms IS NULL) ASC,captured_ms ASC"
                  : "name COLLATE NOCASE ASC";
    const items = this.db
      .prepare(
        `SELECT * FROM assets WHERE ${w} ORDER BY ${sort},id LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, (page - 1) * limit)
      .map((a) => ({ ...a, tags: JSON.parse(a.tags) }));
    for (const a of items)
      if ((a.probe === "pending" || a.capture_status === "pending") && a.online)
        this.enqueue(a.id, true);
    return {
      items,
      total,
      page,
      pages: Math.ceil(total / limit),
      categories: this.categoryOptions(query),
    };
  }
  stats() {
    return {
      total: this.db
        .prepare("SELECT COUNT(*) n FROM assets WHERE trashed=0")
        .get().n,
      kinds: this.db
        .prepare(
          "SELECT kind,COUNT(*) n FROM assets WHERE trashed=0 GROUP BY kind",
        )
        .all(),
      favorites: this.db
        .prepare("SELECT COUNT(*) n FROM assets WHERE favorite=1 AND trashed=0")
        .get().n,
      review: this.db
        .prepare(
          "SELECT COUNT(*) n FROM assets WHERE review=1 AND confirmed=0 AND trashed=0",
        )
        .get().n,
      offline: this.db
        .prepare("SELECT COUNT(*) n FROM assets WHERE online=0 AND trashed=0")
        .get().n,
      missing: this.db.prepare("SELECT COUNT(*) n FROM assets WHERE file_status='missing' AND trashed=0").get().n,
      categories: this.db
        .prepare(
          "SELECT category,COUNT(*) n FROM assets WHERE category<>'' AND trashed=0 GROUP BY category ORDER BY category",
        )
        .all(),
      formats: this.db
        .prepare("SELECT DISTINCT ext FROM assets WHERE trashed=0 ORDER BY ext")
        .all()
        .map((r) => r.ext),
    };
  }
  patch(assetId, patch) {
    const original = this.asset(assetId);
    if (this.categoryStore && Object.hasOwn(patch, "category"))
      patch = { ...patch, category: this.categoryStore.existingName(patch.category) };
    if (this.hierarchyAvailable && (Object.hasOwn(patch, "category") || Object.hasOwn(patch, "sub"))) {
      const parent = patch.category ?? original.category;
      const sub = Object.hasOwn(patch, "sub") ? patch.sub : parent !== original.category ? "" : original.sub;
      patch = { ...patch, sub: this.categoryStore.validatePair(parent, sub) };
    }
    if (Object.hasOwn(patch, "capturedAt")) {
      if (patch.capturedAt === "") {
        this.db
          .prepare(
            "UPDATE assets SET captured_ms=NULL,capture_source='',capture_error='',capture_status='pending' WHERE id=?",
          )
          .run(assetId);
        this.enqueue(assetId, true);
      } else {
        if (
          typeof patch.capturedAt !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(patch.capturedAt)
        )
          throw Error("拍摄时间格式错误");
        const parsed = parseCaptureTime(
          patch.capturedAt.length === 16
            ? patch.capturedAt + ":00"
            : patch.capturedAt,
        );
        if (!parsed) throw Error("拍摄时间无效");
        this.db
          .prepare(
            "UPDATE assets SET captured_ms=?,capture_source='手动校正（北京时间）',capture_status='ready',capture_error='' WHERE id=?",
          )
          .run(parsed.ms, assetId);
      }
    }
    const columns = [],
      v = [];
    if (Object.hasOwn(patch, "kind") && patch.kind !== original.kind) {
      columns.push("basis=?");
      v.push("人工指定素材类型");
    }
    for (const k of [
      "note",
      "category",
      "sub",
      "kind",
      "favorite",
      "confirmed",
      "tags",
    ])
      if (Object.hasOwn(patch, k)) {
        let value = patch[k];
        if (k === "tags") {
          if (
            !Array.isArray(value) ||
            value.length > 40 ||
            value.some((t) => typeof t !== "string" || t.length > 60)
          )
            throw Error("标签格式错误");
          value = JSON.stringify([
            ...new Set(value.map((t) => t.trim()).filter(Boolean)),
          ]);
        } else if (["favorite", "confirmed"].includes(k)) value = value ? 1 : 0;
        else if (typeof value !== "string" || value.length > 4000)
          throw Error("字段过长或格式错误");
        if (k === "kind" && !["sfx", "music", "video", "photo"].includes(value))
          throw Error("素材类型错误");
        columns.push(k + "=?");
        v.push(value);
      }
    if (columns.length)
      this.db
        .prepare("UPDATE assets SET " + columns.join(",") + " WHERE id=?")
        .run(...v, assetId);
    return this.asset(assetId);
  }
  async plan(input) {
    if (
      !["rename", "move", "trash"].includes(input.action) ||
      !Array.isArray(input.ids) ||
      !input.ids.length ||
      input.ids.length > 200
    )
      throw Error("操作参数错误（每批最多200项）");
    const seen = new Set();
    const results = [];
    for (const assetId of [...new Set(input.ids)]) {
      try {
        if ([...this.jobs.values()].some((j) => j.status === "running"))
          throw Error("素材扫描进行中，请完成后再整理文件");
        const { a, p, stat } = await this.source(assetId);
        let target = "";
        if (input.action === "trash") {
          if (!this.trashBin) throw Error("废纸篓组件不可用，操作已禁止");
        } else if (input.action === "rename") {
          const name =
            input.ids.length === 1
              ? input.name
              : String(input.prefix || "") + a.name;
          if (
            typeof name !== "string" ||
            !name.trim() ||
            name.includes("/") ||
            name.includes("\\") ||
            name.includes("\0") ||
            name === "." ||
            name === ".." ||
            name.startsWith(".")
          )
            throw Error("文件名无效");
          if (
            path.extname(name).toLowerCase() !==
            path.extname(a.name).toLowerCase()
          )
            throw Error("请保留原文件扩展名");
          target = path.join(path.dirname(p), name);
        } else {
          const root = this.roots().find((r) => r.id === input.rootId);
          if (!root) throw Error("请选择登记目录");
          const relative = String(input.relative || "");
          if (
            path.isAbsolute(relative) ||
            relative.split(/[\\/]/).includes("..")
          )
            throw Error("目标子目录无效");
          const dir = await this.checked(
            path.join(root.path, relative),
            root.id,
          );
          if (!(await fs.stat(dir)).isDirectory()) throw Error("目标不是目录");
          target = path.join(dir, a.name);
        }
        if (target) {
          if (target === p) throw Error("目标与原位置相同");
          await this.checked(
            path.dirname(target),
            input.action === "move" ? input.rootId : a.root_id,
          );
          try {
            await fs.lstat(target);
            throw Error("目标已存在，不会覆盖");
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
          if (seen.has(target)) throw Error("批次中目标重名");
          seen.add(target);
        }
        results.push({
          id: assetId,
          name: a.name,
          source: p,
          target,
          fileSize: stat.size,
          fileMtime: stat.mtimeMs,
          fileInode: stat.ino,
          ok: true,
        });
      } catch (e) {
        results.push({ id: assetId, ok: false, error: e.message });
      }
    }
    return results;
  }
  async relocate(source, target, expected) {
    const before = await fs.stat(source);
    if (
      expected &&
      (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs)
    )
      throw Error("源文件已变化，请重新确认");
    let copied = false;
    let copiedInode;
    try {
      await fs.copyFile(source, target, constants.COPYFILE_EXCL);
      copied = true;
      copiedInode = (await fs.stat(target)).ino;
      const [a, b] = await Promise.all([sha(source), sha(target)]);
      if (a !== b) throw Error("复制校验失败，源文件保留");
      const after = await fs.stat(source);
      if (
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ino !== before.ino
      )
        throw Error("源文件复制期间变化，操作取消");
      await fs.utimes(target, before.atime, before.mtime);
      await fs.unlink(source);
    } catch (e) {
      if (copied) {
        try {
          if ((await fs.lstat(target)).ino === copiedInode)
            await fs.unlink(target);
        } catch {}
      }
      throw e;
    }
  }
  async execute(input, expectedPlans = null) {
    const plans = await this.plan(input);
    const results = [];
    for (const p of plans) {
      if (!p.ok) {
        results.push(p);
        continue;
      }
      if (this.locks.has(p.id)) {
        results.push({ ...p, ok: false, error: "素材正在处理" });
        continue;
      }
      this.locks.add(p.id);
      const operation = id();
      let changed = false;
      try {
        if ([...this.jobs.values()].some((j) => j.status === "running"))
          throw Error("素材扫描进行中，请完成后再整理文件");
        const { a, stat } = await this.source(p.id);
        if (expectedPlans) {
          const expected = expectedPlans.find((e) => e.id === p.id);
          if (
            !expected?.ok ||
            expected.source !== p.source ||
            expected.target !== p.target ||
            expected.fileSize !== stat.size ||
            expected.fileMtime !== stat.mtimeMs ||
            expected.fileInode !== stat.ino
          )
            throw Error("文件或目标在确认后发生变化，请重新检查路径");
        }
        this.db
          .prepare(
            "INSERT INTO operations(id,asset_id,action,source,target,status,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            operation,
            p.id,
            input.action,
            p.source,
            p.target,
            "pending",
            new Date().toISOString(),
          );
        if (input.action === "trash") {
          const { stdout } = await run(this.trashBin, [p.source], {
            timeout: 30000,
          });
          const trash = JSON.parse(stdout);
          this.db
            .prepare("UPDATE operations SET target=? WHERE id=?")
            .run(trash, operation);
          changed = true;
          if (!path.isAbsolute(trash) || !/(^|\/)\.Trash(es)?\//.test(trash))
            throw Error("废纸篓返回位置异常，请查看操作记录");
          this.db
            .prepare("UPDATE assets SET trashed=1,online=0 WHERE id=?")
            .run(p.id);
        } else {
          await this.relocate(p.source, p.target, stat);
          changed = true;
          const s = await fs.stat(p.target);
          this.db
            .prepare(
              "UPDATE assets SET path=?,name=?,root_id=?,mtime=?,size=?,created_ms=? WHERE id=?",
            )
            .run(
              p.target,
              path.basename(p.target),
              input.action === "move" ? input.rootId : a.root_id,
              s.mtimeMs,
              s.size,
              fileCreated(s),
              p.id,
            );
        }
        this.db
          .prepare("UPDATE operations SET status='done' WHERE id=?")
          .run(operation);
        results.push({ ...p, ok: true, operation });
      } catch (e) {
        let uncertain = changed;
        if (input.action === "trash") {
          try {
            await fs.access(p.source);
          } catch {
            uncertain = true;
          }
        }
        this.db
          .prepare("UPDATE operations SET status=?,error=? WHERE id=?")
          .run(uncertain ? "interrupted" : "failed", e.message, operation);
        results.push({ ...p, ok: false, error: e.message, operation });
      } finally {
        this.locks.delete(p.id);
      }
    }
    return results;
  }
  async undo(operationId) {
    const op = this.db
      .prepare(
        "SELECT * FROM operations WHERE id=? AND status='done' AND undone=0",
      )
      .get(operationId);
    if (!op) throw Error("该操作不能撤销");
    if (this.locks.has(op.asset_id)) throw Error("素材正在处理");
    this.locks.add(op.asset_id);
    try {
      const a = this.asset(op.asset_id);
      const later = this.db
        .prepare(
          "SELECT id FROM operations WHERE asset_id=? AND status='done' AND undone=0 ORDER BY rowid DESC LIMIT 1",
        )
        .get(a.id);
      if (later?.id !== op.id) throw Error("请先撤销此素材的后续操作");
      const root = this.roots().find((r) => within(r.path, op.source));
      if (!root) throw Error("原目录不再登记，不能恢复");
      await this.checked(path.dirname(op.source), root.id);
      const target = await fs.realpath(op.target);
      if (target !== op.target) throw Error("目标路径变化，不能自动恢复");
      if (op.action === "trash") {
        if (!a.trashed || !/(^|\/)\.Trash(es)?\//.test(target))
          throw Error("废纸篓记录无效");
      } else {
        if (a.path !== target) throw Error("素材位置已经改变");
        await this.checked(target, a.root_id);
      }
      await this.relocate(target, op.source);
      const s = await fs.stat(op.source);
      this.db.transaction(() => {
        this.db
          .prepare(
            "UPDATE assets SET path=?,name=?,root_id=?,mtime=?,size=?,created_ms=?,trashed=0,online=1 WHERE id=?",
          )
          .run(
            op.source,
            path.basename(op.source),
            root.id,
            s.mtimeMs,
            s.size,
            fileCreated(s),
            a.id,
          );
        this.db.prepare("UPDATE operations SET undone=1 WHERE id=?").run(op.id);
      })();
      return this.asset(a.id);
    } finally {
      this.locks.delete(op.asset_id);
    }
  }
}
