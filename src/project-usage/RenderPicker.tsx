// 选择成片：只列这一集的项目视频，默认打开「成片」文件夹；不能播放、编码未知、在废片收纳处、未托管或缺失的视频置灰并写原因。
// 「成片」文件夹只有用户点「准备」或实际收纳时才建（ensure）；打开窗口、取消都不建。写入结果不明时只核对原请求，不换编号重发。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, RefreshCw, Search, X } from "lucide-react";
import type { ProjectRequest } from "../ProjectManager";
import { bytesText, checkOriginal, intentOf, renderApi, schemaErrorText, settle, unsettledReceipt, type FolderRoles, type Intent, type Receipt, type RenderFolder, type RenderV2, type RequestError, type SourceItem, type SourcesPage } from "./render";
import {serverIsMac, usePlatformWords} from '../platform-words';

/** 结果不明的写请求：原意图在提交前冻结，只按它核对；放在上层按时间线/操作分开保存，关掉窗口再打开、换到别的时间线都还在。 */
export type Pending = { intent: Intent; label: string; status: Receipt["status"]; message: string };
export const pendingOf = (intent: Intent, label: string, r: Receipt): Pending => ({ intent, label, status: r.status, message: r.error?.message ?? "" });
/** 这台浏览器实际播放失败的成片（同一来源、同一修订）：不能再确认为成片。 */
export type BlockedSource = { sourceId: string; sourceRevision: number | null; message: string };
const durationText = (ms: number | null) => ms == null ? "时长未知" : `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

export function RenderPicker({ projectId, projectName, timelineId, render, request, close, linked, pendings, putPending, begin, blocked, notWritable }: {
  projectId: string; projectName: string; timelineId: string; render: RenderV2 | null; request: ProjectRequest; close: () => void; linked: () => void;
  /** 与这条时间线、这一集相关的未决请求（别的时间线的不在这里，也不会被这里清掉）。 */
  pendings: Pending[]; putPending: (intent: Intent, p: Pending | null) => void; begin: (intent: Intent) => void; blocked: BlockedSource | null;
  /** 成片表现在不可写的原因（读接口 writable=false）；只禁「用这个作为成片」，准备文件夹、刷新视频信息照常。 */
  notWritable: string | null;
}) {
  const words = usePlatformWords();
  const linkPending = pendings.find(p => p.intent.timelineId === timelineId) ?? null;
  const ensurePending = pendings.find(p => p.intent.action === "final-folder-ensure") ?? null;
  const refreshPending = pendings.find(p => p.intent.action === "video-info-refresh") ?? null;
  const [data, setData] = useState<SourcesPage | null>(null), [folder, setFolder] = useState<string>(""), [q, setQ] = useState(""), [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string>(""), [offset, setOffset] = useState(String(render?.offset ?? 0));
  const [loading, setLoading] = useState(true), [listError, setListError] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(""), [reload, setReload] = useState(0);
  const alive = useRef(true), dialog = useRef<HTMLDivElement>(null);
  const isBlocked = (v: SourceItem) => !!blocked && v.sourceId === blocked.sourceId && (blocked.sourceRevision == null || v.sourceRevision === blocked.sourceRevision);
  const selectable = (v: SourceItem) => v.selectable && !isBlocked(v);
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
      .then(page => { if (!live) return; setData(page); if (picked && !page.items.some(i => i.sourceId === picked && selectable(i))) setPicked(""); })
      .catch(e => { if (live) setListError((e as Error).message); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [request, projectId, timelineId, search, folderId, reload]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = data?.items.find(i => i.sourceId === picked) ?? null;
  const offsetValue = Number(offset);
  const offsetValid = offset.trim() !== "" && Number.isFinite(offsetValue) && Math.abs(offsetValue) <= 86400;

  // 原意图（项目、时间线、编号、查询地址）在发出前冻结：没收到答复（断网、5xx、后端说未核清）时只按它核对，不换编号重发；
  // 明确的业务拒绝才放开重新提交。回执身份对不上原意图的，一律当结果不明。
  async function run<R>(label: string, intent: Intent, start: () => Promise<Receipt<R>>, done: (r: Receipt<R>) => void) {
    begin(intent); setBusy(label); setError(""); setNotice("");
    try {
      const receipt = await settle(request, intent, await start(), () => alive.current);
      if (receipt.status === "completed") { putPending(intent, null); if (alive.current) done(receipt); else if (intent.action === "render-link") linked(); }
      else if (receipt.status === "failed") { putPending(intent, null); if (alive.current) { setError(schemaErrorText(receipt.error) ?? (receipt.error?.message || "操作失败")); setReload(n => n + 1); } }
      else { putPending(intent, pendingOf(intent, label, receipt as Receipt)); if (alive.current && receipt.error?.code === "RECEIPT_MISMATCH") setError(receipt.error.message); }
    } catch (e) {
      const err = e as RequestError;
      const unknown = unsettledReceipt(err, intent);
      if (unknown) { putPending(intent, pendingOf(intent, label, unknown)); return; }
      putPending(intent, null); // 明确的业务拒绝：没有执行，注销
      if (!alive.current) return;
      setError(schemaErrorText(err) ?? (err.message || "操作失败")); setReload(n => n + 1);
    } finally { if (alive.current) setBusy(""); }
  }
  async function recheck(p: Pending) {
    setBusy("正在核对原请求…"); setError("");
    try {
      const receipt = await checkOriginal(request, p.intent);
      if (receipt.status === "completed") { putPending(p.intent, null); if (p.intent.action === "render-link" || p.intent.action === "render-unlink") linked(); else if (alive.current) { setNotice("原请求已完成"); setReload(n => n + 1); } }
      else if (receipt.status === "failed") { putPending(p.intent, null); if (alive.current) { setError(schemaErrorText(receipt.error) ?? (receipt.error?.message || "原请求没有成功")); setReload(n => n + 1); } }
      else { putPending(p.intent, pendingOf(p.intent, p.label, receipt)); if (alive.current && receipt.error) setError(receipt.error.message); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally { if (alive.current) setBusy(""); }
  }
  const confirm = () => {
    if (!item || !selectable(item) || !offsetValid || !data || linkPending || notWritable) return;
    const intent = intentOf("render-link", projectId, timelineId);
    void run("正在关联成片…", intent, () => renderApi.link(request, projectId, timelineId, {
      requestId: intent.requestId, sourceId: item.sourceId, offset: offsetValue,
      expectedRevision: render?.revision ?? 0, expectedSourceRevision: item.sourceRevision, expectedTimelineRevision: data.timelineRevision,
    }), () => linked());
  };
  const prepareFinal = () => {
    if (!roles || ensurePending) return;
    const intent = intentOf("final-folder-ensure", projectId, null);
    void run("正在准备「成片」文件夹…", intent, () => renderApi.ensureFinal(request, projectId, { requestId: intent.requestId, expectedRolesRevision: roles.revision }), r => {
      const result = r.result as { outcome?: string; folder?: RenderFolder } | null;
      if (result?.outcome === "adopted") setNotice("已把你原有的「成片」文件夹设为保留文件夹");
      else if (result?.outcome === "created") setNotice("已建好「成片」文件夹");
      if (result?.folder) setFolder(result.folder.id);
      setReload(n => n + 1);
    });
  };
  const refreshInfo = (source: SourceItem) => {
    if (refreshPending) return;
    const intent = intentOf("video-info-refresh", projectId, null);
    void run("正在刷新视频信息…", intent, () => renderApi.refreshInfo(request, projectId, source.sourceId, { requestId: intent.requestId, expectedRevision: source.sourceRevision }), () => { setNotice(`已刷新「${source.name}」的视频信息`); setReload(n => n + 1); });
  };

  const folders: { id: string; name: string; role: RenderFolder["role"] | "virtual-final" }[] = [
    ...(finalFolder ? [{ id: finalFolder.id, name: finalFolder.name, role: "final" as const }] : [{ id: "virtual-final", name: "成片", role: "virtual-final" as const }]),
    { id: "all", name: "全部视频", role: null },
    ...(data?.folders.filter(f => f.role !== "final" && f.parentId === "root") ?? []).map(f => ({ id: f.id, name: f.name, role: f.role })),
  ];

  return createPortal(<div className="modal-backdrop usage-picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) close(); }}>
    <div ref={dialog} tabIndex={-1} className="usage-picker" role="dialog" aria-modal="true" aria-label="选择这一集的成片" onKeyDown={e => { if (e.key === "Escape" && !busy) { e.stopPropagation(); close(); } }}>
      <header>
        <div><h2>选择这一集的成片</h2><p>只能从「{projectName}」的项目视频里选。成片收进项目后，你{words.editOutside}整理文件不会让关联断开。</p></div>
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
          {notWritable && <p className="usage-note" role="note">{notWritable}</p>}
          {notice && <p className="usage-notice" role="status">{notice}</p>}
          {error && <p className="banner error" role="alert">{error}</p>}
          {listError && <p className="banner error" role="alert">项目视频读取失败：{listError}</p>}
          {pendings.map(p => <div className="usage-pending" role="status" key={p.intent.requestId}><span>{p.label.replace("正在", "").replace("…", "")}的结果还没核清；不会自动重试。</span><button type="button" className="plain" disabled={!!busy} onClick={() => void recheck(p)}><RefreshCw size={14} />核对原请求</button></div>)}
          {selected === "virtual-final" ? <div className="usage-picker-empty">
            {roles?.finalState === "needs_review" ? <><strong>「成片」文件夹需要核对</strong><span>它{words.editOutside}被改名、挪走或删除了。拾光不会自动重建或接管别的文件夹，请到「生成视频」页核对。</span></>
              : <><strong>这一集还没有「成片」文件夹</strong><span>{serverIsMac() ? <>在访达里对导出的成片点右键 → 收纳到拾光，去处选「{projectName} / 成片」，收纳时会自动建好。也可以现在先准备好这个文件夹；</> : '可以现在先准备好这个文件夹；'}如果你原来就有一个叫「成片」的文件夹，会直接接管它，里面的内容不动。</span>
                <button type="button" className="plain" disabled={!!busy || !roles || !!ensurePending} onClick={prepareFinal}>准备「成片」文件夹</button></>}
          </div> : loading ? <p className="usage-muted" role="status">正在读取项目视频…</p> : !data?.items.length ? <div className="usage-picker-empty"><strong>{search ? "没有匹配的项目视频" : "这里还没有视频"}</strong>{!search && <span>成片要先收进这一集的项目视频，才能在这里选。</span>}</div>
            : <div role="radiogroup" aria-label="项目视频">{data.items.map(v => {
              const on = v.sourceId === picked, ok = selectable(v);
              const reason = isBlocked(v) ? blocked!.message : v.disabledReasons[0]?.message;
              return <div className="usage-source" key={v.sourceId} data-disabled={!ok} data-selected={on}>
                <label>
                  <input type="radio" name="usage-render-source" disabled={!ok || !!busy} checked={on} onChange={() => setPicked(v.sourceId)} aria-label={`选择成片：${v.name}`} />
                  <span className="usage-source-thumb">{durationText(v.durationMs)}</span>
                  <span className="usage-source-info">
                    <strong title={v.name}>{v.name}</strong>
                    <small>{v.folder ? v.folder.relativePath : "未放在文件夹里"} · {v.width && v.height ? `${v.width}×${v.height} · ` : ""}{bytesText(v.bytes)}{v.codec ? ` · ${v.codec.toUpperCase()}` : ""}</small>
                    <em data-ok={ok}>{ok ? "能在浏览器播放" : reason || "不能选为成片"}{v.disabledReasons.length > 1 ? `（另有 ${v.disabledReasons.length - 1} 个原因）` : ""}</em>
                  </span>
                </label>
                {v.disabledReasons.some(r => r.code === "RENDER_INFO_REQUIRED") && <button type="button" className="plain" disabled={!!busy || !!refreshPending} onClick={() => refreshInfo(v)}><RefreshCw size={14} />刷新视频信息</button>}
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
        <button type="button" className="primary" disabled={!!busy || !item || !selectable(item) || !offsetValid || !!linkPending || !!notWritable} title={notWritable ?? undefined} onClick={confirm}>用这个作为成片</button>
      </footer>
    </div>
  </div>, document.body);
}
