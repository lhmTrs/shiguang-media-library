import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const foreground = process.argv.includes("--foreground");
const child = spawn(process.execPath, foreground ? [path.join(project, "server/index.mjs")] : [path.join(project, "scripts/launch.mjs"), ...process.argv.slice(2)], {
  cwd: project, env: { ...process.env, MEDIA_PORTABLE: "1", MEDIA_SKIP_IMPORT: "1" }, stdio: "inherit",
});
if (foreground) for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", e => { console.error(e.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
