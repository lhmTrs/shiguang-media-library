import path from "node:path";

/** Syntax only: retain the original string; filesystem identity/ACL checks stay with the service. */
export function isCloudAudioRootPath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  if (platform !== "win32") return path.posix.isAbsolute(value);

  // A drive-relative path or a current-drive rooted path is not a fully qualified root.
  const windows = value.replaceAll("/", "\\");
  if (/^\\\\[?.]\\/.test(windows) || /^\\\?\?\\/.test(windows)) return false;
  if (/^[a-z]:\\/i.test(windows)) return true;
  if (!windows.startsWith("\\\\")) return false;
  const [server, share] = windows.slice(2).split("\\");
  const component = part => typeof part === "string" && part.length > 0 && ![".", ".."].includes(part)
    && !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part);
  return component(server) && component(share);
}
