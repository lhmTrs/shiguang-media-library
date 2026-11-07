import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STORYBOARD_TABLES, storyboardSchema } from './db-schema.mjs';
import { parseInitialization, bindInitialization } from './import.mjs';
import { blankAsset, canonical, digest, fault, idOK, normalize } from '../project-assets/model.mjs';
import * as M from './shared/model.mjs';

export class StoryboardDatabase {
  constructor(lib, assets) { this.lib=lib; this.assets=assets; }
  get db() { return this.lib.db; }
  tx(fn) { return this.assets.tx(fn); }
  init() {
    for (const sql of storyboardSchema(this.db.kind==='mysql')) this.db.exec(sql);
    if (this.db.kind!=='mysql') this.db.exec('CREATE INDEX IF NOT EXISTS storyboard_link_asset ON storyboard_asset_links(asset_id,document_id)');
    const state=this.db.prepare('SELECT * FROM storyboard_schema WHERE id=?').get('storyboard');
    if (state && state.version!==1) throw fault('分镜数据库版本不受支持',503);
    if (!state) { const now=Date.now(); this.db.prepare('INSERT INTO storyboard_schema VALUES(?,?,?,?)').run('storyboard',1,now,now); }
    this.assets.storyboards=this;
    return this;
  }
  project(id,lock=false) { const p=this.assets.project(id,lock); if(p.project_kind!=='normal') throw fault('分镜只能绑定普通项目，公共人物库不能创建分镜'); return p; }
  head(projectId) { return this.db.prepare('SELECT * FROM storyboard_documents WHERE project_id=?').get(projectId); }
  expected(row,revision) { if (row ? revision!==row.revision : revision!==null) throw fault('分镜已经更新或已被重新初始化，请载入最新内容；当前草稿未覆盖数据库',409,{current_revision:row?.revision??null}); }
  linked(row) { return this.db.prepare('SELECT a.* FROM creative_assets a JOIN storyboard_asset_links l ON l.asset_id=a.id WHERE l.document_id=? ORDER BY a.kind,a.id').all(row.id); }
  hydrate(row) {
    const p=JSON.parse(row.document_json), linked=this.linked(row), byId=new Map(linked.map(a=>[a.id,this.assets.get(a.id)]));
    for (const kind of ['character','scene','prop']) for (const e of p.asset_manifest[kind]) { const a=byId.get(e.id); if(!a) throw fault('分镜资产关联损坏，已停止保存',503); e.name=a.name; }
    p.characters=p.characters.map(c=>{const a=byId.get(c.id); if(!a) throw fault('分镜人物关联损坏',503); return {...c,name:a.name,age:a.details?.age??c.age??'',role:a.details?.role??c.role??'',description:a.performance_info,appearance:a.base_info,asset_revision:a.revision};});
    p.revision=row.revision;
    return {project:p,hash:digest(row.document_json),revision:row.revision,project_id:row.project_id,storage:this.db.kind==='mysql'?'mysql':'sqlite',file:'数据库 · '+this.project(row.project_id).name,initialized_at:row.initialized_at,source_filename:row.source_filename,missing_assets:[],asset_stamp:digest(linked.map(a=>[a.id,a.revision,a.name]))};
  }
  read(projectId) { this.project(projectId); const row=this.head(projectId); if(!row) throw fault('此项目尚未初始化分镜',404); return this.hydrate(row); }
  assetShots(assetId) {
    const asset=this.assets.head(assetId),row=this.head(asset.project_id);
    const result={projectId:asset.project_id,documentId:row?.id??null,documentTitle:row?.title??'',revision:row?.revision??null,initialized:!!row,listed:false,items:[]};
    if(!row)return result;
    const project=JSON.parse(row.document_json);if(!project.asset_manifest?.[asset.kind]?.some(a=>a.id===asset.id))return result;
    result.listed=true;const rows=M.timeline(project),dialogues=new Map(rows.flatMap(r=>(r.shot.dialogue??[]).map(d=>[r.shot.id+'/'+d.id,d])));
    for(const {shot,scene,number} of rows){
      const reasons=[];
      if(asset.kind==='character'){
        if((shot.character_ids??[]).includes(asset.id)||(shot.character_presence??[]).some(p=>p.character_id===asset.id))reasons.push('人物关联');
        if((shot.dialogue??[]).some(d=>d.character_id===asset.id))reasons.push('对白');
        if((shot.audio_continuations??[]).some(c=>dialogues.get(c.source_shot_id+'/'+c.dialogue_id)?.character_id===asset.id))reasons.push('语音承接');
      }else if(asset.kind==='scene'&&(shot.scene_asset_id||scene.scene_asset_id)===asset.id)reasons.push(shot.scene_asset_id?'本镜场景':'沿用场次');
      else if(asset.kind==='prop'&&(shot.prop_ids??[]).includes(asset.id))reasons.push('道具关联');
      if(reasons.length)result.items.push({shotId:shot.id,number,sceneId:scene.id,sceneName:scene.name||scene.location||'未命名场次',location:scene.location,action:String(shot.action||'').slice(0,180),reasons});
    }
    return result;
  }
  list() { return this.db.prepare('SELECT d.id,d.project_id,d.title,d.revision,d.updated_at,p.name project_name FROM storyboard_documents d JOIN media_projects p ON p.id=d.project_id ORDER BY d.updated_at DESC').all(); }
  plan(projectId, parsed) {
    const current=this.head(projectId), existing=new Map(this.db.prepare('SELECT * FROM creative_assets WHERE project_id=? AND archived_at=0').all(projectId).map(a=>[a.kind+':'+a.name_key,a]));
    const assets=parsed.manifest.map(e=>{const old=existing.get(e.kind+':'+e.name_key); return {kind:e.kind,name:e.name,action:old?'reuse':'create',id:old?.id??null,has_description:!!old && !!JSON.parse(old.data_json).base_info};});
    const retained=new Set(assets.map(a=>a.id).filter(Boolean));
    return {project_id:projectId,project_name:this.project(projectId).name,expected_revision:current?.revision??null,replacing:!!current,...parsed.summary,assets,unlinked:current?this.linked(current).filter(a=>!retained.has(a.id)).length:0,warnings:parsed.warnings};
  }
  preview(projectId,input) { this.project(projectId); const parsed=parseInitialization(input.source,{filename:input.filename,timing:input.timing}); return this.plan(projectId,parsed); }
  initialize(projectId,input) {
    if(!idOK(input.request_id)) throw fault('初始化请求编号无效');
    const sourceHash=digest(input.source), requestHash=digest({projectId,sourceHash,expected_revision:input.expected_revision,filename:input.filename??'',timing:input.timing??'duration'});
    const parsed=parseInitialization(input.source,{filename:input.filename,timing:input.timing});
    return this.tx(()=>{
      this.project(projectId,true);this.generationLocks?.assertWritable(projectId);
      const done=this.db.prepare('SELECT * FROM storyboard_import_requests WHERE id=?').get(input.request_id);
      if(done) { if(done.request_hash!==requestHash || done.project_id!==projectId) throw fault('初始化请求编号已用于其他内容',409); return {...this.read(projectId),receipt:JSON.parse(done.result_json),repeated:true}; }
      const old=this.head(projectId); this.expected(old,input.expected_revision);
      const plan=this.plan(projectId,parsed), map=new Map(), now=Math.max(Date.now(),(old?.updated_at??0)+1), documentId=old?.id??randomUUID();
      for (const e of parsed.manifest) {
        let a=this.db.prepare('SELECT id FROM creative_assets WHERE project_id=? AND kind=? AND name_key=? AND archived_at=0').get(projectId,e.kind,e.name_key);
        if(!a) {
          const fresh=blankAsset(projectId,e.kind,e.name), d=e.detail;
          fresh.base_info=typeof d.base_info==='string'?d.base_info:[d.age??d['年龄'],d.role??d['身份'],d.description??d['描述']??d['说明']].filter(v=>v!==undefined&&v!=='').join('；');
          fresh.performance_info=String(d.performance_info??d['人物特点']??(e.kind==='character'?d.description:'')??'');
          fresh.details={source:e.source,...(e.kind==='character'?{age:d.age??d['年龄']??'',role:d.role??d['身份']??''}:{})};
          a=this.assets.write(normalize(fresh),null,'分镜初始化创建资产');
        }
        map.set(e.kind+':'+e.name_key,a.id);
      }
      const p=bindInitialization(parsed,map,documentId); p.document_id=documentId; p.bound_project_id=projectId; p.revision=(old?.revision??0)+1;
      p.legacy_media_project_id=input.source.schema_version==='1.0.0' ? input.source.legacy_media_project_id ?? input.source.project_id : null;
      const values=[p.title,canonical(p),p.revision,now,input.filename??'分镜.json',sourceHash,now];
      if(old) this.db.prepare('UPDATE storyboard_documents SET title=?,document_json=?,revision=?,initialized_at=?,source_filename=?,source_hash=?,updated_at=? WHERE id=?').run(...values,documentId);
      else this.db.prepare('INSERT INTO storyboard_documents(title,document_json,revision,initialized_at,source_filename,source_hash,updated_at,id,project_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...values,documentId,projectId,now);
      this.db.prepare('DELETE FROM storyboard_asset_links WHERE document_id=?').run(documentId);
      for(const assetId of map.values()) this.db.prepare('INSERT INTO storyboard_asset_links VALUES(?,?,?,?,?)').run(randomUUID(),documentId,assetId,now,now);
      const receipt={request_id:input.request_id,document_id:documentId,project_id:projectId,revision:p.revision,initialized_at:now,summary:parsed.summary,created:plan.assets.filter(a=>a.action==='create').length,reused:plan.assets.filter(a=>a.action==='reuse').length,unlinked:plan.unlinked};
      this.db.prepare('INSERT INTO storyboard_import_requests VALUES(?,?,?,?,?,?,?,?,?)').run(input.request_id,projectId,documentId,requestHash,sourceHash,input.expected_revision,canonical(receipt),now,now);
      return {...this.read(projectId),receipt,repeated:false};
    });
  }
  request(projectId,id) { this.project(projectId); if(!idOK(id)) throw fault('请求编号无效'); const row=this.db.prepare('SELECT result_json FROM storyboard_import_requests WHERE id=? AND project_id=?').get(id,projectId); return row?{completed:true,receipt:JSON.parse(row.result_json)}:{completed:false}; }
  save(projectId,input) {
    return this.tx(()=>{
      this.project(projectId,true);this.generationLocks?.assertWritable(projectId); const old=this.head(projectId); if(!old) throw fault('请先用完整 JSON 初始化分镜',404);
      this.expected(old,input.expected_revision);
      const p=M.normalizeProject(input.project), previous=JSON.parse(old.document_json);
      if(p.project_id!==old.id) throw fault('分镜编号不匹配');
      if(p.document_id!==old.id||p.bound_project_id!==projectId)throw fault('分镜所属项目不匹配');
      if(p.generation_batches.length || p.generation_runs.length) throw fault('当前分镜不保存历史批次或快照');
      const current=new Set(this.linked(old).map(a=>a.id));
      const ids=[];
      for(const kind of ['character','scene','prop']) {
        if(!Array.isArray(p.asset_manifest?.[kind])) throw fault('清单缺少'+kind);
        for(const e of p.asset_manifest[kind]) {
          const a=this.assets.head(e.id); if(a.project_id!==projectId||a.kind!==kind||a.archived_at!==0) throw fault('清单只能关联当前项目的未归档同类资产');
          if(ids.includes(e.id)) throw fault('清单资产重复'); ids.push(e.id);
        }
      }
      if([...current].some(id=>!ids.includes(id))) throw fault('日常保存不能移除或替换清单关联，请通过完整 JSON 重新初始化',409);
      const charIds=p.asset_manifest.character.map(e=>e.id);
      if(canonical([...p.characters.map(c=>c.id)].sort())!==canonical([...charIds].sort())) throw fault('分镜人物必须与完整人物清单一致');
      const errors=M.validateProject(p); if(errors.length) throw fault('分镜校验失败',400,{errors});
      const allowed=(kind,id)=>!id||p.asset_manifest[kind].some(e=>e.id===id);
      for(const s of p.scenes) { if(!allowed('scene',s.scene_asset_id)) throw fault('场次场景未列入清单'); for(const q of s.shots) if(!allowed('scene',q.scene_asset_id)||(q.prop_ids??[]).some(id=>!allowed('prop',id))) throw fault('镜头场景或道具未列入清单'); }
      // File provenance and initialized manifest source cannot be replaced through
      // autosave. Structured display names are always hydrated from asset IDs.
      p.import_source=previous.import_source;
      p.legacy_media_project_id=previous.legacy_media_project_id;
      p.revision=old.revision;
      const canonicalCurrent=canonical(this.hydrate(old).project);
      if(canonical(p)===canonicalCurrent) return this.read(projectId);
      p.revision=old.revision+1; const now=Math.max(Date.now(),old.updated_at+1);
      this.db.prepare('UPDATE storyboard_documents SET title=?,document_json=?,revision=?,updated_at=? WHERE id=?').run(p.title,canonical(p),p.revision,now,old.id);
      for(const id of ids) if(!current.has(id)) this.db.prepare('INSERT INTO storyboard_asset_links VALUES(?,?,?,?,?)').run(randomUUID(),old.id,id,now,now);
      return this.read(projectId);
    });
  }
  backup() { return this.tx(()=>this.backupInTransaction()); }
  // Shares its caller's transaction, including the creative/script/video snapshots.
  backupInTransaction() {const tables=Object.fromEntries(Object.keys(STORYBOARD_TABLES).map(t=>[t,this.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()])), creative=this.assets.backupInTransaction(), data={tables,creative,...(this.videos?{video_preview:this.videos.snapshot()}:{})}; return {format:'shiguang-storyboard-backup',schema_version:1,...data,checksum:digest(data)};}
  validateBackup(input) {
    if(!input || input.format!=='shiguang-storyboard-backup' || input.schema_version!==1 || digest({tables:input.tables,creative:input.creative,...(Object.hasOwn(input,'video_preview')?{video_preview:input.video_preview}:{})})!==input.checksum || canonical(Object.keys(input.tables??{}).sort())!==canonical(Object.keys(STORYBOARD_TABLES).sort())) throw fault('分镜备份格式或摘要无效');
    const creative=this.assets.validateBackup(input.creative), assets=new Map(creative.tables.creative_assets.map(a=>[a.id,a])), projects=new Map(creative.projects.map(p=>[p.id,p]));
    for(const [table,cols] of Object.entries(STORYBOARD_TABLES)) {
      const rows=input.tables[table], ids=new Set(); if(!Array.isArray(rows)||rows.length>100000) throw fault('备份表数量无效');
      for(const row of rows) {
        if(!row || canonical(Object.keys(row).sort())!==canonical(Object.keys(cols).sort()) || ids.has(row.id)) throw fault('备份分镜字段或编号无效'); ids.add(row.id);
        for(const [k,t] of Object.entries(cols)) {const v=row[k];if(['id','ref'].includes(t)&&!idOK(v)||['key','text','name'].includes(t)&&typeof v!=='string'||t==='integer'&&(!Number.isSafeInteger(v)||v<0)||t==='nullable'&&v!==null&&(!Number.isSafeInteger(v)||v<1)) throw fault('备份分镜字段类型无效');}
        if(row.updated_at<row.created_at) throw fault('备份时间无效');
      }
    }
    const tables=input.tables,docs=new Map(),projectIds=new Set();
    if(tables.storyboard_schema.length!==1||tables.storyboard_schema[0].id!=='storyboard'||tables.storyboard_schema[0].version!==1) throw fault('备份分镜 schema 无效');
    const manifests=new Map();
    for(const d of tables.storyboard_documents) {
      if(projectIds.has(d.project_id)||projects.get(d.project_id)?.project_kind!=='normal'||d.revision<1||!(/^[a-f0-9]{64}$/).test(d.source_hash)) throw fault('备份分镜项目或修订号无效');
      projectIds.add(d.project_id);docs.set(d.id,d);
      let p;try{p=JSON.parse(d.document_json);}catch{throw fault('备份分镜 JSON 无效');}
      if(p.project_id!==d.id||p.document_id!==d.id||p.bound_project_id!==d.project_id||p.revision!==d.revision||M.validateProject(p).length||p.generation_batches.length||p.generation_runs.length) throw fault('备份分镜内容无效');
      const ids=new Set();
      for(const kind of ['character','scene','prop']) {if(!Array.isArray(p.asset_manifest?.[kind]))throw fault('备份清单缺失');for(const e of p.asset_manifest[kind]){const a=assets.get(e.id);if(!a||a.project_id!==d.project_id||a.kind!==kind||a.archived_at!==0||ids.has(a.id))throw fault('备份清单关联无效');ids.add(a.id);}}
      if(canonical(p.characters.map(c=>c.id).sort())!==canonical(p.asset_manifest.character.map(c=>c.id).sort()))throw fault('备份人物清单不一致');
      manifests.set(d.id,ids);
    }
    const pairs=new Set();
    for(const l of tables.storyboard_asset_links){const pair=l.document_id+'/'+l.asset_id;if(!docs.has(l.document_id)||!manifests.get(l.document_id).has(l.asset_id)||pairs.has(pair))throw fault('备份分镜清单关系无效');pairs.add(pair);}
    for(const [id,ids] of manifests) for(const asset of ids) if(!pairs.has(id+'/'+asset))throw fault('备份缺少清单保护关系');
    for(const r of tables.storyboard_import_requests){const d=docs.get(r.document_id);let result;try{result=JSON.parse(r.result_json);}catch{throw fault('备份回执无效');}if(!d||d.project_id!==r.project_id||!(/^[a-f0-9]{64}$/).test(r.request_hash)||!(/^[a-f0-9]{64}$/).test(r.source_hash)||result.request_id!==r.id||result.revision>d.revision)throw fault('备份初始化回执关联无效');}
    if(Object.hasOwn(input,'video_preview')){if(!this.videos)throw fault('预览模块尚未就绪，未恢复备份');input.video_preview=this.videos.validateBackup(input.video_preview,input.tables.storyboard_documents,creative.projects);}
    return {...input,creative};
  }
  async restore(input) {
    input=this.validateBackup(input); const before=this.backup();
    const dir=path.join(this.lib.dataDir,'backups');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,`storyboard-before-restore-${Date.now()}-${randomUUID()}.json`),JSON.stringify(before),{flag:'wx',mode:0o600});
    return this.tx(()=>{
      this.assets.lockRestoreScope();
      if(this.backupInTransaction().checksum!==before.checksum)throw fault('备份期间数据库已变化，请重新恢复',409);
      // Restore only into an empty target or identical records. Never overwrite
      // current storyboards or remove protection through a backup endpoint.
      this.assets.restoreRows(input.creative,before.creative);
      for(const [table,cols] of Object.entries(STORYBOARD_TABLES))for(const row of input.tables[table]) {
        const old=this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id), keys=Object.keys(cols);
        if(old){if(table==='storyboard_schema'&&old.version===row.version)this.db.prepare('UPDATE storyboard_schema SET created_at=?,updated_at=? WHERE id=?').run(row.created_at,row.updated_at,row.id);else if(canonical(old)!==canonical(row))throw fault('目标分镜已有不同内容，未覆盖',409);}
        else this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`).run(...keys.map(k=>row[k]));
      }
      if(Object.hasOwn(input,'video_preview'))this.videos.restoreRows(input.video_preview);
      for(const d of input.tables.storyboard_documents)this.read(d.project_id);
      return {restored:true,documents:input.tables.storyboard_documents.length};
    });
  }
}
