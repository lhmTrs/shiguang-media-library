import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LocalRequest } from "./OpenAISettings";

/**
 * T-LOCAL-006：浏览器侧共享的云端认证状态。
 *
 * 边界：
 * - 只调用既有 /api/cloud-auth/*；令牌、密码、激活码、P12 口令都只存在于后端或
 *   当前表单内存，浏览器不持久化。
 * - 前端状态只作展示，后端仍是权限依据。
 * - 每个状态查询/动作都有代次（epoch）；退出、换账户或离开登录页后，迟到的
 *   旧状态响应不能覆盖较新的结果。
 */
export type CloudLastError = {
  code?: string | null;
  kind?: string | null;
  status?: number | null;
  message?: string | null;
  retryAfterMs?: number | null;
};

export type EnrollmentStatus = {
  recoverySupported?: boolean;
  ready: boolean;
  enabled: boolean;
  configured: boolean;
  deviceId: string | null;
  username: string | null;
  certificateExpiresAt: string | null;
  activated: boolean;
  activationPending?: boolean;
  lastSessionErrorCode?: string | null;
  message: string | null;
};

export type CloudAuthView = {
  configured: boolean;
  originHost: string | null;
  hasCA: boolean;
  hasClientCertificate: boolean;
  state: string;
  username: string | null;
  displayName: string | null;
  accountId: string | null;
  deviceId: string | null;
  sessionId: string | null;
  refreshExpiresAt: string | null;
  accessExpiresInMs: number | null;
  needsLogin: boolean;
  lastError: CloudLastError | null;
  retryAfterMs: number | null;
  enrollment?: EnrollmentStatus;
};

export type LogoutResult = {
  localLoggedOut: boolean;
  cloudRevoked: boolean;
  error: CloudLastError | null;
  state: CloudAuthView;
};

export type EnrollResult = {
  enrolled: boolean;
  session: boolean;
  activationPending?: boolean;
  state: CloudAuthView;
  enrollment?: EnrollmentStatus;
  error?: CloudLastError | null;
};

export type CloudBusy = "login" | "activate" | "enroll" | "logout" | "reset" | "recover" | null;

const STATE_LABELS: Record<string, string> = {
  unconfigured: "未配置",
  "logged-out": "已保存，未连接",
  "logged-in": "已连接",
  "needs-login": "需重新登录",
  "rate-limited": "限流冷却",
  "cert-error": "证书错误",
  "cloud-unreachable": "云端不可达",
  refreshing: "正在刷新登录状态",
};

const seconds = (ms: unknown) => Math.max(1, Math.ceil((Number(ms) || 0) / 1000));

/**
 * 浏览器侧只展示固定文案；不拼接原始响应、异常栈或本机路径。
 * 未知错误也必须落到固定文案，不能回显 message。
 */
