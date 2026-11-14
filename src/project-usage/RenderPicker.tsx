// 选择成片：只列这一集的项目视频，默认打开「成片」文件夹；不能播放、编码未知、在废片收纳处、未托管或缺失的视频置灰并写原因。
// 「成片」文件夹只有用户点「准备」或实际收纳时才建（ensure）；打开窗口、取消都不建。写入结果不明时只核对原请求，不换编号重发。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, RefreshCw, Search, X } from "lucide-react";
import type { ProjectRequest } from "../ProjectManager";
import { bytesText, newRequestId, renderApi, settle, type FolderRoles, type Receipt, type RenderFolder, type RenderV2, type RequestError, type SourceItem, type SourcesPage } from "./render";

type Pending = { receipt: Receipt; label: string };
const durationText = (ms: number | null) => ms == null ? "时长未知" : `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function RenderPicker({ projectId, projectName, timelineId, render, request, close, linked }: {
  projectId: string; projectName: string; timelineId: string; render: RenderV2 | null; request: ProjectRequest; close: () => void; linked: () => void;
}) {
  const [data, setData] = useState<SourcesPage | null>(null), [folder, setFolder] = useState<string>(""), [q, setQ] = useState(""), [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string>(""), [offset, setOffset] = useState(String(render?.offset ?? 0));
  const [loading, setLoading] = useState(true), [listError, setListError] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(""), [pending, setPending] = useState<Pending | null>(null), [reload, setReload] = useState(0);
  const alive = useRef(true), dialog = useRef<HTMLDivElement>(null);
  useEffect(() => () => { alive.current = false; }, []);
  useEffect(() => { const timer = setTimeout(() => setSearch(q.trim()), 200); return () => clearTimeout(timer); }, [q]);
  useEffect(() => { dialog.current?.focus(); }, []);

  const roles: FolderRoles | undefined = data?.folderRoles;
  const finalFolder = data?.folders.find(f => f.role === "final") ?? null;
  // 默认先看「成片」：已建好就看它，还没建就显示「准备」说明；用户点别的文件夹后按所选
  const selected = folder || (data ? (finalFolder ? finalFolder.id : "virtual-final") : "pending");
  const folderId = selected === "virtual-final" || selected === "pending" ? "all" : selected;
  useEffect(() => {
    let live = true; setLoading(true); setListError("");
    renderApi.sources(request, projectId, timelineId, { q: search, folderId, pageSize: 50 })
      .then(page => { if (!live) return; setData(page); if (picked && !page.items.some(i => i.sourceId === picked && i.selectable)) setPicked(""); })
      .catch(e => { if (live) setListError((e as Error).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [request, projectId, timelineId, search, folderId, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = data?.items.find(i => i.sourceId === picked) ?? null;
  const offsetValue = Number(offset);
  const offsetValid = offset.trim() !== "" && Number.isFinite(offsetValue) && Math.abs(offsetValue) <= 86400;

  async function run<R>(label: string, start: () => Promise<Receipt<R>>, done: (r: Receipt<R>) => void) {
    setBusy(label); setError(""); setNotice("");
    try {
      const receipt = await settle(request, await start(), () => alive.current);
      if (!alive.current) return;
      if (receipt.status === "completed") { setPending(null); done(receipt); }
      else if (receipt.status === "failed") { setPending(null); setError(receipt.error?.message || "操作失败"); setReload(n => n + 1); }
      else setPending({ receipt: receipt as Receipt, label });
    } catch (e) {
      const err = e as RequestError;
      if (!alive.current) return;
      setError(err.message || "操作失败"); setReload(n => n + 1);
    } finally { if (alive.current) setBusy(""); }
  }
  async function recheck() {
    if (!pending) return;
    setBusy("正在核对原请求…"); setError("");
    try {
      const receipt = await renderApi.receipt(request, pending.receipt.statusUrl);
      if (!alive.current) return;
      if (receipt.status === "completed") { setPending(null); if (receipt.action === "render-link") linked(); else { setNotice("原请求已完成"); setReload(n => n + 1); } }
      else if (receipt.status === "failed") { setPending(null); setError(receipt.error?.message || "原请求没有成功"); setReload(n => n + 1); }
      else setPending({ ...pending, receipt });
    } catch (e) { if (alive.current) setError((e as RequestError).code === "OPERATION_NOT_FOUND" ? "还查不到原请求的回执；这不代表它没有执行，请稍后再核对。" : (e as Error).message); }
    finally { if (alive.current) setBusy(""); }
  }
  const confirm = () => {
    if (!item || !item.selectable || !offsetValid || !data) return;
    void run("正在关联成片…", () => renderApi.link(request, projectId, timelineId, {
      requestId: newRequestId(), sourceId: item.sourceId, offset: offsetValue,
      expectedRevision: render?.revision ?? 0, expectedSourceRevision: item.sourceRevision, expectedTimelineRevision: data.timelineRevision,
    }), () => linked());
  };
  const prepareFinal = () => {
    if (!roles) return;
    void run("正在准备「成片」文件夹…", () => renderApi.ensureFinal(request, projectId, { requestId: newRequestId(), expectedRolesRevision: roles.revision }), r => {
      const result = r.result as { outcome?: string; folder?: RenderFolder } | null;
      if (result?.outcome === "adopted") setNotice("已把你原有的「成片」文件夹设为保留文件夹");
      else if (result?.outcome === "created") setNotice("已建好「成片」文件夹");
      if (result?.folder) setFolder(result.folder.id);
      setReload(n => n + 1);
    });
  };
  const refreshInfo = (source: SourceItem) => {
    void run("正在刷新视频信息…", () => renderApi.refreshInfo(request, projectId, source.sourceId, { requestId: newRequestId(), expectedRevision: source.sourceRevision }), () => { setNotice(`已刷新「${source.name}」的视频信息`); setReload(n => n + 1); });
  };

  const folders: { id: string; name: string; role: RenderFolder["role"] | "virtual-final" }[] = [
    ...(finalFolder ? [{ id: finalFolder.id, name: finalFolder.name, role: "final" as const }] : [{ id: "virtual-final", name: "成片", role: "virtual-final" as const }]),
    { id: "all", name: "全部视频", role: null },
    ...(data?.folders.filter(f => f.role !== "final" && f.parentId === "root") ?? []).map(f => ({ id: f.id, name: f.name, role: f.role })),
  ];

  return createPortal(<div className="modal-backdrop usage-picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <div ref={dialog} tabIndex={-1} className="usage-picker" role="dialog" aria-modal="true" aria-label="选择这一集的成片" onKeyDown={e => { if (e.key === "Escape" && !busy) { e.stopPropagation(); close(); } }}>
      <header>
        <div><h2>选择这一集的成片</h2><p>只能从「{projectName}」的项目视频里选。成片收进项目后，你在访达里整理文件不会让关联断开。</p></div>
        <button type="button" className="icon-button" aria-label="关闭选择成片" disabled={!!busy} onClick={close}><X size={17} /></button>
      </header>
      <div className="usage-picker-body">
        <nav aria-label="项目视频文件夹">
          {folders.map(f => <button type="button" key={f.id} aria-pressed={selected === f.id} onClick={() => setFolder(f.id)} data-role={f.role ?? ""}>
            <FolderOpen size={15} aria-hidden="true" /><span>{f.name}</span>{f.role === "virtual-final" && <small>还没有</small>}{f.role === "reject" && <small>废片</small>}
          </button>)}
          <p>「成片」是每集自带的文件夹：第一次往里收纳成片或点「准备」时才建，不能删除或改名。</p>
        </nav>
        <div className="usage-picker-list">
          <label className="usage-picker-search"><Search size={14} aria-hidden="true" /><input type="search" aria-label="搜索项目视频" placeholder="搜索项目视频" value={q} onChange={e => setQ(e.target.value)} /></label>
          {notice && <p className="usage-notice" role="status">{notice}</p>}
          {error && <p className="banner error" role="alert">{error}</p>}
          {listError && <p className="banner error" role="alert">项目视频读取失败：{listError}</p>}
          {pending && <div className="usage-pending" role="status"><span>{pending.label.replace("正在", "").replace("…", "")}的结果还没核清；不会自动重试。</span><button type="button" className="plain" disabled={!!busy} onClick={() => void recheck()}><RefreshCw size={14} />核对原请求</button></div>}
          {selected === "virtual-final" ? <div className="usage-picker-empty">
            {roles?.finalState === "needs_review" ? <><strong>「成片」文件夹需要核对</strong><span>它在访达里被改名、挪走或删除了。拾光不会自动重建或接管别的文件夹，请到「生成视频」页核对。</span></>
              : <><strong>这一集还没有「成片」文件夹</strong><span>在访达里对导出的成片点右键 → 收纳到拾光，去处选「{projectName} / 成片」，收纳时会自动建好。也可以现在先准备好这个文件夹；如果你原来就有一个叫「成片」的文件夹，会直接接管它，里面的内容不动。</span>
                <button type="button" className="plain" disabled={!!busy || !roles} onClick={prepareFinal}>准备「成片」文件夹</button></>}
          </div> : loading ? <p className="usage-muted" role="status">正在读取项目视频…</p> : !data?.items.length ? <div className="usage-picker-empty"><strong>{search ? "没有匹配的项目视频" : "这里还没有视频"}</strong>{!search && <span>成片要先收进这一集的项目视频，才能在这里选。</span>}</div>
            : <div role="radiogroup" aria-label="项目视频">{data.items.map(v => {
              const on = v.sourceId === picked;
              const reason = v.disabledReasons[0]?.message;
              return <div className="usage-source" key={v.sourceId} data-disabled={!v.selectable} data-selected={on}>
                <label>
                  <input type="radio" name="usage-render-source" disabled={!v.selectable || !!busy} checked={on} onChange={() => setPicked(v.sourceId)} aria-label={`选择成片：${v.name}`} />
                  <span className="usage-source-thumb">{durationText(v.durationMs)}</span>
                  <span className="usage-source-info">
                    <strong title={v.name}>{v.name}</strong>
                    <small>{v.folder ? v.folder.relativePath : "未放在文件夹里"} · {v.width && v.height ? `${v.width}×${v.height} · ` : ""}{bytesText(v.bytes)}{v.codec ? ` · ${v.codec.toUpperCase()}` : ""}</small>
                    <em data-ok={v.selectable}>{v.selectable ? "能在浏览器播放" : reason || "不能选为成片"}{v.disabledReasons.length > 1 ? `（另有 ${v.disabledReasons.length - 1} 个原因）` : ""}</em>
                  </span>
                </label>
                {v.disabledReasons.some(r => r.code === "RENDER_INFO_REQUIRED") && <button type="button" className="plain" disabled={!!busy} onClick={() => refreshInfo(v)}><RefreshCw size={14} />刷新视频信息</button>}
              </div>;
            })}</div>}
        </div>
      </div>
      <footer>
        <label className="usage-offset">片头偏移（秒）<input inputMode="decimal" aria-label="成片片头偏移秒数" value={offset} disabled={!!busy} onChange={e => setOffset(e.target.value)} /></label>
        <span className="usage-offset-hint">{offsetValid ? "成片比时间线多出的片头秒数；完整导出填 0。" : "请填 -86400 到 86400 之间的秒数"}</span>
        <span className="usage-spacer" />
        {busy && <span role="status" className="usage-busy">{busy}</span>}
        <button type="button" className="plain" disabled={!!busy} onClick={close}>取消</button>
        <button type="button" className="primary" disabled={!!busy || !item?.selectable || !offsetValid || !!pending} onClick={confirm}>用这个作为成片</button>
      </footer>
    </div>
  </div>, document.body);
}
