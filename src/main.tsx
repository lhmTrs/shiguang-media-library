import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { KeywordSearch, KeywordTokens, type SearchMode } from "./KeywordSearch";
import {
  Aperture,
  Library,
  Pencil,
  RotateCcw,
  Power,
  Image,
  Film,
  AudioLines,
  Music2,
  Star,
  CircleHelp,
  HardDrive,
  Search,
  FolderPlus,
  FolderKanban,
  FolderOpen,
  RefreshCw,
  List,
  Grid2X2,
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  X,
  Download,
  FilePenLine,
  FolderInput,
  Trash2,
  Tag,
  Check,
  History,
  Undo2,
  Settings,
  Copy,
  ExternalLink,
  Volume2,
  CircleAlert,
  LoaderCircle,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  PanelRightClose,
  SlidersHorizontal,
  MoreHorizontal,
  Database,
  ListPlus,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import "./style.css";
import "./themes.css";
import { applyTheme, readTheme } from "./theme";
import type { ThemeId } from "./theme-list";
import { AuditionControls } from "./AuditionControls";
import { TagRuleFilter, emptyTagRules, type TagRules } from "./TagRuleFilter";
import { clearTagFacetCache, loadTagFacets } from "./tag-facet-cache";
import { DuplicateAudioManager } from "./DuplicateAudioManager";
import { QuickCategoryDialog } from "./QuickCategoryDialog";
import { TagManager } from "./TagManager";
import { OpenAISettings } from "./OpenAISettings";
import { CloudConnectionSettings } from "./CloudConnectionSettings";
import { AccountEntry, CloudLoginPage } from "./CloudAccount";
import { CloudWorkspace } from "./CloudWorkspace";
import { useCloudAuth } from "./cloud-auth";
import { MusicAnalysisPanel } from "./MusicAnalysisPanel";
import { AssetEditDialog } from "./AssetEditDialog";
import { CategoryFilter } from "./CategoryFilter";
import { CategoryPairFields } from "./CategoryPairFields";
import { AssetCategoryDialog } from "./AssetCategoryDialog";
import { AssetActions } from "./AssetActions";
import { QuickTagDialog } from "./QuickTagDialog";
import { MissingCleanupDialog, type CleanupResult } from "./MissingCleanupDialog";
import { ProjectManager, ProjectHistory, type Project } from "./ProjectManager";
import { NavigationSettings } from "./NavigationSettings";
import { ToolbarPopover } from "./ToolbarPopover";
import { FolderBrowser } from "./FolderBrowser";
import { MoveDestinationPicker } from "./MoveDestinationPicker";
import { readRefreshSeconds, REFRESH_STORAGE_KEY } from "./refresh-preferences";
import { displayDirectoryOptions, type DirectoryOption } from "./directory-labels";
import { MetadataBatchHistory } from "./MetadataBatchHistory";
import { SeriesAssetList, type AssetSeries } from "./SeriesAssetList";
import { PaginationControls } from "./PaginationControls";

export type Asset = {
  id: string;
  name: string;
  path: string;
  root_id: string;
  ext: string;
  kind: string;
  size: number;
  mtime: number;
  created_ms: number | null;
  captured_ms: number | null;
  capture_source: string;
  capture_status: string;
  capture_error: string;
  category: string;
  sub: string;
  basis: string;
  review: number;
  confirmed: number;
  tags: string[];
  note: string;
  favorite: number;
  reveal_count: number;
  file_status: string;
  file_checked_ms: number;
  file_check_reason: string;
  online: number;
  trashed: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  probe: string;
  error: string;
};
type MysqlState = {
  config: {
    host: string;
    port: number;
    database: string;
    user: string;
    hasPassword: boolean;
  };
  status: string;
  lastSync: string | null;
  counts: { roots: number; assets: number; operations: number } | null;
  error: string;
  mode: "mysql" | "sqlite";
};
type Root = {
  id: string;
  name: string;
  path: string;
  kind: string;
  online: number;
  /** 仅注销：不再扫描/监听/参与导航，但记录与素材属性都保留、可恢复 */
  retired?: number;
  revision?: number;
  reconciled_ms?: number | null;
  managed_added_ms?: number | null;
  management_order?: number;
};
type RelocateResult = {
  needsConfirm?: boolean;
  warnings?: string[];
  matchRatio?: number;
  matched?: number;
  total?: number;
  newPath?: string;
  ok?: boolean;
  rolledBack?: boolean;
  report?: { moved: number; renamed: number; adopted: number; added: number; missing: number; conflicts: number };
};
type Stats = {
  total: number;
  kinds: { kind: string; n: number }[];
  favorites: number;
  review: number;
  offline: number;
  missing: number;
  categories: DirectoryOption[];
  formats: string[];
};
type Job = {
  type?: string;
  id: string;
  rootId: string;
  status: string;
  label: string;
  count: number;
  errors: string[];
};
type Operation = {
  id: string;
  asset_id: string;
  action: string;
  source: string;
  target: string;
  status: string;
  error: string;
  created_at: string;
  undone: number;
};
type Plan = {
  id: string;
  name?: string;
  source?: string;
  target?: string;
  ok: boolean;
  error?: string;
  warning?: string;
  duplicateTagsRemoved?: number;
};
type Modal =
  | "folders"
  | "history"
  | "settings"
  | "rename"
  | "move"
  | "trash"
  | "tags"
  | "zoom"
  | null;
let token = "";
async function api<T = unknown>(
  url: string,
  body?: unknown,
  method?: string,
): Promise<T> {
  const verb = method || (body ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  // 非 GET 一律带本机会话令牌，包括没有请求体的 DELETE。
  if (verb.toUpperCase() !== "GET") headers["X-Local-Token"] = token;
  const r = await fetch("/api" + url, {
    method: verb,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await r.json();
  if (!r.ok)
    throw Object.assign(Error(result.error || "请求失败"), {
      diagnostic: result.diagnostic,
      // 云端认证只回固定公开码；保留状态码与冷却时间用于区分 401/429/证书/离线。
      code: result.code,
      kind: result.kind,
      status: r.status,
      retryAfterMs: result.retryAfterMs,
      requestId: result.requestId,
    });
  if ((method || (body ? "POST" : "GET")).toUpperCase() !== "GET") clearTagFacetCache();
  return result;
}
const kindNames: Record<string, string> = {
  photo: "摄影照片",
  video: "视频素材",
  sfx: "音效",
  music: "音乐",
  mixed: "混合素材",
};
const kindIcons: Record<string, LucideIcon> = {
  photo: Image,
  video: Film,
  sfx: AudioLines,
  music: Music2,
};
const bytes = (n: number) =>
  n >= 1e9
    ? (n / 1e9).toFixed(2) + " GB"
    : n >= 1e6
      ? (n / 1e6).toFixed(1) + " MB"
      : (n / 1000).toFixed(1) + " KB";
const time = (n: number | null) =>
  n === null
    ? "—"
    : `${Math.floor(n / 60)
        .toString()
        .padStart(2, "0")}:${Math.floor(n % 60)
        .toString()
        .padStart(2, "0")}`;
const audioAsset = (a: Asset) =>
  ["sfx", "music"].includes(a.kind) &&
  !["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm"].includes(a.ext);
function IconButton({
  icon: Icon,
  title,
  onClick,
  active = false,
  disabled = false,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={"icon-button " + (active ? "active" : "")}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={18} />
    </button>
  );
}
function Thumbnail({
  asset,
  large = false,
}: {
  asset: Asset;
  large?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id, asset.mtime]);
  const Icon = kindIcons[asset.kind] || Film;
  const source =
    asset.kind === "photo" &&
    ["jpg", "jpeg", "png", "webp", "gif"].includes(asset.ext)
      ? "original"
      : "thumb";
  return (
    <div className={"thumbnail " + (large ? "large" : "")}>
      {!asset.online ? (
        <>
          <HardDrive size={30} />
          <span>素材离线</span>
        </>
      ) : failed ? (
        <>
          <Icon size={30} />
          <span>预览不可用</span>
        </>
      ) : (
        <img
          loading="lazy"
          src={`/api/media/${asset.id}/${source}`}
          alt={asset.name}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
function Wave({ asset }: { asset: Asset }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [asset.id]);
  return (
    <div className="wave">
      {!failed && asset.online ? (
        <img
          src={`/api/media/${asset.id}/wave`}
          alt="音频波形"
          onError={() => setFailed(true)}
        />
      ) : (
        <span>波形暂不可用</span>
      )}
    </div>
  );
}
function App() {
  const cloudAuth = useCloudAuth(api);
  const cloudAuthRef = useRef(cloudAuth);
  cloudAuthRef.current = cloudAuth;
  const [loginOpen, setLoginOpen] = useState(() => location.hash === "#/login");
  const [workspaceOpen, setWorkspaceOpen] = useState(() => location.hash === "#/account");
  const loginClosing = useRef(false);
  useEffect(() => {
    const sync = () => {
      const next = location.hash === "#/login";
      setLoginOpen(next);
      setWorkspaceOpen(location.hash === "#/account");
      if (!next) loginClosing.current = false;
    };
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const closeLogin = useCallback(() => {
    if (loginClosing.current) return;
    loginClosing.current = true;
    cloudAuthRef.current.invalidate();
    if (history.state?.shiguangLogin) {
      history.back();
    } else if (location.hash === "#/login") {
      history.replaceState(null, "", location.pathname + location.search);
    }
    setLoginOpen(false);
  }, []);
  const openLogin = useCallback(() => {
    loginClosing.current = false;
    cloudAuthRef.current.invalidate();
    setModal(null);
    setMobileNav(false);
    setWorkspaceOpen(false);
    if (location.hash !== "#/login") {
      history.pushState({ shiguangLogin: true }, "", "#/login");
    }
    // 可能刚从高级设置保存过配置；进入登录页前校准共享状态。
    void cloudAuthRef.current.readStatus().catch(() => undefined);
    setLoginOpen(true);
  }, []);
  const closeWorkspace = useCallback(() => {
    cloudAuthRef.current.invalidate();
    if (history.state?.shiguangWorkspace) {
      history.back();
    } else if (location.hash === "#/account") {
      history.replaceState(null, "", location.pathname + location.search);
    }
    setWorkspaceOpen(false);
  }, []);
  const openWorkspace = useCallback(() => {
    setModal(null);
    setMobileNav(false);
    if (location.hash !== "#/account") {
      history.pushState({ shiguangWorkspace: true }, "", "#/account");
    }
    setWorkspaceOpen(true);
  }, []);
  const [ready, setReady] = useState(false),
    [stats, setStats] = useState<Stats>({
      total: 0,
      kinds: [],
      favorites: 0,
      review: 0,
      offline: 0,
      missing: 0,
      categories: [],
      formats: [],
    });
  // 「素材目录管理」专用的全量列表（含已注销）；侧栏导航与筛选仍用 roots（只在管的）
  const [allRoots, setAllRoots] = useState<Root[]>([]);
  const [rootEdit, setRootEdit] = useState<{ id: string; name: string; kind: string; path: string } | null>(null);
  const loadAllRoots = useCallback(async () => {
    setAllRoots(await api<Root[]>("/roots/all"));
  }, []);
  const [roots, setRoots] = useState<Root[]>([]),
    [assets, setAssets] = useState<Asset[]>([]),
    [filterCategories, setFilterCategories] = useState<Stats["categories"]>([]),
    [filterTags, setFilterTags] = useState<{ id: string; name: string; n: number }[]>([]),
    [allCategories, setAllCategories] = useState<(DirectoryOption & { id: string; name: string })[]>([]),
    [total, setTotal] = useState(0),
    [pages, setPages] = useState(0);
  const [view, setView] = useState("all"),
    [q, setQ] = useState(""),
    [search, setSearch] = useState(""),
    [searchMode, setSearchMode] = useState<SearchMode>("all"),
    [nameOnly, setNameOnly] = useState(false),
    [rootFilter, setRootFilter] = useState<string[]>([]),
    [category, setCategory] = useState(""),
    [ext, setExt] = useState(""),
    [duration, setDuration] = useState(""),
    [createdFrom, setCreatedFrom] = useState(""),
    [createdTo, setCreatedTo] = useState(""),
    [dateField, setDateField] = useState<"created" | "captured">("created"),
    [captureUnknown, setCaptureUnknown] = useState(false),
    [sort, setSort] = useState(() => { try { const saved = localStorage.getItem("shiguang.assetSort"); return saved && ["name", "revealCount", "projectCount", "recent", "createdNewest", "createdOldest", "capturedNewest", "capturedOldest", "size"].includes(saved) ? saved : "revealCount"; } catch { return "revealCount"; } }),
    [onlyFavorites, setOnlyFavorites] = useState(false),
    [page, setPage] = useState(1),
    [layout, setLayout] = useState<"list" | "grid">("list");
  const [selected, setSelected] = useState<Asset | null>(null),
    [checked, setChecked] = useState<Set<string>>(new Set()),
    [busy, setBusy] = useState(false),
    // 全局"正在处理"指示：run() 会往里压标签，遮罩层据此显示（栈式，嵌套调用也正确）
    [workLabels, setWorkLabels] = useState<string[]>([]),
    [showWork, setShowWork] = useState(false),
    // 素材列表正在重新读取：只做内联提示，不遮挡已显示的内容
    [refreshing, setRefreshing] = useState(false),
    [loading, setLoading] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [tagRules, setTagRules] = useState<TagRules>(emptyTagRules);
  const [detailsHidden, setDetailsHidden] = useState(() => { try { return localStorage.getItem("shiguang.detailsHidden") === "true"; } catch { return false; } });
  const [detailsWidth, setDetailsWidth] = useState(() => { try { const n = Number(localStorage.getItem("shiguang.detailsWidth")); return Number.isFinite(n) && n >= 280 ? Math.min(n, 600) : 340; } catch { return 340; } });
  const [playerHeight, setPlayerHeight] = useState(0);
  const [topbarHeight, setTopbarHeight] = useState(72);
  const playerRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  useEffect(() => { try { localStorage.setItem("shiguang.detailsHidden", String(detailsHidden)); localStorage.setItem("shiguang.detailsWidth", String(detailsWidth)); } catch {} }, [detailsHidden, detailsWidth]);
  const [advancedFilters, setAdvancedFilters] = useState(false);
  const folderView = true;
  const filterMemory = useRef(new Map<string, {
    q: string; searchMode: SearchMode; nameOnly: boolean; rootFilter: string[]; category: string; tagRules: TagRules; ext: string;
    duration: string; createdFrom: string; createdTo: string; dateField: "created" | "captured";
    captureUnknown: boolean; onlyFavorites: boolean;
  }>());
  const [navCollapsed, setNavCollapsed] = useState(() => { try { return localStorage.getItem("shiguang.navCollapsed") === "true"; } catch { return false; } });
  const [hiddenNav, setHiddenNav] = useState<string[]>(() => { try { const value = JSON.parse(localStorage.getItem("shiguang.hiddenNav") || "[]"); return Array.isArray(value) ? value.filter((v: unknown): v is string => typeof v === "string" && v !== "all") : []; } catch { return []; } });
  const [navSettings, setNavSettings] = useState(false);
  const closeNavSettings = useCallback(() => setNavSettings(false), []);
  const [refreshSeconds, setRefreshSeconds] = useState(readRefreshSeconds);
  useEffect(() => { try { localStorage.setItem(REFRESH_STORAGE_KEY, String(refreshSeconds)); } catch {} }, [refreshSeconds]);
  // 界面风格：值由 localStorage 驱动、写在 <html data-theme> 上，切换只影响 CSS 变量。
  const [theme, setTheme] = useState<ThemeId>(() => readTheme());
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { try { localStorage.setItem("shiguang.navCollapsed", String(navCollapsed)); } catch {} }, [navCollapsed]);
  useEffect(() => { try { localStorage.setItem("shiguang.hiddenNav", JSON.stringify(hiddenNav)); } catch {} }, [hiddenNav]);
  const [compactActions, setCompactActions] = useState(() => { try { return localStorage.getItem("shiguang.assetActions") !== "full"; } catch { return true; } });
  const [projects, setProjects] = useState<Project[]>([]), [projectRevision, setProjectRevision] = useState(0);
  const [activeProject, setActiveProject] = useState(() => { try { return localStorage.getItem("shiguang.activeProject") || ""; } catch { return ""; } });
  const [projectMembers, setProjectMembers] = useState<{ asset_id: string; status: string }[]>([]);
  const [projectUsageCounts,setProjectUsageCounts] = useState<Record<string,number>>({});
  useEffect(()=>{let live=true;if(ready)void api<{asset_id:string;n:number}[]>("/projects/usage-counts").then(rows=>{if(live)setProjectUsageCounts(Object.fromEntries(rows.map(row=>[row.asset_id,Number(row.n)])));}).catch(()=>{});return()=>{live=false;};},[ready,projectRevision]);
  useEffect(() => { try { localStorage.setItem("shiguang.activeProject", activeProject); } catch {} }, [activeProject]);
  useEffect(() => {
    if (!ready) return;
    let live = true;
    api<Project[]>("/projects").then(rows => { if (live) { setProjects(rows); setActiveProject(id => rows.some(p => p.id === id) ? id : rows[0]?.id || ""); } }).catch(e => { if (live) fail(e); });
    return () => { live = false; };
  }, [ready, projectRevision]);
  useEffect(() => {
    let live = true; setProjectMembers([]);
    if (ready && activeProject) api<typeof projectMembers>(`/projects/${activeProject}/members`).then(rows => { if (live) setProjectMembers(rows); }).catch(e => { if (live) fail(e); });
    return () => { live = false; };
  }, [ready, activeProject, projectRevision]);
  function projectsChanged(id?: string) { if (id !== undefined) setActiveProject(id); setProjectRevision(n => n + 1); }
  async function addToProject(ids: string[]) {
    if (!activeProject) { navigate("projects"); setNotice("请先选择或新建一个项目"); return; }
    const result = await api<{ added: number; alreadyAdded: number }>(`/projects/${activeProject}/items`, { ids });
    projectsChanged();
    setNotice(`已加入 ${result.added} 个候选素材${result.alreadyAdded ? `，${result.alreadyAdded} 个已在项目中` : ""}`);
  }
  useEffect(() => { try { localStorage.setItem("shiguang.assetActions", compactActions ? "compact" : "full"); } catch {} }, [compactActions]);
  useEffect(() => { try { localStorage.setItem("shiguang.assetSort", sort); } catch {} }, [sort]);
  const [inPoint, setInPoint] = useState(0), [outPoint, setOutPoint] = useState(0), [loop, setLoop] = useState(false), [stepping, setStepping] = useState(false);
  const stepInFlight = useRef(false);
  const pendingAudition = useRef<string | null>(null);
  const [modal, setModal] = useState<Modal>(null),
    [mobileNav, setMobileNav] = useState(false),
    [jobs, setJobs] = useState<Job[]>([]),
    [pending, setPending] = useState(0),
    [ops, setOps] = useState<Operation[]>([]),
    [trashAvailable, setTrashAvailable] = useState(false),
    [cache, setCache] = useState({ bytes: 0, files: 0, active: 0 });
  useEffect(() => {
    if (modal === "folders") void loadAllRoots().catch(() => {});
  }, [modal, loadAllRoots]);

  // 太快完成的操作不必闪一下遮罩：延迟 180ms 才显示
  useEffect(() => {
    if (!workLabels.length) {
      setShowWork(false);
      return;
    }
    const timer = setTimeout(() => setShowWork(true), 180);
    return () => clearTimeout(timer);
  }, [workLabels.length]);

  // 有扫描/参数读取任务在跑时轮询任务状态，否则"扫描中"的进度不会自己动
  const jobsActive = jobs.some((j) => j.status === "running") || pending > 0;
  const rootScanning = (rootId: string) => jobs.some((j) => j.rootId === rootId && j.status === "running");
  // 列表正在读取（搜索/筛选/翻页/刷新都会走到这里）
  const listLoading = loading || refreshing;
  // 空列表的首次加载已经有自己的大转圈，不再叠一层蒙层
  const showTableMask = listLoading && assets.length > 0;
  const [seriesMode, setSeriesMode] = useState(() => { try { return localStorage.getItem("shiguang.seriesMode") !== "flat"; } catch { return true; } });
  const [pageSize, setPageSize] = useState(() => { try { const value = Number(localStorage.getItem("shiguang.pageSize")); return [20,50,60,100,200].includes(value) ? value : 60; } catch { return 60; } });
  useEffect(() => { try { localStorage.setItem("shiguang.pageSize", String(pageSize)); } catch {} }, [pageSize]);
  const [seriesGroups, setSeriesGroups] = useState<AssetSeries[]>([]);
  const [seriesRevision, setSeriesRevision] = useState("");
  const [seriesEntries, setSeriesEntries] = useState(0), [seriesCount, setSeriesCount] = useState(0);
  const [seriesAssets, setSeriesAssets] = useState<Asset[]>([]);
  const [seriesFocus, setSeriesFocus] = useState<{ key: string; assetId: string } | null>(null);
  const grouped = seriesMode && layout === "list";
  const displayedAssets = grouped ? seriesAssets : assets;
  useEffect(() => { try { localStorage.setItem("shiguang.seriesMode", seriesMode ? "group" : "flat"); } catch {} }, [seriesMode]);
  // 蒙层要贴合"当前可见的那部分列表"：页面整体滚动、列表可能高于一屏，
  // 直接用 absolute inset:0 会把转圈甩到屏幕外（Element 的 v-loading 在小表格里没这个问题）
  const resultsBodyRef = useRef<HTMLDivElement | null>(null);
  const [maskRect, setMaskRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!showTableMask) return;
    const measure = () => {
      const el = resultsBodyRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const top = Math.max(r.top, 0);
      const bottom = Math.min(r.bottom, window.innerHeight);
      if (bottom - top < 40) {
        setMaskRect(null); // 已完全滚出视口，不必显示
        return;
      }
      setMaskRect({ top, left: Math.max(r.left, 0), width: r.width, height: bottom - top });
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [showTableMask]);
  useEffect(() => {
    if (!ready || !jobsActive) return;
    const timer = setInterval(() => {
      void api<{ jobs: Job[]; metadata: { pending: number } }>("/jobs")
        .then((j) => {
          setJobs(j.jobs);
          setPending(j.metadata.pending);
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [ready, jobsActive]);
  const [folderPath, setFolderPath] = useState(""), [folderPickerAvailable, setFolderPickerAvailable] = useState(false);
  useEffect(() => {
    if (!mobileNav) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setMobileNav(false); };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [mobileNav]);
  const [folderKind, setFolderKind] = useState("mixed"),
    [targetRoot, setTargetRoot] = useState(""),
    [relative, setRelative] = useState(""),
    [name, setName] = useState(""),
    [prefix, setPrefix] = useState(""),
    [plans, setPlans] = useState<Plan[] | null>(null),
    [confirmation, setConfirmation] = useState(""),
    [operationIds, setOperationIds] = useState<string[]>([]),
    [batchTags, setBatchTags] = useState("");
  const [destinationReady, setDestinationReady] = useState(false);
  const [tagText, setTagText] = useState(""),
    [note, setNote] = useState(""),
    [editCategory, setEditCategory] = useState(""),
    [editSub, setEditSub] = useState(""),
    [editKind, setEditKind] = useState("sfx");
  const [captureEdit, setCaptureEdit] = useState("");
  const [showMusicAI, setShowMusicAI] = useState(false);
  useEffect(() => setShowMusicAI(false), [selected?.id]);
  const [quickCategory, setQuickCategory] = useState<Asset | null>(null);
  const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
  const editScroll = useRef<{ top: number; left: number; results: number } | null>(null);
  function openAssetEditor(asset: Asset) {
    editScroll.current = { top: window.scrollY, left: window.scrollX, results: document.querySelector(".results")?.scrollTop || 0 };
    setEditingAsset(asset);
  }
  function closeAssetEditor() {
    setEditingAsset(null);
    const saved = editScroll.current;
    if (saved) requestAnimationFrame(() => { window.scrollTo(saved.left, saved.top); const results = document.querySelector(".results"); if (results) results.scrollTop = saved.results; });
  }
  function syncDetailFields(asset: Asset) {
    if (selected?.id !== asset.id) return;
    setTagText(asset.tags.join("，")); setNote(asset.note); setEditCategory(asset.category); setEditSub(asset.sub); setEditKind(asset.kind);
  }
  const [categoryAsset, setCategoryAsset] = useState<Asset | null>(null);
  const [tagAsset, setTagAsset] = useState<Asset | null>(null);
  const [cleanupIds, setCleanupIds] = useState<string[] | null>(null);
  const [fileChecking, setFileChecking] = useState(false);
  const fileCheckInFlight = useRef(false);
  const [editRevision, setEditRevision] = useState(0);
  const [mysqlState, setMysqlState] = useState<MysqlState | null>(null);
  const [mysqlFeedback, setMysqlFeedback] = useState("");
  const [mysqlForm, setMysqlForm] = useState({
    host: "127.0.0.1",
    port: 3306,
    database: "shiguang_media",
    user: "",
    password: "",
  });
  useEffect(() => {
    if (modal !== "settings") return;
    const timer = setInterval(() => {
      api<MysqlState>("/mysql")
        .then(setMysqlState)
        .catch(() => {});
    }, 2500);
    return () => clearInterval(timer);
  }, [modal]);
  const [rootMenuOpen, setRootMenuOpen] = useState(false);
  const rootMenu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rootMenuOpen) return;
    const closeOutside = (e: PointerEvent) => {
      if (!rootMenu.current?.contains(e.target as Node)) setRootMenuOpen(false);
    };
    const closeEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setRootMenuOpen(false);
        rootMenu.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [rootMenuOpen]);
  const [playing, setPlaying] = useState<Asset | null>(null),
    [isPlaying, setIsPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [length, setLength] = useState(0),
    [volume, setVolume] = useState(0.7),
    [proxy, setProxy] = useState(false),
    [videoProxy, setVideoProxy] = useState(false),
    [mediaError, setMediaError] = useState(""),
    [proxyLoading, setProxyLoading] = useState(false);
  const audio = useRef<HTMLAudioElement>(null),
    video = useRef<HTMLVideoElement>(null),
    requestSeq = useRef(0);
  const auditionGeneration = useRef(0);
  const wantsPlayback = useRef(false);
  const [auditionActive, setAuditionActive] = useState(false);
  function playbackIntent(active: boolean) {
    wantsPlayback.current = active;
    setAuditionActive(active);
  }
  function pauseAudition() {
    auditionGeneration.current++;
    playbackIntent(false);
    audio.current?.pause();
    setIsPlaying(false);
  }
  function resumeAudition() {
    auditionGeneration.current++;
    playbackIntent(true);
    const generation = auditionGeneration.current;
    void audio.current?.play().catch(e => {
      if (generation === auditionGeneration.current && wantsPlayback.current && e?.name !== "AbortError") {
        pauseAudition(); setMediaError("播放失败，请检查文件或生成兼容预览");
      }
    });
  }
  const [continuous, setContinuous] = useState(() => {
    try { return localStorage.getItem("shiguang.continuousAudition") === "true"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("shiguang.continuousAudition", String(continuous)); } catch {} }, [continuous]);
  function changeContinuous(value: boolean) {
    auditionGeneration.current++;
    if (!value && audio.current?.ended) pauseAudition();
    setContinuous(value);
    if (value) setLoop(false);
  }
  function changeLoop(value: boolean) {
    auditionGeneration.current++;
    setLoop(value);
    if (value) setContinuous(false);
  }
  // 后台同步的基线：每次真正读到数据后都用最新修订号覆盖，避免"刚打开就多刷一轮"
  const lastSync = useRef<{ revisions: Map<string, number>; running: number; pending: number; primed: boolean }>({
    revisions: new Map(),
    running: 0,
    pending: 0,
    primed: false,
  });
  const refreshRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});
  const foregroundRequests = useRef(0), foregroundRevision = useRef(0), backgroundRequest = useRef(false);
  const pauseBackground = useRef(false);
  pauseBackground.current = busy || loading || Boolean(selected && (
    tagText !== selected.tags.join("，") || note !== selected.note || editCategory !== selected.category ||
    editSub !== selected.sub || editKind !== selected.kind || captureEdit !== (selected.captured_ms === null ? "" :
      new Date(selected.captured_ms + 8 * 3600000).toISOString().slice(0, 16))
  ));
  function backgroundBlocked() {
    return pauseBackground.current || foregroundRequests.current > 0 || document.visibilityState !== "visible" ||
      Boolean(document.querySelector('[role="dialog"], .modal-backdrop')) ||
      Boolean(document.activeElement?.matches('textarea, select, input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), [contenteditable="true"]'));
  }
  function fail(e: unknown) {
    setError(e instanceof Error ? e.message : String(e));
  }
  function categoryLabel(id: string) {
    const option = allCategories.find(c => c.id === id) || filterCategories.find(c => c.id === id);
    return option ? displayDirectoryOptions([option], allCategories.length ? allCategories : filterCategories)[0].category : "";
  }
  /** 给重操作带上"正在做什么"，全局遮罩会显示这句话 */
  function runWith(label: string, fn: () => Promise<void>) {
    return run(fn, label);
  }
  async function run(fn: () => Promise<void>, label = "正在处理…") {
    setBusy(true);
    setError("");
    setWorkLabels((prev) => [...prev, label]);
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      setWorkLabels((prev) => prev.slice(0, -1));
      setBusy(false);
    }
  }
  function databaseAction(fn: () => Promise<void>) {
    void run(async () => {
      setMysqlFeedback("");
      try {
        await fn();
      } catch (e) {
        setMysqlFeedback(e instanceof Error ? e.message : "数据库操作失败");
      }
    });
  }
  function assetParams(targetPage = page) {
    const params = new URLSearchParams({
      q: search,
      qMode: searchMode,
      qField: nameOnly ? "name" : "all",
      view,
      page: String(targetPage),
      pageSize: String(pageSize),
      sort,
    });
    if (grouped) params.set("series", "1");
    if (kindNames[view]) params.set("kind", view);
    for (const rootId of rootFilter) params.append("root", rootId);
    if (category) params.set("category", category);
    if (Object.values(tagRules).some(v => v.length)) params.set("tagRules", JSON.stringify(tagRules));
    if (ext) params.set("ext", ext);
    if (duration) params.set("duration", duration);
    if (captureUnknown && dateField === "captured")
      params.set("captureUnknown", "1");
    else {
      if (createdFrom)
        params.set(
          dateField === "captured" ? "capturedFrom" : "createdFrom",
          createdFrom,
        );
      if (createdTo)
        params.set(
          dateField === "captured" ? "capturedTo" : "createdTo",
          createdTo,
        );
    }
    if (onlyFavorites) params.set("favorite", "1");
    return params;
  }
  const browseKey = useRef("");
  browseKey.current = assetParams().toString();
  const [categoryChoicesRevision, setCategoryChoicesRevision] = useState(0);
  const facetQuery = assetParams(1).toString();
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void loadTagFacets(new URLSearchParams(facetQuery), api).then(result => {
        if (live) setFilterTags(result.items);
      }).catch(() => {
        if (live) setNotice("标签数量暂未更新，已保留现有选项；可点击刷新重试");
      });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [facetQuery, categoryChoicesRevision]);
  useEffect(() => {
    if (category && allCategories.length && !allCategories.some(c => c.id === category)) { setCategory(""); setPage(1); }
  }, [allCategories, category]);
  useEffect(() => {
    if (!categoryChoicesRevision) return;
    let live = true;
    // Schedule after the list has committed; category statistics never hold its loading mask open.
    const timer = setTimeout(() => {
      void api<(DirectoryOption & { id: string; name: string })[]>("/categories" + (view === "missing" ? "?view=missing" : "")).then(categories => {
        if (live) setAllCategories(categories.filter(c => c.id !== "uncategorized"));
      }).catch(() => {
        if (live) setNotice("分类列表暂未更新，已保留现有分类；可点击刷新重试");
      });
    }, 0);
    return () => { live = false; clearTimeout(timer); };
  }, [categoryChoicesRevision, view]);
  /**
   * 重新读取界面数据。
   * `silent: true` 用于后台同步：不显示列表蒙层，避免外部变化引起的刷新把界面
   * 周期性地"变成加载中"（用户会以为一直在读盘）。
   */
  async function refresh(opts: { silent?: boolean } = {}) {
    if (opts.silent && (backgroundBlocked() || backgroundRequest.current)) return;
    const foreground = !opts.silent;
    const foregroundId = foreground ? ++foregroundRevision.current : 0;
    if (foreground) { foregroundRequests.current++; setRefreshing(true); }
    else backgroundRequest.current = true;
    const seq = ++requestSeq.current;
    const params = assetParams();
    try {
    const [data, s, r, j] = await Promise.all([
      api<{
        items: Asset[];
        total: number;
        page: number;
        pages: number;
        categories: Stats["categories"];
        groups?: AssetSeries[]; revision?: string; entries?: number; seriesCount?: number;
      }>((params.get("series") === "1" ? "/asset-series?" : "/assets?") + params),
      api<Stats>("/stats"),
      api<Root[]>("/roots"),
      api<{ jobs: Job[]; metadata: { pending: number } }>("/jobs"),
    ]);
    if (seq !== requestSeq.current || params.toString() !== browseKey.current || (opts.silent && backgroundBlocked())) return;
    setFilterCategories(data.categories);
    setCategoryChoicesRevision(n => n + 1);
    setAssets(data.items);
    setSeriesGroups(data.groups || []);
    setSeriesRevision(data.revision || "");
    setSeriesEntries(data.entries || 0); setSeriesCount(data.seriesCount || 0);
    const freshSelected = data.items.find((a) => a.id === selected?.id);
    if (freshSelected) {
      if (opts.silent) {
        setTagText(freshSelected.tags.join("，"));
        setNote(freshSelected.note);
        setEditCategory(freshSelected.category);
        setEditSub(freshSelected.sub);
        setEditKind(freshSelected.kind);
        setCaptureEdit(freshSelected.captured_ms === null ? "" :
          new Date(freshSelected.captured_ms + 8 * 3600000).toISOString().slice(0, 16));
      }
      setSelected((prev) =>
        prev?.id === freshSelected.id
          ? {
              ...prev,
              ...(opts.silent ? freshSelected : {}),
              captured_ms: freshSelected.captured_ms,
              capture_source: freshSelected.capture_source,
              capture_status: freshSelected.capture_status,
              capture_error: freshSelected.capture_error,
              duration: freshSelected.duration,
              width: freshSelected.width,
              height: freshSelected.height,
              probe: freshSelected.probe,
              error: freshSelected.error,
              online: freshSelected.online,
              file_status: freshSelected.file_status,
              file_checked_ms: freshSelected.file_checked_ms,
              file_check_reason: freshSelected.file_check_reason,
            }
          : prev,
      );
      if (
        selected?.capture_status === "pending" &&
        freshSelected.captured_ms !== null
      ) {
        setCaptureEdit(
          (prev) =>
            prev ||
            new Date(freshSelected.captured_ms! + 8 * 3600000)
              .toISOString()
              .slice(0, 16),
        );
      }
    }
    setTotal(data.total);
    setPages(data.pages);
    setPage(data.page);
    setStats(s);
    setRoots(r);
    setJobs(j.jobs);
    setPending(j.metadata.pending);
    lastSync.current = {
      revisions: new Map(r.map((root) => [root.id, Number(root.revision)])),
      running: j.jobs.filter((x) => x.status === "running").length,
      pending: j.metadata.pending,
      primed: true,
    };
    } finally {
      if (foreground) {
        foregroundRequests.current--;
        if (foregroundId === foregroundRevision.current) setRefreshing(false);
      } else backgroundRequest.current = false;
    }
  }
  refreshRef.current = refresh;
  async function checkFiles(force = false) {
    if (fileCheckInFlight.current || (!force && backgroundBlocked())) return;
    fileCheckInFlight.current = true; setFileChecking(true);
    try {
      const result = await api<{ checked: number; cached: number; missing: number; deferred?: boolean }>("/maintenance/files", { force });
      if (result.deferred) { if (force) setNotice("素材任务进行中，请稍后检查"); return; }
      if (force) setEditRevision(n => n + 1);
      await refreshRef.current({ silent: !force });
      if (force) setNotice(`已检查 ${result.checked} 条，发现 ${result.missing} 条疑似失效，已归入失效素材；未删除任何记录`);
    } catch { setError("文件状态检查未完成，素材数据已保留"); }
    finally { fileCheckInFlight.current = false; setFileChecking(false); }
  }
  useEffect(() => {
    api<{ token: string; trashAvailable: boolean; folderPickerAvailable?: boolean }>("/session")
      .then((s) => {
        token = s.token;
        setTrashAvailable(s.trashAvailable);
        setFolderPickerAvailable(s.folderPickerAvailable !== false);
        setReady(true);
      })
      .catch(fail);
  }, []);
  useEffect(() => {
    if (!ready || !refreshSeconds) return;
    const check = () => { if (document.visibilityState === "visible") void checkFiles(); };
    // 打开页面时不要立刻检查全部文件状态：它有 7000+ 个文件要 stat，
    // 与首屏那几个接口抢同一条数据库通道，会把"打开"整体拖慢（实测约 1s）。
    // 推迟到界面稳定之后，随后跟随刷新设置，文件检查最短间隔 60 秒。
    const kickoff = setTimeout(check, 5000);
    const timer = setInterval(() => void check(), Math.max(60000, refreshSeconds * 1000));
    document.addEventListener("visibilitychange", check);
    return () => { clearTimeout(kickoff); clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, [ready, refreshSeconds]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 220);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    refresh()
      .catch(fail)
      .finally(() => setLoading(false));
  }, [
    ready,
    view,
    search,
    searchMode,
    nameOnly,
    grouped,
    pageSize,
    rootFilter,
    category,
    tagRules,
    ext,
    duration,
    createdFrom,
    createdTo,
    dateField,
    captureUnknown,
    sort,
    onlyFavorites,
    page,
  ]);
  // Probe revisions first; keep background work out of active edits and foreground requests.
  useEffect(() => {
    if (!ready || !refreshSeconds) return;
    let live = true, inFlight = false;
    const tick = async () => {
      if (!live || inFlight || backgroundBlocked() || backgroundRequest.current) return;
      inFlight = true;
      try {
        const [r, j] = await Promise.all([
          api<Root[]>("/roots"),
          api<{ jobs: Job[]; metadata: { pending: number } }>("/jobs"),
        ]);
        if (!live || backgroundBlocked()) return;
        const running = j.jobs.filter((x) => x.status === "running").length;
        const seen = lastSync.current;
        const revisionsChanged = r.length !== seen.revisions.size || r.some((root) => seen.revisions.get(root.id) !== Number(root.revision));
        const justFinished = seen.primed && running < seen.running;
        const pendingDropped = seen.primed && j.metadata.pending < seen.pending;
        if (revisionsChanged || justFinished || pendingDropped) {
          await refreshRef.current({ silent: true });
        } else {
          setRoots(r);
          setJobs(j.jobs);
          setPending(j.metadata.pending);
        }
        if (live && !backgroundBlocked()) lastSync.current = {
          revisions: new Map(r.map((root) => [root.id, Number(root.revision)])), running, pending: j.metadata.pending, primed: true,
        };
      } catch {
        // 后台同步失败不打扰用户，下一轮再试
      } finally {
        inFlight = false;
      }
    };
    const t = setInterval(() => void tick(), refreshSeconds * 1000);
    return () => { live = false; clearInterval(t); };
  }, [ready, refreshSeconds]);
  useEffect(() => {
    setPage(1);
    setChecked(new Set());
  }, [
    view,
    search,
    searchMode,
    nameOnly,
    grouped,
    pageSize,
    rootFilter,
    category,
    tagRules,
    ext,
    duration,
    createdFrom,
    createdTo,
    dateField,
    captureUnknown,
    onlyFavorites,
  ]);
  useEffect(() => {
    if (!selected) return;
    setTagText(selected.tags.join("，"));
    setNote(selected.note);
    setEditCategory(selected.category);
    setEditSub(selected.sub);
    setEditKind(selected.kind);
    setCaptureEdit(
      selected.captured_ms === null
        ? ""
        : new Date(selected.captured_ms + 8 * 3600000)
            .toISOString()
            .slice(0, 16),
    );
    setMediaError("");
    setVideoProxy(false);
    setProxyLoading(false);
  }, [selected?.id]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setModal(null);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [busy]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(""), 4000);
      return () => clearTimeout(t);
    }
  }, [notice]);
  useEffect(() => {
    if (audio.current) audio.current.volume = volume;
  }, [volume, playing]);
  function navigate(v: string) {
    if (v !== view) {
      filterMemory.current.set(view, { q, searchMode, nameOnly, rootFilter, category, tagRules, ext, duration, createdFrom, createdTo, dateField, captureUnknown, onlyFavorites });
      const saved = filterMemory.current.get(v);
      setQ(saved?.q || "");
      setSearch(saved?.q || "");
      setSearchMode(saved?.searchMode || "all");
      setNameOnly(saved?.nameOnly || false);
      setRootFilter(saved?.rootFilter || []);
      setCategory(saved?.category || "");
      setTagRules(saved?.tagRules || emptyTagRules());
      setExt(saved?.ext || "");
      setDuration(saved?.duration || "");
      setCreatedFrom(saved?.createdFrom || "");
      setCreatedTo(saved?.createdTo || "");
      setDateField(saved?.dateField || "created");
      setCaptureUnknown(saved?.captureUnknown || false);
      setOnlyFavorites(saved?.onlyFavorites || false);
    }
    setView(v);
    setAdvancedFilters(false);
    setRootMenuOpen(false);
    setPage(1);
    setSelected(null);
    setMobileNav(false);
    setLayout(v === "photo" || v === "video" ? "grid" : "list");
  }
  async function patch(a: Asset, patch: unknown) {
    const updated = await api<Asset>("/assets/" + a.id, patch, "PATCH");
    setSelected((prev) => (prev?.id === a.id ? updated : prev));
    setAssets((prev) => prev.map((x) => (x.id === a.id ? updated : x)));
    await refresh();
  }
  function toggleCheck(id: string) {
    setChecked((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function play(a: Asset, automatic = false) {
    if (automatic && !wantsPlayback.current) return;
    if (a.ext === "ncm") {
      setError("NCM 格式暂不支持直接试听，仍可分类及在访达中定位原文件。");
      return;
    }
    video.current?.pause();
    if (window.matchMedia("(min-width: 851px)").matches) setSelected(a);
    if (playing?.id === a.id) {
      if (wantsPlayback.current) pauseAudition();
      else resumeAudition();
      return;
    }
    auditionGeneration.current++;
    playbackIntent(true);
    setPlaying(a);
    setIsPlaying(false);
    setProxy(false);
    setMediaError("");
    setPosition(0);
    setLength(a.duration || 0);
    setInPoint(0); setOutPoint(a.duration || 0); setLoop(false);
  }
  useEffect(() => {
    let live = true;
    if (playing) {
      const generation = auditionGeneration.current;
      audio.current?.load();
      if (wantsPlayback.current) audio.current
        ?.play()
        .catch(e => { if (live && generation === auditionGeneration.current && wantsPlayback.current && e?.name !== "AbortError") { pauseAudition(); setMediaError("播放失败，可生成兼容预览"); } });
    }
    return () => { live = false; };
  }, [playing?.id, proxy]);
  function toggleAudition(active = !wantsPlayback.current) {
    if (!audio.current) return;
    if (active) resumeAudition();
    else pauseAudition();
  }
  function seekAudition(value: number) {
    auditionGeneration.current++;
    const n = Math.max(loop ? inPoint : 0, Math.min(loop && outPoint > inPoint ? outPoint - 0.01 : length, value));
    if (audio.current && Number.isFinite(n)) audio.current.currentTime = n;
    setPosition(n);
  }
  function auditionRange(start: number, end: number) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > length + 0.01 || end - start < 0.05) return;
    setInPoint(start); setOutPoint(Math.min(length, end));
  }
  const libraryView = !["projects", "categoryManagement", "tagManagement", "duplicates", "missing"].includes(view);
  const auditionContext = useRef({ id: playing?.id, view });
  auditionContext.current = { id: playing?.id, view };
  const auditionQueue = displayedAssets.filter(a => audioAsset(a) && a.ext !== "ncm" && a.online);
  const auditionIndex = auditionQueue.findIndex(a => a.id === (playing?.id || selected?.id));
  async function stepAudition(direction: number, automatic = false) {
    if (!libraryView || stepInFlight.current || (automatic && ((!grouped && auditionIndex < 0) || !wantsPlayback.current))) return false;
    stepInFlight.current = true; setStepping(true);
    const key = browseKey.current;
    const generation = auditionGeneration.current;
    try {
      if (grouped) {
        const params = assetParams();
        params.set("direction", String(direction));
        params.set("currentId", playing?.id || selected?.id || "");
        const result = await api<{ item: Asset | null; page?: number; seriesKey?: string }>("/asset-series/adjacent?" + params);
        if (key !== browseKey.current || generation !== auditionGeneration.current || auditionContext.current.id !== playing?.id || auditionContext.current.view !== view || (automatic && !wantsPlayback.current)) return false;
        if (!result.item) return false;
        pendingAudition.current = result.item.id;
        setSeriesFocus({ key: result.seriesKey!, assetId: result.item.id });
        setPage(result.page!); play(result.item, automatic); return true;
      }
      const next = auditionIndex < 0 ? (direction > 0 ? auditionQueue[0] : auditionQueue.at(-1)) : auditionQueue[auditionIndex + direction];
      if (next) { pendingAudition.current = next.id; play(next, automatic); return true; }
      for (let p = page + direction; p >= 1 && p <= pages; p += direction) {
        const data = await api<{ items: Asset[] }>("/assets?" + assetParams(p));
        if (key !== browseKey.current || generation !== auditionGeneration.current || auditionContext.current.id !== playing?.id || auditionContext.current.view !== view || (automatic && !wantsPlayback.current)) return false;
        const queue = data.items.filter(a => audioAsset(a) && a.ext !== "ncm" && a.online), candidate = direction > 0 ? queue[0] : queue.at(-1);
        if (candidate) { pendingAudition.current = candidate.id; setPage(p); play(candidate, automatic); return true; }
      }
    } catch (e) { fail(e); } finally { stepInFlight.current = false; setStepping(false); }
    return false;
  }
  useEffect(() => {
    if (!pendingAudition.current) return;
    const row = document.querySelector(`[data-asset-id="${pendingAudition.current}"]`);
    if (row) { row.scrollIntoView({ block: "nearest" }); pendingAudition.current = null; }
  }, [playing?.id, assets, seriesAssets]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.defaultPrevented || e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('[role="dialog"]') || target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="combobox"],[role="slider"],[role="menu"],.tag-rule-panel')) return;
      if (e.code === "Space" && !target.closest("button,a")) { e.preventDefault(); if (playing) toggleAudition(); else if (selected && audioAsset(selected)) play(selected); else if (auditionQueue[0] && libraryView) play(auditionQueue[0]); else if (grouped && libraryView && total) void stepAudition(1); }
      if (libraryView && ["ArrowUp", "ArrowDown"].includes(e.key)) { e.preventDefault(); void stepAudition(e.key === "ArrowDown" ? 1 : -1); }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    if (!loop || !isPlaying || outPoint - inPoint < 0.05) return;
    let frame = 0;
    const tick = () => { const el = audio.current; if (el && (el.currentTime >= outPoint || el.currentTime < inPoint)) { el.currentTime = inPoint; setPosition(inPoint); } frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);
  }, [loop, inPoint, outPoint, isPlaying, playing?.id]);
  function openOperation(type: Modal) {
    const ids = checked.size ? [...checked] : selected ? [selected.id] : [];
    if (!ids.length) {
      setError("请先选择素材");
      return;
    }
    setOperationIds(ids);
    setName(
      ids.length === 1
        ? (assets.find((a) => a.id === ids[0]) || selected)?.name || ""
        : "",
    );
    setPrefix("");
    setRelative("");
    setDestinationReady(false);
    setConfirmation("");
    setTargetRoot(roots[0]?.id || "");
    setPlans(null);
    setBatchTags("");
    setModal(type);
  }
  function trashAsset(asset: Asset) {
    if (!trashAvailable || !asset.online || busy) return;
    setOperationIds([asset.id]);
    setPlans(null);
    setConfirmation("");
    setError("");
    setModal("trash");
  }
  function moveAsset(asset: Asset) {
    setDestinationReady(false);
    setOperationIds([asset.id]); setTargetRoot(asset.root_id); setRelative("");
    setPlans(null); setConfirmation(""); setError(""); setModal("move");
  }
  async function revealAsset(asset: Asset) {
    const result = await api<{ asset: Asset }>(`/assets/${asset.id}/reveal`, {});
    setAssets(prev => prev.map(a => a.id === asset.id ? result.asset : a));
    setSelected(prev => prev?.id === asset.id ? result.asset : prev);
    await refreshRef.current();
  }
  function assetActions(asset: Asset, grid = false) {
    if (view === "missing") return <div className={"asset-quick-actions" + (grid ? " asset-card-actions" : "")} onClick={e => e.stopPropagation()}>
      {!folderView && <IconButton icon={FilePenLine} title={"修改分类：" + asset.name} onClick={() => setCategoryAsset(asset)}/>}
      <IconButton icon={Trash2} title={"清理失效记录：" + asset.name} disabled={busy || fileChecking} onClick={() => setCleanupIds([asset.id])}/>
    </div>;
    return <AssetActions asset={asset} grid={grid} compact={compactActions} busy={busy} canTrash={trashAvailable}
      reveal={() => void run(() => revealAsset(asset))} trash={() => trashAsset(asset)}
      tags={() => setTagAsset(asset)} category={!folderView ? () => setCategoryAsset(asset) : undefined}
      extraCategory={!folderView ? () => setQuickCategory(asset) : undefined}
      move={folderView ? () => moveAsset(asset) : undefined}
      project={() => void run(() => addToProject([asset.id]))} inProject={projectMembers.some(m => m.asset_id === asset.id)}
      favorite={() => void run(() => patch(asset, { favorite: !asset.favorite }))}/>;
  }
  function operationInput() {
    return {
      ids: operationIds,
      action: modal,
      name,
      prefix,
      rootId: targetRoot,
      relative,
    };
  }
  async function loadHistory() {
    setOps(await api<Operation[]>("/operations"));
  }
  async function openModal(type: Modal) {
    setError("");
    setModal(type);
    if (type === "history") await run(loadHistory);
    if (type === "settings")
      await run(async () => {
        setCache(await api("/cache"));
        const state = await api<MysqlState>("/mysql");
        setMysqlState(state);
        setMysqlForm({
          ...state.config,
          password: "",
        });
      });
  }
  const title =
    view === "projects" ? "项目" : view === "duplicates" ? "重复音频" : view === "tagManagement"
      ? "标签管理"
      : view === "categoryManagement"
        ? "分类管理"
        : view === "all"
          ? "全部素材"
          : view === "favorites"
            ? "我的收藏"
            : view === "review"
              ? "待确认素材"
              : view === "missing" ? "失效素材" : view === "offline"
                ? "离线素材"
                : kindNames[view];
  const count = (v: string) =>
    v === "all"
      ? stats.total
      : v === "favorites"
        ? stats.favorites
        : v === "review"
          ? stats.review
          : v === "missing" ? stats.missing : v === "offline"
            ? stats.offline
            : stats.kinds.find((k) => k.kind === v)?.n || 0;
  const navs: [string, string, LucideIcon][] = [
    ["all", "全部素材", Library],
    ["photo", "摄影照片", Image],
    ["video", "视频素材", Film],
    ["sfx", "音效", AudioLines],
    ["music", "音乐", Music2],
    ["categoryManagement", "分类管理", FolderOpen],
    ["projects", "项目", FolderKanban],
    ["tagManagement", "标签管理", Tag],
    ["duplicates", "重复音频", Copy],
    ["favorites", "我的收藏", Star],
    ["review", "待确认", CircleHelp],
    ["offline", "离线素材", HardDrive],
    ["missing", "失效素材", CircleAlert],
  ];
  const filtersActive = !!(
    q ||
    nameOnly ||
    rootFilter.length ||
    category ||
    Object.values(tagRules).some(v => v.length) ||
    ext ||
    duration ||
    createdFrom ||
    createdTo ||
    captureUnknown ||
    onlyFavorites
  );
  const allChecked =
    displayedAssets.length > 0 && displayedAssets.every((a) => checked.has(a.id));
  useEffect(() => {
    const player = playerRef.current;
    const topbar = topbarRef.current;
    const measure = () => { setPlayerHeight(player ? Math.ceil(player.getBoundingClientRect().height) : 0); setTopbarHeight(topbar ? Math.ceil(topbar.getBoundingClientRect().height) : 72); };
    const observer = new ResizeObserver(measure);
    if (player) observer.observe(player);
    if (topbar) observer.observe(topbar);
    measure();
    return () => observer.disconnect();
  }, [!!playing]);
  function resizeDetails(clientX: number) {
    setDetailsWidth(Math.max(280, Math.min(600, window.innerWidth - 80, window.innerWidth - clientX)));
  }
  if (loginOpen) {
    return (
      <CloudLoginPage
        auth={cloudAuth}
        onBack={closeLogin}
        onAdvanced={() => {
          closeLogin();
          setModal("settings");
        }}
      />
    );
  }
  if (workspaceOpen) {
    return (
      <CloudWorkspace
        auth={cloudAuth}
        request={api}
        onBack={closeWorkspace}
        onLogin={openLogin}
        onNotice={setNotice}
      />
    );
  }
  return (
    <div className={"app" + (navCollapsed ? " nav-collapsed" : "") + (detailsHidden ? " details-hidden" : "")} style={{ "--details-width": `${detailsWidth}px`, "--player-height": `${playerHeight}px`, "--inspector-top": `${topbarHeight}px` } as React.CSSProperties}>
      {mobileNav && <button className="navigation-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)}/>}
      {navSettings && <NavigationSettings items={[...navs.map(([id, label]): [string, string] => [id, label]), ["roots", "素材目录"]]} hidden={hiddenNav}
        toggle={id => { setHiddenNav(prev => prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id]); if (view === id) navigate("all"); }}
        reset={() => setHiddenNav([])} theme={theme} setTheme={setTheme} refreshSeconds={refreshSeconds} setRefreshSeconds={setRefreshSeconds} close={closeNavSettings}/>}
      <aside className={"sidebar " + (mobileNav ? "visible" : "")}>
        <div className="brand">
          <span className="brand-icon">
            <Aperture size={25} />
          </span>
          <div className="brand-name">
            <strong>拾光</strong>
            <span>本地素材库</span>
          </div>
          <button className="icon-button sidebar-mobile-close" title="关闭导航" onClick={() => setMobileNav(false)}><X size={18}/></button>
        </div>
        <div className="sidebar-controls">
          <button className="icon-button sidebar-collapse" title={navCollapsed ? "展开侧栏" : "折叠侧栏"} aria-label={navCollapsed ? "展开侧栏" : "折叠侧栏"} aria-expanded={!navCollapsed} onClick={() => setNavCollapsed(v => !v)}>{navCollapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}</button>
          <button className="icon-button" title="界面设置" aria-label="界面设置" onClick={() => setNavSettings(true)}><SlidersHorizontal size={17}/></button>
        </div>
        <div className="sidebar-scroll">
        <nav aria-label="主导航">
          {navs.filter(([v]) => !hiddenNav.includes(v)).map(([v, label, Icon]) => (
            <React.Fragment key={v}>
              <button
                title={label}
                aria-label={label}
                aria-current={view === v ? "page" : undefined}
                className={view === v ? "nav-item selected" : "nav-item"}
                onClick={() => navigate(v)}
              >
                <Icon size={19} />
                <span>{label}</span>
                {v !== "projects" && v !== "categoryManagement" && v !== "tagManagement" && v !== "duplicates" && (
                  <small>{count(v).toLocaleString()}</small>
                )}
              </button>
            </React.Fragment>
          ))}
        </nav>
        {!hiddenNav.includes("roots") && <>
        <div className="side-heading">
          素材目录
          <IconButton
            icon={FolderPlus}
            title="管理素材目录"
            onClick={() => void openModal("folders")}
          />
        </div>
        <div className="root-nav">
          {roots.map((r) => (
            <button
              key={r.id}
              title={r.path}
              onClick={() => {
                setRootFilter(
                  rootFilter.length === 1 && rootFilter[0] === r.id
                    ? []
                    : [r.id],
                );
                setPage(1);
              }}
              className={
                rootFilter.includes(r.id) ? "root-item selected" : "root-item"
              }
            >
              <FolderOpen size={16} />
              <span>{r.name}</span>
              <i className={r.online ? "online-dot" : "offline-dot"} />
            </button>
          ))}
        </div>
        </>}
        </div>
        <div className="sidebar-bottom">
          <button title="操作记录" aria-label="操作记录" onClick={() => void openModal("history")}>
            <History size={18} />
            <span>操作记录</span>
          </button>
          <button title="设置与缓存" aria-label="设置与缓存" onClick={() => void openModal("settings")}>
            <Settings size={18} />
            <span>设置与缓存</span>
          </button>
          <div>
            <i className="online-dot" />
            本机 · 不上传素材
          </div>
        </div>
      </aside>
      <main aria-busy={refreshing || showWork || undefined}>
        <header ref={topbarRef} className="topbar">
          <IconButton
            icon={Menu}
            title={mobileNav ? "关闭导航" : "展开导航"}
            onClick={() => setMobileNav(!mobileNav)}
          />
          <div className="breadcrumb">
            素材库<span>/</span>
            {title}
          </div>
          <span className="local-label">
            <HardDrive size={14} />
            LOCAL LIBRARY
          </span>
          {libraryView && <button className="icon-button details-toggle" title={detailsHidden ? "显示素材详情" : "隐藏素材详情"} aria-label={detailsHidden ? "显示素材详情" : "隐藏素材详情"} aria-expanded={!detailsHidden} aria-controls="asset-details" onClick={() => { if (detailsHidden && !selected && assets[0]) setSelected(assets[0]); setDetailsHidden(v => !v); }}>{detailsHidden ? <PanelRightOpen size={18}/> : <PanelRightClose size={18}/>}</button>}
          {jobsActive && (
            <span className="work-pill" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              {jobs.some((j) => j.status === "running") ? "正在读取文件…" : "正在读取参数…"}
            </span>
          )}
          <label className="current-project"><FolderKanban size={16}/><select aria-label="当前项目" value={activeProject} disabled={busy} onChange={e => setActiveProject(e.target.value)}><option value="">选择项目</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <button className="primary add-root-button" aria-label="添加素材目录" onClick={() => void openModal("folders")}>
            <FolderPlus size={17} />
            <span className="add-root-label">添加素材目录</span>
          </button>
          <AccountEntry auth={cloudAuth} onLogin={openLogin} onWorkspace={openWorkspace} onNotice={setNotice} />
        </header>
        {view === "projects" ? <ProjectManager projects={projects} activeId={activeProject} select={setActiveProject} request={api} revision={projectRevision + editRevision} changed={projectsChanged} play={play} playingId={playing?.id} isPlaying={isPlaying} edit={openAssetEditor} stopAudio={pauseAudition} browseLibrary={() => navigate("all")}/> : view === "duplicates" ? <DuplicateAudioManager request={api} play={play} edit={openAssetEditor} playingId={playing?.id} isPlaying={isPlaying} trash={trashAsset} canTrash={trashAvailable && !busy} revision={editRevision} changed={() => void refreshRef.current().catch(fail)} stopAudio={pauseAudition} runTask={runWith} cleared={ids => { const removed = new Set(ids); setSelected(prev => prev && removed.has(prev.id) ? null : prev); setPlaying(prev => prev && removed.has(prev.id) ? null : prev); setEditRevision(n => n + 1); }}/> : view === "tagManagement" ? (
          <TagManager
            trash={trashAsset}
            canTrash={trashAvailable && !busy}
            edit={openAssetEditor}
            revision={editRevision}
            request={api}
            stopPreview={pauseAudition}
            changed={() => void refreshRef.current().catch(fail)}
            preview={(a) => {
              if (audioAsset(a)) play(a);
              else {
                navigate(a.kind);
                setSelected(a);
              }
            }}
          />
        ) : view === "categoryManagement" ? (
          <FolderBrowser roots={roots} request={api} revision={editRevision} play={play} playingId={playing?.id} isPlaying={auditionActive} tags={setTagAsset} move={moveAsset} addToProject={addToProject} stopAudio={pauseAudition} categories={allCategories}/>
        ) : (
          <div className="library-browser">
            <section className="library-heading">
              <div>
                <h1>{title}</h1>
                <p>
                  <strong>{total.toLocaleString()}</strong> 个素材
                  {category && <> · {categoryLabel(category)}</>}
                </p>
              </div>
              <div className="heading-tools">
                <IconButton
                  icon={RefreshCw}
                  title="刷新索引显示"
                  onClick={() => void run(refresh)}
                />
                <ToolbarPopover label="更多素材操作" icon={MoreHorizontal}>{close => <>
                  <button disabled={fileChecking} onClick={() => { close(); void checkFiles(true); }}><RefreshCw size={16} className={fileChecking ? "spin" : ""}/>{fileChecking ? "检查中…" : "检查文件状态"}</button>
                  <button onClick={() => { close(); window.location.href = "/api/export" + (checked.size ? "?ids=" + [...checked].join(",") : ""); }}><Download size={16}/>导出清单{checked.size ? `（${checked.size} 项）` : ""}</button>
                </>}</ToolbarPopover>
                {view === "missing" && <button className="danger" disabled={!checked.size || fileChecking || checked.size > 200} onClick={() => setCleanupIds([...checked])}><Trash2 size={16}/>清理所选记录</button>}
              </div>
            </section>
            {error && (
              <div className="banner error" role="alert">
                <CircleAlert size={17} />
                <span>{error}</span>
                <IconButton
                  icon={X}
                  title="关闭提示"
                  onClick={() => setError("")}
                />
              </div>
            )}
            <div className="filters search-toolbar" data-expanded={advancedFilters}>
              <KeywordSearch value={q} change={setQ} mode={searchMode} changeMode={setSearchMode} nameOnly={nameOnly} changeNameOnly={setNameOnly}/>
              <CategoryFilter value={category} categories={displayDirectoryOptions(filterCategories, allCategories.length ? allCategories : filterCategories)} onChange={setCategory} formatName={name => name}/>
              <TagRuleFilter value={tagRules} tags={filterTags} change={setTagRules}/>
              <button className="plain advanced-filter-trigger" aria-label="更多筛选" aria-expanded={advancedFilters} aria-controls="advanced-asset-filters" onClick={() => { setAdvancedFilters(v => !v); setRootMenuOpen(false); }}><SlidersHorizontal size={16}/><span>筛选</span>{(rootFilter.length > 0 || ext || duration || createdFrom || createdTo || captureUnknown || onlyFavorites) && <i className="filter-indicator"/>}<ChevronDown size={14}/></button>
            </div>
            <div id="advanced-asset-filters" className="advanced-filters" hidden={!advancedFilters} role="region" aria-label="更多素材筛选">
              <div className="advanced-filter-fields">
              <div className="root-filter" ref={rootMenu}>
                <button
                  className="root-filter-trigger"
                  data-active={rootFilter.length > 0}
                  aria-label="筛选素材目录"
                  aria-expanded={rootMenuOpen}
                  aria-controls="root-filter-options"
                  onClick={() => setRootMenuOpen(!rootMenuOpen)}
                >
                  <FolderOpen size={16} />
                  <span>
                    {rootFilter.length === 0
                      ? "全部目录"
                      : rootFilter.length === 1
                        ? roots.find((r) => r.id === rootFilter[0])?.name ||
                          "已选目录"
                        : `已选 ${rootFilter.length} 个目录`}
                  </span>
                  <ChevronDown size={14} />
                </button>
                {rootMenuOpen && (
                  <div
                    className="root-filter-options"
                    id="root-filter-options"
                    role="group"
                    aria-label="素材目录勾选"
                  >
                    <div className="root-filter-heading">
                      <strong>
                        <FolderOpen size={15} />
                        素材目录 <small>{roots.length}</small>
                      </strong>
                      <button
                        className="text-button"
                        onClick={() => setRootFilter([])}
                      >
                        全部目录
                      </button>
                    </div>
                    <div className="root-filter-list">
                      {roots.length === 0 && <p>暂无素材目录</p>}
                      {roots.map((r) => (
                        <label
                          key={r.id}
                          title={r.path}
                          className={
                            rootFilter.includes(r.id) ? "is-selected" : ""
                          }
                        >
                          <input
                            type="checkbox"
                            checked={rootFilter.includes(r.id)}
                            onChange={(e) =>
                              setRootFilter((prev) =>
                                e.target.checked
                                  ? [...prev, r.id]
                                  : prev.filter((id) => id !== r.id),
                              )
                            }
                          />
                          <span className="directory-icon" aria-hidden="true">
                            <FolderOpen size={18} />
                          </span>
                          <span>
                            <strong>{r.name}</strong>
                            <small>{r.path}</small>
                          </span>
                          <i
                            aria-label={r.online ? "目录在线" : "目录离线"}
                            className={r.online ? "online-dot" : "offline-dot"}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="root-filter-footer">
                      <span>
                        {rootFilter.length
                          ? `已选 ${rootFilter.length} 个目录`
                          : "全部目录"}
                      </span>
                      <button
                        className="root-filter-done"
                        onClick={() => {
                          setRootMenuOpen(false);
                          rootMenu.current?.querySelector("button")?.focus();
                        }}
                      >
                        <Check size={14} />
                        完成
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <select
                aria-label="筛选格式"
                value={ext}
                onChange={(e) => setExt(e.target.value)}
              >
                <option value="">全部格式</option>
                {stats.formats.map((f) => (
                  <option key={f} value={f}>
                    {f.toUpperCase()}
                  </option>
                ))}
              </select>
              <select
                aria-label="筛选时长"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              >
                <option value="">全部时长</option>
                <option value="short">少于10秒</option>
                <option value="medium">10秒至1分钟</option>
                <option value="long">超过1分钟</option>
                <option value="unknown">时长未读取</option>
              </select>
              <label className="check-label"><input type="checkbox" checked={onlyFavorites} onChange={e => setOnlyFavorites(e.target.checked)}/>仅收藏</label>
            </div>
            <div className="date-filters">
              <span>
                <select
                  aria-label="日期类型"
                  value={dateField}
                  onChange={(e) => {
                    setDateField(e.target.value as "created" | "captured");
                    setCaptureUnknown(false);
                  }}
                >
                  <option value="created">创建日期</option>
                  <option value="captured">拍摄日期</option>
                </select>
                <small>北京时间</small>
              </span>
              <label>
                从
                <input
                  type="date"
                  aria-label={
                    (dateField === "captured" ? "拍摄" : "创建") + "日期起始"
                  }
                  disabled={captureUnknown}
                  value={createdFrom}
                  max={createdTo || undefined}
                  onChange={(e) => setCreatedFrom(e.target.value)}
                />
              </label>
              <label>
                至
                <input
                  type="date"
                  aria-label={
                    (dateField === "captured" ? "拍摄" : "创建") + "日期结束"
                  }
                  disabled={captureUnknown}
                  value={createdTo}
                  min={createdFrom || undefined}
                  onChange={(e) => setCreatedTo(e.target.value)}
                />
              </label>
              {(createdFrom || createdTo || captureUnknown) && (
                <IconButton
                  icon={X}
                  title={
                    "清除" +
                    (dateField === "captured" ? "拍摄" : "创建") +
                    "日期筛选"
                  }
                  onClick={() => {
                    setCreatedFrom("");
                    setCreatedTo("");
                    setCaptureUnknown(false);
                  }}
                />
              )}
              {dateField === "captured" && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={captureUnknown}
                    onChange={(e) => setCaptureUnknown(e.target.checked)}
                  />
                  拍摄时间未知
                </label>
              )}
            </div>
            </div>
            {filtersActive && (
              <div className="active-filter-bar" aria-label="当前筛选条件">
                {rootFilter.map((id) => (
                  <span className="filter-token" key={id}>
                    <FolderOpen size={13} />
                    {roots.find((r) => r.id === id)?.name || "目录"}
                    <IconButton
                      icon={X}
                      title={`取消目录筛选：${roots.find((r) => r.id === id)?.name || id}`}
                      onClick={() =>
                        setRootFilter((prev) =>
                          prev.filter((value) => value !== id),
                        )
                      }
                    />
                  </span>
                ))}
                <KeywordTokens value={q} change={setQ} mode={searchMode}/>
                {nameOnly && <span className="filter-token">仅搜索名称<IconButton icon={X} title="恢复搜索全部字段" onClick={() => setNameOnly(false)}/></span>}
                {category && (
                  <span className="filter-token">
                    {categoryLabel(category)}
                    <IconButton
                      icon={X}
                      title="取消分类筛选"
                      onClick={() => setCategory("")}
                    />
                  </span>
                )}
                {ext && (
                  <span className="filter-token">
                    {ext.toUpperCase()}
                    <IconButton
                      icon={X}
                      title="取消格式筛选"
                      onClick={() => setExt("")}
                    />
                  </span>
                )}
                {(Object.keys(tagRules) as (keyof TagRules)[]).flatMap(group => tagRules[group].map(tag => <span className="filter-token" key={group + tag}><Tag size={13}/>{{all: "包含", any: "任一", none: "排除"}[group]}：{tag}<IconButton icon={X} title={`取消${{all: "包含", any: "任一", none: "排除"}[group]}标签筛选：${tag}`} onClick={() => setTagRules(prev => ({...prev, [group]: prev[group].filter(value => value !== tag)}))}/></span>))}
                {duration && (
                  <span className="filter-token">
                    {
                      (
                        {
                          short: "少于10秒",
                          medium: "10秒至1分钟",
                          long: "超过1分钟",
                          unknown: "时长未知",
                        } as Record<string, string>
                      )[duration]
                    }
                    <IconButton
                      icon={X}
                      title="取消时长筛选"
                      onClick={() => setDuration("")}
                    />
                  </span>
                )}
                {(createdFrom || createdTo || captureUnknown) && (
                  <span className="filter-token">
                    {dateField === "captured" ? "拍摄" : "创建"}：
                    {captureUnknown
                      ? "未知"
                      : `${createdFrom || "不限"} → ${createdTo || "不限"}`}
                    <IconButton
                      icon={X}
                      title="取消日期筛选"
                      onClick={() => {
                        setCreatedFrom("");
                        setCreatedTo("");
                        setCaptureUnknown(false);
                      }}
                    />
                  </span>
                )}
                {onlyFavorites && (
                  <span className="filter-token">
                    <Star size={13} />
                    收藏
                    <IconButton
                      icon={X}
                      title="取消收藏筛选"
                      onClick={() => setOnlyFavorites(false)}
                    />
                  </span>
                )}
                <button className="text-button" onClick={() => {
                  setQ(""); setSearch(""); setSearchMode("all"); setNameOnly(false); setRootFilter([]); setCategory(""); setTagRules(emptyTagRules()); setExt(""); setDuration(""); setCreatedFrom(""); setCreatedTo(""); setCaptureUnknown(false); setOnlyFavorites(false);
                }}>重置筛选</button>
              </div>
            )}
            <div className="content-toolbar">
              <div>
                <span className="result-count" role="status">{loading ? "搜索中…" : `${total.toLocaleString()} 条结果${grouped && seriesCount ? ` · ${seriesCount} 个系列 · ${seriesEntries - seriesCount} 个独立素材` : ""}`}</span>
              </div>
              <div>
                {layout === "list" && <div className="segmented series-mode" aria-label="素材分组方式">
                  <button aria-pressed={!seriesMode} onClick={() => setSeriesMode(false)}>平铺</button>
                  <button aria-pressed={seriesMode} onClick={() => setSeriesMode(true)}>同系列分组</button>
                </div>}
                <select
                  aria-label="排序"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="name">名称排序</option>
                  <option value="revealCount">访达次数：从多到少</option>
                  <option value="projectCount">项目使用次数：从多到少</option>
                  <option value="recent">最近修改</option>
                  <option value="createdNewest">创建时间最新</option>
                  <option value="createdOldest">创建时间最早</option>
                  <option value="capturedNewest">拍摄时间最新</option>
                  <option value="capturedOldest">拍摄时间最早</option>
                  <option value="size">文件大小</option>
                </select>
                <div className="segmented">
                  <IconButton
                    icon={List}
                    title="列表视图"
                    active={layout === "list"}
                    onClick={() => setLayout("list")}
                  />
                  <IconButton
                    icon={Grid2X2}
                    title="网格视图"
                    active={layout === "grid"}
                    onClick={() => setLayout("grid")}
                  />
                </div>
                <ToolbarPopover label="显示设置" icon={Settings}>{() => <label className="check-label"><input type="checkbox" aria-label="显示完整操作" checked={!compactActions} onChange={e => setCompactActions(!e.target.checked)}/>显示完整操作</label>}</ToolbarPopover>
              </div>
            </div>
            <div className="workspace">
              <section className="results">
                {checked.size > 0 && view !== "missing" && (
                  <div className="batch-bar">
                    <span>已选 {checked.size} 项</span>
                    <IconButton icon={FolderPlus} title="批量加入当前项目" disabled={busy || checked.size > 200} onClick={() => void run(() => addToProject([...checked]))}/>
                    <IconButton
                      icon={Tag}
                      title="批量设置标签"
                      onClick={() => openOperation("tags")}
                    />
                    <IconButton
                      icon={Star}
                      title="批量收藏"
                      onClick={() =>
                        void runWith("正在处理选中的素材…", async () => {
                          await api("/batch", {
                            ids: [...checked],
                            patch: { favorite: 1 },
                          });
                          await refresh();
                          setNotice("已收藏所选素材");
                        })
                      }
                    />
                    <IconButton
                      icon={FilePenLine}
                      title="批量改名"
                      onClick={() => openOperation("rename")}
                    />
                    <IconButton
                      icon={FolderInput}
                      title="批量移动"
                      onClick={() => openOperation("move")}
                    />
                    <IconButton
                      icon={Trash2}
                      title="移入废纸篓"
                      disabled={!trashAvailable}
                      onClick={() => openOperation("trash")}
                    />
                    <button
                      className="text-button"
                      onClick={() => setChecked(new Set())}
                    >
                      取消选择
                    </button>
                  </div>
                )}
                <div className="results-body" ref={resultsBodyRef}>
                {showTableMask && maskRect && (
                  <div
                    className="table-mask"
                    role="status"
                    aria-live="polite"
                    style={{ top: maskRect.top, left: maskRect.left, width: maskRect.width, height: maskRect.height }}
                  >
                    <span className="spinner spinner-lg" aria-hidden="true" />
                    <p>正在读取…</p>
                  </div>
                )}
                {loading && !assets.length ? (
                  <div className="empty">
                    <LoaderCircle className="spin" />
                    <h3>读取素材库</h3>
                  </div>
                ) : !assets.length ? (
                  <div className="empty">
                    <Library size={40} />
                    <h3>
                      {filtersActive
                        ? "没有匹配的素材"
                        : view === "favorites"
                          ? "暂无收藏"
                          : view === "review"
                            ? "暂无待确认素材"
                            : view === "missing" ? "没有待清理的失效素材" : view === "offline"
                              ? "没有离线素材"
                              : "这里还没有素材"}
                    </h3>
                    {!filtersActive && (
                      <button
                        className="plain"
                        onClick={() => void openModal("folders")}
                      >
                        <FolderPlus size={16} />
                        管理目录
                      </button>
                    )}
                  </div>
                ) : layout === "list" ? (
                  <div className={"asset-table" + (view === "missing" ? " missing-assets" : "")}>
                    <div className="table-head">
                      <input
                        aria-label="选择当前显示的素材"
                        type="checkbox"
                        checked={allChecked}
                        onChange={() =>
                          setChecked(
                            allChecked
                              ? new Set()
                              : new Set(displayedAssets.map((a) => a.id)),
                          )
                        }
                      />
                      <span>名称</span>
                      <span>分类</span>
                      <span>时长</span>
                      <span>大小</span>
                      <span className="operations-heading">操作</span>
                    </div>
                    {(() => { const renderAsset = (a: Asset) => {
                      const Icon = kindIcons[a.kind];
                      return (
                        <div
                          key={a.id}
                          data-asset-id={a.id}
                          className={
                            "asset-row " +
                            (selected?.id === a.id ? "selected" : "")
                          }
                          onClick={() => setSelected(a)}
                        >
                          <input
                            aria-label={"选择 " + a.name}
                            type="checkbox"
                            checked={checked.has(a.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleCheck(a.id)}
                          />
                          <div className="file-cell">
                            <button
                              className={"file-icon " + a.kind}
                              title={audioAsset(a) ? "试听" : "查看素材"}
                              onClick={(e) => {
                                e.stopPropagation();
                                audioAsset(a) ? play(a) : setSelected(a);
                              }}
                            >
                              {playing?.id === a.id && auditionActive ? (
                                <Pause size={18} />
                              ) : audioAsset(a) ? (
                                <Play size={17} />
                              ) : (
                                <Icon size={18} />
                              )}
                            </button>
                            <div>
                              <button className="asset-name-button" title={a.name} onClick={(e) => { e.stopPropagation(); openAssetEditor(a); }}>{a.name}</button>
                              <span>
                                {a.ext.toUpperCase()}
                                <i>·</i>
                                {kindNames[a.kind]}
                                <i>·</i>访达 {a.reveal_count || 0} 次
                                {!!projectUsageCounts[a.id]&&<><i>·</i>已用于 {projectUsageCounts[a.id]} 个项目</>}
                                {projectMembers.some(m => m.asset_id === a.id) && <b className="project-member-badge">已加入项目</b>}
                                {!a.online && <b>离线</b>}
                                {!!a.review && (
                                  <b className="review-text">待确认</b>
                                )}
                              </span>
                              {view === "missing" && <small className="missing-file-info"><span>{a.path}</span><span>{a.file_check_reason} · 上次检查：{a.file_checked_ms ? new Date(a.file_checked_ms).toLocaleString("zh-CN") : "尚未检查"}</span></small>}
                            </div>
                          </div>
                          <div className="category-cell">
                            <span>{displayDirectoryOptions([{ category: a.category, rootId: a.root_id, rootName: roots.find(r => r.id === a.root_id)?.name, n: 1 }], allCategories)[0].category || "待确认"}</span>
                            <small>{a.sub || a.tags.join(" · ") || "—"}</small>
                          </div>
                          <span className="mono">{time(a.duration)}</span>
                          <span className="size-cell">{bytes(a.size)}</span>
                          {assetActions(a)}
                        </div>
                      );
                    }; return grouped ? <SeriesAssetList key={browseKey.current} groups={seriesGroups} assets={assets} query={assetParams().toString()} revision={seriesRevision} request={api} renderAsset={renderAsset} onVisible={setSeriesAssets} focus={seriesFocus}/> : assets.map(renderAsset); })()}
                  </div>
                ) : (
                  <div className="asset-grid">
                    {assets.map((a) => (
                      <article
                        data-asset-id={a.id}
                        className={
                          "asset-card " +
                          (selected?.id === a.id ? "selected" : "")
                        }
                        key={a.id}
                        onClick={() => setSelected(a)}
                      >
                        <div className="card-top">
                          <input
                            aria-label={"选择 " + a.name}
                            type="checkbox"
                            checked={checked.has(a.id)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={() => toggleCheck(a.id)}
                          />
                        </div>
                        {audioAsset(a) ? (
                          <div className="audio-tile">
                            <button
                              aria-label="试听"
                              onClick={(e) => {
                                e.stopPropagation();
                                play(a);
                              }}
                            >
                              <Play size={28} />
                            </button>
                            <span>{a.ext.toUpperCase()}</span>
                          </div>
                        ) : (
                          <Thumbnail asset={a} />
                        )}
                        <div className="card-info">
                          <button className="asset-name-button" title={a.name} onClick={(e) => { e.stopPropagation(); openAssetEditor(a); }}>{a.name}</button>
                          <span>
                            {kindNames[a.kind]} ·{" "}
                            {a.kind === "photo"
                              ? bytes(a.size)
                              : time(a.duration)}
                          </span>
                          {view === "missing" && <small className="missing-file-info">{a.path}<br/>{a.file_check_reason}</small>}
                        </div>
                        {assetActions(a, true)}
                      </article>
                    ))}
                  </div>
                )}
                </div>
                <footer className="pagination">
                  <span>
                    共 {total.toLocaleString()} 项
                    {grouped && <small> · {seriesEntries.toLocaleString()} 个列表条目</small>}
                    {refreshing && (
                      <span className="inline-loading" role="status">
                        <span className="spinner" aria-hidden="true" />读取中…
                      </span>
                    )}
                    {pending > 0 && (
                      <small> · {pending.toLocaleString()} 项参数读取中</small>
                    )}
                  </span>
                  <div className="pagination-options">
                    <label className="page-size-control" title={grouped ? "每条代表一个系列或独立素材；展开后的成员使用相同分页数量" : "每页显示的素材数量"}>
                      <select aria-label="每页显示数量" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1); setChecked(new Set()); setSeriesFocus(null); }}>
                        {[20,50,60,100,200].map(size => <option key={size} value={size}>{size} 条/页</option>)}
                      </select>
                    </label>
                    <PaginationControls page={page} pages={pages} change={setPage} disabled={loading || refreshing}/>
                  </div>
                </footer>
              </section>
              <aside id="asset-details" aria-label="素材详情" aria-hidden={detailsHidden} className={"details " + (selected ? "has-selection" : "")}>
                <div className="details-resizer" role="separator" aria-label="调整详情宽度" aria-orientation="vertical" aria-valuemin={280} aria-valuemax={600} aria-valuenow={detailsWidth} tabIndex={0}
                  onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); }}
                  onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) resizeDetails(e.clientX); }}
                  onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
                  onKeyDown={e => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) { e.preventDefault(); setDetailsWidth(n => e.key === "Home" ? 280 : e.key === "End" ? 600 : Math.max(280, Math.min(600, n + (e.key === "ArrowLeft" ? 20 : -20)))); } }}/>
                <div className="details-head">
                  <strong>素材详情</strong>
                    <IconButton
                      icon={X}
                      title="关闭详情"
                      onClick={() => setDetailsHidden(true)}
                    />
                </div>
                {!selected ? (
                  <div className="details-empty">
                    <Aperture size={36} />
                    <span>未选择素材</span>
                  </div>
                ) : (
                  <>
                    <div className="detail-identity">
                      <div className="detail-kicker"><span>{kindNames[selected.kind] || "素材"} / {selected.ext.toUpperCase()}</span><span className={"detail-availability " + (selected.file_status === "online" ? "online" : "")}><i/>{({ online: "文件存在", missing: "疑似失效", offline: "目录离线", unavailable: "无法访问", unknown: "未检查" } as Record<string, string>)[selected.file_status] || "未检查"}</span></div>
                      <h2 title={selected.name}>{selected.name}</h2>
                    </div>
                    <div className="preview">
                      {audioAsset(selected) ? (
                        <>
                          <div className="audio-preview">
                            <button
                              className="preview-play"
                              aria-label={playing?.id === selected.id && auditionActive ? "暂停详情试听" : "播放详情试听"}
                              title={playing?.id === selected.id && auditionActive ? "暂停试听" : "试听音频"}
                              disabled={
                                selected.ext === "ncm" || !selected.online
                              }
                              onClick={() => play(selected)}
                            >
                              {playing?.id === selected.id && auditionActive ? (
                                <Pause size={18} />
                              ) : (
                                <Play size={18} />
                              )}
                            </button>
                            <div className="detail-wave-body">{selected.ext !== "ncm" ? <Wave asset={selected}/> : <span className="detail-audio-unavailable">NCM 暂不支持试听</span>}<div className="detail-audio-time"><span>{playing?.id === selected.id && isPlaying ? "播放中" : playing?.id === selected.id ? "已暂停" : selected.ext.toUpperCase()}</span><span>{playing?.id === selected.id ? time(position) : "00:00"} / {time(selected.duration)}</span></div></div>
                          </div>
                        </>
                      ) : selected.kind === "photo" ? (
                        <button
                          className="image-preview"
                          onClick={() => setModal("zoom")}
                        >
                          <Thumbnail asset={selected} large />
                        </button>
                      ) : selected.online ? (
                        <video
                          ref={video}
                          key={selected.id + String(videoProxy)}
                          src={`/api/media/${selected.id}/${videoProxy ? "proxy" : "original"}`}
                          poster={`/api/media/${selected.id}/thumb`}
                          controls
                          preload="metadata"
                          onPlay={pauseAudition}
                          onError={() => {
                            setProxyLoading(false);
                            setMediaError(
                              videoProxy
                                ? "兼容预览失败，请检查素材文件"
                                : "当前视频无法直接播放，可生成兼容预览",
                            );
                          }}
                          onLoadedMetadata={() => setProxyLoading(false)}
                        />
                      ) : (
                        <Thumbnail asset={selected} />
                      )}
                      {mediaError && (
                        <div className="preview-error">
                          <span>{mediaError}</span>
                          <button
                            className="text-button"
                            disabled={proxyLoading || !selected.online}
                            onClick={() => {
                              setProxyLoading(true);
                              if (audioAsset(selected)) { auditionGeneration.current++; playbackIntent(true); setProxy(true); }
                              else setVideoProxy(true);
                              setMediaError("");
                              if (
                                audioAsset(selected) &&
                                playing?.id !== selected.id
                              ) {
                                playbackIntent(true); setPlaying(selected);
                              }
                            }}
                          >
                            {proxyLoading ? "预览生成中…" : "生成兼容预览"}
                          </button>
                        </div>
                      )}
                      {proxyLoading && (
                        <div className="preview-status">
                          <LoaderCircle size={15} className="spin" />
                          兼容预览生成中
                        </div>
                      )}
                    </div>
                    <div className="details-content">
                      <div className="detail-project-row"><div><small>当前项目</small><strong title={projects.find(p => p.id === activeProject)?.name || "未选择项目"}>{projects.find(p => p.id === activeProject)?.name || "未选择项目"}</strong></div><IconButton icon={projectMembers.some(m => m.asset_id === selected.id) ? Check : FolderPlus} title={projectMembers.some(m => m.asset_id === selected.id) ? "已加入当前项目" : "加入当前项目"} active={projectMembers.some(m => m.asset_id === selected.id)} disabled={busy || projectMembers.some(m => m.asset_id === selected.id)} onClick={() => void run(() => addToProject([selected.id]))}/></div>
                      <div className="detail-actions">
                        <IconButton
                          icon={Star}
                          title={selected.favorite ? "取消收藏" : "收藏"}
                          active={!!selected.favorite}
                          onClick={() =>
                            void run(() =>
                              patch(selected, { favorite: !selected.favorite }),
                            )
                          }
                        />
                        <IconButton
                          icon={ExternalLink}
                          title="在访达中显示"
                          disabled={busy}
                          onClick={() =>
                            void run(() => revealAsset(selected))
                          }
                        />
                        <IconButton
                          icon={Copy}
                          title="复制原路径"
                          onClick={() =>
                            void run(async () => {
                              await navigator.clipboard.writeText(
                                selected.path,
                              );
                              setNotice("已复制原路径");
                            })
                          }
                        />
                        <IconButton
                          icon={FilePenLine}
                          title="改名"
                          disabled={!selected.online}
                          onClick={() => {
                            setChecked(new Set());
                            setOperationIds([selected.id]);
                            setName(selected.name);
                            setPlans(null);
                            setModal("rename");
                          }}
                        />
                        <IconButton
                          icon={FolderInput}
                          title="移动"
                          disabled={!selected.online}
                          onClick={() => {
                            setChecked(new Set());
                            setOperationIds([selected.id]);
                            setTargetRoot(roots[0]?.id || "");
                            setRelative("");
                            setPlans(null);
                            setModal("move");
                          }}
                        />
                        <IconButton
                          icon={Trash2}
                          title="移入废纸篓"
                          disabled={!trashAvailable || !selected.online}
                          onClick={() => {
                            setOperationIds([selected.id]);
                            setPlans(null);
                            setModal("trash");
                          }}
                        />
                      </div>
                      <div className="detail-facts"><div><small>时长</small><strong>{time(selected.duration)}</strong></div><div><small>文件大小</small><strong>{bytes(selected.size)}</strong></div><div><small>访达次数</small><strong>{selected.reveal_count || 0}<span> 次</span></strong></div></div>
                      <details className="detail-file-info"><summary>文件信息<ChevronDown size={14}/></summary><dl>
                        <dt>文件状态</dt><dd>{({ online: "文件存在", missing: "疑似失效，待人工清理", offline: "目录离线", unavailable: "暂时无法访问", unknown: "尚未检查" } as Record<string, string>)[selected.file_status] || "尚未检查"}</dd>
                        <dt>最后检查</dt><dd>{selected.file_checked_ms ? new Date(selected.file_checked_ms).toLocaleString("zh-CN") : "尚未检查"}</dd>
                        <dt>访达打开次数</dt>
                        <dd>{selected.reveal_count || 0} 次</dd>
                        <dt>格式</dt>
                        <dd>{selected.ext.toUpperCase()}</dd>
                        <dt>文件大小</dt>
                        <dd>{bytes(selected.size)}</dd>
                        <dt>时长</dt>
                        <dd>{time(selected.duration)}</dd>
                        <dt>创建时间</dt>
                        <dd>
                          {selected.created_ms === null
                            ? "未知"
                            : new Date(selected.created_ms).toLocaleString(
                                "zh-CN",
                                { timeZone: "Asia/Shanghai", hour12: false },
                              )}
                        </dd>
                        <dt>拍摄时间</dt>
                        <dd>
                          {selected.captured_ms === null
                            ? selected.capture_status === "pending"
                              ? "读取中…"
                              : selected.capture_status === "error"
                                ? "读取失败"
                                : "未知"
                            : new Date(selected.captured_ms).toLocaleString(
                                "zh-CN",
                                { timeZone: "Asia/Shanghai", hour12: false },
                              )}
                        </dd>
                        {selected.capture_source && (
                          <>
                            <dt>时间来源</dt>
                            <dd>{selected.capture_source}</dd>
                          </>
                        )}
                        {selected.width && (
                          <>
                            <dt>尺寸</dt>
                            <dd>
                              {selected.width} × {selected.height}
                            </dd>
                          </>
                        )}
                        <dt>分类状态</dt>
                        <dd>
                          {selected.review ? "待确认" : "已归类"}
                        </dd>
                        <dt>分类依据</dt>
                        <dd>{selected.category}{selected.sub ? " / " + selected.sub : ""}</dd>
                      </dl></details>
                      {selected.error && (
                        <p className="muted-warning">{selected.error}</p>
                      )}
                      {selected.capture_error && (
                        <p className="muted-warning">
                          {selected.capture_error}
                        </p>
                      )}
                      {["photo", "video"].includes(selected.kind) && (
                        <div className="capture-edit">
                          <label className="field">
                            校正拍摄时间（北京时间）
                            <input
                              type="datetime-local"
                              aria-label="校正拍摄时间"
                              value={captureEdit}
                              onChange={(e) => setCaptureEdit(e.target.value)}
                            />
                          </label>
                          <button
                            className="plain"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await patch(selected, {
                                  capturedAt: captureEdit,
                                });
                                setNotice(
                                  captureEdit
                                    ? "已校正素材库中的拍摄时间"
                                    : "已重新读取内嵌拍摄时间",
                                );
                              })
                            }
                          >
                            保存时间
                          </button>
                        </div>
                      )}
                      <h3 className="detail-section-title">{folderView ? "属性与标记" : "分类与标记"}</h3>
                      <label className="field">
                        素材类型
                        <select
                          value={editKind}
                          onChange={(e) => setEditKind(e.target.value)}
                        >
                          {Object.entries(kindNames)
                            .filter(([k]) => k !== "mixed")
                            .map(([k, n]) => (
                              <option key={k} value={k}>
                                {n}
                              </option>
                            ))}
                        </select>
                      </label>
                      {!folderView && <CategoryPairFields key={selected.id + ":" + editRevision} category={editCategory} sub={editSub} categories={allCategories} request={api} disabled={busy}
                        categoryLabel="详情主分类" subLabel="详情子类" onChange={(parent, child) => { setEditCategory(parent); setEditSub(child); }}/>}
                      <label className="field">
                        标签
                        <input
                          placeholder="逗号分隔"
                          value={tagText}
                          onChange={(e) => setTagText(e.target.value)}
                        />
                      </label>
                      <div className="tags">
                        {selected.tags.map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </div>
                      <label className="field">
                        备注
                        <textarea
                          aria-label="详情备注"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          rows={3}
                        />
                      </label>
                      <div className="save-actions">
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await patch(selected, {
                                kind: editKind,
                                ...(!folderView ? { category: editCategory, sub: editSub } : {}),
                                tags: tagText.split(/[,，、]/),
                                note,
                              });
                              setNotice("已保存素材信息");
                            })
                          }
                        >
                          <Check size={16} />
                          保存
                        </button>
                        {!!selected.review && <button className="plain" disabled={busy || !selected.online} onClick={() => moveAsset(selected)}><FolderInput size={16}/>移动到分类</button>}
                      </div>
                      {selected.kind === "music" && (
                        <>
                          <button
                            className="plain"
                            onClick={() => setShowMusicAI(!showMusicAI)}
                          >
                            <Sparkles size={16} />
                            {showMusicAI ? "收起音乐分析" : "分析音乐属性"}
                          </button>
                          {showMusicAI && (
                            <MusicAnalysisPanel
                              key={selected.id}
                              asset={selected}
                              request={api}
                              disabled={busy}
                              adopt={(names, description) => {
                                const merged = [
                                  ...new Set([
                                    ...tagText
                                      .split(/[,，、]/)
                                      .map((t) => t.trim())
                                      .filter(Boolean),
                                    ...names,
                                  ]),
                                ];
                                if (merged.length > 40) {
                                  setError("采用后超过 40 个标签，请减少勾选");
                                  return false;
                                }
                                if (
                                  description &&
                                  (note + "\n" + description).length > 4000
                                ) {
                                  setError("备注过长，请先精简备注");
                                  return false;
                                }
                                setTagText(merged.join("，"));
                                if (description && !note.includes(description))
                                  setNote(
                                    note
                                      ? note + "\n" + description
                                      : description,
                                  );
                                return true;
                              }}
                            />
                          )}
                        </>
                      )}
                      <div className="path-box">{selected.path}</div>
                      <ProjectHistory assetId={selected.id} request={api} revision={projectRevision}/>
                    </div>
                  </>
                )}
              </aside>
            </div>
            <div className="task-status">
              {jobs.some((j) => j.status === "running") ? (
                <>
                  <LoaderCircle size={14} className="spin" />
                  {jobs.some(j => j.type === "cleanup" && j.status === "running") ? "检查素材中 · 已检查" : "扫描中 · 已发现"}{" "}
                  {jobs
                    .filter((j) => j.status === "running")
                    .reduce((n, j) => n + j.count, 0)
                    .toLocaleString()}{" "}
                  项
                </>
              ) : (
                <>
                  <span className="online-dot" />
                  索引已保存
                </>
              )}
              <button onClick={() => void openModal("folders")}>
                查看任务
              </button>
            </div>
          </div>
        )}
      </main>
      {cleanupIds && <MissingCleanupDialog key={cleanupIds.join(",")} ids={cleanupIds} request={api} close={() => setCleanupIds(null)} changed={async (result: CleanupResult) => {
        const removed = new Set(result.removedIds);
        setSelected(prev => prev && removed.has(prev.id) ? null : prev);
        setPlaying(prev => prev && removed.has(prev.id) ? null : prev);
        setChecked(prev => new Set([...prev].filter(id => !removed.has(id))));
        setEditRevision(n => n + 1); await refreshRef.current();
        setNotice(`已清理 ${result.removed} 条失效记录，元数据已备份`);
      }}/>}
      {tagAsset && <QuickTagDialog key={tagAsset.id} asset={tagAsset} request={api} close={() => setTagAsset(null)}
        changed={() => void run(async () => {
          const updated = await api<Asset>(`/assets/${tagAsset.id}`);
          syncDetailFields(updated);
          setSelected(prev => prev?.id === updated.id ? updated : prev);
          setPlaying(prev => prev?.id === updated.id ? updated : prev);
          setEditRevision(prev => prev + 1);
          await refreshRef.current();
          setNotice("素材标签已更新");
        })}/>}
      {categoryAsset && <AssetCategoryDialog key={categoryAsset.id} asset={categoryAsset} request={api}
        close={() => setCategoryAsset(null)} changed={async updated => {
          syncDetailFields(updated);
          setAssets(prev => prev.map(a => a.id === updated.id ? updated : a));
          setSelected(prev => prev?.id === updated.id ? updated : prev);
          setPlaying(prev => prev?.id === updated.id ? updated : prev);
          setEditRevision(prev => prev + 1);
          await refreshRef.current();
          setNotice(updated.review && !updated.confirmed ? "分类已保存，待确认状态保持不变" : "素材分类已保存");
        }}/>}
      {editingAsset && <AssetEditDialog
        key={editingAsset.id}
        asset={editingAsset}
        legacyCategories={!folderView}
        request={api}
        close={closeAssetEditor}
        play={play}
        changed={async (updated) => {
          syncDetailFields(updated);
          setAssets(prev => prev.map(a => a.id === updated.id ? updated : a));
          setSelected(prev => prev?.id === updated.id ? updated : prev);
          setPlaying(prev => prev?.id === updated.id ? updated : prev);
          setEditRevision(prev => prev + 1);
          await refreshRef.current();
        }}
      />}
      {quickCategory && (
        <QuickCategoryDialog
          asset={quickCategory}
          request={api}
          close={() => setQuickCategory(null)}
          changed={() => {
            void refreshRef.current().catch(fail);
            setNotice("已添加分类，原分类保留");
          }}
        />
      )}
      {playing && (
        <div ref={playerRef} className="player audition-player">
          <AuditionControls asset={playing} playing={auditionActive} position={position} length={length} volume={volume} inPoint={inPoint} outPoint={outPoint} loop={loop}
            toggle={toggleAudition} seek={seekAudition} previous={() => void stepAudition(-1)} next={() => void stepAudition(1)}
            hasPrevious={libraryView && !stepping && (grouped ? total > 1 : (auditionIndex > 0 || page > 1 || (auditionIndex < 0 && auditionQueue.length > 0)))}
            hasNext={libraryView && !stepping && (grouped ? total > 1 : (auditionIndex < auditionQueue.length - 1 || page < pages))}
            setVolume={setVolume} setRange={auditionRange} setLoop={changeLoop}
            continuous={continuous} setContinuous={changeContinuous} canContinue={libraryView}
            favorite={() => void run(async () => { const current = await api<Asset>("/assets/" + playing.id); const updated = await api<Asset>("/assets/" + playing.id, { favorite: !current.favorite }, "PATCH"); setPlaying(updated); await refreshRef.current(); })}
            close={() => { pauseAudition(); setPlaying(null); setLoop(false); setMediaError(""); }}/>
          {mediaError && <div className="audition-error" role="alert"><span>{mediaError}</span><button className="text-button" disabled={proxyLoading || proxy} onClick={() => { auditionGeneration.current++; playbackIntent(true); setProxyLoading(true); setMediaError(""); setProxy(true); }}>生成兼容预览</button></div>}
          <audio
            ref={audio}
            src={`/api/media/${playing.id}/${proxy ? "proxy" : "original"}`}
            onPlay={() => { if (!wantsPlayback.current) { audio.current?.pause(); return; } setIsPlaying(true); }}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={() => { const el = audio.current; if (el && loop && outPoint > inPoint && el.currentTime >= outPoint) el.currentTime = inPoint; setPosition(el?.currentTime || 0); }}
            onEnded={() => {
              setIsPlaying(false);
              if (!wantsPlayback.current) return;
              if (loop && outPoint > inPoint && audio.current) { audio.current.currentTime = inPoint; resumeAudition(); }
              else if (continuous && libraryView) {
                const generation = auditionGeneration.current;
                void stepAudition(1, true).then(advanced => {
                  if (!advanced && generation === auditionGeneration.current && audio.current?.ended) playbackIntent(false);
                });
              } else playbackIntent(false);
            }}
            onLoadedMetadata={() => {
              setLength(
                Number.isFinite(audio.current?.duration)
                  ? audio.current!.duration
                  : 0,
              );
              const duration = Number.isFinite(audio.current?.duration) ? audio.current!.duration : 0;
              setOutPoint(prev => prev > 0 ? Math.min(prev, duration) : duration);
              setInPoint(prev => Math.min(prev, Math.max(0, duration - 0.05)));
              setProxyLoading(false);
            }}
            onError={() => {
              pauseAudition();
              setProxyLoading(false);
              setMediaError(
                proxy
                  ? "兼容预览失败，请检查素材文件"
                  : "浏览器无法直接播放，可生成兼容预览",
              );
            }}
          />
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          {notice}
        </div>
      )}
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            className={"modal " + (modal === "zoom" ? "zoom-modal" : modal === "move" ? "move-modal" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={
              {
                folders: "素材目录与任务",
                history: "操作记录",
                settings: "设置与缓存",
                rename: "重命名素材",
                move: "移动素材",
                trash: "移入废纸篓",
                tags: "批量标签",
                zoom: "照片预览",
              }[modal]
            }
          >
            <div className="modal-head">
              <h2>
                {
                  {
                    folders: "素材目录与任务",
                    history: "操作记录",
                    settings: "设置与缓存",
                    rename: "重命名素材",
                    move: "移动素材",
                    trash: "移入废纸篓",
                    tags: "批量设置标签",
                    zoom: "照片预览",
                  }[modal]
                }
              </h2>
              <IconButton
                icon={X}
                title="关闭窗口"
                disabled={busy}
                onClick={() => setModal(null)}
              />
            </div>
            <div className="modal-body">
              {modal === "folders" && (
                <>
                  <div className="add-folder">
                    <select
                      aria-label="新增目录类型"
                      value={folderKind}
                      onChange={(e) => setFolderKind(e.target.value)}
                    >
                      {Object.entries(kindNames).map(([k, n]) => (
                        <option key={k} value={k}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <button
                      className="primary"
                      disabled={busy || !folderPickerAvailable}
                      title={folderPickerAvailable ? "选择素材文件夹" : "此平台请使用下方绝对路径添加目录"}
                      onClick={() =>
                        void run(async () => {
                          await api("/folders/choose", { kind: folderKind });
                          await refresh();
                          setNotice("已登记目录，开始扫描"); await loadAllRoots();
                        })
                      }
                    >
                      <FolderPlus size={17} />
                      {busy ? "等待文件夹选择…" : "选择文件夹"}
                    </button>
                  </div>
                  <div className="folder-path-entry"><input aria-label="素材文件夹绝对路径" placeholder="输入素材文件夹绝对路径" value={folderPath} onChange={e => setFolderPath(e.target.value)}/><button className="plain" disabled={busy || !folderPath.trim()} onClick={() => void run(async () => { await api("/roots", { path: folderPath.trim(), kind: folderKind }); setFolderPath(""); await refresh(); await loadAllRoots(); setNotice("已登记目录，开始扫描"); })}><FolderPlus size={16}/>添加路径</button></div>
                  {allRoots.map((r) => (
                    <div className={"folder-record" + (r.retired ? " is-retired" : "")} key={r.id}>
                      <FolderOpen size={21} />
                      <div>
                        <strong>
                          {r.name}
                          {!r.retired && <small>{kindNames[r.kind]}</small>}
                        </strong>
                        <p>{r.path}</p>
                        <span>{r.retired ? "已注销（可恢复）" : r.online ? "在线" : "离线"}</span>
                        <small className="root-management-info">{r.managed_added_ms ? `加入管理：${new Date(r.managed_added_ms).toLocaleString("zh-CN")}` : "历史加入时间未知"}{r.management_order ? ` · 保留顺序 ${r.management_order}` : ""}</small>
                      </div>
                      <div className="folder-actions">
                        {!r.retired && (
                          <button
                            className="plain"
                            disabled={busy || rootScanning(r.id)}
                            onClick={() =>
                              void runWith("正在扫描素材目录…", async () => {
                                await api("/roots/" + r.id + "/scan", {});
                                await refresh();
                              })
                            }
                          >
                            {rootScanning(r.id) ? (
                              <>
                                <span className="spinner" aria-hidden="true" />
                                扫描中…
                              </>
                            ) : (
                              <>
                                <RefreshCw size={15} />
                                重新扫描
                              </>
                            )}
                          </button>
                        )}
                        <button
                          className="plain"
                          disabled={busy}
                          title="改显示名、改目录类型，或填入新位置完成迁移"
                          onClick={() => setRootEdit(rootEdit?.id === r.id ? null : { id: r.id, name: r.name, kind: r.kind, path: r.path })}
                        >
                          <Pencil size={15} />
                          {r.retired ? "查看" : "编辑"}
                        </button>
                        {r.retired ? (
                          <>
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await api("/roots/" + r.id + "/restore", {});
                                  await loadAllRoots();
                                  await refresh();
                                  setNotice("已恢复登记，并开始重新扫描");
                                })
                              }
                            >
                              <RotateCcw size={15} />
                              恢复
                            </button>
                            <button
                              className="plain"
                              disabled={busy}
                              title="仅在该目录名下已无素材索引时可用"
                              onClick={() =>
                                void run(async () => {
                                  if (!window.confirm(`彻底删除「${r.name}」的登记记录？\n\n只删除登记与索引记录，不会删除任何文件；该目录名下必须已无素材索引，否则会被拒绝。`)) return;
                                  await api("/roots/" + r.id, {}, "DELETE");
                                  await loadAllRoots();
                                  setNotice("已彻底删除该目录的登记");
                                })
                              }
                            >
                              <Trash2 size={15} />
                              彻底删除
                            </button>
                          </>
                        ) : (
                          <button
                            className="plain"
                            disabled={busy}
                            title="不再扫描与监听这个目录；文件与素材标签都保留，可随时恢复"
                            onClick={() =>
                              void run(async () => {
                                if (!window.confirm(`仅注销「${r.name}」？\n\n· 不会删除任何文件\n· 不会删除素材的标签、备注与项目关联\n· 该目录将不再被扫描与监听，之后可随时恢复`)) return;
                                await api("/roots/" + r.id + "/retire", {});
                                if (playing?.root_id === r.id) { pauseAudition(); setPlaying(null); }
                                setSelected(prev => prev?.root_id === r.id ? null : prev);
                                setEditingAsset(prev => prev?.root_id === r.id ? null : prev);
                                setChecked(new Set());
                                setRootFilter(prev => prev.filter(id => id !== r.id));
                                if (allCategories.some(c => c.id === category && c.rootId === r.id)) setCategory("");
                                setPage(1);
                                setEditRevision(n => n + 1);
                                await loadAllRoots();
                                await refresh();
                                setNotice("已注销，该目录素材已隐藏，文件与标签保留，可恢复");
                              })
                            }
                          >
                            <Power size={15} />
                            注销
                          </button>
                        )}
                      </div>
                      {!r.retired && !r.online && (
                        <p className="folder-warn">
                          ⚠️ 这个目录现在找不到（可能被改名、搬走或磁盘未挂载）。文件与素材标签都没有被改动：
                          在「编辑」里填入它的新位置即可完成迁移（保持同一批素材与全部属性），或选择「注销」。
                        </p>
                      )}
                      {rootEdit?.id === r.id && (
                        <div className="folder-edit">
                          <label>
                            显示名
                            <input aria-label="目录显示名" value={rootEdit.name} onChange={(e) => setRootEdit({ ...rootEdit, name: e.target.value })} />
                          </label>
                          <label>
                            目录类型
                            <select aria-label="目录类型" value={rootEdit.kind} onChange={(e) => setRootEdit({ ...rootEdit, kind: e.target.value })}>
                              {Object.entries(kindNames).map(([k, n]) => (
                                <option key={k} value={k}>{n}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            目录绝对路径（改动即为迁移：保持同一批素材与全部标签）
                            <input aria-label="目录绝对路径" value={rootEdit.path} onChange={(e) => setRootEdit({ ...rootEdit, path: e.target.value })} />
                          </label>
                          <div className="folder-edit-actions">
                            <button
                              className="primary"
                              disabled={busy || !rootEdit.name.trim() || !rootEdit.path.trim()}
                              onClick={() =>
                                void runWith("正在迁移目录位置…", async () => {
                                  const next = rootEdit.path.trim();
                                  const moved = next !== r.path;
                                  const metaChanged = rootEdit.name !== r.name || rootEdit.kind !== r.kind;
                                  if (metaChanged) await api("/roots/" + r.id, { name: rootEdit.name, kind: rootEdit.kind }, "PATCH");
                                  if (moved) {
                                    let answer = await api<RelocateResult>("/roots/" + r.id + "/relocate", { path: next });
                                    if (answer.needsConfirm) {
                                      const detail = (answer.warnings || []).map((w) => "· " + w).join("\n");
                                      const percent = Math.round((answer.matchRatio ?? 0) * 100);
                                      if (!window.confirm(`迁移前检查发现异常：\n\n${detail}\n\n重合度 ${percent}%（${answer.matched}/${answer.total}）\n目标：${answer.newPath}\n\n仍然迁移？`)) return;
                                      answer = await api<RelocateResult>("/roots/" + r.id + "/relocate", { path: next, confirm: true });
                                    }
                                    const rep = answer.report;
                                    setNotice(
                                      answer.ok === false
                                        ? `迁移完成但需核对：失联 ${rep?.missing ?? 0}、冲突 ${rep?.conflicts ?? 0}${answer.rolledBack ? "（已回滚到原路径）" : ""}`
                                        : `迁移完成：认领 ${rep?.adopted ?? 0}、新增 ${rep?.added ?? 0}、零冲突`,
                                    );
                                  } else if (metaChanged) setNotice("已更新目录信息");
                                  setRootEdit(null);
                                  await loadAllRoots();
                                  await refresh();
                                })
                              }
                            >
                              保存
                            </button>
                            <button className="plain" onClick={() => setRootEdit(null)}>取消</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                  <h3>最近任务</h3>
                  {!jobs.length && <p className="muted">暂无扫描任务</p>}
                  {jobs.map((j) => (
                    <div className="job" key={j.id}>
                      {j.status === "running" && <span className="spinner" aria-hidden="true" />}
                      <strong>
                        {allRoots.find((r) => r.id === j.rootId)?.name ||
                          roots.find((r) => r.id === j.rootId)?.name ||
                          "素材扫描"}
                      </strong>
                      <span>
                        {
                          (
                            {
                              running: "扫描中",
                              done: "完成",
                              partial: "部分完成",
                              failed: "失败",
                            } as Record<string, string>
                          )[j.status]
                        }{" "}
                        · {j.count.toLocaleString()} 项
                      </span>
                      {!!j.errors?.length && (
                        <details>
                          <summary>{j.errors.length} 条问题</summary>
                          {j.errors.map((e, i) => (
                            <p key={i}>{e}</p>
                          ))}
                        </details>
                      )}
                    </div>
                  ))}
                  {pending > 0 && (
                    <p className="muted">
                      媒体参数读取队列：{pending.toLocaleString()} 项
                    </p>
                  )}
                </>
              )}
              {modal === "history" && (
                <>
                  <MetadataBatchHistory request={api} runTask={runWith} changed={() => { setEditRevision(n => n + 1); void refreshRef.current().catch(fail); }}/>
                  <h3 className="file-history-heading">文件操作记录</h3>
                  {!ops.length ? (
                    <div className="empty">
                      <History size={32} />
                      <h3>暂无文件操作</h3>
                    </div>
                  ) : (
                    ops.map((o) => (
                      <div className="operation" key={o.id}>
                        <div className="operation-title">
                          <strong>
                            {{
                              rename: "改名",
                              move: "移动",
                              trash: "移入废纸篓",
                            }[o.action] || o.action}
                          </strong>
                          <span>
                            {o.undone
                              ? "已撤销"
                              : (
                                  {
                                    done: "完成",
                                    failed: "失败",
                                    interrupted: "中断，需核对",
                                    pending: "处理中",
                                  } as Record<string, string>
                                )[o.status]}
                          </span>
                          <small>
                            {new Date(o.created_at).toLocaleString("zh-CN")}
                          </small>
                        </div>
                        <p>{o.source}</p>
                        <p className="target-path">
                          → {o.target || "系统废纸篓"}
                        </p>
                        {o.error && <p className="muted-warning">{o.error}</p>}
                        {o.status === "done" && !o.undone && (
                          <button
                            className="plain"
                            disabled={busy}
                            onClick={() => {
                              if (
                                window.confirm(
                                  "将恢复至原位置。原位置如已有同名文件则取消，是否继续？",
                                )
                              )
                                void run(async () => {
                                  await api(
                                    "/operations/" + o.id + "/undo",
                                    {},
                                  );
                                  await loadHistory();
                                  await refresh();
                                  setEditRevision(prev => prev + 1);
                                  setNotice("已恢复文件");
                                });
                            }}
                          >
                            <Undo2 size={15} />
                            撤销
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </>
              )}
              {modal === "settings" && (
                <>
                  <OpenAISettings request={api} />
                  <details className="cloud-advanced">
                    <summary>高级云端设置（诊断 / 配置）</summary>
                    <CloudConnectionSettings request={api} onChanged={() => void cloudAuth.readStatus().catch(() => undefined)} />
                  </details>
                  <section className="database-settings">
                    <div className="database-heading">
                      <h3>
                        <Database size={18} />
                        本机 MySQL
                      </h3>
                      <span
                        className={
                          "database-status " +
                          (mysqlState?.status === "error"
                            ? "error"
                            : mysqlState?.status === "ready"
                              ? "ready"
                              : "")
                        }
                      >
                        {
                          (
                            {
                              disabled: "未启用",
                              pending: "等待同步",
                              syncing: "迁移中",
                              ready: "MySQL 主数据库",
                              paused: "自动同步暂停",
                              error: "连接异常",
                            } as Record<string, string>
                          )[mysqlState?.status || "disabled"]
                        }
                      </span>
                    </div>
                    <div className="database-form">
                      <label className="field">
                        地址
                        <select
                          aria-label="MySQL 地址"
                          value={mysqlForm.host}
                          onChange={(e) =>
                            setMysqlForm({ ...mysqlForm, host: e.target.value })
                          }
                        >
                          <option value="127.0.0.1">127.0.0.1</option>
                          <option value="localhost">localhost</option>
                          <option value="::1">::1</option>
                        </select>
                      </label>
                      <label className="field">
                        端口
                        <input
                          aria-label="MySQL 端口"
                          type="number"
                          min="1"
                          max="65535"
                          value={mysqlForm.port}
                          onChange={(e) =>
                            setMysqlForm({
                              ...mysqlForm,
                              port: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        数据库
                        <input
                          aria-label="MySQL 数据库"
                          value={mysqlForm.database}
                          onChange={(e) =>
                            setMysqlForm({
                              ...mysqlForm,
                              database: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        用户名
                        <input
                          aria-label="MySQL 用户名"
                          autoComplete="off"
                          value={mysqlForm.user}
                          onChange={(e) =>
                            setMysqlForm({ ...mysqlForm, user: e.target.value })
                          }
                        />
                      </label>
                      <label className="field database-password">
                        密码（仅本机保存）
                        <input
                          aria-label="MySQL 密码"
                          type="password"
                          autoComplete="new-password"
                          placeholder={
                            mysqlState?.config.hasPassword
                              ? "已保存；留空保留原密码"
                              : ""
                          }
                          value={mysqlForm.password}
                          onChange={(e) =>
                            setMysqlForm({
                              ...mysqlForm,
                              password: e.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    <div className="database-actions">
                      <button
                        className="plain"
                        disabled={busy || mysqlState?.status === "syncing"}
                        onClick={() =>
                          databaseAction(async () => {
                            await api("/mysql/test", {
                              ...mysqlForm,
                              password: mysqlForm.password || undefined,
                            });
                            setNotice("MySQL 连接成功");
                          })
                        }
                      >
                        <Database size={15} />
                        测试连接
                      </button>
                      <button
                        className="primary"
                        disabled={
                          busy ||
                          mysqlState?.status === "syncing" ||
                          mysqlState?.mode === "mysql"
                        }
                        onClick={() =>
                          databaseAction(async () => {
                            const state = await api<MysqlState>(
                              "/mysql/config",
                              {
                                ...mysqlForm,
                                password: mysqlForm.password || undefined,
                              },
                            );
                            setMysqlState(state);
                            setMysqlForm((prev) => ({ ...prev, password: "" }));
                            setNotice("数据已迁移，MySQL 已成为主数据库");
                          })
                        }
                      >
                        <Check size={15} />
                        迁移并启用 MySQL
                      </button>
                    </div>
                    {mysqlState?.error && (
                      <p className="database-error" role="alert">
                        {mysqlState.error}
                      </p>
                    )}
                    {mysqlFeedback && (
                      <p className="database-error" role="alert">
                        {mysqlFeedback}
                      </p>
                    )}
                    <dl className="database-summary">
                      <dt>主数据库</dt>
                      <dd>
                        {mysqlState?.mode === "mysql"
                          ? `MySQL · ${mysqlState.config.database}`
                          : "SQLite（尚未迁移）"}
                      </dd>
                      <dt>迁移时间</dt>
                      <dd>
                        {mysqlState?.lastSync
                          ? new Date(mysqlState.lastSync).toLocaleString(
                              "zh-CN",
                              { timeZone: "Asia/Shanghai" },
                            )
                          : "尚未迁移"}
                      </dd>
                      <dt>已写入</dt>
                      <dd>
                        {mysqlState?.counts
                          ? `${mysqlState.counts.assets.toLocaleString()} 条素材 · ${mysqlState.counts.roots} 个目录 · ${mysqlState.counts.operations} 条操作`
                          : "—"}
                      </dd>
                    </dl>
                  </section>
                  <dl className="settings-list">
                    <dt>存储方式</dt>
                    <dd>
                      {mysqlState?.mode === "mysql"
                        ? "本机 MySQL（唯一读写数据库）"
                        : "本机 SQLite 索引"}
                    </dd>
                    <dt>原素材</dt>
                    <dd>保留在登记目录</dd>
                    <dt>预览缓存</dt>
                    <dd>
                      {cache.files} 个文件 · {bytes(cache.bytes)}
                    </dd>
                    <dt>废纸篓</dt>
                    <dd>
                      {trashAvailable
                        ? "Mac 原生组件可用"
                        : "不可用，删除已禁用"}
                    </dd>
                  </dl>
                  <button
                    className="plain"
                    disabled={busy || cache.active > 0}
                    onClick={() => {
                      if (
                        window.confirm(
                          "仅删除生成的预览缓存，不影响原素材，是否继续？",
                        )
                      )
                        void runWith("正在清理缓存…", async () => {
                          await api("/cache/clear", {});
                          setCache(await api("/cache"));
                          setNotice("已清理预览缓存");
                        });
                    }}
                  >
                    <Trash2 size={16} />
                    清理预览缓存
                  </button>
                </>
              )}
              {modal === "zoom" && selected && (
                <Thumbnail asset={selected} large />
              )}
              {modal === "tags" && (
                <>
                  <p>
                    替换所选 {operationIds.length} 个素材的标签，不改动原文件。
                  </p>
                  <label className="field">
                    标签
                    <input
                      value={batchTags}
                      placeholder="逗号分隔"
                      onChange={(e) => setBatchTags(e.target.value)}
                    />
                  </label>
                </>
              )}
              {["rename", "move", "trash"].includes(modal) && (
                <>
                  <p className="operation-summary">
                    所选 {operationIds.length} 个素材
                    {modal === "trash"
                      ? "将移入系统废纸篓，可在操作记录中恢复。"
                      : "将修改原文件。请先核对下方路径。"}
                  </p>
                  {modal === "trash" && operationIds.length === 1 && <p className="trash-file-name">{assets.find(a => a.id === operationIds[0])?.name || (selected?.id === operationIds[0] ? selected.name : operationIds[0])}</p>}
                  {modal === "rename" &&
                    (operationIds.length === 1 ? (
                      <label className="field">
                        新文件名（保留扩展名）
                        <input
                          value={name}
                          onChange={(e) => {
                            setName(e.target.value);
                            setPlans(null);
                          }}
                        />
                      </label>
                    ) : (
                      <label className="field">
                        给原文件名增加前缀
                        <input
                          value={prefix}
                          onChange={(e) => {
                            setPrefix(e.target.value);
                            setPlans(null);
                          }}
                        />
                      </label>
                    ))}
                  {modal === "move" && (
                    <MoveDestinationPicker roots={roots} rootId={targetRoot} directory={relative} api={api} disabled={busy}
                      onReady={setDestinationReady} onCreated={() => setEditRevision(n => n + 1)}
                      onChange={(root, directory) => {
                        setTargetRoot(root); setRelative(directory); setPlans(null); setConfirmation(""); setDestinationReady(false);
                      }} />
                  )}
                  {plans && (
                    <div className="plans">
                      {plans.map((p) => (
                        <div
                          className={"plan " + (!p.ok ? "failed" : "")}
                          key={p.id}
                        >
                          <strong>{p.name || p.id}</strong>
                          {p.ok ? (
                            <>
                              <p>{p.source}</p>
                              <p>→ {p.target || "系统废纸篓"}</p>
                              {p.warning && <p className="muted-warning">{p.warning}</p>}
                            </>
                          ) : (
                            <p>{p.error}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {error && (
                <div className="banner error" role="alert">
                  <CircleAlert size={16} />
                  <span>{error}</span>
                </div>
              )}
            </div>
            {["rename", "move", "trash", "tags"].includes(modal) && (
              <div className="modal-footer">
                <button
                  className="plain"
                  disabled={busy}
                  onClick={() => setModal(null)}
                >
                  取消
                </button>
                {modal === "tags" ? (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<(Plan & { asset?: Asset })[]>(
                          "/batch",
                          {
                            ids: operationIds,
                            patch: { tags: batchTags.split(/[,，、]/) },
                          },
                        );
                        const bad = result.filter((p) => !p.ok);
                        if (bad.length)
                          throw Error(bad.map((p) => p.error).join("；"));
                        const updated = result.find(
                          (p) => p.id === selected?.id,
                        )?.asset;
                        if (updated) {
                          setSelected(updated);
                          setTagText(updated.tags.join("，"));
                        }
                        await refresh();
                        setModal(null);
                        setNotice("已更新标签");
                      })
                    }
                  >
                    保存标签
                  </button>
                ) : !plans || !confirmation ? (
                  <button
                    className="primary"
                    disabled={busy || (modal === "move" && !destinationReady)}
                    onClick={() =>
                      void run(async () => {
                        const result = await api<{
                          items: Plan[];
                          confirmation: string;
                        }>("/operations/preview", operationInput());
                        setPlans(result.items);
                        setConfirmation(result.confirmation);
                      })
                    }
                  >
                    检查目标路径
                  </button>
                ) : (
                  <button
                    className={modal === "trash" ? "danger" : "primary"}
                    disabled={busy || !plans.some((p) => p.ok) || (modal === "move" && !destinationReady)}
                    onClick={() =>
                      void runWith(modal === "move" ? "正在移动素材…" : modal === "trash" ? "正在移入废纸篓…" : "正在重命名素材…", async () => {
                        pauseAudition();
                        video.current?.pause();
                        const result = await api<Plan[]>("/operations", {
                          confirmation,
                        });
                        setConfirmation("");
                        setPlans(result);
                        await refresh();
                        setEditRevision(prev => prev + 1);
                        const ok = result.filter((p) => p.ok).length;
                        const warning = result.find(p => p.warning)?.warning;
                        const removed = Math.max(0, ...result.map(p => p.duplicateTagsRemoved || 0));
                        setChecked(new Set());
                        if (playing && operationIds.includes(playing.id))
                          setPlaying(null);
                        if (selected && operationIds.includes(selected.id))
                          setSelected(null);
                        else if (selected && removed) {
                          const fresh = await api<Asset>("/assets/" + selected.id);
                          setSelected(prev => prev?.id === fresh.id ? { ...prev, tags: fresh.tags } : prev);
                          setTagText(fresh.tags.join("，"));
                        }
                        if (result.every((p) => p.ok)) {
                          setModal(null);
                          setNotice(`已完成 ${ok} 项操作${removed ? `，已移除 ${removed} 个素材的重复音频标签` : ""}`);
                          if (warning) setError(warning);
                        } else
                          setError(
                            `已完成 ${ok} 项，${result.length - ok} 项未完成，请查看结果。`,
                          );
                      })
                    }
                  >
                    {busy
                      ? "处理中…"
                      : `确认${modal === "trash" ? "移入废纸篓" : modal === "move" ? "移动" : "改名"}`}
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      )}
      {/* 首次读取素材库：全屏转圈，避免看到空壳 */}
      {!ready && (
        <div className="work-overlay" role="status" aria-live="polite">
          <div className="work-card">
            <span className="spinner spinner-lg" aria-hidden="true" />
            <p>正在读取素材库…</p>
          </div>
        </div>
      )}
      {/* 正在处理：遮罩挡住点击（按钮同时被 busy 禁用），并显示在做什么 */}
      {showWork && (
        <div className="work-overlay" role="status" aria-live="polite">
          <div className="work-card">
            <span className="spinner spinner-lg" aria-hidden="true" />
            <p>{workLabels[workLabels.length - 1] || "正在处理…"}</p>
          </div>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
