import {probeRuntimeBinding} from '../server/runtime-binding.mjs';
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
  const child = spawn(command, process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url], { stdio: "ignore",windowsHide:true });
  child.on("error", () => console.log("请手动打开：" + url));
}
await fsp.mkdir(data, { recursive: true });
async function running(record) {
  try {
    if(process.platform==='win32'){await probeRuntimeBinding(record);return true;}
    process.kill(record.pid, 0);
    const r = await fetch(record.url + "/api/session", {
      signal: AbortSignal.timeout(1500),
    });
    const identity = await r.json();
    return r.ok && identity.app === 'shiguang-local-media' && (!record.instanceId || identity.instanceId === record.instanceId);
  } catch(error) {
    if(process.platform==='win32'){
      if(error.code==='RUNTIME_IDENTITY_UNCONFIRMED')throw error;
      // Liveness is only a reason to refuse another startup, never closure proof.
      try{if(!Number.isSafeInteger(record.pid)||record.pid<1)throw error;process.kill(record.pid,0);}catch(e){if(e.code==='ESRCH')return false;throw Object.assign(Error('运行记录未能核清，未启动另一个实例'),{code:'RUNTIME_IDENTITY_UNCONFIRMED'});}
      throw Object.assign(Error('原实例仍需核对，未启动另一个实例'),{code:'RUNTIME_IDENTITY_UNCONFIRMED'});
    }
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
} catch(error) {if(error.code==='RUNTIME_IDENTITY_UNCONFIRMED')throw error;}
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
    windowsHide:process.platform==='win32',
    env: { ...process.env, ...(process.platform==='win32'?{MEDIA_DATA_DIR:data}:{}), NODE_ENV: "production", MEDIA_CODEX_AUTOCONNECT: process.env.MEDIA_CODEX_AUTOCONNECT ?? "1" },
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
