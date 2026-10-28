import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
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
        if (!path.win32.isAbsolute(systemRoot)) throw Error("INVALID_SYSTEM_ROOT");
        const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const { stdout } = await run(executable, ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")], { timeout: 120000, maxBuffer: 16384, encoding: "utf8", windowsHide: true, shell: false });
        const result = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
        if (!result || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 || !Object.hasOwn(result, "path")) throw Error("INVALID_DIALOG_RESULT");
        selected = result.path;
      } else {
        const { stdout } = await run("/usr/bin/osascript", ["-e", macScript], { timeout: 120000, maxBuffer: 16384, encoding: "utf8", shell: false });
        selected = stdout.replace(/\r?\n$/, "");
      }
      if (selected === null || selected === "") return { cancelled: true };
      const paths = platform === "win32" ? path.win32 : path.posix;
      if (typeof selected !== "string" || selected.length > 8192 || selected.includes("\0") || !paths.isAbsolute(selected)) throw Error("INVALID_DIALOG_PATH");
      return { cancelled: false, path: selected };
    } catch {
      throw Error("无法完成系统文件夹选择。请重试，或在下方填写文件夹绝对路径添加目录");
    } finally {
      active = false;
    }
  };
}
