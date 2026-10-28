import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  KeyRound,
  LoaderCircle,
  Monitor,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Undo2,
  Upload,
  ListChecks,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { describeFailure, displayTime, type CloudAuthController, type CloudLastError } from "./cloud-auth";
import { CloudUploadApprovalSettings } from "./CloudUploadApprovalSettings";
import { CloudAudioDownload } from "./CloudAudioDownload";
import type { LocalRequest } from "./OpenAISettings";

/**
 * T-LOCAL-008：账户 / 小组 / 授权管理工作区。
 *
 * - 浏览器只提交业务参数；方法、云端路径、mTLS/Bearer 全由本地 Node 固定。
 * - 一次性开通码/重置码只在当前组件内存展示，支持点击复制，绝不写 localStorage、
 *   sessionStorage、URL 或日志；切换页签/离开工作区/退出即清空。
 * - 云端能力只用于显示入口，真正的鉴权仍在 Java；403 重新读取能力，409 提示重读。
 * - 每个异步结果都带代次，退出/换账户后迟到的旧列表不会混进新账户。
 */

type Me = {
  accountId: string;
  username: string;
  displayName: string;
  deviceId: string;
  sessionId: string;
  superAdmin: boolean;
};
type Device = {
  id: string;
  name: string;
  state: string;
  certificateExpiresAt: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
};
type GroupCapability = {
  groupId: string;
  name: string;
  state: string;
  leader: boolean;
  canReadShared: boolean;
  permissions: string[];
};
type Capabilities = {
  superAdmin: boolean;
  systemPermissions: string[];
  groups: GroupCapability[];
};
type Profile = { me: Me; capabilities: Capabilities; devices: Device[] };
type Group = { id: string; name: string; leaderAccountId: string; state: string; version: number };
type Member = {
  accountId: string;
  state: string;
  username: string | null;
  displayName: string | null;
  memberState: string | null;
  accountState: string | null;
};
type Account = {
  id: string;
  username: string;
  displayName: string;
  state: string;
  securityVersion: number;
  createdAt: string | null;
  superAdmin: boolean;
};
type Page<T> = { items: T[]; total: number; limit: number; offset: number };
type Permission = { code: string; scopeType: string; customAssignable: boolean };
type Role = { id: string; code: string; name: string; scopeType: string; builtIn: boolean; version: number };
type RoleView = { role: Role; permissions: string[] };
type Impact = {
  totalAssignments: number;
  assignments: Assignment[];
  limit: number;
  offset: number;
  hasMore: boolean;
};
type Assignment = {
  id: string;
  accountId: string;
  roleId: string;
  scopeType: string;
  scopeKey: string;
  groupId: string | null;
  grantedBy: string | null;
};
type Candidate = { id: string; username: string; displayName: string };
type Opening = { id: string; accountId: string; username: string; openingCode: string; expiresAt: string };
type Reset = { resetToken: string; accountId: string; expiresAt: string };
type AuditEvent = {
  id: string;
  actorAccountId: string;
  eventType: string;
  targetId: string;
  createdAt: string | null;
};

const PAGE_SIZE = 20;
const RESERVED_ROLES = new Set(["SUPER_ADMIN", "GROUP_LEADER", "GROUP_MEMBER"]);
const PERMISSION_GROUP_LABELS: Record<string, string> = {
  account: "账户",
  group: "小组",
  media: "媒体",
  role: "角色",
  audit: "审计",
  device: "设备",
  system: "系统",
};

function permissionGroupLabel(prefix: string): string {
  return PERMISSION_GROUP_LABELS[prefix] || prefix;
}

function failureText(error: unknown): string {
  const failure = error as CloudLastError;
  const code = String(failure?.code || "");
  if (code === "VERSION_CONFLICT") return "数据已被其他人更新：请重新读取最新值后重做，界面不会自动覆盖。";
  if (code === "IDEMPOTENCY_CONFLICT") return "该请求与原请求参数不一致，请重新发起。";
  if (code === "STALE") return "本次结果已过期（账户或页面已切换），已丢弃。";
  return describeFailure(failure, "settings");
}

function stateText(state: string | null): string {
  switch (state) {
    case "ACTIVE":
      return "启用";
    case "DISABLED":
      return "停用";
    case "PENDING":
      return "待激活";
    case "REVOKED":
      return "已撤销";
    case "NEEDS_LEADER":
      return "需指定负责人";
    default:
      return state || "—";
  }
}

function Badge({ kind, children }: { kind?: "ok" | "warn" | "danger" | "muted"; children: ReactNode }) {
  return <span className={"cw-badge" + (kind ? ` ${kind}` : "")}>{children}</span>;
}

