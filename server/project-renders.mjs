import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const formats = new Set([".mp4", ".mov", ".m4v", ".webm"]);
export class ProjectRenders {
  constructor(projects) { this.projects = projects; this.lib = projects.lib; }
  init() {
    const mysql = this.lib.db.kind === "mysql";
    this.lib.db.exec(`CREATE TABLE IF NOT EXISTS project_renders (id ${mysql ? "VARCHAR(36)" : "TEXT"} PRIMARY KEY,project_id ${mysql ? "VARCHAR(36)" : "TEXT"} NOT NULL,payload ${mysql ? "LONGTEXT" : "TEXT"} NOT NULL)${mysql ? " ENGINE=InnoDB" : ""}`);
    return this;
  }
  validate(projectId, timelineId) {
    this.projects.get(projectId);
    if (!this.lib.db.prepare("SELECT id FROM project_timelines WHERE project_id=? AND id=?").get(projectId,timelineId)) throw Error("时间线不存在，请重新导入");
  }
  get(projectId, timelineId) {
    this.validate(projectId,timelineId);
    const row = this.lib.db.prepare("SELECT payload FROM project_renders WHERE project_id=? AND id=?").get(projectId,timelineId);
    if (!row) return null;
    const {path: file, offset, updatedAt} = JSON.parse(row.payload);
    return {path:file,offset,updatedAt};
  }
  async save(projectId, timelineId, input) {
    this.validate(projectId,timelineId);
    if (typeof input.path !== "string" || !path.isAbsolute(input.path) || input.path.length > 8192 || input.path.includes("\0")) throw Error("请输入成片文件的本地绝对路径");
    const offset = Number(input.offset ?? 0);
    if (!Number.isFinite(offset) || Math.abs(offset) > 86400) throw Error("成片偏移须为 -86400 至 86400 秒");
    const file = await fs.realpath(input.path);
    if (!formats.has(path.extname(file).toLowerCase())) throw Error("请选择 MP4、MOV、M4V 或 WebM 成片文件");
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    let stat;
    try { stat = await handle.stat(); if (!stat.isFile()) throw Error("请选择普通视频文件"); } finally { await handle.close(); }
    this.validate(projectId,timelineId);
    const payload = JSON.stringify({path:file,offset,dev:String(stat.dev),ino:String(stat.ino),size:stat.size,mtime:stat.mtimeMs,updatedAt:Date.now()});
    this.lib.db.transaction(() => {
      this.lib.db.prepare("DELETE FROM project_renders WHERE project_id=? AND id=?").run(projectId,timelineId);
      this.lib.db.prepare("INSERT INTO project_renders(id,project_id,payload) VALUES(?,?,?)").run(timelineId,projectId,payload);
    })();
    return this.get(projectId,timelineId);
  }
  remove(projectId,timelineId) {
    this.validate(projectId,timelineId);
    this.lib.db.prepare("DELETE FROM project_renders WHERE project_id=? AND id=?").run(projectId,timelineId);
    return {removed:true};
  }
  async open(projectId,timelineId) {
    this.validate(projectId,timelineId);
    const row = this.lib.db.prepare("SELECT payload FROM project_renders WHERE project_id=? AND id=?").get(projectId,timelineId);
    if (!row) throw Error("尚未关联成片");
    const saved = JSON.parse(row.payload);
    const handle = await fs.open(saved.path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || String(stat.dev)!==saved.dev || String(stat.ino)!==saved.ino || stat.size!==saved.size || stat.mtimeMs!==saved.mtime) throw Error("成片已替换或修改，请重新关联文件");
      return {handle,path:saved.path};
    } catch(e) { await handle.close(); throw e; }
  }
}
