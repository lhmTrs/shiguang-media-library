import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronLeft, ChevronRight, Folder, FolderPlus, HardDrive, LoaderCircle, RefreshCw, Search, X } from "lucide-react";

type Location = { root: string; directory: string };
type Branch = { path: string; state: string; writable: boolean; children: { name: string; directory: string }[] };
type Props = {
  roots: { id: string; name: string; path: string }[];
  rootId: string;
  directory: string;
  disabled: boolean;
  api: <T>(url: string, body?: unknown, method?: string) => Promise<T>;
  onChange: (root: string, directory: string) => void;
  onReady: (ready: boolean) => void;
  onCreated: () => void;
};

export function MoveDestinationPicker({ roots, rootId, directory, disabled, api, onChange, onReady, onCreated }: Props) {
  const [branch, setBranch] = useState<Branch | null>(null);
  const [loading, setLoading] = useState(true), [creating, setCreating] = useState(false);
  const [error, setError] = useState(""), [query, setQuery] = useState("");
  const [newName, setNewName] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const history = useRef<Location[]>([{ root: rootId, directory }]);
  const cursor = useRef(0), request = useRef(0);
  const readyCallback = useRef(onReady); readyCallback.current = onReady;
  const root = roots.find(r => r.id === rootId);
  const locked = disabled || creating;

  useEffect(() => {
    const generation = ++request.current;
    setLoading(true); setBranch(null); setError(""); readyCallback.current(false);
    api<Branch>("/folder-browser?" + new URLSearchParams({ root: rootId, directory }))
      .then(value => {
        if (generation !== request.current) return;
        setBranch(value); readyCallback.current(value.state === "online" && value.writable);
      })
      .catch(e => { if (generation === request.current) setError(e.message); })
      .finally(() => { if (generation === request.current) setLoading(false); });
    return () => { request.current++; };
  }, [api, rootId, directory, revision]);

  function navigate(next: Location, record = true) {
    if (locked) return;
    if (next.root === rootId && next.directory === directory) return;
    if (record) {
      history.current = history.current.slice(0, cursor.current + 1);
      history.current.push(next); cursor.current++;
    }
    readyCallback.current(false); setQuery(""); setNewName(null); setError("");
    onChange(next.root, next.directory);
  }
  async function createFolder() {
    if (locked || !newName?.trim()) return;
    setCreating(true); setError(""); readyCallback.current(false);
    try {
      const next = await api<Location>("/folder-browser", { root: rootId, directory, name: newName });
      // The directory already exists on disk even if the move is later cancelled.
      history.current = history.current.slice(0, cursor.current + 1);
      history.current.push(next); cursor.current++;
      setQuery(""); setNewName(null); onChange(next.root, next.directory); onCreated();
    } catch (e) {
      setError((e as Error).message); readyCallback.current(Boolean(branch?.state === "online" && branch.writable));
    } finally { setCreating(false); }
  }
  const segments = directory ? directory.split("/") : [];
  const children = branch?.children.filter(child => child.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) || [];
  return <div className="destination-picker" aria-label="选择移动目标文件夹" aria-busy={loading || creating}>
    <div className="destination-browser">
      <aside className="destination-roots" aria-label="已登记素材目录">
        <h4>素材位置</h4>
        {roots.map(item => <button type="button" key={item.id} disabled={locked} className={item.id === rootId ? "active" : ""}
          title={item.path} aria-pressed={item.id === rootId} onClick={() => navigate({ root: item.id, directory: "" })}>
          <HardDrive size={17} /><span>{item.name}</span>
        </button>)}
      </aside>
      <section className="destination-content">
        <div className="destination-toolbar">
          <button type="button" title="后退" aria-label="后退" disabled={locked || cursor.current === 0} onClick={() => navigate(history.current[--cursor.current], false)}><ChevronLeft size={18} /></button>
          <button type="button" title="前进" aria-label="前进" disabled={locked || cursor.current === history.current.length - 1} onClick={() => navigate(history.current[++cursor.current], false)}><ChevronRight size={18} /></button>
          <button type="button" title="上一级" aria-label="上一级" disabled={locked || !directory} onClick={() => navigate({ root: rootId, directory: segments.slice(0, -1).join("/") })}><ArrowUp size={18} /></button>
          <button type="button" title="刷新文件夹" aria-label="刷新文件夹" disabled={locked || loading} onClick={() => { readyCallback.current(false); setRevision(n => n + 1); }}><RefreshCw size={16} /></button>
          <button type="button" className="destination-create" disabled={locked || loading || !branch?.writable} onClick={() => setNewName("")}><FolderPlus size={17} />新建文件夹</button>
        </div>
        <nav className="destination-breadcrumbs" aria-label="目标文件夹路径">
          <button type="button" disabled={locked} onClick={() => navigate({ root: rootId, directory: "" })}>{root?.name || "选择目录"}</button>
          {segments.map((name, index) => <span key={index}><ChevronRight size={13} /><button type="button" disabled={locked}
            onClick={() => navigate({ root: rootId, directory: segments.slice(0, index + 1).join("/") })}>{name}</button></span>)}
        </nav>
        <label className="destination-search"><Search size={16} /><input aria-label="搜索当前文件夹" placeholder="搜索当前文件夹" value={query} disabled={locked} onChange={e => setQuery(e.target.value)} /></label>
        {newName !== null && <div className="destination-new-folder">
          <div><FolderPlus size={18} /><input autoFocus aria-label="新文件夹名称" placeholder="未命名文件夹" value={newName} disabled={locked}
            onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void createFolder(); } if (e.key === "Escape") { e.stopPropagation(); if (!locked) setNewName(null); } }} />
            <button type="button" aria-label="创建文件夹" title="创建文件夹" disabled={locked || !newName.trim()} onClick={() => void createFolder()}>{creating ? <LoaderCircle size={17} /> : <Check size={17} />}</button>
            <button type="button" aria-label="取消新建" title="取消新建" disabled={locked} onClick={() => setNewName(null)}><X size={17} /></button></div>
          <small>创建在当前目录中；取消移动不会删除已创建的文件夹。</small>
        </div>}
        {error && <p className="destination-error" role="alert">{error}</p>}
        <div className="destination-folders" aria-label="目标子文件夹">
          {loading ? <p className="destination-empty"><LoaderCircle size={18} />正在读取文件夹…</p>
            : branch?.state !== "online" ? <p className="destination-empty">{error ? "无法读取此位置" : "此位置不存在、已离线或无法访问，请选择其他目录。"}</p>
            : <>
              {!branch.writable && <p className="destination-error">此位置不可写，无法移动素材到这里。</p>}
              {children.map(child => <button type="button" key={child.directory} disabled={locked} onClick={() => navigate({ root: rootId, directory: child.directory })}>
                <Folder size={21} /><span>{child.name}</span><ChevronRight size={16} />
              </button>)}
              {!children.length && <p className="destination-empty">{query ? "没有匹配的文件夹" : "此位置没有子文件夹"}</p>}
            </>}
        </div>
      </section>
    </div>
    <div className="destination-selected"><Folder size={18} /><div><strong>移动到当前文件夹</strong><p>{branch?.path || root?.path || "尚未选择"}</p></div></div>
  </div>;
}