function Notice({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null;
  return (
    <p className={error ? "cw-error" : "cw-success"} role={error ? "alert" : "status"}>
      {error || success}
    </p>
  );
}

function Pager({
  offset,
  limit,
  total,
  onChange,
}: {
  offset: number;
  limit: number;
  total: number;
  onChange: (offset: number) => void;
}) {
  const page = Math.floor(offset / Math.max(1, limit)) + 1;
  const pages = Math.max(1, Math.ceil(total / Math.max(1, limit)));
  return (
    <div className="cw-pager">
      <button
        type="button"
        className="plain"
        aria-label="上一页"
        title="上一页"
        disabled={offset <= 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        <ChevronLeft size={15} />
      </button>
      <span>
        第 {page} / {pages} 页 · 共 {total} 条
      </span>
      <button
        type="button"
        className="plain"
        aria-label="下一页"
        title="下一页"
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        <ChevronRight size={15} />
      </button>
    </div>
  );
}

function OneTimeSecret({
  title,
  code,
  expiresAt,
  onDismiss,
  extra,
}: {
  title: string;
  code: string;
  expiresAt: string | null;
  onDismiss: () => void;
  extra?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="cw-secret" role="status">
      <div className="cw-secret-head">
        <strong>
          <KeyRound size={15} /> {title}
        </strong>
        <button type="button" className="plain cw-icon-button" aria-label="关闭一次性码" title="关闭一次性码" onClick={onDismiss}>
          <X size={15} />
        </button>
      </div>
      <code>{code}</code>
      <div className="cw-secret-foot">
        <span>仅本次显示，{expiresAt ? `${displayTime(expiresAt)} 前有效` : "请立即保存"}；不会写入浏览器存储。</span>
        <div>
          <button type="button" className="plain" onClick={() => void copy()}>
            <Copy size={14} /> {copied ? "已复制" : "复制"}
          </button>
          {extra}
        </div>
      </div>
    </div>
  );
}

export function CloudWorkspace({
  auth,
  request,
  onBack,
  onLogin,
  onNotice,
  onOpenUploadTasks,
  initialTab = "security",
}: {
  auth: CloudAuthController;
  request: LocalRequest;
  onBack: () => void;
  onLogin: () => void;
  onNotice: (message: string) => void;
  onOpenUploadTasks?: () => void;
  initialTab?: "security" | "audio";
}) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const profileRef = useRef<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"security" | "groups" | "audio" | "accounts" | "roles" | "audit" | "upload-settings" | "audio-maintenance">(initialTab);
  const generation = useRef(0);
  /** 只读最新 controller，避免把整个 auth 对象放进 effect 依赖导致父级重渲染即重取。 */
  const authRef = useRef(auth);
  authRef.current = auth;
  /** 同代次并发的资料读取合并成一个 promise；完成/失败后清理。 */
  const inflightProfile = useRef<{ epoch: number; seq: number; promise: Promise<void> } | null>(null);
  /** 每次真正发起 profile 读取都递增；旧请求即使晚到也不能覆盖新结果。 */
  const profileSeq = useRef(0);
  const viewState = auth.view?.state;
  const accountKey = auth.view?.accountId || "";
  const signedIn = viewState === "logged-in";
  const maintenanceIdentityFields = [auth.view?.originHost, auth.view?.accountId, auth.view?.deviceId, auth.view?.sessionId];
  const maintenanceIdentitySource = signedIn && maintenanceIdentityFields.every(v => typeof v === "string" && v.length > 0 && v.length <= 512) ? JSON.stringify(maintenanceIdentityFields) : null;
  const [maintenanceIdentity, setMaintenanceIdentity] = useState<{source: string; digest: string} | null>(null);
  useEffect(() => {
    let current = true;
    if (maintenanceIdentitySource) void crypto.subtle.digest("SHA-256", new TextEncoder().encode(maintenanceIdentitySource)).then(bytes => {
      if (current) setMaintenanceIdentity({ source: maintenanceIdentitySource, digest: Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("") });
    }).catch(() => { if (current) setMaintenanceIdentity(null); });
    return () => { current = false; };
  }, [maintenanceIdentitySource]);

  useEffect(() => {
    generation.current += 1;
    profileSeq.current += 1;
    inflightProfile.current = null;
    // 切账号/退出/重新登录：先丢弃旧资料，不能在新请求回来前继续显示旧权限。
    profileRef.current = null;
    setProfile(null);
    setError("");
    setLoading(true);
    setRefreshing(false);
    return () => {
      generation.current += 1;
    };
  }, [accountKey, viewState]);

  const guard = useCallback(async <T,>(task: () => Promise<T>): Promise<T> => {
    const g = generation.current;
    const value = await task();
    if (g !== generation.current) throw Object.assign(new Error("stale"), { code: "STALE" });
    return value;
  }, []);

  const loadProfile = useCallback(
    async (options?: { force?: boolean }): Promise<void> => {
      if (viewState !== "logged-in") {
        profileRef.current = null;
        setProfile(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const epoch = generation.current;
      const pending = inflightProfile.current;
      // 普通刷新（含双击）合并在途读取；权限失效/写后刷新必须另起一轮，
      // 否则会把“旧权限/写前”的在途响应当成新结果。
      if (!options?.force && pending && pending.epoch === epoch) return pending.promise;
      const seq = (profileSeq.current += 1);
      const entry: { epoch: number; seq: number; promise: Promise<void> } = { epoch, seq, promise: Promise.resolve() };
      if (profileRef.current) setRefreshing(true);
      else setLoading(true);
      entry.promise = (async () => {
        try {
          const next = await guard(() => request<Profile>("/cloud-management/profile"));
          // 只有“当前代次 + 当前这一轮”的响应可以落到界面；被 force 取代的旧响应直接丢弃。
          if (epoch !== generation.current || seq !== profileSeq.current || inflightProfile.current !== entry) return;
          profileRef.current = next;
          setProfile(next);
          setError("");
        } catch (failure) {
          if (epoch !== generation.current || seq !== profileSeq.current || inflightProfile.current !== entry) return;
          const text = failureText(failure);
          if ((failure as CloudLastError)?.status === 401) {
            profileRef.current = null;
            setProfile(null);
            void authRef.current.readStatus().catch(() => undefined);
          }
          setError(text);
        } finally {
          if (epoch === generation.current && inflightProfile.current === entry) {
            setLoading(false);
            setRefreshing(false);
          }
          if (inflightProfile.current === entry) inflightProfile.current = null;
        }
      })();
      inflightProfile.current = entry;
      return entry.promise;
    },
    [accountKey, guard, request, viewState],
  );

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  const capabilities = profile?.capabilities;
  const system = useMemo(() => new Set(capabilities?.systemPermissions || []), [capabilities]);
  const tabs = useMemo(() => {
    const list: { id: typeof tab; label: string }[] = [
      { id: "security", label: "个人安全" },
      { id: "groups", label: "小组与成员" },
      { id: "audio", label: "云端音频" },
    ];
    if (system.has("account:read") || system.has("account:create"))
      list.push({ id: "accounts", label: "账户管理" });
    if (capabilities?.superAdmin) {
      list.push({ id: "roles", label: "角色与授权" });
      list.push({ id: "audit", label: "审计" });
      list.push({ id: "upload-settings", label: "上传审批设置" });
      list.push({ id: "audio-maintenance", label: "音频维护" });
    }
    return list;
  }, [capabilities?.superAdmin, system]);

  useEffect(() => {
    if (!tabs.some((item) => item.id === tab)) setTab("security");
  }, [tab, tabs]);

  const onAuthFailure = useCallback(
    (failure: unknown) => {
      const status = (failure as CloudLastError)?.status;
      if (status === 401) {
        profileRef.current = null;
        setProfile(null);
        void authRef.current.readStatus().catch(() => undefined);
        return "登录状态已失效，请重新登录。";
      }
      if (status === 403) {
        // 权限可能已被云端调整：先清掉旧权限视图，再强制开启新一轮 capabilities 读取。
        // 若沿用同代次在途请求，旧响应会把已撤销的 capabilities 重新显示出来。
        profileRef.current = null;
        setProfile(null);
        setLoading(true);
        void loadProfile({ force: true });
      }
      return failureText(failure);
    },
    [loadProfile],
  );

  if (!signedIn && !auth.loading) {
    return (
      <div className="cloud-workspace">
        <WorkspaceHeader onBack={onBack} title="账户与小组" />
        <main className="cw-body cw-signed-out">
          <ShieldCheck size={34} />
          <h2>需要登录云端账户</h2>
          <p>登录后才能查看本人设备、小组与授权。不登录仍可返回素材库继续管理本地素材。</p>
          <div className="cw-actions">
            <button type="button" className="primary" onClick={onLogin}>
              去登录
            </button>
            <button type="button" className="plain" onClick={onBack}>
              返回素材库
            </button>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="cloud-workspace">
      <WorkspaceHeader
        onBack={onBack}
        title="账户与小组"
        subtitle={
          profile
            ? `${profile.me.displayName || profile.me.username} · @${profile.me.username}${capabilities?.superAdmin ? " · 超级管理员" : ""}`
            : auth.view?.username || ""
        }
        onRefresh={() => void loadProfile()}
        busy={loading || refreshing}
      />
      <main className="cw-body">
        {error && <Notice error={error} />}
        {loading && !profile ? (
          <p className="cw-loading" role="status">
            <LoaderCircle size={16} className="spin" /> 正在读取云端管理数据…
          </p>
        ) : !profile ? (
          <div className="cw-signed-out">
            <p>暂时无法读取账户资料。</p>
            <button type="button" className="plain" onClick={() => void loadProfile()}>
              重试
            </button>
          </div>
        ) : (
          <>
            <nav className="cw-tabs" aria-label="管理工作区">
              {tabs.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={tab === item.id ? "active" : ""}
                  aria-current={tab === item.id ? "page" : undefined}
                  onClick={() => {
                    setTab(item.id);
                    setError("");
                  }}
                >
                  {item.label}
                </button>
              ))}
            </nav>
            {tab === "security" && (
              <SecurityPanel
                profile={profile}
                request={request}
                guard={guard}
                onAuthFailure={onAuthFailure}
                reload={loadProfile}
                onLogin={onLogin}
                onNotice={onNotice}
              />
            )}
            {tab === "groups" && (
              <GroupsPanel
                capabilities={profile.capabilities}
                request={request}
                guard={guard}
                onAuthFailure={onAuthFailure}
                reloadProfile={loadProfile}
              />
            )}
            {tab === "audio" && <AudioWorkspacePanel key={`${accountKey}:${auth.view?.deviceId || ""}:${auth.view?.sessionId || ""}`} request={request} onOpenUploadTasks={onOpenUploadTasks} />}
            {tab === "accounts" && (
              <AccountsPanel
                capabilities={profile.capabilities}
                request={request}
                guard={guard}
                onAuthFailure={onAuthFailure}
              />
            )}
            {tab === "roles" && (
              <RolesPanel
                capabilities={profile.capabilities}
                request={request}
                guard={guard}
                onAuthFailure={onAuthFailure}
              />
            )}
            {tab === "upload-settings" && capabilities?.superAdmin && (
              <CloudUploadApprovalSettings request={request} guard={guard} onAuthFailure={onAuthFailure} />
            )}
            {tab === "audio-maintenance" && capabilities?.superAdmin && (
              maintenanceIdentity?.source === maintenanceIdentitySource
                ? <AudioMaintenancePanel request={request} identityKey={maintenanceIdentity.digest} />
                : <p role="status">正在核对当前维护会话，尚未允许操作。</p>
            )}
            {tab === "audit" && (
              <AuditPanel request={request} guard={guard} onAuthFailure={onAuthFailure} />
            )}
          </>
        )}
      </main>
    </div>
  );
}


type MaintenanceView = {
  runId: string; operationId: string; manifestFingerprint: string; state: "PLANNED" | "BOUND" | "NEEDS_RECHECK" | "ENABLED";
  expiresAt: string; objects: number; bytes: number;
  receipt: null | { runId: string; manifestFingerprint: string; objects: number; verifiedBytes: number; protocolVersion: number; reconciliationVersion: number; writeMode: "READY"; storageState: "READY"; adoptedAt: string };
};
type MaintenanceIntent = { format: 1; identityKey: string; operationId: string; expectedProtocolVersion: number; expectedStorageVersion: number; phase: "PLAN_PENDING" | "APPLY_PENDING" | "KNOWN"; view: MaintenanceView | null };
function AudioWorkspacePanel({ request, onOpenUploadTasks }: { request: LocalRequest; onOpenUploadTasks?: () => void }) {
  const [view, setView] = useState<"files" | "tasks">("files");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<{ known?: boolean; local?: { engine?: string } } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (view !== "tasks") return;
    let current = true;
    setLoading(true); setFailed(false); setStatus(null);
    void request<{ known?: boolean; local?: { engine?: string } }>("/cloud-upload-tasks/control/status")
      .then(value => { if (current) setStatus(value); })
      .catch(() => { if (current) setFailed(true); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [view, revision, request]);
  const mysql = status?.local?.engine === "mysql";
  const available = status?.local?.engine === "sqlite" && status.known === true && !!onOpenUploadTasks;
  return <section className="cw-audio-workspace" aria-label="云端音频工作区">
    <div className="cw-audio-heading"><h2>云端音频</h2>
      <nav className="cw-subtabs" aria-label="云端音频视图">
        <button type="button" className={view === "files" ? "active" : ""} aria-current={view === "files" ? "page" : undefined} onClick={() => setView("files")}><Upload size={15} />音频与单文件上传</button>
        <button type="button" className={view === "tasks" ? "active" : ""} aria-current={view === "tasks" ? "page" : undefined} onClick={() => setView("tasks")}><ListChecks size={15} />批量上传任务</button>
      </nav>
    </div>
    {view === "files" ? <CloudAudioDownload request={request} /> : <div className="cw-upload-overview">
      <div className="cw-pagebar"><div className="cw-pagebar-title"><h3>批量上传任务</h3></div><button type="button" className="plain" disabled={loading} onClick={() => setRevision(n => n + 1)}><RefreshCw size={15} className={loading ? "spin" : ""} />刷新状态</button></div>
      <dl className="cw-upload-facts"><div><dt>本机数据库</dt><dd>{loading ? "读取中" : mysql ? "MySQL" : status?.local?.engine === "sqlite" ? "SQLite" : "未确认"}</dd></div><div><dt>批量任务支持</dt><dd>{loading ? "读取中" : mysql ? "暂不支持 MySQL" : available ? "本机入口已接通" : "尚不可用"}</dd></div></dl>
      {!loading && !available && <div className="cw-upload-unavailable" role="status"><AlertTriangle size={19} /><div><strong>{mysql ? "当前数据库暂不支持批量上传" : failed ? "暂时无法核对上传环境" : "批量上传环境尚未就绪"}</strong><p>{mysql ? "MySQL 接入尚未完成。现有素材和数据库保持不变。" : "未确认可用状态，未创建或启动上传任务。"}</p></div></div>}
      <div className="cw-pagebar-actions"><button type="button" className="primary" disabled={loading || !available} onClick={onOpenUploadTasks}><ListChecks size={16} />进入上传任务中心</button></div>
    </div>}
  </section>;
}

const maintenanceStorageKey = "shiguang.audio-maintenance.intent.v1";
const maintenanceUUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maintenanceHash = /^[a-f0-9]{64}$/;
const maintenanceInteger = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
function maintenanceView(value: unknown): MaintenanceView {
  const v = value as MaintenanceView;
  if (!v || !maintenanceUUID.test(v.runId) || !maintenanceUUID.test(v.operationId) || !maintenanceHash.test(v.manifestFingerprint) || !["PLANNED","BOUND","NEEDS_RECHECK","ENABLED"].includes(v.state) || typeof v.expiresAt !== "string" || !Number.isFinite(Date.parse(v.expiresAt)) || !maintenanceInteger(v.objects) || !maintenanceInteger(v.bytes)) throw Error("维护结果尚未核清，请保留原操作并查询");
  let receipt: MaintenanceView["receipt"] = null;
  if (v.state === "ENABLED") {
    const r = v.receipt;
    if (!r || r.runId !== v.runId || r.manifestFingerprint !== v.manifestFingerprint || r.objects !== v.objects || r.verifiedBytes !== v.bytes || r.writeMode !== "READY" || r.storageState !== "READY" || !maintenanceInteger(r.protocolVersion) || !maintenanceInteger(r.reconciliationVersion) || typeof r.adoptedAt !== "string" || !Number.isFinite(Date.parse(r.adoptedAt))) throw Error("维护回执尚未核清");
    receipt = { runId: r.runId, manifestFingerprint: r.manifestFingerprint, objects: r.objects, verifiedBytes: r.verifiedBytes, protocolVersion: r.protocolVersion, reconciliationVersion: r.reconciliationVersion, writeMode: "READY", storageState: "READY", adoptedAt: r.adoptedAt };
  } else if (v.receipt !== null) throw Error("维护回执尚未核清");
  return { runId: v.runId, operationId: v.operationId, manifestFingerprint: v.manifestFingerprint, state: v.state, expiresAt: v.expiresAt, objects: v.objects, bytes: v.bytes, receipt };
}
function readMaintenanceIntent(): MaintenanceIntent | null {
  const raw = localStorage.getItem(maintenanceStorageKey); if (raw === null) return null;
  if (raw.length > 8192) throw Error("原维护记录无法核验，未自动重建");
  const v = JSON.parse(raw) as MaintenanceIntent;
  if (!v || Object.keys(v).sort().join(",") !== ["format","identityKey","operationId","expectedProtocolVersion","expectedStorageVersion","phase","view"].sort().join(",") || v.format !== 1 || typeof v.identityKey !== "string" || !maintenanceHash.test(v.identityKey) || !maintenanceUUID.test(v.operationId) || !maintenanceInteger(v.expectedProtocolVersion) || !maintenanceInteger(v.expectedStorageVersion) || !["PLAN_PENDING","APPLY_PENDING","KNOWN"].includes(v.phase)) throw Error("原维护记录无法核验，未自动重建");
  const view = v.view === null ? null : maintenanceView(v.view);
  if (view && view.operationId !== v.operationId || v.phase === "KNOWN" && !view) throw Error("原维护记录不一致");
  return { format: 1, identityKey: v.identityKey, operationId: v.operationId, expectedProtocolVersion: v.expectedProtocolVersion, expectedStorageVersion: v.expectedStorageVersion, phase: v.phase, view };
}
export function AudioMaintenancePanel({ request, identityKey }: { request: LocalRequest; identityKey: string }) {
  const [intent, setIntent] = useState<MaintenanceIntent | null>(null), [storageError, setStorageError] = useState(false);
  const [protocol, setProtocol] = useState("0"), [storage, setStorage] = useState("2"), [lookupRun, setLookupRun] = useState("");
  const [verifiedFingerprint, setVerifiedFingerprint] = useState(""), [scopeConfirmed, setScopeConfirmed] = useState(false), [recover, setRecover] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const currentIdentity = useRef(identityKey); currentIdentity.current = identityKey;
  const alive = useRef(true), working = useRef(false), serial = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; serial.current++; }; }, []);
  useEffect(() => {
    serial.current++; working.current = false; setBusy(false); setError(""); setVerifiedFingerprint(""); setScopeConfirmed(false); setRecover(false); setLookupRun("");
    try { setIntent(readMaintenanceIntent()); setStorageError(false); } catch { setIntent(null); setStorageError(true); }
  }, [identityKey]);
  const foreign = !!intent && intent.identityKey !== identityKey;
  const view = foreign ? null : intent?.view;
  const bound = view?.state === "BOUND" || view?.state === "NEEDS_RECHECK";
  async function act(work: (live: () => void) => Promise<void>) {
    if (working.current) return; working.current = true; setBusy(true); setError(""); const generation = serial.current, actor = identityKey;
    const live = () => { if (!alive.current || serial.current !== generation || currentIdentity.current !== actor) throw Error("身份已变化，原记录保留，未转交新会话"); };
    try {
      if (!navigator.locks?.request) throw Error("浏览器无法协调原维护操作，禁止提交");
      await navigator.locks.request("shiguang.audio-maintenance.intent", { mode: "exclusive", ifAvailable: true }, async lock => {
        if (!lock) throw Error("另一页面正在处理原维护操作"); live(); await work(live);
      });
    } catch (e) { if (alive.current && serial.current === generation) setError((e as Error).message); }
    finally { if (alive.current && serial.current === generation) { working.current = false; setBusy(false); } }
  }
  function save(next: MaintenanceIntent, expected: MaintenanceIntent | null) {
    const actual = readMaintenanceIntent();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error("原维护记录已变化，请保留并核对，未重发");
    const raw = JSON.stringify(next); if (raw.length > 8192) throw Error("维护记录超过本机限制");
    localStorage.setItem(maintenanceStorageKey, raw); if (localStorage.getItem(maintenanceStorageKey) !== raw) throw Error("无法安全保存原维护记录"); setIntent(next);
  }
  function accept(raw: unknown, pending: MaintenanceIntent, live: () => void) {
    live(); const next = maintenanceView(raw);
    if (next.operationId !== pending.operationId || pending.view && (next.runId !== pending.view.runId || next.manifestFingerprint !== pending.view.manifestFingerprint || next.objects !== pending.view.objects || next.bytes !== pending.view.bytes)) throw Error("响应与原计划不一致，未更换原命令");
    save({ ...pending, phase: "KNOWN", view: next }, pending); setVerifiedFingerprint(""); setScopeConfirmed(false); setRecover(false);
  }
  const create = () => act(async live => {
    if (storageError || readMaintenanceIntent() !== null) throw Error("原维护操作尚未核清，禁止另建计划");
    if (!/^(0|[1-9][0-9]*)$/.test(protocol) || !/^(0|[1-9][0-9]*)$/.test(storage) || !maintenanceInteger(Number(protocol)) || !maintenanceInteger(Number(storage))) throw Error("请填写核对后的有效版本");
    const pending: MaintenanceIntent = { format: 1, identityKey, operationId: crypto.randomUUID(), expectedProtocolVersion: Number(protocol), expectedStorageVersion: Number(storage), phase: "PLAN_PENDING", view: null };
    save(pending, null); live();
    const result = await request<MaintenanceView>("/cloud-management/audio-maintenance/plan", { operationId: pending.operationId, expectedProtocolVersion: pending.expectedProtocolVersion, expectedStorageVersion: pending.expectedStorageVersion, clientIdentity: identityKey });
    accept(result, pending, live);
  });
  const query = () => act(async live => {
    const saved = readMaintenanceIntent(); if (!saved || saved.identityKey !== identityKey) throw Error("原会话不匹配，未转交记录");
    const runId = saved.view?.runId || lookupRun;
    if (!maintenanceUUID.test(runId)) throw Error("计划结果未知时，请先取得管理员核对的原运行ID；不会重新生成计划");
    const response = await fetch("/api/cloud-management/audio-maintenance/runs/" + runId, { headers: { "x-maintenance-identity": saved.identityKey }, cache: "no-store" });
    const raw = await response.json(); if (!response.ok) throw Error(typeof raw?.error === "string" ? raw.error : "原计划查询失败，未重新提交");
    live(); const result = maintenanceView(raw); if (result.runId !== runId) throw Error("原运行ID不一致"); accept(result, saved, live);
  });
  const apply = () => act(async live => {
    const saved = readMaintenanceIntent(), known = saved?.view;
    if (!saved || saved.identityKey !== identityKey || saved.phase !== "KNOWN" || !known || !scopeConfirmed || verifiedFingerprint !== known.manifestFingerprint) throw Error("请先取得并核对总监对原计划的范围确认");
    const recovery = known.state === "BOUND" || known.state === "NEEDS_RECHECK";
    if (recovery ? !recover : known.state !== "PLANNED" || Date.parse(known.expiresAt) <= Date.now() || recover) throw Error("原计划状态不允许此操作，请查询原运行");
    const pending: MaintenanceIntent = { ...saved, phase: "APPLY_PENDING" }; save(pending, saved); live();
    const result = await request<MaintenanceView>("/cloud-management/audio-maintenance/runs/" + known.runId + "/apply", { operationId: saved.operationId, manifestFingerprint: known.manifestFingerprint, recoverBound: recovery, clientIdentity: saved.identityKey });
    accept(result, pending, live);
  });
  return <section className="cw-panel" aria-label="云端音频维护" style={{ overflowWrap: "anywhere" }}>
    <h2>云端音频维护</h2><p>仅由当前负责人明确操作。生成计划不会启用上传；必须先交总监核对原对象范围，再确认采用。</p>
    {error && <p role="alert">{error}</p>}
    {storageError && <p role="alert">原维护记录无法读取。已停止操作，请保留现场交管理员核对，不会自动清除或重建。</p>}
    {foreign && <p role="alert">存在其他会话的维护记录，已保留。当前会话不能查询、接管或继续原操作。</p>}
    {!intent && !storageError && <><label>协议状态版本<input aria-label="协议状态版本" value={protocol} onChange={e => setProtocol(e.target.value)} disabled={busy}/></label><label>存储状态版本<input aria-label="存储状态版本" value={storage} onChange={e => setStorage(e.target.value)} disabled={busy}/></label><p>请使用本次核对的实际版本；版本冲突时保留原操作，不自动换号重试。</p><button disabled={busy} onClick={() => void create()}>明确生成维护计划（不启写）</button></>}
    {intent && !foreign && <><dl><dt>原操作ID</dt><dd>{intent.operationId}</dd>{view && <><dt>运行ID</dt><dd>{view.runId}</dd><dt>计划指纹</dt><dd>{view.manifestFingerprint}</dd><dt>状态</dt><dd>{view.state}</dd><dt>对象数量 / 字节</dt><dd>{view.objects} / {view.bytes}</dd><dt>计划到期</dt><dd>{view.expiresAt}</dd></>}</dl>
      {intent.phase !== "KNOWN" && <p role="status">原请求结果尚未核清，只能查询原运行；不会重新生成计划或自动重发采用。</p>}
      {!view && <label>管理员核对的原运行ID<input aria-label="管理员核对的原运行ID" value={lookupRun} onChange={e => setLookupRun(e.target.value)} disabled={busy}/></label>}
      <button disabled={busy || storageError} onClick={() => void query()}>查询原维护运行</button>
      {view && view.state !== "ENABLED" && <><p>请将上述运行ID、操作ID、指纹、数量及字节交总监。数量相同不能证明对象相同；收到原范围核对确认前不要采用。</p><label>总监确认的原计划指纹<input aria-label="总监确认的原计划指纹" value={verifiedFingerprint} onChange={e => setVerifiedFingerprint(e.target.value)} disabled={busy}/></label><label><input type="checkbox" checked={scopeConfirmed} onChange={e => setScopeConfirmed(e.target.checked)} disabled={busy}/>已收到总监对原对象与撤共享语义的核对确认</label>
        {bound && <label><input type="checkbox" checked={recover} onChange={e => setRecover(e.target.checked)} disabled={busy}/>明确恢复同一已绑定计划，仅继续结算</label>}
        <button disabled={busy || storageError || intent.phase !== "KNOWN" || !scopeConfirmed || verifiedFingerprint !== view.manifestFingerprint || (bound ? !recover : view.state !== "PLANNED" || recover || Date.parse(view.expiresAt) <= Date.now())} onClick={() => void apply()}>{bound ? "明确恢复原计划结算" : "明确采用已核对计划"}</button></>}
      {view?.state === "ENABLED" && <p role="status">原计划已取得启用回执：READY / READY。回执是历史事实；后续上传仍需实际权限、库和存储就绪。当前本地 MySQL 批量任务不因此变为可用。</p>}
    </>}
  </section>;
}

