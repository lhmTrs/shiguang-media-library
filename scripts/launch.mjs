import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataDirectory } from "../server/runtime.mjs";
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = dataDirectory(project);
function openBrowser(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { stdio: "ignore" });
  child.on("error", () => console.log("请手动打开：" + url));
}
await fsp.mkdir(data, { recursive: true });
async function running(record) {
  try {
    process.kill(record.pid, 0);
    const r = await fetch(record.url + "/api/session", {
      signal: AbortSignal.timeout(1500),
    });
    const identity = await r.json();
    return r.ok && identity.app === 'shiguang-local-media' && (!record.instanceId || identity.instanceId === record.instanceId);
  } catch {
    return false;
  }
}
try {
  const record = JSON.parse(
    await fsp.readFile(path.join(data, "server.json"), "utf8"),
  );
  if (await running(record)) {
    console.log(record.url);
    if (process.argv.includes("--open"))
      openBrowser(record.url);
    process.exit(0);
  }
} catch {}
try {
  await fsp.access(path.join(project, "dist/index.html"));
} catch {
  throw Error("请先执行 npm run build");
}
const log = fs.openSync(path.join(data, "server.log"), "a");
const child = spawn(
  process.execPath,
  [path.join(project, "server/index.mjs")],
  {
    cwd: project,
    detached: true,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", log, log],
  },
);
child.unref();
fs.closeSync(log);
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    process.kill(child.pid, 0);
    const record = JSON.parse(
      await fsp.readFile(path.join(data, "server.json"), "utf8"),
    );
    if (record.pid === child.pid && (await running(record))) {
      console.log(record.url);
      if (process.argv.includes("--open"))
        openBrowser(record.url);
      process.exit(0);
    }
  } catch {}
}
throw Error("启动超时，请查看 " + path.join(data, "server.log"));
