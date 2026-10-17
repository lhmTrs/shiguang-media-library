#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "../server/runtime.mjs";

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2), urlArg = args.find(a => a.startsWith("--url="));
const positional = args.filter(a => !a.startsWith("--"));
const [command, value] = positional;
if (!command || command === "help") {
  console.log("node scripts/annotate.mjs preview /absolute/request.json [--url=http://127.0.0.1:4317]\nnode scripts/annotate.mjs apply <batch-id>\nnode scripts/annotate.mjs history|show <batch-id>|undo <batch-id> [--url=...]\nRead AI_METADATA_API.md before use. preview does not change asset metadata; apply requires user approval.");
  process.exit(0);
}
if (args.some(a => a.startsWith("--") && a !== urlArg) || positional.length > 2 || !["preview", "apply", "history", "show", "undo"].includes(command)) throw Error("无效参数，请运行 help");
const idPattern = /^[\da-f-]{36}$/i;
const runtime = path.join(project, ".runtime", "annotation-sessions");
function localUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("仅接受本机 http://127.0.0.1:端口");
  return url.origin;
}
async function request(base, session, endpoint, body) {
  const r = await fetch(base + "/api" + endpoint, { method: body ? "POST" : "GET", headers: { cookie: session.cookie, ...(body ? { "Content-Type": "application/json", "X-Local-Token": session.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); if (!r.ok) throw Error(d.error || `HTTP ${r.status}`); return d;
}
let base, session, saved;
if (command === "apply") {
  if (!idPattern.test(value || "")) throw Error("批次 ID 无效");
  const file = path.join(runtime, value + ".json"), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077))) throw Error("本机会话缓存权限异常，请重新预览");
  saved = JSON.parse(await fs.readFile(file, "utf8")); base = localUrl(saved.url); session = saved.session;
  if (urlArg && localUrl(urlArg.slice(6)) !== base) throw Error("不能将旧预览用于另一服务");
  if (Date.now() > saved.expiresAt) throw Error("预览已过期，请重新预览");
  const response = await fetch(base + "/api/session", { headers: { cookie: session.cookie } }), identity = await response.json();
  if (identity.app !== "shiguang-local-media" || identity.instanceId !== saved.instanceId || identity.token !== session.token) throw Error("服务或会话已变化，请重新预览");
} else {
  base = localUrl(urlArg ? urlArg.slice(6) : JSON.parse(await fs.readFile(path.join(dataDirectory(project), "server.json"), "utf8")).url);
  const response = await fetch(base + "/api/session"), identity = await response.json();
  if (identity.app !== "shiguang-local-media") throw Error("目标不是拾光素材库");
  session = { cookie: response.headers.get("set-cookie")?.split(";")[0], token: identity.token, instanceId: identity.instanceId };
}
if (command === "preview") {
  if (!value || !path.isAbsolute(value)) throw Error("请提供批量请求 JSON 的绝对路径");
  const text = await fs.readFile(value, "utf8"); if (Buffer.byteLength(text) > 256 * 1024) throw Error("请求 JSON 超过 256 KB，请分批处理");
  const preview = await request(base, session, "/metadata/batches/preview", JSON.parse(text));
  await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
  const dir = path.join(project, ".runtime", "annotation-previews"); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const previewFile = path.join(dir, preview.batchId + ".json");
  await fs.writeFile(previewFile, JSON.stringify(preview, null, 2), { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(runtime, preview.batchId + ".json"), JSON.stringify({ url: base, session, instanceId: session.instanceId, confirmation: preview.confirmation, expiresAt: preview.expiresAt }), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ batchId: preview.batchId, matched: preview.matched, changed: preview.changed, unchanged: preview.unchanged, skipped: preview.skipped, previewFile, expiresAt: preview.expiresAt }));
} else if (command === "apply") {
  const result = await request(base, session, "/metadata/batches", { confirmation: saved.confirmation });
  await fs.unlink(path.join(runtime, value + ".json"));
  console.log(JSON.stringify({ batchId: result.id, updated: result.items.length, skipped: result.skipped, status: result.status }));
} else if (command === "history") {
  console.log(JSON.stringify(await request(base, session, "/metadata/batches"), null, 2));
} else {
  if (!idPattern.test(value || "")) throw Error("批次 ID 无效");
  console.log(JSON.stringify(await request(base, session, "/metadata/batches/" + value + (command === "undo" ? "/undo" : ""), command === "undo" ? {} : undefined), null, 2));
}
