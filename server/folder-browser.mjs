import fs from "node:fs/promises";
import path from "node:path";
import { PENDING_DIRECTORY, PENDING_NAMES, directoryClass } from "./directory-classification.mjs";

export function folderScope(lib, rootId, directory = "") {
  if (typeof rootId !== "string" || !rootId || typeof directory !== "string" || directory.length > 4096 || /[\\\x00-\x1f]/.test(directory)) throw Error("文件夹参数无效");
  if (directory && directory.split("/").some(p => !p || p === "." || p === "..")) throw Error("文件夹必须是登记目录内的相对路径");
  const root = lib.db.prepare("SELECT * FROM roots WHERE id=?").get(rootId);
  if (!root) throw Error("未登记的素材目录");
  if (root.retired) throw Error("目录已注销，请先恢复登记");
  const absolute = path.resolve(root.path, ...directory.split("/"));
  if (absolute !== root.path && !absolute.startsWith(root.path + path.sep)) throw Error("文件夹超出登记目录");
  return { root, directory, absolute };
}

export function folderPredicate(lib, query) {
  const { root, absolute } = folderScope(lib, query.directoryRoot, query.directory || "");
  if (query.includeChildren !== undefined && !["0", "1"].includes(query.includeChildren)) throw Error("子目录范围参数无效");
  const prefix = absolute + path.sep, length = [...prefix].length;
  const comparison = lib.db.kind === "mysql" ? "SUBSTR(path,1,?) COLLATE utf8mb4_bin = ?" : "SUBSTR(path,1,?) = ?";
  return {
    sql: "root_id=? AND " + comparison + (query.includeChildren === "0" ? " AND INSTR(SUBSTR(path,?),?)=0" : ""),
    values: query.includeChildren === "0" ? [root.id, length, prefix, length + 1, path.sep] : [root.id, length, prefix],
  };
}

// Folder browsing and explicit creation do not write legacy categories.
export class FolderBrowser {
  constructor(lib) { this.lib = lib; }
  async create(input) {
    if (process.env.MEDIA_READONLY_FILES === "1") throw Error("当前为原文件只读模式，不允许新建文件夹");
    const { root, directory, absolute } = folderScope(this.lib, input.root, input.directory || "");
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.startsWith(".") || /[/\\:\x00-\x1f]/.test(input.name) || Buffer.byteLength(name) > 255)
      throw Error("请输入有效文件夹名称，不能包含斜线、冒号或以点开头");
    const realRoot = await this.lib.checked(root.path, root.id);
    const parent = await this.lib.checked(absolute, root.id);
    if (realRoot !== root.path || parent !== absolute) throw Error("不允许在符号链接目录内新建文件夹");
    if (!(await fs.stat(parent)).isDirectory()) throw Error("目标不是文件夹");
    await fs.access(parent, fs.constants.W_OK);
    try { await fs.mkdir(path.join(parent, name)); }
    catch (e) { if (e.code === "EEXIST") throw Error("同名文件或文件夹已存在，请换一个名称"); throw e; }
    return { root: root.id, directory: directory ? directory + "/" + name : name };
  }
  async branch(query) {
    const classification = query.classification === "1";
    const pending = classification && query.directory === PENDING_DIRECTORY;
    const { root, directory, absolute } = folderScope(this.lib, query.root, pending ? "" : query.directory || "");
    if (classification && directory.split("/").filter(Boolean).length > 2) throw Error("分类仅支持主类和子类两级");
    const indexed = this.lib.db.prepare("SELECT path FROM assets WHERE root_id=? AND trashed=0").all(root.id);
    if (pending) {
      const total = indexed.filter(a => directoryClass(root, a.path)?.review).length;
      return { root: { id: root.id, name: root.name }, directory: PENDING_DIRECTORY, path: root.path, writable: false, state: root.online ? "online" : "offline", direct: total, total, children: [] };
    }
    const counts = new Map();
    const add = name => { if (!counts.has(name)) counts.set(name, { direct: 0, total: 0 }); return counts.get(name); };
    add("");
    for (const asset of indexed) {
      const rel = path.relative(root.path, asset.path);
      if (!rel || path.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + path.sep)) continue;
      const dirs = rel.split(path.sep).slice(0, -1);
      add(dirs.join("/")).direct++;
      for (let i = 0; i <= dirs.length; i++) add(dirs.slice(0, i).join("/")).total++;
    }
    let state = "online", entries = [];
    try {
      const realRoot = await this.lib.checked(root.path, root.id);
      if (realRoot !== root.path) throw Error("登记目录实际路径已改变，请先人工核对");
    } catch (e) { if (!e.code) throw e; state = e.code === "ENOENT" || e.code === "ENODEV" ? "offline" : "unavailable"; }
    if (state === "online") {
      try {
        const real = await this.lib.checked(absolute, root.id);
        if (real !== absolute) throw Error("不浏览符号链接目录");
        entries = (await fs.readdir(real, { withFileTypes: true })).filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith(".")).map(e => e.name);
      } catch (e) { if (!e.code) throw e; state = e.code === "ENOENT" ? "missing" : "unavailable"; }
    }
    if (state !== "online") {
      const prefix = directory ? directory + "/" : "";
      entries = [...new Set([...counts.keys()].filter(p => p.startsWith(prefix) && p !== directory).map(p => p.slice(prefix.length).split("/")[0]))];
    }
    let children = entries.sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })).map(name => {
      const relative = directory ? directory + "/" + name : name;
      return { name, directory: relative, ...(counts.get(relative) || { direct: 0, total: 0 }) };
    });
    if (classification) {
      if (directory.split("/").filter(Boolean).length >= 2) children = [];
      if (!directory) {
        children = children.filter(c => !PENDING_NAMES.has(c.name));
        const total = indexed.filter(a => directoryClass(root, a.path)?.review).length;
        if (total || entries.some(name => PENDING_NAMES.has(name))) children.unshift({ name: "待确认", directory: PENDING_DIRECTORY, direct: total, total });
      }
    }
    let writable = false;
    if (state === "online" && process.env.MEDIA_READONLY_FILES !== "1") {
      try { await fs.access(absolute, fs.constants.W_OK); writable = true; } catch {}
    }
    return { root: { id: root.id, name: root.name }, directory, path: absolute, writable, state, ...(counts.get(directory) || { direct: 0, total: 0 }), children };
  }
}
