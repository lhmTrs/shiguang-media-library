import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Play,
  Plus,
  RefreshCw,
  X,
  Music2,
} from "lucide-react";
import type { Asset } from "./main";
import { MusicAnalysisPanel } from "./MusicAnalysisPanel";

type Props = {
  request: <T = unknown>(
    url: string,
    body?: unknown,
    method?: string,
  ) => Promise<T>;
  preview: (a: Asset) => void;
  stopPreview: () => void;
  changed: () => void;
  close: () => void;
};
type TagItem = { id: string; name: string; n: number };
const suggestions = [
  "紧张",
  "悬疑",
  "悲伤",
  "温暖",
  "轻松",
  "热血",
  "搞笑",
  "反转",
  "抒情",
  "节奏感",
];

export function MusicTagQueue({
  request,
  preview,
  stopPreview,
  changed,
  close,
}: Props) {
  const [current, setCurrent] = useState<Asset | null>(null);
  const [tags, setTags] = useState<TagItem[]>([]);
  const [draft, setDraft] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [text, setText] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const [previousTags, setPreviousTags] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [skips, setSkips] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [autoplay, setAutoplay] = useState(false);
  const skipped = useRef(new Set<string>());
  const mounted = useRef(true);
  const currentRef = useRef<Asset | null>(null);
  const busyRef = useRef(true);
  const loadRef = useRef<() => Promise<void>>(async () => {});
  currentRef.current = current;
  busyRef.current = busy;
  const dirty =
    !!current &&
    (JSON.stringify(draft) !== JSON.stringify(current.tags) ||
      note !== current.note);

  async function loadNext() {
    stopPreview();
    setBusy(true);
    setError("");
    try {
      const list = await request<TagItem[]>("/tags");
      let next: Asset | undefined;
      let count = 0;
      for (let page = 1; ; page++) {
        const data = await request<{
          items: Asset[];
          total: number;
          pages: number;
        }>("/assets?kind=music&untagged=1&sort=recent&page=" + page);
        count = data.total;
        next = data.items.find((a) => !skipped.current.has(a.id));
        if (next || page >= data.pages) break;
      }
      if (!mounted.current) return;
      setTags(
        list.filter((t) => t.id !== "untagged").sort((a, b) => b.n - a.n),
      );
      setTotal(count);
      setCurrent(next || null);
      setDraft(next?.tags || []);
      setNote(next?.note || "");
      setText("");
      if (autoplay && next?.online && next.ext !== "ncm") preview(next);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "读取待标记音乐失败");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  loadRef.current = loadNext;
  useEffect(() => {
    mounted.current = true;
    void loadRef.current();
    const timer = setInterval(() => {
      if (!busyRef.current && !currentRef.current) void loadRef.current();
    }, 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      stopPreview();
    };
  }, []);

  function toggle(name: string) {
    setDraft((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  }
  function add() {
    const name = text.trim();
    if (!name) return;
    if (name === "未标记" || /[\x00-\x1f\x7f]/.test(name)) {
      setError("请输入有效标签名称");
      return;
    }
    if (draft.length >= 40 && !draft.includes(name)) {
      setError("每首最多 40 个标签");
      return;
    }
    setDraft((prev) => [...new Set([...prev, name])]);
    setText("");
  }
  async function save() {
    if (!current || !draft.length) return;
    setBusy(true);
    setError("");
    try {
      // Merge with the latest record so concurrent edits do not erase existing tags.
      const latest = await request<Asset>("/assets/" + current.id);
      if (
        note !== current.note &&
        latest.note !== current.note &&
        latest.note !== note
      )
        throw Error("备注已在其他页面修改，请刷新后再保存");
      if (latest.trashed) throw Error("此素材已移入废纸篓");
      await request(
        "/assets/" + current.id,
        {
          tags: [...new Set([...latest.tags, ...draft])],
          ...(note !== current.note ? { note } : {}),
        },
        "PATCH",
      );
      setDone((n) => n + 1);
      setPreviousTags(draft);
      changed();
      await loadNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，编辑内容已保留");
      setBusy(false);
    }
  }
  function skip() {
    if (
      !current ||
      (dirty && !window.confirm("跳过将放弃这首尚未保存的标签和备注，继续吗？"))
    )
      return;
    skipped.current.add(current.id);
    setSkips(skipped.current.size);
    void loadNext();
  }
  function leave() {
    if (!dirty || window.confirm("当前标签和备注尚未保存，确定返回吗？"))
      close();
  }
  const options = [...new Set([...tags.map((t) => t.name), ...suggestions])];
  const visibleOptions = options.filter((name) =>
    name.toLowerCase().includes(tagQuery.toLowerCase()),
  );
  return (
    <section className="music-tag-queue">
      <header className="library-heading">
        <div>
          <h1>连续标记音乐</h1>
          <p>
            未标记 {total.toLocaleString()} 首 · 本轮完成 {done} 首 · 已跳过{" "}
            {skips} 首
          </p>
        </div>
        <button disabled={busy} onClick={leave}>
          <X size={16} />
          返回标签管理
        </button>
      </header>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="queue-controls">
        <label>
          <input
            type="checkbox"
            checked={autoplay}
            onChange={(e) => setAutoplay(e.target.checked)}
          />
          下一首自动试听
        </label>
        <button disabled={busy || dirty} onClick={() => void loadNext()}>
          <RefreshCw size={16} />
          刷新队列
        </button>
        {!!skips && (
          <button
            disabled={busy || dirty}
            onClick={() => {
              skipped.current.clear();
              setSkips(0);
              void loadNext();
            }}
          >
            重新查看跳过项
          </button>
        )}
      </div>
      {current ? (
        <div
          className="queue-workspace"
          aria-label="音乐连续标记工作区"
          aria-busy={busy}
        >
          <div className="queue-track">
            <Music2 size={32} />
            <div>
              <h2>{current.name}</h2>
              <p title={current.path}>{current.path}</p>
              <span>
                {current.category || "未分类"} ·{" "}
                {current.duration == null
                  ? "时长未知"
                  : Math.round(current.duration) + " 秒"}
              </span>
            </div>
            <button
              className="primary"
              disabled={busy || !current.online || current.ext === "ncm"}
              onClick={() => preview(current)}
            >
              <Play size={18} />
              试听 / 暂停
            </button>
          </div>
          {(!current.online || current.ext === "ncm") && (
            <p className="muted">
              {!current.online
                ? "素材离线，仍可编辑标签"
                : "NCM 暂不支持试听，仍可编辑标签"}
            </p>
          )}
          <MusicAnalysisPanel
            key={current.id}
            asset={current}
            request={request}
            disabled={busy}
            adopt={(names, description) => {
              const merged = [...new Set([...draft, ...names])];
              if (merged.length > 40) {
                setError("采用后超过 40 个标签，请减少勾选");
                return false;
              }
              if (description && (note + "\n" + description).length > 4000) {
                setError("备注过长，请先精简备注");
                return false;
              }
              setDraft(merged);
              if (description && !note.includes(description))
                setNote(note ? note + "\n" + description : description);
              return true;
            }}
          />
          <h3>标签</h3>
          <div className="queue-tag-search">
            <input
              aria-label="查找连续标记标签"
              placeholder="查找标签"
              value={tagQuery}
              onChange={(e) => setTagQuery(e.target.value)}
            />
            {!!previousTags.length && (
              <button
                disabled={busy}
                onClick={() =>
                  setDraft((prev) =>
                    [...new Set([...prev, ...previousTags])].slice(0, 40),
                  )
                }
              >
                沿用上一首标签
              </button>
            )}
          </div>
          <div className="queue-tag-options">
            {visibleOptions.map((name) => (
              <label
                key={name}
                className={draft.includes(name) ? "selected" : ""}
              >
                <input
                  type="checkbox"
                  aria-label={"连续标记标签：" + name}
                  disabled={
                    busy || (draft.length >= 40 && !draft.includes(name))
                  }
                  checked={draft.includes(name)}
                  onChange={() => toggle(name)}
                />
                <span>{name}</span>
              </label>
            ))}
          </div>
          <form
            className="queue-new-tag"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              aria-label="连续标记新标签"
              placeholder="自定义标签"
              maxLength={60}
              value={text}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
            />
            <button disabled={busy || !text.trim()}>
              <Plus size={16} />
              添加
            </button>
          </form>
          <div className="queue-draft-tags">
            {draft
              .filter((t) => !visibleOptions.includes(t))
              .map((t) => (
                <button key={t} disabled={busy} onClick={() => toggle(t)}>
                  {t}
                  <X size={14} />
                </button>
              ))}
          </div>
          <label className="queue-note">
            备注
            <textarea
              aria-label="连续标记备注"
              placeholder="可留空"
              maxLength={4000}
              value={note}
              disabled={busy}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <footer className="queue-actions">
            <span>已选 {draft.length} 个标签</span>
            <button disabled={busy} onClick={skip}>
              <ChevronRight size={16} />
              暂时跳过
            </button>
            <button
              className="primary"
              disabled={busy || !draft.length}
              onClick={() => void save()}
            >
              <Check size={16} />
              保存并下一首
            </button>
          </footer>
        </div>
      ) : (
        <div className="queue-empty">
          <Music2 size={36} />
          <h2>
            {busy
              ? "读取音乐中…"
              : skips
                ? "本轮已处理完，其余音乐已跳过"
                : "暂无未标记音乐"}
          </h2>
        </div>
      )}
    </section>
  );
}
