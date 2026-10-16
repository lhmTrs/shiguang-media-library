import { useEffect, useState } from "react";
import { Tag, Search, X, Check, Plus } from "lucide-react";
import type { Asset } from "./main";
type Item = { id: string; name: string; n: number };
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
export function QuickTagDialog({ asset, request, close, changed }: Props) {
  const [tags, setTags] = useState<Item[]>([]),
    [members, setMembers] = useState<string[]>([]),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  async function refresh() {
    const [list, a] = await Promise.all([
      request<Item[]>("/tags"),
      request<Asset>("/assets/" + asset.id),
    ]);
    setTags(list.filter((t) => t.id !== "untagged"));
    setMembers(a.tags);
  }
  useEffect(() => {
    let live = true;
    Promise.all([
      request<Item[]>("/tags"),
      request<Asset>("/assets/" + asset.id),
    ])
      .then(([list, a]) => {
        if (live) {
          setTags(list.filter((t) => t.id !== "untagged"));
          setMembers(a.tags);
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
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) close();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [busy, close]);
  async function apply(tag: Item) {
    const previous = members;
    const removing = previous.includes(tag.name);
    setMembers(
      removing
        ? previous.filter((name) => name !== tag.name)
        : [...previous, tag.name],
    );
    setBusy(true);
    setError("");
    try {
      await request("/tags/apply", {
        ids: [asset.id],
        tagId: tag.id,
        action: removing ? "remove" : "add",
      });
      await refresh();
      changed();
    } catch (e) {
      setMembers(previous);
      setError(e instanceof Error ? e.message : "标签更新失败");
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const t = await request<Item>("/tags", { name: query.trim() });
      await request("/tags/apply", {
        ids: [asset.id],
        tagId: t.id,
        action: "add",
      });
      setQuery("");
      await refresh();
      changed();
    } catch (e) {
      setError(e instanceof Error ? e.message : "标签创建失败");
    } finally {
      setBusy(false);
    }
  }
  const visible = tags.filter((t) =>
    t.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="modal-backdrop">
      <div
        className="modal category-editor"
        role="dialog"
        aria-modal="true"
        aria-label="管理单个素材标签"
      >
        <div className="modal-head">
          <h2>素材标签</h2>
          <button
            className="icon-button"
            aria-label="关闭快捷标签"
            disabled={busy}
            onClick={close}
          >
            <X size={17} />
          </button>
        </div>
        <div className="modal-body">
          <p className="quick-song-title">{asset.name}</p>
          <label className="search">
            <Search size={16} />
            <input
              autoFocus
              aria-label="搜索或新建素材标签"
              placeholder="搜索或新建标签"
              maxLength={60}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="quick-category-list">
            {visible.map((t) => (
              <label
                key={t.id}
                className={
                  "quick-tag-option " +
                  (members.includes(t.name) ? "included" : "")
                }
              >
                <input
                  type="checkbox"
                  aria-label={"素材标签：" + t.name}
                  disabled={busy}
                  checked={members.includes(t.name)}
                  onChange={() => void apply(t)}
                />
                <Tag size={15} />
                <span>{t.name}</span>
                <small>{t.n}</small>
              </label>
            ))}
          </div>
          {!busy && !visible.length && (
            <p className="muted">{query ? "没有匹配的标签" : "暂无标签"}</p>
          )}
          {query.trim() && !tags.some((t) => t.name === query.trim()) && (
            <button
              className="tag-create-inline"
              disabled={busy}
              onClick={() => void create()}
            >
              <Plus size={16} />
              新建并添加“{query.trim()}”
            </button>
          )}
          {error && (
            <p className="database-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="modal-footer">
          <span className="muted">已选 {members.length} 个标签</span>
          <button className="primary" disabled={busy} onClick={close}>
            <Check size={15} />
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
