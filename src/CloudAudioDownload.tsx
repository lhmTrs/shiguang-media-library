/**
 * T-LOCAL-014B：手动云端音频下载页面。
 *
 * 只在用户切到「云端音频」标签时挂载并读取列表；不做后台轮询 catalog。
 * 浏览器字段只用于选择根/来源/取消/重试；URL、hash、长度、路径、头都由本地后端
 * 从固定云端响应复制。任务进度在页面可见且存在活动任务时短暂轮询，关闭页面不影响任务。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  CloudOff,
  Download,
  FolderOpen,
  HardDrive,
  ListMusic,
  LoaderCircle,
  Music2,
  RefreshCw,
  X,
} from "lucide-react";
import { CloudAudioUpload } from "./CloudAudioUpload";
import type { LocalRequest } from "./OpenAISettings";

type AudioStatus = {
  enabled: boolean;
  configured: boolean;
  loggedIn: boolean;
  active: number;
  queued: number;
  maxActive: number;
  maxPending: number;
  interrupted: number;
  receiverFaulted: boolean;
  staleTempFiles: number;
};

type AudioRoot = { id: string; name: string; kind: string };
type CatalogItem = {
  id: string;
  sha256: string;
  bytes: number;
  contentType: string;
  createdAt: string;
  preferredShareId: string;
  ownerAccountId: string;
  fileName: string;
  mediaKind: "MUSIC" | "SFX";
  category: string;
  subcategory: string;
  visibleShareCount: number;
};
type AudioShare = {
  id: string;
  ownerAccountId: string;
  fileName: string;
  mediaKind: "MUSIC" | "SFX";
  category: string;
  subcategory: string;
  createdAt: string;
  version: number;
};
type AudioJob = {
  id: string;
  audioId: string;
  shareId: string;
  rootId: string;
  rootName: string;
  category: string;
  subcategory: string;
  fileName: string;
  bytes: number;
  sha256: string;
  mimeType: string;
  state: "queued" | "downloading" | "installing" | "completed" | "failed" | "cancelled" | "interrupted";
  errorCode: string;
  error: string;
  assetId: string;
  createdFile: boolean;
  cancelRequested: boolean;
  cleanupWarning: boolean;
  receivedBytes: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt: number;
};
type DetailState = {
  audioId: string;
  loading: boolean;
  loadingMore: boolean;
  error: string;
  shares: AudioShare[];
  hasMore: boolean;
  preferredShareId: string;
};

const JOB_LABELS: Record<string, string> = {
  queued: "排队中",
  downloading: "下载中",
  installing: "正在加入素材库",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断，需手动重试",
};

const STATE_TONE: Record<string, string> = {
  completed: "ok",
  failed: "danger",
  cancelled: "muted",
  interrupted: "warn",
  downloading: "busy",
  installing: "busy",
  queued: "muted",
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

function formatTime(value: number): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

function failureText(error: unknown): string {
  const value = error as { message?: string; status?: number; code?: string };
  if (value?.status === 401) return "登录状态已失效，请重新登录。";
  if (value?.status === 503) return String(value?.message || "云端音频下载暂不可用。");
  return String(value?.message || "操作未完成");
}

function jobActive(job: AudioJob): boolean {
  return ["queued", "downloading", "installing"].includes(job.state);
}

export function CloudAudioDownload({ request }: { request: LocalRequest }) {
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [roots, setRoots] = useState<AudioRoot[]>([]);
  const [rootId, setRootId] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [rootKind, setRootKind] = useState<"music" | "sfx" | "mixed">("mixed");
  const [addingRoot, setAddingRoot] = useState(false);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [groups, setGroups] = useState<{groupId:string;name:string;state:string;canReadShared:boolean}[]>([]);
  const [total, setTotal] = useState(0);
  const appliedSearch = useRef({q:"",groupId:""});
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [chosenShare, setChosenShare] = useState("");
  const [jobs, setJobs] = useState<AudioJob[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [myAccountId, setMyAccountId] = useState("");
  const [withdrawingShare, setWithdrawingShare] = useState("");
  const [error, setError] = useState("");
  const catalogSeq = useRef(0);
  const detailSeq = useRef(0);
  const completedSeen = useRef<Set<string>>(new Set());

  const refreshJobs = useCallback(async () => {
    const list = await request<AudioJob[]>("/cloud-audio/jobs");
    setJobs(list);
    return list;
  }, [request]);

  const loadCatalog = useCallback(
    async (nextOffset: number) => {
      const seq = (catalogSeq.current += 1);
      setCatalogLoading(true);
      setCatalogError("");
      try {
        const page = await request<{ items: CatalogItem[]; hasMore: boolean; total:number; limit: number; offset: number }>(
          `/cloud-audio/search?${new URLSearchParams({limit:"50",offset:String(nextOffset),q:appliedSearch.current.q,...(appliedSearch.current.groupId?{groupId:appliedSearch.current.groupId}:{})})}`,
        );
        if (seq !== catalogSeq.current) return;
        setItems(page.items);
        setHasMore(page.hasMore);
        setTotal(page.total);
        setOffset(page.offset);
      } catch (failure) {
        if (seq !== catalogSeq.current) return;
        setCatalogError(failureText(failure));
      } finally {
        if (seq === catalogSeq.current) setCatalogLoading(false);
      }
    },
    [request],
  );

  useEffect(() => {
    let alive = true;
    setStatusError("");
    void (async () => {
      try {
        const next = await request<AudioStatus>("/cloud-audio/status");
        if (!alive) return;
        setStatus(next);
        if (!next.enabled) return;
        if (!next.loggedIn) return;
        const [nextRoots, nextJobs] = await Promise.all([
          request<AudioRoot[]>("/cloud-audio/roots"),
          request<AudioJob[]>("/cloud-audio/jobs"),
        ]);
        if (!alive) return;
        setRoots(nextRoots);
        setRootId((current) => current || nextRoots[0]?.id || "");
        setJobs(nextJobs);
        const profile = await request<{me:{accountId:string};capabilities:{groups:{groupId:string;name:string;state:string;canReadShared:boolean}[]}}>("/cloud-management/profile");
        if (!alive) return;
        setMyAccountId(profile.me?.accountId || "");
        setGroups(profile.capabilities.groups.filter(g=>g.state==="ACTIVE"&&g.canReadShared));
        await loadCatalog(0);
      } catch (failure) {
        if (alive) setStatusError(failureText(failure));
      }
    })();
    return () => {
      alive = false;
      catalogSeq.current += 1;
      detailSeq.current += 1;
    };
  }, [loadCatalog, request]);

  // 只在这个页面可见且确有活动任务时轮询任务状态；完成后立刻停止。
  useEffect(() => {
    if (!status?.enabled) return;
    if (!jobs.some(jobActive)) return;
    const timer = setInterval(() => {
      void refreshJobs().catch(() => undefined);
    }, 700);
    return () => clearInterval(timer);
  }, [jobs, refreshJobs, status?.enabled]);

  useEffect(() => {
    for (const job of jobs) {
      if (job.state === "completed" && !completedSeen.current.has(job.id)) {
        completedSeen.current.add(job.id);
        setNotice(`已下载「${job.fileName}」并加入素材库`);
      }
    }
  }, [jobs]);

  // 撤回共享 = GROUP→PRIVATE、取消对外访问；不删文件、不放弃 owner 保留。
  // 云端 revoke 成功体为空，因此成功后重读详情，用真实状态刷新列表。
  const withdrawShare = useCallback(
    async (share: AudioShare) => {
      if (withdrawingShare || !detail || !detail.shares.some(item => item.id === share.id)) return;
      const seq = detailSeq.current;
      const audioId = detail.audioId;
      const current = () => seq === detailSeq.current;
      setWithdrawingShare(share.id);
      setNotice("");
      try {
        await request(`/cloud-audio/shares/${share.id}/withdraw`, { expectedVersion: share.version });
        if (!current()) return;
        const data = await request<{ audio: unknown; shares: AudioShare[]; hasMore: boolean }>(
          `/cloud-audio/audio/${audioId}?limit=50&offset=0`,
        );
        if (!current()) return;
        setDetail(value => current() && value?.audioId === audioId
          ? { ...value, shares: data.shares, hasMore: data.hasMore === true }
          : value);
        setChosenShare(value => current() ? (data.shares.some(item => item.id === value) ? value : data.shares[0]?.id || "") : value);
        setNotice(value => current() ? `已撤回「${share.fileName}」的对外共享：其他人不再可见；文件与你的云端保留未删除` : value);
        if (current()) void loadCatalog(0);
      } catch (failure) {
        if (current()) setNotice(value => current() ? failureText(failure) : value);
      } finally {
        if (current()) setWithdrawingShare(value => current() ? "" : value);
      }
    },
    [detail, loadCatalog, request, withdrawingShare],
  );

  const openDetails = useCallback(
    async (item: CatalogItem) => {
      const seq = (detailSeq.current += 1);
      setWithdrawingShare("");
      setChosenShare(item.preferredShareId);
      setDetail({ audioId: item.id, loading: true, loadingMore: false, error: "", shares: [], hasMore: false, preferredShareId: item.preferredShareId });
      try {
        const data = await request<{ audio: unknown; shares: AudioShare[]; hasMore: boolean }>(
          `/cloud-audio/audio/${item.id}?limit=50&offset=0`,
        );
        if (seq !== detailSeq.current) return;
        setDetail({
          audioId: item.id,
          loading: false,
          loadingMore: false,
          error: "",
          shares: data.shares,
          hasMore: data.hasMore === true,
          preferredShareId: item.preferredShareId,
        });
        const preferred = data.shares.find((share) => share.id === item.preferredShareId);
        setChosenShare(preferred?.id || data.shares[0]?.id || "");
      } catch (failure) {
        if (seq !== detailSeq.current) return;
        setDetail({ audioId: item.id, loading: false, loadingMore: false, error: failureText(failure), shares: [], hasMore: false, preferredShareId: item.preferredShareId });
      }
    },
    [request],
  );

  const loadMoreShares = useCallback(async () => {
    if (!detail || detail.loading || detail.loadingMore || !detail.hasMore) return;
    const seq = detailSeq.current;
    setDetail({ ...detail, loadingMore: true });
    try {
      const data = await request<{ shares: AudioShare[]; hasMore: boolean }>(
        `/cloud-audio/audio/${detail.audioId}?limit=50&offset=${detail.shares.length}`,
      );
      if (seq !== detailSeq.current) return;
      setDetail((current) => current && current.audioId === detail.audioId
        ? {
            ...current,
            loadingMore: false,
            shares: [...current.shares, ...data.shares.filter((share) => !current.shares.some((entry) => entry.id === share.id))],
            hasMore: data.hasMore === true,
          }
        : current);
    } catch (failure) {
      if (seq !== detailSeq.current) return;
      setDetail((current) => current ? { ...current, loadingMore: false, error: failureText(failure) } : current);
    }
  }, [detail, request]);

  const closeDetails = useCallback(() => {
    detailSeq.current += 1;
    setWithdrawingShare("");
    setDetail(null);
    setChosenShare("");
  }, []);

  const startDownload = useCallback(
    async (item: CatalogItem, shareId: string) => {
      if (!rootId) {
        setError("请先选择或添加一个本地下载目录");
        return;
      }
      setBusy(item.id);
      setError("");
      setNotice("");
      try {
        const job = await request<AudioJob>("/cloud-audio/jobs", {
          audioId: item.id,
          shareId,
          rootId,
        });
        setJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)]);
        setNotice(`已开始下载「${job.fileName}」`);
        closeDetails();
        void refreshJobs().catch(() => undefined);
      } catch (failure) {
        setError(failureText(failure));
      } finally {
        setBusy("");
      }
    },
    [closeDetails, refreshJobs, request, rootId],
  );

  const addRoot = useCallback(async () => {
    const value = pathInput.trim();
    if (!value) {
      setError("请填写下载目录的绝对路径");
      return;
    }
    setAddingRoot(true);
    setError("");
    try {
      const root = await request<AudioRoot>("/cloud-audio/roots", { path: value, kind: rootKind });
      const nextRoots = await request<AudioRoot[]>("/cloud-audio/roots");
      setRoots(nextRoots);
      setRootId(root.id);
      setPathInput("");
      setNotice(`已选择下载目录「${root.name}」`);
    } catch (failure) {
      setError(failureText(failure));
    } finally {
      setAddingRoot(false);
    }
  }, [pathInput, request, rootKind]);

  const cancelJob = useCallback(
    async (job: AudioJob) => {
      setBusy(`cancel-${job.id}`);
      setError("");
      try {
        const next = await request<AudioJob>(`/cloud-audio/jobs/${job.id}/cancel`, {});
        setJobs((current) => current.map((entry) => (entry.id === next.id ? next : entry)));
      } catch (failure) {
        setError(failureText(failure));
      } finally {
        setBusy("");
      }
    },
    [request],
  );

  const retryJob = useCallback(
    async (job: AudioJob) => {
      setBusy(`retry-${job.id}`);
      setError("");
      try {
        const next = await request<AudioJob>(`/cloud-audio/jobs/${job.id}/retry`, {});
        setJobs((current) => [next, ...current.filter((entry) => entry.id !== next.id)]);
        setNotice("已重新开始下载");
      } catch (failure) {
        setError(failureText(failure));
      } finally {
        setBusy("");
      }
    },
    [request],
  );

  const activeJobs = useMemo(() => jobs.filter(jobActive), [jobs]);
  const recentJobs = useMemo(() => jobs.slice(0, 20), [jobs]);

  if (!status && !statusError) {
    return (
      <section className="cw-panel cw-audio" aria-label="云端音频下载">
        <p className="cw-loading" role="status">
          <LoaderCircle size={16} className="spin" /> 正在读取云端音频…
        </p>
      </section>
    );
  }
  if (statusError) {
    return (
      <section className="cw-panel cw-audio" aria-label="云端音频下载">
        <div className="cw-audio-empty">
          <AlertTriangle size={28} />
          <h2>无法读取云端音频</h2>
          <p>{statusError}</p>
          <button type="button" className="plain" onClick={() => window.location.reload()}>
            重试
          </button>
        </div>
      </section>
    );
  }
  if (!status?.enabled) {
    return (
      <section className="cw-panel cw-audio" aria-label="云端音频下载">
        <div className="cw-audio-empty">
          <CloudOff size={30} />
          <h2>云端音频下载未启用</h2>
          <p>本机已关闭云端音频传输，请联系本机管理员启用后重启；当前不会发起音频传输请求。</p>
        </div>
      </section>
    );
  }
  if (!status.loggedIn) {
    return (
      <section className="cw-panel cw-audio" aria-label="云端音频下载">
        <div className="cw-audio-empty">
          <CloudOff size={30} />
          <h2>需要登录云端账户</h2>
          <p>登录后才能浏览你有权访问的音频，并下载到本机素材库。</p>
        </div>
      </section>
    );
  }

  return (
    <section className="cw-panel cw-audio" aria-label="云端音频下载">
      {(error || notice) && (
        <div className={"cw-audio-message " + (error ? "danger" : "ok")} role={error ? "alert" : "status"}>
          {error ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}
          <span>{error || notice}</span>
          <button type="button" className="cw-icon-button" aria-label="关闭提示" onClick={() => { setError(""); setNotice(""); }}>
            <X size={14} />
          </button>
        </div>
      )}

      <CloudAudioUpload request={request} />
      <form className="manual-audio-fields" onSubmit={event=>{event.preventDefault();appliedSearch.current={q:query,groupId:groupFilter};closeDetails();void loadCatalog(0);}}>
        <input aria-label="云端音频关键词" placeholder="名称或两级分类中的字面关键词" maxLength={128} value={query} onChange={event=>setQuery(event.target.value)} />
        <select aria-label="查找小组" value={groupFilter} onChange={event=>setGroupFilter(event.target.value)}><option value="">全部当前可见（含本人私有）</option>{groups.map(g=><option key={g.groupId} value={g.groupId}>{g.name}</option>)}</select>
        <button className="plain" disabled={catalogLoading}>查找云端音频</button><span role="status">匹配 {total} 个音频对象</span>
      </form>
      <div className="cw-audio-toolbar">
        <label className="cw-audio-root">
          <span>本地下载目录</span>
          <select value={rootId} onChange={(event) => setRootId(event.target.value)}>
            {roots.length === 0 && <option value="">尚未添加下载目录</option>}
            {roots.map((root) => (
              <option key={root.id} value={root.id}>
                {root.name}（{root.kind === "music" ? "音乐" : root.kind === "sfx" ? "音效" : "混合"}）
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="plain" onClick={() => void loadCatalog(0)} disabled={catalogLoading}>
          {catalogLoading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          刷新列表
        </button>
      </div>

      <div className="cw-audio-add-root">
        <FolderOpen size={15} />
        <select
          aria-label="下载目录类型"
          title="混合目录可同时接收音乐和音效；音乐/音效目录只接收对应类型"
          value={rootKind}
          onChange={(event) => setRootKind(event.target.value as "music" | "sfx" | "mixed")}
        >
          <option value="mixed">混合（音乐+音效）</option>
          <option value="music">音乐</option>
          <option value="sfx">音效</option>
        </select>
        <input
          aria-label="下载目录绝对路径"
          placeholder="或填写本机绝对路径，例如 /Users/你/Music/云端下载"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void addRoot();
          }}
        />
        <button type="button" className="plain" onClick={() => void addRoot()} disabled={addingRoot || !pathInput.trim()}>
          {addingRoot && <LoaderCircle size={14} className="spin" />}
          添加目录
        </button>
      </div>

      {catalogError && (
        <div className="cw-audio-empty compact">
          <AlertTriangle size={22} />
          <p>{catalogError}</p>
          <button type="button" className="plain" onClick={() => void loadCatalog(offset)}>
            重试
          </button>
        </div>
      )}

      {!catalogError && items.length === 0 && (
        <div className="cw-audio-empty compact">
          <ListMusic size={26} />
          <h2>{catalogLoading ? "正在读取云端音频…" : "云端还没有可下载的音频"}</h2>
          <p>只有你有权访问且仍可见的分享会显示在这里；列表按需加载，不会预先读取每条详情。</p>
        </div>
      )}

      {items.length > 0 && (
        <>
          <div className="cw-audio-list" role="list">
            <div className="cw-audio-list-head" aria-hidden="true">
              <span>文件名 / 类型</span>
              <span>分类</span>
              <span>大小</span>
              <span>可见来源</span>
              <span>操作</span>
            </div>
            {items.map((item) => (
              <div className="cw-audio-row" role="listitem" key={item.id}>
                <div className="cw-audio-name">
                  <Music2Icon kind={item.mediaKind} />
                  <div>
                    <strong title={item.fileName}>{item.fileName}</strong>
                    <small>{item.mediaKind === "MUSIC" ? "音乐" : "音效"} · {item.contentType}</small>
                  </div>
                </div>
                <div className="cw-audio-cats">
                  <span>{item.category || "未分类"}</span>
                  {item.subcategory && <small>{item.subcategory}</small>}
                </div>
                <div>{formatBytes(item.bytes)}</div>
                <div>{item.visibleShareCount} 条分享</div>
                <div className="cw-audio-actions">
                  <button type="button" className="plain" onClick={() => void openDetails(item)}>
                    <CircleHelp size={14} />
                    选择来源
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!rootId || busy === item.id}
                    onClick={() => void startDownload(item, item.preferredShareId)}
                  >
                    {busy === item.id ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}
                    下载
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="cw-audio-pager">
            <button type="button" className="plain" disabled={offset === 0 || catalogLoading} onClick={() => void loadCatalog(Math.max(0, offset - 50))}>
              <ChevronLeft size={15} /> 上一页
            </button>
            <span>当前第 {Math.floor(offset / 50) + 1} 页</span>
            <button type="button" className="plain" disabled={!hasMore || catalogLoading} onClick={() => void loadCatalog(offset + 50)}>
              下一页 <ChevronRight size={15} />
            </button>
          </div>
        </>
      )}

      <div className="cw-audio-jobs">
        <div className="cw-audio-section-head">
          <h3>
            <HardDrive size={16} /> 本机下载任务
          </h3>
          <span>{activeJobs.length > 0 ? `${activeJobs.length} 个进行中` : "关闭页面不会取消任务"}</span>
        </div>
        {recentJobs.length === 0 ? (
          <p className="cw-audio-muted">还没有下载任务。选择目录和来源后，任务会在本机后台运行。</p>
        ) : (
          <div className="cw-audio-job-list">
            {recentJobs.map((job) => {
              const percent = job.bytes > 0 ? Math.min(100, Math.round((job.receivedBytes / job.bytes) * 100)) : 0;
              const tone = STATE_TONE[job.state] || "muted";
              return (
                <div className={"cw-audio-job " + tone} key={job.id}>
                  <div className="cw-audio-job-main">
                    <div className="cw-audio-job-title">
                      <strong title={job.fileName}>{job.fileName}</strong>
                      <span className={"cw-audio-badge " + tone}>{JOB_LABELS[job.state] || job.state}</span>
                    </div>
                    <small>
                      {job.rootName || "本机目录"} · {formatBytes(job.receivedBytes)} / {formatBytes(job.bytes)}
                      {job.createdFile === false && job.state === "completed" ? " · 已复用同内容文件" : ""}
                      {job.completedAt ? ` · ${formatTime(job.completedAt)}` : ""}
                    </small>
                    {jobActive(job) && (
                      <div className="cw-audio-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                        <span style={{ width: `${percent}%` }} />
                      </div>
                    )}
                    {job.error && <p className="cw-audio-job-error">{job.error}{job.errorCode ? `（${job.errorCode}）` : ""}</p>}
                    {job.cleanupWarning && <p className="cw-audio-job-error">清理临时文件失败，请检查下载目录。</p>}
                  </div>
                  <div className="cw-audio-job-actions">
                    {jobActive(job) && (
                      <button
                        type="button"
                        className="plain"
                        disabled={busy === `cancel-${job.id}` || job.cancelRequested}
                        onClick={() => void cancelJob(job)}
                      >
                        <Ban size={14} /> {job.cancelRequested ? "取消中" : "取消"}
                      </button>
                    )}
                    {job.state === "completed" && job.assetId && (
                      <span className="cw-audio-done"><CheckCircle2 size={14} /> 已加入素材库</span>
                    )}
                    {["failed", "interrupted", "cancelled"].includes(job.state) && (
                      <button type="button" className="plain" disabled={busy === `retry-${job.id}`} onClick={() => void retryJob(job)}>
                        <RefreshCw size={14} /> 重试
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {detail && (
        <div className="cw-audio-dialog-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeDetails();
        }}>
          <div className="cw-audio-dialog" role="dialog" aria-modal="true" aria-label="选择云端来源">
            <div className="cw-audio-dialog-head">
              <h3>选择下载来源</h3>
              <button type="button" className="cw-icon-button" aria-label="关闭" onClick={closeDetails}>
                <X size={16} />
              </button>
            </div>
            {detail.loading ? (
              <p className="cw-loading" role="status"><LoaderCircle size={16} className="spin" /> 正在读取可见来源…</p>
            ) : detail.error ? (
              <div className="cw-audio-empty compact">
                <AlertTriangle size={22} />
                <p>{detail.error}</p>
                <button type="button" className="plain" onClick={closeDetails}>关闭</button>
              </div>
            ) : detail.shares.length === 0 ? (
              <div className="cw-audio-empty compact">
                <CloudOff size={22} />
                <p>该音频当前没有你可用的可见来源。</p>
              </div>
            ) : (
              <>
                <p className="cw-audio-dialog-hint">来源只影响本次复制；同名同内容的本地文件会被校验复用，不会覆盖既有文件。</p>
                <div className="cw-audio-source-list" role="radiogroup" aria-label="可见来源">
                  {detail.shares.map((share) => (
                    <div className="cw-audio-source-row" key={share.id}>
                      <label className={"cw-audio-source" + (chosenShare === share.id ? " selected" : "")}>
                        <input
                          type="radio"
                          name="cloud-audio-share"
                          checked={chosenShare === share.id}
                          onChange={() => setChosenShare(share.id)}
                        />
                        <div>
                          <strong title={share.fileName}>{share.fileName}</strong>
                          <small>
                            {share.category || "未分类"}{share.subcategory ? ` / ${share.subcategory}` : ""} ·{" "}
                            {share.mediaKind === "MUSIC" ? "音乐" : "音效"} · 发布于 {formatTime(Date.parse(share.createdAt))}
                            {share.ownerAccountId === myAccountId ? " · 你的来源" : ""}
                          </small>
                        </div>
                      </label>
                      {myAccountId && share.ownerAccountId === myAccountId && (
                        <button
                          type="button"
                          className="plain cw-audio-withdraw"
                          disabled={!!withdrawingShare}
                          title="撤回后其他人不再能看到这条来源；文件与你的云端保留不会删除"
                          onClick={() => void withdrawShare(share)}
                        >
                          {withdrawingShare === share.id ? "撤回中…" : "撤回共享"}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {detail.hasMore && (
                  <button type="button" className="plain cw-audio-more" disabled={detail.loadingMore} onClick={() => void loadMoreShares()}>
                    {detail.loadingMore ? <LoaderCircle size={14} className="spin" /> : <ChevronRight size={14} />}
                    加载更多来源
                  </button>
                )}
                <div className="cw-audio-dialog-actions">
                  <button type="button" className="plain" onClick={closeDetails}>取消</button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!chosenShare || !rootId || !!busy}
                    onClick={() => {
                      const item = items.find((entry) => entry.id === detail.audioId);
                      if (item) void startDownload(item, chosenShare);
                    }}
                  >
                    <Download size={15} /> 下载所选来源
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Music2Icon({ kind }: { kind: "MUSIC" | "SFX" }) {
  return kind === "MUSIC" ? <Music2 size={19} /> : <ListMusic size={19} />;
}
