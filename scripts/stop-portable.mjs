import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "../server/runtime.mjs";
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  const data = dataDirectory(project, { ...process.env, MEDIA_PORTABLE: "1" });
  const record = JSON.parse(await fs.readFile(path.join(data, "server.json"), "utf8"));
  const u = new URL(record.url);
  if (u.hostname !== "127.0.0.1" || u.protocol !== "http:" || !record.instanceId) throw Error("运行记录无法安全验证，未停止任何进程");
  const response = await fetch(record.url + "/api/session", { signal: AbortSignal.timeout(2000) });
  const identity = await response.json();
  if (!response.ok || identity.app !== "shiguang-local-media" || identity.instanceId !== record.instanceId) throw Error("服务身份不匹配，未停止任何进程");
  const cookie = response.headers.get("set-cookie")?.split(";")[0] || "";
  const get = async p => { const r = await fetch(record.url + "/api/" + p, { headers: { cookie }, signal: AbortSignal.timeout(3000) }); if (!r.ok) throw Error("无法确认任务状态，未停止服务"); return r.json(); };
  const jobs = await get("jobs"), ai = await get("openai"), duplicate = await get("duplicate-audio");
  if (jobs.jobs.some(j => j.status === "running") || jobs.metadata?.pending || ai.active || ai.testing || duplicate.active || duplicate.marking) throw Error("仍有任务运行，请完成或取消任务后再停止");
  process.kill(record.pid, "SIGTERM");
  for (let i = 0; i < 100; i++) {
    try { process.kill(record.pid, 0); } catch { console.log("分享版服务已停止，数据保留。"); process.exit(0); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error("停止超时，请核对运行记录，未强制终止进程");
} catch (e) { console.error(e.code === "ENOENT" || e.code === "ESRCH" ? "没有找到正在运行的分享版服务。" : e.message); process.exitCode = 1; }
