import express from "express";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Library, run } from "./library.mjs";
import { MysqlStorage } from "./mysql.mjs";
import { MusicCategories, AssetCategories } from "./music-categories.mjs";
import { Tags } from "./tags.mjs";
import { MusicAnalysis } from "./music-analysis.mjs";
import { MissingFiles } from "./missing-files.mjs";
import { DuplicateAudio } from "./duplicate-audio.mjs";
import { Projects } from "./projects.mjs";
import { FolderBrowser } from "./folder-browser.mjs";
import { createManifestSync, reconcileRoot, relocateRoot, startWatcher } from "./reconcile.mjs";
import { dataDirectory } from "./runtime.mjs";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dataDir = dataDirectory(project);
const trashSource = path.join(project, "server/trash.swift");
const trashVersion = crypto
  .createHash("sha256")
  .update(await fs.readFile(trashSource))
  .digest("hex")
  .slice(0, 12);
const trashBin = path.join(dataDir, "trash-helper-" + trashVersion);
await fs.mkdir(dataDir, { recursive: true });
let nativeTrash;
if (process.platform === "darwin") {
  try {
    await fs.access(trashBin);
    nativeTrash = trashBin;
  } catch {
    try {
      await run(
        "swiftc",
        [path.join(project, "server/trash.swift"), "-o", trashBin],
        { timeout: 90000 },
      );
      nativeTrash = trashBin;
    } catch (e) {
      console.warn("废纸篓组件不可用，删除操作已禁用：", e.message);
    }
  }
}
const mysqlStorage = await new MysqlStorage(dataDir).init();
const lib = await new Library(dataDir, {
  trashBin: nativeTrash,
  database: mysqlStorage.database,
}).init();
mysqlStorage.attach(lib);
// 目录监听句柄：启动对账之后才赋值，路由 /api/reconcile 会读它报告监听状态
let reconcileWatcher = null;
// 元数据（标签/备注/分类）改动后防抖刷新清单：让"GPT 直接读 .shiguang/manifest.json"看到最新值
const manifestSync = createManifestSync(lib, { log: (m) => console.log(m) });
lib.onMetadataChanged = (rootId) => manifestSync.touch(rootId);
const musicCategories = new MusicCategories(lib).init();
const categories = new AssetCategories(lib).init();
const tags = new Tags(lib).init();
const projects = new Projects(lib).init();
const folderBrowser = new FolderBrowser(lib);
const musicAnalysis = await new MusicAnalysis(lib).init();
const missingFiles = new MissingFiles(lib, () => mysqlStorage.migrating || musicAnalysis.active || musicAnalysis.testing || duplicateAudio.marking || lib.locks.size > 0 || cacheJobs.size > 0 || [...lib.jobs.values()].some(j => j.type !== "cleanup" && j.status === "running"));
const duplicateAudio = new DuplicateAudio(lib, () => mysqlStorage.migrating || musicAnalysis.active || musicAnalysis.testing || lib.locks.size > 0 || [...lib.jobs.values()].some(j => j.type !== "duplicates" && j.status === "running"));
for (const a of lib.db
  .prepare(
    "SELECT id FROM assets WHERE (probe='pending' OR capture_status='pending') AND online=1 AND trashed=0",
  )
  .all())
  lib.enqueue(a.id);
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
const sessions = new Map();
let port;
const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
app.use((req, res, next) => {
  const expected = `127.0.0.1:${port}`;
  if (req.headers.host !== expected)
    return res.status(403).json({ error: "仅允许本机地址访问" });
  if (req.headers.origin && req.headers.origin !== `http://${expected}`)
    return res.status(403).json({ error: "拒绝跨站访问" });
  if (["cross-site", "same-site"].includes(req.headers["sec-fetch-site"]))
    return res.status(403).json({ error: "拒绝跨站访问" });
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});
app.get("/api/session", (req, res) => {
  const cookie = req.headers.cookie?.match(
    /(?:^|; )media_session=([^;]+)/,
  )?.[1];
  let token = cookie && sessions.get(cookie);
  let session = cookie;
  if (!token) {
    session = crypto.randomBytes(32).toString("hex");
    token = crypto.randomBytes(32).toString("hex");
    sessions.set(session, token);
    res.cookie("media_session", session, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    token,
    trashAvailable: !!nativeTrash,
    folderPickerAvailable: process.platform === "darwin" && process.env.MEDIA_CONTAINER !== "1",
    instanceId: mysqlStorage.sourceId,
    app: "shiguang-local-media",
  });
});
app.use("/api", (req, res, next) => {
  const cookie = req.headers.cookie?.match(
    /(?:^|; )media_session=([^;]+)/,
  )?.[1];
  const token = cookie && sessions.get(cookie);
  if (!token)
    return res.status(401).json({ error: "本机会话失效，请刷新页面" });
  if (req.method !== "GET" && req.headers["x-local-token"] !== token)
    return res.status(403).json({ error: "本机会话校验失败" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.get("/api/stats", (req, res) => res.json(lib.stats()));
app.use("/api", (req, res, next) => {
  if (
    mysqlStorage.migrating &&
    !req.path.startsWith("/mysql") &&
    req.method !== "GET"
  )
    return res.status(423).json({ error: "数据库迁移中，请稍后再操作" });
  next();
});
app.get("/api/mysql", (req, res) => res.json(mysqlStorage.publicState()));
app.post(
  "/api/mysql/test",
  asyncRoute(async (req, res) => res.json(await mysqlStorage.test(req.body))),
);
app.post(
  "/api/mysql/config",
  asyncRoute(async (req, res) =>
    res.json(await mysqlStorage.activate(req.body)),
  ),
);
app.get("/api/roots", (req, res) => res.json(lib.roots()));
app.get("/api/folder-browser", asyncRoute(async (req, res) => res.json(await folderBrowser.branch(req.query))));
app.post("/api/folder-browser", asyncRoute(async (req, res) => {
  if (process.env.MEDIA_READONLY_FILES === "1") return res.status(403).json({ error: "当前为原文件只读模式，不允许新建文件夹" });
  res.json(await folderBrowser.create(req.body));
}));
app.post("/api/roots", asyncRoute(async (req, res) => {
  if (typeof req.body.path !== "string" || !path.isAbsolute(req.body.path)) throw Error("请输入服务器上的绝对文件夹路径");
  const root = await lib.addRoot(req.body.path, req.body.kind);
  void reconcileWatcher?.refresh(); // 立刻开始监听这个新目录，否则外部改动要等下一轮兜底刷新
  res.json({ root, job: lib.scan(root.id) });
}));
// 含已注销的根：只给「素材目录管理」界面用（/api/roots 仍只返回在管的根）
app.get("/api/roots/all", (req, res) => res.json(lib.allRoots()));
app.patch("/api/roots/:id", asyncRoute(async (req, res) => {
  const result = lib.updateRoot(req.params.id, req.body);
  if (Object.hasOwn(req.body, "kind")) void reconcileWatcher?.refresh();
  res.json(result);
}));
// 迁移根路径：保持同一个 root_id，让对账把素材按身份重新认领（标签/项目关联全保留）
app.post("/api/roots/:id/relocate", asyncRoute(async (req, res) => {
  const result = await relocateRoot(lib, req.params.id, req.body.path, { confirm: req.body.confirm === true });
  if (result.needsConfirm) return res.json(result); // 交给界面二次确认
  void reconcileWatcher?.refresh();
  res.json(result);
}));
// 仅注销：保留记录与全部属性，可恢复
app.post("/api/roots/:id/retire", asyncRoute(async (req, res) => {
  const root = lib.retireRoot(req.params.id);
  void reconcileWatcher?.refresh();
  res.json({ root });
}));
app.post("/api/roots/:id/restore", asyncRoute(async (req, res) => {
  const root = lib.restoreRoot(req.params.id);
  void reconcileWatcher?.refresh();
  res.json({ root, job: lib.scan(root.id) });
}));
// 彻底删除：只允许"已注销且名下没有素材"的根
app.delete("/api/roots/:id", asyncRoute(async (req, res) => res.json(lib.deleteRoot(req.params.id))));
// 对账：把外部（访达/脚本/GPT）整理过的文件重新认领回原素材 id，而不是当成新素材
app.get("/api/reconcile", (req, res) =>
  res.json({
    roots: lib.roots().map((r) => ({
      id: r.id, name: r.name, path: r.path, online: r.online,
      revision: r.revision ?? 0, reconciledMs: r.reconciled_ms ?? null,
    })),
    watching: reconcileWatcher ? reconcileWatcher.activeRoots : 0,
  }),
);
app.post("/api/reconcile", asyncRoute(async (req, res) => {
  const all = lib.roots();
  const wanted = typeof req.body.rootId === "string" && req.body.rootId ? all.filter((r) => r.id === req.body.rootId) : all;
  if (!wanted.length) throw Error("还没有登记任何素材目录");
  const withHash = req.body.hash === true; // 是否顺便渐进补齐 sha256（默认不读全文件，快）
  const reports = [];
  for (const root of wanted)
    reports.push(
      await reconcileRoot(lib, root, {
        importMetadata: req.body.importMetadata === true, // 把清单里的标签/备注并入数据库
        hashBudgetFiles: withHash ? undefined : 0,
        hashBudgetBytes: withHash ? undefined : 0,
        tagFiles: process.env.MEDIA_READONLY_FILES !== "1",
      }),
    );
  res.json({ reports });
}));
app.get("/api/projects", asyncRoute(async (req, res) => res.json(projects.list())));
app.post("/api/projects", asyncRoute(async (req, res) => res.json(projects.save(null, req.body))));
app.patch("/api/projects/:id", asyncRoute(async (req, res) => res.json(projects.save(req.params.id, req.body))));
app.delete("/api/projects/:id", asyncRoute(async (req, res) => res.json(projects.remove(req.params.id))));
app.get("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.items(req.params.id, req.query))));
app.get("/api/projects/:id/members", asyncRoute(async (req, res) => res.json(projects.members(req.params.id))));
app.post("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.add(req.params.id, req.body))));
app.patch("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.change(req.params.id, req.body))));
app.delete("/api/projects/:id/items", asyncRoute(async (req, res) => res.json(projects.removeItems(req.params.id, req.body))));
app.get("/api/assets/:id/projects", asyncRoute(async (req, res) => res.json(projects.history(req.params.id))));
app.get("/api/duplicate-audio", asyncRoute(async (req, res) => res.json(duplicateAudio.state(req.query.scope || "sfx"))));
app.post("/api/duplicate-audio/start", asyncRoute(async (req, res) => res.json(duplicateAudio.start(req.body))));
app.post("/api/duplicate-audio/cancel", (req, res) => res.json(duplicateAudio.cancel()));
app.post("/api/duplicate-audio/mark", asyncRoute(async (req, res) => res.json(await duplicateAudio.mark(req.body))));
app.post("/api/maintenance/files", asyncRoute(async (req, res) => {
  res.json(await missingFiles.check({ force: req.body.force === true, dryRun: req.body.dryRun === true }));
}));
const cleanupConfirmations = new Map();
app.post("/api/maintenance/files/cleanup/preview", asyncRoute(async (req, res) => {
  for (const [id, item] of cleanupConfirmations) if (Date.now() - item.createdMs > 600000) cleanupConfirmations.delete(id);
  const items = missingFiles.cleanupPreview(req.body.ids);
  const confirmation = crypto.randomBytes(24).toString("hex");
  cleanupConfirmations.set(confirmation, { items, session: req.headers.cookie, createdMs: Date.now() });
  res.json({ confirmation, items });
}));
app.post("/api/maintenance/files/cleanup", asyncRoute(async (req, res) => {
  const saved = cleanupConfirmations.get(req.body.confirmation);
  if (!saved || saved.session !== req.headers.cookie || Date.now() - saved.createdMs > 600000) throw Error("清理确认已失效，请重新核对");
  cleanupConfirmations.delete(req.body.confirmation);
  res.json(await missingFiles.clean(saved.items));
}));
app.get("/api/openai", (req, res) => res.json(musicAnalysis.state()));
app.post(
  "/api/openai/test",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.testConnection()),
  ),
);
app.get("/api/openai/logs", (req, res) =>
  res.json({ items: musicAnalysis.diagnostics.list(1000) }),
);
app.get("/api/assets/:id/analysis-failure", (req, res) => {
  lib.asset(req.params.id);
  res.json({
    diagnostic: musicAnalysis.diagnostics.lastFailure(req.params.id),
  });
});
app.delete("/api/openai/logs", (req, res) =>
  res.json(musicAnalysis.diagnostics.clear()),
);
app.post(
  "/api/openai/config",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.configure(req.body)),
  ),
);
app.delete(
  "/api/openai/config",
  asyncRoute(async (req, res) => res.json(await musicAnalysis.removeKey())),
);
app.get(
  "/api/assets/:id/analysis",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.readCache(req.params.id, req.query)),
  ),
);
app.post(
  "/api/assets/:id/analysis",
  asyncRoute(async (req, res) =>
    res.json(await musicAnalysis.analyze(req.params.id, req.body)),
  ),
);
app.get("/api/tags", (req, res) => res.json(tags.list()));
app.post(
  "/api/tags",
  asyncRoute(async (req, res) => res.json(tags.create(req.body))),
);
app.patch(
  "/api/tags/:id",
  asyncRoute(async (req, res) =>
    res.json(tags.rename(req.params.id, req.body)),
  ),
);
app.delete(
  "/api/tags/:id",
  asyncRoute(async (req, res) => res.json(tags.remove(req.params.id))),
);
app.post(
  "/api/tags/apply",
  asyncRoute(async (req, res) => res.json(tags.apply(req.body))),
);
app.get("/api/music-categories", (req, res) =>
  res.json(musicCategories.list()),
);
app.get("/api/categories", (req, res) => res.json(categories.list(req.query)));
app.get("/api/subcategories", asyncRoute(async (req, res) => res.json(categories.subcategories(req.query.categoryId))));
app.post("/api/subcategories", asyncRoute(async (req, res) => res.json(categories.createSubcategory(req.body))));
app.patch("/api/subcategories/:id", asyncRoute(async (req, res) => res.json(categories.renameSubcategory(req.params.id, req.body))));
app.delete("/api/subcategories/:id", asyncRoute(async (req, res) => res.json(categories.removeSubcategory(req.params.id))));
app.post("/api/categories", asyncRoute(async (req, res) => res.json(categories.create(req.body))));
app.patch("/api/categories/:id", asyncRoute(async (req, res) => res.json(categories.rename(req.params.id, req.body))));
app.delete("/api/categories/:id", asyncRoute(async (req, res) => res.json(categories.remove(req.params.id))));
app.post("/api/categories/assign", asyncRoute(async (req, res) => res.json(categories.assign(req.body))));
app.post("/api/categories/add", asyncRoute(async (req, res) => res.json(categories.add(req.body))));
app.post("/api/categories/detach", asyncRoute(async (req, res) => res.json(categories.detach(req.body))));
app.post("/api/categories/save", asyncRoute(async (req, res) => res.json(categories.save(req.body))));
app.get("/api/assets/:id/categories", (req, res) => res.json(categories.members(req.params.id)));
app.post(
  "/api/music-categories",
  asyncRoute(async (req, res) => res.json(categories.create(req.body))),
);
app.patch(
  "/api/music-categories/:id",
  asyncRoute(async (req, res) =>
    res.json(categories.rename(req.params.id, req.body)),
  ),
);
app.delete(
  "/api/music-categories/:id",
  asyncRoute(async (req, res) =>
    res.json(categories.remove(req.params.id)),
  ),
);
app.post(
  "/api/music-categories/assign",
  asyncRoute(async (req, res) => res.json(categories.assign(req.body))),
);
app.post(
  "/api/music-categories/add",
  asyncRoute(async (req, res) => res.json(categories.add(req.body))),
);
app.get("/api/assets/:id/music-categories", (req, res, next) => {
  try {
    res.json(categories.members(req.params.id));
  } catch (e) {
    next(e);
  }
});
app.get("/api/jobs", (req, res) =>
  res.json({
    jobs: [...lib.jobs.values()].reverse().slice(0, 30),
    metadata: {
      queued: lib.metadataQueue.length,
      active: lib.workers,
      pending: lib.db
        .prepare(
          "SELECT COUNT(*) n FROM assets WHERE (probe='pending' OR capture_status='pending') AND online=1 AND trashed=0",
        )
        .get().n,
    },
  }),
);
app.get("/api/assets", (req, res) => res.json(lib.list(req.query)));
app.get("/api/assets/:id", (req, res, next) => {
  try {
    res.json(lib.asset(req.params.id));
  } catch (e) {
    next(e);
  }
});
app.patch(
  "/api/assets/:id",
  asyncRoute(async (req, res) => res.json(lib.patch(req.params.id, req.body))),
);
app.post(
  "/api/batch",
  asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body.ids) || req.body.ids.length > 200)
      throw Error("每批最多200项");
    const results = req.body.ids.map((id) => {
      try {
        return { id, ok: true, asset: lib.patch(id, req.body.patch || {}) };
      } catch (e) {
        return { id, ok: false, error: e.message };
      }
    });
    res.json(results);
  }),
);
app.post(
  "/api/folders/choose",
  asyncRoute(async (req, res) => {
    if (process.platform !== "darwin")
      throw Error("系统文件夹选择器仅支持 Mac");
    const { stdout } = await run(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "选择素材文件夹")'],
      { timeout: 120000 },
    );
    const root = await lib.addRoot(stdout.trim(), req.body.kind);
    void reconcileWatcher?.refresh();
    res.json({ root, job: lib.scan(root.id) });
  }),
);
app.post(
  "/api/roots/:id/scan",
  asyncRoute(async (req, res) => res.json(lib.scan(req.params.id))),
);
app.post(
  "/api/assets/:id/reveal",
  asyncRoute(async (req, res) => {
    res.json({ ok: true, asset: await lib.reveal(req.params.id) });
  }),
);
const confirmations = new Map();
app.use("/api/operations", (req, res, next) => {
  if (process.env.MEDIA_READONLY_FILES === "1" && req.method !== "GET") return res.status(403).json({ error: "当前为原文件只读模式，不允许移动、改名、删除或恢复原文件" });
  next();
});
app.post(
  "/api/operations/preview",
  asyncRoute(async (req, res) => {
    for (const [key, value] of confirmations)
      if (Date.now() - value.createdAt > 600000) confirmations.delete(key);
    const items = await lib.plan(req.body);
    const confirmation = crypto.randomBytes(24).toString("hex");
    confirmations.set(confirmation, {
      input: req.body,
      items,
      createdAt: Date.now(),
      session: req.headers.cookie,
    });
    res.json({ items, confirmation });
  }),
);
app.post(
  "/api/operations",
  asyncRoute(async (req, res) => {
    const record = confirmations.get(req.body.confirmation);
    if (
      !record ||
      record.session !== req.headers.cookie ||
      Date.now() - record.createdAt > 600000
    )
      throw Error("操作确认已失效，请重新检查目标路径");
    confirmations.delete(req.body.confirmation);
    const results = await lib.execute(record.input, record.items);
    if (record.input.action === "trash") {
      try {
        const sync = await duplicateAudio.reconcileTrash(results.filter(r => r.ok).map(r => r.id));
        for (const result of results) if (result.ok) result.duplicateTagsRemoved = sync.removed;
      } catch (e) {
        for (const result of results) if (result.ok) result.warning = "文件已移入废纸篓，但重复标签同步失败：" + e.message;
      }
    }
    res.json(results);
  }),
);
app.get("/api/operations", (req, res) =>
  res.json(
    lib.db
      .prepare("SELECT * FROM operations ORDER BY rowid DESC LIMIT 200")
      .all(),
  ),
);
app.post(
  "/api/operations/:id/undo",
  asyncRoute(async (req, res) => res.json(await lib.undo(req.params.id))),
);
app.get("/api/export", (req, res) => {
  const selected = String(req.query.ids || "")
    .split(",")
    .filter(Boolean);
  const rows = selected.length
    ? selected.slice(0, 200).map((id) => lib.asset(id))
    : lib.db
        .prepare("SELECT * FROM assets WHERE trashed=0 ORDER BY name")
        .all()
        .map((a) => ({ ...a, tags: JSON.parse(a.tags) }));
  const cell = (v) => {
    let s = String(v ?? "");
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  const csv = [
    [
      "文件名",
      "类型",
      "分类",
      "子类",
      "标签",
      "备注",
      "时长（秒）",
      "大小（字节）",
      "创建时间（北京时间）",
      "拍摄时间（北京时间）",
      "拍摄时间来源",
      "路径",
      "确认状态",
    ],
    ...rows.map((a) => [
      a.name,
      a.kind,
      a.category,
      a.sub,
      a.tags.join("、"),
      a.note,
      a.duration,
      a.size,
      a.created_ms === null
        ? ""
        : new Date(a.created_ms).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            hour12: false,
          }),
      a.captured_ms === null
        ? ""
        : new Date(a.captured_ms).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
            hour12: false,
          }),
      a.capture_source,
      a.path,
      a.confirmed ? "人工确认" : a.review ? "待试听确认" : "自动初分",
    ]),
  ]
    .map((r) => r.map(cell).join(","))
    .join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename*=UTF-8''%E7%B4%A0%E6%9D%90%E6%B8%85%E5%8D%95.csv",
  );
  res.send("\uFEFF" + csv);
});
const cacheJobs = new Map();
let previewTail = Promise.resolve();
let clearing = false;
const cacheKey = (a, suffix) =>
  path.join(
    lib.cache,
    crypto
      .createHash("sha256")
      .update(`${a.id}:${a.size}:${a.mtime}:${suffix}`)
      .digest("hex") +
      "." +
      suffix,
  );