export function describeFailure(
  failure: CloudLastError | null | undefined,
  context: "login" | "settings" = "settings",
): string {
  if (!failure) return "云端认证操作失败，请稍后重试";
  const code = String(failure.code || "");
  const kind = String(failure.kind || "");
  if (code === "RATE_LIMITED" || failure.status === 429)
    return `请求过于频繁，请 ${seconds(failure.retryAfterMs)} 秒后重试`;
  if (code === "UNAUTHORIZED" || code === "NOT_LOGGED_IN" || failure.status === 401)
    return "登录状态无效或凭据已失效，请重新登录";
  if (code === "CERT_FILE_UNREADABLE") return "无法读取证书文件，请重新核对本机路径";
  if (code === "P12_PASSPHRASE_MISSING") return "缺少 P12 口令，请重新填写设备证书口令";
  if (code === "STORAGE_ERROR") return "本地云端配置保存失败，请检查数据目录权限";
  if (code === "ENROLLMENT_UNAVAILABLE") return "本机自动开通尚未就绪，请等待正式发行配置或联系管理员";
  if (code === "DEVICE_ALREADY_ENROLLED") return "本机已经开通，无需重复操作";
  if (code === "DEVICE_KEY_LOST") return "原设备密钥已丢失，需要向管理员重新申请开通码";
  if (code === "DEVICE_PENDING_IDENTITY_MISMATCH")
    return "本机存在未完成的开通记录，请使用原开通码和原设备名称重试；如需换码，请联系管理员撤销旧设备并安全重置本机开通材料，不要只删除记录。";
  if (code === "DEVICE_PENDING_INVALID")
    return "本机未完成的开通记录与设备材料不一致，已保留原文件；请联系管理员恢复，不要自行删除记录或重新配置云端。";
  if (code === "DEVICE_NOT_REVOKED") return "云端尚未确认本机设备已撤销，请先让超级管理员在账户管理中撤销此设备；本机材料未清理";
  if (code === "DEVICE_RECOVERY_UNSAFE") return "本机材料或连接配置异常，安全恢复已停止，请联系管理员；不要手动删除文件";
  if (code === "DEVICE_RECOVERY_BUSY") return "本机开通操作正在进行，请结束后再恢复";
  if (code === "DEVICE_RECOVERY_CONFIRM_REQUIRED") return "请确认需要重新开通的本机设备后重试";
  if (code === "ENROLLMENT_PASSWORD_INVALID") return "账户密码不能为空，且不能超过 72 个 UTF-8 字节；新账户密码还需至少 12 个字符";
  if (code === "DEVICE_LIMIT") return "该账户的设备数量已达上限，请联系管理员";
  if (code === "DEVICE_KEY_REUSED") return "该设备密钥已被使用，请重新开通";
  if (code === "ACCOUNT_ACTIVATION_PENDING") return "该账户已有待激活设备，请联系管理员处理";
  if (code === "CERT_KEY_MISMATCH" || code === "CERT_EXPIRED" || code === "CERT_CHAIN_INVALID")
    return "设备证书校验失败，请联系管理员重新开通";
  if (code === "ENROLLMENT_TIMEOUT") return "云端开通请求超时，请稍后重试";
  if (code === "ENROLLMENT_NETWORK") return "无法连接云端开通服务，请检查网络后重试";
  if (code === "ENROLLMENT_REDIRECT" || code === "ENROLLMENT_RESPONSE_INVALID" || code === "ENROLLMENT_RESPONSE_INCOMPLETE" || code === "ENROLLMENT_RESPONSE_ABORTED" || code === "ENROLLMENT_RESPONSE_TOO_LARGE")
    return "云端开通响应异常，已安全停止；请稍后重试或联系管理员";
  if (code === "REQUEST_TOO_LARGE") return "开通请求过大，请核对输入";
  if (code === "FORBIDDEN") return "没有执行该操作的权限";
  if (code === "VERSION_CONFLICT") return "数据已被其他人更新，请重新读取后再操作";
  if (code === "IDEMPOTENCY_CONFLICT") return "重复请求与原请求参数不一致，请重新发起";
  if (code === "LEADER_TRANSFER_REQUIRED") return "目标账户仍是小组负责人，请先交接负责人";
  if (code === "GROUP_NEEDS_LEADER") return "小组暂无有效负责人，请先指定负责人";
  if (code === "GROUP_NOT_ACTIVE") return "小组当前不是启用状态，请先恢复";
  if (code === "ROLE_EXISTS") return "角色编码已存在，请换一个";
  if (code === "ACCOUNT_EXISTS") return "用户名已存在";
  if (code === "INVALID_GROUP") return "小组参数不合法";
  if (code === "INVALID_AUTHORIZATION") return "角色或授权范围不合法";
  if (code === "INVALID_REQUEST") return "请求参数不合法，请核对输入";
  if (code === "NOT_FOUND") return "资源不存在或对当前账户不可见";
  if (code === "RESPONSE_INVALID") return "云端返回的数据不符合约定，已停止显示";
  if (code === "STALE") return "操作已被更新的请求取代，请重试";
  if (kind === "cert" || code === "CERT_INVALID" || code === "ERR_TLS_CERT_ALTNAME_INVALID")
    return "证书或主机名校验失败，请检查云端地址、CA 与设备证书";
  if (kind === "network" || code === "ECONNREFUSED" || code === "ENOTFOUND")
    return "无法连接云端服务，请检查网络或云端地址";
  if (kind === "timeout") return "云端请求超时，请稍后重试";
  if (kind === "config")
    return context === "login"
      ? "云端服务尚未就绪，请在高级云端设置中完成连接配置"
      : "云端连接配置不完整，请检查必填项";
  if (kind === "auth") return "登录状态无效，请重新登录";
  if (code === "INTERNAL" || kind === "internal") return "云端认证操作失败，请稍后重试";
  if (kind === "cloud") return "云端服务返回错误，请稍后重试";
  // 非 JSON、未知 code、异常对象等一律使用固定文案，绝不回显原始内容。
  return "云端认证操作失败，请稍后重试";
}