function WorkspaceHeader({
  onBack,
  title,
  subtitle,
  onRefresh,
  busy,
}: {
  onBack: () => void;
  title: string;
  subtitle?: string;
  onRefresh?: () => void;
  busy?: boolean;
}) {
  return (
    <header className="cw-header">
      <button type="button" className="plain cw-back" onClick={onBack} title="返回素材库" aria-label="返回素材库">
        <ArrowLeft size={16} />
        <span className="cw-back-label">返回素材库</span>
      </button>
      <div className="cw-title">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      <div className="cw-header-actions">
        {onRefresh && (
          <button type="button" className="plain cw-icon-button" aria-label="刷新管理数据" title="刷新管理数据" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={16} className={busy ? "spin" : ""} />
          </button>
        )}
      </div>
    </header>
  );
}

function SecurityPanel({
  profile,
  request,
  guard,
  onAuthFailure,
  reload,
  onLogin,
  onNotice,
}: {
  profile: Profile;
  request: LocalRequest;
  guard: <T>(task: () => Promise<T>) => Promise<T>;
  onAuthFailure: (failure: unknown) => string;
  reload: (options?: { force?: boolean }) => Promise<void>;
  onLogin: () => void;
  onNotice: (message: string) => void;
}) {
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [confirmDevice, setConfirmDevice] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function revoke(device: Device) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const result = await guard(() => request<{ revoked: boolean; signedOut: boolean }>(`/cloud-management/devices/${device.id}`, undefined, "DELETE"));
      setConfirmDevice(null);
      onNotice(result?.signedOut ? "当前设备已撤销，需要重新开通本机" : `设备“${device.name}”已撤销`);
      if (result?.signedOut) {
        onLogin();
      } else {
        // 设备撤销是写操作：即使有旧 profile 在途，也必须真正读到新设备列表。
        await reload({ force: true });
        setSuccess("设备已撤销。");
      }
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!currentPassword || !newPassword) {
      setError("请输入当前密码和新密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (newPassword.length < 12 || new TextEncoder().encode(newPassword).length > 72) {
      setError("新密码至少 12 个字符，且不超过 72 字节");
      return;
    }
    const submittedCurrent = currentPassword;
    const submittedNew = newPassword;
    // 密码提交即离开表单内存，不等待响应。
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setBusy(true);
    try {
      await guard(() =>
        request("/cloud-management/password", { currentPassword: submittedCurrent, newPassword: submittedNew }),
      );
      onNotice("密码已修改，旧会话已清除，请用新密码重新登录");
      onLogin();
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cw-panel" aria-label="个人安全">
      <div className="cw-pagebar">
        <div className="cw-pagebar-title">
          <h2>个人安全</h2>
          <p>本人资料、本机设备与密码；撤销当前设备或改密都会要求重新登录。</p>
        </div>
        <div className="cw-pagebar-actions">
          <Badge kind="ok">
            <ShieldCheck size={12} /> {profile.devices.filter((device) => device.state === "ACTIVE").length} 台有效设备
          </Badge>
        </div>
      </div>

      <div className="cw-security-grid">
        <div className="cw-surface cw-security-main">
          <section className="cw-subsection">
            <div className="cw-subsection-head">
              <h2>本人资料</h2>
              <span>当前登录身份</span>
            </div>
            <dl className="cw-facts">
              <div>
                <dt>用户名</dt>
                <dd>@{profile.me.username}</dd>
              </div>
              <div>
                <dt>显示名</dt>
                <dd>{profile.me.displayName || "—"}</dd>
              </div>
              <div>
                <dt>身份</dt>
                <dd>{profile.capabilities.superAdmin ? "超级管理员（唯一 owner）" : "普通账户"}</dd>
              </div>
            </dl>
          </section>

          <section className="cw-subsection">
            <div className="cw-subsection-head">
              <h2>我的设备</h2>
              <span>{profile.devices.length} 条记录 · 证书只保存在本机后台</span>
            </div>
            <ul className="cw-list cw-device-list">
              {profile.devices.map((device) => (
                <li key={device.id} className="cw-row">
                  <div className="cw-row-main">
                    <strong>{device.name || "未命名设备"}</strong>
                    <span className="cw-meta">
                      {device.id === profile.me.deviceId && <Badge kind="ok">当前设备</Badge>}
                      <Badge kind={device.state === "ACTIVE" ? "ok" : device.state === "REVOKED" ? "danger" : "muted"}>
                        {stateText(device.state)}
                      </Badge>
                      <span>证书到期：{displayTime(device.certificateExpiresAt)}</span>
                      <span>最近使用：{displayTime(device.lastSeenAt)}</span>
                    </span>
                  </div>
                  {device.state !== "REVOKED" &&
                    (confirmDevice === device.id ? (
                      <span className="cw-inline-confirm">
                        <span>{device.id === profile.me.deviceId ? "撤销当前设备会立即退出，确认？" : "确认撤销？"}</span>
                        <button type="button" className="plain danger" disabled={busy} onClick={() => void revoke(device)}>
                          确认撤销
                        </button>
                        <button type="button" className="plain" onClick={() => setConfirmDevice(null)}>
                          取消
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="plain" onClick={() => setConfirmDevice(device.id)}>
                        <Trash2 size={13} /> 撤销
                      </button>
                    ))}
                </li>
              ))}
              {!profile.devices.length && (
                <li className="cw-empty">
                  <strong>没有设备记录</strong>
                  <span>设备证书只保存在本机后台。</span>
                </li>
              )}
            </ul>
          </section>
        </div>

        <div className="cw-surface cw-security-side">
          <section className="cw-subsection">
            <div className="cw-subsection-head">
              <h2>修改密码</h2>
              <span>至少 12 个字符</span>
            </div>
            <p className="cw-hint">修改成功后全部设备会话撤销，需要用新密码重新登录；设备证书不会被删除。</p>
            <form className="cw-form" onSubmit={changePassword} aria-label="修改密码">
              <label className="field">
                当前密码
                <input
                  aria-label="当前密码"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  disabled={busy}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </label>
              <label className="field">
                新密码
                <input
                  aria-label="新密码"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  disabled={busy}
                  onChange={(event) => setNewPassword(event.target.value)}
                />
              </label>
              <label className="field">
                确认新密码
                <input
                  aria-label="确认新密码"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  disabled={busy}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
              <button type="submit" className="primary" disabled={busy}>
                {busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
                修改密码
              </button>
            </form>
            <Notice error={error} success={success} />
          </section>
        </div>
      </div>
    </section>
  );
}

function GroupsPanel({
  capabilities,
  request,
  guard,
  onAuthFailure,
  reloadProfile,
}: {
  capabilities: Capabilities;
  request: LocalRequest;
  guard: <T>(task: () => Promise<T>) => Promise<T>;
  onAuthFailure: (failure: unknown) => string;
  reloadProfile: (options?: { force?: boolean }) => Promise<void>;
}) {
  const system = useMemo(() => new Set(capabilities.systemPermissions), [capabilities.systemPermissions]);
  const canAdminister = system.has("group:administer");
  const [management, setManagement] = useState(false);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [rename, setRename] = useState("");
  const [addName, setAddName] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [transferName, setTransferName] = useState("");
  const [transferCandidate, setTransferCandidate] = useState<Candidate | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newLeaderName, setNewLeaderName] = useState("");
  const [newLeader, setNewLeader] = useState<Candidate | null>(null);
  const createRequest = useRef<{ id: string; name: string; leader: string } | null>(null);

  const groupCap = capabilities.groups.find((item) => item.groupId === selectedId);
  const groupPerms = new Set(groupCap?.permissions || []);
  const canManage = canAdminister || groupPerms.has("group:member:manage");
  const canRename = canAdminister || groupPerms.has("group:profile:edit");
  const canTransfer = system.has("group:leader:replace");

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await guard(() =>
        request<Group[]>(`/cloud-management/groups?management=${management ? "true" : "false"}&limit=50&offset=0`),
      );
      setGroups(rows);
      setSelectedId((current) => {
        if (current && rows.some((row) => row.id === current)) return current;
        return rows[0]?.id || null;
      });
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setLoading(false);
    }
  }, [guard, management, onAuthFailure, request]);

  const loadDetail = useCallback(
    async (groupId: string) => {
      setError("");
      try {
        const [group, rows] = await Promise.all([
          guard(() => request<Group>(`/cloud-management/groups/${groupId}`)),
          guard(() => request<Member[]>(`/cloud-management/groups/${groupId}/members?limit=100&offset=0`)),
        ]);
        setDetail(group);
        setMembers(rows);
        setRename(group.name);
      } catch (failure) {
        setError(onAuthFailure(failure));
        setDetail(null);
        setMembers([]);
      }
    },
    [guard, onAuthFailure, request],
  );

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setDetail(null);
      setMembers([]);
    }
  }, [selectedId, loadDetail]);

  async function refresh() {
    await loadGroups();
    if (selectedId) await loadDetail(selectedId);
    // 这是写后刷新：旧 profile 若仍在途，必须另起一轮，不能返回写前结果。
    await reloadProfile({ force: true });
  }

  function resetMessages() {
    setError("");
    setSuccess("");
  }

  async function run(action: () => Promise<unknown>, done: string) {
    setError("");
    setSuccess("");
    try {
      await action();
      await refresh();
      setSuccess(done);
    } catch (failure) {
      setError(onAuthFailure(failure));
    }
  }

  async function findCandidate(name: string, forGroup: boolean): Promise<Candidate | null> {
    const query = `/cloud-management/candidates?username=${encodeURIComponent(name.trim().toLowerCase())}${
      forGroup && selectedId ? `&groupId=${encodeURIComponent(selectedId)}` : ""
    }`;
    const rows = await guard(() => request<Candidate[]>(query));
    return rows[0] || null;
  }

  async function searchMember() {
    resetMessages();
    setCandidate(null);
    try {
      const found = await findCandidate(addName, true);
      if (!found) setError("没有找到该用户名的有效启用账户，或当前无权限查询。");
      setCandidate(found);
    } catch (failure) {
      setError(onAuthFailure(failure));
    }
  }

  async function searchLeader() {
    resetMessages();
    setNewLeader(null);
    try {
      const found = await findCandidate(newLeaderName, false);
      if (!found) setError("没有找到该用户名的有效启用账户，或当前无权限查询。");
      setNewLeader(found);
    } catch (failure) {
      setError(onAuthFailure(failure));
    }
  }

  async function searchTransfer() {
    resetMessages();
    setTransferCandidate(null);
    try {
      const found = await findCandidate(transferName, true);
      if (!found) setError("目标必须是本组有效成员且账户启用。");
      setTransferCandidate(found);
    } catch (failure) {
      setError(onAuthFailure(failure));
    }
  }

  async function submitCreate(event: FormEvent) {
    event.preventDefault();
    resetMessages();
    if (!newGroupName.trim() || !newLeader) {
      setError("请填写小组名称并精确查找初始组长");
      return;
    }
    const key = { name: newGroupName.trim(), leader: newLeader.id };
    // 同一次超时重试复用 requestId；参数改变必须换新 ID。
    if (!createRequest.current || createRequest.current.name !== key.name || createRequest.current.leader !== key.leader) {
      createRequest.current = { id: crypto.randomUUID(), ...key };
    }
    setLoading(true);
    try {
      const created = await guard(() =>
        request<Group>("/cloud-management/groups", {
          name: key.name,
          initialLeaderAccountId: key.leader,
          requestId: createRequest.current?.id,
        }),
      );
      createRequest.current = null;
      setCreateOpen(false);
      setNewGroupName("");
      setNewLeaderName("");
      setNewLeader(null);
      await loadGroups();
      if (created?.id) setSelectedId(created.id);
      setSuccess("小组已创建；指定组长同时成为成员。");
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setLoading(false);
    }
  }

  const leaderShown = detail?.leaderAccountId;
  const selfIsLeader = !!groupCap?.leader;
  const canSeeState = canAdminister;

  return (
    <section className="cw-panel" aria-label="小组与成员">
      <div className="cw-pagebar">
        <div className="cw-pagebar-title">
          <h2>小组与成员</h2>
          <p>
            {groups.length} 个可见小组 · {canAdminister ? "可切换管理模式查看停用/待接管小组" : "仅显示你所属的小组"}
          </p>
        </div>
        <div className="cw-pagebar-actions">
          {canAdminister && (
            <label className="cw-check cw-switch">
              <input type="checkbox" checked={management} onChange={(event) => setManagement(event.target.checked)} />
              管理模式（含停用/待接管小组）
            </label>
          )}
          <button type="button" className="plain" onClick={() => void loadGroups()} disabled={loading} title="刷新小组列表">
            <RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新
          </button>
          {(system.has("group:create") || canAdminister) && (
            <button type="button" className="primary" onClick={() => setCreateOpen((open) => !open)}>
              <Plus size={14} /> 创建小组
            </button>
          )}
        </div>
      </div>

      {createOpen && (
        <form className="cw-inline-editor" onSubmit={submitCreate} aria-label="创建小组">
          <div className="cw-inline-editor-head">
            <h2>创建小组</h2>
            <span>初始组长必须是已存在且启用的账户；创建者不会自动入组。</span>
          </div>
          <div className="cw-form-grid">
            <label className="field">
              小组名称
              <input
                aria-label="新小组名称"
                value={newGroupName}
                maxLength={128}
                onChange={(event) => setNewGroupName(event.target.value)}
              />
            </label>
            <label className="field">
              初始组长完整用户名
              <input
                aria-label="初始组长用户名"
                value={newLeaderName}
                spellCheck={false}
                onChange={(event) => setNewLeaderName(event.target.value)}
              />
            </label>
          </div>
          <div className="cw-inline-editor-foot">
            <div className="cw-actions">
              <button type="button" className="plain" onClick={() => void searchLeader()}>
                <Search size={14} /> 精确查找
              </button>
              {newLeader && (
                <Badge kind="ok">
                  <Check size={12} /> {newLeader.displayName} · @{newLeader.username}
                </Badge>
              )}
            </div>
            <div className="cw-actions">
              <button type="button" className="plain" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button type="submit" className="primary" disabled={loading}>
                创建
              </button>
            </div>
          </div>
        </form>
      )}

      <Notice error={error} success={success} />

      <div className="cw-workbench cw-groups-workbench">
        <aside className="cw-master" aria-label="小组列表">
          <div className="cw-master-head">
            <span>小组</span>
            <span>{groups.length}</span>
          </div>
          {loading && !groups.length ? (
            <p className="cw-loading">
              <LoaderCircle size={14} className="spin" /> 读取中…
            </p>
          ) : (
            <ul className="cw-list cw-select-list">
              {groups.map((group) => (
                <li key={group.id}>
                  <button
                    type="button"
                    className={selectedId === group.id ? "active" : ""}
                    aria-current={selectedId === group.id ? "true" : undefined}
                    onClick={() => setSelectedId(group.id)}
                  >
                    <span className="cw-row-main">
                      <strong>{group.name}</strong>
                      <span className="cw-meta">
                        <Badge kind={group.state === "ACTIVE" ? "ok" : group.state === "DISABLED" ? "danger" : "warn"}>
                          {stateText(group.state)}
                        </Badge>
                        {capabilities.groups.find((item) => item.groupId === group.id)?.leader && (
                          <Badge kind="ok">我是负责人</Badge>
                        )}
                      </span>
                    </span>
                    <ChevronRight size={14} />
                  </button>
                </li>
              ))}
              {!groups.length && (
                <li className="cw-empty cw-empty-action">
                  <strong>没有可见的小组</strong>
                  <span>切换管理模式或等待被加入小组。</span>
                </li>
              )}
            </ul>
          )}
        </aside>

        <div className="cw-detail-pane cw-detail">
          {!detail ? (
            <div className="cw-empty-state">
              <UserPlus size={22} />
              <h2>选择一个小组成员</h2>
              <p>从左侧选择小组，查看负责人、成员与可用的管理操作。</p>
            </div>
          ) : (
            <>
              <div className="cw-detail-head">
                <div className="cw-detail-title">
                  <h2>{detail.name}</h2>
                  <span className="cw-meta">
                    <Badge kind={detail.state === "ACTIVE" ? "ok" : detail.state === "DISABLED" ? "danger" : "warn"}>
                      {stateText(detail.state)}
                    </Badge>
                    <span>版本 v{detail.version}</span>
                    <span>负责人：{leaderShown || "未指定"}</span>
                  </span>
                </div>
                <span className="cw-actions">
                  {canRename && (
                    <button
                      type="button"
                      className="plain"
                      onClick={() =>
                        void run(
                          () =>
                            request(`/cloud-management/groups/${detail.id}`, {
                              name: rename,
                              expectedVersion: detail.version,
                            }, "PUT"),
                          "小组名称已更新。",
                        )
                      }
                      disabled={!rename.trim() || rename.trim() === detail.name}
                    >
                      <Save size={14} /> 保存名称
                    </button>
                  )}
                  {canSeeState && (
                    <button
                      type="button"
                      className={detail.state === "DISABLED" ? "plain" : "plain danger"}
                      onClick={() => setConfirmState(true)}
                    >
                      {detail.state === "DISABLED" ? "恢复小组" : "停用小组"}
                    </button>
                  )}
                </span>
              </div>

              <div className="cw-detail-scroll">
                {canRename && (
                  <label className="field cw-detail-name">
                    小组名称
                    <input aria-label="小组名称" value={rename} maxLength={128} onChange={(event) => setRename(event.target.value)} />
                  </label>
                )}

                {confirmState && (
                  <div className="cw-confirm" role="alert">
                    <AlertTriangle size={16} />
                    <span>
                      {detail.state === "DISABLED"
                        ? "恢复后成员关系与既有角色保留，仍需有效负责人。确认恢复？"
                        : "停用不会删除成员或角色，但组内管理会暂停。确认停用？"}
                    </span>
                    <button
                      type="button"
                      className="plain"
                      onClick={() => {
                        setConfirmState(false);
                        void run(
                          () =>
                            request(`/cloud-management/groups/${detail.id}/state`, {
                              enabled: detail.state === "DISABLED",
                              expectedVersion: detail.version,
                            }),
                          detail.state === "DISABLED" ? "小组已恢复。" : "小组已停用。",
                        );
                      }}
                    >
                      确认
                    </button>
                    <button type="button" className="plain" onClick={() => setConfirmState(false)}>
                      取消
                    </button>
                  </div>
                )}

                <div className="cw-members">
                  <div className="cw-subsection-head">
                    <h3>成员</h3>
                    <span>{members.length} 人 · 负责人不能直接移除或退出</span>
                  </div>
                  <ul className="cw-list">
                    {members.map((member) => (
                      <li key={member.accountId} className="cw-row">
                        <div className="cw-row-main">
                          <strong>{member.displayName || member.username || member.accountId}</strong>
                          <span className="cw-meta">
                            {member.username && <span>@{member.username}</span>}
                            {member.accountId === detail.leaderAccountId && <Badge kind="ok">负责人</Badge>}
                            <Badge kind={member.state === "ACTIVE" ? "ok" : "muted"}>{stateText(member.state)}</Badge>
                            {member.accountState && member.accountState !== "ACTIVE" && (
                              <Badge kind="danger">账户{stateText(member.accountState)}</Badge>
                            )}
                          </span>
                        </div>
                        <span className="cw-actions">
                          {canTransfer && member.accountId !== detail.leaderAccountId && (
                            <button
                              type="button"
                              className="plain"
                              onClick={() =>
                                void run(
                                  () =>
                                    request(`/cloud-management/groups/${detail.id}/leader-transfers`, {
                                      accountId: member.accountId,
                                      expectedVersion: detail.version,
                                    }),
                                  "负责人已交接；原负责人仍是普通成员。",
                                )
                              }
                            >
                              设为负责人
                            </button>
                          )}
                          {canManage && member.accountId !== detail.leaderAccountId && (
                            confirmRemove === member.accountId ? (
                              <span className="cw-inline-confirm">
                                <button
                                  type="button"
                                  className="plain danger"
                                  onClick={() =>
                                    void run(
                                      () =>
                                        request(
                                          `/cloud-management/groups/${detail.id}/members/${member.accountId}`,
                                          { expectedVersion: detail.version },
                                          "DELETE",
                                        ),
                                      "成员已移除；本组角色授权同时撤销。",
                                    )
                                  }
                                >
                                  确认移除
                                </button>
                                <button type="button" className="plain" onClick={() => setConfirmRemove(null)}>
                                  取消
                                </button>
                              </span>
                            ) : (
                              <button type="button" className="plain" onClick={() => setConfirmRemove(member.accountId)}>
                                <UserMinus size={13} /> 移除
                              </button>
                            )
                          )}
                        </span>
                      </li>
                    ))}
                    {!members.length && (
                      <li className="cw-empty">
                        <strong>没有有效成员</strong>
                        <span>可通过下方“添加成员”按完整用户名查找。</span>
                      </li>
                    )}
                  </ul>

                  {selfIsLeader ? (
                    <p className="cw-hint">你是本组负责人，不能直接退出；请先交接负责人。</p>
                  ) : (
                    <button
                      type="button"
                      className="plain"
                      onClick={() =>
                        void run(
                          () =>
                            request(`/cloud-management/groups/${detail.id}/leave`, {
                              expectedVersion: detail.version,
                            }),
                          "已退出小组；本组角色授权同时撤销。",
                        )
                      }
                    >
                      退出本组
                    </button>
                  )}
                </div>

                {canManage && detail.state === "ACTIVE" && (
                  <div className="cw-inline-form">
                    <label className="field">
                      添加成员（完整用户名）
                      <input
                        aria-label="添加成员用户名"
                        value={addName}
                        spellCheck={false}
                        onChange={(event) => {
                          setAddName(event.target.value);
                          setCandidate(null);
                        }}
                      />
                    </label>
                    <button type="button" className="plain" onClick={() => void searchMember()}>
                      <Search size={14} /> 查找
                    </button>
                    {candidate && (
                      <button
                        type="button"
                        className="primary"
                        onClick={() =>
                          void run(
                            () =>
                              request(`/cloud-management/groups/${detail.id}/members`, {
                                accountId: candidate.id,
                                expectedVersion: detail.version,
                              }),
                            "成员已加入。",
                          )
                        }
                      >
                        <UserPlus size={14} /> 加入 {candidate.displayName || candidate.username}
                      </button>
                    )}
                  </div>
                )}

                {canTransfer && detail.state !== "DISABLED" && (
                  <div className="cw-inline-form">
                    <label className="field">
                      交接负责人（完整用户名）
                      <input
                        aria-label="交接负责人用户名"
                        value={transferName}
                        spellCheck={false}
                        onChange={(event) => {
                          setTransferName(event.target.value);
                          setTransferCandidate(null);
                        }}
                      />
                    </label>
                    <button type="button" className="plain" onClick={() => void searchTransfer()}>
                      <Search size={14} /> 查找
                    </button>
                    {transferCandidate && (
                      <button
                        type="button"
                        className="primary"
                        onClick={() =>
                          void run(
                            () =>
                              request(`/cloud-management/groups/${detail.id}/leader-transfers`, {
                                accountId: transferCandidate.id,
                                expectedVersion: detail.version,
                              }),
                            "负责人已交接。",
                          )
                        }
                      >
                        确认交接
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function AccountDevices({ account, request, guard, onAuthFailure, onClose }: {
  account: Account;
  request: LocalRequest;
  guard: <T>(task: () => Promise<T>) => Promise<T>;
  onAuthFailure: (failure: unknown) => string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<Page<Device> | null>(null);
  const [readFailure, setReadFailure] = useState<{ message: string; detail: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [current, setCurrent] = useState(account);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Device | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  async function load(offset = 0) {
    setBusy(true);
    setError("");
    setReadFailure(null);
    setPage(null);
    setSelected(null);
    setPassword("");
    try {
      const fresh = await guard(() => request<Account>(`/cloud-management/accounts/${account.id}`));
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (query.trim()) params.set("deviceId", query.trim());
      const result = await guard(() => request<Page<Device>>(`/cloud-management/accounts/${account.id}/devices?${params}`));
      setCurrent(fresh);
      setPage(result);
    } catch (failure) {
      const info = failure as CloudLastError;
      const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(info?.code || "") ? info.code : "";
      const status = typeof info?.status === "number" && info.status >= 400 && info.status <= 599 ? `HTTP ${info.status}` : "";
      setReadFailure({ message: onAuthFailure(failure), detail: [status, code].filter(Boolean).join(" · ") });
    }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [account.id]);
  async function revoke(event: FormEvent) {
    event.preventDefault();
    if (!selected || busy || !password) return;
    const target = selected;
    const currentPassword = password;
    setPassword("");
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await guard(() => request(`/cloud-management/accounts/${account.id}/devices/${target.id}/revoke`, {
        currentPassword, expectedSecurityVersion: current.securityVersion, expectedState: target.state,
      }));
      await load(page?.offset || 0);
      setSuccess("设备已撤销，账户及素材已保留。用户可在原电脑重新开通。");
    } catch (failure) { setError(onAuthFailure(failure)); }
    finally { setBusy(false); }
  }
  return (
    <dialog ref={dialog} className="cw-device-dialog" aria-label="账户设备管理" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <header className="cw-device-head">
        <span className="cw-device-symbol"><Monitor size={21} /></span>
        <div><h2>设备管理</h2><p>{account.displayName || account.username} <span>@{account.username}</span></p></div>
        <button type="button" className="plain cw-device-icon" aria-label="关闭设备管理" title="关闭设备管理" disabled={busy} onClick={onClose}><X size={18} /></button>
      </header>
      <form className="cw-device-toolbar" onSubmit={event => { event.preventDefault(); void load(); }}>
        <div className="cw-device-search"><Search size={16} /><input aria-label="精确查找设备 ID" value={query} maxLength={64} disabled={busy} onChange={event => setQuery(event.target.value)} placeholder="输入完整设备 ID" /></div>
        <button type="submit" className="plain" disabled={busy}>查询</button>
        <button type="button" className="plain cw-device-icon" aria-label="刷新设备列表" title="刷新设备列表" disabled={busy} onClick={() => void load(page?.offset || 0)}><RefreshCw size={16} className={busy ? "spin" : ""} /></button>
      </form>
      <div className="cw-device-scroll" aria-busy={busy}>
        <Notice error={error} success={success} />
        {readFailure ? <div className="cw-device-state" role="alert">
          <span className="cw-device-state-icon"><AlertTriangle size={26} /></span>
          <h3>设备列表暂不可用</h3><p>{readFailure.message}</p>
          {readFailure.detail && <code>{readFailure.detail}</code>}
          <button type="button" className="plain" disabled={busy} onClick={() => void load()}><RefreshCw size={14} />重新读取</button>
        </div> : !page ? <div className="cw-device-state" role="status"><LoaderCircle size={24} className="spin" /><p>正在读取设备…</p></div> : !page.items.length ? <div className="cw-device-state"><Monitor size={28} /><h3>没有匹配的设备</h3><p>{query.trim() ? "请核对设备 ID 后重新查询。" : "该账户尚无已登记设备。"}</p></div> : <ul className="cw-device-list">
          {page.items.map(device => <li key={device.id}>
            <div className="cw-device-row-title"><Monitor size={18} /><strong>{device.name}</strong><Badge kind={device.state === "ACTIVE" ? "ok" : device.state === "REVOKED" ? "muted" : "warn"}>{stateText(device.state)}</Badge></div>
            <div className="cw-device-id"><code>{device.id}</code><button type="button" className="plain cw-device-icon" aria-label="复制设备 ID" title="复制设备 ID" onClick={() => void navigator.clipboard.writeText(device.id).catch(() => setError("复制失败，请手动选中设备 ID"))}><Copy size={13} /></button></div>
            <dl className="cw-device-dates"><div><dt>登记时间</dt><dd>{displayTime(device.createdAt)}</dd></div><div><dt>证书到期</dt><dd>{displayTime(device.certificateExpiresAt)}</dd></div></dl>
            {["PENDING", "ACTIVE"].includes(device.state) && selected?.id !== device.id && <button type="button" className="text-button cw-device-revoke" disabled={busy} onClick={() => { setSelected(device); setPassword(""); setSuccess(""); }}><UserMinus size={14} />撤销设备</button>}
            {selected?.id === device.id && <form className="cw-device-confirm" onSubmit={event => void revoke(event)}>
              <div className="cw-device-confirm-title"><AlertTriangle size={16} /><strong>确认撤销此设备？</strong></div>
              <p>会话、关联开通码和激活凭证将失效，账户与素材不受影响。</p>
              <label>超级管理员密码<input type="password" autoComplete="current-password" aria-label="撤销设备的管理员密码" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label>
              <div className="cw-device-confirm-actions"><button type="button" className="plain" disabled={busy} onClick={() => { setSelected(null); setPassword(""); }}>取消</button><button type="submit" className="plain cw-device-danger" disabled={busy || !password}>{busy ? <LoaderCircle size={14} className="spin" /> : <UserMinus size={14} />}确认撤销</button></div>
            </form>}
          </li>)}
        </ul>}
      </div>
      {page && <footer className="cw-device-footer"><span>共 {page.total} 台设备</span><div><button type="button" className="plain cw-device-icon" aria-label="设备上一页" title="上一页" disabled={busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - PAGE_SIZE))}><ChevronLeft size={16} /></button><span>{Math.floor(page.offset / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil(page.total / PAGE_SIZE))}</span><button type="button" className="plain cw-device-icon" aria-label="设备下一页" title="下一页" disabled={busy || page.offset + page.limit >= page.total} onClick={() => void load(page.offset + PAGE_SIZE)}><ChevronRight size={16} /></button></div></footer>}
    </dialog>
  );
}

function AccountsPanel({
  capabilities,
  request,
  guard,
  onAuthFailure,
}: {
  capabilities: Capabilities;
  request: LocalRequest;
  guard: <T>(task: () => Promise<T>) => Promise<T>;
  onAuthFailure: (failure: unknown) => string;
}) {
  const system = useMemo(() => new Set(capabilities.systemPermissions), [capabilities.systemPermissions]);
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<Page<Account>>({ items: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [secret, setSecret] = useState<{ title: string; code: string; expiresAt: string | null; openingId?: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [confirmState, setConfirmState] = useState<{ account: Account; enable: boolean; emergency: boolean } | null>(null);
  const [resetFor, setResetFor] = useState<Account | null>(null);
  const [devicesFor, setDevicesFor] = useState<Account | null>(null);
  const [ownerPassword, setOwnerPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const canRead = system.has("account:read");
  const canCreate = system.has("account:create");
  const canDisable = system.has("account:disable");
  const isOwner = capabilities.superAdmin;

  const load = useCallback(
    async (nextOffset = offset) => {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams();
        if (query.trim()) params.set("query", query.trim());
        if (state) params.set("state", state);
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(nextOffset));
        const result = await guard(() => request<Page<Account>>(`/cloud-management/accounts?${params.toString()}`));
        setPage(result);
        setOffset(result.offset);
      } catch (failure) {
        setError(onAuthFailure(failure));
      } finally {
        setLoading(false);
      }
    },
    [guard, offset, onAuthFailure, query, request, state],
  );

  useEffect(() => {
    // 只有 account:read 才请求全局账户列表；仅 account:create 不得为了显示表单
    // 附带读取，也不把创建权限等同于读取权限。
    if (canRead) void load(0);
    // 初次进入按空条件读取；之后由“搜索”按钮显式触发，避免每次输入都打云端。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canRead]);

  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await action();
      if (canRead) await load(offset);
      setSuccess(done);
    } catch (failure) {
      const text = onAuthFailure(failure);
      setError(text);
    } finally {
      setBusy(false);
    }
  }

  async function createAccount(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!newUsername.trim() || !newDisplayName.trim()) {
      setError("请填写用户名和显示名");
      return;
    }
    setBusy(true);
    try {
      const opening = await guard(() =>
        request<Opening>("/cloud-management/accounts", {
          username: newUsername.trim().toLowerCase(),
          displayName: newDisplayName.trim(),
        }),
      );
      setNewUsername("");
      setNewDisplayName("");
      setCreateOpen(false);
      setSecret({ title: `@${opening.username} 的一次性开通码`, code: opening.openingCode, expiresAt: opening.expiresAt, openingId: opening.id });
      if (canRead) await load(0);
      setSuccess("账户已创建（待激活）；开通码只显示这一次。");
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword(event: FormEvent) {
    event.preventDefault();
    if (!resetFor) return;
    setError("");
    setSuccess("");
    if (!ownerPassword) {
      setError("请输入你本人当前密码以确认");
      return;
    }
    const submitted = ownerPassword;
    setOwnerPassword("");
    setBusy(true);
    try {
      const result = await guard(() =>
        request<Reset>(`/cloud-management/accounts/${resetFor.id}/password-reset`, {
          expectedSecurityVersion: resetFor.securityVersion,
          currentPassword: submitted,
        }),
      );
      setResetFor(null);
      setSecret({ title: `@${resetFor.username} 的一次性重置码`, code: result.resetToken, expiresAt: result.expiresAt });
      setSuccess("重置码已签发；目标旧会话会在完成重置时撤销。");
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="cw-panel cw-accounts-panel" aria-label="账户管理">
      <div className="cw-pagebar">
        <div className="cw-pagebar-title">
          <h2>账户管理</h2>
          <p>
            {canRead
              ? `${page.total} 个账户`
              : "当前角色仅可创建待激活账户，不读取全局列表"}
          </p>
        </div>
        <div className="cw-pagebar-actions">
          {canRead && (
            <button type="button" className="plain" onClick={() => void load(offset)} disabled={loading} title="刷新账户列表">
              <RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新
            </button>
          )}
          {canCreate && (
            <button type="button" className="primary" onClick={() => setCreateOpen((open) => !open)}>
              <Plus size={14} /> 创建待激活账户
            </button>
          )}
        </div>
      </div>

      {canRead && (
        <form
          className="cw-filterbar"
          onSubmit={(event) => {
            event.preventDefault();
            void load(0);
          }}
        >
          <label className="field">
            搜索用户名/显示名
            <input
              aria-label="搜索账户"
              value={query}
              maxLength={128}
              placeholder="输入用户名或显示名"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="field cw-field-narrow">
            状态
            <select aria-label="账户状态筛选" value={state} onChange={(event) => setState(event.target.value)}>
              <option value="">全部</option>
              <option value="ACTIVE">启用</option>
              <option value="PENDING">待激活</option>
              <option value="DISABLED">停用</option>
            </select>
          </label>
          <button type="submit" className="plain" disabled={loading}>
            <Search size={14} /> 搜索
          </button>
        </form>
      )}

      {createOpen && (
        <form className="cw-inline-editor" onSubmit={createAccount} aria-label="创建待激活账户">
          <div className="cw-inline-editor-head">
            <h2>创建待激活账户</h2>
            <span>创建后不入组、不授予角色；开通码只显示一次。</span>
          </div>
          <div className="cw-form-grid">
            <label className="field">
              用户名
              <input
                aria-label="新账户用户名"
                autoComplete="off"
                spellCheck={false}
                placeholder="小写字母/数字/点/横线/下划线"
                value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)}
              />
            </label>
            <label className="field">
              显示名
              <input
                aria-label="新账户显示名"
                maxLength={128}
                value={newDisplayName}
                onChange={(event) => setNewDisplayName(event.target.value)}
              />
            </label>
          </div>
          <p className="cw-hint">用户名规范为小写字母/数字/点/横线/下划线，3–64 位。</p>
          <div className="cw-inline-editor-foot">
            <button type="button" className="plain" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button type="submit" className="primary" disabled={busy}>
              创建并签发开通码
            </button>
          </div>
        </form>
      )}

      <Notice error={error} success={success} />
      {secret && (
        <OneTimeSecret
          title={secret.title}
          code={secret.code}
          expiresAt={secret.expiresAt}
          onDismiss={() => setSecret(null)}
          extra={
            secret.openingId && isOwner ? (
              <button
                type="button"
                className="plain danger"
                onClick={() => {
                  const codeId = secret.openingId;
                  void act(async () => {
                    await guard(() => request(`/cloud-management/opening-codes/${codeId}`, undefined, "DELETE"));
                    setSecret(null);
                  }, "本次显示的开通码已撤销。");
                }}
              >
                撤销此码
              </button>
            ) : undefined
          }
        />
      )}

      {resetFor && (
        <form className="cw-inline-editor" onSubmit={resetPassword} aria-label="签发密码重置码">
          <div className="cw-inline-editor-head">
            <h2>为 @{resetFor.username} 签发重置码</h2>
            <span>只有唯一 owner 可以发起；重置码仅本次显示。</span>
          </div>
          <p className="cw-hint">
            目标必须是启用中的非 owner 账户。需要你本人当前密码确认；完成重置时撤销目标旧会话。
          </p>
          <div className="cw-form-grid">
            <label className="field">
              我本人的当前密码
              <input
                aria-label="操作者当前密码"
                type="password"
                autoComplete="current-password"
                value={ownerPassword}
                disabled={busy}
                onChange={(event) => setOwnerPassword(event.target.value)}
              />
            </label>
          </div>
          <div className="cw-inline-editor-foot">
            <button
              type="button"
              className="plain"
              onClick={() => {
                setOwnerPassword("");
                setResetFor(null);
              }}
            >
              取消
            </button>
            <button type="submit" className="primary" disabled={busy}>
              确认签发
            </button>
          </div>
        </form>
      )}

      {confirmState && (
        <div className="cw-confirm" role="alert">
          <AlertTriangle size={16} />
          <span>
            {confirmState.enable
              ? `确认启用 @${confirmState.account.username}？会提升安全版本，不恢复旧会话。`
              : confirmState.emergency
                ? `紧急封禁 @${confirmState.account.username}：会同时撤销会话，其负责的小组进入“需指定负责人”。确认？`
                : `确认停用 @${confirmState.account.username}？版本必须仍为 ${confirmState.account.securityVersion}。`}
          </span>
          <button
            type="button"
            className="plain danger"
            disabled={busy}
            onClick={() => {
              const target = confirmState;
              void act(async () => {
                try {
                  await guard(() =>
                    request(`/cloud-management/accounts/${target.account.id}/state`, {
                      enabled: target.enable,
                      expectedSecurityVersion: target.account.securityVersion,
                      emergency: target.emergency,
                    }),
                  );
                  setConfirmState(null);
                } catch (failure) {
                  if (!target.enable && !target.emergency && (failure as CloudLastError)?.code === "LEADER_TRANSFER_REQUIRED") {
                    setConfirmState({ ...target, emergency: true });
                    throw failure;
                  }
                  throw failure;
                }
              }, confirmState.enable ? "账户已启用。" : "账户已停用。");
            }}
          >
            确认
          </button>
          <button type="button" className="plain" onClick={() => setConfirmState(null)}>
            取消
          </button>
        </div>
      )}

      {devicesFor && isOwner && <AccountDevices key={devicesFor.id} account={devicesFor} request={request} guard={guard} onAuthFailure={onAuthFailure} onClose={() => setDevicesFor(null)} />}
      {canRead ? (
        <div className="cw-surface cw-list-surface">
          <div className="cw-list-caption">
            <span>账户</span>
            <span>共 {page.total} 条</span>
          </div>
          <ul className="cw-list cw-account-list">
            {page.items.map((account) => (
              <li key={account.id} className="cw-row">
                <div className="cw-row-main">
                  <strong>
                    {account.displayName || account.username} <span className="cw-username">@{account.username}</span>
                  </strong>
                  <span className="cw-meta">
                    <Badge kind={account.state === "ACTIVE" ? "ok" : account.state === "DISABLED" ? "danger" : "warn"}>
                      {stateText(account.state)}
                    </Badge>
                    {account.superAdmin && <Badge kind="warn">唯一 owner</Badge>}
                    <span>安全版本 {account.securityVersion}</span>
                    <span>创建于 {displayTime(account.createdAt)}</span>
                  </span>
                </div>
                <span className="cw-actions">
                  {isOwner && !account.superAdmin && (
                    <>
                      <button type="button" className="plain" disabled={busy} onClick={() => setDevicesFor(account)}><ShieldCheck size={13} />设备管理</button>
                      {account.state === "ACTIVE" && (
                        <button
                          type="button"
                          className="plain"
                          disabled={busy}
                          onClick={() => {
                            setOwnerPassword("");
                            setResetFor(account);
                          }}
                        >
                          <KeyRound size={13} /> 重置码
                        </button>
                      )}
                      {account.state !== "DISABLED" && (
                        <button
                          type="button"
                          className="plain"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const opening = await guard(() =>
                                request<Opening>(`/cloud-management/accounts/${account.id}/opening-codes`, {}),
                              );
                              setSecret({
                                title: `@${opening.username} 的一次性开通码`,
                                code: opening.openingCode,
                                expiresAt: opening.expiresAt,
                                openingId: opening.id,
                              });
                            }, "已签发新的设备开通码。")
                          }
                        >
                          发开通码
                        </button>
                      )}
                    </>
                  )}
                  {canDisable && !account.superAdmin && account.state !== "PENDING" && (
                    <button
                      type="button"
                      className="plain"
                      disabled={busy}
                      onClick={() => setConfirmState({ account, enable: account.state !== "ACTIVE", emergency: false })}
                    >
                      {account.state === "ACTIVE" ? "停用" : "启用"}
                    </button>
                  )}
                </span>
              </li>
            ))}
            {!page.items.length && !loading && (
              <li className="cw-empty">
                <strong>没有匹配的账户</strong>
                <span>调整用户名/状态筛选后重新搜索。</span>
              </li>
            )}
          </ul>
          <Pager offset={offset} limit={PAGE_SIZE} total={page.total} onChange={(next) => void load(next)} />
        </div>
      ) : (
        <div className="cw-surface cw-only-create">
          <h2>仅创建账户</h2>
          <p className="cw-hint">
            当前角色只有创建待激活账户的权限，不会读取全局账户列表；创建后的一次性开通码只显示这一次。
          </p>
          {!canCreate && <p className="cw-hint">当前角色没有创建账户权限。</p>}
        </div>
      )}
    </section>
  );
}

function RolesPanel({
  capabilities,
  request,
  guard,
  onAuthFailure,
}: {
  capabilities: Capabilities;
  request: LocalRequest;
  guard: <T>(task: () => Promise<T>) => Promise<T>;
  onAuthFailure: (failure: unknown) => string;
}) {
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [editing, setEditing] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"roles" | "auth">("roles");
  const [authLoading, setAuthLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newScope, setNewScope] = useState<"SYSTEM" | "GROUP">("GROUP");
  const [newPerms, setNewPerms] = useState<string[]>([]);
  const [assignFor, setAssignFor] = useState<Page<Account> | null>(null);
  const [assignQuery, setAssignQuery] = useState("");
  const [assignAccount, setAssignAccount] = useState<Account | null>(null);
  const [assignments, setAssignments] = useState<Page<Assignment> | null>(null);
  const [assignRoleId, setAssignRoleId] = useState("");
  const [assignGroupId, setAssignGroupId] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);

  const role = roles.find((item) => item.role.id === selectedRole) || null;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [catalog, list] = await Promise.all([
        guard(() => request<Permission[]>("/cloud-management/permissions")),
        guard(() => request<RoleView[]>("/cloud-management/roles?limit=100&offset=0")),
      ]);
      setPermissions(catalog);
      setRoles(list);
      setSelectedRole((current) => current || list[0]?.role.id || null);
      setAssignRoleId((current) => current || list[0]?.role.id || "");
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setLoading(false);
    }
  }, [guard, onAuthFailure, request]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadImpact = useCallback(
    async (roleId: string) => {
      setError("");
      try {
        const value = await guard(() => request<Impact>(`/cloud-management/roles/${roleId}/impact?limit=50&offset=0`));
        setImpact(value);
      } catch (failure) {
        setError(onAuthFailure(failure));
        setImpact(null);
      }
    },
    [guard, onAuthFailure, request],
  );

  useEffect(() => {
    if (!role) {
      setImpact(null);
      setEditing([]);
      return;
    }
    setEditing(role.permissions);
    void loadImpact(role.role.id);
  }, [role, loadImpact]);

  const catalogFor = (scope: string, builtIn = false) =>
    permissions.filter((p) => p.scopeType === scope && (builtIn || p.customAssignable));

  async function savePermissions() {
    if (!role) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await guard(() =>
        request(`/cloud-management/roles/${role.role.id}/permissions`, {
          expectedVersion: role.role.version,
          permissions: editing,
        }, "PUT"),
      );
      await load();
      setSuccess("角色权限已更新；受影响的现有授权按新权限生效。");
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  async function createRole(event: FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess("");
    if (!newCode.trim() || !newName.trim()) {
      setError("请填写角色编码和名称");
      return;
    }
    if (RESERVED_ROLES.has(newCode.trim().toUpperCase())) {
      setError("保留身份不能创建为自定义角色");
      return;
    }
    setBusy(true);
    try {
      await guard(() =>
        request("/cloud-management/roles", {
          code: newCode.trim().toUpperCase(),
          name: newName.trim(),
          scopeType: newScope,
          permissions: newPerms,
        }),
      );
      setCreateOpen(false);
      setNewCode("");
      setNewName("");
      setNewPerms([]);
      await load();
      setSuccess("自定义角色已创建。");
    } catch (failure) {
      setError(onAuthFailure(failure));
    } finally {
      setBusy(false);
    }
  }

  const loadAuthAccounts = useCallback(
    async (text: string) => {
      setAuthLoading(true);
      setError("");
      try {
        const params = new URLSearchParams({ limit: "20", offset: "0" });
        if (text.trim()) params.set("query", text.trim());
        const value = await guard(() => request<Page<Account>>(`/cloud-management/accounts?${params.toString()}`));
        setAssignFor(value);
        setAssignAccount(null);
        setAssignments(null);
      } catch (failure) {
        setError(onAuthFailure(failure));
        setAssignFor(null);
      } finally {
        setAuthLoading(false);
      }
    },
    [guard, onAuthFailure, request],
  );

  async function searchAccounts(event: FormEvent) {
    event.preventDefault();
    await loadAuthAccounts(assignQuery);
  }

  useEffect(() => {
    // 首次进入“账户授权”时按空条件加载一次；失败后由用户点搜索/刷新，不自动轮询。
    if (view === "auth") void loadAuthAccounts("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function loadAssignments(account: Account) {
    setAssignAccount(account);
    setError("");
    try {
      const value = await guard(() =>
        request<Page<Assignment>>(`/cloud-management/accounts/${account.id}/role-assignments?limit=50&offset=0`),
      );
      setAssignments(value);
    } catch (failure) {
      setError(onAuthFailure(failure));
      setAssignments(null);
    }
  }

  // 组列表只服务“账户授权”里的 GROUP 角色分配；未进入该子视图不预取（T-LOCAL-011）。
  const groupsLoaded = useRef(false);
  useEffect(() => {
    if (view !== "auth" || groupsLoaded.current) return;
    groupsLoaded.current = true;
    let alive = true;
    (async () => {
      try {
        const list = await guard(() => request<Group[]>("/cloud-management/groups?management=true&limit=100&offset=0"));
        if (alive) setGroups(list);
      } catch {
        try {
          const list = await guard(() => request<Group[]>("/cloud-management/groups?management=false&limit=100&offset=0"));
          if (alive) setGroups(list);
        } catch {
          /* 组列表只是分配的可选辅助 */
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [guard, request, view]);

  const roleScope = role?.role.scopeType || "GROUP";
  const roleBuiltIn = role?.role.builtIn || false;
  const editablePermissions = useMemo(
    () =>
      permissions.filter(
        (permission) => permission.scopeType === roleScope && (roleBuiltIn || permission.customAssignable),
      ),
    [permissions, roleBuiltIn, roleScope],
  );
  const permissionGroups = useMemo(() => {
    const grouped = new Map<string, Permission[]>();
    for (const permission of editablePermissions) {
      const prefix = permission.code.split(":")[0] || "other";
      grouped.set(prefix, [...(grouped.get(prefix) || []), permission]);
    }
    return [...grouped.entries()];
  }, [editablePermissions]);
  const dirty =
    !!role &&
    (editing.length !== role.permissions.length || editing.some((code) => !role.permissions.includes(code)));
  const assignableRoles = roles.filter((item) => !RESERVED_ROLES.has(item.role.code));
  const reservedRole = !!role && RESERVED_ROLES.has(role.role.code);

  return (
    <section className="cw-panel" aria-label="角色与授权">
      <div className="cw-pagebar">
        <div className="cw-pagebar-title">
          <h2>角色与授权</h2>
          <p>
            {view === "roles"
              ? `${roles.length} 个角色 · ${roles.filter((item) => item.role.builtIn).length} 个内置身份 · 权限按现有范围编辑`
              : `${assignFor?.total ?? 0} 个账户 · 按账户查看或调整授权`}
          </p>
        </div>
        <div className="cw-pagebar-actions">
          <button
            type="button"
            className="plain"
            onClick={() => void (view === "roles" ? load() : loadAuthAccounts(assignQuery))}
            disabled={loading || authLoading}
            title="刷新角色与授权"
          >
            <RefreshCw size={14} className={loading || authLoading ? "spin" : ""} /> 刷新
          </button>
          {view === "roles" && (
            <button type="button" className="primary" onClick={() => setCreateOpen((open) => !open)}>
              <Plus size={14} /> 创建自定义角色
            </button>
          )}
        </div>
      </div>

      <div className="cw-subtabs" aria-label="角色与授权视图">
        <button
          type="button"
          aria-label="角色权限"
          aria-pressed={view === "roles"}
          className={view === "roles" ? "active" : ""}
          onClick={() => {
            setView("roles");
            setError("");
            setSuccess("");
          }}
        >
          角色权限 <span className="cw-count">{roles.length}</span>
        </button>
        <button
          type="button"
          aria-label="账户授权"
          aria-pressed={view === "auth"}
          className={view === "auth" ? "active" : ""}
          onClick={() => {
            setView("auth");
            setError("");
            setSuccess("");
          }}
        >
          账户授权
        </button>
      </div>

      <Notice error={error} success={success} />

      {createOpen && (
        <form className="cw-inline-editor" onSubmit={createRole} aria-label="创建自定义角色">
          <div className="cw-inline-editor-head">
            <h2>创建自定义角色</h2>
            <span>保留身份不可创建；创建后回到角色列表分配权限。</span>
          </div>
          <div className="cw-form-grid">
            <label className="field">
              角色编码（大写字母/数字/下划线）
              <input aria-label="角色编码" value={newCode} spellCheck={false} onChange={(event) => setNewCode(event.target.value)} />
            </label>
            <label className="field">
              角色名称
              <input aria-label="角色名称" maxLength={128} value={newName} onChange={(event) => setNewName(event.target.value)} />
            </label>
            <label className="field">
              范围
              <select
                aria-label="角色范围"
                value={newScope}
                onChange={(event) => {
                  setNewScope(event.target.value as "SYSTEM" | "GROUP");
                  setNewPerms([]);
                }}
              >
                <option value="GROUP">GROUP（绑定具体小组）</option>
                <option value="SYSTEM">SYSTEM（全局）</option>
              </select>
            </label>
          </div>
          <fieldset className="cw-perms">
            <legend>可分配权限</legend>
            <div className="cw-perm-grid">
              {catalogFor(newScope).map((permission) => (
                <label key={permission.code} className="cw-check">
                  <input
                    type="checkbox"
                    checked={newPerms.includes(permission.code)}
                    onChange={(event) =>
                      setNewPerms((current) =>
                        event.target.checked ? [...current, permission.code] : current.filter((code) => code !== permission.code),
                      )
                    }
                  />
                  {permission.code}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="cw-inline-editor-foot">
            <button type="button" className="plain" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button type="submit" className="primary" disabled={busy}>
              创建
            </button>
          </div>
        </form>
      )}

      {view === "roles" ? (
        <div className="cw-workbench cw-roles-workbench">
          <aside className="cw-master" aria-label="角色列表">
            <div className="cw-master-head">
              <span>角色</span>
              <span>{roles.length}</span>
            </div>
            {loading && !roles.length ? (
              <p className="cw-loading">
                <LoaderCircle size={14} className="spin" /> 读取中…
              </p>
            ) : (
              <ul className="cw-list cw-select-list">
                {roles.map((item) => (
                  <li key={item.role.id}>
                    <button
                      type="button"
                      className={selectedRole === item.role.id ? "active" : ""}
                      aria-current={selectedRole === item.role.id ? "true" : undefined}
                      onClick={() => setSelectedRole(item.role.id)}
                    >
                      <span className="cw-row-main">
                        <strong>{item.role.name}</strong>
                        <span className="cw-meta">
                          <span>{item.role.code}</span>
                          <Badge kind={item.role.scopeType === "SYSTEM" ? "warn" : "muted"}>{item.role.scopeType}</Badge>
                          {item.role.builtIn && <Badge kind="muted">内置</Badge>}
                          <span>v{item.role.version}</span>
                        </span>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  </li>
                ))}
                {!roles.length && (
                  <li className="cw-empty cw-empty-action">
                    <strong>暂无角色</strong>
                    <span>创建自定义角色后即可分配权限。</span>
                    <button type="button" className="plain" onClick={() => setCreateOpen(true)}>
                      <Plus size={13} /> 新建角色
                    </button>
                  </li>
                )}
              </ul>
            )}
          </aside>

          <div className="cw-detail-pane cw-detail">
            {!role ? (
              <div className="cw-empty-state">
                <ShieldCheck size={22} />
                <h2>{roles.length ? "选择一个角色" : "还没有角色"}</h2>
                <p>
                  {roles.length
                    ? "从左侧选择角色，查看权限分组、版本与受影响的授权。"
                    : "创建自定义角色后即可分配权限；唯一 owner / 组长身份为保留关系，不在此编辑。"}
                </p>
                {!roles.length && !loading && (
                  <button type="button" className="primary" onClick={() => setCreateOpen(true)}>
                    <Plus size={14} /> 创建自定义角色
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="cw-detail-head">
                  <div className="cw-detail-title">
                    <h2>{role.role.name}</h2>
                    <span className="cw-meta">
                      <span>{role.role.code}</span>
                      <Badge kind={role.role.scopeType === "SYSTEM" ? "warn" : "muted"}>{role.role.scopeType}</Badge>
                      {role.role.builtIn && <Badge kind="muted">内置</Badge>}
                      <span>版本 v{role.role.version}</span>
                    </span>
                  </div>
                  <span className="cw-detail-badges">
                    <Badge kind={impact?.totalAssignments ? "warn" : "muted"}>
                      影响 {impact ? impact.totalAssignments : "…"} 条授权
                    </Badge>
                  </span>
                </div>

                {reservedRole ? (
                  <p className="cw-hint cw-notice-line">
                    保留身份不通过普通角色分配或编辑；组长权限从小组负责人关系派生。
                  </p>
                ) : (
                  <>
                    <div className="cw-detail-scroll">
                      <div className="cw-perm-groups">
                        {permissionGroups.map(([prefix, items]) => (
                          <section className="cw-perm-group" key={prefix} aria-label={`${permissionGroupLabel(prefix)}权限`}>
                            <h3>
                              {permissionGroupLabel(prefix)} <span>{items.length}</span>
                            </h3>
                            <div className="cw-perm-grid">
                              {items.map((permission) => (
                                <label key={permission.code} className="cw-check">
                                  <input
                                    type="checkbox"
                                    checked={editing.includes(permission.code)}
                                    onChange={(event) =>
                                      setEditing((current) =>
                                        event.target.checked
                                          ? [...current, permission.code]
                                          : current.filter((code) => code !== permission.code),
                                      )
                                    }
                                  />
                                  {permission.code}
                                </label>
                              ))}
                            </div>
                          </section>
                        ))}
                        {!permissionGroups.length && <p className="cw-empty">该范围没有可编辑权限。</p>}
                      </div>

                      {impact && (
                        <section className="cw-impact">
                          <h3>
                            授权影响 <span>前 {impact.assignments.length} 条 / 共 {impact.totalAssignments} 条</span>
                          </h3>
                          <ul className="cw-list">
                            {impact.assignments.map((assignment) => (
                              <li key={assignment.id} className="cw-row">
                                <span className="cw-row-main">
                                  <strong>{assignment.accountId}</strong>
                                  <span className="cw-meta">
                                    <span>{assignment.scopeType}</span>
                                    {assignment.groupId && <span>小组 {assignment.groupId}</span>}
                                    <span>由 {assignment.grantedBy || "—"} 授予</span>
                                  </span>
                                </span>
                              </li>
                            ))}
                            {!impact.assignments.length && <li className="cw-empty">该角色目前没有授权记录。</li>}
                          </ul>
                        </section>
                      )}
                    </div>

                    <div className="cw-detail-foot">
                      <span className="cw-hint">保存前请核对影响范围；版本冲突时不会自动覆盖。</span>
                      <div className="cw-actions">
                        <button
                          type="button"
                          className="plain"
                          disabled={!dirty || busy}
                          onClick={() => setEditing(role.permissions)}
                        >
                          <Undo2 size={13} /> 撤销更改
                        </button>
                        <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void savePermissions()}>
                          <Save size={14} /> 保存权限
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="cw-auth">
          <form className="cw-filterbar" onSubmit={searchAccounts}>
            <label className="field">
              搜索账户（用户名/显示名）
              <input
                aria-label="授权账户搜索"
                value={assignQuery}
                maxLength={128}
                placeholder="输入完整用户名或显示名"
                onChange={(event) => setAssignQuery(event.target.value)}
              />
            </label>
            <button type="submit" className="plain" disabled={authLoading}>
              <Search size={14} /> 搜索
            </button>
            <span className="cw-filter-hint">仅可分配非保留角色；GROUP 角色需要指定具体小组。</span>
          </form>

          <div className="cw-workbench cw-auth-workbench">
            <aside className="cw-master" aria-label="账户授权列表">
              <div className="cw-master-head">
                <span>账户</span>
                <span>{assignFor?.total ?? "—"}</span>
              </div>
              {authLoading && !assignFor ? (
                <p className="cw-loading">
                  <LoaderCircle size={14} className="spin" /> 读取中…
                </p>
              ) : assignFor ? (
                <>
                  <ul className="cw-list cw-select-list">
                    {assignFor.items.map((account) => (
                      <li key={account.id}>
                        <button
                          type="button"
                          className={assignAccount?.id === account.id ? "active" : ""}
                          aria-current={assignAccount?.id === account.id ? "true" : undefined}
                          onClick={() => void loadAssignments(account)}
                        >
                          <span className="cw-row-main">
                            <strong>{account.displayName || account.username}</strong>
                            <span className="cw-meta">
                              <span>@{account.username}</span>
                              <Badge kind={account.state === "ACTIVE" ? "ok" : "danger"}>{stateText(account.state)}</Badge>
                            </span>
                          </span>
                          <ChevronRight size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                  {!assignFor.items.length && (
                    <div className="cw-empty cw-empty-action">
                      <strong>没有匹配账户</strong>
                      <span>试试完整用户名或显示名；不会伪造账户数据。</span>
                    </div>
                  )}
                </>
              ) : (
                <div className="cw-empty cw-empty-action">
                  <strong>无法读取账户</strong>
                  <span>检查权限或重新搜索。</span>
                </div>
              )}
            </aside>

            <div className="cw-detail-pane cw-detail">
              {!assignAccount ? (
                <div className="cw-empty-state">
                  <UserPlus size={22} />
                  <h2>选择一个账户</h2>
                  <p>从左侧选择账户，查看当前角色授权并新增或撤销授权。</p>
                </div>
              ) : (
                <>
                  <div className="cw-detail-head">
                    <div className="cw-detail-title">
                      <h2>{assignAccount.displayName || assignAccount.username}</h2>
                      <span className="cw-meta">
                        <span>@{assignAccount.username}</span>
                        <Badge kind={assignAccount.state === "ACTIVE" ? "ok" : "danger"}>{stateText(assignAccount.state)}</Badge>
                      </span>
                    </div>
                    <span className="cw-detail-badges">
                      <Badge kind="muted">安全版本 {assignAccount.securityVersion}</Badge>
                    </span>
                  </div>

                  <div className="cw-detail-scroll">
                    <section className="cw-assign-section">
                      <h3>
                        当前授权 <span>{assignments?.total ?? "…"}</span>
                      </h3>
                      <ul className="cw-list">
                        {(assignments?.items || []).map((assignment) => (
                          <li key={assignment.id} className="cw-row">
                            <span className="cw-row-main">
                              <strong>
                                {roles.find((item) => item.role.id === assignment.roleId)?.role.name || assignment.roleId}
                              </strong>
                              <span className="cw-meta">
                                <Badge kind={assignment.scopeType === "SYSTEM" ? "warn" : "muted"}>{assignment.scopeType}</Badge>
                                {assignment.groupId && (
                                  <span>小组 {groups.find((group) => group.id === assignment.groupId)?.name || assignment.groupId}</span>
                                )}
                              </span>
                            </span>
                            <button
                              type="button"
                              className="plain danger"
                              disabled={busy}
                              onClick={() =>
                                void (async () => {
                                  setBusy(true);
                                  setError("");
                                  try {
                                    await guard(() =>
                                      request(`/cloud-management/role-assignments/${assignment.id}`, undefined, "DELETE"),
                                    );
                                    await loadAssignments(assignAccount);
                                    setSuccess("授权已撤销；重新入组不会恢复旧角色。");
                                  } catch (failure) {
                                    setError(onAuthFailure(failure));
                                  } finally {
                                    setBusy(false);
                                  }
                                })()
                              }
                            >
                              撤销
                            </button>
                          </li>
                        ))}
                        {!assignments?.items.length && <li className="cw-empty">该账户没有有效授权。</li>}
                      </ul>
                    </section>

                    <section className="cw-assign-section">
                      <h3>新增授权</h3>
                      <div className="cw-inline-form">
                        <label className="field">
                          角色
                          <select aria-label="要授予的角色" value={assignRoleId} onChange={(event) => setAssignRoleId(event.target.value)}>
                            {assignableRoles.map((item) => (
                              <option key={item.role.id} value={item.role.id}>
                                {item.role.name}（{item.role.code}）
                              </option>
                            ))}
                          </select>
                        </label>
                        {roles.find((item) => item.role.id === assignRoleId)?.role.scopeType === "GROUP" && (
                          <label className="field">
                            小组
                            <select aria-label="授予的小组" value={assignGroupId} onChange={(event) => setAssignGroupId(event.target.value)}>
                              <option value="">选择小组</option>
                              {groups.map((group) => (
                                <option key={group.id} value={group.id}>
                                  {group.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <button
                          type="button"
                          className="primary"
                          disabled={busy || !assignRoleId}
                          onClick={() =>
                            void (async () => {
                              const selected = roles.find((item) => item.role.id === assignRoleId);
                              if (!selected) return;
                              if (selected.role.scopeType === "GROUP" && !assignGroupId) {
                                setError("GROUP 角色必须选择具体小组，且目标必须是该组有效成员。");
                                return;
                              }
                              setBusy(true);
                              setError("");
                              setSuccess("");
                              try {
                                await guard(() =>
                                  request("/cloud-management/role-assignments", {
                                    accountId: assignAccount.id,
                                    roleId: assignRoleId,
                                    groupId: selected.role.scopeType === "GROUP" ? assignGroupId : null,
                                  }),
                                );
                                await loadAssignments(assignAccount);
                                setSuccess("授权已提交。");
                              } catch (failure) {
                                setError(onAuthFailure(failure));
                              } finally {
                                setBusy(false);
                              }
                            })()
                          }
                        >
                          <UserPlus size={14} /> 授予
                        </button>
                      </div>
                      <p className="cw-hint">GROUP 角色只能授予该组有效成员；组长身份不是可分配角色。</p>
                    </section>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function AuditPanel({
  request,
  guard,
  onAuthFailure,
}: {
  request: LocalRequest;
  guard: <T>(task: () => Promise<T>) => Promise<T>;
  onAuthFailure: (failure: unknown) => string;
}) {
  const [page, setPage] = useState<Page<AuditEvent>>({ items: [], total: 0, limit: PAGE_SIZE, offset: 0 });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (nextOffset: number) => {
      setLoading(true);
      setError("");
      try {
        const value = await guard(() =>
          request<Page<AuditEvent>>(`/cloud-management/audit-events?limit=${PAGE_SIZE}&offset=${nextOffset}`),
        );
        setPage(value);
        setOffset(value.offset);
      } catch (failure) {
        setError(onAuthFailure(failure));
      } finally {
        setLoading(false);
      }
    },
    [guard, onAuthFailure, request],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  return (
    <section className="cw-panel" aria-label="审计">
      <div className="cw-pagebar">
        <div className="cw-pagebar-title">
          <h2>审计</h2>
          <p>只读脱敏摘要 · {page.total} 条记录 · 不提供数据库操作或原始请求内容</p>
        </div>
        <div className="cw-pagebar-actions">
          <button type="button" className="plain" onClick={() => void load(offset)} disabled={loading} title="刷新审计记录">
            <RefreshCw size={14} className={loading ? "spin" : ""} /> 刷新
          </button>
        </div>
      </div>
      <Notice error={error} />
      <div className="cw-surface cw-list-surface">
        <div className="cw-list-caption">
          <span>事件</span>
          <span>最近优先</span>
        </div>
        <ul className="cw-list cw-audit-list">
          {page.items.map((event) => (
            <li key={event.id} className="cw-row">
              <div className="cw-row-main">
                <strong>{event.eventType}</strong>
                <span className="cw-meta">
                  <span>操作者 {event.actorAccountId}</span>
                  <span>目标 {event.targetId || "—"}</span>
                  <span>{displayTime(event.createdAt)}</span>
                </span>
              </div>
            </li>
          ))}
          {!page.items.length && !loading && (
            <li className="cw-empty">
              <strong>暂无审计记录</strong>
              <span>有管理写操作后会在这里留下脱敏摘要。</span>
            </li>
          )}
        </ul>
        <Pager offset={offset} limit={PAGE_SIZE} total={page.total} onChange={(next) => void load(next)} />
      </div>
    </section>
  );
}