async function cached(a, suffix, generate) {
  const dest = cacheKey(a, suffix);
  try {
    await fs.access(dest);
    return dest;
  } catch {}
  if (clearing) throw Error("缓存正在清理，请稍后重试");
  if (!cacheJobs.has(dest)) {
    const task = previewTail.then(async () => {
      const temp = dest + ".tmp." + suffix;
      try {
        await generate(temp);
        await fs.rename(temp, dest);
        return dest;
      } finally {
        await fs.unlink(temp).catch(() => {});
      }
    });
    previewTail = task.catch(() => {});
    cacheJobs.set(dest, task);
    task.finally(() => cacheJobs.delete(dest)).catch(() => {});
  }
  return cacheJobs.get(dest);
}
async function sendMedia(req, res, p) {
  const s = await fs.stat(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const types = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
  };
  res.setHeader("Content-Type", types[ext] || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start, end;
    if (m && !m[1] && m[2]) {
      start = Math.max(0, s.size - Number(m[2]));
      end = s.size - 1;
    } else {
      start = m && Number(m[1]);
      end = m?.[2] ? Number(m[2]) : s.size - 1;
    }
    if (
      !m ||
      (!m[1] && !m[2]) ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start >= s.size ||
      end < start
    ) {
      res.status(416).set("Content-Range", `bytes */${s.size}`).end();
      return;
    }
    end = Math.min(end, s.size - 1);
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${s.size}`);
    res.setHeader("Content-Length", end - start + 1);
    const stream = createReadStream(p, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } else {
    res.setHeader("Content-Length", s.size);
    const stream = createReadStream(p);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  }
}
app.get(
  "/api/media/:id/:mode",
  asyncRoute(async (req, res) => {
    const { a, p } = await lib.source(req.params.id);
    const mode = req.params.mode;
    if (mode === "original") return sendMedia(req, res, p);
    if (mode === "wave") {
      const output = await cached(a, "png", (dest) =>
        run(
          "ffmpeg",
          [
            "-v",
            "error",
            "-threads",
            "1",
            "-i",
            p,
            "-filter_complex",
            "aformat=channel_layouts=mono,showwavespic=s=640x72:colors=0x557b6b",
            "-frames:v",
            "1",
            "-y",
            dest,
          ],
          { timeout: 60000, maxBuffer: 1e6 },
        ),
      );
      return sendMedia(req, res, output);
    }
    if (mode === "thumb") {
      const output = await cached(a, "jpg", async (dest) => {
        if (process.platform === "darwin" &&
          [
            "heic",
            "heif",
            "arw",
            "cr2",
            "cr3",
            "nef",
            "dng",
            "raf",
            "orf",
            "rw2",
            "tif",
            "tiff",
          ].includes(a.ext)
        )
          await run(
            "sips",
            [
              "-s",
              "format",
              "jpeg",
              "--resampleHeightWidthMax",
              "1200",
              p,
              "--out",
              dest,
            ],
            { timeout: 30000, maxBuffer: 1e6 },
          );
        else
          await run(
            "ffmpeg",
            [
              "-v",
              "error",
              "-threads",
              "1",
              "-i",
              p,
              "-frames:v",
              "1",
              "-vf",
              "scale=800:800:force_original_aspect_ratio=decrease",
              "-y",
              dest,
            ],
            { timeout: 30000, maxBuffer: 1e6 },
          );
      });
      return sendMedia(req, res, output);
    }
    if (mode === "proxy") {
      if (a.kind === "photo") throw Error("照片请使用缩略图预览");
      const audioOnly =
        ["sfx", "music"].includes(a.kind) &&
        !["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm"].includes(
          a.ext,
        );
      const output = await cached(a, audioOnly ? "m4a" : "mp4", (dest) =>
        run(
          "ffmpeg",
          [
            "-v",
            "error",
            "-threads",
            "2",
            "-i",
            p,
            ...(audioOnly
              ? ["-vn", "-c:a", "aac", "-b:a", "160k"]
              : [
                  "-map",
                  "0:v:0",
                  "-map",
                  "0:a?",
                  "-vf",
                  "scale=1280:720:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
                  "-c:v",
                  "libx264",
                  "-preset",
                  "veryfast",
                  "-crf",
                  "25",
                  "-pix_fmt",
                  "yuv420p",
                  "-c:a",
                  "aac",
                ]),
            "-movflags",
            "+faststart",
            "-y",
            dest,
          ],
          { timeout: 600000, maxBuffer: 1e6 },
        ),
      );
      return sendMedia(req, res, output);
    }
    throw Error("预览类型不存在");
  }),
);
app.get(
  "/api/cache",
  asyncRoute(async (req, res) => {
    let bytes = 0,
      files = 0;
    for (const n of await fs.readdir(lib.cache)) {
      const s = await fs.stat(path.join(lib.cache, n));
      bytes += s.size;
      files++;
    }
    res.json({ bytes, files, active: cacheJobs.size });
  }),
);
app.post(
  "/api/cache/clear",
  asyncRoute(async (req, res) => {
    if (cacheJobs.size || clearing) throw Error("预览生成中，请完成后再清理");
    clearing = true;
    try {
      for (const n of await fs.readdir(lib.cache))
        await fs.unlink(path.join(lib.cache, n));
      res.json({ ok: true });
    } finally {
      clearing = false;
    }
  }),
);

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(project, "dist")));
  app.get("*", (req, res) =>
    res.sendFile(path.join(project, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: project,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  console.error(error.message);
  res
    .status(400)
    .json({
      error: String(error.stderr || error.message).slice(0, 500),
      ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}),
    });
});
const startPort = Number(process.env.PORT) || 4317;
async function listen(n) {
  port = n;
  return new Promise((resolve, reject) => {
    const server = app.listen(n, process.env.MEDIA_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
}
let server;
for (let p = startPort; p < startPort + 30; p++) {
  try {
    server = await listen(p);
    break;
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
  }
}
if (!server) throw Error("没有可用端口");
console.log(`拾光素材库 http://127.0.0.1:${port}`);
await fs.writeFile(
  path.join(dataDir, "server.json"),
  JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}`, instanceId: mysqlStorage.sourceId }),
);
// 启动对账 + 目录监听：用户在访达/终端（或 GPT）直接整理过文件时，把文件重新认领回原素材，
// 而不是让标签、备注、项目关联随路径一起丢。默认不读全文件（不算 sha256），因此很快。
// MEDIA_SKIP_RECONCILE=1 关闭对账，MEDIA_NO_WATCH=1 只对账不监听，MEDIA_RECONCILE_HASH=1 顺便补哈希。
if (process.env.MEDIA_SKIP_RECONCILE !== "1") {
  void (async () => {
    for (const root of lib.roots()) {
      try {
        const report = await reconcileRoot(lib, root, {
          tagFiles: process.env.MEDIA_READONLY_FILES !== "1",
          hashBudgetFiles: process.env.MEDIA_RECONCILE_HASH === "1" ? undefined : 0,
          hashBudgetBytes: process.env.MEDIA_RECONCILE_HASH === "1" ? undefined : 0,
        });
        const adopted = report.adoptedByXattr + report.adoptedByHash;
        if (report.moved || report.renamed || adopted || report.added || report.missing || report.conflicts.length)
          console.log(
            `[reconcile] ${root.name || root.path}：移动 ${report.moved} / 改名 ${report.renamed} / 认领 ${adopted} / 新增 ${report.added} / 失联 ${report.missing} / 冲突 ${report.conflicts.length} / 跳过写库 ${report.skipped} / 打标 ${report.tagged}（${report.elapsedMs}ms）`,
          );
        for (const c of report.conflicts.slice(0, 3))
          console.warn(`[reconcile] 冲突：${c.path || c.entryId || ""} —— ${String(c.error).slice(0, 120)}`);
      } catch (e) {
        console.warn(`[reconcile] ${root.path} 启动对账失败：${e.message}`);
      }
    }
  })();
  if (process.env.MEDIA_NO_WATCH !== "1") {
    try {
      reconcileWatcher = startWatcher(lib, { log: (m) => console.log(m) });
      console.log(`[reconcile] 已监听 ${reconcileWatcher.activeRoots} 个素材目录：外部改名/移动会在 1~2 秒内自动接上`);
    } catch (e) {
      console.warn("[reconcile] 无法启动目录监听：" + e.message);
    }
  }
}
if (!process.env.MEDIA_SKIP_IMPORT) {
  const workspace = path.dirname(project);
  let classification = new Map();
  try {
    const data = JSON.parse(
      await fs.readFile(
        path.join(workspace, "音效_按用途分类", "分类记录.json"),
        "utf8",
      ),
    );
    classification = new Map(data.files.map((f) => [f.path, f]));
  } catch {}
  for (const [relative, kind] of [
    ["音效/音效", "sfx"],
    ["音效/音乐", "music"],
  ]) {
    const p = path.join(workspace, relative);
    try {
      await fs.access(p);
      const root = await lib.addRoot(p, kind);
      if (
        !lib.db
          .prepare("SELECT id FROM assets WHERE root_id=? LIMIT 1")
          .get(root.id)
      )
        lib.scan(root.id, classification);
    } catch (e) {
      console.warn("初始导入：" + e.message);
    }
  }
}
