/**
 * 测试专用副作用探针（NODE_OPTIONS=--require 预加载）。
 *
 * 只记录，不改变行为：出站 HTTP(S) 请求、子进程、以及任何提到 asset_audio 的 SQL。
 * 用来证明“默认关闭”时音频路由零联网/零下载/零 spawn/零建表。
 */
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const cp = require("node:child_process");
const util = require("node:util");
const { syncBuiltinESMExports } = require("node:module");

const logFile = process.env.AUDIO_PROBE_LOG;
if (logFile) {
  const record = (kind, detail) => {
    try {
      fs.appendFileSync(logFile, JSON.stringify({ kind, detail: String(detail) }) + "\n");
    } catch {}
  };

  const urlOf = (args) => {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") return first.href || `${first.protocol || ""}//${first.host || ""}${first.path || ""}`;
    return String(first);
  };

  for (const [modName, mod] of [["http", http], ["https", https]]) {
    for (const method of ["get", "request"]) {
      const original = mod[method];
      mod[method] = function (...args) {
        record(`net.${modName}.${method}`, urlOf(args));
        return original.apply(this, args);
      };
    }
  }

  const recordCommand = (kind, args) => {
    const cmd = typeof args[0] === "string" ? args[0] : "";
    const rest = Array.isArray(args[1]) ? args[1].join(" ") : "";
    record(kind, `${cmd} ${rest}`.trim());
  };

  for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
    const original = cp[method];
    if (typeof original !== "function") continue;
    const wrapped = function (...args) {
      recordCommand(`process.${method}`, args);
      return original.apply(this, args);
    };
    if (original[util.promisify.custom]) wrapped[util.promisify.custom] = original[util.promisify.custom];
    cp[method] = wrapped;
  }

  try {
    const Database = require("better-sqlite3");
    for (const method of ["exec", "prepare"]) {
      const original = Database.prototype[method];
      Database.prototype[method] = function (sql, ...rest) {
        if (typeof sql === "string" && /asset_audio/i.test(sql)) record(`db.${method}`, sql.replace(/\s+/g, " ").slice(0, 300));
        return original.call(this, sql, ...rest);
      };
    }
  } catch {}

  syncBuiltinESMExports();
}