export function stateLabel(view: CloudAuthView): string {
  if (!view.configured) return STATE_LABELS.unconfigured;
  return STATE_LABELS[view.state] || "状态未知";
}

export function enrollmentRecovery(result: EnrollResult): { mode: "enroll" | "login"; message: string } {
  if (result.activationPending) {
    const reason = result.error?.code === "INVALID_REQUEST"
      ? "请核对输入：新账户密码至少 12 个字符，且不超过 72 个 UTF-8 字节。"
      : describeFailure(result.error, "login");
    return {
      mode: "enroll",
      message: `设备材料已保存，但账户激活未完成。${reason} 请使用原开通码和原设备名称重试；若旧码已撤销，请联系管理员处理，勿直接换码。`,
    };
  }
  return { mode: "login", message: `设备已开通，但自动登录未完成。${describeFailure(result.error, "login")} 请使用账户密码登录。` };
}

export function stateDescription(view: CloudAuthView): string {
  if (!view.configured) return "默认不连接云端，原本地素材管理照常可用。";
  switch (view.state) {
    case "logged-in":
      return "已登录云端；云端令牌和私钥只保存在本机后端，浏览器只看到脱敏状态。";
    case "needs-login":
      return "登录或刷新已失效，请重新登录；本地素材管理不受影响。";
    case "rate-limited":
      return `云端正在限流，约 ${seconds(view.retryAfterMs)} 秒后可重试；不会自动并发重试。`;
    case "cert-error":
      return "证书或主机名校验失败，配置尚未连接；请检查 CA、设备证书和云端地址。";
    case "cloud-unreachable":
      return "当前无法连接云端，配置已保留；本地素材管理照常可用。";
    case "refreshing":
      return "正在向云端刷新登录状态，请稍候。";
    default:
      return "连接配置已保存，但尚未登录云端；保存配置不等于连接成功。";
  }
}

export function displayAccount(view: CloudAuthView): string {
  if (!view.username) return "未登录";
  return view.displayName ? `${view.displayName} · ${view.username}` : view.username;
}

export function displayTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

/**
 * 共享认证状态。所有会改变登录态的动作串行执行；读状态与动作共用代次，
 * 旧请求返回时若代次已过期就直接丢弃。
 */
