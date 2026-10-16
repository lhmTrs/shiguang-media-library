import { useEffect, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import type { LocalRequest } from "./OpenAISettings";
import { AnalysisFailure } from "./AnalysisFailure";
export type Diagnostic = {
  id: string;
  createdAt: string;
  operation: "connection" | "analysis";
  outcome: "success" | "error" | "cache_hit";
  summary: string;
  stage: string;
  httpStatus: number | null;
  code: string | null;
  requestId: string | null;
  clientRequestId: string | null;
  elapsedMs: number | null;
  details?: {
    reason: string | null;
    providerMessage: string | null;
    providerParam: string | null;
    responseBody: string | null;
    responseTruncated: boolean;
    network: unknown;
  } | null;
  [key: string]: unknown;
};
export function OpenAIDiagnostics({
  request,
  revision,
}: {
  request: LocalRequest;
  revision: number;
}) {
  const [items, setItems] = useState<Diagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setItems((await request<{ items: Diagnostic[] }>("/openai/logs")).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "日志读取失败");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, [revision]);
  function download() {
    const blob = new Blob(
      [
        JSON.stringify(
          { exportedAt: new Date().toISOString(), items },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement("a");
    link.href = url;
    link.download =
      "openai-diagnostics-" + new Date().toISOString().slice(0, 10) + ".json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function clear() {
    if (
      !window.confirm("清空全部 OpenAI 诊断日志？不会删除分析缓存或 API Key。")
    )
      return;
    setBusy(true);
    setError("");
    try {
      await request("/openai/logs", {}, "DELETE");
      setItems([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "日志清理失败");
    } finally {
      setBusy(false);
    }
  }
  const visible = items.filter(
    (item) => filter === "all" || item.outcome === filter,
  );
  return (
    <section className="openai-diagnostics" aria-label="OpenAI 诊断日志">
      <div className="diagnostics-heading">
        <h3>诊断日志</h3>
        <select
          aria-label="诊断日志结果筛选"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="all">全部结果</option>
          <option value="error">失败</option>
          <option value="success">成功</option>
          <option value="cache_hit">缓存命中</option>
        </select>
        <button
          className="icon-button"
          title="刷新诊断日志"
          aria-label="刷新诊断日志"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="icon-button"
          title="导出脱敏日志"
          aria-label="导出脱敏日志"
          disabled={busy || !items.length}
          onClick={download}
        >
          <Download size={16} />
        </button>
        <button
          className="icon-button"
          title="清空诊断日志"
          aria-label="清空诊断日志"
          disabled={busy || !items.length}
          onClick={() => void clear()}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <p className="muted">
        最近 30 天，最多 1000 条；不包含密钥、音频、提示词或本机路径。
      </p>
      {error && (
        <p role="alert" className="database-error">
          {error}
        </p>
      )}
      <div className="diagnostics-list">
        {visible.length ? (
          visible.map((item) => (
            <details key={item.id} className="diagnostic-entry">
              <summary>
                <span className={"diagnostic-status " + item.outcome}>
                  {item.summary}
                </span>
                <time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time>
                <span>
                  {item.httpStatus ? "HTTP " + item.httpStatus : "本机"} ·{" "}
                  {item.elapsedMs ?? "—"} ms
                </span>
                {item.code && <code>{item.code}</code>}
              </summary>
              {item.outcome === "error" && (
                <AnalysisFailure diagnostic={item} />
              )}
              <pre>{JSON.stringify(item, null, 2)}</pre>
            </details>
          ))
        ) : (
          <p className="muted">{busy ? "日志读取中…" : "暂无匹配日志"}</p>
        )}
      </div>
    </section>
  );
}
