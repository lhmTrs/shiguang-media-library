import { useEffect, useRef, useState } from "react";
import {
  FolderOpen,
  FolderPlus,
  Search,
  RefreshCw,
  FilePenLine,
  Trash2,
  Play,
  Pause,
  X,
  Check,
  ArrowRightLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Music2,
  ListPlus,
  Eye,
} from "lucide-react";
import type { Asset } from "./main";
import { QuickCategoryDialog } from "./QuickCategoryDialog";
import { SubcategoryManager } from "./SubcategoryManager";
type Category = {
  id: string;
  name: string;
  n: number;
  offline: number;
  totalAssets?: number;
  totalOffline?: number;
};
const allAssets = (cats: Category[]): Category => ({
  id: "all",
  name: "全部素材",
  n:
    cats.find((c) => c.id === "uncategorized")?.totalAssets ??
    cats.reduce((n, c) => n + c.n, 0),
  offline:
    cats.find((c) => c.id === "uncategorized")?.totalOffline ??
    cats.reduce((n, c) => n + c.offline, 0),
});
type Props = {
  trash: (a: Asset) => void;
  canTrash: boolean;
  edit: (a: Asset) => void;
  revision: number;
  request: <T = unknown>(
    url: string,
    body?: unknown,
    method?: string,
  ) => Promise<T>;
  play: (a: Asset) => void;
  playingId?: string;
  isPlaying: boolean;
  changed: () => void;
};
export function CategoryManager({
  trash,
  canTrash,
  edit,
  revision,
  request,
  play,
  playingId,
  isPlaying,
  changed,
}: Props) {
  const [categories, setCategories] = useState<Category[]>([]),
    [active, setActive] = useState("all");
  const [items, setItems] = useState<Asset[]>([]),
    [total, setTotal] = useState(0),
    [page, setPage] = useState(1),
    [pages, setPages] = useState(0);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [categorySearch, setCategorySearch] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set()),
    [target, setTarget] = useState("uncategorized");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{
    mode: "create" | "rename" | "delete";
    id?: string;
    name: string;
  } | null>(null);
  const seq = useRef(0),
    loadRef = useRef<() => Promise<void>>(async () => {});
  const [quick, setQuick] = useState<Asset | null>(null);
  const [sort, setSort] = useState("revealCount");
  const [kind, setKind] = useState("");
  const [subcategory, setSubcategory] = useState("");
  const [hierarchyRevision, setHierarchyRevision] = useState(0);
  async function load() {
    const sequence = ++seq.current;
    const cats = await request<Category[]>("/categories" + (kind ? "?kind=" + kind : ""));
    const selected =
      active === "all" ? allAssets(cats) : cats.find((c) => c.id === active);
    if (sequence !== seq.current) return;
    setCategories(cats);
    if (!cats.some((c) => c.id === target)) setTarget("uncategorized");
    if (!selected) {
      setActive("uncategorized");
      return;
    }
    const params = new URLSearchParams({
      kind,
      page: String(page),
      q: search,
      sort,
    });
    if (active === "uncategorized") params.set("uncategorized", "1");
    else if (active !== "all") params.set("category", selected.name);
    if (subcategory && active !== "all" && active !== "uncategorized") params.set("subcategoryId", subcategory);
    const result = await request<{
      items: Asset[];
      total: number;
      pages: number;
    }>("/assets?" + params);
    if (sequence !== seq.current) return;
    setItems(result.items);
    setTotal(result.total);
    setPages(result.pages);
    if (page > Math.max(1, result.pages)) setPage(Math.max(1, result.pages));
    setChecked(
      (prev) =>
        new Set(
          [...prev].filter((id) => result.items.some((a) => a.id === id)),
        ),
    );
  }
  loadRef.current = load;
  useEffect(() => {
    const t = setTimeout(() => setSearch(query), 220);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    setPage(1);
    setChecked(new Set());
  }, [active, search, sort, kind, subcategory]);
  useEffect(() => { setSubcategory(""); }, [active]);
  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      seq.current++;
    };
  }, [active, page, search, revision, sort, kind, subcategory, hierarchyRevision]);
  useEffect(() => {
    const timer = setInterval(
      () => void loadRef.current().catch(() => {}),
      5000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!editor) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setEditor(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [editor, busy]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await loadRef.current();
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  const selected =
    active === "all"
      ? allAssets(categories)
      : categories.find((c) => c.id === active);
  const allChecked = items.length > 0 && items.every((a) => checked.has(a.id));
  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return (
    <section className="category-manager">
      <header className="library-heading">
        <div>
          <h1>分类管理</h1>
          <p>
            <strong>{Math.max(0, categories.length - 1)}</strong> 个分类 ·{" "}
            <strong>{allAssets(categories).n.toLocaleString()}</strong> 个素材
          </p>
        </div>
        <div className="heading-tools">
          <button
            className="icon-button"
            title="刷新素材分类"
            aria-label="刷新素材分类"
            disabled={busy}
            onClick={() => void action(async () => {})}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="primary"
            onClick={() => setEditor({ mode: "create", name: "" })}
          >
            <FolderPlus size={16} />
            新建分类
          </button>
        </div>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="关闭分类错误"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="category-notice" role="status">
          {notice}
          <button
            className="icon-button"
            aria-label="关闭分类提示"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="category-workspace">
        <aside className="category-directory">
          <label className="search">
            <Search size={15} />
            <input
              aria-label="搜索素材分类"
              placeholder="搜索分类"
              value={categorySearch}
              onChange={(e) => setCategorySearch(e.target.value)}
            />
          </label>
          <div className="category-directory-list">
            {[allAssets(categories), ...categories]
              .filter((c) =>
                c.name.toLowerCase().includes(categorySearch.toLowerCase()),
              )
              .map((c) => (
                <button
                  key={c.id}
                  className={
                    "category-entry " + (active === c.id ? "selected" : "")
                  }
                  onClick={() => {
                    setActive(c.id);
                    setQuery("");
                    setPage(1);
                    setChecked(new Set());
                  }}
                  title={c.name}
                >
                  <FolderOpen size={17} />
                  <span>{c.name.replace(/^\d+_/, "")}</span>
                  <small>{c.n.toLocaleString()}</small>
                </button>
              ))}
            {categories.length > 0 &&
              !categories.some((c) =>
                c.name.toLowerCase().includes(categorySearch.toLowerCase()),
              ) && <p className="category-empty-search">没有匹配的分类</p>}
          </div>
        </aside>
        <div className="category-content">
          <div className="category-content-heading">
            <div>
              <h2>{selected?.name.replace(/^\d+_/, "") || "未分类"}</h2>
              <p>
                {selected?.n.toLocaleString() || 0} 个素材
                {selected?.offline ? ` · ${selected.offline} 个离线` : ""}
              </p>
            </div>
            {active !== "uncategorized" && active !== "all" && (
              <div className="heading-tools">
                <button
                  className="icon-button"
                  title="重命名素材分类"
                  aria-label="重命名素材分类"
                  disabled={busy}
                  onClick={() =>
                    selected &&
                    setEditor({
                      mode: "rename",
                      id: active,
                      name: selected.name,
                    })
                  }
                >
                  <FilePenLine size={17} />
                </button>
                <button
                  className="icon-button"
                  title="删除素材分类"
                  aria-label="删除素材分类"
                  disabled={busy}
                  onClick={() =>
                    selected &&
                    setEditor({
                      mode: "delete",
                      id: active,
                      name: selected.name,
                    })
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            )}
          </div>
          {active !== "all" && active !== "uncategorized" && <SubcategoryManager key={active} parentId={active} request={request} revision={revision + hierarchyRevision} selected={subcategory} select={setSubcategory} changed={() => { setHierarchyRevision(n => n + 1); changed(); }}/>} 
          <div className="category-music-tools">
            <select aria-label="分类素材类型" value={kind} onChange={e => setKind(e.target.value)}>
              <option value="">全部类型</option><option value="music">音乐</option><option value="sfx">音效</option><option value="video">视频</option><option value="photo">照片</option>
            </select>
            <label className="search">
              <Search size={16} />
              <input
                aria-label="搜索分类中的素材"
                placeholder="搜索素材、标签或备注"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  aria-label="清空分类素材搜索"
                  onClick={() => setQuery("")}
                >
                  <X size={14} />
                </button>
              )}
            </label>
            <select aria-label="分类素材排序" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="revealCount">访达次数：从多到少</option>
              <option value="name">名称排序</option>
              <option value="recent">最近修改</option>
            </select>
            <span>{total.toLocaleString()} 项</span>
          </div>
          {checked.size > 0 && (
            <div className="category-assignment">
              <span>已选 {checked.size} 项</span>
              <select
                aria-label="目标素材分类"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                className="plain"
                disabled={busy}
                onClick={() => {
                  if (target === "uncategorized" && !window.confirm("清空所选素材的主分类和全部额外分类？原文件与标签不变。")) return;
                  void action(async () => {
                    await request("/categories/assign", {
                      ids: [...checked],
                      categoryId: target,
                    });
                    setChecked(new Set());
                    setNotice("素材分类已更新");
                  });
                }}
              >
                <ArrowRightLeft size={15} />
                {target === "uncategorized" ? "清空分类" : "设为主分类"}
              </button>
              <button
                className="icon-button"
                aria-label="取消素材勾选"
                onClick={() => setChecked(new Set())}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="category-table-head">
            <input
              type="checkbox"
              aria-label="勾选本页分类素材"
              checked={allChecked}
              onChange={() =>
                setChecked(
                  allChecked ? new Set() : new Set(items.map((a) => a.id)),
                )
              }
            />
            <span>素材名称</span>
            <span>时长</span>
            <span>操作</span>
          </div>
          {loading && !items.length ? (
            <div className="empty">
              <Music2 size={28} />
              <h3>读取素材中</h3>
            </div>
          ) : !items.length ? (
            <div className="empty">
              <Music2 size={30} />
              <h3>{search ? "没有匹配的素材" : "这个分类还没有素材"}</h3>
            </div>
          ) : (
            items.map((a) => (
              <div className="category-music-row" key={a.id}>
                <input
                  type="checkbox"
                  aria-label={`勾选分类素材：${a.name}`}
                  checked={checked.has(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <div className="category-music-name">
                  <button
                    className={"file-icon " + a.kind}
                    aria-label={
                      (!["music", "sfx"].includes(a.kind) ? "查看素材：" : playingId === a.id && isPlaying
                        ? "暂停素材："
                        : "试听素材：") + a.name
                    }
                    disabled={a.ext === "ncm"}
                    onClick={() => ["music", "sfx"].includes(a.kind) ? play(a) : edit(a)}
                  >
                    {!["music", "sfx"].includes(a.kind) ? <Eye size={16}/> : playingId === a.id && isPlaying ? (
                      <Pause size={16} />
                    ) : (
                      <Play size={16} />
                    )}
                  </button>
                  <div>
                    <button className="asset-name-button" title={a.name} onClick={() => edit(a)}>{a.name}</button>
                    <small title={a.path}>
                      {({ music: "音乐", sfx: "音效", video: "视频", photo: "照片" } as Record<string, string>)[a.kind]} · {a.ext.toUpperCase()} ·{" "}
                      {a.tags.join(" · ") ||
                        (a.ext === "ncm"
                          ? "暂不支持试听"
                          : a.online
                            ? "本机素材"
                            : "素材离线")}
                    </small>
                  </div>
                </div>
                <span className="mono" title="访达打开次数 / 时长">
                  <small className="reveal-count">访达 {a.reveal_count || 0} 次</small>
                  {a.kind === "photo" || a.duration === null
                    ? "—"
                    : `${Math.floor(a.duration / 60)
                        .toString()
                        .padStart(2, "0")}:${Math.floor(a.duration % 60)
                        .toString()
                        .padStart(2, "0")}`}
                </span>
                <div className="category-song-actions">
                  <button
                    className="icon-button"
                    title="添加到其他分类"
                    aria-label={"添加素材分类：" + a.name}
                    disabled={busy}
                    onClick={() => setQuick(a)}
                  >
                    <ListPlus size={17} />
                  </button>
                  <button
                    className="icon-button"
                    title="在访达中显示"
                    aria-label={`定位素材：${a.name}`}
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await request("/assets/" + a.id + "/reveal", {});
                      })
                    }
                  >
                    <ExternalLink size={15} />
                  </button>
                  <button className="icon-button" title="删除素材（移入废纸篓）"
                    aria-label={"删除素材：" + a.name}
                    disabled={!a.online || busy || !canTrash}
                    onClick={() => trash(a)}><Trash2 size={16}/></button>
                  {active !== "all" && active !== "uncategorized" && <button className="icon-button" title="移出当前分类" aria-label={"移出当前分类：" + a.name} disabled={busy}
                    onClick={() => void action(async () => { await request("/categories/detach", { assetId: a.id, categoryId: active }); setNotice("已移出当前分类，原文件保留"); })}><X size={16}/></button>}
                </div>
              </div>
            ))
          )}
          <footer className="category-pagination">
            <span>{total.toLocaleString()} 个素材</span>
            <div>
              <button
                className="icon-button"
                aria-label="上一页分类素材"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1);
                  setChecked(new Set());
                }}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {page} / {Math.max(1, pages)}
              </span>
              <button
                className="icon-button"
                aria-label="下一页分类素材"
                disabled={page >= pages}
                onClick={() => {
                  setPage(page + 1);
                  setChecked(new Set());
                }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </footer>
        </div>
      </div>
      {editor && (
        <div className="modal-backdrop">
          <form
            className="modal category-editor"
            role="dialog"
            aria-modal="true"
            aria-label={
              editor.mode === "create"
                ? "新建素材分类"
                : editor.mode === "rename"
                  ? "重命名素材分类"
                  : "删除素材分类"
            }
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                if (editor.mode === "create") {
                  const created = await request<Category>("/categories", {
                    name: editor.name,
                  });
                  setActive(created.id);
                  setPage(1);
                  setQuery("");
                } else if (editor.mode === "rename")
                  await request(
                    "/categories/" + editor.id,
                    { name: editor.name },
                    "PATCH",
                  );
                else {
                  await request("/categories/" + editor.id, {}, "DELETE");
                  setActive("uncategorized");
                  setPage(1);
                }
                setEditor(null);
                setNotice(
                  editor.mode === "delete"
                    ? "分类已删除，素材文件已保留"
                    : "分类已保存",
                );
              });
            }}
          >
            <div className="modal-head">
              <h2>
                {editor.mode === "create"
                  ? "新建素材分类"
                  : editor.mode === "rename"
                    ? "重命名素材分类"
                    : "删除素材分类"}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭分类编辑"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="modal-body">
              {editor.mode === "delete" ? (
                <p>
                  删除“{editor.name}
                  ”，并从所有类型的素材中移除此分类。原始文件不会删除。
                </p>
              ) : (
                <label className="field">
                  分类名称
                  <input
                    autoFocus
                    aria-label="素材分类名称"
                    required
                    maxLength={120}
                    value={editor.name}
                    onChange={(e) =>
                      setEditor({ ...editor, name: e.target.value })
                    }
                  />
                </label>
              )}
              {error && (
                <p className="database-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="plain"
                disabled={busy}
                onClick={() => setEditor(null)}
              >
                取消
              </button>
              <button
                type="submit"
                className={editor.mode === "delete" ? "danger" : "primary"}
                disabled={busy}
              >
                {editor.mode === "delete" ? (
                  <Trash2 size={15} />
                ) : (
                  <Check size={15} />
                )}{" "}
                {busy
                  ? "处理中…"
                  : editor.mode === "delete"
                    ? "确认删除分类"
                    : "保存分类"}
              </button>
            </div>
          </form>
        </div>
      )}
      {quick && (
        <QuickCategoryDialog
          asset={quick}
          request={request}
          close={() => setQuick(null)}
          changed={() => {
            void loadRef.current().catch((e) => setError(e.message));
            changed();
            setNotice("已添加分类，原分类保留");
          }}
        />
      )}
    </section>
  );
}