export function useCloudAuth(request: LocalRequest) {
  const [view, setView] = useState<CloudAuthView | null>(null);
  const viewRef = useRef<CloudAuthView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<CloudBusy>(null);
  const [loadError, setLoadError] = useState("");
  const epoch = useRef(0);
  const lock = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      epoch.current++;
    };
  }, []);

  const commit = useCallback((generation: number, next: CloudAuthView) => {
    if (!alive.current || generation !== epoch.current) return false;
    viewRef.current = next;
    setView(next);
    setLoadError("");
    return true;
  }, []);

  const invalidate = useCallback(() => {
    epoch.current++;
  }, []);

  const readStatus = useCallback(async (): Promise<CloudAuthView | null> => {
    // 动作进行中不并发读状态，避免把动作前的旧状态读进来。
    if (lock.current) return viewRef.current;
    const generation = ++epoch.current;
    try {
      const next = await request<CloudAuthView>("/cloud-auth/status");
      commit(generation, next);
      return next;
    } catch (error) {
      if (alive.current && generation === epoch.current)
        setLoadError(describeFailure(error as CloudLastError, "login"));
      throw error;
    }
  }, [request, commit]);

  useEffect(() => {
    let live = true;
    const boot = async () => {
      try {
        await readStatus();
      } catch {
        // 首次页面加载时 /api/session 与本请求可能同时发出；本地会话 cookie 尚未
        // 就绪会得到 401。短暂等待后重试一次，避免账户入口一直显示"登录"。
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (live) await readStatus().catch(() => undefined);
      } finally {
        if (live && alive.current) setLoading(false);
      }
    };
    void boot();
    return () => {
      live = false;
    };
  }, [readStatus]);

  const run = useCallback(
    async <T,>(kind: Exclude<CloudBusy, null>, task: (generation: number) => Promise<T>): Promise<T> => {
      if (lock.current) throw new Error("已有云端认证操作正在进行");
      lock.current = true;
      setBusy(kind);
      setLoadError("");
      const generation = ++epoch.current;
      try {
        return await task(generation);
      } catch (error) {
        // 动作失败后补读一次真实状态（冷却/上次错误/是否已被撤权），但只在不忙时。
        setTimeout(() => {
          if (alive.current && !lock.current) void readStatus().catch(() => undefined);
        }, 0);
        throw error;
      } finally {
        lock.current = false;
        if (alive.current) setBusy(null);
      }
    },
    [readStatus],
  );

  const login = useCallback(
    (username: string, password: string) =>
      run("login", async (generation) => {
        const next = await request<CloudAuthView>("/cloud-auth/login", { username, password });
        commit(generation, next);
        return next;
      }),
    [run, request, commit],
  );

  const activate = useCallback(
    (activationToken: string, password: string) =>
      run("activate", async (generation) => {
        const next = await request<CloudAuthView>("/cloud-auth/activate", { activationToken, password });
        commit(generation, next);
        return next;
      }),
    [run, request, commit],
  );

  const enroll = useCallback(
    (openingCode: string, password: string, deviceName: string) =>
      run("enroll", async (generation) => {
        const result = await request<EnrollResult>("/cloud-auth/enroll", { openingCode, password, deviceName });
        commit(generation, { ...result.state, ...(result.enrollment ? { enrollment: result.enrollment } : {}) });
        return result;
      }),
    [run, request, commit],
  );

  const logout = useCallback(
    () =>
      run("logout", async (generation) => {
        const result = await request<LogoutResult>("/cloud-auth/logout", {});
        commit(generation, result.state);
        return result;
      }),
    [run, request, commit],
  );

  const recoverDevice = useCallback(
    (deviceId: string) => run("recover", async generation => {
      const result = await request<{ recovered: boolean; state: CloudAuthView }>("/cloud-auth/recover-device", { confirm: true, deviceId });
      commit(generation, result.state);
      return result;
    }),
    [run, request, commit],
  );

  /**
   * 本人忘记密码：已有设备证书时用重置码 + 新密码，不要求旧登录。
   * 云端会撤销全部会话；这里只接收脱敏状态，不保存重置码/密码。
   */
  const resetPassword = useCallback(
    (resetToken: string, newPassword: string) =>
      run("reset", async (generation) => {
        const result = await request<{ reset: boolean; state: CloudAuthView }>("/cloud-management/reset-password", {
          resetToken,
          newPassword,
        });
        commit(generation, result.state);
        return result;
      }),
    [run, request, commit],
  );

  /**
   * 返回值保持稳定：父页面因素材轮询/提示等无关状态重渲染时，不能生成新的
   * controller 身份。否则依赖整个 auth 对象的资料加载 effect 会反复触发。
   */
  const controller = useMemo(
    () => ({
      view,
      loading,
      busy,
      loadError,
      login,
      activate,
      enroll,
      logout,
      resetPassword,
      recoverDevice,
      readStatus,
      invalidate,
    }),
    [view, loading, busy, loadError, login, activate, enroll, logout, resetPassword, recoverDevice, readStatus, invalidate],
  );
  return controller;
}

export type CloudAuthController = ReturnType<typeof useCloudAuth>;
