import type { Diagnostic } from "./OpenAIDiagnostics";
const stageNames: Record<string, string> = {
  validation: "本机校验",
  extract: "音频片段读取",
  request: "发送请求",
  parse: "解析返回内容",
  cache: "保存分析结果",
};
export function AnalysisFailure({ diagnostic }: { diagnostic: Diagnostic }) {
  const d = diagnostic.details;
  const fallback =
    diagnostic.code === "network_error"
      ? "请求在网络层失败。旧日志未保留底层错误链，无法确定具体是 DNS、TLS、连接超时还是连接中断。"
      : "旧日志未保留详细错误说明，可查看状态码和错误码。";
  return (
    <div className="analysis-failure" aria-label="音乐分析失败详情">
      <p className="failure-time">
        {new Date(diagnostic.createdAt).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
        })}{" "}
        · {stageNames[diagnostic.stage] || diagnostic.stage} ·{" "}
        {diagnostic.httpStatus
          ? "HTTP " + diagnostic.httpStatus
          : "未收到 HTTP 响应"}{" "}
        · {diagnostic.elapsedMs ?? "—"} ms
      </p>
      <p className="failure-reason">{d?.reason || fallback}</p>
      {d?.providerMessage && (
        <p className="failure-provider-message">
          服务端说明：{d.providerMessage}
        </p>
      )}
      {d?.providerParam && (
        <p>
          相关参数：<code>{d.providerParam}</code>
        </p>
      )}
      <details>
        <summary>查看返回内容与错误链（已脱敏）</summary>
        {d?.responseBody ? (
          <>
            <h4>服务端返回正文</h4>
            <pre>{d.responseBody}</pre>
            {d.responseTruncated && (
              <p className="muted">响应过长或传输中断，内容已截断。</p>
            )}
          </>
        ) : (
          <p className="muted">
            {diagnostic.httpStatus
              ? "未保存服务端返回正文。"
              : "未收到 HTTP 响应，没有服务端正文可显示。"}
          </p>
        )}
        {!!d?.network && (
          <>
            <h4>底层错误链</h4>
            <pre>{JSON.stringify(d.network, null, 2)}</pre>
          </>
        )}
        <h4>排查信息</h4>
        <pre>
          {JSON.stringify(
            {
              logId: diagnostic.id,
              code: diagnostic.code,
              requestId: diagnostic.requestId,
              clientRequestId: diagnostic.clientRequestId,
              stage: diagnostic.stage,
              httpStatus: diagnostic.httpStatus,
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
