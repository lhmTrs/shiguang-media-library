import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ChevronDown,
  CloudOff,
  KeyRound,
  LoaderCircle,
  LogIn,
  LogOut,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";
import {
  describeFailure,
  enrollmentRecovery,
  stateLabel,
  type CloudAuthController,
  type CloudLastError,
} from "./cloud-auth";

/**
 * T-LOCAL-006：顶部账户入口 + 独立登录页。
 *
 * - 顶部入口只读共享认证状态，不主动接触令牌/证书。
 * - 登录页只提交用户名/密码到本机 /api/cloud-auth/login；激活是独立次级入口。
 * - 密码/激活码提交即离开表单内存；错误只显示固定文案。
 */

export function AccountEntry({
  auth,
  onLogin,
  onWorkspace,
  onNotice,
}: {
  auth: CloudAuthController;
  onLogin: () => void;
  onWorkspace: () => void;
  onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const loggedIn = auth.view?.state === "logged-in" && !!auth.view.username;
  const name = loggedIn
    ? auth.view?.displayName || auth.view?.username || ""
    : "";

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        root.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (!loggedIn) setOpen(false);
  }, [loggedIn]);

  function toggle() {
    if (!loggedIn) {
      onLogin();
      return;
    }
    const next = !open;
    setOpen(next);
    // 打开菜单时顺带校准一次状态；迟到的旧响应会被当前代次丢弃。
    if (next) void auth.readStatus().catch(() => undefined);
  }

  async function logout() {
    setOpen(false);
    try {
      const result = await auth.logout();
      onNotice(
        result.cloudRevoked
          ? "已退出，云端会话已撤销"
          : `本地已退出；云端撤销未确认（${describeFailure(result.error, "login")}）`,
      );
    } catch (error) {
      onNotice(`退出未完成：${describeFailure(error as CloudLastError, "login")}`);
      void auth.readStatus().catch(() => undefined);
    }
  }

  return (
    <div className="account-entry" ref={root}>
      <button
        type="button"
        className={"account-button" + (loggedIn ? " signed-in" : "")}
        aria-label={loggedIn ? `账户：${name}` : "登录"}
        aria-haspopup={loggedIn ? "menu" : undefined}
        aria-expanded={loggedIn ? open : undefined}
        disabled={auth.busy === "logout"}
        onClick={toggle}
      >
        {loggedIn ? <UserRound size={17} /> : <LogIn size={17} />}
        <span className="account-label">{loggedIn ? name : "登录"}</span>
        {loggedIn && <ChevronDown size={14} className="account-chevron" />}
        {auth.busy === "logout" && <LoaderCircle size={14} className="spin" />}
      </button>
      {open && loggedIn && (
        <div className="account-menu" role="menu" aria-label="账户菜单">
          <div className="account-menu-head">
            <strong>{name}</strong>
            <small>@{auth.view?.username}</small>
            <span className={"account-state " + (auth.view?.state === "logged-in" ? "ready" : "")}>
              {auth.view ? stateLabel(auth.view) : "读取中"}
            </span>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onWorkspace();
            }}
          >
            <UsersRound size={15} />
            账户与小组
          </button>
          <button type="button" role="menuitem" onClick={() => void logout()} disabled={auth.busy === "logout"}>
            <LogOut size={15} />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

export function CloudLoginPage({
  auth,
  onBack,
  onAdvanced,
}: {
  auth: CloudAuthController;
  onBack: () => void;
  onAdvanced: () => void;
}) {
  const [mode, setMode] = useState<"login" | "enroll" | "reset">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [openingCode, setOpeningCode] = useState("");
  const [enrollPassword, setEnrollPassword] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [resetCode, setResetCode] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [autoMode, setAutoMode] = useState(false);
  const [recoverConfirm, setRecoverConfirm] = useState(false);
  const lock = useRef(false);

  // 没有设备证书时登录不可用；首次在本机使用直接引导到「开通本机」。
  const configured = !!auth.view?.hasClientCertificate;
  const enrollmentReady = auth.view?.enrollment?.ready === true;
  const disabled = !!auth.busy || lock.current;
  const sessionReady = auth.view?.state === "logged-in";
  const recoveryId = auth.view?.enrollment?.deviceId;
  const recoveryAvailable = auth.view?.enrollment?.recoverySupported === true && !!recoveryId;

  // 已有有效会话时直接回主界面，避免登录页循环。
  useEffect(() => {
    if (sessionReady) onBack();
  }, [sessionReady, onBack]);

  // 仅在首次加载时自动切到开通表单，不覆盖用户随后手动选择的模式。
  useEffect(() => {
    if (autoMode || !auth.view || auth.loading) return;
    setAutoMode(true);
    if (enrollmentReady && (!configured || auth.view.enrollment?.activationPending)) setMode("enroll");
  }, [autoMode, auth.view, auth.loading, configured, enrollmentReady]);

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    if (lock.current || auth.busy) return;
    if (!configured) {
      setError("本机尚未开通，请先使用开通码开通本机");
      return;
    }
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    lock.current = true;
    setError("");
    const submitted = password;
    // 密码提交即离开表单内存，不等待响应；失败后需重新输入。
    setPassword("");
    try {
      await auth.login(username.trim(), submitted);
    } catch (failure) {
      setError(describeFailure(failure as CloudLastError, "login"));
    } finally {
      lock.current = false;
    }
  }

  async function submitEnrollment(event: FormEvent) {
    event.preventDefault();
    if (lock.current || auth.busy) return;
    if (!enrollmentReady) {
      setError("本机自动开通尚未就绪，请等待正式发行配置或联系管理员");
      return;
    }
    if (!openingCode.trim() || !enrollPassword) {
      setError("请输入开通码和账户密码");
      return;
    }
    if (new TextEncoder().encode(enrollPassword).length > 72) {
      setError(describeFailure({ code: "ENROLLMENT_PASSWORD_INVALID" }, "login"));
      return;
    }
    lock.current = true;
    setError("");
    const submittedCode = openingCode.trim();
    const submittedPassword = enrollPassword;
    const submittedName = deviceName.trim();
    // 开通码与密码提交即离开表单内存；失败后需重新输入。
    setOpeningCode("");
    setEnrollPassword("");
    try {
      const result = await auth.enroll(submittedCode, submittedPassword, submittedName);
      if (result.session) return;
      const recovery = enrollmentRecovery(result);
      setMode(recovery.mode);
      setError(recovery.message);
    } catch (failure) {
      setError(describeFailure(failure as CloudLastError, "login"));
      setOpeningCode("");
      setEnrollPassword("");
    } finally {
      lock.current = false;
    }
  }

  async function submitReset(event: FormEvent) {
    event.preventDefault();
    if (lock.current || auth.busy) return;
    if (!configured) {
      setError("本机还没有有效设备证书，不能重置密码；请先用开通码开通本机");
      return;
    }
    if (!resetCode.trim() || !resetPassword) {
      setError("请输入重置码和新密码");
      return;
    }
    if (resetPassword !== resetConfirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    if (resetPassword.length < 12 || new TextEncoder().encode(resetPassword).length > 72) {
      setError("新密码至少 12 个字符，且不超过 72 字节");
      return;
    }
    lock.current = true;
    setError("");
    setNotice("");
    const submittedCode = resetCode.trim();
    const submittedPassword = resetPassword;
    // 重置码与密码提交即离开表单内存。
    setResetCode("");
    setResetPassword("");
    setResetConfirm("");
    try {
      await auth.resetPassword(submittedCode, submittedPassword);
      setMode("login");
      setNotice("密码已重置，旧会话已清除，请用新密码重新登录");
    } catch (failure) {
      setError(describeFailure(failure as CloudLastError, "login"));
    } finally {
      lock.current = false;
    }
  }

  function retryStatus() {
    setError("");
    void auth.readStatus().catch((failure) => setError(describeFailure(failure as CloudLastError, "login")));
  }

  async function recoverDevice() {
    const deviceId = auth.view?.enrollment?.deviceId;
    if (!recoveryAvailable || !deviceId || !recoverConfirm || lock.current || auth.busy) return;
    lock.current = true;
    setError("");
    setNotice("");
    setOpeningCode("");
    setEnrollPassword("");
    setPassword("");
    try {
      await auth.recoverDevice(deviceId);
      setRecoverConfirm(false);
      setDeviceName("");
      setMode("enroll");
      setNotice("旧设备材料已安全备份，本地素材未改动。请使用管理员新签发的开通码重新开通。");
    } catch (failure) {
      setError(describeFailure(failure as CloudLastError, "login"));
    } finally {
      lock.current = false;
    }
  }

  return (
    <div className="login-page">
      <header className="login-header">
        <div className="login-brand">
          <span className="brand-icon">
            <ShieldCheck size={23} />
          </span>
          <div className="brand-name">
            <strong>拾光</strong>
            <span>云端账户</span>
          </div>
        </div>
        <button type="button" className="plain login-back" onClick={onBack} disabled={!!auth.busy}>
          <ArrowLeft size={16} />
          返回素材库
        </button>
      </header>
      <main className="login-main">
        <section className="login-card" aria-labelledby="login-title">
          <div className="login-heading">
            <h1 id="login-title">
              {mode === "login" ? "登录云端账户" : mode === "enroll" ? "开通本机" : "重置密码"}
            </h1>
            <p>
              {mode === "login"
                ? "登录只用于云端协作；不登录也能继续管理本地素材。"
                : mode === "enroll"
                  ? "首次在本机使用只需开通码和账户密码；设备证书由本机后台自动生成与安装。"
                  : "使用管理员签发的一次性重置码和本机已开通的设备证书；不需要旧密码。"}
            </p>
          </div>

          {auth.loading && (
            <p className="login-status" role="status">
              <LoaderCircle size={15} className="spin" />
              正在检查云端服务…
            </p>
          )}
          {auth.loadError && !auth.loading && (
            <div className="login-warning" role="alert">
              <span>{auth.loadError}</span>
              <button type="button" className="text-button" onClick={retryStatus}>
                <RefreshCw size={13} />
                重试
              </button>
            </div>
          )}

          {auth.view && !configured && !enrollmentReady && (
            <div className="login-not-ready" role="status">
              <CloudOff size={18} />
              <div>
                <strong>云端服务尚未就绪</strong>
                <p>
                  当前版本还没有内置可用的云端地址与设备证书。你仍可返回素材库继续管理本地素材；管理员可在“设置与缓存 →
                  高级云端设置”中检查连接配置。
                </p>
              </div>
            </div>
          )}

          {sessionReady ? (
            <p className="login-status" role="status">
              <LoaderCircle size={15} className="spin" />
              已登录，正在返回素材库…
            </p>
          ) : mode === "login" ? (
            <form className="login-form" onSubmit={submitLogin} aria-label="云端账户登录">
              <label className="field">
                用户名
                <input
                  aria-label="用户名"
                  autoComplete="username"
                  spellCheck={false}
                  value={username}
                  disabled={disabled}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>
              <label className="field">
                密码
                <input
                  aria-label="密码"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  disabled={disabled}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <button type="submit" className="primary login-submit" disabled={disabled || !configured}>
                {auth.busy === "login" ? <LoaderCircle size={16} className="spin" /> : <LogIn size={16} />}
                {auth.busy === "login" ? "登录中…" : "登录"}
              </button>
            </form>
          ) : mode === "enroll" ? (
            <form className="login-form" onSubmit={submitEnrollment} aria-label="开通本机">
              <label className="field">
                开通码
                <input
                  aria-label="开通码"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  value={openingCode}
                  disabled={disabled}
                  onChange={(event) => setOpeningCode(event.target.value)}
                />
              </label>
              <label className="field">
                账户密码
                <input
                  aria-label="开通账户密码"
                  type="password"
                  autoComplete="current-password"
                  value={enrollPassword}
                  disabled={disabled}
                  onChange={(event) => setEnrollPassword(event.target.value)}
                />
              </label>
              <label className="field">
                设备名称（可选）
                <input
                  aria-label="设备名称"
                  autoComplete="off"
                  maxLength={128}
                  value={deviceName}
                  disabled={disabled}
                  onChange={(event) => setDeviceName(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="primary login-submit"
                disabled={disabled || !enrollmentReady}
              >
                {auth.busy === "enroll" ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}
                {auth.busy === "enroll" ? "正在开通…" : "开通并登录"}
              </button>
              <p className="login-footnote">
                新账户密码至少 12 个字符，且不超过 72 个 UTF-8 字节；已激活账户请填写现有密码。重试未完成的激活时，请保持原开通码和原设备名称。
              </p>
            </form>
          ) : (
            <form className="login-form" onSubmit={submitReset} aria-label="重置密码">
              <label className="field">
                重置码
                <input
                  aria-label="重置码"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  value={resetCode}
                  disabled={disabled}
                  onChange={(event) => setResetCode(event.target.value)}
                />
              </label>
              <label className="field">
                新密码
                <input
                  aria-label="新密码"
                  type="password"
                  autoComplete="new-password"
                  value={resetPassword}
                  disabled={disabled}
                  onChange={(event) => setResetPassword(event.target.value)}
                />
              </label>
              <label className="field">
                确认新密码
                <input
                  aria-label="确认新密码"
                  type="password"
                  autoComplete="new-password"
                  value={resetConfirm}
                  disabled={disabled}
                  onChange={(event) => setResetConfirm(event.target.value)}
                />
              </label>
              <button type="submit" className="primary login-submit" disabled={disabled || !configured}>
                {auth.busy === "reset" ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}
                {auth.busy === "reset" ? "重置中…" : "重置密码"}
              </button>
              <p className="login-footnote">
                重置成功会撤销该账户的全部旧会话，但不会自动登录，也不会重置本机设备证书。
              </p>
            </form>
          )}

          {notice && (
            <p className="login-notice" role="status">
              {notice}
            </p>
          )}
          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          {!sessionReady && (
            <details className="login-recovery">
              <summary><ShieldCheck size={15} /><span>设备与开通恢复</span><ChevronDown size={14} /></summary>
              {auth.loading ? <p role="status">正在读取本机设备状态…</p> : !auth.view || auth.loadError ? (
                <p role="alert">本机设备状态读取失败，尚不能确认恢复条件；旧材料未改动。</p>
              ) : auth.view.enrollment?.recoverySupported !== true ? (
                <p role="alert">当前后台未声明支持设备恢复。请确认前后端为配套版本并重启本机后台；旧材料未改动。</p>
              ) : !recoveryId ? (
                <p role="status">未读取到本机已登记的设备 ID。首次使用可直接开通；若此前开通过或仍报记录冲突，请联系管理员检查本机记录，勿手动删除材料。</p>
              ) : null}
              {recoveryAvailable && !auth.loadError && !auth.loading && <>
              <dl><div><dt>本机设备 ID</dt><dd><code>{recoveryId}</code></dd></div>
              {auth.view?.enrollment?.lastSessionErrorCode && <div><dt>上次错误码</dt><dd>{auth.view.enrollment.lastSessionErrorCode}</dd></div>}</dl>
              <p>需先由超级管理员撤销此设备。</p>
              <label>
                <input type="checkbox" checked={recoverConfirm} disabled={disabled} onChange={event => setRecoverConfirm(event.target.checked)} />
                确认备份旧设备材料，保留本地素材
              </label>
              <button type="button" className="plain" disabled={disabled || !recoverConfirm} onClick={() => void recoverDevice()}>
                {auth.busy === "recover" ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
                重新开通本机
              </button>
              </>}
              <button type="button" className="plain" disabled={disabled || auth.loading} onClick={retryStatus}>
                <RefreshCw size={14} />重新读取设备状态
              </button>
            </details>
          )}
          <div className="login-secondary">
            {mode === "login" ? (
              <>
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled || !enrollmentReady}
                  onClick={() => {
                    setMode("enroll");
                    setError("");
                    setNotice("");
                  }}
                >
                  <KeyRound size={14} />
                  首次在本机使用？开通本机
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={disabled || !configured}
                  onClick={() => {
                    setMode("reset");
                    setError("");
                    setNotice("");
                  }}
                >
                  <KeyRound size={14} />
                  忘记密码？用重置码重置
                </button>
              </>
            ) : (
              <button
                type="button"
                className="text-button"
                disabled={disabled}
                onClick={() => {
                  setMode("login");
                  setError("");
                  setNotice("");
                }}
              >
                <LogIn size={14} />
                返回账号登录
              </button>
            )}
            <button type="button" className="text-button" disabled={!!auth.busy} onClick={onAdvanced}>
              <ShieldCheck size={14} />
              高级云端设置
            </button>
          </div>

          <p className="login-footnote">
            浏览器不会保存密码、开通码或云端令牌；本机文件与素材默认不上传。
          </p>
        </section>
      </main>
    </div>
  );
}
