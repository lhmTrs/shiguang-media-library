import { useEffect, useState } from "react";
import { KeyRound, Save, Trash2, PlugZap, FileText } from "lucide-react";
import { OpenAIDiagnostics, type Diagnostic } from "./OpenAIDiagnostics";
import { AnalysisFailure } from "./AnalysisFailure";
export type LocalRequest = <T = unknown>(
  url: string,
  body?: unknown,
  method?: string,
) => Promise<T>;
export type AIState = {
  hasKey: boolean;
  model: string;
  active: boolean;
  error?: string;
  storage?: string;
};
export function OpenAISettings({
  request,
  changed,
}: {
  request: LocalRequest;
  changed?: () => void;
}) {
  const [state, setState] = useState<AIState | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [revision, setRevision] = useState(0);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    diagnostic: Diagnostic;
  } | null>(null);
  useEffect(() => {
    let live = true;
    request<AIState>("/openai")
      .then((s) => {
        if (live) setState(s);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  async function save(remove = false) {
    setBusy(true);
    setTestResult(null);
    setError("");
    setMessage("");
    try {
      setState(
        await request<AIState>(
          "/openai/config",
          remove ? {} : { apiKey: key },
          remove ? "DELETE" : "POST",
        ),
      );
      setKey("");
      setMessage(remove ? "本机密钥已移除" : "密钥已保存，尚未调用 API");
      changed?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "设置保存失败");
    } finally {
      setBusy(false);
    }
  }
  async function testConnection() {
    setBusy(true);
    setError("");
    setMessage("");
    setTestResult(null);
    try {
      setTestResult(
        await request<{ ok: boolean; message: string; diagnostic: Diagnostic }>(
          "/openai/test",
          {},
        ),
      );
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "连接测试失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="database-settings ai-settings">
      <div className="database-heading">
        <h3>
          <KeyRound size={18} />
          OpenAI 音乐分析
        </h3>
        <span className="database-status">
          {state?.hasKey ? "已保存密钥" : "未配置"}
        </span>
      </div>
      <p className="muted">
        {state?.model || "gpt-audio-1.5"} · 点击分析时上传选定片段，按 OpenAI
        API 计费。
      </p>
      <label className="ai-key-field">
        API Key
        <input
          aria-label="OpenAI API Key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={state?.hasKey ? "已保存，留空保留" : "sk-…"}
          disabled={busy}
          onChange={(e) => {
            setKey(e.target.value);
            setTestResult(null);
          }}
        />
      </label>
      <p className="muted">
        API Key 加密保存于本机数据库；解密密钥单独存于本机，权限
        0600。不会返回已保存的 API Key。
      </p>
      <div className="database-actions">
        <button
          className="primary"
          disabled={
            busy || !state || state.active || (!key.trim() && !state.hasKey)
          }
          onClick={() => void save()}
        >
          <Save size={16} />
          保存密钥
        </button>
        <button
          disabled={busy || (!state?.hasKey && !state?.error) || state?.active}
          onClick={() => {
            if (window.confirm("移除本机 API Key？已缓存的分析结果保留。"))
              void save(true);
          }}
        >
          <Trash2 size={16} />
          移除密钥
        </button>
      </div>
      {error && (
        <p className="database-error" role="alert">
          {error}
        </p>
      )}
      {state?.error && (
        <p className="database-error" role="alert">
          {state.error}
        </p>
      )}
      {message && (
        <p className="category-notice" role="status">
          {message}
        </p>
      )}
      <div className="database-actions diagnostics-actions">
        <button
          disabled={busy || !state?.hasKey || state?.active || !!key.trim()}
          title={
            key.trim()
              ? "请先保存新密钥"
              : "仅读取模型信息，不上传音频或调用付费模型"
          }
          onClick={() => void testConnection()}
        >
          <PlugZap size={16} />
          {busy ? "处理中…" : "测试连接"}
        </button>
        <button onClick={() => setShowLogs(!showLogs)}>
          <FileText size={16} />
          {showLogs ? "收起诊断日志" : "查看诊断日志"}
        </button>
      </div>
      <p className="muted">
        连接测试不上传音频或调用付费模型；余额和音频调用权限未验证。
      </p>
      {testResult && (
        <div
          className={testResult.ok ? "connection-result" : "database-error"}
          role="status"
        >
          <p>{testResult.message}</p>
          <small>
            {testResult.diagnostic.httpStatus
              ? "HTTP " + testResult.diagnostic.httpStatus
              : "本机校验"}{" "}
            · {testResult.diagnostic.elapsedMs} ms
            {testResult.diagnostic.code
              ? " · " + testResult.diagnostic.code
              : ""}
          </small>
        </div>
      )}
      {showLogs && <OpenAIDiagnostics request={request} revision={revision} />}
      {testResult && !testResult.ok && (
        <AnalysisFailure diagnostic={testResult.diagnostic} />
      )}
    </section>
  );
}
