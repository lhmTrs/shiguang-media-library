import crypto from "node:crypto";
import { parseResolveXml } from "./resolve-xml.mjs";
import { cachedRead } from "./read-cache.mjs";

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = value => JSON.parse(value);
const audio = row => ["sfx", "music"].includes(row.kind) && !["mp4", "mov", "m4v", "mkv", "avi", "mts", "m2ts", "webm", "ncm"].includes(row.ext);
const stamp = row => hash([row.id, row.path, row.root_id, row.kind, row.ext, row.size, row.mtime, row.sha256]);
const normalize = value => String(value || "").normalize("NFC");

export class TimelineImports {
  constructor(projects) { this.projects = projects; this.lib = projects.lib; this.previews = new Map(); }
  init() {
    const mysql = this.lib.db.kind === "mysql", id = mysql ? "VARCHAR(36)" : "TEXT", text = mysql ? "LONGTEXT" : "TEXT", number = mysql ? "DOUBLE" : "REAL", name = mysql ? "VARCHAR(120)" : "TEXT", tail = mysql ? " ENGINE=InnoDB" : "";
    // Additive tables only. Existing manual records are journaled before any projection change.
    for (const sql of [
      `CREATE TABLE IF NOT EXISTS project_timelines (id ${id} PRIMARY KEY,project_id ${id} NOT NULL,name ${name} NOT NULL,snapshot ${text} NOT NULL,revision ${id} NOT NULL,head_id ${id} NOT NULL,updated_at ${number} NOT NULL)${tail}`,
      `CREATE TABLE IF NOT EXISTS project_timeline_batches (id ${id} PRIMARY KEY,project_id ${id} NOT NULL,timeline_id ${id} NOT NULL,payload ${text} NOT NULL,status ${mysql ? "VARCHAR(16)" : "TEXT"} NOT NULL,created_at ${number} NOT NULL)${tail}`,
      `CREATE TABLE IF NOT EXISTS project_manual_assets (id ${id} PRIMARY KEY,project_id ${id} NOT NULL,asset_id ${id} NOT NULL,payload ${text} NOT NULL,UNIQUE(project_id,asset_id))${tail}`,
    ]) this.lib.db.exec(sql);
    for (const table of ["project_timelines", "project_timeline_batches"]) this.lib.ensureIndex?.(table+"_project",table,"project_id");
    return this;
  }
  state(projectId) {
    return hash([this.projects.get(projectId), this.lib.db.prepare("SELECT * FROM project_assets WHERE project_id=? ORDER BY id").all(projectId), this.lib.db.prepare("SELECT * FROM project_timelines WHERE project_id=? ORDER BY id").all(projectId)]);
  }
  timelines(projectId) { return this.lib.db.prepare("SELECT * FROM project_timelines WHERE project_id=? ORDER BY updated_at DESC,id").all(projectId); }
  refs(projectId, assetId) { return this.timelines(projectId).flatMap(t => parse(t.snapshot).refs.filter(ref => ref.assetId === assetId).map(ref => ({...ref, timelineId: t.id, timelineName: t.name}))); }
  list(projectId) {
    this.projects.get(projectId);
    return { timelines: this.timelines(projectId).map(({snapshot, ...t}) => ({...t, references: parse(snapshot).refs.length, used: new Set(parse(snapshot).refs.filter(ref=>ref.used && ref.assetId).map(ref=>ref.assetId)).size})), batches: this.lib.db.prepare("SELECT id,timeline_id,status,created_at FROM project_timeline_batches WHERE project_id=? ORDER BY created_at DESC,id LIMIT 30").all(projectId) };
  }
  context(projectId) {
    return cachedRead(this.lib.db,"timeline-context:"+projectId,()=>({
      refs: this.timelines(projectId).flatMap(t=>{
        const snapshot = parse(t.snapshot);
        return snapshot.refs.map(ref=>({assetId:ref.assetId,used:ref.used,occurrences:ref.occurrences,timelineId:t.id,timelineName:t.name,fps:snapshot.fps,duration:snapshot.duration ?? null,startTimecode:snapshot.startTimecode ?? null}));
      }),
      manual: this.lib.db.prepare("SELECT asset_id,payload FROM project_manual_assets WHERE project_id=?").all(projectId).map(row=>({asset_id:row.asset_id,status:parse(row.payload).status})),
    }));
  }
  overview(projectId) {
    this.projects.get(projectId);
    const assets = new Map(this.lib.db.prepare("SELECT p.asset_id,p.snapshot,a.name,a.kind FROM project_assets p LEFT JOIN assets a ON a.id=p.asset_id WHERE p.project_id=?").all(projectId).map(row=>{
      const saved=parse(row.snapshot);
      return [row.asset_id,{name:row.name??saved.name,kind:row.kind??saved.kind}];
    }));
    return {timelines:this.timelines(projectId).map(t=>{
      const snapshot=parse(t.snapshot);
      return {id:t.id,name:t.name,fps:snapshot.fps,duration:snapshot.duration??null,startTimecode:snapshot.startTimecode??null,references:snapshot.refs.map(ref=>({assetId:ref.assetId,name:assets.get(ref.assetId)?.name||ref.name,kind:assets.get(ref.assetId)?.kind||"unknown",used:ref.used,occurrences:ref.occurrences}))};
    })};
  }
  decorate(projectId, row, context = this.context(projectId)) {
    const refs = context.refs.filter(ref=>ref.assetId===row.asset_id);
    const stored = context.manual.find(item=>item.asset_id===row.asset_id);
    const manual = stored || (row.source==="manual" ? row : null);
    return { ...row, manualStatus: manual?.status || null, timelineReferences: refs.map(({assetId,...ref}) => ref), referenceCount: refs.reduce((n,ref)=>n+ref.occurrences.length,0) };
  }
  manual(row) {
    const stored = this.lib.db.prepare("SELECT payload FROM project_manual_assets WHERE project_id=? AND asset_id=?").get(row.project_id, row.asset_id);
    return stored ? parse(stored.payload) : row.source === "manual" ? row : null;
  }
  storeManual(row) {
    const old = this.lib.db.prepare("SELECT id FROM project_manual_assets WHERE project_id=? AND asset_id=?").get(row.project_id, row.asset_id);
    if (old) this.lib.db.prepare("UPDATE project_manual_assets SET payload=? WHERE id=?").run(JSON.stringify(row), old.id);
    else this.lib.db.prepare("INSERT INTO project_manual_assets(id,project_id,asset_id,payload) VALUES(?,?,?,?)").run(crypto.randomUUID(), row.project_id, row.asset_id, JSON.stringify(row));
  }
  editManual(row, input) {
    const now = Date.now(), base = this.manual(row) || { ...row, status: "candidate", used_at: null, source: "manual" };
    const status = input.status ?? base.status;
    this.storeManual({...base, status, note: input.note ?? base.note, updated_at: now, used_at: status === "used" ? base.used_at ?? now : base.used_at});
    this.rebuild(row.project_id, [row.asset_id]);
  }
  rebuild(projectId, ids) {
    const allRefs = this.timelines(projectId).flatMap(t=>parse(t.snapshot).refs);
    const currentRows = new Map(this.lib.db.prepare("SELECT * FROM project_assets WHERE project_id=?").all(projectId).map(row=>[row.asset_id,row]));
    const manualRows = new Map(this.lib.db.prepare("SELECT asset_id,payload FROM project_manual_assets WHERE project_id=?").all(projectId).map(row=>[row.asset_id,parse(row.payload)]));
    for (const assetId of new Set(ids)) {
      const current = currentRows.get(assetId);
      const manual = manualRows.get(assetId) || (current?.source === "manual" ? current : null);
      const refs = allRefs.filter(ref=>ref.assetId===assetId);
      if (!manual && !refs.length) { this.lib.db.prepare("DELETE FROM project_assets WHERE project_id=? AND asset_id=?").run(projectId, assetId); continue; }
      const now = Date.now(), status = manual?.status === "used" || refs.some(ref=>ref.used) ? "used" : "candidate";
      const base = manual || current || { id: crypto.randomUUID(), added_at: now, used_at: null, note: "", snapshot: JSON.stringify(this.lib.asset(assetId)) };
      const values = [status, manual?.note ?? current?.note ?? "", manual && refs.length ? "mixed" : manual ? "manual" : "resolve", status === "used" ? manual?.used_at ?? current?.used_at ?? now : manual?.used_at ?? null, now, base.snapshot];
      if (current) this.lib.db.prepare("UPDATE project_assets SET status=?,note=?,source=?,used_at=?,updated_at=?,snapshot=? WHERE id=?").run(...values, current.id);
      else this.lib.db.prepare("INSERT INTO project_assets(status,note,source,used_at,updated_at,snapshot,id,project_id,asset_id,added_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(...values, base.id, projectId, assetId, base.added_at);
    }
  }
  preview(projectId, input, owner) {
    if (projectId) this.projects.get(projectId);
    const parsed = parseResolveXml(input.xml);
    const target = input.timelineId && projectId ? this.timelines(projectId).find(t=>t.id === input.timelineId) : null;
    if (input.timelineId && !target) throw Error("请选择此项目中的时间线");
    const name = this.projects.text(input.name || target?.name || parsed.name,120,"时间线名称",true);
    const available = this.lib.db.prepare(`SELECT * FROM assets WHERE trashed=0 AND ${this.lib.activeAssetScope()} AND ${this.lib.nonMissingAssetScope()}`).all().filter(audio);
    const byPath = new Map(), byName = new Map();
    for (const asset of available) {
      const p = normalize(asset.path), n = normalize(asset.name).toLocaleLowerCase();
      byPath.set(p, [...(byPath.get(p)||[]),asset]); byName.set(n,[...(byName.get(n)||[]),asset]);
    }
    const rows = parsed.entries.map(entry => {
      const exact = entry.sourcePath ? byPath.get(normalize(entry.sourcePath)) || [] : [];
      const matched = exact.length === 1 ? exact[0] : null;
      const candidates = (matched ? [matched] : byName.get(normalize(entry.name).toLocaleLowerCase()) || []).slice(0,20);
      return {...entry, assetId: matched?.id || null, match: matched ? "path" : candidates.length ? "candidate" : "missing", eligible: entry.occurrences.some(o=>!o.disabled), candidates: candidates.map(a=>({id:a.id,name:a.name,path:a.path,kind:a.kind})), identity: matched ? stamp(matched) : null};
    });
    const previous = target ? parse(target.snapshot) : {refs:[]};
    const newIds = new Set(rows.map(row=>row.assetId).filter(Boolean));
    const beforeIds = new Set(previous.refs.map(ref=>ref.assetId).filter(Boolean));
    const diff = { added: [...newIds].filter(id=>!beforeIds.has(id)).length, removed: [...beforeIds].filter(id=>!newIds.has(id)).length };
    for (const [key,value] of this.previews) if (Date.now()-value.createdAt>600000) this.previews.delete(key);
    if (this.previews.size >= 12) this.previews.delete(this.previews.keys().next().value);
    const token = crypto.randomUUID();
    this.previews.set(token,{projectId,owner,db:this.lib.db,createdAt:Date.now(),state:projectId ? this.state(projectId) : null,target,parsed,rows,name});
    return {token,name,timelineId:target?.id || null,rows,warnings:parsed.warnings,diff,fps:parsed.fps};
  }
  apply(projectId, input, owner) {
    const preview = this.previews.get(input.token);
    if (!preview || preview.projectId !== projectId || preview.owner !== owner || preview.db !== this.lib.db || Date.now()-preview.createdAt>600000) throw Error("导入预览已过期，请重新预览");
    if (!Array.isArray(input.selections) || input.selections.length !== preview.rows.length) throw Error("请确认每条引用的匹配结果");
    if (!projectId && input.confirmUsed !== true) throw Error("请确认创建项目及时间线导入");
    const choices = new Map();
    for (const choice of input.selections) {
      if (!choice || typeof choice.key !== "string" || choices.has(choice.key) || !preview.rows.some(row=>row.key===choice.key) || (choice.assetId !== null && (typeof choice.assetId !== "string" || choice.assetId.length>36)) || typeof choice.used !== "boolean") throw Error("引用选择格式无效");
      choices.set(choice.key,choice);
    }
    const allowed = new Map(this.lib.db.prepare(`SELECT * FROM assets WHERE trashed=0 AND ${this.lib.activeAssetScope()} AND ${this.lib.nonMissingAssetScope()}`).all().filter(audio).map(a=>[a.id,a]));
    const refs = preview.rows.map(row => {
      const choice = choices.get(row.key), asset = choice.assetId ? allowed.get(choice.assetId) : null;
      if (choice.assetId && !asset) throw Error("匹配素材已不可用，请重新预览");
      if (asset && asset.id===row.assetId && stamp(asset)!==row.identity) throw Error("素材身份已变化，请重新预览");
      if (choice.used && (!asset || !row.eligible || input.confirmUsed !== true)) throw Error("请明确确认可用引用为已使用；禁用引用不能直接计入");
      return {key:row.key,name:row.name,sourcePath:row.sourcePath,assetId:asset?.id || null,used:choice.used,occurrences:row.occurrences};
    });
    const previous = preview.target ? parse(preview.target.snapshot) : {refs:[]};
    if (input.removeMissing !== true) {
      const seen = new Set(refs.map(ref=>ref.assetId).filter(Boolean));
      for (const ref of previous.refs) if (ref.assetId && !seen.has(ref.assetId)) refs.push({...ref,retained:true});
    }
    const snapshot = {refs,warnings:preview.parsed.warnings,fps:preview.parsed.fps,duration:preview.parsed.duration,startTimecode:preview.parsed.startTimecode};
    const timelineId = preview.target?.id || crypto.randomUUID();
    const result = this.lib.db.transaction(() => {
      const destination = projectId || this.projects.save(null,{name:input.projectName || preview.name,software:"resolve",note:""}).id;
      if (projectId && this.state(projectId)!==preview.state) throw Error("项目或时间线已变化，请重新预览，不会覆盖新修改");
      if (preview.target && preview.target.name===preview.name && hash(previous)===hash(snapshot)) return {alreadyImported:true,timelineId,projectId:destination};
      const affected = [...new Set([...previous.refs,...refs].map(ref=>ref.assetId).filter(Boolean))];
      const beforeProjection = affected.map(id=>this.lib.db.prepare("SELECT * FROM project_assets WHERE project_id=? AND asset_id=?").get(destination,id)).filter(Boolean);
      for (const row of beforeProjection) if (row.source==="manual") this.storeManual(row);
      const id = crypto.randomUUID(), revision = crypto.randomUUID(), now = Date.now();
      const payload = {before:preview.target,after:{name:preview.name,snapshot},beforeProjection,affected};
      this.lib.db.prepare("INSERT INTO project_timeline_batches(id,project_id,timeline_id,payload,status,created_at) VALUES(?,?,?,?,?,?)").run(id,destination,timelineId,JSON.stringify(payload),"applied",now);
      if (preview.target) this.lib.db.prepare("UPDATE project_timelines SET name=?,snapshot=?,revision=?,head_id=?,updated_at=? WHERE id=? AND project_id=?").run(preview.name,JSON.stringify(snapshot),revision,id,now,timelineId,destination);
      else this.lib.db.prepare("INSERT INTO project_timelines(id,project_id,name,snapshot,revision,head_id,updated_at) VALUES(?,?,?,?,?,?,?)").run(timelineId,destination,preview.name,JSON.stringify(snapshot),revision,id,now);
      this.rebuild(destination,affected);
      this.lib.db.prepare("UPDATE media_projects SET updated_at=? WHERE id=?").run(now,destination);
      return {alreadyImported:false,timelineId,projectId:destination,batchId:id,referenced:new Set(refs.map(ref=>ref.assetId).filter(Boolean)).size,used:new Set(refs.filter(ref=>ref.used).map(ref=>ref.assetId)).size};
    })();
    this.previews.delete(input.token); return result;
  }
  undo(projectId, batchId) {
    this.projects.get(projectId);
    return this.lib.db.transaction(() => {
      const batch = this.lib.db.prepare("SELECT * FROM project_timeline_batches WHERE id=? AND project_id=?").get(batchId,projectId);
      const timeline = batch && this.timelines(projectId).find(t=>t.id===batch.timeline_id);
      if (!batch || batch.status!=="applied" || !timeline || timeline.head_id!==batch.id) throw Error("只能撤销该时间线当前最新的导入，请刷新记录");
      const payload = parse(batch.payload), before = payload.before, now = Date.now();
      if (before) this.lib.db.prepare("UPDATE project_timelines SET name=?,snapshot=?,revision=?,head_id=?,updated_at=? WHERE id=?").run(before.name,before.snapshot,crypto.randomUUID(),before.head_id,now,timeline.id);
      else {
        this.lib.db.prepare("DELETE FROM project_timelines WHERE id=?").run(timeline.id);
        this.lib.db.prepare("DELETE FROM project_renders WHERE id=? AND project_id=?").run(timeline.id,projectId);
      }
      // Recompute from current manual edits and other timelines, never restore over later user edits.
      this.rebuild(projectId,payload.affected);
      this.lib.db.prepare("UPDATE project_timeline_batches SET status=? WHERE id=?").run("undone",batch.id);
      this.lib.db.prepare("UPDATE media_projects SET updated_at=? WHERE id=?").run(now,projectId);
      return {undone:true};
    })();
  }
  removeProject(projectId) {
    for (const table of ["project_timelines","project_timeline_batches","project_manual_assets"]) this.lib.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(projectId);
  }
}
