import crypto from "node:crypto";
import { failureDetails } from "./diagnostic-details.mjs";

export const providerCodes = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "rate_limit_exceeded",
  "slow_down",
  "server_is_overloaded",
  "invalid_api_key",
  "model_not_found",
  "permission_denied",
]);
const localCodes = new Set([
  "not_configured",
  "network_error",
  "invalid_response",
  "local_validation",
  "local_extract",
  "local_parse",
  "local_cache",
  "busy",
  "unknown_provider_error",
]);
export const safeRequestId = (value) =>
  typeof value === "string" && /^req_[A-Za-z0-9_-]{1,120}$/.test(value)
    ? value
    : null;
const uuid = (value) =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
const numeric = (value, max = 1e12) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max
    ? value
    : null;
const labels = { connection: "连接测试", analysis: "音乐分析" };

export class OpenAIDiagnostics {
  constructor(lib) {
    this.lib = lib;
  }
  init() {
    if (this.database === this.lib.db) return this;
    this.lib.db.exec(
      this.lib.db.kind === "mysql"
        ? "CREATE TABLE IF NOT EXISTS openai_diagnostics (id VARCHAR(36) PRIMARY KEY,created_ms DOUBLE,payload LONGTEXT) ENGINE=InnoDB"
        : "CREATE TABLE IF NOT EXISTS openai_diagnostics (id TEXT PRIMARY KEY,created_ms REAL,payload TEXT)",
    );
    this.database = this.lib.db;
    return this;
  }
  record(input, secrets = []) {
    this.init();
    // Request data remains excluded; only bounded, redacted failure details are retained.
    const code =
      providerCodes.has(input.code) || localCodes.has(input.code)
        ? input.code
        : null;
    const operation =
      input.operation === "connection" ? "connection" : "analysis";
    const outcome = ["success", "error", "cache_hit"].includes(input.outcome)
      ? input.outcome
      : "error";
    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      operation,
      outcome,
      summary:
        labels[operation] +
        (outcome === "error"
          ? "失败"
          : outcome === "cache_hit"
            ? "命中缓存"
            : "成功"),
      stage: ["validation", "extract", "request", "parse", "cache"].includes(
        input.stage,
      )
        ? input.stage
        : "validation",
      model: "gpt-audio-1.5",
      httpStatus: numeric(input.httpStatus, 599),
      code,
      providerType: [
        "insufficient_quota",
        "rate_limit_error",
        "rate_limit_exceeded",
        "service_unavailable_error",
        "invalid_request_error",
        "authentication_error",
      ].includes(input.providerType)
        ? input.providerType
        : null,
      requestId: safeRequestId(input.requestId),
      clientRequestId: uuid(input.clientRequestId),
      elapsedMs: numeric(input.elapsedMs),
      assetId: uuid(input.assetId),
      start: numeric(input.start, 86400),
      duration: numeric(input.duration, 60),
      retryAfter:
        typeof input.retryAfter === "string" &&
        (/^\d{1,5}(?:\.\d{1,3})?$/.test(input.retryAfter) ||
          /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
            input.retryAfter,
          ))
          ? input.retryAfter
          : null,
      usage: input.usage
        ? {
            promptTokens: numeric(input.usage.promptTokens),
            completionTokens: numeric(input.usage.completionTokens),
          }
        : null,
      details:
        outcome === "error" ? failureDetails(input.details, secrets) : null,
    };
    this.lib.db.transaction(() => {
      this.lib.db
        .prepare(
          "INSERT INTO openai_diagnostics(id,created_ms,payload) VALUES(?,?,?)",
        )
        .run(record.id, Date.now(), JSON.stringify(record));
      this.lib.db
        .prepare("DELETE FROM openai_diagnostics WHERE created_ms<?")
        .run(Date.now() - 30 * 86400000);
      const excess = this.lib.db
        .prepare(
          "SELECT id FROM openai_diagnostics ORDER BY created_ms DESC,id DESC LIMIT 1000 OFFSET 1000",
        )
        .all();
      for (const row of excess)
        this.lib.db
          .prepare("DELETE FROM openai_diagnostics WHERE id=?")
          .run(row.id);
    })();
    return record;
  }
  list(limit = 1000) {
    this.init();
    return this.lib.db
      .prepare(
        "SELECT payload FROM openai_diagnostics WHERE created_ms>=? ORDER BY created_ms DESC,id DESC LIMIT ?",
      )
      .all(
        Date.now() - 30 * 86400000,
        Math.max(1, Math.min(1000, Number(limit) || 100)),
      )
      .map((r) => JSON.parse(r.payload));
  }
  clear() {
    this.init();
    this.lib.db.prepare("DELETE FROM openai_diagnostics").run();
    return { cleared: true };
  }
  lastFailure(assetId) {
    this.init();
    const extractor =
      this.lib.db.kind === "mysql"
        ? "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.assetId'))"
        : "json_extract(payload,'$.assetId')";
    const outcome =
      this.lib.db.kind === "mysql"
        ? "JSON_UNQUOTE(JSON_EXTRACT(payload,'$.outcome'))"
        : "json_extract(payload,'$.outcome')";
    const row = this.lib.db
      .prepare(
        `SELECT payload FROM openai_diagnostics WHERE ${extractor}=? AND ${outcome}='error' AND created_ms>=? ORDER BY created_ms DESC,id DESC LIMIT 1`,
      )
      .get(assetId, Date.now() - 30 * 86400000);
    return row ? JSON.parse(row.payload) : null;
  }
}
