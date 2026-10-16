import path from "node:path";
import os from "node:os";

export function dataDirectory(project, env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.MEDIA_DATA_DIR) return path.resolve(env.MEDIA_DATA_DIR);
  if (env.MEDIA_PORTABLE === "1") return path.join(project, "data");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "拾光素材库");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ShiguangMedia");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "shiguang-media");
}
