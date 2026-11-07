const foreground = process.argv.includes("--foreground");
if (process.platform === "win32" && foreground) {
  console.error("WINDOWS_SAFE_SHUTDOWN_UNSUPPORTED：当前 Windows 前台模式无法保证安全结束，尚未启动服务。请使用普通后台启动方式；安全停止功能尚未支持。");
  process.exitCode = 1;
} else {
const { default: path } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { spawn } = await import("node:child_process");
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const child = spawn(process.execPath, foreground ? [path.join(project, "server/index.mjs")] : [path.join(project, "scripts/launch.mjs"), ...process.argv.slice(2)], {
  cwd: project, env: { ...process.env, MEDIA_PORTABLE: "1", MEDIA_SKIP_IMPORT: "1" }, stdio: "inherit",
});
if (foreground) for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", e => { console.error(e.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
}
