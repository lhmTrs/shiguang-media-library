import { useEffect, useRef, useState } from "react";
import {
  Tag,
  Plus,
  Search,
  RefreshCw,
  FilePenLine,
  Trash2,
  X,
  Check,
  ListPlus,
  Play,
  Eye,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import type { Asset } from "./main";
import { QuickTagDialog } from "./QuickTagDialog";
import { MusicTagQueue } from "./MusicTagQueue";
type TagItem = { id: string; name: string; n: number; total?: number };
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
  preview: (a: Asset) => void;
  stopPreview: () => void;
  changed: () => void;
};
export function TagManager({ request, preview, stopPreview, changed, edit, revision, trash, canTrash }: Props) {
  const [queue, setQueue] = useState(false);
  const [sort, setSort] = useState("revealCount");
  const [tags, setTags] = useState<TagItem[]>([]),
    [active, setActive] = useState("all"),
    [tagSearch, setTagSearch] = useState("");
  const [items, setItems] = useState<Asset[]>([]),
    [total, setTotal] = useState(0),
    [pages, setPages] = useState(0),
    [page, setPage] = useState(1);
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [checked, setChecked] = useState<Set<string>>(new Set()),
    [target, setTarget] = useState("");
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
  const [kind, setKind] = useState(""),
    [tagSort, setTagSort] = useState("usage"),
    [hideEmpty, setHideEmpty] = useState(false),
    [quick, setQuick] = useState<Asset | null>(null);
  const all = {
    id: "all",
    name: "全部素材",
    n: tags.find((t) => t.id === "untagged")?.total || 0,
  };
  const selected = active === "all" ? all : tags.find((t) => t.id === active);
  async function load() {
    const s = ++seq.current;
    const list = await request<TagItem[]>("/tags");
    if (s !== seq.current) return;
    setTags(list);
    const selected = list.find((t) => t.id === active);
    if (active !== "all" && !selected) {
      setActive("all");
      return;
    }
    if (target && !list.some((t) => t.id === target)) setTarget("");
    const params = new URLSearchParams({ page: String(page), q: search, sort });
    if (kind) params.set("kind", kind);
    if (active === "untagged") params.set("untagged", "1");
    else if (selected) params.set("tagName", selected.name);
    const data = await request<{
      items: Asset[];
      total: number;
      pages: number;
    }>("/assets?" + params);
    if (s !== seq.current) return;
    setItems(data.items);
    setTotal(data.total);
    setPages(data.pages);
    if (page > Math.max(1, data.pages)) setPage(Math.max(1, data.pages));
    setChecked(
      (prev) =>
        new Set([...prev].filter((id) => data.items.some((a) => a.id === id))),
    );
  }
  loadRef.current = load;
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 220);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setPage(1);
    setChecked(new Set());
  }, [active, search, kind, sort]);
  useEffect(() => {
    setLoading(true);
    load()
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
    return () => {
      seq.current++;
    };
  }, [active, page, search, kind, revision, sort]);
  useEffect(() => {
    const timer = setInterval(
      () => void loadRef.current().catch(() => {}),
      5000,
    );
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setEditor(null);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [busy]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await loadRef.current();
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "标签操作失败");
    } finally {
      setBusy(false);
    }
  }
  const apply = (ids: string[], tagId: string, mode: "add" | "remove") =>
    action(async () => {
      await request("/tags/apply", { ids, tagId, action: mode });
      setChecked(new Set());
      setNotice(
        mode === "add"
          ? "标签已添加，原有标签保留"
          : "标签已移除，素材文件保留",
      );
    });
  const isTag = active !== "all" && active !== "untagged";
  const visibleTags = tags
    .filter(
      (t) =>
        t.id !== "untagged" &&
        (!hideEmpty || t.n > 0) &&
        t.name.toLowerCase().includes(tagSearch.toLowerCase()),
    )
    .sort((a, b) =>
      tagSort === "usage"
        ? b.n - a.n || a.name.localeCompare(b.name, "zh-CN")
        : a.name.localeCompare(b.name, "zh-CN"),
    );
  if (queue)
    return (
      <MusicTagQueue
        request={request}
        preview={preview}
        stopPreview={stopPreview}
        changed={changed}
        close={() => {
          setQueue(false);
          void loadRef.current();
        }}
      />
    );
  return (
    <section className="tag-manager">
      <header className="library-heading">
        <div>
          <h1>标签管理</h1>
          <p>
            <strong>{Math.max(0, tags.length - 1)}</strong> 个标签 ·{" "}
            <strong>{all.n.toLocaleString()}</strong> 个素材
          </p>
        </div>
        <div className="heading-tools">
          <button className="primary" onClick={() => setQueue(true)}>
            <Play size={16} />
            连续标记音乐
          </button>
          <button
            className="icon-button"
            aria-label="刷新标签"
            title="刷新标签"
            disabled={busy}
            onClick={() => void action(async () => {})}
          >
            <RefreshCw size={17} />
          </button>
          <button
            className="primary"
            onClick={() => setEditor({ mode: "create", name: "" })}
          >
            <Plus size={16} />
            新建标签
          </button>
        </div>
      </header>
      <div className="tag-coverage">
        <span>
          已标记 <strong>{(all.n - (tags[0]?.n || 0)).toLocaleString()}</strong>
        </span>
        <progress
          aria-label="素材标签覆盖率"
          max={Math.max(1, all.n)}
          value={all.n - (tags[0]?.n || 0)}
        />
        <span>
          未标记 <strong>{(tags[0]?.n || 0).toLocaleString()}</strong>
        </span>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="关闭标签错误"
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
            aria-label="关闭标签提示"
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
              aria-label="搜索标签"
              placeholder="搜索标签"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
            />
          </label>
          <div className="tag-directory-controls">
            <select
              aria-label="标签排序"
              value={tagSort}
              onChange={(e) => setTagSort(e.target.value)}
            >
              <option value="usage">使用量排序</option>
              <option value="name">名称排序</option>
            </select>
            <label className="check-label">
              <input
                type="checkbox"
                checked={hideEmpty}
                onChange={(e) => setHideEmpty(e.target.checked)}
              />
              隐藏空标签
            </label>
          </div>
          <div className="category-directory-list">
            {[all, ...tags.filter((t) => t.id === "untagged"), ...visibleTags]
              .filter((t) =>
                t.name.toLowerCase().includes(tagSearch.toLowerCase()),
              )
              .map((t) => (
                <button
                  key={t.id}
                  className={
                    "category-entry " + (active === t.id ? "selected" : "")
                  }
                  onClick={() => {
                    setActive(t.id);
                    setPage(1);
                    setQuery("");
                    setChecked(new Set());
                    if (t.id !== "all" && t.id !== "untagged") setTarget(t.id);
                  }}
                  title={t.name}
                >
                  <Tag size={16} />
                  <span>{t.name}</span>
                  <small>{t.n.toLocaleString()}</small>
                </button>
              ))}
            {tagSearch && !visibleTags.length && (
              <div className="tag-no-match">
                <p>没有匹配的标签</p>
                <button
                  className="text-button"
                  onClick={() =>
                    setEditor({ mode: "create", name: tagSearch.slice(0, 60) })
                  }
                >
                  <Plus size={14} />
                  新建标签
                </button>
              </div>
            )}
          </div>
        </aside>
        <div className="category-content">
          <div className="category-content-heading">
            <div>
              <h2>{selected?.name || "全部素材"}</h2>
              <p>{selected?.n.toLocaleString() || 0} 个素材</p>
            </div>
            {isTag && (
              <div className="heading-tools">
                <button
                  className="icon-button"
                  aria-label="重命名标签"
                  title="重命名标签"
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
                  aria-label="删除标签"
                  title="删除标签"
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
          <div className="category-music-tools">
            <label className="search">
              <Search size={16} />
              <input
                aria-label="搜索标签中的素材"
                placeholder="搜索素材、标签或备注"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button
                  className="icon-button"
                  aria-label="清空标签素材搜索"
                  onClick={() => setQuery("")}
                >
                  <X size={14} />
                </button>
              )}
            </label>
            <select
              aria-label="筛选标签素材类型"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">全部类型</option>
              <option value="music">音乐</option>
              <option value="sfx">音效</option>
              <option value="photo">照片</option>
              <option value="video">视频</option>
            </select>
            <span>{total.toLocaleString()} 项</span>
            <select aria-label="标签素材排序" value={sort} onChange={e => setSort(e.target.value)}>
              <option value="revealCount">访达次数：从多到少</option>
              <option value="name">名称排序</option>
              <option value="recent">最近修改</option>
            </select>
          </div>
          {checked.size > 0 && (
            <div className="category-assignment">
              <span>已选 {checked.size} 项</span>
              <select
                aria-label="目标标签"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">选择标签</option>
                {tags
                  .filter((t) => t.id !== "untagged")
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
              <button
                className="plain"
                disabled={busy || !target}
                onClick={() => void apply([...checked], target, "add")}
              >
                <ListPlus size={15} />
                添加标签
              </button>
              <button
                className="plain"
                disabled={busy || !target}
                onClick={() => void apply([...checked], target, "remove")}
              >
                <X size={15} />
                移除标签
              </button>
              <button
                className="icon-button"
                aria-label="取消标签素材勾选"
                onClick={() => setChecked(new Set())}
              >
                <X size={15} />
              </button>
            </div>
          )}
          <div className="category-table-head">
            <input
              type="checkbox"
              aria-label="勾选本页标签素材"
              checked={
                items.length > 0 && items.every((a) => checked.has(a.id))
              }
              onChange={() =>
                setChecked(
                  items.every((a) => checked.has(a.id))
                    ? new Set()
                    : new Set(items.map((a) => a.id)),
                )
              }
            />
            <span>素材名称 / 标签</span>
            <span>类型</span>
            <span>操作</span>
          </div>
          {!items.length ? (
            <div className="empty">
              <Tag size={28} />
              <h3>
                {loading
                  ? "读取素材中"
                  : search
                    ? "没有匹配的素材"
                    : "这个标签还没有素材"}
              </h3>
            </div>
          ) : (
            items.map((a) => (
              <div className="category-music-row" key={a.id}>
                <input
                  type="checkbox"
                  aria-label={"勾选标签素材：" + a.name}
                  checked={checked.has(a.id)}
                  onChange={() =>
                    setChecked((prev) => {
                      const next = new Set(prev);
                      next.has(a.id) ? next.delete(a.id) : next.add(a.id);
                      return next;
                    })
                  }
                />
                <div className="category-music-name">
                  <button
                    className={"file-icon " + a.kind}
                    aria-label={"预览标签素材：" + a.name}
                    disabled={a.ext === "ncm"}
                    onClick={() => preview(a)}
                  >
                    {["music", "sfx"].includes(a.kind) ? (
                      <Play size={16} />
                    ) : (
                      <Eye size={16} />
                    )}
                  </button>
                  <div>
                    <button className="asset-name-button" title={a.name} onClick={() => edit(a)}>{a.name}</button>
                    <div className="tag-chips">
                      {a.tags.length ? (
                        a.tags.slice(0, 3).map((name) => (
                          <button
                            key={name}
                            className="tag-chip"
                            title={name}
                            onClick={() => {
                              const tag = tags.find((t) => t.name === name);
                              if (tag) {
                                setActive(tag.id);
                                setQuery("");
                                setPage(1);
                                setChecked(new Set());
                              }
                            }}
                          >
                            {name}
                          </button>
                        ))
                      ) : (
                        <span className="tag-blank">未标记</span>
                      )}
                      {a.tags.length > 3 && (
                        <button
                          className="tag-chip"
                          title="查看全部标签"
                          onClick={() => setQuick(a)}
                        >
                          +{a.tags.length - 3}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <span className="tag-kind">
                  <small className="reveal-count">访达 {a.reveal_count || 0} 次</small>
                  {
                    (
                      {
                        photo: "照片",
                        video: "视频",
                        music: "音乐",
                        sfx: "音效",
                      } as Record<string, string>
                    )[a.kind]
                  }
                </span>
                <div className="category-song-actions">
                  <button
                    className="icon-button"
                    title="管理素材标签"
                    aria-label={"管理素材标签：" + a.name}
                    disabled={busy}
                    onClick={() => setQuick(a)}
                  >
                    <ListPlus size={17} />
                  </button>
                  <button className="icon-button" title="在访达中显示"
                    aria-label={"定位素材：" + a.name} disabled={busy}
                    onClick={() => void action(async () => { await request(`/assets/${a.id}/reveal`, {}); })}>
                    <ExternalLink size={15}/>
                  </button>
                  <button className="icon-button" title="删除素材（移入废纸篓）"
                    aria-label={"删除素材：" + a.name} disabled={!a.online || busy || !canTrash}
                    onClick={() => trash(a)}><Trash2 size={16}/></button>
                  {isTag && (
                    <button
                      className="icon-button"
                      aria-label={"移除当前标签：" + a.name}
                      title="移除当前标签"
                      disabled={busy}
                      onClick={() => void apply([a.id], active, "remove")}
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
          <footer className="category-pagination">
            <span>{total.toLocaleString()} 个素材</span>
            <div>
              <button
                className="icon-button"
                aria-label="上一页标签素材"
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
                aria-label="下一页标签素材"
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
                ? "新建标签"
                : editor.mode === "rename"
                  ? "重命名标签"
                  : "删除标签"
            }
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                if (editor.mode === "create") {
                  const t = await request<TagItem>("/tags", {
                    name: editor.name,
                  });
                  setActive(t.id);
                  setTarget(t.id);
                  setQuery("");
                } else if (editor.mode === "rename")
                  await request(
                    "/tags/" + editor.id,
                    { name: editor.name },
                    "PATCH",
                  );
                else {
                  await request("/tags/" + editor.id, {}, "DELETE");
                  setActive("all");
                }
                setEditor(null);
                setNotice(
                  editor.mode === "delete"
                    ? "标签已删除，素材文件保留"
                    : "标签已保存",
                );
              });
            }}
          >
            <div className="modal-head">
              <h2>
                {editor.mode === "create"
                  ? "新建标签"
                  : editor.mode === "rename"
                    ? "重命名标签"
                    : "删除标签"}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭标签编辑"
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
                  ”，并从所有素材中移除此标签。素材文件不会删除。
                </p>
              ) : (
                <label className="field">
                  标签名称
                  <input
                    autoFocus
                    required
                    maxLength={60}
                    aria-label="标签名称"
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
                <Check size={15} />
                {editor.mode === "delete" ? "确认删除标签" : "保存标签"}
              </button>
            </div>
          </form>
        </div>
      )}
      {quick && (
        <QuickTagDialog
          asset={quick}
          request={request}
          close={() => setQuick(null)}
          changed={() => {
            void loadRef.current().catch((e) => setError(e.message));
            changed();
            setNotice("素材标签已更新");
          }}
        />
      )}
    </section>
  );
}
