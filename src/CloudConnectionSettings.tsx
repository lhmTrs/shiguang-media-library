import { useEffect, useRef, useState, type FormEvent } from "react";
import { Cloud, LoaderCircle, Save } from "lucide-react";
import type { LocalRequest } from "./OpenAISettings";
import {
  describeFailure,
  displayAccount,
  displayTime,
  stateDescription,
  stateLabel,
  type CloudAuthView,
  type CloudLastError,
} from "./cloud-auth";

/**
 * T-LOCAL-006：高级云端设置（诊断/配置）。
 *
 * 本区域只保留连接配置与脱敏状态；普通登录与激活分别由顶部账户入口和独立
 * 登录页负责，避免出现两套重复登录表单。证书路径只写不回显，P12 口令只在本机
 * 后端保存，浏览器不持久化任何密钥。
 */
export function CloudConnectionSettings({
  request,
  onChanged,
}: {
  request: LocalRequest;
  onChanged?: () => void;
}) {
  const [view, setView] = useState<CloudAuthView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);

  const [config, setConfig] = useState({
    origin: "",
    caPath: "",
    certPath: "",
    keyPath: "",
    p12Path: "",
    p12Password: "",
  });

  useEffect(() => {
    let live = true;
    request<CloudAuthView>("/cloud-auth/status")
      .then((next) => {
        if (!live) return;
        setView(next);
        setLoadError("");
      })
      .catch((e) => {
        if (live) setLoadError(describeFailure(e as CloudLastError));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (lock.current) return;
    const origin = config.origin.trim();
    const hasPem = !!(config.certPath.trim() || config.keyPath.trim());
    const hasP12 = !!config.p12Path.trim();
    const payload = {
      ...(origin ? { origin } : {}),
      ...(config.caPath.trim() ? { caPath: config.caPath } : {}),
      ...(config.certPath.trim() ? { certPath: config.certPath } : {}),
      ...(config.keyPath.trim() ? { keyPath: config.keyPath } : {}),
      ...(config.p12Path.trim() ? { p12Path: config.p12Path } : {}),
      ...(config.p12Password ? { p12Password: config.p12Password } : {}),
      // P12 优先于 PEM；显式切换时清掉另一侧，避免旧证书永远压住新选择。
      ...(hasP12 ? { certPath: "", keyPath: "" } : hasPem ? { p12Path: "" } : {}),
    };
    // 口令在请求发出前立即离开表单内存；路径等结果返回后清空，失败时保留方便修正。
    setConfig((prev) => ({ ...prev, p12Password: "" }));
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    void request<CloudAuthView>("/cloud-auth/config", payload)
      .then((next) => {
        setView(next);
        // 路径只写不回显；失败时保留本次输入，方便直接修正。
        setConfig((prev) => ({
          ...prev,
          caPath: "",
          certPath: "",
          keyPath: "",
          p12Path: "",
          p12Password: "",
        }));
        setNotice(
          next.state === "logged-in"
            ? "连接配置已保存；当前仍保持已登录"
            : "连接配置已保存（尚未连接云端，需激活或登录）",
        );
        onChanged?.();
      })
      .catch((e) => {
        setError(describeFailure(e as CloudLastError));
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  }

  const disabled = busy;
  const tone =
    view?.state === "logged-in" ? "ready" : ["cert-error", "cloud-unreachable", "needs-login", "rate-limited"].includes(view?.state || "") ? "error" : "";
  const summaryError = view?.lastError && !error ? describeFailure(view.lastError) : "";

  return (
    <section className="cloud-settings" aria-labelledby="cloud-settings-title">
      <div className="database-heading">
        <h3 id="cloud-settings-title">
          <Cloud size={18} />
          云端连接
        </h3>
        <span className={"database-status " + tone} role="status" aria-live="polite">
          {view ? stateLabel(view) : "读取中"}
        </span>
      </div>
      <p className="muted cloud-description">
        {view
          ? stateDescription(view)
          : "正在读取本机云端认证状态…"}
        登录与设备激活请使用顶部账户入口或独立登录页；本区域仅供诊断和连接配置。已保存的本机证书路径不会回显，留空表示沿用。
      </p>

      {loading && (
        <p className="muted cloud-loading" role="status">
          <LoaderCircle size={14} className="spin" />
          正在读取云端连接状态…
        </p>
      )}
      {loadError && (
        <p className="database-error" role="alert">
          {loadError}
        </p>
      )}

      {view && (
        <dl className="database-summary cloud-summary" aria-label="云端连接摘要">
          <dt>云端地址</dt>
          <dd>{view.originHost || "未配置"}</dd>
          <dt>CA 证书</dt>
          <dd>{view.hasCA ? "已保存" : "未保存"}</dd>
          <dt>设备证书</dt>
          <dd>{view.hasClientCertificate ? "已保存" : "未保存"}</dd>
          <dt>当前账户</dt>
          <dd>{displayAccount(view)}</dd>
          <dt>会话期限</dt>
          <dd>{displayTime(view.refreshExpiresAt)}</dd>
        </dl>
      )}

      {summaryError && (
        <p className="cloud-last-error" role="status">
          上次错误：{summaryError}
        </p>
      )}

      <form className="cloud-form" onSubmit={saveConfig} aria-label="云端连接配置">
        <div className="database-form cloud-config-grid">
          <label className="field cloud-wide">
            云端地址（HTTPS）
            <input
              aria-label="云端地址（HTTPS）"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder={view?.originHost ? "留空沿用已保存地址" : "https://cloud.example:8443"}
              value={config.origin}
              disabled={disabled}
              onChange={(e) => setConfig({ ...config, origin: e.target.value })}
            />
          </label>
          <label className="field">
            云端 CA 证书路径
            <input
              aria-label="云端 CA 证书路径"
              autoComplete="off"
              spellCheck={false}
              placeholder={view?.hasCA ? "已保存，留空沿用" : "本机 CA 证书路径"}
              value={config.caPath}
              disabled={disabled}
              onChange={(e) => setConfig({ ...config, caPath: e.target.value })}
            />
          </label>
          <label className="field">
            设备证书路径（PEM）
            <input
              aria-label="设备证书路径（PEM）"
              autoComplete="off"
              spellCheck={false}
              placeholder={view?.hasClientCertificate ? "已保存，留空沿用" : "client.crt"}
              value={config.certPath}
              disabled={disabled}
              onChange={(e) => setConfig({ ...config, certPath: e.target.value })}
            />
          </label>
          <label className="field">
            设备私钥路径（PEM）
            <input
              aria-label="设备私钥路径（PEM）"
              autoComplete="off"
              spellCheck={false}
              placeholder="client.key"
              value={config.keyPath}
              disabled={disabled}
              onChange={(e) => setConfig({ ...config, keyPath: e.target.value })}
            />
          </label>
          <label className="field">
            设备证书路径（P12）
            <input
              aria-label="设备证书路径（P12）"
              autoComplete="off"
              spellCheck={false}
              placeholder="client.p12（与 PEM 二选一）"
              value={config.p12Path}
              disabled={disabled}
              onChange={(e) => setConfig({ ...config, p12Path: e.target.value })}
            />
          </label>
          <label className="field cloud-wide">
            P12 口令（仅本机保存，不回显）
            <input
              aria-label="P12 口令（仅本机保存，不回显）"
              type="password"
              autoComplete="new-password"
              placeholder="使用 P12 时填写；留空沿用已保存口令"
              value={config.p12Password}
              disabled={disabled}
              onChange={(e) => setConfig({ ...config, p12Password: e.target.value })}
            />
          </label>
        </div>
        <div className="database-actions cloud-actions">
          <button className="primary" type="submit" disabled={disabled}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
            {busy ? "保存中…" : "保存连接配置"}
          </button>
          <span className="muted">保存只会写入本机配置，不会自动登录或连接云端。</span>
        </div>
      </form>

      {error && (
        <p className="database-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="category-notice cloud-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
