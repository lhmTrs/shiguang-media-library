import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_OUTPUT = 16384;
const MAX_PATH = 8192;
const windowsScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择素材文件夹'
$dialog.ShowNewFolderButton = $false
try {
  $selected = $null
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $selected = $dialog.SelectedPath
  }
  ConvertTo-Json -Compress -InputObject @{ path = $selected }
} finally {
  $dialog.Dispose()
}
`;
const macScript = `try
  return POSIX path of (choose folder with prompt "选择素材文件夹")
on error number -128
  return ""
end try`;

// Require a fully qualified Windows path. isAbsolute also accepts paths
// rooted only on the current drive, so it is not sufficient here.
function fullWindowsPath(value) {
  if (typeof value !== "string" || !value || value.length > MAX_PATH || /[\x00-\x1f\x7f<>"|?*]/.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const tail = value.slice(3);
    return !tail.includes(":") && !tail.split(/[\\/]/).some(p => p === "." || p === "..");
  }
  if (!value.startsWith("\\\\") || value.includes(":")) return false;
  const parts = value.slice(2).split("\\");
  return parts.length >= 2 && !!parts[0] && !!parts[1] &&
    !parts.some(p => p === "." || p === ".." || p.includes("/"));
}

export function folderPickerAvailable(platform = process.platform, env = process.env) {
  return env.MEDIA_CONTAINER !== "1" && ["darwin", "win32"].includes(platform);
}

export function createFolderPicker({ platform = process.platform, env = process.env, run = execute } = {}) {
  let active = false;
  return async function chooseFolder() {
    if (!folderPickerAvailable(platform, env)) throw Error("此环境不支持系统文件夹选择，请填写绝对路径");
    if (active) throw Error("文件夹选择窗口已打开，请先完成或取消选择");
    active = true;
    try {
      let selected;
      if (platform === "win32") {
        const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
        if (!fullWindowsPath(systemRoot) || !/^[A-Za-z]:\\/.test(systemRoot)) throw Error("INVALID_SYSTEM_ROOT");
        const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const { stdout } = await run(executable, ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")], { timeout: 120000, maxBuffer: MAX_OUTPUT, encoding: "utf8", windowsHide: true, shell: false });
        if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_OUTPUT) throw Error("INVALID_DIALOG_RESULT");
        const result = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
        if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 || !Object.hasOwn(result, "path")) throw Error("INVALID_DIALOG_RESULT");
        selected = result.path;
      } else {
        const { stdout } = await run("/usr/bin/osascript", ["-e", macScript], { timeout: 120000, maxBuffer: 16384, encoding: "utf8", shell: false });
        selected = stdout.replace(/\r?\n$/, "");
      }
      if (selected === null || selected === "") return { cancelled: true };
      if (typeof selected !== "string" || selected.length > MAX_PATH || selected.includes("\0") ||
          !(platform === "win32" ? fullWindowsPath(selected) : path.posix.isAbsolute(selected))) throw Error("INVALID_DIALOG_PATH");
      return { cancelled: false, path: selected };
    } catch {
      throw Error("无法完成系统文件夹选择。请重试，或在下方填写文件夹绝对路径添加目录");
    } finally {
      active = false;
    }
  };
}
