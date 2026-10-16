import { useEffect, useState } from "react";
import { X, Check, FolderOpen, ListPlus, Search } from "lucide-react";
import type { Asset } from "./main";
type Category = { id: string; name: string };
type Props = {
  asset: Asset;
  request: <T = unknown>(
    url: string,
    body?: unknown,
    method?: string,
  ) => Promise<T>;
  close: () => void;
  changed: () => void;
};
export function QuickCategoryDialog({ asset, request, close, changed }: Props) {
  const [categories, setCategories] = useState<Category[]>([]),
    [members, setMembers] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([
      request<Category[]>("/categories"),
      request<Category[]>("/assets/" + asset.id + "/categories"),
    ])
      .then(([cats, current]) => {
        if (live) {
          setCategories(cats);
          setMembers(current.map((c) => c.id));
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [asset.id]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [busy, close]);
  async function add(category: Category) {
    setBusy(true);
    setError("");
    try {
      await request("/categories/add", {
        assetId: asset.id,
        categoryId: category.id,
      });
      const current = await request<Category[]>(
        "/assets/" + asset.id + "/categories",
      );
      setMembers(current.map((c) => c.id));
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "分类添加失败");
    } finally {
      setBusy(false);
    }
  }
  const visible = categories.filter(
    (c) =>
      c.id !== "uncategorized" &&
      c.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="modal-backdrop">
      <div
        className="modal category-editor"
        role="dialog"
        aria-modal="true"
        aria-label="添加到其他素材分类"
      >
        <div className="modal-head">
          <h2>添加到其他分类</h2>
          <button
            className="icon-button"
            aria-label="关闭快速分类"
            disabled={busy}
            onClick={close}
          >
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          <p className="quick-song-title">{asset.name}</p>
          <label className="search">
            <Search size={15} />
            <input
              autoFocus
              aria-label="搜索可添加的素材分类"
              placeholder="搜索分类"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="quick-category-list">
            {visible.map((c) => (
              <button
                key={c.id}
                className={
                  "quick-category-option " +
                  (members.includes(c.id) ? "included" : "")
                }
                disabled={busy || members.includes(c.id)}
                onClick={() => void add(c)}
              >
                <FolderOpen size={16} />
                <span>{c.name}</span>
                {members.includes(c.id) ? (
                  <>
                    <small>已包含</small>
                    <Check size={15} />
                  </>
                ) : (
                  <ListPlus size={16} />
                )}
              </button>
            ))}
          </div>
          {!busy && !visible.length && <p className="muted">没有匹配的分类</p>}
          {error && (
            <p className="database-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <button className="primary" disabled={busy} onClick={close}>
            <Check size={15} />
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
